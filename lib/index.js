/**
 * dsh-session-vault · host 半身（cordis 插件）
 *
 * 边界
 *  - 本文件是宿主入口（package.json main / exports["."]）；client 半身是 lib/client.js
 *    （exports["./client"]）。两者严格分离：host 不 import client，client 不 import node:*。
 *  - 生命周期一律 ctx.effect(...) 或 apply 返回的 disposer（cordis 4.0.5 没有 'dispose' 事件）。
 *  - 路由前缀 /session-vault/api，只接受 POST + 本机同源请求（lib/http.js）。
 *  - 运行期配置 = <DSH_HOME>/session-vault/config.json（D10：保存即生效，不需要重载宿主配置）。
 *  - 引擎/索引/归档包装用**惰性**动态 import：宿主静态依赖面保持最小（也便于纯 Node 单测）。
 */
import { createConfigStore, resolveHome, resolveVaultPaths } from './config.js';
import { createVaultApi, PREFIX } from './http.js';

export const name = 'dsh-session-vault';

/** 硬依赖只放 webServer；workspaceRegistry / sessionPersistence / sessions 都是可选能力（走 ctx.get）。 */
export const inject = ['webServer'];

export const ROUTE_PREFIX = PREFIX;
export const VERSION = '0.1.0';

/**
 * F1（真机：DSH 重启 7 小时后 /status.sweep 仍为 null）**启动链重试**。
 *
 * 旧实现：apply 后 1s 跑一次 ensureServices → recoverOnBoot → startSweeper；任何一步抛错都只 warn 一次，
 * 之后**永不重试**。真机上首次 ensureServices（打开 vault.db / 加载引擎）在启动窗口里失败过一次，
 * 于是 Sweeper 再没挂上；而稍后的 /list、/search 又各自重试 ensureServices 成功 —— 结果就是
 * 「列表/搜索正常，sweep 恒 null」这个最难解释的组合。
 *
 * 现在：整条链失败（任一步）就按 delayMs（默认 30s）重试，最多 maxAttempts（默认 20 = 10 分钟）；
 * 状态（attached / attempts / lastError / stage / nextRetryAt / gaveUp）全程可读，并接到
 * engine.sweepAttach ⇒ /status 的 sweep.attached=false + error，不再退化成 null。
 * recoverOnBoot 失败**不算**链失败（M3）：Sweeper 以 paused 起跑、每拍重试收敛。
 */
export const BOOT_RETRY_DEFAULT_MS = 30 * 1000;
export const BOOT_RETRY_DEFAULT_MAX = 20;

