/*
 * src/ui/panel.tsx —— 会话保险库主面板（侧栏 panellist 行 + 主列面板 + 全局搜索覆盖层）
 *
 * ⚠ 本文件由 scripts/build.mjs **原样并入** lib/client.js 的单模块作用域：
 *   不要写 import / export；依赖（React、h、vaultApi、ctxRef、openHotSession、
 *   dispatchOpenSearch、selectVaultPanel、OPEN_SEARCH_EVENT、overlaySlotReady）
 *   全部由 bundle 壳提供。文件后缀 .tsx 只用于编辑器体验，内容是 JS。
 *
 * 设计约束（UI 档 v0.3 / 设计档 D22）：
 *  - 主入口 = sidebar.panellist 一行「会话保险库」，主列 = 本面板；
 *  - 面板顶部 50px 全宽大搜索栏；Ctrl/Cmd+Shift+K 全局覆盖层（P3 起；普通 Ctrl+K 归宿主）；会话头部搜索按钮；
 *  - 绝不接管 sidebar.workspaces（只用独立 seat）；不用 DOM 补丁；
 *  - 列表/迁移/恢复按钮全部走 POST /session-vault/api/*。
 */
var SEARCH_BAR_HEIGHT = 50;
/**
 * P3 / FR-P3-1：快捷键与覆盖层标识（设计档 §18.4 原文）。
 * 快捷键是 Ctrl/Cmd+Shift+K —— **普通 Ctrl+K 完全归宿主侧栏搜索**（P3-D1），本模块不注册、不拦截。
 */
var SEARCH_SHORTCUT_HINT = 'Ctrl/Cmd+Shift+K';
var GLOBAL_SEARCH_TITLE = '会话保险库 · 全局搜索（正文）';
var GLOBAL_SEARCH_TITLE_TOOL_RESULTS = '会话保险库 · 全局搜索（正文 + 工具结果）';
/**
 * S6（P3a.1）：覆盖层标题**随检索范围变**（正文 / 正文 + 工具结果）。
 * 旧实现标题是硬编码常量 —— 开了工具结果之后标题仍说「正文」，与 /status.searchScope 自相矛盾。
 */
function vaultSearchTitle(scope) {
  return scope === 'body+toolResults' ? GLOBAL_SEARCH_TITLE_TOOL_RESULTS : GLOBAL_SEARCH_TITLE;
}
var SEARCH_PLACEHOLDER = '搜索所有工作区的会话正文（热 / 归档 / 冷存）· ' + SEARCH_SHORTCUT_HINT;
/** P2-3：搜索防抖（UI 档 §3：300ms）；索引进度轮询与列表同一节奏。 */
var SEARCH_DEBOUNCE_MS = 300;
var INDEX_PROGRESS_POLL_MS = 15000;

/** 搜索结果状态（进行中 / 热 / 已归档 / 冷存）——与后端 RESULT_STATE_LABELS 同文案。 */
var SEARCH_RESULT_STATES = {
  running: { label: '进行中', tone: 'busy' },
  hot: { label: '热', tone: 'hot' },
  archived: { label: '已归档', tone: 'hot' },
  cold: { label: '冷存', tone: 'cold' },
  // P3b（评审遗留 🔵）：回收站命中必须与后端 RESULT_STATE_LABELS.trash 同文案，
  // 否则「已删除」的命中会被标成「热」（点开必然打不开）。
  trash: { label: '回收站', tone: 'dim' }
};

/** P3b：回收站条目的到期文案（**只提示，绝不自动删** —— P3-D5 / A-P3-9）。 */
function vaultTrashExpiryText(item) {
  if (!item || !item.expiresAt) return '文件仍在 sessions（hidden=1），不会自动删除';
  if (item.expired) return '已超过保留期（仍不会自动删除，可还原或彻底删除）';
  var days = Number(item.expiresInDays);
  if (!Number.isFinite(days)) return '保留期内';
  if (days <= 0) return '今天到期（仍不会自动删除）';
  return '约 ' + days + ' 天后到期（不会自动删除）';
}

/**
 * P3 / FR-P3-2：检索范围的可读文案。与后端 searchScope 枚举一一对应（body / body+toolResults）。
 * 默认 body = 只检索正文；body+toolResults 额外含 tool/result 的**文本结果**（工具参数永不入库）。
 */
function vaultScopeLabel(scope) {
  return scope === 'body+toolResults'
    ? '正文 + 工具结果（含工具输出，可能含密钥）'
    : '正文（用户消息 + 助手回复 + 标题）';
}

/**
 * M7：列表 chip → /search 的 state 过滤值。
 * 语义与后端一致：archived = 在归档集合里但还没搬走；cold = 已搬进冷目录。
 * 收藏（favorite）的**搜索侧**不是状态：P3b 起收藏是独立的过滤面（/list 的 filter.favorite），
 * 这里只负责把 chip 映射成搜索的 state（收藏 = 不过滤状态，仍返回全部命中）。
 */
function vaultChipSearchState(chipId) {
  if (chipId === 'hot') return 'archived';
  if (chipId === 'cold') return 'cold';
  return '';
}

function vaultEscapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * M7：命中词高亮（<mark>）。tokens 来自 /search 的同一套分词结果，
 * 所以「搜什么、亮什么」与 FTS 命中的口径一致（大小写不敏感，长词优先）。
 */
function vaultHighlight(text, tokens) {
  var raw = String(text === null || text === undefined ? '' : text);
  var list = Array.isArray(tokens)
    ? tokens.map(function (token) { return String(token === null || token === undefined ? '' : token).trim(); }).filter(function (token) { return token.length > 0; })
    : [];
  if (!raw || !list.length) return raw;
  var ordered = list.slice().sort(function (a, b) { return b.length - a.length; });
  var pattern;
  try {
    pattern = new RegExp('(' + ordered.map(vaultEscapeRegExp).join('|') + ')', 'gi');
  } catch (err) {
    return raw;
  }
  var parts = raw.split(pattern);
  if (parts.length <= 1) return raw;
  var wanted = {};
  for (var i = 0; i < ordered.length; i += 1) wanted[ordered[i].toLowerCase()] = true;
  return parts.map(function (part, index) {
    if (!part) return null;
    if (!wanted[part.toLowerCase()]) return part;
    return h('mark', { key: 'vault-hit-' + index, style: { background: 'var(--dsh-warning-soft, #FFF7ED)', color: 'inherit', padding: '0 1px', borderRadius: 2 } }, part);
  });
}

/** P4（UI 档 §7）：主面板顶部两个 chip 的定义（顺序即展示顺序）。 */
var VAULT_VIEWS = [
  { id: 'archived', label: '归档会话' },
  { id: 'subagent', label: '子代理会话' }
];

var STATUS_META = {
  cold: { label: '冷存储', tone: 'cold' },
  'hot-archived': { label: '热归档', tone: 'hot' },
  hot: { label: '热', tone: 'hot' },
  'hot-restored': { label: '已恢复', tone: 'ok' },
  migrating: { label: '迁移中', tone: 'busy' },
  restoring: { label: '恢复中', tone: 'busy' },
  trash: { label: '回收站', tone: 'dim' }
};

