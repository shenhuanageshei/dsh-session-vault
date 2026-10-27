# 会诊 #123 · dsh-session-vault 设计会诊纪要

- 会诊编号：#123 ｜ job：`consult-547389ff381a4bcf` ｜ 日期：2026-10-22
- 派发方：主会话的委派子代理（consult_start）｜ 模型池：deepseek-flash / glm-5.3 / MiniMax-M3.1-Flash / gpt-6-astra / deepseek-v4-pro
- 评审对象：设计档 v0.2 + 安全边界档 v0.1 + UI 设计档 v0.1 + 需求档 v0.1 + 两份调研备忘 + 工程预评审 eng-readiness
- 回复：5 个模型中 **4 个有效回复**、1 个失败（gpt-6-astra：`codex-cli PROCESS_ERROR`，chatgpt.com backend 请求超时 + 模型列表刷新超时，属网络故障，非设计问题）

## 0 摘要

1. **四方一致：骨架不推倒。** 整目录搬移 + marker 收敛 + fail-closed + 自建索引 + 身份复算这套判断，4 份独立评审全部认可，无需重做。
2. **四方独立收敛在同一个真问题上：官方「取消归档」会把冷会话变成谁也看不见的僵尸。** 官方 `unarchiveSession` 不做存在性检查，对任何 id 必然成功 ⇒ 冷会话一旦被取消归档，既不在热目录、也不在归档列表，还再也回不来。
3. **最强共识（4/4）：删掉迁移时的 `detachSession`。** 宿主白纸黑字写着「归档不动记账、保留 sessionIds 槽位以便取消归档还原位置」；`attachSession` 又是头插（恢复后位置丢失）且要求 cwd 精确存在。
4. **裁定结果：采纳 48 条 · 驳回 2 条（附理由）· 裁定 1 条 · 待用户拍板 1 条。** 全部意见逐条落账见 §2，合并成设计档 v0.3 的 26 组修订见 §3。

## 1 原始层（raw）

- digest 全文落盘：`<DSH_HOME>\.thincoder\jobs\consult-547389ff381a4bcf.txt`（409 行）
- 本平台把每条回复截到 8000 字符，**未截断的尾巴在 4 个子会话日志里**：`b5e71508-f25b-4ae2-b988-f86d0f75af4c`（flash）、`ffca802c-5f12-4e2f-b44d-240c32352614`（v4-pro）、`2af97c7b-caaa-47ff-bb90-6cb0c6cdb072`（glm-5.3）、`20abe987-3453-44a7-bc75-bc8a4aafc126`（MiniMax）
- 权限面如实（A30-10）：**本部署无法保证只读**（子会话实测 `danger-full-access`）；「只读」只是弱证。已核实：glm-5.3 确实把评审全文写进了仓库（`docs/2026-10-22-session-vault-design-review.md`，127 行）——这是评审子代理的唯一写入，范围与本项目一致。
- 评审口径提醒：flash 用的是 `desktop-build/targets/win-x64/dsh` 副本（其 package.json 标 **0.1.7-rc.1**，非文档声称的 0.2.1-rc.2）；MiniMax 用的是 TS 源码行号；v4-pro 用的是构建后 JS 行号 ⇒ **三套坐标不能混引**，见 §2 第 47 行。

## 2 逐条处置（每条意见都有出处与去向）

