/*
 * src/ui/settings.tsx —— 会话保险库配置页（settings.section）+ 复用的配置表单
 *
 * ⚠ 由 scripts/build.mjs 原样并入 lib/client.js 的单模块作用域：不要写 import / export。
 *
 * 设计约束（设计档 §3.2 / §10，UI 档 §1）：
 *  - settings.section 保留为「配置 + 第三方侧栏不渲染 panellist 时的兜底入口」；
 *  - 保存即生效（POST /session-vault/api/config，落 <DSH_HOME>/session-vault/config.json，D10）；
 *  - 跨卷开关必须二次确认（D13）；冷根不得在 sessions 之内（服务端也会拒绝，A-11）。
 */
function VaultFieldRow(props) {
  return h(
    'label',
    { style: { display: 'grid', gridTemplateColumns: '200px 1fr', gap: 12, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid ' + VAULT_BORDER } },
    h('span', { style: { fontSize: 13, color: VAULT_TEXT } }, props.label),
    h('span', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } }, props.children)
  );
}

function VaultConfigForm(props) {
  var loaded = React.useState(false);
  var config = React.useState(null);
  var edits = React.useState({});
  var message = React.useState(null);
  var saving = React.useState(false);

  React.useEffect(function () {
    vaultApi('config', {}).then(function (data) {
      config[1](data.config || {});
      loaded[1](true);
    }).catch(function (err) {
      message[1]({ tone: 'error', text: '读取配置失败：' + err.message });
      loaded[1](true);
    });
  }, []);

  function current(field) {
    if (Object.prototype.hasOwnProperty.call(edits[0], field)) return edits[0][field];
    return config[0] ? config[0][field] : undefined;
  }

  function update(field, value) {
    edits[1](function (prev) {
      var next = {};
      Object.keys(prev).forEach(function (key) { next[key] = prev[key]; });
      next[field] = value;
      return next;
    });
  }

  /**
   * P3b（评审遗留 🔵）：数字输入的**唯一入口** —— 空串/非法值保留旧值并提示，绝不静默转 0。
   *
   * 旧实现是 update(field, Number(event.target.value))：清空输入框 ⇒ Number('') === 0 ⇒ 保存后
   * archiveAgeDays=0（=关闭自动迁移）、dailyBudgetCount=0（=当天一个都不迁）。用户只是「还没填完」，
   * 却静默关掉了一个功能。解析规则在 lib/int-input.js（与测试共用同一份源码）。
   */
  function numberInput(field, options) {
    var opts = options || {};
    return function (event) {
      var parsed = parseIntField(event.target.value, {
        min: opts.min,
        max: opts.max,
        fallback: current(field),
        label: opts.label
      });
      if (!parsed.ok) {
        // 保留旧值：不写 edits（输入框下一次渲染回到旧值），只给一句白话提示。
        message[1]({ tone: 'warning', text: parsed.message });
        return;
      }
      message[1](null);
      update(field, parsed.value);
    };
  }

  function save() {
    if (saving[0]) return;
    var patch = {};
    Object.keys(edits[0]).forEach(function (key) { patch[key] = edits[0][key]; });
    if (!Object.keys(patch).length) {
      message[1]({ tone: 'info', text: '没有改动' });
      return;
    }
    saving[1](true);
    vaultApi('config', { patch: patch }).then(function (data) {
      config[1](data.config || {});
      edits[1]({});
      // P3 / FR-P3-2：scope 切换按方向生效——降级在本次请求内删完 tool 文档；
      // 升级是后台 pass（可暂停/续做），这里如实报进度，不假装「已生效」。
      if (data && data.scopeError) {
        message[1]({ tone: 'warning', text: '配置已保存，但检索范围切换失败：' + data.scopeError + '（下一次 /status、/list 或 /search 会重试）' });
      } else if (data && data.scope && data.scope.phase && data.scope.phase !== 'done' && data.scope.phase !== 'idle') {
        message[1]({
          tone: 'success',
          text: '已保存；检索范围正在后台切换到「' + vaultScopeLabel(data.searchScope) + '」（可暂停/续做，期间旧范围仍可查）' +
            (data.scope.total ? '：' + (data.scope.indexed || 0) + ' / ' + data.scope.total : '')
        });
      } else {
        message[1]({ tone: 'success', text: '已保存，下一次清扫/迁移立即按新值执行（无需重启）' });
      }
      if (typeof props.onSaved === 'function') props.onSaved();
    }).catch(function (err) {
      message[1]({ tone: 'error', text: '保存失败：' + err.message });
    }).then(function () { saving[1](false); });
  }

  if (!loaded[0]) return h('div', { style: { fontSize: 13, color: VAULT_MUTED } }, '读取配置中…');

  var autoMigrate = Boolean(current('autoMigrate'));
  var ageDays = current('archiveAgeDays');
  var crossVolume = Boolean(current('allowCrossVolume'));

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h(VaultFieldRow, { label: '冷存储根目录' },
      h('input', {
        type: 'text',
        value: current('coldRoot') || '',
        placeholder: config[0] && config[0].coldRootEffective ? config[0].coldRootEffective : '<DSH_HOME>/session-vault/cold',
        onChange: function (event) { update('coldRoot', event.target.value); },
        style: { flex: 1, height: 30, border: '1px solid ' + VAULT_BORDER, borderRadius: 6, padding: '0 8px', background: VAULT_SURFACE, color: VAULT_TEXT }
      })
    ),
    h('div', { style: { fontSize: 12, color: VAULT_MUTED, margin: '-4px 0 4px 212px' } },
      '留空 = 默认目录；必须在 sessions 之外（I-9）。改根只影响之后的迁移，已迁数据按原冷根恢复（D17）。'),
    h(VaultFieldRow, { label: '自动迁移阈值（天）' },
      h('input', {
        type: 'number', min: 0, max: 3650, value: ageDays === undefined ? 14 : ageDays,
        onChange: numberInput('archiveAgeDays', { min: 0, max: 3650, label: '自动迁移阈值' }),
        style: { width: 120, height: 30, border: '1px solid ' + VAULT_BORDER, borderRadius: 6, padding: '0 8px', background: VAULT_SURFACE, color: VAULT_TEXT }
      }),
      h('span', { style: { fontSize: 12, color: VAULT_MUTED } }, '口径 = 已归档 + 上次活跃超过 N 天；0 = 关闭自动迁移')
    ),
    h(VaultFieldRow, { label: '自动迁移' },
      h('input', {
        type: 'checkbox', checked: autoMigrate,
        onChange: function (event) { update('autoMigrate', event.target.checked); }
      }),
      h('span', { style: { fontSize: 12, color: VAULT_MUTED } }, '默认关（首次安装 = 观察模式）。开启后按日预算逐批迁移。')
    ),
    h(VaultFieldRow, { label: '清扫间隔（分钟）' },
      h('input', {
        type: 'number', min: 1, max: 1440, value: current('sweepIntervalMinutes') === undefined ? 30 : current('sweepIntervalMinutes'),
        onChange: numberInput('sweepIntervalMinutes', { min: 1, max: 1440, label: '清扫间隔' }),
        style: { width: 120, height: 30, border: '1px solid ' + VAULT_BORDER, borderRadius: 6, padding: '0 8px', background: VAULT_SURFACE, color: VAULT_TEXT }
      })
    ),
    h(VaultFieldRow, { label: '每日迁移预算（个）' },
      h('input', {
        type: 'number', min: 0, max: 1000, value: current('dailyBudgetCount') === undefined ? 20 : current('dailyBudgetCount'),
        onChange: numberInput('dailyBudgetCount', { min: 0, max: 1000, label: '每日迁移预算' }),
        style: { width: 120, height: 30, border: '1px solid ' + VAULT_BORDER, borderRadius: 6, padding: '0 8px', background: VAULT_SURFACE, color: VAULT_TEXT }
      })
    ),
    // P3 / FR-P3-2：检索范围（枚举 searchScope，默认 body）。明文提示密钥风险（I-14）。
    h(VaultFieldRow, { label: '检索范围' },
      h('select', {
        value: current('searchScope') || 'body',
        'aria-label': '检索范围',
        onChange: function (event) { update('searchScope', event.target.value); },
        style: { width: 220, height: 30, border: '1px solid ' + VAULT_BORDER, borderRadius: 6, padding: '0 8px', background: VAULT_SURFACE, color: VAULT_TEXT }
      },
        h('option', { value: 'body' }, '正文（默认）'),
        h('option', { value: 'body+toolResults' }, '正文 + 工具结果')
      ),
      h('span', { style: { fontSize: 12, color: VAULT_MUTED } }, '默认只索引正文（用户消息 + 助手回复 + 标题）')
    ),
    // S8（P3a.1）：警告文案去掉 Markdown 星号 —— 设置页是纯文本渲染，**…** 会原样显示成星号。
    h('div', { style: { fontSize: 12, color: 'var(--dsh-warning, #C2410C)', margin: '-4px 0 4px 212px', lineHeight: 1.6 } },
      '⚠ 工具结果可能含密钥：选「正文 + 工具结果」会额外索引 tool/result 的文本结果（不含工具参数，单条截断 8KB），' +
      '工具输出是明文落盘、库也会变大（I-14）。默认关；切回「正文」只删除工具结果文档、不重读日志。'),
    // A3（P2.6 评审）：maxConcurrentJobs 从来没有消费者（引擎写操作**始终**单串行队列），
    // 已移入 config.js 的 RESERVED_CONFIG_FIELDS（写入按 unknown-field 明确拒绝）。
    // 这里保留只读展示位并写明「本批不生效」——旧文案把它说成队列容量，等于承诺了一个不存在的上限。
    h(VaultFieldRow, { label: '并发任务数' },
      h('input', {
        type: 'number', value: 1, disabled: true, readOnly: true,
        style: { width: 120, height: 30, border: '1px solid ' + VAULT_BORDER, borderRadius: 6, padding: '0 8px', background: VAULT_SURFACE_MUTED, color: VAULT_MUTED }
      }),
      h('span', { style: { fontSize: 12, color: VAULT_MUTED } }, '本批不生效：预留字段（P3 才启用，服务端按未知字段拒绝写入）；引擎写操作始终单串行队列')
    ),
    h(VaultFieldRow, { label: '允许跨卷迁移' },
      h('input', {
        type: 'checkbox', checked: crossVolume,
        onChange: function (event) {
          var next = event.target.checked;
          if (!next) { update('allowCrossVolume', false); return; }
          var ok = false;
          try {
            ok = window.confirm('跨卷迁移会在冷卷上产生「半目录」崩溃窗口（copy → 校验 → 删源），比同卷 rename 风险高。确定开启？');
          } catch (err) { ok = false; }
          if (!ok) {
            message[1]({ tone: 'warning', text: '跨卷迁移未开启：二次确认被取消或宿主不支持确认框（fail-closed）' });
            return;
          }
          update('allowCrossVolume', true);
        }
      }),
      h('span', { style: { fontSize: 12, color: VAULT_MUTED } }, '默认关；开启需二次确认（D13）')
    ),
    h(VaultFieldRow, { label: '取消归档时透明水合' },
      h('input', {
        type: 'checkbox', checked: current('hydrateOnUnarchive') !== false,
        onChange: function (event) { update('hydrateOnUnarchive', event.target.checked); }
      }),
      // A2（P2.6 评审裁定）：本插件面板/接口的「取消归档」对冷会话**恒等于恢复**（数据完整性优先，
      // 否则官方界面会隐形）；这个开关只管官方入口。
      h('span', { style: { fontSize: 12, color: VAULT_MUTED } }, '本插件面板的「取消归档」对冷会话恒等于恢复（数据完整性优先）；开关只管官方入口（官方「取消归档」按钮关掉就不再自动搬回，由启动对账 + 横幅兜底）')
    ),
    message[0]
      ? h('div', {
          style: {
            marginTop: 8, padding: '8px 12px', borderRadius: 6, fontSize: 13,
            background: message[0].tone === 'error' ? 'var(--dsh-danger-soft, #FEF2F2)' : message[0].tone === 'warning' ? 'var(--dsh-warning-soft, #FFF7ED)' : message[0].tone === 'success' ? 'var(--dsh-success-soft, #ECFDF5)' : VAULT_SURFACE_MUTED,
            color: message[0].tone === 'error' ? 'var(--dsh-danger, #B91C1C)' : message[0].tone === 'warning' ? 'var(--dsh-warning, #9A3412)' : message[0].tone === 'success' ? 'var(--dsh-success, #047857)' : VAULT_MUTED
          }
        }, message[0].text)
      : null,
    h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
      h('button', { type: 'button', disabled: saving[0], style: vaultButtonStyle(true, saving[0]), onClick: save }, saving[0] ? '保存中…' : '保存'),
      h('button', {
        type: 'button', disabled: saving[0], style: vaultButtonStyle(false, saving[0]),
        onClick: function () { edits[1]({}); message[1]({ tone: 'info', text: '已撤销未保存的改动' }); }
      }, '撤销改动')
    )
  );
}


