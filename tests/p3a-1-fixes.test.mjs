import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  resolveVaultPaths,
  createConfigStore,
  SEARCH_SCOPE_META,
  SEARCH_SCOPE_BODY,
  SEARCH_SCOPE_TOOL_RESULTS,
  INDEX_SCHEMA_META,
  INDEX_SCHEMA_VERSION,
  SCOPE_GAPS_META,
  SCOPE_MAX_ROUNDS,
} from '../lib/config.js';
import { VaultStore } from '../lib/store.js';
import { VaultEngine, projectKey, ERROR_STATES } from '../lib/engine.js';
import { VaultIndexer, WATERMARK_PREFIX, SCOPE_PROGRESS_META } from '../lib/indexer.js';
import { createVaultApi, PREFIX } from '../lib/http.js';
import {
  extractEvent,
  surfaceOf,
  surfaceInfoOf,
  SURFACE_VALUES,
  truncateToolResult,
  TOOL_RESULT_MAX_BYTES,
  TOOL_RESULT_SURFACE,
} from '../lib/extract.js';

/**
 * P3a.1 修复轮测试（合并「代码评审 7 条」+「只读审计 4 必修 + 5 条存疑」）。
 *
 * 覆盖：# M1 scope 完成判定 / M2 8KB=8192 字节 / M3 index:schema / S2 shadowed 工具结果 /
 * S3 surface 白名单 / S4 暂停解耦 / R2 迁移尾段索引异常 / R3 autoMigrate 回退 / R5 续跑前读配置 /
 * R6 匹配器 repeat（见 tests/p3-1-shortcut.test.mjs）。
 */

const quiet = { info() {}, warn() {}, error() {} };

/** 一帧事件 = 一行 JSON（与线上 v4 日志同构）。 */
function frames(id, cwd, texts = {}) {
  let seq = 0;
  const next = () => { seq += 1; return seq; };
  const lines = [
    JSON.stringify({ type: 'request/header', sessionId: id, cwd, createdAt: 1791000000000 }),
    JSON.stringify({ type: 'user/message', seq: next(), ts: 1791000001000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: texts.user || ('正文 ' + id) }] } }),
    JSON.stringify({ type: 'assistant/message', seq: next(), ts: 1791000002000, data: { message: { content: [{ type: 'reasoning', text: '推理不入索引' }, { type: 'text', text: texts.assistant || ('回复 ' + id) }] } } }),
  ];
  if (texts.toolResult !== undefined) {
    lines.push(JSON.stringify({ type: 'tool/result', seq: next(), ts: 1791000004000, data: { message: { content: [{ type: 'text', text: texts.toolResult }] } } }));
  }
  lines.push(JSON.stringify({ type: 'session/title', seq: next(), ts: 1791000005000, data: { title: texts.title || ('标题 ' + id) } }));
  return lines;
}

