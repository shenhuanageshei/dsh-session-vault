import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, utimes, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVaultPaths, createConfigStore } from '../lib/config.js';
import { VaultStore } from '../lib/store.js';
import {
  VaultEngine,
  projectKey,
  headerFactsOf,
  headerIdEdges,
  REF_SCAN_TTL_MS,
  SUBAGENT_ORPHAN_EDGE_LIMIT,
  SUBAGENT_BATCH_CAP,
  SUBSCAN_META,
} from '../lib/engine.js';
import { VaultIndexer } from '../lib/indexer.js';
import { hashTree } from '../lib/marker.js';

const quiet = { info() {}, warn() {}, error() {} };
/** 固定假时钟（可注入 now）：2027-01-15T08:00:00Z 附近，远离测试机真实时间。 */
const T0 = 1800000000000;
const DAY = 86400000;
/** 同时支持文件与目录的存在性判定（迁移断言要判热/冷**目录**）。 */
const exists = (target) => stat(target).then(() => true).catch(() => false);
/** 全代际 sha256（与 marker 基线同一套实现）。 */
const hashTreeOf = async (dir) => (await hashTree(dir)).sha256;

function headerLine(id, cwd, extra = {}) {
  return JSON.stringify(Object.assign({ type: 'request/header', sessionId: id, cwd, createdAt: 1791000000000 }, extra));
}

function bodyLines() {
  return [
    JSON.stringify({
      type: 'user/message', seq: 1, ts: 1791000001000,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '子代理会话的样本正文' }] },
    }),
    JSON.stringify({
      type: 'assistant/message', seq: 2, ts: 1791000002000,
      data: { message: { content: [{ type: 'text', text: '子代理的回复' }] } },
    }),
    JSON.stringify({ type: 'session/title', seq: 3, ts: 1791000003000, data: { title: '子代理样本' } }),
  ];
}

