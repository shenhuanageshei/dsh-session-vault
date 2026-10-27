/**
 * 事件抽取（设计档 §8.2 / C-8 / A-5a）
 *
 * 只收三类：
 *   user/message      → 仅 data.source.kind === 'user'（runtime-context / time-context / skill-catalog /
 *                       agent-instructions / tool-jobs / user-approval 一律不收）
 *   assistant/message → data.message.content[] 里 type === 'text'（reasoning / tool-call 丢）
 *   session/title     → data.title
 * 其余事件（turn/start、step/*、request/header、system/message、tool/*）一律不收。
 *
 * P3 例外（设计档 §18.4 FR-P3-2 / §8.2 / P3-D3 / I-14）：
 *   searchScope='body+toolResults' 时**额外**收 tool/result 的文本结果（docs.surface='tool-result'），
 *   单事件上限 = **8192 个 UTF-8 字节**（M2：按码点累加 Buffer.byteLength，绝不切坏代理对）。
 *   **工具参数（tool/call 的 arguments / tool/result 里的入参回显）一律不入库** ——
 *   参数常含密钥/令牌，且默认关（默认 body 时连 tool/result 的计数都不留文本，只留「这个会话有工具事件」的计数器）。
 *
 * P3a.1 口径（S2 / S3）：
 *  - 工具结果只在 surfaceOf 判定为 current 时收；shadowed / replaced / log-only 一律跳过并计
 *    stats.toolResultsShadowed（与 §4.2 / A-5b 对正文的同一口径）；
 *  - surfaceOf **白名单化**：只认 SURFACE_VALUES 里的已知值，未知值按 current 处理并计
 *    stats.unknownSurface（禁止任意字符串直通到 docs.surface）。
 *
 * 打包行（text-chunks 等没有 type 的数组）→ unknownLines 计数，不索引（R-17）。
 *
 * v0/v3 代际（旧格式）与 v4 的差异（A-22 实测样本）：
 *  - v4：user/message 必有 `data.source.kind`，只有 `user` 是真人输入 → **缺 source 一律 fail-closed**；
 *  - v0/v3：事件形状来自旧格式（首行 `{"type":"session","version":0|3,...}`），user/message **根本没有
 *    source 字段**（实测 481 个真实 v0/v3 会话样本）。若照 v4 规则 fail-closed，这些会话的全文索引恒为空
 *    （docs==0 → extract-empty），用户搜不到任何旧会话。
 *  - 因此：**显式给出 legacy 标志（formatVersion ∈ {0,3}）时**，无 source 的 user/message 视作真人输入入索引，
 *    计数器 legacyNoSource 留证据；若旧格式里**恰好带了** source.kind 且不是 user，仍一律不收（fail-closed 不放松）。
 *  - 版本未知/缺失 → 按 v4 规则 fail-closed（宁漏不进）。
 */
import { buildIndexText } from './tokenize.js';

export const USER_SOURCE_ALLOWED = 'user';

/** tool/result 文档的 docs.surface（正文文档仍是 'current'）。 */
export const TOOL_RESULT_SURFACE = 'tool-result';
/**
 * M2（P3a.1 偏离审计）：工具结果**单事件**上限 = 8KB = **8192 个 UTF-8 字节**（不是 8192 个字符）。
 * 旧实现按「字符」截断 ⇒ 中文只截到 8192 字节的 1/3、8KB 口径名不副实。
 */
export const TOOL_RESULT_MAX_BYTES = 8 * 1024;

/**
 * 事件 surface 的**白名单**（S3）。只认这四个已知值 —— 未知值不得直通成 docs.surface。
 *  - current  现行文本（唯一可检索的正文面）；
 *  - shadowed 被影子覆盖的旧文本（不检索）；
 *  - replaced 被替换的旧文本（不检索）；
 *  - log-only 只留在日志里（宿主 log-only 面；不检索）。
 */
