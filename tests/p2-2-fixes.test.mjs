import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { resolveVaultPaths, createConfigStore } from '../lib/config.js';
import { VaultStore } from '../lib/store.js';
import { VaultEngine, projectKey, mapLimit, describeOverlayFunction, installArchiveTracker } from '../lib/engine.js';
import { VaultIndexer } from '../lib/indexer.js';
import { Sweeper } from '../lib/sweeper.js';
import { createVaultApi, PREFIX } from '../lib/http.js';
import { createBootChain } from '../lib/index.js';

/**
 * P2.2 修复轮的锚测试（2026-10-24 真机验收的 5 个运行时缺陷）。
 *
 *  F1 Sweeper 挂载健壮性（启动链重试 + /status.sweep 永不 null）
 *  F2 启动回填 + 列表自愈（存量行补齐 archived_at / backfilled=1）
 *  F3 归档包装漂移自愈（引用比对 + 链式重装，不覆盖第三方）
 *  F4 列表冷启动 <2s（header/title 读取限流 8 + projcache 命中优先 + 必要字段并行）
 *  F5 索引读数（coverage = docs 侧 distinct 会话；indexedThisRun = 本轮计数）
 *
 * 全部落在 os.tmpdir() 的临时 home 里，不触碰真实 ~/.dsh。
 */