/** subagent.test.mjs 的自足夹具：假 fs（真临时目录）+ 可注入时钟 + registry/persistence 桩。 */
async function createHarness(options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-subagent-'));
  const paths = resolveVaultPaths(home);
  const cwd = options.cwd || '<workspace-root>\\sub';
  const pk = projectKey(cwd);
  const archived = new Set();
  const registered = new Set();
  const pinned = new Set();
  const clock = { now: options.now === undefined ? T0 : options.now };
  const calls = { archive: [], unarchive: [], attach: [], stat: [] };

  const workspace = {
    path: cwd,
    sessionIds: registered,
    async attachSession(id) { calls.attach.push(String(id)); registered.add(String(id)); },
  };
  const registry = {
    archivedSessionIds: archived,
    // P4：宿主没有 pinnedSessionIds 概念；这里给一个显式桩，验证「若存在也必须被尊重」。
    pinnedSessionIds: pinned,
    async archiveSession(id) { archived.add(String(id)); calls.archive.push(String(id)); },
    async unarchiveSession(id) { archived.delete(String(id)); calls.unarchive.push(String(id)); },
    async resolveByPath() { return workspace; },
  };
  const persistence = {
    async list() { return []; },
    async stat(sessionId) {
      calls.stat.push(String(sessionId));
      const dir = path.join(paths.sessionsRoot, pk, String(sessionId));
      try {
        const files = await readFile(path.join(dir, 'session.v4.jsonl.zstd'));
        return files ? { sizeBytes: files.length, id: sessionId } : undefined;
      } catch {
        return undefined;
      }
    },
  };

  const configStore = createConfigStore({ home, paths });
  if (options.config) await configStore.save(options.config);
  const store = await VaultStore.open(paths.dbPath);
  const engine = new VaultEngine({
    home, paths, configStore, store, registry, persistence,
    logger: quiet,
    now: () => clock.now,
    isActive: async () => Boolean(options.active),
    sameVolume: options.sameVolume === undefined ? async () => true : options.sameVolume,
    detectAm: async () => ({ present: false, matches: [], sources: ['injected'] }),
    resolveWorkspace: async () => workspace,
  });

  /**
   * 造一个会话目录。
   * @param {string} id
   * @param {{origin?:string, depth?:number, parent?:string, daysAgo?:number, extraHeader?:object,
   *          noGeneration?:boolean, rawHeader?:string}} opts
   */
  async function addSession(id, opts = {}) {
    const dir = path.join(paths.sessionsRoot, pk, id);
    await mkdir(dir, { recursive: true });
    if (!opts.noGeneration) {
      const header = opts.rawHeader || headerLine(id, opts.cwd || cwd, Object.assign(
        opts.origin ? { origin: opts.origin } : {},
        opts.depth ? { delegationDepth: opts.depth } : {},
        opts.parent ? { parentSession: opts.parent } : {},
        opts.extraHeader || {},
      ));
      const lines = [header].concat(opts.body === false ? [] : bodyLines());
      await writeFile(
        path.join(dir, 'session.v4.jsonl.zstd'),
        Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line + '\n')))),
      );
    } else {
      await writeFile(path.join(dir, 'not-a-generation.txt'), 'junk');
    }
    return dir;
  }

  /** 入 DB 行（不读盘）：模拟「已经建过行的存量会话」。 */
  function addRow(id, patch = {}) {
    return store.upsertSession(Object.assign({
      session_id: id,
      project_key: pk,
      rel_dir: pk + '/' + id,
      log_names: 'session.v4.jsonl.zstd',
      format_version: 4,
      bytes: 100,
      file_size: 100,
      file_mtime_ms: clock.now - 30 * DAY,
      header_cwd: cwd,
      created_at: clock.now - 60 * DAY,
      status: 'hot',
      source_sha: 'sha-' + id,
    }, patch));
  }

  return {
    home, paths, cwd, pk, archived, registered, pinned, clock, calls, registry, persistence,
    configStore, store, engine, workspace,
    addSession, addRow,
    coldDir: (id) => path.join(paths.coldRootDefault, pk, id),
    hotDir: (id) => path.join(paths.sessionsRoot, pk, id),
    markerPath: (id) => path.join(paths.markerDir, id + '.json'),
    async dispose() {
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// P4 / A-P4-13 的前置：header 事实解析是纯函数（scan 与 indexer 共用同一份）
// ---------------------------------------------------------------------------
test('P4：headerFactsOf / headerIdEdges 是纯函数（未知就是 null/0，边排除自身与结构字段）', () => {
  const unknown = headerFactsOf(null);
  assert.deepEqual(unknown, { origin: null, delegationDepth: 0, parentSession: null });
  const facts = headerFactsOf({
    raw: {
      type: 'request/header',
      sessionId: 'child-1',
      cwd: '<workspace-root>\\x',
      origin: 'subagent',
      delegationDepth: 2,
      parentSession: 'parent-1',
    },
  });
  assert.equal(facts.origin, 'subagent');
  assert.equal(facts.delegationDepth, 2);
  assert.equal(facts.parentSession, 'parent-1');
  // 注入式假 header（只带平铺字段）也要能读（单测接缝）
  const flat = headerFactsOf({ origin: 'subagent', delegationDepth: 1, parentSession: 'p' });
  assert.equal(flat.origin, 'subagent');
  assert.equal(flat.delegationDepth, 1);
  assert.equal(flat.parentSession, 'p');

  const edges = headerIdEdges({
    raw: { sessionId: 'child-1', type: 'request/header', cwd: '<workspace-root>\\x', origin: 'subagent', parentSession: 'parent-1', forkOf: 'seed-1' },
  }, 'child-1');
  assert.deepEqual(edges.map((edge) => edge.to).sort(), ['parent-1', 'seed-1']);
  assert.equal(edges.some((edge) => edge.to === 'child-1'), false, '自身不是入边');
  assert.equal(edges.some((edge) => edge.to === 'subagent'), false, 'origin 不是引用边');
  assert.equal(edges.some((edge) => edge.field === 'type'), false, '结构字段不是引用边');
});

// ---------------------------------------------------------------------------
// P4 / FR-P4-2：header 事实扫描（只读遍历、首帧 header、三列落库、gaps/orphanEdges）
// ---------------------------------------------------------------------------
test('P4 FR-P4-2：scanHeaderFacts 只读遍历 sessions，落 origin/delegation_depth/parent_session 并产出四个 meta', async () => {
  const h = await createHarness();
  try {
    // 有行 + 子代理：三列要被写回
    h.addRow('sub-a');
    await h.addSession('sub-a', { origin: 'subagent', depth: 1, parent: 'main-1' });
    // 有行 + delegationDepth>=1（另一种子代理形态）
    h.addRow('sub-b');
    await h.addSession('sub-b', { depth: 2 });
    // 有行 + 普通会话（origin 缺省 ⇒ NULL，不得被写成 subagent）
    h.addRow('main-1');
    await h.addSession('main-1');
    // 无行的目录：只收集边，**绝不建行**
    await h.addSession('unregistered-1', { parent: 'main-1' });
    // 坏目录：没有合法代际 ⇒ gaps
    await h.addSession('broken-1', { noGeneration: true });

    const before = { 'sub-a': await exists(h.hotDir('sub-a')), 'main-1': await exists(h.hotDir('main-1')) };
    const report = await h.engine.scanHeaderFacts({ force: true });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.scanned, 3, '只有三个目录能读到 header');
    assert.equal(h.store.getSession('sub-a').origin, 'subagent');
    assert.equal(h.store.getSession('sub-a').delegation_depth, 1);
    assert.equal(h.store.getSession('sub-a').parent_session, 'main-1');
    assert.equal(h.store.getSession('sub-b').delegation_depth, 2);
    assert.equal(h.store.getSession('sub-b').origin, null, 'delegationDepth-only 的子代理不伪造 origin');
    assert.equal(h.store.getSession('main-1').origin, null, '普通会话的 origin 必须是 NULL（未知 ≠ subagent）');
    assert.equal(h.store.getSession('unregistered-1'), null, '无 DB 行的目录不得建行');
    assert.deepEqual(report.gaps.map((gap) => gap.id), ['broken-1']);
    assert.equal(report.gaps[0].reason, 'no-generation');
    assert.deepEqual(
      report.orphanEdges.map((edge) => ({ from: edge.from, to: edge.to })),
      [{ from: 'unregistered-1', to: 'main-1' }],
      '无行目录的 parentSession 边要进 orphanEdges',
    );
    // meta 四项都落库
    assert.equal(Number(h.store.getMeta(SUBSCAN_META.at)), h.clock.now);
    assert.equal(Number(h.store.getMeta(SUBSCAN_META.count)), 3);
    assert.deepEqual(JSON.parse(h.store.getMeta(SUBSCAN_META.gaps)).map((gap) => gap.id), ['broken-1']);
    assert.deepEqual(JSON.parse(h.store.getMeta(SUBSCAN_META.orphanEdges)).map((edge) => edge.to), ['main-1']);
    // **不搬移任何文件**（后置条件）
    assert.equal(await exists(h.hotDir('sub-a')), before['sub-a']);
    assert.equal(await exists(h.hotDir('main-1')), before['main-1']);
    assert.equal(await exists(h.coldDir('sub-a')), false, '扫描绝不搬移文件');
    // 快照读面
    const snapshot = h.engine.subscanSnapshot();
    assert.equal(snapshot.fresh, true);
    assert.equal(snapshot.count, 3);
    assert.equal(snapshot.refsIncomplete, true, 'gaps 非空 ⇒ 引用快照不可信（fail-closed）');
    assert.equal(snapshot.gaps.length, 1);
  } finally {
    await h.dispose();
  }
});

test('P4 FR-P4-2：快照新鲜时跳过；force 与过期都会重扫（TTL=24h）', async () => {
  const h = await createHarness();
  try {
    h.addRow('sub-a');
    await h.addSession('sub-a', { origin: 'subagent' });
    const first = await h.engine.scanHeaderFacts({ force: true });
    assert.equal(first.ok, true);
    const skipped = await h.engine.scanHeaderFacts({});
    assert.equal(skipped.skipped, 'fresh', '24h 内不重复全扫（IO 成本）');
    // 推进时钟到阈值之后
    h.clock.now += REF_SCAN_TTL_MS + 1000;
    const again = await h.engine.scanHeaderFacts({});
    assert.equal(again.skipped, undefined, '过期必须重扫（不能把旧快照当可信）');
    assert.equal(again.ok, true);
    assert.equal(h.engine.subscanSnapshot().fresh, true);
  } finally {
    await h.dispose();
  }
});

test('P4 FR-P4-2（评审 #9）：orphanEdges 超过上限的溢出部分计入 gaps，不静默截断', async () => {
  const h = await createHarness();
  try {
    // 一个无行目录里塞 SUBAGENT_ORPHAN_EDGE_LIMIT+1 个 id 型引用字段
    const extraHeader = {};
    for (let i = 0; i <= SUBAGENT_ORPHAN_EDGE_LIMIT; i += 1) extraHeader['ref' + i] = 'session-ref-' + i;
    await h.addSession('unregistered-hub', extraHeader);
    const report = await h.engine.scanHeaderFacts({ force: true });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.orphanEdges.length, SUBAGENT_ORPHAN_EDGE_LIMIT, '落库上限 = ' + SUBAGENT_ORPHAN_EDGE_LIMIT);
    assert.equal(SUBAGENT_ORPHAN_EDGE_LIMIT, 500);
    const overflow = report.gaps.filter((gap) => gap.reason === 'orphan-edge-overflow');
    assert.equal(overflow.length, 1, '溢出必须落进 gaps（同一来源只记一次）');
    assert.equal(overflow[0].id, 'unregistered-hub');
    assert.equal(h.engine.subscanSnapshot().refsIncomplete, true, '溢出 ⇒ class S 暂停');
  } finally {
    await h.dispose();
  }
});

