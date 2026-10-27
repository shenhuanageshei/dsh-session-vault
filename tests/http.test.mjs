import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createConfigStore, resolveVaultPaths } from '../lib/config.js';
import { createVaultApi, isTrustedRequest, PREFIX } from '../lib/http.js';
import { VaultStore } from '../lib/store.js';
import { VaultEngine, projectKey } from '../lib/engine.js';

const quietLogger = { info() {}, warn() {}, error() {} };

async function makeHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-http-'));
  const paths = resolveVaultPaths(home);
  const configStore = createConfigStore({ home, paths });
  return { home, paths, configStore };
}

function makeApi(home, configStore) {
  return createVaultApi({
    home,
    configStore,
    version: '0.1.0-test',
    getEngine: async () => null,
    logger: { warn() {} },
  });
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    // 真实 Node 的 writeHead 会与 setHeader 设过的头**合并**（同名以 writeHead 为准）；
    // 假 Res 必须照做，否则 handler 先 setHeader('allow','POST') 的 405 响应会被整体抹掉。
    writeHead(status, headers) {
      res.statusCode = status;
      for (const [key, value] of Object.entries(headers || {})) {
        res.headers[String(key).toLowerCase()] = value;
      }
    },
    setHeader(key, value) {
      res.headers[String(key).toLowerCase()] = value;
    },
    end(chunk) {
      res.body = chunk ? Buffer.from(chunk).toString('utf8') : '';
    },
  };
  return res;
}

