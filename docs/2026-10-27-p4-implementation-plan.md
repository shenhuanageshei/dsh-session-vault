# P4 子代理会话冷存 · 实施计划（v1，2026-10-27）

- 依据：[设计档 v0.4.1 §19](2026-10-22-session-vault-design.md)（含 §19.11 用户裁定） · [需求档 v0.4 P4](2026-10-22-session-vault-requirements.md) · [安全边界档 v0.4.0 I-15..I-18](2026-10-22-session-vault-safety.md) · [UI 设计档 v0.4 §7](2026-10-22-session-vault-ui-design.md)
- 状态：设计评审 PASS（2026-10-27，token 已签发），已交给 eng-coder 执行
- 交付形态：一个批次（5 个 stage，顺序执行，任一 stage 连续失败 2 次即停）

## 0. 全局约束（每个 stage 都适用）

1. 不改 class A 的既有语义（I-2 / I-7 / I-11 / A-13）；只做「分域」。
2. 所有写操作仍走 `engine.enqueue` 单串行队列；不新增并发写路径。
3. 代码风格沿用仓库现有：零依赖、ESM、`node --test`、中文注释带设计档出处。
4. 不手改 `lib/client.js`（由 `npm run build` 生成；`tests/ui-contract.test.mjs` 逐字节比对）。
5. 每个 stage 结束都必须让 `node --test` 全绿（允许新增测试文件先红后绿，但交付时全绿）。

## 1. Stage 1 — DB v3 + 配置 + header 事实扫描

**目标**：把「谁是子代理、谁引用了谁」变成可查询的落库事实。

| 项 | 内容 |
| --- | --- |
| 改动文件 | `lib/store.js`（USER_VERSION 3 + MIGRATIONS 追加 v2→v3：`origin` / `delegation_depth` / `parent_session` 三列，append 语义）、`lib/config.js`（三个新配置 + 校验 + RESERVED 不动）、`lib/engine.js`（`scanHeaderFacts()` + `isSubagentRow()` + meta 读写）、`lib/indexer.js`（`ensureRow` 顺带落三列） |
| 验收 | A-P4-13（**v1→v3 与 v2→v3 两条链**都通过、失败回滚；v1→v2 的 DDL 已在 store.js:183-207，本 stage 只追加 v2→v3）；`/status` 能读到 `subscan:at` / `count` / `gaps`；对真实 2414 个目录扫描 ≤ 30s 且不搬移任何文件 |
| 测试 | `tests/store.test.mjs` 增升级用例；`tests/subagent.test.mjs` 新建（扫描：假 fs 夹具 + gaps 判定） |
| 禁止 | 不建新表；不加 `vault_class` 列（class 是派生值，见设计 §19.7） |

## 2. Stage 2 — 资格 + 迁移 + 恢复 + 对账/列表分域

**目标**：class S 能安全迁移与恢复，且不污染 class A。

| 项 | 内容 |
| --- | --- |
| 改动文件 | `lib/engine.js`（`subagentCandidates()`、preflight 的 class 分支、`migrateNow` 后置复检、`finishRestore` 的 class S 分支、`reconcileRegistry` 跳过 class S、`list` 的 `class` 参数与 `toItem` 的 class/status） |
| 验收 | A-P4-1..A-P4-8：七条资格（含 **`restored_at` 冷却期**）、被引用永不迁、恢复零 `unarchiveSession`/`attachSession` 调用（spy 断言）、class S 冷行不进 A-13、`archivedSessionIds` 一字不改 |
| 测试 | `tests/subagent.test.mjs`（迁移/恢复/负向）；`tests/http.test.mjs` 补 `list?class=` |
| 禁止 | 不改 `migrateNow` 的 marker / sha256 / 跨卷分支行为（只加 class 参数与复检条件） |

## 3. Stage 3 — 自动清扫（class S）+ HTTP

**目标**：手动批量与自动清扫两条入口打通。

| 项 | 内容 |
| --- | --- |
| 改动文件 | `lib/sweeper.js`（`pauseReasonS` + `sweepSubagents()` + 独立预算/退避键）、`lib/http.js`（`subagent-scan` / `subagent-migrate` / `subagent-job` + `/status.subagent` + `list.class` 透传） |
| 验收 | A-P4-5（快照过期/gaps 非空 ⇒ 零搬移 + `/status.subagent.scanGaps` 逐条列出 + 「重新扫描」可解除）、A-P4-9；`subagent-migrate` 无 `confirm:true` 时 400；批量作业可取消、有进度 |
| 测试 | `tests/sweep.test.mjs` 增 class S 用例；`tests/http.test.mjs` 增路由与 `/status` |
| 禁止 | 不把 class S 塞进现有 `pauseReason()`（会互相污染）；AM 在场不暂停 class S |

