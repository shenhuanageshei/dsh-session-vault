/**
 * VaultIndexer（设计档 §8.4 / D21 / P2-2）：全量索引（热 + 归档 + 冷存）+ 搜索。
 *
 * 与 P1 冷索引的关系：
 *  - 迁移/恢复/冷根导入仍然走 VaultEngine.indexSession（同一套帧遍历 + 抽取 + 分词）；
 *  - 本类负责 **覆盖面**（D21：所有工作区的会话，不再只索引归档/冷存）、**水位**、**首次全量后台任务**、
 *    以及搜索时的**有界增量**（默认每次检查 50 个、最多重索引 3 个）。
 *
 * 水位（§8.4）：meta `wm:<id>` = {size, mtime, generation}（**只索引最高代际**，R-11）。
 * 搜索前只 stat 有界数量会话的当前代际；变化才重索引 ⇒ 避免每次全扫。
 *
 * 首次全量：后台任务（scan → index），先归档/冷存、后热会话按最近活跃倒序；有进度、可暂停、断点续做
 * （续做即重跑：已索引且水位未变的目标直接跳过）。**绝不阻塞**触发它的 HTTP 请求。
 *
 * 官方 sessionQuery 不作依赖（需求 FR-9 / R-3）；搜索走自建 store.searchDocs（FTS5 + Intl.Segmenter）。
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isGenerationName, sortGenerations, generationVersion } from './marker.js';
import { readSessionHeader, headerFactsOf } from './engine.js';
import { toFtsMatch } from './tokenize.js';
import {
  SEARCH_SCOPES,
  SEARCH_SCOPE_BODY,
  SEARCH_SCOPE_TOOL_RESULTS,
  SEARCH_SCOPE_META,
  DEFAULT_SEARCH_SCOPE,
  normalizeSearchScope,
  INDEX_SCHEMA_VERSION,
  INDEX_SCHEMA_META,
  INDEX_SCHEMA_GAPS_META,
  indexSchemaSnapshotFrom,
  SCOPE_MAX_ROUNDS,
  SCOPE_GAPS_META,
  WATERMARK_META_PREFIX,
} from './config.js';

/**
 * 水位键前缀：定义在 config.js（engine 删 trash 行时要清水位，见 WATERMARK_META_PREFIX）；
 * 这里原样再导出，保持 indexer 的公开面不变（测试与调用方继续从 indexer import）。
 */
export const WATERMARK_PREFIX = WATERMARK_META_PREFIX;
export const INDEX_PROGRESS_META = 'index:progress';
/**
 * P3 / FR-P3-2：检索范围（scope）切换的进度读数（跨重启可续做）。
 * `phase` ∈ idle|scanning|running|paused|done|error；目标值写在 snapshot 的 `target` 里。
 */
export const SCOPE_PROGRESS_META = 'index:scope-progress';
/** 每个会话「见过多少条 tool/result 事件」的计数（升级 pass 只扫这些会话，不重读无关会话）。 */
export const TOOL_COUNT_PREFIX = 'tool:';
/** 每个会话「已在哪个水位下抽取过 tool 文档」的标记（续做不重复、不遗漏的判据）。 */
export const TOOL_SCOPE_PREFIX = 'tscope:';
/**
 * M1：重试轮数上限与 gaps meta 键的定义在 config.js（engine 与 indexer 共用，避免循环依赖）；
 * 这里原样再导出，保持 indexer 的公开面不变（测试与调用方可继续从 indexer import）。
 */
export { SCOPE_MAX_ROUNDS, SCOPE_GAPS_META } from './config.js';
export const DEFAULT_SYNC_CHECK_LIMIT = 50;
export const DEFAULT_SYNC_INDEX_LIMIT = 3;
export const FULL_INDEX_YIELD_EVERY = 10;
/**
 * M1（偏离审计）：目标集（id → 目录事实）的 TTL。全量索引 done 之后目录仍会变（新建会话），
 * 旧实现只在首次 scanTargets 时扫一次 ⇒ 新会话永远搜不到。这里最多每 5 分钟重扫一次，
 * 并把新出现/水位变化的会话增量索引掉（无需手动 rebuild-index）。
 */
export const TARGETS_TTL_MS = 5 * 60 * 1000;
/** 一次增量刷新最多索引多少个（有界：不把一次 /search 变成全量重建）。 */
export const DEFAULT_REFRESH_INDEX_LIMIT = 50;
/**
 * 搜索结果状态（UI 文案：进行中 / 热 / 已归档 / 冷存 / 回收站）。
 *
 * P3b（评审遗留 🔵）：补上 `trash` —— 回收站里的行是有状态的（status='trash' / trash 表），
 * 旧映射把它落到 'hot'，结果列表会把「已删除」的命中标成「热」，用户点开必然打不开。
 */
export const RESULT_STATE_LABELS = Object.freeze({
  running: '进行中',
  hot: '热',
  archived: '已归档',
  cold: '冷存',
  trash: '回收站',
});

/**
 * P3b.1（真机）：**确定性数据失败**的封闭集 —— 同一份日志再抽一次仍然会失败的那些错误码。
 *
 * 判据来自 engine：
 *  - `extract-empty`      = docs==0 且 lines>0（v0 空壳 / 打包行 / 未知事件形态，§8.1 R-17）；
 *  - `frame-corrupt`      = 某一完整帧解压/结构校验失败（§8.1，绝不写半截索引）；
 *  - `identity-mismatch`  = header.id / projectKey(header.cwd) 与会话身份不符（C-11 fail-closed）。
 *
 * 其它错误（`index-failed`、IO 异常、未知异常）一律按**瞬态**处理：本轮不写 schema，下次启动重试。
 * 旧实现把这两类混为一谈（只要 failed>0 就不写 schema）⇒ 真实库固定 29 个 extract-empty
 * 让 schema 永远写不回、每次启动清水位全量重抽（永远跑不完）。
 */
export const DETERMINISTIC_INDEX_ERRORS = Object.freeze([
  'extract-empty',
  'frame-corrupt',
  'identity-mismatch',
]);

/**
 * 把一条索引失败归到确定性错误码（命中返回该码，未命中返回 null = 瞬态）。
 * 兼容「码 + 冒号细节」与「码 + 空格细节」两种写法（引擎的 detail 有时被拼进 message）。
 */
export function deterministicIndexError(error) {
  const value = error === null || error === undefined ? '' : String(error).trim();
  if (!value) return null;
  for (const code of DETERMINISTIC_INDEX_ERRORS) {
    if (value === code || value.startsWith(code + ':') || value.startsWith(code + ' ')) return code;
  }
  return null;
}

export function watermarkKey(sessionId) {
  return WATERMARK_PREFIX + String(sessionId);
}

export function watermarkValue(size, mtimeMs, generation) {
  return JSON.stringify({
    size: Math.trunc(Number(size) || 0),
    mtime: Math.trunc(Number(mtimeMs) || 0),
    generation: generation ? String(generation) : '',
  });
}

export function parseWatermark(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    return { size: Number(value.size) || 0, mtime: Number(value.mtime) || 0, generation: String(value.generation || '') };
  } catch {
    return null;
  }
}

export class VaultIndexer {
  constructor(options = {}) {
    this.engine = options.engine;
    if (!this.engine) throw new Error('VaultIndexer 需要 engine');
    this.store = options.store || this.engine.store;
    this.paths = options.paths || this.engine.paths;
    this.logger = options.logger || null;
    this.now = typeof options.now === 'function' ? options.now : () => (typeof this.engine.now === 'function' ? this.engine.now() : Date.now());
    this.syncCheckLimit = Number.isFinite(options.syncCheckLimit) ? options.syncCheckLimit : DEFAULT_SYNC_CHECK_LIMIT;
    this.syncIndexLimit = Number.isFinite(options.syncIndexLimit) ? options.syncIndexLimit : DEFAULT_SYNC_INDEX_LIMIT;
    /** id → {dir, cold, projectKey, generations, current, version, size, mtime, root?}（一次目录扫描的结果）。 */
    this.targets = null;
    this._scannedAt = 0;
    /** M1：目标集 TTL 与增量刷新（新会话无需手动 start 即可被搜到）。 */
    this.targetsTtlMs = Number.isFinite(options.targetsTtlMs) ? options.targetsTtlMs : TARGETS_TTL_MS;
    this.refreshIndexLimit = Number.isFinite(options.refreshIndexLimit) ? options.refreshIndexLimit : DEFAULT_REFRESH_INDEX_LIMIT;
    this._refreshPromise = null;
    this._lastRefreshAt = null;
    /** §15.1 #6：跨重启的进度/暂停读数（meta index:progress），本进程跑过任何一轮后不再使用。 */
    this._persisted = null;
    this._loadPersistedProgress();
    this._phase = 'idle';
    this._indexed = 0;
    /** F5：**本进程**累计索引成功的会话数（不是「上一轮任务」计数，跨重启恒 0）。 */
    this._indexedThisRun = 0;
    this._total = 0;
    this._skipped = 0;
    this._failed = 0;
    this._errors = [];
    this._pauseRequested = false;
    this._runPromise = null;
    this._startedAt = null;
    this._updatedAt = null;
    this._syncCursor = 0;
    this._syncStats = { checked: 0, reindexed: 0 };
    /** F5：coverage 读数是 docs 侧的 COUNT(DISTINCT)，按 2s 缓存（status 轮询不必每次全表统计）。 */
    this._coverageCache = null;
    this._coverageTtlMs = Number.isFinite(options.coverageTtlMs) ? options.coverageTtlMs : 2000;
    /**
     * P3 / FR-P3-2：检索范围切换状态。
     *  - `_scopeTarget` 非空 = 有一个「升级 pass」排定/在跑（目标是 body+toolResults）；
     *  - `_scopePhase` 对外读数（idle|scanning|running|paused|done|error）；
     *  - `_desiredScope` 最近一次从配置读到的 scope（/status 的 searchScope 优先取 engine 的 cfg）。
     */
    this._scopeTarget = null;
    this._scopePhase = 'idle';
    this._scopePauseRequested = false;
    this._scopeAbort = false;
    this._scopeIndexed = 0;
    this._scopeSkipped = 0;
    this._scopeFailed = 0;
    this._scopeTotal = 0;
    /** M1：本轮（或最后一次）pass 未覆盖的会话 id（done-with-gaps 的证据面）。 */
    this._scopeGaps = [];
    /** M1：当前重试轮次（1..SCOPE_MAX_ROUNDS）。 */
    this._scopeRound = 0;
    this._scopeErrors = [];
    this._scopeStartedAt = null;
    this._scopeUpdatedAt = null;
    this._scopeRunPromise = null;
    this._desiredScope = DEFAULT_SEARCH_SCOPE;
    this._scopePersisted = null;
    this._loadPersistedScope();
    /**
     * M3：索引 schema（meta 'index:schema'）。初始化时读一次决定「是否需要全量重建」；
     * 之后的对外读数由 schemaSnapshot() 现读（别人写回的版本也要如实反映）。
     */
    this._schema = this._readSchemaState();
    this._schemaRunPromise = null;
    this._schemaRebuildAt = null;
  }