function vaultIconSearch(size, color) {
  var s = size || 18;
  return h(
    'svg',
    { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    h('circle', { cx: '11', cy: '11', r: '7', stroke: color || 'currentColor', strokeWidth: '2' }),
    h('path', { d: 'M20 20l-4.2-4.2', stroke: color || 'currentColor', strokeWidth: '2', strokeLinecap: 'round' })
  );
}

/**
 * P4b3：侧栏面板行图标（保险柜箱体 + 表盘 + 底座）。
 *
 * 侧栏那一行是**面板**入口，不是搜索入口 —— 用放大镜会让人以为点开的是搜索
 * （正是本次要修的误读）。尺寸由宿主传入（宽侧栏 16 / 收起 18），线条只走 stroke。
 */
function vaultIconVault(size, color) {
  var s = size || 18;
  var stroke = color || 'currentColor';
  return h(
    'svg',
    { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    h('rect', { x: '3', y: '4.5', width: '18', height: '15', rx: '3', stroke: stroke, strokeWidth: '1.8' }),
    h('circle', { cx: '12', cy: '12', r: '3.4', stroke: stroke, strokeWidth: '1.8' }),
    h('path', { d: 'M12 8.6V12', stroke: stroke, strokeWidth: '1.8', strokeLinecap: 'round' }),
    h('path', { d: 'M6.6 19.5v1.4M17.4 19.5v1.4', stroke: stroke, strokeWidth: '1.8', strokeLinecap: 'round' })
  );
}

function formatBytes(bytes) {
  var n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  var units = ['KB', 'MB', 'GB', 'TB'];
  var value = n / 1024;
  var index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value = value / 1024;
    index += 1;
  }
  return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[index];
}

function formatAge(ms) {
  var value = Number(ms) || 0;
  if (!value) return '—';
  var diff = Date.now() - value;
  if (diff < 0) diff = 0;
  var minutes = Math.floor(diff / 60000);
  if (minutes < 60) return minutes + ' 分钟前';
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' 小时前';
  var days = Math.floor(hours / 24);
  return days + ' 天前';
}

function vaultStatusMeta(status) {
  return STATUS_META[status] || { label: status || '未知', tone: 'dim' };
}

function vaultToneColor(tone) {
  if (tone === 'cold') return { background: 'var(--dsh-accent-soft, #EEF2FF)', color: 'var(--dsh-accent, #4338CA)' };
  if (tone === 'hot') return { background: 'var(--dsh-warning-soft, #FFF7ED)', color: 'var(--dsh-warning, #C2410C)' };
  if (tone === 'ok') return { background: 'var(--dsh-success-soft, #ECFDF5)', color: 'var(--dsh-success, #047857)' };
  if (tone === 'busy') return { background: 'var(--dsh-info-soft, #EFF6FF)', color: 'var(--dsh-info, #1D4ED8)' };
  return { background: 'var(--dsh-surface-muted, #F3F4F6)', color: 'var(--dsh-text-muted, #6B7280)' };
}

function formatClock(ms) {
  var value = Number(ms) || 0;
  if (!value) return '—';
  var diff = value - Date.now();
  if (diff <= 0) return '即将';
  var minutes = Math.ceil(diff / 60000);
  if (minutes < 60) return minutes + ' 分钟后';
  return Math.round((minutes / 60) * 10) / 10 + ' 小时后';
}

function VaultResultBadge(props) {
  var meta = SEARCH_RESULT_STATES[props.state] || { label: props.state || '未知', tone: 'dim' };
  var tone = vaultToneColor(meta.tone);
  return h(
    'span',
    {
      style: {
        display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 8px', borderRadius: 10,
        fontSize: 12, fontWeight: 600, background: tone.background, color: tone.color
      }
    },
    meta.label
  );
}

/**
 * 搜索结果 → 动作：热 / 归档结果直接打开会话（uiWorkspace.openSession）；
 * 冷结果交给预览抽屉（不恢复、不打开会话）。
 */
function pickVaultSearchResult(group) {
  if (!group) return;
  if (group.state === 'cold') {
    requestVaultPreview(group);
    return;
  }
  openHotSession(group.sessionId);
}

var VAULT_TEXT = 'var(--dsh-text, #1F2937)';
var VAULT_MUTED = 'var(--dsh-text-muted, #6B7280)';
var VAULT_BORDER = 'var(--dsh-border, #E5E7EB)';
var VAULT_SURFACE = 'var(--dsh-surface, #FFFFFF)';
var VAULT_SURFACE_MUTED = 'var(--dsh-surface-muted, #F9FAFB)';

function vaultButtonStyle(primary, disabled) {
  return {
    height: 30,
    padding: '0 12px',
    borderRadius: 6,
    border: '1px solid ' + (primary ? 'transparent' : VAULT_BORDER),
    background: primary ? 'var(--dsh-accent, #4F46E5)' : VAULT_SURFACE,
    color: primary ? '#FFFFFF' : VAULT_TEXT,
    fontSize: 13,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    whiteSpace: 'nowrap'
  };
}

function VaultBadge(props) {
  var meta = vaultStatusMeta(props.status);
  var tone = vaultToneColor(meta.tone);
  return h(
    'span',
    {
      style: {
        display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 8px', borderRadius: 10,
        fontSize: 12, fontWeight: 600, background: tone.background, color: tone.color
      }
    },
    meta.label
  );
}

/**
 * 列表数据源（P4 起按 class 分域）。
 *
 * @param {string} [viewClass] 'subagent' 时请求 `/list {filter:{class:'subagent'}}`（候选 + 冷存）；
 *   其它值（含 undefined）走**默认视图** `/list {}` —— 请求形状与缓存行为保持原样（D-S5）。
 */
function useVaultList(viewClass) {
  var cls = viewClass === 'subagent' ? 'subagent' : 'archived';
  var state = React.useState({ loading: true, data: null, error: null });
  var inFlight = React.useRef(false);
  var refresh = React.useCallback(function () {
    if (inFlight.current) return;
    inFlight.current = true;
    state[1](function (prev) { return { loading: true, data: prev.data, error: null }; });
    var payload = cls === 'subagent' ? { filter: { class: 'subagent' } } : {};
    vaultApi('list', payload).then(function (data) {
      state[1]({ loading: false, data: data, error: null });
      inFlight.current = false;
    }).catch(function (err) {
      state[1](function (prev) { return { loading: false, data: prev.data, error: err }; });
      inFlight.current = false;
    });
  }, [cls]);
  React.useEffect(function () {
    refresh();
    var timer = window.setInterval(refresh, 15000);
    return function () { window.clearInterval(timer); };
  }, [cls]);
  return { state: state[0], refresh: refresh };
}

/**
 * 搜索 / 状态轮询（P2-3）：搜索走真实 /search（300ms 防抖）；状态用于索引进度与下次清扫。
 * 两者都不接管 sidebar.workspaces —— 只是本面板/覆盖层自己的数据源。
 */
function useVaultSearch(query, options) {
  var state = React.useState({ loading: false, data: null, error: null });
  var opts = options || {};
  // M7：chip（状态）与工作区下拉必须一起传给 /search（API 早已支持 workspace/state，旧 UI 只传 q/limit）。
  var stateFilter = opts.state ? String(opts.state) : '';
  var workspaceFilter = opts.workspace ? String(opts.workspace) : '';
  React.useEffect(function () {
    var q = String(query || '').trim();
    if (!q) {
      state[1]({ loading: false, data: null, error: null });
      return undefined;
    }
    var cancelled = false;
    state[1](function (prev) { return { loading: true, data: prev.data, error: null }; });
    var timer = window.setTimeout(function () {
      vaultApi('search', { q: q, limit: 30, state: stateFilter, workspace: workspaceFilter }).then(function (data) {
        if (!cancelled) state[1]({ loading: false, data: data, error: null });
      }).catch(function (err) {
        if (!cancelled) state[1]({ loading: false, data: null, error: err });
      });
    }, SEARCH_DEBOUNCE_MS);
    return function () {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // 筛选值进依赖：改 chip / 工作区必须重新发请求（旧实现只依赖 query）。
  }, [query, stateFilter, workspaceFilter]);
  return state[0];
}

function useVaultStatus() {
  var state = React.useState(null);
  React.useEffect(function () {
    var cancelled = false;
    function load() {
      vaultApi('status', {}).then(function (data) {
        if (!cancelled) state[1](data);
      }).catch(function () { /* 轮询失败保留上一次读数 */ });
    }
    load();
    var timer = window.setInterval(load, INDEX_PROGRESS_POLL_MS);
    return function () {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return state[0];
}

/** 跨组件（覆盖层 → 面板抽屉）的预览请求：极小的外部 store，避免把状态塞进 React 树。 */
var previewRequest = { item: null, seq: 0 };
var previewRequestListeners = [];

function notifyPreviewRequest() {
  var listeners = previewRequestListeners.slice();
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i](previewRequest); } catch (e) { /* 订阅者异常不影响广播 */ }
  }
}

function requestVaultPreview(item) {
  previewRequest = { item: item || null, seq: previewRequest.seq + 1 };
  notifyPreviewRequest();
  selectVaultPanel(ctxRef);
}

function subscribePreviewRequest(listener) {
  previewRequestListeners.push(listener);
  return function () {
    previewRequestListeners = previewRequestListeners.filter(function (fn) { return fn !== listener; });
  };
}

function usePreviewRequest() {
  var state = React.useState(previewRequest);
  React.useEffect(function () {
    state[1](previewRequest);
    return subscribePreviewRequest(function (next) { state[1](next); });
  }, []);
  return state[0];
}

function VaultSearchResults(props) {
  var data = props.data;
  var groups = data && Array.isArray(data.groups) ? data.groups : [];
  // M7：tokens 由 /search 回传（与 FTS 同一套分词），标题与 snippet 里的命中词都高亮。
  var tokens = props.tokens || (data && Array.isArray(data.tokens) ? data.tokens : []);
  if (!groups.length) {
    return h('div', { style: { padding: 16, color: VAULT_MUTED, fontSize: 13 } }, props.emptyText || '没有符合条件的会话');
  }
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column' } },
    groups.map(function (group) {
      return h('button', {
        key: group.sessionId,
        type: 'button',
        onClick: function () { props.onPick(group); },
        style: {
          display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 200px 76px', gap: 8, alignItems: 'center',
          width: '100%', textAlign: 'left', padding: '10px 16px', border: 'none',
          borderBottom: '1px solid ' + VAULT_BORDER, background: 'transparent', color: VAULT_TEXT, cursor: 'pointer', fontSize: 13
        }
      },
        h('div', { style: { minWidth: 0 } },
          h('div', { title: group.sessionId, style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, vaultHighlight(group.title || group.sessionId, tokens)),
          h('div', { style: { fontSize: 11, color: VAULT_MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            (group.workspace || '—') + ' · ' + (group.sessionId || '')),
          group.snippet
            ? h('div', { style: { fontSize: 12, color: VAULT_MUTED, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, vaultHighlight(group.snippet, tokens))
            : null
        ),
        // P3 / FR-P3-2：命中面标注（正文 / 工具结果）——**只加标注**，分组与 snippet 契约不变。
        h('span', { style: { minWidth: 0, display: 'flex', alignItems: 'center', gap: 4 } },
          h(VaultResultBadge, { state: group.state }),
          group.surfaces && group.surfaces.indexOf('tool-result') >= 0
            ? h('span', { style: { fontSize: 11, color: VAULT_MUTED } }, '工具结果')
            : null),
        h('span', { style: { color: VAULT_MUTED, fontSize: 12, textAlign: 'right' } }, group.state === 'cold' ? '预览' : '打开')
      );
    })
  );
}

/** 索引进度 + 暂停/恢复（P2-3 / P2-4；数据来自 /status 的 index 段）。 */
function VaultIndexProgress(props) {
  var index = props.index;
  if (!index) return null;
  var phaseLabels = { idle: '未开始', scanning: '扫描会话目录', indexing: '索引中', paused: '已暂停', done: '完成', error: '失败' };
  var total = Number(index.total) || 0;
  var indexed = Number(index.indexed) || 0;
  var percent = total > 0 ? Math.min(100, Math.round((indexed / total) * 100)) : 0;
  var running = index.phase === 'indexing' || index.phase === 'scanning';
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 16px', borderBottom: '1px solid ' + VAULT_BORDER, fontSize: 12, color: VAULT_MUTED } },
    h('span', null, '全文索引 ' + (phaseLabels[index.phase] || index.phase)),
    h('span', { style: { width: 140, height: 6, borderRadius: 3, background: VAULT_SURFACE_MUTED, overflow: 'hidden' }, 'aria-hidden': 'true' },
      h('span', { style: { display: 'block', width: percent + '%', height: '100%', background: 'var(--dsh-accent, #4F46E5)' } })
    ),
    h('span', null, indexed + ' / ' + total + '（' + percent + '%）'),
    index.phase === 'paused'
      ? h('button', { type: 'button', style: vaultButtonStyle(true, false), onClick: function () { props.onAction('resume'); } }, '恢复索引')
      : h('button', {
          type: 'button',
          disabled: !running,
          style: vaultButtonStyle(false, !running),
          onClick: function () { props.onAction('pause'); }
        }, '暂停索引')
  );
}

/**
 * 索引未覆盖会话（P3b.1 真机）。
 *
 * 背景：真实库固定有 29 个 extract-empty（v0 空壳/老格式）会让旧实现的「failed===0 才写回 schema」
 * 永远不成立 ⇒ 每次启动清水位全量重抽（永远跑不完）。现在确定性数据失败不阻塞 schema 写回，
 * 未覆盖会话落 meta index:schema-gaps ⇒ 就在这里出**黄条**「N 个会话未能索引（可重建）」，
 * 按钮走 /rebuild-index {action:"start"}（重扫 + 重试这些会话；定时轮询只会增量刷新，不会偷偷全量重置）。
 */
function VaultSchemaGaps(props) {
  var index = props.index;
  if (!index) return null;
  var gaps = Array.isArray(index.gaps) ? index.gaps : [];
  var count = Number(index.gapsCount);
  if (!Number.isFinite(count)) count = gaps.length;
  // 只有在「schema 已完成」时才是 gaps（版本未完成 ⇒ 由全量索引进度条负责，不重复喊）。
  var visible = index.doneWithGaps === true || (count > 0 && index.rebuildNeeded === false);
  if (!visible || count <= 0) return null;
  var reasons = {};
  for (var i = 0; i < gaps.length; i += 1) {
    var code = gaps[i] && gaps[i].error ? String(gaps[i].error) : 'unknown';
    reasons[code] = (reasons[code] || 0) + 1;
  }
  var reasonText = Object.keys(reasons).map(function (code) { return code + ' × ' + reasons[code]; }).join('、');
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 16px', fontSize: 12,
      background: 'var(--dsh-warning-soft, #FFF7ED)', color: 'var(--dsh-warning, #9A3412)', borderBottom: '1px solid ' + VAULT_BORDER
    }
  },
    h('span', { style: { fontWeight: 600 } }, count + ' 个会话未能索引（可重建）'),
    h('span', null,
      '这些会话的日志抽不出正文（' + (reasonText || '确定性数据失败') + '），已记为未覆盖；其它会话照常可搜。'
        + '索引 schema 已完成，重启不会重建。'),
    h('button', {
      type: 'button',
      style: vaultButtonStyle(true, false),
      onClick: function () { props.onAction('start'); }
    }, '重建（重试这些会话）')
  );
}

/**
 * 检索范围升级 pass 的读数与动作（P3a.1）。
 *
 * - M1：done-with-gaps / 仍有未覆盖会话 ⇒ **黄条**「N 个会话未覆盖（可重建）」，按钮走
 *   /rebuild-index {action:"resume-scope"}（显式重建，轮询不会偷偷重跑）；
 * - S4：scope pass 与全量索引的暂停**解耦** —— 这里给独立的「暂停范围升级 / 续做」动作。
 */
function VaultScopeProgress(props) {
  var scope = props.scope;
  if (!scope) return null;
  var gapsCount = Number(scope.gapsCount) || 0;
  var phase = scope.phase;
  var gapsVisible = gapsCount > 0 || phase === 'done-with-gaps';
  var running = phase === 'scanning' || phase === 'running' || phase === 'partial';
  if (!gapsVisible && !running && phase !== 'paused') return null;
  var baseStyle = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 16px', fontSize: 12 };
  if (gapsVisible) {
    return h('div', {
      style: Object.assign({}, baseStyle, {
        background: 'var(--dsh-warning-soft, #FFF7ED)', color: 'var(--dsh-warning, #9A3412)', borderBottom: '1px solid ' + VAULT_BORDER
      })
    },
      h('span', { style: { fontWeight: 600 } }, gapsCount + ' 个会话未覆盖（可重建）'),
      h('span', null,
        '检索范围「' + vaultScopeLabel(scope.searchScope) + '」有 ' + gapsCount + ' 个会话未能抽取工具结果（已自动重试 ' +
          (scope.round || scope.maxRounds || 3) + ' 轮）。库内范围仍是「' + vaultScopeLabel(scope.libraryScope) + '」，这些会话的正文照常可搜。'),
      h('button', {
        type: 'button',
        style: vaultButtonStyle(true, false),
        onClick: function () { props.onAction('resume-scope'); }
      }, '重建（续做）')
    );
  }
  return h('div', { style: Object.assign({}, baseStyle, { borderBottom: '1px solid ' + VAULT_BORDER, color: VAULT_MUTED }) },
    h('span', null,
      '检索范围升级' + (phase === 'paused' ? '（已暂停）' : '中') +
        (scope.total ? '：' + (scope.indexed || 0) + ' / ' + scope.total : '') +
        (scope.round ? '（第 ' + scope.round + ' / ' + (scope.maxRounds || 3) + ' 轮）' : '')),
    phase === 'paused'
      ? h('button', { type: 'button', style: vaultButtonStyle(true, false), onClick: function () { props.onAction('resume-scope'); } }, '续做范围升级')
      : h('button', { type: 'button', style: vaultButtonStyle(false, false), onClick: function () { props.onAction('pause-scope'); } }, '暂停范围升级')
  );
}


/* ===========================================================================
 * P4（设计档 §19 / UI 档 §7）：子代理会话冷存（class S）
 * =========================================================================== */

/**
 * 文案红线（UI 档 §7，用户实测反馈）：搬走之后宿主的可见性会变 —— 必须写清楚，
 * 否则用户会以为「会话丢了」。字面量定义在 src/ui/settings.tsx 的 SUBAGENT_RED_LINE
 * （单模块作用域 ⇒ 本页直接引用同一份，设置卡与子代理页只此一句）。
 */
/* class S 的暂停四原因（顺序即黄条展示顺序；与 sweeper 的 SUBAGENT_PAUSE_CODES 同序同码）。 */
var SUBAGENT_PAUSE_REASON_ORDER = ['subagent-refs-incomplete', 'cold-unavailable', 'cross-volume-disabled', 'restoring-unsettled'];
var SUBAGENT_PAUSE_REASON_TEXT = {
  'subagent-refs-incomplete': '引用快照不可信（缺失 / 超过 24h / gaps 非空）⇒ 一个都不搬（I-18）',
  'cold-unavailable': '冷存储根全部不可访问（只读降级，不搬移）',
  'cross-volume-disabled': '冷根与 sessions 跨卷且未开启 allowCrossVolume',
  'restoring-unsettled': '仍有会话在恢复中（收敛前不开始新的迁移）'
};
/** 子代理页的状态文案（UI 档 §7：hot-subagent → 热·可迁移；cold → 冷存）。 */
var SUBAGENT_STATUS_LABELS = { 'hot-subagent': '热·可迁移', cold: '冷存' };

function vaultSubagentStatusLabel(item) {
  if (!item) return '—';
  return SUBAGENT_STATUS_LABELS[item.status] || item.status || '—';
}

/**
 * 子代理行按 class 分域（data.items 里 status 已经由引擎标好，这里只分组）。
 *
 * 额外再过一遍 class === 'subagent'：切视图的一瞬间 `items` 还可能是**上一视图**的数据
 * （useVaultList 保留旧 data 直到新请求返回），没有这道闸，class A 的冷行会被当成
 * 「已冷存」显示在子代理页里（行操作还会给「恢复」，指向错的对象）。
 */
function vaultSubagentSections(items) {
  var list = Array.isArray(items) ? items : [];
  var scoped = list.filter(function (item) { return Boolean(item) && item.class === 'subagent'; });
  return {
    candidates: scoped.filter(function (item) { return item.status === 'hot-subagent'; }),
    cold: scoped.filter(function (item) { return item.status === 'cold'; })
  };
}

/**
 * 暂停 / 缺口黄条（UI 档 §7：**四条原因全列**；gaps 逐条列出 id 与原因 + 「重新扫描」）。
 * 不做静默豁免：修好坏目录后重新扫描，gaps 清零即自动解除。
 */
function VaultSubagentPauseBanner(props) {
  var sub = props.subagent || null;
  if (!sub) return null;
  var gaps = Array.isArray(sub.scanGaps) ? sub.scanGaps : [];
  var paused = Boolean(sub.paused);
  if (!paused && !gaps.length) return null;
  var reasonCode = sub.pauseReason && sub.pauseReason.code ? sub.pauseReason.code : null;
  return h('div', {
    style: {
      padding: '8px 16px', fontSize: 12, lineHeight: 1.7,
      background: 'var(--dsh-warning-soft, #FFF7ED)', color: 'var(--dsh-warning, #9A3412)',
      borderBottom: '1px solid ' + VAULT_BORDER
    }
  },
    h('div', { style: { fontWeight: 600 } },
      '子代理冷存已暂停（一个都不会搬）' + (reasonCode ? '：' + reasonCode : '')),
    h('div', null,
      '四条可能原因（全部列出）：' + SUBAGENT_PAUSE_REASON_ORDER.map(function (code) {
        return code + ' = ' + SUBAGENT_PAUSE_REASON_TEXT[code];
      }).join('；')),
    gaps.length
      ? h('div', null,
          '缺口 ' + gaps.length + ' 个（修好/移走坏目录后重新扫描即自动解除）：' + gaps.map(function (gap) {
            return (gap && gap.id ? gap.id : '?') + '（' + (gap && gap.reason ? gap.reason : 'unknown') + '）';
          }).join('、'))
      : null,
    h('button', {
      type: 'button',
      disabled: Boolean(props.busy),
      style: Object.assign(vaultButtonStyle(true, Boolean(props.busy)), { marginTop: 6, height: 24 }),
      onClick: function () { if (typeof props.onRescan === 'function') props.onRescan(); }
    }, '重新扫描')
  );
}

/** 子代理页的一段（候选 / 已冷存）：标题 + 空态 + 行操作。 */
function VaultSubagentSection(props) {
  var items = Array.isArray(props.items) ? props.items : [];
  return h('div', { style: { display: 'flex', flexDirection: 'column' } },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, padding: '10px 16px 6px', fontSize: 12, fontWeight: 600, color: VAULT_TEXT } },
      h('span', null, props.title + '（' + items.length + '）'),
      h('span', { style: { fontWeight: 400, color: VAULT_MUTED } }, props.hint || '')),
    items.length === 0
      ? h('div', { style: { padding: '10px 16px 16px', fontSize: 12, color: VAULT_MUTED } }, props.emptyText || '没有符合条件的子代理会话')
      : items.map(function (item) {
          return h('div', {
            key: (props.title || 'sub') + '-' + item.id,
            style: {
              display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) 120px 78px 84px 84px 210px', gap: 8,
              padding: '10px 16px', borderBottom: '1px solid ' + VAULT_BORDER, alignItems: 'center', fontSize: 13
            }
          },
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.id }, item.title || item.id),
              h('div', { style: { fontSize: 11, color: VAULT_MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.id },
                item.error ? '⚠ ' + item.error : (item.id || ''))),
            h('span', { style: { color: VAULT_MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.workspace || '—'),
            h('span', null, formatBytes(item.sizeBytes)),
            h('span', { style: { color: VAULT_MUTED } }, formatAge(item.lastActiveAt)),
            h('span', { style: { fontSize: 12, fontWeight: 600 } }, vaultSubagentStatusLabel(item)),
            h('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
              item.status === 'hot-subagent'
                ? h('button', { type: 'button', disabled: Boolean(props.busy), style: vaultButtonStyle(true, Boolean(props.busy)), onClick: function () { props.onMigrate(item); } }, '迁移')
                : null,
              item.status === 'cold'
                ? h('button', { type: 'button', disabled: Boolean(props.busy), style: vaultButtonStyle(true, Boolean(props.busy)), onClick: function () { props.onRestore(item); } }, '恢复')
                : null,
              h('button', { type: 'button', style: vaultButtonStyle(false, false), onClick: function () { props.onPreview(item); } }, '预览')
            )
          );
        })
  );
}

