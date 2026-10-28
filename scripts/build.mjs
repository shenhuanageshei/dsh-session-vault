#!/usr/bin/env node
/**
 * dsh-session-vault 构建脚本（零依赖、可离线）
 *
 * 产物：lib/client.js —— 唯一合法的 client bundle，格式必须是
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * 做法：把 src/ui/*.tsx 当作「同一模块作用域里的源码片段」原样并入 bundle 壳。
 * 因此 src/ui/*.tsx 内**不得出现 import / export 语句**，依赖（React、h、vaultApi、
 * ctxRef 等）由壳提供；这也是本仓库不引任何打包器/转译器的原因（宿主 Node 24 直接跑，
 * 离线可用、产物与源码逐字节可对账）。
 *
 * 用法：npm run build  （= node scripts/build.mjs）
 * 校验：tests/ui-contract.test.mjs 会重新渲染一次并与 lib/client.js 逐字节比对（防漂移）。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(HERE, '..');

/** 参与拼接的 UI 片段，按顺序并入单模块作用域。 */
export const SECTIONS = ['src/ui/panel.tsx', 'src/ui/settings.tsx'];

/**
 * 以 **ESM 模块**形式存在的纯函数片段（设计档 §16 UI 契约第 ② 条：可纯化的逻辑导出成纯函数，
 * 在 node --test 里直接断言）。拼进 bundle 时只剥掉开头的 `export` 关键字——
 * bundle 是单模块作用域，剥掉后就是普通函数声明，**与测试 import 的是同一份源码**（杜绝双写漂移）。
 */
export const MODULE_SECTIONS = [
  // P3a（FR-P3-1）：快捷键命中判断（A-P3-1 的纯函数锚）
  'lib/shortcut.js',
  // P3b（FR-P3-6）：列表窗口化（A-P3-6 的纯函数锚：>200 行窗口化）
  'lib/virtual.js',
  // P3b（评审遗留 🔵）：设置页整数输入（空串不得静默转 0）
  'lib/int-input.js',
];

/** 剥掉顶层声明前的 `export`（只处理 function/const/let/class；import 一律不允许出现在片段里）。 */
export function stripModuleExports(text) {
  return String(text).replace(/^export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/gm, '');
}