test('P4 FR-P4-2：indexer.ensureRow 首建行时顺带落三列（与 scan 同一份解析）', async () => {
  const h = await createHarness();
  try {
    const id = 'sub-index';
    const dir = await h.addSession(id, { origin: 'subagent', depth: 3, parent: 'main-9' });
    const indexer = new VaultIndexer({ engine: h.engine, store: h.store, paths: h.paths, logger: quiet });
    const row = await indexer.ensureRow({
      id,
      dir,
      cold: false,
      projectKey: h.pk,
      generations: ['session.v4.jsonl.zstd'],
      current: 'session.v4.jsonl.zstd',
      version: 4,
      size: 10,
      mtime: 10,
    });
    assert.equal(row.origin, 'subagent');
    assert.equal(row.delegation_depth, 3);
    assert.equal(row.parent_session, 'main-9');
    assert.equal(row.status, 'hot');
  } finally {
    await h.dispose();
  }
});

test('P4 FR-P4-1：三个新配置的默认值与范围校验（非法值明确拒绝，不静默生效）', async () => {
  const h = await createHarness();
  try {
    const loaded = await h.configStore.load();
    assert.equal(loaded.config.subagentMigrate, false, '默认关（观察模式）');
    assert.equal(loaded.config.subagentAgeDays, 14);
    assert.equal(loaded.config.subagentDailyBudgetCount, 50);
    assert.equal(loaded.ok, true);

    const badBoolean = await h.configStore.save({ subagentMigrate: 'yes' });
    assert.equal(badBoolean.ok, false);
    assert.equal(badBoolean.errors[0].code, 'invalid-config');
    const tooBig = await h.configStore.save({ subagentAgeDays: 4000 });
    assert.equal(tooBig.ok, false, 'subagentAgeDays 上限 3650');
    const negative = await h.configStore.save({ subagentDailyBudgetCount: -1 });
    assert.equal(negative.ok, false, '预算不得为负');
    const ok = await h.configStore.save({ subagentMigrate: true, subagentAgeDays: 0, subagentDailyBudgetCount: 7 });
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));
    assert.equal(ok.config.subagentAgeDays, 0, '0 是合法值（= 关闭）');
    assert.equal(ok.config.subagentMigrate, true);
    assert.equal(ok.config.subagentDailyBudgetCount, 7);
    // 派生字段只在对外视图里（不落 config.json）
    const view = await h.configStore.publicConfig();
    assert.equal(view.subagentMigrateEffective, false, '阈值 0 ⇒ 生效值恒为 false');
    const onDisk = JSON.parse(await readFile(h.paths.configPath, 'utf8'));
    assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'subagentMigrateEffective'), false);
  } finally {
    await h.dispose();
  }
});

