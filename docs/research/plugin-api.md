# DSH Web 插件开发面调研备忘（dsh-session-vault）

> 取证 2026-10-22。检出 `<workspace-root>\harness-checkout` 版本 = **0.2.1-rc.2**，与桌面 asar 一致（`app.asar\dsh\package.json:4`），行号可直接引。
> 路径缩写：`packages/…`、`vendor/…` 均在检出内；`AM`=`%TEMP%\dsh-archive-eval\am`（@michengai/dsh-archive-manager 1.1.6）；`ZS`=`%TEMP%\dsh-archive-eval\zs`（dsh-archived-sessions 0.1.5）。

## 结论速览

1. **包形状**：一个 npm 包、双半身。host 半身 = cordis 插件（`name/inject/Config/apply`）；client 半身 = `exports["./client"]` 指向的浏览器 bundle，格式必须是 `window.__ModuleLoader__.load({id,factory})`；`dsh.bundle.patch` 指向 `cordis.patch.yml`。
2. **挂载两条路**：bundle（进 `dsh.profile.bundles`，靠自带 patch 的 `insert` 行挂载）或**用户层 `insert` 行直插**（写 profile 的 `cordis.patch.yml`）。本地开发依赖写法 `"link:<workspace-root>/dsh-plugins/dsh-session-vault"`（活动 profile 已有 `team-link-plugin` 先例，`~/.dsh/profiles/desktop/package.json:35`）。
3. **设置页**：`ctx.slots.inject('settings.section', () => ctx.slots.register({name:'settings.section', id, order, label, locale}, Component))`（ZS client.js:1762-1774）。slot 契约 `kind:'list', scope:'root'`，owner props 只有 `close`（ui-settings/src/client/contract/slots.ts:57,126-129）。
4. **配置**：`export const Config = z.object({...})`（schemastery，默认值 `.default()`），`apply(ctx, config)` 取第二参。**字段需 `.volatile()` 才进自动设置表单**，否则 `settings.describe()` 直接跳过该条目（settings/src/schema.ts:33-47）。
5. **清理**：只有 `ctx.effect(() => disposer, label)` 或 `apply` 返回 disposer 可靠。**cordis 4.0.5 没有 `'dispose'` 事件**（events.ts:329-352 只有 `internal/*`）。
6. **路由**：`ctx.get('webServer')?.register({kind, path, handler})`，重复 `(kind,path)` **抛错**，返回 disposer（webserver/src/index.ts:360-373）。**宿主不做鉴权**，必须自己校验 loopback/Origin（ZS index.js:144-170 可照抄）。
7. **服务包装**：**不换服务对象**，把方法贴到活实例 + 符号守卫 + 引用比对还原（AM workspace.ts:1506-1553）。
8. **开发循环**：client bundle 改完重建即可，宿主 stat-poll(500ms)+SSE 自动刷新，不重启（client/hmr/src/index.ts:143-156,180-207）。host 代码默认**不热重载**——base bundle 给 `hmr` 的 `config.root: []`（bundle/base/cordis.patch.yml:27-32）。
9. **版本门**：`engines.dsh` 优先（存在则 peer 全忽略），否则逐个校验 `@deepseek-ai/dsh*` peers（semver + includePrerelease）。不匹配的 **bundle 被静默跳过**、不阻断启动（app-boot/src/profile.ts:759-767）；**insert 行不走这道门**。

---

## 1. 包形状与挂载

### 1.1 package.json 最小骨架

```jsonc
{
  "name": "dsh-session-vault",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },          // string 或 string[]（profile.ts:58-64）
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
  },
  "files": ["lib", "cordis.patch.yml", "package.json"],
  "engines": { "dsh": ">=0.2.1-rc.2 <0.3.0" }
}
```

- `dsh.client` 只认 4 个字段：`platform`（必填，必须 `"web"`）、`inject`、`external`、`immediately`（client/modules/src/client/manifest.ts:173-193；非 web 忽略，index.ts:862-865）。
- `exports["./client"]` 缺失 = 抛错（index.ts:866-869）；接受字符串或 `{default:"..."}`（index.ts:196-206）。
- bundle 文件不存在不是警告而是组合期硬错 "client bundle not found; run `pnpm run build`"（index.ts:93-111）。

