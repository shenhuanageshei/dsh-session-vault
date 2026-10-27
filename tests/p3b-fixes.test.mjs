import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, rename } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { resolveVaultPaths, createConfigStore, WATERMARK_META_PREFIX } from '../lib/config.js';
import { VaultStore, USER_VERSION, APPLICATION_ID } from '../lib/store.js';
import {
  VaultEngine,
  projectKey,
  ERROR_STATES,
  TRASH_RETENTION_MS,
  TRASH_MARKER_PREFIX,
  DIAGNOSE_CHECKS,
  REPAIR_ACTIONS,
} from '../lib/engine.js';
import { VaultIndexer, RESULT_STATE_LABELS, WATERMARK_PREFIX } from '../lib/indexer.js';
import { createVaultApi, PREFIX, NOT_IMPLEMENTED, IMPLEMENTED } from '../lib/http.js';
import { Sweeper } from '../lib/sweeper.js';
import { hashTree } from '../lib/marker.js';
import { parseIntField } from '../lib/int-input.js';
import { windowRange, VIRTUAL_THRESHOLD, VIRTUAL_ROW_HEIGHT } from '../lib/virtual.js';

/**
 * P3b 测试（设计档 v0.3.10 §18）：收藏 / 回收站 / 诊断修复 / 窗口化 + schema 1→2。
 *
 * 锚：A-P3-3（收藏）/ A-P3-4（回收站 + hidden 不进候选）/ A-P3-5（诊断修复）/
 *     A-P3-6（窗口化，纯函数面；UI 面在 ui-contract）/ A-P3-7（purge 契约）/
 *     A-P3-8（schema 升级）/ A-P3-9（30 天只提示不自动删）。
 */

const quiet = { info() {}, warn() {}, error() {} };
const exists = (target) => stat(target).then(() => true).catch(() => false);

function frames(id, cwd, texts = {}) {
  let seq = 0;
  const next = () => { seq += 1; return seq; };
  return [
    JSON.stringify({ type: 'request/header', sessionId: id, cwd, createdAt: 1791000000000 }),
    JSON.stringify({ type: 'user/message', seq: next(), ts: 1791000001000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: texts.user || ('正文 ' + id) }] } }),
    JSON.stringify({ type: 'assistant/message', seq: next(), ts: 1791000002000, data: { message: { content: [{ type: 'text', text: texts.assistant || ('回复 ' + id) }] } } }),
    JSON.stringify({ type: 'session/title', seq: next(), ts: 1791000003000, data: { title: texts.title || ('标题 ' + id) } }),
  ];
}

async function createHarness(options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p3b-'));
  const paths = resolveVaultPaths(home);
  const cwd = '<workspace-root>\\p3b-demo';
  const pk = projectKey(cwd);
  const archived = new Set();
  const calls = { archive: [], unarchive: [] };
  const registry = {
    archivedSessionIds: archived,
    async archiveSession(id) { archived.add(String(id)); calls.archive.push(String(id)); },
    async unarchiveSession(id) { archived.delete(String(id)); calls.unarchive.push(String(id)); },
    async resolveByPath() { return undefined; },
  };
  const persistence = {
    async list() { return []; },
    async stat(sessionId) {
      const projects = await readdir(paths.sessionsRoot, { withFileTypes: true }).catch(() => []);
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        const dir = path.join(paths.sessionsRoot, project.name, sessionId);
        const files = await readdir(dir).catch(() => null);
        if (files && files.length) return { sizeBytes: 1, id: sessionId };
      }
      return undefined;
    },
  };
  const clock = { now: options.now || 1792000000000 };
  const configStore = createConfigStore({ home, paths });
  await configStore.save({ autoMigrate: false, archiveAgeDays: 14 });
  const writes = [];
  const store = await VaultStore.open(paths.dbPath);
  const makeEngine = (storeInstance) => new VaultEngine({
    home,
    paths,
    configStore,
    store: storeInstance,
    registry,
    persistence,
    logger: quiet,
    now: () => clock.now,
    isActive: async () => false,
    sameVolume: async () => true,
    detectAm: async () => ({ present: false, matches: [], sources: ['injected'] }),
    resolveWorkspace: async () => undefined,
    onWrite: async (record) => { writes.push(record); },
    logLimit: 0,
  });
  const engine = makeEngine(store);

  async function addSession(id, opts = {}) {
    const sessionCwd = opts.cwd || cwd;
    const dir = path.join(paths.sessionsRoot, pk, id);
    await mkdir(dir, { recursive: true });
    const name = opts.name || 'session.v4.jsonl.zstd';
    await writeFile(path.join(dir, name), Buffer.concat(frames(id, sessionCwd, opts.texts || {}).map((line) => zstdCompressSync(Buffer.from(line + '\n')))));
    return dir;
  }

  async function reopen() {
    store.close();
    const store2 = await VaultStore.open(paths.dbPath);
    const engine2 = makeEngine(store2);
    harness.store = store2;
    harness.engine = engine2;
    return { store: store2, engine: engine2 };
  }

  const harness = {
    home, paths, cwd, pk, archived, calls, registry, persistence, configStore, store, engine, clock, writes, reopen,
    addSession,
    hotDir: (id) => path.join(paths.sessionsRoot, pk, id),
    coldDir: (id) => path.join(paths.coldRootDefault, pk, id),
    trashDir: (id, ts) => path.join(paths.trashRoot, id, String(ts)),
    markerPath: (name) => path.join(paths.markerDir, name + '.json'),
    async manifestRecords() {
      try {
        const text = await readFile(paths.manifestPath, 'utf8');
        return text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line)) : [];
      } catch {
        return [];
      }
    },
    async dispose() {
      try { harness.store.close(); } catch { /* 已关闭 */ }
      await rm(home, { recursive: true, force: true });
    },
  };
  return harness;
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { res.statusCode = status; for (const [key, value] of Object.entries(headers || {})) res.headers[String(key).toLowerCase()] = value; },
    setHeader(key, value) { res.headers[String(key).toLowerCase()] = value; },
    end(chunk) { res.body = chunk ? Buffer.from(chunk).toString('utf8') : ''; },
  };
  return res;
}