/**
 * 子代理页（UI 档 §7）：顶部文案红线 + 暂停/缺口黄条 + 两段（候选 / 已冷存）+ 两个入口按钮。
 * 数据全部来自 /list（class=subagent）的 items 与 subagent 段；不接管 sidebar.workspaces。
 */
function VaultSubagentPage(props) {
  var sections = vaultSubagentSections(props.items);
  var sub = props.subagent || {};
  var ageDays = sub.ageDays === undefined || sub.ageDays === null ? 14 : sub.ageDays;
  var emptyCandidateText = '没有符合条件的子代理会话' + (ageDays === 0 ? '（阈值 0 = 关闭子代理冷存）' : '（阈值 ' + ageDays + ' 天：未登记 + 未被引用 + 超过 ' + ageDays + ' 天未活跃才进候选）');
  return h('div', { style: { display: 'flex', flexDirection: 'column' } },
    h('div', { style: { padding: '8px 16px', fontSize: 12, lineHeight: 1.7, color: VAULT_MUTED, borderBottom: '1px solid ' + VAULT_BORDER } },
      SUBAGENT_RED_LINE),
    h(VaultSubagentPauseBanner, { subagent: sub, busy: props.busy, onRescan: props.onRescan }),
    // 子代理列表还没到手时给「加载中…」，绝不把上一视图的数据（或空态）当成结论。
    props.loading
      ? h('div', { style: { padding: 24, fontSize: 13, color: VAULT_MUTED } }, '加载中…')
      : props.error
        ? h('div', { style: { padding: 24, fontSize: 13, color: 'var(--dsh-danger, #B91C1C)' } },
            '子代理列表加载失败：' + (props.error.message || '未知原因'))
        : h('div', { style: { display: 'flex', flexDirection: 'column' } },
            h(VaultSubagentSection, {
              title: '候选（热）',
              hint: '行操作 = 迁移（二次确认在本页顶部）',
              items: sections.candidates,
              emptyText: emptyCandidateText,
              busy: props.busy,
              onMigrate: props.onMigrate,
              onRestore: props.onRestore,
              onPreview: props.onPreview
            }),
            h(VaultSubagentSection, {
              title: '已冷存',
              hint: '行操作 = 恢复 / 预览（不打开会话）',
              items: sections.cold,
              emptyText: '还没有已冷存的子代理会话',
              busy: props.busy,
              onMigrate: props.onMigrate,
              onRestore: props.onRestore,
              onPreview: props.onPreview
            }))
  );
}