function fakeReq({ method = 'POST', url = PREFIX + '/status', body = '{}', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:53210', ...headers };
  req.socket = { remoteAddress };
  return req;
}

async function call(api, options) {
  const res = fakeRes();
  await api.handler(fakeReq(options), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* keep null */ }
  return { status: res.statusCode, headers: res.headers, json, text: res.body };
}

async function startServer(handler) {
  const server = http.createServer((req, res) => { handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: 'http://127.0.0.1:' + port };
}

test('P0-2: status 在 loopback 上返回 ok', async () => {
  const { home, configStore } = await makeHome();
  const api = makeApi(home, configStore);
  const { server, url } = await startServer(api.handler);
  try {
    const res = await fetch(url + PREFIX + '/status', { method: 'POST', body: '{}' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.config.archiveAgeDays, 14);
    assert.equal(body.config.autoMigrate, false);
    assert.ok(body.queue && typeof body.queue.pending === 'number');
    assert.ok(Array.isArray(body.errors));
    // P2-4：status 必须同时给索引进度与清扫排程（不是只有 queue/errors）
    assert.ok(body.stats && typeof body.stats === 'object');
    assert.ok(body.index && typeof body.index.phase === 'string', 'status 必须带索引进度');
    assert.equal(typeof body.index.indexed, 'number');
    assert.equal(typeof body.index.total, 'number');
    // F1：没有 Sweeper 时**不再返回 null**（真机曾经 7 小时 null，运维读不出原因）。
    assert.equal(body.sweep && body.sweep.attached, false, 'sweep 必须是显式的未挂载对象');
    assert.ok(typeof body.sweep.error === 'string' && body.sweep.error.length > 0, '必须给出原因');
    assert.equal(body.sweep.sweepError.code, 'sweeper-not-attached');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('P0-2: 非 loopback 一律 403', async () => {
  const { home, configStore } = await makeHome();
  const api = makeApi(home, configStore);
  const res = await call(api, { remoteAddress: '10.1.2.3' });
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'forbidden');
  assert.equal(isTrustedRequest(fakeReq({ remoteAddress: '::ffff:10.0.0.9' })), false);
  assert.equal(isTrustedRequest(fakeReq({ remoteAddress: '::ffff:127.0.0.1' })), true);
  await rm(home, { recursive: true, force: true });
});

test('P0-2: cross-site 与异源 Origin 被拒绝', async () => {
  const { home, configStore } = await makeHome();
  const api = makeApi(home, configStore);
  const crossSite = await call(api, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const crossOrigin = await call(api, { headers: { origin: 'http://evil.example' } });
  assert.equal(crossOrigin.status, 403);
  const sameOrigin = await call(api, { headers: { origin: 'http://127.0.0.1:53210', 'sec-fetch-site': 'same-origin' } });
  assert.equal(sameOrigin.status, 200);
  await rm(home, { recursive: true, force: true });
});

test('P0-2: 只接受 POST', async () => {
  const { home, configStore } = await makeHome();
  const api = makeApi(home, configStore);
  const res = await call(api, { method: 'GET' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'POST', '405 必须带 Allow: POST（setHeader 与 writeHead 合并后仍在）');
  assert.equal(res.json.code, 'method-not-allowed');
  assert.equal(res.json.ok, false);
  await rm(home, { recursive: true, force: true });
});

test('P0-2: config 保存后立即被读取，并落到 <DSH_HOME>/session-vault/config.json', async () => {
  const { home, paths, configStore } = await makeHome();
  const api = makeApi(home, configStore);
  const saved = await call(api, {
    url: PREFIX + '/config',
    body: JSON.stringify({ patch: { archiveAgeDays: 7, autoMigrate: true, dailyBudgetCount: 5 } }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.ok, true);
  assert.equal(saved.json.config.archiveAgeDays, 7);

  assert.equal(existsSync(paths.configPath), true, '配置文件必须落盘');
  const onDisk = JSON.parse(await readFile(paths.configPath, 'utf8'));
  assert.equal(onDisk.archiveAgeDays, 7);
  assert.equal(onDisk.autoMigrate, true);

  const status = await call(api, { url: PREFIX + '/status' });
  assert.equal(status.json.config.archiveAgeDays, 7, '保存后无需重启即可读到新值');
  assert.equal(status.json.config.autoMigrate, true);

  const reread = await call(api, { url: PREFIX + '/config' });
  assert.equal(reread.json.config.dailyBudgetCount, 5);
  await rm(home, { recursive: true, force: true });
});

test('P0-2: 冷根放在 sessions 之内时保存被拒绝（I-9 / A-11）', async () => {
  const { home, paths, configStore } = await makeHome();
  const api = makeApi(home, configStore);
  const before = await call(api, { url: PREFIX + '/config' });
  const res = await call(api, {
    url: PREFIX + '/config',
    body: JSON.stringify({ patch: { coldRoot: path.join(paths.sessionsRoot, 'cold') } }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'invalid-config');
  assert.match(res.json.message, /sessions/);
  const after = await call(api, { url: PREFIX + '/config' });
  assert.deepEqual(after.json.config, before.json.config, '非法配置不得写入');
  await rm(home, { recursive: true, force: true });
});

test('P0-2: 负数阈值 / 未知字段被拒绝', async () => {
  const { home, configStore } = await makeHome();
  const api = makeApi(home, configStore);
  const negative = await call(api, { url: PREFIX + '/config', body: JSON.stringify({ patch: { archiveAgeDays: -1 } }) });
  assert.equal(negative.status, 400);
  const unknown = await call(api, { url: PREFIX + '/config', body: JSON.stringify({ patch: { nope: 1 } }) });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.message, /未知配置字段/);
  await rm(home, { recursive: true, force: true });
});

test('P0-2 / P3b：接口不留 501 占位（P2/P3 已实现，引擎未就绪时一律 503 vault-unavailable）', async () => {
  const { home, configStore } = await makeHome();
  const api = makeApi(home, configStore);
  // P2-2/P2-3 已实现：不再返回 not-implemented-p2
  const search = await call(api, { url: PREFIX + '/search', body: JSON.stringify({ q: 'x' }) });
  assert.equal(search.status, 503);
  assert.equal(search.json.code, 'vault-unavailable');
  const preview = await call(api, { url: PREFIX + '/preview', body: JSON.stringify({ id: 'x' }) });
  assert.equal(preview.status, 503);
  assert.equal(preview.json.code, 'vault-unavailable');
  // P3b：delete / repair / favorite / trash / diagnose 全部**已实现**（旧版本是 not-implemented-p3）。
  // 引擎没起来时它们与其它已实现接口一样返回 503 —— 不是 501，也不是 200 的空操作。
  for (const [name, body] of [
    ['delete', { id: 'x' }],
    ['repair', {}],
    ['favorite', { id: 'x', favorite: true }],
    ['trash', {}],
    ['trash-restore', { id: 'x' }],
    ['trash-purge', { id: 'x', confirm: true }],
    ['diagnose', {}],
  ]) {
    const res = await call(api, { url: PREFIX + '/' + name, body: JSON.stringify(body) });
    assert.equal(res.status, 503, name + ' 必须是 503（引擎未就绪），不是 501 占位：' + res.text);
    assert.equal(res.json.code, 'vault-unavailable', name + ' 的 code 必须是 vault-unavailable');
  }
  // 未实现的表单已清空：/status.notImplemented 的 p2/p3 都是空数组（不是「忘了登记」）
  const status = await call(api, { url: PREFIX + '/status' });
  assert.deepEqual(status.json.notImplemented, { p2: [], p3: [] });
  const unknown = await call(api, { url: PREFIX + '/nope' });
  assert.equal(unknown.status, 404);
  await rm(home, { recursive: true, force: true });
});

test('P0-2: 引擎未就绪时列表 503、坏请求体 400', async () => {
  const { home, configStore } = await makeHome();
  const api = makeApi(home, configStore);
  const list = await call(api, { url: PREFIX + '/list' });
  assert.equal(list.status, 503);
  const bad = await call(api, { url: PREFIX + '/status', body: '{not json' });
  assert.equal(bad.status, 400);
  const noId = await call(api, { url: PREFIX + '/migrate', body: '{}' });
  assert.equal(noId.status, 400);
  assert.equal(noId.json.code, 'invalid-request');
  await rm(home, { recursive: true, force: true });
});

test('P0-2: apply 注册 prefix 路由且只注册一次', async () => {
  const mod = await import('../lib/index.js');
  const registered = [];
  const ctx = {
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    get(service) {
      if (service === 'webServer') return { register(route) { registered.push(route); return () => {}; } };
      return undefined;
    },
    setTimeout() { return () => {}; },
    logger: { info() {}, warn() {} },
  };
  const dispose = mod.apply(ctx, {});
  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, 'prefix');
  assert.equal(registered[0].path, '/session-vault/api');
  assert.equal(typeof registered[0].handler, 'function');
  dispose();
});

// ---------------------------------------------------------------------------
// P2-4：可观测（status）与 P2-3 预览 API 的契约
// ---------------------------------------------------------------------------

test('P2-4: status 透传索引进度 / 清扫排程；/rebuild-index 支持 pause|resume|start；/search 走索引器', async () => {
  const { home, configStore } = await makeHome();
  const engineStatus = {
    stats: {
      sessions: 3, cold: 1, hot: 1, hotRestored: 0, hotArchived: 1, bytesCold: 10, errors: 0,
      candidates: 1, candidatesBytes: 10, archived: 2, markers: 0,
      archiveAgeDays: 14, autoMigrate: true, dailyBudgetCount: 20,
      indexed: 2, indexTotal: 3, indexPhase: 'indexing', nextSweepAt: 1799999999999, budgetUsedToday: 1,
    },
    queue: { pending: 1, running: 0, indexRunning: 1 },
    errors: [{ id: 'session-x', error: 'index-failed', status: 'hot' }],
    index: { phase: 'indexing', paused: false, indexed: 2, total: 3, skipped: 0, failed: 1, errors: [] },
    sweep: { nextRunAt: 1799999999999, paused: false, pauseReason: null, budget: { day: '2027-01-15', used: 1, limit: 20 }, lastReport: null },
    vault: { coldRoot: 'C:/x', coldRootAvailable: true, coldRoots: [], coldDegraded: false },
    banners: { coldUnavailable: false, coldRoots: [], am: null, overlay: { installed: true, drifted: false, archiveOk: true, unarchiveOk: true } },
    autoMigrate: true,
    archiveAgeDays: 14,
  };
  let paused = false;
  const indexerStub = {
    pause() { paused = true; return { phase: 'paused', paused: true, indexed: 2, total: 3 }; },
    resume() { paused = false; return Promise.resolve({ phase: 'indexing' }); },
    rescan() { paused = false; return Promise.resolve({ phase: 'indexing' }); },
    ensureStarted() { return Promise.resolve({ phase: 'indexing' }); },
    progress() { return { phase: paused ? 'paused' : 'indexing', paused, indexed: 2, total: 3, skipped: 0, failed: 1, errors: [] }; },
    async search(q) {
      return { query: q, tokens: ['x'], total: 1, hitCount: 1, groups: [{ sessionId: 's1', state: 'cold', title: 't', workspace: 'w', snippet: '[x]' }], tookMs: 1, index: this.progress() };
    },
  };
  const engine = { async status() { return engineStatus; }, store: {}, paths: {} };
  const api = createVaultApi({
    home, configStore, version: '0.1.0-test',
    getEngine: async () => engine,
    getIndexer: async () => indexerStub,
    logger: quietLogger,
  });
  try {
    const status = await call(api, { url: PREFIX + '/status' });
    assert.equal(status.status, 200);
    assert.equal(status.json.index.phase, 'indexing');
    assert.equal(status.json.index.indexed, 2);
    assert.equal(status.json.index.total, 3);
    assert.equal(status.json.sweep.nextRunAt, 1799999999999);
    assert.equal(status.json.sweep.budget.used, 1);
    assert.equal(status.json.queue.indexRunning, 1);
    assert.equal(status.json.stats.indexed, 2);
    assert.equal(status.json.stats.indexTotal, 3);
    assert.equal(status.json.stats.nextSweepAt, 1799999999999);
    assert.ok(Array.isArray(status.json.errors) && status.json.errors.length === 1);

    const pause = await call(api, { url: PREFIX + '/rebuild-index', body: JSON.stringify({ action: 'pause' }) });
    assert.equal(pause.status, 200, JSON.stringify(pause.json));
    assert.equal(pause.json.index.phase, 'paused');
    const resume = await call(api, { url: PREFIX + '/rebuild-index', body: JSON.stringify({ action: 'resume' }) });
    assert.equal(resume.status, 200);
    const start = await call(api, { url: PREFIX + '/rebuild-index', body: JSON.stringify({ action: 'start' }) });
    assert.equal(start.status, 200);
    const invalid = await call(api, { url: PREFIX + '/rebuild-index', body: JSON.stringify({ action: 'nope' }) });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, 'invalid-request');

    const search = await call(api, { url: PREFIX + '/search', body: JSON.stringify({ q: '针' }) });
    assert.equal(search.status, 200);
    assert.equal(search.json.groups.length, 1);
    assert.equal(search.json.groups[0].state, 'cold');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('P2-3: /preview 只读最近 N 条与命中上下文（冷会话；不恢复、不打开、不写文件）', async () => {
  const { home, paths, configStore } = await makeHome();
  const cwd = '<workspace-root>\\preview-demo';
  const pk = projectKey(cwd);
  const archived = new Set();
  const registry = {
    archivedSessionIds: archived,
    async archiveSession(id) { archived.add(String(id)); },
    async unarchiveSession(id) { archived.delete(String(id)); },
    async resolveByPath() { return undefined; },
  };
  const persistence = { async list() { return []; }, async stat() { return undefined; } };
  const store = await VaultStore.open(paths.dbPath);
  const engine = new VaultEngine({
    home, paths, configStore, store, registry, persistence, logger: quietLogger,
    isActive: async () => false,
    sameVolume: async () => true,
    detectAm: async () => ({ present: false, matches: [], sources: ['injected'] }),
    resolveWorkspace: async () => undefined,
  });
  try {
    const id = 'session-preview-1';
    const dir = path.join(paths.sessionsRoot, pk, id);
    await mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'request/header', sessionId: id, cwd, createdAt: 1791000000000 }),
      JSON.stringify({ type: 'user/message', seq: 1, ts: 1791000001000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '预览第一句人话' }] } }),
      JSON.stringify({ type: 'assistant/message', seq: 2, ts: 1791000002000, data: { message: { content: [{ type: 'reasoning', text: '不该出现的推理' }, { type: 'text', text: '预览第一句回复' }] } } }),
      JSON.stringify({ type: 'session/title', seq: 3, ts: 1791000003000, data: { title: '预览标题' } }),
      JSON.stringify({ type: 'user/message', seq: 4, ts: 1791000004000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '命中关键词的句子' }] } }),
    ];
    await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line + '\n')))));
    archived.add(id);
    const migrated = await engine.migrate(id);
    assert.equal(migrated.ok, true, JSON.stringify(migrated));

    const api = createVaultApi({ home, configStore, version: '0.1.0-test', getEngine: async () => engine, logger: quietLogger });
    const res = await call(api, { url: PREFIX + '/preview', body: JSON.stringify({ id, limit: 10 }) });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.ok, true);
    assert.equal(res.json.source, 'cold');
    assert.equal(res.json.title, '预览标题');
    assert.match(String(res.json.workspace), /preview-demo/);
    assert.ok(res.json.messages.length >= 3, JSON.stringify(res.json.messages));
    assert.equal(res.json.messages.some((message) => String(message.text).includes('不该出现')), false, 'reasoning 不进预览');
    assert.equal(store.getSession(id).status, 'cold', '预览不得恢复会话');
    assert.equal(existsSync(path.join(paths.sessionsRoot, pk, id)), false, '预览不得搬回热目录');

    const hit = await call(api, { url: PREFIX + '/preview', body: JSON.stringify({ id, q: '命中关键词', limit: 10 }) });
    assert.equal(hit.status, 200);
    assert.equal(hit.json.matched, true);
    assert.ok(hit.json.messages.some((message) => String(message.text).includes('命中关键词')), JSON.stringify(hit.json.messages));

    const missing = await call(api, { url: PREFIX + '/preview', body: JSON.stringify({ id: 'session-nope' }) });
    assert.equal(missing.status, 404);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P4（FR-P4-6 / FR-P4-7）：list.class 透传、/status.subagent、三个子代理路由