function bootScheduler(ctx) {
  return {
    after(fn, ms) {
      if (ctx && typeof ctx.setTimeout === 'function') {
        const dispose = ctx.setTimeout(fn, ms);
        return typeof dispose === 'function' ? dispose : () => {};
      }
      const timer = setTimeout(fn, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return () => clearTimeout(timer);
    },
  };
}

/**
 * F1（P2.3，真机 2026-10-24 11:30 的失败 1）：**启动链定时器注册**。
 *
 * 旧实现是 `ctx.effect(() => ctx.setTimeout(...))` —— 宿主的 cordis-plugin-timer 的
 * ctx.setTimeout 内部**已经**包了一层 ctx.effect，嵌套进外层 ctx.effect 后可能抛错；
 * 抛出的错误又被外层 try/catch 只 warn 掉，于是回调从未执行：`/status.sweep.attempts = 0`，
 * 启动链一次都没试过（列表/搜索各自重试 ensureServices 却正常，形成最难解释的组合）。
 *
 * 现在：
 *   ① 直接调用 `ctx.setTimeout(fn, delay)` 拿 disposer（**不再套 ctx.effect**）；
 *   ② 拿不到/抛错 ⇒ 退回全局 `setTimeout` + `unref()`（本插件已有先例）；
 *   ③ 两条路都失败 ⇒ 把错误写进可读状态（/status.boot.registrationError），不只 warn。
 *
 * @returns {{registered:boolean, via:null|string, delayMs:number, registrationError:null|string,
 *            registrationErrorAt:null|number, firedAt:null|number, startError:null|string}}
 */
export function registerBootTimer({ ctx, bootChain, delayMs, log, disposers = [] } = {}) {
  const state = {
    registered: false,
    via: null,
    delayMs,
    registrationError: null,
    registrationErrorAt: null,
    firedAt: null,
    startError: null,
  };
  const note = typeof log === 'function' ? log : () => {};
  const fire = () => {
    state.firedAt = Date.now();
    try {
      const started = bootChain && typeof bootChain.start === 'function' ? bootChain.start() : null;
      if (started && typeof started.catch === 'function') {
        started.catch((err) => {
          state.startError = err && err.message ? err.message : String(err);
          note('warn', '启动链 start 异常：' + state.startError);
        });
      }
    } catch (err) {
      state.startError = err && err.message ? err.message : String(err);
      note('warn', '启动链 start 抛错：' + state.startError);
    }
  };
  const fail = (err, via) => {
    state.registrationError = (via ? via + ' 注册失败：' : '') + (err && err.message ? err.message : String(err));
    state.registrationErrorAt = Date.now();
    note('warn', state.registrationError);
  };
  // ① 宿主定时器：直接拿 disposer（宿主内部自己管 ctx.effect，这里**不再嵌套**）。
  //     宿主 ctx.setTimeout 是 **timer 服务的代理访问器**：未 inject 'timer' 时
  //     连属性探测都会抛 "cannot get property \"timer\" without inject"（P2.5 真机），
  //     所以探测与调用都必须包 try/catch，失败退全局 setTimeout。
  let hostSetTimeout = null;
  try {
    if (ctx && typeof ctx.setTimeout === 'function') hostSetTimeout = (fn, ms) => ctx.setTimeout(fn, ms);
  } catch (err) {
    fail(err, 'ctx.setTimeout 探测');
  }
  if (hostSetTimeout) {
    try {
      const dispose = hostSetTimeout(fire, delayMs);
      state.registered = true;
      state.via = 'ctx.setTimeout';
      if (typeof dispose === 'function') disposers.push(dispose);
      return state;
    } catch (err) {
      fail(err, 'ctx.setTimeout');
    }
  }
  // ② 全局 setTimeout + unref（本项目已用过的兜底）
  try {
    const timer = setTimeout(fire, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    state.registered = true;
    state.via = 'global.setTimeout';
    disposers.push(() => clearTimeout(timer));
    return state;
  } catch (err) {
    fail(err, 'global.setTimeout');
  }
  // ③ 两条路都失败：状态里留原因（/status.boot.registrationError），启动链不会静默消失
  return state;
}

function envInt(name, fallback) {
  if (!process.env) return fallback;
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

/**
 * 建一条可重试的启动链（导出即单测接缝：F1 的「首次失败、二次成功」直接测它）。
 *
 * @param {{ensureServices:Function, recoverOnBoot?:Function, attachSweeper:Function,
 *          scheduler?:{after:Function}, log?:Function, maxAttempts?:number, delayMs?:number}} options
 * @returns {{state:object, start:Function, stop:Function, waitForSettle:Function, bindEngine:Function}}
 */
export function createBootChain(options = {}) {
  const ensureServices = options.ensureServices;
  if (typeof ensureServices !== 'function') throw new Error('createBootChain 需要 ensureServices');
  const attachSweeper = typeof options.attachSweeper === 'function' ? options.attachSweeper : async () => {};
  const recoverOnBoot = typeof options.recoverOnBoot === 'function' ? options.recoverOnBoot : async () => {};
  const scheduler = options.scheduler && typeof options.scheduler.after === 'function' ? options.scheduler : bootScheduler(null);
  const log = typeof options.log === 'function' ? options.log : () => {};
  const maxAttempts = Number.isFinite(options.maxAttempts) ? Math.max(1, Math.trunc(options.maxAttempts)) : BOOT_RETRY_DEFAULT_MAX;
  const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, Math.trunc(options.delayMs)) : BOOT_RETRY_DEFAULT_MS;
  const state = {
    attached: false,
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    lastErrorAt: null,
    nextRetryAt: null,
    gaveUp: false,
    stage: null,
    attachedAt: null,
    maxAttempts,
    delayMs,
  };
  let timer = null;
  let running = false;
  let stopped = false;
  let settleResolve = null;
  const settled = new Promise((resolve) => { settleResolve = resolve; });
  const settle = (value) => { if (settleResolve) { const resolve = settleResolve; settleResolve = null; resolve(value); } };

  function bindEngine(engine) {
    if (engine && typeof engine === 'object') engine.sweepAttach = state;
    return engine;
  }

  function schedule() {
    if (stopped || state.attached || state.gaveUp) return;
    if (timer) return;
    state.nextRetryAt = Date.now() + delayMs;
    timer = scheduler.after(() => {
      timer = null;
      attempt().catch(() => {});
    }, delayMs);
  }

  async function attempt() {
    if (running || stopped) return state;
    running = true;
    state.attempts += 1;
    state.lastAttemptAt = Date.now();
    try {
      state.stage = 'engine';
      const services = await ensureServices();
      const engine = services && services.engine;
      if (engine) bindEngine(engine);
      // M3：启动收敛失败**不算**链失败 —— 传给 attachSweeper，Sweeper 以 paused 起跑并每拍重试。
      let bootError = null;
      state.stage = 'recover';
      try {
        await recoverOnBoot(services);
      } catch (err) {
        bootError = err;
        log('warn', 'recoverOnBoot 失败（Sweeper 以暂停态起跑，每拍重试收敛）：' + (err && err.message ? err.message : err));
      }
      state.stage = 'sweeper';
      await attachSweeper(services, bootError);
      state.attached = true;
      state.attachedAt = Date.now();
      state.lastError = null;
      state.nextRetryAt = null;
      state.stage = 'attached';
      log('info', '启动链完成：Sweeper 已挂上（第 ' + state.attempts + ' 次尝试）');
      settle({ attached: true, attempts: state.attempts, state });
    } catch (err) {
      state.lastError = err && err.message ? err.message : String(err);
      state.lastErrorAt = Date.now();
      state.nextRetryAt = null;
      if (state.attempts >= maxAttempts) {
        state.gaveUp = true;
        log('warn', '启动链已达最大重试次数（' + maxAttempts + ' 次，stage=' + state.stage + '）：Sweeper 未挂上；' +
          '/status 的 sweep.attached=false 会一直给出原因，列表/迁移/搜索仍可用。最后错误：' + state.lastError);
        settle({ attached: false, gaveUp: true, attempts: state.attempts, state });
      } else {
        log('warn', '启动链失败（第 ' + state.attempts + '/' + maxAttempts + ' 次，stage=' + state.stage + '），' +
          delayMs + 'ms 后重试：' + state.lastError);
      }
    }
    running = false;
    schedule();
    return state;
  }

  return {
    state,
    bindEngine,
    start() { return attempt(); },
    waitForSettle(timeoutMs) {
      if (state.attached || state.gaveUp || stopped) return Promise.resolve(state);
      if (!Number.isFinite(timeoutMs)) return settled.then(() => state);
      return Promise.race([
        settled.then(() => state),
        new Promise((resolve) => {
          const timer2 = setTimeout(() => resolve(state), Math.max(0, Math.trunc(timeoutMs)));
          if (timer2 && typeof timer2.unref === 'function') timer2.unref();
        }),
      ]);
    },
    stop() {
      stopped = true;
      if (timer) {
        try { timer(); } catch { /* ignore */ }
        timer = null;
      }
      settle({ stopped: true, state });
    },
  };
}

/**
 * F2（P2.4）：抛错是否属于「插件侧编程错误」（标识符未定义 / 类型错 / 语法错 …）。
 *
 * 为什么要区分：**宿主形状不支持是返回值，不是异常**。旧实现把安装器抛出的任何错误
 * （真机是 `ReferenceError: installArchiveTrackerDetailed is not defined`）压成
 * `supported:false` ⇒ 引擎永久 `overlayUnsupported=true` ⇒ 归档追踪 / 透明水合 / 漂移自愈
 * 全部静默失效，连 `/diag {"action":"retry-overlay"}` 也修不好（它走同一个函数）。
 * 现在：编程错误标 retryable:true + 完整 stack，自动重试不停；只有安装器**返回**
 * supported:false（Proxy set 不生效 / 只读 / 缺方法）才停手。
 */
export function isProgrammingError(err) {
  return err instanceof ReferenceError
    || err instanceof TypeError
    || err instanceof SyntaxError
    || err instanceof RangeError
    || err instanceof EvalError
    || err instanceof URIError;
}

/**
 * F2（P2.4）：安装器抛错时的可读读数（导出即可单测的接缝，不是降级路径）。
 *
 * 后置：supported 恒 true（抛错不构成「宿主不支持」的判定）、retryable 恒 true、
 * shape/reason 恒 'threw'，并带 errorName / programmingError / 完整 stack / throws 计数。
 */
export function overlayErrorOutcome(err, priorThrows = 0) {
  const message = err && err.message ? err.message : String(err);
  return {
    ok: false,
    installed: false,
    supported: true,
    retryable: true,
    shape: 'threw',
    reason: 'threw',
    error: message,
    errorName: err && err.name ? String(err.name) : 'Error',
    programmingError: isProgrammingError(err),
    stack: err && err.stack ? String(err.stack) : null,
    throws: Math.max(0, Math.trunc(Number(priorThrows) || 0)) + 1,
  };
}

/**
 * F1（P2.4）：engine.js 尚未加载时的读数（导出即可单测的接缝）。
 *
 * 后置：supported 恒 true、retryable 恒 true —— **不是**「宿主形状不支持」；
 * 引擎不会因此停手，后续读口（/status、/list、清扫 tick、/diag retry-overlay）继续尝试补装。
 */
export function overlayNotLoadedOutcome() {
  return {
    ok: false,
    installed: false,
    supported: true,
    retryable: true,
    shape: 'engine-module-not-loaded',
    reason: 'engine-module-not-loaded',
    error: null,
  };
}

export function apply(ctx, config) {
  const home = resolveHome(process.env);
  const paths = resolveVaultPaths(home);
  const configStore = createConfigStore({ home, paths, seed: config });
  const disposers = [];

  const log = (level, message) => {
    try {
      const logger = ctx && ctx.logger;
      const fn = logger && (logger[level] || logger.warn);
      if (typeof fn === 'function') fn.call(logger, '[dsh-session-vault] ' + message);
    } catch {
      /* 日志永不抛 */
    }
  };

  const getService = (serviceName) => {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined;
    } catch {
      return undefined;
    }
  };

  let servicesPromise = null;
  let trackerDisposer = null;
  let sweeper = null;
  /** F1：启动链（重试 + 可读状态）。ensureServices 成功时把 engine.sweepAttach 接到它的 state 上。 */
  let bootChain = null;
  /** F1（P2.3）：启动定时器的注册读数（registered / via / registrationError）—— /status.boot 的数据源。 */
  let bootState = null;
  /** F2（P2.3）：最近一次 ensureServices 造出的引擎实例（安装器回调要重新解析 registry）。 */
  let activeEngine = null;
  /**
   * F1（P2.4，真机根因）：engine.js 的 `installArchiveTrackerDetailed` 必须**提升到 apply 作用域**。
   *
   * 旧实现在 ensureServices 的异步 IIFE 里解构：
   *   const [{ VaultStore }, { VaultEngine, installArchiveTrackerDetailed }] = await Promise.all([...])
   * 那个 const 只活在 IIFE 的块级作用域 —— **installOverlay 看不到这个名字**。于是真机 registry 一就绪，
   * installOverlay() 就在这一行抛 ReferenceError，被下面的 catch 吞成 shape:"threw" +
   * overlayUnsupported=true ⇒ 归档追踪 / 透明水合 / 漂移自愈全部失效（/diag retry-overlay 走同一函数，修不好）。
   * 现在：apply 作用域持有可变引用，ensureServices 解构后赋值；installOverlay 判空并如实报
   * 「引擎模块尚未加载」（supported:true + retryable:true，不是宿主不支持）。
   */
  let installArchiveTrackerDetailed = null;
  /** F2（P2.4）：安装抛错的连续计数（读数用；成功即清零。停不停手只看能否重试，不看这个数字）。 */
  let overlayThrows = 0;
  /** AC-9 / A-18：检测到 archive-manager ⇒ 完全不装包装（读口补装路径也必须禁掉）。 */
  let amPresent = false;

  /**
   * F2（P2.3）：归档包装安装器（注入给 engine.overlayInstaller）。
   *
   * 为什么不是「ensureServices 里装一次就完」：启动窗口里 `ctx.get("workspaceRegistry")` 可能
   * 还没就绪（旧实现捕获到 null 就永不重试 ⇒ archivedAt / 透明水合静默失效）。这里每次调用都
   * **重新解析** registry；engine 的 /status、/list、清扫 tick 都能触发补装（30s 限流）。
   *
   * P2.4：两条「不再静默」的口径 ——
   *   ① engine.js 尚未加载（installArchiveTrackerDetailed 未就绪）⇒ supported:true + retryable:true，
   *      不是宿主不支持（F1）；② 任何抛错 = 插件侧编程错误 ⇒ shape:"threw" + 完整 stack + retryable:true，
   *      只有安装器**返回** supported:false 才停手（F2）。
   */
  const installOverlay = () => {
    const engine = activeEngine;
    let outcome;
    if (!engine) {
      outcome = { ok: false, installed: false, supported: false, reason: 'no-engine' };
      return outcome;
    }
    if (amPresent) {
      // AC-9 / A-18：AM 在场不装包装（它会删缺失工件的归档标记，与冷存储直接冲突）。
      outcome = { ok: false, installed: false, supported: true, reason: 'am-present', skipped: true };
      engine.overlayInstall = { ...outcome, lastAttemptAt: Date.now() };
      return outcome;
    }
    if (typeof installArchiveTrackerDetailed !== 'function') {
      // F1（P2.4）：engine.js 还没加载完 / 加载失败 —— **不是**宿主形状不支持（旧实现正是在这个位置
      // 抛 ReferenceError 并被 catch 吞成 unsupported）。标 supported:true + retryable:true，
      // 后续读口（/status、/list、清扫 tick、/diag retry-overlay）会继续补装。
      outcome = overlayNotLoadedOutcome();
      engine.overlayInstall = { ...outcome, lastAttemptAt: Date.now() };
      engine.overlayUnsupported = false;
      log('warn', '归档包装延后：engine.js 尚未加载（installArchiveTrackerDetailed 未就绪）。这不是宿主不支持，后续读口会继续重试');
      return outcome;
    }
    try {
      const registry = getService('workspaceRegistry');
      if (!registry) {
        outcome = { ok: false, installed: false, supported: true, retryable: true, reason: 'no-registry' };
        engine.overlayInstall = { ...outcome, lastAttemptAt: Date.now() };
        engine.overlayUnsupported = false;
        return outcome;
      }
      if (!engine.registry) engine.registry = registry;
      const detailed = installArchiveTrackerDetailed({
        registry,
        engine,
        getConfig: () => {
          try {
            const cached = typeof configStore.peek === 'function' ? configStore.peek() : null;
            return (cached && cached.config) || {};
          } catch {
            return {};
          }
        },
        log,
      });
      outcome = detailed;
      engine.overlayInstall = {
        lastAttemptAt: Date.now(),
        ok: Boolean(detailed.ok),
        installed: Boolean(detailed.installed),
        supported: detailed.supported !== false,
        shape: detailed.shape || null,
        reason: detailed.reason || null,
        error: detailed.error || null,
        // F2（P2.4）：编程错误 / 可重试证据必须留在读面上（旧实现只剩一条 warn，读面看不出是编程错误）。
        retryable: detailed.retryable === true,
        throws: Number(detailed.throws) || 0,
        errorName: detailed.errorName || null,
        programmingError: detailed.programmingError === true,
        stack: detailed.stack || null,
        state: detailed.state || null,
      };
      if (detailed.disposer && detailed.installed) trackerDisposer = detailed.disposer;
      // F2（P2.4）：只有「宿主形状不支持」（安装器**返回** supported:false 且不可重试）才停手；
      // 编程错误 / 引擎模块未加载 / registry 未就绪一律保留自动重试。
      // no-registry 是「宿主还没就绪」而不是「宿主不支持」——旧实现就靠这条豁免，这里逐字保留。
      if (detailed.ok) {
        overlayThrows = 0;
        engine.overlayUnsupported = false;
      } else if (detailed.supported === false && detailed.retryable !== true && detailed.reason !== 'no-registry') {
        engine.overlayUnsupported = true;
      } else {
        engine.overlayUnsupported = false;
      }
      if (!detailed.ok) {
        log('warn', '归档包装未生效（' + (detailed.shape || 'unsupported') + '：' + (detailed.reason || 'unknown') + '）：' +
          (engine.overlayUnsupported
            ? '宿主 workspaceRegistry 的形状不支持包装，已停止自动重装；可用 /session-vault/api/diag {"action":"retry-overlay"} 手动重试'
            : 'retryable=true，自动重试未停止（后续读口会再试）') +
          (detailed.error ? '；' + detailed.error : ''));
      }
      return detailed;
    } catch (err) {
      // F2（P2.4）：抛错 = 插件侧编程错误（或其它异常），**不是**「宿主形状不支持」。
      // 旧实现在这里写 supported:false + overlayUnsupported=true ⇒ 一次编程错误就把归档追踪永久判死。
      const detailed = overlayErrorOutcome(err, overlayThrows);
      overlayThrows = detailed.throws;
      engine.overlayInstall = { lastAttemptAt: Date.now(), ...detailed, state: null };
      engine.overlayUnsupported = false;
      log('warn', '归档包装安装抛错（第 ' + detailed.throws + ' 次；编程错误=' + (detailed.programmingError ? '是' : '否') + '，' +
        detailed.errorName + '：' + detailed.error + '）。这不是宿主形状不支持，自动重试不会停止。完整堆栈：\n' +
        (detailed.stack || '(无堆栈)'));
      return detailed;
    }
  };

  async function ensureServices() {
    if (!servicesPromise) {
      servicesPromise = (async () => {
        const [{ VaultStore }, engineModule] = await Promise.all([
          import('./store.js'),
          import('./engine.js'),
        ]);
        const { VaultEngine } = engineModule;
        // F1（P2.4）：把安装器写进 apply 作用域的可变引用 —— installOverlay 与本 IIFE **不在同一个
        // 块级作用域**。旧实现在这里 `const { installArchiveTrackerDetailed } = ...`，installOverlay 里
        // 根本看不到这个名字，于是 registry 一就绪就抛 ReferenceError（被吞成 shape:"threw" + 永久 unsupported）。
        installArchiveTrackerDetailed = typeof engineModule.installArchiveTrackerDetailed === 'function'
          ? engineModule.installArchiveTrackerDetailed
          : null;
        const store = await VaultStore.open(paths.dbPath);
        const registry = getService('workspaceRegistry');
        const persistence = getService('sessionPersistence');
        const engine = new VaultEngine({
          home,
          paths,
          configStore,
          store,
          ctx,
          registry,
          persistence,
          logger: ctx && ctx.logger,
        });
        // F1：engine 一存在就把「Sweeper 挂载状态」接上去 —— 即使启动链随后在 drain 前失败、
        // Sweeper 始终没挂上，/status 也能给出 sweep.attached=false + 原因（不再是 null）。
        if (bootChain) bootChain.bindEngine(engine);
        // F2（P2.3）：把安装器交给引擎 —— 启动窗口里 registry 未就绪时，/status、/list、清扫 tick
        // 任一读口都能补装（旧实现只装一次，捕获 null 就永不重试）。
        engine.overlayInstaller = installOverlay;
        activeEngine = engine;
        try {
          // AC-9 / A-18：检测到 archive-manager 时**完全不装包装**（它会删缺失工件的归档标记，
          // 与冷存储直接冲突），降级为「差分轮询 + 顶部横幅」。
          const loaded = await configStore.load();
          const am = await engine.detectAm();
          if (am.present) {
            const ids = (am.matches || []).map((match) => match.id).join(', ');
            amPresent = true;
            engine.overlayDisabled = true;
            log('warn', '检测到 archive-manager（' + (ids || 'unknown') + '）：不安装归档包装。archivedAt 回填**已交付**（P2 清扫的只读回填 tick：每轮清扫都跑，AM 在场也照跑，只补 DB 展示字段、不搬移文件）；取消归档不会自动搬回、透明水合不生效（AC-9 / A-18）');
            engine.overlayInstall = { lastAttemptAt: Date.now(), ok: false, installed: false, supported: true, shape: 'am-present', reason: 'am-present', skipped: true };
          } else if (!registry) {
            // 不是致命错误：engine.overlayInstaller 会在后续读口补装，这里把原因留在状态里。
            engine.overlayInstall = { lastAttemptAt: Date.now(), ok: false, installed: false, supported: true, shape: 'not-installed', reason: 'no-registry' };
            log('warn', 'workspaceRegistry 暂不可用：归档包装延后补装（每个读口每 30s 重试一次）');
          } else {
            installOverlay();
            // R-21 / 坑 14：装完立刻自检一次（不是我们的包装 / 形状不支持都要暴露）
            const check = engine.verifyOverlay();
            if (check.drifted) {
              const overlay = engine.overlayBanner(check);
              log('warn', '归档包装自检失败（shape=' + (overlay.shape || 'unknown') + '，reason=' + (overlay.reason || 'unknown') +
                '）：archivedAt / 透明水合可能失效');
            }
            // 后装插件可能再包一层：稍后复检一次，把漂移暴露到 UI 横幅。
            try {
              if (typeof ctx.setTimeout === 'function') {
                ctx.setTimeout(() => {
                  try {
                    engine.verifyOverlay();
                  } catch {
                    /* 复检失败不阻塞启动 */
                  }
                }, 3000);
              }
            } catch {
              /* 无定时器能力时只保留安装时自检 */
            }
          }
        } catch (err) {
          log('warn', '归档包装安装失败（降级为无 archivedAt 追踪）：' + (err && err.message ? err.message : err));
        }
        return { store, engine };
      })().catch((err) => {
        servicesPromise = null;
        throw err;
      });
    }
    return servicesPromise;
  }

  /**
   * F1/F4（P2.3）：/status.boot 的数据源 —— 定时器有没有注册、注册走哪条路、链走到哪一步。
   * `attempts=0` 只有在「定时器从未注册」时才是故障；链刚起步的几十毫秒属于正常窗口。
   */
  const getBootState = () => {
    const state = bootChain ? bootChain.state : {};
    const timer = bootState || {};
    return {
      registered: Boolean(timer.registered),
      via: timer.via || null,
      delayMs: Number.isFinite(timer.delayMs) ? timer.delayMs : null,
      registrationError: timer.registrationError || null,
      registrationErrorAt: timer.registrationErrorAt || null,
      firedAt: timer.firedAt || null,
      startError: timer.startError || null,
      attempts: Number(state.attempts) || 0,
      stage: state.stage || null,
      lastError: state.lastError || null,
      nextRetryAt: state.nextRetryAt || null,
      attached: Boolean(state.attached),
      gaveUp: Boolean(state.gaveUp),
    };
  };

  const api = createVaultApi({
    home,
    configStore,
    version: VERSION,
    logger: ctx && ctx.logger ? ctx.logger : console,
    getEngine: async () => {
      const services = await ensureServices();
      if (services && services.engine) activeEngine = services.engine;
      return services.engine;
    },
    // F1：引擎都起不来时 /status 仍要能回答「Sweeper 为什么没挂上」（sweep.attached=false + error）。
    getSweepAttach: () => (bootChain ? bootChain.state : null),
    // F1/F4：启动链定时器的注册与执行读数（真机失败 1：attempts=0 = 定时器回调从未执行过）。
    getBootState,
  });

  const registerRoute = () => {
    const server = getService('webServer');
    if (!server || typeof server.register !== 'function') {
      log('warn', 'webServer 不可用：/session-vault/api 路由未注册');
      return () => {};
    }
    return server.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: api.handler });
  };

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(registerRoute, 'session-vault: routes');
    } else {
      const disposer = registerRoute();
      if (typeof disposer === 'function') disposers.push(disposer);
    }
  } catch (err) {
    log('warn', '路由注册失败：' + (err && err.message ? err.message : err));
  }

  /**
   * P2-1 Sweeper：**必须等 recoverOnBoot() 收敛完成**（R-14）才起跑，否则清扫会在
   * 「marker / 冷目录 / registry 三条对账还没收敛」的现场开始新迁移。
   * 定时器走 ctx.setTimeout / ctx.setInterval（cordis 4.0.5 无 dispose 事件），
   * 卸载时由 stop() 释放（本文件的 dispose 里调用）。
   */
  const startSweeper = async (engine, bootError) => {
    // A6（P2.6 评审）：「有实例」≠「已起跑」。旧实现 `if (sweeper) return sweeper;` 会把上一轮
    // new 出来、start() 却抛错的半成品实例当成「已挂上」直接返回 ⇒ 启动链记 attached=true、
    // 关闭重试，而清扫一次都不会跑。现在只有真的 started 才复用；否则（重新）start 同一个实例。
    if (sweeper && sweeper.started) return sweeper;
    try {
      if (!sweeper) {
        const { Sweeper } = await import('./sweeper.js');
        sweeper = new Sweeper({
          engine,
          ctx,
          logger: ctx && ctx.logger ? ctx.logger : console,
        });
      }
      // M3：启动恢复失败时**照样起跑**，只是 paused + sweepError（旧实现直接不起 ⇒ status.sweep 恒 null）。
      if (bootError) {
        sweeper.holdBootError(bootError);
        log('warn', '启动恢复失败：自动清扫以暂停态起跑（sweepError 已进 /status 与 UI 横幅），每一拍会重试收敛：' + (bootError && bootError.message ? bootError.message : bootError));
      }
      engine.sweeper = sweeper;
      sweeper.start();
      if (!sweeper.started) throw new Error('Sweeper.start() 未生效（started=false）：启动链会重试');
      const loaded = await configStore.load();
      log(
        'info',
        '自动清扫已排程：60s 后首扫，此后每 ' + loaded.config.sweepIntervalMinutes +
          ' 分钟；autoMigrate=' + (loaded.config.autoMigrate ? '开' : '关') +
          '，archiveAgeDays=' + loaded.config.archiveAgeDays +
          '，dailyBudgetCount=' + loaded.config.dailyBudgetCount,
      );
    } catch (err) {
      // F1：**必须抛出**让启动链重试。旧实现吞掉异常并返回 null ⇒ Sweeper 永不挂上、也没人再试。
      log('warn', '自动清扫启动失败（列表/迁移仍可用；启动链会重试）：' + (err && err.message ? err.message : err));
      throw err;
    }
    if (!sweeper) throw new Error('Sweeper 实例未创建（启动链会重试）');
    return sweeper;
  };

  // 启动收敛（§11 ①→④）在引擎起来后先跑一遍；Sweeper 串在收敛之后（R-14）。
  // M3：收敛**失败也起 Sweeper**（暂停态 + sweepError）。
  // F1：整条链失败（ensureServices / attachSweeper 抛错）⇒ 按 30s 重试，最多 20 次；状态可读。
  bootChain = createBootChain({
    ensureServices,
    recoverOnBoot: async (services) => {
      const report = await services.engine.recoverOnBoot();
      if (report && report.repaired) log('info', 'recoverOnBoot 收敛完成：' + JSON.stringify(report.counts || {}));
      return report;
    },
    attachSweeper: async (services, bootError) => startSweeper(services.engine, bootError),
    scheduler: bootScheduler(ctx),
    log,
    maxAttempts: envInt('VAULT_BOOT_RETRY_MAX', BOOT_RETRY_DEFAULT_MAX),
    delayMs: envInt('VAULT_BOOT_RETRY_MS', BOOT_RETRY_DEFAULT_MS),
  });

  const bootDelayMs = envInt('VAULT_BOOT_DELAY_MS', 1000);
  // F1（P2.3）：**不再** ctx.effect(() => ctx.setTimeout(...)) 嵌套 —— 宿主 timeout 内部已经
  // ctx.effect，嵌套可能抛错并被 catch 吞掉，于是启动链一次都不跑（真机 attempts=0）。
  // 这里直接拿 disposer；失败自动退全局 setTimeout + unref；都失败则错误进 /status.boot。
  try {
    bootState = registerBootTimer({ ctx, bootChain, delayMs: bootDelayMs, log, disposers });
    if (bootState.registered) {
      log('info', '启动收敛定时器已注册（' + bootState.via + '，' + bootDelayMs + 'ms 后跑启动链）');
    } else {
      log('warn', '启动收敛定时器注册失败：启动链不会自动跑（原因见 /status.boot.registrationError）：' + (bootState.registrationError || 'unknown'));
    }
  } catch (err) {
    bootState = {
      registered: false,
      via: null,
      delayMs: bootDelayMs,
      registrationError: err && err.message ? err.message : String(err),
      registrationErrorAt: Date.now(),
      firedAt: null,
      startError: null,
    };
    log('warn', '启动收敛定时器注册失败（未吞：/status.boot.registrationError 可读）：' + bootState.registrationError);
  }
  disposers.push(() => bootChain && bootChain.stop());

  const dispose = () => {
    while (disposers.length) {
      const d = disposers.pop();
      try {
        if (typeof d === 'function') d();
      } catch {
        /* 全部执行完 */
      }
    }
    if (bootChain) {
      try {
        bootChain.stop();
      } catch {
        /* ignore */
      }
    }
    if (sweeper) {
      try {
        sweeper.stop();
      } catch {
        /* ignore */
      }
      sweeper = null;
    }
    if (trackerDisposer) {
      try {
        trackerDisposer();
      } catch {
        /* ignore */
      }
      trackerDisposer = null;
    }
    const pending = servicesPromise;
    servicesPromise = null;
    if (pending) {
      pending
        .then(({ store }) => {
          try {
            store.close();
          } catch {
            /* ignore */
          }
        })
        .catch(() => {});
    }
  };

  log('info', 'host half loaded（vault root: ' + paths.vaultRoot + '）');
  return dispose;
}