### 1.2 cordis.patch.yml

```yaml
# <pkg>/cordis.patch.yml（bundle 自带层）
- insert:
    - id: dsh-session-vault        # loader 行 id，同时是 settings 命名空间（§3）
      name: 'dsh-session-vault'    # 相对/绝对路径会被转成 file:// URL（app-boot/src/index.ts:550-561）
      config: { archiveRoot: 'D:/dsh-vault' }
```

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml（用户层，最后应用，profile.ts:769-772）
- insert:
    - id: dsh-session-vault
      name: 'dsh-session-vault'
```

格式 = `@deepseek-ai/cordis-plugin-include` 的 `PatchOptions` 顶层数组，允许 `!!js`；字段 `id/name/config/disabled/insert`，非法字段直接抛错（app-boot/src/index.ts:562-583）。

### 1.3 host 半身骨架

```js
export const name = 'dsh-session-vault';
export const inject = ['webServer', 'workspaceRegistry', 'sessionPersistence', 'sessions'];
export const Config = z.object({
  archiveRoot: z.string().default('').volatile(),
  autoArchiveDays: z.number().min(0).default(0),
});

export function apply(ctx, config) {
  ctx.effect(() => ctx.get('webServer')?.register({
    kind: 'prefix', path: '/session-vault/api',
    handler: async (req, res) => { /* §4.2 */ },
  }), 'session-vault: routes');

  const uninstall = installArchiveWorkspace(ctx.get('workspaceRegistry'), config); // §5
  return () => uninstall();                    // apply 返回值即 disposer（fiber.ts:77-93）
}
```

- `inject` 是硬依赖（缺失则插件一直 pending）；可选能力必须走 `ctx.get('x')`（ZS index.js:26-29 注释即此结论）。
- `apply` 可 async；AM 就返回一个 async 收尾函数（AM src/index.ts:15-39）。

### 1.4 解析顺序

bundle 列表来自 profile `dsh.profile.bundles`，按序叠加各自 patch，最后叠加用户 patch（profile.ts:740-774）。bundle 目录解析**安装目录优先、profile 第二**（profile.ts:714-725）——profile 里同名包不会盖过宿主内置那份。

## 2. 设置页

```js
export const inject = ['slots', 'locale'];                 // ZS client.js:211
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register('session-vault', { zh, en }), 'vault: dict');
  const t = ctx.locale.bind('session-vault');
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'session-vault', order: 210,
    label: () => t('nav'), locale: 'session-vault',
  }, VaultSection));                                       // React 组件，props 含 close
}
```

宿主端**无需配套**：设置页是纯 client 面，数据由自家路由或 `configForms` 提供（AM host-install.ts:9-44 不注册任何 settings 路由）。同族 slot：`settings.action`、`settings.general.item`（单行偏好）、`settings.plugins.tab`（contract/slots.ts:39-92）。

ZS vs AM 两条现成路：ZS = 一个 section + 自家 `POST /archived/api/<method>`（index.js:939-1008）；AM = 自定义 section + typert RPC（src/workspace.ts:292-405）。**v1 走 ZS 形态**，少踩 typert codec。

## 3. 配置

### 3.1 schema 与取值

`schemastery`：宿主内建 `@deepseek-ai/schemastery`（或 ZS 那样 npm 依赖 `schemastery`，package.json:38-40）。导出 `export const Config`（普通插件）或 `static Config`（Service 子类），例 client/hmr/src/index.ts:29-37。默认值只写在 schema，`apply` 拿到的已合并（index.ts:69-70 注释）。

### 3.2 落盘与生效

- 落盘 = profile `cordis.patch.yml` 该行的 `config:`（活动 profile 里 `better-sidebar`/`compaction-basic` 即此形态，`cordis.patch.yml:368-379,719-722`）。
- 写通道 = 宿主 `settings` 服务 `update(ns,patch,expectedRevision)` / `replace` / `mutate`（settings/src/index.ts:347-367）；**ns = loader 行 id**（`entry.options.id`，:315,326）。
- 生效 = patch 重算后发 `app-boot/config-reload`（app-boot/src/index.ts:411），settings 监听刷新（settings/src/index.ts:234）。
- ⚠️ 活动 profile 已有"改配置后同样需要重启才生效"的先例注释（`~/.dsh/profiles/desktop/cordis.patch.yml:718`）⇒ **设计里按"需重载/重启"口径写**，别承诺即时生效。

### 3.3 自动表单 vs 自绘

`describe()` 只投影带 `meta.volatile` 的字段，`volatileForm()` 为 undefined 时**整条跳过**（settings/src/schema.ts:33-47 + index.ts:308-309）。内建示例 `preset/agent-preset-registry/src/index.ts:56`（`z.string().volatile()`）。

```js
export const inject = ['slots', 'remote', 'configForms'];  // locale/src/client/index.ts:554
const form = ctx.configForms.get('dsh-session-vault');     // 参数 = loader 行 id
form.getSnapshot();                                        // {status,value,base,user,revision,writable}
form.subscribe(fn);                                        // 返回 disposer
await form.set('archiveRoot', 'D:/vault');                 // 内含 revision 冲突恢复
```

（ConfigForm 契约 ui-settings/src/client/config-form.ts:50-120。）**建议**：需要选目录/试跑的项自绘页面；纯标量标 `.volatile()` 走自动表单。

## 4. 宿主能力

### 4.1 生命周期与定时器

`ctx.effect(body,label)`：立即执行；disposer 逆序、可 async、重复调用第二次 no-op；fiber 已卸载抛 `INACTIVE_EFFECT`（fiber.ts:402-442）。
`ctx.setInterval/setTimeout/throttle/debounce` 由 `cordis-plugin-timer` 提供并随 fiber 清理（vendor/timer/src/index.ts:4-15,24-40），base bundle 已挂（bundle/base/cordis.patch.yml:24-25）。用原生 `setInterval` 必须自己 clear。
**没有 `ctx.on('dispose')`**：Events 只有 `internal/plugin|status|config|service|update|get|set|listener|dispatch`（events.ts:329-352）。

### 4.2 HTTP 路由

```js
ctx.effect(() => ctx.get('webServer').register({
  kind: 'prefix', path: '/session-vault/api',
  handler: async (req, res) => {
    if (!isTrusted(req)) return send(res, 403, { error: 'forbidden' });
    if (req.method !== 'POST') return send(res, 405, {});
    const method = new URL(req.url, 'http://dsh.internal').pathname.slice('/session-vault/api/'.length);
    // 白名单分派
  },
}), 'vault: routes');
```

- `exact` 逐字；`prefix` 匹配 `p` 与 `p/<anything>`（webserver/src/index.ts:43-53）。
- 重复 `(kind,path)` **抛错不是覆盖**（:366-373）；handler 拥有完整响应生命周期、可 hold 做 SSE（:50-52）；未命中 → fallback → 404（:422-438）。
- **无内建鉴权**。照抄 ZS：host 为 loopback、`sec-fetch-site !== 'cross-site'`、`origin` 与 host 同源（ZS index.js:144-170,943）。宿主的 `/api` 是 connection RPC 通道（api/gateway/src/index.ts:242-248），插件别往里塞。

### 4.3 typert（需要官方 RPC 面时）

```js
const CONTRIB = { package:'dsh-session-vault', face:'host', schemas:[],
  model:{services:[],events:[],objects:[]},
  invocations:[{ id:'dsh-session-vault#workspaceRegistry/unarchiveSession',
    service:'workspaceRegistry', namespace:'workspaceRegistry', method:'unarchiveSession',
    invocation:{kind:'direct'}, parameters:[/* {name,wire,source:'json',codec} */],
    result: codec, sourceLocation:{file:'dsh-session-vault/lib/index.js',line:1,column:1} }] };
