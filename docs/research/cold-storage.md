# dsh-session-vault · 冷存仓储与检索机制（工程备忘）

> 只读取证 2026-10-22。宿主 DSH 0.2.1-rc.2（asar 内 package.json:4）。
> 行号以**运行中的 asar 副本**为准（`resources/app.asar/dsh/node_modules/@deepseek-ai/...`）；
> `~/.dsh/profiles/node_modules` 是**旧构建**（jsonl 包 1461 vs 3643 行，落盘文件名还是无版本号的旧规则），照它写必错。

## 0. 路径坐标

| 缩 | 包（相对 `@deepseek-ai/`） |
| --- | --- |
| **P1** | `dsh-session-persistence-jsonl/lib/index.js` |
| **P2** | `dsh-workspace/lib/index.js` |
| **P3** | `dsh-session-query/lib/index.js` |
| **P4** | `dsh-session-query-sqlite/lib/index.js` |
| **P5** | `dsh-session-projection-cache/lib/index.js` |
| **P6** | `dsh-session/lib/types/known-event-types.js` |
| **REF** | `D:\tmp\cold-storage-research\dsh-search-index`（参考实现，§8） |

## 1. 结论速览

1. **一个会话目录只有一个文件**：`session.v4.jsonl.zstd`（或 v3/v0 代际名）。本机 2083 个会话目录只出现 3 种文件名，**无附件/锁/spill/临时文件**。搬移单位 = 整个目录。
2. **代际名由 SESSION_FORMAT_VERSION 决定**（P1:766-767、942-944）：`session.v<N>.jsonl.zstd`。**重命名 = 会话静默消失**（P1:3411-3441 解析不出代际即跳过）。
3. **日志 = 多帧 zstd 拼接**：首帧独占 header 一行，之后每 append 批次一帧，帧带 xxhash 校验（P1:1293-1297、3269-3281）。帧边界**不解压**即可扫出（P1:1305-1368）。
4. **只读头部 = 只解第 0 帧**（P1:3378-3409，边读边扫），列会话表不必解压全文；全量读仍 O(文件)。
5. **宿主 Node 24.21.0，`node:zlib` 自带 `zstdDecompress(Sync)`**，无需第三方包（实测）。
6. **会话身份 = 路径**：`assertStoredIdentity` 要求「文件路径 == generationLogPath(root, header.cwd, header.id)」（P1:3468-3477）⇒ 搬回必须回**原 projectKey**。
7. **冷目录绝不能放在 sessions 根之下**：错放令 `persistence.list()` 抛错（P1:3125 重抛），而 `WorkspaceRegistry.init` 就 await 它（P2:387-392）。
8. **整目录消失是安全的**：侧栏静默过滤（P2:102-104、367）、workspace.json 留僵尸 id（下次写才剪，P2:178）、缓存不留幽灵（P5:168-197），**不影响启动**。
9. **内置 sqlite 索引不能复用**：对账把「不在 persistence.list() 的行」直接删（P4:656、681、760-769），冷会话一行都不剩；且本机尚未物化索引库。
10. **冷索引只存文本**：语义正文只占原日志 **2%~4%**；118 个归档会话 932 MB ⇒ 文本 20~40 MB、FTS 库 25~70 MB。

## 2. 目录布局（问题 1）

真实样本（本机实测）：

```
<DSH_HOME>\sessions\--workspace-intel--\session-8e57f484-...\
    session.v4.jsonl.zstd        15,313,310 bytes      ← 目录里唯一条目
```

根下 25 个 project 目录 / 2083 个会话目录 / 2201.3 MB，条目只有三类：

| 文件名 | 数量 | 含义 |
| --- | --- | --- |
| `session.v4.jsonl.zstd` | 1583 | 当前代际 v4 |
| `session.v3.jsonl.zstd` | 304 | 旧代际，读时迁移 |
| `session.jsonl.zstd` | 221 | **v0**（v0 保留无版本号历史名，P1:758-761） |

