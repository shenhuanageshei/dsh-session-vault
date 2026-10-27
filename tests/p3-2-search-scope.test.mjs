import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { resolveVaultPaths, createConfigStore, normalizeConfig, DEFAULT_CONFIG, SEARCH_SCOPES, SEARCH_SCOPE_META } from '../lib/config.js';
import { VaultStore } from '../lib/store.js';
import { VaultEngine, projectKey } from '../lib/engine.js';
import { VaultIndexer, SCOPE_PROGRESS_META, TOOL_COUNT_PREFIX, TOOL_SCOPE_PREFIX } from '../lib/indexer.js';
import { createVaultApi, PREFIX } from '../lib/http.js';
import { extractEvent, TOOL_RESULT_MAX_BYTES, TOOL_RESULT_SURFACE } from '../lib/extract.js';

const quiet = { info() {}, warn() {}, error() {} };
const T0 = 1800000000000;

/** 一帧事件 = 一行 JSON（每行一帧 zstd，与线上 v4 日志同构）。 */
function frames(id, cwd, texts = {}) {
  let seq = 0;
  const next = () => { seq += 1; return seq; };
  const lines = [
    JSON.stringify({ type: 'request/header', sessionId: id, cwd, createdAt: 1791000000000 }),
    JSON.stringify({ type: 'user/message', seq: next(), ts: 1791000001000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: texts.user || ('正文 ' + id) }] } }),
    JSON.stringify({ type: 'assistant/message', seq: next(), ts: 1791000002000, data: { message: { content: [{ type: 'reasoning', text: '不该入索引的推理' }, { type: 'text', text: texts.assistant || ('回复 ' + id) }] } } }),
  ];
  if (texts.toolArgs !== undefined) {
    // tool/call 的 arguments 是**参数**面：任何 scope 下都不得入库（P3-D3 / A-P3-2 负向）
    lines.push(JSON.stringify({ type: 'tool/call', seq: next(), ts: 1791000003000, data: { name: 'shell', arguments: { command: texts.toolArgs } } }));
  }
  if (texts.toolResult !== undefined) {
    // v4 形状：结果文本在 data.message.content 的 text 块（research/cold-storage.md §5）
    lines.push(JSON.stringify({ type: 'tool/result', seq: next(), ts: 1791000004000, data: { message: { content: [{ type: 'text', text: texts.toolResult }] } } }));
  }
  lines.push(JSON.stringify({ type: 'session/title', seq: next(), ts: 1791000005000, data: { title: texts.title || ('标题 ' + id) } }));
  return lines;
}

async function createHarness() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-scope-'));
  const paths = resolveVaultPaths(home);
  const cwd = '<workspace-root>\\scope-demo';
  const pk = projectKey(cwd);
  const archived = new Set();
  const registry = {
    archivedSessionIds: archived,
    async archiveSession(id) { archived.add(String(id)); },
    async unarchiveSession(id) { archived.delete(String(id)); },
    async resolveByPath() { return undefined; },
  };
  const persistence = { async list() { return []; }, async stat() { return undefined; } };
  const configStore = createConfigStore({ home, paths });
  await configStore.save({ autoMigrate: false, archiveAgeDays: 14 });
  const store = await VaultStore.open(paths.dbPath);
  const engine = new VaultEngine({
    home, paths, configStore, store, registry, persistence,
    logger: quiet,
    now: () => T0,
    isActive: async () => false,
    sameVolume: async () => true,
    detectAm: async () => ({ present: false, matches: [], sources: ['injected'] }),
    resolveWorkspace: async () => undefined,
  });

  async function addSession(id, opts = {}) {
    const dir = path.join(paths.sessionsRoot, pk, id);
    await mkdir(dir, { recursive: true });
    const logs = { 'session.v4.jsonl.zstd': frames(id, cwd, opts.texts || {}) };
    for (const [name, content] of Object.entries(logs)) {
      await writeFile(path.join(dir, name), Buffer.concat(content.map((line) => zstdCompressSync(Buffer.from(line + '\n')))));
    }
    return dir;
  }

  function makeIndexer(overrides = {}) {
    const indexer = new VaultIndexer({ engine, store, paths, logger: quiet, now: () => T0, ...overrides });
    engine.indexer = indexer;
    return indexer;
  }

  return {
    home, paths, cwd, pk, store, engine, configStore, addSession, makeIndexer,
    async dispose() {
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: '', writeHead(status, headers) { res.statusCode = status; for (const [key, value] of Object.entries(headers || {})) res.headers[String(key).toLowerCase()] = value; }, setHeader(key, value) { res.headers[String(key).toLowerCase()] = value; }, end(chunk) { res.body = chunk ? Buffer.from(chunk).toString('utf8') : ''; } };
  return res;
}
function fakeReq({ url = PREFIX + '/status', body = '{}' } = {}) {
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.method = 'POST';
  req.url = url;
  req.headers = { host: '127.0.0.1:53210' };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}