function fakeReq({ url = PREFIX + '/status', body = '{}' } = {}) {
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.method = 'POST';
  req.url = url;
  req.headers = { host: '127.0.0.1:53210' };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

async function call(api, options) {
  const res = fakeRes();
  await api.handler(fakeReq(options), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* keep null */ }
  return { status: res.statusCode, json, text: res.body };
}

// ---------------------------------------------------------------------------
// A-P3-8：schema 1 → 2（事务内 ALTER + 建表；失败不改版本、库可用）
// ---------------------------------------------------------------------------

/** 手工造一个 v1 库（app_id = 本插件 + user_version = 1 + v1 schema），模拟升级前的存量安装。 */
async function seedV1Database(dbPath, { withConflictingTrash = false } = {}) {
  await mkdir(path.dirname(dbPath), { recursive: true });
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('PRAGMA application_id = ' + APPLICATION_ID);
    raw.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)");
    raw.exec(
      'CREATE TABLE sessions (' +
        "session_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, rel_dir TEXT NOT NULL, log_names TEXT NOT NULL," +
        "cold_root TEXT, format_version INTEGER NOT NULL, bytes INTEGER NOT NULL, file_size INTEGER NOT NULL," +
        "file_mtime_ms INTEGER NOT NULL, header_cwd TEXT, header_state TEXT NOT NULL DEFAULT 'ok'," +
        "created_at INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', archived_at INTEGER," +
        "backfilled INTEGER NOT NULL DEFAULT 0, moved_at INTEGER, restored_at INTEGER, status TEXT NOT NULL," +
        "favorite INTEGER NOT NULL DEFAULT 0, error TEXT, next_attempt INTEGER," +
        "user_msgs INTEGER NOT NULL DEFAULT 0, assistant_msgs INTEGER NOT NULL DEFAULT 0," +
        "first_user_text TEXT NOT NULL DEFAULT '', last_assistant_text TEXT NOT NULL DEFAULT ''," +
        'indexed_at INTEGER, source_sha TEXT NOT NULL)',
    );
    raw.exec(
      'CREATE TABLE docs (doc_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, seq INTEGER NOT NULL,' +
        "type TEXT NOT NULL, role TEXT NOT NULL, time INTEGER NOT NULL, surface TEXT NOT NULL DEFAULT 'current'," +
        'text TEXT NOT NULL, index_text TEXT NOT NULL)',
    );
    if (withConflictingTrash) {
      // 同名的**冲突表**：迁移里的 CREATE TABLE trash 会失败 ⇒ 触发 A-P3-8 的失败分支
      raw.exec('CREATE TABLE trash (whatever TEXT)');
      raw.exec("INSERT INTO trash (whatever) VALUES ('keep-me')");
    }
    raw.exec("INSERT INTO sessions (session_id, project_key, rel_dir, log_names, format_version, bytes, file_size, file_mtime_ms, created_at, status, source_sha) " +
      "VALUES ('session-v1', '--p--', '--p--/session-v1', 'session.v4.jsonl.zstd', 4, 11, 11, 42, 1, 'hot', 'sha-v1')");
    raw.exec('PRAGMA user_version = 1');
  } finally {
    raw.close();
  }
}