| # | 议题 | 出处 | 处置 | 理由 / 落点 |
| --- | --- | --- | --- | --- |
| 1 | 冷会话被外部取消归档 → 官方界面全隐形 | flash V-1 / v4-pro R3 / glm R-4 / MiniMax F1·F13 | 采纳（技术部分已定）+ 行为选项 **D-16′ 待用户拍板** | 四方独立收敛；不变量与锚已定：安全档加 I-11（`cold ⇒ 已归档`）、设计档加 A-13；「包装 `unarchiveSession` 透明水合」这一**行为变更**由用户拍板（见 §4）|
| 2 | 跨卷恢复留「半截热目录」→ 能被 list() 列出、能被打开写，收敛时删掉＝删掉新消息 | flash V-2 / glm Y-1 | 采纳 | copy→`<log_name>.part`→verify→rename；多代际按版本升序 rename、最新代际最后；加 A-14 |
| 3 | 恢复算法不幂等（重跑会把已搬回的文件又搬回冷目录） | v4-pro R2 / MiniMax F3 / flash V-4 | 采纳 | 收敛判据改「文件系统事实真值表」；`src缺+dst存+marker在` ⇒ 幂等续跑，禁止回滚 |
| 4 | marker 缺搬前内容指纹基线 | flash V-4 / v4-pro R1 / glm R-1 | 采纳 | preflight 对**全部代际文件**算 sha256 写进 marker（`planSha`+`files[]`）；收敛以 marker 为唯一基准 |
| 5 | 跨卷 TOCTOU：哈希算完到删源之间会话被追加新帧 | v4-pro R1 | 采纳 | copy 前后各算一次源指纹，相等才允许删源；删源前紧贴临界区再复检一次 |
| 6 | 崩溃收敛跳过 I-6 复检，竞态取消归档的会话被固定成冷态 | glm R-2 / v4-pro R4 | 采纳 | 收敛＝「从最后持久步恢复」，先重跑复检再续尾段 |
| 7 | 启动收敛只有矩阵、没有例程与执行顺序 | v4-pro R4 | 采纳 | 补 `recoverOnBoot()`：①marker 收敛 ②冷目录↔DB 对账 ③registry 对账 ④才允许 Sweeper 起跑 |
| 8 | 恢复时找不到工作区仍照常 unarchive（热、无记账、未归档） | flash V-3 / MiniMax F2 | 采纳 | 顺序改 搬回→stat→官方 unarchive→attach（尽力）；落库拆 `hot-restored` / `hot` 两段 |
| 9 | 迁移时 detach / 恢复时 attach 与宿主记账契约冲突 | eng-readiness B-1 / v4-pro R11 / glm 背书 / MiniMax F11 | 采纳（D6→D6′）| 官方不变量「归档保留 sessionIds 槽位」；`attachSession` 是头插→位置丢失；detach 不可逆→破坏 I-10 承诺 |
| 10 | 「保留 detach + 剪枝护栏」 | flash V-6 | **驳回** | 与第 9 行 4:1 冲突；宿主 `mutate()` 本来就会按 `sessionPath` 剪枝，detach 是多余写操作面。剪枝可能连带删别的会话这一点，转为「不写记账 + 启动对账观察 + manifest 告警」覆盖 |
| 11 | coldRoot 变更后已迁会话在应用内不可恢复 | glm R-3 | 采纳 | sessions 行记**迁移时的绝对冷根**；restore 与启动对账遍历全部已知根 |
| 12 | 引擎调 `unarchiveSession` 重入包装 ⇒ 死锁 | glm R-5 | 采纳 | install 时捕获 original，引擎一律调原件 |
| 13 | 包装里做搬移/索引 → 官方归档按钮卡 1~3 分钟 | flash W-1 / glm Y-9 | 采纳 | 包装只记 `archivedAt`；搬移/索引进后台队列；AM 在场不装包装、降级轮询 + 横幅 |
| 14 | 包装被后装插件盖掉时静默失效 | v4-pro R12 / MiniMax F12 | 采纳 | 安装时引用自检（`registry.archiveSession !== ours` ⇒ warn）；`archivedAt` 缺失记为 manifest 显式 skip 理由 |
| 15 | 重复点归档会把 `archivedAt` 刷成今天 → 本该迁的再等 14 天 | flash W-2 / glm BL-5 | 采纳 | 只在「集合进入沿」记时 |
| 16 | `archivedAt` 的事实来源应是归档集合差分轮询 | flash | 采纳 | 轮询兜底 + 包装补精度（包装被盖掉也不丢计时源） |
| 17 | header 读写成「整文件扫帧」→ body 有一处坏帧就永远恢复不了 | flash X-1 / glm Y-5 / MiniMax F16 / v4-pro R7 | 采纳 | 抄官方 `readFirstZstdLine`：8KB 增量读 + `maxFrames=1` + 1MB 硬上限；**恢复不以 header 读为前置**（用落库的 rel_dir/log_name 事实，header 失败只标 `header-unverified`） |
| 18 | 双代际目录两代都索引 → `(session_id,seq)` 唯一冲突 → 整会话索引失败 | flash X-2 / MiniMax F17 / 我方 E-4 | 采纳 | DB 存**文件清单**；只索引最高代际（与宿主 `resolveGenerationInDirectory` 一致）——我方实测 22/2097 目录并存、118 个归档会话中 1 个命中 |
| 19 | `persistence.stat().sizeBytes` 只是最高代际那一个文件 | flash V-5 | 采纳 | `bytes` 用目录总量；单文件大小另存一列给索引 watermark |
| 20 | 打包行（无 `type`）静默抽出 0 条 | flash X-3 / v4-pro R8 / glm Y-7 | 采纳 | 解码后先判形状；统计 `unknownLines`；`docs==0 && lines>0` ⇒ `error=extract-empty` |
| 21 | `surfaceOp`/`surface` 未处理 → 搜索命中被替换/影子的旧文本 | v4-pro R8 | 采纳 | docs 表补 `surface` 列，检索默认 `surface=current` |
| 22 | seq 跳号（官方视为 corrupt）| v4-pro R8 | 采纳 | 同样校验，但按会话隔离记 error，不整会话拒收 |
| 23 | 「预留 2GB 上限」与 `readFileSync` 冲突 | flash X-4 / glm Y-5 / MiniMax F16 | 采纳 | 流式分段读，解压一帧丢一帧（frames 表已存 start/end，无需常驻整文件） |
| 24 | 坏 magic 被当成 torn tail（与「不写半截索引」自相矛盾）| MiniMax F15 | 采纳 | 照抄宿主三分支：坏 magic / 保留位 / 块类型3 一律抛错，**只有 EOF 截断**才 tornStart |
| 25 | torn tail 整会话判 corrupt | glm Y-6 | 采纳 | 前缀照常索引 + `torn_tail` 标记 |
| 26 | 冷态措辞「只允许解第 0 帧」会被误读成不许建索引 | v4-pro R7 | 采纳 | 改写为「冷态禁止 `persistence.open` / sessionQuery 读模型；**允许**自研只读帧遍历 + zstdDecompressSync（无写路径）」 |
| 27 | 「损坏日志」三种互相矛盾的处置 | v4-pro R6 | 采纳（我裁定）| 与 §8.4 一致：迁移**不因索引失败阻塞**，帧损坏记 error + 可重建/跳过；同步删掉 §13「默认拒绝迁移」的措辞 |
| 28 | status 枚举三处不一致（`hot-active` / `hot_active` / `hot`）+ 永久失败无出路 | v4-pro R5 / glm Y-2 | 采纳 | 统一枚举；新增 `hot-restored`；清扫候选必须加 `id ∈ archivedSessionIds` |
| 29 | 恢复后 DB 行保留还是删除 | v4-pro R5 | **裁定：保留** | 与 §8.4「恢复后保留便于再次归档」一致；删行会连带丢掉再次归档的索引 |
| 30 | `source_sha` 语义：v0/v3 被打开会重编码成 v4 → 合法迁移被判 identity-mismatch | flash X-5 / v4-pro R10 | 采纳 | 钉死为「第 0 帧**压缩字节** sha256 前 16 位」+ 每次成功搬移后覆盖 |
| 31 | external-content FTS 缺维护触发器 → MATCH 恒 0 | eng-readiness B-3 / v4-pro R10 / MiniMax F20 | 采纳 | DDL 补 `docs_ai` / `docs_ad` / `docs_au`；A-5 拆成两条负向断言 |
| 32 | FTS 查询串未转义（`"`、`*`、`NEAR(` 会变语法错误或全匹配）| v4-pro R10 | 采纳 | 整体引号包裹 + 内部转义，与 A-5 同测 |
| 33 | v0/v3 恢复路径未实测 | v4-pro R9 | 采纳 | 118 个存量里 v0×11、v3×3 真实存在；补「迁移→重启→恢复→打开」锚；恢复后索引所有权交还官方 |
| 34 | 迁移不建目标父目录 → 每个 projectKey 首次迁移必 ENOENT | flash V-7 / MiniMax F4 | 采纳 | rename 前 `mkdir -p coldRoot/<projectKey>`；rename 前再查一次 dst 不存在 |
| 35 | 搬后不复查文件本身（归档会话仍可被写）| MiniMax F5 / v4-pro R1 第 3 点 | 采纳 | 搬后 stat 比对 size/mtime，不一致即搬回并标 `race-written`；另查新出现的 `*.tmp` |
| 36 | 「同卷」没判定方法；同卷也被 1.2 倍余量无谓拦下 | MiniMax F6 | 采纳 | 比卷根 + `stat.dev`；余量只约束跨卷分支 |
| 37 | marker 没有 fsync | glm Y-3 | 采纳 | writeMarker 后 fsync 文件 + 父目录 |
| 38 | 尾段失败语义未定义 + manifest 可能双写 | glm Y-4 | 采纳 | 保持 migrating+marker 收敛续跑；append 前查重（并入 S-3） |
| 39 | 8246 帧同步解压卡事件循环 | glm Y-8 | 采纳 | 每 N 帧 / 16MB `setImmediate` |
| 40 | 列表接口每请求都 `persistence.list()` | glm Y-10 | 采纳 | 缓存 + 事件失效 |
| 41 | 未来 v5 格式 | glm BL-1 | 采纳 | 白名单 {0,3,4}，v5 拒迁 |
| 42 | 僵尸搜索命中（已取消归档的 hot 行）| glm BL-2 | 采纳 | 命中时现场查 registry |
| 43 | 工作区已删除时的 restore 文案 | glm BL-3 | 采纳 | 改「已回磁盘原位 + 重试 attach」 |
| 44 | 迁移后 118 条 header missing warn 噪音 | glm BL-4 | 采纳 | 写进诊断说明（不当故障） |
| 45 | `persistence.stat(id)===undefined` 混同两种原因 | v4-pro 交叉项 1 | 采纳 | 文案区分「文件不在」vs「header 损坏被静默跳过」 |
| 46 | 目标卷中途拔出时删不了残留 | v4-pro 交叉项 2 | 采纳 | 冷卷可访问时才删残留，否则保留并降级只读 |
| 47 | 证据坐标不可复现（版本标签 / 两套行号 / 引用错位）| flash 坐标段 / v4-pro R11 注 / MiniMax 证据基线 / glm 交付说明 | 采纳 | 三处重钉：①`npx @electron/asar extract-file` 钉版本 ②TS 源码行号 vs 构建后 JS 行号两套坐标不可混引 ③P2:742-756 实为 `recoverPendingMutation` |
| 48 | 「eng-readiness 只有 18 行且断在半句，却声称已评审」| MiniMax D1 | **驳回** | 该档现为 91 行完整档；MiniMax 读到的是并发写入过程中的中间态快照（与 glm 报告的 PTY 串扰同族）——记录该现象，但不据此改档 |
| 49 | 跨档计数不统一 | MiniMax D2 | 采纳 | 计数一律标 as-of（我方 session-dir-shapes 档已这么做） |
| 50 | 五步实施序（契约对齐→写栅栏→取消归档即恢复→索引器→文档收口）| MiniMax 步骤 | 采纳 | 作为 v0.3 的阶段序，与 glm / v4-pro 的优先级合并为 §3 |
| 51 | 「评审工具的 FAIL 不是设计结论」| MiniMax callout | 采纳（事实记录）| advisor 因会话工作区根是 DSH 安装目录、读不到仓库文档而判 FAIL；已通过把 cwd 切到仓库根修复，评审必须在仓库根重跑 |
| 52 | gpt-6-astra 未产出意见 | 摘要 [1] | 无设计意见 | `codex-cli PROCESS_ERROR`（chatgpt.com backend 超时 + 模型列表刷新超时）＝网络故障，不是设计问题；4/5 有效回复已足够，且四方结论互相印证 |