const quiet = { info() {}, warn() {}, error() {} };
const RELAX = process.env.VAULT_PERF_RELAX === '1';
const T0 = 1800000000000;

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
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p22-'));
  const paths = resolveVaultPaths(home);
  const cwd = '<workspace-root>\\demo';
  const pk = projectKey(cwd);
  const archived = new Set();
  const clock = { now: options.now === undefined ? T0 : options.now };
  const registry = options.registry || {
    archivedSessionIds: archived,
    async archiveSession(id) { archived.add(String(id)); },
    async unarchiveSession(id) { archived.delete(String(id)); },
    async resolveByPath() { return undefined; },
  };
  const configStore = createConfigStore({ home, paths });
  await configStore.save({ autoMigrate: false, archiveAgeDays: 14, ...(options.config || {}) });
  const store = await VaultStore.open(paths.dbPath);
  const engine = new VaultEngine({
    home,
    paths,
    configStore,
    store,
    registry,
    persistence: { async list() { return []; }, async stat() { return undefined; } },
    logger: quiet,
    now: () => clock.now,
    sameVolume: async () => true,
    detectAm: async () => ({ present: false, matches: [], sources: ['injected'] }),
    resolveWorkspace: async () => undefined,
    isActive: async () => false,
    ...(options.engine || {}),
  });

  async function addSession(id, opts = {}) {
    const dir = path.join(paths.sessionsRoot, opts.projectKey || pk, id);
    await mkdir(dir, { recursive: true });
    const logs = opts.logs || { 'session.v4.jsonl.zstd': frames(id, opts.cwd || cwd, opts.texts || {}) };
    for (const [name, logLines] of Object.entries(logs)) {
      await writeFile(path.join(dir, name), Buffer.concat(logLines.map((line) => zstdCompressSync(Buffer.from(line + '\n')))));
    }
    return dir;
  }

  /** 直接落一行（模拟索引器 ensureRow：archived_at / backfilled 都是 0/NULL 的「已存在行」）。 */
  function putRow(id, patch = {}) {
    return store.upsertSession({
      session_id: id,
      project_key: pk,
      rel_dir: pk + '/' + id,
      log_names: 'session.v4.jsonl.zstd',
      cold_root: null,
      format_version: 4,
      bytes: 100,
      file_size: 100,
      file_mtime_ms: clock.now,
      header_cwd: cwd,
      header_state: 'ok',
      created_at: clock.now,
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
      ...patch,
    });
  }

  function indexer(overrides = {}) {
    return new VaultIndexer({ engine, store, paths, logger: quiet, now: () => clock.now, ...overrides });
  }

  function sweeper(overrides = {}) {
    return new Sweeper({ engine, logger: quiet, now: () => clock.now, ...overrides });
  }

  return {
    home, paths, pk, cwd, archived, clock, registry, configStore, store, engine,
    addSession, putRow, indexer, sweeper,
    projcacheDir: path.join(paths.storagesRoot, 'session_projcache', 'sessions'),
    async dispose() {
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { res.statusCode = status; for (const [k, v] of Object.entries(headers || {})) res.headers[String(k).toLowerCase()] = v; },
    setHeader(key, value) { res.headers[String(key).toLowerCase()] = value; },
    end(chunk) { res.body = chunk ? Buffer.from(chunk).toString('utf8') : ''; },
  };
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

// ===========================================================================
// F1：Sweeper 挂载健壮性
// ===========================================================================
test('F1：启动链首次 ensureServices 失败、二次成功 ⇒ Sweeper 照样挂上（attempts=2）', async () => {
  let engineCalls = 0;
  let sweeperCalls = 0;
  let recoverCalls = 0;
  const chain = createBootChain({
    ensureServices: async () => {
      engineCalls += 1;
      if (engineCalls === 1) throw new Error('vault.db is locked（启动窗口内的瞬时失败）');
      return { engine: {} };
    },
    recoverOnBoot: async () => { recoverCalls += 1; },
    attachSweeper: async (services, bootError) => { sweeperCalls += 1; assert.equal(bootError, null); },
    scheduler: {
      after(fn, ms) {
        const timer = setTimeout(fn, ms);
        if (timer && typeof timer.unref === 'function') timer.unref();
        return () => clearTimeout(timer);
      },
    },
    maxAttempts: 3,
    delayMs: 5,
    log: quiet,
  });
  try {
    chain.start();
    const state = await chain.waitForSettle(3000);
    assert.equal(state.attached, true, '二次成功必须挂上：' + JSON.stringify(state));
    assert.equal(state.attempts, 2, '必须恰好重试一次');
    assert.equal(engineCalls, 2);
    assert.equal(recoverCalls, 1, '只有成功那次才跑 recoverOnBoot');
    assert.equal(sweeperCalls, 1);
    assert.equal(state.lastError, null, '成功必须清掉 lastError（不把旧错误挂在状态里）');
  } finally {
    chain.stop();
  }
});

test('F1：启动链一直失败 ⇒ 达到上限后 gaveUp，状态里保留最后错误与 stage（不静默）', async () => {
  const chain = createBootChain({
    ensureServices: async () => { throw new Error('db boom'); },
    attachSweeper: async () => {},
    scheduler: { after(fn, ms) { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return () => clearTimeout(t); } },
    maxAttempts: 3,
    delayMs: 2,
    log: quiet,
  });
  try {
    chain.start();
    const state = await chain.waitForSettle(3000);
    assert.equal(state.attached, false);
    assert.equal(state.gaveUp, true);
    assert.equal(state.attempts, 3);
    assert.match(state.lastError, /db boom/);
    assert.equal(state.stage, 'engine', '必须记录失败发生在哪一段');
  } finally {
    chain.stop();
  }
});

test('F1：/status.sweep 永不 null —— 没挂上时给 attached:false + error/attempts/nextRetryAt', async () => {
  const h = await createHarness();
  try {
    // 模拟真机：引擎在、Sweeper 从未挂上（启动链失败过两次，正在重试）
    h.engine.sweepAttach = {
      attached: false,
      attempts: 2,
      lastError: 'vault.db is locked',
      nextRetryAt: T0 + 30000,
      gaveUp: false,
      stage: 'engine',
    };
    const api = makeApi(h);
    const status = await call(api, { url: PREFIX + '/status' });
    assert.equal(status.status, 200);
    assert.ok(status.json.sweep, 'sweep 不能是 null（真机 7 小时 null 的教训）');
    assert.equal(status.json.sweep.attached, false);
    assert.match(status.json.sweep.error, /locked/);
    assert.equal(status.json.sweep.sweepError.code, 'sweeper-not-attached');
    assert.equal(status.json.sweep.attempts, 2);
    assert.equal(status.json.sweep.nextRetryAt, T0 + 30000);
    assert.equal(status.json.stats.sweepAttached, false);

    // 挂上之后：attached:true（形状不变，UI 只判这一个字段）
    const sweeper = h.sweeper();
    sweeper.start();
    h.engine.sweeper = sweeper;
    try {
      const after = await call(api, { url: PREFIX + '/status' });
      assert.equal(after.json.sweep.attached, true);
      assert.equal(after.json.sweep.phase, 'scheduled');
      assert.equal(after.json.stats.sweepAttached, true);
      assert.equal(after.json.sweep.error, undefined, '挂上之后不该再有未挂载错误');
    } finally {
      sweeper.stop();
      h.engine.sweeper = null;
    }
  } finally {
    await h.dispose();
  }
});

// ===========================================================================
// F2：启动回填 + 列表自愈
// ===========================================================================
test('F2：存量行 archived_at=NULL ⇒ recoverOnBoot 后 118/118 非空且 backfilled=1', async () => {
  const h = await createHarness();
  try {
    const ids = [];
    for (let i = 0; i < 118; i += 1) {
      const id = 'session-f2a-' + String(i).padStart(3, '0');
      ids.push(id);
      await h.addSession(id, { texts: { user: '存量回填样本 ' + i } });
      h.putRow(id); // 已有行：archived_at=null / backfilled=0（真机 2275 行的形状）
      h.archived.add(id);
    }
    assert.equal(h.store.getSession(ids[0]).archived_at, null, '前提：存量行 archivedAt 为空');

    const report = await h.engine.recoverOnBoot();
    const missing = ids.filter((id) => h.store.getSession(id).archived_at === null);
    assert.deepEqual(missing, [], '118/118 必须非空（已有行也要补，不只新建行）');
    const notFlagged = ids.filter((id) => h.store.getSession(id).backfilled !== 1);
    assert.deepEqual(notFlagged, [], '118/118 backfilled 必须是 1');
    assert.ok(report.counts.backfilledArchived >= 118, JSON.stringify(report.counts));
  } finally {
    await h.dispose();
  }
});

test('F2：启动回填跑在归档集合还没加载完（空集）之后 —— 列表读口自愈（真机 118/118 archivedAt=NULL 的真实成因）', async () => {
  const h = await createHarness();
  try {
    const ids = [];
    for (let i = 0; i < 118; i += 1) {
      const id = 'session-f2b-' + String(i).padStart(3, '0');
      ids.push(id);
      await h.addSession(id, { texts: { user: '列表自愈样本 ' + i } });
      h.putRow(id);
    }
    // ① registry 的归档集合此刻还是空的（宿主 workspace.json 尚未加载）⇒ 回填无事可做
    const early = await h.engine.backfillArchivedAt({});
    assert.equal(early, 0, '归档集合为空时回填必须是 no-op（正是真机那一次的形态）');
    assert.equal(h.store.getSession(ids[0]).archived_at, null);

    // ② 归档集合加载完（118 个 id 出现），但没有第二次启动 ⇒ 走列表自愈
    for (const id of ids) h.archived.add(id);
    const list = await h.engine.list();
    const rows = list.items.filter((item) => item.status === 'hot-archived');
    assert.equal(rows.length, 118, JSON.stringify(list.stats));
    const nullItems = rows.filter((item) => item.archivedAt === null || item.archivedAt === undefined);
    assert.deepEqual(nullItems.map((item) => item.id), [], '/list 的 118 行 archivedAt 必须全部非空');
    const nullRows = ids.filter((id) => h.store.getSession(id).archived_at === null);
    assert.deepEqual(nullRows, [], '列表自愈必须写回 DB（不是只改返回值）');
    assert.ok(h.engine.perfStats().archivedAtHeals >= 118, '自愈行数必须可观测');
  } finally {
    await h.dispose();
  }
});

// ===========================================================================
// F3：包装漂移自愈
// ===========================================================================
test('F3：第三方替换 registry.archiveSession ⇒ 下一次 reconcile 链式自动重装（不覆盖第三方）', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-f3');
    const disposer = installArchiveTracker({
      registry: h.registry,
      engine: h.engine,
      getConfig: () => ({ hydrateOnUnarchive: true }),
      log: quiet,
    });
    try {
      assert.equal(h.engine.verifyOverlay().drifted, false, '前提：刚装上是健康的');

      // 模拟第三方插件在我们之后包一层（真机 overlay.drifted=true 的形态）
      const ours = h.registry.archiveSession;
      let thirdCalls = 0;
      h.registry.archiveSession = async function thirdPartyArchive(id) {
        thirdCalls += 1;
        return ours.call(this, id);
      };
      const who = describeOverlayFunction(h.registry.archiveSession);
      assert.equal(who.name, 'thirdPartyArchive');

      const repaired = h.engine.verifyOverlay();
      assert.equal(repaired.drifted, false, 'F3：必须自动重装（drifted 归零）');
      assert.equal(repaired.archiveOk, true);
      assert.equal(repaired.unarchiveOk, true, '没漂移的一侧不该被叠层');
      assert.equal(h.engine.overlayRepair.reinstalls, 1);
      assert.equal(h.engine.overlayRepair.replacedBy.archive.name, 'thirdPartyArchive', '必须记录谁覆盖了我们');

      // 关键：第三方包装**仍然被调用**（链式重装，不是覆盖）
      await h.registry.archiveSession('session-f3');
      assert.equal(thirdCalls, 1, '第三方包装不能被吞掉（否则是覆盖而不是链式重装）');
      assert.equal(h.archived.has('session-f3'), true, '第三方行为照常生效');
      assert.ok(h.store.getSession('session-f3').archived_at > 0, 'archivedAt 追踪必须恢复');

      // status/list 都要给出「谁覆盖过我们 + 已重装几次」
      const status = await h.engine.status();
      assert.equal(status.banners.overlay.drifted, false);
      assert.equal(status.banners.overlay.replacedBy.archive.name, 'thirdPartyArchive');
      assert.ok(status.banners.overlay.reinstalls >= 1);
      assert.equal(status.banners.overlay.autoRepair, true);
      const list = await h.engine.list();
      assert.equal(list.banners.overlay.drifted, false);
      assert.equal(list.banners.overlay.replacedBy.archive.name, 'thirdPartyArchive');
    } finally {
      disposer();
    }
  } finally {
    await h.dispose();
  }
});

