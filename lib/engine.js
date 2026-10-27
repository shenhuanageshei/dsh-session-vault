/**
 * VaultEngine（设计档 §6 / §7 / §11 / §12）
 *
 * 职责：迁移、恢复、启动收敛（recoverOnBoot）、归档包装（ArchiveTracker）、冷索引。
 *
 * 三条铁律：
 *  ① 一切写操作进**单串行队列**（§13 并发）；
 *  ② 任何失败**不删源**；允许删源的唯一条件 = 目标已通过 marker 全量基线校验（+ 迁移复检 I-6）；
 *  ③ 无法判定的状态必须落成**显式标记态**（error='needs-review' / 'lost'，双份保留），
 *     自动例程永不动双份里的任何一份。
 *
 * 状态/错误的边界（R-15）：status 只用 hot|migrating|cold|restoring|hot-restored|trash 六值；
 * needs-review / lost 等显式标记态落在 error 字段，marker 保留作为待人工处置的证据。
 */
// A-19：engine 的业务代码里**不允许**直接调用 mkdir/rename/rm/unlink —— 一切写/删都必须经
// writeOp/assertWritable。（旧的直接在 `restoreNow` 同卷分支里调 `mkdir`/`rename` 就绕过了白名单。）
// 这几个 fs 原语只以 `fs*` 别名存在，用途**仅限**构造注入用的 this.fsOps 默认值（测试可整体替换）。
import { readdir, stat, readFile, open as fsOpen, mkdir as fsMkdir, rename as fsRename, rm as fsRm, unlink as fsUnlink } from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
// F2（P2.3）：Proxy 形态取证。types.isProxy 只看「是不是 Proxy」，不触发 get/set，零副作用。
import { types as utilTypes } from 'node:util';
import {
  effectiveColdRoot,
  isPathInside,
  samePath,
  SEARCH_SCOPES,
  SEARCH_SCOPE_META,
  SEARCH_SCOPE_TOOL_RESULTS,
  DEFAULT_SEARCH_SCOPE,
  INDEX_SCHEMA_VERSION,
  indexSchemaSnapshotFrom,
  SCOPE_MAX_ROUNDS,
  WATERMARK_META_PREFIX,
  TOOL_SCOPE_META_PREFIX,
} from './config.js';
import {
  MarkerStore,
  projectKey,
  isGenerationName,
  generationVersion,
  sortGenerations,
  hashTree,
  statTree,
  fingerprint,
  listDirFiles,
  pathExists,
  isDirectory,
  fsyncFile,
  sha256Hex,
  hashFile,
} from './marker.js';
import { Manifest } from './manifest.js';
import { readHeaderRegion, forEachJsonLine } from './zstd-frames.js';
import { extractEvent, parseLine, emptyStats, isLegacyFormat } from './extract.js';

export { projectKey };
export const FORMAT_WHITELIST = Object.freeze([0, 3, 4]);
/** AC-9 / A-18：与冷存储冲突的「只做标记层」插件（AM 会删缺失工件的归档标记）。 */
export const ARCHIVE_MANAGER_PATTERN = /archive-manager|dsh-archived-sessions/i;
export const VAULT_OVERLAY = Symbol.for('dsh-session-vault.overlay');
export const VAULT_ORIGINAL = Symbol.for('dsh-session-vault.original');
export const VAULT_WRAPPED = Symbol.for('dsh-session-vault.wrapped');
/** F3：包装的共享状态（当前两层引用 + 重装计数 + 谁覆盖过我们）。同一 registry 只存一份。 */
export const VAULT_STATE = Symbol.for('dsh-session-vault.state');
/** F3（P2.3）：自动重装的硬上限 —— 超过这个次数仍 mismatched 就停手（不再抖动）。 */
export const OVERLAY_MAX_AUTO_REINSTALLS = 3;
/** F3（P2.3）：重装退避基数（第 1/2 次 30s，第 3 次 60s，之后封顶 5 分钟）。 */
export const OVERLAY_BACKOFF_BASE_MS = 30 * 1000;
export const OVERLAY_BACKOFF_MAX_MS = 5 * 60 * 1000;
/** F2/F3：包装的两个方法名（诊断按同一套口径遍历）。 */
export const OVERLAY_METHODS = Object.freeze(['archiveSession', 'unarchiveSession']);

/** 显式标记态（落在 sessions.error 上；与 status 六值互不混淆，R-15）。 */
export const ERROR_STATES = Object.freeze({
  LOST: 'lost',
  NEEDS_REVIEW: 'needs-review',
  RACE_UNARCHIVED: 'race-unarchived',
  RACE_WRITTEN: 'race-written',
  INDEX_FAILED: 'index-failed',
  EXTRACT_EMPTY: 'extract-empty',
  FRAME_CORRUPT: 'frame-corrupt',
  IDENTITY_MISMATCH: 'identity-mismatch',
  EXTERNAL_UNARCHIVED: 'external-unarchived',
});

// ---------------------------------------------------------------------------
// P3b：回收站 / 诊断（FR-P3-4、FR-P3-5）
// ---------------------------------------------------------------------------
/** 回收站保留期：30 天（P3-D5 / FR-P3-4）。**到期只提示，绝不自动删**（A-P3-9）。 */
export const TRASH_RETENTION_MS = 30 * 86400 * 1000;
/**
 * 回收站搬移的在途 marker 前缀（§18.4 伪代码 `markers.write('trash-' + id)`）。
 * marker 文件名 = `trash-<sessionId>.json`；payload 里**另存** sessionId（不能拿文件名当 id，
 * 否则启动收敛会为 `trash-xxx` 造出一条假会话行）。
 */
export const TRASH_MARKER_PREFIX = 'trash-';
/** purge 的硬前置（I-12 / A-P3-7）：没有 confirm:true 一律零写入。 */
export const TRASH_PURGE_CONFIRM = true;
/**
 * /diagnose 的检查项封闭集（§18.4 FR-P3-5 逐字三条）：
 *  ① 日志可读性 frame-corrupt / extract-empty / index-failed / seq-gap；
 *  ② DB/manifest 对账 db-no-manifest / manifest-no-db / marker-no-row / hidden-mismatch；
 *  ③ 磁盘对账 row-cold-no-dir / cold-dir-no-row。
 */
export const DIAGNOSE_CHECKS = Object.freeze([
  'frame-corrupt',
  'extract-empty',
  'index-failed',
  'seq-gap',
  'db-no-manifest',
  'manifest-no-db',
  'marker-no-row',
  'hidden-mismatch',
  'row-cold-no-dir',
  'cold-dir-no-row',
]);
/** 日志可读性四条（诊断分组 ①）。 */
export const LOG_CHECKS = Object.freeze(['frame-corrupt', 'extract-empty', 'index-failed', 'seq-gap']);
/** 安全修复动作的封闭集（§18.4 FR-P3-5：**不做 v0→v4 重编码**，P3-D8）。 */
export const REPAIR_ACTIONS = Object.freeze([
  'reindex',
  'mark-needs-review',
  'append-manifest',
  'delete-manifest-rows',
  'remove-marker',
  'import-cold',
  'clear-hidden',
]);


// ---------------------------------------------------------------------------
// P4（设计档 §19）：子代理会话冷存（class S）
// ---------------------------------------------------------------------------
/**
 * 「谁引用谁」快照的 TTL（FR-P4-2 / I-18）：超过 24h 视为不可信 ⇒ class S 零搬移。
 * 迁移是写操作，保护条件必须可查询、可审计；每次迁移现场全扫要 ~10s IO（实测 2414 个目录）。
 */
export const REF_SCAN_TTL_MS = 24 * 60 * 60 * 1000;
/** 手动批量的单次上限（§19.11 用户裁定：一次 2000 个），后台任务可取消 + 有进度。 */
export const SUBAGENT_BATCH_CAP = 2000;
/** 自动清扫的单轮上限（内部常量，不进配置：避免多旋钮）。 */
export const SUBAGENT_ROUND_LIMIT = 10;
/** 首轮 header 事实扫描的最早时刻（插件启动 60s 后；由 Sweeper 的首拍承担，见 sweeper.js）。 */
export const SUBAGENT_FIRST_SCAN_DELAY_MS = 60 * 1000;
/** subscan:orphanEdges 的落库上限；**溢出部分计入 gaps**（fail-closed，评审 #9）。 */
export const SUBAGENT_ORPHAN_EDGE_LIMIT = 500;

/**
 * class S 的 meta 键（§19.7 的「谁写谁读」表）。
 * 与 class A 的 sweep:* 键**完全分开**：同一台清扫器里两套口径不能共用预算/退避。
 */
export const SUBSCAN_META = Object.freeze({
  /** 上次成功扫描时刻（ms） */
  at: 'subscan:at',
  /** 成功读到 header 的目录数 */
  count: 'subscan:count',
  /** 读不到 header / 溢出等缺口（JSON 数组 [{id, reason}]）—— 非空即暂停 class S */
  gaps: 'subscan:gaps',
  /** 无 DB 行目录的入边（JSON 数组 [{from, field, to}]，上限 500） */
  orphanEdges: 'subscan:orphanEdges',
  /** 自动清扫日预算前缀（键 subscan:budget:<UTC 日>） */
  budgetPrefix: 'subscan:budget:',
  /** 失败退避计数前缀（键 subscan:fail:<id>） */
  failurePrefix: 'subscan:fail:',
  /** 手动批量作业进度（JSON；跨重启读得到「上次批量中断」） */
  job: 'subscan:job',
});

/** header 里「像会话 id」的值（用于无 DB 行目录的入边保护；只会多保护，不会少保护）。 */
const SESSION_ID_LIKE = /^[A-Za-z0-9._-]{3,}$/;
/**
 * header 顶层的结构性字段（不是引用边）：origin / type / cwd / 版本号 / 模型 …
 * 刻意显式列举而不是「只认 parentSession」—— 将来 header 新增 id 型字段时，
 * 无行目录的边会自动进 orphanEdges（多保护一边，fail-closed）；
 * 但**有 DB 行的会话只落 parent_session**（§19.5 FR-P4-2 的判据只有它）。
 */
const HEADER_NON_REF_KEYS = Object.freeze([
  'id', 'sessionId', 'type', 'cwd', 'title', 'origin', 'kind', 'role', 'state', 'status',
  'model', 'provider', 'formatVersion', 'delegationDepth', 'delegation_depth', 'createdAt', 'ts', 'time',
  'reason', 'note', 'version', 'seq', 'parentSessionId',
]);

/**
 * header → 三个落库事实（§19.5 FR-P4-2）。**读不到就是未知**（null / 0），绝不猜。
 *
 * 兼容两种来源：真读（readSessionHeader 带回 raw）与单测注入的假 header（只带平铺字段）。
 */
export function headerFactsOf(header) {
  if (!header || typeof header !== 'object') return { origin: null, delegationDepth: 0, parentSession: null };
  const raw = header.raw && typeof header.raw === 'object' ? header.raw : null;
  const data = raw && raw.data && typeof raw.data === 'object' ? raw.data : null;
  const pickString = (key) => {
    for (const source of [raw, data, header]) {
      if (!source || typeof source !== 'object') continue;
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  };
  const pickDepth = () => {
    for (const source of [raw, data, header]) {
      if (!source || typeof source !== 'object') continue;
      const value = source.delegationDepth !== undefined ? source.delegationDepth : source.delegation_depth;
      if (value === null || value === undefined || value === '') continue;
      const num = Number(value);
      if (Number.isFinite(num)) return Math.max(0, Math.trunc(num));
    }
    return 0;
  };
  return { origin: pickString('origin'), delegationDepth: pickDepth(), parentSession: pickString('parentSession') };
}

/**
 * header → 引用边（只用于**无 DB 行**的目录，见 §19.6 伪代码 refs 那一行）。
 * 排除结构性字段与自身 id；值必须像会话 id。
 */
export function headerIdEdges(header, ownerId) {
  const raw = header && header.raw && typeof header.raw === 'object' ? header.raw : null;
  if (!raw) return [];
  const owner = String(ownerId === undefined || ownerId === null ? '' : ownerId);
  const out = [];
  const seen = new Set();
  const scan = (obj, prefix) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      if (HEADER_NON_REF_KEYS.includes(key)) continue;
      const value = obj[key];
      if (typeof value !== 'string') continue;
      const target = value.trim();
      if (!target || target === owner || !SESSION_ID_LIKE.test(target)) continue;
      const flag = prefix + key + '|' + target;
      if (seen.has(flag)) continue;
      seen.add(flag);
      out.push({ field: prefix + key, to: target });
    }
  };
  scan(raw, '');
  scan(raw.data, 'data.');
  return out;
}

/** 读一个 JSON 数组型 meta（脏值 / 非数组 ⇒ []；元素形状不对的丢掉，读面不猜）。 */
function readJsonArrayMeta(store, key) {
  try {
    const raw = store.getMeta(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 把 sessions.error 归到诊断分组 ① 的四条之一（归不上就是普通错误，不是可读性问题）。 */
export function logCheckOf(error) {
  const value = error === null || error === undefined ? '' : String(error);
  if (!value) return null;
  if (value === ERROR_STATES.FRAME_CORRUPT) return 'frame-corrupt';
  if (value === ERROR_STATES.EXTRACT_EMPTY) return 'extract-empty';
  if (value === ERROR_STATES.INDEX_FAILED || value.startsWith(ERROR_STATES.INDEX_FAILED + ':')) return 'index-failed';
  if (value.startsWith('seq-gap')) return 'seq-gap';
  return null;
}

export class EngineFailure extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'EngineFailure';
    this.code = code;
    if (details) this.details = details;
  }
}

/**
 * 队列上下文（M5）：用来**精确**区分「队列任务内部的重入」与「外部并发入队」。
 * 不能用全局 depth 计数——那样外部并发入队会被误判成重入、直接插队执行（破坏串行化）。
 */
const queueContext = new AsyncLocalStorage();

/** 写/删路径日志的默认上限（评审 #6：长跑进程不能无界增长）。0 = 不封顶（测试注入取全量）。 */
export const WRITE_LOG_LIMIT = 500;
/** 列表顶部统计的候选采样窗口（§15.1 #3：不再静默封顶，超出时用 pendingCapped 显式声明）。 */
export const PENDING_SAMPLE_LIMIT = 50;

/**
 * 固定容量环形日志（评审 #6）：只保留最近 limit 条，dropped 记被挤掉的条数。
 * limit <= 0 ⇒ 不封顶（单测注入 logLimit:0 时拿全量）。
 */
export class RingBuffer {
  constructor(limit = WRITE_LOG_LIMIT) {
    const value = Number(limit);
    this.limit = Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
    this._items = [];
    this.dropped = 0;
  }

  push(value) {
    if (!this.limit) {
      this._items.push(value);
      return;
    }
    if (this._items.length >= this.limit) {
      this._items.shift();
      this.dropped += 1;
    }
    this._items.push(value);
  }

  toArray() {
    return [...this._items];
  }

  get length() {
    return this._items.length;
  }

  get total() {
    return this._items.length + this.dropped;
  }

  clear() {
    this._items.length = 0;
    this.dropped = 0;
  }
}

// ---------------------------------------------------------------------------
// 文件系统小工具（全部经 engine.assertWritable 记录写路径，供 A-19 假 fs 断言）
// ---------------------------------------------------------------------------
async function copyFileChunked(src, dst, chunkSize = 8 * 1024 * 1024) {
  const { open } = await import('node:fs/promises');
  const input = await open(src, 'r');
  const output = await open(dst, 'w');
  try {
    const buffer = Buffer.allocUnsafe(chunkSize);
    let position = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, chunkSize, position);
      if (!bytesRead) break;
      await output.write(buffer.subarray(0, bytesRead));
      position += bytesRead;
      await new Promise((resolve) => setImmediate(resolve));
    }
    await output.sync();
  } finally {
    await input.close().catch(() => {});
    await output.close().catch(() => {});
  }
}

async function sameVolume(a, b) {
  const rootA = path.parse(path.resolve(a)).root.toLowerCase();
  const rootB = path.parse(path.resolve(b)).root.toLowerCase();
  if (rootA !== rootB) return false;
  try {
    const [sa, sb] = await Promise.all([stat(rootA), stat(rootB)]);
    return sa.dev === sb.dev;
  } catch {
    return true;
  }
}

async function diskFreeBytes(dir) {
  try {
    const { statfs } = await import('node:fs/promises');
    if (typeof statfs !== 'function') return null;
    const info = await statfs(dir);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return null;
  }
}

/** 首帧**压缩字节** sha256 前 16 位（同名异会话防护，§13）。 */
async function firstFrameSha(file) {
  try {
    const region = await readHeaderRegion(file, { chunkSize: 8192, maxFrames: 1, maxBytes: 1024 * 1024 });
    if (!region.frames.length) return '';
    const frame = region.frames[0];
    return sha256Hex(region.buffer.subarray(frame.start, frame.end)).slice(0, 16);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// R-17：seq 跳号诊断（**只做诊断，绝不整会话拒收**，§4.2）
// ---------------------------------------------------------------------------

/**
 * 事件流 seq 缺口超过这个比例才把诊断写进行的 `error`（其余情况只进 meta）。
 * 10%：单点跳号在长会话里很常见（宿主写盘边界/被杀进程），全刷成 error 会把真正的诊断面淹没。
 */
export const SEQ_GAP_ALERT_RATIO = 0.1;

/**
 * 给定一组 seq，算「区间缺口比例」：1 − 去重后出现的 seq 个数 / [min,max] 区间长度。
 * 0 = 完全连续；1 = 极端跳号。**不判死**：怎么用（meta / error / 阈值）由调用方决定。
 * @returns {{count:number,min:number|null,max:number|null,expected:number,gaps:number,ratio:number}}
 */
export function seqGapOf(sequences) {
  const unique = [
    ...new Set(
      (sequences || [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.trunc(value)),
    ),
  ].sort((a, b) => a - b);
  const count = unique.length;
  const min = count ? unique[0] : null;
  const max = count ? unique[count - 1] : null;
  const expected = count ? max - min + 1 : 0;
  const gaps = expected > count ? expected - count : 0;
  return { count, min, max, expected, gaps, ratio: expected > 0 ? Number((gaps / expected).toFixed(4)) : 0 };
}

/**
 * 组装某会话的 seq 诊断读数：**事件流为主判据，docs 为辅证**。
 *
 * 为什么不是「直接数 docs 的 seq 缺口」：docs 只收 user/message、assistant/message、session/title
 * 三种事件（§8.2），它们之间必然夹着 turn/start、step/*、tool/* 等大量事件 ⇒ **健康会话**的 docs 侧
 * 缺口也恒 > 0，拿它当告警等于每个会话都报警（诊断面直接失效）。真正的「丢帧/跳号」信号是整条
 * 事件流的 seq 断裂，所以 error 判据用事件流；docs 侧的数字一并记进 meta，供诊断时交叉核对。
 *
 * @param {{sequences?:number[], docs?:object[], events?:number, duplicates?:number}} input
 */
export function buildSeqGapReport({ sequences = [], docs = [], events = 0, duplicates = 0 } = {}) {
  const stream = seqGapOf(sequences);
  const docSeqs = (docs || [])
    .map((doc) => (doc ? doc.seq : null))
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  const docLevel = seqGapOf(docSeqs);
  return {
    events,
    duplicates,
    count: stream.count,
    min: stream.min,
    max: stream.max,
    expected: stream.expected,
    gaps: stream.gaps,
    ratio: stream.ratio,
    docs: docLevel.count,
    docGaps: docLevel.gaps,
    docRatio: docLevel.ratio,
  };
}

/**
 * 有界并发 map（F4：header / projcache 读取限流，默认 8）。
 *
 * 结果顺序与输入一致；单个任务抛错时该位置返回 null（由调用方决定「缺一条」的语义）。
 * 不引第三方并发库：worker 池只按 cursor 取下标，天然不漏不重。
 */
export async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.trunc(Number(limit) || 1));
  const out = new Array(list.length);
  if (!list.length) return out;
  let cursor = 0;
  const lanes = Math.min(size, list.length);
  const runners = [];
  for (let lane = 0; lane < lanes; lane += 1) {
    runners.push((async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= list.length) return;
        try {
          out[index] = await worker(list[index], index);
        } catch {
          out[index] = null;
        }
      }
    })());
  }
  await Promise.all(runners);
  return out;
}

/** 读日志首行 header（增量读；解不开就返回 null，由调用方标 header-unverified）。 */
export async function readSessionHeader(file) {
  try {
    const region = await readHeaderRegion(file, { chunkSize: 8192, maxFrames: 1, maxBytes: 1024 * 1024 });
    if (!region.frames.length) return null;
    const frame = region.frames[0];
    const { decompressFrame } = await import('./zstd-frames.js');
    const text = decompressFrame(region.buffer.subarray(frame.start, frame.end)).toString('utf8');
    const line = text.split('\n')[0];
    if (!line) return null;
    const value = JSON.parse(line);
    if (!value || typeof value !== 'object') return null;
    const data = value.data && typeof value.data === 'object' ? value.data : {};
    const pick = (obj, keys) => {
      for (const key of keys) if (obj && typeof obj[key] === 'string' && obj[key]) return obj[key];
      return null;
    };
    return {
      raw: value,
      type: typeof value.type === 'string' ? value.type : null,
      id: pick(value, ['sessionId', 'id']) || pick(data, ['sessionId', 'id']),
      cwd: pick(value, ['cwd']) || pick(data, ['cwd']),
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : typeof data.createdAt === 'number' ? data.createdAt : null,
      // P4（FR-P4-2）：header 事实三字段原样带出（不额外解压，与 raw 同一份读）。
      // 它们是**追加字段**，旧调用方按需取用，形状不变。
      origin: pick(value, ['origin']) || pick(data, ['origin']),
      delegationDepth: (() => {
        const raw = value.delegationDepth !== undefined ? value.delegationDepth : data.delegationDepth;
        const num = Number(raw);
        return Number.isFinite(num) ? Math.max(0, Math.trunc(num)) : 0;
      })(),
      parentSession: pick(value, ['parentSession']) || pick(data, ['parentSession']),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
/**
 * P2.4 🔵 #3：**未挂上 Sweeper 时的唯一读数实现**（engine 与 http 回退共用）。
 *
 * 旧实现有两份（engine.unattachedSweep / http.unattachedSweepPayload），字段已经漂移：
 * engine 在启动链还没报错时给 error/sweepError=null，http 恒给默认原因 —— 同一件事两个读数。
 * 现在只有这一份；`/status.sweep` 无论引擎在不在都走它（http 传 state，engine 额外传 budget）。
 *
 * 形状与 `Sweeper.snapshot()` 对齐（UI 只判 attached 一个字段），attached:false 的**原因恒可读**：
 * 显式 error > state.lastError > 默认「尚未挂上」。
 *
 * @param {object|null} state 启动链状态（lastError/attempts/nextRetryAt/gaveUp/stage/lastAttemptAt）
 * @param {{error?:string|null, now?:number, budget?:{day:string, used:number}|null}} [options]
 * @returns {object}
 */
export function unattachedSweepPayload(state, options = {}) {
  const value = state || {};
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const budgetHint = options.budget || null;
  const day = (budgetHint && budgetHint.day) || new Date(now).toISOString().slice(0, 10);
  const used = budgetHint && Number.isFinite(Number(budgetHint.used)) ? Number(budgetHint.used) : 0;
  const explicit = options.error ? String(options.error) : null;
  const message = explicit || (value.lastError ? String(value.lastError) : null) || 'Sweeper 尚未挂上（启动链未完成或仍在重试）';
  const reason = { code: 'sweeper-not-attached', message };
  return {
    attached: false,
    started: false,
    running: false,
    phase: 'not-attached',
    firstDelayMs: null,
    intervalMs: null,
    nextRunAt: value.nextRetryAt || null,
    nextRetryAt: value.nextRetryAt || null,
    lastRunAt: null,
    paused: true,
    pauseReason: reason,
    sweepError: reason,
    error: message,
    attempts: Number(value.attempts) || 0,
    lastAttemptAt: value.lastAttemptAt || null,
    gaveUp: Boolean(value.gaveUp),
    stage: value.stage || null,
    autoMigrate: null,
    budget: { day, used, limit: null },
    lastReport: null,
  };
}

export class VaultEngine {
  constructor(options = {}) {
    this.home = options.home || (options.configStore && options.configStore.home);
    this.paths = options.paths || (options.configStore && options.configStore.paths);
    if (!this.paths) throw new Error('VaultEngine 需要 paths 或 configStore');
    this.configStore = options.configStore;
    this.store = options.store;
    if (!this.store) throw new Error('VaultEngine 需要 store');
    this.registry = options.registry || null;
    this.persistence = options.persistence || null;
    this.ctx = options.ctx || null;
    this.logger = options.logger || console;
    this.now = options.now || (() => Date.now());
    const guard = (target) => this.assertWritable(target);
    this.markers = new MarkerStore(this.paths.markerDir, { assertPath: guard });
    this.manifest = new Manifest(this.paths.manifestPath, { assertPath: guard });
    // 评审 #6：写/删路径日志与假 fs 证据日志都是环形缓冲（默认最近 500 条）；logLimit:0 = 不封顶（测试）。
    const logLimit = options.logLimit === undefined ? WRITE_LOG_LIMIT : options.logLimit;
    this.writeLog = new RingBuffer(logLimit);
    this.fsLog = new RingBuffer(logLimit);
    this.queue = Promise.resolve();
    /** 队列上下文标记（M5）：当前调用链是否就在本实例的队列任务体内。 */
    this._queueMarker = Symbol('vault-queue');
    this.pending = 0;
    this.running = false;
    /** 列表缓存（P2-0 / Y-10）：TTL + 事件失效；命中时不再碰磁盘。 */
    this._listCache = null;
    this._listCacheTtlMs = 2000;
    /**
     * 「已归档 id → 磁盘事实」扫描缓存（P2-0）。一次目录扫描建映射，供 list / backfill 共用；
     * 归档集合变化或迁移/恢复事件（emit→invalidate）都会让它整体失效。
     */
    this._scanCache = null;
    this._scanCacheTtlMs = 5000;
    this._scanError = null;
    /** 可观测计数（status/测试用）：list 命中/未命中数与扫描次数，证明「一次扫描 + 缓存」真的生效。 */
    this._perf = { listHits: 0, listMisses: 0, scans: 0, lastListMs: 0, lastScanMs: 0, candidateHits: 0, candidateMisses: 0 };
    /**
     * 候选缓存（M4②）：list/status 每请求都会数「待迁」，旧实现每次都做 118 次 isActive waterfall
     * + 118 次 docs SQL。这里整表算一次、TTL 内复用；归档/迁移/恢复事件经 invalidate() 失效。
     */
    this._candidateCache = null;
    this._candidateCacheTtlMs = Number.isFinite(options.candidateCacheTtlMs) ? options.candidateCacheTtlMs : 5000;
    /**
     * P4：class S 的候选缓存（与 class A 的 _candidateCache **分开** —— 两套口径不能互相污染）。
     * 判据含 subscan:at 与 gaps 数：重新扫描成功后缓存自然失效。
     */
    this._subagentCandidateCache = null;
    /** P4：手动批量作业的内存句柄（进度另落 meta subscan:job，跨重启可读「上次中断」）。 */
    this._subagentJob = null;
    this._coldRoot = null;
    /** 已知冷根（当前配置根 + 每行落库的绝对冷根，D17/R-8）：A-16 多冷根恢复/清理都要用。 */
    this._coldRoots = new Set();
    /** 冷根全部不可访问时置 true（A-7：只读降级，不产生删除/搬移）。 */
    this.coldDegraded = false;
    /** 归档包装自检结果（R-21/坑 14）：被后装插件盖掉时不再静默失效。 */
    this.overlayDrift = null;
    /** F3：自动重装的读数（谁覆盖了我们 / 何时重装 / 重装几次 / 是否仍在漂移）。 */
    this.overlayRepair = null;
    /** F3：自动重装退避基数（默认 30s；随重装次数指数退避，封顶 5 分钟）。 */
    this.overlayRepairThrottleMs = Number.isFinite(options.overlayRepairThrottleMs) ? options.overlayRepairThrottleMs : OVERLAY_BACKOFF_BASE_MS;
    /**
     * F3（P2.3）：自动重装硬上限。真机 2026-10-24：reinstalls=10 仍在 mismatched ——
     * 宿主形状不支持时「重装」永远不会成功，只会每 30s 抖一次。到顶即停手（repairFailed）。
     */
    this.overlayMaxAutoReinstalls = Number.isFinite(options.overlayMaxAutoReinstalls) && options.overlayMaxAutoReinstalls > 0
      ? Math.trunc(options.overlayMaxAutoReinstalls)
      : OVERLAY_MAX_AUTO_REINSTALLS;
    /**
     * F2（P2.3）：最近一次归档包装安装的读数（形状 / 是否支持 / 原因 / 共享状态）。
     * 真机证据：ctx.get("workspaceRegistry") 返回的函数值读回是 Proxy（name 还是我们的包装名，
     * toString 已是 native），所以「装上了」不能只凭赋值没抛错。
     */
    this.overlayInstall = null;
    /** F2：安装器回调（index.js 注入；用于启动窗口 registry 未就绪时的补装）。 */
    this.overlayInstaller = typeof options.overlayInstaller === 'function' ? options.overlayInstaller : null;
    /** F2：宿主形状不支持包装（Proxy set 不生效 / 只读）⇒ 不再自动重试安装。 */
    this.overlayUnsupported = false;
    /** AC-9 / A-18：archive-manager 在场时**完全不装包装**（这里禁掉「读口补装」路径）。 */
    this.overlayDisabled = false;
    /**
     * F1：Sweeper 挂载状态（index.js 的启动链写入；engine 只读）。
     * 没有它的话「Sweeper 从未挂上」只能表达成 sweep=null —— 运维看不出原因（真机 7 小时 null）。
     */
    this.sweepAttach = options.sweepAttach || null;
    /** F4：归档目录扫描 / header / projcache 读取的并发上限（默认 8）。 */
    this.scanConcurrency = Number.isFinite(options.scanConcurrency) && options.scanConcurrency > 0 ? Math.trunc(options.scanConcurrency) : 8;
    /** F4：「projcache 标题 hint」的进程内缓存（命中优先，不再每次 backfill 都开 118 次文件）。 */
    this._titleHintCache = new Map();
    this._titleHintTtlMs = Number.isFinite(options.titleHintTtlMs) ? options.titleHintTtlMs : 10 * 60 * 1000;
    this._amCache = null;
    // 测试接缝（不是降级路径）：同卷判定 / 分块拷贝 / fs 写操作可注入，
    // 用于在单卷 CI 上确定性覆盖跨卷分支，以及 A-19「注入假 fs 断言写路径前缀」。
    this.deps = {
      isActive: options.isActive || null,
      statSession: options.statSession || null,
      resolveWorkspace: options.resolveWorkspace || null,
      sameVolume: options.sameVolume || null,
      detectAm: options.detectAm || null,
      onWrite: options.onWrite || null,
      // F4 接缝（不是降级路径）：单测注入慢/计数 header 读取，验证「限流 8 的并发」确实生效。
      readSessionHeader: options.readSessionHeader || null,
    };
    const fsOverrides = options.fs || {};
    this.fsOps = {
      mkdir: typeof fsOverrides.mkdir === 'function' ? fsOverrides.mkdir : fsMkdir,
      rename: typeof fsOverrides.rename === 'function' ? fsOverrides.rename : fsRename,
      rm: typeof fsOverrides.rm === 'function' ? fsOverrides.rm : fsRm,
      unlink: typeof fsOverrides.unlink === 'function' ? fsOverrides.unlink : fsUnlink,
    };
    this.copyFileImpl = options.copyFile || copyFileChunked;
  }

  // ---- 基础访问 ---------------------------------------------------------
  log(level, message) {
    try {
      const fn = this.logger && (this.logger[level] || this.logger.warn);
      if (typeof fn === 'function') fn.call(this.logger, '[dsh-session-vault] ' + message);
    } catch {
      /* 日志永不抛 */
    }
  }

  getService(name) {
    try {
      return this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  }

  async config() {
    return (await this.configStore.load()).config;
  }

  async coldRoot() {
    const cfg = await this.config();
    this._coldRoot = effectiveColdRoot(cfg, this.paths);
    this._coldRoots.add(this._coldRoot);
    return this._coldRoot;
  }

  /** 全部「已知冷根」：当前配置根 + 每一行落库的绝对冷根（D17：改根不搬旧数据）。 */
  knownColdRoots() {
    const roots = new Set(this._coldRoots);
    if (this._coldRoot) roots.add(this._coldRoot);
    try {
      for (const row of this.store.listSessions()) {
        if (row && row.cold_root) roots.add(row.cold_root);
      }
    } catch {
      /* 行读不出来时只用内存根 */
    }
    return [...roots].filter(Boolean);
  }

  /** 逐根探测可用性（A-7 / 12 号项：真实的冷根可访问性，不是桩）。 */
  async probeColdRoots() {
    const cfg = await this.config();
    const current = effectiveColdRoot(cfg, this.paths);
    this._coldRoot = current;
    this._coldRoots.add(current);
    const roots = this.knownColdRoots();
    const report = [];
    for (const root of roots) {
      let available = false;
      try {
        available = (await stat(root)).isDirectory();
      } catch {
        available = false;
      }
      // 当前配置根**尚未创建**不是「不可用」：先幂等建目录（仍在白名单内），
      // 建不出来（盘拔了/权限/父路径是文件）才算真的不可用（A-7 只读降级的判据）。
      if (!available && samePath(root, current)) {
        try {
          await this.writeOp('mkdir', root, [root], (resolved) => this.fsOps.mkdir(resolved, { recursive: true }));
          available = true;
        } catch {
          available = false;
        }
      }
      report.push({ root, available, current: samePath(root, current) });
    }
    this.coldDegraded = report.length > 0 && report.every((item) => !item.available);
    return report;
  }

  getSessionEntry(id) {
    return this.store.getSession(String(id));
  }

  /** 写路径白名单命中记录（A-19 证据面）。环形缓冲 ⇒ 返回最近 logLimit 条。 */
  getWriteLog() {
    return this.writeLog.toArray();
  }

  /** 假 fs 证据面（每个 mkdir/rename/rm/unlink/copy/fsync 一条）。 */
  getFsLog() {
    return this.fsLog.toArray();
  }

  invalidate() {
    this._listCache = null;
    this._scanCache = null;
    this._candidateCache = null;
    // P4：class S 的候选缓存也随事件失效（迁移/恢复/扫描完成都会经过这里）
    this._subagentCandidateCache = null;
  }

  /** 观测读数（P2-0 验收：一次扫描 + 缓存命中；不参与业务判定）。 */
  perfStats() {
    return {
      ...this._perf,
      cached: Boolean(this._listCache),
      scanning: Boolean(this._scanCache),
      candidatesCached: Boolean(this._candidateCache),
      subagentCandidatesCached: Boolean(this._subagentCandidateCache),
      writeLog: { kept: this.writeLog.length, dropped: this.writeLog.dropped },
      fsLog: { kept: this.fsLog.length, dropped: this.fsLog.dropped },
    };
  }

  emit(event) {
    this.invalidate();
    this.log('info', '事件 ' + event.type + ': ' + event.id);
  }

  /** 写路径白名单根：vault 数据目录 / sessions / 全部已知冷根 + 调用方显式给的根。 */
  writeRoots(extraRoots = []) {
    const roots = [
      this.paths.vaultRoot,
      this.paths.sessionsRoot,
      this._coldRoot,
      ...this._coldRoots,
      ...this.knownColdRoots(),
      ...extraRoots,
    ];
    return [...new Set(roots.filter(Boolean).map((root) => path.resolve(root)))];
  }

  /** A-19 / I-1：所有写路径必须落在白名单根之内（绝不写工作区目录）。 */
  assertWritable(target, extraRoots = []) {
    const resolved = path.resolve(target);
    const roots = this.writeRoots(extraRoots);
    const allowed = roots.some((root) => samePath(resolved, root) || isPathInside(resolved, root));
    if (!allowed) {
      throw new EngineFailure('write-outside-vault', '写路径越界（A-19）：' + resolved + ' 不在 ' + roots.join(' / ') + ' 之内');
    }
    this.writeLog.push(resolved);
    return resolved;
  }

  /**
   * 统一写/删入口（A-19 的那一条口子）：先过白名单，再记进 fsLog（假 fs 测试的证据面），最后才真动手。
   * 引擎里**不允许**出现绕过这里的 mkdir / rename / rm / unlink / copy。
   */
  async writeOp(kind, target, extraRoots, run) {
    const resolved = this.assertWritable(target, extraRoots);
    const record = { kind, path: resolved };
    this.fsLog.push(record);
    if (typeof this.deps.onWrite === 'function') await this.deps.onWrite(record);
    return run(resolved);
  }

  async mkdirp(target, extraRoots = []) {
    return this.writeOp('mkdir', target, extraRoots, (resolved) => this.fsOps.mkdir(resolved, { recursive: true }));
  }

  async removeTree(target, coldRoot) {
    return this.writeOp('rm', target, coldRoot ? [coldRoot] : [], (resolved) =>
      this.fsOps.rm(resolved, { recursive: true, force: true }),
    );
  }

  async removeFile(target, coldRoot) {
    return this.writeOp('unlink', target, coldRoot ? [coldRoot] : [], async (resolved) => {
      try {
        await this.fsOps.unlink(resolved);
        return true;
      } catch (err) {
        if (err && err.code === 'ENOENT') return false;
        throw err;
      }
    });
  }

  async renamePath(from, to, coldRoot) {
    const extra = coldRoot ? [coldRoot] : [];
    this.assertWritable(from, extra); // 源端也是写操作的一半（rename 会改它）
    return this.writeOp('rename', to, extra, (resolved) => this.fsOps.rename(from, resolved));
  }

  async copyInto(from, to, coldRoot) {
    const extra = coldRoot ? [coldRoot] : [];
    return this.writeOp('copy', to, extra, (resolved) => this.copyFileImpl(from, resolved));
  }

  async fsyncPath(target, coldRoot) {
    return this.writeOp('fsync', target, coldRoot ? [coldRoot] : [], (resolved) => fsyncFile(resolved));
  }

  /**
   * 单串行队列（§13 / M5）：索引、迁移、恢复、启动收敛的写操作都经这里。
   *
   * **重入保护**：队列任务体内再次 enqueue（典型场景：迁移尾段/恢复尾段里触发索引）必须就地执行——
   * 否则新任务会排在「自己还没结束的那一轮」后面，形成自锁。深度 > 0 时直接跑 task。
   */
  enqueue(task) {
    if (queueContext.getStore() === this._queueMarker) return Promise.resolve().then(() => task());
    this.pending += 1;
    const run = this.queue.then(async () => {
      this.pending -= 1;
      this.running = true;
      try {
        return await queueContext.run(this._queueMarker, () => task());
      } finally {
        this.running = false;
      }
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ---- 归档集合 / 活跃 / persistence ------------------------------------
  archivedIds() {
    const raw = this.registry && this.registry.archivedSessionIds;
    if (!raw) return new Set();
    const values = Array.isArray(raw) ? raw : typeof raw[Symbol.iterator] === 'function' ? [...raw] : [];
    return new Set(values.map((value) => String(value)));
  }

  isArchived(id) {
    return this.archivedIds().has(String(id));
  }

  /**
   * 这一行**是不是子代理会话**（FR-P4-3 第 2 条）。
   *
   * 前置：row 可为 null。
   * 后置：`origin === 'subagent'` 或 `delegation_depth >= 1` ⇒ true；纯函数，不读盘、不读 registry。
   * 判据与 header 事实扫描写入的三列同源（§19.7），不引入第四种「怎么算子代理」的口径。
   */
  isSubagentRow(row) {
    if (!row) return false;
    if (String(row.origin || '') === 'subagent') return true;
    return Math.max(0, Number(row.delegation_depth) || 0) >= 1;
  }

  /**
   * **派生**迁移类（§19.7：刻意不建 vault_class 列）。
   *
   * 后置：'archived'（在归档集合里，class A 优先）/ 'subagent'（子代理且不在归档集合）/ null。
   * 「归档优先」是 I-2 的既有语义：同一个 id 只会属于一套口径，绝不同时两套。
   */
  rowClass(row, archived = null) {
    if (!row) return null;
    const set = archived instanceof Set ? archived : this.archivedIds();
    if (set.has(String(row.session_id))) return 'archived';
    return this.isSubagentRow(row) ? 'subagent' : null;
  }

  /** 单个会话的活跃判定（判据与 isActiveMany 完全一致）。 */
  async isActive(id) {
    const map = await this.isActiveMany([id]);
    return Boolean(map.get(String(id)));
  }

  /**
   * 批量活跃判定（M4② / §6.1 的活跃门）。
   *
   * 旧实现在 list/status 里逐 id 串行 await 一次 ctx.waterfall（118 行 = 118 次往返）。
   * 这里改成：① 一次性从宿主 sessions 服务读全部（同步 map 读数，零 IO）；
   * ② 只有「还没判为活跃」的 id 才并发走 workspace/session-activity（同一判据，不再串行）；
   * ③ 注入判据（单测接缝 deps.isActive / deps.isActiveMany）优先，语义保持不变。
   *
   * @returns {Promise<Map<string, boolean>>}
   */
  async isActiveMany(ids) {
    const list = [...new Set((ids || []).map((value) => String(value)))];
    const out = new Map();
    if (!list.length) return out;
    if (typeof this.deps.isActiveMany === 'function') {
      try {
        const value = await this.deps.isActiveMany(list);
        if (value instanceof Map) return new Map([...value].map(([id, active]) => [String(id), Boolean(active)]));
        if (Array.isArray(value)) return new Map(list.map((id, index) => [id, Boolean(value[index])]));
      } catch {
        /* 注入判据失败 ⇒ 按「不活跃」处理（与逐条实现一致） */
      }
    }
    if (typeof this.deps.isActive === 'function') {
      await Promise.all(
        list.map(async (id) => {
          try {
            out.set(id, Boolean(await this.deps.isActive(id)));
          } catch {
            out.set(id, false);
          }
        }),
      );
      return out;
    }
    // ① 宿主 sessions 服务：一次拿全部（同步读数）
    const sessions = this.getService('sessions');
    if (sessions && typeof sessions.get === 'function') {
      for (const id of list) {
        try {
          const value = sessions.get(id);
          if (value && (value.running === true || value.busy === true || value.status === 'running' || value.active === true)) {
            out.set(id, true);
          }
        } catch {
          /* 辅助判据，失败不影响 */
        }
      }
    }
    // ② 剩下的 id 并发问宿主活动判据（仍是同一个 waterfall，只是不再串行 118 次）
    const remaining = list.filter((id) => !out.get(id));
    if (remaining.length && this.ctx && typeof this.ctx.waterfall === 'function') {
      await Promise.all(
        remaining.map(async (id) => {
          try {
            const result = await this.ctx.waterfall('workspace/session-activity', { sessionId: id }, () => []);
            out.set(id, Array.isArray(result) ? result.length > 0 : Boolean(result));
          } catch {
            out.set(id, false);
          }
        }),
      );
    }
    for (const id of list) if (!out.has(id)) out.set(id, false);
    return out;
  }

  /**
   * class S 的活跃判定（R-S3 的**有界**实现）。
   *
   * 为什么不能直接用 isActiveMany：它会对「没有判为活跃」的 id **逐条**打宿主
   * `workspace/session-activity` waterfall；真机 1271 个候选 = 1271 次往返，/status 与 /list
   * 每 15s 轮询一次就足以拖垮界面。
   *
   * 口径（设计档 §19.9 R-S3 原文）：子代理会话通常未注册进工作区，activity waterfall 对它们
   * 本来就可能返回 false，所以用「≥N 天 + mtime」**双门**兜底（运行中的子代理必有近期写入）：
   *  ① 注入判据（单测接缝）优先，语义与 isActiveMany 完全一致；
   *  ② 否则只读宿主 `sessions` 服务的**同步读数**（running/busy/active）；
   *  ③ 其余一律按「不活跃」，由年龄门与 mtime 兜底（绝不为了快而放宽年龄门）。
   */
  async subagentActiveMany(ids) {
    if (typeof this.deps.isActiveMany === 'function' || typeof this.deps.isActive === 'function') {
      return this.isActiveMany(ids);
    }
    const out = new Map();
    const list = [...new Set((ids || []).map((value) => String(value)))];
    const sessions = this.getService('sessions');
    for (const id of list) {
      let value = null;
      try {
        value = sessions && typeof sessions.get === 'function' ? sessions.get(id) : undefined;
      } catch {
        value = null;
      }
      if (value && (value.running === true || value.busy === true || value.status === 'running' || value.active === true)) {
        out.set(id, true);
      }
    }
    for (const id of list) if (!out.has(id)) out.set(id, false);
    return out;
  }

  async statSession(id) {
    if (typeof this.deps.statSession === 'function') {
      try {
        return await this.deps.statSession(id);
      } catch {
        return undefined;
      }
    }
    const persistence = this.persistence || this.getService('sessionPersistence');
    if (!persistence || typeof persistence.stat !== 'function') return undefined;
    try {
      return await persistence.stat(id);
    } catch {
      return undefined;
    }
  }

  async sameVolume(a, b) {
    if (typeof this.deps.sameVolume === 'function') return Boolean(await this.deps.sameVolume(a, b));
    return sameVolume(a, b);
  }

  async workspaceFor(cwd) {
    if (typeof this.deps.resolveWorkspace === 'function') {
      try {
        return await this.deps.resolveWorkspace(cwd);
      } catch {
        return undefined;
      }
    }
    const registry = this.registry || this.getService('workspaceRegistry');
    if (!registry || typeof registry.resolveByPath !== 'function') return undefined;
    try {
      return await registry.resolveByPath(cwd);
    } catch {
      return undefined;
    }
  }

  async attachBestEffort(id, entry) {
    try {
      const workspace = await this.workspaceFor(entry.header_cwd);
      if (!workspace) return { attached: false, reason: 'workspace-not-found' };
      const slots = workspace.sessionIds ? Array.from(workspace.sessionIds) : [];
      if (slots.includes(String(id))) return { attached: false, reason: 'already-slotted' };
      if (typeof workspace.attachSession !== 'function') return { attached: false, reason: 'attach-unavailable' };
      await workspace.attachSession(id);
      return { attached: true };
    } catch (err) {
      this.log('warn', 'attachSession 失败（尽力步骤，不阻断）：' + (err && err.message ? err.message : err));
      return { attached: false, reason: err && err.message ? err.message : String(err) };
    }
  }

  // ---- 归档包装的写者（D23） -------------------------------------------
  async noteArchived(id, { entered = true } = {}) {
    const sessionId = String(id);
    const now = this.now();
    let entry = this.store.getSession(sessionId);
    if (!entry) {
      const found = await this.findHotDir(sessionId);
      if (!found) return { ok: false, reason: 'no-disk-dir' };
      const row = await this.buildEntryFromDisk(sessionId, found);
      row.archived_at = now;
      row.status = 'hot';
      entry = this.store.upsertSession(row);
      this.invalidate();
      return { ok: true, created: true };
    }
    const patch = {};
    if (entered && entry.archived_at === null) patch.archived_at = now;
    if (entry.status === 'hot-restored') patch.status = 'hot';
    if (Object.keys(patch).length) this.store.updateSession(sessionId, patch);
    this.invalidate();
    return { ok: true, entered };
  }

  async noteUnarchived(id) {
    const sessionId = String(id);
    const entry = this.store.getSession(sessionId);
    if (!entry) return { ok: false };
    if (entry.status === 'cold') {
      this.store.updateSession(sessionId, { error: ERROR_STATES.EXTERNAL_UNARCHIVED });
      this.invalidate();
      return { ok: false, code: ERROR_STATES.EXTERNAL_UNARCHIVED };
    }
    this.invalidate();
    return { ok: true };
  }

  async archiveSession(id) {
    const sessionId = String(id);
    const original = this.originalOf('archiveSession');
    if (!original) return { id: sessionId, ok: false, error: 'workspaceRegistry.archiveSession 不可用' };
    await original(sessionId);
    await this.noteArchived(sessionId, { entered: true });
    return { id: sessionId, ok: true };
  }

  /**
   * 取消归档（本插件自己的入口：面板 / HTTP /api/unarchive 与包装的透明水合最终都走这里）。
   *
   * **A2（P2.6 评审裁定）：冷态分支不读 `hydrateOnUnarchive`** —— 本插件面板/HTTP 的「取消归档」
   * 对冷会话**恒等于恢复**（数据完整性优先）。理由：冷会话的日志已不在 sessions 里，只摘归档标记
   * 会让它在官方界面彻底隐形（I-11 / A-13），而「隐形」是这个插件最严重的用户可见故障。
   * 因此开关 `hydrateOnUnarchive` 只约束**官方入口**（workspaceRegistry.unarchiveSession 的包装，
   * 见 buildArchiveWrappers）是否先水合；设置页文案已按此口径写明（本批 UI：settings.tsx）。
   */
  async unarchiveSession(id) {
    const sessionId = String(id);
    const entry = this.store.getSession(sessionId);
    if (entry && entry.status === 'cold') {
      const result = await this.restore(sessionId, { reason: 'unarchive-hydrate' });
      if (!result.ok) {
        return { id: sessionId, ok: false, code: 'hydrate-failed', error: '透明水合失败：' + result.error };
      }
      return { id: sessionId, ok: true, hydrated: true };
    }
    const original = this.originalOf('unarchiveSession');
    if (!original) return { id: sessionId, ok: false, error: 'workspaceRegistry.unarchiveSession 不可用' };
    await original(sessionId);
    await this.noteUnarchived(sessionId);
    return { id: sessionId, ok: true };
  }

  originalOf(name) {
    const registry = this.registry || this.getService('workspaceRegistry');
    if (!registry) return null;
    const originals = registry[VAULT_ORIGINAL];
    if (originals && typeof originals[name] === 'function') return originals[name];
    const fn = registry[name];
    return typeof fn === 'function' ? fn.bind(registry) : null;
  }

  // ---- 发现 / 行构造 ----------------------------------------------------
  async findHotDir(id) {
    const root = this.paths.sessionsRoot;
    let projects;
    try {
      projects = await readdir(root, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = path.join(root, project.name, String(id));
      if (!(await isDirectory(dir))) continue;
      const entries = await listDirFiles(dir);
      return { projectKey: project.name, dir, files: entries.filter((entry) => !entry.dir).map((entry) => entry.name) };
    }
    return null;
  }

  generationInfo(files) {
    const generations = files.filter((name) => isGenerationName(name));
    const sorted = sortGenerations(generations);
    const current = sorted.length ? sorted[sorted.length - 1] : null;
    return { generations: sorted, current, version: current ? generationVersion(current) : null };
  }

  /**
   * P2-0（运行时首启 36.8s 的根因修复）：**一次目录扫描**建立「已归档 id → 磁盘事实」映射。
   *
   * 为什么不能再逐 id 调 `persistence.stat`：宿主实现每次 findLog 都要扫一遍全库（实测「每次扫全库」），
   * 118 个归档 id 叠起来就是 36.8s。这里只：
   *   ① readdir(sessionsRoot) 拿 project 目录（一次）；
   *   ② 每个 project readdir 一次，**只保留 archivedSessionIds 里的会话名**（未归档会话一个 stat 都不做）；
   *   ③ 对命中的会话目录 readdir 一次、stat 各代际文件、读 8KB header（cwd/createdAt）。
   * 结果按「归档集合快照 + TTL」缓存；归档/迁移/恢复事件经 invalidate() 整体失效（Y-10）。
   *
   * @returns {Promise<Map<string, {id,dir,projectKey,relDir,generations,current,version,bytes,fileSize,fileMtimeMs,header}>>}
   */
  async scanArchivedDirs(ids = this.archivedIds()) {
    const now = this.now();
    const key = [...ids].sort().join(',');
    const cached = this._scanCache;
    if (cached && now - cached.at < this._scanCacheTtlMs && cached.key === key) return cached.map;
    const startedAt = Date.now();
    const map = new Map();
    this._scanError = null;
    let projects = [];
    try {
      projects = await readdir(this.paths.sessionsRoot, { withFileTypes: true });
    } catch (err) {
      this._scanError = 'sessions 目录扫描失败：' + (err && err.message ? err.message : err);
    }
    // ① 先把「候选会话目录」一次性收齐（每个 project 只 readdir 一次，串行；项目数远小于会话数）
    const jobs = [];
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
        if (!session.isDirectory() || !ids.has(session.name)) continue;
        jobs.push({ projectKey: project.name, id: session.name, dir: path.join(projectDir, session.name) });
      }
    }
    // ② F4：会话级事实（readdir + 多代际 stat + 8KB header）按限流并发读 ——
    //    真机上 118 行串行做 300+ 次 Windows 系统调用实测 3.2s，是 /list 冷启动的**主成本**。
    const entries = await mapLimit(jobs, this.scanConcurrency, (job) => this.scanSessionDir(job));
    for (const entry of entries) {
      if (entry) map.set(entry.id, entry);
    }
    this._perf.scans += 1;
    this._perf.lastScanMs = Date.now() - startedAt;
    this._scanCache = { at: now, key, map };
    return map;
  }

  /**
   * 单个会话目录的扫描事实（F4 的并发单元）。
   * 多代际 stat 也并发（一个会话最多 2 代，串行 await 会白白多一个往返）；
   * 返回 null = 该目录不是本插件能处理的形态（没有合法代际 / 读不到）。
   */
  async scanSessionDir(job) {
    const { projectKey: projectKeyName, id, dir } = job;
    let files = [];
    try {
      files = (await listDirFiles(dir)).filter((entry) => !entry.dir).map((entry) => entry.name);
    } catch {
      return null;
    }
    const info = this.generationInfo(files);
    if (!info.current) return null; // 没有合法代际的目录不建行（不是本插件能处理的会话形态）
    const stats = await Promise.all(
      info.generations.map(async (name) => {
        try {
          return { name, info: await stat(path.join(dir, name)) };
        } catch {
          return null; // 单个代际 stat 失败不阻塞整次扫描
        }
      }),
    );
    let bytes = 0;
    let fileSize = 0;
    let fileMtimeMs = 0;
    for (const item of stats) {
      if (!item) continue;
      bytes += item.info.size;
      if (item.name === info.current) {
        fileSize = item.info.size;
        fileMtimeMs = Math.trunc(item.info.mtimeMs);
      }
    }
    const header = await this.readHeader(path.join(dir, info.current));
    return {
      id,
      dir,
      projectKey: projectKeyName,
      relDir: projectKeyName + '/' + id,
      generations: info.generations,
      current: info.current,
      version: info.version,
      bytes,
      fileSize,
      fileMtimeMs,
      header,
    };
  }

  /** header 读取（F4 接缝：单测可注入计数/延迟实现，验证并发度；默认走真实增量读）。 */
  async readHeader(file) {
    if (typeof this.deps.readSessionHeader === 'function') {
      return this.deps.readSessionHeader(file);
    }
    return readSessionHeader(file);
  }


  // ---- P4：header 事实扫描（FR-P4-2 / §19.6）-------------------------------
  /**
   * 读 class S 的 meta 快照（subscan:at / count / gaps / orphanEdges）。
   *
   * 前置：store 可读（读失败一律按「没有快照」处理 —— 没有快照就**不搬**，fail-closed）。
   * 后置：`fresh` 与 `refsIncomplete` 两个判定位恒存在（UI/sweeper/candidates 共用同一份口径）。
   */
  subscanSnapshot(options = {}) {
    const now = Number.isFinite(options.now) ? options.now : this.now();
    let at = null;
    try {
      const raw = this.store.getMeta(SUBSCAN_META.at);
      const num = Number(raw);
      if (raw !== null && raw !== undefined && raw !== '' && Number.isFinite(num) && num > 0) at = num;
    } catch {
      at = null;
    }
    let count = 0;
    try {
      count = Math.max(0, Math.trunc(Number(this.store.getMeta(SUBSCAN_META.count, '0')) || 0));
    } catch {
      count = 0;
    }
    const gaps = readJsonArrayMeta(this.store, SUBSCAN_META.gaps)
      .filter((item) => item && typeof item === 'object' && item.id !== undefined && item.id !== null)
      .map((item) => ({ id: String(item.id), reason: item.reason ? String(item.reason) : 'unknown' }));
    const orphanEdges = readJsonArrayMeta(this.store, SUBSCAN_META.orphanEdges)
      .filter((item) => item && typeof item === 'object' && item.to !== undefined && item.to !== null)
      .map((item) => ({
        from: item.from === null || item.from === undefined ? '' : String(item.from),
        field: item.field === null || item.field === undefined ? '' : String(item.field),
        to: String(item.to),
      }));
    const ageMs = at === null ? null : Math.max(0, now - at);
    const fresh = at !== null && ageMs <= REF_SCAN_TTL_MS;
    return {
      at,
      count,
      gaps,
      orphanEdges,
      ageMs,
      ttlMs: REF_SCAN_TTL_MS,
      // 快照新鲜 = 有 at 且未过期（§19.5 FR-P4-3 第 7 条）
      fresh,
      // 「谁引用谁」不可信 = 快照缺失/过期，**或**任何缺口 —— 此时 class S 一个都不搬（I-18）
      refsIncomplete: !fresh || gaps.length > 0,
    };
  }


  // ---- P4：资格 / 候选 / 批量作业（FR-P4-3 / FR-P4-7）---------------------
  /**
   * 「置顶 / 收藏」集合：宿主若提供 \`pinnedSessionIds\` 就尊重它（当前 DSH 没有这个概念）；
   * 本插件自己的「置顶」是 P3 收藏（favorite=1）—— 两者都算「用户要留着」，一律不搬。
   */
  pinnedIdSet() {
    const out = new Set();
    const raw = this.registry && this.registry.pinnedSessionIds;
    if (raw) {
      const values = Array.isArray(raw) ? raw : typeof raw[Symbol.iterator] === 'function' ? [...raw] : [];
      for (const value of values) out.add(String(value));
    }
    try {
      for (const row of this.store.listSessions({ favorite: true })) out.add(String(row.session_id));
    } catch {
      /* 收藏面读不到 ⇒ 只用 registry 的（少一道保护由别处 fail-closed 兜底，不静默放过别的条件） */
    }
    return out;
  }

  /**
   * 已登记（\`workspace.sessionIds\`）的 id 集合（§19.5 FR-P4-3 第 3 条）。
   *
   * 前置：cwds = 候选行的 header_cwd 集合。
   * 后置：能解析到工作区的 id 全部进集合；解析不到的工作区**不加保护**（但那种行通常也不在
   * archive/subagent 三个来源里，且 isActive/年龄双门仍在）。
   */
  async registeredIdSet(cwds) {
    const out = new Set();
    const list = [...new Set((cwds || []).map((cwd) => (cwd ? String(cwd) : '')).filter(Boolean))];
    await mapLimit(list, 4, async (cwd) => {
      const workspace = await this.workspaceFor(cwd).catch(() => undefined);
      const slots = workspace && workspace.sessionIds ? Array.from(workspace.sessionIds) : [];
      for (const slot of slots) out.add(String(slot));
    });
    return out;
  }

  /**
   * 入边目标集合（§19.5 FR-P4-3 第 4 条）：**两个来源都查** ——
   * ① DB 的 \`sessions.parent_session\`（有行的引用）；
   * ② 快照里无 DB 行目录的 \`orphanEdges\`（本机实测 15 个反例就藏在这一类里）。
   */
  inboundRefTargets(snapshot = null) {
    const out = new Set();
    try {
      const rows = this.store.prepare('SELECT DISTINCT parent_session AS p FROM sessions WHERE parent_session IS NOT NULL').all();
      for (const row of rows) if (row && row.p) out.add(String(row.p));
    } catch {
      /* 读不到 DB 边 ⇒ 靠快照；两者都读不到时 snapshot.refsIncomplete 会让候选恒为空（fail-closed） */
    }
    for (const target of this.subscanOrphanTargets(snapshot)) out.add(String(target));
    return out;
  }

  /**
   * class S 的**类特有**资格（FR-P4-3 的第 2/3/4/5/7 条；第 1/6 条由 preflight / 候选过滤统一判）。
   *
   * 前置：row 可为 null；context 可预置 cfg / now / snapshot / archived / pinned / registered /
   *       inbound / lastActiveAt（批量路径一次算好，避免逐行读盘读库）。
   * 后置：返回 problems 数组（空 = 通过）。**纯判定，不写任何东西**；
   *       candidates / preflight / 迁移后复检共用这一份，杜绝三处口径漂移。
   */
  async subagentQualification(row, context = {}) {
    const ctx = context || {};
    const cfg = ctx.cfg || (await this.config());
    const now = Number.isFinite(ctx.now) ? ctx.now : this.now();
    const snapshot = ctx.snapshot || this.subscanSnapshot({ now });
    const archived = ctx.archived instanceof Set ? ctx.archived : this.archivedIds();
    const problems = [];
    const add = (code, message) => problems.push({ code, message });
    if (cfg.subagentAgeDays === 0) {
      add('threshold-off', 'subagentAgeDays=0：关闭子代理会话冷存（自动与手动候选都为空）');
      return problems;
    }
    // 第 7 条：引用快照新鲜（≤24h 且 gaps=0）—— 不可信就一个都不搬（I-18）
    if (!snapshot.fresh) {
      add(
        'refs-incomplete',
        '引用快照缺失或超过 24h（subscan:at=' +
          (snapshot.at === null ? '无' : new Date(snapshot.at).toISOString()) + '）：class S 暂停（I-18）',
      );
    }
    if (snapshot.gaps.length) {
      add(
        'refs-incomplete',
        '引用快照有 ' + snapshot.gaps.length + ' 个缺口（' +
          snapshot.gaps.slice(0, 3).map((gap) => gap.id + ':' + gap.reason).join(', ') + '）：class S 暂停（I-18）',
      );
    }
    if (!row) {
      add('unknown-session', 'DB 无该会话行（不凭目录建行）');
      return problems;
    }
    const id = String(row.session_id);
    // FR-P4-3 第 1 条：hot ∧ !hidden ∧ error IS NULL（三个状态条件放在这里，
    // 让候选过滤、preflight、迁移后复检共用同一份口径，显式 /migrate 也绕不过去）。
    // 迁移**在飞**的复检要放行 migrating/restoring：marker 先于搬移落盘，行在复检时本来就是
    // status=migrating（否则「迁移后复检」对 class S 恒失败 —— 每次都会把搬好的目录又搬回来）。
    const inFlightAllowed = ctx.allowInFlightStatus === true && (row.status === 'migrating' || row.status === 'restoring');
    if (row.status !== 'hot' && !inFlightAllowed) {
      add('not-candidate', 'status=' + row.status + '（只有 hot 行可迁移）');
    }
    if (row.hidden) add('hidden', '会话已被用户删除（hidden=1，文件未搬移），不参与迁移（I-13）');
    if (row.error) add('session-error', 'error=' + row.error + '（显式标记态未收敛，先处置再迁移）');
    if (!this.isSubagentRow(row)) {
      add(
        'not-subagent',
        'origin=' + String(row.origin || 'null') + ' / delegation_depth=' + (Number(row.delegation_depth) || 0) +
          '：不是子代理会话（FR-P4-3 第 2 条）',
      );
    }
    if (archived.has(id)) add('archived', '在 archivedSessionIds 里（属 class A 的域，I-2）');
    const pinned = ctx.pinned instanceof Set ? ctx.pinned : this.pinnedIdSet();
    if (pinned.has(id)) add('pinned', '在 pinnedSessionIds / 收藏（置顶）里');
    let registered = ctx.registered;
    if (!(registered instanceof Set)) registered = await this.registeredIdSet([row.header_cwd]);
    if (registered.has(id)) add('registered', '已登记进工作区（workspace.sessionIds）：不搬');
    const inbound = ctx.inbound instanceof Set ? ctx.inbound : this.inboundRefTargets(snapshot);
    if (inbound.has(id)) {
      add('referenced', '有会话的 parent_session 指向它（或无行目录引用它）：永不迁移（I-15 / A-P4-2）');
    }
    // 第 5 条：年龄门 + **恢复冷却期**（restored_at + N 天，评审 #5 裁定 A）
    const threshold = cfg.subagentAgeDays * 86400 * 1000;
    const stamp = Number.isFinite(ctx.lastActiveAt) ? ctx.lastActiveAt : await this.lastActiveAt(row);
    if (threshold > 0 && stamp + threshold > now) {
      add('too-recent', '上次活跃 ' + new Date(stamp).toISOString() + ' 未超过 ' + cfg.subagentAgeDays + ' 天');
    }
    if (row.restored_at && threshold > 0 && row.restored_at + threshold > now) {
      add('restored-recent', '恢复冷却期未到：restored_at + ' + cfg.subagentAgeDays + ' 天（评审 #5 裁定 A）');
    }
    return problems;
  }

  /**
   * class S 候选（FR-P4-3：七条全满足）。
   *
   * 前置：\`subagentAgeDays > 0\` 且快照新鲜、gaps 为空；否则返回 []（原因由 /status.subagent 说明）。
   * 后置：按 lastActiveAt 升序；\`limit\` 只影响返回页；**不搬移、不写库**。
   */
  async subagentCandidates(options = {}) {
    const cfg = await this.config();
    const now = Number.isFinite(options.now) ? options.now : this.now();
    const snapshot = options.snapshot || this.subscanSnapshot({ now });
    const useCache = options.useCache !== false;
    const cacheKey = [cfg.subagentAgeDays, snapshot.at, snapshot.gaps.length, snapshot.orphanEdges.length].join('|');
    if (useCache && this._subagentCandidateCache) {
      const cached = this._subagentCandidateCache;
      if (cached.key === cacheKey && now - cached.at < this._candidateCacheTtlMs) return cached.rows;
    }
    if (cfg.subagentAgeDays === 0 || snapshot.refsIncomplete) {
      this._subagentCandidateCache = { key: cacheKey, at: now, rows: [] };
      return [];
    }
    const archived = this.archivedIds();
    const pinned = this.pinnedIdSet();
    const inbound = this.inboundRefTargets(snapshot);
    const rows = this.store
      .listSessions({ status: ['hot'] })
      .filter((row) => this.isSubagentRow(row) && !row.hidden && !row.error);
    const registered = await this.registeredIdSet(rows.map((row) => row.header_cwd));
    const eligible = rows.filter((row) => {
      const id = String(row.session_id);
      if (archived.has(id) || pinned.has(id) || registered.has(id) || inbound.has(id)) return false;
      if (row.next_attempt && row.next_attempt > now) return false;
      return true;
    });
    // R-S3：class S 用**有界**活跃判定（注入判据优先；否则只读宿主同步读数，靠年龄+mtime 双门兜底）
    const active = await this.subagentActiveMany(eligible.map((row) => row.session_id));
    const lastActive = await this.lastActiveMap(eligible);
    const threshold = cfg.subagentAgeDays * 86400 * 1000;
    const out = [];
    for (const row of eligible) {
      const id = String(row.session_id);
      if (active.get(id)) continue;
      const stamp = lastActive.get(id) || 0;
      if (threshold > 0 && stamp + threshold > now) continue;
      if (row.restored_at && threshold > 0 && row.restored_at + threshold > now) continue;
      out.push({ ...row, lastActiveAt: stamp });
    }
    out.sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0));
    this._subagentCandidateCache = { key: cacheKey, at: now, rows: out };
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.trunc(options.limit)) : 0;
    return limit > 0 ? out.slice(0, limit) : out;
  }

  /**
   * 迁移**前/后**复检：这一行现在还配搬吗？（§19.5 FR-P4-4「迁移后复检」/ I-6 的 class S 版）
   *
   * 判据 = 七条重新算一遍（注册表 / 引用 / 活跃 / 年龄都可能在这几秒里变）。
   * @returns {Promise<{ok:boolean, code?:string, problems?:Array}>}
   */
  async subagentStillEligible(sessionId, cfg = null) {
    const id = String(sessionId);
    const archived = this.archivedIds();
    if (archived.has(id)) return { ok: false, code: 'race-archived' };
    const config = cfg || (await this.config());
    const row = this.store.getSession(id);
    if (!row) return { ok: false, code: 'race-unknown-session' };
    const problems = await this.subagentQualification(row, { cfg: config, archived, allowInFlightStatus: true });
    if (problems.length) return { ok: false, code: 'race-' + problems[0].code, problems };
    if (await this.isActive(id)) return { ok: false, code: 'race-active' };
    return { ok: true };
  }

  /**
   * 迁移的两个「放弃点」共用的判据（删源前 / 搬完后）。
   * @returns {Promise<string|null>} null = 仍应继续；否则是写进 error 的 race-* 错误码。
   */
  async migrationRaceReason(sessionId, cls, cfg = null) {
    if (cls === 'subagent') {
      const check = await this.subagentStillEligible(sessionId, cfg);
      return check.ok ? null : check.code || 'race-subagent-ineligible';
    }
    if (!this.isArchived(sessionId)) return ERROR_STATES.RACE_UNARCHIVED;
    if (await this.isActive(sessionId)) return ERROR_STATES.RACE_UNARCHIVED;
    return null;
  }

  /** 手动批量作业的可读载荷（内存 job 与 meta 快照共用同一形状）。 */
  subagentJobPayload(job) {
    if (!job) return null;
    return {
      id: job.id,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || null,
      total: job.total,
      done: job.done,
      migrated: job.migrated,
      failed: job.failed,
      cancelled: Boolean(job.cancelled),
      running: Boolean(job.running),
      progress: job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 100,
      resultsTotal: job.results.length,
      results: job.results.slice(-20),
      rejectedTotal: job.rejected.length,
      rejected: job.rejected.slice(0, 20),
      runningIds: job.ids.slice(0, 20),
      interrupted: false,
    };
  }

  /** 只读作业读数：内存优先；没有内存 job 时读 meta（跨重启 ⇒ interrupted=true，不假装还在跑）。 */
  subagentJobSnapshot() {
    if (this._subagentJob) return this.subagentJobPayload(this._subagentJob);
    let persisted = null;
    try {
      const raw = this.store.getMeta(SUBSCAN_META.job);
      if (raw) persisted = JSON.parse(raw);
    } catch {
      persisted = null;
    }
    if (!persisted || typeof persisted !== 'object') return null;
    return {
      ...persisted,
      running: false,
      interrupted: persisted.running === true || persisted.interrupted === true,
      persisted: true,
    };
  }

  /** 作业进度落 meta（**不落**内存字段，形状与 subagentJobSnapshot 一致）。 */
  persistSubagentJob(job) {
    try {
      this.store.setMeta(SUBSCAN_META.job, JSON.stringify(this.subagentJobPayload(job)));
    } catch (err) {
      this.log('warn', '批量作业进度落库失败（不影响迁移本身）：' + (err && err.message ? err.message : err));
    }
  }

  /**
   * 手动批量迁移（FR-P4-7 / §19.11 用户裁定：一次上限 SUBAGENT_BATCH_CAP=2000，可取消、有进度）。
   *
   * 前置：HTTP 层已强制 \`confirm:true\`；本方法只认 \`{all:true}\` 或 \`{ids:[...]}\`。
   * 步：候选/显式 ids 都过一遍七条资格（显式 ids 不能绕过资格）→ 后台逐条 \`migrate(id,{class:'subagent'})\`。
   * 后置：返回 {ok, job, wait}；每条结果即时落 meta \`subscan:job\`（跨重启可读「上次批量中断」）；
   *       取消只置位（在飞的那一条会跑完，**不会**半途删源）。
   */
  async startSubagentJob(options = {}) {
    /**
     * **只把「算目标 + 落作业」放进队列**；后台循环在队列外跑。
     *
     * 为什么不能整体塞进 enqueue：队列任务体内创建的 async 循环会继承 ALS 的队列标记，
     * 之后每次 `migrate` 都会「就地执行」而不是正常排队 ⇒ 批量作业跑到一半时另一条
     * /restore / /migrate 可以与它并发写（违反「所有写操作单串行」）。在队列外起跑则每条
     * 迁移都是一次正常 enqueue，真正串行。
     */
    const prepared = await this.enqueue(async () => {
      if (this._subagentJob && this._subagentJob.running) {
        return { ok: false, code: 'job-running', error: '已有一个批量迁移作业在跑（先等它结束或取消）', job: this.subagentJobSnapshot() };
      }
      const cfg = await this.config();
      const now = this.now();
      const snapshot = this.subscanSnapshot({ now });
      const archived = this.archivedIds();
      const pinned = this.pinnedIdSet();
      const inbound = this.inboundRefTargets(snapshot);
      const rejected = [];
      let targets = [];
      if (options.all === true) {
        if (cfg.subagentAgeDays === 0) {
          return { ok: false, code: 'threshold-off', error: 'subagentAgeDays=0：没有可迁移的子代理会话' };
        }
        const candidates = await this.subagentCandidates({ now, snapshot, useCache: false });
        targets = candidates.map((row) => String(row.session_id)).slice(0, SUBAGENT_BATCH_CAP);
        if (candidates.length > SUBAGENT_BATCH_CAP) {
          for (const row of candidates.slice(SUBAGENT_BATCH_CAP)) {
            rejected.push({ id: String(row.session_id), code: 'batch-cap', error: '超过单次上限 ' + SUBAGENT_BATCH_CAP + '，留待下一次' });
          }
        }
      } else {
        const wanted = Array.isArray(options.ids) ? [...new Set(options.ids.map(String).filter(Boolean))] : [];
        if (!wanted.length) return { ok: false, code: 'invalid-request', error: '需要 ids（字符串数组）或 all:true' };
        const rows = this.store.getSessionsByIds(wanted);
        const registered = await this.registeredIdSet(wanted.map((id) => (rows.get(id) ? rows.get(id).header_cwd : null)));
        for (const id of wanted) {
          const row = rows.get(id) || null;
          const problems = await this.subagentQualification(row, {
            cfg, now, snapshot, archived, pinned, inbound, registered,
          });
          if (!problems.length) targets.push(id);
          else rejected.push({ id, code: problems[0].code, error: problems[0].message });
        }
        targets = targets.slice(0, SUBAGENT_BATCH_CAP);
      }
      const job = {
        id: 'subjob-' + now.toString(36),
        startedAt: now,
        finishedAt: null,
        total: targets.length,
        done: 0,
        migrated: 0,
        failed: 0,
        cancelled: false,
        running: targets.length > 0,
        ids: targets,
        results: [],
        rejected,
      };
      this._subagentJob = job;
      this.persistSubagentJob(job);
      return { ok: true, job, targets, rejected };
    });
    if (!prepared || prepared.ok !== true) {
      // 失败分支（job-running / threshold-off / invalid-request）：原样回给调用方，不启动任何循环。
      return prepared;
    }
    const job = prepared.job;
    if (!job.total) {
      job.running = false;
      job.finishedAt = this.now();
      this.persistSubagentJob(job);
      return {
        ok: true,
        job: this.subagentJobPayload(job),
        rejected: job.rejected,
        wait: () => Promise.resolve(this.subagentJobPayload(job)),
      };
    }
    const run = (async () => {
      for (const id of job.ids) {
        if (job.cancelled) break;
        let outcome;
        try {
          outcome = await this.migrate(id, { class: 'subagent', reason: 'manual-batch' });
        } catch (err) {
          outcome = { id, ok: false, error: err && err.message ? err.message : String(err) };
        }
        job.done += 1;
        if (outcome && outcome.ok) job.migrated += 1;
        else job.failed += 1;
        job.results.push({
          id,
          ok: Boolean(outcome && outcome.ok),
          code: (outcome && outcome.code) || null,
          error: (outcome && outcome.error) || null,
        });
        this.persistSubagentJob(job);
      }
      job.running = false;
      job.finishedAt = this.now();
      this.persistSubagentJob(job);
      try {
        this.invalidate();
      } catch {
        /* 缓存失效失败不影响结果 */
      }
      this.log(
        'info',
        '手动批量迁移结束：成功 ' + job.migrated + ' / 失败 ' + job.failed + ' / 共 ' + job.total +
          (job.cancelled ? '（已取消，剩余 ' + (job.total - job.done) + ' 个未搬）' : ''),
      );
      return this.subagentJobPayload(job);
    })();
    job.promise = run;
    return { ok: true, job: this.subagentJobPayload(job), rejected: job.rejected, wait: () => run };
  }

  /** 取消手动批量作业（幂等：没有在跑的就如实回 no-job）。 */
  cancelSubagentJob() {
    const job = this._subagentJob;
    if (!job || !job.running) {
      return { ok: false, code: 'no-job', error: '没有正在运行的批量迁移作业', job: this.subagentJobSnapshot() };
    }
    job.cancelled = true;
    this.persistSubagentJob(job);
    this.log('info', '手动批量迁移已请求取消：在飞的一条会跑完（绝不半途删源），其余不再搬');
    return { ok: true, job: this.subagentJobPayload(job) };
  }

  /**
   * /status.subagent 与 /list 的 class S 读数（§19.5 FR-P4-6：{candidates,candidatesBytes,cold,coldBytes,scanAt,scanGaps,paused,job}）。
   * 前置：只读；\`withCandidates:false\` 时跳过候选计算（调用方只想要冷存读数时省掉一次全表过滤）。
   */
  async subagentStatus(options = {}) {
    const cfg = await this.config();
    const now = Number.isFinite(options.now) ? options.now : this.now();
    const snapshot = this.subscanSnapshot({ now });
    const archived = this.archivedIds();
    const coldRows = this.store
      .listSessions({ status: ['cold'] })
      .filter((row) => this.rowClass(row, archived) === 'subagent');
    const candidates = options.withCandidates === false ? null : await this.subagentCandidates({ now, useCache: options.useCache });
    const sweep = this.sweeper && typeof this.sweeper.subagentSnapshot === 'function' ? this.sweeper.subagentSnapshot() : null;
    const fallbackPause = snapshot.refsIncomplete
      ? {
          code: 'subagent-refs-incomplete',
          message: '引用快照不可信（缺失 / 超过 24h / gaps 非空）：class S 暂停（I-18）',
          gaps: snapshot.gaps,
        }
      : null;
    return {
      enabled: cfg.subagentAgeDays > 0,
      migrate: Boolean(cfg.subagentMigrate),
      migrateEffective: cfg.subagentAgeDays > 0 && Boolean(cfg.subagentMigrate),
      ageDays: cfg.subagentAgeDays,
      dailyBudgetCount: cfg.subagentDailyBudgetCount,
      batchCap: SUBAGENT_BATCH_CAP,
      candidates: candidates ? candidates.length : 0,
      candidatesBytes: candidates ? candidates.reduce((sum, row) => sum + (row.bytes || 0), 0) : 0,
      cold: coldRows.length,
      coldBytes: coldRows.reduce((sum, row) => sum + (row.bytes || 0), 0),
      scanAt: snapshot.at,
      scanCount: snapshot.count,
      scanAgeMs: snapshot.ageMs,
      scanFresh: snapshot.fresh,
      scanGaps: snapshot.gaps,
      scanOrphanEdges: snapshot.orphanEdges.length,
      paused: sweep ? Boolean(sweep.paused) : Boolean(fallbackPause),
      pauseReason: sweep ? sweep.pauseReason || null : fallbackPause,
      budget: sweep ? sweep.budget || null : null,
      nextRunAt: sweep ? sweep.nextRunAt || null : null,
      lastRunAt: sweep ? sweep.lastRunAt || null : null,
      lastReport: sweep ? sweep.lastReport || null : null,
      job: this.subagentJobSnapshot(),
    };
  }

  /** 无 DB 行目录的入边目标集合（subscan:orphanEdges 的读面）。 */
  subscanOrphanTargets(snapshot = null) {
    const value = snapshot || this.subscanSnapshot();
    return new Set((value.orphanEdges || []).map((edge) => String(edge.to)));
  }

  /**
   * header 事实扫描（FR-P4-2 / §19.6 伪代码）。
   *
   * 前置：store 可用；整体在**单串行 enqueue** 内（写 DB 的唯一合法路径；重入时就地执行）。
   * 步：
   *  ① 遍历 `sessions/<projectKey>/<id>/`（只 readdir，不 stat 全部代际）；
   *  ② 每个目录只读**首帧 header**（readSessionHeader —— 现成的读法，不解压整份日志）；
   *  ③ 有 DB 行 ⇒ 落三列 `origin / delegation_depth / parent_session`（判据只有 parentSession）；
   *     无 DB 行 ⇒ **不建行**（不凭空造会话），只把它的 id 型引用收集成 orphanEdges（上限 500）。
   * 后置：
   *  - meta `subscan:at / count / gaps / orphanEdges` 落库（gaps/orphanEdges 恒写，空数组也写 ⇒
   *    「重新扫描」修好坏目录后缺口自动解除，不做静默豁免）；
   *  - **不搬移、不删除任何文件**；gaps 非空或快照过期 ⇒ class S 暂停（fail-closed，I-18）。
   *
   * @param {{force?:boolean, maxAgeMs?:number}} [options]
   * @returns {Promise<{ok:boolean, at:number|null, scanned:number, count:number, gaps:Array, orphanEdges:Array, skipped?:string, code?:string}>}
   */
  async scanHeaderFacts(options = {}) {
    const maxAgeMs = Number.isFinite(options.maxAgeMs) ? Math.max(0, Math.trunc(options.maxAgeMs)) : REF_SCAN_TTL_MS;
    const force = options.force === true;
    return this.enqueue(async () => {
      const now = this.now();
      const before = this.subscanSnapshot({ now });
      if (!force && before.at !== null && now - before.at <= maxAgeMs) {
        this.log('info', 'header 事实扫描跳过（快照仍新鲜：' + new Date(before.at).toISOString() + '）');
        return { ok: true, skipped: 'fresh', ...before, scanned: before.count };
      }
      const startedAt = Date.now();
      let projects = [];
      try {
        projects = await readdir(this.paths.sessionsRoot, { withFileTypes: true });
      } catch (err) {
        // 读不到会话根 = 覆盖面未知 ⇒ 不写 at（保持「不可信」），把原因如实带回去。
        const message = err && err.message ? err.message : String(err);
        this.log('warn', 'header 事实扫描失败（sessions 目录不可读）：' + message);
        return {
          ok: false,
          code: 'sessions-unreadable',
          error: message,
          at: before.at,
          scanned: 0,
          count: before.count,
          gaps: before.gaps,
          orphanEdges: before.orphanEdges,
        };
      }
      const jobs = [];
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        const projectDir = path.join(this.paths.sessionsRoot, project.name);
        let sessions = [];
        try {
          sessions = await readdir(projectDir, { withFileTypes: true });
        } catch {
          // 工作区目录不可读 = 里面有多少会话未知 ⇒ 记缺口（fail-closed：class S 暂停），
          // 绝不「跳过就当没有」。id 用 `<projectKey>/` 标出这是目录级缺口。
          gaps.push({ id: project.name + '/', reason: 'project-unreadable' });
          continue;
        }
        for (const session of sessions) {
          if (!session.isDirectory()) continue;
          jobs.push({ id: session.name, projectKey: project.name, dir: path.join(projectDir, session.name) });
        }
      }
      // 并发只读（限流 8，与归档扫描同款）：2414 个目录实测远低于 30s 预算。
      const facts = await mapLimit(jobs, this.scanConcurrency, async (job) => {
        let files = [];
        try {
          files = (await listDirFiles(job.dir)).filter((entry) => !entry.dir).map((entry) => entry.name);
        } catch {
          return { id: job.id, gap: { id: job.id, reason: 'dir-unreadable' } };
        }
        try {
          const info = this.generationInfo(files);
          if (!info.current) return { id: job.id, gap: { id: job.id, reason: 'no-generation' } };
          const header = await this.readHeader(path.join(job.dir, info.current));
          if (!header) return { id: job.id, gap: { id: job.id, reason: 'header-unreadable' } };
          return { id: job.id, header, facts: headerFactsOf(header) };
        } catch (err) {
          // 任何读失败都算缺口（mapLimit 会吞掉抛错；这里必须自己落 gap，绝不静默少一个目录）
          return { id: job.id, gap: { id: job.id, reason: 'header-read-failed' } };
        }
      });
      let scanned = 0;
      const gaps = [];
      const orphanEdges = [];
      const overflowIds = new Set();
      for (const item of facts) {
        if (!item) continue;
        if (item.gap) {
          gaps.push(item.gap);
          continue;
        }
        scanned += 1;
        const row = this.store.getSession(item.id);
        if (row) {
          // 有行：只落三列（判据是 parent_session；其它 id 型字段不入库、不参与判定）
          const patch = {};
          const facts2 = item.facts || { origin: null, delegationDepth: 0, parentSession: null };
          if (String(row.origin || '') !== String(facts2.origin || '')) patch.origin = facts2.origin;
          if ((Number(row.delegation_depth) || 0) !== facts2.delegationDepth) patch.delegation_depth = facts2.delegationDepth;
          if (String(row.parent_session || '') !== String(facts2.parentSession || '')) patch.parent_session = facts2.parentSession;
          if (Object.keys(patch).length) {
            try {
              this.store.updateSession(item.id, patch);
            } catch (err) {
              // 单行写失败不中断整次扫描：它只是「事实没更新」，不影响其它行（下一轮再写）。
              this.log('warn', 'header 事实写回失败（' + item.id + '）：' + (err && err.message ? err.message : err));
            }
          }
        } else {
          // 无行：只收集边（绝不建行 —— 无 DB 行的目录不是本插件能处理的会话形态）
          for (const edge of headerIdEdges(item.header, item.id)) {
            if (orphanEdges.length < SUBAGENT_ORPHAN_EDGE_LIMIT) {
              orphanEdges.push({ from: item.id, field: edge.field, to: edge.to });
            } else if (!overflowIds.has(item.id)) {
              overflowIds.add(item.id);
              gaps.push({ id: item.id, reason: 'orphan-edge-overflow' });
            }
          }
        }
      }
      const at = this.now();
      try {
        this.store.setMeta(SUBSCAN_META.at, String(at));
        this.store.setMeta(SUBSCAN_META.count, String(scanned));
        this.store.setMeta(SUBSCAN_META.gaps, JSON.stringify(gaps));
        this.store.setMeta(SUBSCAN_META.orphanEdges, JSON.stringify(orphanEdges));
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        this.log('warn', 'header 事实快照落库失败（class S 保持暂停）：' + message);
        return { ok: false, code: 'snapshot-write-failed', error: message, at: before.at, scanned, count: scanned, gaps, orphanEdges };
      }
      const tookMs = Date.now() - startedAt;
      // 新事实落地 ⇒ 候选/列表缓存必须失效（否则要等 TTL 才看到新的候选集）
      this.invalidate();
      this.log(
        'info',
        'header 事实扫描完成：' + scanned + ' 个目录 / 缺口 ' + gaps.length + ' / 无行入边 ' + orphanEdges.length + '（' + tookMs + 'ms）',
      );
      return { ok: true, at, scanned, count: scanned, gaps, orphanEdges, tookMs };
    });
  }

  /**
   * 标题提示（best-effort，**不是**事实源）：宿主投影缓存的 per-record 文件
   * `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` 顶部就带 `rows.title.val`
   * （research/cold-storage.md §b 记为可用 hint）。
   *
   * 只读**前 4KB** 并用正则取一个字段：整份 JSON 单个可达 1.7 MB，118 个全解析实测 1.7s，
   * 会直接吃掉冷启动预算。读不到（没有该缓存 / 宿主换了格式）就返回空 Map ——
   * 标题最终由 P2 全量索引回填真实值，绝不因为 hint 缺失而失败或阻塞。
   */
  async titleHints(ids = []) {
    const out = new Map();
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
    if (!list.length) return out;
    const now = this.now();
    // F4「projcache 命中优先」：先查进程内缓存（命中即返回，连一次 open 都不发）；
    // 未命中才读文件，且读取限流（默认 8 并发）。旧实现每次 backfill/list 都串行开 118 个文件。
    const misses = [];
    for (const id of list) {
      const hit = this._titleHintCache.get(id);
      if (hit && now - hit.at < this._titleHintTtlMs) {
        if (hit.title) out.set(id, hit.title);
        continue;
      }
      misses.push(id);
    }
    if (!misses.length) return out;
    const dir = path.join(this.paths.storagesRoot, 'session_projcache', 'sessions');
    const results = await mapLimit(misses, this.scanConcurrency, async (id) => ({
      id,
      title: await this.readTitleHint(dir, id),
    }));
    for (const item of results) {
      if (!item) continue;
      // 读不到也缓存（title=null），避免每个轮询都重开一次不存在的文件；TTL 到期再试。
      this._titleHintCache.set(item.id, { at: now, title: item.title || null });
      if (item.title) out.set(item.id, item.title);
    }
    return out;
  }

  /** 单个 projcache 标题 hint（4KB 前缀 + 正则；失败即 null，绝不影响列表）。 */
  async readTitleHint(dir, id) {
    let handle = null;
    try {
      handle = await fsOpen(path.join(dir, String(id) + '.json'), 'r');
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (!bytesRead) return null;
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const hit = /"rows"\s*:\s*\{\s*"title"\s*:\s*\{[^{}]*?"val"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
      if (!hit) return null;
      const decoded = JSON.parse('"' + hit[1] + '"');
      return typeof decoded === 'string' && decoded.trim() ? decoded.trim() : null;
    } catch {
      /* hint 缺失/坏文件都只是「没有标题提示」 */
      return null;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async buildEntryFromDisk(id, found) {
    const info = this.generationInfo(found.files);
    const tree = await statTree(found.dir);
    let header = null;
    if (info.current) header = await readSessionHeader(path.join(found.dir, info.current));
    let fileSize = 0;
    let fileMtime = tree.maxMtimeMs;
    if (info.current) {
      try {
        const info2 = await stat(path.join(found.dir, info.current));
        fileSize = info2.size;
        fileMtime = Math.trunc(info2.mtimeMs);
      } catch {
        /* ignore */
      }
    }
    return {
      session_id: String(id),
      project_key: found.projectKey,
      rel_dir: found.projectKey + '/' + String(id),
      log_names: info.generations.join(','),
      cold_root: null,
      format_version: info.version === null ? 0 : info.version,
      bytes: tree.bytes,
      file_size: fileSize,
      file_mtime_ms: fileMtime,
      header_cwd: header ? header.cwd : null,
      header_state: header ? 'ok' : 'header-unverified',
      created_at: header && header.createdAt ? header.createdAt : this.now(),
      title: '',
      archived_at: null,
      backfilled: 0,
      moved_at: null,
      restored_at: null,
      status: 'hot',
      favorite: 0,
      error: null,
      next_attempt: null,
      user_msgs: 0,
      assistant_msgs: 0,
      first_user_text: '',
      last_assistant_text: '',
      indexed_at: null,
      source_sha: '',
      // P4（FR-P4-2）：header 事实随行落地 —— 冷目录导入 / 无行建行走的是这一条路径，
      // 缺了它们，class S 的行会「忘记自己是子代理」（恢复分域与对账分域都靠这三列）。
      origin: header ? header.origin || null : null,
      delegation_depth: header ? Math.max(0, Math.trunc(Number(header.delegationDepth) || 0)) : 0,
      parent_session: header ? header.parentSession || null : null,
    };
  }

  // ---- 前置校验（§6.1） -------------------------------------------------
  async preflight(id, context) {
    const cfg = context.cfg;
    const coldRoot = context.coldRoot;
    const found = context.found;
    const entry = context.entry;
    const problems = [];
    const add = (code, message, extra) => problems.push({ code, message, ...extra });
    /**
     * P4（FR-P4-4 / §19.5）：「class 分支」只替换**资格**那一条，其余校验（目录名 == projectKey(header.cwd)、
     * 代际格式白名单、*.tmp、冷根在 sessions 外、跨卷开关、空间 ≥1.2×）**逐条保留**。
     *  - class A：必须在 archivedSessionIds 里（I-2 原样）；
     *  - class S：必须在七条里全过（未登记 + 无入边 + 年龄 + 恢复冷却期 + 快照新鲜 + 是子代理）；
     *    第 1/6 条（hot/hidden/error 与非活跃）由下面共用的通用检查负责，不重复判。
     */
    const migrationClass = context.class === 'subagent' ? 'subagent' : 'archived';
    if (migrationClass === 'subagent') {
      const el = await this.subagentQualification(entry, { cfg });
      for (const problem of el) add(problem.code, problem.message);
    } else if (!this.isArchived(id)) {
      add('not-archived', '会话不在 archivedSessionIds 里（I-2 / A-2）');
    }
    // A-7：冷根不可访问时只读降级——不产生任何搬移/删除（先探测再动手）
    const coldReport = await this.probeColdRoots();
    if (this.coldDegraded) {
      add('cold-unavailable', '冷存储根全部不可访问（只读降级，本轮不搬移；' + coldReport.map((item) => item.root).join(' / ') + '）');
    }
    if (await this.isActive(id)) add('active', '会话正在运行或有活动回合（I-3 / A-2）');
    if (entry && entry.status !== 'hot') add('not-candidate', 'status=' + entry.status + '，只有 hot 行可迁移（hot-restored 需重新归档，D23）');
    // P3b / I-13：hidden=1 = 用户删除的热会话 —— 即使被直接点迁移也必须 fail-closed 拒绝。
    if (entry && entry.hidden) add('hidden', '会话已被用户删除（hidden=1，文件未搬移），不参与迁移（I-13 / A-P3-4）');
    if (!found) add('source-missing', '找不到热目录 <sessions>/<projectKey>/' + id);

    let info = null;
    let tree = null;
    let header = null;
    if (found) {
      const link = await lsLink(found.dir);
      if (link) add('symlink', '会话目录是符号链接（E-3）：' + found.dir);
      info = this.generationInfo(found.files);
      const unexpected = found.files.filter((name) => !isGenerationName(name));
      if (unexpected.length) add('unexpected-files', '目录里含非代际文件：' + unexpected.join(', ') + '（含 *.tmp 一律跳过本轮，C-14）');
      if (!info.generations.length) add('no-generation', '目录里没有合法代际日志');
      if (info.current && !FORMAT_WHITELIST.includes(info.version)) {
        add('format-unsupported', '代际 v' + info.version + ' 不在白名单 {0,3,4}（A-20 / BL-1）');
      }
      try {
        tree = await statTree(found.dir);
      } catch (err) {
        add('stat-failed', '目录统计失败：' + (err && err.message ? err.message : err));
      }
      if (info.current) {
        header = await readSessionHeader(path.join(found.dir, info.current));
        if (header && header.cwd) {
          const expected = projectKey(header.cwd);
          if (expected !== found.projectKey) {
            add('project-key-mismatch', '目录名 ' + found.projectKey + ' ≠ projectKey(header.cwd)=' + expected + '（I-4 / A-10）');
          }
        } else if (header && header.id && header.id !== String(id)) {
          add('identity-mismatch', 'header.id=' + header.id + ' ≠ ' + id);
        }
      }
    }

    const hasGeneration = Boolean(found && info && info.current);
    const dst = hasGeneration ? path.join(coldRoot, found.projectKey, String(id)) : null;
    let sameVol = false;
    if (hasGeneration) {
      if (await pathExists(dst)) add('target-exists', '目标路径已存在：' + dst);
      if (await this.markers.read(id)) add('marker-present', '存在进行中的 marker，先收敛再迁移');
      if (samePath(coldRoot, this.paths.sessionsRoot) || isPathInside(coldRoot, this.paths.sessionsRoot)) {
        add('cold-root-inside-sessions', '冷根不能放在 sessions 之内（I-9 / A-11 / C-5）');
      }
      sameVol = await this.sameVolume(found.dir, dst);
      if (!sameVol && !cfg.allowCrossVolume) {
        add('cross-volume-disabled', '跨卷迁移需要显式开启 allowCrossVolume（D13）');
      }
      if (!sameVol && tree) {
        const free = await diskFreeBytes(path.dirname(dst));
        if (free !== null && free < tree.bytes * 1.2) add('insufficient-space', '冷卷余量不足（需 ≥ 源 × 1.2）');
      }
    }
    return {
      ok: problems.length === 0 && hasGeneration,
      problems,
      found: found || null,
      src: found ? found.dir : null,
      dst,
      coldRoot,
      sameVolume: sameVol,
      files: info ? info.generations : [],
      logNames: info ? info.generations.join(',') : '',
      currentGeneration: info ? info.current : null,
      formatVersion: info ? info.version : null,
      baseTree: tree,
      header,
      entry,
    };
  }

  async firstFrameShaOf(src, currentGeneration) {
    return firstFrameSha(path.join(src, currentGeneration));
  }

  // ---- 迁移（§6.2） -----------------------------------------------------
  async migrate(id, options = {}) {
    return this.enqueue(() => this.migrateNow(String(id), options));
  }

  async migrateNow(sessionId, options = {}) {
      const cfg = await this.config();
      const coldRoot = effectiveColdRoot(cfg, this.paths);
      this._coldRoot = coldRoot;
      this._coldRoots.add(coldRoot);
      let entry = this.store.getSession(sessionId);
      const found = await this.findHotDir(sessionId);
      if (!entry && found) {
        entry = await this.buildEntryFromDisk(sessionId, found);
      }
      if (!entry) {
        return { id: sessionId, ok: false, code: 'source-missing', error: '找不到会话目录与 DB 行' };
      }
      if (found && entry.status === 'hot') {
        entry = { ...entry, ...(await this.refreshDiskFields(sessionId, entry, found)) };
        this.store.upsertSession(entry);
      }
      /**
       * P4（FR-P4-4 / D-S1）：迁移**类**由落库事实派生（不写 vault_class 列）：
       *  - 在归档集合里 ⇒ class A（I-2 原样优先）；
       *  - 否则是子代理行 ⇒ class S（本次新增的迁移类）。
       * options.class 只作为显式提示（HTTP / sweeper 传 'subagent'），不能把非子代理强行搬走 ——
       * preflight 的资格判定会拒绝（fail-closed）。
       */
      // A-12 回归修复（批次 A / Stage A1）：class 派生**只读一次**归档集合快照（rowClass 用传入的 Set），
      // 绝不再调一次 isArchived —— 否则 preflight 的 I-2 判定会被提前消费，复检看到「已取消归档」的时点整体前移
      // （A-12 变成 not-archived、A1 的跨卷删源前复检提前命中，两条 class A 行为都偏离批次前语义）。
      const migrationClass = this.rowClass(entry, this.archivedIds()) === 'subagent' ? 'subagent' : 'archived';
      const pre = await this.preflight(sessionId, { cfg, coldRoot, found, entry, class: migrationClass });
      if (!pre.ok) {
        return {
          id: sessionId,
          ok: false,
          code: pre.problems[0] ? pre.problems[0].code : 'preflight-failed',
          error: pre.problems.map((problem) => problem.message).join('；'),
          problems: pre.problems,
        };
      }

      const baseline = await hashTree(pre.src);
      const statBefore = await statTree(pre.src);
      // 写栅栏（R-7）：同卷 rename 保持 mtime，可直接比源 mtime；跨卷 copy 必然产生新 mtime，
      // 所以拿「拷贝并校验完成那一刻」的 mtime 当栅栏基准（否则跨卷迁移会 100% 误判 race-written）。
      const fence = { bytes: statBefore.bytes, mtimeMs: statBefore.maxMtimeMs, names: statBefore.files.map((file) => file.name) };
      const sourceSha = await this.firstFrameShaOf(pre.src, pre.currentGeneration);
      const marker = {
        op: 'migrate',
        phase: 'planned',
        src: pre.src,
        dst: pre.dst,
        coldRoot,
        projectKey: entry.project_key,
        relDir: entry.rel_dir,
        logNames: pre.logNames,
        currentGeneration: pre.currentGeneration,
        formatVersion: pre.formatVersion,
        bytes: baseline.bytes,
        planSha: baseline.sha256,
        files: baseline.files,
        planMtimeMs: statBefore.maxMtimeMs,
        sourceSha,
        headerCwd: pre.header ? pre.header.cwd : entry.header_cwd,
        title: entry.title || '',
        archivedAt: entry.archived_at,
        createdAt: entry.created_at,
        firstUserText: entry.first_user_text || '',
        lastAssistantText: entry.last_assistant_text || '',
        reason: options.reason || 'manual',
        // P4（§19.7）：marker 带 class —— 崩溃收敛 / 删源前复检 / 清单读面都靠它分域。
        // class A 的 marker 保持**不带该字段**（旧 marker 的兼容口径：缺 = archived）。
        class: migrationClass === 'subagent' ? 'subagent' : undefined,
      };
      if (marker.class === undefined) delete marker.class;

      await this.mkdirp(path.dirname(pre.dst), [coldRoot]);
      // 铁律：marker 必须**先于**任何磁盘搬移落盘（崩溃基线的唯一来源）。但 marker 自身失败 ⇒
      // 这一行会变成「status=migrating 且无 marker」的僵尸：preflight 因 status≠hot 判 not-candidate（拒绝重试），
      // recoverOnBoot 又只扫 marker ⇒ 永久卡死。所以 marker 写失败必须当场回滚 status=hot 并记诊断。
      this.store.updateSession(sessionId, { status: 'migrating', error: null });
      try {
        await this.markers.write(sessionId, marker);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        this.store.updateSession(sessionId, { status: 'hot', error: 'marker-failed: ' + message });
        return {
          id: sessionId,
          ok: false,
          code: 'marker-failed',
          error: 'marker 写入失败，已回滚为 hot（源目录未动，可重试）：' + message,
        };
      }

      try {
        if (pre.sameVolume) {
          await this.renamePath(pre.src, pre.dst, coldRoot);
        } else {
          const partial = pre.dst + '.partial';
          this.assertWritable(partial, [coldRoot]);
          await this.copyTree(pre.src, partial, coldRoot);
          const partialHash = await hashTree(partial);
          if (partialHash.sha256 !== baseline.sha256) {
            throw new EngineFailure('verify-failed', '跨卷拷贝校验失败（.partial 与 marker 基线不一致）');
          }
          const sourcePrint = fingerprint(statBefore);
          const sourceAfter = await statTree(pre.src);
          if (fingerprint(sourceAfter) !== sourcePrint) {
            throw new EngineFailure('source-changed', '拷贝期间源目录被写入（双指纹不一致）');
          }
          await this.renamePath(partial, pre.dst, coldRoot);
          const dstHash = await hashTree(pre.dst);
          if (dstHash.sha256 !== baseline.sha256) {
            throw new EngineFailure('verify-failed', '跨卷落盘后校验失败（dst 与 marker 基线不一致）');
          }
          fence.mtimeMs = (await statTree(pre.dst)).maxMtimeMs;
          const finalPrint = fingerprint(await statTree(pre.src));
          if (finalPrint !== sourcePrint) {
            throw new EngineFailure('source-changed', '删源前复检发现源已变（R-7 临界区）');
          }
          // I-6 在删源前再判一次（唯一允许删源路径的前置条件）；
          // P4：class S 的判据换成「七条资格重算」（class S 本来就不在归档集合里）。
          const preRace = await this.migrationRaceReason(sessionId, migrationClass, cfg);
          if (preRace) {
            await this.removeTree(pre.dst, coldRoot);
            await this.markers.remove(sessionId);
            this.store.updateSession(sessionId, { status: 'hot', error: preRace });
            return {
              id: sessionId,
              ok: false,
              code: preRace,
              error:
                migrationClass === 'subagent'
                  ? '删源前复检发现资格不再满足（' + preRace + '）：已放弃迁移并保留热文件'
                  : '删源前复检发现会话已取消归档或活跃，已放弃迁移并保留热文件',
            };
          }
          await this.removeTree(pre.src, coldRoot);
        }

        const movedHash = await hashTree(pre.dst);
        if (movedHash.sha256 !== baseline.sha256) {
          throw new EngineFailure('baseline-mismatch', '搬移后 sha256 与 marker 基线不一致');
        }
        await this.markers.patch(sessionId, { phase: 'moved' });

        // P4（FR-P4-4）：迁移**后**复检 —— class A 仍是 I-6（取消归档 / 活跃），
        // class S 换成「被登记 / 被归档 / 新增引用 / 变活跃」任一命中即**立即搬回**并记 race-*。
        const postRace = await this.migrationRaceReason(sessionId, migrationClass, cfg);
        if (postRace) {
          const back = await this.moveBack(pre.dst, pre.src, coldRoot, marker);
          if (!back.ok) {
            // A1：跨卷搬回的热侧没通过基线 ⇒ 冷源（唯一合格副本）保留 + needs-review，
            // marker 一并保留作为待人工处置的证据（自动例程永不删双份中的任何一份）。
            this.store.updateSession(sessionId, { status: 'migrating', error: ERROR_STATES.NEEDS_REVIEW });
            return {
              id: sessionId,
              ok: false,
              code: ERROR_STATES.NEEDS_REVIEW,
              error: '迁移后复检需搬回，但跨卷搬回的热侧未通过 marker 基线（' + (back.reason || 'unknown') +
                '）：冷源保留，双份 + needs-review 人工处置（§11 允许删源的唯一条件）',
            };
          }
          await this.markers.remove(sessionId);
          this.store.updateSession(sessionId, { status: 'hot', error: postRace });
          return {
            id: sessionId,
            ok: false,
            code: postRace,
            error:
              migrationClass === 'subagent'
                ? '迁移后复检发现资格不再满足（' + postRace + '），已立即搬回（FR-P4-4）'
                : '迁移后复检发现已取消归档或出现 live 会话，已搬回（I-6 / A-12）',
          };
        }

        const after = await statTree(pre.dst);
        const hasTmp = after.files.some((file) => file.name.endsWith('.tmp'));
        const sameNames = JSON.stringify(after.files.map((file) => file.name)) === JSON.stringify(fence.names);
        if (after.bytes !== fence.bytes || after.maxMtimeMs !== fence.mtimeMs || !sameNames || hasTmp) {
          const back = await this.moveBack(pre.dst, pre.src, coldRoot, marker);
          if (!back.ok) {
            // A1：同上 —— 跨卷搬回的热侧不过基线时冷源保留 + needs-review（绝不删）。
            this.store.updateSession(sessionId, { status: 'migrating', error: ERROR_STATES.NEEDS_REVIEW });
            return {
              id: sessionId,
              ok: false,
              code: ERROR_STATES.NEEDS_REVIEW,
              error: '写栅栏命中需搬回，但跨卷搬回的热侧未通过 marker 基线（' + (back.reason || 'unknown') +
                '）：冷源保留，双份 + needs-review 人工处置（§11 允许删源的唯一条件）',
            };
          }
          await this.markers.remove(sessionId);
          this.store.updateSession(sessionId, { status: 'hot', error: ERROR_STATES.RACE_WRITTEN });
          return {
            id: sessionId,
            ok: false,
            code: ERROR_STATES.RACE_WRITTEN,
            error: '写栅栏命中：搬后字节/mtime 变化或出现 *.tmp，已搬回（R-7）',
          };
        }

        return await this.finishMigrate(sessionId, pre, baseline, marker, coldRoot);
      } catch (err) {
        return await this.handleMigrateFailure(sessionId, err, pre, coldRoot, marker);
      }
  }

  async refreshDiskFields(id, entry, found) {
    const info = this.generationInfo(found.files);
    const tree = await statTree(found.dir);
    const merged = { ...entry };
    merged.project_key = found.projectKey;
    merged.rel_dir = found.projectKey + '/' + String(id);
    merged.log_names = info.generations.join(',');
    merged.bytes = tree.bytes;
    merged.file_mtime_ms = tree.maxMtimeMs;
    if (info.version !== null) merged.format_version = info.version;
    if (info.current && (!entry.header_cwd || entry.origin === null || entry.origin === undefined)) {
      const header = await readSessionHeader(path.join(found.dir, info.current));
      if (header && header.cwd && !entry.header_cwd) merged.header_cwd = header.cwd;
      // P4：header 事实的自愈点（存量行在 P4 之前的列是空的；迁移/列表都会经过这里）
      if (header) {
        const facts = headerFactsOf(header);
        if (facts.origin !== null && merged.origin !== facts.origin) merged.origin = facts.origin;
        if (facts.delegationDepth > 0 && Number(merged.delegation_depth) !== facts.delegationDepth) {
          merged.delegation_depth = facts.delegationDepth;
        }
        if (facts.parentSession !== null && merged.parent_session !== facts.parentSession) merged.parent_session = facts.parentSession;
      }
    }
    return merged;
  }

  async finishMigrate(sessionId, pre, baseline, marker, coldRoot) {
    const now = this.now();
    let indexError = null;
    const row = {
      session_id: sessionId,
      project_key: marker.projectKey,
      rel_dir: marker.relDir,
      log_names: marker.logNames,
      cold_root: coldRoot,
      format_version: marker.formatVersion,
      bytes: baseline.bytes,
      file_size: 0,
      file_mtime_ms: marker.planMtimeMs,
      header_cwd: marker.headerCwd,
      header_state: marker.headerCwd ? 'ok' : 'header-unverified',
      created_at: marker.createdAt || now,
      title: marker.title || '',
      archived_at: marker.archivedAt === undefined ? now : marker.archivedAt,
      backfilled: pre.entry.backfilled || 0,
      moved_at: now,
      restored_at: null,
      status: 'cold',
      favorite: pre.entry.favorite || 0,
      error: null,
      next_attempt: null,
      source_sha: marker.sourceSha,
      // P4：header 事实必须随行保留 —— 少了它们，class S 的行会在搬完后「忘记自己是子代理」
      // （恢复分域 / 对账分域 / 下一次扫描都靠这三列）。
      origin: pre.entry.origin === undefined ? null : pre.entry.origin,
      delegation_depth: Math.max(0, Math.trunc(Number(pre.entry.delegation_depth) || 0)),
      parent_session: pre.entry.parent_session === undefined ? null : pre.entry.parent_session,
    };
    try {
      const info = await stat(path.join(pre.dst, marker.currentGeneration));
      row.file_size = info.size;
      row.file_mtime_ms = Math.trunc(info.mtimeMs);
    } catch {
      /* 用 marker 的 mtime 兜底 */
    }
    this.store.upsertSession(row);
    /**
     * R2（P3a.1 评审）：索引是迁移**之后**的附加步骤（§8.5 / R-9「迁移不因索引失败阻塞」）。
     * 旧实现直接 await indexSession：存储异常（如 replaceDocs 抛错）会穿透到 handleMigrateFailure，
     * 把**已经成功搬完**的行翻回 migrating（files 已在冷侧 ⇒ recovery-pending），等于报了假故障。
     * 现在只落 error='index-failed'（不动 status、不改返回值）。
     */
    try {
      const index = await this.indexSession(sessionId, pre.dst, marker);
      if (!index.ok) indexError = index.error;
    } catch (err) {
      indexError = ERROR_STATES.INDEX_FAILED;
      this.recordIndexFailure(sessionId, err);
    }
    // P4（§19.7）：manifest 行带 class=subagent；class A 行**保持不带该字段**（缺 = archived）。
    const manifestRecord = {
      ts: now,
      op: 'migrate',
      id: sessionId,
      from: marker.src,
      to: pre.dst,
      bytes: baseline.bytes,
      files: marker.logNames ? marker.logNames.split(',').length : 0,
      sha256: baseline.sha256,
      ok: true,
      reason: marker.reason || null,
      movedAt: now,
    };
    if (marker.class === 'subagent') manifestRecord.class = 'subagent';
    await this.manifest.appendDedup(manifestRecord);
    await this.markers.remove(sessionId);
    this.emit({ type: 'migrate', id: sessionId });
    return {
      id: sessionId,
      ok: true,
      status: 'cold',
      bytes: baseline.bytes,
      indexError: indexError ? String(indexError) : null,
    };
  }

  async handleMigrateFailure(sessionId, err, pre, coldRoot, marker) {
    const srcExists = await isDirectory(pre.src);
    const dstExists = await isDirectory(pre.dst);
    const message = err && err.message ? err.message : String(err);
    const code = err && err.code ? err.code : 'migrate-failed';
    if (srcExists && !dstExists) {
      // 搬移前失败 → 删 marker（+ .partial），回滚热态，可重试
      await this.removeTree(pre.dst + '.partial', coldRoot).catch(() => {});
      await this.markers.remove(sessionId).catch(() => {});
      this.store.updateSession(sessionId, { status: 'hot', error: code + ': ' + message });
      return { id: sessionId, ok: false, code, error: message, rolledBack: true };
    }
    if (!srcExists && dstExists) {
      // 文件已到冷侧：保持 marker，启动续跑（不回滚）
      this.store.updateSession(sessionId, { status: 'migrating', error: 'recovery-pending: ' + message });
      return { id: sessionId, ok: false, code: 'recovery-pending', error: '搬移中途失败，已保持 marker，下次启动续跑：' + message };
    }
    if (srcExists && dstExists) {
      // 双份：先尝试按 marker 基线**逐文件补齐**（§11「跨卷删源中（部分删）」唯一可自动收敛的分支）：
      // 冷侧缺的文件用热侧同基线文件补、热侧残留全部通过基线 → 删残留继续尾段；否则永不删源，标 needs-review。
      const repair = marker ? await this.repairMigrationDuplicates(sessionId, marker, pre.src, pre.dst).catch(() => ({ ok: false, reason: 'repair-failed' })) : { ok: false, reason: 'no-marker' };
      // P4：删热残留前的复检也按 class 分域（class S 不在归档集合里，绝不能用 isArchived 当判据）。
      const failureRace = repair.ok ? await this.migrationRaceReason(sessionId, marker && marker.class === 'subagent' ? 'subagent' : 'archived', null) : null;
      if (repair.ok && !failureRace) {
        await this.removeTree(pre.src, coldRoot);
        await this.completeMigrateTail(sessionId, marker);
        return { id: sessionId, ok: true, status: 'cold', repaired: true, copied: repair.copied || 0 };
      }
      if (repair.ok) {
        // 基线可修但会话已取消归档/活跃/失去资格：按 I-6 搬回热态
        await this.removeTree(pre.dst, coldRoot);
        await this.markers.remove(sessionId);
        this.store.updateSession(sessionId, { status: 'hot', error: failureRace });
        return { id: sessionId, ok: false, code: failureRace, error: '双份已按基线收敛，但会话已取消归档/活跃（' + failureRace + '），已搬回热态（I-6）' };
      }
      this.store.updateSession(sessionId, { status: 'migrating', error: ERROR_STATES.NEEDS_REVIEW });
      return {
        id: sessionId,
        ok: false,
        code: ERROR_STATES.NEEDS_REVIEW,
        error: '冷/热双份同时存在且无法按基线逐文件补齐（' + (repair.reason || 'unknown') + '）：保留双份并标 needs-review（自动例程永不删源）：' + message,
      };
    }
    this.store.updateSession(sessionId, { status: 'migrating', error: ERROR_STATES.LOST });
    return { id: sessionId, ok: false, code: ERROR_STATES.LOST, error: '热/冷两侧都不存在，已标 lost 并保留 marker：' + message };
  }

  /**
   * §11「跨卷删源中（部分删）」：冷侧 + 热残留 → **按 marker 基线逐文件比对补齐**。
   *
   * 规则（每一侧都拿基线说话，任何一条不满足都返回 ok:false 让调用方落 needs-review 并保留双份）：
   *  ① 两侧都不允许出现基线之外的文件（新写入/异物 → 不自动处理）；
   *  ② 热侧**剩余**文件必须逐字节等于基线（相等 ⇒ 只是「尚未删掉的残留」；不等 ⇒ 是新内容，绝不删）；
   *  ③ 冷侧缺文件时，用热侧同基线文件补进冷侧并复验（补齐）；
   *  ④ 补齐后冷侧整树必须等于 marker.planSha，才允许删热残留并续尾段。
   * @returns {{ok:boolean, copied?:number, code?:string, reason?:string}}
   */
  async repairMigrationDuplicates(sessionId, marker, src, dst) {
    const files = marker && Array.isArray(marker.files) ? marker.files.filter((file) => file && file.name && file.sha256) : [];
    if (!files.length || !marker.planSha) return { ok: false, code: 'no-baseline', reason: 'marker 无逐文件基线' };
    const coldRoot = marker.coldRoot || this._coldRoot;
    const byName = new Map(files.map((file) => [file.name, file]));
    const names = async (dir) => (await listDirFiles(dir).catch(() => [])).filter((entry) => !entry.dir).map((entry) => entry.name);
    const sourceNames = await names(src);
    const targetNames = await names(dst);
    for (const name of sourceNames) {
      if (!byName.has(name)) return { ok: false, code: 'unexpected-source-file', reason: '热残留含基线外文件：' + name };
    }
    for (const name of targetNames) {
      if (!byName.has(name)) return { ok: false, code: 'unexpected-target-file', reason: '冷侧含基线外文件：' + name };
    }
    for (const name of sourceNames) {
      const expected = byName.get(name);
      const sha = await hashFile(path.join(src, name)).catch(() => null);
      if (sha !== expected.sha256) {
        return { ok: false, code: 'source-has-newer-content', reason: '热残留文件与基线不一致（可能是新写入）：' + name };
      }
    }
    let copied = 0;
    for (const file of files) {
      const target = path.join(dst, file.name);
      const current = await hashFile(target).catch(() => null);
      if (current === file.sha256) continue;
      if (!sourceNames.includes(file.name)) {
        return { ok: false, code: 'missing-on-both-sides', reason: '冷侧缺文件且热侧已删：' + file.name };
      }
      await this.copyInto(path.join(src, file.name), target, coldRoot);
      const after = await hashFile(target).catch(() => null);
      if (after !== file.sha256) return { ok: false, code: 'repair-verify-failed', reason: file.name };
      copied += 1;
    }
    const repaired = await hashTree(dst).catch(() => null);
    if (!repaired || repaired.sha256 !== marker.planSha) {
      return { ok: false, code: 'repair-baseline-mismatch', reason: repaired ? repaired.sha256 : 'unreadable' };
    }
    return { ok: true, copied };
  }

  async copyTree(src, dst, coldRoot) {
    const extra = coldRoot ? [coldRoot] : [];
    await this.mkdirp(dst, extra);
    const entries = await listDirFiles(src);
    for (const entry of entries) {
      if (entry.dir) continue;
      const target = path.join(dst, entry.name);
      await this.copyInto(path.join(src, entry.name), target, coldRoot);
      await this.fsyncPath(target, coldRoot).catch(() => {});
    }
  }

  /**
   * 搬回热侧（**迁移方向的反向动作**：dst = 冷侧/将被删的源，src = 热侧/目标）。
   *
   * A1（P2.6 评审）：跨卷分支是 `copyTree(dst → src)` + `removeTree(dst)`，删冷源**之前**
   * 必须按 marker 基线校验热侧（§11「允许删源的唯一条件」）。旧实现 copy 完直接删源 ⇒
   * 热侧被改坏时把唯一合格的副本删掉。校验不通过 ⇒ **冷源保留 + needs-review（绝不删）**，
   * 由调用方落显式标记态并保留 marker。
   *
   * 同卷 rename 是原子的（不存在「拷完、未校验」的窗口），不额外校验。
   *
   * @param {string} dst 冷侧目录
   * @param {string} src 热侧目录
   * @param {string} [coldRoot]
   * @param {object|null} [baseline] marker（planSha / files[] / bytes）；跨卷分支必填
   * @returns {Promise<{ok:boolean, code?:string, reason?:string, removed?:boolean}>}
   */
  async moveBack(dst, src, coldRoot, baseline = null) {
    await this.mkdirp(path.dirname(src), [coldRoot]);
    const sameVol = await this.sameVolume(dst, src);
    if (sameVol) {
      await this.renamePath(dst, src, coldRoot);
      return { ok: true, removed: true };
    }
    await this.copyTree(dst, src, coldRoot);
    // 跨卷：删源前按 marker 基线校验目标（热侧）。
    const check = await this.verifyBaseline(src, baseline);
    if (!check.ok) {
      // §11：允许删源的唯一条件 = 目标已通过 marker 全量基线校验。这里不删任何一份。
      return { ok: false, code: ERROR_STATES.NEEDS_REVIEW, reason: check.reason || 'baseline-mismatch' };
    }
    await this.removeTree(dst, coldRoot);
    return { ok: true, removed: true };
  }

  // ---- 恢复（§7） -------------------------------------------------------
  async restore(id, options = {}) {
    return this.enqueue(() => this.restoreNow(String(id), options));
  }

  async restoreNow(sessionId, options = {}) {
      const cfg = await this.config();
      const entry = this.store.getSession(sessionId);
      if (!entry) {
        return { id: sessionId, ok: false, code: 'unknown-session', error: 'DB 无该会话行（P1 只恢复自己迁过的会话）' };
      }
      if (entry.status === 'hot-restored') return { id: sessionId, ok: true, code: 'already-restored', status: 'hot-restored' };
      if (entry.status !== 'cold' && entry.status !== 'restoring') {
        return { id: sessionId, ok: false, code: 'not-cold', error: 'status=' + entry.status };
      }
      const coldRoot = entry.cold_root || effectiveColdRoot(cfg, this.paths);
      this._coldRoot = coldRoot;
      this._coldRoots.add(coldRoot);
      const src = path.join(coldRoot, entry.rel_dir);
      const dst = path.join(this.paths.sessionsRoot, entry.rel_dir);
      let srcExists = await isDirectory(src);
      let dstExists = await isDirectory(dst);

      if (!srcExists && !dstExists) {
        this.store.updateSession(sessionId, { error: ERROR_STATES.LOST, status: 'cold' });
        return { id: sessionId, ok: false, code: ERROR_STATES.LOST, error: '冷目录与热目录都不存在：已标 lost，保留 DB 行与 marker，人工处置（§11 真值表）' };
      }

      const existingMarker = await this.markers.read(sessionId);
      if (!srcExists && dstExists && existingMarker) {
        // 冷侧已不在（搬移完成过）+ marker 还在：续跑前仍要按 marker 全量基线校验热侧，
        // 否则「半截热目录」会被当作已完成而进入 unarchive（§11 真值表「无/在 → 按基线校验 dst」）。
        const hotTree = await hashTree(dst).catch(() => null);
        const baselineSha = existingMarker.planSha || null;
        if (!baselineSha || !hotTree || hotTree.sha256 !== baselineSha) {
          this.store.updateSession(sessionId, { status: 'restoring', error: ERROR_STATES.NEEDS_REVIEW });
          return {
            id: sessionId,
            ok: false,
            code: ERROR_STATES.NEEDS_REVIEW,
            error: '冷侧已不在、热侧无法通过 marker 基线校验（' + (baselineSha ? 'sha 不一致' : '无基线') + '）：保留现场，人工处置',
          };
        }
      }
      if (srcExists && dstExists) {
        // 双份判定只看 marker 的全量基线（§11「允许删源的唯一条件」）：
        //  - 热侧通过基线 → 清冷残留续尾段；
        //  - 冷侧通过基线 → 热侧只是半成品，丢弃后重搬；
        //  - 没有基线（marker 丢了/损坏）或任一侧不通过 → **双份保留 + needs-review**，绝不删任何一侧。
        const decision = await this.decideRestoreDuplicates(entry, existingMarker, src, dst);
        if (decision.action === 'delete-cold') {
          await this.removeTree(src, coldRoot);
          srcExists = false;
        } else if (decision.action === 'delete-hot') {
          await this.removeTree(dst, coldRoot);
          dstExists = false;
        } else {
          this.store.updateSession(sessionId, { status: 'restoring', error: ERROR_STATES.NEEDS_REVIEW });
          return {
            id: sessionId,
            ok: false,
            code: ERROR_STATES.NEEDS_REVIEW,
            error: '冷/热双份无法按 marker 基线判定（' + decision.reason + '）：双份保留，人工处置（自动例程永不删源）',
          };
        }
      }

      const plan = await this.buildRestorePlan(sessionId, entry, src, dst, coldRoot, { srcExists });
      if (srcExists) {
        // 身份校验只在能读 header 时做；读不到只标记、不阻塞（R-12 / D19）
        let header = null;
        try {
          header = await readSessionHeader(path.join(src, plan.currentGeneration));
        } catch {
          header = null;
        }
        if (header) {
          if (header.id && String(header.id) !== sessionId) {
            this.store.updateSession(sessionId, { error: ERROR_STATES.IDENTITY_MISMATCH });
            return { id: sessionId, ok: false, code: ERROR_STATES.IDENTITY_MISMATCH, error: 'header.id 与请求 id 不一致（同名异会话防护）' };
          }
          if (header.cwd && projectKey(header.cwd) !== entry.project_key) {
            this.store.updateSession(sessionId, { error: ERROR_STATES.IDENTITY_MISMATCH });
            return {
              id: sessionId,
              ok: false,
              code: ERROR_STATES.IDENTITY_MISMATCH,
              error: 'projectKey(header.cwd) 与落库 project_key 不一致（C-11：恢复必须以落库事实为准，fail-closed）',
            };
          }
        } else {
          this.store.updateSession(sessionId, { header_state: 'header-unverified' });
        }

        this.assertWritable(dst, [coldRoot]);
        this.store.updateSession(sessionId, { status: 'restoring', error: null });
        await this.markers.write(sessionId, { ...plan.marker, phase: 'planned' });
        try {
          if (plan.sameVolume) {
            // A-19 / 写面口径（§7）：恢复**必须写 sessionsRoot**，但它和迁移一样是写操作——
            // 同卷分支旧实现直接 `mkdir`/`rename`，完全绕过 writeOp/assertWritable（假 fs 也看不见），
            // 白名单只在跨卷分支被覆盖到。这里统一走 this.mkdirp + this.renamePath，
            // 让「所有写/删路径 ∈ {vaultRoot, sessionsRoot, 已知冷根}」这条不变量对两条分支都成立。
            await this.mkdirp(path.dirname(dst), [coldRoot]);
            await this.renamePath(src, dst, coldRoot);
          } else {
            await this.restoreAcrossVolume(src, dst, plan, coldRoot);
          }
          await this.markers.patch(sessionId, { phase: 'moved' });
        } catch (err) {
          await this.handleRestoreMoveFailure(sessionId, err, src, dst, coldRoot, plan);
          return { id: sessionId, ok: false, code: err.code || 'move-failed', error: err && err.message ? err.message : String(err) };
        }
      }

      return await this.finishRestore(sessionId, entry, src, dst, plan, options);
  }

  async buildRestorePlan(sessionId, entry, src, dst, coldRoot, { srcExists }) {
    const logNames = entry.log_names ? entry.log_names.split(',').filter(Boolean) : [];
    const current = sortGenerations(logNames).slice(-1)[0] || null;
    let files = [];
    let bytes = entry.bytes || 0;
    if (srcExists) {
      const listing = (await listDirFiles(src)).filter((item) => !item.dir).map((item) => item.name);
      files = sortGenerations(listing.filter((name) => isGenerationName(name)));
      const base = await hashTree(src);
      bytes = base.bytes;
      return {
        sameVolume: await this.sameVolume(src, dst),
        files: base.files,
        bytes,
        planSha: base.sha256,
        sourceFingerprint: fingerprint(await statTree(src)),
        currentGeneration: current || (files.length ? files[files.length - 1] : entry.log_names),
        marker: {
          op: 'restore',
          phase: 'planned',
          src,
          dst,
          coldRoot,
          projectKey: entry.project_key,
          relDir: entry.rel_dir,
          logNames: entry.log_names,
          currentGeneration: current,
          bytes,
          planSha: base.sha256,
          files: base.files,
          reason: 'restore',
        },
      };
    }
    return {
      sameVolume: true,
      files: [],
      bytes,
      planSha: entry.source_sha || '',
      sourceFingerprint: '',
      currentGeneration: current || entry.log_names,
      marker: {
        op: 'restore',
        phase: 'moved',
        src,
        dst,
        coldRoot,
        projectKey: entry.project_key,
        relDir: entry.rel_dir,
        logNames: entry.log_names,
        currentGeneration: current,
        bytes,
        planSha: entry.source_sha || '',
        files: [],
        reason: 'restore-resume',
      },
    };
  }

  async restoreAcrossVolume(src, dst, plan, coldRoot) {
    await this.mkdirp(dst, [coldRoot]);
    const names = plan.files.map((file) => file.name);
    const ordered = sortGenerations(names); // v0→v3→v4：最新代际最后落最终名（R-6 / A-14）
    for (const name of ordered) {
      const from = path.join(src, name);
      const part = path.join(dst, name + '.part');
      await this.copyInto(from, part, coldRoot);
      await this.fsyncPath(part, coldRoot).catch(() => {});
      const expected = plan.files.find((file) => file.name === name);
      if (expected) {
        const actual = await hashFile(part);
        if (actual !== expected.sha256) {
          await this.removeFile(part, coldRoot).catch(() => {});
          throw new EngineFailure('verify-failed', '代际文件校验失败：' + name);
        }
      }
      await this.renamePath(part, path.join(dst, name), coldRoot);
    }
    const after = await statTree(src);
    if (fingerprint(after) !== plan.sourceFingerprint) {
      throw new EngineFailure('source-changed', '拷贝期间冷侧被写入（双指纹不一致）');
    }
    await this.removeTree(src, coldRoot);
  }

  async handleRestoreMoveFailure(sessionId, err, src, dst, coldRoot, plan) {
    const message = err && err.message ? err.message : String(err);
    if (await isDirectory(src)) {
      // 冷源仍在：**先按基线确认冷源完整**，才允许丢弃热侧半成品（A-14 不产生半截热目录）；
      // 冷源不通过基线 ⇒ 双份保留 + needs-review（不删任何一侧）。
      const coldOk = plan && plan.planSha ? (await hashTree(src).catch(() => null))?.sha256 === plan.planSha : false;
      if (!coldOk) {
        this.store.updateSession(sessionId, { status: 'restoring', error: ERROR_STATES.NEEDS_REVIEW });
        return;
      }
      await this.removeTree(dst, coldRoot).catch(() => {});
      await this.markers.remove(sessionId).catch(() => {});
      this.store.updateSession(sessionId, { status: 'cold', error: 'restore-failed: ' + message });
      return;
    }
    // 冷源已不在：热侧是唯一副本 → 绝不删，保持 marker 续跑（不回滚）
    this.store.updateSession(sessionId, { status: 'restoring', error: 'recovery-pending: ' + message });
  }

  /**
   * 热侧「当前代际是否与 marker 基线一致」。
   *
   * 铁律：**没有基线就是 false**。旧实现（`if (!expectedSha) return true`）把「无基线」当成
   * 「完整」，于是 restore/recoverOnBoot 在无基线下会删掉冷源——直接违反 §11
   * 「允许删源的唯一条件 = 目标已通过 marker 全量基线校验」。
   */
  async hotSideComplete(dir, entry, marker) {
    const entries = await listDirFiles(dir).catch(() => []);
    const names = entries.filter((item) => !item.dir).map((item) => item.name);
    const generations = sortGenerations(names.filter((name) => isGenerationName(name)));
    if (!generations.length) return false;
    const current = generations[generations.length - 1];
    const expected = marker && Array.isArray(marker.files) ? marker.files.find((file) => file.name === current) : null;
    const expectedSha = expected && expected.sha256 ? expected.sha256 : null;
    if (!expectedSha) return false;
    try {
      return (await hashFile(path.join(dir, current))) === expectedSha;
    } catch {
      return false;
    }
  }

  /**
   * 逐文件校验目录与 marker 基线（评审 #3）：marker 只有 files[]（缺 planSha）时，
   * 「冷侧是完整副本」只能靠**逐文件 sha256** 证明——名字集合必须完全一致（多一个文件也不算通过）。
   */
  async verifyDirFiles(dir, files) {
    const expected = new Map();
    for (const file of files || []) {
      if (file && file.name && file.sha256) expected.set(String(file.name), String(file.sha256));
    }
    if (!expected.size) return false;
    const names = (await listDirFiles(dir).catch(() => [])).filter((item) => !item.dir).map((item) => item.name);
    if (names.length !== expected.size) return false;
    for (const name of names) {
      const sha = expected.get(name);
      if (!sha) return false;
      const actual = await hashFile(path.join(dir, name)).catch(() => null);
      if (actual !== sha) return false;
    }
    return true;
  }

  /**
   * **删某一份之前的基线校验**（A1 / §11「允许删源的唯一条件」）。
   *
   * 跨卷 moveBack 是 copyTree(dst → src) 再 removeTree(dst)：copy 出来的热侧可能被并发写入、
   * 磁盘错误或注入的 copy 实现改坏。旧实现在 copyTree 之后**不做任何校验**就删冷源 ——
   * 一旦热侧不合格，唯一通过 marker 基线的副本（冷源）就被删掉了。
   *
   * 判据与 `decideRestoreDuplicates` 同口径（fail-closed）：
   *   ① 有 `planSha` ⇒ 整树 sha256 必须相等；
   *   ② 只有 `files[]`（缺 planSha）⇒ 逐文件 sha256 + 名字集合（verifyDirFiles）+ 总字节数；
   *   ③ 两样都没有 / 目标读不出来 ⇒ **不通过**（读失败绝不当作通过）。
   *
   * @param {string} dir 目标目录（即将成为唯一副本的那一侧）
   * @param {{planSha?:string, files?:Array<{name:string,sha256:string}>, bytes?:number}|null} baseline
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async verifyBaseline(dir, baseline) {
    const value = baseline || {};
    const planSha = typeof value.planSha === 'string' && value.planSha ? value.planSha : null;
    const files = Array.isArray(value.files) && value.files.length ? value.files : null;
    if (!planSha && !files) return { ok: false, reason: 'marker 无全量基线（planSha/files 为空）' };
    if (planSha) {
      const tree = await hashTree(dir).catch(() => null);
      if (!tree) return { ok: false, reason: '目标目录读不出来（读失败不当作通过）' };
      if (tree.sha256 !== planSha) return { ok: false, reason: '目标与 marker 基线 sha256 不一致（实测 ' + tree.sha256 + '）' };
      return { ok: true };
    }
    if (!(await this.verifyDirFiles(dir, files))) {
      return { ok: false, reason: 'marker 只有 files[]（缺 planSha）且目标逐文件校验不通过（读失败/不一致都不当作通过）' };
    }
    const expectedBytes = Number(value.bytes);
    if (Number.isFinite(expectedBytes) && expectedBytes >= 0) {
      const tree = await statTree(dir).catch(() => null);
      if (!tree) return { ok: false, reason: '目标目录读不出来（读失败不当作通过）' };
      if (tree.bytes !== expectedBytes) {
        return { ok: false, reason: '目标总字节数 ' + tree.bytes + ' ≠ marker 基线 ' + expectedBytes };
      }
    }
    return { ok: true };
  }

  /**
   * 恢复方向「双份」（src=冷、dst=热）该删哪一侧（§11 真值表 + 允许删源的唯一条件）。
   *
   * 评审 #3（必须修）：marker 只有 files[]、缺 planSha 时，**冷侧必须先逐文件校验**；
   * 通过才允许任何「删热侧」的决定，否则一律 needs-review。旧实现只看 planSha，
   * 缺 planSha 时等于「冷侧没校验就删热源」——直接违反「允许删源的唯一条件」。
   *
   * @returns {{action:'delete-cold'|'delete-hot'|'needs-review', reason:string}}
   */
  async decideRestoreDuplicates(entry, marker, src, dst) {
    const baselineSha = marker && typeof marker.planSha === 'string' && marker.planSha ? marker.planSha : null;
    const baselineFiles = marker && Array.isArray(marker.files) && marker.files.length ? marker.files : null;
    if (!baselineSha && !baselineFiles) {
      return { action: 'needs-review', reason: 'marker 无全量基线（planSha/files 为空）' };
    }
    const cold = await hashTree(src).catch(() => null);
    if (!cold) return { action: 'needs-review', reason: '冷侧读不出来（读失败不删源）' };
    if (baselineSha && cold.sha256 !== baselineSha) {
      return { action: 'needs-review', reason: '冷侧与 marker 基线不一致（sha=' + cold.sha256 + '）' };
    }
    if (!baselineSha && baselineFiles && !(await this.verifyDirFiles(src, baselineFiles))) {
      return { action: 'needs-review', reason: 'marker 只有 files[]（缺 planSha）且冷侧逐文件校验不通过（读失败/不一致都不删源）' };
    }
    const hot = await hashTree(dst).catch(() => null);
    if (!hot) return { action: 'needs-review', reason: '热侧读不出来（读失败不删源）' };
    if (baselineSha && hot.sha256 === baselineSha) {
      return { action: 'delete-cold', reason: '热侧已通过全量基线校验，清冷残留续尾段' };
    }
    if (!baselineSha && baselineFiles && (await this.verifyDirFiles(dst, baselineFiles))) {
      return { action: 'delete-cold', reason: '热侧已通过 files[] 逐文件基线校验，清冷残留续尾段' };
    }
    // 冷侧通过基线（上面已校验）→ 热侧是半成品；且当前代际必须确实「不一致」才允许丢弃热侧。
    const currentOk = await this.hotSideComplete(dst, entry, marker);
    if (currentOk) {
      return { action: 'needs-review', reason: '当前代际与基线一致但整树不一致（可能存在额外文件/新写入）' };
    }
    return { action: 'delete-hot', reason: '冷侧通过基线，热侧为半成品（整树与基线不一致）' };
  }

  async finishRestore(sessionId, entry, src, dst, plan, options) {
    const statResult = await this.statSession(sessionId);
    if (!statResult) {
      this.store.updateSession(sessionId, { status: 'restoring', error: 'stat-missing' });
      return {
        id: sessionId,
        ok: false,
        code: 'stat-missing',
        error: '已恢复到磁盘原位，但 persistence.stat 仍不可见（身份/路径校验未通过）',
        hint: '已恢复到磁盘原位；重建工作区后重试挂回',
      };
    }
    /**
     * P4（FR-P4-5 / I-16）：**class 分域**的唯一一处区别就在「搬回之后」——
     *  - class A：stat 可见 → 官方 unarchiveSession（原件）→ attachSession（尽力）→ hot-restored；
     *  - class S：stat 可见 → 直接 status=hot + restored_at=now + 清 cold_root；
     *    **不调** unarchiveSession（它本就不在归档集合，调了会制造幽灵归档标记）、
     *    **不调** attachSession（它不该进侧栏/工作区记账）。
     * 搬回顺序与基线校验完全复用 §7（上面整段代码一个字节没动）。
     */
    const restoredEntry = this.store.getSession(sessionId) || entry || {};
    if (this.rowClass(restoredEntry, this.archivedIds()) === 'subagent') {
      const now = this.now();
      this.store.updateSession(sessionId, {
        status: 'hot',
        restored_at: now,
        moved_at: null,
        cold_root: null,
        error: null,
      });
      await this.manifest.appendDedup({
        ts: now,
        op: 'restore',
        id: sessionId,
        from: src,
        to: dst,
        bytes: plan.bytes,
        files: plan.files.length,
        sha256: plan.planSha,
        ok: true,
        reason: options.reason || 'manual',
        class: 'subagent',
      });
      await this.markers.remove(sessionId);
      this.emit({ type: 'restore', id: sessionId, class: 'subagent' });
      return { id: sessionId, ok: true, status: 'hot', class: 'subagent', attach: null };
    }
    const original = this.originalOf('unarchiveSession');
    if (!original) {
      this.store.updateSession(sessionId, { status: 'restoring', error: 'unarchive-unavailable' });
      return { id: sessionId, ok: false, code: 'unarchive-unavailable', error: 'workspaceRegistry.unarchiveSession 不可用' };
    }
    try {
      await original(sessionId);
    } catch (err) {
      this.store.updateSession(sessionId, { status: 'restoring', error: 'unarchive-failed: ' + (err && err.message ? err.message : err) });
      return {
        id: sessionId,
        ok: false,
        code: 'unarchive-failed',
        error: '文件已回热目录，但官方取消归档失败（不回滚）：' + (err && err.message ? err.message : err),
        hint: '已恢复到磁盘原位；可重试完成恢复',
      };
    }
    const attach = await this.attachBestEffort(sessionId, entry);
    const now = this.now();
    this.store.updateSession(sessionId, { status: 'hot-restored', restored_at: now, moved_at: null, error: null });
    await this.manifest.appendDedup({
      ts: now,
      op: 'restore',
      id: sessionId,
      from: src,
      to: dst,
      bytes: plan.bytes,
      files: plan.files.length,
      sha256: plan.planSha,
      ok: true,
      reason: options.reason || 'manual',
    });
    await this.markers.remove(sessionId);
    this.emit({ type: 'restore', id: sessionId });
    return { id: sessionId, ok: true, status: 'hot-restored', attach };
  }

  // ---- 收藏（FR-P3-3 / A-P3-3）--------------------------------------------
  /**
   * 收藏 / 取消收藏（幂等：重复设同一个值不产生副作用，只写一次同一列）。
   *
   * 前置：id 已由 HTTP 层过 assertSessionId；value 只按真假归一（true/1/字符串真值都算收藏）。
   * 后置：sessions.favorite = 0|1 落库；列表缓存失效（下一次 /list 立刻按「收藏优先」排序）。
   * 没有 DB 行时（归档目录在盘、但还没入库）先按磁盘事实建行 —— 否则 UI 的星标点了没反应。
   *
   * @returns {Promise<{id:string, ok:boolean, favorite?:number, code?:string, error?:string}>}
   */
  async favorite(id, value) {
    return this.enqueue(async () => {
      const sessionId = String(id);
      const wanted = value ? 1 : 0;
      let entry = this.store.getSession(sessionId);
      if (!entry) {
        const found = await this.findHotDir(sessionId);
        if (!found) {
          return { id: sessionId, ok: false, code: 'unknown-session', error: '找不到会话目录与 DB 行（不建空行）' };
        }
        const row = await this.buildEntryFromDisk(sessionId, found);
        row.favorite = wanted;
        entry = this.store.upsertSession(row);
        this.emit({ type: 'favorite', id: sessionId });
        return { id: sessionId, ok: true, favorite: entry.favorite, created: true };
      }
      if (entry.favorite !== wanted) this.store.updateSession(sessionId, { favorite: wanted });
      this.emit({ type: 'favorite', id: sessionId });
      return { id: sessionId, ok: true, favorite: wanted };
    });
  }

  // ---- 删除 / 回收站（FR-P3-4 / P3-D4 / A-P3-4 / A-P3-7 / A-P3-9）---------
  /**
   * 删除会话（**入口**，全部写操作经单串行队列）。
   *
   * P3-D4 的两条路径：
   *  - **冷会话** ⇒ 搬进 <vaultRoot>/trash/<id>/<ts>/（同卷 rename / 跨卷 copy+基线校验，失败不删源），
   *    写 trash 行（含 row_json 整行快照 + favorite + trashed_at + expires_at=+30d）、删 sessions 行、
   *    manifest op:'trash'、在途 marker trash-<id> + 启动收敛；
   *  - **热会话** ⇒ hidden=1 + manifest op:'hide'，**文件零改动**（热文件属宿主事实源，绝不 unlink）。
   *
   * 前置：id 形状已校验；status ∉ {migrating, restoring, trash}（在途状态一律拒绝，fail-closed）。
   * 后置：见上面两条路径；失败一律不改 DB 行、不删源。
   */
  async deleteSession(id, options = {}) {
    return this.enqueue(() => this.deleteNow(String(id), options));
  }

  async deleteNow(sessionId, options = {}) {
    const cfg = await this.config();
    let entry = this.store.getSession(sessionId);
    if (!entry) {
      const found = await this.findHotDir(sessionId);
      if (!found) return { id: sessionId, ok: false, code: 'unknown-session', error: '找不到会话目录与 DB 行' };
      entry = this.store.upsertSession(await this.buildEntryFromDisk(sessionId, found));
      if (entry.status === 'hot') entry = { ...entry, ...(await this.refreshDiskFields(sessionId, entry, found)) };
    }
    if (entry.status === 'migrating' || entry.status === 'restoring' || entry.status === 'trash') {
      return {
        id: sessionId,
        ok: false,
        code: 'busy',
        error: 'status=' + entry.status + ' 的会话不可删除（在途状态 fail-closed；等它收敛后重试）',
      };
    }
    if (entry.status === 'cold') return this.trashMove(sessionId, entry, options);
    // 热会话（hot / hot-restored）：只隐藏，文件零改动（P3-D4）
    if (entry.hidden) {
      return { id: sessionId, ok: true, code: 'already-hidden', status: 'hidden', hidden: 1, filesUntouched: true };
    }
    const now = this.now();
    this.store.updateSession(sessionId, { hidden: 1, error: null });
    await this.manifest.appendDedup({
      ts: now,
      op: 'hide',
      id: sessionId,
      from: null,
      to: null,
      bytes: entry.bytes || 0,
      files: entry.log_names ? String(entry.log_names).split(',').length : 0,
      sha256: entry.source_sha || '',
      ok: true,
      reason: options.reason || 'manual',
    });
    this.emit({ type: 'hide', id: sessionId });
    return {
      id: sessionId,
      ok: true,
      status: 'hidden',
      hidden: 1,
      filesUntouched: true,
      note: '热会话只置 hidden=1：文件仍在 sessions，还原 = hidden=0（FR-P3-4）',
    };
  }

  /**
   * 冷会话搬进回收站（**全设计里第二处会动文件的地方**；唯一不可逆 unlink 是 purge）。
   *
   * 顺序（§18.4.1 trashMove 伪代码）：
   *  ① hashTree(src) 基线（**必须先于任何搬移**）→ sizeBytes；
   *  ② 写 trash-<id> marker（在途证据）→ DB 行 status='trash'；
   *  ③ 同卷 rename（原子）/ 跨卷 copy+基线校验（**不通过不删源**）；
   *  ④ 复核 dst 与基线一致；
   *  ⑤ 事务：trash 行入库 + 删 sessions 行；⑥ manifest op:'trash'；⑦ 删 marker。
   *
   * 失败方向：src 还在 ⇒ 删掉 dst/partial 残留、行回 cold、error='trash-failed: …'，**源一个字节不动**；
   *          src 已不在 ⇒ 目标已验证则保持 marker 等启动收敛（不回滚），否则 needs-review + 保留 marker。
   */
  async trashMove(sessionId, entry, options = {}) {
    const cfg = await this.config();
    const coldRoot = entry.cold_root || effectiveColdRoot(cfg, this.paths);
    this._coldRoots.add(coldRoot);
    // 防御：rel_dir 为空会让 path.join 退化成「整个冷根」——那是绝对不会被搬走/删除的东西。
    if (!entry.rel_dir) {
      return { id: sessionId, ok: false, code: 'invalid-row', error: 'DB 行的 rel_dir 为空：拒绝搬移（fail-closed，未做任何改动）' };
    }
    const src = path.join(coldRoot, entry.rel_dir);
    if (!(await isDirectory(src))) {
      this.store.updateSession(sessionId, { error: ERROR_STATES.LOST });
      return {
        id: sessionId,
        ok: false,
        code: 'source-missing',
        error: '冷目录不存在：' + src + '（已标 lost；未移动、未删除任何数据）',
      };
    }
    const baseline = await hashTree(src);
    const now = this.now();
    const trashedAt = now;
    const expiresAt = now + TRASH_RETENTION_MS;
    const dst = path.join(this.paths.trashRoot, sessionId, String(trashedAt));
    const marker = {
      op: 'trash',
      phase: 'planned',
      sessionId,
      src,
      dst,
      coldRoot,
      relDir: entry.rel_dir,
      sha256: baseline.sha256,
      files: baseline.files,
      bytes: baseline.bytes,
      trashedAt,
      expiresAt,
      favorite: entry.favorite ? 1 : 0,
      // 尾段崩溃收敛需要整行快照：marker 里存一份（约 1-2 KB），否则「文件已进回收站但 DB 行没了」不可续。
      rowJson: JSON.stringify(entry),
      reason: options.reason || 'manual',
    };
    const markerName = TRASH_MARKER_PREFIX + sessionId;
    this.store.updateSession(sessionId, { status: 'trash', error: null });
    try {
      await this.markers.write(markerName, marker);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.store.updateSession(sessionId, { status: 'cold', error: 'marker-failed: ' + message });
      return { id: sessionId, ok: false, code: 'marker-failed', error: 'marker 写入失败，已回滚为 cold（源未动）：' + message };
    }
    try {
      await this.mkdirp(path.dirname(dst));
      const sameVol = await this.sameVolume(src, dst);
      if (sameVol) {
        await this.renamePath(src, dst);
      } else {
        // 跨卷：先落到 .partial，按基线校验通过再换正式名，**最后**才删源（§11 允许删源的唯一条件）。
        const partial = dst + '.partial';
        await this.copyTree(src, partial);
        const partialCheck = await this.verifyBaseline(partial, { planSha: baseline.sha256, files: baseline.files, bytes: baseline.bytes });
        if (!partialCheck.ok) {
          throw new EngineFailure('verify-failed', '跨卷拷贝校验失败（.partial 与基线不一致：' + (partialCheck.reason || 'unknown') + '）');
        }
        await this.renamePath(partial, dst);
        const dstCheck = await this.verifyBaseline(dst, { planSha: baseline.sha256 });
        if (!dstCheck.ok) {
          throw new EngineFailure('verify-failed', '落盘后校验失败（dst 与基线不一致：' + (dstCheck.reason || 'unknown') + '）');
        }
        await this.removeTree(src);
      }
      const finalCheck = await this.verifyBaseline(dst, { planSha: baseline.sha256 });
      if (!finalCheck.ok) {
        throw new EngineFailure('baseline-mismatch', '回收站副本与基线不一致：' + (finalCheck.reason || 'unknown'));
      }
      const row = await this.completeTrashTail(sessionId, marker, entry);
      await this.markers.remove(markerName).catch(() => {});
      this.emit({ type: 'trash', id: sessionId });
      return {
        id: sessionId,
        ok: true,
        status: 'trash',
        trashPath: dst,
        sha256: baseline.sha256,
        bytes: baseline.bytes,
        trashedAt,
        expiresAt,
        favorite: row ? row.favorite : entry.favorite ? 1 : 0,
        retentionDays: Math.round(TRASH_RETENTION_MS / 86400000),
      };
    } catch (err) {
      return this.handleTrashFailure(sessionId, err, { src, dst, marker, markerName, baseline, entry });
    }
  }

  /**
   * 回收站搬移失败的三分支（与 handleMigrateFailure 同口径：**绝不删唯一副本**）。
   */
  async handleTrashFailure(sessionId, err, context) {
    const message = err && err.message ? err.message : String(err);
    const code = err && err.code ? err.code : 'trash-failed';
    const srcExists = await isDirectory(context.src);
    const dstExists = await isDirectory(context.dst);
    if (srcExists) {
      // 源还在：目标是残留（copy/partial 或已落名的副本），删掉即可重试 —— 源是唯一合格副本。
      await this.removeTree(context.dst + '.partial').catch(() => {});
      if (dstExists) await this.removeTree(context.dst).catch(() => {});
      await this.markers.remove(context.markerName).catch(() => {});
      this.store.updateSession(sessionId, { status: 'cold', error: 'trash-failed: ' + message });
      return { id: sessionId, ok: false, code, error: '删除失败（源完整保留，可重试）：' + message, rolledBack: true };
    }
    if (dstExists) {
      const check = await this.verifyBaseline(context.dst, { planSha: context.baseline.sha256 });
      if (check.ok) {
        // 文件已进回收站、只是尾段没写完：保持 marker，启动收敛会补完（不回滚、不删源）。
        this.store.updateSession(sessionId, { status: 'trash', error: 'recovery-pending: ' + message });
        return {
          id: sessionId,
          ok: false,
          code: 'recovery-pending',
          error: '搬移已完成但收尾失败，已保持 marker，下次启动续跑（文件不会被删）：' + message,
        };
      }
      this.store.updateSession(sessionId, { status: 'trash', error: ERROR_STATES.NEEDS_REVIEW });
      return {
        id: sessionId,
        ok: false,
        code: ERROR_STATES.NEEDS_REVIEW,
        error: '回收站副本未通过基线校验：保留现场与 marker，人工处置（不删任何一份）：' + message,
      };
    }
    this.store.updateSession(sessionId, { status: 'trash', error: ERROR_STATES.LOST });
    return { id: sessionId, ok: false, code: ERROR_STATES.LOST, error: '冷目录与回收站目录都不存在，已标 lost 并保留 marker：' + message };
  }

  /**
   * trash 尾段（marker 驱动的收敛与正常路径**共用同一段代码**）：
   * trash 行入库 + 删 sessions 行（单事务）→ manifest op:'trash' → 清索引水位（恢复后才会重索引）。
   */
  async completeTrashTail(sessionId, marker, rowSnapshot = null) {
    const now = this.now();
    const trashedAt = Number(marker.trashedAt) || now;
    const expiresAt = Number(marker.expiresAt) || trashedAt + TRASH_RETENTION_MS;
    let snapshot = rowSnapshot;
    if (!snapshot) {
      try {
        snapshot = marker.rowJson ? JSON.parse(marker.rowJson) : null;
      } catch {
        snapshot = null;
      }
    }
    if (!snapshot) snapshot = this.store.getSession(sessionId) || {};
    const row = this.store.trashSession({
      session_id: sessionId,
      sha256: String(marker.sha256 || ''),
      size_bytes: Number(marker.bytes) || 0,
      favorite: snapshot && snapshot.favorite ? 1 : 0,
      row_json: JSON.stringify(snapshot),
      cold_root: marker.coldRoot || (snapshot && snapshot.cold_root) || null,
      rel_dir: marker.relDir || (snapshot && snapshot.rel_dir) || '',
      trashed_at: trashedAt,
      expires_at: expiresAt,
    });
    // 索引水位必须清掉：docs 已随 sessions 行删除，若水位留着，还原后 indexer 会认定「未变 ⇒ 不用重索引」。
    this.clearDerivedMeta(sessionId);
    await this.manifest.appendDedup({
      ts: now,
      op: 'trash',
      id: sessionId,
      from: marker.src || null,
      to: marker.dst || null,
      bytes: Number(marker.bytes) || 0,
      files: Array.isArray(marker.files) ? marker.files.length : 0,
      sha256: String(marker.sha256 || ''),
      ok: true,
      reason: marker.reason || 'boot-resume',
    });
    this.invalidate();
    return row;
  }

  /** 清掉某会话的派生 meta（索引水位 / scope 标记 / 跳号诊断）：它们描述的是**已不存在的 docs**。 */
  clearDerivedMeta(sessionId) {
    const id = String(sessionId);
    for (const key of [WATERMARK_META_PREFIX + id, TOOL_SCOPE_META_PREFIX + id, 'seq-gap:' + id, 'torn:' + id, 'legacy:' + id, 'tool:' + id]) {
      try {
        this.store.deleteMeta(key);
      } catch {
        /* 清理失败不影响数据安全（只是一条派生读数） */
      }
    }
  }

  /**
   * 回收站列表（**只读**；不恢复、不删除、不动到期的任何文件 —— A-P3-9）。
   *
   * 两类条目：
   *  - kind='trash'  ：trash 表里的行（文件已在 <vaultRoot>/trash/<id>/<ts>/，可以还原或彻底删除）；
   *  - kind='hidden' ：热会话删除后的 hidden=1 行（文件仍在 sessions，还原 = hidden=0）。
   *    「恢复即 hidden=0」（FR-P3-4）必须有一个看得见的入口，否则热删除变成不可逆 —— 这就是它。
   */
  trashList(options = {}) {
    const now = this.now();
    const retentionDays = Math.round(TRASH_RETENTION_MS / 86400000);
    const items = this.store.listTrash(options).map((row) => {
      let snapshot = {};
      try {
        snapshot = row.row_json ? JSON.parse(row.row_json) : {};
      } catch {
        snapshot = {};
      }
      const expiresInMs = row.expires_at ? row.expires_at - now : null;
      return {
        id: row.session_id,
        kind: 'trash',
        title: snapshot.title || snapshot.first_user_text || '（无标题）',
        workspace: this.workspaceLabel(snapshot.project_key, snapshot.header_cwd),
        projectKey: snapshot.project_key || '',
        status: 'trash',
        sizeBytes: row.size_bytes || 0,
        favorite: row.favorite ? 1 : 0,
        sha256: row.sha256 || '',
        coldRoot: row.cold_root || null,
        relDir: row.rel_dir || '',
        trashedAt: row.trashed_at || null,
        expiresAt: row.expires_at || null,
        expired: Boolean(row.expires_at && now >= row.expires_at),
        expiresInDays: expiresInMs === null ? null : Math.floor(expiresInMs / 86400000),
        trashPath: path.join(this.paths.trashRoot, String(row.session_id), String(row.trashed_at || '')),
        next: 'trash-restore | trash-purge（需 confirm:true）',
      };
    });
    const hidden = this.store
      .listSessions({ hidden: true })
      .filter((row) => row.hidden)
      .map((row) => ({
        id: row.session_id,
        kind: 'hidden',
        title: row.title || row.first_user_text || '（无标题）',
        workspace: this.workspaceLabel(row.project_key, row.header_cwd),
        projectKey: row.project_key,
        status: 'hidden',
        sizeBytes: row.bytes || 0,
        favorite: row.favorite ? 1 : 0,
        sha256: row.source_sha || '',
        coldRoot: row.cold_root || null,
        relDir: row.rel_dir || '',
        trashedAt: null,
        expiresAt: null,
        expired: false,
        expiresInDays: null,
        trashPath: null,
        next: 'trash-restore（hidden=0，文件零改动）',
      }));
    const expired = items.filter((item) => item.expired);
    return {
      items,
      hidden,
      count: items.length + hidden.length,
      trashCount: items.length,
      hiddenCount: hidden.length,
      expiredCount: expired.length,
      expiredIds: expired.map((item) => item.id),
      retentionDays,
      trashRoot: this.paths.trashRoot,
      now,
      note:
        '保留 ' + retentionDays + ' 天；到期只提示、**不会**自动删除（P3-D5 / A-P3-9）。' +
        '彻底删除必须 trash-purge 且带 confirm:true，且只删回收站根内的目录。',
    };
  }

  /**
   * 回收站还原（FR-P3-4 / A-P3-4）。
   *
   * 冷会话路径：trash.sha256 基线校验 → 搬回原冷目录（同卷 rename / 跨卷 copy+校验）→
   * row_json **整行回填**（保留 favorite、hidden=0）→ 删 trash 行 → manifest op:'trash-restore'。
   * 校验不通过 ⇒ needs-review，不搬、不删（fail-closed）。
   * 热会话路径（kind=hidden）：hidden=0 + manifest op:'unhide'（文件零改动）。
   */
  async trashRestore(id, options = {}) {
    return this.enqueue(() => this.trashRestoreNow(String(id), options));
  }

  async trashRestoreNow(sessionId, options = {}) {
    const row = this.store.getTrashRow(sessionId);
    const cfg = await this.config();
    if (!row) {
      const entry = this.store.getSession(sessionId);
      if (entry && entry.hidden) {
        const now = this.now();
        this.store.updateSession(sessionId, { hidden: 0, error: null });
        await this.manifest.appendDedup({
          ts: now,
          op: 'unhide',
          id: sessionId,
          from: null,
          to: null,
          bytes: entry.bytes || 0,
          files: 0,
          sha256: entry.source_sha || '',
          ok: true,
          reason: options.reason || 'manual',
        });
        this.emit({ type: 'unhide', id: sessionId });
        return { id: sessionId, ok: true, status: entry.status, hidden: 0, filesUntouched: true, code: 'unhidden' };
      }
      if (entry) return { id: sessionId, ok: true, code: 'already-restored', status: entry.status };
      return { id: sessionId, ok: false, code: 'not-in-trash', error: '回收站里没有该会话（也找不到 hidden 行）' };
    }
    if (!row.rel_dir) {
      return { id: sessionId, ok: false, code: 'invalid-row', error: 'trash 行的 rel_dir 为空：拒绝还原（fail-closed，未做任何改动）' };
    }
    const coldRoot = row.cold_root || effectiveColdRoot(cfg, this.paths);
    this._coldRoots.add(coldRoot);
    const src = path.join(this.paths.trashRoot, sessionId, String(row.trashed_at));
    const dst = path.join(coldRoot, row.rel_dir);
    const srcExists = await isDirectory(src);
    const dstExists = await isDirectory(dst);
    if (!srcExists && !dstExists) {
      return {
        id: sessionId,
        ok: false,
        code: ERROR_STATES.LOST,
        error: '回收站目录与目标冷目录都不存在：已保留 trash 行，未删除任何数据（人工处置）',
      };
    }
    if (!row.sha256) {
      return {
        id: sessionId,
        ok: false,
        code: ERROR_STATES.NEEDS_REVIEW,
        error: 'trash 行没有 sha256 基线：拒绝搬回（无基线的副本不可信）',
      };
    }
    if (srcExists && dstExists) {
      /**
       * 双份（回收站 + 冷目录都在）：上一次还原搬完了文件但没写完 DB（或反过来）。
       * 判据只看基线（与 restore 的重复判定同口径）：
       *  - 冷侧通过 trash.sha256 ⇒ 文件已在原位：清掉回收站副本（**唯一允许删源的路径**）并补 DB；
       *  - 冷侧不通过 ⇒ 不能删任何一侧（needs-review，人工处置）。
       */
      const hotCheck = await this.verifyBaseline(dst, { planSha: row.sha256 });
      if (!hotCheck.ok) {
        return {
          id: sessionId,
          ok: false,
          code: ERROR_STATES.NEEDS_REVIEW,
          error:
            '回收站副本与冷目录同时存在，且冷侧未通过 trash.sha256 基线校验（' + (hotCheck.reason || 'unknown') +
            '）：双份保留，人工处置（自动例程永不删源）',
        };
      }
      await this.removeTree(src);
    }
    if (srcExists && !dstExists) {
      const check = await this.verifyBaseline(src, { planSha: row.sha256 });
      if (!check.ok) {
        return {
          id: sessionId,
          ok: false,
          code: ERROR_STATES.NEEDS_REVIEW,
          error: '回收站副本未通过 trash.sha256 基线校验（' + (check.reason || 'unknown') + '）：未搬移、未删除',
        };
      }
      try {
        await this.mkdirp(path.dirname(dst));
        const sameVol = await this.sameVolume(src, dst);
        if (sameVol) {
          await this.renamePath(src, dst);
        } else {
          await this.copyTree(src, dst);
          const after = await this.verifyBaseline(dst, { planSha: row.sha256 });
          if (!after.ok) {
            throw new EngineFailure('verify-failed', '跨卷还原校验失败（目标与 trash 基线不一致：' + (after.reason || 'unknown') + '）');
          }
          await this.removeTree(src);
        }
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        // 目标没落成 ⇒ 清掉半成品（源是唯一合格副本）；已落成的失败保持原地，可重试。
        return {
          id: sessionId,
          ok: false,
          code: err && err.code ? err.code : 'move-failed',
          error: '搬回冷目录失败（回收站副本保留，可重试）：' + message,
        };
      }
    } else {
      const check = await this.verifyBaseline(dst, { planSha: row.sha256 });
      if (!check.ok) {
        return {
          id: sessionId,
          ok: false,
          code: ERROR_STATES.NEEDS_REVIEW,
          error: '回收站目录已不在、冷目录未通过基线校验（' + (check.reason || 'unknown') + '）：保留现场，人工处置',
        };
      }
    }
    let snapshot;
    try {
      snapshot = row.row_json ? JSON.parse(row.row_json) : null;
    } catch {
      snapshot = null;
    }
    if (!snapshot || typeof snapshot !== 'object') {
      return {
        id: sessionId,
        ok: false,
        code: ERROR_STATES.NEEDS_REVIEW,
        error: 'trash.row_json 不可解析：无法整行回填（文件已搬回冷目录，trash 行保留）',
      };
    }
    const now = this.now();
    const restored = {
      ...snapshot,
      session_id: sessionId,
      cold_root: coldRoot,
      rel_dir: row.rel_dir || snapshot.rel_dir,
      status: 'cold',
      hidden: 0,
      favorite: row.favorite ? 1 : 0,
      error: null,
      next_attempt: null,
      moved_at: snapshot.moved_at || now,
      restored_at: null,
    };
    this.store.restoreSessionFromTrash(restored);
    // 水位已清 ⇒ indexer 下一轮会把恢复回来的会话重新抽进索引；清 scope 标记避免跳过抽取。
    this.clearDerivedMeta(sessionId);
    await this.manifest.appendDedup({
      ts: now,
      op: 'trash-restore',
      id: sessionId,
      from: src,
      to: dst,
      bytes: row.size_bytes || 0,
      files: snapshot.log_names ? String(snapshot.log_names).split(',').length : 0,
      sha256: row.sha256,
      ok: true,
      reason: options.reason || 'manual',
    });
    await this.markers.remove(TRASH_MARKER_PREFIX + sessionId).catch(() => {});
    this.emit({ type: 'trash-restore', id: sessionId });
    return {
      id: sessionId,
      ok: true,
      status: 'cold',
      path: dst,
      sha256: row.sha256,
      favorite: restored.favorite,
      note: '整行按 row_json 回填；文件已按 trash.sha256 校验后搬回冷目录',
    };
  }

  /**
   * 彻底删除（**全设计唯一不可逆 unlink**：I-12 / A-P3-7）。
   *
   * 三重门：① confirm 必须严格为 true；② 目标必须 resolve 后落在 trash 根**之内**（且不是根本身）；
   * ③ trash 行必须存在（hidden 热会话的文件属宿主事实源，**永不**在此删除）。
   * 任一门不过 ⇒ 零写入。
   */
  async trashPurge(id, options = {}) {
    return this.enqueue(() => this.trashPurgeNow(String(id), options));
  }

  async trashPurgeNow(sessionId, options = {}) {
    if (options.confirm !== true) {
      return {
        id: sessionId,
        ok: false,
        code: 'confirm-required',
        error: '彻底删除必须显式 confirm:true（无 confirm 零写入：I-12 / A-P3-7）',
        writes: 0,
      };
    }
    const row = this.store.getTrashRow(sessionId);
    if (!row) {
      const entry = this.store.getSession(sessionId);
      return {
        id: sessionId,
        ok: false,
        code: entry && entry.hidden ? 'hidden-not-purgeable' : 'not-in-trash',
        error:
          entry && entry.hidden
            ? 'hidden=1 的热会话文件仍在 sessions（宿主事实源）：本插件不删除它；请先「还原」（hidden=0）后自行处置'
            : '回收站里没有该会话：零写入',
        writes: 0,
      };
    }
    const trashRoot = path.resolve(this.paths.trashRoot);
    const target = path.resolve(trashRoot, sessionId);
    const inside = target !== trashRoot && isPathInside(target, trashRoot);
    if (!inside) {
      return { id: sessionId, ok: false, code: 'outside-trash-root', error: '目标不在回收站根内，拒绝删除：' + target, writes: 0 };
    }
    const exists = await isDirectory(target);
    if (exists) await this.removeTree(target);
    this.store.deleteTrash(sessionId);
    this.clearDerivedMeta(sessionId);
    await this.manifest.appendDedup({
      ts: this.now(),
      op: 'purge',
      id: sessionId,
      from: target,
      to: null,
      bytes: row.size_bytes || 0,
      files: 0,
      sha256: row.sha256 || '',
      ok: true,
      reason: options.reason || 'manual',
    });
    await this.markers.remove(TRASH_MARKER_PREFIX + sessionId).catch(() => {});
    this.emit({ type: 'purge', id: sessionId });
    return { id: sessionId, ok: true, status: 'purged', removed: exists, path: target, writes: exists ? 1 : 0 };
  }

  // ---- 冷索引 -----------------------------------------------------------
  async collectIndex(sessionId, dir, meta) {
    const logNames = meta.logNames ? String(meta.logNames).split(',').filter(Boolean) : [];
    // 兜底也必须是**最高代际**（§4.2 / R-11：只索引最高代际）。旧实现取 filter(...)[0]，
    // 拿到的只是 readdir 顺序里的第一个（v3+v4 目录 ⇒ v3），marker 缺 logNames 的续跑/冷根导入路径会索引错代。
    const currentGeneration =
      meta.currentGeneration ||
      sortGenerations(logNames).slice(-1)[0] ||
      sortGenerations((await listDirFiles(dir)).map((e) => e.name).filter(isGenerationName)).slice(-1)[0];
    if (!currentGeneration) {
      return { ok: false, error: ERROR_STATES.EXTRACT_EMPTY, docs: [], stats: emptyStats(), detail: '没有可读代际文件' };
    }
    // 代际版本决定 user/message 的抽取规则（A-22：v0/v3 旧格式没有 source 字段，不能按 v4 fail-closed）。
    const explicitVersion = meta.formatVersion === undefined || meta.formatVersion === null ? null : Number(meta.formatVersion);
    const formatVersion = explicitVersion === null ? generationVersion(currentGeneration) : explicitVersion;
    const legacy = isLegacyFormat(formatVersion);
    // P3 / FR-P3-2：抽取范围。显式给了 meta.toolResults 就按它（indexer 的升级 pass 走这条）；
    // 没给（迁移尾段 / 重建索引）则跟随**库内实际 scope**，不会把 tool 文档偷偷写进 body 库。
    const toolResults =
      meta.toolResults === true ||
      (meta.toolResults === undefined && this.librarySearchScope() === SEARCH_SCOPE_TOOL_RESULTS);
    const file = path.join(dir, currentGeneration);
    const docs = [];
    const stats = emptyStats();
    let tornTail = false;
    // R-17 seq 跳号（诊断面，不拒收）：统计**整条事件流**里出现过的 seq（去重）与重复次数。
    const eventSeqs = new Set();
    let seqEvents = 0;
    let seqDuplicates = 0;
    try {
      const result = await forEachJsonLine(
        file,
        async (line) => {
          const parsed = parseLine(line);
          if (!parsed.ok) {
            stats.lines += 1;
            if (parsed.empty) stats.unknownLines += 1;
            else stats.invalidJson += 1;
            return;
          }
          const extracted = extractEvent(parsed.value, docs.length, { legacy, toolResults });
          for (const key of Object.keys(extracted.stats)) stats[key] = (stats[key] || 0) + extracted.stats[key];
          for (const doc of extracted.docs) docs.push(doc);
          const rawSeq = parsed.value && typeof parsed.value.seq === 'number' && Number.isFinite(parsed.value.seq)
            ? Math.trunc(parsed.value.seq)
            : null;
          if (rawSeq !== null) {
            seqEvents += 1;
            if (eventSeqs.has(rawSeq)) seqDuplicates += 1;
            else eventSeqs.add(rawSeq);
          }
        },
        { yieldEveryFrames: 256, yieldEveryBytes: 16 * 1024 * 1024 },
      );
      tornTail = result.tornStart !== null;
    } catch (err) {
      return {
        ok: false,
        error: err && err.code === 'frame-corrupt' ? ERROR_STATES.FRAME_CORRUPT : 'index-failed',
        docs: [],
        stats,
        seq: null,
        detail: err && err.message ? err.message : String(err),
      };
    }
    const seq = buildSeqGapReport({ sequences: [...eventSeqs], docs, events: seqEvents, duplicates: seqDuplicates });
    return { ok: true, docs, stats, seq, empty: docs.length === 0 && stats.lines > 0, tornTail, currentGeneration, formatVersion, legacy, toolResults };
  }

  async indexSession(sessionId, dir, meta) {
    const collected = await this.collectIndex(sessionId, dir, meta);
    const now = this.now();
    if (!collected.ok) {
      this.store.updateSession(sessionId, { error: collected.error, indexed_at: null });
      return { ok: false, error: collected.error, detail: collected.detail };
    }
    if (collected.empty) {
      this.store.replaceDocs(sessionId, []);
      this.store.updateSession(sessionId, { error: ERROR_STATES.EXTRACT_EMPTY, indexed_at: now });
      return { ok: false, error: ERROR_STATES.EXTRACT_EMPTY, detail: 'docs==0 且 lines>0（打包行/未知事件形态，R-17）' };
    }
    this.store.replaceDocs(sessionId, collected.docs);
    const titleDoc = [...collected.docs].reverse().find((doc) => doc.type === 'title');
    const firstUser = collected.docs.find((doc) => doc.type === 'user');
    const assistants = collected.docs.filter((doc) => doc.type === 'assistant');
    const patch = {
      title: titleDoc ? titleDoc.text.slice(0, 200) : (firstUser ? firstUser.text.slice(0, 80) : ''),
      user_msgs: collected.stats.userMsgs,
      assistant_msgs: collected.stats.assistantMsgs,
      first_user_text: firstUser ? firstUser.text.slice(0, 200) : '',
      last_assistant_text: assistants.length ? assistants[assistants.length - 1].text.slice(0, 200) : '',
      indexed_at: now,
      error: null,
    };
    // R-17：seq 跳号**只做诊断**——docs 已落库、indexed_at 已置，绝不因为跳号整会话拒收（§4.2）。
    // 事件流缺口 > 阈值才写进 error（status/recentErrors 是诊断面的读口）；否则只进 meta。
    const seqReport = collected.seq || null;
    if (seqReport && seqReport.ratio > SEQ_GAP_ALERT_RATIO) {
      patch.error = 'seq-gap: ' + seqReport.gaps + '/' + seqReport.expected + '（' + Math.round(seqReport.ratio * 100) + '%）';
    }
    this.store.updateSession(sessionId, patch);
    if (collected.tornTail) this.store.setMeta('torn:' + sessionId, String(now));
    if (collected.legacy) this.store.setMeta('legacy:' + sessionId, String(collected.formatVersion));
    if (seqReport) this.store.setMeta('seq-gap:' + sessionId, JSON.stringify(seqReport));
    return {
      ok: true,
      docs: collected.docs.length,
      tornTail: collected.tornTail,
      seq: seqReport,
      stats: collected.stats,
      formatVersion: collected.formatVersion,
      legacy: collected.legacy,
    };
  }

  async rebuildIndex(ids) {
    return this.enqueue(async () => {
      const targets = ids && ids.length ? ids.map(String) : this.store
        .listSessions({ status: ['cold', 'hot-restored', 'hot'] })
        .filter((row) => row.indexed_at === null || row.error)
        .map((row) => row.session_id);
      const results = [];
      for (const sessionId of targets) {
        try {
          const entry = this.store.getSession(sessionId);
          if (!entry) {
            results.push({ id: sessionId, ok: false, error: 'no-row' });
            continue;
          }
          let dir;
          if (entry.status === 'cold') dir = path.join(entry.cold_root || (await this.coldRoot()), entry.rel_dir);
          else dir = path.join(this.paths.sessionsRoot, entry.rel_dir);
          if (!(await isDirectory(dir))) {
            this.store.updateSession(sessionId, { error: ERROR_STATES.LOST });
            results.push({ id: sessionId, ok: false, error: ERROR_STATES.LOST });
            continue;
          }
          const index = await this.indexSession(sessionId, dir, {
            logNames: entry.log_names,
            currentGeneration: sortGenerations(String(entry.log_names || '').split(',')).slice(-1)[0],
            formatVersion: entry.format_version,
            // 重建索引跟随库内 scope（不传 undefined 以免与「迁移尾段跟随库内 scope」两条路径分叉）
            toolResults: this.librarySearchScope() === SEARCH_SCOPE_TOOL_RESULTS,
          });
          results.push({ id: sessionId, ok: index.ok, error: index.error || null, docs: index.docs || 0 });
        } catch (err) {
          results.push({ id: sessionId, ok: false, error: err && err.message ? err.message : String(err) });
        }
      }
      return { results, rebuilt: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length };
    });
  }

  // ---- 检索范围（P3 / FR-P3-2） ----------------------------------------
  /**
   * **库内实际**检索范围（meta `index:scope`）。与配置的 searchScope 可以短暂不一致：
   * 升级 pass 在跑时库内仍是旧值（旧 scope 保持可查，FR-P3-2 的后置条件）。
   */
  librarySearchScope() {
    try {
      const raw = this.store.getMeta(SEARCH_SCOPE_META);
      return SEARCH_SCOPES.includes(raw) ? raw : DEFAULT_SEARCH_SCOPE;
    } catch {
      return DEFAULT_SEARCH_SCOPE;
    }
  }

  /**
   * /status 的 scope 段：searchScope（配置）+ libraryScope（库内）+ 升级 pass 的 phase/paused/done。
   * 索引进度与 scope 进度**分开给**：indexer 未实例化时也要有可读读数（不返回 null）。
   */
  scopeSnapshot(desiredScope) {
    let libraryScope = DEFAULT_SEARCH_SCOPE;
    try {
      libraryScope = this.librarySearchScope();
    } catch {
      libraryScope = DEFAULT_SEARCH_SCOPE;
    }
    let snap = null;
    try {
      if (this.indexer && typeof this.indexer.scopeSnapshot === 'function') snap = this.indexer.scopeSnapshot();
    } catch {
      snap = null;
    }
    const base = snap && typeof snap === 'object'
      ? snap
      : {
          phase: 'idle',
          paused: false,
          done: false,
          doneWithGaps: false,
          target: null,
          indexed: 0,
          skipped: 0,
          failed: 0,
          total: 0,
          // M1：索引器未实例化时也必须给 gaps 读数（面板黄条读它），不能是 undefined。
          round: 0,
          maxRounds: SCOPE_MAX_ROUNDS,
          gaps: [],
          gapsCount: 0,
          startedAt: null,
          updatedAt: null,
          errors: [],
        };
    const searchScope = SEARCH_SCOPES.includes(desiredScope) ? desiredScope : libraryScope;
    return { ...base, searchScope, libraryScope };
  }

  // ---- 列表 / 统计 / 候选 ----------------------------------------------
  /**
   * 索引 schema 读数（M3 + P3b.1）：索引器在场就照抄它的 schemaSnapshot()（含 rebuilding + gaps）；
   * 索引器还没实例化时自己读 meta 'index:schema' / 'index:schema-gaps' —— 键、常量和解析都来自
   * config.js（`indexSchemaSnapshotFrom`），不是两处手抄。
   *
   * 后置（与 indexer 同一口径）：`rebuildNeeded` 只看版本（**有 gaps 也不重建**）；
   * `doneWithGaps` = 版本已完成且有未覆盖会话（UI 黄条判据）。
   */
  indexSchemaSnapshot() {
    let state = null;
    try {
      if (this.indexer && typeof this.indexer.schemaSnapshot === 'function') {
        const snap = this.indexer.schemaSnapshot();
        return {
          schema: snap.schema,
          schemaStored: snap.stored,
          rebuildNeeded: snap.rebuildNeeded,
          schemaRebuilding: Boolean(snap.rebuilding),
          gaps: Array.isArray(snap.gaps) ? snap.gaps : [],
          gapsCount: Number.isFinite(Number(snap.gapsCount)) ? Number(snap.gapsCount) : 0,
          doneWithGaps: Boolean(snap.doneWithGaps),
        };
      }
    } catch {
      /* 索引器异常不影响 status */
    }
    try {
      state = indexSchemaSnapshotFrom(this.store);
    } catch {
      state = null;
    }
    if (!state) {
      state = { schema: INDEX_SCHEMA_VERSION, stored: null, rebuildNeeded: true, gaps: [], gapsCount: 0, doneWithGaps: false };
    }
    return {
      schema: state.schema,
      schemaStored: state.stored,
      rebuildNeeded: state.rebuildNeeded,
      schemaRebuilding: false,
      gaps: state.gaps,
      gapsCount: state.gapsCount,
      doneWithGaps: state.doneWithGaps,
    };
  }

  /** 索引进度快照（indexer 由 http 层惰性挂到 engine.indexer；没有就走 store 的静态读数）。 */
  indexSnapshot() {
    try {
      if (this.indexer && typeof this.indexer.progress === 'function') {
        // M3：/status.index 必须带 schema / schemaStored / rebuildNeeded（索引 schema 版本读数）。
        return { ...this.indexer.progress(), ...this.indexSchemaSnapshot() };
      }
    } catch {
      /* 索引器异常不影响 status */
    }
    let counts = { total: 0, indexed: 0, coverage: 0 };
    try {
      counts = this.store.indexStats();
    } catch {
      /* ignore */
    }
    // §15.1 #6：索引器还没在本进程里实例化时，读 meta 的**持久化读数**（进度 / 暂停跨重启可见）。
    // 键与 indexer.INDEX_PROGRESS_META 同一个字符串（engine 不能 import indexer：indexer 已经 import engine）。
    let persisted = null;
    try {
      const raw = this.store.getMeta('index:progress');
      if (raw) persisted = JSON.parse(raw);
    } catch {
      persisted = null;
    }
    // F5（真机读数误导）：indexed / total / skipped 是**上一轮/本轮任务**的计数（persisted 即上一进程），
    // 它回答不了「到底有多少会话能搜到」。所以这里固定给出三个不同口径的字段：
    //   coverage      = docs 侧 distinct session_id（**真实覆盖面**，运维/UI 用这个）
    //   indexedThisRun= 本进程这一轮真正索引成功的会话数（persisted 时恒 0：不是本轮）
    //   indexed/total = 任务计数（保留向后兼容；total 是**目标集**大小，不是会话总数）
    return {
      phase: persisted && typeof persisted.phase === 'string' ? persisted.phase : 'idle',
      paused: Boolean(persisted && persisted.paused),
      indexed: persisted && Number.isFinite(Number(persisted.indexed)) ? Number(persisted.indexed) : counts.indexed,
      indexedThisRun: 0,
      coverage: counts.coverage || 0,
      total: persisted && Number.isFinite(Number(persisted.total)) ? Number(persisted.total) : counts.total,
      skipped: persisted && Number.isFinite(Number(persisted.skipped)) ? Number(persisted.skipped) : 0,
      failed: persisted && Number.isFinite(Number(persisted.failed)) ? Number(persisted.failed) : 0,
      errors: persisted && Array.isArray(persisted.errors) ? persisted.errors.slice(-5) : [],
      persisted: Boolean(persisted),
      // M3：索引器未实例化时也必须给 schema 读数（从 meta 直接算，不冒充「需要重建」）。
      ...this.indexSchemaSnapshot(),
    };
  }

  /**
   * 清扫快照（Sweeper 由 index.js 挂到 engine.sweeper）。
   *
   * F1（真机：重启 7 小时后 /status.sweep 仍是 null）：未挂上时**不再返回 null**。
   * 现在返回显式的「未挂载」对象（attached:false + 错误原因 + 已尝试次数 + 下次重试时刻），
   * 运维能在 /status 上直接看到「为什么没有清扫」，而不是把 null 读成「没有这个概念」。
   */
  sweepSnapshot() {
    try {
      if (this.sweeper && typeof this.sweeper.snapshot === 'function') {
        return { ...this.sweeper.snapshot(), attached: true };
      }
    } catch (err) {
      return this.unattachedSweep('Sweeper 快照读取失败：' + (err && err.message ? err.message : err));
    }
    return this.unattachedSweep(null);
  }

  /**
   * 未挂上 Sweeper 时的显式读数（F1）。**唯一实现**在模块级 `unattachedSweepPayload`：
   * P2.4 🔵 #3 —— 旧实现在 engine 与 http 各写一份，字段已经漂移（engine 的 error/sweepError 可为 null，
   * http 恒给默认原因），同一次「没挂上」在两条路径上读数不一致。
   * budget.used 从 meta 同步读（跨重启不丢），limit 未知给 null（不伪造一个数字）。
   */
  unattachedSweep(error) {
    const now = this.now();
    const day = new Date(now).toISOString().slice(0, 10);
    let used = 0;
    try {
      used = Number(this.store.getMeta('sweep:budget:' + day, '0')) || 0;
    } catch {
      used = 0;
    }
    return unattachedSweepPayload(this.sweepAttach || {}, { error, now, budget: { day, used } });
  }

  workspaceLabel(projectKeyValue, cwd) {
    if (cwd) {
      const base = path.basename(String(cwd));
      if (base) return base;
    }
    const trimmed = String(projectKeyValue || '').replace(/^--/, '').replace(/--$/, '');
    const parts = trimmed.split('-').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '未知工作区';
  }

  toItem(row, status) {
    // P4（FR-P4-6 / §19.7）：列表项带 `class`（派生值：archived / subagent / null）与真实 `status`。
    // UI 用 class + status 分域渲染；`status` 的 class S 取值是 hot-subagent / cold。
    const rowClass = this.rowClass(row);
    return {
      id: row.session_id,
      title: row.title || row.first_user_text || '（无标题）',
      status,
      class: rowClass,
      workspace: this.workspaceLabel(row.project_key, row.header_cwd),
      projectKey: row.project_key,
      sizeBytes: row.bytes || 0,
      lastActiveAt: row.file_mtime_ms || row.moved_at || row.restored_at || row.created_at || null,
      archivedAt: row.archived_at || null,
      movedAt: row.moved_at || null,
      restoredAt: row.restored_at || null,
      coldRoot: row.cold_root || null,
      error: row.error || null,
      headerState: row.header_state || 'ok',
      formatVersion: row.format_version,
      userMsgs: row.user_msgs || 0,
      assistantMsgs: row.assistant_msgs || 0,
      // 评审 #8：favorite 必须进列表序列化（P3 启用前先对齐；否则 UI 的「收藏」chip 永远筛不到行）
      favorite: row.favorite ? 1 : 0,
      // P3b（FR-P3-4）：hidden=1 = 用户删除的热会话（文件仍在 sessions，未被搬移）。
      hidden: row.hidden ? 1 : 0,
      // P3b：回收站到期读数（只有 trash 行有；热行恒 null）
      expiresAt: null,
    };
  }

  /** 没有 DB 行时，用一次目录扫描的事实直接合成列表项（不再逐 id persistence.stat）。 */
  itemFromScan(entry, status) {
    return {
      id: entry.id,
      title: '（无标题）',
      status,
      // 扫描合成行没有 DB 行 ⇒ 不可能有 header 事实 ⇒ class 恒 null（形状与 toItem 对齐）
      class: null,
      workspace: this.workspaceLabel(entry.projectKey, entry.header ? entry.header.cwd : null),
      projectKey: entry.projectKey,
      sizeBytes: entry.bytes || 0,
      lastActiveAt: entry.fileMtimeMs || null,
      archivedAt: null,
      movedAt: null,
      restoredAt: null,
      coldRoot: null,
      error: null,
      headerState: entry.header ? 'ok' : 'header-unverified',
      formatVersion: entry.version,
      userMsgs: 0,
      assistantMsgs: 0,
      // 评审 #8：扫描合成行同样带 favorite（没有 DB 行 ⇒ 恒 0，字段形状与 toItem 对齐）
      favorite: entry.favorite ? 1 : 0,
      // P3b：字段形状与 toItem 对齐（扫描合成行没有 DB 行 ⇒ hidden 恒 0）
      hidden: 0,
      expiresAt: null,
    };
  }

  /**
   * 列表（设计档 §10 数据源合并 + P3b 的收藏/隐藏过滤面）。
   *
   * @param {{favorite?:boolean, hidden?:boolean, status?:string[]}|null} filter
   *   - favorite:true/false ⇒ 只列收藏 / 只列未收藏（FR-P3-3）；
   *   - hidden:true ⇒ **包含**用户删除的热会话（hidden=1，供「回收站」视图还原）；
   *     默认（不给/给 false）一律不列 —— 删除就该从列表消失；
   *   - 带 filter 的请求不读缓存（与旧行为一致：缓存只服务「无参」列表）。
   */
  async list(filter = null) {
    const startedAt = Date.now();
    const cached = this._listCache;
    /**
     * P4（FR-P4-6 / D-S5）：`class` 三值 `archived`（默认）/ `subagent` / `all`。
     * 默认行为**一个字节都不变**：只有显式 class=subagent/all 才会把子代理行掺进来。
     * 非法值明确拒绝（不静默回退成 archived —— 那会让调用方以为筛选生效了）。
     */
    const classFilter = filter && typeof filter.class === 'string' ? String(filter.class) : '';
    if (classFilter && !['archived', 'subagent', 'all'].includes(classFilter)) {
      const error = new Error('class 只支持 archived / subagent / all（收到 ' + JSON.stringify(filter.class) + '）');
      error.code = 'invalid-class';
      throw error;
    }
    const viewClass = classFilter === 'subagent' || classFilter === 'all' ? classFilter : 'archived';
    const wantArchived = viewClass !== 'subagent';
    const wantSubagent = viewClass === 'subagent' || viewClass === 'all';
    const onlyClassKey = !filter || Object.keys(filter).every((key) => key === 'class');
    const defaultView = onlyClassKey && viewClass === 'archived';
    // M4①：缓存时间戳必须取**命中判定时刻**。旧实现取请求开始的 now，再写回 {at: now}
    // ⇒ 一次慢请求（36.8s 那类）写进缓存的 at 是过去时刻，下一次请求就已经过期，缓存等于永不命中。
    if (defaultView && cached && this.now() - cached.at < this._listCacheTtlMs) {
      this._perf.listHits += 1;
      return cached.data;
    }
    this._perf.listMisses += 1;
    const archived = this.archivedIds();
    const items = new Map();
    // P4：class S 的候选（热）与读数先取 —— 与 class A 的候选缓存**分开**（两套口径不互相污染）。
    const subCandidates = wantSubagent ? await this.subagentCandidates({ useCache: true }) : [];
    const subSummary = wantSubagent ? await this.subagentStatus({ withCandidates: false, useCache: true }) : null;
    // P3b：hidden:true ⇒ 连「用户删除的热会话」一起列（默认不列；删除要真的从列表消失）。
    const includeHidden = Boolean(filter && filter.hidden === true);
    /** P4：这一行在当前 class 视图里可见吗？（class 是派生值，见 rowClass） */
    const classVisible = (row) => (this.rowClass(row, archived) === 'subagent' ? wantSubagent : wantArchived);
    const coldRows = this.store.listSessions({ status: ['cold', 'trash'] });
    const lostRows = this.store.listSessions({ errorOnly: true }).filter((row) => row.error === ERROR_STATES.LOST);
    for (const row of coldRows) {
      if (!classVisible(row)) continue;
      items.set(row.session_id, this.toItem(row, 'cold'));
    }
    for (const row of lostRows) {
      if (items.has(row.session_id)) continue;
      if (!classVisible(row)) continue;
      items.set(row.session_id, this.toItem(row, 'cold'));
    }
    // 恢复过（hot-restored → hot）的会话留在 DB 行里（D18）：列表给一行「热」，行操作就是 FR-14 的
    // 「归档」（再次归档后由 ArchiveTracker 记 archivedAt，随后可迁移）。这不是全量热会话列表——
    // 列表数据源仍是「热归档 + 冷归档 + 本插件恢复过的行」（设计档 §10）。
    for (const row of this.store.listSessions({ status: ['hot', 'hot-restored'] })) {
      if (!row.restored_at || items.has(row.session_id)) continue;
      if (row.hidden && !includeHidden) continue;
      if (!classVisible(row)) continue;
      items.set(row.session_id, this.toItem(row, row.status === 'hot' ? 'hot' : 'hot-restored'));
    }

    // P2-0（首启 36.8s 的根因）：**一次目录扫描**替代「逐 id persistence.stat（每次扫全库）」。
    // 目录扫描事实用于大小 / 上次活跃 / 工作区 / 代际；冷行不读盘（DB 即事实源）。
    const disk = await this.scanArchivedDirs(archived);
    let degraded = this._scanError || null;
    // F2/F4：归档 id 的行用**一次 IN 查询**取（旧实现逐 id getSession = 118 条 SQL），
    // 同时作为「存量行 archivedAt 自愈」的判定输入（见下方 healArchivedAt）。
    const archivedRowMap = this.store.getSessionsByIds([...archived]);
    // P4：class=subagent 视图里**不列**归档集合的行（D-S5 的分域）。
    for (const id of wantArchived ? archived : []) {
      if (items.has(id)) continue;
      const row = archivedRowMap.get(id) || null;
      const entry = disk.get(id);
      if (!row && !entry) continue; // 盘上没有、DB 也没有：不属于本插件的列表项
      // P3b（FR-P3-4）：hidden=1 的归档会话不在默认列表里（文件零改动；list({hidden:true}) 才列出来）
      if (row && row.hidden && !includeHidden) continue;
      // hot 行但热目录已被外部删除：不展示幽灵行（扫描本身失败时保留 DB 视图，属降级路径）
      if (row && row.status === 'hot' && !entry && !this._scanError) continue;
      const item = row ? this.toItem(row, 'hot-archived') : this.itemFromScan(entry, 'hot-archived');
      if (entry) {
        item.sizeBytes = entry.bytes || item.sizeBytes;
        item.lastActiveAt = entry.fileMtimeMs || item.lastActiveAt;
        item.projectKey = item.projectKey || entry.projectKey;
        if (!item.workspace || item.workspace === '未知工作区') {
          item.workspace = this.workspaceLabel(entry.projectKey, entry.header ? entry.header.cwd : null);
        }
        item.headerState = entry.header ? 'ok' : item.headerState;
        if (entry.version !== null) item.formatVersion = entry.version;
      }
      item.title = item.title || '（无标题）';
      items.set(id, item);
    }
    // F2（真机：118/118 archivedAt=NULL）：启动回填可能跑在 workspaceRegistry 还没加载完
    // archivedSessionIds 的时刻（空集直接 return 0），索引器建行时也读不到归档集合；此后没有第二条
    // 路径再补。列表是唯一必定被调用的读口 ⇒ 在这里按落库事实补一次（批量单事务，只写展示字段）。
    if (wantArchived) this.healArchivedAt(archived, archivedRowMap, items);
    // P4（FR-P4-3）：class S 的候选（热）进列表，状态 = hot-subagent（行操作 = 迁移）。
    for (const row of subCandidates) {
      if (items.has(row.session_id)) continue;
      const item = this.toItem(row, 'hot-subagent');
      item.class = 'subagent';
      item.lastActiveAt = row.lastActiveAt || item.lastActiveAt;
      items.set(row.session_id, item);
    }

    // P4：`cold ⇒ 归档集合`（I-11 / A-13）**只约束 class A**；class S 的冷行永不参与这条判定（I-17）。
    const coldItems = [...items.values()].filter((item) => item.status === 'cold' && item.class !== 'subagent');
    const externalUnarchived = coldItems.filter((item) => !archived.has(item.id));
    const stats = this.store.stats();
    // F4：候选 / 冷根探测 / AM 探测 / 配置互不依赖 ⇒ 并行（旧实现 4 次串行 await）。
    // §15.1 #3：pendingCount 不再静默封顶 50——这里拿**全量候选**，超采样窗口时用 pendingCapped 显式声明。
    const [cfg, candidateRows, coldRoots, am] = await Promise.all([
      this.config(),
      this.allCandidates({ respectAutoMigrate: false }),
      this.probeColdRoots(),
      this.detectAm(),
    ]);
    const pendingCapped = candidateRows.length > PENDING_SAMPLE_LIMIT;
    // F4「projcache 命中优先」：只给**仍然没有标题**的行补 hint（10 分钟进程内缓存 ⇒ 命中即零 IO）。
    // 旧实现只在 backfill 里读，首屏要等全量索引回填标题；现在首屏就有标题（拿不到仍显示「（无标题）」）。
    const missingTitles = [...items.values()]
      .filter((item) => !item.title || item.title === '（无标题）')
      .map((item) => item.id);
    if (missingTitles.length) {
      const hints = await this.titleHints(missingTitles);
      for (const [id, title] of hints) {
        const item = items.get(id);
        if (item && (!item.title || item.title === '（无标题）')) item.title = title;
      }
    }
    const overlay = this.verifyOverlay();
    const sweep = this.sweepSnapshot();
    const index = this.indexSnapshot();
    /**
     * P3b（FR-P3-3）：**默认排序 = 收藏优先**（收藏 DESC，同状态内 lastActiveAt DESC）。
     * 旧实现只有 lastActiveAt —— 「收藏置顶」（FR-11 / 需求 US-8）永远是空话。
     */
    let ordered = [...items.values()];
    if (filter && typeof filter.favorite === 'boolean') {
      ordered = ordered.filter((item) => Boolean(item.favorite) === filter.favorite);
    }
    ordered.sort((a, b) => {
      const fav = (Number(b.favorite) || 0) - (Number(a.favorite) || 0);
      if (fav !== 0) return fav;
      return (b.lastActiveAt || 0) - (a.lastActiveAt || 0);
    });
    const data = {
      items: ordered,
      stats: {
        ...stats,
        archived: archived.size,
        hotArchived: ordered.filter((item) => item.status === 'hot-archived').length,
        // P3b：收藏 / 隐藏 / 回收站读数（stats 里 favorites/hidden/trash 是库内事实；
        // 这里额外给「本列表里可见的收藏行数」，UI 的收藏 chip 用它，不再是「—」）
        favoriteItems: ordered.filter((item) => item.favorite).length,
        hiddenItems: ordered.filter((item) => item.hidden).length,
        bytesCold: stats.bytesCold,
        pendingCount: candidateRows.length,
        pendingBytes: candidateRows.reduce((sum, row) => sum + (row.bytes || 0), 0),
        pendingCapped,
        pendingSampleLimit: PENDING_SAMPLE_LIMIT,
        // 设计档 §10 顶部统计的「阈值」：旧 UI 恒显示「—」，因为引擎没给这两个字段。
        archiveAgeDays: cfg.archiveAgeDays,
        autoMigrate: Boolean(cfg.autoMigrate) && cfg.archiveAgeDays > 0,
        dailyBudgetCount: cfg.dailyBudgetCount,
        // P4：class S 的四项读数（与 class A 的 pendingCount 分开，绝不混算）
        subagentAgeDays: cfg.subagentAgeDays,
        subagentMigrate: cfg.subagentAgeDays > 0 && Boolean(cfg.subagentMigrate),
        subagentCandidates: subSummary ? subSummary.candidates : 0,
        subagentCandidatesBytes: subSummary ? subSummary.candidatesBytes : 0,
        subagentCold: subSummary ? subSummary.cold : 0,
        subagentColdBytes: subSummary ? subSummary.coldBytes : 0,
        coldRoots: coldRoots.length,
        // P2-4：列表顶部统计「下次清扫 + 待迁量 + 索引覆盖」
        nextSweepAt: sweep ? sweep.nextRunAt : null,
        sweepPaused: Boolean(sweep && sweep.paused),
        sweepPauseReason: sweep ? sweep.pauseReason : null,
        budgetUsedToday: sweep && sweep.budget ? sweep.budget.used : 0,
        indexPhase: index.phase,
        indexIndexed: index.indexed,
        indexTotal: index.total,
        // F5：UI 的「已索引 N/M」用 coverage（docs 侧 distinct 会话），不是本轮任务计数。
        indexCoverage: index.coverage,
        indexIndexedThisRun: index.indexedThisRun,
      },
      sweep,
      index,
      banners: {
        externalUnarchived: externalUnarchived.length,
        externalUnarchivedIds: externalUnarchived.map((item) => item.id),
        coldUnavailable: this.coldDegraded,
        coldRoots,
        am: am.present ? { present: true, matches: am.matches, sources: am.sources } : null,
        overlay: this.overlayBanner(overlay),
        // P4：class S 的暂停 / 缺口读数（UI 黄条与「重新扫描」按钮的数据源）
        subagentPaused: Boolean(subSummary && subSummary.paused),
        subagentPauseReason: subSummary ? subSummary.pauseReason : null,
        subagentScanGaps: subSummary ? subSummary.scanGaps : [],
        subagentScanAt: subSummary ? subSummary.scanAt : null,
      },
      // P4（FR-P4-6）：只有 class 视图包含子代理时才给这一段（默认 archived 视图保持 null，形状不变但可读）。
      subagent: subSummary
        ? {
            ...subSummary,
            candidates: subCandidates.length,
            candidatesBytes: subCandidates.reduce((sum, row) => sum + (row.bytes || 0), 0),
          }
        : null,
      class: viewClass,
      workspaces: [...new Set([...items.values()].map((item) => item.workspace).filter(Boolean))].sort(),
      degraded,
      coldRoot: this._coldRoot || null,
      coldDegraded: this.coldDegraded,
      perf: { scanMs: this._perf.lastScanMs, scans: this._perf.scans },
    };
    this._perf.lastListMs = Date.now() - startedAt;
    // 写入时刻（不是请求开始时刻），见 M4①。
    // P4：只有「默认视图」（无 filter，或只带 class=archived）才写缓存 —— 子代理视图与筛选请求不污染它。
    if (defaultView) this._listCache = { at: this.now(), data };
    return data;
  }

  /**
   * F2：归档存量行的 archivedAt 自愈（列表读口保险）。
   *
   * 只补**展示字段**：archived_at（仅在 null 时写 now）与 backfilled=1；status / cold_root /
   * moved_at 等事实一个都不动（与 backfillArchivedAt 的口径一致）。返回补写行数，供 /list 的 perf 读数。
   */
  healArchivedAt(archived, rowMap, items) {
    const now = this.now();
    const needAt = [];
    const needFlag = [];
    for (const id of archived) {
      const row = rowMap.get(id);
      if (!row) continue;
      // 冷行的时间戳语义不同（迁移时由引擎写 moved_at / archived_at），不在读口改。
      if (row.status !== 'hot' && row.status !== 'hot-restored') continue;
      if (row.archived_at === null || row.archived_at === undefined) needAt.push(id);
      else if (!row.backfilled) needFlag.push(id);
    }
    if (!needAt.length && !needFlag.length) return 0;
    let patched = 0;
    try {
      if (needAt.length) patched += this.store.updateSessions(needAt, { archived_at: now, backfilled: 1 });
      if (needFlag.length) patched += this.store.updateSessions(needFlag, { backfilled: 1 });
    } catch (err) {
      this.log('warn', 'archivedAt 列表自愈失败（不影响列表本身）：' + (err && err.message ? err.message : err));
      return 0;
    }
    for (const id of needAt) {
      const item = items.get(id);
      if (item) item.archivedAt = now;
    }
    this._perf.archivedAtHeals = (this._perf.archivedAtHeals || 0) + patched;
    this.log('info', 'archivedAt 列表自愈：补写 ' + patched + ' 行（archived_at ' + needAt.length + ' / backfilled ' + needFlag.length + '）');
    return patched;
  }

  /**
   * F3：overlay 的对外读数（自检结果 + 自动重装记录）。
   * drifted=true 表示**仍未修复**（archivedAt 追踪 / 透明水合不可用）；replacedBy 记录「谁覆盖了我们」。
   */
  overlayBanner(overlay = null) {
    const check = overlay || this.verifyOverlay();
    const repair = this.overlayRepair || null;
    const install = this.overlayInstall || null;
    const supported = check.supported !== false;
    let reason = check.reason || null;
    if (supported && repair && repair.repairFailed) reason = repair.reason || 'repair-failed';
    return {
      installed: check.installed,
      drifted: check.drifted,
      archiveOk: check.archiveOk,
      unarchiveOk: check.unarchiveOk,
      // F2/F4：形状与支持性 —— Proxy / 只读形态会让「引用比对」永远 false，UI 必须能区分
      // 「被第三方覆盖（可自愈）」与「宿主不支持（自愈无效）」。
      supported,
      shape: check.shape || (install && install.shape) || null,
      verifiedBy: check.verifiedBy || null,
      // F4：一条可读原因（启动链未跑 / 包装不支持 / 重装失败由 UI 横幅分别展示）
      reason,
      repairFailed: Boolean(repair && repair.repairFailed),
      autoRepair: supported && !(repair && repair.repairFailed),
      maxAutoReinstalls: this.overlayMaxAutoReinstalls,
      replacedBy: repair ? repair.replacedBy : null,
      repairedAt: repair ? repair.repairedAt : null,
      reinstalls: repair ? repair.reinstalls || 0 : 0,
      repairError: repair ? repair.lastError || null : null,
      // F2（P2.4）：最近一次安装的读数（形状 / 原因 / 是否可重试 / 抛错次数）。
      // 「装不上」不再只能靠 /diag 反推：shape="threw" + retryable=true 就是「插件侧编程错误，仍在重试」，
      // 而 supported=false 才是「宿主形状不支持，已停手」——两种故障在 /status 上可区分。
      install: install
        ? {
            ok: Boolean(install.ok),
            installed: Boolean(install.installed),
            shape: install.shape || null,
            reason: install.reason || null,
            supported: install.supported !== false,
            retryable: install.retryable === true,
            throws: Number(install.throws) || 0,
            errorName: install.errorName || null,
            error: install.error || null,
            programmingError: install.programmingError === true,
            lastAttemptAt: install.lastAttemptAt || null,
          }
        : null,
    };
  }

  async lastActiveAt(row) {
    const map = await this.lastActiveMap([row]);
    return map.get(String(row.session_id)) || 0;
  }

  /**
   * 批量「上次活跃」（M4② / §9 / §15.1 #7）：
   * 一次 GROUP BY 查询拿全部 docs 的 MAX(time)，再与 file_mtime_ms / created_at 取最大。
   * 旧实现对每个候选行各发一条 SQL（118 行 = 118 条）。
   */
  async lastActiveMap(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const out = new Map();
    if (!list.length) return out;
    const docMax = new Map();
    const ids = [...new Set(list.map((row) => String(row.session_id)))];
    const chunkSize = 400; // 低于 SQLite 的变量上限
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);
      const sql = 'SELECT session_id, MAX(time) AS t FROM docs WHERE session_id IN (' + chunk.map(() => '?').join(', ') + ') GROUP BY session_id';
      try {
        for (const row of this.store.prepare(sql).all(...chunk)) {
          if (row && row.session_id) docMax.set(String(row.session_id), Number(row.t) || 0);
        }
      } catch {
        /* 读数失败 ⇒ 退回 mtime/created_at（不改变候选语义） */
      }
    }
    for (const row of list) {
      const id = String(row.session_id);
      out.set(id, Math.max(docMax.get(id) || 0, row.file_mtime_ms || 0, row.created_at || 0));
    }
    return out;
  }

  /**
   * 全量候选（§9 候选口径）。list/status 的 pendingCount 用它取**总量**（§15.1 #3 不再静默封顶）。
   * 结果按 (respectAutoMigrate, 阈值, 开关) 缓存 5s；归档/迁移/恢复事件经 invalidate() 失效。
   */
  async allCandidates(options = {}) {
    const cfg = await this.config();
    const respect = options.respectAutoMigrate !== false;
    const now = this.now();
    // 配置指纹进缓存键：设置页改阈值/开关后，下一次读数立即按新值（A-8 不依赖手动 invalidate）。
    const cacheKey = [respect ? 'respect' : 'all', cfg.archiveAgeDays, cfg.autoMigrate ? 1 : 0].join('|');
    const useCache = options.useCache !== false;
    const cached = this._candidateCache;
    if (useCache && cached && cached.key === cacheKey && now - cached.at < this._candidateCacheTtlMs) {
      this._perf.candidateHits += 1;
      return cached.rows;
    }
    this._perf.candidateMisses += 1;
    // `archiveAgeDays=0` ⇒ **不迁移**（§9 / 需求 AC-6 / 审计 R-26）：这是阈值本身的语义，与 respectAutoMigrate 无关。
    // 旧实现把「0」只挂在 respect 分支上早退，而 list/status 的 pendingCount/pendingBytes 走 respect=false，
    // threshold=0 又恒不跳过 ⇒ 全部 hot 归档行被数成「待迁」，与「0=关闭」自相矛盾。
    if (cfg.archiveAgeDays === 0 || (respect && !cfg.autoMigrate)) {
      this._candidateCache = { key: cacheKey, at: now, rows: [] };
      return [];
    }
    const archived = this.archivedIds();
    const threshold = cfg.archiveAgeDays * 86400 * 1000;
    // P3b / I-13 / A-P3-4（负向）：**hidden=1 的会话绝不进候选**（用户以为已删除，却被自动搬走 = 最坏体验）。
    const rows = this.store
      .listSessions({ status: ['hot'] })
      .filter((row) => archived.has(row.session_id) && !row.hidden);
    const eligible = rows.filter((row) => !(row.next_attempt && row.next_attempt > now));
    // 批量活跃判定 + 批量 lastActive（M4②：118 行不再 118 次串行 waterfall / 118 条 SQL）
    const active = await this.isActiveMany(eligible.map((row) => row.session_id));
    const lastActive = await this.lastActiveMap(eligible);
    const out = [];
    for (const row of eligible) {
      if (active.get(String(row.session_id))) continue;
      const stamp = lastActive.get(String(row.session_id)) || 0;
      if (threshold > 0 && stamp + threshold > now) continue;
      out.push({ ...row, lastActiveAt: stamp });
    }
    out.sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0));
    this._candidateCache = { key: cacheKey, at: now, rows: out };
    return out;
  }

  /**
   * 候选页（清扫用：单轮上限 5）。limit 只影响**返回页**，不参与缓存（缓存的是全量）。
   */
  async candidates(limit = 5, options = {}) {
    // 清扫侧传 useCache:false（刚失败的行要立刻进退避、刚迁走的行要立刻出候选）；list/status 用缓存。
    const all = await this.allCandidates(options);
    return all.slice(0, Math.max(1, limit));
  }

  async status() {
    const cfg = await this.config();
    const coldRoot = effectiveColdRoot(cfg, this.paths);
    this._coldRoot = coldRoot;
    const stats = this.store.stats();
    const archived = this.archivedIds();
    // F4：四条互不依赖的探测/读数并行（旧实现串行 await，status 是 UI 15s 轮询口）。
    // §15.1 #3：同样给全量候选数 + candidatesCapped（不是静默的 50）。
    const [coldRoots, am, markerIds, candidateRows] = await Promise.all([
      this.probeColdRoots(),
      this.detectAm(),
      this.markers.list().catch(() => []),
      this.allCandidates({ respectAutoMigrate: false }),
    ]);
    const coldRootAvailable = coldRoots.some((item) => item.available);
    const candidatesCapped = candidateRows.length > PENDING_SAMPLE_LIMIT;
    // F3：自检即自愈（漂移 ⇒ 自动重装，记录「谁覆盖了我们」）。
    const overlay = this.verifyOverlay();
    const sweep = this.sweepSnapshot();
    const index = this.indexSnapshot();
    // P3 / FR-P3-2：检索范围（配置 + 库内实际值 + 升级 pass 进度）单列一段，不混进 index。
    const scope = this.scopeSnapshot(cfg.searchScope);
    const loaded = await this.configStore.load();
    return {
      stats: {
        ...stats,
        archived: archived.size,
        candidates: candidateRows.length,
        candidatesBytes: candidateRows.reduce((sum, row) => sum + (row.bytes || 0), 0),
        candidatesCapped,
        pendingSampleLimit: PENDING_SAMPLE_LIMIT,
        markers: markerIds.length,
        archiveAgeDays: cfg.archiveAgeDays,
        autoMigrate: Boolean(cfg.autoMigrate) && cfg.archiveAgeDays > 0,
        dailyBudgetCount: cfg.dailyBudgetCount,
        // P2-4 可观测：索引进度 + 下次清扫 + 今日预算用量
        indexed: index.indexed,
        indexTotal: index.total,
        indexPhase: index.phase,
        // F5：真实覆盖面（docs 侧 distinct 会话）与本轮计数分开给，运维不再被「indexed:19」误读。
        indexCoverage: index.coverage,
        indexedThisRun: index.indexedThisRun,
        nextSweepAt: sweep ? sweep.nextRunAt : null,
        sweepAttached: Boolean(sweep && sweep.attached),
        budgetUsedToday: sweep && sweep.budget ? sweep.budget.used : 0,
      },
      queue: {
        pending: this.pending,
        running: this.running ? 1 : 0,
        indexRunning: index.phase === 'indexing' || index.phase === 'scanning' ? 1 : 0,
      },
      index,
      sweep,
      errors: this.store.recentErrors(20).map((row) => ({ id: row.id, error: row.error, status: row.status })),
      vault: {
        coldRoot,
        coldRootAvailable,
        coldRoots,
        coldDegraded: this.coldDegraded,
        sessionsRoot: this.paths.sessionsRoot,
        configSource: loaded.source,
        configErrors: loaded.errors,
      },
      banners: {
        coldUnavailable: this.coldDegraded,
        coldRoots,
        am: am.present ? { present: true, matches: am.matches, sources: am.sources } : null,
        overlay: this.overlayBanner(overlay),
      },
      autoMigrate: Boolean(cfg.autoMigrate) && cfg.archiveAgeDays > 0,
      archiveAgeDays: cfg.archiveAgeDays,
      // P3：检索范围（searchScope = 配置值；libraryScope = 库内实际值；phase/paused/done = 升级进度）
      searchScope: cfg.searchScope,
      scope,
      /**
       * P4（FR-P4-6 / §19.5）：class S 的独立读数。
       * {enabled,migrate,candidates,candidatesBytes,cold,coldBytes,scanAt,scanGaps,paused,pauseReason,job}
       * —— **绝不与 class A 的 stats.candidates / sweep 混算**（两套口径不能互相污染）。
       */
      subagent: await this.subagentStatus({ useCache: true }),
    };
  }

  // ---- 启动收敛（§11） --------------------------------------------------
  async recoverOnBoot() {
    return this.enqueue(async () => {
      const counts = {
        markers: 0,
        resumedMigrate: 0,
        resumedRestore: 0,
        // P3b：trash 在途 marker 的收敛读数（§18.7：源/目标二选一，不删源）
        resumedTrash: 0,
        trashAborted: 0,
        trashLost: 0,
        coldImports: 0,
        lost: 0,
        repaired: 0,
        externalUnarchived: 0,
        flipped: 0,
        needsReview: 0,
        partials: 0,
        hotResidueKept: 0,
        coldUnavailable: 0,
        backfilledArchived: 0,
        strayRecovered: 0,
        failed: 0,
      };
      // 先把冷根集合装进内存（写路径白名单 + A-16 多冷根都要它），再开始收敛。
      await this.probeColdRoots().catch(() => {});
      const ids = await this.markers.list().catch(() => []);
      for (const id of ids) {
        try {
          await this.recoverMarker(id, counts);
        } catch (err) {
          counts.failed += 1;
          this.log('warn', 'marker 收敛失败 ' + id + '：' + (err && err.message ? err.message : err));
        }
      }
      // ②b（3 号项兜底）：marker 收敛之后、冷目录对账之前，先把「status 卡在 migrating/restoring
      // 却没有 marker、热目录仍在盘」的游离行翻回 hot——否则这类行既没有收敛依据，也被 preflight 永久拒绝重试。
      await this.reconcileStrayStatuses(counts).catch((err) => {
        counts.failed += 1;
        this.log('warn', '游离状态行收敛失败：' + (err && err.message ? err.message : err));
      });
      await this.reconcileColdRoots(counts).catch((err) => {
        counts.failed += 1;
        this.log('warn', '冷目录对账失败：' + (err && err.message ? err.message : err));
      });
      await this.reconcileRegistry(counts).catch((err) => {
        counts.failed += 1;
        this.log('warn', 'registry 对账失败：' + (err && err.message ? err.message : err));
      });
      await this.reconcileManifest(counts).catch((err) => {
        counts.failed += 1;
        this.log('warn', 'manifest 对账失败：' + (err && err.message ? err.message : err));
      });
      await this.backfillArchivedAt(counts).catch((err) => {
        counts.failed += 1;
        this.log('warn', 'archivedAt 回填失败：' + (err && err.message ? err.message : err));
      });
      await this.cleanupPartials(counts).catch((err) => {
        counts.failed += 1;
        this.log('warn', '残留 .partial 清理失败：' + (err && err.message ? err.message : err));
      });
      this.invalidate();
      return {
        ok: true,
        repaired: counts.markers + counts.coldImports + counts.repaired + counts.flipped + counts.strayRecovered + counts.backfilledArchived > 0,
        counts,
      };
    });
  }

  /** marker 可能先于 DB 行落盘（崩在 DB 写入前）：显式态必须有行可见，否则 §11 的「显式标记态」不可见。 */
  ensureRowFromMarker(marker) {
    if (!marker || !marker.id) return null;
    const existing = this.store.getSession(marker.id);
    if (existing) return existing;
    return this.store.upsertSession({
      session_id: marker.id,
      project_key: marker.projectKey || '',
      rel_dir: marker.relDir || '',
      log_names: marker.logNames || '',
      cold_root: marker.coldRoot || null,
      format_version: marker.formatVersion || 0,
      bytes: marker.bytes || 0,
      file_size: 0,
      file_mtime_ms: marker.planMtimeMs || 0,
      header_cwd: marker.headerCwd || null,
      header_state: marker.headerCwd ? 'ok' : 'header-unverified',
      created_at: marker.createdAt || this.now(),
      title: marker.title || '',
      archived_at: marker.archivedAt === undefined ? null : marker.archivedAt,
      backfilled: 0,
      moved_at: null,
      restored_at: null,
      status: marker.op === 'restore' ? 'restoring' : 'migrating',
      favorite: 0,
      error: null,
      next_attempt: null,
      source_sha: marker.sourceSha || '',
    });
  }

  async recoverMarker(sessionId, counts) {
    const marker = await this.markers.read(sessionId);
    if (!marker) return;
    counts.markers += 1;
    /**
     * P3b：回收站 marker（文件名 trash-<id>）走**独立**收敛。
     * 不能进下面那条通用真值表：它的 sessionId 是「trash-xxx」而不是会话 id，
     * 通用路径会给它造出一条假会话行（ensureRowFromMarker），并把迁移/恢复的语义套错。
     */
    if (marker.op === 'trash') {
      await this.recoverTrashMarker(sessionId, marker, counts);
      return;
    }
    this.ensureRowFromMarker({ ...marker, id: marker.id || sessionId });
    const srcExists = await isDirectory(marker.src);
    const dstExists = await isDirectory(marker.dst);
    if (!srcExists && !dstExists) {
      this.store.updateSession(sessionId, { error: ERROR_STATES.LOST });
      counts.lost += 1;
      return; // 保留 marker：人工处置
    }
    if (srcExists && !dstExists) {
      // 真值表「在/无」：重跑搬移（幂等续跑）
      if (marker.op === 'migrate') {
        await this.markers.remove(sessionId);
        const entry = this.store.getSession(sessionId);
        if (entry) this.store.updateSession(sessionId, { status: 'hot' });
        // P4：续跑的资格判据也分域（class S 不在归档集合里，用 isArchived 会永远不续跑）
        const resumeClass = marker.class === 'subagent' ? 'subagent' : 'archived';
        const resumeRace = await this.migrationRaceReason(sessionId, resumeClass, null);
        if (!resumeRace) {
          const result = await this.migrateNow(sessionId, { reason: 'boot-resume', class: resumeClass });
          if (result.ok) counts.resumedMigrate += 1;
          else counts.failed += 1;
        }
        return;
      }
      // restore 的「源在、热无」= 还没搬；直接重跑恢复
      const entry = this.store.getSession(sessionId);
      if (entry && entry.status === 'restoring') this.store.updateSession(sessionId, { status: 'cold' });
      const result = await this.restoreNow(sessionId, { reason: 'boot-resume' });
      if (result.ok) counts.resumedRestore += 1;
      else counts.failed += 1;
      return;
    }
    if (!srcExists && dstExists) {
      const baseline = await hashTree(marker.dst).catch(() => null);
      // 无基线（marker 损坏/旧版）也一律 needs-review：没有基线就没有「允许继续尾段」的判据。
      if (!baseline || (marker.planSha && baseline.sha256 !== marker.planSha)) {
        this.store.updateSession(sessionId, { error: ERROR_STATES.NEEDS_REVIEW });
        counts.needsReview += 1;
        return; // 保留 marker
      }
      if (marker.op === 'migrate') {
        // §11「同卷 rename 后、复检前」崩溃点必须**先重跑 I-6 复检**（R-2），再决定续尾段还是搬回：
        // 基线已通过 ⇒ 冷侧是完整副本，但此时若 id 已离开归档集合（用户已取消归档）或出现 live 会话，
        // 继续尾段就把一个「用户认为已取消归档」的会话钉成 cold —— 反向违反 I-6/A-12。
        const completeClass = marker.class === 'subagent' ? 'subagent' : 'archived';
        const completeRace = await this.migrationRaceReason(sessionId, completeClass, null);
        if (completeRace) {
          // A1：跨卷搬回删冷源前同样要过 marker 基线；不通过 ⇒ 双份保留 + needs-review（marker 留着）。
          const back = await this.moveBack(marker.dst, marker.src, marker.coldRoot, marker);
          if (!back.ok) {
            this.store.updateSession(sessionId, { error: ERROR_STATES.NEEDS_REVIEW });
            counts.needsReview += 1;
            return;
          }
          await this.markers.remove(sessionId);
          this.store.updateSession(sessionId, { status: 'hot', error: completeRace });
          counts.flipped += 1;
          return;
        }
        await this.completeMigrateTail(sessionId, marker);
        counts.resumedMigrate += 1;
      } else {
        await this.completeRestoreTail(sessionId, marker);
        counts.resumedRestore += 1;
      }
      return;
    }
    // src 在 + dst 在
    if (marker.op === 'restore') {
      // 恢复方向：双份判定只看 marker 全量基线（§11「允许删源的唯一条件」）。
      const decision = await this.decideRestoreDuplicates(this.store.getSession(sessionId) || {}, marker, marker.src, marker.dst);
      if (decision.action === 'delete-cold') {
        await this.removeTree(marker.src, marker.coldRoot);
        await this.completeRestoreTail(sessionId, marker);
        counts.resumedRestore += 1;
        return;
      }
      if (decision.action === 'delete-hot') {
        await this.removeTree(marker.dst, marker.coldRoot);
        const resumed = await this.restoreNow(sessionId, { reason: 'boot-resume' });
        if (resumed.ok) counts.resumedRestore += 1;
        else counts.failed += 1;
        return;
      }
      this.store.updateSession(sessionId, { error: ERROR_STATES.NEEDS_REVIEW });
      counts.needsReview += 1;
      return;
    }

    // 迁移方向：**按 marker 基线逐文件补齐**（§11「跨卷删源中（部分删）」）；
    // 补齐后冷侧等于 planSha ⇒ 才允许删热残留并续尾段；否则双份保留 + needs-review。
    const repair = await this.repairMigrationDuplicates(sessionId, marker, marker.src, marker.dst).catch((err) => ({
      ok: false,
      code: 'repair-failed',
      reason: err && err.message ? err.message : String(err),
    }));
    if (repair.ok && (this.isArchived(sessionId) && !(await this.isActive(sessionId)))) {
      await this.removeTree(marker.src, marker.coldRoot);
      await this.completeMigrateTail(sessionId, marker);
      counts.resumedMigrate += 1;
      return;
    }
    if (repair.ok) {
      // 基线可修但会话已取消归档/活跃：按 I-6 搬回热态（冷侧是残留，删它）
      await this.removeTree(marker.dst, marker.coldRoot);
      await this.markers.remove(sessionId);
      this.store.updateSession(sessionId, { status: 'hot', error: ERROR_STATES.RACE_UNARCHIVED });
      counts.flipped += 1;
      return;
    }
    this.store.updateSession(sessionId, { error: ERROR_STATES.NEEDS_REVIEW });
    counts.needsReview += 1;
  }

  /**
   * 回收站搬移的启动收敛（§18.7：「崩溃 ⇒ marker 驱动收敛（源与目标二选一，不删源）」）。
   *
   * 真值表（src = 冷目录，dst = <trashRoot>/<id>/<ts>）：
   *  - 源在、目标无      ⇒ 还没搬成：撤销在途状态（行回 cold）、删 marker、可重试；
   *  - 源无、目标在      ⇒ 搬完了、尾段没写：按 marker.sha256 校验目标 → 通过则补尾段（不回滚）；
   *                        不通过 ⇒ needs-review + 保留 marker（不删任何一份）；
   *  - 源在、目标在      ⇒ 双份：**先**按基线校验目标；通过才允许删源（§11 允许删源的唯一条件）并补尾段；
   *                        不通过 ⇒ 保留双份 + needs-review；
   *  - 源无、目标无      ⇒ lost + 保留 marker（人工处置）。
   */
  async recoverTrashMarker(markerName, marker, counts) {
    const sessionId = String(marker.sessionId || markerName.slice(TRASH_MARKER_PREFIX.length));
    const src = marker.src ? String(marker.src) : null;
    const dst = marker.dst ? String(marker.dst) : null;
    const srcExists = src ? await isDirectory(src) : false;
    const dstExists = dst ? await isDirectory(dst) : false;
    const baseline = { planSha: marker.sha256 || null, files: Array.isArray(marker.files) ? marker.files : null, bytes: marker.bytes };
    const row = this.store.getSession(sessionId);
    if (!srcExists && !dstExists) {
      if (row) this.store.updateSession(sessionId, { status: 'trash', error: ERROR_STATES.LOST });
      counts.trashLost += 1;
      return; // 保留 marker：人工处置
    }
    if (srcExists && !dstExists) {
      // 还没搬成（或搬到 .partial）：撤销在途状态，源仍是唯一副本。
      await this.removeTree(dst + '.partial').catch(() => {});
      if (row) this.store.updateSession(sessionId, { status: 'cold', error: null });
      await this.markers.remove(markerName).catch(() => {});
      counts.trashAborted += 1;
      return;
    }
    const check = await this.verifyBaseline(dst, baseline);
    if (!check.ok) {
      if (row) this.store.updateSession(sessionId, { status: srcExists ? 'cold' : 'trash', error: ERROR_STATES.NEEDS_REVIEW });
      counts.needsReview += 1;
      return; // 双份/坏副本：保留 marker 与两份现场，人工处置
    }
    if (srcExists) {
      // 目标已通过全量基线校验 ⇒ 这是唯一允许删源的路径（§11）。
      await this.removeTree(src).catch(() => {});
    }
    await this.completeTrashTail(sessionId, marker);
    await this.markers.remove(markerName).catch(() => {});
    counts.resumedTrash += 1;
  }

  async completeMigrateTail(sessionId, marker) {
    const now = this.now();
    const baseline = { bytes: marker.bytes, sha256: marker.planSha, files: marker.files || [] };
    const dst = marker.dst;
    const entry = this.store.getSession(sessionId) || {};
    const row = {
      session_id: sessionId,
      project_key: marker.projectKey || entry.project_key || '',
      rel_dir: marker.relDir || entry.rel_dir || '',
      log_names: marker.logNames || entry.log_names || '',
      cold_root: marker.coldRoot || entry.cold_root || null,
      format_version: marker.formatVersion === undefined ? (entry.format_version || 0) : marker.formatVersion,
      bytes: baseline.bytes || 0,
      file_size: entry.file_size || 0,
      file_mtime_ms: marker.planMtimeMs || entry.file_mtime_ms || 0,
      header_cwd: marker.headerCwd || entry.header_cwd || null,
      header_state: marker.headerCwd ? 'ok' : 'header-unverified',
      created_at: marker.createdAt || entry.created_at || now,
      title: marker.title || entry.title || '',
      archived_at: marker.archivedAt === undefined ? (entry.archived_at === undefined ? now : entry.archived_at) : marker.archivedAt,
      backfilled: entry.backfilled || 0,
      moved_at: entry.moved_at || now,
      restored_at: null,
      status: 'cold',
      favorite: entry.favorite || 0,
      error: null,
      next_attempt: null,
      source_sha: marker.sourceSha || entry.source_sha || '',
      // P4：header 事实随行保留（崩溃续跑的尾段也必须知道自己是 class S）
      origin: entry.origin === undefined ? null : entry.origin,
      delegation_depth: Math.max(0, Math.trunc(Number(entry.delegation_depth) || 0)),
      parent_session: entry.parent_session === undefined ? null : entry.parent_session,
    };
    try {
      const info = await stat(path.join(dst, marker.currentGeneration));
      row.file_size = info.size;
      row.file_mtime_ms = Math.trunc(info.mtimeMs);
    } catch {
      /* 兜底 */
    }
    this.store.upsertSession(row);
    // R2：同上 —— 收尾索引的存储异常只能落 error='index-failed'，不能让启动收敛在这一步炸掉
    // （否则 marker 留着、行已 cold，下一轮又会重跑尾段）。
    let index = { ok: true, error: null };
    let indexThrew = false;
    try {
      index = await this.indexSession(sessionId, dst, marker);
    } catch (err) {
      indexThrew = true;
      index = { ok: false, error: ERROR_STATES.INDEX_FAILED };
      this.recordIndexFailure(sessionId, err);
    }
    const manifestRecord = {
      ts: now,
      op: 'migrate',
      id: sessionId,
      from: marker.src,
      to: dst,
      bytes: baseline.bytes || 0,
      files: marker.logNames ? String(marker.logNames).split(',').length : 0,
      sha256: baseline.sha256 || '',
      ok: true,
      reason: 'boot-resume',
      movedAt: row.moved_at,
    };
    if (marker.class === 'subagent') manifestRecord.class = 'subagent';
    await this.manifest.appendDedup(manifestRecord);
    await this.markers.remove(sessionId);
    if (!index.ok && !indexThrew) this.log('warn', '索引失败（不阻塞迁移）：' + index.error + ' @' + sessionId);
  }

  /**
   * R2：索引失败的**唯一**收尾（存储异常与普通失败共用）。
   * 只写 error，绝不改 status / 不抛（迁移/恢复的成功事实已经落在行上）。
   */
  recordIndexFailure(sessionId, err) {
    try {
      this.store.updateSession(sessionId, { error: ERROR_STATES.INDEX_FAILED });
    } catch (e) {
      /* 连 error 都写不进去：迁移事实已在行上，日志留证即可 */
    }
    this.log('warn', '索引失败（不阻塞迁移/恢复）：' + (err && err.message ? err.message : err) + ' @' + sessionId);
  }

  async completeRestoreTail(sessionId, marker) {
    const entry = this.store.getSession(sessionId);
    if (!entry) {
      this.store.updateSession(sessionId, { error: ERROR_STATES.LOST });
      return;
    }
    const statResult = await this.statSession(sessionId);
    if (!statResult) {
      this.store.updateSession(sessionId, { status: 'restoring', error: 'stat-missing' });
      return;
    }
    // P4（FR-P4-5）：崩溃续跑的恢复尾段同样分域（class S 不调 unarchive / attach）
    if (this.rowClass(entry, this.archivedIds()) === 'subagent') {
      const now = this.now();
      this.store.updateSession(sessionId, { status: 'hot', restored_at: now, moved_at: null, cold_root: null, error: null });
      await this.manifest.appendDedup({
        ts: now,
        op: 'restore',
        id: sessionId,
        from: marker.src,
        to: marker.dst,
        bytes: marker.bytes || 0,
        files: marker.files ? marker.files.length : 0,
        sha256: marker.planSha || '',
        ok: true,
        reason: 'boot-resume',
        class: 'subagent',
      });
      await this.markers.remove(sessionId);
      return;
    }
    const original = this.originalOf('unarchiveSession');
    if (original) {
      try {
        await original(sessionId);
      } catch (err) {
        this.store.updateSession(sessionId, { status: 'restoring', error: 'unarchive-failed: ' + (err && err.message ? err.message : err) });
        return;
      }
    }
    await this.attachBestEffort(sessionId, entry);
    const now = this.now();
    this.store.updateSession(sessionId, { status: 'hot-restored', restored_at: now, moved_at: null, error: null });
    await this.manifest.appendDedup({
      ts: now,
      op: 'restore',
      id: sessionId,
      from: marker.src,
      to: marker.dst,
      bytes: marker.bytes || 0,
      files: marker.files ? marker.files.length : 0,
      sha256: marker.planSha || '',
      ok: true,
      reason: 'boot-resume',
    });
    await this.markers.remove(sessionId);
  }

  async reconcileColdRoots(counts) {
    const cfg = await this.config();
    const currentRoot = effectiveColdRoot(cfg, this.paths);
    const known = new Set([currentRoot]);
    for (const row of this.store.listSessions({ status: ['cold', 'trash'] })) {
      if (row.cold_root) known.add(row.cold_root);
    }
    // ① 冷目录有、DB 无 → 导入 cold（先探热路径，绝不把「已恢复但 marker 丢了」标 lost）
    for (const root of known) {
      let projects = [];
      try {
        projects = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        let sessions = [];
        try {
          sessions = await readdir(path.join(root, project.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const session of sessions) {
          if (!session.isDirectory()) continue;
          const sessionId = session.name;
          const coldDir = path.join(root, project.name, sessionId);
          const existing = this.store.getSession(sessionId);
          if (existing) {
            if (existing.status === 'hot' || existing.status === 'hot-restored') {
              // 热行 + 冷目录同时存在：不能悄悄改状态；交给人工（双份）
              this.store.updateSession(sessionId, { error: ERROR_STATES.NEEDS_REVIEW });
              counts.needsReview += 1;
            }
            continue;
          }
          // 先探热路径：命中说明恢复已搬回但 marker 丢失 → 按 §7 续跑（不得标 lost）
          const hotDir = path.join(this.paths.sessionsRoot, project.name, sessionId);
          if (await isDirectory(hotDir)) {
            this.log('warn', '冷/热双份但 DB 无行（人工处置，不自动删除）：' + coldDir);
            counts.needsReview += 1;
            continue;
          }
          const found = { projectKey: project.name, dir: coldDir, files: (await listDirFiles(coldDir)).filter((f) => !f.dir).map((f) => f.name) };
          const row = await this.buildEntryFromDisk(sessionId, found);
          row.status = 'cold';
          row.cold_root = root;
          row.backfilled = 1;
          row.moved_at = row.file_mtime_ms || this.now();
          row.error = null;
          this.store.upsertSession(row);
          const index = await this.indexSession(sessionId, coldDir, { logNames: row.log_names, formatVersion: row.format_version });
          if (!index.ok) this.log('warn', '导入冷会话索引失败：' + index.error + ' @' + sessionId);
          await this.manifest.appendDedup({
            ts: this.now(),
            op: 'migrate',
            id: sessionId,
            from: null,
            to: coldDir,
            bytes: row.bytes,
            files: row.log_names ? row.log_names.split(',').length : 0,
            sha256: '',
            ok: true,
            reason: 'boot-import',
            movedAt: row.moved_at,
          });
          counts.coldImports += 1;
        }
      }
    }
    // ② DB 有、冷盘无：先探热目录（恢复续跑），再标 lost（不删行）
    //    P3b：**status='trash' 的行不走这条**（文件已/正在进回收站，由 trash marker 与游离状态收敛负责），
    //    否则一个刚搬进回收站的会话会在启动对账里被误标 lost。
    for (const row of this.store.listSessions({ status: ['cold'] })) {
      const path_ = row.cold_root ? path.join(row.cold_root, row.rel_dir) : path.join(currentRoot, row.rel_dir);
      if (await isDirectory(path_)) continue;
      const hotDir = path.join(this.paths.sessionsRoot, row.rel_dir);
      if (await isDirectory(hotDir)) {
        // 冷行但文件已回热目录：按 §7 续跑（**不得标 lost**）；marker 丢了也要能续
        const marker = await this.markers.read(row.session_id);
        if (marker) {
          await this.completeRestoreTail(row.session_id, marker);
        } else {
          this.store.updateSession(row.session_id, { status: 'restoring', error: 'recovery-pending: hot-files-found' });
        }
        continue;
      }
      const marker = await this.markers.read(row.session_id);
      if (marker) continue; // marker 收敛负责
      this.store.updateSession(row.session_id, { error: ERROR_STATES.LOST });
      counts.lost += 1;
    }
  }

  /**
   * §11「DB 后、manifest 前」：DB 有、manifest 无 → 补 op:repair（S-3 查重）。
   *
   * P3b（评审遗留 🔵）：判据**只有一份** —— 就是 Manifest.repairIfMissing（此前它没有生产调用方，
   * 这里又手写了一份同样的判断，两处迟早漂移）。records 快照传下去，避免每行重读整档。
   */
  async reconcileManifest(counts) {
    const snapshot = await this.manifest.readAll();
    const known = new Set(
      snapshot.records
        .filter((record) => record && (record.op === 'migrate' || record.op === 'restore' || record.op === 'repair'))
        .map((record) => String(record.id)),
    );
    for (const row of this.store.listSessions({ status: ['cold', 'hot-restored'] })) {
      if (known.has(row.session_id)) continue;
      const to = row.status === 'cold' && row.cold_root ? path.join(row.cold_root, row.rel_dir) : null;
      const repairRecord = {
        ts: this.now(),
        id: row.session_id,
        from: null,
        to,
        bytes: row.bytes || 0,
        files: row.log_names ? String(row.log_names).split(',').length : 0,
        sha256: row.source_sha || '',
        ok: true,
        reason: 'manifest-missing',
      };
      // P4：class S 的补行也带 class（审计面按 class 分域；class A 保持不带该字段）
      if (this.rowClass(row) === 'subagent') repairRecord.class = 'subagent';
      const result = await this.manifest.repairIfMissing(repairRecord, snapshot);
      if (result && result.repaired) counts.repaired += 1;
    }
  }

  // ---- 诊断与修复（FR-P3-5 / P3-D6 / A-P3-5）-----------------------------
  /**
   * /diagnose：**只读**三类对账（§18.4 FR-P3-5 逐字三条）。
   *
   *  ① 日志可读性：sessions.error 归到 frame-corrupt / extract-empty / index-failed / seq-gap；
   *  ② DB/manifest 对账：db-no-manifest / manifest-no-db / marker-no-row / hidden-mismatch；
   *  ③ 磁盘对账：row-cold-no-dir / cold-dir-no-row。
   *
   * 只读的硬约束：不 probeColdRoots（它会幂等 mkdir）、不 verifyOverlay（它会自动重装包装）、
   * 不写 manifest / 不改行 —— 本方法只有 readdir / stat / SQL 读。
   * 有界：「冷目录有、DB 无行」的遍历受 maxScanDirs（默认 2000）约束，超出如实标 truncated。
   */
  async diagnose(options = {}) {
    const now = this.now();
    const cfg = await this.config();
    const coldRoot = effectiveColdRoot(cfg, this.paths);
    this._coldRoot = coldRoot;
    const items = [];
    const rows = this.store.listSessions();
    const rowById = new Map(rows.map((row) => [String(row.session_id), row]));
    const trashRows = this.store.listTrash();
    const trashById = new Map(trashRows.map((row) => [String(row.session_id), row]));

    // ① 日志可读性（只读列表；seq-gap 是**诊断读数**，没有安全修复动作）
    for (const row of rows) {
      const check = logCheckOf(row.error);
      if (!check) continue;
      const repairable = check === 'index-failed' || check === 'extract-empty';
      items.push({
        id: check + ':' + row.session_id,
        check,
        group: 'log',
        sessionId: row.session_id,
        title: row.title || row.first_user_text || '（无标题）',
        status: row.status,
        error: row.error,
        detail:
          check === 'seq-gap'
            ? '事件流 seq 跳号超过阈值（只做诊断，不拒收、不重编码）：' + row.error
            : '日志/抽取面错误：' + row.error,
        repairable,
        repair: repairable ? { kind: 'reindex', summary: '重新索引（重建该会话的 docs，不动日志）' } : null,
      });
    }

    // ② DB / manifest / marker 对账
    const manifest = await this.manifest.readAll().catch(() => ({ records: [], invalid: 0 }));
    const records = Array.isArray(manifest.records) ? manifest.records : [];
    const manifestIds = new Set();
    const orphanManifestIds = new Map();
    for (const record of records) {
      if (!record || !record.id) continue;
      const id = String(record.id);
      if (record.op === 'migrate' || record.op === 'restore' || record.op === 'repair') manifestIds.add(id);
      if (record.op !== 'migrate' && record.op !== 'restore') continue;
      if (rowById.has(id) || trashById.has(id)) continue;
      if (!orphanManifestIds.has(id)) orphanManifestIds.set(id, { ops: [], firstTs: record.ts || null });
      const bucket = orphanManifestIds.get(id);
      bucket.ops.push(record.op);
    }
    for (const row of rows) {
      if (row.status !== 'cold' && row.status !== 'hot-restored') continue;
      if (manifestIds.has(row.session_id)) continue;
      items.push({
        id: 'db-no-manifest:' + row.session_id,
        check: 'db-no-manifest',
        group: 'reconcile',
        sessionId: row.session_id,
        title: row.title || row.first_user_text || '（无标题）',
        status: row.status,
        detail: 'DB 有行、manifest 无对应的 migrate/restore/repair 记录（§11「DB 后、manifest 前」）',
        repairable: true,
        repair: { kind: 'append-manifest', summary: '补一条 op:repair 审计行（不改 DB、不动文件）' },
      });
    }
    for (const [id, bucket] of orphanManifestIds) {
      items.push({
        id: 'manifest-no-db:' + id,
        check: 'manifest-no-db',
        group: 'reconcile',
        sessionId: id,
        detail: 'manifest 有 ' + bucket.ops.join('/') + ' 记录，但 DB 与回收站都没有该会话',
        repairable: true,
        repair: { kind: 'delete-manifest-rows', summary: '删掉该 id 的 migrate/restore 审计行（整档重写，坏行留痕）' },
      });
    }
    const markerNames = await this.markers.list().catch(() => []);
    for (const name of markerNames) {
      const isTrash = name.startsWith(TRASH_MARKER_PREFIX);
      const sessionId = isTrash ? name.slice(TRASH_MARKER_PREFIX.length) : name;
      if (rowById.has(sessionId) || trashById.has(sessionId)) continue;
      items.push({
        id: 'marker-no-row:' + sessionId,
        check: 'marker-no-row',
        group: 'reconcile',
        sessionId,
        marker: name,
        detail: '存在孤立 marker（' + name + '）：DB 与回收站都没有对应行',
        repairable: true,
        repair: { kind: 'remove-marker', summary: '删掉孤立 marker（不动任何日志文件）' },
      });
    }
    for (const row of rows) {
      if (!row.hidden) continue;
      // hidden 只对热会话有意义；cold / migrating / restoring / trash 上的 hidden=1 是矛盾状态。
      if (row.status === 'hot' || row.status === 'hot-restored') continue;
      items.push({
        id: 'hidden-mismatch:' + row.session_id,
        check: 'hidden-mismatch',
        group: 'reconcile',
        sessionId: row.session_id,
        status: row.status,
        detail: 'hidden=1 与 status=' + row.status + ' 矛盾（hidden 只对热会话有意义：文件在 sessions 才用隐藏表达删除）',
        repairable: true,
        repair: { kind: 'clear-hidden', summary: '把 hidden 清回 0（不动文件、不改 status）' },
      });
    }

    // ③ 磁盘对账
    for (const row of rows) {
      if (row.status !== 'cold') continue;
      const root = row.cold_root || coldRoot;
      const dir = path.join(root, row.rel_dir);
      if (await isDirectory(dir)) continue;
      /**
       * 已经标过 needs-review 的行**仍然列出来**（用户要看得见），但不再是可修复项：
       * 「标 needs-review」这个动作只做一次，重复标记等于没动作 —— 那会让 apply 永远不幂等。
       * 正确的后续处置是人工：把冷目录找回来，或从回收站还原。
       */
      const alreadyMarked = row.error === ERROR_STATES.NEEDS_REVIEW;
      items.push({
        id: 'row-cold-no-dir:' + row.session_id,
        check: 'row-cold-no-dir',
        group: 'disk',
        sessionId: row.session_id,
        title: row.title || row.first_user_text || '（无标题）',
        status: 'cold',
        coldRoot: root,
        detail: alreadyMarked
          ? 'DB 行是 cold、冷目录不存在，且该行已标 needs-review（显式标记态，等待人工处置）：' + dir
          : 'DB 行是 cold，但冷目录不存在：' + dir,
        repairable: !alreadyMarked,
        repair: alreadyMarked ? null : { kind: 'mark-needs-review', summary: '标 needs-review（显式标记态，保留行，不删任何东西）' },
      });
    }
    const scanLimit = Number.isFinite(options.maxScanDirs) ? Math.max(1, Math.trunc(options.maxScanDirs)) : 2000;
    let scanned = 0;
    let truncated = false;
    const roots = this.knownColdRoots();
    for (const root of roots) {
      if (truncated) break;
      let projects = [];
      try {
        projects = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const project of projects) {
        if (!project.isDirectory() || truncated) continue;
        let sessions = [];
        try {
          sessions = await readdir(path.join(root, project.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const session of sessions) {
          if (!session.isDirectory()) continue;
          // .partial 是在途残留（由启动清理负责），不是「冷目录有、DB 无行」的现场。
          if (session.name.endsWith('.partial')) continue;
          if (scanned >= scanLimit) {
            truncated = true;
            break;
          }
          scanned += 1;
          const sessionId = session.name;
          if (rowById.has(sessionId) || trashById.has(sessionId)) continue;
          items.push({
            id: 'cold-dir-no-row:' + sessionId,
            check: 'cold-dir-no-row',
            group: 'disk',
            sessionId,
            root,
            projectKey: project.name,
            dir: path.join(root, project.name, sessionId),
            detail: '冷目录存在、DB 与回收站都没有该行（可导入为 cold：只读扫描 + 建索引）',
            repairable: true,
            repair: { kind: 'import-cold', summary: '导入冷目录（建 cold 行 + 索引 + manifest 记录）' },
          });
        }
      }
    }

    const counts = {};
    for (const item of items) counts[item.check] = (counts[item.check] || 0) + 1;
    const groupOf = (names) => items.filter((item) => names.includes(item.check));
    return {
      ok: true,
      at: now,
      readonly: true,
      total: items.length,
      counts,
      items,
      groups: {
        log: groupOf(LOG_CHECKS),
        reconcile: groupOf(['db-no-manifest', 'manifest-no-db', 'marker-no-row', 'hidden-mismatch']),
        disk: groupOf(['row-cold-no-dir', 'cold-dir-no-row']),
      },
      repairable: items.filter((item) => item.repairable).length,
      invalidManifestLines: Number(manifest.invalid) || 0,
      coldRoot,
      coldRoots: roots,
      trashRoot: this.paths.trashRoot,
      trash: {
        count: trashRows.length,
        expired: trashRows.filter((row) => row.expires_at && now >= row.expires_at).length,
        hidden: rows.filter((row) => row.hidden).length,
      },
      scan: { dirs: scanned, limit: scanLimit, truncated },
      checks: DIAGNOSE_CHECKS,
      note: '只读诊断：不移动、不删除、不写 manifest；修复请显式 POST /repair（默认 dry-run 零写入）。',
    };
  }

  /**
   * /repair（FR-P3-5 / P3-D6 / A-P3-5）：
   *  - dry-run（apply !== true）⇒ **零写入**，只回计划；
   *  - apply === true ⇒ 逐项执行（每项一条 manifest op:'repair'），**单项失败即停**、不自动回滚已完成项；
   *  - 幂等：已修好的项在下一次 diagnose 里消失；重发同一 checks 会返回 skipped 而不是报错；
   *  - checks ⊆ /diagnose 的项 id **或**封闭集里的检查名（前者精确、后者整类）。
   */
  async repair(request = {}) {
    return this.enqueue(() => this.repairNow(request));
  }

  async repairNow(request) {
    const body = request && typeof request === 'object' ? request : {};
    const apply = body.apply === true;
    const requested = Array.isArray(body.checks) ? body.checks.map((value) => String(value)).filter(Boolean) : null;
    const diagnosis = await this.diagnose();
    const selection = this.selectRepairItems(diagnosis.items, requested);
    const plans = selection.items.map((item) => {
      const plan = this.planRepair(item);
      return {
        id: item.id,
        check: item.check,
        sessionId: item.sessionId || null,
        group: item.group,
        repairable: Boolean(plan),
        action: plan ? plan.kind : null,
        summary: plan ? plan.summary : '该项没有安全修复动作（只做诊断）',
        detail: item.detail,
      };
    });
    const skipped = selection.fixed.concat(plans.filter((plan) => !plan.repairable).map((plan) => ({ id: plan.id, check: plan.check, reason: 'not-repairable' })));
    if (!apply) {
      return {
        ok: true,
        apply: false,
        writes: 0,
        dryRun: true,
        diagnosisTotal: diagnosis.total,
        planned: plans.filter((plan) => plan.repairable),
        skipped,
        note: 'dry-run：零写入（不写 manifest、不动文件、不改行）。加 apply:true 才会执行。',
      };
    }
    const applied = [];
    for (const item of selection.items) {
      const plan = this.planRepair(item);
      if (!plan) {
        skipped.push({ id: item.id, check: item.check, reason: 'not-repairable' });
        continue;
      }
      try {
        const outcome = await plan.run();
        await this.manifest.append({
          ts: this.now(),
          op: 'repair',
          id: item.sessionId || null,
          check: item.check,
          action: plan.kind,
          ok: true,
          reason: 'diagnose-repair',
        });
        applied.push({ id: item.id, check: item.check, sessionId: item.sessionId || null, action: plan.kind, ok: true, outcome: outcome || null });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        await this.manifest
          .append({ ts: this.now(), op: 'repair', id: item.sessionId || null, check: item.check, action: plan.kind, ok: false, reason: 'repair-failed', detail: message })
          .catch(() => {});
        this.invalidate();
        return {
          ok: false,
          apply: true,
          code: 'repair-failed',
          applied,
          skipped,
          failed: { id: item.id, check: item.check, action: plan.kind, error: message },
          error: '第 ' + (applied.length + 1) + ' 项失败，已停止（已完成项不回滚，逐项可审计）：' + message,
        };
      }
    }
    this.invalidate();
    return {
      ok: true,
      apply: true,
      writes: applied.length,
      applied,
      skipped,
      note: '每项写一条 manifest op:repair；失败即停，不自动回滚已完成项（逐项可审计）。',
    };
  }

  /**
   * 把请求里的 checks 解析成具体项。
   * 未知值（既不是当前项 id、也不在封闭集里）⇒ 抛 invalid-check（fail-closed，零写入）；
   * 封闭集里但当前没有命中项 ⇒ 记为 fixed（幂等重跑不报错）。
   */
  selectRepairItems(items, requested) {
    const all = Array.isArray(items) ? items : [];
    if (!requested) return { items: all.filter((item) => item.repairable), fixed: [] };
    const out = [];
    const seen = new Set();
    const fixed = [];
    for (const key of requested) {
      const hits = all.filter((item) => item.id === key || item.check === key);
      if (!hits.length) {
        /**
         * 幂等（A-P3-5）：已修好的项在下一次 diagnose 里**消失**了，所以重发同一批 checks 不该报错。
         * 判据：这一项的形状属于封闭集 —— 要么是检查名本身，要么是「检查名:会话 id」
         * （检查名不含 ':'、会话 id 也不含 ':'，所以按第一个 ':' 切分是安全的）。
         */
        const colon = key.indexOf(':');
        const prefix = colon > 0 ? key.slice(0, colon) : key;
        if (DIAGNOSE_CHECKS.includes(prefix)) {
          fixed.push({ check: prefix, id: key, reason: 'nothing-to-repair' });
          continue;
        }
        const error = new EngineFailure(
          'invalid-check',
          '未知检查项：' + key + '（只接受 /diagnose 返回的项 id，或封闭集：' + DIAGNOSE_CHECKS.join(' / ') + '）',
        );
        error.checks = DIAGNOSE_CHECKS;
        throw error;
      }
      for (const item of hits) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
    }
    return { items: out, fixed };
  }

  /**
   * 单项 → 可执行动作（封闭集 REPAIR_ACTIONS；**不做 v0→v4 重编码**，P3-D8）。
   * 返回 null = 该项没有安全修复动作（只诊断）。
   */
  planRepair(item) {
    const kind = item && item.repair ? item.repair.kind : null;
    if (!kind || !REPAIR_ACTIONS.includes(kind)) return null;
    const sessionId = item.sessionId ? String(item.sessionId) : null;
    if (kind === 'reindex') {
      return {
        kind,
        summary: '重新索引 ' + sessionId,
        run: async () => {
          const row = this.store.getSession(sessionId);
          if (!row) return { skipped: 'no-row' };
          const dir =
            row.status === 'cold'
              ? path.join(row.cold_root || (await this.coldRoot()), row.rel_dir)
              : path.join(this.paths.sessionsRoot, row.rel_dir);
          if (!(await isDirectory(dir))) throw new EngineFailure('source-missing', '日志目录不存在：' + dir);
          const index = await this.indexSession(sessionId, dir, {
            logNames: row.log_names,
            currentGeneration: sortGenerations(String(row.log_names || '').split(',')).slice(-1)[0],
            formatVersion: row.format_version,
            toolResults: this.librarySearchScope() === SEARCH_SCOPE_TOOL_RESULTS,
          });
          if (!index.ok) throw new EngineFailure(index.error || 'index-failed', '重新索引仍失败：' + (index.detail || index.error || ''));
          return { status: row.status, docs: index.docs || 0 };
        },
      };
    }
    if (kind === 'mark-needs-review') {
      return {
        kind,
        summary: '标 needs-review ' + sessionId,
        run: async () => {
          const row = this.store.getSession(sessionId);
          if (!row) return { skipped: 'no-row' };
          this.store.updateSession(sessionId, { error: ERROR_STATES.NEEDS_REVIEW });
          return { status: row.status, error: ERROR_STATES.NEEDS_REVIEW };
        },
      };
    }
    if (kind === 'append-manifest') {
      return {
        kind,
        summary: '补 manifest 审计行 ' + sessionId,
        run: async () => {
          const row = this.store.getSession(sessionId);
          if (!row) return { skipped: 'no-row' };
          const to = row.status === 'cold' && row.cold_root ? path.join(row.cold_root, row.rel_dir) : null;
          const result = await this.manifest.repairIfMissing({
            ts: this.now(),
            id: sessionId,
            from: null,
            to,
            bytes: row.bytes || 0,
            files: row.log_names ? String(row.log_names).split(',').length : 0,
            sha256: row.source_sha || '',
            ok: true,
            reason: 'diagnose-missing',
          });
          return { repaired: Boolean(result && result.repaired) };
        },
      };
    }
    if (kind === 'delete-manifest-rows') {
      return {
        kind,
        summary: '删掉 ' + sessionId + ' 的 migrate/restore 审计行',
        run: async () => {
          const result = await this.manifest.removeRecords(
            (record) => record && String(record.id) === sessionId && (record.op === 'migrate' || record.op === 'restore'),
          );
          return { removed: result.removed, kept: result.kept };
        },
      };
    }
    if (kind === 'remove-marker') {
      return {
        kind,
        summary: '删掉孤立 marker ' + (item.marker || sessionId),
        run: async () => {
          const name = item.marker || sessionId;
          const removed = await this.markers.remove(name);
          return { marker: name, removed: Boolean(removed) };
        },
      };
    }
    if (kind === 'import-cold') {
      return {
        kind,
        summary: '导入冷目录 ' + (item.dir || sessionId),
        run: async () => {
          const dir = item.dir;
          if (!dir || !(await isDirectory(dir))) throw new EngineFailure('source-missing', '冷目录不存在：' + String(dir));
          const files = (await listDirFiles(dir)).filter((entry) => !entry.dir).map((entry) => entry.name);
          const root = item.root || path.dirname(path.dirname(dir));
          const projectKeyName = item.projectKey || path.basename(path.dirname(dir));
          const row = await this.buildEntryFromDisk(sessionId, { projectKey: projectKeyName, dir, files });
          row.status = 'cold';
          row.cold_root = root;
          row.backfilled = 1;
          row.moved_at = row.file_mtime_ms || this.now();
          row.error = null;
          this.store.upsertSession(row);
          const index = await this.indexSession(sessionId, dir, { logNames: row.log_names, formatVersion: row.format_version });
          await this.manifest.appendDedup({
            ts: this.now(),
            op: 'migrate',
            id: sessionId,
            from: null,
            to: dir,
            bytes: row.bytes || 0,
            files: row.log_names ? String(row.log_names).split(',').length : 0,
            sha256: '',
            ok: true,
            reason: 'repair-import',
            movedAt: row.moved_at,
          });
          return { status: 'cold', docs: index.ok ? index.docs || 0 : 0, indexError: index.ok ? null : index.error || null };
        },
      };
    }
    if (kind === 'clear-hidden') {
      return {
        kind,
        summary: '清掉矛盾的 hidden=1 ' + sessionId,
        run: async () => {
          const row = this.store.getSession(sessionId);
          if (!row) return { skipped: 'no-row' };
          this.store.updateSession(sessionId, { hidden: 0 });
          return { status: row.status, hidden: 0 };
        },
      };
    }
    return null;
  }

  /**
   * §11「跨卷 copy 中断」/「目标卷中途拔出」：只删**确认可重试**的残留。
   *
   * R-17 / A-7 的硬要求（旧实现缺了这一层）：删热侧残留前必须**先探测冷侧可访问**——
   * 冷卷拔掉时热侧残留可能是唯一副本的索引线索，删了就永久丢；此时保留 + 降级只读 + 诊断。
   */
  async cleanupPartials(counts) {
    const coldReport = await this.probeColdRoots();
    const coldAvailable = coldReport.some((item) => item.available);
    if (!coldAvailable) {
      // 一个冷根都访问不了：本轮**不做任何删除**（只读降级），把诊断留给 status/list 的横幅。
      counts.coldUnavailable = (counts.coldUnavailable || 0) + 1;
      this.log('warn', '冷根全部不可访问：跳过残留清理（只读降级，不删除任何数据；A-7/R-17）');
      return;
    }
    const coldRoots = new Set(coldReport.filter((item) => item.available).map((item) => item.root));

    for (const root of coldRoots) {
      let projects = [];
      try {
        projects = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        let sessions = [];
        try {
          sessions = await readdir(path.join(root, project.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const session of sessions) {
          if (!session.isDirectory()) continue;
          const name = session.name;
          const abs = path.join(root, project.name, name);
          if (name.endsWith('.partial')) {
            const base = name.slice(0, -'.partial'.length);
            const hot = path.join(this.paths.sessionsRoot, project.name, base);
            const finalDir = path.join(root, project.name, base);
            // 源未删（热在）或已落最终名（拷贝完成）→ 残留可删；否则保留给人看
            if ((await isDirectory(hot)) || (await isDirectory(finalDir))) {
              await this.removeTree(abs, root).catch(() => {});
              counts.partials = (counts.partials || 0) + 1;
            }
          }
        }
      }
    }

    // 热侧半截目录（跨卷恢复残留）：没有合法代际名 → 整目录清掉
    let projects = [];
    try {
      projects = await readdir(this.paths.sessionsRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      let sessions = [];
      try {
        sessions = await readdir(path.join(this.paths.sessionsRoot, project.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const abs = path.join(this.paths.sessionsRoot, project.name, session.name);
        const entries = await listDirFiles(abs).catch(() => []);
        const files = entries.filter((entry) => !entry.dir).map((entry) => entry.name);
        const parts = files.filter((name) => name.endsWith('.part'));
        if (!parts.length) continue;
        const hasGeneration = files.some((name) => isGenerationName(name));
        if (!hasGeneration) {
          // 只有 .part、没有合法代际：热侧只是**半成品**。删它之前必须确认冷侧有可用的完整副本
          // （否则它可能是唯一线索）——冷副本在 ⇒ 删除可重试；不在 ⇒ 保留 + 诊断（不删）。
          const coldCopy = await this.findColdCopy(project.name, session.name);
          if (!coldCopy) {
            counts.hotResidueKept = (counts.hotResidueKept || 0) + 1;
            this.log('warn', '热侧只有 .part 且冷侧无完整副本：保留不删（' + abs + '）');
            continue;
          }
          await this.removeTree(abs, coldCopy.root).catch(() => {});
          counts.partials = (counts.partials || 0) + 1;
        } else {
          for (const part of parts) {
            await this.removeFile(path.join(abs, part)).catch(() => {});
            counts.partials = (counts.partials || 0) + 1;
          }
        }
      }
    }
  }

  /**
   * FR-2 / §9 / P2-0：启动时把 registry 里的**存量归档 id** 入库（title / workspace / lastActiveAt /
   * archivedAt / formatVersion / projectKey），仅展示/排序用（不再是迁移门槛）。
   *
   * 硬约束（P2-0）：
   *  - 复用 scanArchivedDirs() 的**一次目录扫描**结果，**禁止**逐 id persistence.stat / listDirFiles/statTree；
   *  - 归档集合里有、DB 里没有行 ⇒ 建 hot 行（archived_at = 发现时间）；
   *  - 已有行只**补齐展示面空字段**（archived_at / title / project_key / file_mtime_ms …），
   *    绝不覆盖已落库的事实（cold/restored 行的 status/cold_root 等一个都不动）；
   *  - title 先取宿主投影缓存 hint（4KB 前缀，缺失即留空，由 P2 全量索引回填真实标题）。
   */
  async backfillArchivedAt(counts) {
    const archived = this.archivedIds();
    if (!archived.size) return 0;
    const scan = await this.scanArchivedDirs(archived);
    const now = this.now();
    // F2：行用一次 IN 查询取（旧实现每轮 2 × 118 次 getSession），下面两个循环共用同一份快照。
    const rowsById = this.store.getSessionsByIds([...archived]);
    const missing = [];
    const titleCandidates = [];
    for (const id of archived) {
      const row = rowsById.get(id) || null;
      if (!row) {
        if (!scan.has(id)) continue; // 只有冷副本/盘上不存在：不在这里建行（冷行由对账导入）
        missing.push(id);
        titleCandidates.push(id);
        continue;
      }
      if (!row.title) titleCandidates.push(id);
    }
    const hints = titleCandidates.length ? await this.titleHints(titleCandidates) : new Map();
    const rows = [];
    for (const id of missing) {
      const entry = scan.get(id);
      if (!entry) continue;
      const header = entry.header;
      rows.push({
        session_id: String(id),
        project_key: entry.projectKey,
        rel_dir: entry.relDir,
        log_names: entry.generations.join(','),
        cold_root: null,
        format_version: entry.version === null ? 0 : entry.version,
        bytes: entry.bytes,
        file_size: entry.fileSize,
        file_mtime_ms: entry.fileMtimeMs,
        header_cwd: header && header.cwd ? header.cwd : null,
        header_state: header ? 'ok' : 'header-unverified',
        created_at: header && header.createdAt ? header.createdAt : now,
        title: (hints.get(id) || '').slice(0, 200),
        archived_at: now,
        backfilled: 1,
        moved_at: null,
        restored_at: null,
        status: 'hot',
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
    if (rows.length) this.store.upsertSessions(rows);

    let patched = 0;
    const needAt = [];
    const needFlag = [];
    for (const id of archived) {
      const row = rowsById.get(id) || null;
      if (!row) continue;
      const patch = {};
      // F2：**已有行**（不只新建行）也要补 —— 真机 118/118 archived_at=NULL / backfilled=0。
      // archived_at 只在 null 时写 now（绝不刷新已记录的时间）；hot-restored 同样补（D23 翻回 hot 后还要展示）。
      if ((row.archived_at === null || row.archived_at === undefined) && (row.status === 'hot' || row.status === 'hot-restored')) {
        patch.archived_at = now;
        needAt.push(id);
      }
      if (!row.backfilled) {
        patch.backfilled = 1;
        needFlag.push(id);
      }
      if (!row.title && hints.has(id)) patch.title = hints.get(id).slice(0, 200);
      const entry = scan.get(id);
      if (entry && row.status === 'hot') {
        if (!row.project_key) patch.project_key = entry.projectKey;
        if (!row.rel_dir) patch.rel_dir = entry.relDir;
        if (!row.log_names) patch.log_names = entry.generations.join(',');
        if (!row.file_mtime_ms) patch.file_mtime_ms = entry.fileMtimeMs;
        if (!row.bytes) patch.bytes = entry.bytes;
        if (!row.header_cwd && entry.header && entry.header.cwd) patch.header_cwd = entry.header.cwd;
        if (row.header_state !== 'ok' && entry.header) patch.header_state = 'ok';
        if (row.format_version === 0 && entry.version !== null) patch.format_version = entry.version;
      }
      const keys = Object.keys(patch);
      if (!keys.length) continue;
      // 常见情形（只有 archived_at / backfilled）合并成两次批量写；含其它字段的行仍逐行（罕见）。
      if (keys.every((key) => key === 'archived_at' || key === 'backfilled')) {
        patched += 1;
        continue;
      }
      this.store.updateSession(id, patch);
      patched += 1;
    }
    if (needAt.length) this.store.updateSessions(needAt, { archived_at: now, backfilled: 1 });
    const flagOnly = needFlag.filter((id) => !needAt.includes(id));
    if (flagOnly.length) this.store.updateSessions(flagOnly, { backfilled: 1 });

    const created = rows.length;
    const total = created + patched;
    if (total) {
      if (counts) counts.backfilledArchived = (counts.backfilledArchived || 0) + total;
      this.log('info', 'archivedAt 回填完成：新建 ' + created + ' 行、补齐 ' + patched + ' 行（仅展示/排序用，不作迁移门槛）');
      this.invalidate();
    }
    return total;
  }

  /**
   * AC-9 / A-18：**真实探测** archive-manager（AM）是否安装（旧实现恒 `am: null` 是桩）。
   * 两条证据面：① 宿主插件清单服务（服务名逐版本不同，存在才用）；② profile manifest / cordis.patch.yml。
   * 结果缓存 60s（UI 轮询 15s，不能每次都扫盘）。
   */
  async detectAm(options = {}) {
    const now = this.now();
    if (this._amCache && !options.refresh && now - this._amCache.at < 60000) return this._amCache.value;
    if (typeof this.deps.detectAm === 'function') {
      const injected = await this.deps.detectAm();
      const value = {
        present: Boolean(injected && injected.present),
        matches: (injected && injected.matches) || [],
        sources: (injected && injected.sources) || ['injected'],
        scannedAt: now,
      };
      this._amCache = { at: now, value };
      return value;
    }
    const matches = [];
    const sources = [];
    for (const serviceName of ['pluginInventory', 'pluginManager', 'pluginCatalog', 'plugins']) {
      const service = this.getService(serviceName);
      if (!service) continue;
      let list = null;
      try {
        if (typeof service.list === 'function') list = await service.list();
        else if (typeof service.entries === 'function') list = await service.entries();
        else if (Array.isArray(service.plugins)) list = service.plugins;
        else if (service.plugins && typeof service.plugins.list === 'function') list = await service.plugins.list();
      } catch {
        list = null;
      }
      if (!list) continue;
      sources.push('service:' + serviceName);
      for (const item of Array.isArray(list) ? list : []) {
        const id = typeof item === 'string' ? item : item && (item.canonical || item.name || item.id || item.package);
        if (id && ARCHIVE_MANAGER_PATTERN.test(String(id))) matches.push({ id: String(id), source: 'service:' + serviceName });
      }
      if (matches.length) break;
    }
    if (!matches.length) {
      const home = this.home || this.paths.home;
      const profilesRoot = home ? path.join(home, 'profiles') : null;
      let profiles = [];
      if (profilesRoot) {
        try {
          profiles = await readdir(profilesRoot, { withFileTypes: true });
        } catch {
          profiles = [];
        }
      }
      for (const profile of profiles) {
        if (!profile.isDirectory() || profile.name === 'node_modules') continue;
        const dir = path.join(profilesRoot, profile.name);
        try {
          const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
          const bundles = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
          const names = [...Object.keys((pkg && pkg.dependencies) || {}), ...Object.keys((pkg && pkg.devDependencies) || {}), ...bundles];
          sources.push('profile:' + profile.name);
          for (const name of names) {
            if (ARCHIVE_MANAGER_PATTERN.test(String(name))) matches.push({ id: String(name), source: 'profile:' + profile.name });
          }
        } catch {
          /* 没有 package.json 的 profile 跳过 */
        }
        if (matches.length) break;
        try {
          const patch = await readFile(path.join(dir, 'cordis.patch.yml'), 'utf8');
          for (const line of patch.split('\n')) {
            const hit = /^\s*-?\s*(?:id|name):\s*['"]?([^'"\s#]+)/.exec(line);
            if (hit && ARCHIVE_MANAGER_PATTERN.test(hit[1])) matches.push({ id: hit[1], source: 'patch:' + profile.name });
          }
        } catch {
          /* 没有 cordis.patch.yml 的 profile 跳过 */
        }
        if (matches.length) break;
      }
    }
    const value = { present: matches.length > 0, matches, sources, scannedAt: now };
    this._amCache = { at: now, value };
    return value;
  }

  /**
   * R-21 / 坑 14 + F3：安装后自检，并且**漂移即自愈**。
   *
   * 真机（2026-10-24）：/status 报 overlay = {installed:true, drifted:true, archiveOk:false,
   * unarchiveOk:false} —— 我们的包装被后装者（或服务重建）替换掉了，archivedAt 与透明水合实际失效。
   * 旧实现只 warn 一次，永不恢复。现在：
   *   ① 引用比对判定漂移（checkArchiveTracker，比的是我们自己的函数引用）；
   *   ② 漂移 ⇒ reinstallArchiveTracker **链式重装**（把当前函数当 prior 包进来，绝不覆盖第三方）；
   *   ③ 谁覆盖了我们、何时重装、重装几次进 overlayRepair ⇒ /status 的 banners.overlay 与 UI 横幅；
   *   ④ 重装限流（默认 30s 一次），避免两个插件互相抢包装的风暴；失败也记录原因，不静默。
   *
   * 调用点：/status、/list（UI 每 15s 轮询）与清扫 tick —— 任一读口都能触发 reconcile。
   */
  /**
   * F3（P2.3）：自动重装的退避间隔。第 1 次重装前 30s，第 2 次 30s，第 3 次 60s …… 封顶 5 分钟。
   * 设计口径：done <= 1 ⇒ base（保住旧行为「30s 一次」）；done >= 2 ⇒ base × 2^(done-1)。
   */
  overlayBackoffMs(done) {
    const base = Number.isFinite(this.overlayRepairThrottleMs) && this.overlayRepairThrottleMs > 0
      ? this.overlayRepairThrottleMs
      : OVERLAY_BACKOFF_BASE_MS;
    const attempts = Math.max(0, Number(done) || 0);
    const factor = attempts <= 1 ? 1 : Math.pow(2, attempts - 1);
    return Math.min(OVERLAY_BACKOFF_MAX_MS, Math.round(base * factor));
  }

  /**
   * F2（P2.3）：调一次安装器（index.js 注入，能重新解析 workspaceRegistry），把结果落成可读状态。
   * 安装器返回 installArchiveTrackerDetailed 的形状：{ok, installed, supported, shape, reason, error, state, disposer}；
   * P2.4 追加 {retryable, throws, errorName, programmingError, stack} —— 这些字段一并落进 this.overlayInstall，
   * 让 /diag 与 /status.banners.overlay 能区分「编程错误（可重试）」与「宿主形状不支持（停手）」。
   */
  runOverlayInstaller() {
    const now = this.now();
    let outcome = null;
    try {
      outcome = typeof this.overlayInstaller === 'function' ? this.overlayInstaller() : null;
    } catch (err) {
      // F2（P2.4）：安装器抛错 = 插件侧编程错误，**不是**「宿主形状不支持」——
      // 旧实现在这里写 supported:false，随后被下面的门判定成永久停手（真机 ReferenceError 就这样静默失效）。
      outcome = {
        ok: false,
        installed: false,
        supported: true,
        retryable: true,
        shape: 'threw',
        reason: 'threw',
        error: err && err.message ? err.message : String(err),
        errorName: err && err.name ? String(err.name) : 'Error',
        programmingError: true,
        stack: err && err.stack ? String(err.stack) : null,
        throws: 1,
      };
      try {
        this.log('warn', '归档包装安装器抛错（这不是宿主形状不支持，自动重试不会停止）。完整堆栈：\n' + (outcome.stack || '(无堆栈)'));
      } catch {
        /* 日志永不抛 */
      }
    }
    if (!outcome || typeof outcome !== 'object') {
      outcome = { ok: false, installed: false, supported: false, reason: 'no-outcome', error: '安装器没有返回读数' };
    }
    this.overlayInstall = {
      lastAttemptAt: now,
      ok: Boolean(outcome.ok),
      installed: Boolean(outcome.installed),
      supported: outcome.supported !== false,
      shape: outcome.shape || null,
      reason: outcome.reason || null,
      error: outcome.error || null,
      state: outcome.state || null,
      // F2（P2.4）：把「编程错误 / 可重试」证据透传到读面（/diag 的 install、/status 的 banners.overlay）——
      // 旧实现只保留 ok/supported/shape/reason，真机那次 ReferenceError 在读面上只剩 shape:"threw"。
      retryable: outcome.retryable === true,
      throws: Number(outcome.throws) || 0,
      errorName: outcome.errorName || null,
      programmingError: outcome.programmingError === true,
      stack: outcome.stack || null,
    };
    if (outcome.supported === false && outcome.retryable !== true && outcome.reason && outcome.reason !== 'no-registry') {
      // 形状不支持：别再自动重试安装（等 /diag 的手动 retry）。
      // retryable=true（编程错误 / 模块未加载 / 未就绪）一律**不**停手。
      this.overlayUnsupported = true;
    }
    if (outcome.ok && outcome.installed) {
      this.overlayUnsupported = false;
      this.overlayDrift = null;
    }
    return this.overlayInstall;
  }

  /**
   * F2/F3（P2.3）：手动重置并重试包装（POST /session-vault/api/diag {"action":"retry-overlay"}）。
   * 同一次调用里清掉「停手」标记 → 重新安装/重装 → 返回新的诊断读数。
   */
  retryOverlay() {
    this.overlayRepair = null;
    this.overlayUnsupported = false;
    this.overlayInstall = null;
    const check = this.verifyOverlay({ force: true, autoRepair: true });
    return {
      ok: true,
      check,
      overlay: this.overlayBanner(check),
      install: this.overlayInstall,
      repair: this.overlayRepair,
    };
  }

  verifyOverlay(options = {}) {
    const registry = this.registry || this.getService('workspaceRegistry');
    if (!this.registry && registry) this.registry = registry;
    const wasDrifted = Boolean(this.overlayDrift);
    const force = options.force === true;
    const autoRepair = options.autoRepair !== false;
    const now = this.now();
    const installState = () => (this.overlayInstall && this.overlayInstall.state) || null;

    // ①（F2）还没装上 ⇒ 先尝试（重新）安装一次。真机教训：启动窗口里 workspaceRegistry 可能还没
    // 就绪，旧实现只装一次、捕获到 null 就永不重试 ⇒ archivedAt / 透明水合静默失效。
    let result = checkArchiveTracker(registry, installState());
    if (!result.installed && registry && autoRepair && !this.overlayDisabled && typeof this.overlayInstaller === 'function' &&
        (!this.overlayUnsupported || force)) {
      const lastInstallAt = this.overlayInstall && this.overlayInstall.lastAttemptAt ? this.overlayInstall.lastAttemptAt : 0;
      if (force || now - lastInstallAt >= this.overlayBackoffMs(0)) {
        this.runOverlayInstaller();
        result = checkArchiveTracker(registry, installState());
      }
    }

    if (registry && result.supported === false) {
      // ②（F2）形状不支持（Proxy set 不生效 / 只读 / 缺方法）：明确记录、停手，不抖。
      const reason = result.reason || 'unsupported';
      const previous = this.overlayRepair || {};
      if (!previous.repairFailed || previous.reason !== 'overlay-unsupported: ' + reason) {
        this.overlayRepair = {
          ...previous,
          lastAttemptAt: previous.lastAttemptAt || now,
          reinstalls: previous.reinstalls || 0,
          repairFailed: true,
          reason: 'overlay-unsupported: ' + reason,
          lastError: reason,
        };
        this.log('warn', '归档追踪不可用：宿主 workspaceRegistry 的形状不支持包装（' + reason +
          '）。已停止自动重装；修好后可 POST /session-vault/api/diag {"action":"retry-overlay"} 手动重试');
      }
    } else if (result.drifted && autoRepair && registry) {
      const repair = this.overlayRepair || {};
      const done = Number(repair.reinstalls) || 0;
      const max = this.overlayMaxAutoReinstalls;
      if (repair.repairFailed && !force) {
        // 已经停手：保留原因，不再每 30s 抖一次（/diag 的 retry 会清掉它）
      } else if (done >= max && !force) {
        // ③（F3）重装到顶仍 mismatched ⇒ 停手（真机 reinstalls=10 的抖动就是缺了这一条）。
        this.overlayRepair = {
          ...repair,
          repairedAt: repair.repairedAt || null,
          lastAttemptAt: repair.lastAttemptAt || now,
          reinstalls: done,
          repairFailed: true,
          reason: 'auto-reinstall-stopped: 已自动重装 ' + done + ' 次仍检测到归档包装漂移（' + (result.reason || 'drifted') +
            '）；停止自动重装以免抖动。手动重试：POST /session-vault/api/diag {"action":"retry-overlay"}',
        };
        this.log('warn', '归档包装自动重装已停手（第 ' + done + ' 次后仍 mismatched）：archivedAt / 透明水合不可用；原因=' + (result.reason || 'drifted'));
      } else {
        const lastAt = repair.lastAttemptAt ? repair.lastAttemptAt : 0;
        const throttle = this.overlayBackoffMs(done);
        if (force || now - lastAt >= throttle) {
          let outcome = null;
          try {
            outcome = reinstallArchiveTracker({
              registry,
              engine: this,
              getConfig: () => {
                try {
                  const cached = this.configStore && typeof this.configStore.peek === 'function' ? this.configStore.peek() : null;
                  return (cached && cached.config) || {};
                } catch {
                  return {};
                }
              },
              log: (level, message) => this.log(level, message),
              stateHint: installState(),
            });
          } catch (err) {
            outcome = { ok: false, reason: 'threw', error: err && err.message ? err.message : String(err) };
          }
          const previous = this.overlayRepair || {};
          if (outcome && outcome.ok) {
            this.overlayRepair = {
              lastAttemptAt: now,
              repairedAt: outcome.reinstalled ? now : previous.repairedAt || null,
              reinstalls: Number(outcome.reinstalls) || previous.reinstalls || 0,
              replacedBy: outcome.replacedBy || previous.replacedBy || null,
              lastError: null,
              repairFailed: false,
              reason: null,
            };
            result = checkArchiveTracker(registry, installState());
            // 重装是一次真实状态变化：/list 的缓存必须失效，否则 UI 要等 TTL 才看到新的读数。
            if (outcome.reinstalled) this.invalidate();
          } else {
            this.overlayRepair = {
              lastAttemptAt: now,
              repairedAt: previous.repairedAt || null,
              reinstalls: previous.reinstalls || 0,
              replacedBy: previous.replacedBy || null,
              lastError: (outcome && (outcome.error || outcome.reason)) || 'reinstall-failed',
              repairFailed: false,
              reason: null,
            };
            this.log('warn', '归档包装自动重装失败（archivedAt / 透明水合仍不可用）：' + this.overlayRepair.lastError);
          }
        }
      }
    } else if (!result.drifted && this.overlayRepair) {
      // 健康：清掉错误/停手标记（replacedBy / reinstalls 保留为审计读数）
      this.overlayRepair = {
        ...this.overlayRepair,
        lastError: null,
        repairFailed: false,
        reason: null,
      };
    }

    this.overlayDrift = result.drifted
      ? {
          ...result,
          replacedBy: this.overlayRepair ? this.overlayRepair.replacedBy : null,
          repairedAt: this.overlayRepair ? this.overlayRepair.repairedAt : null,
          reason: this.overlayRepair && this.overlayRepair.reason ? this.overlayRepair.reason : result.reason || null,
        }
      : null;
    // 漂移状态变化 = 列表缓存失效（Y-10：按事件失效，不靠下一次 15s 轮询）
    if (wasDrifted !== Boolean(result.drifted)) this.invalidate();
    if (result.drifted && !(this.overlayRepair && this.overlayRepair.repairFailed)) {
      this.log('warn', '归档包装仍指向它处（自动重装未成功，或刚被再次覆盖）：archivedAt 追踪 / 透明水合不可用（R-21 / 坑 14）');
    }
    return result;
  }

  /** 冷侧是否存在「有合法代际」的完整副本（cleanupPartials 的删前探测）。 */
  async findColdCopy(projectKeyName, sessionId) {
    for (const root of this.knownColdRoots()) {
      const dir = path.join(root, projectKeyName, sessionId);
      if (!(await isDirectory(dir))) continue;
      const files = (await listDirFiles(dir).catch(() => [])).filter((entry) => !entry.dir).map((entry) => entry.name);
      if (files.some((name) => isGenerationName(name))) return { root, dir };
    }
    return null;
  }

  /**
   * 3 号项（🟡「行卡死在 migrating 且无 marker」的兜底扫描）。
   *
   * 判据：status ∈ {migrating, restoring} ∧ 无 marker ∧ **热目录仍在盘**。
   * 满足 ⇒ 这一行没有任何收敛依据（marker 收敛只认 marker，冷目录对账只认 cold/trash 行），
   * 而 preflight 又以 status≠hot 判 not-candidate ⇒ 用户既看不见也重试不了。翻回 hot + 落诊断。
   *
   * 只翻「热侧确实在盘」的行：热侧不存在时**绝不凭空造热态**（那是 §11 的 lost / needs-review 面，
   * 由 marker 收敛与冷目录对账负责，自动例程不猜）。
   */
  async reconcileStrayStatuses(counts) {
    const rows = this.store.listSessions({ status: ['migrating', 'restoring'] });
    for (const row of rows) {
      if (!row.rel_dir) continue;
      const marker = await this.markers.read(row.session_id);
      if (marker) continue; // 有 marker ⇒ marker 收敛负责（它可能刚续跑完）
      const hotDir = path.join(this.paths.sessionsRoot, row.rel_dir);
      if (!(await isDirectory(hotDir))) continue;
      this.store.updateSession(row.session_id, {
        status: 'hot',
        error: 'stray-status-recovered: ' + row.status,
      });
      counts.strayRecovered = (counts.strayRecovered || 0) + 1;
      this.log('warn', '游离状态行已翻回 hot：' + row.session_id + '（原 status=' + row.status + '，无 marker，热目录在盘）');
    }
    // P3b：status='trash' 的游离行（回收站搬移的在途状态，但没有 marker —— 崩在写 marker 之后/删 marker 之前）。
    for (const row of this.store.listSessions({ status: ['trash'] })) {
      try {
        await this.reconcileStrayTrashRow(row, counts);
      } catch (err) {
        counts.failed += 1;
        this.log('warn', '游离 trash 行收敛失败 ' + row.session_id + '：' + (err && err.message ? err.message : err));
      }
    }
  }

  /**
   * 一条 status='trash' 但没有 marker 的行怎么收敛（P3b）：
   *  - 冷目录还在      ⇒ 搬移没发生/已回滚：撤销在途状态（行回 cold）；
   *  - 冷目录不在、回收站里有副本 ⇒ 按现场重建基线并补尾段（trash 行入库 + 删 sessions 行 + manifest）；
   *  - 两边都没有      ⇒ error='lost'（不删行、不猜）。
   * 绝不因为「没有 marker」就删除任何文件。
   */
  async reconcileStrayTrashRow(row, counts) {
    const sessionId = String(row.session_id);
    const marker = await this.markers.read(TRASH_MARKER_PREFIX + sessionId);
    if (marker) return; // marker 收敛负责
    const cfg = await this.config();
    const coldRoot = row.cold_root || effectiveColdRoot(cfg, this.paths);
    const coldDir = row.rel_dir ? path.join(coldRoot, row.rel_dir) : null;
    if (coldDir && (await isDirectory(coldDir))) {
      this.store.updateSession(sessionId, { status: 'cold', error: 'stray-status-recovered: trash' });
      counts.strayRecovered = (counts.strayRecovered || 0) + 1;
      this.log('warn', '游离 trash 行已翻回 cold（冷目录仍在，搬移未完成）：' + sessionId);
      return;
    }
    const container = path.join(this.paths.trashRoot, sessionId);
    let entry = null;
    try {
      const dirs = (await readdir(container, { withFileTypes: true })).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      for (const dir of dirs) {
        const candidate = path.join(container, dir.name);
        const files = (await listDirFiles(candidate).catch(() => [])).filter((item) => !item.dir).map((item) => item.name);
        if (!files.some((name) => isGenerationName(name))) continue;
        entry = { dir: candidate, name: dir.name };
        break;
      }
    } catch {
      entry = null;
    }
    if (!entry) {
      this.store.updateSession(sessionId, { error: ERROR_STATES.LOST });
      counts.lost += 1;
      this.log('warn', '游离 trash 行：冷目录与回收站副本都不存在，已标 lost（不删行）：' + sessionId);
      return;
    }
    const baseline = await hashTree(entry.dir);
    const trashedAt = Number(entry.name);
    const now = this.now();
    const markerLike = {
      op: 'trash',
      sessionId,
      src: coldDir,
      dst: entry.dir,
      coldRoot,
      relDir: row.rel_dir,
      sha256: baseline.sha256,
      files: baseline.files,
      bytes: baseline.bytes,
      trashedAt: Number.isFinite(trashedAt) && trashedAt > 0 ? trashedAt : now,
      expiresAt: (Number.isFinite(trashedAt) && trashedAt > 0 ? trashedAt : now) + TRASH_RETENTION_MS,
      rowJson: JSON.stringify(row),
      reason: 'boot-stray-tail',
    };
    await this.completeTrashTail(sessionId, markerLike, row);
    counts.resumedTrash += 1;
    this.log('warn', '游离 trash 行已补完尾段（回收站副本按现场重建基线）：' + sessionId);
  }

  async reconcileRegistry(counts) {
    const archived = this.archivedIds();
    const protective = new Set([ERROR_STATES.LOST, ERROR_STATES.NEEDS_REVIEW]);
    for (const row of this.store.listSessions({ status: ['cold'] })) {
      // P4（I-17 / A-P4-8）：class S 的冷行**永不参与** A-13 判定 ——
      // 它本来就不在 archivedSessionIds 里，旧判据会把每一行都标 external-unarchived，
      // 进而让整台 Sweeper 在下一拍被 external-unarchived-unsettled 锁死（P-2 的原样重现）。
      if (this.rowClass(row, archived) === 'subagent') continue;
      if (!archived.has(row.session_id) && !protective.has(row.error)) {
        // A-13：cold ⇒ id ∈ archivedSessionIds（I-11）。拦截器在场时不会走到这里。
        this.store.updateSession(row.session_id, { error: ERROR_STATES.EXTERNAL_UNARCHIVED });
        counts.externalUnarchived += 1;
      }
    }
    for (const row of this.store.listSessions({ status: ['hot-restored'] })) {
      // P4：hot-restored → hot 翻写仍**只作用于 class A**（class S 的恢复直接落 hot，见 finishRestore）
      if (this.rowClass(row, archived) === 'subagent') continue;
      if (archived.has(row.session_id)) {
        // D23：重入归档集合 → hot（否则永远不可迁）
        this.store.updateSession(row.session_id, { status: 'hot' });
        counts.flipped += 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
/** 读 registry 上的符号状态（Proxy / 抛错的 get 都不能让诊断抛出去）。 */
function safeGet(target, key) {
  try {
    return target ? target[key] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * F2（P2.3）：两个函数引用是否「仍然是我们的包装」。
 *
 * - 普通实例 = 直接引用比对（identity）；
 * - Proxy / 函数代理形态（真机证据：name 仍是我们的包装名、toString 已是 native）= 按契约名比对。
 *   这种形态下**每次读都可能返回新的代理对象**，引用永远不等；但调用仍然落到我们的包装上。
 *   装/重装时写入探针会验证「写确实生效」，所以这里按名字比对不是猜测。
 */
/**
 * F2：函数「契约名」比对 —— 代理形态下读回的函数可能带 \`bound \` 前缀（get 陷阱里 bind 到服务上）。
 * 只放宽这一个已知前缀；名字不同一律不认（第三方包装照旧判漂移）。
 */
function functionNameMatches(current, expected) {
  if (!current || !expected) return false;
  let a = '';
  let b = '';
  try {
    a = typeof current.name === 'string' ? current.name : '';
    b = typeof expected.name === 'string' ? expected.name : '';
  } catch {
    return false;
  }
  if (!a || !b) return false;
  return a === b || a === 'bound ' + b;
}

export function sameOverlayMethod(current, expected, state = null) {
  if (!current || !expected) return false;
  if (current === expected) return true;
  const by = state && state.verification && state.verification.by ? state.verification.by : null;
  if (by !== 'proxy-name') return false;
  try {
    return typeof current === 'function' && typeof expected === 'function' && functionNameMatches(current, expected);
  } catch {
    return false;
  }
}

/**
 * R-21 / 坑 14：归档包装自检。
 * 「装上了」不是「还生效」：后装插件把 archiveSession 再包一层就会把我们盖掉，
 * 那时 archivedAt 与透明水合会**静默失效**。这个函数给 UI 一份可判定的读数。
 *
 * F2（P2.3）：增加 supported / shape / verifiedBy / reason —— 「宿主形状不支持」与
 * 「被第三方覆盖」是两种不同的故障，前者自愈无效（重装永远 mismatched），必须能区分。
 *
 * @param {object} registry
 * @param {object|null} stateHint installArchiveTrackerDetailed 返回的共享状态
 *   （Proxy 可能让 registry[VAULT_STATE] 读不到，调用方直接传更可靠）
 */
export function checkArchiveTracker(registry, stateHint = null) {
  const state = stateHint || safeGet(registry, VAULT_STATE) || null;
  if (!registry) {
    // 服务还没就绪 ≠ 形状不支持：如实标 no-registry，但**不**进入「停手/不支持」分支
    // （引擎会每 30s 通过 overlayInstaller 重新解析 registry 补装）。
    return {
      installed: false, supported: true, archiveOk: false, unarchiveOk: false, drifted: false,
      shape: state ? state.shape : 'no-registry', verifiedBy: null, reason: 'no-registry',
    };
  }
  const installed = safeGet(registry, VAULT_OVERLAY) === true;
  const originals = safeGet(registry, VAULT_ORIGINAL) || null;
  if (!installed || !originals) {
    return {
      installed: false,
      supported: state ? state.supported !== false : true,
      archiveOk: false,
      unarchiveOk: false,
      drifted: false,
      shape: state ? state.shape : 'not-installed',
      verifiedBy: null,
      reason: state && state.reason ? state.reason : 'not-installed',
    };
  }
  if (state && state.supported === false) {
    return {
      installed: true,
      supported: false,
      archiveOk: false,
      unarchiveOk: false,
      drifted: true,
      shape: state.shape || 'unsupported',
      verifiedBy: null,
      reason: state.reason || 'unsupported',
    };
  }
  // 判断「还是我们的包装」必须对我们自己的函数引用（Proxy 形态下退化为契约名比对），
  // 而不是对 original：后装插件再包一层时 registry.archiveSession 依然 !== original，会比漏检。
  const wrapped = safeGet(registry, VAULT_WRAPPED) || null;
  const archiveOk = sameOverlayMethod(safeGet(registry, 'archiveSession'), wrapped && wrapped.archiveSession, state);
  const unarchiveOk = sameOverlayMethod(safeGet(registry, 'unarchiveSession'), wrapped && wrapped.unarchiveSession, state);
  const drifted = !archiveOk || !unarchiveOk;
  return {
    installed: true,
    supported: true,
    archiveOk,
    unarchiveOk,
    drifted,
    shape: state ? state.shape || null : null,
    verifiedBy: state && state.verification ? state.verification.by || null : 'identity',
    reason: drifted ? 'drifted' : null,
  };
}

/**
 * F2（P2.3）：registry 形状诊断 —— 「先诊断再修」的取证面。
 *
 * 真机证据（2026-10-24 11:30）：/status.banners.overlay 的 replacedBy 显示
 * {name:"wrappedArchive", source:"function () { [native code] }"} —— name 还是**我们的**包装名、
 * toString 却已是 native。这正是「函数 Proxy」的签名（Proxy 没有 [[SourceText]]，name 转发到目标）。
 * 也就是说 ctx.get("workspaceRegistry") 未必是裸实例：赋值后回读拿不到同一引用，旧代码把
 * 「引用不等」判成「被第三方覆盖」⇒ 每 30s 重装一次，10 次也修不好（抖动）。
 *
 * 这里只做**形状取证**（不写）；写探针见 probeRegistrySet。
 */
export function describePropertyDescriptor(descriptor) {
  if (!descriptor) return null;
  const hasValue = Object.prototype.hasOwnProperty.call(descriptor, 'value');
  return {
    kind: hasValue ? 'data' : 'accessor',
    hasGet: typeof descriptor.get === 'function',
    hasSet: typeof descriptor.set === 'function',
    writable: hasValue ? Boolean(descriptor.writable) : null,
    enumerable: Boolean(descriptor.enumerable),
    configurable: Boolean(descriptor.configurable),
    valueType: hasValue ? typeof descriptor.value : null,
    valueName: hasValue && typeof descriptor.value === 'function' ? describeOverlayFunction(descriptor.value).name : null,
  };
}

/** 沿原型链找属性宿主：depth 0 = 实例自有，1 = 直接原型，… */
export function findPropertyOwner(target, key, maxDepth = 8) {
  let owner = target;
  let depth = 0;
  while (owner && depth <= maxDepth) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) return { owner, descriptor, depth };
    owner = Object.getPrototypeOf(owner);
    depth += 1;
  }
  return null;
}

/**
 * @param {object} registry
 * @param {string} key archiveSession | unarchiveSession
 */
export function inspectRegistryShape(registry, key = 'archiveSession') {
  const info = {
    key,
    present: Boolean(registry),
    type: typeof registry,
    isProxy: false,
    constructorName: null,
    prototypeConstructorName: null,
    ownDescriptor: null,
    prototypeDescriptor: null,
    prototypeDepth: null,
    ownerKind: 'none',
    readable: false,
    valueName: null,
    valueSource: null,
    error: null,
  };
  if (!registry) {
    info.error = 'no-registry';
    return info;
  }
  try {
    info.isProxy = typeof utilTypes.isProxy === 'function' ? Boolean(utilTypes.isProxy(registry)) : false;
  } catch {
    info.isProxy = null;
  }
  try {
    const ctor = registry.constructor;
    info.constructorName = typeof ctor === 'function' ? ctor.name || null : null;
  } catch {
    info.constructorName = null;
  }
  try {
    const proto = Object.getPrototypeOf(registry);
    const protoCtor = proto && proto.constructor;
    info.prototypeConstructorName = typeof protoCtor === 'function' ? protoCtor.name || null : null;
  } catch {
    info.prototypeConstructorName = null;
  }
  try {
    info.ownDescriptor = describePropertyDescriptor(Object.getOwnPropertyDescriptor(registry, key));
  } catch {
    info.ownDescriptor = null;
  }
  try {
    const proto = Object.getPrototypeOf(registry);
    const found = proto ? findPropertyOwner(proto, key, 7) : null;
    if (found) {
      info.prototypeDepth = found.depth + 1;
      info.prototypeDescriptor = describePropertyDescriptor(found.descriptor);
    }
  } catch {
    info.prototypeDescriptor = null;
  }
  try {
    const value = registry[key];
    info.readable = typeof value === 'function';
    if (info.readable) {
      const described = describeOverlayFunction(value);
      info.valueName = described.name;
      info.valueSource = described.source;
    }
  } catch (err) {
    info.error = err && err.message ? err.message : String(err);
  }
  if (info.readable) {
    if (info.ownDescriptor) info.ownerKind = info.ownDescriptor.kind === 'accessor' ? 'accessor' : 'own';
    else if (info.prototypeDescriptor) info.ownerKind = info.prototypeDescriptor.kind === 'accessor' ? 'prototype-accessor' : 'prototype';
    else info.ownerKind = info.isProxy ? 'proxy' : 'unknown';
  }
  return info;
}

/**
 * F2（P2.3）：写探针 —— Reflect.set 一个带唯一名字的探针函数，立即回读，再还原。
 *
 * 判定：
 *  - readBackEqual=true ⇒ 普通实例（引用回读得到同一引用）；
 *  - readBackEqual=false 且 nameMatch=true ⇒ 读路径把函数包了一层（Proxy/绑定）而**写确实生效**；
 *  - 两者都 false ⇒ set 不生效（只读 / set 被吞）⇒ 包装不受支持。
 *
 * 全部同步执行（set→read→restore 之间没有 await），不会与宿主并发交错。
 */
export function probeRegistrySet(registry, key = 'archiveSession', options = {}) {
  const evidence = {
    key,
    supported: false,
    readOk: false,
    setReturned: null,
    readBackEqual: null,
    nameMatch: null,
    distinctReads: null,
    restored: false,
    restoreReadBackEqual: null,
    error: null,
    restoreError: null,
  };
  if (!registry) {
    evidence.error = 'no-registry';
    return evidence;
  }
  let current = null;
  try {
    current = registry[key];
  } catch (err) {
    evidence.error = err && err.message ? err.message : String(err);
    return evidence;
  }
  evidence.readOk = typeof current === 'function';
  if (!evidence.readOk) {
    evidence.error = 'not-a-function';
    return evidence;
  }
  try {
    evidence.distinctReads = registry[key] !== current;
  } catch {
    evidence.distinctReads = null;
  }
  const probeName = '__dsh_session_vault_probe_' + Math.random().toString(36).slice(2, 10);
  const probe = async function vaultOverlayProbe() {};
  try {
    Object.defineProperty(probe, 'name', { value: probeName, configurable: true });
  } catch {
    /* name 改不了就用默认名，仅影响可读性 */
  }
  // 写目标要与**安装器的写法**一致：原型数据属性 ⇒ 探针也写在原型上（否则会在实例上留一层
  // 影子自有属性，卸载后原型还原不到实例，诊断本身就把状态改了）；其余一律写 registry（走 setter）。
  let owner = registry;
  let onPrototype = false;
  let rawValue = null;
  try {
    const found = findPropertyOwner(registry, key);
    if (found && found.descriptor && Object.prototype.hasOwnProperty.call(found.descriptor, 'value')) {
      rawValue = typeof found.descriptor.value === 'function' ? found.descriptor.value : null;
      if (found.depth > 0) {
        owner = found.owner;
        onPrototype = true;
      }
    }
  } catch {
    owner = registry;
  }
  evidence.target = onPrototype ? 'prototype' : 'instance';
  // 代理形态下「读到的 current」本身可能是代理包装：优先还原到描述符里**真实存着**的原函数
  // （rawValue），避免每诊断一次就多叠一层代理；调用方也可显式给 restoreTo（我们登记的包装）。
  const restoreValue = typeof options.restoreTo === 'function' ? options.restoreTo : (rawValue || current);
  try {
    evidence.setReturned = Reflect.set(owner, key, probe);
    const back = registry[key];
    evidence.readBackEqual = back === probe;
    evidence.nameMatch = Boolean(back && typeof back === 'function' && (back.name === probeName || back.name === 'bound ' + probeName));
  } catch (err) {
    evidence.error = err && err.message ? err.message : String(err);
  }
  // 诊断不得改变最终状态：无论写没写进去都还原一次（同步完成，无并发窗口）。
  const restoreName = describeOverlayFunction(restoreValue).name;
  try {
    Reflect.set(owner, key, restoreValue);
    const back = registry[key];
    evidence.restoreReadBackEqual = back === restoreValue;
    evidence.restored = evidence.restoreReadBackEqual || Boolean(back && typeof back === 'function' && back.name === restoreName);
  } catch (err) {
    evidence.restoreError = err && err.message ? err.message : String(err);
  }
  evidence.supported = Boolean(evidence.readBackEqual || evidence.nameMatch);
  return evidence;
}

/**
 * F3：把「谁覆盖了我们」记成一段可判定的人类可读证据（函数名 + toString 片段）。
 * 只用于诊断展示；永不抛（第三方可能给 Proxy / 原生函数）。
 */
export function describeOverlayFunction(fn) {
  if (typeof fn !== 'function') return { name: null, source: null };
  let name = null;
  let source = null;
  try {
    name = typeof fn.name === 'string' && fn.name ? fn.name : null;
  } catch {
    name = null;
  }
  try {
    source = Function.prototype.toString.call(fn).replace(/\s+/g, ' ').trim().slice(0, 160);
  } catch {
    source = null;
  }
  return { name, source };
}

/**
 * 构建一对包装闭包（install / reinstall 共用）。
 *
 * 语义（D-16′ / R-21 / 坑 2/11/13/14）：只记 archivedAt + 透明水合；被包的 prior 一律**照常调用**
 * （链式，绝不吞掉第三方包装）；引擎内部走 originalOf（= 这里登记的 prior），不重入本包装。
 */
function buildArchiveWrappers({ registry, engine, getConfig, log, priorArchive, priorUnarchive }) {
  const hasArchived = (id) => {
    let raw = null;
    try {
      raw = registry.archivedSessionIds;
    } catch {
      raw = null;
    }
    if (!raw) return false;
    const values = Array.isArray(raw) ? raw : typeof raw[Symbol.iterator] === 'function' ? [...raw] : [];
    return values.map(String).includes(String(id));
  };
  const wrappedArchive = async function (sessionId, ...rest) {
    const wasArchived = hasArchived(sessionId);
    const result = await priorArchive.apply(this, [sessionId, ...rest]);
    try {
      await engine.noteArchived(sessionId, { entered: !wasArchived });
    } catch (err) {
      if (log) log('warn', 'archivedAt 记录失败（不影响归档结果）：' + (err && err.message ? err.message : err));
    }
    return result;
  };
  const wrappedUnarchive = async function (sessionId, ...rest) {
    // A2（P2.6 评审裁定）：`hydrateOnUnarchive` 只作用于**官方入口**（就是这里）。
    // 本插件面板 / HTTP 的「取消归档」走 engine.unarchiveSession，对冷会话**恒等于恢复**（数据完整性优先）。
    const cfg = typeof getConfig === 'function' ? getConfig() : {};
    const entry = engine.getSessionEntry(sessionId);
    if (cfg && cfg.hydrateOnUnarchive !== false && entry && entry.status === 'cold') {
      const restored = await engine.restore(sessionId, { reason: 'unarchive-hydrate' });
      if (!restored.ok) {
        const error = new Error(
          '会话保险库：无法把冷会话搬回热目录，已拒绝取消归档（' + (restored.error || restored.code) + '）。文件未被删除，可稍后重试。',
        );
        error.code = 'vault-hydrate-failed';
        throw error;
      }
      // 返回值：水合成功 = 「取消归档已生效」。依据（§7 I-7 的硬顺序，engine.finishRestore 实现）：
      //   ① 文件已整目录搬回 sessionsRoot；② persistence.stat(id) 已可见（身份/路径校验过）；
      //   ③ **official originalUnarchive 已被引擎调用**（包装本身在冷态分支里不重复调它，否则会二次写记账）；
      //   ④ attachSession 尽力完成（失败不阻断）。
      // 官方 unarchiveSession 成功时返回 void，所以此处显式返回 true —— 旧实现裸 `return;` 把
      // 「成功」表达成 undefined，调用方无法区分「成功」与「没走到」。
      return true;
    }
    const result = await priorUnarchive.apply(this, [sessionId, ...rest]);
    try {
      await engine.noteUnarchived(sessionId);
    } catch {
      /* ignore */
    }
    return result;
  };
  return { wrappedArchive, wrappedUnarchive };
}

/**
 * F2（P2.3）：把一对包装写到 registry 上，并**回读验证**。
 *
 * 三种宿主形状（真机诊断驱动，不猜）：
 *  ① 普通实例自有属性（或 Proxy 隐藏描述符）：直接赋值 + 回读；
 *  ② 原型方法：patch **原型**并记录还原描述符（任务 F2 ②；不污染实例，卸载可逐字还原）；
 *  ③ Proxy / 只读：回读既拿不到同一引用、也拿不到同名函数 ⇒ ok:false（明确 unsupported，
 *     调用方停手；不再每 30s 抖一次）。
 *
 * @returns {{key:string, ok:boolean, shape:string, ownerKind:string, error:null|string, restore:null|Function}}
 */
function applyWrappedMethod({ registry, key, value, log }) {
  const result = { key, ok: false, shape: 'unsupported', ownerKind: 'none', error: null, restore: null };
  const readBack = () => {
    try {
      return registry[key];
    } catch (err) {
      result.error = err && err.message ? err.message : String(err);
      return null;
    }
  };
  const matches = (back) => Boolean(back && (back === value || (typeof back === 'function' && functionNameMatches(back, value))));
  let found = null;
  try {
    found = findPropertyOwner(registry, key);
  } catch (err) {
    result.error = err && err.message ? err.message : String(err);
  }

  // ②a 访问器（get/set）：交给宿主自己的 setter 存（不绕过它的语义）。
  if (found && found.descriptor && (found.descriptor.get || found.descriptor.set)) {
    result.ownerKind = 'accessor';
    if (typeof found.descriptor.set !== 'function') {
      result.error = 'accessor-without-setter';
      return result;
    }
    try {
      Reflect.set(registry, key, value);
    } catch (err) {
      result.error = err && err.message ? err.message : String(err);
    }
    const back = readBack();
    if (matches(back)) {
      result.ok = true;
      result.shape = back === value ? 'accessor' : 'proxy';
    } else {
      result.error = result.error || 'set-ineffective';
    }
    return result;
  }

  // ②b 原型方法：patch 原型并记录还原（任务 F2 ②）。
  if (found && found.depth > 0 && found.descriptor && Object.prototype.hasOwnProperty.call(found.descriptor, 'value')) {
    result.ownerKind = 'prototype';
    if (found.descriptor.writable === false) {
      result.error = 'read-only-prototype';
      return result;
    }
    const owner = found.owner;
    const originalDescriptor = found.descriptor;
    try {
      Object.defineProperty(owner, key, { ...originalDescriptor, value });
    } catch (err) {
      result.error = err && err.message ? err.message : String(err);
      return result;
    }
    const back = readBack();
    if (matches(back)) {
      result.ok = true;
      result.shape = back === value ? 'prototype' : 'proxy';
      result.restore = () => {
        try {
          const now = Object.getOwnPropertyDescriptor(owner, key);
          if (now && now.value === value) Object.defineProperty(owner, key, originalDescriptor);
        } catch {
          /* 还原永不抛 */
        }
      };
    } else {
      result.error = result.error || 'set-ineffective';
    }
    return result;
  }

  // ① 自有不可写但可配置的数据属性：defineProperty 改值（赋值会静默失败）。
  if (found && found.depth === 0 && found.descriptor &&
      Object.prototype.hasOwnProperty.call(found.descriptor, 'value') && found.descriptor.writable === false) {
    result.ownerKind = 'own';
    if (!found.descriptor.configurable) {
      result.error = 'read-only-own';
      return result;
    }
    try {
      Object.defineProperty(registry, key, { ...found.descriptor, value });
    } catch (err) {
      result.error = err && err.message ? err.message : String(err);
      return result;
    }
    const back = readBack();
    if (matches(back)) {
      result.ok = true;
      result.shape = back === value ? 'own' : 'proxy';
    } else {
      result.error = result.error || 'set-ineffective';
    }
    return result;
  }

  // ① 普通自有属性 / Proxy 隐藏了描述符：直接赋值 + 回读。
  result.ownerKind = found ? 'own' : 'instance';
  try {
    Reflect.set(registry, key, value);
  } catch (err) {
    result.error = err && err.message ? err.message : String(err);
  }
  const back = readBack();
  if (matches(back)) {
    result.ok = true;
    result.shape = back === value ? 'own' : 'proxy';
    if (typeof log === 'function' && result.shape === 'proxy') {
      log('info', 'workspaceRegistry.' + key + ' 读回是代理/包装函数（引用不等但名字一致）：按代理形态验证');
    }
  } else {
    result.error = result.error || 'set-ineffective';
  }
  return result;
}

/** 引用比对还原（坑 2）：只还原自己那次；别人后装过就不动。 */
function restoreWrappedMethod(registry, key, expected, original) {
  try {
    const current = registry[key];
    const same = current === expected ||
      Boolean(current && expected && typeof current === 'function' && typeof expected === 'function' && functionNameMatches(current, expected));
    if (same) Reflect.set(registry, key, original);
  } catch {
    /* 还原永不抛 */
  }
}

/**
 * 归档包装（D-16′ / R-21 / 坑 2/11/13/14）：只记 archivedAt；引擎一律调 original。
 *
 * F2（P2.3）：返回**详细读数**（形状 / 是否支持 / 原因 / 共享状态 / disposer），
 * 让 index.js 能把「装不上」的根源写进 /status 与 UI 横幅（旧实现抛错后只剩一条 warn）。
 */
export function installArchiveTrackerDetailed({ registry, engine, getConfig, log }) {
  const outcome = {
    ok: false,
    installed: false,
    supported: false,
    shape: 'unsupported',
    reason: null,
    error: null,
    state: null,
    verification: null,
    disposer: () => {},
  };
  if (!registry) {
    outcome.reason = 'no-registry';
    return outcome;
  }
  const existing = safeGet(registry, VAULT_STATE);
  if (safeGet(registry, VAULT_OVERLAY) === true && existing && existing.wrappedArchive) {
    return {
      ok: true,
      installed: true,
      supported: existing.supported !== false,
      shape: existing.shape || 'own',
      reason: existing.reason || null,
      error: null,
      state: existing,
      verification: existing.verification || null,
      disposer: () => {},
    };
  }
  let originalArchive = null;
  let originalUnarchive = null;
  try {
    originalArchive = registry.archiveSession;
    originalUnarchive = registry.unarchiveSession;
  } catch (err) {
    outcome.reason = 'unreadable';
    outcome.error = err && err.message ? err.message : String(err);
    return outcome;
  }
  if (typeof originalArchive !== 'function' || typeof originalUnarchive !== 'function') {
    outcome.reason = 'missing-methods';
    outcome.error = 'workspaceRegistry 缺少 archiveSession/unarchiveSession，无法安装归档包装';
    outcome.state = {
      attempted: true, installed: false, supported: false, shape: 'missing-methods',
      reason: outcome.reason, verification: null, installedAt: Date.now(),
    };
    return outcome;
  }
  const { wrappedArchive, wrappedUnarchive } = buildArchiveWrappers({
    registry, engine, getConfig, log, priorArchive: originalArchive, priorUnarchive: originalUnarchive,
  });
  const appliedArchive = applyWrappedMethod({ registry, key: 'archiveSession', value: wrappedArchive, log });
  const appliedUnarchive = applyWrappedMethod({ registry, key: 'unarchiveSession', value: wrappedUnarchive, log });
  const ok = appliedArchive.ok && appliedUnarchive.ok;
  const shape = ok
    ? (appliedArchive.shape === 'proxy' || appliedUnarchive.shape === 'proxy' ? 'proxy' : appliedArchive.shape)
    : 'unsupported';
  const reason = ok ? null : (appliedArchive.error || appliedUnarchive.error || 'install-failed');
  const state = {
    attempted: true,
    installed: ok,
    supported: ok,
    shape: ok ? shape : 'unsupported',
    reason,
    error: ok ? null : reason,
    verification: { by: ok ? (shape === 'proxy' ? 'proxy-name' : 'identity') : null },
    installedAt: Date.now(),
    originalArchive,
    originalUnarchive,
    wrappedArchive,
    wrappedUnarchive,
    reinstalls: 0,
    replacedBy: null,
    patchRestores: [
      appliedArchive.restore ? { key: 'archiveSession', restore: appliedArchive.restore } : null,
      appliedUnarchive.restore ? { key: 'unarchiveSession', restore: appliedUnarchive.restore } : null,
    ].filter(Boolean),
  };
  if (!ok) {
    // 装不上就绝不留下半套包装（更不能把「装了一半」报成已装）。
    try {
      if (appliedArchive.restore) appliedArchive.restore();
    } catch { /* ignore */ }
    try {
      if (appliedUnarchive.restore) appliedUnarchive.restore();
    } catch { /* ignore */ }
    restoreWrappedMethod(registry, 'archiveSession', wrappedArchive, originalArchive);
    restoreWrappedMethod(registry, 'unarchiveSession', wrappedUnarchive, originalUnarchive);
    outcome.state = state;
    outcome.reason = reason;
    outcome.error = reason;
    outcome.shape = 'unsupported';
    if (typeof log === 'function') {
      log('warn', '归档包装安装失败（' + (appliedArchive.ownerKind || appliedUnarchive.ownerKind) + ' 形态：' +
        reason + '）：archivedAt 追踪与透明水合不可用；已停止自动重装，可用 /session-vault/api/diag {"action":"retry-overlay"} 手动重试');
    }
    return outcome;
  }
  // 成功：登记共享状态（幂等 / 重装 / 卸载都以它为准）。
  try {
    registry[VAULT_STATE] = state;
    registry[VAULT_ORIGINAL] = { archiveSession: originalArchive, unarchiveSession: originalUnarchive };
    registry[VAULT_WRAPPED] = { archiveSession: wrappedArchive, unarchiveSession: wrappedUnarchive };
    registry[VAULT_OVERLAY] = true;
  } catch (err) {
    outcome.error = err && err.message ? err.message : String(err);
  }
  const disposer = () => {
    const shared = safeGet(registry, VAULT_STATE) || state;
    for (const entry of state.patchRestores || []) {
      try {
        entry.restore();
      } catch { /* ignore */ }
    }
    restoreWrappedMethod(registry, 'archiveSession', shared.wrappedArchive, shared.originalArchive);
    restoreWrappedMethod(registry, 'unarchiveSession', shared.wrappedUnarchive, shared.originalUnarchive);
    for (const sym of [VAULT_ORIGINAL, VAULT_WRAPPED, VAULT_STATE, VAULT_OVERLAY]) {
      try {
        delete registry[sym];
      } catch { /* ignore */ }
    }
  };
  outcome.ok = true;
  outcome.installed = true;
  outcome.supported = true;
  outcome.shape = shape;
  outcome.reason = null;
  outcome.state = state;
  outcome.verification = state.verification;
  outcome.disposer = disposer;
  return outcome;
}

/** 兼容入口（旧调用方只要 disposer）：installArchiveTracker({...}) ⇒ dispose()。 */
export function installArchiveTracker(options) {
  return installArchiveTrackerDetailed(options).disposer;
}

/**
 * F3：包装漂移的自动重装（真机实测 overlay = {drifted:true, archiveOk:false, unarchiveOk:false}）。
 *
 * 铁律：**引用比对，绝不覆盖别人的包装**。做法是「链式重装」——把 registry 上**当前**的
 * archiveSession/unarchiveSession（= 覆盖我们的那个第三方包装）当作新的 prior 包进来：
 *   ① 第三方的行为照常执行（不被吞掉、不被回滚）；② 我们的 archivedAt / 透明水合回到最外层（恢复生效）；
 *   ③ 谁覆盖了我们记进 replacedBy（函数名 + toString 片段），供 /status 与 UI 展示。
 *
 * 返回值：{ok, reinstalled, replacedBy, reinstalls}；只在**确实漂移**时才动 registry，否则 no-op。
 */
export function reinstallArchiveTracker({ registry, engine, getConfig, log, stateHint = null }) {
  if (!registry) return { ok: false, reinstalled: false, reason: 'no-registry' };
  const state = stateHint || safeGet(registry, VAULT_STATE) || null;
  if (!state || safeGet(registry, VAULT_OVERLAY) !== true) return { ok: false, reinstalled: false, reason: 'not-installed' };
  let currentArchive = null;
  let currentUnarchive = null;
  try {
    currentArchive = registry.archiveSession;
    currentUnarchive = registry.unarchiveSession;
  } catch (err) {
    return { ok: false, reinstalled: false, reason: 'unreadable', error: err && err.message ? err.message : String(err) };
  }
  if (typeof currentArchive !== 'function' || typeof currentUnarchive !== 'function') {
    return { ok: false, reinstalled: false, reason: 'missing-methods' };
  }
  const oursArchive = sameOverlayMethod(currentArchive, state.wrappedArchive, state);
  const oursUnarchive = sameOverlayMethod(currentUnarchive, state.wrappedUnarchive, state);
  if (oursArchive && oursUnarchive) {
    return { ok: true, reinstalled: false, replacedBy: null, reinstalls: state.reinstalls || 0 };
  }
  const replacedBy = {
    archive: oursArchive ? null : describeOverlayFunction(currentArchive),
    unarchive: oursUnarchive ? null : describeOverlayFunction(currentUnarchive),
  };
  // 只重装漂移的那一个方法：没漂移的一侧保持原引用（不叠层、不改它的 prior）。
  if (!oursArchive) {
    const built = buildArchiveWrappers({
      registry, engine, getConfig, log,
      priorArchive: currentArchive,
      priorUnarchive: currentUnarchive,
    });
    const applied = applyWrappedMethod({ registry, key: 'archiveSession', value: built.wrappedArchive, log });
    if (!applied.ok) {
      return { ok: false, reinstalled: false, reason: 'set-ineffective', error: applied.error, ownerKind: applied.ownerKind };
    }
    state.patchRestores = (state.patchRestores || []).filter((entry) => entry.key !== 'archiveSession');
    if (applied.restore) state.patchRestores.push({ key: 'archiveSession', restore: applied.restore });
    state.originalArchive = currentArchive;
    state.wrappedArchive = built.wrappedArchive;
    state.shape = applied.shape;
  }
  if (!oursUnarchive) {
    const built = buildArchiveWrappers({
      registry, engine, getConfig, log,
      priorArchive: currentArchive,
      priorUnarchive: currentUnarchive,
    });
    const applied = applyWrappedMethod({ registry, key: 'unarchiveSession', value: built.wrappedUnarchive, log });
    if (!applied.ok) {
      return { ok: false, reinstalled: false, reason: 'set-ineffective', error: applied.error, ownerKind: applied.ownerKind };
    }
    state.patchRestores = (state.patchRestores || []).filter((entry) => entry.key !== 'unarchiveSession');
    if (applied.restore) state.patchRestores.push({ key: 'unarchiveSession', restore: applied.restore });
    state.originalUnarchive = currentUnarchive;
    state.wrappedUnarchive = built.wrappedUnarchive;
    state.shape = applied.shape;
  }
  state.reinstalls = (state.reinstalls || 0) + 1;
  state.replacedBy = replacedBy;
  state.supported = true;
  state.installed = true;
  state.reason = null;
  state.verification = { by: state.shape === 'proxy' ? 'proxy-name' : 'identity' };
  try {
    registry[VAULT_ORIGINAL] = { archiveSession: state.originalArchive, unarchiveSession: state.originalUnarchive };
    registry[VAULT_WRAPPED] = { archiveSession: state.wrappedArchive, unarchiveSession: state.wrappedUnarchive };
  } catch { /* ignore */ }
  if (typeof log === 'function') {
    const who = (replacedBy.archive && (replacedBy.archive.name || replacedBy.archive.source)) ||
      (replacedBy.unarchive && (replacedBy.unarchive.name || replacedBy.unarchive.source)) || 'unknown';
    log('warn', '归档包装检测到漂移，已链式自动重装（第 ' + state.reinstalls + ' 次）：覆盖者=' + who +
      '（第三方包装仍会被调用，未被覆盖）');
  }
  return { ok: true, reinstalled: true, replacedBy, reinstalls: state.reinstalls };
}

async function lsLink(target) {
  try {
    const { lstat } = await import('node:fs/promises');
    const info = await lstat(target);
    return info.isSymbolicLink();
  } catch {
    return false;
  }
}