const dispose = ctx.typert.register(CONTRIB);   // 返回 disposer
```

范式 AM src/workspace.ts:292-405。坑：codec 必须 `mode:'strict'`（AM src/client.ts:125-128）；热重载残留抛 `already registered`，AM 选择吞掉（workspace.ts:399-404）。**v1 只做 HTTP 路由即可。**

### 4.4 事件

`emit`（同步广播）/ `parallel`（allSettled）/ `serial` / `bail` / `waterfall`（events.ts:32-88,183-240）。新事件用 `declare module '@deepseek-ai/cordis' { interface Events { 'session-vault/archived'(id:string):void } }` 声明。

## 5. 包装 archiveSession / unarchiveSession

**实例级 overlay，不换服务对象**：官方实例被 `workspaceController` 等直接持有，替换会让"卸下插件后工作区 unavailable"（AM cordis.patch.yml:1-6 注释 + workspace.ts:1502-1505）。

```js
const OVERLAY = Symbol.for('dsh-session-vault.overlay');

export function installArchiveWorkspace(registry, config) {
  if (registry[OVERLAY] === true) return () => {};       // ① 幂等守卫（AM workspace.ts:1508）
  const undo = [];
  const wrap = (name, make) => {
    const had = Object.hasOwn(registry, name);
    const previous = registry[name];
    const next = make(previous);
    registry[name] = next;
    undo.push(() => {                                    // ② 只还原自己那次
      if (registry[name] !== next) return;               //    别人后装过 → 不动
      if (had) registry[name] = previous; else delete registry[name];
    });
  };

  wrap('archiveSession', (original) => async function (sessionId, ...rest) {
    const result = await original.apply(this, [sessionId, ...rest]);  // ③ 先走官方路径
    await vault.onArchived(sessionId);                                // ④ 再做迁移
    return result;
  });

  registry[OVERLAY] = true;
  return () => { if (registry[OVERLAY] !== true) return;
    undo.reverse().forEach(f => f()); delete registry[OVERLAY]; };
}
```

- **存原函数**：AM 先存 `host.sessionPath`/`candidateMatches` 原引用再还原（workspace.ts:1427-1460）。
- **多插件叠加**：cordis 无方法级组合，**后装者赢**；引用比对能保证先卸者不破坏后装者，但"两次拦截"不存在 ⇒ 我们的迁移失败**不能回滚官方归档结果**，要落成待办。
- 包装用 `...rest` 透传、不做参数校验，容忍官方签名变化。
- 仅在"必须让 typert 扫描认领"时才改原型（AM `markOverlayMethods`，workspace.ts:1474-1491），且要原样存回 descriptor。

## 6. 客户端 bundle

- 硬契约：`window.__ModuleLoader__.load({ id:'<包名>', factory:(require)=>{ …; return module.exports; } })`（ZS client.js:1-3,1797-1801；语义见 client/modules/src/client/manifest.ts:1-30）。
- 免打包可 `require` 的平台模块：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`（client/web/src/platform.ts:8-15）。
- 其它插件包：`dsh.client.inject` 声明图边（工厂先到）或 `dsh.client.external` 逐字列出（modules/index.ts:858-875）。
- 构建：官方 tsdown 预设（client/tsdown.client.ts:98-128）含 purity 校验；我们用 esbuild 打单文件 CJS + 上面的 load 壳，产物放 `exports["./client"]` 指定位置。
- client→host 三条路：自家 `fetch`（ZS，最省）、`ctx.configForms`、`ctx.remote.*`（typert 生成面）。