test('F3：重装限流 —— 30s 内不重复重装（防两个插件互相抢包装），到期后再次自愈', async () => {
  const h = await createHarness();
  try {
    const disposer = installArchiveTracker({
      registry: h.registry, engine: h.engine, getConfig: () => ({}), log: quiet,
    });
    try {
      const ours = h.registry.archiveSession;
      h.registry.archiveSession = async function thirdPartyArchive() {};
      assert.equal(h.engine.verifyOverlay().drifted, false);
      const first = h.engine.overlayRepair.reinstalls;
      // 立刻再次被覆盖：限流窗口内不重装（drifted 如实暴露，UI 有提示）
      h.registry.archiveSession = async function anotherThirdParty() {};
      const throttled = h.engine.verifyOverlay();
      assert.equal(throttled.drifted, true, '限流窗口内必须如实报漂移（不假装已修）');
      assert.equal(h.engine.overlayRepair.reinstalls, first, '30s 内不得重复重装');
      // 窗口到期：再次 reconcile 必须自愈
      h.clock.now += 31000;
      const repaired = h.engine.verifyOverlay();
      assert.equal(repaired.drifted, false);
      assert.equal(h.engine.overlayRepair.replacedBy.archive.name, 'anotherThirdParty');
      assert.equal(h.registry.archiveSession === ours, false);
    } finally {
      disposer();
    }
  } finally {
    await h.dispose();
  }
});