async function createHarness() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p3a1-'));
  const paths = resolveVaultPaths(home);
  const cwd = '<workspace-root>\\p3a1-demo';
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
    isActive: async () => false,
    sameVolume: async () => true,
    detectAm: async () => ({ present: false, matches: [], sources: ['injected'] }),
    resolveWorkspace: async () => undefined,
  });

  async function addSession(id, opts = {}) {
    const dir = path.join(paths.sessionsRoot, pk, id);
    await mkdir(dir, { recursive: true });
    const logs = { 'session.v4.jsonl.zstd': frames(id, cwd, opts.texts || {}) };
    for (const [name, lines] of Object.entries(logs)) {
      await writeFile(path.join(dir, name), Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line + '\n')))));
    }
    return dir;
  }

  function makeIndexer(overrides = {}) {
    const indexer = new VaultIndexer({ engine, store, paths, logger: quiet, ...overrides });
    engine.indexer = indexer;
    return indexer;
  }

  async function dispose() {
    store.close();
    await rm(home, { recursive: true, force: true });
  }

  return {
    home, paths, cwd, pk, store, engine, configStore, registry, archived, addSession, makeIndexer, dispose,
    hotDir: (id) => path.join(paths.sessionsRoot, pk, id),
    coldDir: (id) => path.join(paths.coldRootDefault, pk, id),
    markerPath: (id) => path.join(paths.markerDir, id + '.json'),
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

const exists = (target) => stat(target).then(() => true).catch(() => false);

// ---- M2：8KB = 8192 个 UTF-8 字节 ----------------------------------------

test('M2：工具结果上限 = 8192 个 UTF-8 字节（截断函数：中文整码点 / emoji 不裂 / ASCII 恰好 8192）', () => {
  assert.equal(TOOL_RESULT_MAX_BYTES, 8192, '8KB 口径必须是 8192 字节');
  // 短文本一个字节都不动
  assert.equal(truncateToolResult('short'), 'short');
  assert.equal(truncateToolResult(''), '');
  assert.equal(truncateToolResult(null), '');
  assert.equal(truncateToolResult(undefined), '');
  assert.equal(truncateToolResult(12345), '12345', '非字符串按 String() 处理');
  // 恰好 8192 字节不动
  const exactly = 'x'.repeat(8192);
  assert.equal(truncateToolResult(exactly), exactly);

  // 中文：3 字节/字 ⇒ 2730 字 = 8190 字节（不是 8192 个「字符」）
  const cjk = '中'.repeat(5000);
  const cjkOut = truncateToolResult(cjk);
  assert.equal(Buffer.byteLength(cjkOut, 'utf8'), 8190);
  assert.equal(cjkOut, '中'.repeat(2730));
  assert.ok(!cjkOut.includes('\uFFFD'), '不得出现替换字符（=不切半字）');

  // emoji：4 字节/码点 ⇒ 2048 个完整 emoji；绝不留下半个代理对
  const emojiOut = truncateToolResult('😀'.repeat(5000));
  assert.equal(Buffer.byteLength(emojiOut, 'utf8'), 8192);
  assert.equal(emojiOut, '😀'.repeat(2048), '2048 个完整码点（不是 2048 字节）');
  assert.equal(/[\uD800-\uDBFF]$/.test(emojiOut), false, '结尾不得是孤立高位代理');

  // 3 字节字符跨在边界上 ⇒ 整字丢弃（8190 + 3 > 8192）
  const straddle = 'x'.repeat(8190) + '中';
  assert.equal(truncateToolResult(straddle), 'x'.repeat(8190));
});

test('M2：extractEvent 落库的工具结果同样按 8192 字节截断（中文/emoji 集成面）', () => {
  const cjkEvent = { type: 'tool/result', seq: 1, data: { message: { content: [{ type: 'text', text: '中'.repeat(4000) }] } } };
  const cjkDoc = extractEvent(cjkEvent, 0, { toolResults: true });
  assert.equal(cjkDoc.docs.length, 1);
  assert.equal(Buffer.byteLength(cjkDoc.docs[0].text, 'utf8'), 8190);
  const emojiEvent = { type: 'tool/result', seq: 2, data: { message: { content: [{ type: 'text', text: '😀'.repeat(4000) }] } } };
  const emojiDoc = extractEvent(emojiEvent, 1, { toolResults: true });
  assert.equal(Buffer.byteLength(emojiDoc.docs[0].text, 'utf8'), 8192);
  assert.equal(emojiDoc.docs[0].text, '😀'.repeat(2048));
});

// ---- S2：工具结果只在 current 面收 ---------------------------------------

test('S2：surfaceOf 判定为 shadowed / replaced / log-only 的工具结果不收，计数 stats.toolResultsShadowed', () => {
  const make = (surface) => ({
    type: 'tool/result',
    seq: 4,
    ts: 1791000004000,
    data: { surface, message: { content: [{ type: 'text', text: '工具输出样本甲' }] } },
  });

  const current = extractEvent(make('current'), 0, { toolResults: true });
  assert.equal(current.docs.length, 1, 'current 面必须收');
  assert.equal(current.stats.toolResultsShadowed, 0);
  assert.equal(current.docs[0].surface, TOOL_RESULT_SURFACE);

  for (const surface of ['shadowed', 'replaced', 'log-only']) {
    const result = extractEvent(make(surface), 1, { toolResults: true });
    assert.equal(result.docs.length, 0, surface + ' 面的工具结果不得入库');
    assert.equal(result.stats.toolResultsShadowed, 1, surface + ' 必须计入 toolResultsShadowed');
    assert.equal(result.stats.toolResults, 0);
    assert.equal(result.kind, 'tool-result-shadowed');
    // 事件计数照旧（升级 pass 挑会话的依据与 surface 无关）
    assert.equal(result.stats.toolResultEvents, 1);
  }

  // replaced:true 形状（没有 surface 字符串）也是 shadowed 语义
  const replacedFlag = extractEvent({ type: 'tool/result', seq: 5, data: { replaced: true, message: { content: [{ type: 'text', text: '旧工具输出' }] } } }, 2, { toolResults: true });
  assert.equal(replacedFlag.docs.length, 0);
  assert.equal(replacedFlag.stats.toolResultsShadowed, 1);

  // body scope 下也计数（「见到了但没资格入库」是事件事实，与 scope 无关）
  const bodyScope = extractEvent(make('shadowed'), 3);
  assert.equal(bodyScope.docs.length, 0);
  assert.equal(bodyScope.stats.toolResultsShadowed, 1);
});

// ---- S3：surfaceOf 白名单 ------------------------------------------------

test('S3：surfaceOf 白名单化 —— 只认已知值；未知值按 current 处理并计 stats.unknownSurface（不直通）', () => {
  assert.deepEqual([...SURFACE_VALUES], ['current', 'shadowed', 'replaced', 'log-only']);
  for (const value of SURFACE_VALUES) {
    assert.equal(surfaceOf({ data: { surface: value } }), value, '已知值必须原样返回：' + value);
    assert.equal(surfaceInfoOf({ data: { surface: value } }).unknown, false);
  }
  // event.surface（顶层）同样走白名单
  assert.equal(surfaceOf({ surface: 'shadowed' }), 'shadowed');
  // 缺失 ⇒ current
  assert.equal(surfaceOf({}), 'current');
  assert.equal(surfaceOf(null), 'current');
  assert.equal(surfaceOf(undefined), 'current');
  assert.equal(surfaceOf('not-an-event'), 'current');
  // replaced:true ⇒ shadowed
  assert.equal(surfaceOf({ data: { replaced: true } }), 'shadowed');

  // 未知值：不得直通（docs.surface 只能是白名单里的值）
  for (const raw of ['weird-surface', 'CURRENT', 'current ', 'tool-result', '', 'shadow']) {
    const info = surfaceInfoOf({ data: { surface: raw } });
    if (raw === '') {
      assert.equal(info.surface, 'current', '空串按缺失处理');
      assert.equal(info.unknown, false);
      continue;
    }
    assert.equal(info.surface, 'current', '未知值必须按 current 处理：' + JSON.stringify(raw));
    assert.equal(info.unknown, true, '未知值必须标 unknown：' + JSON.stringify(raw));
    assert.equal(info.raw, raw);
  }

  // 事件面：未知 surface 的正文事件仍按 current 入库，并计 unknownSurface
  const unknownUser = extractEvent({ type: 'user/message', seq: 1, data: { surface: 'weird-surface', source: { kind: 'user' }, content: [{ type: 'text', text: '未知面的正文' }] } }, 0);
  assert.equal(unknownUser.docs.length, 1, '未知面按 current 处理 ⇒ 仍然入库');
  assert.equal(unknownUser.docs[0].surface, 'current', 'docs.surface 不得写入未知字符串');
  assert.equal(unknownUser.stats.unknownSurface, 1);

  // 已知的非 current 面：入库但 surface 如实记录（检索面会过滤掉）
  const shadowedUser = extractEvent({ type: 'user/message', seq: 2, data: { surface: 'replaced', source: { kind: 'user' }, content: [{ type: 'text', text: '被替换的旧正文' }] } }, 1);
  assert.equal(shadowedUser.docs[0].surface, 'replaced');
  assert.equal(shadowedUser.stats.unknownSurface, 0);
});

// ---- M1：scope 完成判定（partial → 重试 → done-with-gaps → 重建清空） ----

test('M1：scope pass 有失败 ⇒ 不写 index:scope、phase=partial、自动重试至多用尽轮数，最后 done-with-gaps（gaps 可见且可重建）', async () => {
  const h = await createHarness();
  try {
    const ids = ['session-gap-a', 'session-gap-b', 'session-gap-c'];
    for (const id of ids) {
      await h.addSession(id, { texts: { user: '正文样本 ' + id.slice(-1), toolResult: '工具结果样本 ' + id.slice(-1) + ' 号' } });
    }
    const indexer = h.makeIndexer();
    await indexer.runFullIndex();
    assert.equal(h.store.countDocsBySurface('tool-result'), 0);

    const failing = 'session-gap-b';
    let failedAttempts = 0;
    const origIndexTarget = indexer.indexTarget.bind(indexer);
    indexer.indexTarget = async (target, options = {}) => {
      if (target.id === failing && options && options.toolResults === true) {
        failedAttempts += 1;
        return { ok: false, error: 'injected-failure' };
      }
      return origIndexTarget(target, options);
    };
    // 真实流程：升级是由**配置切换**触发的（/config 先落盘再 syncScope），续跑/重建也读这份配置
    await h.configStore.save({ searchScope: SEARCH_SCOPE_TOOL_RESULTS });
    // 记录 pass 的相位序列（_persistScopeProgress 每步都落盘 ⇒ 能看到 partial 中间态）
    const phases = [];
    const origPersist = indexer._persistScopeProgress.bind(indexer);
    indexer._persistScopeProgress = (extra) => { phases.push(indexer._scopePhase); return origPersist(extra); };

    await indexer.syncScope(SEARCH_SCOPE_TOOL_RESULTS);
    await settleScope(indexer);

    const snap = indexer.scopeSnapshot();
    assert.equal(snap.phase, 'done-with-gaps', JSON.stringify(snap));
    assert.equal(snap.doneWithGaps, true);
    assert.equal(snap.done, false, 'done-with-gaps 不得冒充 done');
    assert.equal(snap.gapsCount, 1);
    assert.deepEqual(snap.gaps, [failing]);
    // 有失败 ⇒ **不写** index:scope（库内保持旧值 body）
    assert.equal(h.store.getMeta(SEARCH_SCOPE_META), null, '失败时不得写 index:scope');
    assert.equal(indexer.libraryScope(), SEARCH_SCOPE_BODY, '库内 scope 仍是旧值');
    // 未覆盖 id 落 meta（跨重启可读）
    assert.deepEqual(JSON.parse(h.store.getMeta(SCOPE_GAPS_META)), [failing]);
    // 自动重试有界：恰好 SCOPE_MAX_ROUNDS 轮，绝不无限重试
    assert.equal(failedAttempts, SCOPE_MAX_ROUNDS, '重试轮数必须恰好用尽 ' + SCOPE_MAX_ROUNDS + ' 轮');
    // 相位序列必须出现 partial（中间态）再落到 done-with-gaps
    assert.ok(phases.includes('partial'), '必须有 phase=partial 的中间态：' + JSON.stringify(phases));
    assert.equal(phases[phases.length - 1], 'done-with-gaps');
    // 其余两个会话照常抽到工具结果（部分成功的数据不丢）
    assert.equal(toolDocs(h.store).length, 2);
    assert.deepEqual(toolDocs(h.store).map((row) => row.id).sort(), ['session-gap-a', 'session-gap-c']);

    // /status 暴露 gaps / gapsCount
    const api = createVaultApi({
      home: h.home,
      configStore: h.configStore,
      version: '0.1.0-test',
      getEngine: async () => h.engine,
      getIndexer: async () => indexer,
      logger: quiet,
    });
    const status = await call(api, { url: PREFIX + '/status', body: '{}' });
    assert.equal(status.status, 200);
    assert.equal(status.json.scope.phase, 'done-with-gaps');
    assert.deepEqual(status.json.scope.gaps, [failing], '/status.scope.gaps 必须可见');
    assert.equal(status.json.scope.gapsCount, 1);
    assert.equal(status.json.scope.doneWithGaps, true);

    // 轮询不得偷偷重跑（禁止无限重试）：ensureScope 早退
    await indexer.ensureScope();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failedAttempts, SCOPE_MAX_ROUNDS, 'ensureScope 不得在 done-with-gaps 上再重试');
    assert.equal(indexer.scopeSnapshot().phase, 'done-with-gaps');

    // 重建：不再失败 ⇒ 成功一轮写回 scope 并**清空 gaps**
    indexer.indexTarget = origIndexTarget;
    indexer.resumeScope();
    await settleScope(indexer);
    const done = indexer.scopeSnapshot();
    assert.equal(done.phase, 'done', JSON.stringify(done));
    assert.equal(done.gapsCount, 0, '成功后 gap 必须清空');
    assert.deepEqual(done.gaps, []);
    assert.equal(h.store.getMeta(SCOPE_GAPS_META), null, 'gaps meta 必须清掉');
    assert.equal(h.store.getMeta(SEARCH_SCOPE_META), SEARCH_SCOPE_TOOL_RESULTS);
    assert.equal((await indexer.search('工具结果样本 b 号')).groups.length, 1, '重建后未覆盖的会话也能搜到');
  } finally {
    await h.dispose();
  }
});