async function call(api, options) {
  const res = fakeRes();
  await api.handler(fakeReq(options), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* keep null */ }
  return { status: res.statusCode, json };
}

/** 等 scope pass 收敛（升级是后台任务；测试要拿确定状态）。 */
async function settleScope(indexer) {
  for (let i = 0; i < 500; i += 1) {
    const running = indexer._scopeRunPromise;
    if (!running) return;
    try { await running; } catch { /* 错误由调用方断言 phase */ }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('scope pass 未收敛');
}

function toolDocs(store) {
  return store.prepare("SELECT session_id, COUNT(*) AS n FROM docs WHERE surface = 'tool-result' GROUP BY session_id").all()
    .map((row) => ({ id: String(row.session_id), n: Number(row.n) }));
}

test('A-P3-2（extract）：tool/result 只在 body+toolResults 下入库，surface=tool-result、单事件截断 8KB，参数永不入库', () => {
  assert.equal(DEFAULT_CONFIG.searchScope, 'body', '默认 scope 必须是 body（I-14：工具结果默认不入库）');
  assert.deepEqual([...SEARCH_SCOPES], ['body', 'body+toolResults']);

  const toolEvent = {
    type: 'tool/result',
    seq: 4,
    ts: 1791000004000,
    data: { message: { content: [{ type: 'text', text: '工具结果的独有输出 ABC-123' }] } },
  };
  const callEvent = {
    type: 'tool/call',
    seq: 3,
    ts: 1791000003000,
    data: { name: 'shell', arguments: { command: '工具参数里的密钥甲' } },
  };

  // 默认（body）：不收文本，但**要计数**（升级 pass 只扫含 tool/result 的会话）
  const skipped = extractEvent(toolEvent, 0);
  assert.equal(skipped.docs.length, 0, '默认 body 时 tool/result 不得入库');
  assert.equal(skipped.stats.toolResultEvents, 1, '无论 scope 都要记 tool/result 事件数');
  assert.equal(skipped.stats.toolResults, 0);
  assert.equal(skipped.kind, 'tool-result-skipped');

  // body+toolResults：收结果文本，surface='tool-result'
  const enabled = extractEvent(toolEvent, 0, { toolResults: true });
  assert.equal(enabled.docs.length, 1);
  assert.equal(enabled.docs[0].surface, TOOL_RESULT_SURFACE);
  assert.equal(enabled.docs[0].surface, 'tool-result');
  assert.equal(enabled.docs[0].text, '工具结果的独有输出 ABC-123');
  assert.equal(enabled.docs[0].type, 'tool-result');
  assert.equal(enabled.stats.toolResults, 1);

  // 负向：工具参数（tool/call 的 arguments）任何 scope 都不入库
  assert.equal(extractEvent(callEvent, 1).docs.length, 0);
  assert.equal(extractEvent(callEvent, 1, { toolResults: true }).docs.length, 0, '工具参数绝不被索引（P3-D3）');

  // M2（P3a.1）：单事件上限 = 8KB = **8192 个 UTF-8 字节**（不是 8192 个字符），且不切坏代理对
  assert.equal(TOOL_RESULT_MAX_BYTES, 8192, '8KB 必须是 8192 字节常量');
  const long = 'x'.repeat(TOOL_RESULT_MAX_BYTES + 500);
  const truncated = extractEvent({ type: 'tool/result', seq: 9, data: { message: { content: [{ type: 'text', text: long }] } } }, 2, { toolResults: true });
  assert.equal(Buffer.byteLength(truncated.docs[0].text, 'utf8'), TOOL_RESULT_MAX_BYTES, 'ASCII：截到恰好 8192 字节');
  assert.equal(truncated.docs[0].text.length, TOOL_RESULT_MAX_BYTES, 'ASCII 下字节==字符');
  // 中文：每字 3 字节 ⇒ 8192 / 3 = 2730 字（8190 字节），不能按 8192 **字符**截
  const cjk = '中'.repeat(4000);
  const cjkDoc = extractEvent({ type: 'tool/result', seq: 11, data: { message: { content: [{ type: 'text', text: cjk }] } } }, 4, { toolResults: true });
  assert.equal(Buffer.byteLength(cjkDoc.docs[0].text, 'utf8'), 8190, '中文按整码点截断：8190 字节');
  assert.equal(cjkDoc.docs[0].text.length, 2730);
  assert.equal(cjkDoc.docs[0].text, '中'.repeat(2730));
  // emoji（4 字节码点）：8192 / 4 = 2048 个完整码点，绝不切出半个代理对
  const emoji = '😀'.repeat(4000);
  const pairCut = extractEvent({ type: 'tool/result', seq: 10, data: { message: { content: [{ type: 'text', text: emoji }] } } }, 3, { toolResults: true });
  assert.equal(Buffer.byteLength(pairCut.docs[0].text, 'utf8'), TOOL_RESULT_MAX_BYTES);
  assert.equal(pairCut.docs[0].text, '😀'.repeat(2048));
  assert.equal(/[\uD800-\uDBFF]$/.test(pairCut.docs[0].text), false, '截断点不得留下半个代理对（高位）');
  // 每个完整 emoji 天然含一个低代理 ⇒ 判据是「等于 2048 个完整码点」（上一行已断言）。
  // 混排（1 字节 + 3 字节）：整码点边界截断，字节数 <= 8192
  const mixed = 'x'.repeat(8190) + '中中';
  const mixedDoc = extractEvent({ type: 'tool/result', seq: 12, data: { message: { content: [{ type: 'text', text: mixed }] } } }, 5, { toolResults: true });
  assert.equal(Buffer.byteLength(mixedDoc.docs[0].text, 'utf8'), 8190, '末尾放不下的 3 字节中文整字丢弃（不截半字）');
  assert.equal(mixedDoc.docs[0].text, 'x'.repeat(8190));

  // config 枚举：非法值按 invalid-config 拒绝（不静默回退）
  const bad = normalizeConfig({ searchScope: 'everything' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.some((error) => error.code === 'invalid-config' && error.field === 'searchScope'), true, JSON.stringify(bad.errors));
  const good = normalizeConfig({ searchScope: 'body+toolResults' });
  assert.equal(good.ok, true);
  assert.equal(good.config.searchScope, 'body+toolResults');
});

test('A-P3-2：默认 body —— 工具结果不入库/搜不到；工具参数也搜不到；正文照旧可搜', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-scope-body', {
      texts: {
        user: '正文里的独有句子甲',
        assistant: '助手回复里的独有句子乙',
        toolResult: '工具结果的独有输出甲乙丙',
        toolArgs: '工具参数里的密钥丁戊己',
      },
    });
    const indexer = h.makeIndexer();
    const progress = await indexer.runFullIndex();
    assert.equal(progress.phase, 'done', JSON.stringify(progress));

    assert.equal(indexer.libraryScope(), 'body', '库内默认 scope = body');
    assert.equal(h.store.getMeta(SEARCH_SCOPE_META), null, '默认可不写 meta（读面按 body 兜底）');
    assert.equal(h.store.countDocsBySurface('tool-result'), 0, '默认 body 时不得有 tool 文档');

    assert.equal((await indexer.search('正文里的独有句子甲')).groups.length, 1, '正文必须可搜');
    assert.equal((await indexer.search('助手回复里的独有句子乙')).groups.length, 1, '助手回复必须可搜');
    assert.equal((await indexer.search('工具结果的独有输出甲乙丙')).groups.length, 0, '默认 scope 下工具结果不可搜');
    assert.equal((await indexer.search('工具参数里的密钥丁戊己')).groups.length, 0, '工具参数永远不可搜');

    // 升级 pass 的挑会话依据：tool/result 事件计数（body 模式也要记）
    assert.equal(h.store.getMeta(TOOL_COUNT_PREFIX + 'session-scope-body'), '1');
  } finally {
    await h.dispose();
  }
});

