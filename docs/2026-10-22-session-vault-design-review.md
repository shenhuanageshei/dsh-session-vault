# dsh-session-vault 设计评审（第 2 轮 · 独立复核）

- 日期：2026-10-22 16:10 ｜ 性质：设计评审（对象：设计档 v0.2 + 安全边界档 v0.1 + UI 设计档 v0.1 + 需求档 v0.1 + 两份调研 + 工程预评审 eng-readiness）
- **2026-10-22 16:30 更新指针**：本文是[设计档 v0.3](2026-10-22-session-vault-design.md)的输入。R-1..R-5、Y-1..Y-10、BL-1..BL-5 全部落进 v0.3；本文新增的 A-15（marker 基线）/ A-16（改冷根可恢复）/ A-17（cold id 不隐形）/ A-18（引擎不重入包装）在 v0.3 分别是 **A-15 / A-16 / A-13 / A-17**（v0.3 的锚表见其 §12，A-5 已拆成 A-5a/A-5b/A-5c）
- 源码复核基准：<workspace-root>/harness-checkout/apps/desktop/.desktop-build/targets/win-x64/dsh/node_modules/@deepseek-ai/dsh-workspace/lib/index.js（下称 P2′；本轮逐段复核 :100-129 / :148-153 / :173-191 / :228-248 / :495-558）
- 结论：**有条件通过**。骨架（整目录搬移、marker、fail-closed、自建索引、身份复算校验）成立，不推倒；5 处阻塞全部是契约/状态机层修订。修完 🔴 并把 eng-readiness 结论合入设计档 v0.3 后，可进工程模式。

## 0. 三句话结论

1. 方向对：只碰归档集合、整目录搬移、marker 收敛、fail-closed，这套骨架不需要动。
2. 状态机有 5 个真实洞：同卷迁移无完整性基线（A-1 根本不可验证）、崩溃收敛漏 I-6 复检、coldRoot 变更搁浅已迁数据、官方 UI 可把冷会话取消归档成隐形、包装重入死锁。
3. 问题③的答案：**保留并升级包装**（两个方法都包 + 引擎调原件 + AM 在场降级轮询）；只做手动迁移不成立。

## 1. 对 eng-readiness（第 1 轮预评审）的对账

| 编号 | 本轮裁定 | 说明 |
| --- | --- | --- |
| B-1 删 detach | **采纳，独立复核成立** | P2′:178 每次 mutate 按 sessionPath 剪枝；P2′:231-235 与 :496-500 证明「归档会话保留 sessionIds 槽位」是宿主有意设计；P2′:111-129 attach 需要 cwd 目录存在。D6→D6′ + tools/vault-restore.mjs + I-10 可执行演练，照单执行 |
| B-2 活跃检测 API 未取证 | **部分升级** | workspace/session-activity waterfall 名称已在 P2′:527 核实（archiveSession 内部活跃门就是它）；前置 2 可直接写「ctx.waterfall(同名, {sessionId}, () => [])，与 archiveSession 同一谓词」。ctx.sessions.get 仍留 P0-3 spike 验证 |
| B-3 FTS 缺触发器 | **采纳** | DDL 补 insert/delete/update 三条；A-5 拆成两条负向断言 |
| S-1..S-5 | **全部采纳** | S-3（manifest 补写）并入本文 Y-4 |

**文档同步债**：设计档 v0.2 仍写着 detach（§6.2 循环、§14 D6、C-3 行），与 eng-readiness 修复案互相矛盾——进工程前必须出 v0.3 合一（§8 有修订清单）。

## 2. 阻塞项 🔴（5 处，写码前必须定稿）

### R-1 同卷迁移没有完整性基线，A-1 不可验证

