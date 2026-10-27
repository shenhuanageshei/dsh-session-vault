import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { resolveVaultPaths, createConfigStore } from '../lib/config.js';
import { VaultStore } from '../lib/store.js';
import { VaultEngine, projectKey } from '../lib/engine.js';
import { VaultIndexer, RESULT_STATE_LABELS } from '../lib/indexer.js';
import { createVaultApi, PREFIX } from '../lib/http.js';

const quiet = { info() {}, warn() {}, error() {} };
const T0 = 1800000000000;

function frames(id, cwd, texts = {}) {
  const user = texts.user || ('第一句人话 ' + id);
  const assistant = texts.assistant || ('第一句回复 ' + id);
  return [
    JSON.stringify({ type: 'request/header', sessionId: id, cwd, createdAt: 1791000000000 }),
    JSON.stringify({ type: 'user/message', seq: 1, ts: 1791000001000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: user }] } }),
    JSON.stringify({ type: 'assistant/message', seq: 2, ts: 1791000002000, data: { message: { content: [{ type: 'reasoning', text: '不该入索引的推理' }, { type: 'text', text: assistant }] } } }),
    JSON.stringify({ type: 'session/title', seq: 3, ts: 1791000003000, data: { title: texts.title || ('标题 ' + id) } }),
  ];
}

async function createHarness(options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-search-'));
  const paths = resolveVaultPaths(home);
  const cwd = '<workspace-root>\\demo';
  const pk = projectKey(cwd);
  const archived = new Set();
  const clock = { now: options.now === undefined ? T0 : options.now };
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
    now: () => clock.now,
    isActive: async (id) => (typeof options.active === 'function' ? options.active(id) : Boolean(options.active)),
    sameVolume: async () => true,
    detectAm: async () => ({ present: false, matches: [], sources: ['injected'] }),
    resolveWorkspace: async () => undefined,
  });

  async function addSession(id, opts = {}) {
    const dir = path.join(paths.sessionsRoot, pk, id);
    await mkdir(dir, { recursive: true });
    const logs = opts.logs || { 'session.v4.jsonl.zstd': frames(id, cwd, opts.texts || {}) };
    for (const [name, lines] of Object.entries(logs)) {
      await writeFile(path.join(dir, name), Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line + '\n')))));
    }
    return dir;
  }

  function indexer(overrides = {}) {
    return new VaultIndexer({ engine, store, paths, logger: quiet, now: () => clock.now, ...overrides });
  }

  return {
    home, paths, cwd, pk, archived, clock, registry, persistence, configStore, store, engine,
    addSession, indexer,
    hotDir: (id) => path.join(paths.sessionsRoot, pk, id),
    coldDir: (id) => path.join(paths.coldRootDefault, pk, id),
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
function fakeReq({ url = PREFIX + '/search', body = '{}' } = {}) {
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

test('P2-2 全量覆盖（D21）：冷存 / 归档 / 热会话全部可搜；冷会话无需恢复；状态与工作区正确', async () => {
  const h = await createHarness({ active: (id) => id === 'session-running' });
  try {
    await h.addSession('session-cold', { texts: { user: '冷存储里的独有句子', title: '冷会话标题' } });
    h.archived.add('session-cold');
    assert.equal((await h.engine.migrate('session-cold')).ok, true, '前提：冷会话');
    await h.addSession('session-archived', { texts: { user: '归档但还在热目录的句子', title: '归档会话标题' } });
    h.archived.add('session-archived');
    await h.addSession('session-plain', { texts: { user: '普通热会话的句子', title: '热会话标题' } });
    await h.addSession('session-running', { texts: { user: '正在运行的会话句子', title: '运行中标题' } });

    const indexer = h.indexer();
    const progress = await indexer.runFullIndex();
    assert.equal(progress.phase, 'done', JSON.stringify(progress));
    assert.ok(progress.total >= 4, JSON.stringify(progress));
    assert.equal(progress.failed, 0, JSON.stringify(progress.errors));
    assert.ok(progress.indexed >= 4, JSON.stringify(progress));

    const cold = await indexer.search('冷存储里的独有句子');
    assert.equal(cold.groups.length, 1, JSON.stringify(cold));
    assert.equal(cold.groups[0].state, 'cold');
    assert.equal(cold.groups[0].statusLabel, RESULT_STATE_LABELS.cold);
    assert.match(String(cold.groups[0].workspace), /demo/);
    assert.ok(cold.groups[0].snippet, '必须带 snippet');
    assert.ok(String(cold.groups[0].snippet).length > 0, 'snippet 来自命中正文：' + cold.groups[0].snippet);
    assert.equal(h.store.getSession('session-cold').status, 'cold', '搜索/索引不得恢复冷会话');

    const archivedHit = await indexer.search('归档但还在热目录的句子');
    assert.equal(archivedHit.groups[0].state, 'archived');
    assert.equal(archivedHit.groups[0].title, '归档会话标题');

    const plainHit = await indexer.search('普通热会话的句子');
    assert.equal(plainHit.groups[0].state, 'hot', '未归档热会话也必须可搜（D21）');
    assert.ok(h.store.getSession('session-plain'), '全量扫描应给热会话建最小行');

    const runningHit = await indexer.search('正在运行的会话句子');
    assert.equal(runningHit.groups[0].state, 'running');
    assert.equal(runningHit.groups[0].statusLabel, RESULT_STATE_LABELS.running);

    // 注入内容 / reasoning 不得入库（A-5a）
    const reasoning = await indexer.search('不该入索引的推理');
    assert.equal(reasoning.groups.length, 0);
  } finally {
    await h.dispose();
  }
});

test('P2-2 只索引最高代际（R-11）：v3+v4 目录里 v3 文本搜不到、v4 文本可搜', async () => {
  const h = await createHarness();
  try {
    const id = 'session-multi-gen';
    await h.addSession(id, {
      logs: {
        'session.v3.jsonl.zstd': [JSON.stringify({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '只有旧代际才有的句子' }] } })],
        'session.v4.jsonl.zstd': frames(id, h.cwd, { user: '只有最高代际才有的句子' }),
      },
    });
    const indexer = h.indexer();
    await indexer.runFullIndex();
    assert.equal((await indexer.search('只有最高代际才有的句子')).groups.length, 1);
    assert.equal((await indexer.search('只有旧代际才有的句子')).groups.length, 0, '低代际文本不得入索引');
    const row = h.store.getSession(id);
    assert.equal(row.log_names, 'session.v3.jsonl.zstd,session.v4.jsonl.zstd');
    assert.equal(row.format_version, 4);
  } finally {
    await h.dispose();
  }
});

