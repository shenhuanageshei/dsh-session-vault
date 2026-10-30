import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes, readdir, stat } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { resolveVaultPaths, createConfigStore } from '../lib/config.js';
import { VaultStore } from '../lib/store.js';
import { VaultEngine, projectKey, SUBSCAN_META } from '../lib/engine.js';
import { VaultIndexer } from '../lib/indexer.js';
import {
  Sweeper,
  sweepBackoffMs,
  sweepDayKey,
  FIRST_SWEEP_DELAY_MS,
  ROUND_LIMIT,
  SUBAGENT_PAUSE_CODES,
} from '../lib/sweeper.js';

const quiet = { info() {}, warn() {}, error() {} };
/** 文件/目录存在性（迁移断言要判热/冷**目录**）。 */
const pathExistsSweep = (target) => stat(target).then(() => true).catch(() => false);
/** 固定假时钟（可注入 now）：2027-01-15T08:00:00Z 附近，远离测试机真实时间。 */
const T0 = 1800000000000;

function frames(id, cwd) {
  return [
    JSON.stringify({ type: 'request/header', sessionId: id, cwd, createdAt: 1791000000000 }),
    JSON.stringify({
      type: 'user/message', seq: 1, ts: 1791000001000,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '自动清扫样本会话' }] },
    }),
    JSON.stringify({
      type: 'assistant/message', seq: 2, ts: 1791000002000,
      data: { message: { content: [{ type: 'text', text: '可以搬走了' }] } },
    }),
  ];
}