test('A-P3-2：升级到 body+toolResults 后工具结果可搜、参数仍搜不到；降级只删 tool 文档且不重读日志', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-scope-up', {
      texts: {
        user: '升级样本的正文句子',
        toolResult: '升级后应该能搜到的工具输出',
        toolArgs: '不该被搜到的工具参数口令',
      },
    });
    await h.addSession('session-scope-plain', { texts: { user: '没有工具事件的普通会话' } });
    const indexer = h.makeIndexer();
    await indexer.runFullIndex();
    assert.equal(h.store.countDocsBySurface('tool-result'), 0);

    const started = await indexer.syncScope('body+toolResults');
    assert.equal(started.target, 'body+toolResults', '升级 pass 的目标 scope 必须写进读数');
    assert.ok(['scanning', 'running', 'done'].includes(started.phase), JSON.stringify(started));
    await settleScope(indexer);
    const done = indexer.scopeSnapshot();
    assert.equal(done.phase, 'done', JSON.stringify(done));
    assert.equal(done.done, true);
    assert.equal(done.paused, false);
    assert.equal(done.failed, 0, JSON.stringify(done.errors));
    assert.equal(done.total, 1, '升级 pass 只扫含 tool/result 的会话（这里恰好 1 个）');

    // 后置：库内 scope 与配置一致之后才切 done
    assert.equal(h.store.getMeta(SEARCH_SCOPE_META), 'body+toolResults');
    assert.equal(indexer.libraryScope(), 'body+toolResults');
    assert.deepEqual(toolDocs(h.store), [{ id: 'session-scope-up', n: 1 }]);

    const hit = await indexer.search('升级后应该能搜到的工具输出');
    assert.equal(hit.groups.length, 1, JSON.stringify(hit));
    assert.deepEqual(hit.groups[0].surfaces, ['tool-result'], '结果要标注命中面（正文/工具结果）');
    assert.equal(hit.groups[0].hits[0].surface, 'tool-result');
    assert.ok(hit.groups[0].snippet, 'groups/snippet 契约不变：仍必须带 snippet');
    assert.equal((await indexer.search('不该被搜到的工具参数口令')).groups.length, 0, '工具参数绝不入库（负向）');
    assert.equal((await indexer.search('升级样本的正文句子')).groups.length, 1, '正文仍可搜');

    // 降级：只 DELETE FROM docs WHERE surface='tool-result'，**不重读日志**
    let indexCalls = 0;
    const original = h.engine.indexSession.bind(h.engine);
    h.engine.indexSession = async (...args) => { indexCalls += 1; return original(...args); };
    const down = await indexer.syncScope('body');
    assert.equal(down.phase, 'done');
    assert.equal(down.deleted, 1, '降级要报告删掉的行数：' + JSON.stringify(down));
    assert.equal(indexCalls, 0, '降级不得重读日志（不产生任何 indexSession 调用）');
    assert.equal(h.store.countDocsBySurface('tool-result'), 0);
    assert.equal(h.store.getMeta(SEARCH_SCOPE_META), 'body');
    assert.equal((await indexer.search('升级后应该能搜到的工具输出')).groups.length, 0, '降级后 tool 文档必须从 FTS 消失');
    assert.equal((await indexer.search('升级样本的正文句子')).groups.length, 1, '正文不受降级影响');
    // 计数保留：下次再升级仍能挑出这个会话
    assert.equal(h.store.getMeta(TOOL_COUNT_PREFIX + 'session-scope-up'), '1');
    assert.deepEqual(h.store.listMetaKeys(TOOL_SCOPE_PREFIX), [], '降级清掉 tscope 标记，避免下次升级误跳过');
  } finally {
    await h.dispose();
  }
});

