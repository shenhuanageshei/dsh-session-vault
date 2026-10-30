# dsh-session-vault（会话保险库）

把 DSH 的「归档会话」从**纯标记**升级为**可配置冷存储**：已归档且上次活跃超过 N 天（默认 14）的会话可整目录搬到
`<DSH_HOME>/session-vault/cold`，热目录只留冷索引（元数据 + 全文 + 审计）；需要时按落库事实一键搬回原 `projectKey`
并调官方 `unarchiveSession` 解除归档。支持所有工作区（热）/ 归档 / 冷存的统一列表与本地全文索引。

> **脱敏说明**：本仓库为公开准备做过脱敏——文档中的 `<DSH_HOME>`、`<USER_HOME>`、`<workspace-root>`、`<cold-root>`、`<DSH_INSTALL>` 是路径占位符；工作区/项目名已替换为中性名（`workspace-*` 等）；提交作者统一为 `dsh-session-vault <shenhuanageshei@users.noreply.github.com>`。代码逻辑与测试断言不受影响（277 项全绿）。

- 目标宿主：**DSH 0.2.1-rc.2** 桌面版（Node 24，ESM，内置 `node:sqlite` / `node:zlib` zstd）。版本门写在
  `package.json` 的 `engines.dsh = ">=0.2.1-rc.2 <0.3.0"`。
- 当前版本：**0.4.2**（2026-10-30）——变更见 [CHANGELOG.md](CHANGELOG.md)。
- 当前范围：**P0 + P1 + P2 + P3a + P3b + P4**（P4 = 子代理会话冷存：已实机迁移 class S **1156 个 / 约 509 MiB**，0 失败）（… / 自动清扫 / 全量索引 / 全文搜索 / 只读预览；P3a = **Ctrl/Cmd+Shift+K** 全局搜索（普通 Ctrl+K 归宿主）+ **检索范围** `searchScope`：默认正文，可选收录工具结果（只收结果、单条 8KB、不含参数）；P3b = 收藏 / 回收站 / 诊断修复 / 列表窗口化）。
- **P4（子代理会话冷存 / class S）已实施并于 2026-10-28 实机迁移**：批次 A/B1/B2/B3/B4/B5/B6/B7 交付，全量 **278 项全绿**；两批迁移共 1157 次（273 + 884），class S 冷存 **1156 个 / 533,401,237 字节**，0 失败，恢复实测通过；见[设计档](docs/2026-10-22-session-vault-design.md) §19 与下方「P4 子代理会话冷存（已实施）」。

设计文档（以下为唯一事实源）：

| 文档 | 内容 |
| --- | --- |
| [设计档 v0.4.2](docs/2026-10-22-session-vault-design.md) | 架构 / schema / 状态机 / 崩溃矩阵 / 验收锚 / §18 P3 设计 / §19 P4 设计 |
| [需求档 v0.4.1](docs/2026-10-22-session-vault-requirements.md) | FR-x / 用户故事 / AC（含 P4） |
| [安全边界档 v0.4.2](docs/2026-10-22-session-vault-safety.md) | 数据不变量 I-1..I-18 |
| [UI 设计档 v0.4.2](docs/2026-10-22-session-vault-ui-design.md) | 入口 / 线框 / 交互矩阵 / §7 P4 子代理视图 / §7.1 列表排序 |
| [变更记录 v0.4.2](CHANGELOG.md) | 版本历史与每次交付的内容 |

## P2 能力与限制（2026-10-23）

**自动清扫（FR-8 / §9）**

- `autoMigrate` 默认关；开启后启动 **60s 首扫**，此后每 `sweepIntervalMinutes`（默认 30）一次；
  先跑 `recoverOnBoot()` 收敛，再起 Sweeper（R-14）；定时器走 `ctx.setTimeout`/`ctx.setInterval`，卸载时 dispose。
- 候选 = `status=hot` + 在 `archivedSessionIds` + `lastActiveAt + archiveAgeDays*86400e3 <= now` + `next_attempt <= now`；
  单轮上限 **5**，日预算 `dailyBudgetCount`（默认 20，**按 UTC 日切分**、跨重启不重置 —— 见下方「口径」）。