test('P4：批量上限常量 = 2000（§19.11 用户裁定）', () => {
  assert.equal(SUBAGENT_BATCH_CAP, 2000);
});

// ---------------------------------------------------------------------------
// Stage 2：资格 / 迁移 / 恢复 / 对账分域（A-P4-1 .. A-P4-8 / A-P4-12）
// ---------------------------------------------------------------------------

/** 造一个「合格的 class S 候选」：目录 + DB 行 + 已落库的 header 事实 + 年龄门。 */
async function seedSubagent(h, id, opts = {}) {
  await h.addSession(id, opts);
  h.addRow(id, opts.row || {});
  // 真实路径：header 事实必须由扫描落库（不是测试里手写三列）
  await h.engine.scanHeaderFacts({ force: true });
  const daysAgo = opts.daysAgo === undefined ? 20 : opts.daysAgo;
  const stamp = h.clock.now - daysAgo * DAY;
  const patch = Object.assign({ file_mtime_ms: stamp, created_at: stamp }, opts.patch || {});
  h.store.updateSession(id, patch);
  // 文件 mtime 也要落到「N 天前」：lastActiveAt = max(docs, 文件 mtime, created_at)，
  // 只改 DB 的话迁移前的 refreshDiskFields 会把 mtime 读回「刚刚」，年龄门永远不过（§9 / §15.1 #7）。
  const dir = h.hotDir(id);
  const date = new Date(stamp);
  for (const name of await readdir(dir).catch(() => [])) {
    await utimes(path.join(dir, name), date, date).catch(() => {});
  }
  h.engine.invalidate();
  return h.store.getSession(id);
}