async function createHarness(options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-sweep-'));
  const paths = resolveVaultPaths(home);
  const cwd = '<workspace-root>\\demo';
  const pk = projectKey(cwd);
  const archived = new Set();
  const clock = { now: options.now === undefined ? T0 : options.now };
  const registry = {
    archivedSessionIds: archived,
    async archiveSession(id) { archived.add(String(id)); },
    async unarchiveSession(id) { archived.delete(String(id)); },
    async resolveByPath() { return undefined; },
  };
  const persistence = {
    async list() { return []; },
    async stat() { return undefined; },
  };
  const configStore = createConfigStore({ home, paths });
  const baseConfig = { autoMigrate: true, archiveAgeDays: 14, dailyBudgetCount: 20, sweepIntervalMinutes: 30 };
  await configStore.save({ ...baseConfig, ...(options.config || {}) });
  const store = await VaultStore.open(paths.dbPath);
  const engine = new VaultEngine({
    home, paths, configStore, store, registry, persistence,
    logger: quiet,
    now: () => clock.now,
    isActive: async () => Boolean(options.active),
    sameVolume: options.sameVolume,
    detectAm: options.detectAm,
    resolveWorkspace: async () => undefined,
  });

  async function addSession(id, opts = {}) {
    const dir = path.join(paths.sessionsRoot, pk, id);
    await mkdir(dir, { recursive: true });
    // 夹具修正（A-P4-5 / gaps fail-closed）：`noGeneration` 造「没有合法代际」的坏目录。
    // 旧夹具忽略该选项 ⇒ 所谓坏目录其实带合法代际，header 事实扫描永远没有缺口，
    // 「gaps 非空 ⇒ 暂停且一个都不搬」这条用例形同虚设（断言永远走不到暂停分支）。
    if (opts.noGeneration) {
      await writeFile(path.join(dir, 'not-a-generation.txt'), 'junk');
    } else {
      const logs = opts.logs || { 'session.v4.jsonl.zstd': frames(id, cwd) };
      for (const [name, lines] of Object.entries(logs)) {
        await writeFile(path.join(dir, name), Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line + '\n')))));
      }
    }
    return dir;
  }

  function sweeper(overrides = {}) {
    return new Sweeper({ engine, logger: quiet, now: () => clock.now, ...overrides });
  }

  return {
    home, paths, cwd, pk, archived, clock, registry, persistence, configStore, store, engine,
    addSession, sweeper,
    hotDir: (id) => path.join(paths.sessionsRoot, pk, id),
    coldDir: (id) => path.join(paths.coldRootDefault, pk, id),
    async dispose() {
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** 建一条归档会话并让它在「上次活跃」上落在 daysAgo 天前（写入 row + 文件 mtime）。 */
async function seedArchived(h, id, daysAgo = 20) {
  await h.addSession(id);
  h.archived.add(id);
  await h.engine.backfillArchivedAt({});
  const stamp = h.clock.now - daysAgo * 86400000;
  h.store.updateSession(id, { file_mtime_ms: stamp, created_at: stamp });
  const file = path.join(h.hotDir(id), 'session.v4.jsonl.zstd');
  const date = new Date(stamp);
  await utimes(file, date, date).catch(() => {});
  h.engine.invalidate();
  return id;
}

test('P2-1 A-8：到期才迁；改阈值后**下一次清扫**立即按新值执行（不重启、不重建实例）', async () => {
  const h = await createHarness();
  try {
    await seedArchived(h, 'session-sweep-old', 20);
    await seedArchived(h, 'session-sweep-young', 2);
    const sweeper = h.sweeper();

    const first = await sweeper.sweep();
    assert.equal(first.skipped, undefined, JSON.stringify(first));
    assert.equal(first.migrated, 1, JSON.stringify(first));
    assert.equal(h.store.getSession('session-sweep-old').status, 'cold', '20 天没动 ⇒ 迁移');
    assert.equal(h.store.getSession('session-sweep-young').status, 'hot', '2 天没动 ⇒ 不到 14 天，不迁');

    // A-8：阈值 14 → 1 天；**同一个 sweeper 实例**的下一次清扫必须用新值
    const saved = await h.configStore.save({ archiveAgeDays: 1 });
    assert.equal(saved.ok, true, JSON.stringify(saved.errors));
    h.engine.invalidate();
    const second = await sweeper.sweep();
    assert.equal(second.migrated, 1, JSON.stringify(second));
    assert.equal(h.store.getSession('session-sweep-young').status, 'cold', '改阈值后下一次清扫立即生效（A-8）');

    // archiveAgeDays=0 = 关闭：一个都不迁
    await h.configStore.save({ archiveAgeDays: 0 });
    await seedArchived(h, 'session-sweep-zero', 400);
    const third = await sweeper.sweep();
    assert.equal(third.skipped, 'threshold-off', JSON.stringify(third));
    assert.equal(h.store.getSession('session-sweep-zero').status, 'hot');
  } finally {
    await h.dispose();
  }
});

test('P2-1 S-1：日预算 dailyBudgetCount 生效并在跨日重置', async () => {
  const h = await createHarness({ config: { dailyBudgetCount: 2 } });
  try {
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seedArchived(h, 'session-budget-' + i, 30));
    const sweeper = h.sweeper();

    const first = await sweeper.sweep();
    assert.equal(first.migrated, 2, JSON.stringify(first));
    assert.equal(first.budget.used, 2);
    assert.equal(first.budget.limit, 2);
    assert.equal(ids.filter((id) => h.store.getSession(id).status === 'cold').length, 2);

    const second = await sweeper.sweep();
    assert.equal(second.skipped, 'budget-exhausted', JSON.stringify(second));
    assert.equal(ids.filter((id) => h.store.getSession(id).status === 'cold').length, 2, '预算耗尽后不得再迁');

    // 跨日：预算键按日期分桶 ⇒ 次日恢复额度
    h.clock.now += 86400000;
    h.engine.invalidate();
    const third = await sweeper.sweep();
    assert.equal(third.migrated, 2, JSON.stringify(third));
    assert.equal(third.budget.used, 2);
    assert.equal(ids.filter((id) => h.store.getSession(id).status === 'cold').length, 4);
  } finally {
    await h.dispose();
  }
});

test('P2-1 失败退避：next_attempt = now + min(6h, 5min * 2^n)，退避期内不再重试', async () => {
  const h = await createHarness();
  try {
    const id = await seedArchived(h, 'session-backoff', 30);
    const sweeper = h.sweeper();
    h.engine.migrate = async () => ({ id, ok: false, code: 'boom', error: 'simulated failure' });

    const first = await sweeper.sweep();
    assert.equal(first.failed, 1, JSON.stringify(first));
    assert.equal(h.store.getSession(id).next_attempt, h.clock.now + 5 * 60000, 'n=1 ⇒ 5 分钟退避');

    const second = await sweeper.sweep();
    assert.equal(second.candidates, 0, '退避期内不得进候选');
    assert.equal(second.attempted, 0);

    h.clock.now += 5 * 60000;
    const third = await sweeper.sweep();
    assert.equal(third.attempted, 1, JSON.stringify(third));
    assert.equal(h.store.getSession(id).next_attempt, h.clock.now + 10 * 60000, 'n=2 ⇒ 10 分钟退避');

    assert.equal(sweepBackoffMs(0), 5 * 60000);
    assert.equal(sweepBackoffMs(1), 10 * 60000);
    assert.equal(sweepBackoffMs(2), 20 * 60000);
    assert.equal(sweepBackoffMs(10), 6 * 60 * 60000, '封顶 6 小时');
  } finally {
    await h.dispose();
  }
});

test('P2-1 暂停条件：autoMigrate/threshold/AM/冷根/跨卷/restoring/external-unarchived', async () => {
  // ① autoMigrate 关（默认关 = 观察模式，D20）
  {
    const h = await createHarness({ config: { autoMigrate: false } });
    try {
      const report = await h.sweeper().sweep();
      assert.equal(report.skipped, 'auto-migrate-off', JSON.stringify(report));
    } finally { await h.dispose(); }
  }
  // ② AM 在场（AC-9 / A-18）：不装包装、清扫 no-op
  {
    const h = await createHarness({
      detectAm: async () => ({ present: true, matches: [{ id: '@michengai/dsh-archive-manager' }], sources: ['injected'] }),
    });
    try {
      const id = await seedArchived(h, 'session-pause-am', 30);
      const report = await h.sweeper().sweep();
      assert.equal(report.skipped, 'archive-manager', JSON.stringify(report));
      assert.equal(h.store.getSession(id).status, 'hot', 'AM 在场时一个都不迁');
    } finally { await h.dispose(); }
  }
  // ③ coldRoot 不可用（A-7：只读降级，不搬移）
  {
    const h = await createHarness();
    try {
      const id = await seedArchived(h, 'session-pause-cold', 30);
      await writeFile(path.join(h.home, 'blocked-cold'), 'x');
      const saved = await h.configStore.save({ coldRoot: path.join(h.home, 'blocked-cold', 'cold') });
      assert.equal(saved.ok, true, JSON.stringify(saved.errors));
      const report = await h.sweeper().sweep();
      assert.equal(report.skipped, 'cold-unavailable', JSON.stringify(report));
      assert.equal(h.store.getSession(id).status, 'hot');
    } finally { await h.dispose(); }
  }
  // ④ 跨卷未开启（D13）
  {
    const h = await createHarness({ sameVolume: async () => false, config: { allowCrossVolume: false } });
    try {
      const report = await h.sweeper().sweep();
      assert.equal(report.skipped, 'cross-volume-disabled', JSON.stringify(report));
    } finally { await h.dispose(); }
  }
  // ⑤ restoring 未收敛（R-14）
  {
    const h = await createHarness();
    try {
      h.store.upsertSession({
        session_id: 'session-pause-restoring', project_key: h.pk, rel_dir: h.pk + '/session-pause-restoring',
        log_names: 'session.v4.jsonl.zstd', format_version: 4, status: 'restoring', source_sha: '',
      });
      const report = await h.sweeper().sweep();
      assert.equal(report.skipped, 'restoring-unsettled', JSON.stringify(report));
      assert.ok(Array.isArray(report.paused.ids) && report.paused.ids.includes('session-pause-restoring'));
    } finally { await h.dispose(); }
  }
  // ⑥ external-unarchived 未收敛（A-13）
  {
    const h = await createHarness();
    try {
      h.store.upsertSession({
        session_id: 'session-pause-ext', project_key: h.pk, rel_dir: h.pk + '/session-pause-ext',
        log_names: 'session.v4.jsonl.zstd', format_version: 4, status: 'cold', cold_root: h.paths.coldRootDefault,
        error: 'external-unarchived', source_sha: '',
      });
      const report = await h.sweeper().sweep();
      assert.equal(report.skipped, 'external-unarchived-unsettled', JSON.stringify(report));
    } finally { await h.dispose(); }
  }
});

test('P2-1：候选覆盖「registry 已归档但 DB 未入库」的存量行（清扫前先入库）', async () => {
  const h = await createHarness();
  try {
    const id = 'session-unregistered';
    await seedArchived(h, id, 30);
    // 模拟「首启时没入库」：删掉行（回填前置的现场）
    h.store.deleteSession(id);
    h.engine.invalidate();
    assert.equal(h.store.getSession(id), null, '前提：DB 无行');

    const sweeper = h.sweeper();
    const report = await sweeper.sweep();
    assert.ok(report.backfilled >= 1, '清扫必须先回填入库：' + JSON.stringify(report));
    assert.equal(report.migrated, 1, JSON.stringify(report));
    assert.equal(h.store.getSession(id).status, 'cold', '入库后按到期条件迁移');
  } finally {
    await h.dispose();
  }
});

test('P2-1 定时器：60s 首扫 + 此后 sweepIntervalMinutes（ctx.setInterval + dispose，A-8 改间隔即生效）', async () => {
  const h = await createHarness();
  try {
    const scheduled = { timeouts: [], intervals: [], cleared: 0 };
    const scheduler = {
      after(fn, ms) { scheduled.timeouts.push({ fn, ms }); return () => { scheduled.cleared += 1; }; },
      every(fn, ms) { scheduled.intervals.push({ fn, ms }); return () => { scheduled.cleared += 1; }; },
    };
    const sweeper = new Sweeper({ engine: h.engine, logger: quiet, now: () => h.clock.now, scheduler });
    sweeper.start();
    assert.equal(scheduled.timeouts.length, 1);
    assert.equal(scheduled.timeouts[0].ms, FIRST_SWEEP_DELAY_MS, '启动后 60s 首扫');
    assert.equal(FIRST_SWEEP_DELAY_MS, 60000);
    assert.equal(sweeper.snapshot().nextRunAt, h.clock.now + 60000);

    // 让本轮不做真实迁移，只验证排程
    sweeper.sweep = async () => ({ ok: true, migrated: 0 });
    await scheduled.timeouts[0].fn();
    assert.equal(scheduled.intervals.length, 1, '首扫后必须挂上 ctx.setInterval');
    assert.equal(scheduled.intervals[0].ms, 30 * 60000);

    // A-8：改清扫间隔 ⇒ 下一次 tick 重建 interval
    const saved = await h.configStore.save({ sweepIntervalMinutes: 5 });
    assert.equal(saved.ok, true, JSON.stringify(saved.errors));
    await scheduled.intervals[0].fn();
    assert.equal(scheduled.intervals.length, 2, '间隔变化后必须重建定时器');
    assert.equal(scheduled.intervals[1].ms, 5 * 60000);
    assert.equal(sweeper.snapshot().intervalMs, 5 * 60000);

    sweeper.stop();
    assert.ok(scheduled.cleared >= 2, 'stop() 必须释放定时器（dispose）');
    assert.equal(sweeper.snapshot().started, false);
    assert.equal(sweeper.snapshot().nextRunAt, null);
    assert.deepEqual([ROUND_LIMIT], [5], '单轮上限固定 5（§9）');
    assert.equal(sweepDayKey(T0), new Date(T0).toISOString().slice(0, 10));
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// P4 / A-P4-5 + A-P4-9：子代理会话冷存的自动清扫（class S 与 class A 完全分域）
// ---------------------------------------------------------------------------

function subagentHeaderLine(id, cwd, extra = {}) {
  return JSON.stringify(Object.assign({ type: 'request/header', sessionId: id, cwd, createdAt: 1791000000000 }, extra));
}

/** 造一个「合格但可能失败」的 class S 候选（header 走真实 zstd 首帧，年龄落在 N 天前）。 */
async function seedSubagentSweep(h, id, opts = {}) {
  const lines = [subagentHeaderLine(id, h.cwd, { origin: 'subagent', delegationDepth: 1 })].concat(frames(id, h.cwd).slice(1));
  const dir = await h.addSession(id, { logs: { 'session.v4.jsonl.zstd': lines } });
  if (opts.extraFile) await writeFile(path.join(dir, opts.extraFile), 'junk');
  const daysAgo = opts.daysAgo === undefined ? 20 : opts.daysAgo;
  const stamp = h.clock.now - daysAgo * 86400000;
  h.store.upsertSession({
    session_id: id,
    project_key: h.pk,
    rel_dir: h.pk + '/' + id,
    log_names: 'session.v4.jsonl.zstd',
    format_version: 4,
    bytes: 100,
    file_size: 100,
    file_mtime_ms: stamp,
    header_cwd: h.cwd,
    created_at: stamp,
    status: 'hot',
    source_sha: 'sha-' + id,
  });
  await h.engine.scanHeaderFacts({ force: true });
  const date = new Date(stamp);
  for (const name of await readdir(dir).catch(() => [])) {
    await utimes(path.join(dir, name), date, date).catch(() => {});
  }
  h.store.updateSession(id, { file_mtime_ms: stamp, created_at: stamp });
  h.engine.invalidate();
  return dir;
}

test('P4 A-P4-9：class S 与 class A 同一拍各跑各的 —— 独立预算键 subscan:budget:<UTC 日>', async () => {
  const h = await createHarness({ config: { autoMigrate: false, subagentMigrate: true, subagentAgeDays: 14, subagentDailyBudgetCount: 2 } });
  try {
    for (const id of ['sub-b1', 'sub-b2', 'sub-b3']) await seedSubagentSweep(h, id);
    const sweeper = h.sweeper();
    const first = await sweeper.sweep();
    assert.equal(first.skipped, 'auto-migrate-off', 'class A 仍按 autoMigrate=false 早退（行为不变）');
    assert.equal(first.subagent.migrated, 2, 'class S 按自己的日预算 2 个搬：' + JSON.stringify(first.subagent));
    const coldIds = ['sub-b1', 'sub-b2', 'sub-b3'].filter((id) => h.store.getSession(id).status === 'cold');
    assert.equal(coldIds.length, 2);
    const day = new Date(h.clock.now).toISOString().slice(0, 10);
    assert.equal(h.store.getMeta('subscan:budget:' + day), '2', '预算键必须是 subscan:budget:<UTC 日>');
    assert.equal(h.store.getMeta('sweep:budget:' + day), null, 'class A 的预算键不得被 class S 写');

    const second = await sweeper.sweep();
    assert.equal(second.subagent.skipped, 'budget-exhausted', JSON.stringify(second.subagent));

    // 改预算 ⇒ 下一次立即按新值（A-8 同款：每次重新读配置）
    const saved = await h.configStore.save({ subagentDailyBudgetCount: 5 });
    assert.equal(saved.ok, true, JSON.stringify(saved.errors));
    h.engine.invalidate();
    const third = await sweeper.sweep();
    assert.equal(third.subagent.migrated, 1, '预算 5 ⇒ 剩余那一个搬走：' + JSON.stringify(third.subagent));
    for (const id of ['sub-b1', 'sub-b2', 'sub-b3']) {
      assert.equal(h.store.getSession(id).status, 'cold', id + '：三个最终都该在冷侧');
    }
  } finally {
    await h.dispose();
  }
});

test('P4 A-P4-5：失败退避用独立键 subscan:fail:<id>（不污染 class A 的 sweep:fail:*）', async () => {
  const h = await createHarness({ config: { autoMigrate: false, subagentMigrate: true, subagentDailyBudgetCount: 50 } });
  try {
    // 非代际文件 ⇒ 候选能进（候选只看 DB 行），但 preflight 会拒绝 unexpected-files
    const id = 'sub-fail';
    await seedSubagentSweep(h, id, { extraFile: 'junk.bin' });
    const sweeper = h.sweeper();
    const report = await sweeper.sweep();
    assert.equal(report.subagent.attempted, 1, JSON.stringify(report.subagent));
    assert.equal(report.subagent.failed, 1);
    const failure = report.subagent.results[0];
    assert.equal(failure.ok, false);
    assert.equal(failure.code, 'unexpected-files', JSON.stringify(failure));
    assert.equal(h.store.getMeta('subscan:fail:' + id), '1', '退避计数必须落独立键');
    assert.equal(h.store.getMeta('sweep:fail:' + id), null, 'class A 的退避键不得被写');
    const row = h.store.getSession(id);
    assert.equal(row.status, 'hot', '失败不搬（源目录保留）');
    assert.ok(row.next_attempt > h.clock.now, '失败必须写 next_attempt 退避');
    assert.equal(await pathExistsSweep(h.hotDir(id)), true, '源目录一个文件都不能动');
  } finally {
    await h.dispose();
  }
});

test('P4 A-P4-5：pauseReasonS 四条原因全在（且与 class A 的 pauseReason 分开）', async () => {
  const h = await createHarness({ config: { autoMigrate: true, subagentMigrate: true } });
  try {
    const sweeper = h.sweeper();
    assert.deepEqual(
      sweeper.subagentSnapshot().pauseReasonOptions,
      ['subagent-refs-incomplete', 'cold-unavailable', 'cross-volume-disabled', 'restoring-unsettled'],
      '四条原因必须逐条可读（UI 黄条按这个顺序全列）',
    );
    assert.deepEqual(SUBAGENT_PAUSE_CODES, sweeper.subagentSnapshot().pauseReasonOptions);

    // ① cold-unavailable
    const probe = h.engine.probeColdRoots.bind(h.engine);
    h.engine.probeColdRoots = async () => [{ root: h.paths.coldRootDefault, available: false }];
    assert.equal((await sweeper.pauseReasonS({ allowCrossVolume: false })).code, 'cold-unavailable');
    h.engine.probeColdRoots = probe;

    // ② cross-volume-disabled
    const same = h.engine.sameVolume.bind(h.engine);
    h.engine.sameVolume = async () => false;
    assert.equal((await sweeper.pauseReasonS({ allowCrossVolume: false })).code, 'cross-volume-disabled');
    h.engine.sameVolume = same;

    // ③ refs-incomplete（快照缺失 ⇒ 不可信）
    assert.equal((await sweeper.pauseReasonS({ allowCrossVolume: true })).code, 'subagent-refs-incomplete');
    await h.engine.scanHeaderFacts({ force: true });
    assert.equal(await sweeper.pauseReasonS({ allowCrossVolume: true }), null, '新鲜且无缺口 ⇒ 不暂停');

    // ④ restoring-unsettled
    h.store.upsertSession({
      session_id: 'still-restoring',
      project_key: h.pk,
      rel_dir: h.pk + '/still-restoring',
      log_names: 'session.v4.jsonl.zstd',
      format_version: 4,
      bytes: 1,
      file_size: 1,
      file_mtime_ms: h.clock.now,
      created_at: h.clock.now,
      status: 'restoring',
      source_sha: 'x',
    });
    const restoring = await sweeper.pauseReasonS({ allowCrossVolume: true });
    assert.equal(restoring.code, 'restoring-unsettled');
    assert.deepEqual(restoring.ids, ['still-restoring']);

    // 负向：class A 的 pauseReason 不会因为 class S 的这些条件而暂停（两套条件互相独立）
    h.store.deleteSession('still-restoring');
    const am = await h.engine.detectAm();
    assert.equal(am.present, false);
    assert.equal(await sweeper.pauseReason({ allowCrossVolume: true }), null, 'class A 的暂停条件不受 class S 影响');
  } finally {
    await h.dispose();
  }
});

test('P4 A-P4-5：gaps 非空 ⇒ 首扫补扫描后仍然暂停、一个都不搬（fail-closed）', async () => {
  const h = await createHarness({ config: { autoMigrate: false, subagentMigrate: true } });
  try {
    await seedSubagentSweep(h, 'sub-gap');
    await h.addSession('broken-p4', { noGeneration: true });
    const sweeper = h.sweeper();
    // 新鲜但带缺口的快照（坏目录读不到 header）⇒ _sweepSubagents 必须暂停、一个都不搬
    await h.engine.scanHeaderFacts({ force: true });
    const report = await sweeper.sweepSubagents();
    assert.equal(report.skipped, 'subagent-refs-incomplete', JSON.stringify(report));
    assert.equal(h.store.getSession('sub-gap').status, 'hot', '暂停时零搬移');
    assert.equal(await pathExistsSweep(h.hotDir('sub-gap')), true);
    assert.deepEqual(report.paused.gaps.map((gap) => gap.id), ['broken-p4'], '暂停原因必须逐条列出 gap');
    assert.equal(sweeper.subagentSnapshot().paused, true);
  } finally {
    await h.dispose();
  }
});

test('P4 A-P4-5：AM 在场只暂停 class A，不暂停 class S（两套暂停条件分开）', async () => {
  const h = await createHarness({
    config: { autoMigrate: true, subagentMigrate: true, subagentDailyBudgetCount: 50 },
    detectAm: async () => ({ present: true, matches: [{ id: '@michengai/dsh-archive-manager' }], sources: ['injected'] }),
  });
  try {
    await seedArchived(h, 'class-a-am', 20);
    await seedSubagentSweep(h, 'sub-am');
    const sweeper = h.sweeper();
    const report = await sweeper.sweep();
    assert.equal(report.skipped, 'archive-manager', 'class A 按 AC-9 暂停（行为不变）');
    assert.equal(h.store.getSession('class-a-am').status, 'hot', 'class A 一个都不搬');
    assert.equal(report.subagent.migrated, 1, 'AM 在场不得连带停掉 class S：' + JSON.stringify(report.subagent));
    assert.equal(h.store.getSession('sub-am').status, 'cold');
  } finally {
    await h.dispose();
  }
});

test('P4：subagentMigrate=false 时自动清扫不跑，但手动候选照常可读（开关只约束自动）', async () => {
  const h = await createHarness({ config: { autoMigrate: false, subagentMigrate: false } });
  try {
    await seedSubagentSweep(h, 'sub-manual');
    const sweeper = h.sweeper();
    const report = await sweeper.sweepSubagents();
    assert.equal(report.skipped, 'subagent-migrate-off');
    assert.deepEqual((await h.engine.subagentCandidates()).map((row) => row.session_id), ['sub-manual'], '手动候选不受开关限制');
    assert.equal(h.store.getSession('sub-manual').status, 'hot');
    assert.equal(sweeper.subagentSnapshot().migrate, false);
    // 阈值 0 = 关闭（自动与手动候选都为空）——开关开着也必须是 threshold-off
    await h.configStore.save({ subagentMigrate: true, subagentAgeDays: 0 });
    h.engine.invalidate();
    assert.deepEqual((await h.engine.subagentCandidates()).map((row) => row.session_id), [], '阈值 0 ⇒ 零候选');
    assert.equal((await sweeper.sweepSubagents()).skipped, 'threshold-off');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// P4 FR-P4-2（2026-10-27 审计 #2 / #3）：ENOENT 留痕 + scanPosture + DSH_HOME 判别器，
// 以及「只读 header 事实扫描」与 subagentMigrate 开关解耦（清扫 tick 前置 / 全量索引完成后）
// ---------------------------------------------------------------------------

test('P4 FR-P4-2（审计 #2）：sessions 根 ENOENT 且 DSH_HOME 可读 ⇒ 空集扫描 + warn + scanPosture=empty-root', async () => {
  const h = await createHarness({ config: { subagentMigrate: false } });
  try {
    const logs = [];
    h.engine.logger = {
      info(message) { logs.push(['info', String(message)]); },
      warn(message) { logs.push(['warn', String(message)]); },
      error(message) { logs.push(['error', String(message)]); },
    };
    // 夹具不建 sessionsRoot（只有 configStore/vault.db）⇒ readdir(sessionsRoot) 必 ENOENT，
    // 而 DSH_HOME（h.home）可读 ⇒ 判别器必须认定「空集」。
    assert.equal(await pathExistsSweep(h.paths.sessionsRoot), false, '前提：sessions 根不存在');
    assert.equal(await pathExistsSweep(h.paths.home), true, '前提：DSH_HOME 可读');

    const report = await h.engine.scanHeaderFacts({ force: true });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.code, undefined);
    assert.equal(report.posture, 'empty-root', 'ENOENT + DSH_HOME 可读 ⇒ 空集姿态');
    assert.equal(report.count, 0);
    assert.deepEqual(report.gaps, []);
    // 空集扫描照常落库（否则空机/新装永远停在 subagent-refs-incomplete）
    assert.equal(Number(h.store.getMeta(SUBSCAN_META.at)), h.clock.now, '空集扫描必须写 at');
    assert.equal(h.store.getMeta(SUBSCAN_META.posture), 'empty-root');
    assert.equal(h.engine.subscanSnapshot().posture, 'empty-root');
    assert.equal(h.engine.subscanSnapshot().fresh, true, '空集也是「新鲜且无缺口」的可信快照');
    const status = await h.engine.subagentStatus({ withCandidates: false });
    assert.equal(status.scanPosture, 'empty-root', '/status.subagent.scanPosture 必须给 empty-root');
    assert.equal(status.count + status.gaps.length, 0, '空集自检：count + gaps = 0');
    assert.equal(
      logs.some((entry) => entry[0] === 'warn' && /ENOENT/.test(entry[1])),
      true,
      'ENOENT 空集扫描必须 log(warn) 留痕（审计 #2：无日志的假完整快照不可接受）',
    );
  } finally {
    await h.dispose();
  }
});

test('P4 FR-P4-2（审计 #2）：ENOENT 但 DSH_HOME 也不可读 ⇒ fail-closed（sessions-unreadable，不写 at）；非 ENOENT 行为不变', async () => {
  const h = await createHarness();
  try {
    const logs = [];
    h.engine.logger = {
      info(message) { logs.push(['info', String(message)]); },
      warn(message) { logs.push(['warn', String(message)]); },
      error(message) { logs.push(['error', String(message)]); },
    };
    // 卷掉模拟：sessions 根与 DSH_HOME 都指向不存在的位置（Windows 上卷掉对两者同样返回 ENOENT）。
    const missing = path.join(h.home, 'missing-volume');
    h.engine.paths = Object.assign({}, h.paths, {
      sessionsRoot: path.join(missing, 'sessions'),
      home: missing,
    });
    const report = await h.engine.scanHeaderFacts({ force: true });
    assert.equal(report.ok, false);
    assert.equal(report.code, 'sessions-unreadable', JSON.stringify(report));
    assert.equal(h.store.getMeta(SUBSCAN_META.at), null, 'fail-closed：不得写 subscan:at');
    assert.equal(h.store.getMeta(SUBSCAN_META.posture), null, '读失败不写姿态（不冒充 empty-root）');
    assert.equal(h.engine.subscanSnapshot().posture, null);
    assert.equal(h.engine.subscanSnapshot().fresh, false, '没有 at ⇒ 快照不可信');
    assert.equal(
      logs.some((entry) => entry[0] === 'warn' && /DSH_HOME/.test(entry[1])),
      true,
      '判别器拒绝时必须留痕（说清是 DSH_HOME 也不可读）',
    );

    // EACCES/EIO 一类行为不变：sessions 根是「文件」而不是目录（Windows 上 ENOTDIR）⇒ 同样 fail-closed，
    // 且**不再多探一次 DSH_HOME**（非 ENOENT 分支）。
    const notDir = path.join(h.home, 'sessions-not-a-dir');
    await writeFile(notDir, 'x');
    h.engine.paths = Object.assign({}, h.paths, { sessionsRoot: notDir, home: missing });
    const notDirReport = await h.engine.scanHeaderFacts({ force: true });
    assert.equal(notDirReport.ok, false);
    assert.equal(notDirReport.code, 'sessions-unreadable');
    assert.equal(h.store.getMeta(SUBSCAN_META.at), null, '非 ENOENT 读失败同样不写 at');
  } finally {
    await h.dispose();
  }
});

test('P4 FR-P4-2（审计 #3）：subagentMigrate=false 时清扫 tick 仍会补扫过期的 header 事实', async () => {
  const h = await createHarness({ config: { autoMigrate: false, subagentMigrate: false } });
  try {
    // 一个**无 DB 行**的可读目录：既验证「扫描不被开关挡掉」，也验证 count 按目录口径算。
    await h.addSession('session-facts-only');
    assert.equal(h.store.getMeta(SUBSCAN_META.at), null, '前提：从未扫描');
    const sweeper = h.sweeper();
    const report = await sweeper.sweep();
    assert.equal(report.skipped, 'auto-migrate-off', 'class A 行为不变（开关仍然早退）');
    assert.equal(report.subagent.skipped, 'subagent-migrate-off', 'class S 自动迁移仍然不跑');
    assert.equal(Number(h.store.getMeta(SUBSCAN_META.at)), h.clock.now, '只读扫描与 subagentMigrate 解耦：过期就补扫');
    assert.equal(h.store.getMeta(SUBSCAN_META.posture), 'ok');
    assert.equal(Number(h.store.getMeta(SUBSCAN_META.count)), 1, '无 DB 行的可读目录也计入 count（§19.7 口径）');
    assert.equal(report.subscan.scanned, true, '报告必须如实说本轮补扫了');
    assert.equal(report.subscan.posture, 'ok');

    // 快照新鲜 ⇒ 下一拍不再全扫（IO 成本），但读数仍在。
    h.clock.now += 60 * 1000;
    const second = await sweeper.sweep();
    assert.equal(second.subscan.scanned, false, '24h 内不重复全扫');
    assert.equal(Number(h.store.getMeta(SUBSCAN_META.at)), h.clock.now - 60 * 1000, 'at 不被无谓重写');

    // 过期 ⇒ 重新补扫（>24h），且不被任何开关挡掉。
    h.clock.now += 24 * 60 * 60 * 1000 + 1000;
    const third = await sweeper.sweep();
    assert.equal(third.subscan.scanned, true, '超过 24h ⇒ 必须重扫');
    assert.equal(Number(h.store.getMeta(SUBSCAN_META.at)), h.clock.now);
  } finally {
    await h.dispose();
  }
});

test('P4 FR-P4-2（审计 #3）：全量索引完成后触发一次过期的 header 事实扫描', async () => {
  const h = await createHarness({ config: { subagentMigrate: false } });
  try {
    await h.addSession('session-indexed-facts');
    assert.equal(h.store.getMeta(SUBSCAN_META.at), null, '前提：从未扫描');
    const indexer = new VaultIndexer({ engine: h.engine, store: h.store, paths: h.paths, logger: quiet, now: () => h.clock.now });
    const progress = await indexer.runFullIndex();
    assert.equal(progress.phase, 'done', JSON.stringify(progress));
    assert.equal(Number(h.store.getMeta(SUBSCAN_META.at)), h.clock.now, '全量索引完成 ⇒ 补扫 header 事实');
    assert.equal(h.store.getMeta(SUBSCAN_META.posture), 'ok');
    assert.equal(Number(h.store.getMeta(SUBSCAN_META.count)), 1);
    assert.equal(h.engine.subscanSnapshot().fresh, true);
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// B8（2026-10-30 真机缺陷，**第二次重启后**实测）：B7 的自愈没落地 —— 两条根因各一个锚
//  ① pauseReason 只看库里的 error 列（不看**当前**归档集合）⇒ 历史误标把 class A 永久钉死；
//  ② registry 对账只在 recoverOnBoot() 里跑一次 ⇒ 启动时序一旦不巧，之后没有任何路径再跑。
// 真机读数：archived=119（19 个误标 id 全部在集合里），库里仍 19 条 error='external-unarchived'，
// pauseReason 照旧 external-unarchived-unsettled（ids=19），class A 继续暂停。
// ---------------------------------------------------------------------------

test('B8 A-13：external-unarchived 按**当前**归档集合判定（在集合内 ⇒ 不暂停；不在 ⇒ 仍暂停；registry 读不到 ⇒ 退回旧行为）', async () => {
  const h = await createHarness();
  try {
    h.store.upsertSession({
      session_id: 'session-b8-mislabel', project_key: h.pk, rel_dir: h.pk + '/session-b8-mislabel',
      log_names: 'session.v4.jsonl.zstd', format_version: 4, status: 'cold', cold_root: h.paths.coldRootDefault,
      error: 'external-unarchived', source_sha: '',
    });
    const sweeper = h.sweeper();

    // ① 历史误标 + id 在**当前**归档集合里（I-11 重新成立）⇒ class A 必须可跑
    h.archived.add('session-b8-mislabel');
    assert.equal(h.engine.archivedIds().has('session-b8-mislabel'), true, '前提：当前集合包含该 id');
    assert.equal(await sweeper.pauseReason({ allowCrossVolume: true }), null, '误标在集合内 ⇒ 不得暂停（B8 根因 ①）');

    // ② 同一行 id 不在集合里 ⇒ 仍暂停（A-13 的语义一个字节都不放宽）
    h.archived.delete('session-b8-mislabel');
    const paused = await sweeper.pauseReason({ allowCrossVolume: true });
    assert.equal(paused && paused.code, 'external-unarchived-unsettled', '集合里没有 ⇒ 仍是真未收敛：' + JSON.stringify(paused));
    assert.deepEqual(paused.ids, ['session-b8-mislabel'], '暂停原因必须逐条列出真正的未收敛 id');

    // ③ registry 读不到（抛错）⇒ 退回旧行为：仍按 error 列暂停（**不** fail-open 到「永不暂停」）
    h.archived.add('session-b8-mislabel');
    const archivedIds = h.engine.archivedIds;
    h.engine.archivedIds = () => { throw new Error('registry-unavailable'); };
    try {
      const fallback = await sweeper.pauseReason({ allowCrossVolume: true });
      assert.equal(fallback && fallback.code, 'external-unarchived-unsettled', '读不到 registry ⇒ fail-closed（B8 边界）');
    } finally {
      h.engine.archivedIds = archivedIds;
    }
    assert.equal(await sweeper.pauseReason({ allowCrossVolume: true }), null, '注入解除后回到「在集合内 ⇒ 不暂停」');
  } finally {
    await h.dispose();
  }
});

test('B8：每一拍清扫先跑 registry 对账（误标当拍自愈；对账失败不阻断整拍）', async () => {
  // ① 每拍对账：cold 行上的历史误标必须在**清扫拍里**被清掉（不依赖 recoverOnBoot 的时机）
  {
    const h = await createHarness();
    try {
      const id = await seedArchived(h, 'session-b8-heal', 30);
      const migrated = await h.engine.migrate(id, { reason: 'b8-test' });
      assert.equal(migrated.ok, true, '前提：先把它搬到冷侧（真机误标行都是 cold 行）：' + JSON.stringify(migrated));
      assert.equal(h.store.getSession(id).status, 'cold');
      h.store.updateSession(id, { error: 'external-unarchived' });
      h.engine.invalidate();
      assert.equal(h.store.getSession(id).error, 'external-unarchived', '前提：历史误标在库里');

      let reconciles = 0;
      const reconcile = h.engine.reconcileRegistry.bind(h.engine);
      h.engine.reconcileRegistry = async (counts) => {
        reconciles += 1;
        return reconcile(counts);
      };

      const sweeper = h.sweeper();
      const report = await sweeper.sweep();
      assert.equal(reconciles, 1, '每拍必须跑**恰好一次** registry 对账（B8 根因 ②）');
      assert.equal(h.store.getSession(id).error, null, '误标必须当拍被 B7 自愈清掉（不再只在启动跑一次）');
      assert.equal(report.skipped, undefined, '误标不该再让整拍 no-op：' + JSON.stringify(report));
      assert.equal(sweeper.snapshot().paused, false);

      // 第二拍仍要跑对账（不是「只有启动后第一拍」的一次性开关），且幂等：已清空的行零写入
      const second = await sweeper.sweep();
      assert.equal(reconciles, 2, '第二拍同样要跑对账');
      assert.equal(second.skipped, undefined);
      assert.equal(h.store.getSession(id).error, null);

      // 负向：真的未收敛（id 不在当前集合里）⇒ 当拍仍必须暂停（A-13 不放宽）
      h.store.upsertSession({
        session_id: 'session-b8-stray', project_key: h.pk, rel_dir: h.pk + '/session-b8-stray',
        log_names: 'session.v4.jsonl.zstd', format_version: 4, status: 'cold', cold_root: h.paths.coldRootDefault,
        error: 'external-unarchived', source_sha: '',
      });
      const paused = await sweeper.sweep();
      assert.equal(paused.skipped, 'external-unarchived-unsettled', JSON.stringify(paused));
      assert.deepEqual(paused.paused.ids, ['session-b8-stray'], '不在集合里的行仍然让 class A 暂停');
    } finally {
      await h.dispose();
    }
  }
  // ② 对账失败只 warn，不得让整拍 no-op（合法候选照常迁移）
  {
    const h = await createHarness();
    try {
      const id = await seedArchived(h, 'session-b8-reconcile-boom', 30);
      const warns = [];
      h.engine.reconcileRegistry = async () => { throw new Error('reconcile-boom'); };
      const sweeper = h.sweeper({ logger: { info() {}, warn(message) { warns.push(String(message)); }, error() {} } });
      const report = await sweeper.sweep();
      assert.equal(report.migrated, 1, '对账失败不得让整拍 no-op（B8 验收）：' + JSON.stringify(report));
      assert.equal(h.store.getSession(id).status, 'cold');
      assert.equal(warns.some((message) => /registry 对账失败/.test(message)), true, '失败必须 warn 留痕：' + JSON.stringify(warns));
    } finally {
      await h.dispose();
    }
  }
});