- **只读回填 tick 先于所有短路**：`autoMigrate=false` 或 archive-manager 在场时也会跑（只补 DB 展示字段，不搬移文件）。
- 失败退避：`next_attempt = now + min(6h, 5min * 2^(failures-1))` ⇒ **首次失败 5 分钟**，此后 10/20/…（§15.1 #1）。
- **启动收敛失败也起跑**：Sweeper 以 `paused=true` 启动，`/status` 的 `sweep.sweepError` 与 UI 横幅给出原因，每一拍重试收敛、成功即自动解除暂停。
- 暂停条件：archive-manager 在场、冷根不可用、跨卷未开启、`restoring` 未收敛、`external-unarchived` 未收敛。
- **A-8**：阈值 / 开关 / 预算 / 间隔都在**每一轮清扫重新读**，设置页保存后下一次清扫立即生效（不重启、不重建实例）。

**全量索引与搜索（FR-9 / D21 / §8.4）**

- 覆盖 **全部会话**：热 + 归档 + 冷存。首次全量是后台任务：先冷存、再热归档、最后热会话（同档按最近活跃倒序）；
  有进度，可暂停/恢复，断点续做（已索引且水位未变的会话直接跳过）。
- 水位 = `(size, mtime, generation)`（只索引最高代际）；搜索前做**有界增量**：每次 stat 50 个、最多重索引 3 个变更会话。
- **目标集按 TTL 重扫**（默认 5 分钟）：全量索引完成后新建的会话**无需手动 start** —— 下一次 `/search`（或清扫）会重扫目录并把新/变更会话增量索引掉（`/search` 响应里 `refresh` 字段给出本轮结果）。
- `POST /session-vault/api/search`：`Intl.Segmenter` 预处理 + FTS5 `MATCH` + 按会话分组 + snippet + 状态
  （`running` 进行中 / `hot` 热 / `archived` 已归档 / `cold` 冷存）+ 工作区；**不依赖官方 sessionQuery**。
- 性能目标：1000 会话索引下搜索 p95 < 1s（`tests/search-perf.test.mjs`）；列表 118 行冷启动 < 2s、命中缓存 < 500ms。

**预览（FR-10）**

- `POST /session-vault/api/preview`：**只读**帧遍历冷/热日志，返回最近 N 条消息或命中上下文；
  不恢复、不打开会话、不写任何文件。reasoning / tool 参数不入预览。
- **遍历有上限**（§15.1 #5）：尾部优先解压，最多 `maxFrames`（默认 2048）帧 / `maxBytes`（默认 8 MB）压缩字节；
  被截断时 `truncated=true` 且 `traversal` 段给出 `frames / totalFrames / bytes` 读数（不把截断当完整结果）。
- `id` 必须匹配 `^[A-Za-z0-9._-]+$`（`. / ..` 直接拒绝），且解析后的目录必须落在 `sessions` 或已知冷根之内，否则 **400**（评审 #4）。

**已修的首启缺陷（P2-0）**

- `/list` 首启 36.8s 的根因是**逐 id `persistence.stat`（宿主每次扫全库）**。
  现在改为**一次目录扫描**（只 stat 归档集合里的会话）+ 进程内缓存（TTL + 事件失效），
  启动回填把 118 个归档 id 的 title/workspace/lastActiveAt/archivedAt/formatVersion/projectKey 入库。

**已知限制**

- 标题先取宿主投影缓存的 4KB 前缀（hint）；缺失时显示「（无标题）」，由全量索引回填真实 `session.title`。
- 全量索引由首次 `status/list/search` 请求触发（后台、幂等），也可用 `POST /rebuild-index {"action":"start"}` 手动启动；
  宿主重启后需要重新触发一次（水位已在库里，续做只处理变更/未索引的会话）。
- 索引是单串行写（不并发抢 SQLite）；大库首次建库需要几分钟（2.2 GB 实测量级），可暂停。
- 增量检查同时覆盖「已扫描过的目标列表」（有界水位）与「TTL 到期的目标集重扫」（默认 5 分钟，见上）；
  需要立刻发现新会话时仍可 `POST /rebuild-index {"action":"start"}` 强制重扫。
