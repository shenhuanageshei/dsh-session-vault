/**
 * VaultStore（设计档 §4.2 / §18.5）：SQLite 元数据 + 冷索引 + 回收站。
 *
 * 要点：
 *  - 独立 application_id（0x53565731 "SVW1"，与官方 0x44534851 / REF 0x53574954 都不同），
 *    防被官方库重置；user_version 管升级（不兼容 → 明确报错，见 engine 的只读降级）。
 *  - **schema 1 → 2**（P3b / FR-P3-4 / A-P3-8）：`sessions` 增 hidden 列传、新表 trash。
 *  - **schema 2 → 3**（P4 / FR-P4-2 / A-P4-13）：`sessions` 追加 origin / delegation_depth / parent_session
 *    三列（header 事实；class 是派生值，**不加 vault_class 列** —— 设计档 §19.7）。
 *    升级在**一个事务**里完成（ALTER + CREATE + PRAGMA user_version）；任何一步失败 ⇒ 整体回滚、
 *    版本停在 1、数据一个字节不改（建表失败不改版本、库仍可用 —— 见 runMigration 的说明）。
 *  - external-content FTS5 + **三条维护触发器**（docs_ai/docs_ad/docs_au）：缺了 MATCH 恒 0 命中（B-3）。
 *  - SQL 字面量一律**单引号**：Node 24 内置 SQLite 关闭了 DQS（双引号是标识符，不是字符串）。
 *  - 只索引最高代际（由 engine 决定喂哪一代），多代目录不会撞 (session_id,seq) 唯一索引。
 *  - 查询串一律经 tokenize.toFtsMatch 转义（A-5c）。
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildIndexText, toFtsMatch } from './tokenize.js';

export const APPLICATION_ID = 0x53565731;
/**
 * 当前 schema 版本。
 *  1 = P1/P2 基线；2 = P3b（sessions.hidden + trash 表）；
 *  3 = P4（sessions.origin / delegation_depth / parent_session：header 事实，供 class S 资格判定）
 */
export const USER_VERSION = 3;
/** 回收站表列（顺序 = CREATE TABLE 顺序 = 读取契约，测试按它断言）。 */
export const TRASH_COLUMNS = Object.freeze([
  'session_id',
  'sha256',
  'size_bytes',
  'favorite',
  'row_json',
  'cold_root',
  'rel_dir',
  'trashed_at',
  'expires_at',
]);

export const SESSION_COLUMNS = Object.freeze([
  'session_id',
  'project_key',
  'rel_dir',
  'log_names',
  'cold_root',
  'format_version',
  'bytes',
  'file_size',
  'file_mtime_ms',
  'header_cwd',
  'header_state',
  'created_at',
  'title',
  'archived_at',
  'backfilled',
  'moved_at',
  'restored_at',
  'status',
  'favorite',
  'error',
  'next_attempt',
  'user_msgs',
  'assistant_msgs',
  'first_user_text',
  'last_assistant_text',
  'indexed_at',
  'source_sha',
  // P3b（§18.5）：用户删除热会话 = hidden=1，文件零改动；hidden=1 不进清扫候选（I-13）。
  // **必须是表的最后一列**：升级路径是 ALTER TABLE ADD COLUMN（追加），新库也必须同序，
  // 否则「新装」与「升级」出来的两份库列序不同（PRAGMA table_info 对不上，测试会红）。
  'hidden',
  // P4（FR-P4-2 / 设计档 §19.7）：header 事实三列，同样 **append 追加**（v2→v3 用同一条纪律）。
  // class 是**派生**值（archivedSessionIds.has(id) ? 'archived' : isSubagentRow ? 'subagent' : null），
  // 刻意不加 vault_class 列，避免「列与归档集合不同步」的新一类不一致。
  'origin',
  'delegation_depth',
  'parent_session',
]);

export const STATUSES = Object.freeze(['hot', 'migrating', 'cold', 'restoring', 'hot-restored', 'trash']);

const SESSION_DEFAULTS = Object.freeze({
  session_id: '',
  project_key: '',
  rel_dir: '',
  log_names: '',
  cold_root: null,
  format_version: 0,
  bytes: 0,
  file_size: 0,
  file_mtime_ms: 0,
  header_cwd: null,
  header_state: 'ok',
  created_at: 0,
  title: '',
  archived_at: null,
  backfilled: 0,
  moved_at: null,
  restored_at: null,
  status: 'hot',
  favorite: 0,
  error: null,
  next_attempt: null,
  user_msgs: 0,
  assistant_msgs: 0,
  first_user_text: '',
  last_assistant_text: '',
  indexed_at: null,
  source_sha: '',
  hidden: 0,
  // P4：header 事实（缺省 = 未知；delegation_depth 用 0，与列上的 NOT NULL DEFAULT 0 同口径）
  origin: null,
  delegation_depth: 0,
  parent_session: null,
});

/**
 * **v1 基线**（P1/P2 的 schema）：不含 hidden 列、没有 trash 表。
 *
 * 刻意保留成「v1 原样」而不是改成 v2：新库与老库必须走**同一条**升级链
 * （建 v1 基线 → 跑迁移 1→2），否则两条路径的列序/表结构会各写一套、慢慢漂移。
 */
