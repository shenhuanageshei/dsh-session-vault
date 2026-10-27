import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  resolveVaultPaths,
  createConfigStore,
  INDEX_SCHEMA_META,
  INDEX_SCHEMA_VERSION,
  INDEX_SCHEMA_GAPS_META,
  readIndexSchemaGaps,
  indexSchemaSnapshotFrom,
} from '../lib/config.js';
import { VaultStore } from '../lib/store.js';
import { VaultEngine, projectKey } from '../lib/engine.js';
import {
  VaultIndexer,
  WATERMARK_PREFIX,
  DETERMINISTIC_INDEX_ERRORS,
  deterministicIndexError,
} from '../lib/indexer.js';
import { createVaultApi, PREFIX } from '../lib/http.js';

/**
 * P3b.1 真机修复轮测试：**索引 schema 重建每轮从 0 重来，永远跑不完**。
 *
 * 根因（真机已定位）：旧 `_markSchemaComplete()` 只在「本轮 failed===0」时写 `index:schema`；
 * 真实库固定有 29 个 extract-empty（v0 空壳/老格式）⇒ failed 恒 >0 ⇒ schema 永不写回 ⇒
 * 每次启动 `rebuildSchema()` 清水位全量重抽（真机读数：indexedThisRun 0→1616/2442、
 * rebuildNeeded 恒 true）。
 *
 * 本档锁定四条契约（对应任务 ①②③ + 分类器/UI）：
 *  ① 有 extract-empty ⇒ schema **照写回** + gaps 落库 + `/status.index.gaps` 可见；
 *  ② 同一库再次 ensureStarted ⇒ **不重建**（rebuildNeeded=false、零重抽、水位不动）；
 *  ③ 瞬态失败（注入普通 Error）⇒ 不写 schema、rebuildNeeded 仍 true；
 *  ④ 分类器封闭集 + 面板黄条「N 个会话未能索引（可重建）」有手动重建入口。
 */

const quiet = { info() {}, warn() {}, error() {} };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 一帧事件 = 一行 JSON（与线上 v4 日志同构）。 */
function frames(id, cwd) {
  let seq = 0;
  const next = () => { seq += 1; return seq; };
  return [
    JSON.stringify({ type: 'request/header', sessionId: id, cwd, createdAt: 1791000000000 }),
    JSON.stringify({ type: 'user/message', seq: next(), ts: 1791000001000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '正文 ' + id }] } }),
    JSON.stringify({ type: 'assistant/message', seq: next(), ts: 1791000002000, data: { message: { content: [{ type: 'text', text: '回复 ' + id }] } } }),
    JSON.stringify({ type: 'session/title', seq: next(), ts: 1791000005000, data: { title: '标题 ' + id } }),
  ];
}

/**
 * v0/v3 空壳/老格式的最小复现：只有一行不会被抽取的事件（step/start）。
 * 结果 = docs 0 且 lines>0 ⇒ engine 落 error='extract-empty'（§8.1 R-17）——这正是真机那 29 个。
 */
function emptyShellFrames(id, cwd) {
  return [
    JSON.stringify({ type: 'request/header', sessionId: id, cwd, createdAt: 1791000000000 }),
    JSON.stringify({ type: 'step/start', seq: 1, ts: 1791000001000, data: {} }),
  ];
}

async function createHarness() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p3b1-'));
  const paths = resolveVaultPaths(home);
  const cwd = '<workspace-root>\\p3b1-demo';
  const pk = projectKey(cwd);
  const archived = new Set();
  const registry = {
    archivedSessionIds: archived,
    async archiveSession(id) { archived.add(String(id)); },
    async unarchiveSession(id) { archived.delete(String(id)); },
    async resolveByPath() { return undefined; },
  };
  const persistence = { async list() { return []; }, async stat() { return undefined; } };
  const configStore = createConfigStore({ home, paths });
  await configStore.save({ autoMigrate: false, archiveAgeDays: 14 });
  const store = await VaultStore.open(paths.dbPath);
  const engine = new VaultEngine({
    home, paths, configStore, store, registry, persistence,
    logger: quiet,
    isActive: async () => false,
    sameVolume: async () => true,
    detectAm: async () => ({ present: false, matches: [], sources: ['injected'] }),
    resolveWorkspace: async () => undefined,
  });

  async function writeLog(id, lines) {
    const dir = path.join(paths.sessionsRoot, pk, id);
    await mkdir(dir, { recursive: true });
    const buffer = Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line + '\n'))));
    await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), buffer);
    return dir;
  }

  function makeIndexer(overrides = {}) {
    const indexer = new VaultIndexer({ engine, store, paths, logger: quiet, ...overrides });
    engine.indexer = indexer;
    return indexer;
  }

  async function dispose() {
    store.close();
    await rm(home, { recursive: true, force: true });
  }

  return {
    home, paths, cwd, pk, store, engine, configStore, registry, archived, dispose, writeLog, makeIndexer,
    addSession: (id) => writeLog(id, frames(id, cwd)),
    addEmptyShell: (id) => writeLog(id, emptyShellFrames(id, cwd)),
  };
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
  return { status: res.statusCode, json };
}

