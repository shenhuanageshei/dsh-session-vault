import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { resolveVaultPaths, createConfigStore } from '../lib/config.js';
import { VaultStore } from '../lib/store.js';
import { VaultEngine, projectKey } from '../lib/engine.js';
import { VaultIndexer, TARGETS_TTL_MS } from '../lib/indexer.js';
import { Sweeper } from '../lib/sweeper.js';
import { createVaultApi, PREFIX } from '../lib/http.js';
import { hashFile } from '../lib/marker.js';

/**
 * P2.1 修复轮的锚测试（偏离审计 M1–M7 + 代码评审 #1–#8 + 设计档 §15.1 口径裁定）。
 * 全部落在 os.tmpdir() 的临时 home 里，不触碰真实 ~/.dsh。
 */
const quiet = { info() {}, warn() {}, error() {} };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T0 = 1800000000000;
const RELAX = process.env.VAULT_PERF_RELAX === '1';

function frames(id, cwd, texts = {}) {
  const user = texts.user || ('第一句人话 ' + id);
  const assistant = texts.assistant || ('第一句回复 ' + id);
  return [
    JSON.stringify({ type: 'request/header', sessionId: id, cwd, createdAt: 1791000000000 }),
    JSON.stringify({ type: 'user/message', seq: 1, ts: 1791000001000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: user }] } }),
    JSON.stringify({ type: 'assistant/message', seq: 2, ts: 1791000002000, data: { message: { content: [{ type: 'text', text: assistant }] } } }),
    JSON.stringify({ type: 'session/title', seq: 3, ts: 1791000003000, data: { title: texts.title || ('标题 ' + id) } }),
  ];
}