function VaultPanel() {
  /** P4（UI 档 §7）：顶部两个 chip —— 归档会话（默认，行为不变）/ 子代理会话。 */
  var view = React.useState('archived');
  var vaultList = useVaultList(view[0]);
  var selection = React.useState({});
  var filter = React.useState('all');
  var workspace = React.useState('all');
  var query = React.useState('');
  var preview = React.useState(null);
  var notice = React.useState(null);
  var busy = React.useState(false);
  var settingsOpen = React.useState(false);
  /** P3b：列表滚动位移与回收站/诊断抽屉（都是本面板自己的数据源，不接管 sidebar.workspaces）。 */
  var listScroll = React.useState(0);
  var trashOpen = React.useState(false);
  var trashData = React.useState(null);
  var diagnoseOpen = React.useState(false);
  var diagnoseData = React.useState(null);
  var repairPlan = React.useState(null);
  /** P2-3：真实全文搜索（面板顶部搜索栏 + Ctrl/Cmd+Shift+K 覆盖层共用同一条 /search）。 */
  // M7：chip（状态）与工作区下拉都作为筛选传给 /search（在面板内即筛，不再只过滤本地列表）。
  var search = useVaultSearch(query[0], {
    state: vaultChipSearchState(filter[0]),
    workspace: workspace[0] === 'all' ? '' : workspace[0]
  });
  var status = useVaultStatus();
  var previewReq = usePreviewRequest();

  var data = vaultList.state.data;
  var statusIndex = status && status.index ? status.index : null;
  var statusScope = status && status.scope ? status.scope : null;
  var statusSweep = status && status.sweep ? status.sweep : null;
  var items = data && Array.isArray(data.items) ? data.items : [];
  var selectedIds = Object.keys(selection[0]).filter(function (id) { return selection[0][id]; });
  /** P4：class S 的读数（列表段的 subagent 优先，其次 /status.subagent —— 同一份引擎口径）。 */
  var subagentSummary = (data && data.subagent) || (status && status.subagent) || null;
  var subagentView = view[0] === 'subagent';
  var subagentJob = subagentSummary && subagentSummary.job ? subagentSummary.job : null;

  function toggle(id) {
    selection[1](function (prev) {
      var next = {};
      Object.keys(prev).forEach(function (key) { next[key] = prev[key]; });
      next[id] = !next[id];
      return next;
    });
  }

  function setNotice(tone, text) {
    notice[1]({ tone: tone, text: text });
  }

  function runAction(method, ids, verb) {
    if (!ids.length || busy[0]) return;
    busy[1](true);
    setNotice('info', verb + '中…（' + ids.length + ' 项）');
    vaultApi(method, { ids: ids }).then(function (result) {
      var results = result && Array.isArray(result.results) ? result.results : [];
      var failed = results.filter(function (row) { return !row.ok; });
      var ok = results.length - failed.length;
      if (failed.length) {
        setNotice('warning', verb + '：成功 ' + ok + ' / 失败 ' + failed.length + ' —— ' + (failed[0].error || failed[0].code || '未知原因'));
      } else {
        setNotice('success', verb + '：成功 ' + ok + ' 项');
      }
      selection[1]({});
      vaultList.refresh();
    }).catch(function (err) {
      setNotice('error', verb + '失败：' + err.message);
    }).then(function () { busy[1](false); });
  }

  var visible = items.filter(function (item) {
    if (filter[0] === 'hot' && item.status !== 'hot-archived') return false;
    if (filter[0] === 'cold' && item.status !== 'cold') return false;
    if (filter[0] === 'favorite' && !item.favorite) return false;
    if (workspace[0] !== 'all' && item.workspace !== workspace[0]) return false;
    var needle = query[0].trim().toLowerCase();
    if (needle && String(item.title || '').toLowerCase().indexOf(needle) === -1) return false;
    return true;
  });
  var allSelected = visible.length > 0 && visible.every(function (item) { return selection[0][item.id]; });
  var stats = (data && data.stats) || {};
  var banners = (data && data.banners) || {};
  // 真实读数（旧代码是桩：coldRootAvailable 恒 true、am 恒 null）：
  var coldUnavailable = Boolean(banners.coldUnavailable);
  var coldRoots = Array.isArray(banners.coldRoots) ? banners.coldRoots : [];
  var amBanner = banners.am || null;
  var overlayBanner = banners.overlay || null;
  var overlaySeat = useOverlaySeat();
  var overlayMissing = overlaySeat.status === 'missing';
  var overlayDrifted = Boolean(overlayBanner && overlayBanner.drifted);
  // F2/F4（P2.3）：包装「宿主形状不支持」与「自动重装已停手」是两种故障，横幅必须分开说。
  var overlayRepairFailed = Boolean(overlayBanner && overlayBanner.repairFailed);
  var overlayUnsupported = Boolean(overlayBanner && overlayBanner.supported === false);
  var overlayShape = overlayBanner && overlayBanner.shape ? overlayBanner.shape : null;
  var statusBoot = status && status.boot ? status.boot : null;

  function openPreview(item) {
    var id = item && (item.id || item.sessionId);
    if (!id) return;
    var normalized = Object.assign({}, item, { id: id });
    preview[1]({ item: normalized, body: null, error: null, loading: true });
    vaultApi('preview', { id: id, limit: 20 }).then(function (result) {
      preview[1]({ item: normalized, body: result, error: null, loading: false });
    }).catch(function (err) {
      preview[1]({ item: normalized, body: null, error: err, loading: false });
    });
  }

  // 覆盖层/搜索结果点「冷存」→ requestVaultPreview → 这里打开同一个抽屉（不恢复、不打开会话）
  React.useEffect(function () {
    var req = previewReq;
    if (!req || !req.item || !req.seq) return;
    openPreview(req.item);
  }, [previewReq && previewReq.seq]);

  /**
   * FR-P3-6 / UI 档 §5：**Esc 关闭预览抽屉**（键盘可达性）。
   * 只在抽屉打开时挂监听，关闭即摘掉；捕获阶段监听，避免被宿主的输入框吞掉。
   */
  React.useEffect(function () {
    if (!preview[0]) return undefined;
    function onKey(event) {
      if (event && event.key === 'Escape') {
        event.preventDefault();
        preview[1](null);
      }
    }
    try {
      window.addEventListener('keydown', onKey, true);
    } catch (err) {
      return undefined;
    }
    return function () {
      try { window.removeEventListener('keydown', onKey, true); } catch (err) { /* 摘监听失败不影响功能 */ }
    };
  }, [preview[0] ? 1 : 0]);

  /** P3b：收藏 / 取消收藏（逐 id 串行，失败逐条记；成功后刷新列表并按「收藏优先」重排）。 */
  function setFavorite(ids, favorite) {
    if (!ids.length || busy[0]) return;
    busy[1](true);
    var verb = favorite ? '收藏' : '取消收藏';
    setNotice('info', verb + '中…（' + ids.length + ' 项）');
    var failed = [];
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        return vaultApi('favorite', { id: id, favorite: favorite }).catch(function (err) {
          failed.push({ id: id, error: err.message });
        });
      });
    });
    chain.then(function () {
      if (failed.length) setNotice('warning', verb + '：失败 ' + failed.length + ' / ' + ids.length + ' —— ' + failed[0].error);
      else setNotice('success', verb + '：成功 ' + ids.length + ' 项');
      selection[1]({});
      vaultList.refresh();
    }).then(function () { busy[1](false); });
  }

  function loadTrash() {
    vaultApi('trash', {}).then(function (data) {
      trashData[1](data);
    }).catch(function (err) {
      setNotice('error', '回收站读取失败：' + err.message);
    });
  }

  function openTrash() {
    var next = !trashOpen[0];
    trashOpen[1](next);
    if (next) loadTrash();
  }

  function restoreFromTrash(item) {
    if (!item || busy[0]) return;
    busy[1](true);
    vaultApi('trash-restore', { ids: [item.id] }).then(function (data) {
      var rows = data && Array.isArray(data.results) ? data.results : [];
      var row = rows[0] || {};
      if (row.ok) setNotice('success', '已还原：' + item.id + '（再归档后可重新迁移）');
      else setNotice('error', '还原失败：' + (row.error || row.code || '未知原因'));
      loadTrash();
      vaultList.refresh();
    }).catch(function (err) {
      setNotice('error', '还原失败：' + err.message);
    }).then(function () { busy[1](false); });
  }

  function purgeFromTrash(item) {
    if (!item || busy[0]) return;
    var ok = false;
    try {
      // 二次确认（I-12 / P3-D5）：这是全设计唯一不可逆的 unlink。
      ok = window.confirm('彻底删除「' + (item.title || item.id) + '」？这会把回收站里的文件真正删掉，无法还原。');
    } catch (err) {
      ok = false;
    }
    if (!ok) {
      setNotice('warning', '彻底删除已取消（未写入任何东西）');
      return;
    }
    busy[1](true);
    vaultApi('trash-purge', { id: item.id, confirm: true }).then(function (data) {
      var rows = data && Array.isArray(data.results) ? data.results : [];
      var row = rows[0] || {};
      if (row.ok) setNotice('success', '已彻底删除：' + item.id);
      else setNotice('error', '彻底删除失败：' + (row.error || row.code || '未知原因'));
      loadTrash();
      vaultList.refresh();
    }).catch(function (err) {
      setNotice('error', '彻底删除失败：' + err.message);
    }).then(function () { busy[1](false); });
  }

  function openDiagnose() {
    var next = !diagnoseOpen[0];
    diagnoseOpen[1](next);
    repairPlan[1](null);
    if (!next) return;
    vaultApi('diagnose', {}).then(function (data) {
      diagnoseData[1](data);
    }).catch(function (err) {
      setNotice('error', '诊断失败：' + err.message);
    });
  }

  /** dry-run 预览（服务端 apply:false ⇒ 零写入）。 */
  function dryRunRepair() {
    vaultApi('repair', { apply: false }).then(function (data) {
      repairPlan[1](data);
    }).catch(function (err) {
      setNotice('error', 'dry-run 失败：' + err.message);
    });
  }

  /** 逐项确认后 apply（服务端幂等；失败即停）。 */
  function applyRepair(item) {
    if (!item || busy[0]) return;
    var ok = false;
    try {
      ok = window.confirm('应用这一项修复？' + String.fromCharCode(10) + (item.check || '') + ' · ' + (item.action || '') + String.fromCharCode(10) + (item.summary || ''));
    } catch (err) {
      ok = false;
    }
    if (!ok) {
      setNotice('warning', '已取消该项修复（未写入任何东西）');
      return;
    }
    busy[1](true);
    vaultApi('repair', { checks: [item.id], apply: true }).then(function (data) {
      var applied = data && Array.isArray(data.applied) ? data.applied : [];
      if (data && data.ok) setNotice('success', '已修复 ' + applied.length + ' 项（manifest 记 op:repair）');
      else setNotice('error', '修复失败：' + ((data && data.failed && data.failed.error) || (data && data.error) || '未知原因'));
      return vaultApi('diagnose', {}).then(function (next) { diagnoseData[1](next); });
    }).catch(function (err) {
      setNotice('error', '修复失败：' + err.message);
    }).then(function () { busy[1](false); });
  }

  /** P4（UI 档 §7）：主面板的两个子代理入口 —— 立即扫描 / 迁移候选（都能在这里取消）。 */
  function runSubagentScan() {
    if (busy[0]) return;
    busy[1](true);
    setNotice('info', '扫描中…（只读遍历会话目录，不改任何文件）');
    vaultApi('subagent-scan', { action: 'start' }).then(function (data) {
      var scan = data && data.scan ? data.scan : null;
      setNotice(
        'success',
        '扫描完成' + (scan ? '：' + (scan.scanned || 0) + ' 个目录 / 缺口 ' + ((scan.gaps || []).length) + ' 个' + (scan.tookMs ? '（' + Math.round(scan.tookMs / 1000) + 's）' : '') : ''),
      );
      vaultList.refresh();
    }).catch(function (err) {
      setNotice('error', '扫描失败：' + err.message);
    }).then(function () { busy[1](false); });
  }

  function migrateSubagentRows(rows) {
    var list = Array.isArray(rows) ? rows : [];
    if (!list.length || busy[0]) return;
    var bytes = list.reduce(function (sum, item) { return sum + (Number(item.sizeBytes) || 0); }, 0);
    var ok = false;
    try {
      // 二次确认：必须列出数量与字节（UI 档 §7 / §19.11）
      ok = window.confirm(
        '把 ' + list.length + ' 个子代理会话（' + formatBytes(bytes) + '）搬到冷存？' +
          String.fromCharCode(10) + SUBAGENT_RED_LINE,
      );
    } catch (err) {
      ok = false;
    }
    if (!ok) {
      setNotice('warning', '迁移已取消（未写入任何东西）');
      return;
    }
    busy[1](true);
    setNotice('info', '已请求迁移 ' + list.length + ' 项…');
    vaultApi('subagent-migrate', { ids: list.map(function (item) { return item.id; }), confirm: true }).then(function (result) {
      var job = result && result.job ? result.job : null;
      setNotice('info', '批量迁移已启动' + (job ? '：0 / ' + (job.total || list.length) : '') + '（可取消；进度见本页读数条）');
      selection[1]({});
      vaultList.refresh();
    }).catch(function (err) {
      setNotice('error', '迁移失败：' + err.message);
    }).then(function () { busy[1](false); });
  }

  function migrateSubagentRow(item) {
    migrateSubagentRows([item]);
  }

  function migrateAllSubagentCandidates() {
    var sub = subagentSummary || {};
    var count = Number(sub.candidates) || 0;
    var bytes = Number(sub.candidatesBytes) || 0;
    if (!count) {
      setNotice('info', '当前没有可迁移的子代理候选（先「立即扫描」或放宽阈值）');
      return;
    }
    var ok = false;
    try {
      ok = window.confirm(
        '把 ' + count + ' 个候选（' + formatBytes(bytes) + '）搬到冷存？' +
          String.fromCharCode(10) + SUBAGENT_RED_LINE,
      );
    } catch (err) {
      ok = false;
    }
    if (!ok) {
      setNotice('warning', '迁移已取消（未写入任何东西）');
      return;
    }
    busy[1](true);
    vaultApi('subagent-migrate', { all: true, confirm: true }).then(function (result) {
      var job = result && result.job ? result.job : null;
      setNotice('info', '批量迁移已启动' + (job ? '：0 / ' + (job.total || count) : '') + '（可取消）');
      vaultList.refresh();
    }).catch(function (err) {
      setNotice('error', '迁移失败：' + err.message);
    }).then(function () { busy[1](false); });
  }

  function cancelSubagentJob() {
    vaultApi('subagent-job', { action: 'cancel' }).then(function (result) {
      setNotice('info', result && result.ok ? '已请求取消批量迁移（在飞的一条会跑完，不会半途删源）' : '当前没有在跑的批量迁移');
      vaultList.refresh();
    }).catch(function (err) {
      setNotice('error', '取消失败：' + err.message);
    });
  }

  function runIndexAction(action) {
    // S4 / M1：全量索引与检索范围升级各有自己的动作（暂停解耦；resume-scope 兼作 done-with-gaps 的重建）
    var labels = {
      pause: '已请求暂停全量索引',
      resume: '已请求恢复全量索引',
      start: '已请求重新扫描会话目录',
      'pause-scope': '已请求暂停检索范围升级',
      'resume-scope': '已请求续做检索范围升级'
    };
    vaultApi('rebuild-index', { action: action }).then(function () {
      setNotice('success', labels[action] || ('已请求 ' + action));
      if (action === 'resume-scope') vaultList.refresh();
    }).catch(function (err) {
      setNotice('error', '索引操作失败：' + err.message);
    });
  }

  var chips = [
    { id: 'all', label: '全部' },
    { id: 'hot', label: '热归档' },
    { id: 'cold', label: '冷存储' },
    { id: 'favorite', label: '收藏' }
  ];
  var workspaces = (data && Array.isArray(data.workspaces) ? data.workspaces : []).slice();

  /**
   * FR-P3-6 / P3-D7 / A-P3-6：列表 **>200 行窗口化**（纯函数 windowRange，与 node --test 同一份源码）。
   * 固定行高 VIRTUAL_ROW_HEIGHT —— 行的 style 必须真的锁成这个高度，否则占位高度与真实高度不符。
   * 表头也在同一个滚动容器里（约 33px），这点偏移由「上下各 20 行」的 overscan 吸收。
   */
  var viewportHeight = 520;
  try {
    if (typeof window !== 'undefined' && window.innerHeight) viewportHeight = Math.max(240, window.innerHeight - 360);
  } catch (err) {
    viewportHeight = 520;
  }
  var virtualRange = windowRange(visible.length, listScroll[0], viewportHeight);
  var renderedRows = visible.slice(virtualRange.start, virtualRange.end);

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: VAULT_SURFACE, color: VAULT_TEXT } },

    // 顶部 50px 全宽大搜索栏（设计档 §10 / D22）
    h(
      'div',
      {
        style: {
          height: SEARCH_BAR_HEIGHT, minHeight: SEARCH_BAR_HEIGHT, display: 'flex', alignItems: 'center', gap: 10,
          padding: '0 16px', borderBottom: '1px solid ' + VAULT_BORDER, background: VAULT_SURFACE
        }
      },
      h('span', { style: { display: 'flex', color: VAULT_MUTED } }, vaultIconSearch(18)),
      h('input', {
        type: 'search',
        value: query[0],
        placeholder: SEARCH_PLACEHOLDER,
        'aria-label': '搜索会话',
        onChange: function (event) { query[1](event.target.value); },
        onKeyDown: function (event) {
          if (event.key === 'Enter') {
            event.preventDefault();
            // 评审 #7：**有查询词**时回车打开搜索结果的第一条（走 pickVaultSearchResult：
            // 热结果直接打开、冷结果开预览抽屉）；只有查询词为空时才回退到可见列表第一条。
            var groups = search.data && Array.isArray(search.data.groups) ? search.data.groups : [];
            if (query[0].trim()) {
              if (groups.length) pickVaultSearchResult(groups[0]);
            } else if (visible.length) {
              openPreview(visible[0]);
            }
          }
          if (event.key === 'Escape') query[1]('');
        },
        style: {
          flex: 1, height: '100%', minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
          fontSize: 16, color: VAULT_TEXT
        }
      }),
      h('kbd', { title: '全局呼出快捷键', style: { fontSize: 11, color: VAULT_MUTED, border: '1px solid ' + VAULT_BORDER, borderRadius: 4, padding: '2px 6px', whiteSpace: 'nowrap' } }, SEARCH_SHORTCUT_HINT)
    ),

    // P4（UI 档 §7）：顶部两个 chip —— 归档会话（默认，行为不变）/ 子代理会话
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid ' + VAULT_BORDER } },
      VAULT_VIEWS.map(function (entry) {
        var active = view[0] === entry.id;
        return h('button', {
          key: 'view-' + entry.id,
          type: 'button',
          onClick: function () { view[1](entry.id); selection[1]({}); },
          style: Object.assign(vaultButtonStyle(false, false), {
            background: active ? 'var(--dsh-accent-soft, #EEF2FF)' : VAULT_SURFACE,
            color: active ? 'var(--dsh-accent, #4338CA)' : VAULT_TEXT,
            borderColor: active ? 'transparent' : VAULT_BORDER
          })
        }, entry.label);
      })
    ),

    // 统计
    h(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: 16, padding: '10px 16px', borderBottom: '1px solid ' + VAULT_BORDER, fontSize: 12, color: VAULT_MUTED } },
      h('span', null, '归档 ' + (stats.archived || 0)),
      h('span', null, '热归档 ' + (stats.hotArchived || 0)),
      h('span', null, '冷存储 ' + (stats.cold || 0)),
      h('span', null, '冷占用 ' + formatBytes(stats.bytesCold)),
      h('span', null, '阈值 ' + (stats.archiveAgeDays === undefined || stats.archiveAgeDays === null ? '—' : stats.archiveAgeDays + ' 天')),
      h('span', null, '自动迁移 ' + (stats.autoMigrate ? '开（下一次清扫按阈值执行）' : '关（观察模式）')),
      h('span', null, '待迁 ' + (stats.pendingCount || 0) + ' 个 / ' + formatBytes(stats.pendingBytes)),
      h('span', null, '下次清扫 ' + (statusSweep && statusSweep.nextRunAt ? formatClock(statusSweep.nextRunAt) : '—')),
      statusSweep && statusSweep.paused && statusSweep.pauseReason
        ? h('span', { style: { color: 'var(--dsh-warning, #C2410C)' } }, '清扫暂停：' + (statusSweep.pauseReason.message || statusSweep.pauseReason.code))
        : null,
      data && data.degraded ? h('span', { style: { color: 'var(--dsh-warning, #C2410C)' } }, '列表降级：' + data.degraded) : null
    ),

    // P4：子代理页的读数条（候选 / 已冷存 / 上次扫描 / 阈值 / 自动开关 / 批量进度）
    subagentView
      ? h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, padding: '10px 16px', borderBottom: '1px solid ' + VAULT_BORDER, fontSize: 12, color: VAULT_MUTED } },
          h('span', null, '子代理候选 ' + ((subagentSummary && subagentSummary.candidates) || 0) + ' 个 / ' + formatBytes(subagentSummary ? subagentSummary.candidatesBytes : 0)),
          h('span', null, '已冷存 ' + ((subagentSummary && subagentSummary.cold) || 0) + ' 个 / ' + formatBytes(subagentSummary ? subagentSummary.coldBytes : 0)),
          h('span', null, '上次扫描 ' + (subagentSummary && subagentSummary.scanAt ? formatAge(subagentSummary.scanAt) : '—')),
          h('span', null, '阈值 ' + (subagentSummary && subagentSummary.ageDays !== undefined && subagentSummary.ageDays !== null ? subagentSummary.ageDays + ' 天' : '—')),
          h('span', null, '自动清扫 ' + (subagentSummary && subagentSummary.migrateEffective ? '开' : '关（默认关）')),
          subagentJob
            ? h('span', null,
                '批量迁移 ' + (subagentJob.done || 0) + ' / ' + (subagentJob.total || 0) + '（' + (subagentJob.progress || 0) + '%）· 成功 ' + (subagentJob.migrated || 0) + ' / 失败 ' + (subagentJob.failed || 0) +
                  (subagentJob.cancelled ? ' · 已取消' : '') + (subagentJob.interrupted ? ' · 上次批量中断（可重跑）' : ''))
            : null,
          subagentJob && subagentJob.running
            ? h('button', { type: 'button', style: vaultButtonStyle(false, false), onClick: cancelSubagentJob }, '取消批量迁移')
            : null
        )
      : null,

    // 全量索引进度 + 暂停/恢复（P2-3；数据来自 /status 的 index 段）
    h(VaultIndexProgress, { index: statusIndex, onAction: runIndexAction }),

    // 索引未覆盖会话黄条（P3b.1：确定性数据失败 ⇒ schema 照写回，这些会话单独提示 + 手动重建入口）
    h(VaultSchemaGaps, { index: statusIndex, onAction: runIndexAction }),

    // 检索范围升级 pass 的进度 / 未覆盖黄条（P3a.1：M1 gaps + S4 独立暂停续做）
    h(VaultScopeProgress, { scope: statusScope, onAction: runIndexAction }),

    // 横幅（外部取消归档 / 冷目录不可用 / AM）
    banners.externalUnarchived
      ? h('div', { style: { padding: '8px 16px', background: 'var(--dsh-warning-soft, #FFF7ED)', color: 'var(--dsh-warning, #9A3412)', fontSize: 13 } },
          banners.externalUnarchived + ' 个冷会话已被外部取消归档（cold ⇒ 归档集合，I-11）。',
          h('button', {
            type: 'button',
            style: Object.assign(vaultButtonStyle(true, busy[0]), { marginLeft: 10, height: 24 }),
            disabled: busy[0],
            onClick: function () { runAction('restore', banners.externalUnarchivedIds || [], '恢复'); }
          }, '一键恢复'))
      : null,
    coldUnavailable
      ? h('div', { style: { padding: '8px 16px', background: 'var(--dsh-warning-soft, #FFF7ED)', color: 'var(--dsh-warning, #9A3412)', fontSize: 13 } },
          '冷存储目录不可用：' + (coldRoots.length ? coldRoots.map(function (item) { return item.root; }).join(' / ') : '（未配置）') + '（只读模式，不会删除任何数据）')
      : null,
    amBanner
      ? h('div', { style: { padding: '8px 16px', background: 'var(--dsh-warning-soft, #FFF7ED)', color: 'var(--dsh-warning, #9A3412)', fontSize: 13 } },
          '检测到 archive-manager（' + ((amBanner.matches || []).map(function (item) { return item.id; }).join(', ') || '已安装') + '），自动清扫已暂停（AC-9 / A-18：它会删除缺失工件的归档标记）。归档时间在下次启动时回填；取消归档不会自动搬回（透明水合不生效）。')
      : null,
    overlayDrifted || overlayRepairFailed || overlayUnsupported
      ? h('div', { style: { padding: '8px 16px', background: 'var(--dsh-warning-soft, #FFF7ED)', color: 'var(--dsh-warning, #9A3412)', fontSize: 13 } },
          overlayUnsupported
            ? '归档追踪不可用：宿主 workspaceRegistry 的归档方法无法被本插件包装（形状 ' + (overlayShape || 'unsupported') + '：' + (overlayBanner.reason || 'set-ineffective') + '）。archivedAt 记录与「取消归档时透明水合」不生效；已停止自动重装以免抖动。修复后可 POST /session-vault/api/diag {"action":"retry-overlay"} 手动重试。'
            : overlayRepairFailed
              ? '归档包装持续漂移：已自动重装 ' + (overlayBanner.reinstalls || 0) + ' 次仍未恢复（' + (overlayBanner.reason || 'drifted') + '），自动重装已停止。可 POST /session-vault/api/diag {"action":"retry-overlay"} 手动重试。'
              : '归档包装已被其它插件覆盖：archivedAt 追踪与「取消归档时透明水合」可能失效（registry.archiveSession 不再指向本插件）' + (overlayBanner.reason ? '（' + overlayBanner.reason + '）' : '') + '。')
      : null,
    // F1/F4（P2.3）：启动链定时器没注册成功 ⇒ 自动清扫永远不会自动挂上（真机 attempts=0 的现场）。
    statusBoot && !statusBoot.registered
      ? h('div', { style: { padding: '8px 16px', background: 'var(--dsh-warning-soft, #FFF7ED)', color: 'var(--dsh-warning, #9A3412)', fontSize: 13 } },
          '启动链定时器未注册：自动清扫不会自动挂上（attempts=0）。原因：' + (statusBoot.registrationError || statusBoot.error || '未知') + '。列表 / 迁移 / 搜索仍可用；重启宿主后才会重新注册（时机由你决定）。')
      : null,
    // M3：启动收敛失败 ⇒ 清扫仍在跑（暂停态），错误必须可见（旧实现 sweep 恒 null，用户看不到原因）。
    statusSweep && statusSweep.sweepError
      ? h('div', { style: { padding: '8px 16px', background: 'var(--dsh-warning-soft, #FFF7ED)', color: 'var(--dsh-warning, #9A3412)', fontSize: 13 } },
          '启动收敛失败，自动清扫已暂停（每一拍自动重试）：' + (statusSweep.sweepError.message || statusSweep.sweepError.code))
      : null,
    overlayMissing
      ? h('div', { style: { padding: '8px 16px', background: 'var(--dsh-warning-soft, #FFF7ED)', color: 'var(--dsh-warning, #9A3412)', fontSize: 13 } },
          OVERLAY_MISSING_TEXT + '：Ctrl/Cmd+Shift+K 与会话头部按钮在当前界面打不开全局搜索；面板内顶部搜索栏仍可用。宿主用于全局覆盖层的席位是 shell.overlay。')
      : null,

    // 工具条
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 16px', borderBottom: '1px solid ' + VAULT_BORDER } },
      // P4：归档视图的四个筛选 chip 在子代理页不适用（子代理页自带「候选 / 已冷存」两段）
      subagentView ? null : chips.map(function (chip) {
        var active = filter[0] === chip.id;
        // P3b（FR-P3-3）：收藏 chip **启用**（旧版是置灰的 P3 占位）；标签带收藏数。
        var label = chip.id === 'favorite' ? '★ 收藏' + (stats.favorites ? ' ' + stats.favorites : '') : chip.label;
        return h('button', {
          key: chip.id,
          type: 'button',
          title: chip.id === 'favorite' ? '只看收藏（默认排序：收藏优先，其次上次活跃）' : undefined,
          onClick: function () { filter[1](chip.id); },
          style: Object.assign(vaultButtonStyle(false, false), {
            background: active ? 'var(--dsh-accent-soft, #EEF2FF)' : VAULT_SURFACE,
            color: active ? 'var(--dsh-accent, #4338CA)' : VAULT_TEXT,
            borderColor: active ? 'transparent' : VAULT_BORDER
          })
        }, label);
      }),
      h('span', { style: { flex: 1 } }),
      // P4（UI 档 §7）：子代理页的两个入口 —— 立即扫描 / 迁移候选（迁移需二次确认并列出数量与字节）
      subagentView
        ? h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(false, busy[0]), onClick: runSubagentScan }, '立即扫描')
        : null,
      subagentView
        ? h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(true, busy[0]), onClick: migrateAllSubagentCandidates }, '迁移候选')
        : null,
      h('label', { style: { fontSize: 12, color: VAULT_MUTED, display: 'flex', alignItems: 'center', gap: 6 } },
        '工作区',
        h('select', {
          value: workspace[0],
          'aria-label': '按工作区筛选',
          onChange: function (event) { workspace[1](event.target.value); },
          style: { height: 30, borderRadius: 6, border: '1px solid ' + VAULT_BORDER, background: VAULT_SURFACE, color: VAULT_TEXT }
        },
          h('option', { value: 'all' }, '全部工作区'),
          workspaces.map(function (name) { return h('option', { key: name, value: name }, name); })
        )
      ),
      h('button', {
        type: 'button',
        onClick: vaultList.refresh,
        disabled: vaultList.state.loading,
        style: vaultButtonStyle(false, vaultList.state.loading)
      }, vaultList.state.loading ? '刷新中…' : '刷新'),
      h('button', {
        type: 'button',
        onClick: openTrash,
        style: vaultButtonStyle(false, false)
      }, '回收站' + (stats.trash || stats.hidden ? ' ' + ((stats.trash || 0) + (stats.hidden || 0)) : '')),
      h('button', {
        type: 'button',
        onClick: openDiagnose,
        style: vaultButtonStyle(false, false)
      }, diagnoseOpen[0] ? '收起诊断' : '诊断'),
      h('button', {
        type: 'button',
        onClick: function () { settingsOpen[1](!settingsOpen[0]); },
        style: vaultButtonStyle(false, false)
      }, settingsOpen[0] ? '收起设置' : '设置')
    ),

    // 提示条
    notice[0]
      ? h('div', {
          style: {
            padding: '8px 16px', fontSize: 13,
            background: notice[0].tone === 'error' ? 'var(--dsh-danger-soft, #FEF2F2)' : notice[0].tone === 'warning' ? 'var(--dsh-warning-soft, #FFF7ED)' : VAULT_SURFACE_MUTED,
            color: notice[0].tone === 'error' ? 'var(--dsh-danger, #B91C1C)' : notice[0].tone === 'warning' ? 'var(--dsh-warning, #9A3412)' : VAULT_MUTED
          }
        }, notice[0].text)
      : null,

    // 批量条
    selectedIds.length
      ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', background: 'var(--dsh-accent-soft, #EEF2FF)', borderBottom: '1px solid ' + VAULT_BORDER, fontSize: 13 } },
          '已选 ' + selectedIds.length + ' 项',
          h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(true, busy[0]), onClick: function () { runAction('migrate', selectedIds, '迁移'); } }, '迁移'),
          h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(false, busy[0]), onClick: function () { runAction('restore', selectedIds, '恢复'); } }, '恢复'),
          h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(false, busy[0]), onClick: function () { runAction('archive', selectedIds, '归档'); } }, '归档'),
          h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(false, busy[0]), onClick: function () { runAction('unarchive', selectedIds, '取消归档'); } }, '取消归档'),
          // P3b（FR-P3-3）：批量条「收藏 / 取消收藏」
          h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(false, busy[0]), onClick: function () { setFavorite(selectedIds, true); } }, '收藏'),
          h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(false, busy[0]), onClick: function () { setFavorite(selectedIds, false); } }, '取消收藏'),
          // P3b（FR-P3-4）：批量删除（冷会话进回收站，热会话 hidden=1）
          h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(false, busy[0]), onClick: function () { runAction('delete', selectedIds, '删除'); } }, '删除'),
          h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(false, busy[0]), onClick: function () { selection[1]({}); } }, '清除'))
      : null,

    // 列表 / 搜索结果（同一块区域：有查询词时展示真实全文搜索结果，含 snippet 与状态标签）
    h('div', {
      style: { flex: 1, minHeight: 0, overflow: 'auto' },
      onScroll: function (event) { listScroll[1](event.target.scrollTop || 0); }
    },
      // P4（UI 档 §7）：子代理页走独立的两段列表（候选 / 已冷存），归档视图一行代码都不改。
      subagentView
        ? h(VaultSubagentPage, {
            items: items,
            subagent: subagentSummary,
            busy: busy[0],
            // `data.class` 是 /list 的视图标记：旧视图的数据还没被替换时不许当成子代理列表
            // （也不许把「还没到手」渲染成「没有符合条件的子代理会话」）；出错时让错误态优先。
            loading: !(data && data.class === 'subagent') && !vaultList.state.error,
            error: vaultList.state.error,
            onRescan: runSubagentScan,
            onMigrate: function (item) { migrateSubagentRows([item]); },
            onRestore: function (item) { runAction('restore', [item.id], '恢复'); },
            onPreview: openPreview
          })
        : (query[0].trim()
        ? (search.loading
            ? h('div', { style: { padding: 24, color: VAULT_MUTED } }, '搜索中…')
            : search.error
              ? h('div', { style: { padding: 24, color: 'var(--dsh-danger, #B91C1C)' } }, '搜索失败：' + search.error.message)
              : h(VaultSearchResults, { data: search.data, tokens: search.data && search.data.tokens, onPick: pickVaultSearchResult, emptyText: '没有符合条件的会话' }))
        : (!vaultList.state.data && vaultList.state.loading
        ? h('div', { style: { padding: 24, color: VAULT_MUTED } }, '加载中…')
        : vaultList.state.error
          ? h('div', { style: { padding: 24, color: 'var(--dsh-danger, #B91C1C)' } }, '列表加载失败：' + vaultList.state.error.message)
          : visible.length === 0
            ? h('div', { style: { padding: 24, color: VAULT_MUTED } }, items.length === 0 ? '还没有归档会话。归档后超过 ' + (stats.archiveAgeDays === undefined || stats.archiveAgeDays === null ? 14 : stats.archiveAgeDays) + ' 天会自动进入冷存储（autoMigrate 默认关）。' : '没有符合条件的会话。')
            : [
                h('div', { key: 'head', style: { display: 'grid', gridTemplateColumns: '32px minmax(180px, 1fr) 130px 78px 84px 84px 96px 300px', gap: 8, padding: '8px 16px', fontSize: 12, color: VAULT_MUTED, borderBottom: '1px solid ' + VAULT_BORDER } },
                  h('input', {
                    type: 'checkbox',
                    checked: allSelected,
                    'aria-label': '全选',
                    onChange: function () {
                      var next = {};
                      if (!allSelected) visible.forEach(function (item) { next[item.id] = true; });
                      selection[1](next);
                    }
                  }),
                  h('span', null, '会话'), h('span', null, '工作区'), h('span', null, '大小'), h('span', null, '上次活跃'), h('span', null, '归档时间'), h('span', null, '状态'), h('span', null, '操作')
                ),
                // FR-P3-6：窗口化的上占位（>200 行时才出现，高度 = 未渲染行 × 固定行高）
                virtualRange.virtual && virtualRange.padTop
                  ? h('div', { key: 'pad-top', style: { height: virtualRange.padTop } })
                  : null
              ].concat(renderedRows.map(function (item) {
                return h('div', {
                  key: item.id,
                  style: {
                    display: 'grid', gridTemplateColumns: '32px minmax(180px, 1fr) 130px 78px 84px 84px 96px 300px', gap: 8,
                    padding: '10px 16px', borderBottom: '1px solid ' + VAULT_BORDER, alignItems: 'center', fontSize: 13,
                    // 窗口化按固定行高换算 ⇒ 行必须真的锁成 VIRTUAL_ROW_HEIGHT（boxSizing 把 padding 算进去）
                    height: VIRTUAL_ROW_HEIGHT, boxSizing: 'border-box', overflow: 'hidden'
                  }
                },
                  h('input', { type: 'checkbox', checked: Boolean(selection[0][item.id]), 'aria-label': '选择 ' + (item.title || item.id), onChange: function () { toggle(item.id); } }),
                  h('div', { style: { minWidth: 0 } },
                    h('div', { style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.id }, item.title || item.id),
                    h('div', { style: { fontSize: 11, color: VAULT_MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.id }, item.error ? '⚠ ' + item.error : item.id)
                  ),
                  h('span', { style: { color: VAULT_MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.projectKey || '' }, item.workspace || '—'),
                  h('span', null, formatBytes(item.sizeBytes)),
                  h('span', { style: { color: VAULT_MUTED } }, formatAge(item.lastActiveAt)),
                  h('span', { style: { color: VAULT_MUTED }, title: item.archivedAt ? new Date(item.archivedAt).toLocaleString() : '未记录归档时间' }, formatAge(item.archivedAt)),
                  h('span', null, h(VaultBadge, { status: item.status })),
                  h('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
                    // P3b（FR-P3-3）：行内收藏星标（随时切换，成功后按「收藏优先」重排）
                    h('button', {
                      type: 'button',
                      disabled: busy[0],
                      title: item.favorite ? '取消收藏' : '收藏（列表置顶）',
                      'aria-pressed': item.favorite ? 'true' : 'false',
                      style: vaultButtonStyle(false, busy[0]),
                      onClick: function () { setFavorite([item.id], !item.favorite); }
                    }, item.favorite ? '★' : '☆'),
                    item.status === 'hot-archived'
                      ? h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(true, busy[0]), onClick: function () { runAction('migrate', [item.id], '迁移'); } }, '迁移')
                      : null,
                    item.status === 'cold'
                      ? h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(true, busy[0]), onClick: function () { runAction('restore', [item.id], '恢复'); } }, '恢复')
                      : null,
                    h('button', { type: 'button', style: vaultButtonStyle(false, false), onClick: function () { openPreview(item); } }, '预览'),
                    // FR-14 归档动作：调官方 archiveSession（走 POST /session-vault/api/archive），成功后记录 archivedAt
                    item.status === 'hot' || item.status === 'hot-restored'
                      ? h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(false, busy[0]), onClick: function () { runAction('archive', [item.id], '归档'); } }, '归档')
                      : null,
                    item.status === 'hot-archived'
                      ? h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(false, busy[0]), onClick: function () { runAction('unarchive', [item.id], '取消归档'); } }, '取消归档')
                      : null,
                    // P3b（FR-P3-4）：删除（冷会话进回收站 / 热会话只 hidden=1，文件零改动）
                    h('button', { type: 'button', disabled: busy[0], title: '删除（冷会话进回收站；热会话只隐藏，文件零改动）', style: vaultButtonStyle(false, busy[0]), onClick: function () { runAction('delete', [item.id], '删除'); } }, '删除')
                  )
                );
              }).concat(
                // FR-P3-6：窗口化的下占位
                virtualRange.virtual && virtualRange.padBottom
                  ? [h('div', { key: 'pad-bottom', style: { height: virtualRange.padBottom } })]
                  : []
              ))))
    ),

    // 设置（与 settings.section 共用同一个表单组件）
    settingsOpen[0]
      ? h('div', { style: { borderTop: '1px solid ' + VAULT_BORDER, maxHeight: 360, overflow: 'auto', padding: 16, background: VAULT_SURFACE_MUTED } },
          h(VaultConfigForm, { onSaved: vaultList.refresh }))
      : null,

    // P3b（FR-P3-4）：回收站面板（列表 + 还原 + 彻底删除；到期只提示，绝不自动删）
    trashOpen[0]
      ? h('div', { style: { borderTop: '1px solid ' + VAULT_BORDER, maxHeight: 320, overflow: 'auto', padding: 12, background: VAULT_SURFACE_MUTED } },
          h(VaultTrashDrawer, {
            data: trashData[0],
            busy: busy[0],
            onRefresh: loadTrash,
            onRestore: restoreFromTrash,
            onPurge: purgeFromTrash
          }))
      : null,

    // P3b（FR-P3-5）：诊断面板（列出 + dry-run 预览 + 逐项确认）
    diagnoseOpen[0]
      ? h('div', { style: { borderTop: '1px solid ' + VAULT_BORDER, maxHeight: 340, overflow: 'auto', padding: 12, background: VAULT_SURFACE_MUTED } },
          h(VaultDiagnosePanel, {
            data: diagnoseData[0],
            plan: repairPlan[0],
            busy: busy[0],
            onRefresh: function () {
              vaultApi('diagnose', {}).then(function (next) { diagnoseData[1](next); }).catch(function (err) { setNotice('error', '诊断失败：' + err.message); });
            },
            onDryRun: dryRunRepair,
            onApply: applyRepair
          }))
      : null,

    // 预览抽屉（292px，右侧）
    preview[0]
      ? h('div', { style: { position: 'absolute', top: 0, right: 0, bottom: 0, width: 292, background: VAULT_SURFACE, borderLeft: '1px solid ' + VAULT_BORDER, boxShadow: 'var(--dsh-shadow-lg, 0 10px 30px rgba(15,23,42,0.12))', padding: 16, overflow: 'auto', zIndex: 20 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('strong', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, preview[0].item.title || preview[0].item.id),
            h('button', { type: 'button', style: vaultButtonStyle(false, false), onClick: function () { preview[1](null); } }, '关闭')
          ),
          h('div', { style: { fontSize: 12, color: VAULT_MUTED, margin: '8px 0 12px' } },
            (preview[0].body && preview[0].body.workspace ? preview[0].body.workspace : preview[0].item.workspace || '—') + ' · ' +
              formatBytes(preview[0].body ? preview[0].body.sizeBytes : preview[0].item.sizeBytes) + ' · ' +
              vaultStatusMeta(preview[0].item.status).label +
              (preview[0].body && preview[0].body.source === 'cold' ? ' · 只读预览' : '')
          ),
          preview[0].loading
            ? h('div', { style: { color: VAULT_MUTED } }, '读取中…')
            : preview[0].error
              ? h('div', { style: { fontSize: 13, color: 'var(--dsh-warning, #9A3412)' } },
                  '预览失败：' + (preview[0].error.body && preview[0].error.body.message ? preview[0].error.body.message : preview[0].error.message))
              : preview[0].body && Array.isArray(preview[0].body.messages) && preview[0].body.messages.length
                ? preview[0].body.messages.map(function (message, index) {
                    return h('div', {
                      key: 'preview-msg-' + index + '-' + (message.seq === null || message.seq === undefined ? index : message.seq),
                      style: {
                        marginBottom: 8, padding: 8, borderRadius: 6,
                        background: message.role === 'user' ? 'var(--dsh-accent-soft, #EEF2FF)' : VAULT_SURFACE_MUTED
                      }
                    },
                      h('div', { style: { fontSize: 11, color: VAULT_MUTED, marginBottom: 4 } },
                        (message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : (message.type || '消息')) + (message.matched ? ' · 命中' : '')
                      ),
                      h('div', { style: { fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, message.text)
                    );
                  })
                : h('div', { style: { fontSize: 13, color: VAULT_MUTED } }, preview[0].body ? '（没有可显示的消息）' : '读取中…'),
          preview[0].body && preview[0].body.truncated
            ? h('div', { style: { fontSize: 11, color: VAULT_MUTED, marginTop: 4 } }, '仅显示最近 ' + preview[0].body.messages.length + ' 条（共 ' + preview[0].body.totalMessages + ' 条）')
            : null,
          preview[0].item.status === 'cold'
            ? h('button', { type: 'button', disabled: busy[0], style: Object.assign(vaultButtonStyle(true, busy[0]), { marginTop: 12 }), onClick: function () { runAction('restore', [preview[0].item.id], '恢复'); } }, '恢复到此目录')
            : null,
          // FR-P3-6：Esc 与「关闭」按钮等价（键盘可达性）
          h('div', { style: { fontSize: 11, color: VAULT_MUTED, marginTop: 8 } }, '按 Esc 关闭')
        )
      : null,

    // 覆盖层：shell.overlay 席位不可用时由面板自己挂同一组件（并在上方给出显式横幅）
    overlaySeat.status === 'ready' ? null : h(VaultSearchOverlay)
  );
}

/**
 * 侧栏面板行（sidebar.panellist）—— **只渲染一个图标**，别的一律交给宿主。
 *
 * 宿主的 PanelRow（dsh-client-ui-sidebar/lib/client.js:164-191）自己就是那个按钮：
 *   - 可访问名与 tooltip 取自我们注册项的 label()；
 *   - onClick = selectPanel(id)（sidebar 把它接到 ctx.layout.selectPanel，:448-449）；
 *   - 它把 renderSlot('sidebar.panellist', { size, active }, { only: id }) 渲染在**图标槽**
 *     （panelGlyph span，:178-184）里，宽侧栏传 size=16、收起传 18。
 * 所以本组件多画 button / 文字 / onClick / title 会同时造成：
 *   ① 侧栏出现两遍「会话保险库」（宿主的面板标题 + 我们自己的文字）；
 *   ② 点内层按钮走我们自己的点击路径（旧实现还在 selectPanel 失败时回退成打开搜索）。
 * 行点击与标签由宿主负责；这里只把 size 画成图标。
 */
function VaultPanelRow(props) {
  var size = props && props.size ? props.size : 18;
  return h(
    'span',
    { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } },
    vaultIconVault(size)
  );
}