export const SURFACE_VALUES = Object.freeze(['current', 'shadowed', 'replaced', 'log-only']);
/** surface 缺省值（白名单外的值也按它处理）。 */
export const DEFAULT_SURFACE = 'current';

/**
 * 工具结果截断（P3-D3 / M2）。
 * 前置：text 任意（非字符串 ⇒ 按 String() 转，null/undefined ⇒ ''）。
 * 后置：返回的字符串 UTF-8 字节数 <= TOOL_RESULT_MAX_BYTES，且**绝不切坏代理对**
 *       （按码点累加字节，emoji 只在完整码点边界截断）。
 */
export function truncateToolResult(text) {
  const value = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
  if (Buffer.byteLength(value, 'utf8') <= TOOL_RESULT_MAX_BYTES) return value;
  let bytes = 0;
  let end = 0;
  for (const ch of value) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > TOOL_RESULT_MAX_BYTES) break;
    bytes += size;
    end += ch.length;
  }
  return value.slice(0, end);
}

/** 默认（searchScope='body'）收录的事件类型；P3 的 tool/result 例外在 extractEvent 的专门分支里。 */
export const INDEXED_EVENT_TYPES = Object.freeze(['user/message', 'assistant/message', 'session/title']);

export function emptyStats() {
  return {
    lines: 0,
    jsonLines: 0,
    unknownLines: 0,
    userMsgs: 0,
    assistantMsgs: 0,
    titles: 0,
    ignored: 0,
    unmatchedSource: 0,
    legacyNoSource: 0,
    emptyText: 0,
    invalidJson: 0,
    /** 真落了 docs 的 tool/result 文档数（仅 searchScope=body+toolResults 时 >0）。 */
    toolResults: 0,
    /** 见到的 tool/result 事件数（**与 scope 无关**）——升级 pass 用它挑「含工具结果」的会话。 */
    toolResultEvents: 0,
    /**
     * S2：surfaceOf 判定为 shadowed / replaced / log-only 的 tool/result 数（**不收**，只计数）——
     * 与 §4.2 / A-5b 对正文「被替换/影子的旧文本不检索」同一口径。
     */
    toolResultsShadowed: 0,
    /** S3：带了**白名单外** surface 值的事件数（按 current 处理，但必须留证）。 */
    unknownSurface: 0,
  };
}

