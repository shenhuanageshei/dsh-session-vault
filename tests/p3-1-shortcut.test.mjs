import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchSearchShortcut } from '../lib/shortcut.js';
import { stripModuleExports } from '../scripts/build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

/** 在 Node 里用桩 window + 桩 React 把 client bundle 加载起来（不碰浏览器）。 */
async function loadClientBundle() {
  const code = await read('lib/client.js');
  const ReactStub = {
    createElement() { return null; },
    useState(value) { return [value, function () {}]; },
    useEffect() {},
    useRef(value) { return { current: value }; },
    useCallback(fn) { return fn; },
    useMemo(fn) { return fn(); },
  };
  const listeners = [];
  const events = [];
  const windowStub = {
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: Boolean(capture) }); },
    removeEventListener() {},
    dispatchEvent(event) { events.push(event); return true; },
    setTimeout() { return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
  };
  let factory = null;
  const loader = { load(definition) { factory = definition.factory; } };
  // bundle 的 factory 体里引用的 `window` 就是 new Function 的入参 ⇒ 它必须同时是 ModuleLoader
  // 宿主（__ModuleLoader__）和浏览器 window 桩（addEventListener/dispatchEvent/timers）。
  const moduleWindow = Object.assign({ __ModuleLoader__: loader }, windowStub);
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  globalThis.window = moduleWindow;
  globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };
  let moduleExports;
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', code)(moduleWindow);
    if (typeof factory !== 'function') throw new Error('bundle 没有注册 factory');
    moduleExports = factory(function (name) {
      if (name !== 'react') throw new Error('bundle 只能 require react（实际 ' + name + '）');
      return ReactStub;
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.CustomEvent = previousCustomEvent;
  }
  return { moduleExports, listeners, events };
}

/** 桩宿主：记录席位与快捷键注册。 */
function createSlotHost() {
  const registered = [];
  const shortcuts = [];
  const slots = {
    inject(name, callback) { callback(); return () => {}; },
    register(options, component) { registered.push({ slot: options.name, id: options.id, component }); return () => {}; },
    spec(name) { return name === 'shell.overlay' ? { kind: 'list', scope: 'root' } : undefined; },
  };
  const ctx = {
    slots,
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer(); }; },
    shortcuts: { register(options) { shortcuts.push(options); return () => {}; } },
  };
  return { registered, shortcuts, ctx };
}

/** 键盘事件形状：记录 preventDefault / stopPropagation 调用次数（不动的宿主行为要能被断言）。 */
function keyEvent(shape) {
  const event = {
    key: shape.key,
    ctrlKey: Boolean(shape.ctrlKey),
    metaKey: Boolean(shape.metaKey),
    shiftKey: Boolean(shape.shiftKey),
    altKey: Boolean(shape.altKey),
    repeat: shape.repeat === true,
    defaultPrevented: false,
    prevented: 0,
    stopped: 0,
    preventDefault() { this.defaultPrevented = true; this.prevented += 1; },
    stopPropagation() { this.stopped += 1; },
  };
  return event;
}

