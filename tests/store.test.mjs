import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VaultStore, APPLICATION_ID, USER_VERSION } from '../lib/store.js';
import { buildIndexText } from '../lib/tokenize.js';

async function withStore(fn, { memory = true } = {}) {
  const dir = memory ? null : await mkdtemp(path.join(os.tmpdir(), 'vault-store-'));
  const dbPath = memory ? ':memory:' : path.join(dir, 'vault.db');
  const store = await VaultStore.open(dbPath);
  try {
    return await fn(store, dir);
  } finally {
    store.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

function sessionRow(overrides = {}) {
  return {
    session_id: 'session-a',
    project_key: '--demo--',
    rel_dir: '--demo--/session-a',
    log_names: 'session.v4.jsonl.zstd',
    format_version: 4,
    bytes: 1234,
    file_size: 1200,
    file_mtime_ms: 1792000000000,
    header_cwd: '<workspace-root>\\demo',
    created_at: 1791000000000,
    status: 'hot',
    source_sha: 'abcdef0123456789',
    ...overrides,
  };
}

function doc(seq, text, extra = {}) {
  return { seq, type: 'user', role: 'user', time: 1792000000000, text, index_text: buildIndexText(text), ...extra };
}

test('P1-3: schema 与设计 §4.2 一致（application_id / user_version / 三触发器）', async () => {
  await withStore(async (store) => {
    assert.equal(store.applicationId(), APPLICATION_ID);
    assert.equal(APPLICATION_ID, 0x53565731);
    assert.equal(store.userVersion(), USER_VERSION);

    const tables = new Set(store.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    // P3b（§18.5 / A-P3-8）：schema 2 新增 trash 表（回收站）
    for (const name of ['meta', 'sessions', 'docs', 'docs_fts', 'frames', 'trash']) {
      assert.ok(tables.has(name), '缺表 ' + name);
    }
    const triggers = new Set(store.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name));
    for (const name of ['docs_ai', 'docs_ad', 'docs_au']) {
      assert.ok(triggers.has(name), '缺触发器 ' + name);
    }

    // P3b（§18.5 / A-P3-8）+ P4（§19.7 / A-P4-13）：sessions 的追加列必须是**表的最后几列**
    // （升级走 ALTER TABLE ADD COLUMN ⇒ 追加；新库必须同序，否则「新装」与「升级」出来的两份库列序不同）。
    const sessionColumns = store.prepare('PRAGMA table_info(sessions)').all().map((r) => r.name);
    const expected = [
      'session_id', 'project_key', 'rel_dir', 'log_names', 'cold_root', 'format_version', 'bytes',
      'file_size', 'file_mtime_ms', 'header_cwd', 'header_state', 'created_at', 'title', 'archived_at',
      'backfilled', 'moved_at', 'restored_at', 'status', 'favorite', 'error', 'next_attempt',
      'user_msgs', 'assistant_msgs', 'first_user_text', 'last_assistant_text', 'indexed_at', 'source_sha',
      'hidden',
      // P4：header 事实三列（v2→v3 append）
      'origin', 'delegation_depth', 'parent_session',
    ];
    assert.deepEqual(sessionColumns, expected);
    assert.equal(USER_VERSION, 3, 'P4 的 schema 版本必须是 3（1 = P1/P2 基线，2 = P3b）');
    const trashColumns = store.prepare('PRAGMA table_info(trash)').all().map((r) => r.name);
    assert.deepEqual(trashColumns, ['session_id', 'sha256', 'size_bytes', 'favorite', 'row_json', 'cold_root', 'rel_dir', 'trashed_at', 'expires_at']);

    const docColumns = store.prepare('PRAGMA table_info(docs)').all().map((r) => r.name);
    assert.deepEqual(docColumns, ['doc_id', 'session_id', 'seq', 'type', 'role', 'time', 'surface', 'text', 'index_text']);
  });
});

test('P1-3: docs → FTS 同步（插入即命中，中文与拉丁都能搜）', async () => {
  await withStore(async (store) => {
    store.upsertSession(sessionRow());
    store.replaceDocs('session-a', [
      doc(1, '会话保险库的全文搜索'),
      doc(2, 'cold storage search works', { type: 'assistant', role: 'assistant' }),
    ]);

    const zh = store.searchDocs('保险');
    assert.equal(zh.hits.length, 1);
    assert.equal(zh.hits[0].sessionId, 'session-a');
    assert.match(zh.hits[0].snippet, /保险/);
    assert.equal(zh.match, '"保险"');

    const en = store.searchDocs('storage');
    assert.equal(en.hits.length, 1);
    assert.equal(en.hits[0].seq, 2);

    assert.equal(store.countDocs('session-a'), 2);
  });
});

test('P1-3: 删除行经触发器同步出 FTS（A-5b）', async () => {
  await withStore(async (store) => {
    store.upsertSession(sessionRow());
    store.replaceDocs('session-a', [doc(1, '要被删掉的句子')]);
    assert.equal(store.searchDocs('删掉').hits.length, 1);
    store.deleteDocs('session-a');
    assert.equal(store.searchDocs('删掉').hits.length, 0);
  });
});

test('P1-3: 更新行同步 FTS（docs_au 触发器）', async () => {
  await withStore(async (store) => {
    store.upsertSession(sessionRow());
    store.replaceDocs('session-a', [doc(1, '旧文本在这里')]);
    assert.equal(store.searchDocs('旧文本').hits.length, 1);

    store.replaceDocs('session-a', [doc(1, '新文本在这里')]);
    assert.equal(store.searchDocs('旧文本').hits.length, 0);
    assert.equal(store.searchDocs('新文本').hits.length, 1);
    assert.equal(store.countDocs('session-a'), 1, '替换不得留双份');
  });
});

test('P1-3: 查询串转义（A-5c：不抛错、不全匹配）', async () => {
  await withStore(async (store) => {
    store.upsertSession(sessionRow());
    store.replaceDocs('session-a', [doc(1, 'normal words here')]);
    for (const nasty of ['" * NEAR(', '""', 'OR', 'NOT "x"', '()', 'a OR b']) {
      assert.doesNotThrow(() => store.searchDocs(nasty), '查询 ' + nasty + ' 不得抛错');
    }
    const empty = store.searchDocs('*** "" ()');
    assert.equal(empty.match, null);
    assert.deepEqual(empty.hits, []);
  });
});

test('P1-3: surface=current 过滤（影子/被替换的旧文本不命中）', async () => {
  await withStore(async (store) => {
    store.upsertSession(sessionRow());
    // 用拉丁唯一词，避免中文分词把两个文档切出同样的词导致断言不稳
    store.replaceDocs('session-a', [
      doc(1, 'shadowed-only-term', { surface: 'shadowed' }),
      doc(2, 'current-only-term'),
    ]);
    const currentHits = store.searchDocs('current-only-term');
    assert.equal(currentHits.hits.length, 1);
    assert.equal(currentHits.hits[0].seq, 2);
    const shadowedHits = store.searchDocs('shadowed-only-term');
    assert.equal(shadowedHits.hits.length, 0, 'surface=shadowed 不得命中');
    // 两个词都同时出现在两份文档里：若无 surface 过滤应命中 2 条，实际只命中 current 的 1 条
    const sharedHits = store.searchDocs('only-term');
    assert.equal(sharedHits.hits.length, 1, 'surface=current 过滤必须生效');
  });
});

test('P1-3: replaceDocs 幂等 / seq 冲突自动分配', async () => {
  await withStore(async (store) => {
    store.upsertSession(sessionRow());
    const docs = [doc(1, '第一句'), doc(1, '重复 seq 的第二句'), { seq: null, type: 'user', role: 'user', time: 0, text: '没有 seq 的句子' }];
    store.replaceDocs('session-a', docs);
    const stored = store.prepare('SELECT seq FROM docs WHERE session_id = ? ORDER BY seq').all('session-a');
    const seqs = stored.map((r) => Number(r.seq));
    assert.equal(new Set(seqs).size, seqs.length, 'seq 必须唯一');
    assert.equal(seqs.length, 3);

    store.replaceDocs('session-a', [doc(1, '第一句'), doc(2, '第二句')]);
    store.replaceDocs('session-a', [doc(1, '第一句'), doc(2, '第二句')]);
    assert.equal(store.countDocs('session-a'), 2);
  });
});

test('P1-3: 会话行 upsert/update/list/stats/meta', async () => {
  await withStore(async (store) => {
    const created = store.upsertSession(sessionRow());
    assert.equal(created.status, 'hot');
    assert.equal(created.source_sha, 'abcdef0123456789');

    store.updateSession('session-a', { status: 'cold', cold_root: 'D:\\vault\\cold', moved_at: 1792000000000, bytes: 999 });
    const cold = store.getSession('session-a');
    assert.equal(cold.status, 'cold');
    assert.equal(cold.bytes, 999);
    assert.equal(cold.project_key, '--demo--', '局部更新不得清空其他列');

    assert.equal(store.listSessions({ status: ['cold'] }).length, 1);
    assert.equal(store.listSessions({ status: ['hot'] }).length, 0);
    assert.equal(store.listSessions({ projectKey: '--demo--' }).length, 1);

    const stats = store.stats();
    assert.equal(stats.sessions, 1);
    assert.equal(stats.cold, 1);
    assert.equal(stats.bytesCold, 999);

    store.setMeta('schema', 'ok');
    assert.equal(store.getMeta('schema'), 'ok');
    assert.equal(store.getMeta('missing', 'fallback'), 'fallback');

    store.updateSession('session-a', { error: 'index-failed' });
    const errors = store.recentErrors();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].id, 'session-a');

    store.deleteSession('session-a');
    assert.equal(store.getSession('session-a'), null);
  });
});