/**
 * P4（UI 档 §7）**文案红线**：搬到冷存后宿主的可见性会变（会话列表与父会话的子代理缩进行
 * 都不再显示它们），设置卡与主面板「子代理会话」页都必须逐字写明。
 *
 * 字面量放在设置页源（契约对 src/ui/settings.tsx 的字面量单独断言）；主面板通过**同一模块
 * 作用域**的 SUBAGENT_RED_LINE 复用同一份文案 —— 全仓只此一句，杜绝两处漂移。
 */
var SUBAGENT_RED_LINE = '搬到冷存后，宿主的会话列表与父会话的子代理缩进行不再显示它们；可在本页或全局搜索找回';

/** 只读读数的绝对时刻（「上次扫描」只给「N 分钟前」时对不上钟表，UI 档 §7 要求完成时间可见）。 */
function vaultStamp(ms) {
  var value = Number(ms) || 0;
  if (!value) return '—';
  try { return new Date(value).toLocaleString(); } catch (err) { return String(value); }
}

/** 批量迁移进度归一到 0..100（服务端可能给小数 / 缺失）。 */
function vaultPercent(value) {
  var n = Number(value);
  if (!isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

/**
 * P4（FR-P4-8 / UI 档 §7）：「子代理会话冷存」卡。
 *
 * 卡顶部**必须先给恢复入口指路**（2026-10-27 用户实测：在设置页找不到恢复冷会话的入口）——
 * 这里明确写「列表 / 预览 / 恢复入口在主面板」并给「打开主面板」按钮。
 * 迁移需二次确认并列出**数量与字节**；暂停/缺口黄条四条原因全列，gaps 逐条列出并给「重新扫描」。
 */
function VaultSubagentCard(props) {
  var state = React.useState(props.subagent || null);
  var message = React.useState(null);
  var busy = React.useState(false);
  /**
   * B2c（2026-10-27 裁决）：数字输入的**本地编辑态**（key = 字段名，value = 输入框原文）。
   *
   * 旧实现 onChange 就 patchConfig ⇒ 每敲一个字符就 POST /config：输入 "1"→"14" 的中间态会把
   * 阈值写成 1 天，若此时自动迁移开着，一次清扫可能按 1 天阈值搬走会话 —— 写操作被中间态触发的
   * 安全窗口。现在只有**失焦 / 回车**才提交（开关等布尔项保持即时保存：它们没有中间态）。
   */
  var drafts = React.useState({});

  function reload() {
    vaultApi('status', {}).then(function (data) {
      state[1]((data && data.subagent) || null);
      if (typeof props.onReload === 'function') props.onReload(data);
    }).catch(function () { /* 读数失败保留上一次，不把界面清空 */ });
  }

  React.useEffect(function () {
    reload();
    // 批量迁移在跑时轮询进度（作业读数来自 /status.subagent.job）
    var timer = window.setInterval(function () {
      var current = state[0];
      if (current && current.job && current.job.running) reload();
    }, 1000);
    return function () { window.clearInterval(timer); };
  }, []);

  function patchConfig(patch, okText) {
    busy[1](true);
    vaultApi('config', { patch: patch }).then(function (data) {
      message[1]({ tone: 'success', text: okText });
      var next = data && data.config ? data.config : null;
      if (next) {
        state[1](function (prev) {
          var base = prev || {};
          return Object.assign({}, base, {
            ageDays: next.subagentAgeDays,
            dailyBudgetCount: next.subagentDailyBudgetCount,
            migrate: next.subagentMigrate,
            enabled: next.subagentAgeDays > 0,
            migrateEffective: next.subagentAgeDays > 0 && next.subagentMigrate
          });
        });
      }
      if (typeof props.onSaved === 'function') props.onSaved();
      reload();
    }).catch(function (err) {
      message[1]({ tone: 'error', text: '保存失败：' + err.message });
    }).then(function () { busy[1](false); });
  }

  /**
   * B2c（2026-10-27 裁决）：数字输入 = 本地编辑态 + 失焦/回车提交，**绝不 onChange 就 POST**。
   *
   * 提交时用 parseIntField 解析（空串/非整数/越界一律保留原值 + 白话提示，绝不静默转 0）；
   * 解析失败或与已保存值相同 ⇒ 不发请求、清掉草稿（输入框回到已保存值）。
   * 开关等布尔项仍即时保存（`toggleMigrate`）—— 布尔项没有中间态。
   */
  function draftOf(field, committed) {
    var d = drafts[0] || {};
    if (Object.prototype.hasOwnProperty.call(d, field)) return d[field];
    return committed === undefined || committed === null ? '' : String(committed);
  }

  function setDraft(field, raw) {
    drafts[1](function (prev) {
      var next = {};
      Object.keys(prev || {}).forEach(function (key) { next[key] = prev[key]; });
      next[field] = String(raw);
      return next;
    });
  }

  function dropDraft(field) {
    drafts[1](function (prev) {
      if (!prev || !Object.prototype.hasOwnProperty.call(prev, field)) return prev || {};
      var next = {};
      Object.keys(prev).forEach(function (key) { if (key !== field) next[key] = prev[key]; });
      return next;
    });
  }

  function commitNumber(field, min, max, label, committed) {
    return function (event) {
      var raw = event && event.target && event.target.value !== undefined
        ? event.target.value
        : draftOf(field, committed);
      var parsed = parseIntField(raw, { min: min, max: max, fallback: committed, label: label });
      dropDraft(field);
      if (!parsed.ok) {
        // 空串/非法值保留已保存值并提示（与 archiveAgeDays 同一套口径，绝不静默转 0）
        message[1]({ tone: 'warning', text: parsed.message });
        return;
      }
      message[1](null);
      if (parsed.value === committed) return;
      var body = {};
      body[field] = parsed.value;
      patchConfig(body, '已保存，下一次清扫立即按新值执行（无需重启）');
    };
  }

  /** 数字输入的统一接线：输入只改草稿；失焦或回车才提交。 */
  function numberProps(field, min, max, label, committed) {
    var commit = commitNumber(field, min, max, label, committed);
    return {
      type: 'number', min: min, max: max,
      value: draftOf(field, committed),
      'aria-label': label,
      onChange: function (event) { setDraft(field, event.target.value); },
      onBlur: commit,
      onKeyDown: function (event) {
        if (event && (event.key === 'Enter' || event.keyCode === 13)) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          commit(event);
        }
      },
      style: inputStyle
    };
  }

  function toggleMigrate(event) {
    var next = event.target.checked;
    if (!next) {
      patchConfig({ subagentMigrate: false }, '已关闭子代理自动清扫（手动「迁移候选」仍可用）');
      return;
    }
    var s = state[0] || {};
    var ageDays = s.ageDays === undefined || s.ageDays === null ? 14 : s.ageDays;
    var budget = s.dailyBudgetCount === undefined || s.dailyBudgetCount === null ? 50 : s.dailyBudgetCount;
    var ok = false;
    try {
      ok = window.confirm(
        '开启子代理自动清扫？' + String.fromCharCode(10) +
          '只搬未登记 + 未被引用 + ≥' + ageDays + ' 天未活跃的子代理会话（每天至多 ' + budget + ' 个）。' +
          String.fromCharCode(10) + SUBAGENT_RED_LINE,
      );
    } catch (err) {
      ok = false;
    }
    if (!ok) {
      message[1]({ tone: 'warning', text: '未开启：二次确认被取消或宿主不支持确认框（fail-closed）' });
      return;
    }
    patchConfig({ subagentMigrate: true }, '已开启子代理自动清扫（下一次清扫立即生效，无需重启）');
  }

  function scan() {
    if (busy[0]) return;
    busy[1](true);
    message[1]({ tone: 'info', text: '扫描中…（只读遍历会话目录，不改任何文件）' });
    vaultApi('subagent-scan', { action: 'start' }).then(function (data) {
      var result = data && data.scan ? data.scan : null;
      message[1]({
        tone: 'success',
        text: '扫描完成' + (result
          ? '：' + (result.scanned || 0) + ' 个目录 / 缺口 ' + ((result.gaps || []).length) + ' 个' + (result.tookMs ? '（' + Math.round(result.tookMs / 1000) + 's）' : '')
          : '') + ' · 完成于 ' + vaultStamp(Date.now()),
      });
      reload();
    }).catch(function (err) {
      message[1]({ tone: 'error', text: '扫描失败：' + err.message });
    }).then(function () { busy[1](false); });
  }

  function migrateAll() {
    var s = state[0] || {};
    var count = Number(s.candidates) || 0;
    var bytes = Number(s.candidatesBytes) || 0;
    if (!count) {
      message[1]({ tone: 'info', text: '当前没有可迁移的子代理候选（先「立即扫描」或放宽阈值）' });
      return;
    }
    var ok = false;
    try {
      // 二次确认必须列出数量与字节（UI 档 §7）
      ok = window.confirm('把 ' + count + ' 个候选（' + formatBytes(bytes) + '）搬到冷存？' + String.fromCharCode(10) + SUBAGENT_RED_LINE);
    } catch (err) {
      ok = false;
    }
    if (!ok) {
      message[1]({ tone: 'warning', text: '迁移已取消（未写入任何东西）' });
      return;
    }
    busy[1](true);
    vaultApi('subagent-migrate', { all: true, confirm: true }).then(function (data) {
      var job = data && data.job ? data.job : null;
      message[1]({ tone: 'info', text: '批量迁移已启动' + (job ? '：0 / ' + (job.total || count) : '') + '（可取消，进度见下方）' });
      reload();
    }).catch(function (err) {
      message[1]({ tone: 'error', text: '迁移失败：' + err.message });
    }).then(function () { busy[1](false); });
  }

  function cancelJob() {
    vaultApi('subagent-job', { action: 'cancel' }).then(function (data) {
      message[1]({ tone: 'info', text: data && data.ok ? '已请求取消（在飞的一条会跑完，不会半途删源）' : '当前没有在跑的批量迁移' });
      reload();
    }).catch(function (err) {
      message[1]({ tone: 'error', text: '取消失败：' + err.message });
    });
  }

  var s = state[0];
  var ageDays = s && s.ageDays !== undefined && s.ageDays !== null ? s.ageDays : 14;
  var budget = s && s.dailyBudgetCount !== undefined && s.dailyBudgetCount !== null ? s.dailyBudgetCount : 50;
  var gaps = s && Array.isArray(s.scanGaps) ? s.scanGaps : [];
  var job = s && s.job ? s.job : null;
  var inputStyle = { width: 120, height: 30, border: '1px solid ' + VAULT_BORDER, borderRadius: 6, padding: '0 8px', background: VAULT_SURFACE, color: VAULT_TEXT };

  return h(
    'div',
    {
      style: {
        marginTop: 16, padding: 12, border: '1px solid ' + VAULT_BORDER, borderRadius: 8,
        background: VAULT_SURFACE, display: 'flex', flexDirection: 'column', gap: 8
      }
    },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
      h('strong', { style: { fontSize: 14 } }, '子代理会话冷存'),
      h('span', { style: { fontSize: 12, color: VAULT_MUTED } }, 'class S：只搬未登记 + 未被引用 + 超过阈值的子代理会话；默认关'),
      h('span', { style: { flex: 1 } }),
      h('button', {
        type: 'button',
        style: vaultButtonStyle(true, false),
        onClick: function () { selectVaultPanel(ctxRef); }
      }, '打开主面板')
    ),
    // 恢复入口指路（UI 档 §7 卡顶部硬文案；2026-10-27 用户实测：在设置页找不到恢复冷会话的入口）
    h('div', { style: { fontSize: 12, lineHeight: 1.7, color: VAULT_TEXT } },
      '列表 / 预览 / 恢复入口在主面板（侧栏「会话保险库」），本页只放配置'),
    h(VaultFieldRow, { label: '子代理自动清扫' },
      h('input', { type: 'checkbox', checked: Boolean(s && s.migrate), onChange: toggleMigrate }),
      h('span', { style: { fontSize: 12, color: VAULT_MUTED } }, '默认关；开启前二次确认。手动「迁移候选」不受这个开关限制。')
    ),
    // B2c：数字项只在失焦/回车时保存（输入过程中不会把中间态写进 config，消除瞬时阈值窗口）
    h(VaultFieldRow, { label: '子代理年龄阈值（天）' },
      h('input', numberProps('subagentAgeDays', 0, 3650, '子代理年龄阈值', ageDays)),
      h('span', { style: { fontSize: 12, color: VAULT_MUTED } },
        '0 = 关闭；当前会命中 ' + ((s && s.candidates) || 0) + ' 个 / ' + formatBytes(s ? s.candidatesBytes : 0))
    ),
    h(VaultFieldRow, { label: '自动清扫日预算（个）' },
      h('input', numberProps('subagentDailyBudgetCount', 0, 1000, '子代理日预算', budget)),
      h('span', { style: { fontSize: 12, color: VAULT_MUTED } }, '仅自动清扫使用（默认 50 个/天）；手动批量一次最多 2000 个')
    ),
    h('div', { style: { fontSize: 12, color: VAULT_MUTED, margin: '-4px 0 4px 212px' } },
      '数字项在失焦或按回车时才保存（输入过程中的中间值不会写进配置）；开关类立即保存。'),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 12, color: VAULT_MUTED } },
      h('span', null, '候选 ' + ((s && s.candidates) || 0) + ' 个 / ' + formatBytes(s ? s.candidatesBytes : 0)),
      h('span', null, '已冷存 ' + ((s && s.cold) || 0) + ' 个 / ' + formatBytes(s ? s.coldBytes : 0)),
      h('span', null, '上次扫描 ' + (s && s.scanAt ? formatAge(s.scanAt) + '（' + vaultStamp(s.scanAt) + '）' : '还没有扫描过')),
      h('span', { style: gaps.length ? { color: 'var(--dsh-warning, #9A3412)' } : undefined },
        '缺口 ' + gaps.length + ' 个' + (gaps.length ? '（会暂停：一个都不搬）' : '')),
      h('span', null, '自动清扫 ' + (s && s.migrateEffective ? '已开启' : '关'))
    ),
    h(VaultSubagentPauseBanner, { subagent: s, busy: busy[0], onRescan: scan }),
    h('div', { style: { fontSize: 12, lineHeight: 1.7, color: 'var(--dsh-warning, #9A3412)' } }, SUBAGENT_RED_LINE),
    job
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: VAULT_MUTED } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('span', null,
              '批量迁移 ' + (job.done || 0) + ' / ' + (job.total || 0) + '（' + (job.progress || 0) + '%）· 成功 ' +
                (job.migrated || 0) + ' / 失败 ' + (job.failed || 0) +
                (job.cancelled ? ' · 已取消' : '') + (job.interrupted ? ' · 上次批量中断（可重跑）' : '')),
            job.running
              ? h('button', { type: 'button', style: vaultButtonStyle(false, false), onClick: cancelJob }, '取消')
              : null),
          // UI 档 §7：批量迁移要给**进度条**（不只是一行数字）+「可取消」
          h('div', {
            role: 'progressbar',
            'aria-label': '批量迁移进度',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': vaultPercent(job.progress),
            style: { height: 6, borderRadius: 3, background: VAULT_SURFACE_MUTED, overflow: 'hidden' }
          },
            h('div', {
              style: {
                height: '100%', width: vaultPercent(job.progress) + '%',
                background: 'var(--dsh-accent, #4338CA)', transition: 'width 0.2s'
              }
            })))
      : null,
    message[0]
      ? h('div', {
          style: {
            padding: '6px 10px', borderRadius: 6, fontSize: 12,
            background: message[0].tone === 'error' ? 'var(--dsh-danger-soft, #FEF2F2)' : message[0].tone === 'warning' ? 'var(--dsh-warning-soft, #FFF7ED)' : message[0].tone === 'success' ? 'var(--dsh-success-soft, #ECFDF5)' : VAULT_SURFACE_MUTED,
            color: message[0].tone === 'error' ? 'var(--dsh-danger, #B91C1C)' : message[0].tone === 'warning' ? 'var(--dsh-warning, #9A3412)' : message[0].tone === 'success' ? 'var(--dsh-success, #047857)' : VAULT_MUTED
          }
        }, message[0].text)
      : null,
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(false, busy[0]), onClick: scan }, busy[0] ? '处理中…' : '立即扫描'),
      h('button', { type: 'button', disabled: busy[0], style: vaultButtonStyle(true, busy[0]), onClick: migrateAll }, '迁移候选')
    )
  );
}

