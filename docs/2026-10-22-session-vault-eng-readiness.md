# 会话保险库 · 设计预评审与工程交接（进工程模式前必读）

- 日期 2026-10-22 ｜ 对象：需求档 v0.1 / 设计档 v0.2 / 安全边界档 v0.1 / UI 设计档 v0.1
- **2026-10-22 16:30 更新指针**：本文是[设计档 v0.3](2026-10-22-session-vault-design.md)的输入。B-1/B-2/B-3、S-1..S-5 已全部落进 v0.3；本文 §3 的 stages 见 v0.3 §15；**本文 S-2 提的 A-13（写路径白名单）/ A-14（AM 共存 no-op）在 v0.3 分别是 A-19 / A-18**（v0.3 的锚表见其 §12，A-5 已拆成 A-5a/A-5b/A-5c）
- 依据：两份调研备忘 + 本次对 `dsh-workspace/lib/index.js` 的独立复核（可读副本在 `.desktop-build/targets/win-x64/dsh/...` 下）
- 结论：骨架可用；**3 处阻塞 + 5 处应改**，补齐即可进工程模式（**2026-10-22 已并入设计档 v0.3；本档保留为评审记录**）

## 0 三句话

1. 骨架（只碰归档集合、整目录搬移、marker + sha256、fail-closed）是对的，不需要推倒。
2. 3 处阻塞都在**对外契约**层：一个和宿主记账契约冲突的 detach、两个没取证的 API 名、一个漏了触发器的 FTS DDL。
3. 补齐 3 处阻塞 + 5 处应改，即可发起会诊（问题见 §4）并进工程模式（stages 见 §3）。

## 1 阻塞项（写代码前必须定稿）

### B-1 🔴 「迁移时 detach」与宿主记账契约冲突，并让 I-10 不可执行

证据（同一文件 `dsh-workspace/lib/index.js` 的三段，两份调研都未引用）：

- `Workspace.mutate()` 是唯一写路径，每次写都按 `host.sessionPath(id) === record.path` 过滤 `sessionIds`（:173-191）⇒ 文件一搬走，宿主下一次任何写操作就会修剪掉这个 id，**与插件是否 detach 无关**。
- 域声明注释明写：`archivedSessionIds` 是分层在 workspace 记账之上的集合，**归档会话保留它的 `sessionIds` 槽位（unarchive 要还原位置）**（:228-239）⇒ 设计档 C-3 看到的「118 个归档 id 里 117 个仍在 sessionIds」**不是脏数据，是宿主的有意设计**。
- `attachSession()` 需要 `readSessionHeader(id)` + `realpathNormalize(header.cwd)`，且 cwd 必须是存在目录并等于 `record.path`（:111-129）⇒ **文件不在时 attach 必失败**，而 DSH 没有面向用户的 attach 入口。

**推论**：迁移后无论 detach 与否，id 都会在宿主下一次写时被修剪；恢复必须走 `attachSession`，而它只在插件里。**安全边界档 I-10「插件卸载后冷数据仍可手工恢复」在当前设计下不可执行**：把目录搬回原 projectKey，侧栏也不会出现该会话。

**修复（三条一起做）**：

1. **删掉 detach**（D6 改为 D6′：迁移不动记账，恢复时按需 attach）。理由：detach 省不掉修剪、多写一次宿主状态、多一个竞态面。
2. **P1 交付 `tools/vault-restore.mjs`**（不加载插件、纯 Node）：读 `manifest.jsonl` → 同卷 rename 搬回原 `projectKey` → 校验 header.id/cwd → **直接改 `storages/workspace.json`**（要求 DSH 未运行）把 id 插回该 workspace 的 `sessionIds` → 打印下一步（在官方 UI 取消归档）。
3. **I-10 验收改为可执行演练**：关 DSH → 跑脚本 → 起 DSH → 会话在侧栏可见且可继续对话，进 P1 验收清单。

### B-2 🔴 活跃检测用的两个 API 名没有取证

设计档 §6.1 前置 2 写的是 `ctx.sessions.get(id) === undefined` 且 `workspace/session-activity` waterfall 返回空。两份调研备忘里**这两个符号零命中**（已 grep 全 docs），而 `archiveSession` 内部已有 activity 门（调研只给了 P2:526-533 的行号，没给符号名）。

- 风险：服务名写错 = `inject` 缺失 = 插件永远 pending（调研档 §1.3）。
- 修复：前置 2 改为「复用 `archiveSession` 已通过的 activity 谓词（P2:526-533 同一函数）」；P0 加 spike 打印 `Object.keys(ctx.get(workspace))` / `ctx.get(sessions)` 的真实成员，把符号名回填设计档。

### B-3 🔴 external-content FTS5 缺维护触发器，照抄 §4.2 会得到「永远 0 命中」

调研档 §9 明确写了这条（`content=docs` 不会自动同步，需 `docs_ai/docs_ad` 触发器，否则 MATCH 永远 0 行），但**设计档 §4.2 的 DDL 里没有触发器**。

修复：DDL 补三条（insert / delete / update 同步 `docs_fts`），并把 A-5 拆成两条负向断言：注入消息不入索引；删除行同步出索引。