test('A-P3-8：user_version 1→2 升级成功 —— sessions 增 hidden 末列、trash 表建成、存量数据原样', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p3b-v1-'));
  const paths = resolveVaultPaths(home);
  try {
    await seedV1Database(paths.dbPath);
    const store = await VaultStore.open(paths.dbPath);
    try {
      // P4 起 schema 版本是 3（v2→v3 追加 header 事实三列，A-P4-13）；本条只验 1→2 段的 DDL 生效。
      assert.equal(store.userVersion(), USER_VERSION);
      const columns = store.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name);
      assert.deepEqual(
        columns.slice(-4),
        ['hidden', 'origin', 'delegation_depth', 'parent_session'],
        '追加列顺序恒定：hidden 之后才是 P4 的三列（ALTER TABLE ADD COLUMN 追加）',
      );
      assert.ok(columns.includes('hidden'));
      const tables = store.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
      assert.ok(tables.includes('trash'));
      const old = store.getSession('session-v1');
      assert.equal(old.session_id, 'session-v1', '存量行必须原样保留');
      assert.equal(old.hidden, 0, 'hidden 默认 0');
      assert.equal(store.trashCount(), 0);
    } finally {
      store.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('A-P3-8：建表失败 ⇒ 整体回滚、user_version 仍为 1、库可用（数据零改动）', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p3b-v1fail-'));
  const paths = resolveVaultPaths(home);
  try {
    await seedV1Database(paths.dbPath, { withConflictingTrash: true });
    let failure = null;
    let opened = null;
    try {
      opened = await VaultStore.open(paths.dbPath);
    } catch (err) {
      failure = err;
    }
    if (opened) opened.close();
    assert.ok(failure, '建表失败必须拒绝打开（fail-closed，不假装升级成功）');
    assert.equal(failure.code, 'migration-failed');
    assert.equal(failure.userVersion, 1, '错误读数里必须带「版本未变」');
    assert.match(String(failure.message), /1→2/, '错误信息要点明失败的迁移段');

    // 库本身仍然可用：版本 1、没有 hidden 列（ALTER 被回滚）、存量行与冲突表都原样
    const raw = new DatabaseSync(paths.dbPath, { readOnly: true });
    try {
      assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1);
      const columns = raw.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name);
      assert.equal(columns.includes('hidden'), false, 'ALTER TABLE 必须随事务回滚');
      assert.equal(raw.prepare("SELECT whatever FROM trash").get().whatever, 'keep-me', '冲突表原样保留');
      assert.equal(raw.prepare("SELECT session_id FROM sessions WHERE session_id = 'session-v1'").get().session_id, 'session-v1');
    } finally {
      raw.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A-P3-3：收藏（持久化 + 筛选 + 跨重启 + 默认排序）
// ---------------------------------------------------------------------------

test('A-P3-3：收藏持久化、favorite 过滤、默认排序「收藏优先」、跨重启仍在', async () => {
  const h = await createHarness();
  try {
    const a = 'session-fav-a';
    const b = 'session-fav-b';
    await h.addSession(a);
    await h.addSession(b);
    h.archived.add(a);
    h.archived.add(b);

    const favA = await h.engine.favorite(a, true);
    assert.equal(favA.ok, true);
    assert.equal(favA.favorite, 1, '没有 DB 行时也要按磁盘事实建行并置 favorite');
    assert.equal(h.store.getSession(a).favorite, 1);

    const all = await h.engine.list();
    const ids = all.items.map((item) => item.id);
    assert.equal(ids.indexOf(a) < ids.indexOf(b), true, '收藏必须排在前面（favorite DESC 优先于 lastActiveAt DESC）');
    assert.equal(all.items.find((item) => item.id === a).favorite, 1);
    assert.equal(all.stats.favorites, 1);

    const onlyFav = await h.engine.list({ favorite: true });
    assert.deepEqual(onlyFav.items.map((item) => item.id), [a], 'favorite:true 只列收藏');
    const noFav = await h.engine.list({ favorite: false });
    assert.equal(noFav.items.some((item) => item.id === a), false, 'favorite:false 只列未收藏');

    // 取消收藏
    const off = await h.engine.favorite(a, false);
    assert.equal(off.favorite, 0);
    assert.equal(h.store.getSession(a).favorite, 0);

    // 跨重启：重新打开库 + 新建引擎，收藏仍在（写的是 DB，不是内存）
    await h.engine.favorite(b, true);
    const reopened = await h.reopen();
    assert.equal(reopened.store.getSession(b).favorite, 1, '收藏必须落库（跨重启可见）');
    const list2 = await reopened.engine.list({ favorite: true });
    assert.deepEqual(list2.items.map((item) => item.id), [b]);
  } finally {
    await h.dispose();
  }
});

test('A-P3-3（HTTP）：/favorite 只接受严格布尔；/list 支持 favorite 过滤', async () => {
  const h = await createHarness();
  try {
    const id = 'session-http-fav';
    await h.addSession(id);
    h.archived.add(id);
    const api = createVaultApi({ home: h.home, configStore: h.configStore, getEngine: async () => h.engine });
    const bad = await call(api, { url: PREFIX + '/favorite', body: JSON.stringify({ id, favorite: 'yes' }) });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'invalid-request');
    assert.equal(h.store.getSession(id), null, '非法请求不得建行/写库');

    const ok = await call(api, { url: PREFIX + '/favorite', body: JSON.stringify({ id, favorite: true }) });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.favorite, 1);
    const list = await call(api, { url: PREFIX + '/list', body: JSON.stringify({ filter: { favorite: true } }) });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.items.map((item) => item.id), [id]);

    const missing = await call(api, { url: PREFIX + '/favorite', body: JSON.stringify({ favorite: true }) });
    assert.equal(missing.status, 400, '缺 id ⇒ 400');
    const badShape = await call(api, { url: PREFIX + '/favorite', body: JSON.stringify({ id: '../evil', favorite: true }) });
    assert.equal(badShape.status, 400, 'id 形状必须过 assertSessionId');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// A-P3-4：回收站（冷删除 / 恢复 / 热删除 / hidden 不进候选、不被迁移）
// ---------------------------------------------------------------------------

test('A-P3-4：冷删除 ⇒ 文件只在 trash、sessions 行删除、trash 行含 sha256/row_json/expires_at；恢复逐字节一致', async () => {
  const h = await createHarness();
  try {
    const id = 'session-cold-del';
    await h.addSession(id);
    h.archived.add(id);
    await h.engine.favorite(id, true);
    const migrated = await h.engine.migrate(id);
    assert.equal(migrated.ok, true, JSON.stringify(migrated));
    assert.equal(h.store.getSession(id).status, 'cold');

    const coldDir = h.coldDir(id);
    const baseline = await hashTree(coldDir);
    assert.equal(await exists(coldDir), true);

    const del = await h.engine.deleteSession(id);
    assert.equal(del.ok, true, JSON.stringify(del));
    assert.equal(del.status, 'trash');
    assert.equal(del.sha256, baseline.sha256);
    assert.equal(await exists(coldDir), false, '冷目录必须不在原处（文件只应在 trash）');
    assert.equal(await exists(h.hotDir(id)), false, '热目录也不该出现');

    const trashRow = h.store.getTrashRow(id);
    assert.ok(trashRow, 'trash 表必须有一行');
    assert.equal(trashRow.sha256, baseline.sha256, 'sha256 = 搬移前的全树基线');
    assert.equal(trashRow.size_bytes, baseline.bytes);
    assert.equal(trashRow.favorite, 1, 'favorite 必须带进回收站');
    const snapshot = JSON.parse(trashRow.row_json);
    assert.equal(snapshot.session_id, id, 'row_json = sessions 整行快照');
    assert.equal(trashRow.expires_at - trashRow.trashed_at, TRASH_RETENTION_MS, 'expires_at = trashed_at + 30 天');
    assert.equal(h.store.getSession(id), null, 'sessions 行必须删除（同一事务）');
    assert.equal(await exists(h.trashDir(id, trashRow.trashed_at)), true, '文件必须在 <vaultRoot>/trash/<id>/<ts>/');
    assert.equal(await exists(h.markerPath(TRASH_MARKER_PREFIX + id)), false, '成功后 marker 必须删掉');
    const ops = (await h.manifestRecords()).map((record) => record.op);
    assert.ok(ops.includes('trash'), 'manifest 必须有 op:trash');

    const restored = await h.engine.trashRestore(id);
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.status, 'cold');
    assert.equal(restored.sha256, baseline.sha256);
    assert.equal(restored.favorite, 1, '还原必须保留 favorite');
    const after = await hashTree(coldDir);
    assert.deepEqual(after.files, baseline.files, '恢复必须逐文件逐字节一致（trash.sha256 校验通过）');
    assert.equal(after.sha256, baseline.sha256);
    const row = h.store.getSession(id);
    assert.equal(row.status, 'cold');
    assert.equal(row.hidden, 0);
    assert.equal(row.favorite, 1);
    assert.equal(h.store.getTrashRow(id), null, '还原后 trash 行必须删掉');
    const ops2 = (await h.manifestRecords()).map((record) => record.op);
    assert.ok(ops2.includes('trash-restore'));
  } finally {
    await h.dispose();
  }
});

test('A-P3-4：热删除只置 hidden=1（文件零改动）；hidden 不进清扫候选、被直接迁移也拒绝', async () => {
  const h = await createHarness();
  try {
    const hiddenId = 'session-hot-hidden';
    const controlId = 'session-hot-control';
    await h.addSession(hiddenId);
    await h.addSession(controlId);
    h.archived.add(hiddenId);
    h.archived.add(controlId);
    const dir = h.hotDir(hiddenId);
    const before = {
      names: (await readdir(dir)).sort(),
      bytes: await readFile(path.join(dir, 'session.v4.jsonl.zstd')),
    };
    const del = await h.engine.deleteSession(hiddenId);
    assert.equal(del.ok, true, JSON.stringify(del));
    assert.equal(del.status, 'hidden');
    assert.equal(del.filesUntouched, true);
    const after = {
      names: (await readdir(dir)).sort(),
      bytes: await readFile(path.join(dir, 'session.v4.jsonl.zstd')),
    };
    assert.deepEqual(after.names, before.names, '热删除不得改动 sessions 目录');
    assert.deepEqual(after.bytes, before.bytes, '热删除不得改动任何字节');
    assert.equal(h.store.getSession(hiddenId).hidden, 1);
    assert.ok((await h.manifestRecords()).some((record) => record.op === 'hide'), 'manifest 必须有 op:hide');

    // 让「已归档 + 闲置 30 天」的条件成立（否则候选为空，负向断言会白白通过）。
    // 对照组必须先建行（favorite 会在没有 DB 行时按磁盘事实建行），否则 updateSession 是 0 行更新。
    await h.engine.favorite(controlId, false);
    const old = h.clock.now - 30 * 86400000;
    h.store.updateSession(hiddenId, { file_mtime_ms: old, created_at: old });
    h.store.updateSession(controlId, { file_mtime_ms: old, created_at: old });
    const candidates = await h.engine.allCandidates({ respectAutoMigrate: false, useCache: false });
    const candidateIds = candidates.map((row) => row.session_id);
    assert.equal(candidateIds.includes(controlId), true, '对照组（未隐藏、闲置 30 天）必须进候选');
    assert.equal(candidateIds.includes(hiddenId), false, 'hidden=1 绝不进清扫候选（I-13 / A-P3-4）');

    // 直接点迁移也必须 fail-closed
    const refused = await h.engine.migrate(hiddenId);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'hidden');
    assert.equal(await exists(h.coldDir(hiddenId)), false);

    // 还原：hidden=0（文件仍零改动），随后才可能再被归档/迁移
    const back = await h.engine.trashRestore(hiddenId);
    assert.equal(back.ok, true);
    assert.equal(back.hidden, 0);
    assert.equal(h.store.getSession(hiddenId).hidden, 0);
    assert.ok((await h.manifestRecords()).some((record) => record.op === 'unhide'));
  } finally {
    await h.dispose();
  }
});

test('A-P3-4：Sweeper 一轮清扫不会搬走 hidden=1 的归档会话', async () => {
  const h = await createHarness();
  try {
    await h.configStore.save({ autoMigrate: true, archiveAgeDays: 14 });
    const hiddenId = 'session-sweep-hidden';
    await h.addSession(hiddenId);
    h.archived.add(hiddenId);
    const old = h.clock.now - 40 * 86400000;
    await h.engine.favorite(hiddenId, false);
    h.store.updateSession(hiddenId, { file_mtime_ms: old, created_at: old, hidden: 1 });

    const sweeper = new Sweeper({ engine: h.engine, ctx: null, logger: quiet });
    h.engine.sweeper = sweeper;
    const report = await sweeper.sweep({ now: h.clock.now });
    const resultIds = (report.results || []).map((row) => row.id);
    assert.equal(resultIds.includes(hiddenId), false, 'hidden 会话不得出现在清扫结果里');
    assert.equal(await exists(h.coldDir(hiddenId)), false, 'hidden 会话的文件不得被搬走');
    assert.equal(h.store.getSession(hiddenId).hidden, 1, 'hidden 标记不得被清扫改动');
    assert.equal(h.store.getSession(hiddenId).status, 'hot');
  } finally {
    await h.dispose();
  }
});


test('A-P3-4：跨卷删除 —— copy+基线校验通过才删源；校验失败 ⇒ 源完整保留、回滚为 cold', async () => {
  const h = await createHarness();
  try {
    const id = 'session-cross-volume';
    await h.addSession(id);
    h.archived.add(id);
    await h.engine.migrate(id);
    const coldDir = h.coldDir(id);
    const baseline = await hashTree(coldDir);

    // ① 正常跨卷：copy → 校验 → 删源
    h.engine.deps.sameVolume = async () => false;
    const del = await h.engine.deleteSession(id);
    assert.equal(del.ok, true, JSON.stringify(del));
    assert.equal(await exists(coldDir), false, '校验通过后源才允许删除');
    const trashRow = h.store.getTrashRow(id);
    assert.equal((await hashTree(h.trashDir(id, trashRow.trashed_at))).sha256, baseline.sha256);

    // ② 跨卷拷坏（copy 实现写坏字节）⇒ 基线校验失败 ⇒ 不删源、行回 cold
    await h.engine.trashRestore(id);
    const coldDir2 = h.coldDir(id);
    assert.equal((await hashTree(coldDir2)).sha256, baseline.sha256, '还原后仍是同一份内容');
    const realCopy = h.engine.copyFileImpl;
    h.engine.copyFileImpl = async (from, to) => {
      await realCopy(from, to);
      const { appendFile } = await import('node:fs/promises');
      await appendFile(to, Buffer.from('corrupted'));
    };
    const failed = await h.engine.deleteSession(id);
    h.engine.copyFileImpl = realCopy;
    assert.equal(failed.ok, false);
    assert.equal(failed.rolledBack, true);
    assert.equal((await hashTree(coldDir2)).sha256, baseline.sha256, '失败时源一个字节都不许丢');
    assert.equal(h.store.getSession(id).status, 'cold', '失败必须回滚为 cold，可重试');
    assert.match(String(h.store.getSession(id).error), /trash-failed/);
    assert.equal(h.store.getTrashRow(id), null);
    const leftovers = await readdir(path.join(h.paths.trashRoot, id)).catch(() => []);
    assert.deepEqual(leftovers, [], '失败不得留下回收站残留（副本与 .partial 都要清掉）');
    assert.equal(await exists(h.markerPath(TRASH_MARKER_PREFIX + id)), false, '失败必须删 marker');
  } finally {
    await h.dispose();
  }
});

test('A-P3-4：还原前基线校验不通过 ⇒ needs-review（不搬、不删、trash 行保留）', async () => {
  const h = await createHarness();
  try {
    const id = 'session-restore-tampered';
    await h.addSession(id);
    h.archived.add(id);
    await h.engine.migrate(id);
    const del = await h.engine.deleteSession(id);
    assert.equal(del.ok, true, JSON.stringify(del));
    const trashRow = h.store.getTrashRow(id);
    const trashDir = h.trashDir(id, trashRow.trashed_at);
    // 篡改回收站副本（模拟盘上损坏/被人手工改过）
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path.join(trashDir, 'session.v4.jsonl.zstd'), Buffer.from('tampered'));
    const restored = await h.engine.trashRestore(id);
    assert.equal(restored.ok, false);
    assert.equal(restored.code, ERROR_STATES.NEEDS_REVIEW);
    assert.equal(await exists(h.trashDir(id, trashRow.trashed_at)), true, '校验不通过时不得搬移/删除回收站副本');
    assert.ok(h.store.getTrashRow(id), 'trash 行保留（人工处置）');
    assert.equal(await exists(h.coldDir(id)), false, '不得把坏副本搬回冷目录');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// A-P3-7：purge 契约（无 confirm 零写入；目标必须在 trash 根内）
// ---------------------------------------------------------------------------

test('A-P3-7：purge 无 confirm 零写入；越界目标拒绝；confirm 后 trash 行与目录都消失', async () => {
  const h = await createHarness();
  try {
    const id = 'session-purge';
    await h.addSession(id);
    h.archived.add(id);
    await h.engine.migrate(id);
    const del = await h.engine.deleteSession(id);
    assert.equal(del.ok, true, JSON.stringify(del));
    const trashRow = h.store.getTrashRow(id);
    const trashDir = h.trashDir(id, trashRow.trashed_at);
    assert.equal(await exists(trashDir), true);

    const manifestBefore = (await h.manifestRecords()).length;
    const fsBefore = h.engine.getFsLog().length;
    const refused = await h.engine.trashPurge(id, {});
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'confirm-required');
    assert.equal(refused.writes, 0);
    assert.equal(await exists(trashDir), true, '无 confirm ⇒ 文件必须还在');
    assert.ok(h.store.getTrashRow(id), '无 confirm ⇒ trash 行必须还在');
    assert.equal(h.engine.getFsLog().length, fsBefore, '无 confirm ⇒ 一个 fs 写/删都不许发生');
    assert.equal((await h.manifestRecords()).length, manifestBefore, '无 confirm ⇒ manifest 不得有新行');

    // 越界：trash 行存在但目标 resolve 后不在 trash 根内（'..' ⇒ <vaultRoot>）
    h.store.trashSession({ session_id: '..', sha256: 'x', size_bytes: 0, row_json: '{}', cold_root: null, rel_dir: '../..', trashed_at: 1, expires_at: 2 });
    const outside = await h.engine.trashPurge('..', { confirm: true });
    assert.equal(outside.ok, false);
    assert.equal(outside.code, 'outside-trash-root');
    assert.equal(outside.writes, 0);
    assert.equal(await exists(h.paths.vaultRoot), true, '越界目标必须一个字节都不删');
    h.store.deleteTrash('..');

    const purged = await h.engine.trashPurge(id, { confirm: true });
    assert.equal(purged.ok, true, JSON.stringify(purged));
    assert.equal(purged.removed, true);
    assert.equal(await exists(trashDir), false, 'confirm 后目录必须删除');
    assert.equal(h.store.getTrashRow(id), null, 'confirm 后 trash 行必须消失');
    assert.ok((await h.manifestRecords()).some((record) => record.op === 'purge'));
  } finally {
    await h.dispose();
  }
});


test('§18.7：还原时双份（回收站 + 冷目录都在）—— 冷侧过基线 ⇒ 清回收站副本并补 DB 行', async () => {
  const h = await createHarness();
  try {
    const id = 'session-restore-dupe';
    await h.addSession(id);
    h.archived.add(id);
    await h.engine.migrate(id);
    const baseline = await hashTree(h.coldDir(id));
    const del = await h.engine.deleteSession(id);
    assert.equal(del.ok, true, JSON.stringify(del));
    const trashRow = h.store.getTrashRow(id);
    const trashDir = h.trashDir(id, trashRow.trashed_at);
    // 模拟「文件已拷回冷目录、DB 还没写」的崩溃现场（回收站副本仍在）
    const { cp } = await import('node:fs/promises');
    await cp(trashDir, h.coldDir(id), { recursive: true });
    assert.equal(await exists(trashDir), true);
    assert.equal(await exists(h.coldDir(id)), true);

    const restored = await h.engine.trashRestore(id);
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.status, 'cold');
    assert.equal((await hashTree(h.coldDir(id))).sha256, baseline.sha256);
    assert.equal(await exists(trashDir), false, '冷侧已通过基线 ⇒ 才允许清掉回收站副本');
    assert.equal(h.store.getTrashRow(id), null);
    assert.equal(h.store.getSession(id).status, 'cold');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// A-P3-9：30 天到期只提示，绝不自动删
// ---------------------------------------------------------------------------

test('A-P3-9：到期只提示（trashList 标 expired）；启动收敛与清扫都不删回收站', async () => {
  const h = await createHarness();
  try {
    const id = 'session-expire';
    await h.addSession(id);
    h.archived.add(id);
    await h.engine.migrate(id);
    const del = await h.engine.deleteSession(id);
    assert.equal(del.ok, true, JSON.stringify(del));
    const trashRow = h.store.getTrashRow(id);
    const trashDir = h.trashDir(id, trashRow.trashed_at);

    // 31 天后：到期读数可见，但文件一个都不动
    h.clock.now = trashRow.trashed_at + TRASH_RETENTION_MS + 86400000;
    const fsBefore = h.engine.getFsLog().length;
    const list = h.engine.trashList();
    assert.equal(list.expiredCount, 1, '到期必须被如实标出来');
    assert.equal(list.items[0].expired, true);
    assert.equal(list.items[0].expiresInDays < 0, true);
    assert.match(String(list.note), /不会.*自动删除/);

    const diag = await h.engine.diagnose();
    assert.equal(diag.trash.expired, 1, '诊断面也要看到到期读数');
    // 只读面零写：trashList / diagnose 不得产生任何 fs 写/删
    assert.equal(h.engine.getFsLog().length, fsBefore, '到期判定与诊断都必须是只读');

    // 启动收敛与清扫：不得清空回收站
    await h.engine.recoverOnBoot();
    await h.configStore.save({ autoMigrate: true, archiveAgeDays: 14 });
    const sweeper = new Sweeper({ engine: h.engine, ctx: null, logger: quiet });
    await sweeper.sweep({ now: h.clock.now });
    assert.equal(await exists(trashDir), true, '到期不等于删除：文件必须还在');
    assert.ok(h.store.getTrashRow(id), 'trash 行必须还在');
    assert.equal(h.engine.getFsLog().filter((record) => record.kind === 'rm').length, 0, '全程不得出现任何 rm');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// §18.7：trash 在途 marker 的启动收敛
// ---------------------------------------------------------------------------

test('§18.7：trash marker 收敛 —— 文件已到回收站则补完尾段（源/目标二选一，不删源）', async () => {
  const h = await createHarness();
  try {
    const id = 'session-trash-crash';
    await h.addSession(id);
    h.archived.add(id);
    await h.engine.migrate(id);
    const coldDir = h.coldDir(id);
    const baseline = await hashTree(coldDir);
    const row = h.store.getSession(id);
    const dst = path.join(h.paths.trashRoot, id, '1792000000000');
    await mkdir(path.dirname(dst), { recursive: true });
    await rename(coldDir, dst);
    h.store.updateSession(id, { status: 'trash' });
    await h.engine.markers.write(TRASH_MARKER_PREFIX + id, {
      op: 'trash',
      sessionId: id,
      src: coldDir,
      dst,
      coldRoot: h.paths.coldRootDefault,
      relDir: row.rel_dir,
      sha256: baseline.sha256,
      files: baseline.files,
      bytes: baseline.bytes,
      trashedAt: 1792000000000,
      expiresAt: 1792000000000 + TRASH_RETENTION_MS,
      rowJson: JSON.stringify(row),
      reason: 'test-crash',
    });

    const report = await h.engine.recoverOnBoot();
    assert.equal(report.counts.resumedTrash, 1, JSON.stringify(report.counts));
    assert.equal(h.store.getSession(id), null, '尾段必须补完：sessions 行删除');
    const trashRow = h.store.getTrashRow(id);
    assert.ok(trashRow, 'trash 行必须补写');
    assert.equal(trashRow.sha256, baseline.sha256);
    assert.equal(await exists(dst), true, '回收站副本必须保留（不删源）');
    assert.equal(await exists(h.markerPath(TRASH_MARKER_PREFIX + id)), false, '收敛后 marker 必须删掉');
    assert.ok((await h.manifestRecords()).some((record) => record.op === 'trash'));
  } finally {
    await h.dispose();
  }
});

test('§18.7：trash marker 收敛 —— 还没搬成（源在、目标无）⇒ 撤销在途状态、删 marker、源原样', async () => {
  const h = await createHarness();
  try {
    const id = 'session-trash-abort';
    await h.addSession(id);
    h.archived.add(id);
    await h.engine.migrate(id);
    const coldDir = h.coldDir(id);
    const baseline = await hashTree(coldDir);
    const row = h.store.getSession(id);
    const dst = path.join(h.paths.trashRoot, id, '1792000000000');
    h.store.updateSession(id, { status: 'trash' });
    await h.engine.markers.write(TRASH_MARKER_PREFIX + id, {
      op: 'trash',
      sessionId: id,
      src: coldDir,
      dst,
      coldRoot: h.paths.coldRootDefault,
      relDir: row.rel_dir,
      sha256: baseline.sha256,
      files: baseline.files,
      bytes: baseline.bytes,
      trashedAt: 1792000000000,
      expiresAt: 1792000000000 + TRASH_RETENTION_MS,
      rowJson: JSON.stringify(row),
      reason: 'test-crash',
    });
    const report = await h.engine.recoverOnBoot();
    assert.equal(report.counts.trashAborted, 1, JSON.stringify(report.counts));
    const after = h.store.getSession(id);
    assert.equal(after.status, 'cold', '源还在 ⇒ 行回 cold，可重试');
    assert.equal((await hashTree(coldDir)).sha256, baseline.sha256, '源一个字节都不许动');
    assert.equal(await exists(h.markerPath(TRASH_MARKER_PREFIX + id)), false);
    assert.equal(h.store.getTrashRow(id), null, '不得写 trash 行');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// A-P3-5：诊断（只读）与修复（dry-run 零写入 / apply 逐项 / 幂等 / fail-closed）
// ---------------------------------------------------------------------------

test('A-P3-5：/diagnose 三类对账只读；/repair dry-run 零写入、apply 逐项生效、重跑幂等、失败即停', async () => {
  const h = await createHarness();
  try {
    const coldRoot = h.paths.coldRootDefault;
    // ① row-cold-no-dir（同时是 db-no-manifest：这行没有 migrate/restore/repair 记录）
    h.store.upsertSession({
      session_id: 'session-lost-row',
      project_key: h.pk,
      rel_dir: h.pk + '/session-lost-row',
      log_names: 'session.v4.jsonl.zstd',
      cold_root: coldRoot,
      format_version: 4,
      bytes: 10,
      file_size: 10,
      file_mtime_ms: 10,
      header_cwd: h.cwd,
      created_at: 10,
      status: 'cold',
      source_sha: 'sha-lost',
    });
    // ② cold-dir-no-row（冷目录在盘、DB 无行）
    const orphanId = 'session-orphan-cold';
    const orphanDir = path.join(coldRoot, h.pk, orphanId);
    await mkdir(orphanDir, { recursive: true });
    await writeFile(path.join(orphanDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames(orphanId, h.cwd).map((line) => zstdCompressSync(Buffer.from(line + '\n')))));
    // ③ marker-no-row
    await h.engine.markers.write('session-ghost-marker', { op: 'migrate', src: 'x', dst: 'y' });
    // ④ manifest-no-db
    await h.engine.manifest.append({ ts: 1, op: 'migrate', id: 'session-nowhere', movedAt: 1 });

    const manifestBefore = await readFile(h.paths.manifestPath, 'utf8');
    const fsBefore = h.engine.getFsLog().length;
    const diag = await h.engine.diagnose();
    const checks = diag.items.map((item) => item.check);
    for (const check of ['row-cold-no-dir', 'cold-dir-no-row', 'marker-no-row', 'manifest-no-db', 'db-no-manifest']) {
      assert.equal(checks.includes(check), true, '诊断必须报出 ' + check + '：' + JSON.stringify(checks));
    }
    assert.equal(diag.readonly, true);
    for (const item of diag.items) assert.equal(DIAGNOSE_CHECKS.includes(item.check), true, '检查项必须来自封闭集');
    // 只读：manifest 字节不变、没有任何 fs 写/删
    assert.equal(await readFile(h.paths.manifestPath, 'utf8'), manifestBefore, '诊断不得写 manifest');
    assert.equal(h.engine.getFsLog().length, fsBefore, '诊断不得产生任何 fs 写/删');
    assert.equal(diag.scan.truncated, false);

    const wanted = [
      'row-cold-no-dir:session-lost-row',
      'cold-dir-no-row:' + orphanId,
      'marker-no-row:session-ghost-marker',
      'manifest-no-db:session-nowhere',
    ];
    const dry = await h.engine.repair({ checks: wanted, apply: false });
    assert.equal(dry.ok, true);
    assert.equal(dry.apply, false);
    assert.equal(dry.writes, 0, 'dry-run 必须零写入');
    assert.equal(dry.planned.length, 4);
    assert.equal(await readFile(h.paths.manifestPath, 'utf8'), manifestBefore, 'dry-run 不得写 manifest');
    assert.equal(h.engine.getFsLog().length, fsBefore, 'dry-run 不得产生 fs 写/删');
    assert.equal(h.store.getSession('session-lost-row').error, null, 'dry-run 不得改行');

    const applied = await h.engine.repair({ checks: wanted, apply: true });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.applied.length, 4);
    for (const entry of applied.applied) assert.equal(REPAIR_ACTIONS.includes(entry.action), true, '修复动作必须来自封闭集');
    // 效果
    assert.equal(h.store.getSession('session-lost-row').error, ERROR_STATES.NEEDS_REVIEW);
    const imported = h.store.getSession(orphanId);
    assert.ok(imported, '冷目录必须被导入成 cold 行');
    assert.equal(imported.status, 'cold');
    assert.equal(imported.cold_root, coldRoot);
    assert.equal(await exists(h.markerPath('session-ghost-marker')), false, '孤立 marker 必须被清掉');
    const records = await h.manifestRecords();
    assert.equal(
      records.some((record) => record.id === 'session-nowhere' && (record.op === 'migrate' || record.op === 'restore')),
      false,
      'manifest 里该 id 的 migrate/restore 行必须删掉（修复自身的 op:repair 审计行保留）',
    );
    const repairs = records.filter((record) => record.op === 'repair' && record.check);
    assert.ok(repairs.length >= 4, '每一项都要有一条 op:repair 审计行');
    assert.equal(repairs.every((record) => DIAGNOSE_CHECKS.includes(record.check)), true);

    // 幂等：重跑同一批 checks ⇒ 什么都不做（fixed / nothing-to-repair，而不是报错）
    const again = await h.engine.repair({ checks: wanted, apply: true });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.applied.length, 0, '重跑必须幂等（0 项）');
    assert.ok(again.skipped.length >= 1);

    // 未知检查项 ⇒ 明确拒绝（不静默）
    await assert.rejects(
      () => h.engine.repair({ checks: ['nope-not-a-check'], apply: false }),
      (err) => err && err.code === 'invalid-check',
    );

    // fail-closed：reindex 项但目录不存在 ⇒ 该项失败并停下（ok:false + failed）
    h.store.upsertSession({
      session_id: 'session-broken-index',
      project_key: h.pk,
      rel_dir: h.pk + '/session-broken-index',
      log_names: 'session.v4.jsonl.zstd',
      format_version: 4,
      bytes: 1,
      file_size: 1,
      file_mtime_ms: 1,
      header_cwd: h.cwd,
      created_at: 1,
      status: 'hot',
      error: ERROR_STATES.INDEX_FAILED,
      source_sha: 'sha-broken',
    });
    const failed = await h.engine.repair({ checks: ['index-failed:session-broken-index'], apply: true });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'repair-failed');
    assert.equal(failed.failed.id, 'index-failed:session-broken-index');
    assert.match(String(failed.error), /失败/);
  } finally {
    await h.dispose();
  }
});

test('A-P3-5：/diagnose 与 /repair 的 HTTP 契约（dry-run 默认零写入、apply 严格 true、未知项 400）', async () => {
  const h = await createHarness();
  try {
    h.store.upsertSession({
      session_id: 'session-http-lost',
      project_key: h.pk,
      rel_dir: h.pk + '/session-http-lost',
      log_names: 'session.v4.jsonl.zstd',
      cold_root: h.paths.coldRootDefault,
      format_version: 4,
      bytes: 1,
      file_size: 1,
      file_mtime_ms: 1,
      header_cwd: h.cwd,
      created_at: 1,
      status: 'cold',
      source_sha: 'sha-x',
    });
    const api = createVaultApi({ home: h.home, configStore: h.configStore, getEngine: async () => h.engine });
    const diag = await call(api, { url: PREFIX + '/diagnose', body: '{}' });
    assert.equal(diag.status, 200);
    assert.equal(diag.json.readonly, true);
    assert.ok(diag.json.items.some((item) => item.check === 'row-cold-no-dir'));

    const dry = await call(api, { url: PREFIX + '/repair', body: JSON.stringify({ checks: ['row-cold-no-dir:session-http-lost'] }) });
    assert.equal(dry.status, 200);
    assert.equal(dry.json.apply, false);
    assert.equal(dry.json.writes, 0);

    // apply 只认严格 true：'true' 字符串 ⇒ 仍然 dry-run（安全方向失败）
    const stringy = await call(api, { url: PREFIX + '/repair', body: JSON.stringify({ checks: ['row-cold-no-dir:session-http-lost'], apply: 'true' }) });
    assert.equal(stringy.json.apply, false);
    assert.equal(stringy.json.writes, 0);

    const badChecks = await call(api, { url: PREFIX + '/repair', body: JSON.stringify({ checks: [1, 2], apply: true }) });
    assert.equal(badChecks.status, 400);
    const unknown = await call(api, { url: PREFIX + '/repair', body: JSON.stringify({ checks: ['nope'], apply: true }) });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.code, 'invalid-check');

    const applied = await call(api, { url: PREFIX + '/repair', body: JSON.stringify({ checks: ['row-cold-no-dir:session-http-lost'], apply: true }) });
    assert.equal(applied.status, 200);
    assert.equal(applied.json.writes, 1);
    assert.equal(h.store.getSession('session-http-lost').error, ERROR_STATES.NEEDS_REVIEW);
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// 评审遗留 🔵：manifest 补齐判据唯一化 / status 兜底字段 / indexer trash 状态 / 数字输入
// ---------------------------------------------------------------------------

test('🔵 /status.stats 引擎不可用时也是完整形状（autoMigrate 与配置+阈值同口径、archiveAgeDays 等）', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p3b-status-'));
  const paths = resolveVaultPaths(home);
  const configStore = createConfigStore({ home, paths });
  try {
    await configStore.save({ archiveAgeDays: 0, autoMigrate: true, dailyBudgetCount: 7 });
    const api = createVaultApi({ home, configStore, getEngine: async () => null });
    const status = await call(api, { url: PREFIX + '/status', body: '{}' });
    assert.equal(status.status, 200);
    const stats = status.json.stats;
    assert.equal(stats.archiveAgeDays, 0, '阈值 0 必须原样（不是 undefined、也不是默认 14）');
    assert.equal(stats.dailyBudgetCount, 7);
    assert.equal(stats.autoMigrate, false, 'autoMigrate 与「配置 AND 阈值>0」同口径（阈值 0 ⇒ 关）');
    for (const key of ['favorites', 'hidden', 'trash', 'pendingCount', 'pendingBytes', 'candidatesCapped', 'markers', 'hotRestored']) {
      assert.equal(Object.prototype.hasOwnProperty.call(stats, key), true, '兜底 stats 必须带 ' + key);
    }
    // 阈值恢复成非 0 后同口径应为 true
    await configStore.save({ archiveAgeDays: 14, autoMigrate: true });
    const status2 = await call(api, { url: PREFIX + '/status', body: '{}' });
    assert.equal(status2.json.stats.autoMigrate, true);
    assert.equal(status2.json.stats.archiveAgeDays, 14);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('🔵 indexer 搜索分组 state 映射补 trash（与 RESULT_STATE_LABELS 同文案）', async () => {
  const h = await createHarness();
  try {
    assert.equal(RESULT_STATE_LABELS.trash, '回收站');
    // 造一条 status=trash 的行 + docs（在途/历史行）：分组必须标 trash，而不是 hot
    h.store.upsertSession({
      session_id: 'session-trash-state',
      project_key: h.pk,
      rel_dir: h.pk + '/session-trash-state',
      log_names: 'session.v4.jsonl.zstd',
      cold_root: h.paths.coldRootDefault,
      format_version: 4,
      bytes: 1,
      file_size: 1,
      file_mtime_ms: 1,
      header_cwd: h.cwd,
      created_at: 1,
      status: 'trash',
      source_sha: 'sha-t',
    });
    const { buildIndexText } = await import('../lib/tokenize.js');
    h.store.replaceDocs('session-trash-state', [
      { seq: 1, type: 'user', role: 'user', time: 1, text: '回收站里的命中词', index_text: buildIndexText('回收站里的命中词') },
    ]);
    const indexer = new VaultIndexer({ engine: h.engine, store: h.store, paths: h.paths, logger: quiet });
    const result = await indexer.search('回收站里的命中词');
    assert.equal(result.groups.length, 1, JSON.stringify(result.groups));
    assert.equal(result.groups[0].state, 'trash');
    assert.equal(result.groups[0].statusLabel, '回收站');
  } finally {
    await h.dispose();
  }
});

test('🔵 设置页数字输入：空串/非法值不转 0（保留旧值），合法值才写', () => {
  // 空串（旧实现 Number('') === 0 ⇒ 静默关闭自动迁移 / 预算）
  const empty = parseIntField('', { min: 0, max: 3650, fallback: 14, label: '自动迁移阈值' });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty');
  assert.match(String(empty.message), /保留原值 14/);
  assert.equal(parseIntField('   ', { fallback: 14 }).reason, 'empty');
  assert.equal(parseIntField(null, { fallback: 14 }).reason, 'empty');
  assert.equal(parseIntField(undefined, { fallback: 14 }).reason, 'empty');
  // 非整数 / 小数 / 指数 / 带加号
  for (const raw of ['abc', '1.5', '1e3', '+3', '3 4']) {
    const parsed = parseIntField(raw, { min: 0, max: 10, fallback: 5 });
    assert.equal(parsed.ok, false, raw + ' 必须被拒绝');
    assert.equal(parsed.reason, 'not-integer');
  }
  // 越界
  assert.equal(parseIntField('11', { min: 0, max: 10 }).reason, 'out-of-range');
  assert.equal(parseIntField('-1', { min: 0, max: 10 }).reason, 'out-of-range');
  // 合法值（含 0：0 是合法阈值，只是**不能**由空串推导出来）
  assert.deepEqual(parseIntField('0', { min: 0, max: 3650 }), { ok: true, value: 0 });
  assert.deepEqual(parseIntField(' 14 ', { min: 0, max: 3650 }), { ok: true, value: 14 });
});

test('🔵 设置页/面板源码契约：数字输入走 parseIntField（不再 Number(event.target.value)）', async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const settings = await readFile(path.join(root, 'src', 'ui', 'settings.tsx'), 'utf8');
  const client = await readFile(path.join(root, 'lib', 'client.js'), 'utf8');
  for (const text of [settings, client]) {
    assert.match(text, /function numberInput\(field, options\)/, '必须只有一个数字输入入口 numberInput');
    assert.match(text, /parseIntField\(event\.target\.value/, '必须走 parseIntField（空串不转 0）');
    assert.doesNotMatch(text, /update\('archiveAgeDays', Number\(event\.target\.value\)\)/, '不得再用 Number(event.target.value)');
    assert.doesNotMatch(text, /update\('dailyBudgetCount', Number\(event\.target\.value\)\)/, '不得再用 Number(event.target.value)');
    assert.match(text, /numberInput\('archiveAgeDays'/, '阈值输入必须走 numberInput');
    assert.match(text, /numberInput\('dailyBudgetCount'/, '预算输入必须走 numberInput');
  }
});

test('🔵 reconcileManifest 走 Manifest.repairIfMissing（判据唯一），且不重复补行', async () => {
  const h = await createHarness();
  try {
    const id = 'session-manifest-heal';
    await h.addSession(id);
    h.archived.add(id);
    await h.engine.migrate(id);
    // 制造「DB 有、manifest 无」：把 manifest 整档清掉
    await rm(h.paths.manifestPath, { force: true });
    const report = await h.engine.recoverOnBoot();
    assert.ok(report.counts.repaired >= 1, JSON.stringify(report.counts));
    const records = await h.manifestRecords();
    const repairs = records.filter((record) => record.op === 'repair' && record.id === id);
    assert.equal(repairs.length, 1, '只补一条 op:repair（repairIfMissing 的判据）');
    // 再跑一轮：已经补过 ⇒ 不再补（幂等）
    const before = (await h.manifestRecords()).length;
    await h.engine.recoverOnBoot();
    assert.equal((await h.manifestRecords()).length, before, '已补齐后不得再写新行');
  } finally {
    await h.dispose();
  }
});

test('§18.5：trash/restore 清索引水位（恢复后才会重索引，不会永远搜不到）', async () => {
  const h = await createHarness();
  try {
    const id = 'session-watermark';
    await h.addSession(id);
    h.archived.add(id);
    await h.engine.migrate(id);
    h.store.setMeta(WATERMARK_PREFIX + id, JSON.stringify({ size: 1, mtime: 1, generation: 'session.v4.jsonl.zstd' }));
    await h.engine.deleteSession(id);
    assert.equal(h.store.getMeta(WATERMARK_META_PREFIX + id, null), null, '删除必须清掉水位（否则恢复后永远不重索引）');
    await h.engine.trashRestore(id);
    assert.equal(h.store.getMeta(WATERMARK_META_PREFIX + id, null), null, '还原也不得留下旧水位');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// A-P3-6（纯函数面）：窗口化；UI 接线在 tests/ui-contract.test.mjs
// ---------------------------------------------------------------------------

test('A-P3-6：windowRange —— ≤200 行全量、>200 行窗口化（±overscan + 上下占位）', () => {
  const r0 = windowRange(0, 0, 500);
  assert.deepEqual(r0, { start: 0, end: 0, count: 0, padTop: 0, padBottom: 0, virtual: false });
  const exactly = windowRange(VIRTUAL_THRESHOLD, 5000, 500);
  assert.equal(exactly.virtual, false, '正好 200 行不窗口化（>200 才是阈值）');
  assert.deepEqual([exactly.start, exactly.end, exactly.count], [0, VIRTUAL_THRESHOLD, VIRTUAL_THRESHOLD]);
  assert.equal(exactly.padTop + exactly.padBottom, 0);

  const total = 1000;
  const viewport = 520;
  const scrolled = VIRTUAL_ROW_HEIGHT * 400;
  const r = windowRange(total, scrolled, viewport);
  assert.equal(r.virtual, true);
  assert.equal(r.start, 400 - 20, '上方 overscan = 20 行');
  const visibleRows = Math.ceil(viewport / VIRTUAL_ROW_HEIGHT) + 1;
  assert.equal(r.end, 400 + visibleRows + 20, '下方 overscan = 20 行');
  assert.ok(r.count < total / 2, '窗口必须远小于总行数');
  assert.equal(r.padTop, r.start * VIRTUAL_ROW_HEIGHT);
  assert.equal(r.padBottom, (total - r.end) * VIRTUAL_ROW_HEIGHT);
  // 上占位 + 实际渲染的行 + 下占位 = 全长（滚动条长度与真实内容一致）
  assert.equal(r.padTop + r.count * VIRTUAL_ROW_HEIGHT + r.padBottom, total * VIRTUAL_ROW_HEIGHT);

  // 边界：滚到最底 / 负数 / 视口 0 / 非法入参都不抛
  const bottom = windowRange(total, total * VIRTUAL_ROW_HEIGHT, viewport);
  assert.equal(bottom.end, total);
  assert.ok(bottom.start >= 0);
  const negative = windowRange(total, -100, viewport);
  assert.equal(negative.start, 0);
  const zeroViewport = windowRange(total, 0, 0);
  assert.ok(zeroViewport.count >= 1);
  assert.doesNotThrow(() => windowRange(undefined, undefined, undefined));
  assert.doesNotThrow(() => windowRange('abc', null, {}));
  assert.equal(windowRange(300, 0, 500, { overscan: 0 }).start, 0);
  assert.equal(VIRTUAL_THRESHOLD, 200, '阈值必须是 200（P3-D7）');
});
