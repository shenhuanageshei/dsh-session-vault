/**
 * 分词（设计档 §8.3）：中文可搜 = Intl.Segmenter 插词边界 + 拉丁小写；
 * 索引与查询**走同一个函数**（同构是「中文能搜到」的全部秘密）。
 *
 * FTS 查询串转义（A-5c）：先分词，再把每个 token 整体用双引号包裹（内部 " 翻倍），
 * 于是用户输入的 `"` / `*` / `NEAR(` 只会变成「普通词或干脆被丢掉」，
 * 不会变成 FTS5 的语法或全匹配。
 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;
const WORD_RE = /[\p{L}\p{N}_]+/gu;

let segmenter;
let segmenterResolved = false;

function getSegmenter() {
  if (segmenterResolved) return segmenter;
  segmenterResolved = true;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    } else {
      segmenter = null;
    }
  } catch {
    segmenter = null;
  }
  return segmenter;
}

export function normalizeText(input) {
  if (input === null || input === undefined) return '';
  return String(input).normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function pushWord(out, word) {
  if (!word) return;
  const normalized = word.normalize('NFKC');
  if (!normalized) return;
  if (CJK_RE.test(normalized)) out.push(normalized);
  else out.push(normalized.toLowerCase());
}

/**
 * 分词：返回词数组。中文按 Segmenter 的词切（连续中文 → 多词），拉丁小写化。
 * 注意：调用方（索引与查询）必须都用它，否则中文命中率会塌。
 */
export function tokenizeWords(input) {
  const text = normalizeText(input);
  if (!text) return [];
  const out = [];
  const seg = getSegmenter();
  if (seg) {
    for (const part of seg.segment(text)) {
      if (!part.isWordLike) continue;
      pushWord(out, part.segment);
    }
    return out;
  }
  // 兜底：没有 Intl.Segmenter 的环境（索引/查询仍同构）
  for (const match of text.matchAll(WORD_RE)) {
    const run = match[0];
    if (CJK_RE.test(run)) {
      for (const ch of run) if (CJK_RE.test(ch)) out.push(ch);
    } else {
      pushWord(out, run);
    }
  }
  return out;
}

/** 写进 docs.index_text 的形态：词之间单个空格。 */
export function buildIndexText(input) {
  return tokenizeWords(input).join(' ');
}

/** 单个 token 的 FTS5 字符串字面量（内部双引号翻倍）。 */
export function quoteFtsToken(token) {
  return '"' + String(token).replace(/"/g, '""') + '"';
}

/**
 * 查询串 → FTS5 MATCH 表达式。
 * @returns {{match: string|null, tokens: string[]}} match 为 null 表示「没有可检索的词」，调用方应直接返回空结果。
 */
export function toFtsMatch(query) {
  const tokens = tokenizeWords(query);
  if (!tokens.length) return { match: null, tokens: [] };
  const unique = [];
  const seen = new Set();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  return { match: unique.map(quoteFtsToken).join(' AND '), tokens: unique };
}

/** 供测试/诊断：判断一个词是否含中日韩字符。 */
export function hasCjk(input) {
  return CJK_RE.test(String(input || ''));
}
