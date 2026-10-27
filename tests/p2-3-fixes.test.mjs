import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { resolveVaultPaths, createConfigStore } from '../lib/config.js';
import { VaultStore } from '../lib/store.js';
import {
  VaultEngine,
  checkArchiveTracker,
  installArchiveTrackerDetailed,
  probeRegistrySet,
} from '../lib/engine.js';
import { createVaultApi, PREFIX, bootPayload } from '../lib/http.js';
import { createBootChain, registerBootTimer } from '../lib/index.js';

/**
 * P2.3 修复轮的锚测试（2026-10-24 11:30 第二次真机验收的两项失败）。
 *
 *  F1 启动链定时器：不再 ctx.effect(() => ctx.setTimeout(...)) 嵌套；注册失败/回退都要可读，
 *     `/status.boot` 能解释「sweep.attempts=0」到底为什么。
 *  F2 包装安装诊断与兼容：own / prototype / accessor / proxy 四种形状；
 *     Proxy「读回包装」按契约名验证（不误判漂移），Proxy「set 不生效」明确 unsupported 并停手。
 *  F3 自愈退避：重装 3 次仍 mismatched ⇒ repairFailed 停手（真机 reinstalls=10 的抖动）。
 *  F4 诊断落状态：/status.boot + overlay.reason；/diag 形状取证与 retry-overlay。
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

async function createHarness(options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p23-'));
  const paths = resolveVaultPaths(home);
  const configStore = createConfigStore({ home, paths });
  await configStore.save({ autoMigrate: false, archiveAgeDays: 14 });
  const store = await VaultStore.open(paths.dbPath);
  const clock = { now: T0 };
  const archived = new Set();
  const registry = options.registry === null ? null : (options.registry || makeRegistry(archived));
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
  });
  /** 复刻 index.js 的安装器接线（不启动完整 apply：零安装、零重启）。 */
  function wireInstaller(targetRegistry = registry) {
    const stats = { calls: 0 };
    engine.registry = targetRegistry;
    engine.overlayInstaller = () => {
      stats.calls += 1;
      const outcome = installArchiveTrackerDetailed({ registry: targetRegistry, engine, getConfig: () => ({}), log: quiet });
      engine.overlayInstall = {
        lastAttemptAt: clock.now,
        ok: Boolean(outcome.ok),
        installed: Boolean(outcome.installed),
        supported: outcome.supported !== false,
        shape: outcome.shape || null,
        reason: outcome.reason || null,
        error: outcome.error || null,
        state: outcome.state || null,
      };
      if (outcome.ok) engine.overlayUnsupported = false;
      else if (outcome.reason && outcome.reason !== 'no-registry') engine.overlayUnsupported = true;
      return outcome;
    };
    return stats;
  }
  return {
    home, paths, configStore, store, clock, archived, registry, engine, wireInstaller,
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
function fakeReq({ url = PREFIX + '/status', body = '{}', method = 'POST', remoteAddress = '127.0.0.1' } = {}) {
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:53210' };
  req.socket = { remoteAddress };
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
// F1：启动链定时器（真机失败 1：/status.sweep.attempts = 0）
// ===========================================================================
test('F1（P2.3）：ctx.setTimeout 抛错 ⇒ 回退全局定时器并注册成功，错误进可读状态（不吞）', async () => {
  let ensureCalls = 0;
  const chain = createBootChain({
    ensureServices: async () => { ensureCalls += 1; return { engine: {} }; },
    attachSweeper: async () => {},
    scheduler: { after(fn, ms) { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return () => clearTimeout(t); } },
    maxAttempts: 2,
    delayMs: 5,
    log: quiet,
  });
  const ctx = {
    setTimeout() { throw new Error('nested effect boom（宿主 timeout 内部已有 ctx.effect）'); },
  };
  const disposers = [];
  try {
    const state = registerBootTimer({ ctx, bootChain: chain, delayMs: 5, log: quiet, disposers });
    assert.equal(state.registered, true, '回退路径必须真的把定时器挂上：' + JSON.stringify(state));
    assert.equal(state.via, 'global.setTimeout');
    assert.match(String(state.registrationError), /nested effect boom/, '注册失败不得被吞：必须写进可读状态');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(ensureCalls, 1, '启动链必须真的跑起来（真机 attempts=0 的根因就在这一步）');
    assert.equal(chain.state.attempts, 1);
    assert.equal(chain.state.attached, true);
    // disposer 被交回调用方（卸载时能清掉）
    assert.ok(disposers.length >= 1);
  } finally {
    chain.stop();
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  }
});

test('F1（P2.3）：/status.boot 解释「启动链为什么没跑」—— 注册失败/未注册都不再是哑谜', async () => {
  const h = await createHarness();
  try {
    const failed = makeApi(h, {
      getEngine: async () => null,
      getBootState: () => ({
        registered: false,
        registrationError: 'ctx.setTimeout 注册失败：nested effect boom',
        attempts: 0,
        stage: null,
        lastError: null,
        nextRetryAt: null,
      }),
    });
    const status = await call(failed, { url: PREFIX + '/status' });
    assert.equal(status.status, 200);
    assert.equal(status.json.boot.registered, false);
    assert.match(status.json.boot.registrationError, /nested effect boom/);
    assert.equal(status.json.boot.attempts, 0);
    assert.equal(status.json.bootError, status.json.boot.registrationError, 'bootError 是 /status 上的一行可读原因');
    assert.equal(status.json.sweep.attached, false);

    // 定时器已注册、链还没到点：attempts=0 是正常启动窗口，不该报错
    const payload = bootPayload({ registered: true, via: 'ctx.setTimeout', attempts: 0, stage: null, lastError: null });
    assert.equal(payload.error, null);
    assert.equal(payload.via, 'ctx.setTimeout');
    assert.equal(payload.delayMs, null);
  } finally {
    await h.dispose();
  }
});

// ===========================================================================
// F2：包装安装的形状兼容（own / prototype / accessor / proxy）
// ===========================================================================
test('F2（P2.3）：原型方法形态 ⇒ patch 原型安装成功，卸载逐字还原（不污染实例）', async () => {
  class FakeRegistry {
    constructor() { this.archivedSessionIds = new Set(); }
    async archiveSession(id) { this.archivedSessionIds.add(String(id)); }
    async unarchiveSession(id) { this.archivedSessionIds.delete(String(id)); }
    async resolveByPath() { return undefined; }
  }
  const h = await createHarness();
  try {
    const registry = new FakeRegistry();
    const originalArchive = FakeRegistry.prototype.archiveSession;
    const originalUnarchive = FakeRegistry.prototype.unarchiveSession;
    const outcome = installArchiveTrackerDetailed({ registry, engine: h.engine, getConfig: () => ({}), log: quiet });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.shape, 'prototype');
    assert.equal(Object.prototype.hasOwnProperty.call(registry, 'archiveSession'), false, '原型方法不应被复制成实例自有属性');
    assert.notEqual(registry.archiveSession, originalArchive, '原型上必须换成我们的包装');

    await registry.archiveSession('session-proto');
    assert.equal(registry.archivedSessionIds.has('session-proto'), true, '包装必须照常调用 prior（不吞）');

    // F4：/diag 的写探针在原型形态下也必须「写在原型、还原到原型」——不能在实例上留影子属性
    const evidence = probeRegistrySet(registry, 'archiveSession');
    assert.equal(evidence.supported, true);
    assert.equal(evidence.restored, true);
    assert.equal(evidence.target, 'prototype');
    assert.equal(Object.prototype.hasOwnProperty.call(registry, 'archiveSession'), false, '诊断不得在实例上留影子自有属性（会把 final state 改掉）');

    outcome.disposer();
    assert.equal(registry.archiveSession, originalArchive, '卸载必须逐字还原原型描述符');
    assert.equal(registry.unarchiveSession, originalUnarchive);
    assert.equal(checkArchiveTracker(registry).installed, false);
  } finally {
    await h.dispose();
  }
});

test('F2（P2.3）：getter-only 形态 ⇒ 明确 unsupported（accessor-without-setter），不进重试链', async () => {
  const h = await createHarness();
  try {
    const registry = makeRegistry();
    Object.defineProperty(registry, 'archiveSession', {
      configurable: true,
      enumerable: false,
      get() { return async function onlyGetter(id) { registry.archivedSessionIds.add(String(id)); }; },
      // 故意不给 setter：宿主只读形态
    });
    const stats = h.wireInstaller(registry);
    const outcome = installArchiveTrackerDetailed({ registry, engine: h.engine, getConfig: () => ({}), log: quiet });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.supported, false);
    assert.equal(outcome.reason, 'accessor-without-setter');

    // 走引擎的 reconcile：必须停手（repairFailed），而不是每 30s 重装一次
    const check = h.engine.verifyOverlay();
    assert.equal(check.supported, false, '「装不上」由 supported=false 表达（installed 也应为 false）');
    assert.equal(check.installed, false);
    assert.equal(h.engine.overlayRepair.repairFailed, true);
    assert.match(String(h.engine.overlayRepair.reason), /overlay-unsupported: accessor-without-setter/);
    assert.equal(h.engine.overlayRepair.reinstalls || 0, 0, '形状不支持时一次重装都不该发生');

    // 再等很久也不重试安装（除非 /diag 手动 retry）
    h.clock.now += 6 * 60 * 60 * 1000;
    h.engine.verifyOverlay();
    assert.equal(stats.calls, 1, '不支持形态不得反复安装（旧实现 10 次抖动的同类根因）');

    const banner = h.engine.overlayBanner();
    assert.equal(banner.supported, false);
    assert.equal(banner.repairFailed, true);
    assert.equal(banner.autoRepair, false);
    assert.match(String(banner.reason), /accessor-without-setter/);
  } finally {
    await h.dispose();
  }
});