function gapsMeta(store) {
  const raw = store.getMeta(INDEX_SCHEMA_GAPS_META);
  return raw === null || raw === undefined ? null : JSON.parse(raw);
}

// ---- ① 确定性失败（extract-empty）不阻塞 schema 写回 ---------------------

test('P3b.1 ①：extract-empty 会话不阻塞 schema 写回 —— gaps 落库且 /status.index.gaps 可见', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-healthy');
    await h.addEmptyShell('session-empty-shell');
    const indexer = h.makeIndexer();
    const progress = await indexer.runFullIndex();

    // 这一轮确实「有失败」（旧实现正因如此拒绝写回 schema）
    assert.equal(progress.failed, 1, '空壳会话必须被记为失败：' + JSON.stringify(progress));
    assert.equal(progress.indexed, 1, '健康会话必须被索引成功');

    // 修复点 1：schema **照写回**（不再要求 failed===0）
    assert.equal(
      h.store.getMeta(INDEX_SCHEMA_META),
      String(INDEX_SCHEMA_VERSION),
      '确定性数据失败不得阻塞 schema 写回（旧实现永远写不回 ⇒ 每次启动全量重抽）',
    );
    // 修复点 2：未覆盖会话落 meta index:schema-gaps（[{id,error}]）
    assert.deepEqual(
      gapsMeta(h.store),
      [{ id: 'session-empty-shell', error: 'extract-empty' }],
      '未覆盖会话必须以 {id,error} 形状落 index:schema-gaps',
    );

    const snap = indexer.schemaSnapshot();
    assert.equal(snap.rebuildNeeded, false, 'schema 已写回 ⇒ rebuildNeeded 必须为 false');
    assert.equal(snap.doneWithGaps, true);
    assert.equal(snap.gapsCount, 1);

    // 修复点 3：/status.index 暴露 gaps / gapsCount / doneWithGaps
    const status = await call(createVaultApi({
      home: h.home, configStore: h.configStore, version: '0.1.0-test',
      getEngine: async () => h.engine, getIndexer: async () => indexer, logger: quiet,
    }), { url: PREFIX + '/status', body: '{}' });
    assert.equal(status.status, 200);
    assert.equal(status.json.ok, true);
    assert.deepEqual(status.json.index.gaps, [{ id: 'session-empty-shell', error: 'extract-empty' }]);
    assert.equal(status.json.index.gapsCount, 1);
    assert.equal(status.json.index.doneWithGaps, true);
    assert.equal(status.json.index.rebuildNeeded, false);
    assert.equal(status.json.index.schemaStored, INDEX_SCHEMA_VERSION);
    // 健康会话照常可搜（gaps 只是「这一个会话没索引」，不是整体失效）
    assert.equal(indexer.coverage(), 1);

    // 引擎兜底读数（索引器还没实例化/被置空时）同口径：gaps 仍从 meta 读出来，不冒充
    h.engine.indexer = null;
    const fallback = h.engine.indexSnapshot();
    assert.deepEqual(fallback.gaps, [{ id: 'session-empty-shell', error: 'extract-empty' }]);
    assert.equal(fallback.gapsCount, 1);
    assert.equal(fallback.doneWithGaps, true);
    assert.equal(fallback.rebuildNeeded, false);
  } finally {
    await h.dispose();
  }
});

// ---- ② 再次启动不重建 -------------------------------------------------