- 22 个目录**同时存在两代**文件（迁移后旧代际未删）；运行期只取版本号最大者（P1:3435）。
- 目录名 = `encodeSegment(sessionId)`（P1:858），无前缀魔法；样本 id 本身即以 `session-` 开头。
- 附件在全局 `~/.dsh/attachments/v1/`（实测），**不随会话搬**。
- 写盘临时文件 `<log>.<hex>.tmp`（P1:3194 附近）；搬前若见 `*.tmp` 视为「写入在飞」，跳过。

| 对象 | 处理 |
| --- | --- |
| `<projectKey>/<sessionId>/` 整目录（含全部代际） | **整体搬**（目录是原子单位，P1:919-921） |
| `*.tmp` | 不搬，等它消失 |
| `storages/session_projcache/sessions/<id>.json` | 不动（派生数据，§6.2） |
| `attachments/` | 不动 |

## 3. v4 格式（问题 2）

- **容器 = 一串独立可解帧**。首帧恰好「header JSON + \n」；此后每 durable append 批次一帧（P1:3269-3277 建文件；P1:3279-3281 追加）。
- **压缩参数** `{ params: { [ZSTD_c_checksumFlag]: 1 } }`（P1:1296）：每帧 4 字节校验，解压即校验；碎尾用 `ZSTD_e_flush` 抢救已落地明文（P1:1297、1395-1403）。
- **帧边界**靠结构走查而非搜 magic：4 字节 magic(4247762216) → descriptor（csFlag/singleSegment/checksum/dict）→ 跳帧头余量 → 循环 3 字节块头（last/type/size）跳块体 → 有 checksum 再跳 4（P1:1305-1368，可照抄）。EOF 落在帧中返回 `tornStart`，不抛错。**这是唯一可靠的边界算法**（压缩块里可能出现同字节）。
- **实测**：15.3 MB 会话 = **8246 帧**，均值 1.85 KB/帧（171/147/418/129/683/107553…）。
- **读路径三条硬约束**：① header 帧必须独占一帧且以 \n 结尾（P1:3398）；② torn tail 不算数据，首次 append 前 truncate（P1:1395-1403 的 `truncateTo`）；③ 读 v0/v3 会**迁移写新文件**（P1:2123-2147）⇒ 搬移期间若有人打开该会话会多出/改写文件，必须确认非 live（archive 的 activity 门即此，P2:526-533）。

## 4. zstd 可用性（问题 3）

- 实测：`process.versions.node = 24.21.0`、`electron = 44.7.0`，`typeof zlib.zstdDecompress === 'function'`。
- 官方 `NodePrivateZstdFrameDecoder` 用 `stream._handle.writeSync` 复用原生上下文（P1:1360 起）**只是优化，不要抄**（依赖 Node 私有字段，换版即退化）。用 `zstdDecompressSync` 逐帧解即可。也不要引入第三方原生包。

```js
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 4247762216;                    // P1:1293

export function scanFrames(buf) {                 // 照抄 P1:1305-1368
  const frames = []; let o = 0;
  while (o < buf.length) {
    const start = o;
    if (buf.length - o < 4) return { frames, tornStart: start };
    if (buf.readUInt32LE(o) !== ZSTD_MAGIC) throw new Error('bad frame magic at ' + o);
    o += 4;
    if (o === buf.length) return { frames, tornStart: start };
    const d = buf.readUInt8(o); o += 1;
    if ((d & 24) !== 0) throw new Error('reserved frame-header bit');
    const csFlag = d >>> 6, single = (d & 32) !== 0, checksum = (d & 4) !== 0, dictFlag = d & 3;
    const csBytes = csFlag === 0 ? (single ? 1 : 0) : 1 << csFlag;
    const rest = (single ? 0 : 1) + (dictFlag === 3 ? 4 : dictFlag) + csBytes;
    if (buf.length - o < rest) return { frames, tornStart: start };
    o += rest;
    for (;;) {
      if (buf.length - o < 3) return { frames, tornStart: start };
      const bh = buf.readUIntLE(o, 3); o += 3;
      const last = (bh & 1) !== 0, type = (bh >>> 1) & 3, size = bh >>> 3;
      if (type === 3) throw new Error('reserved block type');
      const payload = type === 1 ? 1 : size;
      if (buf.length - o < payload) return { frames, tornStart: start };
      o += payload;
      if (last) break;
    }
    if (checksum) { if (buf.length - o < 4) return { frames, tornStart: start }; o += 4; }
    frames.push({ start, end: o });
  }
  return { frames, tornStart: undefined };
}

export function readHeader(file) {                // 只解第 0 帧（P1:3378-3409 同构）
  const buf = readFileSync(file);
  const { frames } = scanFrames(buf);
  if (frames.length === 0) throw new Error('empty log');
  const text = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8');
  if (!text.endsWith('\n')) throw new Error('corrupt header frame');
  return JSON.parse(text.slice(0, -1));           // {type:'session', id, createdAt, cwd, version, ...}
}

export function* frameText(buf) {                 // 全量读取 / 建索引
  for (const f of scanFrames(buf).frames) {
    yield zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8');
  }
}
```