test('F2（P2.3）：Proxy 读回包装（name 仍是我们，toString 已是 native）⇒ 按 proxy-name 判为生效，不误判漂移', async () => {
  const h = await createHarness();
  try {
    const target = makeRegistry();
    // 复刻真机签名：函数值读回是 Proxy（name 转发到目标、toString 为 [native code]）
    const proxy = new Proxy(target, {
      get(t, key, receiver) {
        const value = Reflect.get(t, key, receiver);
        if (typeof value === 'function' && key !== 'constructor') return new Proxy(value, {});
        return value;
      },
      set(t, key, value) { return Reflect.set(t, key, value); },
    });
    const stats = h.wireInstaller(proxy);
    h.engine.verifyOverlay({ force: true });
    assert.equal(stats.calls, 1);
    assert.equal(h.engine.overlayInstall.ok, true, JSON.stringify(h.engine.overlayInstall));
    assert.equal(h.engine.overlayInstall.shape, 'proxy');

    const check = checkArchiveTracker(proxy, h.engine.overlayInstall.state);
    assert.equal(check.supported, true);
    assert.equal(check.drifted, false, '引用不等但名字一致（代理形态）不能判成漂移：' + JSON.stringify(check));
    assert.equal(check.verifiedBy, 'proxy-name');

    // 调用仍然落到我们的包装 + 第三方 prior 上（功能真的生效）
    await proxy.archiveSession('session-proxy');
    assert.equal(target.archivedSessionIds.has('session-proxy'), true);
    // 行为验证：我们的包装会记录 archivedAt（engine.noteArchived 副作用）
    const after = h.engine.verifyOverlay();
    assert.equal(after.drifted, false);
    assert.equal(h.engine.overlayRepair, null, '健康形态不该触发重装（overlayRepair 不该被创建）');
  } finally {
    await h.dispose();
  }
});