const SCHEMA_V1 = [
  "CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)",
  "CREATE TABLE sessions (" +
    "session_id TEXT PRIMARY KEY," +
    "project_key TEXT NOT NULL," +
    "rel_dir TEXT NOT NULL," +
    "log_names TEXT NOT NULL," +
    "cold_root TEXT," +
    "format_version INTEGER NOT NULL," +
    "bytes INTEGER NOT NULL," +
    "file_size INTEGER NOT NULL," +
    "file_mtime_ms INTEGER NOT NULL," +
    "header_cwd TEXT," +
    "header_state TEXT NOT NULL DEFAULT 'ok'," +
    "created_at INTEGER NOT NULL," +
    "title TEXT NOT NULL DEFAULT ''," +
    "archived_at INTEGER," +
    "backfilled INTEGER NOT NULL DEFAULT 0," +
    "moved_at INTEGER," +
    "restored_at INTEGER," +
    "status TEXT NOT NULL," +
    "favorite INTEGER NOT NULL DEFAULT 0," +
    "error TEXT," +
    "next_attempt INTEGER," +
    "user_msgs INTEGER NOT NULL DEFAULT 0," +
    "assistant_msgs INTEGER NOT NULL DEFAULT 0," +
    "first_user_text TEXT NOT NULL DEFAULT ''," +
    "last_assistant_text TEXT NOT NULL DEFAULT ''," +
    "indexed_at INTEGER," +
    "source_sha TEXT NOT NULL" +
    ")",
  "CREATE TABLE docs (" +
    "doc_id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "session_id TEXT NOT NULL," +
    "seq INTEGER NOT NULL," +
    "type TEXT NOT NULL," +
    "role TEXT NOT NULL," +
    "time INTEGER NOT NULL," +
    "surface TEXT NOT NULL DEFAULT 'current'," +
    "text TEXT NOT NULL," +
    "index_text TEXT NOT NULL" +
    ")",
  "CREATE UNIQUE INDEX docs_session_seq ON docs(session_id, seq)",
  "CREATE INDEX docs_session ON docs(session_id)",
  "CREATE VIRTUAL TABLE docs_fts USING fts5(index_text, content='docs', content_rowid='doc_id', tokenize='unicode61')",
  "CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN " +
    "INSERT INTO docs_fts(rowid, index_text) VALUES (new.doc_id, new.index_text); " +
    "END",
  "CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN " +
    "INSERT INTO docs_fts(docs_fts, rowid, index_text) VALUES('delete', old.doc_id, old.index_text); " +
    "END",
  "CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN " +
    "INSERT INTO docs_fts(docs_fts, rowid, index_text) VALUES('delete', old.doc_id, old.index_text); " +
    "INSERT INTO docs_fts(rowid, index_text) VALUES (new.doc_id, new.index_text); " +
    "END",
  "CREATE TABLE frames (" +
    "session_id TEXT NOT NULL," +
    "idx INTEGER NOT NULL," +
    "start INTEGER NOT NULL," +
    "end INTEGER NOT NULL," +
    "PRIMARY KEY (session_id, idx)" +
    ") WITHOUT ROWID",
];

/**
 * schema 迁移链（P3b / §18.5 / A-P3-8）。
 *
 * 每条迁移 = 一组语句 + 目标版本，**整体在一个事务里**执行：
 *   BEGIN → statements… → PRAGMA user_version = to → COMMIT
 * 任一步抛错 ⇒ ROLLBACK（ALTER / CREATE / user_version 一起回滚），版本不变、库照旧可用。
 *
 * 为什么 PRAGMA user_version 能进事务：它写在库头页里，SQLite 的 DDL 与它都是事务性的；
 * 回滚后版本与表结构一起回到迁移前（A-P3-8 的「失败不改版本」就是靠这条）。
 */
export const MIGRATIONS = Object.freeze([
  {
    from: 1,
    to: 2,
    statements: Object.freeze([
      // FR-P3-4 / I-13：热会话删除 = hidden=1（文件零改动），hidden=1 不进清扫候选。
      "ALTER TABLE sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0",
      // FR-P3-4：回收站行。sha256 = 搬移前对源目录算的**全树基线**（恢复时用它校验）；
      // row_json = 删除时 sessions 的整行快照（恢复时整行回填，避免拼 NOT NULL 字段）；
      // expires_at = trashed_at + 30 天（到期只提示、不自动删，A-P3-9）。
      "CREATE TABLE trash (" +
        "session_id TEXT PRIMARY KEY," +
        "sha256 TEXT NOT NULL," +
        "size_bytes INTEGER NOT NULL," +
        "favorite INTEGER NOT NULL DEFAULT 0," +
        "row_json TEXT NOT NULL," +
        "cold_root TEXT," +
        "rel_dir TEXT NOT NULL," +
        "trashed_at INTEGER NOT NULL," +
        "expires_at INTEGER NOT NULL" +
        ")",
      "CREATE INDEX trash_expires ON trash(expires_at)",
    ]),
  },
  {
    // P4（FR-P4-2 / A-P4-13 / 设计档 §19.7）：v2 → v3 只做三条 **append** ALTER：
    // header 事实落库（origin / delegationDepth / parentSession）。不建新表、不加 vault_class 列。
    // 失败方向与 v1→v2 完全相同：单事务回滚 ⇒ 版本停在 2、库照旧可用。
    from: 2,
    to: 3,
    statements: Object.freeze([
      "ALTER TABLE sessions ADD COLUMN origin TEXT",
      "ALTER TABLE sessions ADD COLUMN delegation_depth INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sessions ADD COLUMN parent_session TEXT",
    ]),
  },
]);