## 5. 事件形状与提取（问题 4）

行 = `{ type, seq, time, data, surfaceOp?, ignorable? }`，`seq` 自 0 连续（跳号即 corrupt，P1:3152-3162）。实测：

```json
{"type":"turn/start","seq":11,"time":1792320321418,"data":{"turn":1}}
{"type":"user/message","seq":16,"time":1792320321567,"data":{"content":[{"type":"text","text":"..."}],"source":{"kind":"user-approval"},"role":"user"},"surfaceOp":"append"}
{"type":"assistant/message","seq":29,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":"..."},{"type":"text","text":"..."}]}}}
{"type":"session/title","seq":24,"data":{"title":"你马上看一下当前服务器（150","messageSeqs":[17]}}
```

- v4 还支持**打包行**（`text-chunks`/`reasoning-chunks`/`tool-call-chunks`，P1:945-950）：无 `type` 字段、解出一个事件数组。本机 30 会话抽样**未见**，但必须容忍（无 type 行交给 `decodeStorageRecord` 或跳过）。
- 事件类型白名单 65 项在 P6；未知类型不带 `ignorable:true` 会被读路径拒读。

**官方提取语义（P3:545-588，照抄）**：`user/message`→`data.content` 的 text 块；`assistant/message`→`data.message.content` 的 text 块（**reasoning 一律丢**）；`tool/call`/`tool/result`→name+arguments / 结果+error；`todo/write`→status+content；`turn/end` 只有 error/aborted/max-tokens/interrupted 有文本；`turn/start` `step/*` `assistant/attempt` `request/header` 为空。

**关键：`user/message` 里的多数字不是人写的。** 30 会话抽样 `data.source.kind` 分布：

| kind | 数 | 算用户文本？ |
| --- | --- | --- |
| `user` | 47 | ✅ 唯一真人输入 |
| `runtime-context` / `time-context` / `skill-catalog` / `agent-instructions` | 31 / 18 / 27 / 16 | ❌ 注入 |
| `tool-jobs` / `user-approval` | 10 / 5 | ❌ 工具回灌·审批伪装 |
| `agent-message` / `subagent-settled` / `session-reference` | 1 / 1 / 2 | △ 队友消息，按需 |

`assistant/message` 块分布 `reasoning 491 / tool-call 517 / text 197`：不丢 reasoning 会把索引灌满。⇒ **正文只收 kind=user + assistant text + title**；工具参数做可选列。

```js
const text = (blocks) => (blocks ?? [])
  .filter(b => b && b.type === 'text' && typeof b.text === 'string')
  .map(b => b.text.trim()).filter(Boolean).join('\n');

export function extract(event, opts = {}) {
  const d = event.data ?? {};
  switch (event.type) {
    case 'user/message': {
      if (d.source?.kind !== 'user' && opts.includeInjected !== true) return '';
      return text(d.content);
    }
    case 'assistant/message': return text(d.message?.content);
    case 'session/title':    return typeof d.title === 'string' ? d.title.trim() : '';
    case 'tool/call':        return opts.includeTools ? [d.name, d.arguments].filter(Boolean).join('\n') : '';
    case 'tool/result':      return opts.includeTools ? text(d.message?.content) : '';
    default: return '';        // turn/start, step/*, request/header, system/message …
  }
}
```

## 6. 搬走之后会发生什么（问题 5）

