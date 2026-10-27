import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFromDisk, SECTIONS, stripModuleExports } from '../scripts/build.mjs';
import { windowRange, VIRTUAL_THRESHOLD } from '../lib/virtual.js';

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
  const windowStub = {
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener() {},
    dispatchEvent() { return true; },
    setTimeout() { return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
  };
  let factory = null;
  const loader = { load(definition) { factory = definition.factory; } };
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  globalThis.window = windowStub;
  globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };
  let moduleExports;
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', code)({ __ModuleLoader__: loader });
    if (typeof factory !== 'function') throw new Error('bundle 没有注册 factory');
    moduleExports = factory(function (name) {
      if (name !== 'react') throw new Error('bundle 只能 require react（实际 ' + name + '）');
      return ReactStub;
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.CustomEvent = previousCustomEvent;
  }
  return { moduleExports, listeners };
}

/** 桩 slots/ctx：记录席位注册，并把组件交给调用方。 */
function createSlotHost() {
  const registered = [];
  const slots = {
    inject(name, callback) { callback(); return () => {}; },
    register(options, component) { registered.push({ slot: options.name, id: options.id, component }); return () => {}; },
    spec(name) { return name === 'shell.overlay' ? { kind: 'list', scope: 'root' } : undefined; },
  };
  const ctx = {
    slots,
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer(); }; },
    shortcuts: { register() { return () => {}; } },
  };
  return { registered, ctx };
}