test('M1（跨重启）：done-with-gaps 与 gaps 列表落 meta，重启后如实读回且不自动重跑', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-gaps-restart', { texts: { user: '正文', toolResult: '工具结果样本' } });
    const first = h.makeIndexer();
    await first.runFullIndex();
    const failing = 'session-gaps-restart';
    first.indexTarget = async () => ({ ok: false, error: 'injected-failure' });
    await first.syncScope(SEARCH_SCOPE_TOOL_RESULTS);
    await settleScope(first);
    assert.equal(first.scopeSnapshot().phase, 'done-with-gaps');
    assert.equal(JSON.parse(h.store.getMeta(SCOPE_PROGRESS_META)).phase, 'done-with-gaps', '终态必须落 meta');

    // 「重启」：同一 store 上的新索引器不共享内存
    const second = h.makeIndexer();
    const restored = second.scopeSnapshot();
    assert.equal(restored.phase, 'done-with-gaps');
    assert.deepEqual(restored.gaps, [failing]);
    assert.equal(restored.gapsCount, 1);
    // ensureScope 不得自动重跑
    let calls = 0;
    second.indexTarget = async () => { calls += 1; return { ok: true }; };
    await second.ensureScope();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0, '重启后的 ensureScope 不得自动重跑 done-with-gaps');

    // 但**显式保存配置**（syncScope = /config 路径）是用户动作 ⇒ 允许清掉终态重来一轮
    const cfg = await h.configStore.save({ searchScope: SEARCH_SCOPE_TOOL_RESULTS });
    assert.equal(cfg.ok, true);
    const restarted = await second.syncScope(SEARCH_SCOPE_TOOL_RESULTS);
    assert.ok(['scanning', 'running', 'partial', 'done'].includes(restarted.phase), '显式保存配置必须能重新发起 pass：' + JSON.stringify(restarted));
    await settleScope(second);
    assert.ok(calls > 0, '重建必须真的抽取过（不是空跑）');
    assert.equal(second.scopeSnapshot().phase, 'done');
    assert.equal(h.store.getMeta(SEARCH_SCOPE_META), SEARCH_SCOPE_TOOL_RESULTS);
  } finally {
    await h.dispose();
  }
});