function addStats(target, delta) {
  for (const key of Object.keys(delta)) {
    target[key] = (target[key] || 0) + delta[key];
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textFromContent(content) {
  const texts = [];
  if (typeof content === 'string') {
    if (content.trim()) texts.push(content);
    return texts;
  }
  if (!Array.isArray(content)) return texts;
  for (const part of content) {
    if (!isPlainObject(part)) continue;
    if (part.type !== 'text') continue; // reasoning / tool-call / image 全丢
    if (typeof part.text === 'string' && part.text.trim()) texts.push(part.text);
  }
  return texts;
}

/** 从事件里取「文本部件」（user 与 assistant 的字段位置不同，两处兜底）。 */
export function textPartsOf(data) {
  if (!isPlainObject(data)) return [];
  const direct = textFromContent(data.content);
  if (direct.length) return direct;
  if (isPlainObject(data.message)) {
    const nested = textFromContent(data.message.content);
    if (nested.length) return nested;
  }
  return [];
}

/**
 * surface 解析（S3 白名单化）。
 *
 * 前置：event 任意（非对象 ⇒ current）。
 * 后置：{ surface, unknown, raw }：
 *  - 已知值（SURFACE_VALUES）⇒ 原样返回，unknown=false；
 *  - 白名单外的任意字符串 ⇒ surface=current + unknown=true（**禁止直通**到 docs.surface，
 *    否则 /search 的 surface IN ('current','tool-result') 过滤会漏判，任意字符串还会污染库）；
 *  - 缺失 ⇒ data.replaced===true / event.replaced===true 视为 shadowed，否则 current（unknown=false）。
 */
export function surfaceInfoOf(event) {
  const data = isPlainObject(event && event.data) ? event.data : {};
  const raw = typeof data.surface === 'string'
    ? data.surface
    : isPlainObject(event) && typeof event.surface === 'string'
      ? event.surface
      : '';
  if (raw) {
    if (SURFACE_VALUES.includes(raw)) return { surface: raw, unknown: false, raw };
    return { surface: DEFAULT_SURFACE, unknown: true, raw };
  }
  if (data.replaced === true || (isPlainObject(event) && event.replaced === true)) {
    return { surface: 'shadowed', unknown: false, raw: '' };
  }
  return { surface: DEFAULT_SURFACE, unknown: false, raw: '' };
}

/** 事件 surface（只读结论面；需要 unknown 计数时用 surfaceInfoOf）。 */
export function surfaceOf(event) {
  return surfaceInfoOf(event).surface;
}

export function timeOf(event) {
  const data = isPlainObject(event && event.data) ? event.data : {};
  const candidates = [event && event.ts, event && event.time, event && event.timestamp, data.ts, data.time];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function seqOf(event) {
  return typeof event.seq === 'number' && Number.isFinite(event.seq) ? Math.trunc(event.seq) : null;
}

function makeDoc({ event, type, role, text, index, surface }) {
  const seq = seqOf(event);
  return {
    seq,
    seqFallbackIndex: index,
    type,
    role,
    time: timeOf(event),
    // tool/result 用自己的 surface（'tool-result'），其余沿用事件自身的 current/shadowed 判定。
    surface: surface || surfaceOf(event),
    text,
    index_text: buildIndexText(text),
  };
}

/** v0/v3 代际（旧格式）：user/message 无 source 字段属正常形状。 */
export const LEGACY_FORMATS = Object.freeze([0, 3]);

export function isLegacyFormat(formatVersion) {
  return LEGACY_FORMATS.includes(Number(formatVersion));
}

/**
 * 抽取一行事件。
 * @param {object} event 一行事件
 * @param {number} index 文档序号兜底
 * @param {{legacy?:boolean, toolResults?:boolean}} [options]
 *   legacy=true      表示 v0/v3 旧格式（无 source 的 user/message 视为真人输入）
 *   toolResults=true 表示 searchScope='body+toolResults'（额外收 tool/result 的**文本结果**）
 * @returns {{docs:Array, stats:object, kind:string}}
 */
export function extractEvent(event, index = 0, options = {}) {
  const legacy = options.legacy === true;
  const toolResults = options.toolResults === true;
  const stats = emptyStats();
  stats.lines = 1;
  const docs = [];

  if (Array.isArray(event) || !isPlainObject(event)) {
    stats.unknownLines = 1;
    return { docs, stats, kind: 'packed' };
  }
  stats.jsonLines = 1;

  const type = typeof event.type === 'string' ? event.type : '';
  if (!type) {
    stats.unknownLines = 1;
    return { docs, stats, kind: 'packed' };
  }

  // S3：surface 只走白名单；白名单外的值按 current 处理，但必须留证（stats.unknownSurface），
  // 且**绝不**把原始字符串写进 docs.surface（否则检索面过滤会漏判）。
  const surfaceInfo = surfaceInfoOf(event);
  if (surfaceInfo.unknown) stats.unknownSurface = 1;

  if (type === 'user/message') {
    const data = isPlainObject(event.data) ? event.data : {};
    const source = data.source;
    const hasSource = source !== undefined && source !== null;
    const sourceKind = isPlainObject(source) ? source.kind : typeof source === 'string' ? source : undefined;
    if (!hasSource) {
      // 旧格式（v0/v3）的 user/message 本来就没有 source：显式 legacy 时视为真人输入；
      // 其余（v4 或版本未知）一律 fail-closed（宁可漏索引，不把注入内容当人话）。
      if (!legacy) {
        stats.unmatchedSource = 1;
        return { docs, stats, kind: 'user-not-human' };
      }
      stats.legacyNoSource = 1;
    } else if (sourceKind !== USER_SOURCE_ALLOWED) {
      // 旧格式里若显式带 source 却非 user → 仍不收（fail-closed 不放松）
      stats.unmatchedSource = 1;
      return { docs, stats, kind: 'user-not-human' };
    }
    const texts = textPartsOf(data);
    if (!texts.length) {
      stats.emptyText = 1;
      return { docs, stats, kind: 'user-empty' };
    }
    docs.push(makeDoc({ event, type: 'user', role: 'user', text: texts.join('\n'), index }));
    stats.userMsgs = 1;
    return { docs, stats, kind: 'user' };
  }

  if (type === 'assistant/message') {
    const data = isPlainObject(event.data) ? event.data : {};
    const texts = textPartsOf(data);
    if (!texts.length) {
      stats.emptyText = 1;
      return { docs, stats, kind: 'assistant-empty' };
    }
    docs.push(makeDoc({ event, type: 'assistant', role: 'assistant', text: texts.join('\n'), index }));
    stats.assistantMsgs = 1;
    return { docs, stats, kind: 'assistant' };
  }

  if (type === 'tool/result') {
    // FR-P3-2：**无论 scope 都计数**（升级 pass 靠它挑「含 tool/result 的会话」，不重读无关会话）。
    stats.toolResultEvents = 1;
    // S2：只有 current 面的工具结果收；shadowed / replaced / log-only 一律跳过并计数
    // （与正文 A-5b「被替换/影子的旧文本不检索」同一口径）。
    if (surfaceInfo.surface !== DEFAULT_SURFACE) {
      stats.toolResultsShadowed = 1;
      stats.ignored = 1;
      return { docs, stats, kind: 'tool-result-shadowed' };
    }
    if (!toolResults) {
      stats.ignored = 1;
      return { docs, stats, kind: 'tool-result-skipped' };
    }
    const data = isPlainObject(event.data) ? event.data : {};
    // v4 形状：结果文本在 data.message.content 的 text 块（research/cold-storage.md §5）；
    // textPartsOf 同时兼容 data.content —— 但**只取 type==='text' 的块**，参数/reasoning 一律丢（P3-D3）。
    const texts = textPartsOf(data);
    if (!texts.length) {
      stats.emptyText = 1;
      return { docs, stats, kind: 'tool-result-empty' };
    }
    const text = truncateToolResult(texts.join('\n'));
    docs.push(makeDoc({ event, type: 'tool-result', role: 'tool', text, index, surface: TOOL_RESULT_SURFACE }));
    stats.toolResults = 1;
    return { docs, stats, kind: 'tool-result' };
  }

  if (type === 'session/title') {
    const data = isPlainObject(event.data) ? event.data : {};
    const title = typeof data.title === 'string' ? data.title : typeof event.title === 'string' ? event.title : '';
    if (!title.trim()) {
      stats.emptyText = 1;
      return { docs, stats, kind: 'title-empty' };
    }
    docs.push(makeDoc({ event, type: 'title', role: 'title', text: title, index }));
    stats.titles = 1;
    return { docs, stats, kind: 'title' };
  }

  stats.ignored = 1;
  return { docs, stats, kind: 'ignored' };
}

/** 解析一行 JSON；空行/坏行分别计数（坏行不崩）。 */
export function parseLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return { ok: false, empty: true };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * 对多行做抽取（纯函数；供单测与引擎共用）。
 * @returns {{docs:Array, stats:object, emptyExtract:boolean}}
 */
export function extractFromLines(lines, options = {}) {
  const stats = emptyStats();
  const docs = [];
  let index = 0;
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed.ok) {
      stats.lines += 1;
      if (parsed.empty) stats.unknownLines += 1;
      else stats.invalidJson += 1;
      continue;
    }
    const result = extractEvent(parsed.value, index, options);
    addStats(stats, result.stats);
    for (const doc of result.docs) docs.push(doc);
    index += 1;
  }
  return { docs, stats, emptyExtract: docs.length === 0 && stats.lines > 0 };
}