test('A-P3-10：scope 升级中断 → 暂停 → 续做完成，分批不重复、不遗漏，期间旧 scope 可查', async () => {
  const h = await createHarness();
  try {
    const ids = ['session-scope-a', 'session-scope-b', 'session-scope-c', 'session-scope-d'];
    for (const id of ids) {
      await h.addSession(id, { texts: { user: '正文样本 ' + id.slice(-1), toolResult: '工具结果样本 ' + id.slice(-1) + ' 号' } });
    }
    const indexer = h.makeIndexer();
    await indexer.runFullIndex();
    assert.equal(h.store.countDocsBySurface('tool-result'), 0);
    // 真实流程：升级由配置切换触发（/config 先落盘，再 syncScope）——续跑（resumeScope）会读这份配置
    await h.configStore.save({ searchScope: 'body+toolResults' });

    // 记录「tool 抽取 pass」对每个会话的索引次数（区分全量索引与 pass：pass 显式传 toolResults=true）
    const passCounts = new Map();
    let passCalls = 0;
    const original = indexer.indexTarget.bind(indexer);
    indexer.indexTarget = async (target, options = {}) => {
      if (options && options.toolResults === true) {
        passCalls += 1;
        passCounts.set(target.id, (passCounts.get(target.id) || 0) + 1);
        const result = await original(target, options);
        // 抽完第 2 个就暂停：模拟「升级过程被中断」
        if (passCalls === 2) indexer.pauseScope();
        return result;
      }
      return original(target, options);
    };

    await indexer.syncScope('body+toolResults');
    await settleScope(indexer);
    const paused = indexer.scopeSnapshot();
    assert.equal(paused.phase, 'paused', JSON.stringify(paused));
    assert.equal(paused.paused, true);
    assert.equal(paused.done, false, '暂停时不得声称完成');
    assert.equal(paused.indexed, 2, JSON.stringify(paused));
    assert.equal(paused.total, 4, JSON.stringify(paused));
    assert.equal(h.store.countDocsBySurface('tool-result'), 2, '暂停时只落已完成的 2 个会话');
    assert.equal(h.store.getMeta(SEARCH_SCOPE_META), null, 'pass 未完成前不得写库内 scope（旧 scope 保持可查）');
    // 期间旧 scope 可查：正文照样命中；已抽完的会话工具结果可搜、未轮到的还搜不到
    const doneIds = new Set(toolDocs(h.store).map((row) => row.id));
    assert.equal(doneIds.size, 2);
    const pendingId = ids.find((id) => !doneIds.has(id));
    assert.equal((await indexer.search('正文样本 a')).groups.length, 1, '暂停期间正文（旧 scope）必须照旧可查');
    assert.equal((await indexer.search('工具结果样本 ' + pendingId.slice(-1) + ' 号')).groups.length, 0, '未轮到的会话此刻还不该可搜');

    // 续做：按 tscope 标记重算待做集合 ⇒ 已完成的 2 个不再重抽
    indexer.resumeScope();
    await settleScope(indexer);
    const resumed = indexer.scopeSnapshot();
    assert.equal(resumed.phase, 'done', JSON.stringify(resumed));
    assert.equal(resumed.done, true);
    assert.equal(resumed.failed, 0, JSON.stringify(resumed.errors));
    assert.equal(h.store.getMeta(SEARCH_SCOPE_META), 'body+toolResults');

    // 不重复：每个会话在整个 pass 里恰好抽取一次（暂停前 2 个 + 续做 2 个）
    assert.equal(passCalls, 4, '总共只该抽 4 次（不重复）：' + JSON.stringify([...passCounts]));
    for (const id of ids) assert.equal(passCounts.get(id), 1, '会话 ' + id + ' 被重复抽取');

    // 不遗漏：4 个会话都有且只有 1 条 tool 文档；4 条工具结果都能搜到
    assert.deepEqual(toolDocs(h.store).sort((a, b) => a.id.localeCompare(b.id)), ids.map((id) => ({ id, n: 1 })).sort((a, b) => a.id.localeCompare(b.id)));
    for (const id of ids) {
      const found = await indexer.search('工具结果样本 ' + id.slice(-1) + ' 号');
      assert.equal(found.groups.length, 1, '续做后必须能搜到：' + id);
    }
  } finally {
    await h.dispose();
  }
});

