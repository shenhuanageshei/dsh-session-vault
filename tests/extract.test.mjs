import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEvent, extractFromLines, parseLine, isLegacyFormat, LEGACY_FORMATS } from '../lib/extract.js';
import { buildIndexText, tokenizeWords, toFtsMatch, quoteFtsToken } from '../lib/tokenize.js';

const human = (text, extra = {}) => ({
  type: 'user/message',
  seq: 1,
  ts: 1792000000000,
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }], ...extra },
});

test('P1-2: 真人 user/message 入库；注入来源一律不入库（A-5a）', () => {
  const doc = extractEvent(human('把归档会话搬到冷目录'), 0);
  assert.equal(doc.docs.length, 1);
  assert.equal(doc.docs[0].type, 'user');
  assert.equal(doc.docs[0].role, 'user');
  assert.equal(doc.docs[0].seq, 1);
  assert.equal(doc.docs[0].time, 1792000000000);
  assert.equal(doc.docs[0].surface, 'current');
  assert.match(doc.docs[0].text, /归档会话/);

  const injected = [
    'runtime-context',
    'time-context',
    'skill-catalog',
    'agent-instructions',
    'tool-jobs',
    'user-approval',
    'system',
  ];
  for (const kind of injected) {
    const result = extractEvent({
      type: 'user/message',
      seq: 2,
      data: { source: { kind }, content: [{ type: 'text', text: '注入内容不该被索引' }] },
    }, 1);
    assert.equal(result.docs.length, 0, kind + ' 不得入库');
    assert.equal(result.stats.unmatchedSource, 1);
  }
});

test('P1-2（8 号项）：缺 source.kind 的 user/message —— v4 fail-closed，v0/v3 视真人输入', () => {
  const event = {
    type: 'user/message',
    seq: 3,
    ts: 1792000000002,
    data: { content: [{ type: 'text', text: '没有来源标记' }] },
  };
  // v4 / 版本未知：fail-closed（宁可漏索引，不把注入内容当人话）
  const modern = extractEvent(event, 0);
  assert.equal(modern.docs.length, 0);
  assert.equal(modern.stats.unmatchedSource, 1);

  // v0/v3（显式 legacy）：视作真人输入入索引，并留 legacyNoSource 证据
  assert.deepEqual([...LEGACY_FORMATS], [0, 3]);
  for (const formatVersion of [0, 3]) {
    assert.equal(isLegacyFormat(formatVersion), true);
    const legacy = extractEvent(event, 0, { legacy: isLegacyFormat(formatVersion) });
    assert.equal(legacy.docs.length, 1, 'v' + formatVersion + ' 的真人输入必须入索引');
    assert.equal(legacy.stats.legacyNoSource, 1);
    assert.equal(legacy.stats.userMsgs, 1);
  }
  assert.equal(isLegacyFormat(4), false);
  assert.equal(isLegacyFormat(undefined), false);

  // 旧格式里若显式带 source 且非 user → 仍 fail-closed（不放松）
  const injected = extractEvent({
    type: 'user/message',
    seq: 4,
    data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '注入内容' }] },
  }, 0, { legacy: true });
  assert.equal(injected.docs.length, 0);
  assert.equal(injected.stats.unmatchedSource, 1);
});

test('P1-2（8 号项）：extractFromLines 透传 legacy 标志（真实 v0 事件形状）', () => {
  // 形状取自真实 v0 会话样本（首行 type=session/version=0，user/message 无 source）
  const lines = [
    JSON.stringify({ type: 'session', version: 0, id: 's1', cwd: 'D:\\x', createdAt: 1788779880834 }),
    JSON.stringify({ type: 'user/message', seq: 9, time: 1789119375780, data: { content: [{ type: 'text', text: '真实 v0 形状的人话' }] } }),
    JSON.stringify({ type: 'assistant/message', seq: 16, time: 1790135249145, data: { message: { content: [{ type: 'reasoning', text: '推理' }, { type: 'text', text: '真实 v0 的回复' }] } } }),
  ];
  const modern = extractFromLines(lines);
  assert.equal(modern.docs.filter((doc) => doc.type === 'user').length, 0, '默认（v4 规则）不收无 source 的 user/message');
  assert.equal(modern.docs.length, 1, '默认仍收 assistant 的 text（它不需要 source）');
  const legacy = extractFromLines(lines, { legacy: true });
  assert.equal(legacy.docs.length, 2, 'v0：user + assistant 的 text 都要收');
  assert.equal(legacy.emptyExtract, false);
  assert.equal(legacy.stats.legacyNoSource, 1);
  assert.ok(!legacy.docs.some((doc) => doc.text.includes('推理')), 'reasoning 仍不收');
});

test('P1-2: assistant 只收 text，reasoning / tool-call 丢', () => {
  const result = extractEvent({
    type: 'assistant/message',
    seq: 4,
    ts: 1792000000001,
    data: {
      message: {
        content: [
          { type: 'reasoning', text: '内部推理不该出现' },
          { type: 'text', text: '这是可见回复' },
          { type: 'tool-call', name: 'shell', input: { secret: 'password' } },
          { type: 'text', text: '第二段可见回复' },
        ],
      },
    },
  }, 0);
  assert.equal(result.docs.length, 1);
  assert.equal(result.docs[0].text, '这是可见回复\n第二段可见回复');
  assert.ok(!result.docs[0].index_text.includes('内部推理'));
  assert.ok(!result.docs[0].text.includes('password'));
});