test('P3b.1 ②：schema 一致时再次 ensureStarted 不触发重建（rebuildNeeded=false、零重抽、水位不动）', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-restart-ok');
    await h.addEmptyShell('session-restart-empty');
    const first = h.makeIndexer();
    await first.runFullIndex();
    assert.equal(h.store.getMeta(INDEX_SCHEMA_META), String(INDEX_SCHEMA_VERSION));

    const watermarksBefore = h.store.listMetaKeys(WATERMARK_PREFIX).sort();
    assert.deepEqual(watermarksBefore, ['wm:session-restart-ok'], '正常索引后只有健康会话有水位');

    // 「重启」：同一库上的新索引器不共享内存（初始 _phase=idle / _startedAt=null）
    const second = h.makeIndexer();
    assert.equal(second.schemaSnapshot().rebuildNeeded, false, 'schema 已等于当前版本 ⇒ 不得声明需要重建（即使有 gaps）');
    assert.equal(second.schemaSnapshot().gapsCount, 1, 'gaps 读数必须跨重启可见');

    const resumed = await second.ensureStarted();
    assert.equal(resumed.phase, 'done', JSON.stringify(resumed));
    assert.equal(resumed.indexed, 0, 'schema 一致 ⇒ 不得清水位重抽（旧实现这里会是 2 个重抽）');
    assert.equal(resumed.indexedThisRun, 0, '本轮真实重抽数必须为 0');
    // 清水位是重建的标志性副作用：水位原样保留 ⇒ 确实没走 rebuildSchema()
    assert.deepEqual(h.store.listMetaKeys(WATERMARK_PREFIX).sort(), watermarksBefore, '水位不得被清（清水位=重建）');
    assert.equal(h.store.getMeta(INDEX_SCHEMA_META), String(INDEX_SCHEMA_VERSION));
    // 重跑只会重试无水位的那一个（gaps 会话），不会碰已索引会话
    assert.equal(resumed.skipped, 1);
    assert.equal(resumed.failed, 1);
    assert.deepEqual(gapsMeta(h.store), [{ id: 'session-restart-empty', error: 'extract-empty' }], '重跑必须如实重写同一份 gaps');
  } finally {
    await h.dispose();
  }
});

// ---- ③ 瞬态失败不写 schema ---------------------------------------------

test('P3b.1 ③：瞬态失败（注入普通 Error / index-failed）⇒ 不写 schema，rebuildNeeded 仍 true', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-transient');
    const indexer = h.makeIndexer();
    const original = indexer.indexTarget.bind(indexer);
    indexer.indexTarget = async (target, options) => {
      if (target && target.id === 'session-transient') throw new Error('EIO: injected transient IO failure');
      return original(target, options);
    };
    const progress = await indexer.runFullIndex();
    assert.equal(progress.failed, 1);
    // 瞬态 ⇒ 不写 schema、不落 gaps（下次启动重建重试）
    assert.equal(h.store.getMeta(INDEX_SCHEMA_META), null, '瞬态失败不得写回 schema');
    assert.equal(h.store.getMeta(INDEX_SCHEMA_GAPS_META), null, '瞬态失败不得落 gaps（gaps 只装确定性数据失败）');
    assert.equal(indexer.schemaSnapshot().rebuildNeeded, true);
    assert.equal(indexer.schemaSnapshot().doneWithGaps, false);

    // 「重启」⇒ 仍声明需要重建（下次启动重试）
    const second = h.makeIndexer();
    assert.equal(second.schemaSnapshot().rebuildNeeded, true, '瞬态失败后重启必须重试');
    assert.equal(second.schemaSnapshot().stored, null);

    // 引擎返回的 index-failed 同属瞬态（不是确定性数据失败）
    const third = h.makeIndexer();
    third.indexTarget = async () => ({ ok: false, error: 'index-failed' });
    const again = await third.runFullIndex();
    assert.equal(again.failed, 1);
    assert.equal(h.store.getMeta(INDEX_SCHEMA_META), null, 'index-failed 属瞬态 ⇒ 仍不写 schema');
    assert.equal(third.schemaSnapshot().rebuildNeeded, true);
  } finally {
    await h.dispose();
  }
});

// ---- ⑤ 手动重建：gaps 修好后黄条消失（入口不是空按钮） ------------------