// ---- M3：index:schema ---------------------------------------------------

test('M3：索引 schema（旧库缺失 ⇒ 清水位全量重建并写回；一致 ⇒ 不重建）', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-schema-a', { texts: { user: '正文甲' } });
    await h.addSession('session-schema-b', { texts: { user: '正文乙' } });

    const first = h.makeIndexer();
    await first.runFullIndex();
    assert.equal(h.store.getMeta(INDEX_SCHEMA_META), String(INDEX_SCHEMA_VERSION), '全量索引完成后必须写回 schema');
    assert.equal(first.schemaSnapshot().rebuildNeeded, false);
    assert.ok(h.store.listMetaKeys(WATERMARK_PREFIX).length >= 2, '正常索引必须有水位');

    // 模拟「旧库」：schema 缺失（本批落地前的库）
    h.store.deleteMeta(INDEX_SCHEMA_META);
    const second = h.makeIndexer();
    const snap = second.schemaSnapshot();
    assert.equal(snap.schema, INDEX_SCHEMA_VERSION);
    assert.equal(snap.stored, null);
    assert.equal(snap.rebuildNeeded, true, 'schema 缺失必须声明需要重建');

    const rebuilt = await second.ensureStarted();
    assert.equal(rebuilt.phase, 'done', JSON.stringify(rebuilt));
    assert.equal(rebuilt.indexed, 2, '重建必须清掉旧水位 ⇒ 真正重抽（不是 skipped）');
    assert.equal(rebuilt.skipped, 0);
    assert.equal(h.store.getMeta(INDEX_SCHEMA_META), String(INDEX_SCHEMA_VERSION), '重建完成后写回 schema');
    assert.equal(second.schemaSnapshot().rebuildNeeded, false);
    // /status.index 暴露 schema 读数
    const status = await call(createVaultApi({
      home: h.home, configStore: h.configStore, version: '0.1.0-test',
      getEngine: async () => h.engine, getIndexer: async () => second, logger: quiet,
    }), { url: PREFIX + '/status', body: '{}' });
    assert.equal(status.json.index.schema, INDEX_SCHEMA_VERSION);
    assert.equal(status.json.index.schemaStored, INDEX_SCHEMA_VERSION);
    assert.equal(status.json.index.rebuildNeeded, false);

    // 一致 ⇒ 不重建：新索引器沿用有效水位，全部跳过
    const third = h.makeIndexer();
    assert.equal(third.schemaSnapshot().rebuildNeeded, false, 'schema 一致时不得声明需要重建');
    const noop = await third.ensureStarted();
    assert.equal(noop.phase, 'done');
    assert.equal(noop.indexed, 0, 'schema 一致时不得重抽');
    assert.equal(noop.skipped, 2, '水位有效 ⇒ 两个会话都被跳过');
  } finally {
    await h.dispose();
  }
});