- 预览**不再**解压整份日志：尾部优先 + 帧/字节上限，截断时明确回 `truncated`（见上）。
- 索引进度与暂停状态持久化在 meta（`index:progress`）：重启后 `/status` 读到的是上次进度，暂停不会被偷偷续跑。
- 写/删路径日志（`writeLog` / `fsLog`）是**环形缓冲**（最近 500 条；`logLimit: 0` 可关闭封顶，单测用）。

**口径（2026-10-23 §15.1 裁定）**

- **日预算按 UTC 日切分**：预算键是 `sweep:budget:<YYYY-MM-DD>`（UTC），所以「今天用了多少」以 UTC 零点为界，
  与本地时区的零点**不同**；跨重启不重置。
- **「最近活跃」用 mtime 近似**：`lastActiveAt = max(docs.MAX(time), 代际文件 mtime, created_at)`。
  宿主日志没有统一的「最后事件时间」索引，mtime 是可复算、零额外读的近似口径（§9 / §15.1 #7）。
- **`pendingCount` 不静默封顶 50**：`/list`、`/status` 返回的是**全量候选数**与全量字节数，
  超过采样窗口时额外给 `pendingCapped=true`（`/list`）或 `candidatesCapped=true`（`/status`）。
- **「只索引最近 N 天」本批不实现**（设计 §8.4）：配置位刻意留空（`config.js` 的 `RESERVED_CONFIG_FIELDS` 登记为 P3），
  现在写入 `indexRecentDays` 会被按未知字段**明确拒绝**，不会变成静默 no-op。

## P4 子代理会话冷存（已实施并在 2026-10-28 实机迁移）

**问题**：DSH 的子代理会话（`origin=subagent` / `delegationDepth>=1`）不进侧栏、不进归档集合，
却和普通会话一样占目录、占磁盘、占宿主每次 `persistence.list()` 的枚举成本。本机实测（2026-10-27 16:17，只读预检）：

| 指标 | 数值 |
| --- | --- |
| 会话目录总数 | 2414 个 / 2301 MB |
| 其中子代理会话 | 1893 个 / 920 MB（78% 的目录） |
| 可搬候选（未登记 + 未被引用 + header 可读） | 1878 个 / 909 MB |
| 其中 ≥14 天未活跃 | **1271 个 / 555 MB** |
| 被其它会话引用（有子会话 / fork 指向它）⇒ 不搬 | 15 个 |

**方案要点**（完整设计见[设计档](docs/2026-10-22-session-vault-design.md) §19）：

- 新增**迁移类 class S**，与现有归档类（class A）共用搬移/校验/marker/崩溃收敛，但资格、恢复、对账**分域**；
- 资格七条缺一不可：hot · 子代理 · 未登记 · **无入边引用** · ≥N 天 · 非活跃 · 引用快照新鲜（≤24h 且 gaps=0）；
- 恢复**不调** `unarchiveSession` / `attachSession`（它本就不在归档集合），只搬回 + `stat` + `status=hot`；
- 默认关：`subagentMigrate=false`，先手动批量、再开自动（默认 50 个/天）；
- DB 升级 v2→v3：`sessions` 追加 `origin` / `delegation_depth` / `parent_session` 三列（全量 header 扫描回填）。

**已知代价**：搬走的子代理不再出现在宿主 `session.list`（父会话的 lineage 缩进行会少掉它们），
点击历史子代理卡片会得到 `subagent/not-found`——这是减负的目的，但用户需要知情；保险库的搜索/预览/恢复是找回入口
（UI 里就是这句话的原文，见设置页「子代理会话冷存」卡与面板「子代理会话」页）。

**实施落点（已交付）**

- **DB v2→v3**：`sessions` 追加 `origin / delegation_depth / parent_session`（append；v1 库走 v1→v2→v3 同一条链）。
- **header 事实扫描**：只读每个会话目录的**首帧 header**，产出 meta `subscan:at / count / gaps / orphanEdges`；
  gaps 非空或快照超过 24h ⇒ **一个都不搬**（I-18，fail-closed），修好坏目录后「重新扫描」自动解除。