**(a) 侧栏/工作区：安全。** 会话集合唯一来源是 `ctx.sessionPersistence.list()`（P2:897-899）；目录不在→不在 `headers/sessionPaths`；`Workspace.sessionIds` 是记账（P2:209-215），getter 用 `candidateMatches` 过滤（P2:102-104、367）⇒ 静默隐藏；`reportFilteredCandidates` 打一条 `'session header is missing'` warn（原引 P2:742-756 经复核实为 `recoverPendingMutation`，行号待重钉）是唯一痕迹。僵尸 id 在下一次该工作区写操作时被剪（P2:178），不写就一直躺着，无害。`archivedSessionIds` 不受影响（P2:506-508）。
⇒ **unarchive 顺序必须由插件保证**：`unarchiveSession` 不做存在性检查（P2:543-561，注释原文「an entry whose session is gone still resolves」），正确序 = 搬回 → 再 unarchive；反序会短暂出现指向空气的可见会话。

**(b) 投影缓存：不留幽灵，只留垃圾。** 已改 per-record：`storages/session_projcache/sessions/<id>.json`，本机 2085 文件 vs 2083 会话目录（P5:89-101：`layout:'per-record'`、`version:7`、`compatibleVersions:[3..6]`）；401 KB 的 `session_projcache.json` 是 v3 旧单文件，已不在读路径。读按 id 定位（P5:168-172），无「全表列会话」⇒ 无幽灵；无删除路径（唯一写在 P5:292-324）⇒ 旧记录永久滞留（2085-2083=2 即孤儿）。副产品：冷索引可借 `record.rows.title.val`（本机 118 归档 **100% 有记录**），但只能当 hint（P5:198-218）。

**(c) persistence.list() 的四种状态：**

| 状态 | 行为 | 依据 |
| --- | --- | --- |
| 目录整个不存在 | 不列出（正常） | P1:3048-3052 |
| 目录在、无合法代际名 | **静默跳过** | P1:3411-3441 |
| 文件在、父 projectKey ≠ header.cwd | **抛错**，`listArtifacts` 逐条重抛（P1:3125），`list()` 整体 reject | P1:3468-3477 |
| 同 id 出现在两个 projectKey | 抛 duplicate | P1:3128、3454 |

**头号风险**：`WorkspaceRegistry.init` 里 `await this.listStoredHeaders()`（P2:387-392）会吃到上面的 reject。⇒ ① 冷目录放 `/.dsh/session-vault/cold/`（sessions 之外）；② 搬回必须回**原 projectKey**（用 `projectKey()` 从 header.cwd 复算，P1:880-900）；③ 同卷 rename，跨卷 copy+校验+删；④ 未完成事务留标记，启动时先收尾或回滚，绝不留中间态。

## 7. 内置 FTS 对账（问题 6）

**结论：不能复用，且它会主动删掉冷会话的行。**

- 索引侧现存 `persistedRows`（P4:649）；观测侧 `observation.persisted` = 当前 `persistence.list()` 的 id 集（P4:717-719）。
- `persistentDeletes = persistedRows.filter(row => !observation.persisted.has(row.id))`（**P4:656**）→ `_deleteSession('persisted', row.id)`（**P4:681**）→ `DELETE FROM persisted_docs WHERE session_id=?` + `DELETE FROM persisted_sessions`（**P4:760-764**）。
- 即：会话目录一搬走，下次搜索触发的对账把两表行**物理删除**，且没有「保留旧行」开关。schema 里也没有冷/热维度（P4:91-116）。
- 本机现状：索引库路径由 launcher 注入（`Config.path` 必填，P4:478-479，不是常量）；在 `/.dsh` 与 profile 下全量搜 `*.db/*.sqlite*`，只有 `graph-memory.db` ⇒ **本机索引从未物化**。`@deepseek-ai/dsh-experimental-session-search` 在 `profiles/desktop/package.json` 的 bundles 里但包不存在（`dsh-session-query-sqlite` 本体却在）⇒ 别假设内置检索可用。
- 设计取向差异：官方 `_observeStable` 对 revision 变化的会话直接 `readColdSessionLog` 全量读（P4:721-728）——它是**热语料的读模型**；冷存要的是「不打开日志也能搜」，数据流相反。

## 8. 参考实现评审（问题 7）