async function createHarness(options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p21-'));
  const paths = resolveVaultPaths(home);
  const cwd = '<workspace-root>\\demo';
  const pk = projectKey(cwd);
  const archived = new Set();
  const clock = { now: options.now === undefined ? T0 : options.now };
  const counts = { waterfall: 0, active: 0 };
  const registry = {
    archivedSessionIds: archived,
    async archiveSession(id) { archived.add(String(id)); },
    async unarchiveSession(id) { archived.delete(String(id)); },
    async resolveByPath() { return undefined; },
  };
  const persistence = { async list() { return []; }, async stat() { return undefined; } };
  const configStore = createConfigStore({ home, paths });
  await configStore.save({ autoMigrate: false, archiveAgeDays: 14, ...(options.config || {}) });
  const store = await VaultStore.open(paths.dbPath);
  const engineOptions = {
    home, paths, configStore, store, registry, persistence, logger: quiet,
    now: () => clock.now,
    sameVolume: async () => true,
    detectAm: options.detectAm || (async () => ({ present: false, matches: [], sources: ['injected'] })),
    resolveWorkspace: async () => undefined,
  };
  if (options.hostActivity) {
    // 不注入 isActive：走宿主活动判据（waterfall），用于验证「批量并发而不是逐条串行」
    engineOptions.ctx = {
      async waterfall(name, payload) {
        counts.waterfall += 1;
        if (typeof options.hostActivity === 'function') return options.hostActivity(payload.sessionId);
        return [];
      },
    };
  } else if (!options.noInjectedActive) {
    engineOptions.isActive = async (id) => {
      counts.active += 1;
      return typeof options.active === 'function' ? Boolean(options.active(id)) : Boolean(options.active);
    };
  }
  const engine = new VaultEngine(engineOptions);

  async function addSession(id, opts = {}) {
    const dir = path.join(paths.sessionsRoot, pk, id);
    await mkdir(dir, { recursive: true });
    const logs = opts.logs || { 'session.v4.jsonl.zstd': frames(id, cwd, opts.texts || {}) };
    for (const [name, logLines] of Object.entries(logs)) {
      await writeFile(path.join(dir, name), Buffer.concat(logLines.map((line) => zstdCompressSync(Buffer.from(line + '\n')))));
    }
    return dir;
  }

  function indexer(overrides = {}) {
    return new VaultIndexer({ engine, store, paths, logger: quiet, now: () => clock.now, ...overrides });
  }

  function sweeper(overrides = {}) {
    return new Sweeper({ engine, logger: quiet, now: () => clock.now, ...overrides });
  }

  async function seedArchived(id, daysAgo = 30, texts = {}) {
    await addSession(id, { texts });
    archived.add(id);
    await engine.backfillArchivedAt({});
    const stamp = clock.now - daysAgo * 86400000;
    store.updateSession(id, { file_mtime_ms: stamp, created_at: stamp });
    engine.invalidate();
    return id;
  }

  return {
    home, paths, cwd, pk, archived, clock, counts, registry, persistence, configStore, store, engine,
    addSession, indexer, sweeper, seedArchived,
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

function makeApi(h, overrides = {}) {
  return createVaultApi({
    home: h.home,
    configStore: h.configStore,
    version: '0.1.0-test',
    getEngine: async () => h.engine,
    logger: quiet,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// M1：全量完成后新建会话，无需手动 start 即可被 /search 命中
// ---------------------------------------------------------------------------
test('M1：全量 done 之后新建会话 → TTL 到期自动重扫并增量索引，/search 无需手动 start 即可命中', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-m1-old', { texts: { user: '旧会话的独有句子' } });
    const indexer = h.indexer();
    const progress = await indexer.runFullIndex();
    assert.equal(progress.phase, 'done', JSON.stringify(progress));
    assert.equal(progress.persisted, undefined);

    await h.addSession('session-m1-new', { texts: { user: '新会话的独有句子' } });

    // TTL 内：有界（不重扫），搜不到新会话 —— 这是「最多每 5 分钟一次」的成本上限
    const fresh = await indexer.search('新会话的独有句子');
    assert.equal(fresh.groups.length, 0, JSON.stringify(fresh));
    assert.equal(fresh.refresh.rescanned, false, 'TTL 内不得重扫目录：' + JSON.stringify(fresh.refresh));

    // TTL 到期：同一实例、同一 store，不调用 resume/rescan，只 search
    h.clock.now += TARGETS_TTL_MS;
    const after = await indexer.search('新会话的独有句子');
    assert.equal(after.groups.length, 1, JSON.stringify(after));
    assert.equal(after.groups[0].sessionId, 'session-m1-new');
    assert.equal(after.refresh.rescanned, true, JSON.stringify(after.refresh));
    assert.ok(after.refresh.indexed >= 1, '新会话必须被增量索引：' + JSON.stringify(after.refresh));

    // 再来一次：水位已建立 ⇒ 不再重复索引（有界）
    h.clock.now += TARGETS_TTL_MS;
    const again = await indexer.search('新会话的独有句子');
    assert.equal(again.groups.length, 1);
    assert.equal(again.refresh.indexed, 0, '水位命中后不得重复索引：' + JSON.stringify(again.refresh));
  } finally {
    await h.dispose();
  }
});

test('M1：清扫也会触发索引器的 TTL 增量刷新（随每次清扫）', async () => {
  const h = await createHarness({ config: { autoMigrate: true } });
  try {
    await h.addSession('session-m1-sweep-old', { texts: { user: '清扫前的旧会话' } });
    const indexer = h.indexer();
    await indexer.runFullIndex();
    await h.addSession('session-m1-sweep-new', { texts: { user: '清扫时新出现的会话' } });
    h.engine.indexer = indexer;
    h.clock.now += TARGETS_TTL_MS;
    const sweeper = new Sweeper({ engine: h.engine, logger: quiet, now: () => h.clock.now });
    await sweeper.sweep();
    // 清扫通过 indexer.ensureStarted() → done 分支 → _autoRefresh（后台）触发 TTL 重扫：等它落地
    if (indexer._refreshPromise) await indexer._refreshPromise;
    const target = indexer.targets.get('session-m1-sweep-new');
    assert.ok(target, '清扫必须触发目标集重扫（新会话进目标集）');
    assert.equal(await indexer.needsIndex(target), false, '清扫必须把新会话增量索引掉');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// M2：archivedAt 双缺口
// ---------------------------------------------------------------------------
test('M2①：indexer 首建行时，id 已在归档集合里 ⇒ archived_at=now + backfilled=1（不再恒 null）', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-m2a', { texts: { user: '归档但先被索引的会话' } });
    h.archived.add('session-m2a');
    const indexer = h.indexer();
    // 不调用 backfillArchivedAt / recoverOnBoot：缺口就出在「索引先建行」这条路径上
    const result = await indexer.indexTarget({ ...(await indexer.scanTargets()).get('session-m2a') });
    assert.equal(result.ok, true, JSON.stringify(result));
    const row = h.store.getSession('session-m2a');
    assert.ok(row, '必须建行');
    assert.equal(row.archived_at, h.clock.now, 'archivedAt 必须落 now（不是 null）');
    assert.equal(row.backfilled, 1, '必须是 backfilled 标记（与回填口径一致）');

    // 非归档会话：不写 archivedAt
    await h.addSession('session-m2a-hot', { texts: { user: '未归档的热会话' } });
    const indexer2 = h.indexer();
    await indexer2.indexTarget({ ...(await indexer2.scanTargets()).get('session-m2a-hot') });
    const hotRow = h.store.getSession('session-m2a-hot');
    assert.equal(hotRow.archived_at, null, '未归档会话不得写 archivedAt');
  } finally {
    await h.dispose();
  }
});

test('M2②：只读回填 tick 在 pause 短路之前 —— autoMigrate=false 与 AM 在场时也照跑', async () => {
  // ① autoMigrate=false（默认观察模式）
  {
    const h = await createHarness({ config: { autoMigrate: false } });
    try {
      await h.addSession('session-m2b-off', { texts: { user: '观察模式下的归档会话' } });
      h.archived.add('session-m2b-off');
      assert.equal(h.store.getSession('session-m2b-off'), null, '前提：DB 无行');
      const report = await h.sweeper().sweep();
      assert.equal(report.skipped, 'auto-migrate-off', JSON.stringify(report));
      assert.ok(report.backfilled >= 1, 'autoMigrate 关闭时也必须回填：' + JSON.stringify(report));
      const row = h.store.getSession('session-m2b-off');
      assert.ok(row && row.archived_at > 0, 'archivedAt 必须落库（旧实现被 pause 短路挡住）');
    } finally { await h.dispose(); }
  }
  // ② archive-manager 在场（AC-9 / A-18：不搬移，但展示字段要自愈）
  {
    const h = await createHarness({
      config: { autoMigrate: true },
      detectAm: async () => ({ present: true, matches: [{ id: '@michengai/dsh-archive-manager' }], sources: ['injected'] }),
    });
    try {
      await h.addSession('session-m2b-am', { texts: { user: 'AM 在场时的归档会话' } });
      h.archived.add('session-m2b-am');
      const report = await h.sweeper().sweep();
      assert.equal(report.skipped, 'archive-manager', JSON.stringify(report));
      assert.ok(report.backfilled >= 1, 'AM 在场时也必须回填（只补 DB 字段、不搬文件）：' + JSON.stringify(report));
      const row = h.store.getSession('session-m2b-am');
      assert.ok(row && row.archived_at > 0);
      assert.equal(row.status, 'hot', 'AM 在场一个都不迁');
    } finally { await h.dispose(); }
  }
});
// ---------------------------------------------------------------------------
// M3：启动恢复失败不再「sweeper 不起」
// ---------------------------------------------------------------------------
test('M3：recoverOnBoot 失败 ⇒ Sweeper 仍起跑但 paused + sweepError；重试成功后自动解除', async () => {
  const h = await createHarness({ config: { autoMigrate: true } });
  try {
    const id = await h.seedArchived('session-m3', 30);
    const sweeper = new Sweeper({ engine: h.engine, logger: quiet, now: () => h.clock.now });
    sweeper.holdBootError(new Error('boot boom'));
    const snap = sweeper.snapshot();
    assert.equal(snap.paused, true);
    assert.equal(snap.sweepError.code, 'boot-recovery-failed');
    assert.match(snap.sweepError.message, /boot boom/);
    assert.equal(snap.pauseReason.code, 'boot-recovery-failed');

    const paused = await sweeper.sweep();
    assert.equal(paused.skipped, 'boot-recovery-failed', JSON.stringify(paused));
    assert.equal(h.store.getSession(id).status, 'hot', '暂停态下一个都不迁');
    assert.ok(paused.backfilled !== undefined, '暂停也要带 backfilled 读数（回填先于短路）');

    // 收敛恢复成功 ⇒ 自动解除暂停
    let recovered = 0;
    h.engine.recoverOnBoot = async () => { recovered += 1; return { ok: true, repaired: false, counts: {} }; };
    const retried = await sweeper.retryBootRecovery();
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(recovered, 1);
    assert.equal(sweeper.snapshot().sweepError, null, '成功后必须清掉 sweepError');
    assert.equal(sweeper.snapshot().paused, false, '成功后必须解除 paused');

    const resumed = await sweeper.sweep();
    assert.equal(resumed.migrated, 1, JSON.stringify(resumed));
    assert.equal(h.store.getSession(id).status, 'cold');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// M4：列表稳定达标（缓存时刻 / 批量活跃 / 候选缓存 / HTTP 计时）
// ---------------------------------------------------------------------------
test('M4①：list 缓存时间戳取写入时刻 —— 慢请求之后紧接着的请求必须命中', async () => {
  const h = await createHarness();
  try {
    for (let i = 0; i < 5; i += 1) {
      await h.addSession('session-m4a-' + i, { texts: { user: '缓存样本 ' + i } });
      h.archived.add('session-m4a-' + i);
    }
    h.engine._listCacheTtlMs = 100;
    const originalScan = h.engine.scanArchivedDirs.bind(h.engine);
    h.engine.scanArchivedDirs = async (ids) => {
      await new Promise((resolve) => setTimeout(resolve, 260)); // > TTL：旧实现会把「请求开始时刻」写进缓存
      return originalScan(ids);
    };
    const first = await h.engine.list();
    assert.equal(first.items.length, 5);
    const hits = h.engine.perfStats().listHits;
    const second = await h.engine.list();
    assert.equal(second, first, '慢请求之后必须立刻命中同一份缓存');
    assert.equal(h.engine.perfStats().listHits, hits + 1, 'M4①：缓存 at 必须是写入时刻，否则慢请求等于永不命中');
  } finally {
    await h.dispose();
  }
});

test('M4②：候选批量活跃判定（不再 118 次串行 waterfall）+ 5s 缓存 + 事件失效', async () => {
  const h = await createHarness({ hostActivity: async () => [] });
  try {
    const ids = [];
    for (let i = 0; i < 60; i += 1) {
      const id = 'session-m4b-' + String(i).padStart(2, '0');
      ids.push(id);
      await h.addSession(id, { texts: { user: '批量活跃样本 ' + i } });
      h.archived.add(id);
    }
    await h.engine.backfillArchivedAt({}); // 一次回填 60 行（逐条 seedArchived 会把目录扫描做 60 次）
    const stamp = h.clock.now - 30 * 86400000;
    for (const id of ids) h.store.updateSession(id, { file_mtime_ms: stamp, created_at: stamp });
    h.engine.invalidate();
    const first = await h.engine.list();
    const afterFirst = h.counts.waterfall;
    assert.equal(afterFirst, 60, '每个候选一次活动判据（不是 118 次 / 每请求重复）：' + afterFirst);
    assert.equal(first.stats.pendingCount, 60);

    // 越过 list 缓存（2s）但仍在候选缓存（5s）之内：候选必须命中、活动判据不得再打
    h.clock.now += 2500;
    const hitsBefore = h.engine.perfStats().candidateHits;
    await h.engine.list();
    assert.equal(h.counts.waterfall, afterFirst, 'TTL 内复用候选缓存，不得再打活动判据');
    assert.ok(h.engine.perfStats().candidateHits > hitsBefore, '候选缓存必须命中（perfStats.candidateHits）');

    // 事件失效：归档/迁移/恢复都会 emit → invalidate
    h.engine.emit({ type: 'migrate', id: 'session-m4b-00' });
    assert.equal(h.engine.perfStats().candidatesCached, false, '事件必须让候选缓存失效');
    await h.engine.list();
    assert.ok(h.counts.waterfall >= afterFirst + 60, '失效后必须重算（批量一次）：' + h.counts.waterfall);
  } finally {
    await h.dispose();
  }
});

test('M4③：HTTP 层 /list 计时 —— 118 行冷启动 <2s、命中 <500ms（VAULT_PERF_RELAX=1 放宽）', async () => {
  const h = await createHarness();
  try {
    for (let i = 0; i < 118; i += 1) {
      await h.addSession('session-m4c-' + String(i).padStart(3, '0'), { texts: { user: 'HTTP 计时样本 ' + i } });
      h.archived.add('session-m4c-' + String(i).padStart(3, '0'));
    }
    // /list 会惰性拉起索引器（本测试只量列表，不需要全量索引在后台抢 CPU/SQLite）
    const indexerStub = {
      ensureStarted: async () => ({ phase: 'done' }),
      progress: () => ({ phase: 'done', paused: false, indexed: 0, total: 0, skipped: 0, failed: 0, errors: [] }),
      pause() { return this.progress(); },
      resume: async () => ({ phase: 'done' }),
      rescan: async () => ({ phase: 'done' }),
      search: async () => ({ groups: [], tokens: [] }),
    };
    const api = makeApi(h, { getIndexer: async () => indexerStub });
    const coldStart = Date.now();
    const cold = await call(api, { url: PREFIX + '/list', body: '{}' });
    const coldMs = Date.now() - coldStart;
    assert.equal(cold.status, 200, JSON.stringify(cold.json).slice(0, 300));
    assert.equal(cold.json.items.length, 118);
    const hitStart = Date.now();
    const hit = await call(api, { url: PREFIX + '/list', body: '{}' });
    const hitMs = Date.now() - hitStart;
    assert.equal(hit.status, 200);
    const coldLimit = RELAX ? 10000 : 2000;
    const hitLimit = RELAX ? 5000 : 500;
    if (RELAX) console.log('[perf] VAULT_PERF_RELAX=1：/list 阈值放宽为 cold<' + coldLimit + 'ms / hit<' + hitLimit + 'ms');
    console.log('[perf] /list 118 行：冷启动 ' + coldMs + 'ms，命中 ' + hitMs + 'ms');
    assert.ok(coldMs < coldLimit, '/list 冷启动必须 <' + coldLimit + 'ms，实测 ' + coldMs + 'ms');
    assert.ok(hitMs < hitLimit, '/list 命中必须 <' + hitLimit + 'ms，实测 ' + hitMs + 'ms');
  } finally {
    await h.dispose();
  }
});

test('§15.1 #3：pendingCount 不再静默封顶 50 —— 全量数 + pendingCapped', async () => {
  const h = await createHarness();
  try {
    const ids = [];
    for (let i = 0; i < 60; i += 1) {
      const id = 'session-c1-' + String(i).padStart(2, '0');
      ids.push(id);
      await h.addSession(id, { texts: { user: '全量候选样本 ' + i } });
      h.archived.add(id);
    }
    await h.engine.backfillArchivedAt({});
    const stamp = h.clock.now - 30 * 86400000;
    for (const id of ids) h.store.updateSession(id, { file_mtime_ms: stamp, created_at: stamp });
    h.engine.invalidate();
    const list = await h.engine.list();
    assert.equal(list.stats.pendingCount, 60, '必须是全量候选数（旧实现恒 ≤50）：' + JSON.stringify(list.stats));
    assert.equal(list.stats.pendingCapped, true, '超过采样窗口必须显式声明 pendingCapped');
    assert.equal(list.stats.pendingSampleLimit, 50);
    assert.ok(list.stats.pendingBytes > 0);
    const status = await h.engine.status();
    assert.equal(status.stats.candidates, 60, 'status 的 candidates 同样是全量数');
    assert.equal(status.stats.candidatesCapped, true);
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// M5：索引写路径必须进 VaultEngine 单串行队列
// ---------------------------------------------------------------------------
test('M5：indexTarget 走 engine.enqueue（串行化）、重入不自锁、migrating/restoring 行跳过', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-m5-a', { texts: { user: '队列样本甲' } });
    const indexer = h.indexer();
    const order = [];
    const originalIndex = h.engine.indexSession.bind(h.engine);
    h.engine.indexSession = async (...args) => { order.push('index:' + args[0]); return originalIndex(...args); };
    const originalEnqueue = h.engine.enqueue.bind(h.engine);
    let enqueued = 0;
    h.engine.enqueue = (task) => { enqueued += 1; return originalEnqueue(task); };

    // ① 索引写必须排在已经占着队列的任务之后（旧实现直调 indexSession，会插到队列中间）
    const gate = h.engine.enqueue(async () => {
      order.push('task-start');
      await new Promise((resolve) => setTimeout(resolve, 80));
      order.push('task-end');
    });
    const indexing = indexer.runFullIndex();
    await gate;
    await indexing;
    assert.ok(enqueued >= 1, 'M5：索引写必须经 engine.enqueue');
    assert.deepEqual(order.slice(0, 3), ['task-start', 'task-end', 'index:session-m5-a'], '索引写必须排在队列任务之后：' + JSON.stringify(order));

    // ② 重入：队列任务体内再触发索引（迁移/恢复尾段的真实形态）不得自锁
    await h.addSession('session-m5-b', { texts: { user: '队列样本乙' } });
    const nested = h.engine.enqueue(async () => {
      const target = { ...(await indexer.scanTargets({ force: true })).get('session-m5-b') };
      return indexer.indexTarget(target, { force: true });
    });
    const nestedResult = await Promise.race([
      nested,
      new Promise((resolve) => setTimeout(() => resolve({ deadlock: true }), 5000)),
    ]);
    assert.notEqual(nestedResult.deadlock, true, '队列重入必须就地执行，不得自锁');
    assert.equal(nestedResult.ok, true, JSON.stringify(nestedResult));

    // ③ migrating / restoring 行不给索引写路径插手（记录后跳过）
    h.store.updateSession('session-m5-b', { status: 'migrating' });
    const busy = await indexer.indexTarget({ ...(await indexer.scanTargets({ force: true })).get('session-m5-b') }, { force: true });
    assert.equal(busy.skipped, true, JSON.stringify(busy));
    assert.equal(busy.reason, 'busy-status');
    assert.equal(busy.status, 'migrating');
  } finally {
    await h.dispose();
  }
});
// ---------------------------------------------------------------------------
// 评审 #3：marker 只有 files[]（缺 planSha）时必须先逐文件校验冷侧
// ---------------------------------------------------------------------------
async function makeSide(root, files) {
  await mkdir(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  return root;
}

async function filesOf(root) {
  const names = await readdir(root);
  const out = [];
  for (const name of names) out.push({ name, sha256: await hashFile(path.join(root, name)) });
  return out;
}

test('评审 #3：marker 只有 files[] ⇒ 冷侧逐文件校验通过才允许 delete-hot；不通过一律 needs-review', async () => {
  const h = await createHarness();
  try {
    const cold = path.join(h.home, 'review-3-cold');
    const hot = path.join(h.home, 'review-3-hot');
    await makeSide(cold, { 'session.v4.jsonl.zstd': 'cold-complete' });
    const marker = { op: 'restore', files: await filesOf(cold) }; // 刻意不给 planSha
    assert.equal(marker.planSha, undefined);

    // ① 冷侧完整 + 热侧是半成品 ⇒ 允许删热侧（唯一允许删源的路径之一）
    await makeSide(hot, { 'session.v4.jsonl.zstd': 'hot-partial' });
    const decision = await h.engine.decideRestoreDuplicates({}, marker, cold, hot);
    assert.equal(decision.action, 'delete-hot', JSON.stringify(decision));

    // ② 热侧已完整（逐文件通过 files[]）⇒ 清冷残留续尾段
    await makeSide(hot, { 'session.v4.jsonl.zstd': 'cold-complete' });
    const both = await h.engine.decideRestoreDuplicates({}, marker, cold, hot);
    assert.equal(both.action, 'delete-cold', JSON.stringify(both));

    // ③ 冷侧与 files[] 不一致（内容坏 / 多一个文件）⇒ 绝不删热源
    await makeSide(cold, { 'session.v4.jsonl.zstd': 'cold-corrupted' });
    await makeSide(hot, { 'session.v4.jsonl.zstd': 'hot-partial' });
    const corrupt = await h.engine.decideRestoreDuplicates({}, marker, cold, hot);
    assert.equal(corrupt.action, 'needs-review', JSON.stringify(corrupt));
    assert.match(corrupt.reason, /逐文件校验不通过/);

    // ④ 冷侧多一个基线外文件 ⇒ 也不算通过（名字集合必须完全一致）
    await makeSide(cold, { 'session.v4.jsonl.zstd': 'cold-complete', 'extra.log': 'x' });
    const extra = await h.engine.decideRestoreDuplicates({}, marker, cold, hot);
    assert.equal(extra.action, 'needs-review', JSON.stringify(extra));
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// 评审 #4：/preview 的 id 形状 + containment
// ---------------------------------------------------------------------------
test('评审 #4：/preview id 形状非法 / 目录越界一律 400（合法形状但不存在仍 404）', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-preview-ok', { texts: { user: '预览样本句子' } });
    const api = makeApi(h);
    const ok = await call(api, { url: PREFIX + '/preview', body: JSON.stringify({ id: 'session-preview-ok' }) });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));

    for (const bad of ['../evil', 'a/b', 'a\\b', '..', '.', 'x'.padEnd(2, '.') + '/../y']) {
      const res = await call(api, { url: PREFIX + '/preview', body: JSON.stringify({ id: bad }) });
      assert.equal(res.status, 400, 'id=' + bad + ' 必须 400：' + JSON.stringify(res.json));
      assert.equal(res.json.code, 'invalid-id');
    }

    const missing = await call(api, { url: PREFIX + '/preview', body: JSON.stringify({ id: 'session-does-not-exist' }) });
    assert.equal(missing.status, 404, '形状合法的未知 id 仍是 404（不是 400）');

    // rel_dir 被污染（DB 行）⇒ resolve 后 containment 兜底
    h.store.upsertSession({
      session_id: 'session-preview-dirty',
      project_key: 'pk',
      rel_dir: '../../etc/passwd',
      log_names: 'session.v4.jsonl.zstd',
      format_version: 4,
      status: 'hot',
      source_sha: '',
    });
    const dirty = await call(api, { url: PREFIX + '/preview', body: JSON.stringify({ id: 'session-preview-dirty' }) });
    assert.equal(dirty.status, 400, JSON.stringify(dirty.json));
    assert.equal(dirty.json.code, 'invalid-id');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// §15.1 #5：预览尾部遍历上限 + truncated
// ---------------------------------------------------------------------------
test('§15.1 #5：/preview 尾部优先遍历有帧上限，截断时回 truncated=true 与 traversal 读数', async () => {
  const h = await createHarness();
  try {
    const id = 'session-preview-cap';
    const dir = await h.addSession(id, {
      logs: {
        'session.v4.jsonl.zstd': [
          JSON.stringify({ type: 'request/header', sessionId: id, cwd: h.cwd, createdAt: 1791000000000 }),
          JSON.stringify({ type: 'user/message', seq: 1, ts: 1791000001000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '很早的一条消息' }] } }),
          JSON.stringify({ type: 'user/message', seq: 2, ts: 1791000002000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '中间的一条消息' }] } }),
          JSON.stringify({ type: 'user/message', seq: 3, ts: 1791000003000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '最新的一条消息' }] } }),
        ],
      },
    });
    assert.ok(dir);
    const api = makeApi(h);
    const full = await call(api, { url: PREFIX + '/preview', body: JSON.stringify({ id }) });
    assert.equal(full.status, 200, JSON.stringify(full.json));
    assert.equal(full.json.truncated, false, JSON.stringify(full.json.traversal));
    assert.equal(full.json.traversal.totalFrames, 4);
    assert.equal(full.json.traversal.truncated, false);
    assert.ok(full.json.messages.some((message) => String(message.text).includes('很早的一条消息')));

    const capped = await call(api, { url: PREFIX + '/preview', body: JSON.stringify({ id, maxFrames: 1 }) });
    assert.equal(capped.status, 200, JSON.stringify(capped.json));
    assert.equal(capped.json.traversal.truncated, true, '帧数被上限截断时必须显式标记');
    assert.equal(capped.json.truncated, true);
    assert.equal(capped.json.traversal.frames, 1);
    assert.ok(capped.json.messages.some((message) => String(message.text).includes('最新的一条消息')), '尾部优先：最近的帧必须保留');
    assert.equal(capped.json.messages.some((message) => String(message.text).includes('很早的一条消息')), false);
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// §15.1 #6：索引进度 / 暂停持久化到 meta
// ---------------------------------------------------------------------------
test('§15.1 #6：索引进度与暂停持久化到 meta —— 新实例（模拟重启）读到 done / paused', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-c3-a', { texts: { user: '进度持久化样本甲' } });
    await h.addSession('session-c3-b', { texts: { user: '进度持久化样本乙' } });
    const indexer = h.indexer();
    const done = await indexer.runFullIndex();
    assert.equal(done.phase, 'done');

    const restarted = h.indexer();
    const progress = restarted.progress();
    assert.equal(progress.phase, 'done', '重启后必须读到 done（旧实现恒 idle）: ' + JSON.stringify(progress));
    assert.equal(progress.persisted, true);
    assert.ok(progress.indexed >= 2, JSON.stringify(progress));

    // 暂停同样持久化：新实例不得偷偷续跑
    indexer.pause();
    const paused = h.indexer();
    const started = await paused.ensureStarted();
    assert.equal(started.phase, 'paused', JSON.stringify(started));
    assert.equal(started.paused, true);
    // 解除暂停后仍可续做
    const resumed = await paused.resume();
    assert.equal(resumed.phase, 'done', JSON.stringify(resumed));
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// 评审 #6：writeLog / fsLog 环形缓冲
// ---------------------------------------------------------------------------
test('评审 #6：writeLog/fsLog 是环形缓冲（保留最近 500 条，dropped 记账；logLimit:0 = 全量）', async () => {
  const h = await createHarness();
  try {
    const ring = new VaultEngine({
      home: h.home, paths: h.paths, configStore: h.configStore, store: h.store,
      registry: h.registry, persistence: h.persistence, logger: quiet,
      logLimit: 8,
    });
    for (let i = 0; i < 20; i += 1) ring.assertWritable(path.join(h.paths.vaultRoot, 'w-' + i));
    const log = ring.getWriteLog();
    assert.equal(log.length, 8, '默认只保留最近 limit 条');
    assert.equal(ring.writeLog.dropped, 12, '被挤掉的条数必须记账');
    assert.match(log[7], /w-19$/, '保留的必须是最近写入的');
    assert.equal(ring.perfStats().writeLog.kept, 8);
    assert.equal(ring.perfStats().writeLog.dropped, 12);

    const unbounded = new VaultEngine({
      home: h.home, paths: h.paths, configStore: h.configStore, store: h.store,
      registry: h.registry, persistence: h.persistence, logger: quiet,
      logLimit: 0,
    });
    for (let i = 0; i < 20; i += 1) unbounded.assertWritable(path.join(h.paths.vaultRoot, 'u-' + i));
    assert.equal(unbounded.getWriteLog().length, 20, 'logLimit:0 ⇒ 测试注入拿全量');
    assert.equal(unbounded.fsLog.limit, 0);
    assert.equal(new VaultEngine({ home: h.home, paths: h.paths, configStore: h.configStore, store: h.store, logger: quiet }).writeLog.limit, 500, '默认 500');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// 评审 #8：favorite 进列表序列化
// ---------------------------------------------------------------------------
test('评审 #8：favorite 进 toItem / itemFromScan 序列化（P3 启用前先对齐）', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-favorite', { texts: { user: '收藏样本' } });
    h.archived.add('session-favorite');
    await h.engine.backfillArchivedAt({});
    h.store.updateSession('session-favorite', { favorite: 1 });
    h.engine.invalidate();
    const list = await h.engine.list();
    const item = list.items.find((entry) => entry.id === 'session-favorite');
    assert.equal(item.favorite, 1, 'toItem 必须输出 favorite：' + JSON.stringify(item));

    const scanItem = h.engine.itemFromScan({ id: 'x', projectKey: 'pk', bytes: 1, fileMtimeMs: 1, version: 4, header: null }, 'hot-archived');
    assert.equal(scanItem.favorite, 0, 'itemFromScan 也要有同形字段');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// §15.1 #1：退避首次 5 分钟（口径与实现/测试一致）
// ---------------------------------------------------------------------------
test('§15.1 #1：失败退避首次 = 5 分钟（failures=1 ⇒ 指数 0）', async () => {
  const { sweepBackoffMs, BASE_BACKOFF_MS } = await import('../lib/sweeper.js');
  assert.equal(BASE_BACKOFF_MS, 5 * 60 * 1000);
  assert.equal(sweepBackoffMs(0), 5 * 60 * 1000, '首次失败（指数 0）必须是 5 分钟');
  assert.equal(sweepBackoffMs(1), 10 * 60 * 1000);
  assert.equal(sweepBackoffMs(2), 20 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// M3 接线：启动收敛失败时仍起 Sweeper（宿主入口 lib/index.js）
// ---------------------------------------------------------------------------
test('M3 接线（F1 后）：lib/index.js 在 recoverOnBoot 失败时仍起 Sweeper，并以暂停态 + sweepError 暴露；启动链失败会重试', async () => {
  const source = await readFile(path.join(ROOT, 'lib', 'index.js'), 'utf8');
  assert.match(source, /createBootChain\(/, '启动链必须走可重试的 createBootChain');
  assert.match(source, /attachSweeper: async \(services, bootError\) => startSweeper\(services\.engine, bootError\)/, '两条分支都必须走到 startSweeper（旧实现失败时不启动）');
  assert.match(source, /holdBootError\(bootError\)/, 'Sweeper 必须以暂停态启动');
  assert.match(source, /recoverOnBoot 失败（Sweeper 以暂停态起跑，每拍重试收敛）/, '失败文案必须说明清扫以暂停态起跑');
  assert.match(source, /throw err;/, 'startSweeper 失败必须抛出（旧实现吞掉 ⇒ Sweeper 永不挂上）');
  assert.match(source, /VOID|'VAULT_BOOT_RETRY_MS'|VAULT_BOOT_RETRY_MS/, '重试间隔必须可配（测试/慢机）');
});

test('M1：真实 /search 路由——全量完成后新建会话也可命中（不调 rebuild-index / resume）', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-m1-api-old', { texts: { user: '旧会话的 API 句子' } });
    const indexer = h.indexer();
    h.engine.indexer = indexer; // 让 /status 的 acquireIndexer 复用同一个实例
    await indexer.runFullIndex();
    const api = makeApi(h);
    const first = await call(api, { url: PREFIX + '/search', body: JSON.stringify({ q: '旧会话的 API 句子' }) });
    assert.equal(first.status, 200, JSON.stringify(first.json).slice(0, 200));
    assert.equal(first.json.groups.length, 1);

    await h.addSession('session-m1-api-new', { texts: { user: '新会话的 API 独有句子' } });
    const fresh = await call(api, { url: PREFIX + '/search', body: JSON.stringify({ q: '新会话的 API 独有句子' }) });
    assert.equal(fresh.json.groups.length, 0, 'TTL 内不重扫（有界成本）');

    h.clock.now += TARGETS_TTL_MS;
    const after = await call(api, { url: PREFIX + '/search', body: JSON.stringify({ q: '新会话的 API 独有句子' }) });
    assert.equal(after.status, 200, JSON.stringify(after.json).slice(0, 300));
    assert.equal(after.json.groups.length, 1, JSON.stringify(after.json).slice(0, 300));
    assert.equal(after.json.groups[0].sessionId, 'session-m1-api-new');
  } finally {
    await h.dispose();
  }
});