- **资格七条**：hot · 子代理（`origin=subagent` 或 `delegationDepth>=1`）· 未登记（`workspace.sessionIds`）·
  无入边引用（`parent_session` 与无行目录的 `orphanEdges` 两个来源）· ≥N 天（含 `restored_at` 冷却期）·
  非活跃 · 快照新鲜。任一不满足 ⇒ 拒绝（`/migrate` 会回具体 code：`referenced` / `registered` / `too-recent` …）。
- **迁移/恢复**：完全复用 marker + 全代际 sha256 + 跨卷 copy/校验/删源；manifest 行带 `"class":"subagent"`；
  **`archivedSessionIds` 零改动**；恢复只搬回 + `persistence.stat` + `status=hot`，**不调** `unarchiveSession` / `attachSession`。
- **对账/列表分域**：class S 冷行不进 A-13（不会被标 `external-unarchived`、不会锁死清扫器）；
  `/list` 的 `class` 三值 `archived`（默认）/ `subagent` / `all`。
- **自动清扫**：独立暂停四条（`subagent-refs-incomplete` / `cold-unavailable` / `cross-volume-disabled` /
  `restoring-unsettled`）、独立预算键 `subscan:budget:<UTC 日>`、独立退避键 `subscan:fail:<id>`、
  单轮上限 10；AM 在场**不**暂停 class S。手动批量上限 2000（可取消、有进度，进度落 `subscan:job`）。
- **卸载后手工恢复**：`tools/vault-restore.mjs` 读 manifest 的 `class`；class S 行**跳过** `--write-workspace`。
## 接口

`/session-vault/api` 全部 **POST + 仅本机 + 同源**：

| 接口 | 说明 |
| --- | --- |
| `status` | 配置 + `queue / errors / stats` + `index`（indexed/total/phase，跨重启从 meta 读）+ `sweep`（nextRunAt/预算/暂停原因/`sweepError`）+ `subagent`（class S：候选/冷存读数、scanAt/scanGaps、paused/pauseReason、job） |
| `list` | 热归档 + 冷归档 + 本插件行；一次目录扫描 + 缓存；顶部统计含下次清扫、全量待迁量（`pendingCount` / `pendingCapped`）；P4 起支持 `class`（`archived` 默认 / `subagent` / `all`） |
| `migrate` / `restore` / `archive` / `unarchive` | 迁移 / 恢复 / 归档 / 取消归档（`id` 或 `ids`） |
| `search` | `{ q \| query, limit?, workspace?, state? }` → 分组结果 + snippet + 状态 + 索引进度 |
| `preview` | `{ id, limit?, q? }` → 只读最近 N 条 / 命中上下文 |
| `rebuild-index` | `{ id \| ids }` 重建；`{ action: "pause" \| "resume" \| "start" }` 控制全量索引 |
| `subagent-scan`（P4） | `{action:"start"\|"status"}` → header 事实扫描（写 `origin` / `delegation_depth` / `parent_session`） |
| `subagent-migrate`（P4） | `{all:true}` 或 `{ids:[...]}` + 必须 `confirm:true`；后台按上限逐条迁移 |
| `subagent-job`（P4） | `{action:"status"\|"cancel"}` → 手动批量进度 / 取消 |
| `config` | 读写运行期配置（保存即生效） |

## 构建

零依赖、离线可用（不需要 pnpm install，也不引任何打包器）：

```bash
npm run build          # = node scripts/build.mjs → 生成 lib/client.js
```

`lib/client.js` 是唯一合法的 client bundle（`window.__ModuleLoader__.load({ id, factory })`），由
`scripts/build.mjs` 把 `src/ui/panel.tsx` + `src/ui/settings.tsx` **原样并入** bundle 壳生成。
那两个 `.tsx` 是「同一模块作用域里的源码片段」，**不得写 import / export**（依赖 React、`h`、`vaultApi`、`ctxRef` 等由壳提供）。
`tests/ui-contract.test.mjs` 会重新渲染一次并与 `lib/client.js` 逐字节比对，防手改漂移。