test('P2-2 水位增量：未变更会话不重索引；变更后搜索按需重索引（有界批量）', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-wm-a', { texts: { user: '水位样本甲' } });
    await h.addSession('session-wm-b', { texts: { user: '水位样本乙' } });
    const indexer = h.indexer();
    await indexer.runFullIndex();

    let calls = 0;
    const original = h.engine.indexSession.bind(h.engine);
    h.engine.indexSession = async (...args) => {
      calls += 1;
      return original(...args);
    };
    const first = await indexer.search('水位样本甲');
    assert.equal(first.groups.length, 1);
    assert.equal(calls, 0, '未变更的会话不得重索引（水位命中）');
    assert.equal(indexer.progress().sync.reindexed, 0);

    // 变更 session-wm-b：追加一句新人话（size/mtime 都变）
    const file = path.join(h.hotDir('session-wm-b'), 'session.v4.jsonl.zstd');
    const before = await readFile(file);
    const extra = zstdCompressSync(Buffer.from(JSON.stringify({ type: 'user/message', seq: 4, ts: 1791000004000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '后来追加的独有句子' }] } }) + '\n'));
    await writeFile(file, Buffer.concat([before, extra]));

    const hit = await indexer.search('后来追加的独有句子');
    assert.equal(hit.groups.length, 1, JSON.stringify(hit));
    assert.equal(hit.groups[0].sessionId, 'session-wm-b');
    assert.equal(calls, 1, '变更会话必须在搜索前按需重索引');
    assert.equal(hit.sync.reindexed, 1);

    const again = await indexer.search('后来追加的独有句子');
    assert.equal(again.groups.length, 1, '水位更新后仍可搜到');
    assert.equal(calls, 1, '水位更新后不得重复重索引');
  } finally {
    await h.dispose();
  }
});

test('P2-2 暂停 / 续做 / 进度：暂停后 indexTarget 不再前进，resume 从断点继续', async () => {
  const h = await createHarness();
  try {
    for (let i = 0; i < 8; i += 1) await h.addSession('session-pause-' + i, { texts: { user: '暂停样本 ' + i } });
    const indexer = h.indexer();
    let calls = 0;
    const original = indexer.indexTarget.bind(indexer);
    indexer.indexTarget = async (target, options) => {
      calls += 1;
      const result = await original(target, options);
      if (calls === 3) indexer.pause();
      return result;
    };
    const paused = await indexer.runFullIndex();
    assert.equal(paused.phase, 'paused', JSON.stringify(paused));
    assert.equal(paused.paused, true);
    assert.ok(paused.indexed <= 3, '暂停后不得继续索引：' + JSON.stringify(paused));
    assert.ok(paused.total >= 8);
    const stoppedAt = calls;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, stoppedAt, '暂停后不得再有新的索引调用');

    indexer.indexTarget = original;
    const done = await indexer.resume();
    assert.equal(done.phase, 'done', JSON.stringify(done));
    assert.equal(done.failed, 0);
    assert.equal((await indexer.search('暂停样本 7')).groups.length, 1, '续做后所有会话可搜');
  } finally {
    await h.dispose();
  }
});