function VaultHeaderButton() {
  return h(
    'button',
    {
      type: 'button',
      title: '会话保险库：搜索（Ctrl/Cmd+Shift+K）',
      'aria-label': '会话保险库搜索',
      onClick: function () { openGlobalSearch(); },
      style: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28,
        border: '1px solid ' + VAULT_BORDER, borderRadius: 6, background: VAULT_SURFACE, color: VAULT_TEXT, cursor: 'pointer'
      }
    },
    vaultIconSearch(15)
  );
}

/**
 * 侧栏底部动作（UI 档 §1 第 2 条 / 设计档 §10）：sidebar.footer.action 是 list 席位。
 * 点放大镜 = 打开同一个快速搜索浮层（Ctrl/Cmd+Shift+K；普通 Ctrl+K 归宿主，P3-D1）。
 */
function VaultFooterAction() {
  return h(
    'button',
    {
      type: 'button',
      title: '会话保险库：快速搜索（Ctrl/Cmd+Shift+K）',
      'aria-label': '会话保险库快速搜索',
      onClick: function () { openGlobalSearch(); },
      style: {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 30, padding: '0 10px',
        border: 'none', borderRadius: 6, background: 'transparent', color: VAULT_TEXT, cursor: 'pointer', fontSize: 13, textAlign: 'left'
      }
    },
    h('span', { style: { display: 'flex', color: VAULT_MUTED } }, vaultIconSearch(15)),
    h('span', { style: { flex: 1 } }, '快速搜索')
  );
}