## 3 合并后的设计档 v0.3 修订清单（26 组）

> 本清单 = 本会诊 52 条处置 + eng-readiness（B-1~B-3 / S-1~S-5）+ design-review（R-1~R-5 / Y-1~Y-10 / BL-1~BL-5）+ 我方实测（E-1~E-4 + 身份复算 35/35）的**合一版**。设计档必须出 v0.3 才能进工程模式。

### P0 · 写码前必须改伪代码（12 组）

| 编号 | 改哪 | 改什么 |
| --- | --- | --- |
| R-1 | 设计档 §6.2 / §7 / §14 D6 / §12 A-1 | **删掉**迁移时的 `detachSession`、恢复时的 `attachSession`（D6→D6′）：不碰工作区记账，交给宿主重启后自行过滤 |
| R-2 | 设计档 §3.1 / §7 | 包装 `unarchiveSession` 做**透明水合**（冷会话先搬回再放行官方取消归档，失败即拒绝）；引擎一律调 install 时捕获的 original（防重入死锁） |
| R-3 | 设计档 §4 / §6.1 / §6.2 | marker 携带**全部代际文件**的 sha256 基线（`planSha` + `files[]`）：preflight 算、move 后复算；收敛以 marker 为唯一基准，永不自动删源 |
| R-4 | 设计档 §11 | 收敛判据改「(src 在, dst 在) 真值表」；marker 只记意图；恢复按 phase **幂等续跑**，禁止回滚 |
| R-5 | 设计档 §4.2 / §7 | 落库拆 `hot-restored` / `hot` 两段；恢复顺序 搬回 → stat → 官方 unarchive → attach（尽力） |
| R-6 | 设计档 §7 | 跨卷恢复 copy → `<log_name>.part` → verify → rename（多代际按版本升序 rename，最新代际最后） |
| R-7 | 设计档 §6.2 | 写栅栏：搬后 stat 比对 size/mtime（不一致即搬回并标 `race-written`）；跨卷 copy 前后各算一次源指纹；删源前再复检 |
| R-8 | 设计档 §4.2 | sessions 行记**迁移时的绝对冷根**（冷根变更后旧会话仍可恢复） |
| R-9 | 设计档 §8.2 / §13 / §6.1 | 损坏日志策略统一：迁移**不因索引失败阻塞**，帧损坏记 error + 可重建/跳过 |
| R-10 | 设计档 §4.2 | 补 external-content FTS 三触发器 `docs_ai` / `docs_ad` / `docs_au` |
| R-11 | 设计档 §4.2 / §8.1 | DB 存**文件清单**；只索引最高代际（双代际目录不撞 `(session_id,seq)` 唯一索引） |
| R-12 | 设计档 §8.1 | header 改增量读（8KB）+ `maxFrames=1` + 1MB 硬上限；**恢复不以 header 读为前置**（用落库事实，header 失败只标 `header-unverified`） |

