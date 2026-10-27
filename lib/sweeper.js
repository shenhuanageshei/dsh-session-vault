/**
 * Sweeper（设计档 §9 / 需求 FR-8 / P2-1）：自动清扫。
 *
 * 触发与节奏（R-14）：
 *  - **recoverOnBoot() 收敛完成之后**才允许起跑（由 lib/index.js 串在启动收敛的 promise 后面）；
 *  - 启动后 60s 首扫，此后每 `sweepIntervalMinutes`（默认 30）一次；
 *  - 定时器一律经 ctx.setTimeout / ctx.setInterval（cordis 4.0.5 没有 dispose 事件），
 *    并把返回的 disposer 存起来，插件卸载时 stop() 全部释放。
 *
 * 候选（D4 / 2026-10-22 用户口径）：
 *  status=hot + id ∈ registry.archivedSessionIds + lastActiveAt + ageDays*86400e3 <= now + next_attempt <= now，
 *  按 lastActiveAt 升序，单轮上限 5。清扫**先入库**（backfillArchivedAt），所以「registry 里已归档但 DB 没行」
 *  的存量会话也进候选（运行时首启缺陷的另一半）。
 *
 * M2②（偏离审计 / 评审 #2）：回填 tick 放在**所有短路之前**——autoMigrate=false 或 AM 在场时也照跑
 * （只补 DB 展示字段，不搬移任何文件）。旧实现把它放在 pause 之后 ⇒ 这两种场景下 archivedAt 永不自愈。
 *
 * M3（偏离审计）：启动恢复失败时**仍然起跑**（paused=true + sweepError 暴露到 /status 与 UI 横幅），
 * 之后每一拍重试 recoverOnBoot，成功即自动解除 paused。
 *
 * 预算 / 退避 / 暂停：
 *  - 单日上限 dailyBudgetCount（默认 20 个/天），计数持久化在 meta（跨重启不重置）；
 *  - 失败退避 next_attempt = now + min(6h, 5min * 2^n)，n = **本次失败之前的连续失败次数**
 *    （meta 计数 failures 从 1 起；n = failures-1 ⇒ 首次失败 5 分钟、此后 10/20/…，§15.1 #1）；
 *  - 暂停条件：AM 在场、coldRoot 不可用、跨卷未开启、restoring 未收敛、external-unarchived 未收敛；
 *  - A-8：配置（阈值 / 开关 / 预算 / 间隔）**每次清扫重新读**，下一次立即按新值执行，不重建实例。
 */
import {
  ERROR_STATES,
  SUBAGENT_ROUND_LIMIT,
  SUBSCAN_META,
  REF_SCAN_TTL_MS,
} from './engine.js';

export const FIRST_SWEEP_DELAY_MS = 60 * 1000;
export const ROUND_LIMIT = 5;
export const BASE_BACKOFF_MS = 5 * 60 * 1000;
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_SWEEP_INTERVAL_MINUTES = 30;

export const SWEEP_META = Object.freeze({
  lastRunAt: 'sweep:lastRunAt',
  lastReport: 'sweep:lastReport',
  budgetPrefix: 'sweep:budget:',
  failurePrefix: 'sweep:fail:',
});

/**
 * P4（FR-P4-6 / 设计档 §19.5）：class S 的**四条**暂停条件 —— 与 class A 的五条完全分开。
 *
 * 为什么不能塞进 pauseReason()：class A 的 `archive-manager` / `external-unarchived-unsettled`
 * 只对「归档集合」有意义；class S 的行根本不在归档集合里，用同一套暂停条件会**互相锁死**
 * （AM 在场会顺带停掉子代理冷存；一条 class A 的 external-unarchived 也会让 class S 永远不跑）。
 * 顺序 = UI 展示顺序（黄条按这个顺序列全部四条原因）。
 */
export const SUBAGENT_PAUSE_CODES = Object.freeze([
  'subagent-refs-incomplete',
  'cold-unavailable',
  'cross-volume-disabled',
  'restoring-unsettled',
]);

/** 失败退避：min(6h, 5min * 2^n)（§9）。n=0 ⇒ 5min，n≥7 起封顶 6h。 */
export function sweepBackoffMs(failures) {
  const n = Math.max(0, Math.trunc(Number(failures) || 0));
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, n));
}

/** 日预算的「日」：UTC 日期串（可注入 now 的纯函数，便于测跨日重置）。 */
export function sweepDayKey(ms) {
  return new Date(Number(ms) || 0).toISOString().slice(0, 10);
}