test('A-P4-1 / A-P4-6：合格子代理会话进候选并迁移（热目录消失、基线一致、status=cold、manifest class）', async () => {
  const h = await createHarness();
  try {
    const id = 'sub-p4-1';
    const row = await seedSubagent(h, id, { origin: 'subagent', depth: 1, parent: 'main-root' });
    assert.equal(row.origin, 'subagent');
    const candidateIds = (await h.engine.subagentCandidates()).map((item) => item.session_id);
    assert.deepEqual(candidateIds, [id], '合格候选必须恰好是它');
    const baseline = await hashTreeOf(h.hotDir(id));

    const result = await h.engine.migrate(id, { class: 'subagent' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, 'cold');
    assert.equal(await exists(h.hotDir(id)), false, '热目录必须消失');
    const cold = h.coldDir(id);
    assert.equal(await exists(cold), true, '冷目录必须存在');
    assert.equal(await hashTreeOf(cold), baseline, '全代际 sha256 必须与 marker 基线一致');
    const migrated = h.store.getSession(id);
    assert.equal(migrated.status, 'cold');
    assert.equal(migrated.cold_root, h.paths.coldRootDefault);
    assert.equal(migrated.origin, 'subagent', 'header 事实必须随行保留');
    assert.equal(migrated.parent_session, 'main-root');
    assert.equal(migrated.restored_at, null);
    // manifest 行带 class=subagent（§19.7）
    const records = (await readFile(h.paths.manifestPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const migrateRecord = records.find((record) => record.op === 'migrate' && record.id === id);
    assert.ok(migrateRecord, 'manifest 必须有迁移行');
    assert.equal(migrateRecord.class, 'subagent');
    assert.equal(migrateRecord.sha256, baseline);
    // 负向断言：archivedSessionIds 一字未改（I-2）
    assert.equal(h.archived.has(id), false, 'class S 迁移绝不写 archivedSessionIds');
    assert.equal(h.archived.size, 0);
    assert.equal(await exists(h.markerPath(id)), false, '成功后 marker 必须删除');
  } finally {
    await h.dispose();
  }
});

test('A-P4-2（负向）：被 parent_session 指向的会话永不迁移（DB 边与 orphanEdges 两个来源都生效）', async () => {
  const h = await createHarness();
  try {
    const id = 'sub-p4-2';
    await seedSubagent(h, id, { origin: 'subagent' });
    // 来源 ①：DB 里的 parent_session 指向它
    h.addRow('ref-child', { parent_session: id });
    h.engine.invalidate();
    assert.deepEqual((await h.engine.subagentCandidates()).map((row) => row.session_id), [], '被 DB 边引用 ⇒ 不进候选');
    const blocked = await h.engine.migrate(id, { class: 'subagent' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'referenced', JSON.stringify(blocked));
    assert.equal(await exists(h.hotDir(id)), true, '拒绝时不得搬走任何文件');
    assert.equal(await exists(h.coldDir(id)), false);

    // 来源 ②：无 DB 行目录的 header.parentSession（orphanEdges）
    h.store.deleteSession('ref-child');
    h.engine.invalidate();
    await h.addSession('ghost-child', { parent: id });
    await h.engine.scanHeaderFacts({ force: true });
    assert.deepEqual((await h.engine.subagentCandidates()).map((row) => row.session_id), [], '被无行目录引用 ⇒ 同样不进候选');
    const blocked2 = await h.engine.migrate(id, { class: 'subagent' });
    assert.equal(blocked2.code, 'referenced', JSON.stringify(blocked2));

    // 移走引用者后（重新扫描）⇒ 恢复候选资格
    await rm(path.join(h.paths.sessionsRoot, h.pk, 'ghost-child'), { recursive: true, force: true });
    await h.engine.scanHeaderFacts({ force: true });
    assert.deepEqual((await h.engine.subagentCandidates()).map((row) => row.session_id), [id]);
  } finally {
    await h.dispose();
  }
});

test('A-P4-3（负向）：已登记 / 已归档 / 置顶收藏的会话永不进候选', async () => {
  const h = await createHarness();
  try {
    const registeredId = 'sub-registered';
    await seedSubagent(h, registeredId, { origin: 'subagent' });
    h.registered.add(registeredId);
    const archivedId = 'sub-archived';
    await seedSubagent(h, archivedId, { origin: 'subagent' });
    h.archived.add(archivedId);
    const pinnedId = 'sub-pinned';
    await seedSubagent(h, pinnedId, { origin: 'subagent' });
    h.pinned.add(pinnedId);
    const favoriteId = 'sub-favorite';
    await seedSubagent(h, favoriteId, { origin: 'subagent' });
    h.store.updateSession(favoriteId, { favorite: 1 });
    h.engine.invalidate();

    const candidateIds = (await h.engine.subagentCandidates()).map((row) => row.session_id);
    assert.deepEqual(candidateIds, [], '登记 / 归档 / 置顶 / 收藏 四类必须全部被排除');

    const registered = await h.engine.migrate(registeredId, { class: 'subagent' });
    assert.equal(registered.code, 'registered', JSON.stringify(registered));
    const pinned = await h.engine.migrate(pinnedId, { class: 'subagent' });
    assert.equal(pinned.code, 'pinned', JSON.stringify(pinned));
    // 已归档的子代理会话属 **class A** 的域（§19.7 的派生规则：archived 优先）：
    // 它不进 class S 候选；要搬它必须走 class A 的资格（在归档集合里 ⇒ 允许），这里只断言分域。
    const classAView = await h.engine.list();
    assert.equal(
      classAView.items.some((item) => item.id === archivedId && item.class === 'archived'),
      true,
      '已在归档集合里的子代理会话必须留在 class A 视图（分域不是删行）',
    );
    assert.equal(h.engine.rowClass(h.store.getSession(archivedId)), 'archived', '归档优先：class S 不得覆盖 class A');
    for (const id of [registeredId, archivedId, pinnedId, favoriteId]) {
      assert.equal(await exists(h.hotDir(id)), true, id + '：一个文件都不许动');
    }
  } finally {
    await h.dispose();
  }
});

test('A-P4-4（负向）：hidden / error / 非 hot / 活跃 一律不进候选', async () => {
  const h = await createHarness();
  try {
    const hiddenId = 'sub-hidden';
    await seedSubagent(h, hiddenId, { origin: 'subagent', patch: { hidden: 1 } });
    const errorId = 'sub-error';
    await seedSubagent(h, errorId, { origin: 'subagent', patch: { error: 'needs-review' } });
    const restoredId = 'sub-restored';
    await seedSubagent(h, restoredId, { origin: 'subagent', patch: { status: 'hot-restored' } });
    h.engine.invalidate();
    assert.deepEqual((await h.engine.subagentCandidates()).map((row) => row.session_id), [], '三个状态条件都必须排除');

    assert.equal((await h.engine.migrate(hiddenId, { class: 'subagent' })).code, 'hidden');
    assert.equal((await h.engine.migrate(errorId, { class: 'subagent' })).code, 'session-error');
    assert.equal((await h.engine.migrate(restoredId, { class: 'subagent' })).code, 'not-candidate');
  } finally {
    await h.dispose();
  }

  // 活跃：注入判据（单测接缝）说「running」⇒ 永不进候选、迁移被 active 拒绝
  const active = await createHarness({ active: true });
  try {
    const id = 'sub-active';
    await seedSubagent(active, id, { origin: 'subagent' });
    assert.deepEqual((await active.engine.subagentCandidates()).map((row) => row.session_id), []);
    const result = await active.engine.migrate(id, { class: 'subagent' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'active');
    assert.equal(await exists(active.hotDir(id)), true);
  } finally {
    await active.dispose();
  }
});

test('A-P4-5（负向）：快照缺失 / 过期 / gaps 非空 ⇒ 零搬移 + 明确暂停原因', async () => {
  const h = await createHarness();
  try {
    const id = 'sub-p4-5';
    await seedSubagent(h, id, { origin: 'subagent' });
    // ① 快照过期（> 24h）
    h.store.setMeta(SUBSCAN_META.at, String(h.clock.now - 25 * 60 * 60 * 1000));
    h.engine.invalidate();
    assert.deepEqual((await h.engine.subagentCandidates()).map((row) => row.session_id), [], '过期快照 ⇒ 零候选');
    const expired = await h.engine.migrate(id, { class: 'subagent' });
    assert.equal(expired.ok, false);
    assert.equal(expired.code, 'refs-incomplete', JSON.stringify(expired));
    assert.equal(await exists(h.hotDir(id)), true);
    const staleStatus = await h.engine.subagentStatus({});
    assert.equal(staleStatus.paused, true, '过期必须显式暂停（不静默）');
    assert.equal(staleStatus.pauseReason.code, 'subagent-refs-incomplete');

    // ② 快照缺失
    h.store.deleteMeta(SUBSCAN_META.at);
    h.engine.invalidate();
    assert.deepEqual((await h.engine.subagentCandidates()).map((row) => row.session_id), []);
    assert.equal((await h.engine.migrate(id, { class: 'subagent' })).code, 'refs-incomplete');

    // ③ gaps 非空（有坏目录）⇒ 同样零搬移，且原因里点名 gap
    await h.addSession('broken-gap', { noGeneration: true });
    await h.engine.scanHeaderFacts({ force: true });
    assert.deepEqual((await h.engine.subagentCandidates()).map((row) => row.session_id), [], 'gaps 非空 ⇒ 零候选（fail-closed）');
    const blocked = await h.engine.migrate(id, { class: 'subagent' });
    assert.equal(blocked.code, 'refs-incomplete', JSON.stringify(blocked));
    const gapStatus = await h.engine.subagentStatus({});
    assert.equal(gapStatus.paused, true);
    assert.deepEqual(gapStatus.scanGaps.map((gap) => gap.id), ['broken-gap'], 'gaps 必须逐条列出 id');

    // ④ 修好坏目录后重新扫描 ⇒ 自动解除（不做静默豁免）
    await rm(path.join(h.paths.sessionsRoot, h.pk, 'broken-gap'), { recursive: true, force: true });
    await h.engine.scanHeaderFacts({ force: true });
    const healthy = await h.engine.subagentStatus({});
    assert.equal(healthy.paused, false);
    assert.deepEqual((await h.engine.subagentCandidates()).map((row) => row.session_id), [id], '缺口清零后恢复候选');
  } finally {
    await h.dispose();
  }
});

test('A-P4-5：恢复冷却期（restored_at + N 天）内不再被搬（评审 #5 裁定 A）', async () => {
  const h = await createHarness();
  try {
    const id = 'sub-cooldown';
    await seedSubagent(h, id, { origin: 'subagent', patch: { restored_at: h.clock.now - 2 * DAY } });
    assert.deepEqual((await h.engine.subagentCandidates()).map((row) => row.session_id), [], '刚恢复 2 天 ⇒ 冷却期内');
    const blocked = await h.engine.migrate(id, { class: 'subagent' });
    assert.equal(blocked.code, 'restored-recent', JSON.stringify(blocked));
    // 冷却期也过了 ⇒ 恢复候选
    h.store.updateSession(id, { restored_at: h.clock.now - 20 * DAY });
    h.engine.invalidate();
    assert.deepEqual((await h.engine.subagentCandidates()).map((row) => row.session_id), [id]);
  } finally {
    await h.dispose();
  }
});

test('A-P4-7（负向）：恢复只搬回 + stat + status=hot，零 unarchiveSession / attachSession 调用', async () => {
  const h = await createHarness();
  try {
    const id = 'sub-p4-7';
    await seedSubagent(h, id, { origin: 'subagent', depth: 1 });
    assert.equal((await h.engine.migrate(id, { class: 'subagent' })).ok, true);
    assert.equal(h.calls.unarchive.length, 0);

    const result = await h.engine.restore(id);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, 'hot');
    assert.equal(result.class, 'subagent');
    assert.equal(await exists(h.hotDir(id)), true, '热目录必须回来');
    assert.equal(await exists(h.coldDir(id)), false, '冷目录必须搬走');
    const row = h.store.getSession(id);
    assert.equal(row.status, 'hot');
    assert.equal(row.cold_root, null);
    assert.equal(row.restored_at, h.clock.now, 'restored_at 必须写（冷却期的依据）');
    // 负向断言（I-16 / A-P4-7）：两个宿主方法一次都没被调用
    assert.equal(h.calls.unarchive.length, 0, 'class S 恢复不得调用 unarchiveSession');
    assert.equal(h.calls.attach.length, 0, 'class S 恢复不得调用 attachSession');
    assert.equal(h.archived.has(id), false, '归档集合零改动');
    assert.ok(h.calls.stat.length >= 1, '必须做 persistence.stat 可见性校验');
    // manifest 的恢复行同样带 class=subagent
    const records = (await readFile(h.paths.manifestPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const restoreRecord = records.filter((record) => record.op === 'restore' && record.id === id).pop();
    assert.ok(restoreRecord, 'manifest 必须有恢复行');
    assert.equal(restoreRecord.class, 'subagent');
    // 再恢复一次 ⇒ not-cold（幂等，不重复搬）
    const again = await h.engine.restore(id);
    assert.equal(again.ok, false);
    assert.equal(again.code, 'not-cold');
  } finally {
    await h.dispose();
  }
});

test('A-P4-8（负向）：class S 冷行不进 A-13（external-unarchived），recoverOnBoot 不误标', async () => {
  const h = await createHarness();
  try {
    const subId = 'sub-cold-row';
    await seedSubagent(h, subId, { origin: 'subagent' });
    assert.equal((await h.engine.migrate(subId, { class: 'subagent' })).ok, true);
    assert.equal(h.store.getSession(subId).status, 'cold');
    assert.equal(h.store.getSession(subId).error, null);

    // 对账：class S 冷行不得被标 external-unarchived（P-2 的原样重现点）
    const counts = { externalUnarchived: 0, flipped: 0 };
    await h.engine.reconcileRegistry(counts);
    assert.equal(counts.externalUnarchived, 0, 'class S 冷行不进 A-13（I-17）');
    assert.equal(h.store.getSession(subId).error, null);

    // 对照：class A 的冷行（不在归档集合里）仍然按 A-13 拦截（class A 语义一字不改）
    h.addRow('legacy-cold', { status: 'cold', cold_root: h.paths.coldRootDefault });
    const counts2 = { externalUnarchived: 0, flipped: 0 };
    await h.engine.reconcileRegistry(counts2);
    assert.equal(counts2.externalUnarchived, 1, 'class A 的 A-13 拦截面必须保持原样');
    assert.equal(h.store.getSession('legacy-cold').error, 'external-unarchived');
    assert.equal(h.store.getSession(subId).error, null, 'class S 行不能因为别人的 A-13 被连坐');

    // 启动收敛整体跑一遍：class S 行既不被标 lost、也不被标 external-unarchived
    const boot = await h.engine.recoverOnBoot();
    assert.equal(boot.ok, true);
    const after = h.store.getSession(subId);
    assert.equal(after.status, 'cold');
    assert.equal(after.error, null, 'class S 冷行在启动收敛后仍保持 error=null');
  } finally {
    await h.dispose();
  }
});

test('A-P4-5 / A-P4-6：迁移后复检失败 ⇒ 立即搬回热目录（不留在冷侧）', async () => {
  const h = await createHarness();
  try {
    const id = 'sub-race';
    await seedSubagent(h, id, { origin: 'subagent' });
    // 制造竞态：preflight 的活跃判据（第 1 次）返回 false，迁移**后**复检（第 2 次）返回 true
    // ⇒ 命中 race-active 并立即搬回（FR-P4-4 的后置条件）。
    let calls = 0;
    h.engine.deps.isActive = async () => {
      calls += 1;
      return calls > 1;
    };
    const result = await h.engine.migrate(id, { class: 'subagent' });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, 'race-active', JSON.stringify(result));
    assert.equal(await exists(h.hotDir(id)), true, '必须搬回热目录（不留半截）');
    assert.equal(await exists(h.coldDir(id)), false, '冷侧不得残留');
    const row = h.store.getSession(id);
    assert.equal(row.status, 'hot');
    assert.equal(row.error, 'race-active');
    assert.equal(await exists(h.markerPath(id)), false, '搬回后 marker 必须清掉');
  } finally {
    await h.dispose();
  }
});

test('A-P4-12（负向）：离线恢复脚本读 manifest class，class S 不写 --write-workspace', async () => {
  const h = await createHarness();
  try {
    const archivedId = 'script-archived';
    const subagentId = 'script-subagent';
    const coldA = path.join(h.paths.coldRootDefault, h.pk, archivedId);
    const coldS = path.join(h.paths.coldRootDefault, h.pk, subagentId);
    for (const pair of [[archivedId, coldA], [subagentId, coldS]]) {
      const id = pair[0];
      const dir = pair[1];
      await mkdir(dir, { recursive: true });
      const lines = [headerLine(id, h.cwd)].concat(bodyLines());
      await writeFile(
        path.join(dir, 'session.v4.jsonl.zstd'),
        Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line + '\n')))),
      );
    }
    const shaA = await hashTreeOf(coldA);
    const shaS = await hashTreeOf(coldS);
    const records = [
      { ts: 1, op: 'migrate', id: archivedId, from: null, to: coldA, bytes: 1, files: 1, sha256: shaA, ok: true },
      { ts: 2, op: 'migrate', id: subagentId, from: null, to: coldS, bytes: 1, files: 1, sha256: shaS, ok: true, class: 'subagent' },
    ];
    await mkdir(path.dirname(h.paths.manifestPath), { recursive: true });
    await writeFile(h.paths.manifestPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const workspaceFile = path.join(h.home, 'storages', 'workspace.json');
    await mkdir(path.dirname(workspaceFile), { recursive: true });
    await writeFile(
      workspaceFile,
      JSON.stringify({ global: { archivedSessionIds: [] }, tables: { workspaces: [{ path: h.cwd, sessionIds: [] }] } }),
    );

    const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'vault-restore.mjs');
    const run = spawnSync(
      process.execPath,
      [script, '--apply', '--write-workspace', '--home', h.home, '--manifest', h.paths.manifestPath],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, '脚本必须成功退出：' + run.stdout + run.stderr);
    const workspace = JSON.parse(await readFile(workspaceFile, 'utf8'));
    const slots = workspace.tables.workspaces[0].sessionIds;
    assert.ok(slots.includes(archivedId), 'class A 的会话按 --write-workspace 写回（原行为不变）');
    assert.equal(slots.includes(subagentId), false, 'class S 的会话绝不写回 workspace.json（A-P4-12 负向）');
    assert.equal(await exists(path.join(h.paths.sessionsRoot, h.pk, subagentId)), true, 'class S 也要被搬回热目录');
    assert.match(run.stdout, /子代理会话/, '输出必须标出 class S');
  } finally {
    await h.dispose();
  }
});

test('A-P4-9（引擎侧）：list 的 class 三值分域（默认不含子代理行；subagent 同时给候选与冷存行）', async () => {
  const h = await createHarness();
  try {
    // class A：归档 + 热（走原来的热归档行）
    const archivedId = 'class-a-hot';
    await h.addSession(archivedId);
    h.addRow(archivedId);
    h.archived.add(archivedId);
    // class S：一个热的候选 + 一个已冷存的
    const hotSubId = 'class-s-hot';
    await seedSubagent(h, hotSubId, { origin: 'subagent' });
    const coldSubId = 'class-s-cold';
    await seedSubagent(h, coldSubId, { origin: 'subagent' });
    assert.equal((await h.engine.migrate(coldSubId, { class: 'subagent' })).ok, true);
    h.engine.invalidate();

    const byDefault = await h.engine.list();
    const defaultIds = byDefault.items.map((item) => item.id);
    assert.ok(defaultIds.includes(archivedId), '默认视图必须有 class A 的行');
    assert.equal(defaultIds.includes(hotSubId), false, '默认视图不得出现子代理候选（D-S5）');
    assert.equal(defaultIds.includes(coldSubId), false, '默认视图不得出现子代理冷行');
    assert.equal(byDefault.items.find((item) => item.id === archivedId).class, 'archived');
    assert.equal(byDefault.subagent, null, '默认视图不带子代理段');
    assert.equal(byDefault.banners.externalUnarchived, 0, 'class S 冷行不得计入 external-unarchived（I-17）');

    const subagentView = await h.engine.list({ class: 'subagent' });
    const subItems = subagentView.items;
    assert.deepEqual(subItems.map((item) => item.id).sort(), [coldSubId, hotSubId].sort(), '子代理页 = 候选 + 已冷存');
    assert.equal(subItems.every((item) => item.class === 'subagent'), true);
    assert.equal(subItems.find((item) => item.id === hotSubId).status, 'hot-subagent', '候选状态 = hot-subagent');
    assert.equal(subItems.find((item) => item.id === coldSubId).status, 'cold', '冷存状态 = cold');
    assert.equal(subagentView.stats.subagentCandidates, 1);
    assert.equal(subagentView.stats.subagentCold, 1);
    assert.equal(subagentView.subagent.candidates, 1);
    assert.equal(subagentView.subagent.cold, 1);
    assert.ok(subagentView.subagent.scanAt > 0, '子代理页必须带上次扫描时间');

    const allView = await h.engine.list({ class: 'all' });
    assert.deepEqual(allView.items.map((item) => item.id).sort(), [archivedId, hotSubId, coldSubId].sort());

    let invalid = null;
    try {
      await h.engine.list({ class: 'bogus' });
    } catch (err) {
      invalid = err;
    }
    assert.ok(invalid, '非法 class 必须报错（不静默回退成 archived）');
    assert.equal(invalid.code, 'invalid-class');
  } finally {
    await h.dispose();
  }
});

test('P4 FR-P4-7：手动批量（进度 / 取消 / 显式 ids 也过资格）+ 作业互斥', async () => {
  const h = await createHarness();
  try {
    await seedSubagent(h, 'job-a', { origin: 'subagent' });
    await seedSubagent(h, 'job-b', { origin: 'subagent' });
    await seedSubagent(h, 'job-ref', { origin: 'subagent' });
    h.addRow('job-child', { parent_session: 'job-ref' });
    h.engine.invalidate();

    // 显式 ids 也要过七条：被引用 / 不存在的 id 一律进 rejected，不搬
    const started = await h.engine.startSubagentJob({ ids: ['job-a', 'job-b', 'job-ref', 'ghost-id'] });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.job.total, 2, '只有两个合格：' + JSON.stringify(started.job));
    assert.equal(started.job.rejected.some((row) => row.id === 'job-ref' && row.code === 'referenced'), true, '被引用必须 rejected');
    assert.equal(started.job.rejected.some((row) => row.id === 'ghost-id' && row.code === 'unknown-session'), true, '不存在的 id 必须 rejected');
    await started.wait();
    const done = h.engine.subagentJobSnapshot();
    assert.equal(done.id, started.job.id);
    assert.equal(done.running, false);
    assert.equal(done.done, 2);
    assert.equal(done.migrated, 2);
    assert.equal(done.failed, 0);
    assert.equal(done.progress, 100, '进度必须可读（0..100）');
    assert.equal(h.store.getSession('job-a').status, 'cold');
    assert.equal(h.store.getSession('job-ref').status, 'hot', '被引用的一条绝不搬');
    // 进度落 meta（跨重启读得到）
    assert.ok(h.store.getMeta('subscan:job'), 'subscan:job 必须落库');

    // ① 互斥：起一个 3 项的作业，立刻再起一个 ⇒ job-running
    for (const id of ['job-c', 'job-d', 'job-e']) await seedSubagent(h, id, { origin: 'subagent' });
    h.engine.invalidate();
    const running = await h.engine.startSubagentJob({ all: true });
    assert.equal(running.ok, true, JSON.stringify(running));
    assert.equal(running.job.total, 3);
    const second = await h.engine.startSubagentJob({ all: true });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'job-running', '同一时刻只允许一个批量作业');
    await running.wait();

    // ② 取消：起一个作业后**立刻**取消（不等任何一步）⇒ 剩余项不再搬，在飞的一条会跑完
    for (const id of ['job-f', 'job-g', 'job-h']) await seedSubagent(h, id, { origin: 'subagent' });
    h.engine.invalidate();
    const cancelable = await h.engine.startSubagentJob({ all: true });
    assert.equal(cancelable.ok, true, JSON.stringify(cancelable));
    assert.equal(cancelable.job.total, 3);
    const cancelled = h.engine.cancelSubagentJob();
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    assert.equal(cancelled.job.cancelled, true);
    await cancelable.wait();
    const after = h.engine.subagentJobSnapshot();
    assert.equal(after.cancelled, true);
    assert.equal(after.done < after.total, true, '取消后剩余项不再搬（在飞的一条会跑完）');
    const again = h.engine.cancelSubagentJob();
    assert.equal(again.ok, false, '没有在跑的作业 ⇒ 幂等回 no-job');
    assert.equal(again.code, 'no-job');
  } finally {
    await h.dispose();
  }
});