export const SHELL_HEAD = String.raw`window.__ModuleLoader__.load({
  id: 'dsh-session-vault',
  factory: function (require) {
    'use strict';
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;
    var API_BASE = '/session-vault/api';
    var PANEL_ID = 'session-vault';
    var OPEN_SEARCH_EVENT = 'session-vault:open-search';
    // 宿主的全局覆盖层席位是 **shell.overlay**（ui-layout 声明、list、root scope）。
    // 旧代码注册的 app.overlay 在宿主里根本不存在（源码 0 命中）⇒ Ctrl/Cmd+Shift+K 与会话头部按钮在面板外空转。
    var OVERLAY_SEAT = 'shell.overlay';
    var FOOTER_SEAT = 'sidebar.footer.action';
    var ctxRef = null;
    var overlaySlotReady = false;
    var OVERLAY_MISSING_TEXT = '全局搜索不可用（缺 overlay 席位）';
    // 席位状态是跨组件共享的（面板 / 设置页 / 覆盖层都要读）：用极小的外部 store，避免把状态塞进 React 树。
    var overlayState = { status: 'pending', seat: OVERLAY_SEAT, error: null };
    var overlayListeners = [];
    var pendingOpenSearch = false;

    function setOverlayState(patch) {
      overlayState = Object.assign({}, overlayState, patch);
      var listeners = overlayListeners.slice();
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](overlayState); } catch (e) { /* 订阅者异常不影响广播 */ }
      }
    }

    function subscribeOverlay(listener) {
      overlayListeners.push(listener);
      return function () {
        overlayListeners = overlayListeners.filter(function (fn) { return fn !== listener; });
      };
    }

    function useOverlaySeat() {
      var state = React.useState(overlayState);
      React.useEffect(function () {
        state[1](overlayState);
        return subscribeOverlay(function (next) { state[1](next); });
      }, []);
      return state[0];
    }

    function consumePendingOpenSearch() {
      var value = pendingOpenSearch;
      pendingOpenSearch = false;
      return value;
    }

    /**
     * 打开全局搜索。席位不可用时**不是只 console.warn**：先切到保险库面板（面板内自带同一覆盖层），
     * 再由面板顶部横幅显式说明「全局搜索不可用（缺 overlay 席位）」。
     */
    function openGlobalSearch() {
      // 席位就绪 ⇒ 覆盖层已挂载并在监听事件：同步派发即可，别留下过期的「打开意图」。
      if (overlaySlotReady) {
        pendingOpenSearch = false;
        dispatchOpenSearch();
        return;
      }
      pendingOpenSearch = true;
      selectVaultPanel(ctxRef);
      dispatchOpenSearch();
    }

    function warn(message) {
      try {
        if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-session-vault] ' + message);
      } catch (e) { /* 日志永不抛 */ }
    }

    function vaultApi(method, payload) {
      return fetch(API_BASE + '/' + method, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {})
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || !data || data.ok === false) {
            var err = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
            err.status = res.status;
            err.code = data && data.code;
            err.body = data;
            throw err;
          }
          return data;
        });
      });
    }

    function dispatchOpenSearch() {
      try { window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT)); } catch (e) { warn('open search: ' + e.message); }
    }

    /**
     * 切到保险库主面板（设计档 §10 深链 / UI 档 §1：ctx.layout.selectPanel('session-vault')）。
     *
     * P4b3：三个前提缺一即打不开主面板（旧实现后两条都踩了）——
     *   ① exports.inject 必须含 'layout'，否则 cordis 代理访问 ctx.layout 直接抛错；
     *   ② main 席位必须用 key: PANEL_ID 注册：宿主 ui-layout 的 LayoutController 按
     *      **key** 解析（dsh-client-ui-layout/lib/client.js:603
     *      entry.options.key === id），不匹配就抛
     *      'main panel "session-vault" is not registered'；
     *   ③ 失败**只 warn**，绝不回退到打开搜索：旧实现在这里 dispatchOpenSearch()，
     *      用户点侧栏行只会弹出搜索浮层，于是看起来「主面板打不开」。
     * 设置页卡里的「打开主面板」按钮复用本函数（同一个出口、同一条失败语义）。
     *
     * @returns {boolean} true = 已切到主面板；false = 没切成（调用方自行提示，不换动作）
     */
    function selectVaultPanel(ctx) {
      var target = ctx || ctxRef;
      var layout = null;
      try {
        layout = target ? target.layout : null;
      } catch (e) {
        warn('selectPanel 不可用（layout 服务未注入，见 exports.inject）：' + (e && e.message));
        return false;
      }
      if (!layout || typeof layout.selectPanel !== 'function') {
        warn('selectPanel 不可用（layout 服务未注入，见 exports.inject）：主面板未切换（绝不回退打开搜索）');
        return false;
      }
      try {
        layout.selectPanel(PANEL_ID);
        return true;
      } catch (e) {
        warn('selectPanel 失败（main panel 是否以 key 注册？）：' + (e && e.message));
        return false;
      }
    }

    function openHotSession(id) {
      var ctx = ctxRef;
      var candidates = [];
      try { if (ctx && ctx.uiWorkspace) candidates.push(ctx.uiWorkspace); } catch (e) { /* ignore */ }
      try { if (ctx && ctx.workspace) candidates.push(ctx.workspace); } catch (e) { /* ignore */ }
      for (var i = 0; i < candidates.length; i++) {
        var api = candidates[i];
        if (api && typeof api.openSession === 'function') {
          try {
            var r = api.openSession(id);
            if (r && typeof r.catch === 'function') r.catch(function (e) { warn('openSession: ' + e.message); });
            return true;
          } catch (e) { warn('openSession: ' + e.message); }
        }
      }
      warn('openSession 不可用（P0-3 spike 决定降级路径）');
      return false;
    }

    function FallbackPanel() {
      return h('div', { style: { padding: 16, fontFamily: 'inherit' } }, '会话保险库：界面尚未构建（运行 npm run build）');
    }
    function FallbackSection() {
      return h('div', { style: { padding: 16, fontFamily: 'inherit' } }, '会话保险库设置：界面尚未构建（运行 npm run build）');
    }
    function FallbackOverlay() { return null; }
    function FallbackRow() { return h('div', { style: { padding: '8px 12px' } }, '会话保险库'); }
    function FallbackFooterAction() { return null; }
    function FallbackHeaderButton() { return null; }
`;