test('F2（P2.3）：绑定方法形态（get 里 bind）⇒ 契约名容忍 bound 前缀，判为生效不抖动', async () => {
  const h = await createHarness();
  try {
    const target = makeRegistry();
    const boundProxy = new Proxy(target, {
      get(t, key, receiver) {
        const value = Reflect.get(t, key, receiver);
        if (typeof value === 'function' && key !== 'constructor') return value.bind(t);
        return value;
      },
      set(t, key, value) { return Reflect.set(t, key, value); },
    });
    const stats = h.wireInstaller(boundProxy);
    const check = h.engine.verifyOverlay({ force: true });
    assert.equal(stats.calls, 1);
    assert.equal(h.engine.overlayInstall.ok, true, JSON.stringify(h.engine.overlayInstall));
    assert.equal(h.engine.overlayInstall.shape, 'proxy');
    assert.equal(check.supported, true);
    assert.equal(check.drifted, false, '绑定形态不能判成漂移：' + JSON.stringify(check));
    assert.equal(check.verifiedBy, 'proxy-name');
    assert.equal(h.engine.overlayRepair, null, '健康形态不该触发重装');
    await boundProxy.archiveSession('session-bound');
    assert.equal(target.archivedSessionIds.has('session-bound'), true);
  } finally {
    await h.dispose();
  }
});