**它怎么做的（REF）**：独立库（自己 `application_id=0x53574954`、`user_version=4`，显式拒绝官方库 `0x44534851`，`src/host/schema.ts:14-22,76-84`），默认落 `join(homedir(),'.dsh-switch-search')`（`src/host/rebuild.ts:351-354`，实测 384 MB，见 `docs/phase0-index-facts-20260917.md:7-10`）。schema = `sessions(session_id PK, version, title, cwd, updated_at, indexed_at, archived)` + `docs(doc_id, session_id, seq, type, surface, time, text, index_text)` + `UNIQUE(session_id,seq)` + **external-content** FTS5 `docs_fts(index_text, content='docs', content_rowid='doc_id', tokenize='unicode61')`（`schema.ts:128-152`）。增量 = 比对 `sessions.version` watermark，失败按会话隔离（`src/host/sync.ts:1-20,118-140`）。中文 = 写前用 `Intl.Segmenter('zh',{granularity:'word'})` 插词边界空格，查询侧同一函数（`src/host/extract.ts:40-77`）。提取与官方逐条对齐、surface 用简化 `classifySurface`（`extract.ts:180-260`）。导出 = JSONL 快照 + 影子库原子换（`src/host/snapshot.ts`）。

**可以抄**：① 库隔离三件套（独立 app id + user_version + 拒绝开别人的库——否则会被内置索引的版本重置逻辑清空）；② `UNIQUE(session_id,seq)` + external-content FTS5（改一行=一次 delete+insert，库更小）；③ watermark 增量（冷存日志不变，天然幂等）；④ `Intl.Segmenter` 预分词，索引/查询用同一函数；⑤ JSONL 快照做 schema 升级与备份；⑥ 每会话失败隔离 + 状态快照。

**不要抄**：① **把归档当软删除**——`setArchived` 只留 header、清空 docs，`docs/phase0-*.md:12-22` 实测 391 会话里 85 个已归档**正文 0 行**（这正是 vault 要解决的问题）；② 只信 `sessionQuery.listSessions()/readSession()`（`sync.ts:14-27`）——冷会话根本不在那个语料里；③ 全量 rebuild + 单个 384 MB 大库；④ 不做帧级局部读（它的 content-fetch 仍走官方全量读）；⑤ 库放 `homedir()` 根而非 `/.dsh` 下。

## 9. 冷索引建议（问题 8）

**本机样本（118 个归档会话实测）**：归档 118 / 仍在磁盘 **118**；总计 **932.1 MB**（均值 8.0、P50 6.5、P90 16.1、最大 34.5 MB）；代际 v4 104 / v0 11 / v3 3；有 projcache title 的 118。

**文本占比抽样**：

| 日志 | 帧/行 | kind=user 文本 | 助手正文 | 工具参数 |
| --- | --- | --- | --- | --- |
| 6.5 MB | 3802 / 7091 | 0 KB | 157 KB | 1226 KB |
| 34.5 MB | 5645 / 12112 | 5 KB（34 条） | 804 KB | 1921 KB |

⇒ 正文 ≈ **2%~4%** 原日志；**工具参数比正文大 1.5~8 倍**，默认不入正文列。

**方案 A（推荐）：只存文本 + 定位三件套**