- 证据：设计 §6.2 同卷分支只 persistence.stat 记 bytes；rename 之后源目录已不存在，§6.3 后置条件与 A-1 却要求「sha256 与源一致」——**无处取值**。跨卷「删源中断且源被部分删除」（22 个目录含两代文件，removeDir 可删一半）时，崩溃收敛同样没有对照基准。manifest 里的 sha256 是事后从 dst 算的，不构成基线。
- 修复：preflight 对**目录内全部代际文件**算逐文件 sha256 + 文件清单，写进 marker（phase=planned 即含）；同卷 rename 后对 dst 复算校验；一切崩溃收敛以 marker 为唯一基准。代价：迁移前多读一遍源（实测均值 8 MB、最大 34.5 MB，秒级）。
- 新锚 A-15：同卷迁移后可离线验证「marker 基线 vs 冷目录实测」一致。

### R-2 崩溃收敛跳过 I-6 复检，可把用户刚解除归档的会话固定成冷态

- 证据：§11 矩阵「rename 后、detach 前 → detach+索引+收尾」直接收尾。若崩溃前用户恰好取消了归档（复检还没跑），收敛成 cold ⇒ 该会话官方 UI 全隐形（用户感知=丢失），直到有人进保险库页找到它。
- 修复：收敛语义改为「从最后持久步恢复」：phase=planned 且 dst 在 ⇒ 先重跑 I-6（id∈archivedSessionIds 且 activity 谓词为空），不过 ⇒ 搬回 + error=race-unarchived；过了才续尾段。A-3 措辞同步。D6′ 落地后矩阵中 detach 两行删除，本行并入「复检+索引+收尾」。

### R-3 coldRoot 变更会让已迁会话在应用内不可恢复

- 证据：FR-1 明确「已迁数据不自动搬」= 多冷根是受支持状态；但 §4.2 sessions 行只有 rel_dir，§7 restore 用「当前 coldRoot/rel_dir」拼 src，§11 对账「冷目录有、DB 无 → 导入」也只扫当前根。根目录一改：旧行全部 lost / 无法从 UI 恢复（manifest 有绝对路径仅手工可救；I-10 兜底 ≠ 应用内可用）。
- 修复：sessions 行记**迁移时的绝对冷根**（或 roots 表 + root_id）；restore 与启动对账遍历全部已知根；UI 按根分组。
- 新锚 A-16：改冷根后，旧根上的会话仍可从 UI 一键恢复。

### R-4 「冷会话被外部取消归档」是未定义状态，官方 UI 一点就隐形

- 证据（源码复核）：P2′:549-558 unarchiveSession 不做存在性检查；P2′:231-235 归档会话保留 sessionIds 槽位、unarchive 承诺「还原位置」——文件不在时承诺落空。用户在官方 UI 对已搬走会话点「取消归档」⇒ 文件在冷、id 已离开归档集 ⇒ 全 UI 隐形。AM 的 pruneUnknownArchivedSessionIds 会**批量**制造此状态（AC-9 只暂停清扫，不保护已冷行）。§8.4 只说「以 registry 为准并记差异」，没定义动作——按字面执行甚至可能把冷行静默丢弃。
- 修复：命名该状态（status=cold 且 id∉archivedSessionIds ⇒ 派生标记 externalUnarchive）：横幅「N 个冷会话已被外部取消归档」+ 一键恢复；wrapped unarchiveSession 对 cold id 改为**透明水合**：先 enqueue 完整 restore（搬回→校验→attach）再调原件 ⇒ 官方 UI 的取消归档就地变成恢复，零隐形。
- 新锚 A-17：对 cold id 调 registry.unarchiveSession 后，会话文件必在热目录且可见（或报明确错误），绝不出现「操作成功但会话隐形」。

### R-5 包装重入：引擎调 unarchiveSession 打回包装自身 ⇒ 死锁/递归

- 证据：FR-2 包装两个方法；§7 restore 调 registry.unarchiveSession（= 包装后的自己）。R-4 的修复让包装 enqueue restore 后，串行队列上 restore 等 unarchive、unarchive 等 restore 入队 ⇒ 死锁；即便包装只是被动记录，restore 也会给刚恢复的会话误记一次 unarchive 时间戳。
- 修复：install 时捕获 original 引用；引擎内一律调 original（绕过包装）；包装识别「引擎调用」内部标记直接放行（双保险）。
- 新锚 A-18：restore 全程不重入包装（断言 original 被调用）。