test('P3b.1 ⑤：手动重建（rebuild-index start → rescan）在会话可索引后清空 gaps（黄条消失）', async () => {
  const h = await createHarness();
  try {
    await h.addSession('session-fixme');
    await h.addEmptyShell('session-broken');
    const indexer = h.makeIndexer();
    await indexer.runFullIndex();
    assert.deepEqual(gapsMeta(h.store), [{ id: 'session-broken', error: 'extract-empty' }]);

    // 用户「重建」入口：/rebuild-index {action:"start"} ⇒ indexer.rescan()（强制重扫 + 重试无水位会话）
    // 这里模拟「日志被修好/换成了可抽取的形状」
    await h.addSession('session-broken');
    const rescanned = await indexer.rescan();
    assert.equal(rescanned.phase, 'done', JSON.stringify(rescanned));
    assert.equal(rescanned.indexed, 1, '修好的会话必须被真的重抽（不是空跑）');
    assert.equal(rescanned.failed, 0);
    // 后置：全部覆盖 ⇒ gaps meta 删除、doneWithGaps=false（黄条必须消失，不是留着陈旧计数）
    assert.equal(h.store.getMeta(INDEX_SCHEMA_GAPS_META), null, '全部覆盖后必须清掉 index:schema-gaps');
    assert.equal(indexer.schemaSnapshot().gapsCount, 0);
    assert.equal(indexer.schemaSnapshot().doneWithGaps, false);
    assert.equal(h.store.getMeta(INDEX_SCHEMA_META), String(INDEX_SCHEMA_VERSION));
  } finally {
    await h.dispose();
  }
});

// ---- ④ 分类器 + 读取面 + UI 契约 ---------------------------------------

test('P3b.1 ④：确定性失败分类器封闭集（extract-empty / frame-corrupt / identity-mismatch），其它一律瞬态', () => {
  assert.deepEqual([...DETERMINISTIC_INDEX_ERRORS], ['extract-empty', 'frame-corrupt', 'identity-mismatch']);
  for (const code of DETERMINISTIC_INDEX_ERRORS) {
    assert.equal(deterministicIndexError(code), code, '精确码必须命中：' + code);
    assert.equal(deterministicIndexError(code + ': detail'), code, '码 + 冒号细节必须命中：' + code);
    assert.equal(deterministicIndexError(code + ' detail'), code, '码 + 空格细节必须命中：' + code);
  }
  // 瞬态：IO / 未知异常 / index-failed / 空值
  assert.equal(deterministicIndexError('index-failed'), null);
  assert.equal(deterministicIndexError('EIO: disk I/O error'), null);
  assert.equal(deterministicIndexError('no-target'), null);
  assert.equal(deterministicIndexError(null), null);
  assert.equal(deterministicIndexError(undefined), null);
  assert.equal(deterministicIndexError(''), null);
  // 前缀不得跨码误命中（extract-emptyish 不是 extract-empty）
  assert.equal(deterministicIndexError('extract-emptyish'), null);

  // 读取面：脏值 ⇒ []、不冒充完成（读面不猜）
  const dirty = {
    getMeta(key) {
      if (key === INDEX_SCHEMA_GAPS_META) return 'not-json';
      if (key === INDEX_SCHEMA_META) return String(INDEX_SCHEMA_VERSION);
      return null;
    },
  };
  assert.deepEqual(readIndexSchemaGaps(dirty), []);
  const snapshot = indexSchemaSnapshotFrom(dirty);
  assert.equal(snapshot.doneWithGaps, false);
  assert.equal(snapshot.rebuildNeeded, false);
  assert.equal(snapshot.stored, INDEX_SCHEMA_VERSION);
  // 非数组 / 形状不对的元素被丢掉
  const shaped = { getMeta: (key) => (key === INDEX_SCHEMA_GAPS_META ? JSON.stringify([{ id: 'a', error: 'extract-empty' }, null, 'x', { error: 'no-id' }]) : null) };
  assert.deepEqual(readIndexSchemaGaps(shaped), [{ id: 'a', error: 'extract-empty' }]);
});

test('P3b.1 ④ UI 契约：面板黄条「N 个会话未能索引（可重建）」+ 手动重建入口（rebuild-index start）', async () => {
  const bundle = await readFile(path.join(ROOT, 'lib/client.js'), 'utf8');
  assert.ok(bundle.includes('个会话未能索引（可重建）'), '黄条文案必须是「N 个会话未能索引（可重建）」');
  assert.ok(bundle.includes('index.doneWithGaps === true'), '黄条只看 doneWithGaps（schema 未完成时由进度条负责）');
  assert.ok(bundle.includes("props.onAction('start')"), '手动重建入口必须走 rebuild-index {action:"start"}');
  // 读面字段真的被 bundle 消费（不是只存在于 host 侧）
  assert.ok(bundle.includes('gapsCount'), '面板必须读 gapsCount');
});