// ---------------------------------------------------------------------------

/** P4 测试用的最小索引器桩（/status 与 /list 会顺手触发一次 ensureStarted/ensureScope）。 */
function indexerStubForP4() {
  return {
    ensureStarted() { return Promise.resolve({ phase: 'idle' }); },
    ensureScope() { return Promise.resolve({ phase: 'idle' }); },
    progress() { return { phase: 'idle', paused: false, indexed: 0, total: 0, skipped: 0, failed: 0, errors: [] }; },
    scopeSnapshot() { return null; },
    async search() { return { query: '', tokens: [], total: 0, hitCount: 0, groups: [] }; },
  };
}

test('P4 A-P4-9：/list 的 class 三值透传（默认不带 filter；subagent / all 原样进引擎；非法值 400）', async () => {
  const { home, configStore } = await makeHome();
  const seen = [];
  const engine = {
    async status() { return { stats: {}, subagent: { scanGaps: [] } }; },
    async list(filter) {
      seen.push(filter);
      return { items: [], stats: {}, subagent: filter && filter.class ? { candidates: 0, cold: 0 } : null };
    },
    store: {},
    paths: {},
  };
  const api = createVaultApi({
    home, configStore, version: '0.1.0-test',
    getEngine: async () => engine,
    getIndexer: async () => indexerStubForP4(),
    logger: quietLogger,
  });
  try {
    const plain = await call(api, { url: PREFIX + '/list', body: '{}' });
    assert.equal(plain.status, 200, JSON.stringify(plain.json));
    assert.equal(seen[seen.length - 1], null, '默认视图必须保持「不带 filter」的原行为（可缓存）');
    const sub = await call(api, { url: PREFIX + '/list', body: JSON.stringify({ class: 'subagent' }) });
    assert.equal(sub.status, 200);
    assert.deepEqual(seen[seen.length - 1], { class: 'subagent' });
    assert.ok(sub.json.subagent, '子代理视图必须带 subagent 段');
    const all = await call(api, { url: PREFIX + '/list', body: JSON.stringify({ filter: { class: 'all' } }) });
    assert.equal(all.status, 200);
    assert.deepEqual(seen[seen.length - 1], { class: 'all' }, '旧调用形状（filter.class）同样认');
    const bad = await call(api, { url: PREFIX + '/list', body: JSON.stringify({ class: 'bogus' }) });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'invalid-class', '非法 class 必须明确拒绝（不静默回退成 archived）');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('P4 FR-P4-6：/status.subagent 段恒存在（引擎不可用时按配置兜底，读不到的事实 0 / null）', async () => {
  const { home, configStore } = await makeHome();
  const api = makeApi(home, configStore);
  try {
    const status = await call(api, { url: PREFIX + '/status' });
    const sub = status.json.subagent;
    assert.ok(sub && typeof sub === 'object', '/status.subagent 必须是对象（不是 undefined / null）');
    assert.equal(sub.ageDays, 14);
    assert.equal(sub.migrate, false);
    assert.equal(sub.migrateEffective, false);
    assert.equal(sub.dailyBudgetCount, 50);
    assert.equal(sub.candidates, 0);
    assert.equal(sub.candidatesBytes, 0);
    assert.equal(sub.cold, 0);
    assert.deepEqual(sub.scanGaps, []);
    assert.equal(sub.scanAt, null, '引擎不可用时扫描时间未知 ⇒ null（不编造）');
    assert.equal(sub.paused, false);
    assert.equal(sub.job, null);

    // 保存即生效（无需重启）：ageDays / migrateEffective 立刻跟着变
    const saved = await call(api, { url: PREFIX + '/config', body: JSON.stringify({ patch: { subagentMigrate: true, subagentAgeDays: 21 } }) });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const again = await call(api, { url: PREFIX + '/status' });
    assert.equal(again.json.subagent.ageDays, 21);
    assert.equal(again.json.subagent.migrateEffective, true);
    // 阈值 0 = 关闭 ⇒ 生效值恒 false（同 archiveAgeDays 口径）
    await call(api, { url: PREFIX + '/config', body: JSON.stringify({ patch: { subagentAgeDays: 0 } }) });
    const off = await call(api, { url: PREFIX + '/status' });
    assert.equal(off.json.subagent.enabled, false);
    assert.equal(off.json.subagent.migrateEffective, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('P4 FR-P4-6：/status.subagent 透传引擎读数（scanGaps / paused / pauseReason / job）', async () => {
  const { home, configStore } = await makeHome();
  const scanGaps = [{ id: 'broken-1', reason: 'no-generation' }];
  const engine = {
    async status() {
      return {
        stats: { sessions: 3 },
        subagent: {
          enabled: true,
          migrate: true,
          candidates: 7,
          candidatesBytes: 100,
          cold: 2,
          coldBytes: 50,
          scanAt: 1799999999000,
          scanFresh: true,
          scanGaps,
          paused: true,
          pauseReason: { code: 'subagent-refs-incomplete', message: 'gap' },
          job: { id: 'j1', running: false, total: 7, done: 7 },
        },
      };
    },
    store: {},
    paths: {},
  };
  const api = createVaultApi({
    home, configStore, version: '0.1.0-test',
    getEngine: async () => engine,
    getIndexer: async () => indexerStubForP4(),
    logger: quietLogger,
  });
  try {
    const status = await call(api, { url: PREFIX + '/status' });
    const sub = status.json.subagent;
    assert.equal(sub.candidates, 7);
    assert.equal(sub.cold, 2);
    assert.equal(sub.scanAt, 1799999999000);
    assert.equal(sub.paused, true);
    assert.equal(sub.pauseReason.code, 'subagent-refs-incomplete');
    assert.deepEqual(sub.scanGaps, scanGaps, 'gaps 必须逐条透传（UI 黄条要列出 id 与原因）');
    assert.equal(sub.job.done, 7);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('P4 FR-P4-7：subagent-scan / subagent-migrate（无 confirm ⇒ 400）/ subagent-job 三个路由', async () => {
  const { home, configStore } = await makeHome();
  const calls = [];
  const engine = {
    async status() { return { stats: {}, subagent: { scanGaps: [] } }; },
    async subscanSnapshot() {
      return { at: 123, count: 9, gaps: [], orphanEdges: [], fresh: true, refsIncomplete: false };
    },
    async scanHeaderFacts(options) {
      calls.push(['scan', options]);
      return { ok: true, at: 456, scanned: 9, gaps: [], orphanEdges: [] };
    },
    async subagentStatus() { return { candidates: 2, cold: 1 }; },
    async startSubagentJob(input) {
      calls.push(['job', input]);
      return { ok: true, job: { id: 'j1', running: true, total: 2, done: 0 }, wait: () => Promise.resolve({ ok: true }) };
    },
    subagentJobSnapshot() { return { id: 'j1', running: false, total: 2, done: 2, migrated: 2 }; },
    cancelSubagentJob() { calls.push(['cancel']); return { ok: true, job: { id: 'j1', cancelled: true } }; },
  };
  const api = createVaultApi({
    home, configStore, version: '0.1.0-test',
    getEngine: async () => engine,
    getIndexer: async () => indexerStubForP4(),
    logger: quietLogger,
  });
  try {
    // subagent-scan：start（立即扫描 = force）与 status（只读）
    const scan = await call(api, { url: PREFIX + '/subagent-scan', body: JSON.stringify({ action: 'start' }) });
    assert.equal(scan.status, 200, JSON.stringify(scan.json));
    assert.equal(scan.json.scan.at, 456);
    assert.deepEqual(calls[0], ['scan', { force: true }], '「立即扫描」必须 force（不吃 TTL 跳过）');
    assert.equal(scan.json.subagent.candidates, 2, '扫描后顺手回传子代理读数');
    const scanStatus = await call(api, { url: PREFIX + '/subagent-scan', body: JSON.stringify({ action: 'status' }) });
    assert.equal(scanStatus.status, 200);
    assert.equal(scanStatus.json.scan.at, 123, 'status 只读快照，不触发扫描');
    assert.equal(calls.filter((entry) => entry[0] === 'scan').length, 1);
    const badAction = await call(api, { url: PREFIX + '/subagent-scan', body: JSON.stringify({ action: 'nope' }) });
    assert.equal(badAction.status, 400);
    assert.equal(badAction.json.code, 'invalid-request');

    // subagent-migrate：没有 confirm:true ⇒ 400 且**零作业**
    const noConfirm = await call(api, { url: PREFIX + '/subagent-migrate', body: JSON.stringify({ all: true }) });
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.json.code, 'confirm-required');
    assert.equal(calls.some((entry) => entry[0] === 'job'), false, '没有 confirm:true 不得触发后台作业');
    const noTargets = await call(api, { url: PREFIX + '/subagent-migrate', body: JSON.stringify({ confirm: true }) });
    assert.equal(noTargets.status, 400, 'confirm 但没有 all/ids 也必须 400');

    const byIds = await call(api, { url: PREFIX + '/subagent-migrate', body: JSON.stringify({ ids: ['a', 'b'], confirm: true }) });
    assert.equal(byIds.status, 200, JSON.stringify(byIds.json));
    assert.equal(byIds.json.job.id, 'j1');
    assert.deepEqual(calls.find((entry) => entry[0] === 'job')[1], { ids: ['a', 'b'] });
    const byAll = await call(api, { url: PREFIX + '/subagent-migrate', body: JSON.stringify({ all: true, confirm: true }) });
    assert.equal(byAll.status, 200);
    assert.deepEqual(calls.filter((entry) => entry[0] === 'job')[1][1], { all: true });

    // subagent-job：status / cancel / 非法 action
    const jobStatus = await call(api, { url: PREFIX + '/subagent-job', body: JSON.stringify({ action: 'status' }) });
    assert.equal(jobStatus.status, 200);
    assert.equal(jobStatus.json.job.migrated, 2);
    const cancelled = await call(api, { url: PREFIX + '/subagent-job', body: JSON.stringify({ action: 'cancel' }) });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.job.cancelled, true);
    assert.equal(calls.filter((entry) => entry[0] === 'cancel').length, 1);
    const badJob = await call(api, { url: PREFIX + '/subagent-job', body: JSON.stringify({ action: 'nope' }) });
    assert.equal(badJob.status, 400);
    assert.equal(badJob.json.code, 'invalid-request');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('P4 FR-P4-7：引擎不可用时三个子代理路由一律 503（不是 501 占位、不是 200 空操作）', async () => {
  const { home, configStore } = await makeHome();
  const api = makeApi(home, configStore);
  try {
    for (const [name, body] of [
      ['subagent-scan', { action: 'status' }],
      ['subagent-migrate', { all: true, confirm: true }],
      ['subagent-job', { action: 'status' }],
    ]) {
      const res = await call(api, { url: PREFIX + '/' + name, body: JSON.stringify(body) });
      assert.equal(res.status, 503, name + ' 必须是 503：' + res.text);
      assert.equal(res.json.code, 'vault-unavailable');
    }
    const status = await call(api, { url: PREFIX + '/status' });
    assert.deepEqual(status.json.notImplemented, { p2: [], p3: [] }, '三个路由是已实现，不得留在 notImplemented 表里');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P4 FR-P4-2 / §19.7 + §19.9（2026-10-27 审计 #1/#2）：/status.subagent 的 count + gaps 自检关系与 scanPosture
// ---------------------------------------------------------------------------

test('P4 FR-P4-2：/status.subagent 给 count + gaps（§19.7 自检关系）与 scanPosture（§19.9）', async () => {
  const { home, configStore } = await makeHome();
  const scanGaps = [{ id: 'broken-1', reason: 'no-generation' }];
  const engine = {
    async status() {
      return {
        stats: {},
        subagent: {
          count: 4,
          gaps: scanGaps,
          scanCount: 4,
          scanGaps,
          scanPosture: 'ok',
          scanAt: 1799999999000,
          scanFresh: true,
        },
      };
    },
    store: {},
    paths: {},
  };
  const api = createVaultApi({
    home, configStore, version: '0.1.0-test',
    getEngine: async () => engine,
    getIndexer: async () => indexerStubForP4(),
    logger: quietLogger,
  });
  try {
    const status = await call(api, { url: PREFIX + '/status' });
    const sub = status.json.subagent;
    assert.equal(sub.count, 4, 'count = 成功读到 header 的目录数');
    assert.deepEqual(sub.gaps, scanGaps, 'gaps 必须逐条透传');
    assert.equal(sub.count + sub.gaps.length, 5, 'count + gaps = 扫描到的目录总数（自检关系）');
    assert.equal(sub.scanPosture, 'ok', 'scanPosture 必须透传');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('P4 FR-P4-2：引擎不可用时 count / gaps / scanPosture 是 0 / [] / null（不编造真空集）', async () => {
  const { home, configStore } = await makeHome();
  const api = makeApi(home, configStore);
  try {
    const status = await call(api, { url: PREFIX + '/status' });
    const sub = status.json.subagent;
    assert.equal(sub.count, 0);
    assert.deepEqual(sub.gaps, []);
    assert.equal(sub.scanPosture, null, '读不到扫描姿态 ⇒ null（不冒充 ok / empty-root）');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