// ===========================================================================
// F4：列表冷启动 <2s（并发 + 缓存 + 并行）
// ===========================================================================
test('F4：mapLimit 有界并发（限流 8，结果顺序与输入一致）', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 40 }, (_, i) => i);
  const out = await mapLimit(items, 8, async (value) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    return value * 2;
  });
  assert.deepEqual(out, items.map((value) => value * 2));
  assert.ok(peak <= 8, '并发不得超过 8：' + peak);
  assert.ok(peak > 1, '必须是并发（旧实现逐条串行，peak 恒 1）：' + peak);
});

test('F4：header 读取按限流并发（不串行），118 行冷启动 <2s（VAULT_PERF_RELAX=1 放宽）', async () => {
  let inFlight = 0;
  let peak = 0;
  let headers = 0;
  const h = await createHarness({
    engine: {
      readSessionHeader: async () => {
        headers += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return null;
      },
      indexer: { ensureStarted: async () => ({}), progress: () => ({ phase: 'done', paused: false, indexed: 0, indexedThisRun: 0, coverage: 0, total: 0, skipped: 0, failed: 0, errors: [] }) },
    },
  });
  try {
    for (let i = 0; i < 118; i += 1) {
      const id = 'session-f4-' + String(i).padStart(3, '0');
      await h.addSession(id, { texts: { user: 'HTTP 计时样本 ' + i } });
      h.archived.add(id);
    }
    const indexerStub = {
      ensureStarted: async () => ({ phase: 'done' }),
      progress: () => ({ phase: 'done', paused: false, indexed: 0, indexedThisRun: 0, coverage: 0, total: 0, skipped: 0, failed: 0, errors: [] }),
      pause() { return this.progress(); },
      resume: async () => ({ phase: 'done' }),
      rescan: async () => ({ phase: 'done' }),
      search: async () => ({ groups: [], tokens: [] }),
    };
    const api = makeApi(h, { getIndexer: async () => indexerStub });
    const coldStart = Date.now();
    const cold = await call(api, { url: PREFIX + '/list', body: '{}' });
    const coldMs = Date.now() - coldStart;
    const hitStart = Date.now();
    const hit = await call(api, { url: PREFIX + '/list', body: '{}' });
    const hitMs = Date.now() - hitStart;
    assert.equal(cold.status, 200, JSON.stringify(cold.json).slice(0, 300));
    assert.equal(cold.json.items.length, 118);
    assert.equal(headers, 118, '每个归档会话的 header 必须被读到（少读=少了事实）');
    assert.ok(peak <= 8, 'header 读取并发不得超过 8：' + peak);
    assert.ok(peak > 1, 'header 读取必须并发：' + peak);
    const coldLimit = RELAX ? 10000 : 2000;
    const hitLimit = RELAX ? 5000 : 500;
    if (RELAX) console.log('[perf] VAULT_PERF_RELAX=1：/list 阈值放宽为 cold<' + coldLimit + 'ms / hit<' + hitLimit + 'ms');
    console.log('[perf] /list 118 行（P2.2）：冷启动 ' + coldMs + 'ms，命中 ' + hitMs + 'ms');
    assert.ok(coldMs < coldLimit, '/list 冷启动必须 <' + coldLimit + 'ms，实测 ' + coldMs + 'ms');
    assert.ok(hitMs < hitLimit, '/list 命中必须 <' + hitLimit + 'ms，实测 ' + hitMs + 'ms');
    assert.equal(hit.json.items.length, 118);
  } finally {
    await h.dispose();
  }
});