## 测试

全部测试用 **`node --test`（无参数，Node 24 自带测试运行器发现 `**/*.test.mjs`）**，禁止 vitest/jest；
写测试一律**只用临时目录**（`os.tmpdir()`），不触碰真实的 `~/.dsh/sessions`（两条真数据回归是**只读**扫描 + 缺样本自动 skip）。

```bash
node --test                              # 全套（等价于 npm test）
node --test tests/engine.test.mjs        # 单文件也可以
```

| 文件 | 覆盖 |
| --- | --- |
| `tests/p0.test.mjs` | P0-1 脚手架 / 双半身入口 |
| `tests/http.test.mjs` | P0-2 路由与配置（loopback + POST + 同源） |
| `tests/frames.test.mjs` | P1-1 多帧 zstd 扫描 / torn tail |
| `tests/extract.test.mjs` | P1-2 抽取与分词（v4 fail-closed；v0/v3 legacy 形态） |
| `tests/store.test.mjs` | P1-3 SQLite + FTS 三触发器 |
| `tests/engine.test.mjs` | P1-4 迁移/恢复/验收锚 + A-19 假 fs 写路径白名单 + 基线收敛分支 + **P2-0 118 行列表性能/回填** |
| `tests/recovery.test.mjs` | P1-4 崩溃矩阵与真值表 |
| `tests/marker.test.mjs` | C-11 projectKey 与宿主逐字一致（含真实目录名与真数据只读回归） |
| `tests/sweep.test.mjs` | P2-1 自动清扫（到期/预算/退避/暂停条件/A-8 即时生效/定时器 dispose） |
| `tests/search.test.mjs` | P2-2 全量覆盖 / 最高代际 / 水位增量 / 暂停续做 / 建库顺序 / search API |
| `tests/search-perf.test.mjs` | P2-2 1000 会话索引下搜索 p95 < 1s |
| `tests/ui-contract.test.mjs` | P1-6 + P2-3 UI 契约（席位 / 搜索 / 预览 / 索引进度 / 构建产物逐字节一致）+ **M7/#7**（chip+工作区进 search、`<mark>` 高亮、回车取搜索首条）+ **P4**（子代理冷存卡 / 双 chip / 文案红线 / 二次确认） |
| `tests/subagent.test.mjs` | **P4**：header 事实扫描（gaps / orphanEdges 溢出）、资格七条（A-P4-1..5 含负向与恢复冷却期）、迁移（A-P4-6，`archivedSessionIds` 零改动）、恢复零 unarchive/attach（A-P4-7）、对账分域（A-P4-8）、列表三值、迁移后复检搬回、离线脚本 class S 跳过 `--write-workspace`（A-P4-12） |
| `tests/p3-1-shortcut.test.mjs` | P3a：Ctrl/Cmd+Shift+K 全局搜索快捷键（与宿主 Ctrl+K 互不抢占） |
| `tests/p3-2-search-scope.test.mjs` | P3a：`searchScope` 枚举 / 升级 pass / 缺口与重试口径 |
| `tests/p2-6-fixes.test.mjs` | **P2.6 收口轮**：跨卷搬回删源前基线校验（篡改⇒冷源保留+needs-review）、hydrate 口径（面板恒恢复）、`maxConcurrentJobs` 转预留、id 形状统一校验、snippet 取原文、Sweeper started 校验、ctx 定时器代理抛错退全局（B1/B2） |
| `tests/p2-4-fixes.test.mjs` | **P2.4 修复轮（代码评审 🔴）**：宿主侧包装安装作用域修复、编程错误 vs 宿主不支持分离、apply 级集成（包装生效/dispose 还原/A-9）、sweep 未挂上读数合并、manifest 去重索引 |
| `tests/p2-3-fixes.test.mjs` | **P2.3 修复轮（第二次真机验收）**：启动链定时器直连 `ctx.setTimeout` + `/status.boot`；registry 形状取证与 Proxy/原型/绑定三种安装；自愈退避与停手；`/diag` + `retry-overlay`；UI 三支提示 |
| `tests/p2-2-fixes.test.mjs` | **P2.2 修复轮（真机验收后）**：F1 启动链重试 + `/status.sweep` 永不为 null；F2 存量 archived_at 回填与列表自愈；F3 包装漂移链式重装（限流/取证）；F4 列表冷启动并发限流；F5 coverage/indexedThisRun 口径 |
| `tests/p2-1-fixes.test.mjs` | **P2.1 修复轮**：M1 目标集 TTL 重扫 / M2 archivedAt 双缺口 / M3 启动恢复失败也起跑 / M4 列表缓存与批量活跃 + HTTP 计时 / M5 索引写进队列 / §15.1 全量口径 + 预览上限 + 进度持久化 + 环形缓冲 / #3 逐文件校验 / #4 预览 id 与 containment / #6 环形日志 / #8 favorite |

