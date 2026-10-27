import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { resolveVaultPaths, createConfigStore } from '../lib/config.js';
import { VaultStore } from '../lib/store.js';
import { VaultEngine, checkArchiveTracker, VAULT_OVERLAY, unattachedSweepPayload } from '../lib/engine.js';
import { createVaultApi, PREFIX, unattachedSweepPayload as httpUnattachedSweepPayload } from '../lib/http.js';
import { Manifest } from '../lib/manifest.js';
import * as hostModule from '../lib/index.js';
import { isProgrammingError, overlayErrorOutcome, overlayNotLoadedOutcome } from '../lib/index.js';

/**
 * P2.4 修复轮的锚测试（代码评审 🔴：宿主侧作用域 bug）。
 *
 * 真机根因：`installArchiveTrackerDetailed` 只在 ensureServices 的异步 IIFE 里解构，块级作用域
 * 对 `installOverlay` 不可见 ⇒ registry 一就绪就抛 ReferenceError ⇒ 被 catch 吞成
 * shape:"threw" + overlayUnsupported=true ⇒ 归档追踪 / 透明水合 / 漂移自愈全部失效。
 * 既有测试全绿的盲区：apply 用例的 ctx 都不提供 workspaceRegistry，走不到那一行。
 *
 * 本文件补上**apply 级**集成（F3）：真 ctx（含 get("workspaceRegistry") + 假 webServer）、
 * 真 engine、真 store、临时 DSH_HOME，断言包装真的装上 / archivedAt 真的落库 / dispose 真的还原。
 * 另有 F1（模块未加载 = 可重试，不是宿主不支持）与 F2（编程错误 ≠ 形状不支持）的锚。
 *
 * 全部落在 os.tmpdir() 的临时 home 里，不安装、不重启、不碰真实 ~/.dsh。
 */
const quiet = { info() {}, warn() {}, error() {} };
const T0 = 1800000000000;

function makeRegistry(archived = new Set()) {
  return {
    archivedSessionIds: archived,
    async archiveSession(id) { archived.add(String(id)); },
    async unarchiveSession(id) { archived.delete(String(id)); },
    async resolveByPath() { return undefined; },
  };
}

/**
 * 复刻宿主装配：ctx.get(webServer|workspaceRegistry) + ctx.effect + ctx.setTimeout。
 * 定时器**注册成功但永不触发** —— 启动链由测试显式通过 /diag 读口拉起（零等待、确定性）。
 */