### P1 · 同批补设计（10 组）

| 编号 | 改哪 | 改什么 |
| --- | --- | --- |
| R-13 | 安全档 §1 / 设计档 §12 | 加不变量 **I-11**（`cold ⇒ id ∈ archivedSessionIds`）+ 负向锚 **A-13 / A-14** |
| R-14 | 设计档 §11 | 补 `recoverOnBoot()` 例程与执行顺序：①marker 收敛 ②冷目录↔DB 对账 ③registry 对账 ④才允许 Sweeper 起跑 |
| R-15 | 设计档 §4.2 / §5 / §7 / §9 | status 枚举统一；清扫候选必须加 `id ∈ archivedSessionIds` |
| R-16 | 设计档 §8.1 / §13 | 冷态措辞改写：禁 `persistence.open` / sessionQuery 读模型，**允许**自研只读帧遍历 |
| R-17 | 设计档 §8.1 / §8.2 | 打包行形状判定 + `unknownLines` 统计 + docs 表补 `surface` 列（检索默认 current）+ seq 跳号按会话隔离记 error |
| R-18 | 设计档 §4.2 / §6.2 | `bytes` 用目录总量；`source_sha` 钉死为第 0 帧压缩字节 sha256 前 16 位 + 每次搬移后覆盖 |
| R-19 | 设计档 §6.1 / §6.2 | `mkdir -p` 目标父目录 + rename 前复检 dst + 同卷判定（卷根 + `stat.dev`）+ 余量只约束跨卷 |
| R-20 | 设计档 §6.2 / §7 / §11 | marker fsync（文件 + 父目录）；manifest append 前查重；尾段失败保持 marker 收敛续跑 |
| R-21 | 设计档 §3 / §9 / §16 | 包装只记 `archivedAt`（不搬移不建索引）；AM 在场不装包装；安装时引用自检；差分轮询兜底；重复归档不刷新时间 |
| R-22 | 设计档 §10 / §8.1 | 列表接口缓存 + 事件失效；帧解压每 N 帧 / 16MB `setImmediate` 让出事件循环 |