// ---- S4：scope pass 与全量索引暂停解耦 ----------------------------------

test('S4：暂停索引不得把 scope pass 置 paused；暂停状态下改配置 ⇒ scope 升级立即起步（不等 status 轮询）', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-pause-a', { texts: { user: '正文甲', toolResult: '工具结果甲' } });
    await h.addSession('session-pause-b', { texts: { user: '正文乙', toolResult: '工具结果乙' } });
    const indexer = h.makeIndexer();
    await indexer.runFullIndex();

    const paused = indexer.pause();
    assert.equal(paused.phase, 'paused', '暂停索引本身必须生效');
    assert.equal(paused.paused, true);
    const scopeWhilePaused = indexer.scopeSnapshot();
    assert.notEqual(scopeWhilePaused.phase, 'paused', 'S4：暂停索引不得把 scope 置 paused');
    assert.equal(scopeWhilePaused.phase, 'idle');
    assert.equal(indexer._scopePauseRequested, false, 'S4：pause() 不得设置 scope 的暂停位');

    // 暂停状态下保存配置（syncScope 就是 /config 的路径）⇒ 立即起步
    const started = await indexer.syncScope(SEARCH_SCOPE_TOOL_RESULTS);
    assert.ok(['scanning', 'running', 'partial', 'done'].includes(started.phase), '配置切换后必须立即起步：' + JSON.stringify(started));
    assert.ok(indexer._scopeRunPromise, 'pass 必须在本次请求内排定（不依赖下一次 /status 的 ensureScope）');
    await settleScope(indexer);
    assert.equal(indexer.scopeSnapshot().phase, 'done');
    assert.equal(h.store.getMeta(SEARCH_SCOPE_META), SEARCH_SCOPE_TOOL_RESULTS);

    // HTTP 面同一断言：暂停索引后 POST /config ⇒ 响应里 scope 已起步
    await indexer.syncScope(SEARCH_SCOPE_BODY);
    indexer.pause();
    const api = createVaultApi({
      home: h.home, configStore: h.configStore, version: '0.1.0-test',
      getEngine: async () => h.engine, getIndexer: async () => indexer, logger: quiet,
    });
    const up = await call(api, { url: PREFIX + '/config', body: JSON.stringify({ patch: { searchScope: SEARCH_SCOPE_TOOL_RESULTS } }) });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    assert.ok(['scanning', 'running', 'partial', 'done'].includes(up.json.scope.phase), JSON.stringify(up.json.scope));
    assert.notEqual(up.json.scope.phase, 'paused', 'S4：暂停索引不得让 scope 停在 paused');
    await settleScope(indexer);
    assert.equal(indexer.scopeSnapshot().phase, 'done');

    // S4 的另一半：pause-scope / resume-scope 是**独立**动作，且不得动全量索引的暂停位。
    assert.equal(indexer.progress().phase, 'paused', '全量索引此刻仍是暂停态（与 scope 解耦）');
    const p2 = await call(api, { url: PREFIX + '/rebuild-index', body: JSON.stringify({ action: 'pause-scope' }) });
    assert.equal(p2.status, 200, JSON.stringify(p2.json));
    assert.equal(p2.json.index.phase, 'paused', 'pause-scope 不得改全量索引状态');
    assert.notEqual(p2.json.scope.phase, 'paused', '已完成的 pass 上暂停是幂等 no-op（不伪造 paused）');
    const r2 = await call(api, { url: PREFIX + '/rebuild-index', body: JSON.stringify({ action: 'resume-scope' }) });
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    await settleScope(indexer);
    assert.equal(indexer.progress().phase, 'paused', 'resume-scope 也不得顺手恢复全量索引');
    const bad = await call(api, { url: PREFIX + '/rebuild-index', body: JSON.stringify({ action: 'nope' }) });
    assert.equal(bad.status, 400);
  } finally {
    await h.dispose();
  }
});