test('A-P3-1：纯匹配器 —— Ctrl/Cmd+Shift+K 命中；plain Ctrl/Cmd+K / 无修饰 / 只 shift 均不命中', () => {
  // 命中（shift 按住时 event.key 通常是 'K'，大小写都要认）
  assert.equal(matchSearchShortcut({ key: 'K', ctrlKey: true, shiftKey: true }), true);
  assert.equal(matchSearchShortcut({ key: 'k', ctrlKey: true, shiftKey: true }), true);
  assert.equal(matchSearchShortcut({ key: 'K', metaKey: true, shiftKey: true }), true, 'macOS 的 Cmd+Shift+K 也要命中');

  // 普通 Ctrl/Cmd+K：**不命中**（宿主侧栏搜索保留，P3-D1）
  assert.equal(matchSearchShortcut({ key: 'k', ctrlKey: true }), false);
  assert.equal(matchSearchShortcut({ key: 'k', metaKey: true }), false);

  // 无修饰 / 只 shift / 只 alt 系
  assert.equal(matchSearchShortcut({ key: 'k' }), false, '无修饰不命中');
  assert.equal(matchSearchShortcut({ key: 'k', shiftKey: true }), false, '只按 shift 不命中');
  assert.equal(matchSearchShortcut({ key: 'k', altKey: true }), false);

  // 其它键 / 畸形输入
  assert.equal(matchSearchShortcut({ key: 'j', ctrlKey: true, shiftKey: true }), false);
  assert.equal(matchSearchShortcut({ key: 'F', ctrlKey: true, shiftKey: true }), false);
  assert.equal(matchSearchShortcut(null), false);
  assert.equal(matchSearchShortcut(undefined), false);
  assert.equal(matchSearchShortcut('K'), false);
  assert.equal(matchSearchShortcut({}), false);

  // 已被别人处理过（defaultPrevented）：不再重复命中，避免同一次按键开两遍覆盖层
  assert.equal(matchSearchShortcut({ key: 'K', ctrlKey: true, shiftKey: true, defaultPrevented: true }), false);

  // R6（P3a.1）：**长按自动重复**（repeat:true）不命中 —— 否则按住 Ctrl+Shift+K 会反复重开覆盖层
  assert.equal(matchSearchShortcut({ key: 'K', ctrlKey: true, shiftKey: true, repeat: true }), false, 'repeat 事件不得命中');
  assert.equal(matchSearchShortcut({ key: 'k', metaKey: true, shiftKey: true, repeat: true }), false, 'macOS 的 repeat 同样不命中');
  assert.equal(matchSearchShortcut({ key: 'K', ctrlKey: true, shiftKey: true, repeat: false }), true, 'repeat:false 仍是首发命中');

  // 纯函数：不改入参
  const shape = { key: 'K', ctrlKey: true, shiftKey: true };
  Object.freeze(shape);
  assert.equal(matchSearchShortcut(shape), true);
  assert.deepEqual(shape, { key: 'K', ctrlKey: true, shiftKey: true });
});

test('A-P3-1：bundle 内联的匹配器与 lib/shortcut.js 是同一份源码（只剥了 export），文案统一为 Ctrl/Cmd+Shift+K', async () => {
  const code = await read('lib/client.js');
  const source = await read('lib/shortcut.js');
  const inlined = stripModuleExports(source).trimEnd();
  assert.ok(inlined.includes('function matchSearchShortcut(eventShape)'), '内联片段必须包含匹配器本体');
  assert.ok(code.includes(inlined), 'lib/client.js 必须内联 lib/shortcut.js 的同一份源码（防双写漂移）');
  assert.doesNotMatch(code, /export function matchSearchShortcut/, 'bundle 里不得残留 export 关键字');

  // 快捷键提示面（面板占位 / kbd / footer title / 头部 title / 设置页说明）统一 Ctrl/Cmd+Shift+K
  assert.match(code, /var SEARCH_SHORTCUT_HINT = 'Ctrl\/Cmd\+Shift\+K';/);
  assert.match(code, /var SEARCH_PLACEHOLDER = '[^']*' \+ SEARCH_SHORTCUT_HINT;/, '面板搜索框提示必须带 Ctrl/Cmd+Shift+K');
  assert.match(code, /'会话保险库：快速搜索（Ctrl\/Cmd\+Shift\+K）'/, '侧栏 footer 按钮 title 必须是 Ctrl/Cmd+Shift+K');
  assert.match(code, /'会话保险库：搜索（Ctrl\/Cmd\+Shift\+K）'/, '会话头部按钮 title 必须是 Ctrl/Cmd+Shift+K');
  assert.match(code, /Ctrl\/Cmd\+Shift\+K 打开全局搜索/, '设置页说明必须是 Ctrl/Cmd+Shift+K');
  assert.doesNotMatch(code, /'Ctrl K'/, '不得再出现旧快捷键 Ctrl K');
  assert.doesNotMatch(code, /（Ctrl\/Cmd\+K）/, '不得再出现旧快捷键 Ctrl/Cmd+K');

  // 覆盖层标题（设计档 §18.4 原文 + P3a.1 / S6：标题必须**随检索范围变**，不是硬编码一句「正文」）
  assert.match(code, /var GLOBAL_SEARCH_TITLE = '会话保险库 · 全局搜索（正文）';/);
  assert.match(code, /var GLOBAL_SEARCH_TITLE_TOOL_RESULTS = '会话保险库 · 全局搜索（正文 \+ 工具结果）';/);
  assert.match(code, /function vaultSearchTitle\(scope\)/, '标题必须有随 scope 变的唯一实现');
  assert.match(code, /return scope === 'body\+toolResults' \? GLOBAL_SEARCH_TITLE_TOOL_RESULTS : GLOBAL_SEARCH_TITLE;/, '两个标题必须按 scope 分支');
  assert.match(code, /var overlayTitle = vaultSearchTitle\(overlayScope\);/, '覆盖层必须按 /status.searchScope 算标题');
  assert.match(code, /'aria-label': overlayTitle/, 'aria-label 也要跟着 scope 走');
  assert.match(code, /h\('span', null, overlayTitle\)/, '可见标题必须是动态的那一个');
  assert.doesNotMatch(code, /h('span', null, GLOBAL_SEARCH_TITLE)/, '不得再渲染硬编码标题');
});