### P2 · 顺手写死（4 组）

| 编号 | 改哪 | 改什么 |
| --- | --- | --- |
| R-23 | 设计档 §12 / §13 / §14 + UI 档 | v0/v3 恢复实测锚；v5 格式白名单 {0,3,4}；僵尸命中查 registry；restore/错误文案修正；header missing warn 噪音写进诊断；FTS 查询串转义 |
| R-24 | 全部档 | 证据坐标三处重钉：①`npx @electron/asar extract-file` 钉版本 ②TS 行号 vs 构建后 JS 行号两套坐标 ③P2:742-756 实为 `recoverPendingMutation` |
| R-25 | 全部档 | 跨档计数统一标 as-of（含 2097 目录 / 118 归档 / 22 多代际目录 / 1 个命中的口径） |
| R-26 | 需求档 AC-6 / 设计档 §9 | 统一「阈值为 0 时不迁移」口径（现两处矛盾） |

## 4 待用户拍板（1 项决策 + 1 项建议）

| 编号 | 决策 | 前因与后果 | 建议 | 代价 |
| --- | --- | --- | --- | --- |
| **D-16′** | 是否把 `unarchiveSession` 包装成「取消归档 = 取消归档**并搬回**」（透明水合） | **前因**：官方 `unarchiveSession` 不做存在性检查，对任何 id 必然成功。冷会话被取消归档后既不在热目录、也不在归档列表，还无法再用官方 API 归档回来 —— 4 份评审一致认定这是最严重的用户可见故障（等同“数据丢了但没人报错”）。**不包装的后果**：这种状态靠 30 分钟一轮的对账才能发现，插件装不上时完全无解。**包装的后果**：在官方 UI 点一次「取消归档」会触发一次真实恢复（几百毫秒到数秒），恢复失败时明确报错而不是静默消失 | **建议采纳**（安全默认；且不包装就没有「自动迁移」的计时源） | 代价：官方归档/取消归档的耗时变得不均匀；AM（archive-manager）在场时不装包装，降级为轮询 + 顶部横幅 |
| 附 | 跨卷迁移是否收紧为「默认且强制同卷，跨卷需显式 opt-in + 二次确认」 | **前因**：跨卷是本设计唯一有真丢数据窗口的路径（copy 完成 → 删源之间的 TOCTOU，v4-pro R1）；本机冷目录默认与 `~/.dsh/sessions` 同卷，实际用不到跨卷。**不收紧的后果**：用户误开 `allowCrossVolume` 就落进唯一会丢帧的分支 | **建议采纳**（与已拍板的 D13「默认同卷、跨卷需显式开关」同向，只多一次确认） | 代价：确实要跨盘用的用户多一步操作 |