## 7. 开发循环

| 改什么 | 生效方式 | 证据 |
|---|---|---|
| client bundle | 重建即可；500ms stat-poll + SSE `/plugins/events`，**不重启** | client/hmr/src/index.ts:1-8,143-156,180-207 |
| host 代码 | 默认**不热重载**（`hmr.config.root: []`，注释"module roots are opt-in"） | bundle/base/cordis.patch.yml:27-32 |
| host 代码想热重载 | 给 `- id: hmr` 行补 `config: { root: ['<workspace-root>/dsh-plugins/dsh-session-vault'] }`，由 `dsh-hmr` 替换插件 | boot/hmr/src/index.ts:1-19,55-65 |
| patch/配置 | config reload 通道（`app-boot/config-reload`） | app-boot/src/index.ts:386-411 |
| 新增 insert 行 / 新依赖 | loader 需重算；桌面端最稳是**重启**（由用户定时机） | — |

host 侧"打印调试"只能用 `ctx.logger?.warn(...)`（AM/ZS 同做法），日志进宿主控制台；插件没有独立 stdout。

## 8. 版本门

判定链（app-boot/src/plugin-compatibility.ts）：① `engines.dsh` 存在 → 只看它、peer 全忽略（:55-61）；② 否则遍历 peers，只挑 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`（:62-72）；③ `semver.satisfies(v,range,{includePrerelease:true})`（:51-53）；④ `workspace:^|~|*` 视为当前运行时版本（:70）。

- **bundle 不匹配**：`loadProfileDirectory` 内 throw 被 catch → 进 `skippedBundles`，**整层不加载但 DSH 照常启动**（profile.ts:759-767）。
- **insert 行不匹配**：不走此判定（同处注释"A bundle is not a plugin row…"，profile.ts:759）⇒ ZS 的 `^0.1.0-rc.6` 在 0.2.1-rc.2 仍能跑。
- **安装期另有硬门**：`incompatible-version` ManagementFailure（boot/plugin-manager/src/index.ts:365-366,624-625），可申请精确版本豁免（profile-compatibility.ts:62-127）。

**建议**：用 `"engines": { "dsh": ">=0.2.1-rc.2 <0.3.0" }`（语义清楚、绕过逐条 peer 比对）。若要逐包写就照 AM（package.json:45-63，range 显式带 prerelease）。⚠️ 写 `engines.dsh` 后 peerDependencies 完全不再参与判定，别指望它还能卡 cordis 版本。

## 9. 坑清单

| # | 坑 | 现象 | 处理 |
|---|---|---|---|
| 1 | 用 `ctx.on('dispose')` 清理 | 永不执行，定时器/监听泄漏 | 一律 `ctx.effect` 或返回 disposer |
| 2 | dispose 不还原 / 无条件还原 | 热重载后包装叠 N 层，或误删别人的 | 符号守卫 + 引用比对还原（§5） |
| 3 | `ctx.set('workspaceRegistry',…)` 换服务 | 卸下后工作区/会话面挂掉 | 实例 overlay，不动服务注册 |
| 4 | 重复注册同一 `(kind,path)` 路由 | 抛 `duplicate prefix route`，apply 失败 | 路径带插件前缀；复用前先 dispose |
| 5 | 忘鉴权 | 任意网页可 POST 迁移接口 | 抄 ZS `isTrustedApiRequest` |
| 6 | 版本门 | bundle 被静默跳过，界面全无 | `engines.dsh` 写对；本地开发走 insert 行 |
| 7 | 写死 `~/.dsh` | 换 profile/工作区错位 | 用 `DSH_HOME`（空串视为未设置），ZS index.js:72-86 |
| 8 | 忘构建 client bundle | 组合期硬错 | `exports["./client"]` 的文件必须存在 |
| 9 | 自动表单不出现 | `describe()` 无该 ns | 字段加 `.volatile()`，或改自绘页面 |
| 10 | host 里 import client 包 | 解析失败/双份 React | host 与 client 两个入口严格分开 |
| 11 | 假设配置即时生效 | 桌面端有"需重启"先例 | 设计写"需重载/重启"+ 给校验判据 |

## 10. 未找到 / 待补

- **`dsh plugin add` 对非 bundle 插件是否自动写 insert 行**：源码只见 `not-bundle` 拒绝分支（boot/plugin-manager/src/index.ts:440），未找到"自动插入 patch 行"的实现；本文 insert 写法来自活动 profile 实践与 patch 解析器契约。待实测。
- **桌面端 `hmr` 是否真在跑**：base bundle 声明了该行（bundle/base/cordis.patch.yml:27-32），但桌面 app 是否 `disabled` 未逐项核对。待验：日志/`getEffects()` 是否出现 hmr 行。
- **typert strict codec 的完整 wire 约定**：只引到 AM 用法与 `bindTypertRemote`；若 v2 要官方 RPC 面需单独取证。
