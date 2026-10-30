# 变更记录（Changelog）

本项目的版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)；日期为本地交付日。

## [0.4.2] — 2026-10-30

### 修复

- **class A 永久暂停（真机缺陷）**：`reconcileRegistry()` 对 `external-unarchived` **只打标记、从不清除** —— 一旦某次读到不含这些 id 的归档集合快照（启动早期 / 宿主重写 `workspace.json` 的窗口），标记永久残留，`Sweeper.pauseReason()` 见数量 > 0 就让 class A 暂停。真机实测 19 条 `team-link-*` 的 id 全部在 `archivedSessionIds` 里，属历史误标。新增自愈分支：集合重新包含该 id 且 `error` 恰为该错误码 ⇒ 清空 + `externalUnarchivedCleared` 计数 + warn 日志；只清这一个码，`lost` / `needs-review` 保护态与 A-13 打标语义不变（幂等）。回归测试 1 条（277 → **278 项**）。**需重启 DSH 生效**。

## [0.4.1] — 2026-10-28

### 修复

- **class A 恢复失败（真机缺陷）**：`originalOf()` 从 `registry[VAULT_ORIGINAL]` 取到的是**未绑定**引用，而宿主的 `archiveSession` / `unarchiveSession` 是依赖 `this` 的原型方法 ⇒ 恢复最后一步抛 `Cannot read properties of undefined (reading 'enqueueOperation')`。两条分支统一 `fn.bind(registry)`，并补「原型方法 `this`」回归测试（276 → **277 项**）。**需重启 DSH 生效**。

## [0.4.0] — 2026-10-28

### 新增：P4 子代理会话冷存（class S）

- **迁移类分域**：class S（子代理会话）与 class A（已归档会话）共用同一套搬移/校验/marker/崩溃收敛引擎，但资格、恢复、对账、列表四处**完全分开**；class A 的 I-2 / I-7 / I-11 / A-13 口径一字未改。
- **资格七条**：hot · 子代理（`origin=subagent` 或 `delegationDepth>=1`）· 未登记 · **无入边引用** · ≥N 天未活跃 · 非活跃 · 引用快照新鲜（≤24h、gaps=0）。
- **header 事实扫描**：`origin` / `delegation_depth` / `parent_session` 落库；`subscan:count`（可读目录数）+ `gaps` 自检；`scanPosture`（`ok` / `empty-root` / `null`）；扫描与 `subagentMigrate` 开关**解耦**（启动 60s / 24h TTL / 全量索引完成后）。
- **恢复**：搬回 → `persistence.stat` → `status=hot`；**不调** `unarchiveSession` / `attachSession`；恢复冷却期 `restored_at + N 天`。
- **HTTP**：`subagent-scan` / `subagent-migrate`（必须 `confirm:true`，否则 400 零写入）/ `subagent-job`；`/status.subagent`；`list` 增 `class` 参数（`archived` 默认 / `subagent` / `all`）。
- **UI**：设置页「子代理会话冷存」卡（开关 / 阈值 / 预算 / 只读读数 / 一键迁移 / 「打开主面板」指路）；主面板双 chip（归档会话 / 子代理会话）+ 冷存行「恢复」。
- **实机迁移**：2026-10-28 两批共 **1157 次**（273 + 884），0 失败、0 取消、marker 零残留；class S 冷存 **1156 个 / 533,401,237 字节**；恢复路径实机验证通过（`attach:null`、归档集合不变）。

### 修复

- **侧栏入口**：点「会话保险库」只弹搜索 —— 根因（插件行自渲染文字与按钮 / `main` 用 `id` 而非 `key` 注册 / 未注入 `layout` / 失败回退打开搜索）全部修复；`ui-contract` 增三条防回归断言。
- 设置页「收藏置顶」文案随排序模式修正（仅「按时间」模式置顶）。

### 改进

- 归档列表默认**按工作区排序**（工具条可切回「按时间」）；窗口化与固定行高不变。
- 测试规模收敛到 **276 项**，`node --test` 全绿；`lib/client.js` 与源码渲染逐字节一致（0.4.1 追加 1 条回归测试后为 277）。

## [0.3.0] — 2026-10-26（历史汇总，未单独打 tag）

- P0–P2：冷存储迁移 / 恢复引擎、自动清扫、全量索引、全文搜索、只读预览。
- P3a：`Ctrl/Cmd+Shift+K` 全局搜索 + `searchScope`（正文 / 正文 + 工具结果）。
- P3b：收藏、回收站（trash）、诊断与修复、列表窗口化。