## 5 结论与下一步

### 5.1 裁定汇总

| 项 | 数 | 说明 |
| --- | --- | --- |
| 采纳 | 48 | 全部落进 §3 的 26 组修订；另有 1 条为**部分采纳**（§2 第 1 行的行为选项已拆出为 D-16′ 待拍板，故未计入 48） |
| **驳回** | 2 | ① flash V-6「保留 detach + 剪枝护栏」（与 4:1 共识冲突，见 §2 第 10 行）② MiniMax D1「eng-readiness 只有 18 行」（读到了并发写入中间态，见 §2 第 48 行） |
| 裁定 | 1 | v4-pro R5「恢复后 DB 行保留还是删除」→ **保留**（§2 第 29 行） |
| 待用户拍板 | 1 | D-16′（+ 跨卷二次确认作为建议项） |
| 无设计意见 | 1 | gpt-6-astra（网络故障） |

### 5.2 结论

1. **骨架不用推倒**（4/4 一致）：整目录搬移 + marker 收敛 + fail-closed + 自建索引 + 身份复算保留。
2. **四方独立收敛的同一个真问题**：官方「取消归档」会吃掉冷会话 → 必须包 `unarchiveSession`（D-16′）并加反向不变量 I-11。
3. **最强共识**：删掉 detach（D6→D6′），恢复从 5 步变 3~4 步，顺带消掉 attach 的永久失败分支。
4. **唯一真丢数据路径已封**：跨卷恢复改 `.part` + verify + rename（两段 rename 都原子），跨卷删源前两次指纹核对。
5. 设计档 v0.2 **不可直接进工程模式**：必须出 v0.3，合并本纪要 §3 的 26 组修订 + eng-readiness + design-review + 我方实测 E-1~E-4。