  log(level, message) {
    try {
      const fn = this.logger && (this.logger[level] || this.logger.warn);
      if (typeof fn === 'function') fn.call(this.logger, '[dsh-session-vault] ' + message);
    } catch {
      /* 日志永不抛 */
    }
  }

  async _coldRoot() {
    try {
      return typeof this.engine.coldRoot === 'function' ? await this.engine.coldRoot() : null;
    } catch {
      return null;
    }
  }

  archivedIds() {
    try {
      return typeof this.engine.archivedIds === 'function' ? this.engine.archivedIds() : new Set();
    } catch {
      return new Set();
    }
  }

  /**
   * 扫描全部会话目录（D21：热 + 归档 + 冷存），建立 id → 目标事实。
   * 冷存取 DB 行的**绝对冷根**（D17：改根不搬旧数据）；热侧对 sessionsRoot 做一次完整目录扫描。
   */
  async scanTargets({ force = false } = {}) {
    if (this.targets && !force) return this.targets;
    const targets = new Map();
    const currentCold = await this._coldRoot();
    for (const row of this.store.listSessions({ status: ['cold'] })) {
      const root = row.cold_root || currentCold;
      if (!root || !row.rel_dir) continue;
      const dir = path.join(root, row.rel_dir);
      const generations = sortGenerations(String(row.log_names || '').split(',').filter((name) => isGenerationName(name)));
      const current = generations.length ? generations[generations.length - 1] : null;
      if (!current) continue;
      let info = null;
      try {
        info = await stat(path.join(dir, current));
      } catch {
        info = null;
      }
      if (!info) continue; // 冷盘不可用/文件不在：跳过（由 DB 行 / 启动对账负责）
      targets.set(row.session_id, {
        id: row.session_id,
        dir,
        root,
        cold: true,
        projectKey: row.project_key || '',
        generations,
        current,
        version: generationVersion(current),
        size: info.size,
        mtime: Math.trunc(info.mtimeMs),
      });
    }

    let projects = [];
    try {
      projects = await readdir(this.paths.sessionsRoot, { withFileTypes: true });
    } catch {
      projects = [];
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(this.paths.sessionsRoot, project.name);
      let sessions = [];
      try {
        sessions = await readdir(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const id = session.name;
        if (targets.has(id)) continue;
        const dir = path.join(projectDir, id);
        let names = [];
        try {
          names = (await readdir(dir)).filter((name) => isGenerationName(name));
        } catch {
          continue;
        }
        const generations = sortGenerations(names);
        const current = generations.length ? generations[generations.length - 1] : null;
        if (!current) continue; // 没有合法代际：跳过（顶层 cleanupPartials/诊断负责）
        let info = null;
        try {
          info = await stat(path.join(dir, current));
        } catch {
          info = null;
        }
        if (!info) continue;
        targets.set(id, {
          id,
          dir,
          cold: false,
          projectKey: project.name,
          generations,
          current,
          version: generationVersion(current),
          size: info.size,
          mtime: Math.trunc(info.mtimeMs),
        });
      }
    }
    this.targets = targets;
    this._scannedAt = this.now();
    return targets;
  }

  /** 建库顺序：冷存(0) → 热归档(1) → 热会话(2)；同档按最近活跃倒序（§8.4 用户口径）。 */
  orderedTargets() {
    const archived = this.archivedIds();
    const list = this.targets ? [...this.targets.values()] : [];
    const rank = (target) => (target.cold ? 0 : archived.has(target.id) ? 1 : 2);
    list.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return (b.mtime || 0) - (a.mtime || 0);
    });
    return list;
  }

  /** 没有 DB 行时（热会话首建）先落一行最小元数据——indexSession 需要行来写回索引结果。 */
  async ensureRow(target) {
    const existing = this.store.getSession(target.id);
    if (existing) return existing;
    let header = null;
    if (!target.cold) {
      try {
        header = await readSessionHeader(path.join(target.dir, target.current));
      } catch {
        header = null;
      }
    }
    const now = this.now();
    // P4（FR-P4-2）：首建行时顺带落 header 事实三列（origin / delegation_depth / parent_session）。
    // 与 scanHeaderFacts 共用同一份解析（headerFactsOf）：两处各写一套，早晚会漂。
    const facts = header ? headerFactsOf(header) : { origin: null, delegationDepth: 0, parentSession: null };
    /**
     * M2①（偏离审计）：首建行时若会话**已在归档集合里**，必须同时落 archived_at ——
     * 旧实现恒写 archived_at:null，于是「先被索引建行」的归档会话在运行期内再也不会自愈
     * （backfill 只补已有行，而这里自己建的行正是它要补的那一行；AM 在场 / autoMigrate 关时更不会跑）。
     */
    const archivedNow = this.archivedIds().has(String(target.id));
    return this.store.upsertSession({
      session_id: target.id,
      project_key: target.projectKey || '',
      rel_dir: target.projectKey ? target.projectKey + '/' + target.id : target.id,
      log_names: target.generations.join(','),
      cold_root: target.cold ? target.root || null : null,
      format_version: target.version === null || target.version === undefined ? 0 : target.version,
      bytes: target.size || 0,
      file_size: target.size || 0,
      file_mtime_ms: target.mtime || 0,
      header_cwd: header && header.cwd ? header.cwd : null,
      header_state: header ? 'ok' : 'header-unverified',
      created_at: header && header.createdAt ? header.createdAt : now,
      title: '',
      archived_at: archivedNow ? now : null,
      backfilled: archivedNow ? 1 : 0,
      // P4（FR-P4-2）：header 事实（冷目标读不到 header ⇒ 未知，绝不用 0 冒充「不是子代理」）
      origin: facts.origin,
      delegation_depth: facts.delegationDepth,
      parent_session: facts.parentSession,
      moved_at: null,
      restored_at: null,
      status: target.cold ? 'cold' : 'hot',
      favorite: 0,
      error: null,
      next_attempt: null,
      user_msgs: 0,
      assistant_msgs: 0,
      first_user_text: '',
      last_assistant_text: '',
      indexed_at: null,
      source_sha: '',
    });
  }

  async needsIndex(target) {
    const wm = parseWatermark(this.store.getMeta(watermarkKey(target.id)));
    if (!wm) return true;
    return wm.size !== Math.trunc(Number(target.size) || 0) || wm.mtime !== Math.trunc(Number(target.mtime) || 0) || wm.generation !== String(target.current || '');
  }

  /**
   * 索引一个目标（只索引**最高代际**）。
   * @param {object} target
   * @param {{force?:boolean, toolResults?:boolean|null}} [options]
   *   toolResults=true/false 显式指定抽取范围（升级 pass 传 true）；省略则跟随 extractionScope()。
   * @returns {{ok:boolean, skipped?:boolean, docs?:number, error?:string}}
   */
  async indexTarget(target, { force = false, toolResults = null } = {}) {
    if (!target) return { ok: false, error: 'no-target' };
    if (!force && !(await this.needsIndex(target))) return { ok: true, skipped: true };
    const row = await this.ensureRow(target);
    // M5（§13）：migrating / restoring 的行正被迁移/恢复尾段自己写，索引不插手（记录后跳过，下一轮再说）。
    if (row && (row.status === 'migrating' || row.status === 'restoring')) {
      this.log('info', '索引跳过（会话正在 ' + row.status + '，由迁移/恢复尾段写入）：' + target.id);
      return { ok: false, skipped: true, reason: 'busy-status', status: row.status };
    }
    if (row && !target.cold) {
      const patch = {};
      if (row.project_key !== target.projectKey) patch.project_key = target.projectKey;
      if (!row.rel_dir) patch.rel_dir = target.projectKey + '/' + target.id;
      if (row.log_names !== target.generations.join(',')) patch.log_names = target.generations.join(',');
      if (target.version !== null && target.version !== undefined && row.format_version !== target.version) patch.format_version = target.version;
      if (row.file_size !== target.size) patch.file_size = target.size;
      if (row.file_mtime_ms !== target.mtime) patch.file_mtime_ms = target.mtime;
      if (!row.bytes) patch.bytes = target.size;
      if (Object.keys(patch).length) this.store.updateSession(target.id, patch);
    }
    // M5（§13「所有写操作进 VaultEngine 单串行队列」）：不再直调 engine.indexSession 绕过队列。
    // 队列已重入时（迁移/恢复尾段里触发索引）engine.enqueue 会就地执行，不会自锁。
    // P3 / FR-P3-2：抽取范围（显式 > 升级 pass 目标 > 库内 scope）。
    const scope = toolResults === true
      ? SEARCH_SCOPE_TOOL_RESULTS
      : toolResults === false
        ? SEARCH_SCOPE_BODY
        : this.extractionScope();
    const wantsToolResults = scope === SEARCH_SCOPE_TOOL_RESULTS;
    const runIndex = () =>
      this.engine.indexSession(target.id, target.dir, {
        logNames: target.generations.join(','),
        currentGeneration: target.current,
        formatVersion: target.version,
        toolResults: wantsToolResults,
      });
    const result = typeof this.engine.enqueue === 'function' ? await this.engine.enqueue(runIndex) : await runIndex();
    this._updatedAt = this.now();
    if (result && result.ok && !result.skipped) this._indexedThisRun += 1;
    if (result && result.ok && !result.skipped) {
      // ① tool/result 计数：升级 pass **只扫**这些会话（FR-P3-2），所以 body 模式也要记。
      this.recordToolEvents(target, result.stats ? result.stats.toolResultEvents : 0);
      // ② 已抽标记：续做时按水位比较跳过（分批不重复、不遗漏，A-P3-10）。
      if (wantsToolResults) this._markToolScopeDone(target);
    }
    if (result && result.ok) {
      try {
        this.store.setMeta(watermarkKey(target.id), watermarkValue(target.size, target.mtime, target.current));
      } catch {
        /* 水位写失败：下一轮会重索引（安全方向） */
      }
    }
    return result;
  }

  /** 纯内存读数（也直接拿来落 meta——不能把「从 meta 读回来的旧值」再写回去）。 */
  _snapshot() {
    return {
      phase: this._phase,
      paused: this._pauseRequested || this._phase === 'paused',
      indexed: this._indexed,
      total: this._total,
      skipped: this._skipped,
      failed: this._failed,
      scannedAt: this._scannedAt || null,
      startedAt: this._startedAt,
      updatedAt: this._updatedAt,
      refreshedAt: this._lastRefreshAt || null,
      errors: this._errors.slice(-5),
      sync: { ...this._syncStats },
    };
  }

  /**
   * 对外读数。§15.1 #6：本进程还没跑过任何一轮时，读 meta 的**持久化读数**
   * （进度 / 暂停跨重启可见，/status 重启后不再恒 idle）。
   */
  progress() {
    const base = this._snapshot();
    // F5：三个口径必须分开给（真机出现过 indexed:19 / skipped:2225 / total:2273 被读成「只索引了 19 个」）
    //   coverage       = docs 侧 distinct session_id（**搜索实际能覆盖到的会话数**）
    //   indexedThisRun = 本进程这一轮索引成功的数量（跨重启从 meta 读时恒 0）
    //   indexed        = 任务计数（向后兼容；不是覆盖面）
    const enriched = {
      ...base,
      coverage: this.coverage(),
      indexedThisRun: this._indexedThisRun || 0,
    };
    const persisted = this._persisted;
    if (!persisted || this._startedAt !== null) return enriched;
    // 本进程内的显式暂停 / 出错优先（比上一次进程的读数新）
    if (this._pauseRequested || this._phase === 'paused' || this._phase === 'error') return base;
    const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    return {
      ...enriched,
      phase: typeof persisted.phase === 'string' ? persisted.phase : base.phase,
      paused: Boolean(persisted.paused),
      indexed: num(persisted.indexed, base.indexed),
      // persisted 读数来自**上一个进程的那一轮** ⇒ 本轮计数如实为 0（不冒充）。
      indexedThisRun: 0,
      total: num(persisted.total, base.total),
      skipped: num(persisted.skipped, base.skipped),
      failed: num(persisted.failed, base.failed),
      updatedAt: persisted.updatedAt === undefined ? base.updatedAt : persisted.updatedAt,
      scannedAt: persisted.scannedAt === undefined ? base.scannedAt : persisted.scannedAt,
      persisted: true,
    };
  }

  /** F5：有正文索引的会话数（docs 侧 distinct session_id），2s 缓存。 */
  coverage() {
    const now = this.now();
    if (this._coverageCache && now - this._coverageCache.at < this._coverageTtlMs) return this._coverageCache.value;
    let value = 0;
    try {
      value = typeof this.store.docCoverage === 'function'
        ? this.store.docCoverage()
        : Number((this.store.indexStats() || {}).coverage) || 0;
    } catch {
      value = 0;
    }
    this._coverageCache = { at: now, value };
    return value;
  }

  /**
   * 落 meta。`preserveWhenIdle` 用于「后台增量刷新」：本进程还没跑过任何一轮（phase=idle）时
   * 不能把上一次进程的 done + 计数覆盖成 0/0——只更新刷新时刻与暂停位（§15.1 #6 的跨重启读数）。
   */
  _persistProgress(options = {}) {
    try {
      const snapshot = this._snapshot();
      const preserve = options.preserveWhenIdle === true && this._startedAt === null && this._phase === 'idle' && this._persisted;
      const value = preserve
        ? {
            ...this._persisted,
            phase: snapshot.paused ? 'paused' : this._persisted.phase || snapshot.phase,
            paused: snapshot.paused,
            refreshedAt: snapshot.refreshedAt,
            scannedAt: snapshot.scannedAt || this._persisted.scannedAt,
            updatedAt: snapshot.updatedAt || this._persisted.updatedAt,
            sync: snapshot.sync,
          }
        : snapshot;
      this._persisted = value;
      this.store.setMeta(INDEX_PROGRESS_META, JSON.stringify(value));
    } catch {
      /* 进度写失败不影响索引 */
    }
  }

  _loadPersistedProgress() {
    try {
      const raw = this.store.getMeta(INDEX_PROGRESS_META);
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object') return null;
      this._persisted = value;
      return value;
    } catch {
      return null;
    }
  }
  /**
   * 读跨重启的 scope 进度（P3 / FR-P3-2：升级 pass 可暂停、可续做）。
   *
   *  - 上一次是 paused ⇒ 本次仍按暂停处理（不偷偷续跑，等 resume / syncScope）；
   *  - 上一次在跑（running / scanning / partial，即进程在 pass 中途死掉）⇒ 标成 paused 等续做；
   *    续做按 tscope 标记重算待做集合，因此「不重复、不遗漏」（A-P3-10）；
   *  - 上一次是 done-with-gaps ⇒ 如实读回（含未覆盖 id 列表），**不**自动重跑（M1：要用户点重建）。
   */
  _loadPersistedScope() {
    let value = null;
    try {
      const text = this.store.getMeta(SCOPE_PROGRESS_META);
      if (!text) return null;
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (!value || typeof value !== 'object') return null;
    this._scopePersisted = value;
    const phase = typeof value.phase === 'string' ? value.phase : 'idle';
    this._scopeTarget = SEARCH_SCOPES.includes(value.target) ? value.target : null;
    if (phase === 'paused' || phase === 'running' || phase === 'scanning' || phase === 'partial') {
      this._scopePhase = 'paused';
      this._scopePauseRequested = true;
    } else if (phase === 'done') {
      this._scopePhase = 'done';
    } else if (phase === 'done-with-gaps') {
      this._scopePhase = 'done-with-gaps';
    } else if (phase === 'error') {
      this._scopePhase = 'error';
    }
    const num = (input, fallback) => (Number.isFinite(Number(input)) ? Number(input) : fallback);
    this._scopeIndexed = num(value.indexed, 0);
    this._scopeSkipped = num(value.skipped, 0);
    this._scopeFailed = num(value.failed, 0);
    this._scopeTotal = num(value.total, 0);
    this._scopeRound = num(value.round, 0);
    this._scopeGaps = Array.isArray(value.gaps) ? value.gaps.map(String) : [];
    this._scopeStartedAt = num(value.startedAt, null);
    this._scopeUpdatedAt = num(value.updatedAt, null);
    this._scopeErrors = Array.isArray(value.errors) ? value.errors.slice(-5) : [];
    return value;
  }

  // ---- 检索范围（P3 / FR-P3-2 / A-P3-2 / A-P3-10） ---------------------

  /** 库内**实际**检索范围（meta index:scope）；缺失/脏值按默认 body 读（不猜）。 */
  libraryScope() {
    try {
      const raw = this.store.getMeta(SEARCH_SCOPE_META);
      return SEARCH_SCOPES.includes(raw) ? raw : DEFAULT_SEARCH_SCOPE;
    } catch {
      return DEFAULT_SEARCH_SCOPE;
    }
  }

  /**
   * 正常索引（水位重索引 / 增量刷新）该用哪个抽取范围。
   *
   * 升级 pass 排定/在跑时直接用目标 scope 抽取：否则 pass 期间被其它路径重索引的会话
   * 会缺 tool 文档，而 pass 完成后水位没变又不会再补（等于永久漏）。
   */
  extractionScope() {
    if (this._scopeTarget === SEARCH_SCOPE_TOOL_RESULTS) {
      if (
        this._scopePhase === 'running'
        || this._scopePhase === 'scanning'
        || this._scopePhase === 'paused'
        || this._scopePhase === 'partial'
      ) return SEARCH_SCOPE_TOOL_RESULTS;
    }
    return this.libraryScope();
  }

  _scopeSnapshot() {
    return {
      phase: this._scopePhase,
      paused: Boolean(this._scopePauseRequested || this._scopePhase === 'paused'),
      done: this._scopePhase === 'done',
      // M1：done-with-gaps 是「已收敛但未覆盖全部」的显式终态（不是 done，也不是 error）。
      doneWithGaps: this._scopePhase === 'done-with-gaps',
      target: this._scopeTarget,
      indexed: this._scopeIndexed,
      skipped: this._scopeSkipped,
      failed: this._scopeFailed,
      total: this._scopeTotal,
      round: this._scopeRound,
      maxRounds: SCOPE_MAX_ROUNDS,
      // M1：未覆盖的会话 id（/status.scope.gaps + 面板黄条「N 个会话未覆盖（可重建）」）。
      gaps: this._scopeGaps.slice(),
      gapsCount: this._scopeGaps.length,
      startedAt: this._scopeStartedAt,
      updatedAt: this._scopeUpdatedAt,
      errors: this._scopeErrors.slice(-5),
    };
  }

  /** 对外读数（/status 的 scope 段）：配置值 + 库内值 + pass 进度。 */
  scopeSnapshot() {
    const base = this._scopeSnapshot();
    const libraryScope = this.libraryScope();
    const searchScope = SEARCH_SCOPES.includes(this._desiredScope) ? this._desiredScope : libraryScope;
    if (this._scopeStartedAt !== null || this._scopePhase !== 'idle' || !this._scopePersisted) {
      return { ...base, searchScope, libraryScope };
    }
    // 本进程没碰过 scope，但上一进程有读数 ⇒ 如实透出（persisted:true，别伪装成 idle）
    const persisted = this._scopePersisted;
    const num = (input, fallback) => (Number.isFinite(Number(input)) ? Number(input) : fallback);
    const phase = typeof persisted.phase === 'string' ? persisted.phase : base.phase;
    const gaps = Array.isArray(persisted.gaps) ? persisted.gaps.map(String) : base.gaps;
    return {
      ...base,
      phase,
      paused: Boolean(persisted.paused),
      done: phase === 'done',
      doneWithGaps: phase === 'done-with-gaps',
      target: SEARCH_SCOPES.includes(persisted.target) ? persisted.target : base.target,
      indexed: num(persisted.indexed, base.indexed),
      skipped: num(persisted.skipped, base.skipped),
      failed: num(persisted.failed, base.failed),
      total: num(persisted.total, base.total),
      round: num(persisted.round, base.round),
      gaps,
      gapsCount: gaps.length,
      updatedAt: persisted.updatedAt === undefined ? base.updatedAt : persisted.updatedAt,
      persisted: true,
      searchScope,
      libraryScope,
    };
  }

  _persistScopeProgress(extra = {}) {
    try {
      const value = { ...this._scopeSnapshot(), ...extra, libraryScope: this.libraryScope() };
      this._scopePersisted = value;
      this.store.setMeta(SCOPE_PROGRESS_META, JSON.stringify(value));
    } catch {
      /* 进度写失败不影响 pass */
    }
  }

  toolCountKey(sessionId) {
    return TOOL_COUNT_PREFIX + String(sessionId);
  }

  toolScopeKey(sessionId) {
    return TOOL_SCOPE_PREFIX + String(sessionId);
  }

  /**
   * 记一条「这个会话见过 N 条 tool/result」。**0 也要写**：
   *  - '0' = 已知没有工具结果 ⇒ 升级 pass 直接跳过（FR-P3-2「只扫含 tool/result 的会话」）；
   *  - 键缺失 = 本批落地**之前**索引的旧行（计数未知）⇒ 首次升级 pass 必须扫一遍才能发现，
   *    否则旧会话里已有的工具结果永远不会进索引（那才是静默遗漏）。扫过一次就记 '0' 或 N。
   */
  recordToolEvents(target, count) {
    const value = Math.max(0, Math.trunc(Number(count) || 0));
    try {
      this.store.setMeta(this.toolCountKey(target.id), String(value));
    } catch {
      /* 计数写失败：该会话可能漏出升级 pass —— 安全方向是「下次全量重索引时再补」 */
    }
  }

  /** 该会话是否已在**当前水位**下抽过 tool 文档（续做判据：不重复、不遗漏）。 */
  toolScopeDone(target) {
    try {
      const marker = this.store.getMeta(this.toolScopeKey(target.id));
      if (!marker) return false;
      return marker === watermarkValue(target.size, target.mtime, target.current);
    } catch {
      return false;
    }
  }

  _markToolScopeDone(target) {
    try {
      this.store.setMeta(this.toolScopeKey(target.id), watermarkValue(target.size, target.mtime, target.current));
    } catch {
      /* 标记写失败：下次续做会重抽一次（幂等，只是多花时间） */
    }
  }

  _clearToolScopeMarkers() {
    try {
      for (const key of this.store.listMetaKeys(TOOL_SCOPE_PREFIX)) this.store.deleteMeta(key);
    } catch {
      /* 清标记失败：降级已删 docs；残留标记只会让下次升级少抽一次（由水位比较兜底） */
    }
  }

  /**
   * 升级 pass 的待做集合：**只扫含 tool/result 的会话**（FR-P3-2），且跳过已在该水位抽过的。
   *
   * 「含」的判据是索引时写下的 tool 计数（见 recordToolEvents）：
   *  - '0'   ⇒ 已知没有工具结果，跳过（这才是「只扫含 tool/result 的会话」的实际含义）；
   *  - 缺失  ⇒ 本批之前的旧索引，计数未知 —— 只有**首次**升级会把它纳入，扫过即记账，之后不再白扫。
   *
   * 前置：this.targets 已扫描（runFullIndex / scanTargets 之后）。
   */
  pendingToolTargets() {
    const out = [];
    for (const target of this.orderedTargets()) {
      let raw = null;
      try {
        raw = this.store.getMeta(this.toolCountKey(target.id));
      } catch {
        raw = null;
      }
      if (raw !== null && raw !== undefined) {
        const count = Number(raw);
        if (!Number.isFinite(count) || count <= 0) continue;
      }
      if (this.toolScopeDone(target)) continue;
      out.push(target);
    }
    return out;
  }

  /** 读配置里的 scope（engine.config 不可用时回落到库内 scope，不抛）。 */
  async configScope() {
    try {
      const cfg = await this.engine.config();
      return normalizeSearchScope(cfg && cfg.searchScope, DEFAULT_SEARCH_SCOPE);
    } catch {
      return this.libraryScope();
    }
  }

  /**
   * **范围切换的唯一入口**（FR-P3-2 的 scopeSwitch 伪代码）：
   *  - 配置与库内一致 ⇒ 无事（顺手把 phase 收敛成 done）；
   *  - 降级（→ body）⇒ 只 DELETE FROM docs WHERE surface='tool-result'，**不重读日志**；
   *  - 升级（→ body+toolResults）⇒ 后台增量 pass（可暂停/续做），**完成时才写 meta index:scope**；
   *    期间库内仍是旧 scope（旧 scope 保持可查）。
   */
  async syncScope(desiredInput) {
    const desired = SEARCH_SCOPES.includes(desiredInput) ? desiredInput : await this.configScope();
    this._desiredScope = desired;
    const library = this.libraryScope();
    if (desired === library) {
      if (this._scopeTarget && this._scopePhase !== 'done') {
        // 配置退回库内 scope ⇒ 取消在跑的升级 pass（不写 scope；已抽的 tool 文档由下方降级逻辑处理）
        await this.cancelScopePass();
        if (desired === SEARCH_SCOPE_BODY) return this.downgradeScope();
        return this.scopeSnapshot();
      }
      if (this._scopePhase !== 'done') {
        this._scopePhase = 'done';
        this._scopeTarget = null;
        this._scopeUpdatedAt = this.now();
        this._persistScopeProgress();
      }
      return this.scopeSnapshot();
    }
    if (desired === SEARCH_SCOPE_BODY) return this.downgradeScope();
    // done-with-gaps 是「轮数用尽」的终态；**显式保存配置**（syncScope 的调用方 /config）是用户的
    // 明确动作 ⇒ 允许清掉终态重来一轮。轮询（ensureScope）在这之前就早退，不会自动重跑。
    if (this._scopePhase === 'done-with-gaps') {
      this._scopePhase = 'idle';
      this._scopeGaps = [];
      this._clearScopeGapsMeta();
      this._scopeUpdatedAt = this.now();
      this._persistScopeProgress();
    }
    return this.upgradeScope(desired);
  }

  /** 设计档 §18.4.1 伪代码里的名字（scopeSwitch）：与 syncScope 同一实现。 */
  scopeSwitch(next) {
    return this.syncScope(next);
  }

  /** 设计档 §18.4.1 伪代码里的名字（enqueue(indexer.extractToolResults)）：起升级 pass。 */
  extractToolResults() {
    return this.upgradeScope(SEARCH_SCOPE_TOOL_RESULTS);
  }

  /** 取消在跑的 pass（等它退出，确保调用方之后的状态是确定的）。 */
  async cancelScopePass() {
    this._scopeAbort = true;
    const running = this._scopeRunPromise;
    if (running) {
      try {
        await running;
      } catch {
        /* 取消路径不因 pass 异常而失败 */
      }
    }
    this._scopeAbort = false;
  }

  /**
   * 降级：只删 tool 文档（不重读日志）+ 清 pass 标记 + 写库内 scope = body。
   * 先取消在跑的 pass（外部入口）；pass **内部**要降级时只能调 _applyDowngrade()
   * —— cancelScopePass() 会 await _scopeRunPromise，而那时它正是当前这层 promise ⇒ 自锁。
   */
  async downgradeScope() {
    await this.cancelScopePass();
    return this._applyDowngrade();
  }

  /** 降级本体（无自锁副作用；pass 内部与外部入口共用）。 */
  _applyDowngrade() {
    let deleted = 0;
    try {
      deleted = this.store.deleteDocsBySurface('tool-result');
    } catch (err) {
      this.log('warn', '降级删除 tool 文档失败：' + (err && err.message ? err.message : err));
      return { ...this.scopeSnapshot(), deleted: 0, error: err && err.message ? err.message : String(err) };
    }
    this._clearToolScopeMarkers();
    try {
      this.store.setMeta(SEARCH_SCOPE_META, SEARCH_SCOPE_BODY);
    } catch {
      /* 写失败：库内 scope 仍报旧值（下一轮 syncScope 会重试），但 tool 文档已删 —— 不会搜到陈旧结果 */
    }
    this._scopeTarget = null;
    this._scopePauseRequested = false;
    this._scopePhase = 'done';
    this._scopeIndexed = 0;
    this._scopeSkipped = 0;
    this._scopeFailed = 0;
    this._scopeTotal = 0;
    this._scopeRound = 0;
    this._scopeGaps = [];
    this._clearScopeGapsMeta();
    this._scopeErrors = [];
    this._scopeStartedAt = null;
    this._scopeUpdatedAt = this.now();
    this._persistScopeProgress({ deleted });
    this.log('info', '检索范围降级为 body：删除 ' + deleted + ' 条工具结果文档（不重读日志）');
    return { ...this.scopeSnapshot(), deleted };
  }

  /** M1：清掉 done-with-gaps 的未覆盖 id 列表（成功 / 降级 / 新 pass 起步时）。 */
  _clearScopeGapsMeta() {
    try {
      this.store.deleteMeta(SCOPE_GAPS_META);
    } catch {
      /* 清失败不影响状态推进：内存的 gaps 已清，下一次 setMeta 会覆盖 */
    }
  }

  /**
   * 升级：起后台 pass（立即返回读数；真跑在 this._scopeRunPromise 上）。
   *
   * 三个**不自动重跑**的显式态（M1）：
   *  - done-with-gaps：轮数用尽仍有未覆盖会话 ⇒ 等用户点「重建」（resumeScope）；
   *  - paused：用户显式暂停 ⇒ 等用户点「续做」；
   *  - 正在跑：幂等。
   */
  upgradeScope(desiredInput = SEARCH_SCOPE_TOOL_RESULTS, options = {}) {
    const desired = SEARCH_SCOPES.includes(desiredInput) ? desiredInput : SEARCH_SCOPE_TOOL_RESULTS;
    if (desired !== SEARCH_SCOPE_TOOL_RESULTS) return Promise.resolve(this.scopeSnapshot());
    if (this._scopeRunPromise) return this.scopeSnapshot();
    if (this._scopePhase === 'done-with-gaps') return this.scopeSnapshot();
    // 尊重暂停：已暂停的 pass 不被「保存配置 / 打开页面」偷偷续跑（续做要显式 resume）。
    if (this._scopePauseRequested || this._scopePhase === 'paused') return this.scopeSnapshot();
    this._scopeTarget = desired;
    this._scopeAbort = false;
    this._scopePhase = 'scanning';
    this._scopePauseRequested = false;
    this._scopeStartedAt = this.now();
    this._scopeUpdatedAt = this._scopeStartedAt;
    this._scopeErrors = [];
    this._persistScopeProgress();
    this._scopeRunPromise = this._runScopePass(desired, options)
      .catch((err) => {
        this._scopePhase = 'error';
        this._scopeErrors.push({ id: null, error: err && err.message ? err.message : String(err) });
        this._scopeUpdatedAt = this.now();
        this._persistScopeProgress();
        this.log('warn', '检索范围升级失败（库内 scope 保持旧值）：' + (err && err.message ? err.message : err));
        return this.scopeSnapshot();
      })
      .finally(() => {
        this._scopeRunPromise = null;
      });
    return this.scopeSnapshot();
  }

  /**
   * 暂停 scope pass（当前会话做完即停）。
   * S4：与全量索引的 pause() **完全解耦** —— 暂停索引不会暂停 pass，暂停 pass 也不会暂停索引。
   */
  pauseScope() {
    this._scopePauseRequested = true;
    // 只有「还能继续跑」的相位才需要落 paused；done / done-with-gaps / error 是终态，
    // 暂停它们不能把终态改写成 paused（那会让 /status 与面板黄条丢掉未覆盖事实）。
    const pausable = this._scopePhase === 'idle' || this._scopePhase === 'scanning' || this._scopePhase === 'running' || this._scopePhase === 'partial';
    if (!this._scopeRunPromise && pausable) this._scopePhase = 'paused';
    this._scopeUpdatedAt = this.now();
    this._persistScopeProgress();
    return this.scopeSnapshot();
  }

  /**
   * 续做 scope pass（按 tscope 标记重算待做集合：分批不重复、不遗漏）。
   *
   * R5：续跑前**先读配置 scope**——配置已回 body ⇒ 取消 pass + 降级删 tool 文档，不续跑。
   * 配置读取发生在 _runScopePass 的开头（本方法与 upgradeScope 都同步派发 pass，读配置在 pass 内部完成），
   * 这样调用方拿到的仍是「已排定」的确定状态，暂停/取消语义不变。
   * M1：done-with-gaps 的「重建」也走这里（清掉终态后重新起 pass）。
   */
  resumeScope() {
    this._scopePauseRequested = false;
    if (this._scopePhase === 'paused' || this._scopePhase === 'done-with-gaps' || this._scopePhase === 'partial') {
      this._scopePhase = 'idle';
    }
    this._scopeUpdatedAt = this.now();
    this._persistScopeProgress();
    if (!this._scopeTarget) return this.scopeSnapshot();
    // R5：只有**续跑**这条路要在开跑前读配置（fresh 升级的 desired 就是配置值/显式调用，
    // 读配置反而会把「显式 syncScope('body+toolResults') 但配置还没落盘」的正常路径误判成降级）。
    return this.upgradeScope(this._scopeTarget, { checkConfig: true });
  }

  /**
   * 启动/轮询时的 scope 自愈：配置与库内不一致就按方向处理（降级立即、升级后台）。
   * 暂停中的 pass 不会被偷偷续跑（由 ensureScope 早退）。
   */
  async ensureScope() {
    if (this._scopeRunPromise) return this.scopeSnapshot();
    // M1：done-with-gaps 是**显式待处置态** —— /status、/list、/search 的轮询不得自动重跑
    // （否则每次轮询都重试一轮，等于无限后台重试）。重建入口是 resumeScope（/rebuild-index resume-scope）。
    if (this._scopePhase === 'done-with-gaps' || this._scopeGaps.length) return this.scopeSnapshot();
    const desired = await this.configScope();
    this._desiredScope = desired;
    const library = this.libraryScope();
    if (desired === library) {
      if (!this._scopeTarget) return this.scopeSnapshot();
    }
    // 暂停态：只记配置，不自动续做（resume 的显式动作归用户）
    if ((this._scopePauseRequested || this._scopePhase === 'paused') && this._scopeTarget) return this.scopeSnapshot();
    return this.syncScope(desired);
  }

  async _runScopePass(desired, options = {}) {
    this._scopePhase = 'scanning';
    this._scopeStartedAt = this.now();
    this._scopeIndexed = 0;
    this._scopeSkipped = 0;
    this._scopeFailed = 0;
    this._scopeTotal = 0;
    this._scopeRound = 0;
    this._scopeGaps = [];
    this._scopeErrors = [];
    // 新 pass 起步 ⇒ 上一轮的 gaps 列表作废（避免陈旧黄条与新进度并存）。
    this._clearScopeGapsMeta();
    this._persistScopeProgress();
    // R5：**续跑**前先读配置 scope（options.checkConfig）。配置已回 body ⇒ 取消 pass + 降级
    // （删 tool 文档），不续跑。fresh 升级不读配置：它的 desired 来自配置保存或显式调用。
    let configured = desired;
    if (options && options.checkConfig === true) {
      try {
        configured = await this.configScope();
      } catch {
        configured = desired;
      }
      this._desiredScope = configured;
    }
    if (options && options.checkConfig === true && configured === SEARCH_SCOPE_BODY) {
      this.log('info', '配置已是 body：取消检索范围升级并降级（不续跑）');
      this._scopeAbort = false;
      this._scopeTarget = null;
      this._scopePauseRequested = false;
      this._scopePhase = 'idle';
      this._scopeUpdatedAt = this.now();
      this._persistScopeProgress();
      // 注意：这里**不能**调 downgradeScope()（它会 await _scopeRunPromise，而本函数就是它 ⇒ 自锁）。
      return this._applyDowngrade();
    }
    // 全量索引在飞时先等它：它会给每个会话记 tool 计数（先跑 pass 会漏掉还没索引过的会话）。
    if (this._runPromise) {
      try {
        await this._runPromise;
      } catch {
        /* 全量索引失败不阻塞 scope pass：失败会话由后续重试补 */
      }
    }
    if (this._scopeAbort) return this._abortScopePass();
    await this.scanTargets({ force: true });
    let pending = this.pendingToolTargets();
    this._scopeTotal = pending.length;
    this._scopePhase = 'running';
    this._persistScopeProgress();
    // M1（用户裁定 A）：有失败/被跳过的会话 ⇒ 不写 index:scope、phase=partial，按未覆盖集合
    // **自动重试最多 SCOPE_MAX_ROUNDS 轮**；轮数用尽仍失败 ⇒ done-with-gaps（禁止无限阻塞 / 静默 done）。
    for (let round = 1; round <= SCOPE_MAX_ROUNDS; round += 1) {
      this._scopeRound = round;
      const uncovered = [];
      for (const target of pending) {
        if (this._scopeAbort) return this._abortScopePass();
        if (this._scopePauseRequested) {
          this._scopePhase = 'paused';
          this._scopeUpdatedAt = this.now();
          this._persistScopeProgress();
          return this.scopeSnapshot();
        }
        try {
          const result = await this.indexTarget(target, { force: true, toolResults: true });
          if (result && result.ok) this._scopeIndexed += 1;
          else if (result && result.skipped) {
            this._scopeSkipped += 1;
            uncovered.push(target.id);
          } else {
            this._scopeFailed += 1;
            this._scopeErrors.push({ id: target.id, error: (result && result.error) || 'index-failed' });
            uncovered.push(target.id);
          }
        } catch (err) {
          this._scopeFailed += 1;
          this._scopeErrors.push({ id: target.id, error: err && err.message ? err.message : String(err) });
          uncovered.push(target.id);
        }
        this._scopeUpdatedAt = this.now();
        this._persistScopeProgress();
        // 每会话让出事件循环：pass 不把宿主/HTTP 卡住，也保证 pause/abort 能及时生效。
        await new Promise((resolve) => setImmediate(resolve));
      }
      this._scopeGaps = uncovered;
      if (!uncovered.length) break;
      if (round >= SCOPE_MAX_ROUNDS) break;
      // 本轮有未覆盖 ⇒ phase=partial（**不写** index:scope，库内仍是旧 scope），只重试未覆盖的会话。
      this._scopePhase = 'partial';
      this._scopeUpdatedAt = this.now();
      this._persistScopeProgress();
      this.log(
        'info',
        '检索范围升级第 ' + round + ' 轮有 ' + uncovered.length + ' 个会话未覆盖，自动重试（最多 ' + SCOPE_MAX_ROUNDS + ' 轮）',
      );
      pending = uncovered.map((id) => (this.targets ? this.targets.get(id) : null)).filter(Boolean);
      if (!pending.length) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (this._scopeGaps.length) {
      // 轮数用尽仍有未覆盖：**不写 index:scope**（库内 scope 保持旧值），落 meta index:scope-gaps 供
      // /status.scope.gaps 与面板黄条展示；重建入口是 resumeScope（/rebuild-index resume-scope）。
      this._scopePhase = 'done-with-gaps';
      this._scopeTarget = desired;
      this._scopeUpdatedAt = this.now();
      try {
        this.store.setMeta(SCOPE_GAPS_META, JSON.stringify(this._scopeGaps));
      } catch (err) {
        this.log('warn', '未覆盖会话列表写入失败（读数仍在本进程）：' + (err && err.message ? err.message : err));
      }
      this._persistScopeProgress();
      this.log(
        'warn',
        '检索范围升级有 ' + this._scopeGaps.length + ' 个会话未覆盖（' + SCOPE_MAX_ROUNDS + ' 轮后仍失败）：phase=done-with-gaps，未写库内 scope，可重建',
      );
      return this.scopeSnapshot();
    }
    // 后置（FR-P3-2）：**库内 scope 与目标一致之后**才切 phase='done'。
    try {
      this.store.setMeta(SEARCH_SCOPE_META, desired);
    } catch (err) {
      this._scopePhase = 'error';
      this._scopeErrors.push({ id: null, error: 'scope-write-failed: ' + (err && err.message ? err.message : err) });
      this._scopeUpdatedAt = this.now();
      this._persistScopeProgress();
      return this.scopeSnapshot();
    }
    this._scopeTarget = null;
    this._scopePhase = 'done';
    this._scopeGaps = [];
    this._clearScopeGapsMeta();
    this._scopeUpdatedAt = this.now();
    this._persistScopeProgress();
    this.log(
      'info',
      '检索范围升级完成：' + desired + '（抽取 ' + this._scopeIndexed + ' / 跳过 ' + this._scopeSkipped + ' / 失败 ' + this._scopeFailed + '，共 ' + this._scopeTotal + '，' + this._scopeRound + ' 轮）',
    );
    return this.scopeSnapshot();
  }

  _abortScopePass() {
    this._scopeAbort = false;
    this._scopePhase = 'idle';
    this._scopeTarget = null;
    this._scopePauseRequested = false;
    this._scopeGaps = [];
    this._scopeRound = 0;
    this._clearScopeGapsMeta();
    this._scopeUpdatedAt = this.now();
    this._persistScopeProgress();
    return this.scopeSnapshot();
  }

  /**
   * 首次全量索引（后台任务）。可暂停 / 续做：
   *  - pause() 后当前目标做完即停（phase=paused）；
   *  - resume() 重新从扫描开始，已索引且水位未变的会话直接 skipped（断点续做）。
   */
  async runFullIndex() {
    if (this._runPromise) return this._runPromise;
    this._runPromise = this._runFull().finally(() => {
      this._runPromise = null;
    });
    return this._runPromise;
  }

  async _runFull() {
    this._phase = 'scanning';
    this._startedAt = this.now();
    this._indexed = 0;
    this._indexedThisRun = 0;
    this._total = 0;
    this._skipped = 0;
    this._failed = 0;
    this._errors = [];
    this._persistProgress();
    await this.scanTargets({ force: true });
    const ordered = this.orderedTargets();
    this._total = ordered.length;
    this._phase = 'indexing';
    this._persistProgress();
    for (const target of ordered) {
      if (this._pauseRequested) {
        this._phase = 'paused';
        this._persistProgress();
        return this.progress();
      }
      try {
        const result = await this.indexTarget(target);
        if (result && result.skipped) this._skipped += 1;
        else if (result && result.ok) this._indexed += 1;
        else {
          this._failed += 1;
          this._errors.push({ id: target.id, error: (result && result.error) || 'index-failed' });
        }
      } catch (err) {
        this._failed += 1;
        this._errors.push({ id: target.id, error: err && err.message ? err.message : String(err) });
      }
      this._updatedAt = this.now();
      if ((this._indexed + this._failed + this._skipped) % FULL_INDEX_YIELD_EVERY === 0) {
        this._persistProgress();
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    this._phase = 'done';
    this._persistProgress();
    // M3 / P3b.1：全量索引收敛 ⇒ 把索引 schema 写回 meta（只有**瞬态**失败的轮次才不写，下次启动重试）。
    this._markSchemaComplete();
    // FR-P4-2 触发 ④（设计档 §19.5 / 2026-10-27 审计 #3）：全量索引完成时触发一次
    // **过期才跑**的 header 事实扫描。它只读遍历、与 subagentMigrate 开关无关；失败只记日志。
    await this.refreshSubscanFacts();
    this.log('info', '全量索引完成：索引 ' + this._indexed + ' / 跳过 ' + this._skipped + ' / 失败 ' + this._failed + '（共 ' + this._total + '）');
    return this.progress();
  }

  /**
   * FR-P4-2 触发 ④：全量索引完成后补一次 header 事实扫描（`subscan:at` 过期才真的跑）。
   *
   * 前置：engine 提供 subscanSnapshot / scanHeaderFacts（老版本引擎 / 测试桩 ⇒ no-op）。
   * 后置：**只读**，不搬移任何文件；失败只记日志 —— 扫描是 class S 的读数面，
   *       绝不能因为补扫失败把一轮索引判成失败（索引与扫描是两件事）。
   */
  async refreshSubscanFacts() {
    const engine = this.engine;
    if (!engine || typeof engine.scanHeaderFacts !== 'function') return null;
    try {
      const snapshot = typeof engine.subscanSnapshot === 'function' ? engine.subscanSnapshot() : null;
      if (snapshot && snapshot.fresh) return snapshot;
      return await engine.scanHeaderFacts({});
    } catch (err) {
      this.log(
        'warn',
        '全量索引完成后的 header 事实扫描失败（class S 沿用上一次快照）：' + (err && err.message ? err.message : err),
      );
      return null;
    }
  }

  // ---- 索引 schema（M3） -------------------------------------------------

  /**
   * 读 meta 'index:schema' + 'index:schema-gaps' 的现值。
   *
   * 返回 `{schema, stored, rebuildNeeded, gaps, gapsCount, doneWithGaps}`；读法在 config.js 里与
   * engine 的兜底读数共用（`indexSchemaSnapshotFrom`），避免 /status 的两条路径口径漂移。
   * 缺失/脏值 ⇒ stored=null、gaps=[]（不猜、不冒充已完成的版本）。
   */
  _readSchemaState() {
    try {
      return indexSchemaSnapshotFrom(this.store);
    } catch {
      return {
        /** 期望版本（代码里的常量）。 */
        schema: INDEX_SCHEMA_VERSION,
        /** 库内已完成的版本；null = 缺失/不可读。 */
        stored: null,
        rebuildNeeded: true,
        gaps: [],
        gapsCount: 0,
        doneWithGaps: false,
      };
    }
  }

  /**
   * 对外读数（/status.index 的 schema 段）：期望版本 + 库内版本 + 是否需要重建 + 是否正在重建
   * + 未覆盖会话（gaps / gapsCount / doneWithGaps，P3b.1）。
   * 每次现读 meta：别的实例写回的版本也要如实反映（不能拿初始化时的快照冒充现状）。
   */
  schemaSnapshot() {
    const state = this._readSchemaState();
    return {
      ...state,
      rebuilding: Boolean(this._schemaRunPromise),
      startedAt: this._schemaRebuildAt,
    };
  }

  /** 清掉全部水位（schema 重建要真正重抽每一个会话，而不是被旧水位跳过）。 */
  _clearWatermarks() {
    let cleared = 0;
    try {
      for (const key of this.store.listMetaKeys(WATERMARK_PREFIX)) {
        this.store.deleteMeta(key);
        cleared += 1;
      }
    } catch {
      /* 清水位失败：本次重建会跳过已索引会话；schema 不写回，下次启动再试（安全方向） */
    }
    return cleared;
  }

  /** 全量重建（M3）：清水位 → 后台全量索引（可暂停/续做）→ 收敛后按失败类别写回 schema（见 _markSchemaComplete）。 */
  rebuildSchema() {
    if (this._schemaRunPromise) return this._schemaRunPromise;
    if (this._runPromise) return this._runPromise;
    const state = this._readSchemaState();
    this._schema = { ...state, rebuildNeeded: true };
    this._schemaRebuildAt = this.now();
    const cleared = this._clearWatermarks();
    this._clearToolScopeMarkers();
    this.log(
      'info',
      '索引 schema 需要重建（库内 ' + (state.stored === null ? '缺失' : state.stored) + ' / 期望 ' + INDEX_SCHEMA_VERSION + '）：清水位 ' + cleared + ' 条，后台全量重建（可暂停）',
    );
    this._schemaRunPromise = this.runFullIndex()
      .catch((err) => {
        this.log('warn', '索引 schema 重建失败（下次启动重试）：' + (err && err.message ? err.message : err));
        return this.progress();
      })
      .finally(() => {
        this._schemaRunPromise = null;
      });
    return this._schemaRunPromise;
  }

  /**
   * 把本轮 `_errors` 分成「确定性数据失败」与「瞬态失败」两类（P3b.1）。
   *
   *  - 确定性：同一份日志再抽一次仍会失败（extract-empty / frame-corrupt / identity-mismatch）
   *    ⇒ 计入 gaps，**不阻塞** schema 写回；
   *  - 瞬态：IO / 未知异常 / `index-failed` ⇒ 本轮不写 schema，下次启动重建重试。
   *
   * 后置：`deterministic` 与 `transient` 的元素都是 `{id,error}`；顺序与 `_errors` 一致。
   */
  _classifyRunFailures() {
    const deterministic = [];
    const transient = [];
    for (const item of Array.isArray(this._errors) ? this._errors : []) {
      const id = item && item.id !== undefined && item.id !== null ? String(item.id) : '';
      const error = item && item.error !== undefined && item.error !== null ? String(item.error) : 'index-failed';
      const code = deterministicIndexError(error);
      if (code) deterministic.push({ id, error: code });
      else transient.push({ id, error });
    }
    return { deterministic, transient };
  }

  /**
   * 落 meta 'index:schema-gaps'（确定性失败清单）；空清单 ⇒ 删除该键（全部覆盖后黄条必须消失）。
   * 写失败只记日志、不抛：schema 写回是主事件，gaps 是诊断面（失败时下一个重建轮会重写）。
   */
  _writeSchemaGaps(gaps) {
    try {
      if (gaps && gaps.length) this.store.setMeta(INDEX_SCHEMA_GAPS_META, JSON.stringify(gaps));
      else this.store.deleteMeta(INDEX_SCHEMA_GAPS_META);
      return true;
    } catch (err) {
      this.log('warn', '索引未覆盖会话清单写入失败（读数可能过期）：' + (err && err.message ? err.message : err));
      return false;
    }
  }

  /**
   * 全量索引收敛后写回 schema（P3b.1 真机修复：确定性失败不再阻塞写回）。
   *
   * 三支：
   *  ① 库内已是当前版本 ⇒ **不重建、不改写版本**（即使有 gaps）；跑到终态时顺带对齐 gaps 读数
   *     （有确定性失败就写，没有且无瞬态就清）。
   *  ② 有瞬态失败 ⇒ **不写** schema（也没落 gaps），下次启动重建重试。
   *  ③ 只有确定性失败（或全无失败）⇒ 写 gaps（可能为空）+ 写回 schema 版本。
   *
   * 前置：本轮 `_runFull` 已跑完全部目标（`_errors` 是整轮的代表性读数）。
   * 后置：返回 true 表示此刻 `index:schema` 等于当前版本；false 表示下次启动会重建。
   */
  _markSchemaComplete() {
    const state = this._readSchemaState();
    const { deterministic, transient } = this._classifyRunFailures();
    if (state.stored === INDEX_SCHEMA_VERSION) {
      // 已经完成过：绝不因为失败/瞬态把版本抹掉（那正是「每次启动全量重抽」的根因）。
      if (transient.length) {
        this.log('warn', '索引 schema 已完成（版本 ' + state.stored + '）：本轮 ' + transient.length + ' 个瞬态失败不影响版本，未覆盖清单保持原样');
      } else {
        this._writeSchemaGaps(deterministic);
      }
      this._schema = { ...state, rebuildNeeded: false };
      return true;
    }
    if (transient.length) {
      this.log('warn', '索引 schema 未写回：本轮有 ' + transient.length + ' 个瞬态失败（IO/未知异常，下次启动重建重试）');
      this._schema = { ...state, rebuildNeeded: true };
      return false;
    }
    // 确定性 gaps 先落：schema 一旦写回，它就是「哪些会话没被索引」的唯一证据面。
    this._writeSchemaGaps(deterministic);
    try {
      this.store.setMeta(INDEX_SCHEMA_META, String(INDEX_SCHEMA_VERSION));
      this._schema = {
        schema: INDEX_SCHEMA_VERSION,
        stored: INDEX_SCHEMA_VERSION,
        rebuildNeeded: false,
        gaps: deterministic,
        gapsCount: deterministic.length,
        doneWithGaps: deterministic.length > 0,
      };
      this._schemaRebuildAt = this._schemaRebuildAt || this.now();
      if (deterministic.length) {
        this.log(
          'warn',
          '索引 schema 已写回（版本 ' + INDEX_SCHEMA_VERSION + '）：' + deterministic.length + ' 个会话属确定性数据失败，已落 index:schema-gaps（重启不会重建，可在面板手动重建重试）',
        );
      }
      return true;
    } catch (err) {
      this.log('warn', '索引 schema 写回失败（下次启动重建）：' + (err && err.message ? err.message : err));
      return false;
    }
  }

  /** 幂等启动（HTTP 首次 status/list/search 调用都会触发；重复调用不会重跑）。 */
  ensureStarted() {
    if (this._runPromise) return this._runPromise;
    // §15.1 #6：上一个进程里被暂停 ⇒ 重启后仍保持暂停（不偷偷续跑）。
    // 注意这条**先于** schema 检查：用户显式暂停的意图优先，schema 重建等 resume() 再起（仍是可暂停的）。
    if (!this._startedAt && this._persisted && this._persisted.paused) {
      this._pauseRequested = true;
      if (this._phase === 'idle') this._phase = 'paused';
      return Promise.resolve(this.progress());
    }
    // M3：schema 缺失/不一致 ⇒ 先清水位再全量重建（后台、可暂停），收敛后写回 meta。
    const schema = this.schemaSnapshot();
    if (schema.rebuildNeeded) return this.rebuildSchema();
    if (this._phase === 'done' || (this._phase === 'paused' && this._pauseRequested)) {
      // M1：全量已完成后仍要持续发现新会话 ⇒ 后台按 TTL（默认 5 分钟）重扫 + 增量索引。
      this._autoRefresh();
      return Promise.resolve(this.progress());
    }
    return this.runFullIndex().catch((err) => {
      this._phase = 'error';
      this._errors.push({ id: null, error: err && err.message ? err.message : String(err) });
      this._persistProgress();
      return this.progress();
    });
  }

  /**
   * 强制重扫（发现新会话 / 目录变化）：即使上一次全量已 done，也重新扫描目标列表。
   * HTTP 的 `rebuild-index {"action":"start"}` 走这条；已索引且水位未变的会话仍会被跳过。
   */
  async rescan() {
    if (this._runPromise) return this._runPromise;
    this._pauseRequested = false;
    this._phase = 'idle';
    return this.runFullIndex();
  }

  /**
   * M1（偏离审计）：目标集过期就重扫，并把新出现 / 水位变化的会话增量索引掉。
   * 旧实现只在首次 scanTargets 时扫一次目录 ⇒ 全量 done 之后新建的会话永远搜不到。
   * @param {{force?:boolean, index?:boolean}} [options]
   * @returns {Promise<{rescanned:boolean, indexed:number, failed:number}>}
   */
  async refreshIfStale(options = {}) {
    const force = options.force === true;
    const withIndex = options.index !== false;
    // 全量任务在跑时由它自己维护目标集（避免两个扫描互相覆盖）
    if (this._runPromise) return { rescanned: false, indexed: 0, failed: 0 };
    if (!this.targets) {
      await this.scanTargets({ force: true });
      this._lastRefreshAt = this.now();
      this._persistProgress({ preserveWhenIdle: true });
      return { rescanned: true, indexed: 0, failed: 0 };
    }
    if (!force && this.now() - (this._scannedAt || 0) < this.targetsTtlMs) {
      return { rescanned: false, indexed: 0, failed: 0 };
    }
    await this.scanTargets({ force: true });
    this._lastRefreshAt = this.now();
    this._persistProgress({ preserveWhenIdle: true });
    if (!withIndex) return { rescanned: true, indexed: 0, failed: 0 };
    const result = await this.indexStaleTargets();
    return { rescanned: true, ...result };
  }

  /** 增量索引「新出现 / 水位变化」的目标（有界），不重置全量进度。 */
  async indexStaleTargets(limit = this.refreshIndexLimit) {
    const ordered = this.orderedTargets();
    let indexed = 0;
    let failed = 0;
    for (const target of ordered) {
      if (indexed >= limit) break;
      let stale = true;
      try {
        stale = await this.needsIndex(target);
      } catch {
        stale = true;
      }
      if (!stale) continue;
      try {
        const result = await this.indexTarget(target);
        if (result && result.ok) indexed += 1;
        else if (!(result && result.skipped)) failed += 1;
      } catch (err) {
        failed += 1;
        this._errors.push({ id: target.id, error: err && err.message ? err.message : String(err) });
      }
      if ((indexed + failed) % FULL_INDEX_YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    if (indexed || failed) {
      this._updatedAt = this.now();
      this._persistProgress({ preserveWhenIdle: true });
    }
    return { indexed, failed };
  }

  /** 后台增量刷新（ensureStarted 在 done/paused 之后调用；同一时刻只允许一个）。 */
  _autoRefresh() {
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = this.refreshIfStale({ index: true })
      .catch((err) => {
        this.log('warn', '增量刷新失败（不影响已有索引）：' + (err && err.message ? err.message : err));
        return { rescanned: false, indexed: 0, failed: 0 };
      })
      .finally(() => {
        this._refreshPromise = null;
      });
    return this._refreshPromise;
  }

  /**
   * 暂停全量索引（当前目标做完即停）。
   * S4（P3a.1 评审）：与 scope 升级 pass **解耦** —— 暂停索引**不得**把 scope 置 paused
   * （旧实现顺手 pauseScope()，于是「暂停索引 → 改配置 → 升级 pass 被暂停位挡住」，
   * 用户必须手动续做；scope 有自己的 pauseScope()/resumeScope()）。
   */
  pause() {
    this._pauseRequested = true;
    if (!this._runPromise) this._phase = 'paused';
    this._persistProgress();
    return this.progress();
  }

  /**
   * 恢复全量索引（从断点续做；已索引且水位未变的目标会被跳过）。
   * S4：不再自动续做 scope pass（它有自己的暂停位与显式入口 resumeScope）。
   */
  async resume() {
    this._pauseRequested = false;
    if (this._phase === 'paused') this._phase = 'idle';
    // §15.1 #6：暂停是**持久化**的，解除也必须立刻落 meta —— 否则 ensureStarted 会从
    // meta 读到上一次的 paused=true，把刚恢复的请求又按暂停处理（重启后永远起不来）。
    this._persistProgress();
    return this.ensureStarted();
  }

  /**
   * 搜索前按需重索引**变更**的会话（有界批量，§8.4）：只 stat 当前代际，最多重索引 syncIndexLimit 个。
   * 首次全量还没扫过目录（targets === null）时不做同步（后台任务会覆盖）。
   */
  async syncChanged() {
    if (!this.targets) return { checked: 0, reindexed: 0, skipped: true };
    const targets = this.orderedTargets();
    if (!targets.length) return { checked: 0, reindexed: 0 };
    const limit = Math.min(this.syncCheckLimit, targets.length);
    let checked = 0;
    let reindexed = 0;
    for (let i = 0; i < limit; i += 1) {
      const target = targets[(this._syncCursor + i) % targets.length];
      let info = null;
      try {
        info = await stat(path.join(target.dir, target.current));
      } catch {
        continue;
      }
      checked += 1;
      const next = { ...target, size: info.size, mtime: Math.trunc(info.mtimeMs) };
      const wm = parseWatermark(this.store.getMeta(watermarkKey(target.id)));
      const stale =
        !wm ||
        wm.size !== Math.trunc(next.size) ||
        wm.mtime !== Math.trunc(next.mtime) ||
        wm.generation !== String(next.current);
      if (!stale) continue;
      if (reindexed >= this.syncIndexLimit) continue; // 本轮额度用完，留给下一轮
      try {
        const result = await this.indexTarget(next, { force: true });
        if (result && result.ok) reindexed += 1;
      } catch {
        /* 单个会话失败不阻塞搜索（下次再试） */
      }
    }
    this._syncCursor = targets.length ? (this._syncCursor + limit) % targets.length : 0;
    this._syncStats = { checked, reindexed };
    return { checked, reindexed };
  }

  /**
   * 搜索：查询预处理（Intl.Segmenter，与索引同构）+ FTS MATCH + 按会话分组 + snippet + 状态/工作区。
   * @param {string} query
   * @param {{limit?:number, workspace?:string, state?:string}} [options]
   */
  async search(query, options = {}) {
    const startedAt = Date.now();
    const q = typeof query === 'string' ? query.trim() : '';
    const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
    if (!q) {
      return { query: '', tokens: [], total: 0, hitCount: 0, groups: [], tookMs: Date.now() - startedAt, index: this.progress() };
    }
    let sync = null;
    let refresh = null;
    try {
      // M1：目标集过期（默认 5 分钟）⇒ 先重扫并增量索引，再走有界水位检查。
      // 这样「全量完成后新建的会话」不用手动 rebuild-index 就能被本次 /search 命中。
      refresh = await this.refreshIfStale({ index: true });
      sync = await this.syncChanged();
    } catch {
      sync = null;
    }
    const { match, tokens } = toFtsMatch(q);
    if (!match) {
      return { query: q, tokens: [], total: 0, hitCount: 0, groups: [], tookMs: Date.now() - startedAt, index: this.progress(), sync };
    }
    const result = this.store.searchDocs(q, { limit: Math.max(limit * 4, 40) });
    const hits = result.hits || [];
    const ids = [...new Set(hits.map((hit) => hit.sessionId))];
    const rows = this.store.getSessionsByIds(ids);
    const archived = this.archivedIds();
    const groups = [];
    const byId = new Map();
    for (const hit of hits) {
      let group = byId.get(hit.sessionId);
      if (!group) {
        const row = rows.get(hit.sessionId) || null;
        // P3b：status='trash'（在途/历史行）优先标 trash；冷行标 cold；归档集合内标 archived；其余 hot。
        const state = row && row.status === 'trash'
          ? 'trash'
          : row && row.status === 'cold'
            ? 'cold'
            : archived.has(hit.sessionId)
              ? 'archived'
              : 'hot';
        group = {
          sessionId: hit.sessionId,
          title: row ? row.title || row.first_user_text || '（无标题）' : '（无标题）',
          projectKey: row ? row.project_key : '',
          workspace: row ? this.engine.workspaceLabel(row.project_key, row.header_cwd) : '未知工作区',
          status: row ? row.status : 'hot',
          state,
          statusLabel: RESULT_STATE_LABELS[state],
          coldRoot: row ? row.cold_root : null,
          snippet: '',
          // P3：命中面（'current' 正文 / 'tool-result' 工具结果）——只作标注，groups/snippet 契约不变。
          surfaces: [],
          hits: [],
        };
        byId.set(hit.sessionId, group);
        groups.push(group);
      }
      if (!group.snippet) group.snippet = hit.snippet || '';
      const hitSurface = hit.surface || 'current';
      if (!group.surfaces.includes(hitSurface)) group.surfaces.push(hitSurface);
      if (group.hits.length < 3) {
        group.hits.push({ seq: hit.seq, type: hit.type, role: hit.role, time: hit.time, snippet: hit.snippet, surface: hitSurface });
      }
    }
    // 「进行中」只在分组层判一次（有界：命中前 30 组；活动判据复用引擎的 workspace/session-activity）
    for (const group of groups.slice(0, 30)) {
      try {
        if (await this.engine.isActive(group.sessionId)) {
          group.state = 'running';
          group.statusLabel = RESULT_STATE_LABELS.running;
        }
      } catch {
        /* 活动判据失败不改变结果 */
      }
    }
    let filtered = groups;
    if (options.workspace) filtered = filtered.filter((group) => group.workspace === options.workspace);
    if (options.state) filtered = filtered.filter((group) => group.state === options.state);
    return {
      query: q,
      tokens,
      total: filtered.length,
      hitCount: hits.length,
      groups: filtered.slice(0, limit),
      tookMs: Date.now() - startedAt,
      index: this.progress(),
      sync,
      refresh,
    };
  }
}