function VaultSettingsSection() {
  var status = React.useState(null);
  React.useEffect(function () {
    vaultApi('status', {}).then(function (data) { status[1](data); }).catch(function () { /* 兜底入口不因状态失败而消失 */ });
  }, []);
  var stats = (status[0] && status[0].stats) || {};
  var banners = (status[0] && status[0].banners) || {};
  var statusVault = (status[0] && status[0].vault) || {};
  var overlaySeat = useOverlaySeat();
  var warnings = [];
  // S8（P3a.1）：警告文案里不得出现 Markdown 星号（纯文本渲染会原样显示）。
  if (banners.am) warnings.push('检测到 archive-manager（' + ((banners.am.matches || []).map(function (item) { return item.id; }).join(', ') || '已安装') + '），自动迁移已暂停（AC-9 / A-18）。归档时间回填已交付：每轮清扫的只读回填 tick 照跑（AM 在场也执行，只补 DB 展示字段、不搬移文件）；取消归档不会自动搬回（透明水合不生效）。');
  if (banners.coldUnavailable) warnings.push('冷存储目录不可用：' + (Array.isArray(statusVault.coldRoots) ? statusVault.coldRoots.map(function (item) { return item.root; }).join(' / ') : '') + '（只读模式，不会删除任何数据）。');
  // F2/F4（P2.3）：包装不支持 / 自动重装已停手 / 被第三方覆盖 —— 三种故障分开说，不静默降级。
  var overlayBanner = banners.overlay || null;
  if (overlayBanner && overlayBanner.supported === false) {
    warnings.push('归档追踪不可用：宿主 workspaceRegistry 的归档方法无法被包装（形状 ' + (overlayBanner.shape || 'unsupported') + '：' + (overlayBanner.reason || 'set-ineffective') + '）。archivedAt 记录与「取消归档时透明水合」不生效；已停止自动重装以免抖动，可 POST /session-vault/api/diag {"action":"retry-overlay"} 手动重试。');
  } else if (overlayBanner && overlayBanner.repairFailed) {
    warnings.push('归档包装持续漂移：已自动重装 ' + (overlayBanner.reinstalls || 0) + ' 次仍未恢复（' + (overlayBanner.reason || 'drifted') + '），自动重装已停止；可 POST /session-vault/api/diag {"action":"retry-overlay"} 手动重试。');
  } else if (overlayBanner && overlayBanner.drifted) {
    warnings.push('归档包装已被其它插件覆盖：archivedAt 追踪与透明水合可能失效' + (overlayBanner.reason ? '（' + overlayBanner.reason + '）' : '') + '。');
  }
  // M3：启动收敛失败时清扫仍会起跑（暂停态），错误必须在这一屏可见（旧实现 sweep 恒 null ⇒ 静默降级）。
  var sweepStatus = (status[0] && status[0].sweep) || null;
  if (sweepStatus && sweepStatus.sweepError) warnings.push('启动收敛失败，自动清扫已暂停（每一拍会自动重试）：' + (sweepStatus.sweepError.message || sweepStatus.sweepError.code));
  // F1/F4（P2.3）：启动链定时器没注册成功 ⇒ 自动清扫永远挂不上（真机 /status.sweep.attempts=0 的现场）。
  var statusBoot = (status[0] && status[0].boot) || null;
  if (statusBoot && !statusBoot.registered) warnings.push('启动链定时器未注册：自动清扫不会自动挂上（attempts=0）。原因：' + (statusBoot.registrationError || statusBoot.error || '未知') + '；列表/迁移/搜索仍可用，重启宿主后才会重新注册。');
  if (overlaySeat.status === 'missing') warnings.push(OVERLAY_MISSING_TEXT + '：Ctrl/Cmd+Shift+K 与会话头部按钮打不开全局搜索（宿主席位是 shell.overlay）。');
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, color: VAULT_TEXT, fontFamily: 'inherit' } },
    h('div', null,
      h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, '会话保险库'),
      h('p', { style: { margin: '6px 0 0', fontSize: 13, color: VAULT_MUTED } },
        '把「归档」升级为可配置冷存储：已归档且上次活跃超过阈值的会话可搬离 ~/.dsh/sessions，需要时一键按原 projectKey 搬回。')
    ),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 16, padding: '10px 12px', borderRadius: 8, background: VAULT_SURFACE_MUTED, fontSize: 12, color: VAULT_MUTED } },
      h('span', null, '归档 ' + (stats.archived || 0)),
      h('span', null, '冷存储 ' + (stats.cold || 0)),
      h('span', null, '冷占用 ' + formatBytes(stats.bytesCold)),
      h('span', null, '待迁 ' + (stats.candidates || 0) + ' 个'),
      h('span', null, '阈值 ' + (stats.archiveAgeDays === undefined || stats.archiveAgeDays === null ? '—' : stats.archiveAgeDays + ' 天')),
      h('span', null, '自动迁移 ' + (stats.autoMigrate ? '已开启（按清扫间隔执行）' : '关（观察模式）')),
      h('span', null, '检索范围 ' + vaultScopeLabel(status[0] && status[0].searchScope)),
      h('span', null, status[0] && status[0].vault && status[0].vault.coldRoot ? '冷根 ' + status[0].vault.coldRoot : '')
    ),
    warnings.length
      ? h('div', { style: { padding: '8px 12px', borderRadius: 8, background: 'var(--dsh-warning-soft, #FFF7ED)', color: 'var(--dsh-warning, #9A3412)', fontSize: 13, lineHeight: 1.7 } },
          warnings.map(function (text, index) { return h('div', { key: 'warn-' + index }, text); }))
      : null,
    h('div', { style: { fontSize: 13, color: VAULT_MUTED } },
      '主入口在侧栏「会话保险库」行；列表 / 预览 / 恢复都在主面板里（含「子代理会话」页）。任意处按 Ctrl/Cmd+Shift+K 打开全局搜索（普通 Ctrl+K 归宿主）；会话头部也有搜索按钮。此处是配置页，也是第三方侧栏不渲染 panellist 时的兜底入口（不接管 sidebar.workspaces）。'),
    h(VaultConfigForm, {}),
    // P4（FR-P4-8 / UI 档 §7）：「子代理会话冷存」卡（含恢复入口指路）
    h(VaultSubagentCard, { subagent: (status[0] && status[0].subagent) || null }),
    h('div', { style: { marginTop: 8, padding: 12, border: '1px dashed ' + VAULT_BORDER, borderRadius: 8, fontSize: 12, color: VAULT_MUTED, lineHeight: 1.7 } },
      h('div', { style: { fontWeight: 600, color: VAULT_TEXT, marginBottom: 4 } }, '本批范围与留好的接口'),
      h('div', null, 'P1 已实现：列表 / 工作区筛选 / 单条与批量迁移 / 恢复 / 归档 / 取消归档 / 审计 manifest / 冷索引。'),
      h('div', null, 'P2 已实现：全局全文搜索（search）/ 只读预览（preview）/ 自动清扫（sweeper，含只读回填 tick 与暂停条件）/ 全量后台索引与增量刷新（indexer）。'),
      h('div', null, 'P3（本批已实现）：Ctrl/Cmd+Shift+K 全局搜索（普通 Ctrl+K 归宿主）+ 检索范围（正文 / 正文 + 工具结果，默认正文）。'),
      h('div', null, 'P3b 已实现：收藏 /favorite（列表收藏优先置顶）/ 回收站 /delete（冷会话搬进 <vaultRoot>/trash，热会话只 hidden=1，文件零改动）/ 诊断与修复 /diagnose（只读）+ /repair（默认 dry-run，零写入）。'),
      h('div', null, 'P4 已实现：子代理会话冷存（class S）—— 设置页为配置与只读读数，列表/预览/恢复入口在主面板「子代理会话」页。'),
      h('div', null, 'diagnostics：header 缺失按「header-unverified」记录，不当故障（BL-4）。')
    )
  );
}