### 5.3 下一步（交接给主会话）

1. 用户拍板 **D-16′**（+ 跨卷二次确认建议项）。
2. 出**设计档 v0.3**：把 §3 的 26 组落到设计档正文（改伪代码 + schema + 锚 + 决策表），并同步安全边界档（I-11）、需求档（AC-6 口径）、UI 档（按工作区筛选 + 恢复文案）。
3. 在**仓库根**跑 `advisor(type=design)` 拿设计 token —— 注意：会话工作区根必须是 `<workspace-root>/dsh-plugins/dsh-session-vault`，否则评审读不到文档（本轮已踩过一次，判的是「评审范围为空」的 FAIL，不是设计不通过）。
4. `eng_coder` 按 eng-readiness §3 的 stages 进 P0/P1（宿主是 ESM + 内置 `node:sqlite`，测试一律 `node --test`）。

> **2026-10-22 16:50 状态**：第 2 步**已完成** —— 设计档已出 **v0.3**（§3 的 26 组修订全部落进正文；防偏离锚统一为 **A-1..A-22**，其中 A-5 拆成 A-5a/A-5b/A-5c；决策表 D1..D19，其中 **D16′ 待用户拍板**），并同步[安全边界档 v0.2](2026-10-22-session-vault-safety.md)（新增 I-11）、[需求档 v0.2](2026-10-22-session-vault-requirements.md)、[UI 设计档 v0.2](2026-10-22-session-vault-ui-design.md)。第 1 步（D-16′ 拍板）**仍未完成**：v0.3 把「透明水合」写成**待拍板的方案**（D16′），并未内置开关；未拍板前按「启动对账 + 横幅 + 一键恢复」兜底（A-13），不会静默丢会话。v0.2 原文归档在 [archive/2026-10-22-session-vault-design-v0.2.md](archive/2026-10-22-session-vault-design-v0.2.md)。

### 5.4 消化凭证（digest ack）

本纪要即 #123 的消化凭证。**下一次 `consult_start` 必须带**：

```json
{"digested":[{"id":"123","minutesPath":"<workspace-root>/dsh-plugins/dsh-session-vault/docs/consult-minutes/2026-10-22-consult-123-minutes.md"}]}
```

否则 digest 门会拒绝新的会诊（并把未消化的 digest 内联返回）。

### 5.5 诚实声明

- 本会诊只覆盖**设计层**：没有跑任何实现代码，没有移动任何会话文件，没有重启 DSH。
- 4 份评审的证据坐标分三套（见 §1），已列 R-24 重新钉版本与行号口径 —— 在坐标重钉前，**引用的行号不可当定论**。
- 本平台的「只读」是弱证（子会话实测 `danger-full-access`）；glm-5.3 把评审全文写进了仓库（`docs/2026-10-22-session-vault-design-review.md`），已复核该文件存在且内容与本纪要一致。
- 我方独立实测（见 `docs/research/session-dir-shapes-2026-10-22.md`）：118 个归档会话全部在盘、22/2097 目录并存两代日志、1 个归档会话命中、projectKey 复算 35/35 精确命中。