export const SHELL_TAIL = String.raw`
    var UI = {
      Panel: typeof VaultPanel === 'function' ? VaultPanel : FallbackPanel,
      SettingsSection: typeof VaultSettingsSection === 'function' ? VaultSettingsSection : FallbackSection,
      Overlay: typeof VaultSearchOverlay === 'function' ? VaultSearchOverlay : FallbackOverlay,
      PanelRow: typeof VaultPanelRow === 'function' ? VaultPanelRow : FallbackRow,
      FooterAction: typeof VaultFooterAction === 'function' ? VaultFooterAction : FallbackFooterAction,
      HeaderButton: typeof VaultHeaderButton === 'function' ? VaultHeaderButton : FallbackHeaderButton
    };

    function registerSlot(ctx, slot, register) {
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
          warn('slots 服务不可用：' + slot + ' 未注册');
          return null;
        }
        return ctx.slots.inject(slot, function () { return register(ctx); });
      } catch (e) {
        warn('slot ' + slot + ' 注册失败（已降级）：' + (e && e.message));
        return null;
      }
    }

    function apply(ctx) {
      ctxRef = ctx;
      var disposers = [];
      function add(d) { if (typeof d === 'function') disposers.push(d); }

      // 设置页：配置 + 第三方侧栏不渲染 panellist 时的兜底入口
      add(registerSlot(ctx, 'settings.section', function (c) {
        return c.slots.register({
          name: 'settings.section', id: PANEL_ID, order: 210,
          label: function () { return '会话保险库'; }
        }, UI.SettingsSection);
      }));

      // 侧栏面板行（主入口）：sidebar.panellist，与 Plugins / Cron 同款原生行
      add(registerSlot(ctx, 'sidebar.panellist', function (c) {
        return c.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 210,
          label: function () { return '会话保险库'; }
        }, UI.PanelRow);
      }));

      // 主列面板：与 panellist 行同标识，行点击由 sidebar shell 调 layout.selectPanel(id)。
      // ⚠ 宿主按 **key** 解析 main 席位（dsh-client-ui-layout/lib/client.js:603：
      //   ctx.slots.entries("main").some((entry) => entry.options.key === id)），
      // 用 id 注册会让 ctx.layout.selectPanel('session-vault') 抛
      //   'main panel "session-vault" is not registered'
      // —— 对照 dsh-client-ui-plugin-manager/lib/client.js:3346 的 key: PANEL_ID。
      add(registerSlot(ctx, 'main', function (c) {
        return c.slots.register({
          name: 'main', key: PANEL_ID, order: 210,
          label: function () { return '会话保险库'; }
        }, UI.Panel);
      }));

      // 侧栏底部动作（UI 档 §1 第 2 条）：sidebar.footer.action 是 **list** 席位，放大镜 → 同一个搜索
      add(registerSlot(ctx, FOOTER_SEAT, function (c) {
        return c.slots.register({
          name: FOOTER_SEAT, id: PANEL_ID + '.search', order: 120,
          label: function () { return '会话保险库：快速搜索'; }
        }, UI.FooterAction);
      }));

      // 会话头部搜索按钮：任意会话里呼出同一个全局搜索
      add(registerSlot(ctx, 'conversation.session.header.utilities', function (c) {
        return c.slots.register({
          name: 'conversation.session.header.utilities', id: PANEL_ID, order: 120,
          label: function () { return '会话保险库搜索'; }
        }, UI.HeaderButton);
      }));

      // 全局覆盖层：宿主席位是 shell.overlay（list / root scope）。声明存在时 inject 立即注册。
      add(registerSlot(ctx, OVERLAY_SEAT, function (c) {
        var disposer = c.slots.register({ name: OVERLAY_SEAT, id: PANEL_ID, order: 900 }, UI.Overlay);
        overlaySlotReady = true;
        setOverlayState({ status: 'ready', error: null });
        return disposer;
      }));

      // 席位可用性探测（真实读 slots 声明，不是猜）：就绪则无事；否则把「缺 overlay 席位」摆到 UI 上。
      function probeOverlaySeat() {
        if (overlaySlotReady) return;
        var spec = null;
        try {
          if (ctx && ctx.slots && typeof ctx.slots.spec === 'function') spec = ctx.slots.spec(OVERLAY_SEAT);
        } catch (e) { spec = null; }
        if (spec) return; // 声明在但 inject 还没跑到：留给下一轮探测
        setOverlayState({ status: 'missing', error: 'seat-not-declared' });
        warn(OVERLAY_MISSING_TEXT + '：Ctrl/Cmd+Shift+K 与会话头部按钮只在保险库面板内可用（UI 已显式提示）');
      }
      [3000, 9000].forEach(function (delay) {
        try {
          var timer = window.setTimeout(probeOverlaySeat, delay);
          add(function () { window.clearTimeout(timer); });
        } catch (e) { /* 无定时器环境只保留 inject 结果 */ }
      });

      // 快捷键（P3 / FR-P3-1 / P3-D1）：**Ctrl/Cmd+Shift+K** 归保险库；普通 Ctrl/Cmd+K 完全归宿主
      // （不注册、不拦截、不 preventDefault —— 见下面 onKeyDown 的早退）。
      try {
        if (ctx && ctx.shortcuts && typeof ctx.shortcuts.register === 'function') {
          add(ctx.shortcuts.register({
            id: 'session-vault.search',
            keys: 'mod+shift+k',
            label: '会话保险库：全局搜索（正文）',
            handler: function () { openGlobalSearch(); }
          }));
        }
      } catch (e) { warn('shortcuts 注册失败（用 keydown 兜底）：' + e.message); }

      // 捕获阶段监听（设计档 §18.4 FR-P3-1）：命中 Ctrl/Cmd+Shift+K ⇒ openGlobalSearch()。
      // 命中判断是纯函数 matchSearchShortcut —— 它就是 lib/shortcut.js 的同一份源码（本 bundle 内联），
      // node --test 直接 import 那个文件断言（A-P3-1），bundle 与测试不会各写一套。
      var onKeyDown = function (ev) {
        if (!matchSearchShortcut(ev)) return; // 普通 Ctrl+K / 无修饰 k / 其它键：一个字节都不碰
        ev.preventDefault();
        openGlobalSearch();
      };
      try {
        window.addEventListener('keydown', onKeyDown, true);
        add(function () { window.removeEventListener('keydown', onKeyDown, true); });
      } catch (e) { warn('keydown 注册失败：' + e.message); }

      var dispose = function () {
        while (disposers.length) {
          var d = disposers.pop();
          try { if (typeof d === 'function') d(); } catch (e) { /* ignore */ }
        }
        ctxRef = null;
      };
      try {
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () { return dispose; }, 'session-vault: client slots');
        }
      } catch (e) { warn('ctx.effect 注册失败：' + e.message); }
      return dispose;
    }

    exports.name = 'dsh-session-vault';
    // 'layout' 不可省：ctx.layout（ui-layout 的 LayoutController）是切主面板的唯一入口；
    // 不声明 inject 时 cordis 代理访问 ctx.layout 直接抛错 ⇒ selectVaultPanel 永远失败。
    exports.inject = ['slots', 'layout'];
    exports.apply = apply;
    return module.exports;
  }
});
`;