// ---- R5：resumeScope 续跑前读配置 ---------------------------------------

test('R5：配置已回 body ⇒ resumeScope 取消 pass 并降级删除 tool 文档（不续跑）', async () => {
  const h = await createHarness();
  try {
    const ids = ['session-r5-a', 'session-r5-b', 'session-r5-c'];
    for (const id of ids) {
      await h.addSession(id, { texts: { user: '正文 ' + id.slice(-1), toolResult: '工具结果 ' + id.slice(-1) + ' 号' } });
    }
    const indexer = h.makeIndexer();
    await indexer.runFullIndex();

    // 起升级 pass，抽 1 个就显式暂停（模拟「用户暂停后改了配置」）
    let passCalls = 0;
    const origIndexTarget = indexer.indexTarget.bind(indexer);
    indexer.indexTarget = async (target, options = {}) => {
      const result = await origIndexTarget(target, options);
      if (options && options.toolResults === true) {
        passCalls += 1;
        if (passCalls === 1) indexer.pauseScope();
      }
      return result;
    };
    await indexer.syncScope(SEARCH_SCOPE_TOOL_RESULTS);
    await settleScope(indexer);
    assert.equal(indexer.scopeSnapshot().phase, 'paused');
    assert.equal(h.store.countDocsBySurface('tool-result'), 1, '暂停时已抽 1 个');
    indexer.indexTarget = origIndexTarget;

    // 配置回到 body（绕过 /config 的 scope 同步，模拟另一实例/手改配置文件）
    const saved = await h.configStore.save({ searchScope: SEARCH_SCOPE_BODY });
    assert.equal(saved.config.searchScope, SEARCH_SCOPE_BODY);

    indexer.resumeScope();
    await settleScope(indexer);
    const snap = indexer.scopeSnapshot();
    assert.equal(snap.phase, 'done', JSON.stringify(snap));
    assert.equal(h.store.countDocsBySurface('tool-result'), 0, 'R5：配置回 body ⇒ 降级删掉 tool 文档');
    assert.equal(h.store.getMeta(SEARCH_SCOPE_META), SEARCH_SCOPE_BODY);
    assert.equal(toolDocs(h.store).length, 0);
    assert.equal(passCalls, 1, 'R5：不得续跑（除暂停前那 1 次抽取外没有新的 pass 抽取）');
  } finally {
    await h.dispose();
  }
});