function VaultSearchOverlay() {
  var open = React.useState(false);
  var query = React.useState('');
  /** 与面板搜索栏共用同一条 /search（P2-3：真实全文检索，300ms 防抖）。 */
  var search = useVaultSearch(query[0]);
  var status = useVaultStatus();

  React.useEffect(function () {
    function onOpen() { open[1](true); }
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen);
    // 席位缺失时 openGlobalSearch() 会先把本覆盖层挂进面板，再派发事件；挂载是异步的，
    // 所以「打开意图」要留一个可消费的标记，否则第一次点击会丢掉（空转）。
    if (consumePendingOpenSearch()) open[1](true);
    return function () { window.removeEventListener(OPEN_SEARCH_EVENT, onOpen); };
  }, []);

  React.useEffect(function () {
    if (!open[0]) return;
    function onKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); open[1](false); }
    }
    window.addEventListener('keydown', onKey, true);
    return function () { window.removeEventListener('keydown', onKey, true); };
  }, [open[0]]);

  if (!open[0]) return null;
  var groups = search.data && Array.isArray(search.data.groups) ? search.data.groups : [];
  var index = status && status.index ? status.index : null;
  // S6：标题随检索范围变（body / body+toolResults），与 /status.searchScope 同步。
  var overlayScope = (status && status.searchScope) || 'body';
  var overlayTitle = vaultSearchTitle(overlayScope);

  function pick(group) {
    open[1](false);
    query[1]('');
    pickVaultSearchResult(group);
  }

  return h(
    'div',
    {
      style: {
        position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.45)', zIndex: 1000,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 96
      },
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': overlayTitle,
      onMouseDown: function (event) { if (event.target === event.currentTarget) open[1](false); }
    },
    h('div', { style: { width: 640, maxWidth: '92vw', background: VAULT_SURFACE, borderRadius: 10, boxShadow: 'var(--dsh-shadow-xl, 0 24px 60px rgba(15,23,42,0.35))', overflow: 'hidden' } },
      // P3 / FR-P3-1：覆盖层标题（设计档 §18.4 原文）+ 当前检索范围（来自 /status.searchScope）。
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '10px 14px 0', fontSize: 13, fontWeight: 600, color: VAULT_TEXT } },
        h('span', null, overlayTitle),
        h('span', { style: { fontSize: 11, fontWeight: 400, color: VAULT_MUTED } },
          '检索范围：' + vaultScopeLabel(overlayScope))),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', height: SEARCH_BAR_HEIGHT, borderBottom: '1px solid ' + VAULT_BORDER } },
        h('span', { style: { display: 'flex', color: VAULT_MUTED } }, vaultIconSearch(16)),
        h('input', {
          autoFocus: true,
          type: 'search',
          value: query[0],
          placeholder: SEARCH_PLACEHOLDER,
          'aria-label': '全局搜索会话',
          onChange: function (event) { query[1](event.target.value); },
          onKeyDown: function (event) {
            if (event.key === 'Enter') {
              if (groups.length) { event.preventDefault(); pick(groups[0]); }
              return;
            }
            if (event.key === 'Escape') { event.preventDefault(); open[1](false); }
          },
          style: { flex: 1, height: '100%', minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontSize: 16, color: VAULT_TEXT }
        }),
        h('kbd', { title: '关闭', style: { fontSize: 11, color: VAULT_MUTED, border: '1px solid ' + VAULT_BORDER, borderRadius: 4, padding: '2px 6px' } }, 'Esc')
      ),
      h('div', { style: { maxHeight: '58vh', overflow: 'auto' } },
        !query[0].trim()
          ? h('div', { style: { padding: 16, fontSize: 13, color: VAULT_MUTED } },
              '输入关键词搜索所有工作区的会话正文（热 / 归档 / 冷存）。命中会话直接打开；冷存会话打开只读预览。')
          : search.loading
            ? h('div', { style: { padding: 16, fontSize: 13, color: VAULT_MUTED } }, '搜索中…')
            : search.error
              ? h('div', { style: { padding: 16, fontSize: 13, color: 'var(--dsh-danger, #B91C1C)' } }, '搜索失败：' + search.error.message)
              : h(VaultSearchResults, { data: search.data, tokens: search.data && search.data.tokens, onPick: pick, emptyText: '没有符合条件的会话' })
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderTop: '1px solid ' + VAULT_BORDER, fontSize: 11, color: VAULT_MUTED } },
        h('span', null, 'Enter 打开第一条 · Esc 关闭'),
        index && (index.phase === 'indexing' || index.phase === 'scanning') && index.total
          ? h('span', null, '索引构建中 ' + (index.indexed || 0) + ' / ' + index.total)
          : null,
        h('span', { style: { flex: 1 } }),
        h('span', null, '范围：' + vaultScopeLabel(overlayScope)))
    )
  );
}