/**
 * 定时器适配器：ctx 优先（cordis 定时器返回 disposer），否则退回全局定时器（unref，不吊住宿主退出）。
 * 单测可整体注入 scheduler。
 */
export function createScheduler(ctx) {
  // 宿主 ctx.setTimeout / setInterval 是 **timer 服务的代理访问器**：未 inject 'timer' 时
  // 连属性探测都会抛错（真机 "cannot get property \"timer\" without inject"）。
  // 因此探测与调用都包 try/catch，失败退全局定时器（unref，不吊住宿主退出）。
  let hostTimeout = null;
  let hostInterval = null;
  try {
    if (ctx && typeof ctx.setTimeout === 'function') hostTimeout = (fn, ms) => ctx.setTimeout(fn, ms);
  } catch {
    hostTimeout = null;
  }
  try {
    if (ctx && typeof ctx.setInterval === 'function') hostInterval = (fn, ms) => ctx.setInterval(fn, ms);
  } catch {
    hostInterval = null;
  }
  return {
    after(fn, ms) {
      if (hostTimeout) {
        try {
          const dispose = hostTimeout(fn, ms);
          if (typeof dispose === 'function') return dispose;
        } catch {
          /* 退全局 */
        }
      }
      const timer = setTimeout(fn, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return () => clearTimeout(timer);
    },
    every(fn, ms) {
      if (hostInterval) {
        try {
          const dispose = hostInterval(fn, ms);
          if (typeof dispose === 'function') return dispose;
        } catch {
          /* 退全局 */
        }
      }
      const timer = setInterval(fn, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return () => clearInterval(timer);
    },
  };
}

export class Sweeper {
  /**
   * @param {{engine:object, logger?:object, ctx?:object, now?:()=>number, scheduler?:object,
   *          firstDelayMs?:number, roundLimit?:number}} options
   */
  constructor(options = {}) {
    this.engine = options.engine;
    if (!this.engine) throw new Error('Sweeper 需要 engine');
    this.logger = options.logger || null;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.firstDelayMs = Number.isFinite(options.firstDelayMs) ? options.firstDelayMs : FIRST_SWEEP_DELAY_MS;
    this.roundLimit = Number.isFinite(options.roundLimit) ? options.roundLimit : ROUND_LIMIT;
    this.scheduler = options.scheduler || createScheduler(options.ctx || null);
    this._started = false;
    this._running = false;
    this._firstDispose = null;
    this._intervalDispose = null;
    this._intervalMs = 0;
    this._nextRunAt = null;
    this._lastRunAt = null;
    this._pauseReason = null;
    this._lastReport = null;
    this._lastConfig = null;
    this._lastTickPromise = null;
    /** P4：class S 的运行读数（与 class A 的 _running / _pauseReason **分开**，互不污染）。 */
    this._subagentRunning = false;
    this._subagentPause = null;
    this._subagentLastRunAt = null;
    this._subagentLastReport = null;
    /** M3：启动恢复（recoverOnBoot）失败 ⇒ 清扫以暂停态起跑，错误暴露到 /status 与 UI。 */
    this._bootError = null;
    this._bootRecovery = typeof options.bootRecovery === 'function' ? options.bootRecovery : () => this.engine.recoverOnBoot();
  }

  get store() {
    return this.engine.store;
  }

  /**
   * A6（P2.6 评审）：只读的「真的起跑了吗」。
   *
   * `new Sweeper(...)` 成功 ≠ 已排程：`start()` 可能抛错（定时器服务不可用 / 宿主形状不支持）。
   * 调用方（lib/index.js 的 startSweeper）必须按这个位决定「复用实例」还是「重新 start 同一个实例」，
   * 否则半成品实例会被当成已挂上，清扫永远不起跑（旧实现就是 `if (sweeper) return sweeper;`）。
   */
  get started() {
    return this._started === true;
  }

  log(level, message) {
    try {
      const fn = this.logger && (this.logger[level] || this.logger.warn);
      if (typeof fn === 'function') fn.call(this.logger, '[dsh-session-vault] ' + message);
    } catch {
      /* 日志永不抛 */
    }
  }

  async config() {
    return this.engine.config();
  }

  /** 暂停条件（§9）：任一命中 ⇒ 本轮 no-op，一个会话都不碰。 */
  async pauseReason(cfg) {
    let am = null;
    try {
      am = await this.engine.detectAm();
    } catch {
      am = null;
    }
    if (am && am.present) {
      return { code: 'archive-manager', message: '检测到 archive-manager（AC-9 / A-18）：自动清扫暂停' };
    }
    let coldReport = [];
    try {
      coldReport = await this.engine.probeColdRoots();
    } catch {
      coldReport = [];
    }
    if (!coldReport.some((item) => item.available)) {
      return { code: 'cold-unavailable', message: '冷存储根全部不可访问（只读降级，不搬移；A-7）' };
    }
    if (!cfg.allowCrossVolume) {
      let same = true;
      try {
        const coldRoot = await this.engine.coldRoot();
        same = await this.engine.sameVolume(this.engine.paths.sessionsRoot, coldRoot);
      } catch {
        same = true;
      }
      if (!same) {
        return { code: 'cross-volume-disabled', message: '冷根与 sessions 跨卷且 allowCrossVolume=false（D13）：自动清扫暂停' };
      }
    }
    const restoring = this.store.listSessions({ status: ['restoring'] });
    if (restoring.length) {
      return {
        code: 'restoring-unsettled',
        message: restoring.length + ' 个会话仍在恢复中（R-14：收敛前不开始新的迁移）',
        ids: restoring.map((row) => row.session_id),
      };
    }
    const external = this.store.listSessions().filter((row) => row.error === ERROR_STATES.EXTERNAL_UNARCHIVED);
    if (external.length) {
      return {
        code: 'external-unarchived-unsettled',
        message: external.length + ' 个冷会话被外部取消归档且尚未收敛（A-13）',
        ids: external.map((row) => row.session_id),
      };
    }
    return null;
  }


  // ---- P4：子代理会话冷存（class S）的自动清扫 ---------------------------
  /**
   * class S 的暂停条件（四条，与 class A 的五条**完全分开**）。
   *
   * 前置：cfg 已加载（每次清扫重新读，A-8 同款：改配置下一次立即生效）。
   * 后置：返回 null（可跑）或 {code, message, ...读数}；code 必在 SUBAGENT_PAUSE_CODES 里。
   * **AM 在场不暂停 class S**（archive-manager 只管归档集合，子代理行不在其中）。
   */
  async pauseReasonS(cfg) {
    let coldReport = [];
    try {
      coldReport = await this.engine.probeColdRoots();
    } catch {
      coldReport = [];
    }
    if (!coldReport.some((item) => item.available)) {
      return { code: 'cold-unavailable', message: '冷存储根全部不可访问（只读降级，不搬移；A-7）' };
    }
    if (!cfg.allowCrossVolume) {
      let same = true;
      try {
        const coldRoot = await this.engine.coldRoot();
        same = await this.engine.sameVolume(this.engine.paths.sessionsRoot, coldRoot);
      } catch {
        same = true;
      }
      if (!same) {
        return {
          code: 'cross-volume-disabled',
          message: '冷根与 sessions 跨卷且 allowCrossVolume=false（D13）：子代理会话冷存暂停',
        };
      }
    }
    // I-18：「谁引用谁」必须来自新鲜快照（≤24h 且 gaps=0）；不可信就零搬移。
    const snapshot = this.engine.subscanSnapshot();
    if (!snapshot.fresh || snapshot.gaps.length) {
      const reason = !snapshot.fresh
        ? '引用快照缺失或超过 ' + Math.round(REF_SCAN_TTL_MS / 3600000) + 'h（subscan:at=' +
          (snapshot.at === null ? '无' : new Date(snapshot.at).toISOString()) + '）'
        : '引用快照有 ' + snapshot.gaps.length + ' 个缺口';
      return {
        code: 'subagent-refs-incomplete',
        message: reason + '：class S 暂停（I-18 / FR-P4-3 第 7 条）',
        gaps: snapshot.gaps,
        scanAt: snapshot.at,
        scanFresh: snapshot.fresh,
      };
    }
    const restoring = this.store.listSessions({ status: ['restoring'] });
    if (restoring.length) {
      return {
        code: 'restoring-unsettled',
        message: restoring.length + ' 个会话仍在恢复中（R-14：收敛前不开始新的迁移）',
        ids: restoring.map((row) => row.session_id),
      };
    }
    return null;
  }

  /** class S 的当日预算读数（键 subscan:budget:<UTC 日>，与 class A 的 sweep:budget:* 完全分开）。 */
  async subagentBudget(cfg, now = this.now()) {
    const day = sweepDayKey(now);
    const key = SUBSCAN_META.budgetPrefix + day;
    let used = 0;
    try {
      used = Number(this.store.getMeta(key, '0')) || 0;
    } catch {
      used = 0;
    }
    const limit = Math.max(0, Math.trunc(Number(cfg && cfg.subagentDailyBudgetCount) || 0));
    return { day, key, used, limit, remaining: Math.max(0, limit - used) };
  }

  /**
   * 跑一轮 class S 清扫（不做定时；可注入 now，单测直接调用）。
   *
   * 与 class A 的关系（§19.5 FR-P4-6）：
   *  - **同一拍里各跑各的**：class A 的开关/暂停/预算一个都不影响 class S（反之亦然）；
   *  - 共用单串行引擎队列 ⇒ 迁移与恢复互斥；手动批量作业在跑时本轮跳过（先到先跑）。
   */
  async sweepSubagents(options = {}) {
    const now = options.now === undefined ? this.now() : options.now;
    const base = { at: now, day: sweepDayKey(now) };
    if (this._subagentRunning) return { ...base, skipped: 'already-running' };
    // 手动批量作业与自动清扫互斥（同一把锁的精神：同一时刻只有一条迁移流）
    try {
      const job = this.engine && typeof this.engine.subagentJobSnapshot === 'function' ? this.engine.subagentJobSnapshot() : null;
      if (job && job.running) return { ...base, skipped: 'job-running', job };
    } catch {
      /* 作业读数失败不影响清扫 */
    }
    let cfg;
    try {
      cfg = await this.config();
    } catch (err) {
      return { ...base, ok: false, skipped: 'config-unavailable', error: err && err.message ? err.message : String(err) };
    }
    this._subagentRunning = true;
    let report;
    try {
      report = await this._sweepSubagents(cfg, now, base);
    } catch (err) {
      report = { ...base, ok: false, error: err && err.message ? err.message : String(err) };
      this.log('warn', '子代理清扫失败：' + report.error);
    } finally {
      this._subagentRunning = false;
      this._subagentLastRunAt = now;
      this._subagentLastReport = report;
    }
    return report;
  }

  async _sweepSubagents(cfg, now, base) {
    if (!cfg.subagentMigrate) {
      this._subagentPause = null;
      return { ...base, skipped: 'subagent-migrate-off' };
    }
    if (cfg.subagentAgeDays === 0) {
      this._subagentPause = null;
      return { ...base, skipped: 'threshold-off' };
    }
    // FR-P4-2 的触发 ①（插件启动 60s 后的首拍，也就是本函数第一次跑）与 ②（subscan:at 超过 24h）：
    // 快照不新鲜就先补一次 header 事实扫描；扫描失败/仍有缺口 ⇒ 下面 pauseReasonS 会如实暂停。
    let snapshot = this.engine.subscanSnapshot({ now });
    let scanned = null;
    if (!snapshot.fresh) {
      try {
        scanned = await this.engine.scanHeaderFacts({});
      } catch (err) {
        scanned = { ok: false, error: err && err.message ? err.message : String(err) };
      }
      snapshot = this.engine.subscanSnapshot({ now: this.now() });
    }
    const pause = await this.pauseReasonS(cfg);
    this._subagentPause = pause;
    if (pause) return { ...base, scanned, skipped: pause.code, paused: pause };
    const budget = await this.subagentBudget(cfg, now);
    if (budget.limit === 0) return { ...base, scanned, skipped: 'budget-disabled', budget };
    if (budget.remaining === 0) return { ...base, scanned, skipped: 'budget-exhausted', budget };
    const limit = Math.min(SUBAGENT_ROUND_LIMIT, budget.remaining);
    // 清扫必须拿当下读数（退避 / 状态变化立刻生效）⇒ 显式 bypass 缓存。
    const candidates = await this.engine.subagentCandidates({ now, useCache: false, limit });
    const results = [];
    let used = budget.used;
    for (const row of candidates) {
      const id = row.session_id;
      let outcome;
      try {
        outcome = await this.engine.migrate(id, { class: 'subagent', reason: 'subagent-sweep' });
      } catch (err) {
        outcome = { id, ok: false, error: err && err.message ? err.message : String(err) };
      }
      const entry = {
        id,
        ok: Boolean(outcome && outcome.ok),
        code: (outcome && outcome.code) || null,
        error: (outcome && outcome.error) || null,
      };
      results.push(entry);
      if (entry.ok) {
        used += 1;
        try {
          this.store.setMeta(budget.key, String(used));
          this.store.setMeta(SUBSCAN_META.failurePrefix + id, '0');
        } catch {
          /* 预算落库失败：下一轮少算一次，不阻塞迁移 */
        }
      } else {
        try {
          // 失败退避公式与 §9 同款（首次 5 分钟，此后 10/20/…，封顶 6h），但键是 subscan:fail:<id>。
          const failures = (Number(this.store.getMeta(SUBSCAN_META.failurePrefix + id, '0')) || 0) + 1;
          this.store.setMeta(SUBSCAN_META.failurePrefix + id, String(failures));
          const nextAttempt = now + sweepBackoffMs(failures - 1);
          this.store.updateSession(id, { next_attempt: nextAttempt });
          entry.failures = failures;
          entry.nextAttempt = nextAttempt;
        } catch (err) {
          this.log('warn', '子代理失败退避写入失败（' + id + '）：' + (err && err.message ? err.message : err));
        }
      }
    }
    const migrated = results.filter((entry) => entry.ok).length;
    const failed = results.length - migrated;
    if (results.length) {
      try {
        this.engine.invalidate();
      } catch {
        /* 缓存失效失败不影响本轮结果 */
      }
      this.log('info', '子代理自动清扫：迁移 ' + migrated + ' / 失败 ' + failed + '（预算 ' + used + '/' + budget.limit + '）');
    }
    return {
      ...base,
      scanned,
      budget: { ...budget, used },
      candidates: candidates.length,
      attempted: results.length,
      migrated,
      failed,
      results,
    };
  }

  /**
   * class S 的只读快照（/status.subagent 与 UI 黄条的数据源；不触发扫描、不迁移）。
   * 后置：\`paused\` / \`pauseReason\` / 四条可选原因（pauseReasonOptions）恒存在。
   */
  subagentSnapshot() {
    const cfg = this._lastConfig || {};
    const now = this.now();
    const day = sweepDayKey(now);
    let used = 0;
    try {
      used = Number(this.store.getMeta(SUBSCAN_META.budgetPrefix + day, '0')) || 0;
    } catch {
      used = 0;
    }
    let snapshot = null;
    try {
      snapshot = this.engine && typeof this.engine.subscanSnapshot === 'function' ? this.engine.subscanSnapshot({ now }) : null;
    } catch {
      snapshot = null;
    }
    return {
      attached: true,
      started: this._started,
      running: this._subagentRunning,
      phase: this._subagentRunning ? 'sweeping' : this._started ? 'scheduled' : 'idle',
      nextRunAt: this._nextRunAt,
      lastRunAt: this._subagentLastRunAt,
      paused: Boolean(this._subagentPause),
      pauseReason: this._subagentPause,
      pauseReasonOptions: SUBAGENT_PAUSE_CODES,
      migrate: Boolean(cfg.subagentMigrate) && Number(cfg.subagentAgeDays) > 0,
      ageDays: cfg.subagentAgeDays === undefined ? null : cfg.subagentAgeDays,
      budget: {
        day,
        used,
        limit: Math.max(0, Math.trunc(Number(cfg.subagentDailyBudgetCount) || 0)),
      },
      scanAt: snapshot ? snapshot.at : null,
      scanGaps: snapshot ? snapshot.gaps : [],
      refsIncomplete: snapshot ? snapshot.refsIncomplete : true,
      lastReport: this._subagentLastReport
        ? {
            at: this._subagentLastReport.at,
            skipped: this._subagentLastReport.skipped || null,
            attempted: this._subagentLastReport.attempted || 0,
            migrated: this._subagentLastReport.migrated || 0,
            failed: this._subagentLastReport.failed || 0,
          }
        : null,
    };
  }

  /** 当日预算读数（meta 持久化：跨重启不重置）。 */
  async budget(cfg, now = this.now()) {
    const day = sweepDayKey(now);
    const key = SWEEP_META.budgetPrefix + day;
    let used = 0;
    try {
      used = Number(this.store.getMeta(key, '0')) || 0;
    } catch {
      used = 0;
    }
    const limit = Math.max(0, Math.trunc(Number(cfg && cfg.dailyBudgetCount) || 0));
    return { day, key, used, limit, remaining: Math.max(0, limit - used) };
  }

  /**
   * 跑一轮清扫（**不做定时**，可注入 now；单测直接调用）。
   * 返回结构化报告：skipped / paused / budget / candidates / migrated / failed / results。
   */
  async sweep(options = {}) {
    const now = options.now === undefined ? this.now() : options.now;
    const base = { at: now, day: sweepDayKey(now) };
    if (this._running) return { ...base, skipped: 'already-running' };
    let cfg;
    try {
      cfg = await this.config();
    } catch (err) {
      return { ...base, ok: false, skipped: 'config-unavailable', error: err && err.message ? err.message : String(err) };
    }
    this._lastConfig = cfg;
    this._running = true;
    let report;
    try {
      report = await this._sweep(cfg, now, base);
      /**
       * P4（FR-P4-6）：class S 在同一拍里**独立**跑一轮。
       * 放在 _sweep 之后、finally 之前 —— 这样 class A 的早退（autoMigrate=false / AM 在场 / 阈值 0）
       * 一个都不会连带停掉子代理冷存；报告一起落 sweep:lastReport，/status 读得到两段。
       */
      try {
        report.subagent = await this.sweepSubagents({ now });
      } catch (err) {
        report.subagent = { at: now, ok: false, error: err && err.message ? err.message : String(err) };
        this.log('warn', '子代理清扫异常（不影响 class A 报告）：' + report.subagent.error);
      }
    } catch (err) {
      report = { ...base, ok: false, error: err && err.message ? err.message : String(err) };
      this.log('warn', '清扫失败：' + report.error);
    } finally {
      this._running = false;
      this._lastRunAt = now;
      this._lastReport = report;
      try {
        this.store.setMeta(SWEEP_META.lastRunAt, String(now));
        this.store.setMeta(SWEEP_META.lastReport, JSON.stringify(report));
      } catch {
        /* 报告落库失败不影响清扫结果 */
      }
    }
    return report;
  }

  async _sweep(cfg, now, base) {
    // M2②（评审 #2）：**只读回填 tick 放在所有短路之前**。
    // 它只补 DB 展示/排序字段（archived_at / title / projectKey …），不搬移任何文件，
    // 所以在 autoMigrate=false 与 AM 在场时也必须跑——否则「先被索引建行」或「DB 没行」的归档会话
    // 永远拿不到 archivedAt（旧实现把这段放在 pause 之后，等于永不轮询）。
    let backfilled = 0;
    try {
      backfilled = await this.engine.backfillArchivedAt();
    } catch (err) {
      this.log('warn', '清扫前回填失败（继续用现有行）：' + (err && err.message ? err.message : err));
    }
    // F3：清扫 tick 也是一次包装 reconcile（漂移 ⇒ 链式自动重装；失败原因进 /status）。
    // 这样即使 UI 不轮询 /status、也没有 /list 请求，长时间运行时包装漂移仍会被自愈。
    try {
      if (this.engine && typeof this.engine.verifyOverlay === 'function') this.engine.verifyOverlay();
    } catch (err) {
      this.log('warn', '包装 reconcile 失败（不影响清扫）：' + (err && err.message ? err.message : err));
    }
    // M1 配套：清扫也顺手触发一次索引器的 TTL 增量刷新（有界、后台；索引器还没起来时跳过）。
    try {
      const indexer = this.engine.indexer;
      if (indexer && typeof indexer.ensureStarted === 'function') indexer.ensureStarted().catch(() => {});
    } catch {
      /* 索引器异常不影响清扫 */
    }
    if (!cfg.autoMigrate) {
      this._pauseReason = null;
      return { ...base, backfilled, skipped: 'auto-migrate-off' };
    }
    if (cfg.archiveAgeDays === 0) {
      this._pauseReason = null;
      return { ...base, backfilled, skipped: 'threshold-off' };
    }
    // M3：启动恢复失败 ⇒ 本轮 no-op（错误已在 /status 与 UI 暴露；下一拍重试收敛）。
    if (this._bootError) {
      this._pauseReason = this._bootError;
      return { ...base, backfilled, skipped: this._bootError.code, paused: this._bootError };
    }
    const pause = await this.pauseReason(cfg);
    this._pauseReason = pause;
    if (pause) return { ...base, backfilled, skipped: pause.code, paused: pause };

    const budget = await this.budget(cfg, now);
    if (budget.limit === 0) return { ...base, backfilled, skipped: 'budget-disabled', budget };
    if (budget.remaining === 0) return { ...base, backfilled, skipped: 'budget-exhausted', budget };

    const limit = Math.min(this.roundLimit, budget.remaining);
    // 缓存交给 list/status 用；清扫必须拿当下读数（退避 / 状态变化立刻生效），所以显式 bypass。
    const candidates = await this.engine.candidates(limit, { useCache: false });
    const results = [];
    let used = budget.used;
    for (const row of candidates) {
      const id = row.session_id;
      let outcome;
      try {
        outcome = await this.engine.migrate(id, { reason: 'sweep' });
      } catch (err) {
        outcome = { id, ok: false, error: err && err.message ? err.message : String(err) };
      }
      const entry = {
        id,
        ok: Boolean(outcome && outcome.ok),
        code: (outcome && outcome.code) || null,
        error: (outcome && outcome.error) || null,
      };
      results.push(entry);
      if (entry.ok) {
        used += 1;
        try {
          this.store.setMeta(budget.key, String(used));
          this.store.setMeta(SWEEP_META.failurePrefix + id, '0');
        } catch {
          /* 预算读数落库失败：下一轮会少算一次，不阻塞迁移 */
        }
      } else {
        let failures = 0;
        try {
          failures = (Number(this.store.getMeta(SWEEP_META.failurePrefix + id, '0')) || 0) + 1;
          this.store.setMeta(SWEEP_META.failurePrefix + id, String(failures));
          // 首次失败用 base（5min），此后 10/20/…：指数取「本次之前的连续失败次数」（failures-1）。
          const nextAttempt = now + sweepBackoffMs(failures - 1);
          this.store.updateSession(id, { next_attempt: nextAttempt });
          entry.failures = failures;
          entry.nextAttempt = nextAttempt;
        } catch (err) {
          this.log('warn', '失败退避写入失败（' + id + '）：' + (err && err.message ? err.message : err));
        }
      }
    }
    const migrated = results.filter((entry) => entry.ok).length;
    const failed = results.length - migrated;
    // 本轮动过行（迁移成功 / next_attempt 更新）⇒ 让 list/status 的缓存立刻失效。
    if (results.length) {
      try {
        this.engine.invalidate();
      } catch {
        /* 缓存失效失败不影响本轮结果 */
      }
    }
    if (results.length) {
      this.log('info', '自动清扫：迁移 ' + migrated + ' / 失败 ' + failed + '（预算 ' + used + '/' + budget.limit + '）');
    }
    return {
      ...base,
      backfilled,
      budget: { ...budget, used },
      candidates: candidates.length,
      attempted: results.length,
      migrated,
      failed,
      results,
    };
  }

  /**
   * M3：启动恢复失败时把错误挂上来（Sweeper 照常起跑，但每一轮都 paused）。
   * 错误会出现在 /status 的 sweep.sweepError 与 UI 横幅上，不再是「sweep 恒 null」的静默降级。
   */
  holdBootError(error) {
    const message = error && error.message ? error.message : String(error || 'recoverOnBoot 失败');
    this._bootError = { code: 'boot-recovery-failed', message };
    this._pauseReason = this._bootError;
    return this.snapshot();
  }

  /** 启动恢复成功后自动解除暂停（M3）。返回是否真的解除了一条暂停。 */
  releaseBootError() {
    if (!this._bootError) return false;
    this._bootError = null;
    if (this._pauseReason && this._pauseReason.code === 'boot-recovery-failed') this._pauseReason = null;
    return true;
  }

  /** 重试启动收敛（M3：失败不是终态——每一拍重试一次，成功即自动解除 paused）。 */
  async retryBootRecovery() {
    if (!this._bootError) return { retried: false, ok: true };
    try {
      await this._bootRecovery();
      this.releaseBootError();
      this.log('info', '启动恢复重试成功：自动清扫已解除暂停');
      return { retried: true, ok: true };
    } catch (err) {
      this.holdBootError(err);
      this.log('warn', '启动恢复重试仍失败（清扫保持暂停）：' + (err && err.message ? err.message : err));
      return { retried: true, ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  /** status/list 用的只读快照（不触发扫描、不迁移）。 */
  snapshot() {
    const cfg = this._lastConfig || {};
    const now = this.now();
    const day = sweepDayKey(now);
    let used = 0;
    try {
      used = Number(this.store.getMeta(SWEEP_META.budgetPrefix + day, '0')) || 0;
    } catch {
      used = 0;
    }
    const intervalMinutes = Math.max(1, Math.trunc(Number(cfg.sweepIntervalMinutes) || DEFAULT_SWEEP_INTERVAL_MINUTES));
    return {
      started: this._started,
      running: this._running,
      phase: this._running ? 'sweeping' : this._started ? 'scheduled' : 'idle',
      firstDelayMs: this.firstDelayMs,
      intervalMs: this._intervalMs || intervalMinutes * 60000,
      nextRunAt: this._nextRunAt,
      lastRunAt: this._lastRunAt,
      paused: Boolean(this._pauseReason),
      pauseReason: this._pauseReason,
      // M3：启动恢复失败的可见面（旧实现恢复失败 ⇒ Sweeper 根本没起，status.sweep 恒 null）
      sweepError: this._bootError,
      autoMigrate: Boolean(cfg.autoMigrate) && cfg.archiveAgeDays > 0,
      budget: { day, used, limit: Math.max(0, Math.trunc(Number(cfg.dailyBudgetCount) || 0)) },
      lastReport: this._lastReport
        ? {
            at: this._lastReport.at,
            skipped: this._lastReport.skipped || null,
            attempted: this._lastReport.attempted || 0,
            migrated: this._lastReport.migrated || 0,
            failed: this._lastReport.failed || 0,
          }
        : null,
    };
  }

  /** 启动排程：60s 首扫，此后每 sweepIntervalMinutes（R-14：调用方保证 recoverOnBoot 已完成）。 */
  start() {
    if (this._started) return this;
    this._nextRunAt = this.now() + this.firstDelayMs;
    // A6：**先排程、排程成功后才置 _started**。旧顺序先置位再排程，一旦 scheduler.after 抛错，
    // 实例就带着 _started=true 却没有定时器 —— 调用方会把「半成品」当成「已起跑」，永不重试。
    this._firstDispose = this.scheduler.after(async () => {
      this._firstDispose = null;
      await this._tick();
    }, this.firstDelayMs);
    this._started = true;
    return this;
  }

  async _tick() {
    // M3：启动恢复失败过的进程，每一拍重试一次收敛；成功即自动解除 paused（不重启、不重建实例）。
    await this.retryBootRecovery().catch(() => {});
    let cfg = null;
    try {
      cfg = await this.config();
      this._lastConfig = cfg;
    } catch {
      cfg = this._lastConfig;
    }
    try {
      await this.sweep();
    } catch (err) {
      this.log('warn', '定时清扫异常：' + (err && err.message ? err.message : err));
    }
    this._scheduleInterval(cfg || this._lastConfig);
  }

  /** A-8：间隔配置变了就重建 interval（不用重启，也不用重建 Sweeper 实例）。 */
  _scheduleInterval(cfg) {
    const minutes = Math.max(1, Math.trunc(Number(cfg && cfg.sweepIntervalMinutes) || DEFAULT_SWEEP_INTERVAL_MINUTES));
    const ms = minutes * 60000;
    if (this._intervalDispose && this._intervalMs === ms) return;
    if (this._intervalDispose) {
      try {
        this._intervalDispose();
      } catch {
        /* ignore */
      }
      this._intervalDispose = null;
    }
    this._intervalMs = ms;
    this._nextRunAt = this.now() + ms;
    this._intervalDispose = this.scheduler.every(async () => {
      this._nextRunAt = this.now() + this._intervalMs;
      await this._tick();
    }, ms);
  }

  /** 卸载：释放两个定时器（ctx.effect 的 disposer / 全局定时器都覆盖）。 */
  stop() {
    this._started = false;
    if (this._firstDispose) {
      try {
        this._firstDispose();
      } catch {
        /* ignore */
      }
      this._firstDispose = null;
    }
    if (this._intervalDispose) {
      try {
        this._intervalDispose();
      } catch {
        /* ignore */
      }
      this._intervalDispose = null;
    }
    this._intervalMs = 0;
    this._nextRunAt = null;
  }
}

/**
 * 便捷安装器（index.js 用）：建实例 → 挂到 engine（status 读快照）→ 启动。
 * @returns {{sweeper:Sweeper, dispose:()=>void}}
 */
export function installSweeper({ engine, ctx, logger }) {
  const sweeper = new Sweeper({ engine, ctx, logger });
  try {
    engine.sweeper = sweeper;
  } catch {
    /* engine 是普通对象，正常不会失败 */
  }
  sweeper.start();
  return { sweeper, dispose: () => sweeper.stop() };
}