## 4. Stage 4 — UI（设置页卡 + 面板双 chip）

**目标**：用户能看见、能迁移、能恢复。

| 项 | 内容 |
| --- | --- |
| 改动文件 | `src/ui/settings.tsx`（「子代理会话冷存」卡：开关/阈值/预算/读数/两个按钮/二次确认 + **卡顶部「打开主面板」恢复入口指路**）、`src/ui/panel.tsx`（顶部两个 chip + 子代理页两段列表 + 行操作）、`lib/client.js`（只由 `npm run build` 生成） |
| 验收 | UI 档 §7 的线框与文案红线逐条落地；`tests/ui-contract.test.mjs` 增断言（chip / 卡 / 二次确认文案 / 「搬走后宿主列表不再显示」提示） |
| 禁止 | 不接管 `sidebar.workspaces`；不引第三方 UI 库；不用 Markdown 星号文案 |

## 5. Stage 5 — 收口：全量测试 + 构建 + 文档状态同步

| 项 | 内容 |
| --- | --- |
| 改动文件 | `README.md`（P4 状态改为已实施 + 接口/限制）、`docs/2026-10-22-session-vault-design.md`（§19 状态行）、`docs/2026-10-22-session-vault-requirements.md`（状态行）、`package.json`（若需版本号，按仓库惯例） |
| 验收 | `node --test` 全绿（当前基线 234 项）；`npm run build` 后 `lib/client.js` 与源码渲染逐字节一致；真实库上 `/status` 的 `subagent` 段读数与预检口径一致（1271 / 555 MB ± 新增会话） |
| 测试 | 全套 + 一次只读实跑（不执行迁移） |

## 6. 检查命令（宿主验收配方，交付时逐字报告）

```powershell
node --test                                    # 全套（基线 234 项）
node --test tests/subagent.test.mjs            # 新能力
npm run build && node --test tests/ui-contract.test.mjs   # 构建产物一致性
```

## 7. 回退

- 代码：`git revert` 本批提交（仓库为本地交付，无远端发布）。
- 数据：class S 行在冷根里与原目录同构，`tools/vault-restore.mjs` 可整批搬回；DB 升级失败自动回滚（A-P4-13）。
- 配置：三个新字段写入非法值会被 `normalizeConfig` 明确拒绝，不会静默生效。

## 8. 明确不做

- 不删除任何子代理会话；不新开删除入口。
- 不做按工作区策略、不做整树打包、不写 `workspace.json`。
- 不改宿主 subagent 生命周期，不动运行中的子代理。

## 9. 首次交付失败与重排（2026-10-27 17:27）

**失败事实**：eng-coder 触达 30 分钟后台兜底（`dshBackgroundTimeoutMs=1800000`）被强制结算，未自报任何 stage 失败；最后写入 `lib/engine.js` 17:26:57，收口阶段文档已被改动。**全量 268 项：259 过 / 9 失败**，其中 2 项为 class A 回归（A-12、A1），7 项为 P4 未收口（`scanHeaderFacts` 计数、`orphanEdges` 溢出、`list` class 三值、`pauseReasonS` 四条、`gaps` fail-closed、`subagent` 三路由、UI 契约）。

**根因判断**：不是设计问题，而是**一个 30 分钟批次装不下 20 个文件**；收口阶段没有分批提交点，超时即整批报废。

**已做的防再发**：

1. 2026-10-27 仓库纳入 git（`git init`，首个检查点 `abe6b19`，另有行尾规范化提交 `ff0fee2`）——现在任何一轮都可 `git reset --hard` 回到检查点。
2. 本计划重排为**两个短批次**（同一设计 token），每批结束必须 `git commit`，把检查点前移：

| 批次 | 范围 | 完成判据 |
| --- | --- | --- |
| A | ① 修 2 项 class A 回归（`A-12`、`A1`）；② 修 6 项 P4 非 UI 失败（`scanHeaderFacts` 计数、`orphanEdges` 溢出、`list` class 三值、`pauseReasonS` 四条、`gaps` fail-closed、`subagent` 三路由） | `node --test` 只允许剩下 1 条 UI 契约失败 |
| B | ③ UI 契约（设置卡 / 双 chip / 文案红线）；④ `npm run build` 一致性；⑤ 全量 `node --test` 全绿；⑥ 文档收口（状态行只允许由架构师指定的文案，禁止自写「已实施」） | `node --test` 零失败 + 构建一致 |