// ---- R2：迁移尾段的 indexSession 异常 ------------------------------------

test('R2：finishMigrate 的 indexSession 抛错 ⇒ 只落 error=index-failed，行保持 cold、返回值不变', async () => {
  const h = await createHarness();
  try {
    const id = 'session-r2-hot';
    await h.addSession(id, { texts: { user: '迁移样本正文' } });
    h.archived.add(id);
    h.store.replaceDocs = () => { throw new Error('injected-replaceDocs-failure'); };

    const result = await h.engine.migrate(id);
    assert.equal(result.ok, true, '迁移本身必须成功（索引失败不阻塞迁移）：' + JSON.stringify(result));
    assert.equal(result.status, 'cold');
    assert.equal(result.indexError, ERROR_STATES.INDEX_FAILED);

    const row = h.store.getSession(id);
    assert.equal(row.status, 'cold', 'R2：不得把已成功迁移的行翻回 migrating');
    assert.equal(row.error, ERROR_STATES.INDEX_FAILED, 'R2：只落 error=index-failed');
    assert.equal(await exists(h.hotDir(id)), false, '热目录已搬走');
    assert.equal(await exists(h.coldDir(id)), true, '冷目录在');
    assert.equal(await exists(h.markerPath(id)), false, '迁移完成后 marker 必须删除');
    const lines = (await readFile(h.paths.manifestPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'manifest 恰好一行（迁移事实照常记账）');
    assert.equal(JSON.parse(lines[0]).op, 'migrate');
  } finally {
    await h.dispose();
  }
});

test('R2：completeMigrateTail（启动续跑）的 indexSession 抛错 ⇒ 只落 error=index-failed，行仍 cold、marker 收掉', async () => {
  const h = await createHarness();
  try {
    const id = 'session-r2-tail';
    await h.addSession(id, { texts: { user: '续跑样本正文' } });
    h.archived.add(id);

    // 先正常迁一次，并抓下 marker（用来模拟「崩在删 marker 之前」的现场）
    let captured = null;
    const markerStore = h.engine.markers;
    const origWrite = markerStore.write.bind(markerStore);
    markerStore.write = async (sessionId, marker) => {
      captured = JSON.parse(JSON.stringify(marker));
      return origWrite(sessionId, marker);
    };
    const first = await h.engine.migrate(id);
    markerStore.write = origWrite;
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(captured, '必须抓到 marker');

    // 崩溃现场：冷目录在、热目录不在、marker 还在（DB 行已是 cold）
    await origWrite(id, captured);
    assert.equal(await exists(h.markerPath(id)), true);
    h.store.updateSession(id, { error: null });
    h.store.replaceDocs = () => { throw new Error('injected-replaceDocs-failure'); };

    const boot = await h.engine.recoverOnBoot();
    assert.equal(boot.ok, true, JSON.stringify(boot));
    const row = h.store.getSession(id);
    assert.equal(row.status, 'cold', 'R2：续跑索引失败不得把行翻回 migrating');
    assert.equal(row.error, ERROR_STATES.INDEX_FAILED);
    assert.equal(await exists(h.markerPath(id)), false, '尾段必须收掉 marker（否则下一轮又会重跑）');
    assert.equal(await exists(h.coldDir(id)), true, '冷目录原样保留');
  } finally {
    await h.dispose();
  }
});

// ---- R3：/status 的 autoMigrate 回退同口径 -------------------------------

test('R3：引擎不可用时 /status 的 autoMigrate 回退与 archiveAgeDays 同口径（配置 + 阈值>0）', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-r3-'));
  const paths = resolveVaultPaths(home);
  const configStore = createConfigStore({ home, paths });
  try {
    const down = () => { throw new Error('engine unavailable'); };
    // archiveAgeDays=0 ⇒ 自动迁移恒关（阈值 0 就是关闭）
    await configStore.save({ autoMigrate: true, archiveAgeDays: 0 });
    const zero = await call(createVaultApi({ home, configStore, version: 'test', getEngine: async () => down(), logger: quiet }), { url: PREFIX + '/status', body: '{}' });
    assert.equal(zero.status, 200, JSON.stringify(zero.json));
    assert.equal(zero.json.vault.available, false);
    assert.equal(zero.json.archiveAgeDays, 0);
    assert.equal(zero.json.autoMigrate, false, '阈值 0 时自动迁移必须是关（与引擎口径一致）');

    // autoMigrate=true + 阈值 14 ⇒ true
    await configStore.save({ autoMigrate: true, archiveAgeDays: 14 });
    const on = await call(createVaultApi({ home, configStore, version: 'test', getEngine: async () => down(), logger: quiet }), { url: PREFIX + '/status', body: '{}' });
    assert.equal(on.json.archiveAgeDays, 14);
    assert.equal(on.json.autoMigrate, true, 'R3：引擎不可用时也必须按配置 + 阈值推算生效值');

    // autoMigrate=false + 阈值 14 ⇒ false
    await configStore.save({ autoMigrate: false, archiveAgeDays: 14 });
    const off = await call(createVaultApi({ home, configStore, version: 'test', getEngine: async () => down(), logger: quiet }), { url: PREFIX + '/status', body: '{}' });
    assert.equal(off.json.autoMigrate, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