export function renderBundle(sections) {
  const parts = [];
  parts.push('// dsh-session-vault client bundle — generated by scripts/build.mjs; do not edit by hand.');
  parts.push('// source: ' + SECTIONS.join(' + ') + ' (single module scope; no import/export in sections)');
  parts.push(SHELL_HEAD.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n'));
  for (const section of sections) {
    parts.push('');
    parts.push('/* ===== ' + section.file + ' ===== */');
    parts.push(section.text.replace(/[ \t]+$/gm, '').replace(/\n+$/, ''));
  }
  parts.push(SHELL_TAIL.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n'));
  return parts.join('\n').replace(/\n*$/, '\n');
}

export async function readSections({ root = ROOT } = {}) {
  const out = [];
  for (const rel of SECTIONS) {
    const abs = path.join(root, rel);
    let text;
    try {
      text = await readFile(abs, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        out.push({ file: rel, text: '/* ' + rel + ' 尚未提供（P0-1 脚手架） */' });
        continue;
      }
      throw err;
    }
    out.push({ file: rel, text: text.replace(/^\uFEFF/, '') });
  }
  // 纯函数片段：文件本身是 ESM 模块（可被 node --test 直接 import），内联时只剥掉 export。
  for (const rel of MODULE_SECTIONS) {
    const text = await readFile(path.join(root, rel), 'utf8');
    out.push({ file: rel, text: stripModuleExports(text.replace(/^\uFEFF/, '')) });
  }
  return out;
}

export async function renderFromDisk({ root = ROOT } = {}) {
  return renderBundle(await readSections({ root }));
}

export async function build({ root = ROOT } = {}) {
  const sections = await readSections({ root });
  const code = renderBundle(sections);
  const target = path.join(root, 'lib', 'client.js');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, code, 'utf8');
  return { target, bytes: Buffer.byteLength(code, 'utf8'), sections: sections.map((s) => s.file) };
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const result = await build();
  console.log('[session-vault] built ' + path.relative(ROOT, result.target) + ' (' + result.bytes + ' bytes; sections: ' + result.sections.join(', ') + ')');
}