服务面 spike（人工读输出，只读）：`node tools/spike.mjs`（可加 `--root <resources/app.asar|检出副本目录>`）。

## 本地加载

1. 构建 client：`npm run build`。
2. 在活动 profile 里把本仓库当本地依赖（与 `team-link-plugin` 同款写法），或在 profile 的 `cordis.patch.yml` 手写 insert 行：

   ```yaml
   - insert:
       - id: dsh-session-vault
         name: 'dsh-session-vault'
   ```

   作为 bundle 安装时，本仓库自带的 `cordis.patch.yml` 就是那条 insert 行（`dsh.bundle.patch`）。
3. **host 改动需要重启 DSH**（宿主代码默认不热重载；重启时机由用户决定）；client 重建后由宿主 HMR 自动刷新。
4. 运行期配置在 `<DSH_HOME>/session-vault/config.json`（保存即生效，无需重启）；插件数据（DB / manifest / markers）也在同一目录。

> `DSH_HOME` 为空串时按「未设置」处理，回退 `~/.dsh`；绝不写死路径。

## 数据布局

```
<DSH_HOME>/session-vault/
  config.json          # 运行期配置（UI 保存即生效）
  vault.db             # SQLite（schema v3）：sessions/docs/frames/meta + external-content FTS5（三触发器）
  manifest.jsonl       # 追加式审计（DB 是事实源，manifest 是审计副本）
  markers/<id>.json    # 迁移/恢复中的崩溃标记（含全代际 sha256 基线）
  cold/<projectKey>/<sessionId>/   # 默认冷根（必须与 sessions 同卷、且在 sessions 之外）
```

## 安全边界（摘要）

- **class A** 只处理 `archivedSessionIds` 里的会话，未归档会话不读不搬（I-2/I-3）；**class S**（P4 子代理会话）按 I-15 另行判定，见[设计档 §19](docs/2026-10-22-session-vault-design.md)。
- 迁移前校验「目录名 == `projectKey(header.cwd)`」；迁移后复检，已取消归档/活跃则**立即搬回**（I-4/I-6）。
- 恢复顺序固定：搬回 → `persistence.stat` 校验 → 官方 `unarchiveSession`（**原件**，绕过包装）→ `attachSession`（尽力）。**class S 例外**：子代理会话只搬回 + 校验，**不调** `unarchiveSession` / `attachSession`（I-16 / FR-P4-5）。
- 冷根不允许放在 `sessions` 之内（会让 `persistence.list()` 抛错）；跨卷需显式开关 + 二次确认。
- **任何失败都不删源**；无法判定的状态落成显式标记态 `error=needs-review` / `error=lost`（双份保留，启动例程永不自动删双份里的任何一份）。
- HTTP 只接受 loopback + POST + 同源（`sec-fetch-site` / `Origin` 自校验）；宿主不鉴权。

## 卸载后手工恢复（I-10 演练 / AC-12）

```bash
node tools/vault-restore.mjs --dry-run                 # 默认就是 dry-run：只看计划
node tools/vault-restore.mjs --apply                   # 真搬（校验 sha256，失败保留双份）
node tools/vault-restore.mjs --apply --write-workspace # 再写回 workspace.json（**必须先退出 DSH**，会先备份）
```

脚本不加载插件、纯 Node；不改 `archivedSessionIds`——搬回后到官方 UI 点「取消归档」即可。