test('A-P3-10（跨重启）：pass 中途死掉 ⇒ 重启后如实读 paused、不偷偷续跑；resume 后完成且不重复', async () => {
  const h = await createHarness();
  try {
    const ids = ['session-restart-a', 'session-restart-b', 'session-restart-c'];
    for (const id of ids) {
      await h.addSession(id, { texts: { user: '重启样本正文 ' + id.slice(-1), toolResult: '重启样本工具输出 ' + id.slice(-1) + ' 号' } });
    }
    const first = h.makeIndexer();
    await first.runFullIndex();
    await h.configStore.save({ searchScope: 'body+toolResults' });

    // 抽完 1 个就暂停，模拟「进程在 pass 中途死掉」的前一刻
    let calls = 0;
    const original = first.indexTarget.bind(first);
    first.indexTarget = async (target, options = {}) => {
      const result = await original(target, options);
      if (options && options.toolResults === true) {
        calls += 1;
        if (calls === 1) first.pauseScope();
      }
      return result;
    };
    await first.syncScope('body+toolResults');
    await settleScope(first);
    assert.equal(first.scopeSnapshot().phase, 'paused');
    assert.equal(h.store.countDocsBySurface('tool-result'), 1);

    // 「重启」：同一个 store 上新建索引器（不共享任何内存状态）
    const second = h.makeIndexer();
    const restored = second.scopeSnapshot();
    assert.equal(restored.phase, 'paused', '跨重启必须如实读回 paused（不伪装成 idle/done）');
    assert.equal(restored.paused, true);
    assert.equal(restored.target, 'body+toolResults');
    assert.equal(JSON.parse(h.store.getMeta(SCOPE_PROGRESS_META)).phase, 'paused', '进度必须落 meta 才能续做');

    // 打开页面 / 轮询 /status 不得偷偷续跑（暂停是用户的显式动作）
    await second.ensureScope();
    assert.equal(second.scopeSnapshot().phase, 'paused');
    assert.equal(h.store.countDocsBySurface('tool-result'), 1, 'ensureScope 不得在暂停态推进 pass');

    // 显式续做：按 tscope 标记重算 ⇒ 只补剩下的 2 个，不重复已完成的 1 个
    second.resumeScope();
    await settleScope(second);
    const done = second.scopeSnapshot();
    assert.equal(done.phase, 'done', JSON.stringify(done));
    assert.equal(done.failed, 0, JSON.stringify(done.errors));
    assert.equal(h.store.getMeta(SEARCH_SCOPE_META), 'body+toolResults');
    assert.deepEqual(toolDocs(h.store).sort((a, b) => a.id.localeCompare(b.id)), ids.map((id) => ({ id, n: 1 })).sort((a, b) => a.id.localeCompare(b.id)));
    for (const id of ids) {
      assert.equal((await second.search('重启样本工具输出 ' + id.slice(-1) + ' 号')).groups.length, 1, '续做后必须能搜到：' + id);
    }
  } finally {
    await h.dispose();
  }
});
test('A-P3-2（/status、/config、/search）：status 给 searchScope 与 scope 进度；config 切 scope 按方向生效；非法值 400', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-api-scope', {
      texts: { user: 'API 正文样本', toolResult: 'API 工具结果样本' },
    });
    const indexer = h.makeIndexer();
    await indexer.runFullIndex();
    const api = createVaultApi({
      home: h.home,
      configStore: h.configStore,
      version: '0.1.0-test',
      getEngine: async () => h.engine,
      getIndexer: async () => indexer,
      logger: quiet,
    });

    const before = await call(api, { url: PREFIX + '/status', body: '{}' });
    assert.equal(before.status, 200);
    assert.equal(before.json.searchScope, 'body', '/status 必须给配置里的 searchScope');
    assert.ok(before.json.scope && typeof before.json.scope.phase === 'string', '/status 必须给 scope 重建进度');
    assert.equal(before.json.scope.libraryScope, 'body');
    assert.equal(typeof before.json.scope.done, 'boolean');
    assert.equal(typeof before.json.scope.paused, 'boolean');

    // 升级：保存配置 ⇒ 后台 pass；接口立即回读数（不假装已生效）
    const up = await call(api, { url: PREFIX + '/config', body: JSON.stringify({ patch: { searchScope: 'body+toolResults' } }) });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    assert.equal(up.json.ok, true);
    assert.equal(up.json.searchScope, 'body+toolResults');
    assert.equal(up.json.previousSearchScope, 'body');
    assert.ok(up.json.scope && typeof up.json.scope.phase === 'string', JSON.stringify(up.json.scope));
    await settleScope(indexer);
    const after = await call(api, { url: PREFIX + '/status', body: '{}' });
    assert.equal(after.json.searchScope, 'body+toolResults');
    assert.equal(after.json.scope.libraryScope, 'body+toolResults', 'pass 完成后库内 scope 才切');
    assert.equal(after.json.scope.done, true, JSON.stringify(after.json.scope));

    const search = await call(api, { url: PREFIX + '/search', body: JSON.stringify({ q: 'API 工具结果样本' }) });
    assert.equal(search.status, 200);
    assert.equal(search.json.groups.length, 1, JSON.stringify(search.json.groups));
    assert.deepEqual(search.json.groups[0].surfaces, ['tool-result']);
    assert.ok(search.json.scope && search.json.scope.libraryScope === 'body+toolResults');

    // 非法枚举值：按 invalid-config 拒绝，且不动库内 scope
    const bad = await call(api, { url: PREFIX + '/config', body: JSON.stringify({ patch: { searchScope: 'all' } }) });
    assert.equal(bad.status, 400, JSON.stringify(bad.json));
    assert.equal(bad.json.code, 'invalid-config');
    assert.equal(bad.json.details[0].field, 'searchScope');
    assert.equal(h.store.getMeta(SEARCH_SCOPE_META), 'body+toolResults', '被拒绝的配置不得改动库内 scope');

    // 降级：保存后立即删 tool 文档（同一请求内完成）
    const down = await call(api, { url: PREFIX + '/config', body: JSON.stringify({ patch: { searchScope: 'body' } }) });
    assert.equal(down.status, 200, JSON.stringify(down.json));
    assert.equal(down.json.scope.done, true, JSON.stringify(down.json.scope));
    assert.equal(h.store.getMeta(SEARCH_SCOPE_META), 'body');
    assert.equal(h.store.countDocsBySurface('tool-result'), 0);
    const goneSearch = await call(api, { url: PREFIX + '/search', body: JSON.stringify({ q: 'API 工具结果样本' }) });
    assert.equal(goneSearch.json.groups.length, 0, '降级后工具结果不再可搜');
  } finally {
    await h.dispose();
  }
});