test('F2（P2.3）：Proxy set 不生效 ⇒ unsupported + 停手（不再自动安装），/diag retry 可手动重试', async () => {
  const h = await createHarness();
  try {
    const target = makeRegistry();
    const writes = [];
    // set 被吞：返回 true 但什么都不写（真机「赋值成功、回读不是它」的另一种形态）
    const proxy = new Proxy(target, {
      get(t, key, receiver) { return Reflect.get(t, key, receiver); },
      set(t, key, value) { writes.push(String(key)); return true; },
    });
    const stats = h.wireInstaller(proxy);
    const check = h.engine.verifyOverlay({ force: true });
    assert.equal(stats.calls, 1);
    assert.equal(h.engine.overlayInstall.ok, false);
    assert.equal(h.engine.overlayInstall.supported, false);
    assert.equal(h.engine.overlayInstall.reason, 'set-ineffective');
    assert.equal(check.supported, false);
    assert.equal(h.engine.overlayRepair.repairFailed, true);
    assert.match(String(h.engine.overlayRepair.reason), /overlay-unsupported: set-ineffective/);

    // 形状静态：不再自动安装（旧实现每 30s 抖一次）
    h.clock.now += 6 * 60 * 60 * 1000;
    h.engine.verifyOverlay();
    assert.equal(stats.calls, 1, 'unsupported 之后不得再自动重试安装');

    // 手动 retry 会再诊断一次（force 绕过停手标记），仍不支持就仍如实报 unsupported
    const retried = h.engine.retryOverlay();
    assert.equal(stats.calls, 2, '/diag retry-overlay 必须真的重试一次');
    assert.equal(retried.overlay.supported, false);
    assert.equal(retried.overlay.repairFailed, true);
    assert.ok(writes.length >= 2, '写探针必须真的试过 set');
  } finally {
    await h.dispose();
  }
});

// ===========================================================================
// F3：自愈退避 + 停手（真机 reinstalls=10 的抖动）
// ===========================================================================
test('F3（P2.3）：重装 3 次仍 mismatched ⇒ 停止自动重装（repairFailed + 原因），不再抖动', async () => {
  const h = await createHarness();
  try {
    const stats = h.wireInstaller(h.registry);
    h.engine.verifyOverlay({ force: true });
    assert.equal(h.engine.overlayInstall.ok, true);

    // 每一轮都模拟「后装插件再次覆盖」，验证重装次数与退避
    for (let i = 1; i <= 3; i += 1) {
      h.registry.archiveSession = async function thirdParty() {};
      h.clock.now += h.engine.overlayBackoffMs(h.engine.overlayRepair ? h.engine.overlayRepair.reinstalls : 0) + 1000;
      const check = h.engine.verifyOverlay();
      assert.equal(check.drifted, false, '第 ' + i + ' 次重装必须把它修好');
      assert.equal(h.engine.overlayRepair.reinstalls, i);
      assert.equal(h.engine.overlayRepair.repairFailed, false);
    }
    assert.equal(stats.calls, 1, '重装走 reinstallArchiveTracker，不重复安装');

    // 第 4 次覆盖：到顶 ⇒ 停手（不再重装）
    h.registry.archiveSession = async function thirdPartyAgain() {};
    h.clock.now += 10 * 60 * 1000;
    const stopped = h.engine.verifyOverlay();
    assert.equal(stopped.drifted, true);
    assert.equal(h.engine.overlayRepair.reinstalls, 3, '超过 3 次后不得再重装');
    assert.equal(h.engine.overlayRepair.repairFailed, true);
    assert.match(String(h.engine.overlayRepair.reason), /auto-reinstall-stopped/);
    assert.match(String(h.engine.overlayRepair.reason), /retry-overlay/);

    // 即便再等很久也不抖
    h.clock.now += 24 * 60 * 60 * 1000;
    h.engine.verifyOverlay();
    assert.equal(h.engine.overlayRepair.reinstalls, 3, '停手后不得再重装（真机抖 10 次的根因）');

    const banner = h.engine.overlayBanner();
    assert.equal(banner.repairFailed, true);
    assert.equal(banner.autoRepair, false);
    assert.equal(banner.reinstalls, 3);
    assert.equal(banner.maxAutoReinstalls, 3);
    assert.match(String(banner.reason), /auto-reinstall-stopped/);

    // 手动 retry 重置 + 重装（修好后可恢复正常）
    h.registry.archiveSession = h.engine.overlayInstall.state.wrappedArchive;
    const retried = h.engine.retryOverlay();
    assert.equal(retried.overlay.drifted, false);
    assert.equal(retried.overlay.repairFailed, false);
    assert.equal(retried.overlay.reason, null);
    assert.equal(retried.overlay.reinstalls, 0, '手动 retry 重新计数');
  } finally {
    await h.dispose();
  }
});