// ---------------------------------------------------------------------------
// 第三轮小修（代码评审剩余 4 条 🔵 中的 2 条存储侧）
// ---------------------------------------------------------------------------

test('R3-3：application_id 非 0 且非本插件 ⇒ 拒绝打开，文件字节/application_id/表结构零改动', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vault-store-foreign-'));
  const dbPath = path.join(dir, 'vault.db');
  try {
    const seeds = [
      { label: '官方 0x44534851 + user_version=0', appId: 0x44534851, version: 0 },
      { label: 'REF 0x53574954 + user_version=1', appId: 0x53574954, version: 1 },
    ];
    for (const seed of seeds) {
      await rm(dbPath, { force: true });
      const raw = new DatabaseSync(dbPath);
      raw.exec('PRAGMA application_id = ' + seed.appId);
      raw.exec('PRAGMA user_version = ' + seed.version);
      raw.exec('CREATE TABLE foreign_data (k TEXT)');
      raw.close();
      const before = await readFile(dbPath);

      // 刻意不用 assert.rejects：若实现「意外打开成功」，先把句柄关掉再断言，
      // 否则 Windows 上的 EBUSY 会盖掉真正的失败原因（旧实现就是这样接管他库的）。
      let opened = null;
      let rejection = null;
      try {
        opened = await VaultStore.open(dbPath);
      } catch (err) {
        rejection = err;
      }
      if (opened) opened.close();
      assert.ok(rejection, seed.label + '：必须拒绝打开（拿到库实例 = 接管了他库）');
      assert.equal(rejection.code, 'foreign-database', seed.label + '：错误码必须是 foreign-database');
      assert.match(String(rejection.message), /application_id/, seed.label + '：错误信息要点明 application_id');

      const after = await readFile(dbPath);
      assert.deepEqual(after, before, seed.label + '：文件字节不得被改动（不写任何 PRAGMA、不建表）');
      const walExists = await stat(dbPath + '-wal').then(() => true).catch(() => false);
      assert.equal(walExists, false, seed.label + '：不得切到 WAL（-wal 文件不得出现）');

      const check = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(check.prepare('PRAGMA application_id').get().application_id, seed.appId, 'application_id 必须原样');
        assert.equal(check.prepare('PRAGMA user_version').get().user_version, seed.version, 'user_version 必须原样');
        const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
        assert.deepEqual(tables, ['foreign_data'], '不得建任何本插件的表');
        const triggers = check.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all();
        assert.equal(triggers.length, 0, '不得建任何触发器（FTS 三触发器一个都不能有）');
        const fts = check.prepare("SELECT name FROM sqlite_master WHERE name = 'docs_fts'").all();
        assert.equal(fts.length, 0);
      } finally {
        check.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R3-4：updateSession 非法 status 抛 code=invalid-status，且 DB 行原样不动', async () => {
  await withStore(async (store) => {
    store.upsertSession(sessionRow());
    const before = store.getSession('session-a');

    assert.throws(
      () => store.updateSession('session-a', { status: 'bogus' }),
      (err) => err && err.code === 'invalid-status' && /bogus/.test(String(err.message)),
      '非法 status 必须抛错（旧实现静默改写成 hot）',
    );
    assert.equal(store.getSession('session-a').status, 'hot', '非法 status 不得静默改写成 hot');

    // 抛错发生在任何写入之前：同一 patch 里的其它列也不得落库
    assert.throws(
      () => store.updateSession('session-a', { title: '不该落库', status: 'bogus' }),
      (err) => err && err.code === 'invalid-status',
    );
    assert.deepEqual(store.getSession('session-a'), before, '抛错时整行必须原样（含 status 与 title）');

    // 合法值照常生效
    store.updateSession('session-a', { status: 'cold' });
    assert.equal(store.getSession('session-a').status, 'cold');

    // 读/映射面的历史脏数据归一化保留（mapRow：非枚举值 ⇒ hot），不受新门影响
    const normalized = store.upsertSession(sessionRow({ session_id: 'session-legacy', status: 'legacy-unknown' }));
    assert.equal(normalized.status, 'hot', '历史脏数据的归一化（normalizeSessionRow）必须保留');
  });
});


// ---------------------------------------------------------------------------
// P4 / A-P4-13：schema v2 → v3（v1→v3 与 v2→v3 两条链都要过；失败整体回滚）
// ---------------------------------------------------------------------------

/** v1 基线（P1/P2）：不含 hidden / origin 等追加列，也没有 trash 表。 */
const V1_SESSIONS_DDL =
  'CREATE TABLE sessions (' +
  "session_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, rel_dir TEXT NOT NULL, log_names TEXT NOT NULL," +
  "cold_root TEXT, format_version INTEGER NOT NULL, bytes INTEGER NOT NULL, file_size INTEGER NOT NULL," +
  "file_mtime_ms INTEGER NOT NULL, header_cwd TEXT, header_state TEXT NOT NULL DEFAULT 'ok'," +
  "created_at INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', archived_at INTEGER," +
  "backfilled INTEGER NOT NULL DEFAULT 0, moved_at INTEGER, restored_at INTEGER, status TEXT NOT NULL," +
  "favorite INTEGER NOT NULL DEFAULT 0, error TEXT, next_attempt INTEGER," +
  "user_msgs INTEGER NOT NULL DEFAULT 0, assistant_msgs INTEGER NOT NULL DEFAULT 0," +
  "first_user_text TEXT NOT NULL DEFAULT '', last_assistant_text TEXT NOT NULL DEFAULT ''," +
  'indexed_at INTEGER, source_sha TEXT NOT NULL)';

async function seedDatabase(dbPath, version, extra = []) {
  await mkdir(path.dirname(dbPath), { recursive: true });
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('PRAGMA application_id = ' + APPLICATION_ID);
    raw.exec('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)');
    raw.exec(V1_SESSIONS_DDL);
    if (version >= 2) {
      // v2 的 DDL 与 lib/store.js 的 1→2 迁移逐字一致（hidden 追加 + trash 表）
      raw.exec('ALTER TABLE sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
      raw.exec(
        'CREATE TABLE trash (session_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,' +
          ' favorite INTEGER NOT NULL DEFAULT 0, row_json TEXT NOT NULL, cold_root TEXT, rel_dir TEXT NOT NULL,' +
          ' trashed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
      );
      raw.exec('CREATE INDEX trash_expires ON trash(expires_at)');
    }
    for (const statement of extra) raw.exec(statement);
    raw.exec(
      "INSERT INTO sessions (session_id, project_key, rel_dir, log_names, format_version, bytes, file_size, file_mtime_ms, created_at, status, source_sha) " +
        "VALUES ('session-v1', '--p--', '--p--/session-v1', 'session.v4.jsonl.zstd', 4, 11, 11, 42, 1, 'hot', 'sha-v1')",
    );
    raw.exec('PRAGMA user_version = ' + version);
  } finally {
    raw.close();
  }
}

async function withSeededDatabase(version, fn, extra = []) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p4-v' + version + '-'));
  const dbPath = path.join(home, 'vault.db');
  try {
    await seedDatabase(dbPath, version, extra);
    return await fn(dbPath);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

for (const from of [1, 2]) {
  test('A-P4-13：v' + from + ' → v3 升级成功 —— 三列追加在末尾、存量行原样、默认值正确', async () => {
    await withSeededDatabase(from, async (dbPath) => {
      const store = await VaultStore.open(dbPath);
      try {
        assert.equal(store.userVersion(), USER_VERSION);
        assert.equal(USER_VERSION, 3);
        const columns = store.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name);
        assert.deepEqual(columns.slice(-4), ['hidden', 'origin', 'delegation_depth', 'parent_session'], 'v3 的三列必须是 append（列序不漂）');
        const row = store.getSession('session-v1');
        assert.equal(row.session_id, 'session-v1', '存量行必须原样保留');
        assert.equal(row.source_sha, 'sha-v1');
        assert.equal(row.origin, null, 'origin 默认 NULL（未知 ≠ subagent）');
        assert.equal(row.parent_session, null);
        assert.equal(row.delegation_depth, 0, 'delegation_depth 默认 0');
        // 三列可写可读（升级后的真实用法）
        store.updateSession('session-v1', { origin: 'subagent', delegation_depth: 2, parent_session: 'session-parent' });
        const updated = store.getSession('session-v1');
        assert.equal(updated.origin, 'subagent');
        assert.equal(updated.delegation_depth, 2);
        assert.equal(updated.parent_session, 'session-parent');
        // 未加 vault_class 列（class 是派生值，设计档 §19.7）
        assert.equal(columns.includes('vault_class'), false, '不得新增 vault_class 列');
        const tables = store.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
        assert.deepEqual(tables.filter((name) => name.startsWith('subagent')), [], '不得建任何子代理相关的表');
      } finally {
        store.close();
      }
    });
  });
}

test('A-P4-13：v2→v3 迁移失败 ⇒ 整体回滚、user_version 仍为 2、库可用（数据零改动）', async () => {
  // 制造冲突：v2 库里塞一个同名的 origin 列 ⇒ 第一条 ALTER 失败 ⇒ 整段事务回滚。
  await withSeededDatabase(2, async (dbPath) => {
    let failure = null;
    let opened = null;
    try {
      opened = await VaultStore.open(dbPath);
    } catch (err) {
      failure = err;
    }
    if (opened) opened.close();
    assert.ok(failure, '迁移失败必须拒绝打开（fail-closed，不假装升级成功）');
    assert.equal(failure.code, 'migration-failed');
    assert.equal(failure.userVersion, 2, '错误读数里必须带「版本未变」');
    assert.match(String(failure.message), /2→3/, '错误信息要点明失败的迁移段');
    assert.match(String(failure.message), /rollback|回滚/, '错误信息必须说明「已整体回滚」');
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 2, '版本不得被改动');
      const columns = raw.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name);
      assert.equal(columns.includes('delegation_depth'), false, '后续 ALTER 必须随事务回滚');
      assert.equal(columns.includes('parent_session'), false);
      assert.equal(raw.prepare("SELECT session_id FROM sessions WHERE session_id = 'session-v1'").get().session_id, 'session-v1');
    } finally {
      raw.close();
    }
  }, ['ALTER TABLE sessions ADD COLUMN origin TEXT']);
});

test('P1-3: 真实文件库可打开（父目录自动创建）', async () => {
  await withStore(async (store, dir) => {
    const info = await stat(path.join(dir, 'vault.db'));
    assert.ok(info.size > 0);
    const reopened = await VaultStore.open(path.join(dir, 'vault.db'));
    try {
      assert.equal(reopened.applicationId(), APPLICATION_ID);
      assert.equal(reopened.userVersion(), USER_VERSION);
    } finally {
      reopened.close();
    }
  }, { memory: false });
});