**回退**：批次 A/B 各自提交；失败即 `git reset --hard <上一检查点>`，不需要手工回滚。

## 10. 批次 A 验收与裁决（2026-10-27）

**验收读数**：宿主侧 `node --test` = **268 项 / 267 过 / 1 失败**（仅剩 `P4 UI 契约`，属批次 B 范围）；`git diff --stat 56f49d0..HEAD` = 4 个文件（`lib/engine.js`、`lib/http.js`、`tests/subagent.test.mjs`、`tests/sweep.test.mjs`），无越界；`tests/` 的断言与期望值零改动（只有夹具修）。

**架构师裁决（两条偏离点）**：

| # | eng-coder 的做法 | 裁决 | 理由 |
| --- | --- | --- | --- |
| 1 | `subscan:count` 按「有 DB 行」计（迁就测试锚 3） | **驳回，按设计档**：count = 成功读到 header 的目录数（含无行目录）；测试锚期望改 3 → 4 | 覆盖读数失真会让「有目录没被算进覆盖面」；无行目录恰是最可能藏引用的那批 |
| 2 | `sessions` 根 ENOENT ⇒ 空集扫描（照常写 at） | **采纳**，并写进设计档 §19.9 | 否则空机/新装永远停在 `subagent-refs-incomplete`；EACCES/EIO 仍 fail-closed |


### 10.1 独立偏离审计（2026-10-27，teammate `p4-audit`，只读）

**结论**：文件范围干净（恰 4 个文件）、测试强度干净（断言零改动、夹具为加强）、资格七条与六项能力均为真实现；发现 6 处偏离（1 高 / 2 中 / 3 低），其中 1 处已由架构师驳回（§10 裁决 #1）。

| # | 严重度 | 审计发现 | 架构师处置 |
| --- | --- | --- | --- |
| 1 | 高 | `subscan:count` 被改成「有 DB 行」口径，与设计档「可读目录数」冲突；测试消息「只有三个目录能读到 header」与夹具（4 个可读）相反 | **已驳回**（§10 裁决 #1）：B2 改实现为可读目录数、测试期望 3→4、并改掉那句错误消息；`/status.subagent` 给 `count + gaps` 自检读数 |
| 2 | 中 | ENOENT 空集扫描**无日志、无姿态字段**；Windows 上卷掉也返回 ENOENT ⇒ 可能造出「新鲜 + 零缺口」的假完整快照 ≤24h | **采纳并补强**：ENOENT 必写 warn 日志 + `scanPosture`；再探 `DSH_HOME` 判别「空机」与「卷掉」，后者 fail-closed。已写入设计档 §19.9 |
| 3 | 中 | 扫描触发 ①②④ 未实现，唯一自动触发被 `subagentMigrate=false` 前置 return 挡掉；`SUBAGENT_FIRST_SCAN_DELAY_MS` 是死常量 | **裁决**：扫描与开关解耦（只读，不搬移）：启动 60s + 每 24h + 全量索引完成后各跑一次。已写入设计档 FR-P4-2 |
| 4 | 低 | `http.js` 的 `await engine.subscanSnapshot()` 是为异步测试替身加的；真引擎是同步函数 | **保留**（同步/异步两态都安全），B2 在交付说明里标注「防御性写法，非线上缺陷」 |
| 5 | 低 | A-12 / A1 的「class A 回归」实为**测试用「第 N 次 isArchived」模拟归档集合变化**造成的脆性；生产语义未变 | **接受结论并更正记录**：本批不再改锚（B2 不做），另立测试硬化待办；对用户的表述改为「锚点脆性触发，非生产语义变化」 |
| 6 | 低 | 设计档 §19 内嵌状态行与安全档 §0 仍写「已实施」，与三档「实施未完成」矛盾；`56f49d0` 提交消息声称的「四处假账」实际都在更早的 `abe6b19` 里 | **已修**（设计档 §19 状态块 → 「实施中」、安全档 §0 → 「实施中」）；`56f49d0` 消息不改写历史，在此留痕 |

**批次 B 拆分（同一设计 token）**：

| 批次 | 范围 | 完成判据 |
| --- | --- | --- |
| B1 | UI 档 §7 全量落地：设置页「子代理会话冷存」卡（含「打开主面板」指路）、面板双 chip、候选/冷存两段、四条暂停原因与 gaps 重扫按钮、文案红线；`npm run build` | `node --test tests/ui-contract.test.mjs` 全绿 |
| B2 | 裁决 #1 落地（count 口径 + 测试锚 3→4 + 消息更正）；审计 #2/#3 补强（ENOENT 留痕与判别器、扫描触发解耦）；全量 `node --test` 零失败；文档收口（状态行由架构师指定文案） | `node --test` 全绿 + 构建一致 |