test('P1-2: 其他事件（turn/step/tool/request/system）不索引', () => {
  const ignored = [
    { type: 'turn/start', seq: 10 },
    { type: 'step/start', seq: 11 },
    { type: 'tool/call', seq: 12, data: { input: { password: 'x' } } },
    { type: 'request/header', seq: 13, cwd: '<workspace-root>\\x' },
    { type: 'system/message', seq: 14, data: { content: 'system prompt' } },
    { type: 'step/end', seq: 15 },
  ];
  for (const event of ignored) {
    const result = extractEvent(event, 0);
    assert.equal(result.docs.length, 0, event.type + ' 不得入库');
  }
  const { docs, stats, emptyExtract } = extractFromLines(ignored.map((e) => JSON.stringify(e)));
  assert.equal(docs.length, 0);
  assert.equal(stats.lines, ignored.length);
  assert.equal(emptyExtract, true);
});

test('P1-2: session/title 收标题；打包行计 unknownLines', () => {
  const title = extractEvent({ type: 'session/title', seq: 20, data: { title: '会话保险库设计' } }, 0);
  assert.equal(title.docs.length, 1);
  assert.equal(title.docs[0].type, 'title');
  assert.equal(title.docs[0].text, '会话保险库设计');

  const packed = extractEvent([{ type: 'text-chunks', chunks: ['a'] }], 0);
  assert.equal(packed.docs.length, 0);
  assert.equal(packed.stats.unknownLines, 1);

  const noType = extractEvent({ chunks: ['a', 'b'] }, 0);
  assert.equal(noType.stats.unknownLines, 1);
  assert.equal(parseLine('not json').ok, false);
  assert.equal(parseLine('').empty, true);
});

test('P1-2: 中文可搜（索引/查询同构分词）', () => {
  const indexText = buildIndexText('会话保险库的全文搜索支持中文');
  assert.ok(indexText.includes(' '), '中文必须插词边界');
  const tokens = tokenizeWords('会话保险库的全文搜索支持中文');
  assert.ok(tokens.length > 3, '应切成多个词，实际：' + tokens.join('|'));
  assert.ok(tokens.includes('保险') || tokens.includes('搜索') || tokens.includes('中文'));

  const query = toFtsMatch('保险');
  assert.ok(query.match && query.match.includes('"保险"'));

  // 拉丁小写化，混合文本两套 token 合并
  const mixed = buildIndexText('CSV 解析器 Export');
  assert.match(mixed, /csv/);
  assert.match(mixed, /export/);
});

test('P1-2: FTS 查询串转义（A-5c：无语法错误 / 不变成全匹配）', () => {
  const dangerous = 'he said "hi" * NEAR(secret) AND OR NOT';
  const { match, tokens } = toFtsMatch(dangerous);
  assert.ok(match, '含有可检索词时应生成 MATCH');
  assert.ok(!/[*()]/.test(match), 'MATCH 中不得残留 * ( ) 元字符');
  assert.equal(tokens.includes('near'), true);
  const quotes = (match.match(/"/g) || []).length;
  assert.equal(quotes % 2, 0, '引号必须成对');

  const nothing = toFtsMatch('***  "" () ');
  assert.equal(nothing.match, null, '纯符号查询必须返回 null（调用方直接空结果），不得全匹配');
  assert.deepEqual(nothing.tokens, []);

  assert.equal(quoteFtsToken('a"b'), '"a""b"');
});

test('P1-2: surface 过滤字段（被替换/影子的旧文本标 shadowed）', () => {
  const replaced = extractEvent({
    type: 'user/message',
    seq: 30,
    data: { source: { kind: 'user' }, replaced: true, content: [{ type: 'text', text: '旧文本' }] },
  }, 0);
  assert.equal(replaced.docs[0].surface, 'shadowed');

  const explicit = extractEvent({
    type: 'assistant/message',
    seq: 31,
    data: { surface: 'shadowed', message: { content: [{ type: 'text', text: '影子里的话' }] } },
  }, 0);
  assert.equal(explicit.docs[0].surface, 'shadowed');
});

test('P1-2: 打包行形状判定与统计口径', () => {
  const lines = [
    JSON.stringify({ type: 'request/header', cwd: '<workspace-root>\\a' }),
    JSON.stringify([{ type: 'text-chunks', chunks: ['x'] }]),
    JSON.stringify({ type: 'user/message', seq: 1, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'ctx' }] } }),
    '{broken json',
    JSON.stringify({ type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '唯一一句人话' }] } }),
  ];
  const result = extractFromLines(lines);
  assert.equal(result.docs.length, 1);
  assert.equal(result.docs[0].text, '唯一一句人话');
  assert.equal(result.stats.lines, 5);
  assert.equal(result.stats.unknownLines, 1);
  assert.equal(result.stats.invalidJson, 1);
  assert.equal(result.stats.unmatchedSource, 1);
  assert.equal(result.emptyExtract, false);
});