R-4 与 R-5 必须同批交付（互为前提）。

## 3. 应改项 🟡（10 处）

| 编号 | 问题 | 修复 |
| --- | --- | --- |
| Y-1 | 恢复跨卷崩溃无矩阵行；not exists(dst) 遇 .partial 残留永久卡死 | restore 复用 migrate 的 .partial+verify+rename 模式；§11 补 2 行；重试前清 dst.partial |
| Y-2 | restore 收尾写 status=hot（=迁移候选），枚举 hot_active 从未写入；清扫候选只查 DB | restore 完成 → status=hot_active（终态）；候选过滤加 id∈archivedSessionIds；非归档热行就地 park 成 hot_active，不进退避重试 |
| Y-3 | marker 无 fsync，断电序下「rename 落盘而 marker 丢失」 | writeMarker 后 fsync 文件+父目录再动文件系统 |
| Y-4 | 尾段（索引/DB/manifest）逐步失败语义未定义 | 任一步抛错 ⇒ 保持 migrating+marker，收敛续跑；manifest 按 S-3「DB 为事实源、缺则补 op:repair」，append 前按 id+op+moved_at 查重 |
| Y-5 | readHeader 样例 readFileSync 全文件；§13 预留 2 GB 上限 | 首块 64KB 增量读、帧不完整扩读、header 帧上限 1MB；preflight/restore/对账统一走它 |
| Y-6 | torn tail（历史崩溃遗留碎尾）会整会话 error=frame-corrupt | 完整前缀照常索引 + torn_tail 标记；仅「干净帧边界后 magic 错」才拒绝迁移；A-5 拆分 |
| Y-7 | 打包行（text-chunks）可能造成重复 doc；v0/v3 的 user/message 可能无 source.kind | 加「打包行不产生重复 doc」负向锚；v0/v3 抽取规则先对 P3:545-588 验证再写码 |
| Y-8 | 8246 帧 zstdDecompressSync 同步段卡事件循环 | 与拷贝同纪律：每 N 帧/每 16MB setImmediate；NFR「不阻塞」明确覆盖索引 |
| Y-9 | AM 在场只暂停清扫，overlay 叠加仍有卸载序脆弱性（调研 §5） | 检测到 AM ⇒ 完全不 install overlay，archivedAt 与 R-4 检测降级清扫轮询（30min 对 14 天阈值无伤）+ 横幅明示降级 |
| Y-10 | 列表接口每请求 persistence.list()（全量 frame-0 读） | 缓存 + 归档/迁移/恢复事件失效；NFR 首屏 <500ms |

## 4. 建议 🔵（5 处）

| 编号 | 建议 |
| --- | --- |
| BL-1 | format_version 白名单 {0,3,4}；出现 v5 ⇒ 拒迁 fail-closed + 锚 |
| BL-2 | 搜索可见性：status=hot 行命中需现场查 registry 归档集（防已取消归档的僵尸命中） |
| BL-3 | 工作区已删除的 restore：文案改「已恢复到磁盘原位；重建工作区后重试 attach」+ 提供重试入口（attachSession 要求 cwd 目录存在，P2′:121） |
| BL-4 | 全量迁移后启动将出现每会话一条 session header is missing warn（118 条），写进诊断说明，别当故障 |
| BL-5 | archivedAt 只在「集合进入沿」记时：already-archived 的 archiveSession 早退路径（P2′:524）不得刷新时间戳 |

## 5. 三个评审问题的答复

### ① 迁移/恢复状态机：丢数据或半目录窗口？

有，共 4 处（R-1/R-2/R-3/R-4），全部可修且不动骨架；修完后「热完整/冷完整」二态收敛才真正成立。半目录窗口本身已被「同卷 rename + 跨卷 .partial+verify+rm + C-14 tmp 跳过 + C-15 单日志目录」四件套压住——这部分设计是对的。修订后的收敛图：