test('P1-6 UI 契约：client bundle 是 ModuleLoader 格式，且构建产物与源码逐字节一致', async () => {
  const code = await read('lib/client.js');
  assert.match(code, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(code, /id: 'dsh-session-vault'/);
  assert.match(code, /factory: function \(require\)/);
  assert.ok(code.trimEnd().endsWith('});'));

  const rendered = await renderFromDisk({ root: ROOT });
  assert.equal(code.replace(/^\uFEFF/, ''), rendered, 'lib/client.js 必须与 scripts/build.mjs 的产物一致（防手改漂移）');
  assert.deepEqual(SECTIONS, ['src/ui/panel.tsx', 'src/ui/settings.tsx']);
  for (const rel of SECTIONS) {
    const source = await read(rel);
    assert.doesNotMatch(source, /^\s*(import|export)\s/m, rel + ' 作为单模块片段不得含 import/export');
  }
});

test('P1-6 UI 契约：侧栏入口是 sidebar.panellist 一行「会话保险库」，并且不接管 sidebar.workspaces', async () => {
  const code = await read('lib/client.js');
  assert.match(code, /'sidebar\.panellist'/);
  assert.match(code, /'会话保险库'/);
  assert.match(code, /PANEL_ID = 'session-vault'/);
  assert.match(code, /c\.slots\.register\(/);
  assert.match(code, /name: 'main'/);
  assert.doesNotMatch(code, /registerSlot\(ctx,\s*'sidebar\.workspaces'/);
  assert.doesNotMatch(code, /slots\.inject\(\s*'sidebar\.workspaces'/);
  assert.doesNotMatch(code, /querySelector|MutationObserver|insertBefore|appendChild\(/, '不得用 DOM 补丁');
});

test('P1-6 UI 契约：面板顶部 50px 全宽大搜索栏 + Ctrl/Cmd+Shift+K（P3 起；普通 Ctrl+K 归宿主）+ 会话头部按钮 + settings.section 兜底', async () => {
  const code = await read('lib/client.js');
  assert.match(code, /SEARCH_BAR_HEIGHT = 50/);
  assert.match(code, /height: SEARCH_BAR_HEIGHT/);
  assert.match(code, /SEARCH_PLACEHOLDER/);
  // P3 / FR-P3-1 / P3-D1：面板的快捷键提示改成 Ctrl/Cmd+Shift+K；命中判断走纯函数 matchSearchShortcut。
  assert.match(code, /SEARCH_SHORTCUT_HINT = 'Ctrl\/Cmd\+Shift\+K'/);
  assert.match(code, /SEARCH_PLACEHOLDER = '[^']*' \+ SEARCH_SHORTCUT_HINT/, '搜索框占位必须带 Ctrl/Cmd+Shift+K 提示');
  assert.match(code, /if \(!matchSearchShortcut\(ev\)\) return;/, '快捷键必须走纯函数 matchSearchShortcut（A-P3-1）');
  assert.doesNotMatch(code, /'Ctrl K'/, '面板不得再显示旧快捷键 Ctrl K');
  assert.doesNotMatch(code, /ev\.altKey \|\| ev\.shiftKey/, '旧 handler 明确排除 shift —— P3 起必须是 shift+k');
  assert.match(code, /'conversation\.session\.header\.utilities'/);
  assert.match(code, /'settings\.section'/);
  assert.match(code, /function VaultPanel\(/);
  assert.match(code, /function VaultSettingsSection\(/);
  assert.match(code, /function VaultSearchOverlay\(/);
});

/**
 * 阻断 2：宿主**没有 app.overlay 席位**（ui-layout 的 shell.overlay 才是真的，list + root scope）。
 * 旧代码注册 app.overlay ⇒ slots.inject 的回调永远不跑 ⇒ Ctrl/Cmd+K 与会话头部按钮在面板外空转。
 * 这条契约必须断言「不用 app.overlay」，而不是反过来。
 */
test('P1-6 UI 契约（阻断 2）：全局覆盖层注册在 shell.overlay，且不再出现 app.overlay', async () => {
  const code = await read('lib/client.js');
  // 断言「没有把它当席位注册」（注释里可以解释旧 bug，但注册面不许出现）
  assert.doesNotMatch(code, /registerSlot\(ctx,\s*'app\.overlay'/, '宿主没有 app.overlay 席位：注册它等于永久空转');
  assert.doesNotMatch(code, /name:\s*'app\.overlay'/, '不允许任何 slots.register 以 app.overlay 作为席位名');
  const slotNames = new Set();
  for (const match of code.matchAll(/registerSlot\(ctx,\s*([A-Z_]+|'[^']+')/g)) slotNames.add(match[1]);
  for (const match of code.matchAll(/name:\s*([A-Z_]+|'[^']+')/g)) slotNames.add(match[1]);
  assert.equal(slotNames.has("'app.overlay'"), false, '实际注册的席位集合里不得有 app.overlay');
  assert.doesNotMatch(code, /ctx\.slots\.inject\(\s*'app\.overlay'/, 'inject 也不得指向 app.overlay');
  assert.match(code, /var OVERLAY_SEAT = 'shell\.overlay'/, '覆盖层席位必须是 shell.overlay');
  assert.match(code, /registerSlot\(ctx, OVERLAY_SEAT/, '必须按 shell.overlay 注册（走声明感知的 inject）');
  assert.match(code, /name: OVERLAY_SEAT, id: PANEL_ID, order: 900/, '覆盖层注册项要落在 shell.overlay 上');
  // 席位不可用时不是只 console.warn：UI 上有显式横幅文案
  assert.match(code, /全局搜索不可用（缺 overlay 席位）/, '必须给用户可见的提示文案');
  assert.match(code, /overlaySeat\.status === 'missing'/, '面板/设置页必须读席位状态并渲染横幅');
  assert.match(code, /function probeOverlaySeat\(/, '必须有真实的席位探测（slots.spec），不是猜');
  assert.match(code, /ctx\.slots\.spec\(OVERLAY_SEAT\)/);
  // 面板内的兜底覆盖层仍然存在（横幅说明它只在面板内可用）
  assert.match(code, /overlaySeat\.status === 'ready' \? null : h\(VaultSearchOverlay\)/);
});

/** 阻断 3：设计档 §10 / UI 档 §1 第 2 条的 sidebar.footer.action 完全没实现。 */
test('P1-6 UI 契约（阻断 3）：sidebar.footer.action 注册放大镜动作，点击打开同一个搜索', async () => {
  const code = await read('lib/client.js');
  assert.match(code, /var FOOTER_SEAT = 'sidebar\.footer\.action'/);
  assert.match(code, /registerSlot\(ctx, FOOTER_SEAT/, '必须注册 sidebar.footer.action（list 席位）');
  assert.match(code, /name: FOOTER_SEAT, id: PANEL_ID \+ '\.search'/, 'list 席位必须带唯一 id');
  assert.match(code, /function VaultFooterAction\(/, '缺少底部动作组件');
  assert.match(code, /FooterAction: typeof VaultFooterAction === 'function' \? VaultFooterAction : FallbackFooterAction/);
  assert.match(code, /'会话保险库：快速搜索（Ctrl\/Cmd\+Shift\+K）'/);
  assert.match(code, /'会话保险库：搜索（Ctrl\/Cmd\+Shift\+K）'/, '会话头部按钮的 title 也要统一成 Ctrl/Cmd+Shift+K');
  assert.match(code, /onClick: function \(\) \{ openGlobalSearch\(\); \}/, '底部动作必须打开同一个搜索');
});

test('P1-6 UI 契约：列表/迁移/恢复/取消归档按钮走 HTTP API，P2/P3 不静默降级', async () => {
  const code = await read('lib/client.js');
  for (const endpoint of ['list', 'migrate', 'restore', 'unarchive', 'config', 'preview', 'status']) {
    assert.match(code, new RegExp("'" + endpoint + "'"), '缺少 API 调用：' + endpoint);
  }
  // client 的写动作全部经 runAction(method, ids, verb) → vaultApi(method, {ids}) 派发，
  // 没有字面量 vaultApi('migrate') 调用点；按真实调用点断言，而不是把代码改成字面量调用。
  assert.match(code, /function runAction\(method, ids, verb\)/);
  assert.match(code, /vaultApi\(method, \{ ids: ids \}\)/, '派发器必须把 method 原样交给 POST /session-vault/api/<method>');
  assert.match(code, /runAction\('migrate'/);
  assert.match(code, /runAction\('restore'/);
  assert.match(code, /runAction\('unarchive'/);
  assert.match(code, /vaultApi\('list'/);
  assert.match(code, /vaultApi\('search'/, 'P2-2：搜索必须走真实 /search');
  // P3b（FR-P3-3 / FR-P3-4）：收藏与删除不再是「P3 占位」—— chip 启用、批量条有收藏/取消收藏/删除，
  // 行内有星标与删除；接口走 /favorite 与 /delete。
  assert.match(code, /vaultApi\('favorite', \{ id: id, favorite: favorite \}\)/, '收藏必须走 POST /session-vault/api/favorite');
  assert.match(code, /\}, item\.favorite \? '★' : '☆'\)/, '行内必须有收藏星标（★/☆）');
  assert.match(code, /\{ setFavorite\(selectedIds, true\); \} \}, '收藏'\)/, '批量条必须有「收藏」');
  assert.match(code, /\{ setFavorite\(selectedIds, false\); \} \}, '取消收藏'\)/, '批量条必须有「取消收藏」');
  assert.match(code, /runAction\('delete', \[item\.id\], '删除'\)/, '行内必须有「删除」（FR-P3-4）');
  assert.match(code, /runAction\('delete', selectedIds, '删除'\)/, '批量条必须有「删除」（FR-P3-4）');
  assert.match(code, /vaultApi\('trash', \{\}\)/, '回收站面板必须走 POST /session-vault/api/trash');
  assert.match(code, /vaultApi\('diagnose', \{\}\)/, '诊断面板必须走 POST /session-vault/api/diagnose');
  assert.match(code, /vaultApi\('repair', \{ checks: \[item\.id\], apply: true \}\)/, '逐项修复必须走 /repair apply:true');
  // 负向：不得再出现「收藏属于 P3」这类已交付功能的占位文案
  assert.doesNotMatch(code, /收藏属于 P3/, '收藏已交付（P3b）：不得保留占位文案');
  assert.match(code, /工作区/);
  assert.match(code, /已选 /);
  assert.doesNotMatch(code, /from 'node:|require\('node:/);
});

/** FR-14（第 10 项）：归档动作在 UI 里缺失 —— 单条与批量都要有，并显示归档时间。 */
test('P1-6 UI 契约（FR-14）：单条与批量都有「归档」，列表有「归档时间」列', async () => {
  const code = await read('lib/client.js');
  assert.match(code, /runAction\('archive', \[item\.id\], '归档'\)/, '单条归档按钮缺失');
  assert.match(code, /runAction\('archive', selectedIds, '归档'\)/, '批量条归档按钮缺失');
  assert.match(code, /runAction\('unarchive', selectedIds, '取消归档'\)/, '批量条取消归档按钮缺失');
  assert.match(code, /'归档时间'/, '列表要有归档时间列（FR-2 / 需求 §2.2）');
  assert.match(code, /formatAge\(item\.archivedAt\)/);
  assert.match(code, /stats\.archiveAgeDays/, '顶部统计的阈值必须来自引擎读数（旧 UI 恒显示 —）');
});

/**
 * 契约：client bundle 真的能在浏览器式的 ModuleLoader 环境里 apply 起来，并把席位都注册上。
 * （阻断 2/3 的根因是「注册到不存在的席位」，只读代码断言不够——这里跑一遍 apply。）
 */
test('P1-6 UI 契约：bundle 在桩宿主里 apply 成功，且席位移交 sets 正确', async () => {
  const { moduleExports } = await loadClientBundle();
  assert.equal(typeof moduleExports.apply, 'function');
  const { registered, ctx } = createSlotHost();
  const dispose = moduleExports.apply(ctx);
  assert.equal(typeof dispose, 'function');
  const slotsRegistered = registered.map((item) => item.slot).sort();
  assert.deepEqual(
    slotsRegistered,
    ['conversation.session.header.utilities', 'main', 'settings.section', 'shell.overlay', 'sidebar.footer.action', 'sidebar.panellist'].sort(),
  );
  assert.equal(registered.every((item) => typeof item.component === 'function'), true, '每个席位都要有可渲染组件');
  const overlay = registered.find((item) => item.slot === 'shell.overlay');
  const footer = registered.find((item) => item.slot === 'sidebar.footer.action');
  assert.equal(overlay.id, 'session-vault');
  assert.equal(footer.id, 'session-vault.search', 'list 席位要有唯一 id');
  dispose();
});

/** 渲染烟测：组件在桩 React 下至少不能抛（属性访问 / 空数据 / 缺少字段）。 */
test('P1-6 UI 契约：五个席位组件在空数据下都能渲染不抛（桩 React 烟测）', async () => {
  const { moduleExports } = await loadClientBundle();
  const { registered, ctx } = createSlotHost();
  moduleExports.apply(ctx);
  const bySlot = new Map(registered.map((item) => [item.slot, item.component]));
  for (const slot of ['settings.section', 'sidebar.panellist', 'main', 'sidebar.footer.action', 'conversation.session.header.utilities']) {
    assert.equal(typeof bySlot.get(slot), 'function', slot + ' 缺少组件');
  }
  const React = {
    createElement() { return null; },
    useState(value) { return [value, function () {}]; },
    useEffect() {},
    useRef(value) { return { current: value }; },
    useCallback(fn) { return fn; },
    useMemo(fn) { return fn(); },
  };
  // 把 bundle 内的 React 换成桩后，组件才能直接当函数调用（bundle 已捕获同一桩）
  assert.doesNotThrow(() => bySlot.get('main')());
  assert.doesNotThrow(() => bySlot.get('settings.section')());
  assert.doesNotThrow(() => bySlot.get('sidebar.panellist')());
  assert.doesNotThrow(() => bySlot.get('sidebar.footer.action')());
  assert.doesNotThrow(() => bySlot.get('conversation.session.header.utilities')());
});

/**
 * P2-2 / P2-3 契约（FR-9 / FR-10 / D21 / D22）：
 *  - 面板顶部搜索栏与 Ctrl/Cmd+K 覆盖层都接**真实** /search（不再按标题本地过滤）；
 *  - 结果按会话分组渲染，标注「进行中 / 热 / 已归档 / 冷存」+ 工作区 + snippet；
 *  - 热结果 → uiWorkspace.openSession，冷结果 → 预览抽屉（不恢复、不打开会话）；
 *  - 索引进度 + 暂停/恢复按钮；
 *  - 不接管 sidebar.workspaces。
 */
test('P2-3 UI 契约：搜索/预览接真实 API，结果标注状态+工作区+snippet，冷结果走预览抽屉，索引有进度与暂停恢复', async () => {
  const code = await read('lib/client.js');
  assert.match(code, /SEARCH_DEBOUNCE_MS = 300/, '搜索必须 300ms 防抖（UI 档 §3）');
  assert.match(code, /vaultApi\('search', \{ q: q, limit: 30, state: stateFilter, workspace: workspaceFilter \}\)/, '搜索必须调 POST /session-vault/api/search，并带上 chip（state）与工作区筛选');
  assert.match(code, /function useVaultSearch\(/, '缺少搜索数据源 hook');
  assert.match(code, /function VaultSearchResults\(/, '缺少搜索结果渲染组件');
  assert.match(code, /SEARCH_RESULT_STATES/, '结果状态表缺失');
  for (const label of ['进行中', '已归档', '冷存']) {
    assert.match(code, new RegExp(label), '结果必须标注状态：' + label);
  }
  assert.match(code, /group\.workspace/, '结果必须显示工作区');
  assert.match(code, /group\.snippet/, '结果必须显示命中 snippet（不是标题过滤）');
  assert.match(code, /openHotSession\(group\.sessionId\)/, '热结果必须走 uiWorkspace.openSession');
  assert.match(code, /requestVaultPreview\(group\)/, '冷结果必须打开预览抽屉（不恢复、不打开会话）');
  assert.match(code, /vaultApi\('preview', \{ id: id, limit: 20 \}\)/, '预览抽屉必须调 POST /session-vault/api/preview');
  assert.match(code, /preview\[0\]\.body\.messages\.map/, '预览必须渲染真实消息（不是占位文案）');
  assert.match(code, /function VaultIndexProgress\(/, '缺少索引进度组件');
  assert.match(code, /vaultApi\('rebuild-index', \{ action: action \}\)/, '暂停/恢复必须走 /rebuild-index 的 action');
  assert.match(code, /'暂停索引'/);
  assert.match(code, /'恢复索引'/);
  assert.match(code, /nextRunAt/, '顶部统计必须显示下次清扫');
  assert.match(code, /phaseLabels/, '索引进度必须有阶段文案');
  // 负向：绝不接管会话列表（D22）
  assert.doesNotMatch(code, /'sidebar\.workspaces'/);
  assert.doesNotMatch(code, /querySelector|MutationObserver|insertBefore|appendChild\(/);
});

/**
 * M7 / 评审 #7 契约（P2.1 修复轮）：
 *  - chip（状态）与工作区下拉必须作为筛选传给 /search（旧 UI 只传 q/limit，服务端明明支持 state/workspace）；
 *  - snippet / 标题里的命中词要用 <mark> 高亮（tokens 来自 /search 的同一套分词）；
 *  - 面板搜索回车：**有查询词**时打开搜索结果第一条（pickVaultSearchResult），无查询词才回退到可见列表第一条。
 */
test('M7 / #7 UI 契约：chip+工作区进 /search、snippet 命中词高亮、回车取搜索首条', async () => {
  const code = await read('lib/client.js');
  assert.match(code, /state: stateFilter/, 'chip 状态必须传给 /search');
  assert.match(code, /workspace: workspaceFilter/, '工作区筛选必须传给 /search');
  assert.match(code, /\[query, stateFilter, workspaceFilter\]/, '筛选值必须进 useEffect 依赖（改 chip 要重新搜）');
  assert.match(code, /function vaultChipSearchState\(/, '缺少 chip → state 的映射');
  assert.match(code, /if \(chipId === 'hot'\) return 'archived'/, '热归档 chip 必须映射到 archived');
  assert.match(code, /if \(chipId === 'cold'\) return 'cold'/);
  assert.match(code, /state: vaultChipSearchState\(filter\[0\]\)/, '面板必须把当前 chip 映射进搜索');
  assert.match(code, /function vaultHighlight\(text, tokens\)/, '缺少命中词高亮');
  assert.match(code, /h\('mark'/, '高亮必须用 <mark>（或等价标记）');
  assert.match(code, /vaultHighlight\(group\.snippet, tokens\)/, 'snippet 必须高亮');
  assert.match(code, /vaultHighlight\(group\.title \|\| group\.sessionId, tokens\)/, '标题也必须高亮');
  assert.match(code, /tokens: search\.data && search\.data\.tokens/, '结果组件必须拿到 /search 回传的 tokens');
  assert.match(code, /if \(groups\.length\) pickVaultSearchResult\(groups\[0\]\)/, '回车必须取搜索结果第一条（走 pickVaultSearchResult）');
});

/**
 * M4（P3a.1 审计必修）：设置页「检索范围」的文案契约 —— 删掉任何一句都必须变红。
 *  - 默认 body；枚举恰好两项（body / body+toolResults）；
 *  - 必须含「工具结果可能含密钥」的明文提示（I-14）；
 *  - S8：纯文本渲染的警告里不得出现 Markdown 星号（**…**）。
 */
test('M4 / S8 UI 契约：设置页检索范围文案（默认 body、两项枚举、密钥提示、无 Markdown 星号）', async () => {
  const code = await read('lib/client.js');
  const source = await read('src/ui/settings.tsx');
  for (const text of [code, source]) {
    assert.match(text, /h\('option', \{ value: 'body' \}, '正文（默认）'\)/, '必须有两项枚举之一：默认正文');
    assert.match(text, /h\('option', \{ value: 'body\+toolResults' \}, '正文 \+ 工具结果'\)/, '必须有两项枚举之二：正文 + 工具结果');
    assert.match(text, /工具结果可能含密钥/, '必须含 I-14 的密钥风险提示');
    assert.match(text, /单条截断 8KB/, 'UI 文案保持 8KB 口径');
    // S8：星号不得出现（纯文本渲染会原样显示 **）
    assert.doesNotMatch(text, /\*\*不含工具参数\*\*/, 'S8：警告文案不得用 Markdown 星号');
    assert.doesNotMatch(text, /回填\*\*已交付\*\*/, 'S8：警告文案不得用 Markdown 星号');
    assert.match(text, /不含工具参数，单条截断 8KB/);
  }
  // 默认值必须回落到 body（配置缺字段时）
  assert.match(code, /value: current\('searchScope'\) \|\| 'body'/, '检索范围下拉的默认值必须是 body');
  // 两个枚举值必须来自同一份 SEARCH_SCOPES 语义（配置层拒绝第三个值）
  const config = await read('lib/config.js');
  assert.match(config, /export const SEARCH_SCOPES = Object\.freeze\(\[SEARCH_SCOPE_BODY, SEARCH_SCOPE_TOOL_RESULTS\]\);/, '枚举必须只有两项（body / body+toolResults）');
});

/**
 * M1 面板契约：done-with-gaps / 未覆盖会话的**黄条**必须存在（N 个会话未覆盖（可重建）），
 * 且重建走 resume-scope（不靠轮询偷偷重跑）。
 */
test('M1 UI 契约：未覆盖会话黄条「N 个会话未覆盖（可重建）」+ 重建走 resume-scope', async () => {
  const code = await read('lib/client.js');
  assert.match(code, /function VaultScopeProgress\(/, '缺少未覆盖/进度组件');
  assert.match(code, /个会话未覆盖（可重建）/, '必须显示「N 个会话未覆盖（可重建）」黄条');
  assert.match(code, /scope\.gapsCount/, '黄条必须读 /status.scope.gapsCount');
  assert.match(code, /resume-scope/, '重建必须走 rebuild-index 的 resume-scope 动作');
  assert.match(code, /h\(VaultScopeProgress, \{ scope: statusScope, onAction: runIndexAction \}\)/, '面板必须挂上该组件');
  // S4：暂停/续做 scope 是独立动作
  assert.match(code, /'pause-scope'/, '必须有独立的暂停 scope 动作');
  assert.match(code, /var statusScope = status && status\.scope \? status\.scope : null;/);
});

/**
 * A-P3-6（FR-P3-6 / P3-D7）：列表 **>200 行窗口化**。
 *
 * 两层断言：
 *  ① 纯函数面 —— windowRange（lib/virtual.js，与 bundle 内联的是同一份源码）；
 *  ② 接线面 —— 面板真的用 windowRange/固定行高/上下占位渲染，而不是只 import 了函数。
 */
test('A-P3-6 UI 契约：>200 行窗口化（windowRange 纯函数 + 面板接线 + 固定行高与上下占位）', async () => {
  const code = await read('lib/client.js');
  const source = await read('src/ui/panel.tsx');
  const virtualSource = await read('lib/virtual.js');
  // ① 纯函数面：200 行全量、201 行窗口化，窗口远小于总行数
  const full = windowRange(200, 0, 520);
  assert.equal(full.virtual, false, '200 行不窗口化（>200 才是阈值）');
  const win = windowRange(1000, 56 * 400, 520);
  assert.equal(win.virtual, true, '1000 行必须窗口化');
  assert.ok(win.count < 100, '窗口行数必须远小于总行数：' + win.count);
  assert.equal(win.padTop + win.count * 56 + win.padBottom, 1000 * 56, '占位 + 渲染 = 全长');
  // bundle 内联的是同一份源码（只剥了 export）
  assert.ok(code.includes(stripModuleExports(virtualSource).trim()), 'lib/client.js 必须内联 lib/virtual.js 的同一份源码');
  // ② 接线面
  for (const text of [code, source]) {
    assert.match(text, /var virtualRange = windowRange\(visible\.length, listScroll\[0\], viewportHeight\);/, '面板必须按滚动位移算窗口');
    assert.match(text, /var renderedRows = visible\.slice\(virtualRange\.start, virtualRange\.end\);/, '只能渲染窗口内的行');
    assert.match(text, /height: VIRTUAL_ROW_HEIGHT/, '行必须锁成固定行高（否则占位高度与真实高度不符）');
    assert.match(text, /onScroll: function \(event\) \{ listScroll\[1\]\(event\.target\.scrollTop \|\| 0\); \}/, '必须在滚动容器上记录位移');
    assert.match(text, /key: 'pad-top'/, '上占位必须存在');
    assert.match(text, /key: 'pad-bottom'/, '下占位必须存在');
    assert.doesNotMatch(text, /visible\.map\(function \(item\) \{/, '旧的全量渲染路径必须被窗口化取代');
  }
  assert.match(code, /VIRTUAL_THRESHOLD = 200/, '阈值常量必须是 200（P3-D7）');
});

/**
 * FR-P3-6 / UI 档 §5：预览抽屉 **Esc 关闭**（与「关闭」按钮等价，键盘可达）。
 */
test('FR-P3-6 UI 契约：预览抽屉 Esc 关闭（只在抽屉打开时挂监听，关闭即摘）', async () => {
  const code = await read('lib/client.js');
  const source = await read('src/ui/panel.tsx');
  for (const text of [code, source]) {
    assert.match(text, /if \(!preview\[0\]\) return undefined;/, 'Esc 监听只在预览抽屉打开时挂上');
    assert.match(text, /if \(event && event\.key === 'Escape'\)/, '必须识别 Escape');
    assert.match(text, /preview\[1\]\(null\)/, 'Esc 必须关闭抽屉');
    assert.match(text, /window\.addEventListener\('keydown', onKey, true\)/, '捕获阶段监听（不被输入框吞掉）');
    assert.match(text, /window\.removeEventListener\('keydown', onKey, true\)/, '关闭后必须摘掉监听');
    assert.match(text, /按 Esc 关闭/, '抽屉里要有可见的 Esc 提示');
  }
});

test('P1-6 UI 契约：client bundle 文件存在且被 package.json exports 指向', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const target = pkg.exports['./client'];
  assert.equal(target, './lib/client.js');
  const info = await stat(path.join(ROOT, target));
  assert.ok(info.isFile() && info.size > 1000);
  assert.equal(pkg.dsh.client.platform, 'web');
});

// ---------------------------------------------------------------------------
// P4（UI 档 §7）：设置页「子代理会话冷存」卡 + 主面板双 chip + 恢复入口指路 + 文案红线
// ---------------------------------------------------------------------------
test('P4 UI 契约（UI 档 §7）：设置页子代理卡（指路/二次确认/读数/两个按钮）+ 面板双 chip + 文案红线', async () => {
  const code = await read('lib/client.js');
  const settings = await read('src/ui/settings.tsx');
  const panel = await read('src/ui/panel.tsx');

  for (const text of [code, settings]) {
    assert.match(text, /子代理会话冷存/, '设置页必须有「子代理会话冷存」卡');
    // 恢复入口指路（2026-10-27 用户实测：在设置页找不到恢复入口）
    assert.match(text, /列表 \/ 预览 \/ 恢复入口在主面板（侧栏「会话保险库」），本页只放配置/, '卡顶部必须有恢复入口指路');
    assert.match(text, /'打开主面板'/, '必须有「打开主面板」按钮');
    assert.match(text, /selectVaultPanel\(ctxRef\)/, '「打开主面板」必须真的切到主面板（§1 深链）');
    assert.match(text, /subagentMigrate/, '开关字段必须接进 UI');
    assert.match(text, /subagentAgeDays/, '阈值字段必须接进 UI');
    assert.match(text, /subagentDailyBudgetCount/, '日预算字段必须接进 UI');
    assert.match(text, /只搬未登记 \+ 未被引用 \+ ≥/, '开启前二次确认必须写明「只搬哪些」');
    assert.match(
      text,
      /搬到冷存后，宿主的会话列表与父会话的子代理缩进行不再显示它们；可在本页或全局搜索找回/,
      '文案红线：搬走后宿主列表/父会话缩进行不再显示它们（必须写明）',
    );
    assert.match(text, /vaultApi\('subagent-scan', \{ action: 'start' \}\)/, '「立即扫描」走 POST /subagent-scan');
    assert.match(text, /vaultApi\('subagent-migrate', \{ all: true, confirm: true \}\)/, '「迁移候选」必须带 confirm:true');
    assert.match(text, /vaultApi\('subagent-job', \{ action: 'cancel' \}\)/, '批量迁移必须可取消');
    assert.match(text, /vaultApi\('status', \{\}\)/, '只读读数必须来自 /status.subagent');
    assert.match(text, /candidatesBytes/, '读数必须含候选字节数');
    assert.match(text, /coldBytes/, '读数必须含已冷存字节数');
    assert.match(text, /scanAt/, '读数必须含上次扫描时间');
  }

  for (const text of [code, panel]) {
    assert.match(text, /VAULT_VIEWS/, '主面板顶部必须有两个 chip 的定义');
    assert.match(text, /\{ id: 'archived', label: '归档会话' \}/, 'chip 之一：归档会话（默认）');
    assert.match(text, /\{ id: 'subagent', label: '子代理会话' \}/, 'chip 之二：子代理会话');
    assert.match(text, /filter: \{ class: 'subagent' \}/, '子代理页必须按 class 分域请求 /list');
    assert.match(text, /function VaultSubagentPage\(/, '缺少子代理页组件');
    assert.match(text, /'候选（热）'/, '子代理页必须分「候选（热）」段');
    assert.match(text, /'已冷存'/, '子代理页必须分「已冷存」段');
    assert.match(text, /热·可迁移/, '行状态文案 hot-subagent → 热·可迁移');
    assert.match(text, /没有符合条件的子代理会话/, '空态文案缺失');
    assert.match(text, /function VaultSubagentPauseBanner\(/, '缺少暂停/缺口黄条组件');
    assert.match(text, /SUBAGENT_PAUSE_REASON_ORDER/, '暂停原因必须以同一份常量驱动（四条全列）');
    for (const reasonCode of ['subagent-refs-incomplete', 'cold-unavailable', 'cross-volume-disabled', 'restoring-unsettled']) {
      assert.match(text, new RegExp(reasonCode), '四条暂停原因缺一条：' + reasonCode);
    }
    assert.match(text, /'重新扫描'/, 'gaps 必须给「重新扫描」按钮（不做静默豁免）');
    assert.match(text, /gaps\.map\(function \(gap\)/, 'gaps 必须逐条列出 id 与原因');
  }
});