function makeCtx({ registry = null } = {}) {
  const routes = [];
  const webServer = { register(route) { routes.push(route); return () => {}; } };
  const ctx = {
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    get(service) {
      if (service === 'webServer') return webServer;
      if (service === 'workspaceRegistry') return registry || undefined;
      return undefined;
    },
    setTimeout() { return () => {}; },
    logger: quiet,
  };
  return { ctx, routes };
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
function fakeReq({ url = PREFIX + '/diag', body = '{}', method = 'POST', remoteAddress = '127.0.0.1' } = {}) {
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:53210' };
  req.socket = { remoteAddress };
  return req;
}
async function call(handler, options) {
  const res = fakeRes();
  await handler(fakeReq(options), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* keep null */ }
  return { status: res.statusCode, json };
}

/** 引擎级宿主（F1/F2 读面用；与 p2-3 的 harness 同构）。 */
async function createEngineHarness() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p24-engine-'));
  const paths = resolveVaultPaths(home);
  const configStore = createConfigStore({ home, paths });
  await configStore.save({ autoMigrate: false, archiveAgeDays: 14 });
  const store = await VaultStore.open(paths.dbPath);
  const clock = { now: T0 };
  const engine = new VaultEngine({
    home,
    paths,
    configStore,
    store,
    registry: makeRegistry(),
    persistence: { async list() { return []; }, async stat() { return undefined; } },
    logger: quiet,
    now: () => clock.now,
    sameVolume: async () => true,
    detectAm: async () => ({ present: false, matches: [], sources: ['injected'] }),
    resolveWorkspace: async () => undefined,
    isActive: async () => false,
  });
  return {
    home, paths, store, clock, engine, configStore,
    async dispose() {
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

// ===========================================================================
// F3：apply 级集成（旧代码上的红点）
// ===========================================================================
test('F3（P2.4）：apply 级集成 —— workspaceRegistry 就绪时归档包装真的装上、archivedAt 落库、dispose 还原', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p24-apply-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const paths = resolveVaultPaths(home);
  const archived = new Set();
  const registry = makeRegistry(archived);
  const originalArchive = registry.archiveSession;
  const originalUnarchive = registry.unarchiveSession;
  // 预置一行 hot 会话：包装只写 archived_at（不搬文件），noteArchived 需要已有行才能落时间戳。
  const seed = await VaultStore.open(paths.dbPath);
  seed.upsertSession({
    session_id: 'session-f3',
    project_key: '--ws--',
    rel_dir: '--ws--/session-f3',
    log_names: 'session.v4.jsonl.zstd',
    format_version: 4,
    status: 'hot',
    header_cwd: 'C:\\ws',
    created_at: 1790000000000,
    file_size: 64,
    file_mtime_ms: 1790000000000,
  });
  seed.close();
  let dispose = null;
  let disposed = false;
  let reader = null;
  try {
    const { ctx, routes } = makeCtx({ registry });
    dispose = hostModule.apply(ctx, {});
    assert.equal(typeof dispose, 'function');
    assert.equal(routes.length, 1, 'apply 必须注册 /session-vault/api 路由');

    const diag = await call(routes[0].handler, { url: PREFIX + '/diag', body: '{}' });
    assert.equal(diag.status, 200, '诊断口必须可用：' + JSON.stringify(diag.json).slice(0, 500));
    // ① 引擎读数：install.ok === true（/diag 的 install 就是引擎上那份 engine.overlayInstall）
    assert.equal(diag.json.diag.install.ok, true, '归档包装必须真的装上（旧代码在这里是 shape:"threw"）：' + JSON.stringify(diag.json.diag.install));
    assert.equal(diag.json.diag.install.installed, true);
    assert.equal(diag.json.diag.install.supported, true);
    assert.equal(diag.json.diag.install.shape, 'own');
    assert.equal(diag.json.diag.check.installed, true);
    assert.equal(diag.json.diag.check.drifted, false, '装完自检不得漂移：' + JSON.stringify(diag.json.diag.check));
    assert.equal(diag.json.diag.check.supported, true);
    assert.equal(diag.json.diag.shape, 'own');
    assert.equal(diag.json.diag.supported, true);
    // 宿主 registry 上确实是我们的包装（不是「报告已装、实际没装」）
    assert.equal(registry[VAULT_OVERLAY], true);
    assert.notEqual(registry.archiveSession, originalArchive, 'registry.archiveSession 必须被包装');
    assert.equal(registry.archiveSession.name, 'wrappedArchive');
    assert.notEqual(registry.unarchiveSession, originalUnarchive, 'registry.unarchiveSession 必须被透明水合包装');

    // ② 包装真的工作：prior 照常调用 + archivedAt 落库
    await registry.archiveSession('session-f3');
    assert.equal(archived.has('session-f3'), true, '包装必须照常调用 prior（不吞归档结果）');

    dispose();
    disposed = true;

    // ③ A-9：dispose 后引用逐字还原
    assert.equal(registry.archiveSession, originalArchive, 'A-9：dispose 必须还原 registry.archiveSession');
    assert.equal(registry.unarchiveSession, originalUnarchive, 'A-9：dispose 必须还原 registry.unarchiveSession');
    assert.equal(checkArchiveTracker(registry).installed, false, 'dispose 后包装登记必须清掉');
    assert.equal(registry[VAULT_OVERLAY], undefined);

    // ④ archivedAt 真的写进了 DB（读只读库，不写任何东西）
    await new Promise((resolve) => setTimeout(resolve, 30));
    reader = new VaultStore(paths.dbPath, { readonly: true });
    const row = reader.getSession('session-f3');
    reader.close();
    reader = null;
    assert.ok(row, '会话行必须还在');
    assert.equal(typeof row.archived_at, 'number', '包装调用后 archivedAt 必须落库：' + JSON.stringify(row.archived_at));
    assert.ok(row.archived_at > 0);
  } finally {
    // 断言失败时也要关掉引擎连接，否则 Windows 上 -shm 仍被占用、清理会 EBUSY 掩盖真正的断言信息。
    if (reader) { try { reader.close(); } catch { /* ignore */ } }
    if (!disposed && dispose) { try { dispose(); } catch { /* ignore */ } }
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test('F3（P2.4）：不提供 workspaceRegistry 的 ctx 仍能正常 apply（回归其它 apply 用例）', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p24-noreg-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let dispose = null;
  try {
    const { ctx, routes } = makeCtx({ registry: null });
    assert.doesNotThrow(() => { dispose = hostModule.apply(ctx, {}); });
    assert.equal(typeof dispose, 'function');
    assert.equal(routes.length, 1);
    const diag = await call(routes[0].handler, { url: PREFIX + '/diag', body: '{}' });
    assert.equal(diag.status, 200, JSON.stringify(diag.json).slice(0, 400));
    assert.equal(diag.json.diag.shape, 'no-registry');
    assert.equal(diag.json.diag.install.reason, 'no-registry');
    assert.equal(diag.json.diag.install.supported, true, '服务未就绪 ≠ 宿主不支持');
    assert.equal(diag.json.diag.check.installed, false);
  } finally {
    if (dispose) { try { dispose(); } catch { /* ignore */ } }
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

// ===========================================================================
// F1：engine.js 未加载 = 可重试（不是宿主不支持）
// ===========================================================================
test('F1（P2.4）：engine.js 未加载的读数 supported:true + retryable:true ⇒ 引擎不停手、后续读口继续重试', async () => {
  const h = await createEngineHarness();
  try {
    const outcome = overlayNotLoadedOutcome();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.installed, false);
    assert.equal(outcome.supported, true, '「模块还没加载」不是「宿主形状不支持」');
    assert.equal(outcome.retryable, true);
    assert.equal(outcome.shape, 'engine-module-not-loaded');
    assert.equal(outcome.reason, 'engine-module-not-loaded');

    let calls = 0;
    h.engine.overlayInstaller = () => { calls += 1; return overlayNotLoadedOutcome(); };
    const first = h.engine.verifyOverlay({ force: true });
    assert.equal(calls, 1);
    assert.equal(first.installed, false);
    assert.equal(first.supported, true);
    assert.equal(h.engine.overlayUnsupported, false, '不得置「停手」标记');
    assert.equal(h.engine.overlayRepair, null, '不得落 repairFailed');

    // 后续读口（30s 退避之后）必须继续尝试补装
    h.clock.now += 6 * 60 * 1000;
    h.engine.verifyOverlay();
    assert.equal(calls, 2, 'retryable 的未加载读数必须允许后续读口再试');

    const banner = h.engine.overlayBanner();
    assert.equal(banner.supported, true);
    assert.equal(banner.autoRepair, true);
    assert.equal(banner.repairFailed, false);
    assert.equal(banner.install.shape, 'engine-module-not-loaded');
    assert.equal(banner.install.retryable, true);
  } finally {
    await h.dispose();
  }
});

// ===========================================================================
// F2：编程错误与宿主不支持分离
// ===========================================================================
test('F2（P2.4）：编程错误 ≠ 宿主形状不支持 —— 分类、完整堆栈、retryable', () => {
  assert.equal(isProgrammingError(new ReferenceError('installArchiveTrackerDetailed is not defined')), true);
  assert.equal(isProgrammingError(new TypeError('registry.archiveSession is not a function')), true);
  assert.equal(isProgrammingError(new SyntaxError('unexpected token')), true);
  assert.equal(isProgrammingError(new RangeError('out of range')), true);
  assert.equal(isProgrammingError(new Error('宿主说不行')), false, '普通 Error 不自动算编程错误');
  assert.equal(isProgrammingError('thrown string'), false);
  assert.equal(isProgrammingError(null), false);

  const err = new ReferenceError('installArchiveTrackerDetailed is not defined');
  const outcome = overlayErrorOutcome(err, 2);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.installed, false);
  assert.equal(outcome.supported, true, '抛错不能报成「宿主不支持」');
  assert.equal(outcome.retryable, true);
  assert.equal(outcome.shape, 'threw');
  assert.equal(outcome.reason, 'threw');
  assert.equal(outcome.errorName, 'ReferenceError');
  assert.equal(outcome.programmingError, true);
  assert.equal(outcome.throws, 3, 'throws 是连续计数（成功清零）');
  assert.match(String(outcome.stack), /installArchiveTrackerDetailed is not defined/);
  assert.match(String(outcome.stack), /\n\s+at /, '必须带完整堆栈（含调用帧）');
});

test('F2（P2.4）：安装器抛错经引擎 ⇒ retryable 证据上读面且不停手；形状不支持才停手', async () => {
  const h = await createEngineHarness();
  try {
    let calls = 0;
    h.engine.overlayInstaller = () => {
      calls += 1;
      throw new ReferenceError('installArchiveTrackerDetailed is not defined');
    };
    const check = h.engine.verifyOverlay({ force: true });
    assert.equal(calls, 1);
    assert.equal(h.engine.overlayInstall.shape, 'threw');
    assert.equal(h.engine.overlayInstall.reason, 'threw');
    assert.equal(h.engine.overlayInstall.supported, true, '抛错不得报成宿主不支持');
    assert.equal(h.engine.overlayInstall.retryable, true);
    assert.equal(h.engine.overlayInstall.programmingError, true);
    assert.equal(h.engine.overlayInstall.errorName, 'ReferenceError');
    assert.match(String(h.engine.overlayInstall.stack), /installArchiveTrackerDetailed is not defined/);
    assert.equal(h.engine.overlayUnsupported, false, '编程错误不得永久停手（旧实现的静默失效就在这里）');
    assert.equal(check.supported, true);
    assert.equal(check.drifted, false);

    h.clock.now += 6 * 60 * 1000;
    h.engine.verifyOverlay();
    assert.equal(calls, 2, '编程错误必须允许后续读口继续重试');

    const banner = h.engine.overlayBanner();
    assert.equal(banner.supported, true);
    assert.equal(banner.repairFailed, false);
    assert.equal(banner.install.shape, 'threw');
    assert.equal(banner.install.programmingError, true);
    assert.equal(banner.install.retryable, true);

    // 对照：宿主形状不支持（安装器**返回** supported:false）= 停手（A-18 之外的唯一停手条件）
    h.engine.overlayInstaller = () => ({
      ok: false, installed: false, supported: false, shape: 'accessor', reason: 'set-ineffective', error: 'set-ineffective',
    });
    h.engine.verifyOverlay({ force: true });
    assert.equal(h.engine.overlayUnsupported, true, '只有「宿主形状不支持」才停手');
    h.clock.now += 6 * 60 * 1000;
    h.engine.verifyOverlay();
    assert.equal(h.engine.overlayUnsupported, true);
  } finally {
    await h.dispose();
  }
});

// ===========================================================================
// F4（可选）：评审 🔵 #3 / #4
// ===========================================================================
test('F4（P2.4，🔵 #3）：未挂上 Sweeper 的读数只剩一份实现 —— engine 与 HTTP 回退字段集合一致', async () => {
  const state = { attempts: 2, lastError: 'vault.db is locked', nextRetryAt: T0 + 30000, gaveUp: false, stage: 'engine', lastAttemptAt: T0 - 1000 };
  const canonical = unattachedSweepPayload(state, { now: T0 });
  assert.equal(canonical.attached, false);
  assert.equal(canonical.error, 'vault.db is locked');
  assert.equal(canonical.sweepError.code, 'sweeper-not-attached');
  assert.equal(canonical.attempts, 2);
  assert.equal(canonical.nextRetryAt, T0 + 30000);
  assert.equal(canonical.stage, 'engine');
  assert.equal(canonical.budget.day, '2027-01-15');
  assert.equal(canonical.budget.used, 0);

  // http.js 的再导出必须是同一个函数（不是第二份实现）
  assert.equal(httpUnattachedSweepPayload, unattachedSweepPayload);

  // 启动链一次都没报错时也必须给默认原因（旧 engine 实现对同一件事给 null，与 HTTP 回退读数不一致）
  const noError = unattachedSweepPayload({ attempts: 0 }, { now: T0 });
  assert.equal(noError.error, 'Sweeper 尚未挂上（启动链未完成或仍在重试）');
  assert.equal(noError.sweepError.code, 'sweeper-not-attached');

  const h = await createEngineHarness();
  try {
    h.engine.sweepAttach = state;
    h.store.setMeta('sweep:budget:2027-01-15', '4');
    const engineSnap = h.engine.sweepSnapshot();
    assert.deepEqual(
      Object.keys(engineSnap).sort(),
      Object.keys(unattachedSweepPayload(null, { now: T0 })).sort(),
      'engine 读数必须与唯一实现字段集合一致',
    );
    assert.equal(engineSnap.attached, false);
    assert.equal(engineSnap.budget.used, 4, 'engine 侧预算从 meta 读（跨重启不丢）');
    assert.equal(engineSnap.budget.day, '2027-01-15');

    // 引擎不可用时 /status 走 HTTP 回退 = 同一个形状
    const api = createVaultApi({
      home: h.home,
      configStore: h.configStore,
      version: '0.1.0-test',
      getEngine: async () => null,
      logger: quiet,
    });
    const status = await call(api.handler, { url: PREFIX + '/status', body: '{}' });
    assert.equal(status.status, 200);
    assert.equal(status.json.sweep.sweepError.code, 'sweeper-not-attached');
    assert.equal(
      status.json.sweep.error,
      'Sweeper 尚未挂上（启动链未完成或仍在重试）',
      '没有引擎时也必须给出可读原因',
    );
    assert.deepEqual(
      Object.keys(status.json.sweep).sort(),
      Object.keys(unattachedSweepPayload(null, { now: T0 })).sort(),
      '/status 的 sweep 字段集合必须与唯一实现一致',
    );
  } finally {
    await h.dispose();
  }
});

test('F4（P2.4，🔵 #4）：manifest 查重走内存索引 —— 命中不再整档读取，新键照常落盘', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p24-manifest-'));
  try {
    const manifest = new Manifest(path.join(home, 'manifest.jsonl'));
    const record = { ts: 1, op: 'migrate', id: 's1', movedAt: 7 };
    assert.equal((await manifest.appendDedup(record)).skipped, false);
    assert.equal((await manifest.appendDedup(record)).skipped, true);

    // 命中路径不得再整档读取：把 readAll 换成抛错，重复键仍必须判重
    manifest.readAll = async () => { throw new Error('查重命中时不得再整档读取 manifest'); };
    const again = await manifest.appendDedup(record);
    assert.equal(again.skipped, true, '缓存命中不得回退到整档读取');
    assert.equal(again.key, 's1|migrate|7');

    // 新键照常落盘（append 不依赖 readAll）
    const fresh = await manifest.appendDedup({ ts: 2, op: 'restore', id: 's1' });
    assert.equal(fresh.skipped, false);

    const text = await readFile(path.join(home, 'manifest.jsonl'), 'utf8');
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 2, '两条不同键的记录各一行（旧实现会在此重复写）');
    assert.match(lines[0], /"op":"migrate"/);
    assert.match(lines[1], /"op":"restore"/);
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});