test('F4：projcache 标题 hint 命中优先（第二次不再开文件；目录消失仍从缓存命中）', async () => {
  const h = await createHarness();
  try {
    await mkdir(h.projcacheDir, { recursive: true });
    for (const id of ['session-hint-a', 'session-hint-b']) {
      await writeFile(
        path.join(h.projcacheDir, id + '.json'),
        JSON.stringify({ rows: { title: { val: '真实标题 ' + id } } }),
      );
    }
    const first = await h.engine.titleHints(['session-hint-a', 'session-hint-b', 'session-hint-missing']);
    assert.equal(first.get('session-hint-a'), '真实标题 session-hint-a');
    assert.equal(first.size, 2);

    // 文件消失：命中缓存 ⇒ 仍然拿到标题（证明「命中优先」不是每次重开文件）
    await rm(h.projcacheDir, { recursive: true, force: true });
    const second = await h.engine.titleHints(['session-hint-a', 'session-hint-b']);
    assert.equal(second.get('session-hint-b'), '真实标题 session-hint-b', '缓存命中必须直接返回，不再 open');

    // TTL 到期：如实返回空（不缓存永久假象）
    h.clock.now += h.engine._titleHintTtlMs + 1;
    const third = await h.engine.titleHints(['session-hint-a']);
    assert.equal(third.size, 0, 'TTL 到期后必须重新读文件（并如实为空）');
  } finally {
    await h.dispose();
  }
});