```sql
PRAGMA application_id = 0x53565731;   -- "SVW1"，与官方/REF 都不同
PRAGMA user_version = 1;

CREATE TABLE sessions (
  session_id     TEXT PRIMARY KEY,
  project_key    TEXT NOT NULL,   -- P1:880 的 --xxx-- 目录名
  rel_dir        TEXT NOT NULL,   -- <projectKey>/<sessionId>，搬回目标相对路径
  log_name       TEXT NOT NULL,   -- 必须原样搬回（P1:777-781）
  format_version INTEGER NOT NULL,
  file_size      INTEGER NOT NULL,
  file_mtime_ms  INTEGER NOT NULL,
  header_cwd     TEXT,            -- 重算 project_key 的唯一依据
  created_at     INTEGER NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  user_msgs      INTEGER NOT NULL DEFAULT 0,
  assistant_msgs INTEGER NOT NULL DEFAULT 0,
  first_user_text    TEXT NOT NULL DEFAULT '',  -- 列表页秒出摘要
  last_assistant_text TEXT NOT NULL DEFAULT '',
  indexed_at     INTEGER NOT NULL,
  cold_since     INTEGER NOT NULL,   -- 搬进冷区时间（≠归档时间）
  source_sha     TEXT NOT NULL       -- 头部帧 sha256 前 16 位，防同名异会话
);

CREATE TABLE docs (
  doc_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, seq INTEGER NOT NULL,
  type TEXT NOT NULL, role TEXT NOT NULL,   -- user|assistant|title
  time INTEGER NOT NULL, text TEXT NOT NULL
);
CREATE UNIQUE INDEX docs_session_seq ON docs(session_id, seq);
CREATE INDEX docs_session ON docs(session_id);
CREATE VIRTUAL TABLE docs_fts USING fts5(
  text, content='docs', content_rowid='doc_id', tokenize='unicode61'
);

CREATE TABLE frames (              -- 可选：秒开原文某段，不解压全文件
  session_id TEXT NOT NULL, idx INTEGER NOT NULL,
  start INTEGER NOT NULL, end INTEGER NOT NULL,
  PRIMARY KEY (session_id, idx)
) WITHOUT ROWID;
```

- **粒度**：会话行 1 条 + 每个「有文本的事件」1 行 doc；只存文本，不存压缩字节。
- **external-content FTS 必须自带维护**：~~content='docs'~~ 不会自动同步，需 ~~docs_ai/docs_ad~~ 触发器（或显式 insert/delete），否则 MATCH 永远 0 行。已用 ~~node:sqlite~~ 实测：建表 + 触发器 + ~~MATCH '冷存测试'~~ 命中正常（Node 24 会打一条 SQLite experimental 警告）。
- **中文分词**：入库前对 text 过 ~~Intl.Segmenter('zh',{granularity:'word'})~~ 并在词间插空格（REF 已在做）；查询串用同一函数切分后逐词 MATCH。不做这步，FTS5 只能整段匹配。
- **体积**（按 932 MB）：正文 20~40 MB；FTS5 ≈1.2~1.8× 正文 ⇒ **25~70 MB**；帧表 118×~4000×24 B ≈ **11 MB**（只对 >2 MB 会话建则 ~8 MB）。总量 **< 100 MB**。
- **建库耗时**：逐帧解压实测 34.5 MB 会话数秒；118 个全建预计 **1~3 分钟**，可分批并靠 `indexed_at/file_size/mtime` 断点续做。
- **方案 B（不推荐首版）**：额外存 `tool/call` 的 name+arguments 前 4 KB、`tool/result` 首尾 1 KB。能搜「哪个会话跑过某条命令」，但库涨到 120~260 MB、噪声大；A 的 schema 已留 `type/role` 列，B 只是多写行，无需改表。

**检索侧三条约束**：① 中文查询过同一 Segmenter，否则只能整段匹配（REF 教训）；② 命中冷会话的打开序 = 校验文件 → 同卷 rename 搬回 → `unarchiveSession` → UI 打开，**不能反**（§6a）；③ 冷检索自己算可见性：`archivedSessionIds` 是唯一「已归档」事实（P2:506-508），vault 清单要与它对账（本机 118 vs 118 一致），不一致以 registry 为准并记差异。

## 10. 待补 / 未取证

1. **未验证**：错放目录是否真令 DSH **启动失败**（而非该服务降级）。只证到「`Service.init` 内 await + `sessionPersistence` 是 `static inject` 硬依赖 + 异常向上抛」（P2:354-355、387-392），未做破坏性实验（任务禁止动数据）⇒ 设计按 **fail-closed** 处理。
2. **未验证**：`dsh-experimental-session-search` 缺席时 `sessionQuery` 服务由谁提供（`dsh-tool-session-query` 只依赖抽象服务）。若要「热用官方索引 + 冷用自建索引」需先摸清。
3. **未测**：v0/v3 会话搬回后是否触发迁移写新文件（P1:2123-2147 未实跑）⇒ 搬回后只做 header 只读校验，不主动 open。
4. **未测**：跨卷搬移崩溃窗口 ⇒ 建议强制同卷（vault 与 sessions 同盘），否则 copy 期间崩溃留半个目录。