## 11. 批次 B1/B2 交付说明与裁决（2026-10-27）

**验收读数**：全量 `node --test` = **274 项 / 274 过 / 0 失败**（B2 新增 6 条）；`npm run build` 产物 153,941 B 且与源码渲染逐字节一致；工作树 clean。

| # | 子代理提出的偏离/放宽 | 裁决 |
| --- | --- | --- |
| 1 | B2a 把 count 期望 3→4 落到三处同源断言（`report.scanned` / meta / snapshot），并新增自检断言 | **接受**：同一个量的三处读数必须一起改，只改一处必红；新增断言是加强 |
| 2 | 新增 meta 键 `subscan:posture`（设计只点名 `/status.subagent.scanPosture`） | **接受**：跨重启要保留真实姿态，失败路径不写该键；已补进设计档 §19.7 |
| 3 | `scanPosture` 第三态 `null`（从未成功扫描） | **接受**：没有事实不冒充 `ok`；UI 暂不展示（UI 档未要求） |
| 4 | sweep 报告新增 `subscan` 段 | **接受**：可观测性；无既有断言依赖该形状 |
| 5 | 全量索引完成后 `await` 一次过期扫描 | **接受**：失败只记日志、不把索引轮判失败 |
| 6 | B2c 数字输入改「本地草稿 + 失焦/回车提交」（`parseIntField` 校验、值未变不发请求） | **接受**：消除「输 14 过程中按 1 天阈值清扫」的安全窗口；布尔项仍即时保存 |
| 7 | B1 备案：「立即扫描」不补假进度、设置页也显示文案红线、恢复后的 class S 会话两段都不可见、黄条触发条件 | **接受**：同步路由没有进度事件，如实呈现比假进度好；其余与 UI 档一致 |

**未执行的事**：**没有在实机上搬过任何一个会话**。P4 的候选（≥14 天 1271 个 / 555 MB）仍原样在热目录；是否迁移、迁移多少，由用户在交付后决定。

## 12. 代码评审结论与后续待办（2026-10-27）

**结论：`VERDICT: PASS`**（无 🔴、无 must-fix）。评审逐条核对了七条资格、迁移/恢复 class 分支、对账分域、marker/manifest `class`、`archivedSessionIds` 零改动、count 口径、ENOENT 判别器、扫描解耦、HTTP `confirm` 门、UI 契约与 `vault-restore.mjs` 的 class S 跳过，并与 §19 / FR-P4 / I-15..I-18 / UI 档 §7 / 本计划 §10-11 的裁决对齐。

**4 条 🔵（非阻塞，本批不修，登记为后续待办）**：

| # | 位置 | 发现 | 处置 |
| --- | --- | --- | --- |
| 1 | `lib/sweeper.js:487` | `subagentSnapshot()` 读 `_lastConfig`，首拍（启动 60s 内）的 `/status.subagent.migrate`、`budget.limit` 可能读成 false/0 | **延后**：首拍后自愈，仅读数短暂失真；修法是 `start()` 预热一次 `config()`——留给下一轮抛光（会动 sweeper 启动路径，需回归 sweep 全量） |
| 2 | `lib/engine.js:194` | `HEADER_NON_REF_KEYS` 显式排除 `parentSessionId`，与「新 id 型字段自动进 orphanEdges」的注释相悖 | **延后**：当前 header 无该字段（120 抽样），属前瞻口径；修法是移出排除清单或写明依据 |
| 3 | `lib/engine.js:6377-6381` | `reconcileRegistry` 缺第三桶：`cold ∧ ¬archived ∧ 非子代理` 且 facts 丢失时会误标 `external-unarchived` | **延后**：当前生产路径不可达（迁移与冷导入都随行落三列）；改成 `needs-review` 属于动 class A 对账语义，须单独设计 + 锚点 |
| 4 | `lib/engine.js:1413-1415` | `registeredIdSet` 依赖 `header_cwd` 解析工作区，解析失败的行不受登记保护且无读数 | **延后**：由 archived/年龄/活跃三门兜底；可观测性问题留待 `/diagnose` 增强 |

**交付状态**：代码已实施、全量 274 项全绿、构建逐字节一致、评审 PASS；**实机迁移未执行**。要让它生效需要**重启 DSH**（宿主插件默认不热重载，重启时机由用户决定）。