~~~mermaid
stateDiagram-v2
  direction LR
  [*] --> hot
  hot --> migrating: preflight(全代际sha入marker)+rename
  migrating --> cold: I-6复检→索引→DB→manifest→删marker
  migrating --> hot: 复检不过→搬回(race-unarchived)
  cold --> restoring: 用户恢复 / 透明水合
  restoring --> hot_active: 搬回→stat→attach→unarchive(调original)
  cold --> coldExt: 官方UI外部取消归档
  coldExt --> hot_active: 横幅+一键恢复(同restore)
~~~

### ② 帧遍历 + 索引抽取的实现风险

算法层风险低：scanFrames 与宿主同构（3 字节块头上限 2MB ≥ zstd 128KB 块上限；FCS/dict/window 位序核对无误；xxhash 随帧校验）。真风险在工程细节：Y-5（全文件读 vs 增量）、Y-6（torn tail 语义）、Y-7（打包行/旧格式）、Y-8（CPU 让出）、BL-1（未来 v5）。

### ③ 包装 archiveSession 还是只做手动迁移？

**保留并升级包装，不能只做手动迁移**（决策表见 §6）：archivedAt 只有包装能准时拿到（C-10）；冷会话被官方 UI 无检查 unarchive（C-2、P2′:549-558）只能靠包装当场拦截成「透明恢复」；只做手动迁移 ⇒ US-5 自动迁移无计时源 + R-4 隐形窗口拉长到清扫周期。

## 6. 决策表（前因后果 / 建议 / 代价）

| 编号 | 决策点 | 前因后果 | 建议 | 代价 |
| --- | --- | --- | --- | --- |
| D-16′（新） | 包装两方法（升级为带拦截）vs 只做手动迁移 | archivedAt 无宿主来源（C-10）；冷会话可被官方 UI 无检查 unarchive（C-2、P2′:549-558）。只手动 ⇒ US-5 无计时源 + R-4 隐形窗口拉长到清扫周期 | 包装 archiveSession+unarchiveSession；R-4 透明水合 + R-5 原件捕获 + Y-9 AM 降级 | overlay 维护面（调研 §5 模式已备）；不包装的代价：计时失真 + 隐形检测延迟 30min |
| D-17（新） | 冷根按行记忆 vs 只记 rel_dir | FR-1 支持多冷根（改根不搬旧数据），rel_dir+当前根拼路径必然断 | sessions 行记迁移时绝对冷根（或 roots 表） | 每行多一列；对账遍历多根 |
| D6′（背书 B-1） | 迁移不 detach | 宿主契约：槽位保留是设计，剪枝由宿主下次写自理（P2′:178） | 采纳 B-1 全套（含 vault-restore.mjs、I-10 演练） | 失去「unarchive 还原原位置」——文件搬走后该承诺本就落空 |

## 7. 新增防偏离锚汇总

A-15（marker 全代际 sha 基线可离线验证）· A-16（改冷根后旧行可恢复）· A-17（cold id unarchive 必不隐形）· A-18（引擎不重入包装）+ B-3 的 A-5 拆分 + Y-2 的「restore 后两轮清扫不进候选」。

## 8. 评审结论与 v0.3 修订清单

**有条件通过**。进入工程模式的前置条件：

1. 5 处 🔴 修完（R-4/R-5 同批）；
2. 设计档出 v0.3 与 eng-readiness 合一：D6→D6′（§6.2 删 detach 循环、§14 D6 改写、C-3 行补「这是宿主有意设计」）、§11 矩阵按 D6′+R-2+Y-1 重写、§6.2/§7 按 R-1（marker 全代际 sha）与 R-5（引擎调 original）修订、§4.2 schema 加冷根列（R-3）与 FTS 触发器（B-3）；
3. 10 处 🟡 进 P1/P2 任务清单（Y-1..Y-10），5 处 🔵 进收尾清单。