// ===========================================================================
// F4：诊断落状态（/diag 形状取证 + /status.boot/overlay.reason）
// ===========================================================================
test('F4（P2.3）：/diag 返回描述符与写探针证据（探针不改最终状态），retry-overlay 可用', async () => {
  const h = await createHarness();
  try {
    h.wireInstaller(h.registry);
    h.engine.verifyOverlay({ force: true });
    const installed = h.engine.overlayInstall.state.wrappedArchive;
    const api = makeApi(h);

    const diag = await call(api, { url: PREFIX + '/diag', body: '{}' });
    assert.equal(diag.status, 200, JSON.stringify(diag.json).slice(0, 400));
    assert.equal(diag.json.diag.shape, 'own');
    assert.equal(diag.json.diag.supported, true);
    assert.equal(diag.json.diag.registry.isProxy, false);
    assert.equal(diag.json.diag.methods.archiveSession.descriptor.kind, 'data');
    assert.ok('ownDescriptor' in diag.json.diag.methods.archiveSession, '自有描述符必须是独立字段');
    assert.ok('prototypeDescriptor' in diag.json.diag.methods.archiveSession, '原型描述符必须是独立字段');
    assert.equal(diag.json.diag.methods.archiveSession.descriptor.writable, true);
    assert.equal(diag.json.diag.check.installed, true);
    assert.equal(diag.json.diag.methods.archiveSession.setProbe.readBackEqual, true, '写探针必须报告「set 后回读相等」');
    assert.equal(diag.json.diag.methods.archiveSession.setProbe.restored, true);
    assert.equal(h.registry.archiveSession, installed, '诊断不得改变最终状态（探针必须还原）');
    assert.equal(diag.json.diag.methods.unarchiveSession.setProbe.readBackEqual, true);

    const retry = await call(api, { url: PREFIX + '/diag', body: JSON.stringify({ action: 'retry-overlay' }) });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.action, 'retry-overlay');
    assert.equal(retry.json.retry.overlay.drifted, false);
    assert.equal(retry.json.retry.overlay.supported, true);

    const bad = await call(api, { url: PREFIX + '/diag', body: JSON.stringify({ action: 'nope' }) });
    assert.equal(bad.status, 400);
    assert.match(String(bad.json.message), /retry-overlay/);

    // 安全口径与其它路由一致：仅本机 + 仅 POST
    const nonLoopback = await call(api, { url: PREFIX + '/diag', remoteAddress: '10.0.0.8' });
    assert.equal(nonLoopback.status, 403);
    const getMethod = await call(api, { url: PREFIX + '/diag', method: 'GET' });
    assert.equal(getMethod.status, 405);
  } finally {
    await h.dispose();
  }
});