/** 摘要窗口半径（字符）：命中词前后各保留这么多**原文**（大小写/标点/连字符原样）。 */
export const SNIPPET_RADIUS = 32;

/**
 * 从**原文**（`docs.text`）截取搜索摘要（A5 / P2.6 评审）。
 *
 * 旧实现用 FTS5 的 `snippet(docs_fts, 0, '[', ']', '…', 12)` —— 它作用在 `docs.index_text` 上，
 * 而 index_text 是**分词后**的文本（拉丁小写化、标点被吃掉、中文插词边界空格）。
 * 真机因此看到 `[dsh] navbar` 这类和用户原文对不上的摘要。
 *
 * 现在：在原文里按命中词（大小写不敏感）定位，截取前后各 radius 个字符的窗口。
 * 命中词高亮仍由客户端用回传的 `tokens` 做 `<mark>`（tokens 口径不变），服务端不插标记。
 *
 * 前置：text 任意（null/undefined ⇒ ''）；tokens 为字符串数组。
 * 后置：返回字符串；窗口被裁剪时首尾带 '…'；内容一律是原文片段（不含分词插词空格）。
 */
export function snippetFromText(text, tokens, options = {}) {
  const source = text === null || text === undefined ? '' : String(text);
  if (!source) return '';
  const radius = Number.isFinite(options.radius) ? Math.max(1, Math.trunc(options.radius)) : SNIPPET_RADIUS;
  const list = (Array.isArray(tokens) ? tokens : [])
    .map((token) => String(token === null || token === undefined ? '' : token))
    .filter(Boolean);
  const head = () => (source.length > radius * 2 ? source.slice(0, radius * 2) + '…' : source);
  if (!list.length) return head();
  const lower = source.toLowerCase();
  let hitAt = -1;
  let hitLength = 0;
  for (const token of list) {
    const index = lower.indexOf(token.toLowerCase());
    if (index < 0) continue;
    if (hitAt < 0 || index < hitAt || (index === hitAt && token.length > hitLength)) {
      hitAt = index;
      hitLength = token.length;
    }
  }
  // 命中词在原文里按字面找不到（分词产物/词形差异）：退回原文开头 —— 仍是原文，绝不是 index_text。
  if (hitAt < 0) return head();
  const start = Math.max(0, hitAt - radius);
  const end = Math.min(source.length, hitAt + Math.max(hitLength, 1) + radius);
  return (start > 0 ? '…' : '') + source.slice(start, end) + (end < source.length ? '…' : '');
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function toInt(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return fallback;
}

function normalizeSessionRow(row) {
  const out = { ...SESSION_DEFAULTS };
  for (const key of SESSION_COLUMNS) {
    if (row && row[key] !== undefined) out[key] = row[key];
  }
  out.session_id = String(out.session_id || '');
  out.project_key = String(out.project_key || '');
  out.rel_dir = String(out.rel_dir || '');
  out.log_names = String(out.log_names || '');
  out.format_version = toInt(out.format_version, 0);
  out.bytes = toInt(out.bytes, 0);
  out.file_size = toInt(out.file_size, 0);
  out.file_mtime_ms = toInt(out.file_mtime_ms, 0);
  out.created_at = toInt(out.created_at, 0);
  out.backfilled = out.backfilled ? 1 : 0;
  out.favorite = out.favorite ? 1 : 0;
  out.user_msgs = toInt(out.user_msgs, 0);
  out.assistant_msgs = toInt(out.assistant_msgs, 0);
  out.title = out.title == null ? '' : String(out.title);
  out.first_user_text = out.first_user_text == null ? '' : String(out.first_user_text);
  out.last_assistant_text = out.last_assistant_text == null ? '' : String(out.last_assistant_text);
  out.source_sha = out.source_sha == null ? '' : String(out.source_sha);
  out.hidden = out.hidden ? 1 : 0;
  // P4（§19.7）：header 事实的读面归一化 —— 空串按「未知」= null，delegation_depth 走整数。
  out.origin = out.origin == null || out.origin === '' ? null : String(out.origin);
  out.delegation_depth = Math.max(0, toInt(out.delegation_depth, 0));
  out.parent_session = out.parent_session == null || out.parent_session === '' ? null : String(out.parent_session);
  if (!STATUSES.includes(out.status)) out.status = 'hot';
  return out;
}

const TRASH_DEFAULTS = Object.freeze({
  session_id: '',
  sha256: '',
  size_bytes: 0,
  favorite: 0,
  row_json: '',
  cold_root: null,
  rel_dir: '',
  trashed_at: 0,
  expires_at: 0,
});

function normalizeTrashRow(row) {
  const out = { ...TRASH_DEFAULTS };
  for (const key of TRASH_COLUMNS) {
    if (row && row[key] !== undefined) out[key] = row[key];
  }
  out.session_id = String(out.session_id || '');
  out.sha256 = out.sha256 == null ? '' : String(out.sha256);
  out.size_bytes = toInt(out.size_bytes, 0);
  out.favorite = out.favorite ? 1 : 0;
  out.row_json = out.row_json == null ? '' : String(out.row_json);
  out.cold_root = out.cold_root == null ? null : String(out.cold_root);
  out.rel_dir = out.rel_dir == null ? '' : String(out.rel_dir);
  out.trashed_at = toInt(out.trashed_at, 0);
  out.expires_at = toInt(out.expires_at, 0);
  return out;
}

export class VaultStore {
  constructor(dbPath, options = {}) {
    this.path = dbPath;
    this.readonly = Boolean(options.readonly);
    this.db = new DatabaseSync(dbPath, this.readonly ? { readOnly: true } : {});
    this.statements = new Map();
    try {
      this.migrate();
    } catch (err) {
      // 拒绝打开（他库 / 版本不兼容）时必须当场释放句柄：Windows 上留着打开的文件
      // 会让调用方的清理与删除失败，看起来像「库被占用」。
      try {
        this.db.close();
      } catch {
        /* 已关闭 */
      }
      throw err;
    }
  }

  static async open(dbPath) {
    if (dbPath !== ':memory:') await mkdir(path.dirname(dbPath), { recursive: true });
    return new VaultStore(dbPath);
  }

  prepare(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /**
   * 库身份判定 + 版本门（§4.2 / D15 / §13 升级边界）——**先读、后写**。
   *
   * ① 先读 `PRAGMA application_id` 与 `PRAGMA user_version`，不写任何 PRAGMA、不建表；
   * ② application_id 非 0 且非本插件（官方 0x44534851 / REF 0x53574954 / 任何他库）⇒ **抛错拒绝打开**：
   *    旧实现先 `PRAGMA application_id = ours` 再读 user_version，既污染他库，
   *    又让「是不是我们的库」这道自检在读到 user_version 之前就被自己抹平了（自检钝化）；
   * ③ 空库（app_id=0 且 user_version=0）⇒ 设 application_id，建 v1 schema，落 user_version；
   * ④ 已是本库 ⇒ 只校验 user_version（> 本版 = 需要升级插件；< 本版 = 需要重建索引）。
   *
   * app_id=0 但 user_version≠0 既不是空库也不是本库：同样 fail-closed 拒绝，绝不接管。
   */
  migrate() {
    if (this.readonly) return;
    const appId = this.applicationId();
    const current = this.userVersion();
    if (appId !== 0 && appId !== APPLICATION_ID) {
      const error = new Error(
        "vault.db 的 application_id=0x" + appId.toString(16).toUpperCase() +
          " 不是本插件的库（ours=0x" + APPLICATION_ID.toString(16).toUpperCase() +
          "）：拒绝打开，未写入任何 PRAGMA、未建表（设计档 §4.2 / D15 / §13）",
      );
      error.code = "foreign-database";
      error.applicationId = appId;
      throw error;
    }
    if (appId === 0 && current !== 0) {
      const error = new Error(
        "vault.db 没有本插件的 application_id，却带着 user_version=" + current +
          "：不是空库，拒绝打开（未写入任何 PRAGMA、未建表）",
      );
      error.code = "foreign-database";
      error.applicationId = appId;
      throw error;
    }
    // 身份确认归属之后才允许落连接级 PRAGMA（journal_mode 会真实改写库文件头/建 -wal，不能提前写）。
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    if (appId === 0) {
      // 新库：建 v1 基线 → 跑整条迁移链 → 落到当前版本。新库走与升级**同一条**迁移链，
      // 不做「新库直接建 v2 表」的第二套 schema（两条路径迟早漂移）。
      this.db.exec("PRAGMA application_id = " + APPLICATION_ID);
      for (const statement of SCHEMA_V1) this.db.exec(statement);
      for (const migration of MIGRATIONS) this.runMigration(migration);
      this.db.exec("PRAGMA user_version = " + USER_VERSION);
      return;
    }
    if (current > USER_VERSION) {
      throw new Error(
        "vault.db 的 user_version=" + current + " 高于本插件支持的 " + USER_VERSION +
          "：请升级插件，或删库重建索引（设计档 §13 升级边界）",
      );
    }
    if (current < USER_VERSION) {
      // P3b / A-P3-8：逐级升级。0 < current < 1 不可能是本库（app_id 已经是我们的），
      // 说明文件被改过 —— 保守 fail-closed（不猜、不接管）。
      if (current < 1) {
        throw new Error("vault.db 的 user_version=" + current + " 不是本插件认识的版本：请重建索引（§13 / A-P3-8）");
      }
      for (const migration of MIGRATIONS) {
        if (migration.to <= current) continue;
        this.runMigration(migration);
      }
      if (this.userVersion() !== USER_VERSION) {
        // 迁移链没覆盖到当前版本（缺一段迁移）：fail-closed，绝不假装「已经是最新」。
        throw new Error(
          "vault.db 升级链不完整：user_version=" + this.userVersion() + " 未达到 " + USER_VERSION + "（请重建索引）",
        );
      }
    }
  }

  /**
   * 执行一条迁移：**单事务**（BEGIN → statements → user_version → COMMIT）。
   *
   * 失败方向（A-P3-8）：回滚全部语句（含 ALTER / CREATE / user_version），复核版本未变，
   * 抛 `code='migration-failed'`（带 from/to/userVersion/cause 四个读数）。
   * 调用方（构造函数）会当场关闭句柄 —— 库文件本身**没有任何改动**，旧版插件仍可打开它。
   */
  runMigration(migration) {
    const statements = Array.isArray(migration && migration.statements) ? migration.statements : [];
    try {
      this.db.exec("BEGIN");
      for (const statement of statements) this.db.exec(statement);
      this.db.exec("PRAGMA user_version = " + migration.to);
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 已经回滚/事务未开：都不改变「版本未变」这个事实 */
      }
      const versionAfter = this.userVersion();
      const message = err && err.message ? err.message : String(err);
      const error = new Error(
        "vault.db 升级 " + migration.from + "→" + migration.to + " 失败：已整体回滚，版本仍为 user_version=" +
          versionAfter + "（库未被改动，旧版插件仍可打开）：" + message,
      );
      error.code = "migration-failed";
      error.from = migration.from;
      error.to = migration.to;
      error.userVersion = versionAfter;
      error.cause = err;
      throw error;
    }
    return { from: migration.from, to: migration.to, statements: statements.length };
  }

  applicationId() {
    const row = this.db.prepare("PRAGMA application_id").get();
    if (!row) return 0;
    const value = row.application_id !== undefined ? row.application_id : Object.values(row)[0];
    return Number(value) || 0;
  }

  userVersion() {
    const row = this.db.prepare("PRAGMA user_version").get();
    if (!row) return 0;
    const value = row.user_version !== undefined ? row.user_version : Object.values(row)[0];
    return Number(value) || 0;
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* 已关闭 */
    }
  }

  // ---- meta -------------------------------------------------------------
  setMeta(key, value) {
    this.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(key), String(value));
  }

  getMeta(key, fallback = null) {
    const row = this.prepare("SELECT v FROM meta WHERE k = ?").get(String(key));
    return row ? row.v : fallback;
  }

  deleteMeta(key) {
    const result = this.prepare("DELETE FROM meta WHERE k = ?").run(String(key));
    return Number(result && result.changes ? result.changes : 0);
  }

  /**
   * 列出某个前缀下的 meta 键（P3：scope 降级时要清掉全部 `tscope:<id>` 标记）。
   * 前缀由本插件自己给（不含 LIKE 通配符），这里按 LIKE 前缀匹配并原样返回键名。
   */
  listMetaKeys(prefix) {
    const value = String(prefix);
    return this.prepare("SELECT k FROM meta WHERE k LIKE ?").all(value + '%').map((row) => String(row.k));
  }

  // ---- sessions ---------------------------------------------------------
  /**
   * upsert 语句的**唯一拼装点**（upsertSession / upsertSessions / restoreSessionFromTrash 共用）。
   * 列清单来自 SESSION_COLUMNS —— 加列（P3b 的 hidden）不需要改三处 SQL。
   */
  sessionUpsertSql() {
    const columns = SESSION_COLUMNS;
    const placeholders = columns.map(() => "?").join(", ");
    const updates = columns
      .filter((column) => column !== "session_id")
      .map((column) => quoteIdent(column) + " = excluded." + quoteIdent(column))
      .join(", ");
    return (
      "INSERT INTO sessions (" + columns.map(quoteIdent).join(", ") + ") VALUES (" + placeholders + ") " +
      "ON CONFLICT(session_id) DO UPDATE SET " + updates
    );
  }

  upsertSession(row) {
    const value = normalizeSessionRow(row);
    if (!value.session_id) throw new Error("upsertSession 需要 session_id");
    this.prepare(this.sessionUpsertSql()).run(...SESSION_COLUMNS.map((column) => value[column]));
    return this.getSession(value.session_id);
  }

  /** 批量 upsert（P2-0 回填 118 行用；单事务，避免 118 次 auto-commit）。 */
  upsertSessions(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return 0;
    const columns = SESSION_COLUMNS;
    const statement = this.prepare(this.sessionUpsertSql());
    this.db.exec('BEGIN');
    try {
      for (const row of list) {
        const value = normalizeSessionRow(row);
        if (!value.session_id) throw new Error('upsertSessions 需要 session_id');
        statement.run(...columns.map((column) => value[column]));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    return list.length;
  }

  /**
   * 局部更新一行。
   *
   * status 只接受六值枚举（§4.2 / R-15）：非法值一律抛 `code=invalid-status`，**绝不静默改写成 hot**——
   * 静默改写会把调用方的 bug 变成一条「看起来成功」的错误状态（旧实现就是这样）。
   * 抛错发生在任何写入之前，所以同一 patch 里的其它列也不会被写。
   * 历史脏数据的归一化保留在读面（normalizeSessionRow），不受本门影响。
   */
  updateSession(id, patch = {}) {
    const keys = Object.keys(patch).filter((key) => SESSION_COLUMNS.includes(key) && key !== "session_id");
    if (!keys.length) return this.getSession(id);
    if (keys.includes("status") && !STATUSES.includes(patch.status)) {
      const error = new Error(
        "status 必须是 [" + STATUSES.join(", ") + "] 之一（收到 " + JSON.stringify(patch.status) +
          "）：行 " + String(id) + " 未改动",
      );
      error.code = "invalid-status";
      error.status = patch.status;
      throw error;
    }
    const assignments = keys.map((key) => quoteIdent(key) + " = ?").join(", ");
    const values = keys.map((key) => patch[key]);
    this.prepare("UPDATE sessions SET " + assignments + " WHERE session_id = ?").run(...values, String(id));
    return this.getSession(id);
  }

  /**
   * 批量局部更新**同一个 patch**（F2：列表/启动自愈补 archived_at、backfilled 用）。
   *
   * 单事务，避免 118 次 auto-commit；keys 仍受 SESSION_COLUMNS 白名单约束，
   * status 仍走六值枚举门（非法值抛在**任何写入之前**，整批不动）。
   */
  updateSessions(ids, patch = {}) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
    const keys = Object.keys(patch || {}).filter((key) => SESSION_COLUMNS.includes(key) && key !== 'session_id');
    if (!list.length || !keys.length) return 0;
    if (keys.includes('status') && !STATUSES.includes(patch.status)) {
      const error = new Error(
        'status 必须是 [' + STATUSES.join(', ') + '] 之一（收到 ' + JSON.stringify(patch.status) +
          '）：' + list.length + ' 行未改动',
      );
      error.code = 'invalid-status';
      error.status = patch.status;
      throw error;
    }
    const assignments = keys.map((key) => quoteIdent(key) + ' = ?').join(', ');
    const values = keys.map((key) => patch[key]);
    const statement = this.prepare('UPDATE sessions SET ' + assignments + ' WHERE session_id = ?');
    this.db.exec('BEGIN');
    try {
      for (const id of list) statement.run(...values, id);
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    return list.length;
  }

  getSession(id) {
    const row = this.prepare("SELECT * FROM sessions WHERE session_id = ?").get(String(id));
    return row || null;
  }

  listSessions(filter = null) {
    const clauses = [];
    const values = [];
    if (filter && Array.isArray(filter.status) && filter.status.length) {
      clauses.push("status IN (" + filter.status.map(() => "?").join(", ") + ")");
      values.push(...filter.status);
    }
    if (filter && filter.errorOnly) clauses.push("error IS NOT NULL");
    if (filter && filter.projectKey) {
      clauses.push("project_key = ?");
      values.push(filter.projectKey);
    }
    // P3b（FR-P3-3 / FR-P3-4）：收藏与隐藏的过滤面（strict boolean：不给就不过滤）。
    if (filter && typeof filter.favorite === "boolean") {
      clauses.push("favorite = ?");
      values.push(filter.favorite ? 1 : 0);
    }
    if (filter && typeof filter.hidden === "boolean") {
      clauses.push("hidden = ?");
      values.push(filter.hidden ? 1 : 0);
    }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    return this.prepare("SELECT * FROM sessions" + where + " ORDER BY COALESCE(moved_at, created_at) DESC").all(...values);
  }

  /** 按 id 批量取行（搜索分组用；一次 IN 查询取代 N 次 getSession）。 */
  getSessionsByIds(ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
    const out = new Map();
    for (let offset = 0; offset < list.length; offset += 500) {
      const chunk = list.slice(offset, offset + 500);
      const rows = this.prepare('SELECT * FROM sessions WHERE session_id IN (' + chunk.map(() => '?').join(', ') + ')').all(...chunk);
      for (const row of rows) out.set(row.session_id, row);
    }
    return out;
  }

  deleteSession(id) {
    this.db.exec("BEGIN");
    try {
      this.prepare("DELETE FROM docs WHERE session_id = ?").run(String(id));
      this.prepare("DELETE FROM frames WHERE session_id = ?").run(String(id));
      this.prepare("DELETE FROM sessions WHERE session_id = ?").run(String(id));
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    }
  }

  // ---- trash（FR-P3-4 / §18.5；P3b）---------------------------------------
  /**
   * 把一条会话行搬进回收站表，并**在同一个事务里**删掉 sessions 行与它的索引。
   *
   * 后置（失败时全部回滚）：trash 表有该 id 的行；sessions / docs / frames 没有该 id。
   * 幂等：同 id 重复写按 exclude 覆盖（崩溃续跑会重放这一笔）。
   *
   * @param {{session_id:string, sha256:string, size_bytes:number, favorite?:number, row_json:string,
   *          cold_root?:string|null, rel_dir:string, trashed_at:number, expires_at:number}} record
   */
  trashSession(record) {
    const value = normalizeTrashRow(record);
    if (!value.session_id) throw new Error("trashSession 需要 session_id");
    if (!value.row_json) throw new Error("trashSession 需要 row_json（恢复时整行回填）");
    this.db.exec("BEGIN");
    try {
      this.prepare(
        "INSERT INTO trash (" + TRASH_COLUMNS.map(quoteIdent).join(", ") + ") VALUES (" +
          TRASH_COLUMNS.map(() => "?").join(", ") + ") " +
          "ON CONFLICT(session_id) DO UPDATE SET " +
          TRASH_COLUMNS.filter((column) => column !== "session_id")
            .map((column) => quoteIdent(column) + " = excluded." + quoteIdent(column))
            .join(", "),
      ).run(...TRASH_COLUMNS.map((column) => value[column]));
      this.prepare("DELETE FROM docs WHERE session_id = ?").run(value.session_id);
      this.prepare("DELETE FROM frames WHERE session_id = ?").run(value.session_id);
      this.prepare("DELETE FROM sessions WHERE session_id = ?").run(value.session_id);
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    }
    return this.getTrashRow(value.session_id);
  }

  getTrashRow(id) {
    const row = this.prepare("SELECT * FROM trash WHERE session_id = ?").get(String(id));
    return row ? normalizeTrashRow(row) : null;
  }

  /** 回收站列表（只读；按 trashed_at 倒序）。limit <= 0 = 不封顶。 */
  listTrash(options = {}) {
    const limit = Number.isFinite(Number(options.limit)) ? Math.trunc(Number(options.limit)) : 0;
    const sql =
      "SELECT * FROM trash ORDER BY trashed_at DESC, session_id ASC" + (limit > 0 ? " LIMIT " + limit : "");
    return this.prepare(sql).all().map((row) => normalizeTrashRow(row));
  }

  trashCount() {
    const row = this.prepare("SELECT COUNT(*) AS n FROM trash").get();
    return row ? Number(row.n) || 0 : 0;
  }

  deleteTrash(id) {
    const result = this.prepare("DELETE FROM trash WHERE session_id = ?").run(String(id));
    return Number(result && result.changes ? result.changes : 0);
  }

  /**
   * 回收站还原：**单事务**把 sessions 整行回填 + 删 trash 行。
   * 调用方必须先把文件搬回冷目录并通过 trash.sha256 校验（本方法只碰 DB）。
   */
  restoreSessionFromTrash(row) {
    const value = normalizeSessionRow(row);
    if (!value.session_id) throw new Error("restoreSessionFromTrash 需要 session_id");
    this.db.exec("BEGIN");
    try {
      this.prepare(this.sessionUpsertSql()).run(...SESSION_COLUMNS.map((column) => value[column]));
      this.prepare("DELETE FROM trash WHERE session_id = ?").run(value.session_id);
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    }
    return this.getSession(value.session_id);
  }

  // ---- docs / FTS -------------------------------------------------------
  /** 事务式整体替换某会话的索引（先删旧文档 → 触发器同步 FTS）。 */
  replaceDocs(sessionId, docs) {
    const rows = this.assignSequences(docs);
    this.db.exec("BEGIN");
    try {
      this.prepare("DELETE FROM docs WHERE session_id = ?").run(String(sessionId));
      const insert = this.prepare(
        "INSERT INTO docs (session_id, seq, type, role, time, surface, text, index_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const doc of rows) {
        insert.run(
          String(sessionId),
          doc.seq,
          String(doc.type || "user"),
          String(doc.role || "user"),
          toInt(doc.time, 0),
          String(doc.surface || "current"),
          String(doc.text || ""),
          doc.index_text !== undefined ? String(doc.index_text) : buildIndexText(doc.text || ""),
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    }
    return rows.length;
  }

  assignSequences(docs) {
    const used = new Set();
    let next = 0;
    const out = [];
    for (const doc of docs) {
      let seq = typeof doc.seq === "number" && Number.isFinite(doc.seq) ? Math.trunc(doc.seq) : null;
      if (seq === null || used.has(seq)) {
        while (used.has(next) || (seq !== null && next <= seq)) next += 1;
        seq = next;
      }
      used.add(seq);
      next = Math.max(next, seq + 1);
      out.push({ ...doc, seq });
    }
    return out;
  }

  deleteDocs(sessionId) {
    this.prepare("DELETE FROM docs WHERE session_id = ?").run(String(sessionId));
  }

  /**
   * P3 / FR-P3-2：按 surface 删文档（**降级**唯一动作：toolResults → body 只删 tool 文档，不重读日志）。
   * docs_ad 触发器同步把 FTS 行打出去（A-5b），所以删完 MATCH 立即不再命中。
   * @returns {number} 删除的行数
   */
  deleteDocsBySurface(surface) {
    const result = this.prepare("DELETE FROM docs WHERE surface = ?").run(String(surface));
    return Number(result && result.changes ? result.changes : 0);
  }

  countDocsBySurface(surface) {
    const row = this.prepare("SELECT COUNT(*) AS n FROM docs WHERE surface = ?").get(String(surface));
    return row ? Number(row.n) || 0 : 0;
  }

  countDocs(sessionId) {
    const row = this.prepare("SELECT COUNT(*) AS n FROM docs WHERE session_id = ?").get(String(sessionId));
    return row ? Number(row.n) : 0;
  }

  /**
   * 全文检索。
   *
   * 命中面 = `surface IN ('current','tool-result')`：
   *  - 'current'    正文（默认 scope 下唯一的文档面）；
   *  - 'tool-result' P3 的 tool/result 文本结果 —— 只有 searchScope='body+toolResults' 时才会存在
   *    （降级时被 deleteDocsBySurface 整面删掉，所以这里放开不会改变 body 模式的结果集）；
   *  - 'shadowed' 等被替换/影子的旧文本仍然不命中（A-5b 口径不变）。
   *
   * @returns {{match:string|null, tokens:string[], hits:Array<object>}}
   */
  searchDocs(query, options = {}) {
    const limit = Math.min(Math.max(toInt(options.limit, 20), 1), 500);
    const { match, tokens } = toFtsMatch(query);
    if (!match) return { match: null, tokens: [], hits: [] };
    const params = [match];
    // A5：摘要取原文列 d.text（**不是** index_text）—— 由 snippetFromText 在 JS 里按命中词位置截取。
    let sql =
      "SELECT d.doc_id AS doc_id, d.session_id AS session_id, d.seq AS seq, d.type AS type, d.role AS role, " +
      "d.time AS time, d.surface AS surface, d.text AS text " +
      "FROM docs_fts JOIN docs d ON d.doc_id = docs_fts.rowid " +
      "WHERE docs_fts MATCH ? AND d.surface IN ('current', 'tool-result')";
    if (options.sessionId) {
      sql += " AND d.session_id = ?";
      params.push(String(options.sessionId));
    }
    sql += " ORDER BY docs_fts.rank LIMIT ?";
    params.push(limit);
    let rows = [];
    try {
      rows = this.prepare(sql).all(...params);
    } catch (err) {
      throw new Error("FTS 查询失败（转义后仍不合法）：" + (err && err.message ? err.message : err));
    }
    return {
      match,
      tokens,
      hits: rows.map((row) => ({
        docId: Number(row.doc_id),
        sessionId: row.session_id,
        seq: Number(row.seq),
        type: row.type,
        role: row.role,
        time: Number(row.time),
        // P3：命中面（'current' = 正文 / 'tool-result' = 工具结果）；groups/snippet 契约不变，本字段只作标注。
        surface: row.surface || 'current',
        // A5：从原文截取（保留大小写与原文标点，不含分词空格）；tokens 不变，供 UI 做 <mark> 高亮。
        snippet: snippetFromText(row.text, tokens),
      })),
    };
  }

  // ---- frames（P2 定位用，P1 只建表） -----------------------------------
  putFrames(sessionId, frames) {
    const insert = this.prepare("INSERT OR REPLACE INTO frames (session_id, idx, start, end) VALUES (?, ?, ?, ?)");
    for (const frame of frames) insert.run(String(sessionId), toInt(frame.index, 0), toInt(frame.start, 0), toInt(frame.end, 0));
  }

  listFrames(sessionId) {
    return this.prepare("SELECT idx, start, end FROM frames WHERE session_id = ? ORDER BY idx").all(String(sessionId));
  }

  // ---- stats ------------------------------------------------------------
  stats() {
    const row = this.prepare(
      "SELECT COUNT(*) AS total," +
        " COALESCE(SUM(CASE WHEN status = 'cold' THEN 1 ELSE 0 END), 0) AS cold," +
        " COALESCE(SUM(CASE WHEN status = 'hot' THEN 1 ELSE 0 END), 0) AS hot," +
        " COALESCE(SUM(CASE WHEN status = 'hot-restored' THEN 1 ELSE 0 END), 0) AS hotRestored," +
        " COALESCE(SUM(CASE WHEN status = 'cold' THEN bytes ELSE 0 END), 0) AS bytesCold," +
        " COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors," +
        // P3b：收藏数 / 隐藏数（用户删除的热会话 = hidden=1，文件仍在 sessions）
        " COALESCE(SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END), 0) AS favorites," +
        " COALESCE(SUM(CASE WHEN hidden = 1 THEN 1 ELSE 0 END), 0) AS hidden" +
        " FROM sessions",
    ).get();
    const docs = this.prepare("SELECT COUNT(*) AS n FROM docs").get();
    return {
      sessions: row ? Number(row.total) : 0,
      cold: row ? Number(row.cold) : 0,
      hot: row ? Number(row.hot) : 0,
      hotRestored: row ? Number(row.hotRestored) : 0,
      bytesCold: row ? Number(row.bytesCold) : 0,
      errors: row ? Number(row.errors) : 0,
      favorites: row ? Number(row.favorites) : 0,
      hidden: row ? Number(row.hidden) : 0,
      // 回收站行数（trash 表；与 sessions 行互斥 —— 删进回收站时 sessions 行已删）
      trash: this.trashCount(),
      docs: docs ? Number(docs.n) : 0,
    };
  }

  /**
   * 索引覆盖面读数（P2-4 status 的 indexed/total；不含 trash）。
   *
   * F5（真机读数误导）：indexed 只是「sessions 行里有 indexed_at」的行数，行的**本轮进度**
   * 另算；真正能回答「有多少会话的正文已进索引」的是 docs 侧的 distinct session_id —— 即 coverage。
   */
  indexStats() {
    const row = this.prepare(
      "SELECT COUNT(*) AS total," +
        " COALESCE(SUM(CASE WHEN indexed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS indexed" +
        " FROM sessions WHERE status != 'trash'",
    ).get();
    return {
      total: row ? Number(row.total) : 0,
      indexed: row ? Number(row.indexed) : 0,
      coverage: this.docCoverage(),
    };
  }

  /**
   * F5：**有正文索引的会话数**（docs 侧 distinct session_id）。
   *
   * 与「sessions 行的 indexed_at」是两个不同口径：indexed_at 会被 replaceDocs([]) 的
   * extract-empty 会话置位，而 coverage 只数真的落了 docs 的会话。UI 的「已索引 N/M」
   * 与 /status 的 index.coverage 都用它（本轮进度另由 indexer 计数给出）。
   */
  docCoverage() {
    const row = this.prepare("SELECT COUNT(DISTINCT session_id) AS n FROM docs").get();
    return row ? Number(row.n) || 0 : 0;
  }

  recentErrors(limit = 20) {
    return this.prepare(
      "SELECT session_id AS id, error, status, moved_at, restored_at FROM sessions WHERE error IS NOT NULL " +
        "ORDER BY COALESCE(moved_at, created_at) DESC LIMIT ?",
    ).all(Math.min(Math.max(toInt(limit, 20), 1), 200));
  }
}

export async function openStore(dbPath) {
  return VaultStore.open(dbPath);
}