/* ===========================================================================
 * P3b 面板（FR-P3-4 回收站 / FR-P3-5 诊断修复）
 * =========================================================================== */

/**
 * 回收站面板（FR-P3-4 / P3-D5 / A-P3-9）。
 *
 * 两类条目：
 *  - kind='trash' ：冷会话 —— 文件已在 <vaultRoot>/trash/<id>/<ts>/（可还原 / 可彻底删除）；
 *  - kind='hidden'：热会话 —— hidden=1、文件零改动（还原 = hidden=0；本插件**不删**宿主文件）。
 * 到期只提示、绝不自动删；彻底删除必须二次确认（I-12：没有 confirm:true 服务端零写入）。
 */
function VaultTrashDrawer(props) {
  var data = props.data;
  if (!data) return h('div', { style: { fontSize: 13, color: VAULT_MUTED } }, '读取回收站…');
  var items = Array.isArray(data.items) ? data.items : [];
  var hidden = Array.isArray(data.hidden) ? data.hidden : [];
  var expired = Number(data.expiredCount) || 0;
  var rows = items.concat(hidden);
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 } },
      h('strong', { style: { flex: 1 } }, '回收站（' + rows.length + '）'),
      h('span', { style: { fontSize: 12, color: VAULT_MUTED } }, '保留 ' + (data.retentionDays || 30) + ' 天；到期只提示、不自动删'),
      h('button', { type: 'button', disabled: props.busy, style: vaultButtonStyle(false, props.busy), onClick: props.onRefresh }, '刷新')
    ),
    expired
      ? h('div', { style: { padding: '6px 10px', borderRadius: 6, background: 'var(--dsh-warning-soft, #FFF7ED)', color: 'var(--dsh-warning, #9A3412)', fontSize: 12 } },
          expired + ' 个条目已超过保留期（30 天）：**不会**自动删除，请自行还原或彻底删除。')
      : null,
    data.note ? h('div', { style: { fontSize: 11, color: VAULT_MUTED, lineHeight: 1.6 } }, data.note) : null,
    rows.length === 0
      ? h('div', { style: { padding: 16, fontSize: 13, color: VAULT_MUTED } }, '回收站是空的。')
      : rows.map(function (item) {
          return h('div', {
            key: 'trash-' + item.id,
            style: { display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) 120px 92px 110px 190px', gap: 8, alignItems: 'center', padding: '8px 10px', border: '1px solid ' + VAULT_BORDER, borderRadius: 6, background: VAULT_SURFACE, fontSize: 12 }
          },
            h('div', { style: { minWidth: 0 } },
              h('div', { title: item.id, style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title || item.id),
              h('div', { style: { fontSize: 11, color: VAULT_MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                (item.kind === 'hidden' ? '热会话（hidden=1，文件未搬移）' : '冷会话（文件在回收站）') + ' · ' + (item.id || ''))
            ),
            h('span', { style: { color: VAULT_MUTED } }, item.workspace || '—'),
            h('span', null, formatBytes(item.sizeBytes)),
            h('span', { style: { color: item.expired ? 'var(--dsh-warning, #C2410C)' : VAULT_MUTED } }, vaultTrashExpiryText(item)),
            h('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
              h('button', { type: 'button', disabled: props.busy, style: vaultButtonStyle(true, props.busy), onClick: function () { props.onRestore(item); } }, '还原'),
              item.kind === 'hidden'
                ? h('span', { style: { fontSize: 11, color: VAULT_MUTED, alignSelf: 'center' } }, '不删文件')
                : h('button', { type: 'button', disabled: props.busy, style: vaultButtonStyle(false, props.busy), onClick: function () { props.onPurge(item); } }, '彻底删除')
            )
          );
        })
  );
}

var DIAGNOSE_GROUP_LABELS = {
  log: '① 日志可读性',
  reconcile: '② DB / manifest / marker 对账',
  disk: '③ 磁盘对账'
};

/**
 * 诊断面板（FR-P3-5 / P3-D6 / A-P3-5）：
 *  列出（只读 /diagnose 的三类对账）→ dry-run 预览（服务端 apply:false ⇒ **零写入**）→ 逐项确认 apply。
 * 修复动作限于「重新索引 / 标 needs-review / 补删 manifest 行 / 清孤立 marker / 导入冷目录 / 清矛盾的 hidden」，
 * **不做 v0→v4 重编码**（P3-D8）。
 */
function VaultDiagnosePanel(props) {
  var data = props.data;
  var plan = props.plan;
  if (!data) return h('div', { style: { fontSize: 13, color: VAULT_MUTED } }, '诊断中…');
  var items = Array.isArray(data.items) ? data.items : [];
  var groups = data.groups || {};
  var planned = plan && Array.isArray(plan.planned) ? plan.planned : null;
  var plannedById = {};
  if (planned) planned.forEach(function (entry) { plannedById[entry.id] = entry; });
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, flexWrap: 'wrap' } },
      h('strong', { style: { flex: 1, minWidth: 200 } },
        '诊断：' + (data.total || 0) + ' 项，其中可修复 ' + (data.repairable || 0) + ' 项'),
      h('span', { style: { fontSize: 12, color: VAULT_MUTED } },
        '回收站 ' + ((data.trash && data.trash.count) || 0) + ' · 隐藏 ' + ((data.trash && data.trash.hidden) || 0)),
      h('button', { type: 'button', disabled: props.busy, style: vaultButtonStyle(false, props.busy), onClick: props.onRefresh }, '重新诊断'),
      h('button', { type: 'button', disabled: props.busy, style: vaultButtonStyle(true, props.busy), onClick: props.onDryRun }, 'dry-run 预览')
    ),
    h('div', { style: { fontSize: 11, color: VAULT_MUTED, lineHeight: 1.6 } },
      '只读诊断：不移动、不删除、不写 manifest。dry-run 预览也是零写入；每一项都需要你在确认框里点一下才会执行（失败即停，已完成项不回滚）。'),
    plan && plan.dryRun
      ? h('div', { style: { padding: '6px 10px', borderRadius: 6, background: 'var(--dsh-info-soft, #EFF6FF)', color: 'var(--dsh-info, #1D4ED8)', fontSize: 12 } },
          'dry-run：计划执行 ' + (planned ? planned.length : 0) + ' 项，写入 0 处（服务端 writes=' + (plan.writes || 0) + '）。')
      : null,
    items.length === 0
      ? h('div', { style: { padding: 16, fontSize: 13, color: VAULT_MUTED } }, '没有发现需要处理的问题（DB / manifest / 冷目录一致）。')
      : ['log', 'reconcile', 'disk'].map(function (groupKey) {
          var groupItems = Array.isArray(groups[groupKey]) ? groups[groupKey] : [];
          if (!groupItems.length) return null;
          return h('div', { key: 'diag-group-' + groupKey, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { fontSize: 12, fontWeight: 600, color: VAULT_TEXT, marginTop: 4 } },
              (DIAGNOSE_GROUP_LABELS[groupKey] || groupKey) + '（' + groupItems.length + '）'),
            groupItems.map(function (item) {
              var plannedEntry = plannedById[item.id];
              return h('div', {
                key: 'diag-' + item.id,
                style: { display: 'grid', gridTemplateColumns: '150px minmax(200px, 1fr) 150px', gap: 8, alignItems: 'center', padding: '8px 10px', border: '1px solid ' + VAULT_BORDER, borderRadius: 6, background: VAULT_SURFACE, fontSize: 12 }
              },
                h('code', { style: { fontSize: 11, color: VAULT_MUTED, overflow: 'hidden', textOverflow: 'ellipsis' }, title: item.id }, item.check),
                h('div', { style: { minWidth: 0 } },
                  h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title || item.sessionId || item.id),
                  h('div', { style: { fontSize: 11, color: VAULT_MUTED, lineHeight: 1.5 } }, item.detail || '')
                ),
                h('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
                  item.repairable
                    ? h('button', {
                        type: 'button',
                        disabled: props.busy,
                        title: plannedEntry ? plannedEntry.summary : (item.repair && item.repair.summary) || '修复',
                        style: vaultButtonStyle(true, props.busy),
                        onClick: function () {
                          props.onApply({
                            id: item.id,
                            check: item.check,
                            action: (item.repair && item.repair.kind) || (plannedEntry && plannedEntry.action) || '',
                            summary: (item.repair && item.repair.summary) || (plannedEntry && plannedEntry.summary) || ''
                          });
                        }
                      }, '修复')
                    : h('span', { style: { fontSize: 11, color: VAULT_MUTED, alignSelf: 'center' } }, '仅诊断')
                )
              );
            })
          );
        })
  );
}
