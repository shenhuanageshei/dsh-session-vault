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