// ===========================================================================
// F5：索引读数
// ===========================================================================
test('F5：/status.index 给 coverage（docs 侧 distinct 会话）与 indexedThisRun（本轮计数）', async () => {
  const h = await createHarness();
  try {
    const indexer = h.indexer();
    h.engine.indexer = indexer;
    for (const id of ['session-f5-a', 'session-f5-b', 'session-f5-c']) {
      await h.addSession(id, { texts: { user: '索引读数样本 ' + id } });
    }
    // 只索引两个：coverage=2、indexedThisRun=2；第三个不索引
    const targets = await indexer.scanTargets({ force: true });
    await indexer.indexTarget(targets.get('session-f5-a'), { force: true });
    await indexer.indexTarget(targets.get('session-f5-b'), { force: true });

    const api = makeApi(h, { getIndexer: async () => indexer });
    const status = await call(api, { url: PREFIX + '/status' });
    assert.equal(status.status, 200);
    assert.equal(status.json.index.coverage, 2, 'coverage 必须是「有 docs 的会话数」：' + JSON.stringify(status.json.index));
    assert.equal(status.json.index.indexedThisRun, 2, 'indexedThisRun 是本轮成功数');
    // indexed 是「上一轮/本轮全量任务」的计数（语义未变，只是不再是覆盖面的唯一读数）
    assert.equal(typeof status.json.index.indexed, 'number');
    assert.equal(status.json.stats.indexCoverage, 2);
    assert.equal(status.json.stats.indexedThisRun, 2);

    const list = await call(api, { url: PREFIX + '/list', body: '{}' });
    assert.equal(list.json.stats.indexCoverage, 2, '/list 顶部统计也要给 coverage（UI 的「已索引 N/M」用它）');

    // 「indexed_at 有值」与「真有 docs」是两个口径：extract-empty 会话会让二者分叉
    h.putRow('session-f5-c', { indexed_at: h.clock.now, error: 'extract-empty' });
    const stats = h.store.indexStats();
    assert.equal(stats.indexed, 3, 'indexed_at 口径：3 行有 indexed_at');
    assert.equal(stats.coverage, 2, 'coverage 口径：只有 2 个会话真有 docs');
  } finally {
    await h.dispose();
  }
});

test('F5：跨重启读持久化进度时 indexedThisRun=0（不把上一轮的计数冒充本轮），coverage 仍取真实库', async () => {
  const h = await createHarness();
  try {
    const first = h.indexer();
    h.engine.indexer = first;
    await h.addSession('session-f5-p', { texts: { user: '持久化读数样本' } });
    const targets = await first.scanTargets({ force: true });
    await first.indexTarget(targets.get('session-f5-p'), { force: true });
    assert.equal(first.progress().coverage, 1);

    // 新进程：同一个库、新索引器实例（没有任何一轮在本进程跑过）。
    // 上一进程的读数在 meta index:progress（§15.1 #6 的持久化进度）。
    h.store.setMeta('index:progress', JSON.stringify({
      phase: 'done', paused: false, indexed: 1, total: 1, skipped: 0, failed: 0, errors: [],
      startedAt: h.clock.now, updatedAt: h.clock.now, scannedAt: h.clock.now,
    }));
    const second = h.indexer();
    h.engine.indexer = second;
    const progress = second.progress();
    assert.equal(progress.indexedThisRun, 0, '跨重启的读数不是「本轮」');
    assert.equal(progress.coverage, 1, 'coverage 永远读库，不是读上一轮的任务计数');
    assert.equal(progress.persisted, true);

    const status = await h.engine.status();
    assert.equal(status.index.coverage, 1);
    assert.equal(status.index.indexedThisRun, 0);
  } finally {
    await h.dispose();
  }
});

test('F5：索引器还没实例化时（engine.indexSnapshot 兜底）也给出 coverage/indexedThisRun，不是 undefined', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-f5-x', { texts: { user: '兜底读数样本' } });
    // 直接写 docs（模拟别的路径落库），不走索引器
    h.store.replaceDocs('session-f5-x', [{ seq: 1, type: 'user', role: 'user', time: h.clock.now, text: '兜底读数样本' }]);
    const snapshot = h.engine.indexSnapshot();
    assert.equal(snapshot.coverage, 1, JSON.stringify(snapshot));
    assert.equal(snapshot.indexedThisRun, 0);
    assert.equal(typeof snapshot.phase, 'string');
  } finally {
    await h.dispose();
  }
});
