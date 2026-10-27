/**
 * HTTP 传输层（设计档 §10 / §16 坑 5 / D12：v1 只做 HTTP 路由，不做 typert RPC）
 *
 * 安全口径与 ZS/AM 同款：宿主**不做鉴权**，所以这里自校验
 *   ① 仅 loopback 对端；② 仅 POST；③ sec-fetch-site 不得为 cross-site；④ Origin 若存在必须与 Host 同源。
 * 路由：webServer.register({kind:'prefix', path:'/session-vault/api', handler})，重复注册会抛错（坑 4）。
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import { publicConfig, isPathInside, samePath, INDEX_SCHEMA_VERSION } from './config.js';
import { VaultIndexer, SCOPE_MAX_ROUNDS } from './indexer.js';
import { isGenerationName, sortGenerations, generationVersion } from './marker.js';
import { forEachJsonLineTail } from './zstd-frames.js';
import { parseLine, extractEvent, isLegacyFormat } from './extract.js';
import { tokenizeWords } from './tokenize.js';
// F2/F3（P2.3）：/diag 的只读取证面（形状描述符 + 写探针 + 包装自检）。
import { inspectRegistryShape, probeRegistrySet, checkArchiveTracker, OVERLAY_METHODS, unattachedSweepPayload, EngineFailure } from './engine.js';

/**
 * P2.4 🔵 #3：Sweeper 未挂上（或引擎不可用）时的 /status.sweep 形状 —— **唯一实现在 engine.js**
 * （`unattachedSweepPayload`）。旧实现在这里与 engine.unattachedSweep 各写一份，字段已漂移
 * （engine 侧 error/sweepError 可为 null，HTTP 回退侧恒给默认原因）。这里保留同名再导出，导入路径不变。
 * 引擎不可用时没有 store，budget.used 只能是 0（不伪造 limit）。
 */
export { unattachedSweepPayload };

export const PREFIX = '/session-vault/api';
export const MAX_BODY_BYTES = 1024 * 1024;
/** 评审 #4：会话 id 的合法形状（只允许 [A-Za-z0-9._-]；. / .. 另行拒绝）。 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
/** §15.1 #5：预览的尾部遍历上限（最近 2048 帧 / 8MB 压缩字节），超出返回 truncated=true。 */
export const PREVIEW_MAX_FRAMES = 2048;
export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
/** 命中池的尾部上限（评审 #17：不能在命中量巨大时把 matched 无界驻留）。 */
export const PREVIEW_MATCH_LIMIT = 400;

/** 已实现（P0 + P1 + P2 + P3a + P3b）。 */
export const IMPLEMENTED = Object.freeze([
  'status',
  'config',
  'list',
  'migrate',
  'restore',
  'archive',
  'unarchive',
  'rebuild-index',
  'search',
  'preview',
  'diag',
  // P3b（FR-P3-3 / FR-P3-4 / FR-P3-5）
  'favorite',
  'delete',
  'trash',
  'trash-restore',
  'trash-purge',
  'diagnose',
  'repair',
  // P4（FR-P4-7）：子代理会话冷存（class S）
  'subagent-scan',
  'subagent-migrate',
  'subagent-job',
]);

/** P4：/list 的 class 三值（FR-P4-6 / D-S5：默认 archived，行为不变）。 */
export const LIST_CLASSES = Object.freeze(['archived', 'subagent', 'all']);

/**
 * 接口留好、本批不实现：显式 501，不做静默降级。
 *
 * P3b 起**已清空**（delete / repair 都已实现：收藏、回收站、诊断修复）。这张表与 501 分支
 * 仍然保留，供下一批沿用同一口径：未实现的接口回 501 + stage，而不是 404 或静默空操作。
 */
export const NOT_IMPLEMENTED = Object.freeze({});

/**
 * 评审 #4：/preview 的 id 形状校验。宿主 id 是文件名级令牌，任何路径分隔符都不可能合法；
 * 这里先按白名单卡形状（. 与 .. 也拒绝），再由 assertPreviewContained 做 resolve 后的 containment 双保险。
 */
export function assertSessionId(id) {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!value || !SESSION_ID_PATTERN.test(value) || value === '.' || value === '..') {
    throw new HttpError(400, 'invalid-id', '会话 id 形状非法（只允许 [A-Za-z0-9._-]，且不得是 . 或 ..）：' + value);
  }
  return value;
}

/**
 * 评审 #4：resolve 之后的 containment —— 预览目录必须落在 sessionsRoot 或任一已知冷根之内。
 * rel_dir 来自 DB（可能被污染），所以形状校验之外还要按**解析后路径**再卡一次。
 */
export function assertPreviewContained(engine, dir) {
  const resolved = path.resolve(dir);
  let roots = [];
  try {
    roots = [
      engine && engine.paths && engine.paths.sessionsRoot,
      ...(engine && typeof engine.knownColdRoots === 'function' ? engine.knownColdRoots() : []),
    ]
      .filter(Boolean)
      .map((root) => path.resolve(root));
  } catch {
    roots = [];
  }
  const allowed = roots.some((root) => samePath(resolved, root) || isPathInside(resolved, root));
  if (!allowed) {
    throw new HttpError(400, 'invalid-id', '预览目录越界（必须落在 sessions 或已知冷根之内）：' + resolved);
  }
  return resolved;
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function isLoopbackAddress(address) {
  if (!address) return false;
  const value = String(address).trim().toLowerCase();
  if (!value) return false;
  if (value === '::1' || value === 'localhost') return true;
  if (value.startsWith('::ffff:')) {
    const v4 = value.slice('::ffff:'.length);
    return v4 === '127.0.0.1' || v4.startsWith('127.');
  }
  return value === '127.0.0.1' || value.startsWith('127.');
}

function headerOf(req, name) {
  const headers = req && req.headers ? req.headers : {};
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function isTrustedRequest(req) {
  const socket = req && (req.socket || req.connection);
  const remote = (socket && socket.remoteAddress) || (req && req.remoteAddress);
  if (!isLoopbackAddress(remote)) return false;

  const site = String(headerOf(req, 'sec-fetch-site') || '').toLowerCase();
  if (site === 'cross-site') return false;

  const origin = headerOf(req, 'origin');
  if (origin) {
    const host = headerOf(req, 'host');
    if (!host) return false;
    try {
      const originUrl = new URL(origin);
      if (String(origin).toLowerCase() === 'null') return false;
      if (originUrl.host.toLowerCase() !== String(host).toLowerCase()) return false;
      if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload === undefined ? null : payload), 'utf8');
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  };
  if (typeof res.writeHead === 'function') {
    res.writeHead(status, headers);
  } else {
    res.statusCode = status;
    for (const [key, value] of Object.entries(headers)) {
      if (typeof res.setHeader === 'function') res.setHeader(key, value);
    }
  }
  res.end(body);
}

export function readJsonBody(req, { limit = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, 'body-too-large', '请求体超过上限（' + limit + ' bytes）'));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => fail(err));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!size) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = text.trim() ? JSON.parse(text) : {};
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'invalid-json', '请求体不是合法 JSON'));
      }
    });
  });
}