test('P2-2 建库顺序：冷存 → 热归档 → 热会话（同档按最近活跃倒序）', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-order-hot-old', { texts: { user: '顺序样本热旧' } });
    await h.addSession('session-order-hot-new', { texts: { user: '顺序样本热新' } });
    await h.addSession('session-order-archived', { texts: { user: '顺序样本归档' } });
    h.archived.add('session-order-archived');
    await h.addSession('session-order-cold', { texts: { user: '顺序样本冷' } });
    h.archived.add('session-order-cold');
    assert.equal((await h.engine.migrate('session-order-cold')).ok, true);
    // mtime 排序：新 > 旧
    const now = Date.now();
    await import('node:fs/promises').then(({ utimes }) => utimes(path.join(h.hotDir('session-order-hot-old'), 'session.v4.jsonl.zstd'), new Date(now - 3600000), new Date(now - 3600000)));

    const indexer = h.indexer();
    const order = [];
    const original = indexer.indexTarget.bind(indexer);
    indexer.indexTarget = async (target, options) => {
      order.push(target.id);
      return original(target, options);
    };
    await indexer.runFullIndex();
    assert.equal(order[0], 'session-order-cold', '冷存必须最先建库：' + JSON.stringify(order));
    assert.equal(order[1], 'session-order-archived', '归档次之：' + JSON.stringify(order));
    const hotIndex = order.indexOf('session-order-hot-new');
    const oldIndex = order.indexOf('session-order-hot-old');
    assert.ok(hotIndex > 1 && oldIndex > hotIndex, '热会话最后、且按最近活跃倒序：' + JSON.stringify(order));
  } finally {
    await h.dispose();
  }
});

test('P2-2 /session-vault/api/search：分组 + snippet + 状态/工作区 + tokens + 进度；转义不炸', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-api-cold', { texts: { user: 'API 冷句子的正文', title: 'API 冷标题' } });
    h.archived.add('session-api-cold');
    assert.equal((await h.engine.migrate('session-api-cold')).ok, true);
    await h.addSession('session-api-hot', { texts: { user: 'API 热句子的正文', title: 'API 热标题' } });
    const indexer = h.indexer();
    await indexer.runFullIndex();

    const api = createVaultApi({
      home: h.home,
      configStore: h.configStore,
      version: '0.1.0-test',
      getEngine: async () => h.engine,
      getIndexer: async () => indexer,
      logger: quiet,
    });
    const res = await call(api, { url: PREFIX + '/search', body: JSON.stringify({ q: 'API 冷句子' }) });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.ok, true);
    assert.equal(res.json.groups.length, 1);
    const group = res.json.groups[0];
    assert.equal(group.sessionId, 'session-api-cold');
    assert.equal(group.state, 'cold');
    assert.ok(group.snippet);
    assert.match(String(group.workspace), /demo/);
    assert.ok(Array.isArray(res.json.tokens) && res.json.tokens.length > 0, '分词 tokens 必须回传');
    assert.ok(res.json.index && typeof res.json.index.phase === 'string', '搜索响应带索引进度');
    assert.ok(typeof res.json.tookMs === 'number');

    // A-5c：引号 / 星号 / NEAR( 不得造成语法错误或全匹配
    const weird = await call(api, { url: PREFIX + '/search', body: JSON.stringify({ q: '\" * NEAR( 冷句子' }) });
    assert.equal(weird.status, 200, JSON.stringify(weird.json));
    assert.equal(weird.json.ok, true);
    assert.ok(Array.isArray(weird.json.groups));
    for (const hit of weird.json.groups) assert.ok(hit.sessionId.startsWith('session-api-'), '不得全匹配到无关会话');

    const empty = await call(api, { url: PREFIX + '/search', body: JSON.stringify({}) });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.groups, []);

    const filtered = await call(api, { url: PREFIX + '/search', body: JSON.stringify({ q: 'API', workspace: 'demo' }) });
    assert.ok(filtered.json.groups.length >= 2, JSON.stringify(filtered.json.groups));
    const stateFiltered = await call(api, { url: PREFIX + '/search', body: JSON.stringify({ q: 'API', state: 'cold' }) });
    assert.equal(stateFiltered.json.groups.length, 1);
  } finally {
    await h.dispose();
  }
});