test('A-P3-1：bundle 捕获阶段 keydown —— Ctrl/Cmd+Shift+K 打开搜索；普通 Ctrl+K 不 preventDefault / 不吞事件', async () => {
  const { moduleExports, listeners, events } = await loadClientBundle();
  assert.equal(typeof moduleExports.apply, 'function');
  const { shortcuts, ctx } = createSlotHost();
  const dispose = moduleExports.apply(ctx);

  // 注册面：快捷键声明是 mod+shift+k（不是旧的 mod+k）
  const registeredShortcut = shortcuts.find((item) => item.id === 'session-vault.search');
  assert.ok(registeredShortcut, '必须注册 session-vault.search 快捷键');
  assert.equal(registeredShortcut.keys, 'mod+shift+k', '宿主快捷键声明必须是 mod+shift+k');
  assert.match(String(registeredShortcut.label), /全局搜索（正文）/, '快捷键标签要写明「全局搜索（正文）」');

  const keydown = listeners.filter((item) => item.type === 'keydown');
  assert.ok(keydown.length >= 1, '必须挂 window keydown 监听');
  assert.equal(keydown[0].capture, true, '设计档 §18.4：必须是捕获阶段监听');
  const handler = keydown[0].fn;

  // ① 命中：preventDefault + 派发打开事件
  events.length = 0;
  const hit = keyEvent({ key: 'K', ctrlKey: true, shiftKey: true });
  handler(hit);
  assert.equal(hit.prevented, 1, '命中组合要 preventDefault（避免浏览器把 Ctrl+Shift+K 当别的快捷键）');
  assert.ok(events.some((event) => event.type === 'session-vault:open-search'), '命中后必须打开全局搜索覆盖层');

  // ② 普通 Ctrl+K：一个字节都不碰（宿主的侧栏搜索保持可用）
  events.length = 0;
  const plain = keyEvent({ key: 'k', ctrlKey: true });
  handler(plain);
  assert.equal(plain.prevented, 0, '普通 Ctrl+K 不得 preventDefault（P3-D1）');
  assert.equal(plain.stopped, 0, '普通 Ctrl+K 不得 stopPropagation');
  assert.equal(events.length, 0, '普通 Ctrl+K 不得打开保险库覆盖层');

  // ③ 无修饰 / 只 shift / 长按 repeat / 带 defaultPrevented 的同一组合：同样不碰
  events.length = 0;
  for (const shape of [{ key: 'k' }, { key: 'k', shiftKey: true }, { key: 'j', ctrlKey: true, shiftKey: true }, { key: 'K', ctrlKey: true, shiftKey: true, repeat: true }]) {
    const event = keyEvent(shape);
    handler(event);
    assert.equal(event.prevented, 0, '不得拦截非契约按键：' + JSON.stringify(shape));
    assert.equal(event.stopped, 0);
  }
  assert.equal(events.length, 0);
  const already = keyEvent({ key: 'K', ctrlKey: true, shiftKey: true });
  already.defaultPrevented = true;
  handler(already);
  assert.equal(events.length, 0, '已被别人处理过的同组合不重复打开');

  dispose();
});