/**
 * A4（P2.6 评审）：批量接口的 id 归一化 —— **与 /preview 同口径，先卡形状**（assertSessionId，非法 ⇒ 400）。
 *
 * 旧实现只 trim 就往下传：`../x`、`a/b`、`.`、`..` 这类值会一路进 engine / store / 路径拼接，
 * 而 /preview 早就用 assertSessionId 拦住了（两套口径）。现在 /migrate /restore /archive /unarchive
 * （以及复用本函数的 /rebuild-index）都过同一道门；错误发生在 requireEngine() 之前，非法请求**不触达引擎**。
 */
function asIdList(body) {
  const out = [];
  const add = (raw) => {
    if (typeof raw !== 'string') return;
    const value = raw.trim();
    if (!value) return;
    const id = assertSessionId(value);
    if (!out.includes(id)) out.push(id);
  };
  if (body && typeof body.id === 'string') add(body.id);
  if (body && Array.isArray(body.ids)) for (const id of body.ids) add(id);
  if (!out.length) throw new HttpError(400, 'invalid-request', '需要 id（字符串）或 ids（字符串数组）');
  return out;
}

/**
 * F1/F4（P2.3）：/status.boot 的归一化形状。
 *
 * 真机失败 1 的证据是 `/status.sweep = {attached:false, attempts:0, stage:null, lastAttemptAt:null}`
 * —— 启动链**一次都没尝试**。sweep 只说「没挂上」，说不出「定时器压根没注册」，所以 boot 单列：
 *   registered=false / registrationError 非空 ⇒ 定时器注册就失败了（不是链在重试）
 *   registered=true 且 attempts=0          ⇒ 正常的启动窗口（定时器还没到点）
 */
export function bootPayload(state) {
  const value = state || {};
  const registrationError = value.registrationError || null;
  const lastError = value.lastError || null;
  return {
    registered: Boolean(value.registered),
    via: value.via || null,
    delayMs: Number.isFinite(value.delayMs) ? value.delayMs : null,
    registrationError,
    registrationErrorAt: value.registrationErrorAt || null,
    firedAt: value.firedAt || null,
    startError: value.startError || null,
    attempts: Number(value.attempts) || 0,
    stage: value.stage || null,
    lastError,
    nextRetryAt: value.nextRetryAt || null,
    attached: Boolean(value.attached),
    gaveUp: Boolean(value.gaveUp),
    // 一行可读的「启动链为什么没跑/没挂上」
    error: registrationError || lastError || value.startError || null,
  };
}

/**
 * F2（P2.3）：/diag 的取证 payload（**只读**；写探针同步 set→read→restore，不改最终状态）。
 *
 * 三态结论（给 UI 横幅用）：
 *   shape 'own' / 'prototype' / 'accessor' / 'proxy' ⇒ 包装可用（proxy = 按契约名验证）
 *   unsupported（set 不生效 / 只读 / 缺方法）        ⇒ 「归档追踪不可用」，不再自动重装
 */
export function overlayDiagnostics(registry, engine = null) {
  const stateHint = engine && engine.overlayInstall ? engine.overlayInstall.state || null : null;
  if (!registry) {
    const check = checkArchiveTracker(null, stateHint);
    return {
      registry: null,
      shape: 'no-registry',
      supported: false,
      reason: 'no-registry',
      methods: {},
      check,
      // 传 check 而不是无参调用：诊断是**只读**的，不能顺手触发一次自动重装。
      overlay: engine && typeof engine.overlayBanner === 'function' ? engine.overlayBanner(check) : null,
      install: engine ? engine.overlayInstall || null : null,
    };
  }
  const methods = {};
  let shape = 'unsupported';
  let supported = false;
  let reason = null;
  // 已安装时把「我们登记的原函数」交给探针还原（代理形态下 current 读回可能本身就是代理，
  // 直接拿它还原会每诊断一次多叠一层包装）。
  const shared = engine && engine.overlayInstall ? engine.overlayInstall.state : null;
  for (const key of OVERLAY_METHODS) {
    const info = inspectRegistryShape(registry, key);
    const restoreTo = shared ? (key === 'archiveSession' ? shared.wrappedArchive : shared.wrappedUnarchive) : null;
    const probe = probeRegistrySet(registry, key, { restoreTo });
    methods[key] = {
      // 任务 F2 要求的形状证据：自有描述符 + 原型描述符都要单独给（get/set/writable 全在里面）
      descriptor: info.ownDescriptor || info.prototypeDescriptor,
      ownDescriptor: info.ownDescriptor,
      prototypeDescriptor: info.prototypeDescriptor,
      ownerKind: info.ownerKind,
      prototypeDepth: info.prototypeDepth,
      readable: info.readable,
      valueName: info.valueName,
      valueSource: info.valueSource,
      setProbe: probe,
    };
    if (key === 'archiveSession') {
      shape = info.ownerKind;
      supported = Boolean(probe.supported);
      reason = probe.supported ? null : (probe.error || 'set-ineffective');
      if (supported && probe.nameMatch && !probe.readBackEqual) shape = 'proxy';
    }
  }
  const info = inspectRegistryShape(registry, 'archiveSession');
  const check = checkArchiveTracker(registry, stateHint);
  return {
    registry: {
      type: typeof registry,
      constructorName: info.constructorName,
      prototypeConstructorName: info.prototypeConstructorName,
      isProxy: info.isProxy,
    },
    shape,
    supported,
    reason,
    methods,
    check,
    overlay: engine && typeof engine.overlayBanner === 'function' ? engine.overlayBanner(check) : null,
    install: engine ? engine.overlayInstall || null : null,
  };
}