## 2 应改项（不阻塞，但建议同批修）

| 编号 | 问题 | 修复 |
| --- | --- | --- |
| S-1 | 「第 15 天」批量后果未量化：111 个 ≈ 955 MB 会按单轮上限 5 个、每 30 分钟一轮搬走（约 11 小时），首轮扫描在启动后 60 s | UI 顶部给「下次迁移窗口 + 待迁数量/体积」；安全边界档 §3 写清；加 `dailyBudgetMB` 或「每天最多 N 个」（建议默认 20） |
| S-2 | AC-8 / AC-9 / AC-10 无对应锚；I-1（不写工作区目录）在 A-1..A-12 里没有编号 | 加 A-13（注入假 fs，断言所有写路径以 vaultRoot/coldRoot 为前缀）、A-14（检测到 AM 时清扫为 no-op） |
| S-3 | manifest 与 DB 的写入顺序 / 崩溃补写没有算法（§11 只说「补 manifest」） | 定「DB 是事实源、manifest 是审计副本」；启动对账遍历 DB 行，manifest 缺失即补 `op:repair` |
| S-4 | UI 缺「按工作区」维度：chip 只有 全部/热归档/冷存储/收藏，表格也没有工作区列（预览页同样没有），而用户头号关切是三个具体工作区 | chip 增加「工作区 ▾」下拉（取 registry 的 root 名）；行第二行 meta 显示工作区 |
| S-5 | 证据坐标不可复现：文档说行号以 `resources/app.asar/...` 为准，但 `app.asar` 是**文件**（不是目录），rg/read 都打不开 | 坐标改成可读副本 `.desktop-build/targets/win-x64/dsh/...`，并抽样复核 3 条行号 |

## 3 实施映射（给 eng_coder 的 stages）

| 阶段 | 文件 | 验收 | check |
| --- | --- | --- | --- |
| P0-1 脚手架 | `package.json` `cordis.patch.yml` `lib/index.js` `lib/client.js` | 插件能加载、设置页出现「会话保险库」 | `node --test tests/p0.test.mjs` |
| P0-2 路由与配置 | `lib/http.js` `lib/config.js` | `/session-vault/api/status` 200；config 落 `<DSH_HOME>/session-vault/config.json` | `node --test tests/http.test.mjs` |
| P0-3 服务面 spike | `tools/spike.mjs` | 打印 sessions / workspace / webServer / slots 的真实成员名，回填设计档 | 人工读输出 |
| P1-1 帧层 | `lib/zstd-frames.js` | 15.3 MB 样本扫出 8246 帧；torn tail 不抛 | `node --test tests/frames.test.mjs` |
| P1-2 抽取与分词 | `lib/extract.js` `lib/tokenize.js` | 注入消息不入库；中文可搜 | `node --test tests/extract.test.mjs` |
| P1-3 存储 | `lib/store.js` | schema + 三触发器；docs → FTS 同步 | `node --test tests/store.test.mjs` |
| P1-4 引擎 | `lib/engine.js` | A-1 / A-2 / A-4 / A-10 / A-12 | `node --test tests/engine.test.mjs` |
| P1-5 恢复脚本 | `tools/vault-restore.mjs` | I-10 演练：关 DSH → 脚本 → 起 DSH → 会话可见 | 人工演练 |
| P1-6 UI | `lib/client.js` | 列表 / 迁移 / 恢复 / 批量条 | 人工（设置页截图） |
| P2 | `lib/sweeper.js` `lib/search.js` | A-3 / A-8 / S-1 预算 | `node --test tests/sweep.test.mjs` |

注意：宿主是 ESM + 内置 `node:sqlite`，测试一律用 `node --test`，**不要引 vitest / jest**。

## 4 给会诊的 4 个问题

1. **detach 与否**：B-1 的「删掉 detach」是否成立？有没有我们没看到的用例必须 detach？
2. **搬运预算**：第 15 天一次性搬 955 MB 是否要加每日上限？默认多少？（我建议 20 个/天）
3. **FTS 维护**：触发器 vs 应用层显式同步，哪个崩溃一致性与可测性更好？
4. **设置页 vs 独立页**：118 行 + 右抽屉塞进设置弹窗是否过挤？要不要 P2 就开独立页？

## 5 数据复核（2026-10-22 独立重算，非引用旧档）

| 项 | 读数 | 与文档一致 |
| --- | --- | --- |
| `archivedSessionIds` | 118 | 一致 |
| 118 个都还在磁盘 | 118 | 一致 |
| 归档合计 | 958.6 MB | 一致 |
| sessions 根 | 2090 目录 / 2278.9 MB | 需求档写 2064（时间漂移，建议标 as-of） |
| workspace-scan | 387 目录 / 503.3 MB / 归档 38 | 一致 |
| workspace-intel | 453 目录 / 627.4 MB / 归档 46 | 一致 |
| workspace-agent | 577 目录 / 627.6 MB / 归档 27 | 一致 |

结论：安全边界档 §2 的三个工作区表准确；「今天可自动迁移 0」的口径成立（回填 = 首次启动）。