test('F4（P2.3）：/status.banners.overlay 带 reason/supported/repairFailed；boot 与 sweep 并存', async () => {
  const h = await createHarness();
  try {
    h.wireInstaller(h.registry);
    // 先造成一次「停手」的漂移：第 4 次覆盖
    h.engine.verifyOverlay({ force: true });
    for (let i = 1; i <= 4; i += 1) {
      h.registry.archiveSession = async function thirdParty() {};
      h.clock.now += 10 * 60 * 1000;
      h.engine.verifyOverlay();
    }
    const api = makeApi(h);
    const status = await call(api, { url: PREFIX + '/status' });
    assert.equal(status.status, 200, JSON.stringify(status.json).slice(0, 300));
    const overlay = status.json.banners.overlay;
    assert.equal(overlay.repairFailed, true);
    assert.equal(overlay.autoRepair, false);
    assert.equal(overlay.reinstalls, 3);
    assert.match(String(overlay.reason), /auto-reinstall-stopped/);
    assert.equal(typeof overlay.supported, 'boolean');
    // boot 段恒在（即便是「正常启动窗口」，字段也必须存在）
    assert.equal(typeof status.json.boot.registered, 'boolean');
    assert.equal(typeof status.json.boot.attempts, 'number');
    assert.equal(status.json.boot.error, null);
  } finally {
    await h.dispose();
  }
});
// F2：服务未就绪 ≠ 形状不支持（不能因为一次「还没加载完」就永久停手）
test('F2（P2.3）：workspaceRegistry 未就绪 ⇒ 如实标 no-registry，不进入停手/不支持分支', async () => {
  const h = await createHarness({ registry: null });
  try {
    h.engine.overlayInstaller = () => ({ ok: false, installed: false, supported: true, reason: 'no-registry' });
    const check = h.engine.verifyOverlay({ force: true });
    assert.equal(check.installed, false);
    assert.equal(check.supported, true, 'no-registry 是「未就绪」，不是「宿主不支持」');
    assert.equal(check.reason, 'no-registry');
    assert.equal(h.engine.overlayRepair, null, '未就绪时不得落 repairFailed（宿主稍后就绪会自动补装）');
    const banner = h.engine.overlayBanner(check);
    assert.equal(banner.repairFailed, false);
    assert.equal(banner.reason, 'no-registry');

    const api = makeApi(h);
    const diag = await call(api, { url: PREFIX + '/diag', body: '{}' });
    assert.equal(diag.status, 200);
    assert.equal(diag.json.diag.shape, 'no-registry');
  } finally {
    await h.dispose();
  }
});

// A-18 回归：AM 在场 ⇒ 读口补装路径也必须是死路（否则 P2.3 的「补装」会绕过 A-18）
test('A-18（P2.3 回归）：archive-manager 在场 ⇒ overlayDisabled，reconcile 绝不补装包装', async () => {
  const h = await createHarness();
  try {
    let calls = 0;
    h.engine.overlayDisabled = true;
    h.engine.overlayInstaller = () => { calls += 1; return { ok: false, installed: false, supported: true, reason: 'am-present' }; };
    const check = h.engine.verifyOverlay({ force: true });
    assert.equal(calls, 0, 'AM 在场时不得尝试安装包装（AC-9 / A-18）');
    assert.equal(check.installed, false);
    assert.equal(check.drifted, false);
    const banner = h.engine.overlayBanner(check);
    assert.equal(banner.repairFailed, false, 'AM 在场不是「重装失败」');
  } finally {
    await h.dispose();
  }
});

// probeRegistrySet 的直接契约（诊断面被单独复用的前提）
test('F2（P2.3）：probeRegistrySet 对普通实例报告 readBackEqual 且还原引用', async () => {
  const registry = makeRegistry();
  const original = registry.archiveSession;
  const evidence = probeRegistrySet(registry, 'archiveSession');
  assert.equal(evidence.supported, true);
  assert.equal(evidence.readBackEqual, true);
  assert.equal(evidence.restored, true);
  assert.equal(registry.archiveSession, original);
});