export function createVaultApi(options = {}) {
  const home = options.home;
  const configStore = options.configStore;
  const getEngine = options.getEngine;
  const version = options.version || '0.1.0';
  const logger = options.logger || console;
  /** F1：启动链状态（引擎不可用时也要能回答 sweep 为什么没挂上）。 */
  const getSweepAttach = typeof options.getSweepAttach === 'function' ? options.getSweepAttach : () => null;
  /** F1/F4（P2.3）：启动链定时器的注册 / 执行读数（/status.boot）。 */
  const getBootState = typeof options.getBootState === 'function' ? options.getBootState : () => null;

  if (!configStore) throw new Error('createVaultApi 需要 configStore');

  /** 索引器是惰性创建的（host 依赖面最小；纯配置/状态请求不会拉起全量索引）。 */
  let indexerPromise = null;

  /**
   * 取（或惰性创建）索引器，并在每次使用时幂等调用 ensureStarted()——
   * M1：全量 done 之后，`status` / `list` / `search` 的每一次调用都要有机会触发
   * 「目标集 TTL 重扫 + 增量索引」（ensureStarted 在 done 分支里做这件事，本身不阻塞请求）。
   */
  async function acquireIndexer() {
    if (typeof options.getIndexer === 'function') return options.getIndexer();
    const indexer = await ensureIndexer();
    try {
      indexer.ensureStarted().catch(() => {});
      // P3 / FR-P3-2：配置与库内 scope 不一致时按方向自愈（降级立即、升级后台 pass）。
      // 暂停中的 pass 不会被这里偷偷续跑（ensureScope 尊重持久化的暂停位）。
      indexer.ensureScope().catch(() => {});
    } catch {
      /* 索引器异常不影响请求本身 */
    }
    return indexer;
  }

  async function ensureIndexer() {
    if (indexerPromise) return indexerPromise;
    indexerPromise = (async () => {
      // 注入式索引器优先（测试/宿主其它接线）：/config 的 scope 切换必须落在**同一个实例**上，
      // 否则「升级 pass」会跑在一个空的第二实例里，/status 读到的是另一个实例的进度。
      if (typeof options.getIndexer === 'function') return options.getIndexer();
      const engine = await requireEngine();
      if (engine.indexer) return engine.indexer;
      const indexer = new VaultIndexer({ engine, store: engine.store, paths: engine.paths, logger });
      engine.indexer = indexer;
      return indexer;
    })().catch((err) => {
      indexerPromise = null;
      throw err;
    });
    return indexerPromise;
  }

  async function acquireEngine() {
    if (typeof getEngine !== 'function') {
      return { engine: null, reason: 'engine 未接线' };
    }
    try {
      const engine = await getEngine();
      if (!engine) return { engine: null, reason: 'engine 尚未初始化' };
      return { engine, reason: null };
    } catch (err) {
      return { engine: null, reason: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * 读索引器的 scope 读数（P3 / M1：/status、/search、/rebuild-index 共用）。
   * 第三方/桩索引器没有 scopeSnapshot() 时如实返回 null（不自造读数）。
   */
  function readScope(indexer) {
    try {
      if (indexer && typeof indexer.scopeSnapshot === 'function') return indexer.scopeSnapshot();
    } catch {
      /* 读数失败不影响动作本身 */
    }
    return null;
  }

  async function requireEngine() {
    const { engine, reason } = await acquireEngine();
    if (!engine) throw new HttpError(503, 'vault-unavailable', '保险库引擎不可用：' + (reason || '未知原因'));
    return engine;
  }

  function notImplementedPayload(name) {
    const stage = NOT_IMPLEMENTED[name];
    return {
      ok: false,
      error: 'not-implemented',
      code: 'not-implemented-' + String(stage).toLowerCase(),
      stage,
      interface: PREFIX + '/' + name,
      message: name + ' 属于 ' + stage + '，本批（P0+P1+P2）不实现；接口与字段已预留，启用前请勿依赖其行为',
    };
  }

  async function handleStatus() {
    const loaded = await configStore.load();
    const { engine, reason } = await acquireEngine();
    let engineStatus = null;
    let engineError = reason;
    if (engine) {
      // 首屏/轮询也会把全量索引的后台任务拉起来（幂等；不阻塞本请求）
      acquireIndexer().catch(() => {});
      try {
        engineStatus = await engine.status();
      } catch (err) {
        engineError = err && err.message ? err.message : String(err);
      }
    }
    // F4（P2.3）：boot 只取一次（同一份读数既给 boot 段也给 bootError 一行原因）
    const boot = bootPayload(getBootState());
    /**
     * P3b（评审遗留 🔵：/status.stats 引擎不可用兜底补齐字段）：
     * 旧兜底只有 14 个字段，缺 archiveAgeDays / autoMigrate / dailyBudgetCount / pendingCount …
     * UI 在「引擎没起来」这一刻读到的是一半字段 —、一半字段 undefined（同一张统计条两种形状）。
     * 现在兜底**与引擎面同形状**：能从配置推的按配置推（archiveAgeDays / dailyBudgetCount /
     * autoMigrate = 配置 AND 阈值>0，与 engine 同口径）；读不到的事实一律 0 / null，不编造。
     */
    const statsFromConfig = {
      sessions: 0,
      hotArchived: 0,
      cold: 0,
      hotRestored: 0,
      bytesCold: 0,
      candidates: 0,
      candidatesBytes: 0,
      candidatesCapped: false,
      pendingSampleLimit: 0,
      markers: 0,
      errors: 0,
      favorites: 0,
      hidden: 0,
      trash: 0,
      docs: 0,
      indexed: 0,
      indexCoverage: 0,
      indexedThisRun: 0,
      indexTotal: 0,
      indexPhase: 'idle',
      nextSweepAt: null,
      sweepAttached: false,
      budgetUsedToday: 0,
      // 与 engine.status().stats 同口径：阈值来自配置；autoMigrate = 配置 AND 阈值>0
      archiveAgeDays: loaded.config.archiveAgeDays,
      dailyBudgetCount: loaded.config.dailyBudgetCount,
      autoMigrate: Boolean(loaded.config.autoMigrate) && loaded.config.archiveAgeDays > 0,
      archived: 0,
      pendingCount: 0,
      pendingBytes: 0,
    };
    /**
     * P4（FR-P4-6）：/status.subagent 的**形状兜底**。引擎不可用时它既不是 undefined 也不是 null：
     * 配置能推的按配置推（ageDays / migrateEffective），读不到的事实一律 0 / null（不编造）。
     */
    const subagentFromConfig = {
      enabled: loaded.config.subagentAgeDays > 0,
      migrate: Boolean(loaded.config.subagentMigrate),
      migrateEffective: loaded.config.subagentAgeDays > 0 && Boolean(loaded.config.subagentMigrate),
      ageDays: loaded.config.subagentAgeDays,
      dailyBudgetCount: loaded.config.subagentDailyBudgetCount,
      batchCap: null,
      candidates: 0,
      candidatesBytes: 0,
      cold: 0,
      coldBytes: 0,
      scanAt: null,
      scanCount: 0,
      scanAgeMs: null,
      scanFresh: false,
      scanGaps: [],
      scanOrphanEdges: 0,
      paused: false,
      pauseReason: null,
      budget: null,
      nextRunAt: null,
      lastRunAt: null,
      lastReport: null,
      job: null,
    };
    const stats = (engineStatus && engineStatus.stats) || statsFromConfig;
    return {
      ok: true,
      version,
      home,
      config: publicConfig(loaded.config, { home, paths: configStore.paths }),
      configSource: loaded.source,
      configErrors: loaded.errors,
      // A3（P2.6）：从**旧配置文件**里摘掉的预留字段（如 maxConcurrentJobs）如实列出来 ——
      // 读取容错不等于静默：写入仍被 save() 的严格 normalize 拒绝（见 config.js 的 load/save 注释）。
      configReserved: loaded.reserved || [],
      vault: {
        available: Boolean(engine) && Boolean(engineStatus),
        reason: engineError,
        sessionsRoot: configStore.paths.sessionsRoot,
        coldRoots: (engineStatus && engineStatus.vault && engineStatus.vault.coldRoots) || [],
        coldDegraded: Boolean(engineStatus && engineStatus.vault && engineStatus.vault.coldDegraded),
      },
      stats,
      queue: (engineStatus && engineStatus.queue) || { pending: 0, running: 0, indexRunning: 0 },
      errors: (engineStatus && engineStatus.errors) || [],
      // P2-4 / F5：索引进度（coverage = 真实覆盖面；indexedThisRun = 本轮计数）与清扫排程
      index: (engineStatus && engineStatus.index) || {
        phase: 'idle', paused: false, indexed: 0, indexedThisRun: 0, coverage: 0, total: 0, skipped: 0, failed: 0, errors: [],
        // M3：引擎不可用时读不到库内 schema 值 —— schema 是代码常量，如实给；stored 未知给 null，
        // rebuildNeeded 也给 null（**不冒充**「需要重建」，那是库内事实）。
        schema: INDEX_SCHEMA_VERSION, schemaStored: null, rebuildNeeded: null, schemaRebuilding: false,
        // P3b.1：未覆盖会话读数必须恒存在（面板黄条读它）；读不到库就是空集，不是 undefined。
        gaps: [], gapsCount: 0, doneWithGaps: null,
      },
      // P3 / FR-P3-2：检索范围（配置）+ 库内实际 scope + 升级 pass 进度（phase / paused / done）。
      searchScope: loaded.config.searchScope,
      scope: (engineStatus && engineStatus.scope) || {
        searchScope: loaded.config.searchScope,
        // 引擎不可用时**读不到库内实际 scope**：如实给 null，不拿配置值冒充库内值。
        libraryScope: null,
        phase: 'idle',
        paused: false,
        done: false,
        doneWithGaps: false,
        target: null,
        indexed: 0,
        skipped: 0,
        failed: 0,
        total: 0,
        // M1：未覆盖读数必须恒存在（面板黄条读它），引擎不可用时为空集而不是 undefined。
        round: 0,
        maxRounds: SCOPE_MAX_ROUNDS,
        gaps: [],
        gapsCount: 0,
        startedAt: null,
        updatedAt: null,
        errors: [],
      },
      // F1：**永远不是 null**。挂上了就是 Sweeper 快照（attached:true）；没挂上/引擎不可用时是
      // {attached:false, error, sweepError, attempts, nextRetryAt, gaveUp}，运维能直接看出原因。
      sweep: (engineStatus && engineStatus.sweep) || unattachedSweepPayload(getSweepAttach()),
      /**
       * P4（FR-P4-6 / §19.5）：子代理会话冷存的独立读数段
       * {candidates,candidatesBytes,cold,coldBytes,scanAt,scanGaps,paused,pauseReason,job,...}
       * —— 与 class A 的 stats / sweep 分开，UI 的黄条与设置页卡都读它。
       */
      subagent: (engineStatus && engineStatus.subagent) || subagentFromConfig,
      // F4（P2.3）：启动链读数。真机失败 1 是「sweep.attempts=0（启动链从未尝试）」——
      // sweep 只能说「没挂上」，boot 才能区分「定时器压根没注册」与「链在重试」。
      boot,
      bootError: boot.error,
      // A-7 / AC-9 / R-21：冷根不可用、AM 在场、包装漂移都要能被 UI 读到（不是桩字段）
      banners: (engineStatus && engineStatus.banners) || { coldUnavailable: false, coldRoots: [], am: null, overlay: null },
      // R3（P3a.1 评审）：autoMigrate 的回退必须与 archiveAgeDays **同口径** —— 引擎不可用时应按
      // 「配置 + 阈值>0」推算生效值（archiveAgeDays=0 时自动迁移本来就是关的），而不是一律 false。
      autoMigrate: engineStatus
        ? Boolean(engineStatus.autoMigrate)
        : Boolean(loaded.config.autoMigrate) && loaded.config.archiveAgeDays > 0,
      // 注意：0 是合法阈值（0 = 关闭自动迁移）⇒ 必须用 ?? 而不是 ||（|| 会把 0 读成「没值」）。
      archiveAgeDays:
        engineStatus && engineStatus.archiveAgeDays !== undefined && engineStatus.archiveAgeDays !== null
          ? engineStatus.archiveAgeDays
          : loaded.config.archiveAgeDays,
      notImplemented: {
        p2: Object.keys(NOT_IMPLEMENTED).filter((k) => NOT_IMPLEMENTED[k] === 'P2'),
        p3: Object.keys(NOT_IMPLEMENTED).filter((k) => NOT_IMPLEMENTED[k] === 'P3'),
      },
    };
  }

  async function handleConfig(body) {
    const patch = body && typeof body === 'object' && body.patch && typeof body.patch === 'object' ? body.patch : null;
    if (!patch) {
      const loaded = await configStore.load();
      return {
        ok: true,
        config: publicConfig(loaded.config, { home, paths: configStore.paths }),
        source: loaded.source,
        errors: loaded.errors,
      };
    }
    const before = await configStore.load();
    const result = await configStore.save(patch);
    if (!result.ok) {
      return {
        ok: false,
        error: 'invalid-config',
        code: 'invalid-config',
        message: result.errors.map((e) => e.message).join('；'),
        details: result.errors,
        config: publicConfig(result.config, { home, paths: configStore.paths }),
      };
    }
    /**
     * P3 / FR-P3-2：配置落盘成功之后才动索引面（顺序不可反：先写库内 scope 再保存配置，
     * 一旦保存被拒就会出现「库升了、配置没升」的不一致）。
     *  - 降级（→ body）在本次请求内完成（只删 tool 文档，不重读日志）；
     *  - 升级（→ body+toolResults）起后台 pass 立即返回（phase=running/paused 由 /status 读）；
     *  - scope 同步失败**不让配置保存失败**，但必须如实回报（scopeError），并在下一次
     *    /status、/list、/search 的 ensureScope 上重试。
     */
    let scope = null;
    let scopeError = null;
    try {
      const indexer = await ensureIndexer();
      if (typeof indexer.syncScope === 'function') scope = await indexer.syncScope(result.config.searchScope);
    } catch (err) {
      scopeError = err && err.message ? err.message : String(err);
    }
    return {
      ok: true,
      config: publicConfig(result.config, { home, paths: configStore.paths }),
      source: 'file',
      errors: [],
      previousSearchScope: before.config.searchScope,
      searchScope: result.config.searchScope,
      scope,
      scopeError,
    };
  }

  async function handleList(body) {
    const engine = await requireEngine();
    // 首屏即触发全量索引的后台任务（幂等、不阻塞本请求）；索引进度由 status 读取。
    acquireIndexer().catch(() => {});
    /**
     * P4（FR-P4-6 / D-S5）：`class` 三值 archived（默认）/ subagent / all。
     * 既接受顶层 body.class（新 UI），也接受 body.filter.class（旧调用方的形状）；
     * 非法值在这里就 400，不静默回退成 archived（那会让人以为筛选生效了）。
     */
    const baseFilter = body && body.filter && typeof body.filter === 'object' ? { ...body.filter } : null;
    const rawClass = body && body.class !== undefined && body.class !== null ? body.class : baseFilter && baseFilter.class;
    let filter = baseFilter;
    if (rawClass !== undefined && rawClass !== null && rawClass !== '') {
      if (typeof rawClass !== 'string' || !LIST_CLASSES.includes(rawClass)) {
        throw new HttpError(400, 'invalid-class', 'class 只支持 ' + LIST_CLASSES.join(' / ') + '（收到 ' + JSON.stringify(rawClass) + '）');
      }
      filter = { ...(baseFilter || {}), class: rawClass };
    }
    const data = await engine.list(filter);
    return { ok: true, ...data };
  }

  async function handleMigrate(body) {
    const ids = asIdList(body);
    const engine = await requireEngine();
    const results = [];
    for (const id of ids) {
      try {
        const result = await engine.migrate(id, { reason: body && body.reason ? String(body.reason) : 'manual' });
        results.push({ id, ok: Boolean(result && result.ok), ...result });
      } catch (err) {
        results.push({ id, ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
    return { ok: true, results };
  }

  async function handleRestore(body) {
    const ids = asIdList(body);
    const engine = await requireEngine();
    const results = [];
    for (const id of ids) {
      try {
        const result = await engine.restore(id, { reason: body && body.reason ? String(body.reason) : 'manual' });
        results.push({ id, ok: Boolean(result && result.ok), ...result });
      } catch (err) {
        results.push({ id, ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
    return { ok: true, results };
  }

  async function handleArchive(body) {
    const ids = asIdList(body);
    const engine = await requireEngine();
    const results = [];
    for (const id of ids) {
      try {
        const result = await engine.archiveSession(id);
        results.push({ id, ok: Boolean(result && result.ok), ...result });
      } catch (err) {
        results.push({ id, ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
    return { ok: true, results };
  }

  async function handleUnarchive(body) {
    const ids = asIdList(body);
    const engine = await requireEngine();
    const results = [];
    for (const id of ids) {
      try {
        const result = await engine.unarchiveSession(id);
        results.push({ id, ok: Boolean(result && result.ok), ...result });
      } catch (err) {
        results.push({ id, ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
    return { ok: true, results };
  }

  /**
   * P2-2 全量索引与搜索（FR-9 / D21）：
   *   - 查询预处理（Intl.Segmenter）+ FTS MATCH + 按会话分组 + snippet + 状态/工作区；
   *   - 搜索前按需重索引**变更**会话（有界批量，默认 50 检查 / 3 重索引）；
   *   - 官方 sessionQuery 不作依赖。
   * body: { q | query, limit?, workspace?, state? }
   */
  async function handleSearch(body) {
    const indexer = await acquireIndexer();
    const query = body && typeof body.q === 'string' ? body.q : body && typeof body.query === 'string' ? body.query : '';
    const result = await indexer.search(query, {
      limit: body && body.limit,
      workspace: body && typeof body.workspace === 'string' ? body.workspace : null,
      state: body && typeof body.state === 'string' ? body.state : null,
    });
    // P3：顺带回传检索范围读数（覆盖层要显示「正文 / 正文+工具结果」，不额外发一次 /status）。
    // 索引器没有该方法（第三方/桩实现）时如实省略，不自造读数。
    let scope = null;
    try {
      if (typeof indexer.scopeSnapshot === 'function') scope = indexer.scopeSnapshot();
    } catch {
      scope = null;
    }
    return scope ? { ok: true, ...result, scope } : { ok: true, ...result };
  }

  /**
   * P2-3 预览（FR-10 / US-7）：**只读**帧遍历，返回最近 N 条消息或命中上下文。
   * 不恢复、不打开会话、不写任何文件；冷/热两种来源同一条只读路径。
   * body: { id, limit?, q? }
   */
  async function handlePreview(body) {
    const engine = await requireEngine();
    const rawId = body && typeof body.id === 'string' ? body.id.trim() : '';
    if (!rawId) throw new HttpError(400, 'invalid-request', '需要 id（字符串）');
    // 评审 #4：先卡 id 形状（路径分隔符 / .. 一律 400），再在 resolve 后做 containment。
    const id = assertSessionId(rawId);
    const limit = Math.min(Math.max(Number(body && body.limit) || 20, 1), 100);
    const row = engine.store.getSession(id);
    let dir = null;
    let source = 'hot';
    let coldRoot = null;
    if (row && row.status === 'cold') {
      coldRoot = row.cold_root || (await engine.coldRoot());
      dir = path.join(coldRoot, row.rel_dir);
      source = 'cold';
    } else if (row && row.rel_dir) {
      dir = path.join(engine.paths.sessionsRoot, row.rel_dir);
    }
    if (!dir) {
      const found = await engine.findHotDir(id);
      if (found) dir = found.dir;
    }
    if (!dir) throw new HttpError(404, 'not-found', '找不到该会话的日志目录：' + id);
    // 评审 #4：DB 里的 rel_dir / 合成路径都可能被污染 ⇒ 解析后再卡一次白名单根。
    dir = assertPreviewContained(engine, dir);
    let names = [];
    try {
      names = await readdir(dir);
    } catch (err) {
      throw new HttpError(404, 'not-found', '会话目录不可读（文件不在或权限不足）：' + (err && err.message ? err.message : err));
    }
    const generations = sortGenerations(names.filter((name) => isGenerationName(name)));
    const current = generations.length ? generations[generations.length - 1] : null;
    if (!current) throw new HttpError(422, 'no-generation', '目录里没有合法代际日志（只读预览无法解析）');
    const formatVersion = row && row.format_version !== null && row.format_version !== undefined ? row.format_version : generationVersion(current);
    const legacy = isLegacyFormat(formatVersion);
    const query = body && typeof body.q === 'string' ? body.q.trim() : '';
    const tokens = query ? tokenizeWords(query) : [];
    const recent = [];
    const matched = [];
    let matchTruncated = false;
    let lines = 0;
    let docsCount = 0;
    let previous = null;
    let tornTail = false;
    let traversal = null;
    const maxFrames = Math.min(Math.max(Number(body && body.maxFrames) || PREVIEW_MAX_FRAMES, 1), 20000);
    const maxBytes = Math.min(Math.max(Number(body && body.maxBytes) || PREVIEW_MAX_BYTES, 1024), 256 * 1024 * 1024);
    try {
      // §15.1 #5：**尾部优先**遍历 + 帧/字节上限（旧实现解压整份日志，34.5 MB 也照读全程）。
      const result = await forEachJsonLineTail(
        path.join(dir, current),
        async (line) => {
          lines += 1;
          const parsed = parseLine(line);
          if (!parsed.ok) return;
          const extracted = extractEvent(parsed.value, docsCount, { legacy });
          for (const doc of extracted.docs) {
            docsCount += 1;
            const message = { seq: doc.seq, type: doc.type, role: doc.role, time: doc.time, text: doc.text };
            recent.push(message);
            if (recent.length > 200) recent.shift();
            if (tokens.length) {
              const lower = String(doc.text || '').toLowerCase();
              if (tokens.some((token) => lower.includes(String(token).toLowerCase()))) {
                if (previous) matched.push({ ...previous, context: true });
                matched.push({ ...message, matched: true });
                // 评审 #17：命中池本身也要有上限（尾部保留），否则大文件命中量可无界驻留
                if (matched.length > PREVIEW_MATCH_LIMIT) {
                  matched.splice(0, matched.length - PREVIEW_MATCH_LIMIT);
                  matchTruncated = true;
                }
              }
            }
            previous = message;
          }
        },
        { maxFrames, maxBytes, windowSize: 256 * 1024 },
      );
      traversal = result;
      tornTail = result.tornStart !== null;
    } catch (err) {
      const code = err && err.code === 'frame-corrupt' ? 'frame-corrupt' : 'preview-failed';
      throw new HttpError(422, code, '读取日志失败（只读帧遍历）：' + (err && err.message ? err.message : err));
    }
    const pool = tokens.length ? matched : recent;
    const seen = new Set();
    const deduped = [];
    for (const message of pool) {
      const key = String(message.seq) + '|' + String(message.role) + '|' + String(message.text);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(message);
    }
    const messages = deduped.slice(-limit);
    return {
      ok: true,
      id,
      source,
      title: row ? row.title || row.first_user_text || '（无标题）' : '（无标题）',
      status: row ? row.status : 'unknown',
      workspace: row ? engine.workspaceLabel(row.project_key, row.header_cwd) : '未知工作区',
      projectKey: row ? row.project_key : '',
      coldRoot,
      formatVersion,
      generation: current,
      sizeBytes: row ? row.bytes || 0 : 0,
      matched: tokens.length > 0,
      messages,
      totalMessages: docsCount,
      lines,
      // §15.1 #5：truncated 同时表达「尾部遍历被上限截断」与「消息池比返回页更大」
      truncated: Boolean(traversal && traversal.truncated) || matchTruncated || pool.length > messages.length,
      traversal: traversal
        ? { frames: traversal.frames, totalFrames: traversal.totalFrames, bytes: traversal.bytes, maxFrames, maxBytes, truncated: Boolean(traversal.truncated) }
        : null,
      tornTail,
      note: '只读预览：不恢复、不打开会话、不写任何文件',
    };
  }

  /**
   * 索引控制 + 重建：
   *  - body.action = pause | resume | start（P2-3 的进度组件按钮；不新增路由，复用本接口）
   *  - body.action = pause-scope | resume-scope（P3a.1 / S4：scope 升级 pass **独立**暂停/续做；
   *    暂停索引不再连带暂停 pass；resume-scope 也是 done-with-gaps 的「重建」入口）
   *  - 与原有 body.id / body.ids 重建语义并存（P1 行为不变）。
   */
  async function handleRebuildIndex(body) {
    const action = body && typeof body.action === 'string' ? body.action.trim() : '';
    if (action) {
      const actions = ['pause', 'resume', 'start', 'pause-scope', 'resume-scope'];
      if (!actions.includes(action)) {
        throw new HttpError(400, 'invalid-request', 'action 只支持 ' + actions.join(' / ') + '（收到 ' + action + '）');
      }
      const indexer = await acquireIndexer();
      if (action === 'pause') return { ok: true, index: indexer.pause(), scope: readScope(indexer) };
      if (action === 'resume') {
        // 不等待全量跑完（可能几分钟）：立即返回进度，后台继续
        indexer.resume().catch(() => {});
        return { ok: true, index: indexer.progress(), scope: readScope(indexer) };
      }
      if (action === 'pause-scope') {
        // S4：只暂停 scope pass（全量索引照跑）
        if (typeof indexer.pauseScope !== 'function') throw new HttpError(501, 'not-supported', '索引器没有 pauseScope（版本不匹配）');
        return { ok: true, scope: indexer.pauseScope(), index: indexer.progress() };
      }
      if (action === 'resume-scope') {
        // S4 / M1：只续做（或重建）scope pass；done-with-gaps 走同一条重建入口
        if (typeof indexer.resumeScope !== 'function') throw new HttpError(501, 'not-supported', '索引器没有 resumeScope（版本不匹配）');
        const scopeBefore = indexer.resumeScope();
        return { ok: true, scope: readScope(indexer) || scopeBefore, index: indexer.progress() };
      }
      // start = 强制重扫（新会话 / 目录变化）；不等待整轮跑完
      indexer.rescan().catch(() => {});
      return { ok: true, index: indexer.progress(), scope: readScope(indexer) };
    }
    const ids = body && (body.id || body.ids) ? asIdList(body) : null;
    const engine = await requireEngine();
    const result = ids ? await engine.rebuildIndex(ids) : await engine.rebuildIndex(null);
    return { ok: true, ...result };
  }

  /**
   * F2/F3（P2.3）：归档包装诊断（**只读**，仅 loopback POST）。
   *
   *   POST /session-vault/api/diag                        ⇒ 形状取证（描述符 + 写探针 + 当前读数）
   *   POST /session-vault/api/diag {"action":"retry-overlay"} ⇒ 清掉「停手」标记 → 重装 → 返回新读数
   *
   * 真机失败 2 的取证目标：replacedBy = {name:"wrappedArchive", source:"function () { [native code] }"}
   * —— 名字是我们的、toString 是 native ⇒ 读到的是函数代理，不是「被第三方覆盖」。
   */
  async function handleDiag(body) {
    const action = body && typeof body.action === 'string' ? body.action.trim() : '';
    if (action && action !== 'inspect' && action !== 'retry-overlay') {
      throw new HttpError(400, 'invalid-request', 'action 只支持 retry-overlay（省略即 inspect），收到 ' + action);
    }
    const { engine, reason } = await acquireEngine();
    const registry = engine
      ? engine.registry || (typeof engine.getService === 'function' ? engine.getService('workspaceRegistry') : null)
      : null;
    if (action === 'retry-overlay') {
      if (!engine) throw new HttpError(503, 'vault-unavailable', '保险库引擎不可用：' + (reason || '未知原因'));
      if (typeof engine.retryOverlay !== 'function') {
        throw new HttpError(501, 'not-supported', '引擎没有 retryOverlay（版本不匹配）');
      }
      const retried = engine.retryOverlay();
      return { ok: true, action, retry: retried, diag: overlayDiagnostics(registry, engine) };
    }
    return { ok: true, action: action || 'inspect', diag: overlayDiagnostics(registry, engine) };
  }

  /**
   * FR-P3-3：收藏 / 取消收藏。body: { id, favorite: boolean }
   *
   * favorite 必须是**严格布尔**：旧版 UI 可能把复选框状态发成字符串，静默按真值处理会让
   * "取消收藏" 变成 "收藏"（一个开关两义）。非法就 400，不猜。
   */
  async function handleFavorite(body) {
    const rawId = body && typeof body.id === 'string' ? body.id.trim() : '';
    if (!rawId) throw new HttpError(400, 'invalid-request', '需要 id（字符串）');
    const id = assertSessionId(rawId);
    if (typeof (body && body.favorite) !== 'boolean') {
      throw new HttpError(400, 'invalid-request', 'favorite 必须是布尔值（true=收藏 / false=取消收藏）');
    }
    const engine = await requireEngine();
    const result = await engine.favorite(id, body.favorite);
    return { ok: Boolean(result && result.ok), ...result, id, favorite: result && result.favorite };
  }

  /**
   * FR-P3-4：删除。冷会话进回收站（<vaultRoot>/trash/…），热会话只 hidden=1（文件零改动）。
   * body: { id | ids, reason? }
   */
  async function handleDelete(body) {
    const ids = asIdList(body);
    const engine = await requireEngine();
    const results = [];
    for (const id of ids) {
      try {
        const result = await engine.deleteSession(id, { reason: body && body.reason ? String(body.reason) : 'manual' });
        results.push({ id, ok: Boolean(result && result.ok), ...result });
      } catch (err) {
        results.push({ id, ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
    return { ok: true, results };
  }

  /** FR-P3-4：回收站列表（只读）。body: { limit? } */
  async function handleTrash(body) {
    const engine = await requireEngine();
    const data = engine.trashList({ limit: body && body.limit });
    return { ok: true, ...data };
  }

  /** FR-P3-4：回收站还原。body: { id | ids } */
  async function handleTrashRestore(body) {
    const ids = asIdList(body);
    const engine = await requireEngine();
    const results = [];
    for (const id of ids) {
      try {
        const result = await engine.trashRestore(id, { reason: body && body.reason ? String(body.reason) : 'manual' });
        results.push({ id, ok: Boolean(result && result.ok), ...result });
      } catch (err) {
        results.push({ id, ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
    return { ok: true, results };
  }

  /**
   * FR-P3-4 / I-12 / A-P3-7：彻底删除（唯一不可逆 unlink）。
   * body: { id | ids, confirm: true } —— **没有 confirm:true 就零写入**（这里就拦，不靠引擎兜底）。
   */
  async function handleTrashPurge(body) {
    const ids = asIdList(body);
    const confirm = body && body.confirm === true;
    if (!confirm) {
      return {
        ok: false,
        code: 'confirm-required',
        error: '彻底删除必须显式 confirm:true（无 confirm 零写入：I-12 / A-P3-7）',
        writes: 0,
        results: ids.map((id) => ({ id, ok: false, code: 'confirm-required', writes: 0 })),
      };
    }
    const engine = await requireEngine();
    const results = [];
    for (const id of ids) {
      try {
        const result = await engine.trashPurge(id, { confirm: true, reason: body && body.reason ? String(body.reason) : 'manual' });
        results.push({ id, ok: Boolean(result && result.ok), ...result });
      } catch (err) {
        results.push({ id, ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
    return { ok: true, results };
  }

  /**
   * P4 / FR-P4-7：header 事实扫描（class S 的唯一事实源）。
   * body: { action: "start" | "status" }（省略 = start）
   *  - start：**立即**扫一遍（force），写 sessions 三列 + subscan:at/count/gaps/orphanEdges；
   *  - status：只读快照（不触发扫描）。
   * 后置：扫描只读遍历会话目录、绝不搬移/删除任何文件；失败（sessions 不可读）如实 ok:false。
   */
  async function handleSubagentScan(body) {
    const action = body && typeof body.action === 'string' && body.action.trim() ? body.action.trim() : 'start';
    if (action !== 'start' && action !== 'status') {
      throw new HttpError(400, 'invalid-request', 'action 只支持 start / status（收到 ' + action + '）');
    }
    const engine = await requireEngine();
    if (typeof engine.subscanSnapshot !== 'function') {
      throw new HttpError(501, 'not-supported', '引擎没有 subscanSnapshot（版本不匹配）');
    }
    if (action === 'status') {
      return {
        ok: true,
        action,
        scan: engine.subscanSnapshot(),
        subagent: typeof engine.subagentStatus === 'function' ? await engine.subagentStatus({ withCandidates: false }) : null,
      };
    }
    if (typeof engine.scanHeaderFacts !== 'function') {
      throw new HttpError(501, 'not-supported', '引擎没有 scanHeaderFacts（版本不匹配）');
    }
    const scan = await engine.scanHeaderFacts({ force: true });
    return {
      ok: Boolean(scan && scan.ok),
      action,
      scan,
      subagent: typeof engine.subagentStatus === 'function' ? await engine.subagentStatus({ withCandidates: false }) : null,
    };
  }

  /**
   * P4 / FR-P4-7 ＋ §19.11：手动批量迁移。
   * body: { all:true } 或 { ids:[...] }，**必须** confirm:true（没有就 400 + 零写入）。
   * 返回 job 读数（后台按 SUBAGENT_BATCH_CAP 逐条搬；进度/取消走 subagent-job）。
   */
  async function handleSubagentMigrate(body) {
    const confirm = body && body.confirm === true;
    if (!confirm) {
      return {
        ok: false,
        code: 'confirm-required',
        error: '迁移子代理会话必须显式 confirm:true（二次确认：设计档 §19.5 FR-P4-7）',
        writes: 0,
        job: null,
      };
    }
    const engine = await requireEngine();
    if (typeof engine.startSubagentJob !== 'function') {
      throw new HttpError(501, 'not-supported', '引擎没有 startSubagentJob（版本不匹配）');
    }
    const all = body && body.all === true;
    let ids = null;
    if (!all) {
      if (!body || (typeof body.id !== 'string' && !Array.isArray(body.ids))) {
        throw new HttpError(400, 'invalid-request', '需要 all:true 或 ids（字符串数组）');
      }
      ids = asIdList(body);
    }
    const started = all ? await engine.startSubagentJob({ all: true }) : await engine.startSubagentJob({ ids });
    const wait = started && typeof started.wait === 'function' ? started.wait : null;
    const payload = { ...started };
    delete payload.wait;
    if (wait) {
      // 后台跑完只看 job 读数（HTTP 不等它跑完）；错误不吞：wait 上挂 catch 以防 unhandled rejection。
      wait().catch((err) => {
        try {
          logger.warn?.('[dsh-session-vault] 批量迁移作业异常：' + (err && err.message ? err.message : err));
        } catch {
          /* ignore */
        }
      });
    }
    return { ok: Boolean(started && started.ok), ...payload };
  }

  /** P4 / FR-P4-7：手动批量作业的进度 / 取消。body: { action: "status" | "cancel" } */
  async function handleSubagentJob(body) {
    const action = body && typeof body.action === 'string' && body.action.trim() ? body.action.trim() : 'status';
    if (action !== 'status' && action !== 'cancel') {
      throw new HttpError(400, 'invalid-request', 'action 只支持 status / cancel（收到 ' + action + '）');
    }
    const engine = await requireEngine();
    if (typeof engine.subagentJobSnapshot !== 'function') {
      throw new HttpError(501, 'not-supported', '引擎没有 subagentJobSnapshot（版本不匹配）');
    }
    if (action === 'status') return { ok: true, action, job: engine.subagentJobSnapshot() };
    if (typeof engine.cancelSubagentJob !== 'function') {
      throw new HttpError(501, 'not-supported', '引擎没有 cancelSubagentJob（版本不匹配）');
    }
    const result = engine.cancelSubagentJob();
    return { ok: Boolean(result && result.ok), action, ...result };
  }

  /** FR-P3-5：诊断（**只读**；三类对账，不移动、不删除、不写 manifest）。body: { maxScanDirs? } */
  async function handleDiagnose(body) {
    const engine = await requireEngine();
    const data = await engine.diagnose({ maxScanDirs: body && body.maxScanDirs });
    return { ok: true, ...data };
  }

  /**
   * FR-P3-5：修复。body: { checks?: string[], apply?: boolean }
   *  - apply 只认**严格 true**（"true" / 1 一律按 dry-run 处理 —— 安全方向失败）；
   *  - checks 省略 = 全部可修复项；给了就必须是字符串数组，且必须是 /diagnose 的项 id 或检查名。
   * 引擎抛 invalid-check ⇒ 400（不是 500：调用方参数问题）。
   */
  async function handleRepair(body) {
    const engine = await requireEngine();
    const rawChecks = body && body.checks !== undefined && body.checks !== null ? body.checks : null;
    if (rawChecks !== null && (!Array.isArray(rawChecks) || !rawChecks.every((value) => typeof value === 'string'))) {
      throw new HttpError(400, 'invalid-request', 'checks 必须是字符串数组（省略 = 全部可修复项）');
    }
    try {
      return await engine.repair({ checks: rawChecks, apply: body && body.apply === true });
    } catch (err) {
      if (err instanceof EngineFailure) throw new HttpError(400, err.code || 'invalid-request', err.message);
      throw err;
    }
  }

  const endpoints = {
    status: handleStatus,
    diag: handleDiag,
    config: handleConfig,
    list: handleList,
    migrate: handleMigrate,
    restore: handleRestore,
    archive: handleArchive,
    unarchive: handleUnarchive,
    'rebuild-index': handleRebuildIndex,
    search: handleSearch,
    preview: handlePreview,
    // P3b
    favorite: handleFavorite,
    delete: handleDelete,
    trash: handleTrash,
    'trash-restore': handleTrashRestore,
    'trash-purge': handleTrashPurge,
    diagnose: handleDiagnose,
    repair: handleRepair,
    // P4（FR-P4-7）：子代理会话冷存
    'subagent-scan': handleSubagentScan,
    'subagent-migrate': handleSubagentMigrate,
    'subagent-job': handleSubagentJob,
  };

  async function handler(req, res) {
    try {
      if (!isTrustedRequest(req)) {
        return sendJson(res, 403, { ok: false, error: 'forbidden', code: 'forbidden', message: '仅接受本机（loopback）同源请求' });
      }
      const method = String((req && req.method) || 'GET').toUpperCase();
      if (method !== 'POST') {
        if (typeof res.setHeader === 'function') res.setHeader('allow', 'POST');
        return sendJson(res, 405, { ok: false, error: 'method-not-allowed', code: 'method-not-allowed', message: '本接口只接受 POST' });
      }
      const url = new URL((req && req.url) || '/', 'http://dsh.internal');
      const pathname = url.pathname.replace(/\/+$/, '');
      if (!pathname.startsWith(PREFIX)) {
        return sendJson(res, 404, { ok: false, error: 'not-found', code: 'not-found', message: '未知路径' });
      }
      const name = pathname.slice(PREFIX.length).replace(/^\/+/, '');
      if (!name) {
        return sendJson(res, 404, { ok: false, error: 'not-found', code: 'not-found', message: '缺少接口名' });
      }
      if (Object.prototype.hasOwnProperty.call(NOT_IMPLEMENTED, name) && !Object.prototype.hasOwnProperty.call(endpoints, name)) {
        return sendJson(res, 501, notImplementedPayload(name));
      }
      const endpoint = endpoints[name];
      if (typeof endpoint !== 'function') {
        return sendJson(res, 404, { ok: false, error: 'not-found', code: 'not-found', message: '未知接口：' + name });
      }
      const body = await readJsonBody(req);
      const payload = await endpoint(body);
      if (payload && payload.ok === false) {
        return sendJson(res, 400, payload);
      }
      return sendJson(res, 200, payload === undefined ? { ok: true } : payload);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : 'internal';
      const message = err && err.message ? err.message : 'internal error';
      if (!(err instanceof HttpError)) {
        try { logger.warn?.('[dsh-session-vault] http 500: ' + message); } catch { /* ignore */ }
      }
      return sendJson(res, status, { ok: false, error: code === 'internal' ? 'internal' : code, code, message });
    }
  }

  return { handler, endpoints, PREFIX, NOT_IMPLEMENTED, IMPLEMENTED };
}
