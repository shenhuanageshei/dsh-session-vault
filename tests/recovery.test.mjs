import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, copyFile } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { resolveVaultPaths, createConfigStore } from '../lib/config.js';
import { VaultStore } from '../lib/store.js';
import { VaultEngine, projectKey } from '../lib/engine.js';
import { hashTree, statTree } from '../lib/marker.js';

const quiet = { info() {}, warn() {}, error() {} };
const exists = (target) => stat(target).then(() => true).catch(() => false);

function logLines(id, cwd, text = '崩溃收敛测试的人话') {
  return [
    JSON.stringify({ type: 'request/header', sessionId: id, cwd, createdAt: 1791000000000 }),
    JSON.stringify({ type: 'user/message', seq: 1, ts: 1791000001000, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }),
    JSON.stringify({ type: 'session/title', seq: 2, ts: 1791000002000, data: { title: '崩溃测试' } }),
  ];
}

async function setup() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-recovery-'));
  const paths = resolveVaultPaths(home);
  const cwd = '<workspace-root>\\demo';
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
    async list() {
      const out = [];
      const projects = await readdir(paths.sessionsRoot, { withFileTypes: true }).catch(() => []);
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        const sessions = await readdir(path.join(paths.sessionsRoot, project.name), { withFileTypes: true }).catch(() => []);
        for (const session of sessions) if (session.isDirectory()) out.push({ sessionId: session.name });
      }
      return out;
    },
    async stat(sessionId) {
      const projects = await readdir(paths.sessionsRoot, { withFileTypes: true }).catch(() => []);
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        const dir = path.join(paths.sessionsRoot, project.name, sessionId);
        const files = await readdir(dir).catch(() => null);
        if (files && files.length) return { sizeBytes: 1 };
      }
      return undefined;
    },
  };
  const configStore = createConfigStore({ home, paths });
  const store = await VaultStore.open(paths.dbPath);
  const engine = new VaultEngine({ home, paths, configStore, store, registry, persistence, logger: quiet, isActive: async () => false });

  const hotDir = (id) => path.join(paths.sessionsRoot, pk, id);
  const coldDir = (id) => path.join(paths.coldRootDefault, pk, id);
  const markerPath = (id) => path.join(paths.markerDir, id + '.json');

  async function addSession(id, opts = {}) {
    const dir = hotDir(id);
    await mkdir(dir, { recursive: true });
    const logs = opts.logs || { 'session.v4.jsonl.zstd': logLines(id, cwd) };
    for (const [name, lines] of Object.entries(logs)) {
      await writeFile(path.join(dir, name), Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line + '\n')))));
    }
    return dir;
  }

  /** 手工写 marker（模拟「进程在某个崩溃点被杀」）。 */
  async function writeMarker(id, marker) {
    await engine.markers.ensureDir();
    await writeFile(markerPath(id), JSON.stringify({ v: 1, id, ...marker }, null, 2));
  }

  /** 造一个「已搬到冷侧」的会话 + 对应的 planned marker（模拟崩在 rename 之后、复检之前）。 */
  async function seedMovedCold(id, { keepHot = false } = {}) {
    const dir = await addSession(id);
    const baseline = await hashTree(dir);
    const tree = await statTree(dir);
    const cold = coldDir(id);
    await mkdir(path.dirname(cold), { recursive: true });
    const { rename } = await import('node:fs/promises');
    await rename(dir, cold);
    if (keepHot) await addSession(id);
    archived.add(id);
    const marker = {
      op: 'migrate', phase: 'planned', src: dir, dst: cold, coldRoot: paths.coldRootDefault,
      projectKey: pk, relDir: pk + '/' + id, logNames: 'session.v4.jsonl.zstd', currentGeneration: 'session.v4.jsonl.zstd',
      formatVersion: 4, bytes: baseline.bytes, planSha: baseline.sha256, files: baseline.files,
      planMtimeMs: tree.maxMtimeMs, sourceSha: '', headerCwd: cwd, title: '', archivedAt: Date.now(), createdAt: Date.now(),
    };
    await writeMarker(id, marker);
    return { baseline, marker, cold, dir };
  }

  return {
    home, paths, cwd, pk, archived, calls, registry, persistence, configStore, store, engine,
    addSession, writeMarker, seedMovedCold, hotDir, coldDir, markerPath,
    async dispose() { store.close(); await rm(home, { recursive: true, force: true }); },
  };
}

test('§11 崩溃矩阵：planned 后 rename 前（热完整 + marker）→ 启动幂等重跑并收敛为冷', async () => {
  const h = await setup();
  try {
    const id = 'session-planned';
    const dir = await h.addSession(id);
    const baseline = await hashTree(dir);
    const tree = await statTree(dir);
    h.archived.add(id);
    await h.writeMarker(id, {
      op: 'migrate', phase: 'planned', src: dir, dst: h.coldDir(id), coldRoot: h.paths.coldRootDefault,
      projectKey: h.pk, relDir: h.pk + '/' + id, logNames: 'session.v4.jsonl.zstd', currentGeneration: 'session.v4.jsonl.zstd',
      formatVersion: 4, bytes: baseline.bytes, planSha: baseline.sha256, files: baseline.files, planMtimeMs: tree.maxMtimeMs,
      headerCwd: h.cwd, title: '', archivedAt: Date.now(), createdAt: Date.now(),
    });
    const report = await h.engine.recoverOnBoot();
    assert.equal(report.ok, true);
    assert.equal(await exists(dir), false);
    assert.equal(await exists(h.coldDir(id)), true);
    assert.equal(h.store.getSession(id).status, 'cold');
    assert.equal(await exists(h.markerPath(id)), false);
  } finally {
    await h.dispose();
  }
});

test('§11 崩溃矩阵：rename 后复检前（冷完整 + marker planned）→ 续尾段（基线校验 → 索引 → DB → manifest）', async () => {
  const h = await setup();
  try {
    const id = 'session-moved';
    const { baseline } = await h.seedMovedCold(id);
    const report = await h.engine.recoverOnBoot();
    assert.equal(report.ok, true);
    assert.equal(h.store.getSession(id).status, 'cold');
    assert.ok(h.store.searchDocs('崩溃收敛').hits.length >= 1, '续尾段必须建索引');
    const manifest = await readFile(h.paths.manifestPath, 'utf8');
    assert.match(manifest, /"op":"migrate"/);
    assert.match(manifest, new RegExp(baseline.sha256));
    assert.equal(await exists(h.markerPath(id)), false);
  } finally {
    await h.dispose();
  }
});

test('§11 崩溃矩阵：DB 后 manifest 前 → 启动补 op:repair（查重）', async () => {
  const h = await setup();
  try {
    const id = 'session-repair';
    await h.addSession(id);
    h.archived.add(id);
    assert.equal((await h.engine.migrate(id)).ok, true);
    await rm(h.paths.manifestPath, { force: true });
    const report = await h.engine.recoverOnBoot();
    assert.equal(report.ok, true);
    const records = (await readFile(h.paths.manifestPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].op, 'repair');
    assert.equal(records[0].id, id);
    await h.engine.recoverOnBoot();
    const again = (await readFile(h.paths.manifestPath, 'utf8')).trim().split('\n');
    assert.equal(again.length, 1, '对账必须查重');
  } finally {
    await h.dispose();
  }
});

test('§11 跨卷 copy 中断：热完整 + .partial → 删 .partial，可重试', async () => {
  const h = await setup();
  try {
    const id = 'session-partial';
    const dir = await h.addSession(id);
    const baseline = await hashTree(dir);
    const tree = await statTree(dir);
    h.archived.add(id);
    const partial = h.coldDir(id) + '.partial';
    await mkdir(partial, { recursive: true });
    await writeFile(path.join(partial, 'session.v4.jsonl.zstd'), Buffer.from('half-copied'));
    await h.writeMarker(id, {
      op: 'migrate', phase: 'planned', src: dir, dst: h.coldDir(id), coldRoot: h.paths.coldRootDefault,
      projectKey: h.pk, relDir: h.pk + '/' + id, logNames: 'session.v4.jsonl.zstd', currentGeneration: 'session.v4.jsonl.zstd',
      formatVersion: 4, bytes: baseline.bytes, planSha: baseline.sha256, files: baseline.files, planMtimeMs: tree.maxMtimeMs,
      headerCwd: h.cwd, title: '', archivedAt: Date.now(), createdAt: Date.now(),
    });
    await h.engine.recoverOnBoot();
    assert.equal(await exists(partial), false, '.partial 必须被清掉');
    assert.equal(await exists(h.coldDir(id)), true, '重跑迁移成功');
    assert.equal((await hashTree(h.coldDir(id))).sha256, baseline.sha256);
  } finally {
    await h.dispose();
  }
});

test('§11 真值表：src 在 + dst 在（基线一致）→ 迁移方向清理热源；恢复方向清理冷残留', async () => {
  const h = await setup();
  try {
    const id = 'session-inin';
    const { baseline } = await h.seedMovedCold(id, { keepHot: true });
    await h.engine.recoverOnBoot();
    const row = h.store.getSession(id);
    assert.equal(row.status, 'cold');
    assert.equal(await exists(h.hotDir(id)), false, '迁移方向：热源被清掉');
    assert.equal(await exists(h.coldDir(id)), true);
    assert.equal((await hashTree(h.coldDir(id))).sha256, baseline.sha256);
    assert.equal(await exists(h.markerPath(id)), false);
  } finally {
    await h.dispose();
  }
});

test('§11 真值表：双份内容不一致 → needs-review，双份保留 + marker 保留（自动例程永不删源）', async () => {
  const h = await setup();
  try {
    const id = 'session-diff';
    const { baseline, cold } = await h.seedMovedCold(id, { keepHot: true });
    // 让热侧内容与基线不一致
    await writeFile(path.join(h.hotDir(id), 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from('{"tampered":true}\n')));
    const hotBefore = await hashTree(h.hotDir(id));
    const coldBefore = await hashTree(cold);
    await h.engine.recoverOnBoot();
    const row = h.store.getSession(id);
    assert.equal(row.error, 'needs-review');
    assert.equal(await exists(h.markerPath(id)), true, 'marker 必须保留给人看');
    assert.equal((await hashTree(h.hotDir(id))).sha256, hotBefore.sha256, '热侧一个字节都不能动');
    assert.equal((await hashTree(cold)).sha256, coldBefore.sha256, '冷侧一个字节都不能动');
    assert.notEqual(baseline.sha256, hotBefore.sha256);
  } finally {
    await h.dispose();
  }
});

test('§11 真值表：src 无 + dst 无 → error=lost，保留 marker 与 DB 行', async () => {
  const h = await setup();
  try {
    const id = 'session-lost';
    h.archived.add(id);
    h.store.upsertSession({
      session_id: id, project_key: h.pk, rel_dir: h.pk + '/' + id, log_names: 'session.v4.jsonl.zstd',
      format_version: 4, status: 'migrating', cold_root: h.paths.coldRootDefault, source_sha: '',
    });
    await h.writeMarker(id, {
      op: 'migrate', phase: 'moved', src: h.hotDir(id), dst: h.coldDir(id), coldRoot: h.paths.coldRootDefault,
      projectKey: h.pk, relDir: h.pk + '/' + id, logNames: 'session.v4.jsonl.zstd', formatVersion: 4,
      bytes: 10, planSha: 'deadbeef', files: [], headerCwd: h.cwd,
    });
    await h.engine.recoverOnBoot();
    assert.equal(h.store.getSession(id).error, 'lost');
    assert.equal(await exists(h.markerPath(id)), true, 'lost 也必须保留 marker（人工处置依据）');
    assert.equal(h.store.getSession(id).status, 'migrating', '不删行、不伪造成功');
  } finally {
    await h.dispose();
  }
});

test('§11 恢复中断：热侧半成品被丢弃、冷侧完整 → 启动续跑恢复（不回滚、不半截可见）', async () => {
  const h = await setup();
  try {
    const id = 'session-rh';
    const dir = await h.addSession(id);
    const baseline = await hashTree(dir);
    const tree = await statTree(dir);
    h.archived.add(id);
    // 直接造「已搬冷 + 热侧半成品 + restore marker」
    const cold = h.coldDir(id);
    await mkdir(path.dirname(cold), { recursive: true });
    const { rename } = await import('node:fs/promises');
    await rename(dir, cold);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.from('truncated-half'));
    await h.writeMarker(id, {
      op: 'restore', phase: 'planned', src: cold, dst: dir, coldRoot: h.paths.coldRootDefault,
      projectKey: h.pk, relDir: h.pk + '/' + id, logNames: 'session.v4.jsonl.zstd', currentGeneration: 'session.v4.jsonl.zstd',
      bytes: baseline.bytes, planSha: baseline.sha256, files: baseline.files, reason: 'crash-test',
    });
    h.store.upsertSession({
      session_id: id, project_key: h.pk, rel_dir: h.pk + '/' + id, log_names: 'session.v4.jsonl.zstd',
      format_version: 4, status: 'restoring', cold_root: h.paths.coldRootDefault, bytes: baseline.bytes, source_sha: '',
    });
    const report = await h.engine.recoverOnBoot();
    assert.equal(report.ok, true);
    const row = h.store.getSession(id);
    assert.equal(row.status, 'hot-restored', JSON.stringify(report.counts));
    assert.equal(await exists(cold), false);
    assert.equal((await hashTree(dir)).sha256, baseline.sha256, '恢复后热侧必须与基线一致');
    assert.equal(h.archived.has(id), false);
    assert.equal(h.calls.unarchive.length, 1);
    assert.equal(await exists(h.markerPath(id)), false);
  } finally {
    await h.dispose();
  }
});

test('启动对账：冷目录有、DB 无 → 导入 cold（backfilled=1）；绝不标 lost', async () => {
  const h = await setup();
  try {
    const id = 'session-orphan';
    const cold = h.coldDir(id);
    await mkdir(cold, { recursive: true });
    await writeFile(path.join(cold, 'session.v4.jsonl.zstd'), Buffer.concat(logLines(id, h.cwd).map((line) => zstdCompressSync(Buffer.from(line + '\n')))));
    await h.engine.recoverOnBoot();
    const row = h.store.getSession(id);
    assert.ok(row, '冷目录必须被导入成 DB 行');
    assert.equal(row.status, 'cold');
    assert.equal(row.backfilled, 1);
    assert.ok(h.store.searchDocs('崩溃收敛').hits.length >= 1);
  } finally {
    await h.dispose();
  }
});

test('启动对账：DB 有、磁盘无 → error=lost（不删行、不删标记）', async () => {
  const h = await setup();
  try {
    const id = 'session-dbonly';
    h.store.upsertSession({
      session_id: id, project_key: h.pk, rel_dir: h.pk + '/' + id, log_names: 'session.v4.jsonl.zstd',
      format_version: 4, status: 'cold', cold_root: h.paths.coldRootDefault, source_sha: '',
    });
    await h.engine.recoverOnBoot();
    const row = h.store.getSession(id);
    assert.equal(row.error, 'lost');
    assert.equal(row.status, 'cold', '不删行、不改状态');
  } finally {
    await h.dispose();
  }
});

test('§11 registry 对账：cold 但 id 已离开归档集合 → external-unarchived（A-13 兜底）', async () => {
  const h = await setup();
  try {
    const id = 'session-ext';
    await h.addSession(id);
    h.archived.add(id);
    assert.equal((await h.engine.migrate(id)).ok, true);
    h.archived.delete(id);
    await h.engine.recoverOnBoot();
    assert.equal(h.store.getSession(id).error, 'external-unarchived');
    assert.equal(await exists(h.coldDir(id)), true, '不许因为对账而删任何文件');
  } finally {
    await h.dispose();
  }
});

test('§11 D23：hot-restored 重入归档集合 → 启动差分轮询翻回 hot（否则永远不可迁）', async () => {
  const h = await setup();
  try {
    const id = 'session-flip';
    await h.addSession(id);
    h.archived.add(id);
    assert.equal((await h.engine.migrate(id)).ok, true);
    assert.equal((await h.engine.restore(id)).ok, true);
    assert.equal(h.store.getSession(id).status, 'hot-restored');
    h.archived.add(id); // 再次归档
    await h.engine.recoverOnBoot();
    assert.equal(h.store.getSession(id).status, 'hot');
    await h.configStore.save({ autoMigrate: true, archiveAgeDays: 0 });
    assert.equal((await h.engine.candidates(5)).length, 0, 'archiveAgeDays=0 关闭自动迁移（AC-6）');
  } finally {
    await h.dispose();
  }
});

test('启动收敛顺序：marker 收敛先于冷目录对账（同一会话不会先被标 lost）', async () => {
  const h = await setup();
  try {
    const id = 'session-order';
    const { baseline } = await h.seedMovedCold(id); // 热无、冷在、marker 在
    await h.engine.recoverOnBoot();
    const row = h.store.getSession(id);
    assert.equal(row.status, 'cold');
    assert.notEqual(row.error, 'lost', 'marker 收敛必须先跑，否则会误标 lost');
    assert.equal((await hashTree(h.coldDir(id))).sha256, baseline.sha256);
  } finally {
    await h.dispose();
  }
});
// ---------------------------------------------------------------------------
// 第四轮微修（代码评审 PASS 后的 🟡）
// ---------------------------------------------------------------------------

test('4R-2（2 号项 / I-6）：同卷 rename 后、复检前崩溃 ∩ 崩溃前已取消归档或已活跃 → 启动搬回热侧并标 race-unarchived', async () => {
  const h = await setup();
  try {
    // ① 崩溃前用户已经取消归档（仍在冷侧 + planned marker）
    const unarchivedId = 'session-boot-unarchived';
    const un = await h.seedMovedCold(unarchivedId);
    h.archived.delete(unarchivedId);
    let report = await h.engine.recoverOnBoot();
    assert.equal(report.ok, true);
    assert.equal(await exists(un.dir), true, '热目录必须搬回（I-6：取消归档 ⇒ 立即搬回）');
    assert.equal(await exists(un.cold), false, '冷侧必须清掉（搬回 = rename）');
    assert.equal((await hashTree(un.dir)).sha256, un.baseline.sha256, '搬回后内容与 marker 基线一致');
    let row = h.store.getSession(unarchivedId);
    assert.equal(row.status, 'hot');
    assert.equal(row.error, 'race-unarchived');
    assert.equal(await exists(h.markerPath(unarchivedId)), false, 'marker 必须删（收敛完成，不留僵尸证据）');
    assert.ok(report.counts.flipped >= 1, JSON.stringify(report.counts));

    // ② 崩溃后、启动前出现了 live 会话（仍留在归档集合里）
    const activeId = 'session-boot-active';
    const act = await h.seedMovedCold(activeId);
    h.engine.isActive = async (id) => String(id) === activeId;
    report = await h.engine.recoverOnBoot();
    assert.equal(report.ok, true);
    assert.equal(await exists(act.dir), true, '出现 live 会话也必须搬回（I-6 的另一半）');
    assert.equal(await exists(act.cold), false);
    row = h.store.getSession(activeId);
    assert.equal(row.status, 'hot');
    assert.equal(row.error, 'race-unarchived');
    assert.equal(await exists(h.markerPath(activeId)), false);

    // ③ 正对照：仍在归档、不活跃 ⇒ 照旧续尾段（I-6 不得误伤正常收敛）
    const normalId = 'session-boot-normal';
    const normal = await h.seedMovedCold(normalId);
    report = await h.engine.recoverOnBoot();
    assert.equal(h.store.getSession(normalId).status, 'cold', JSON.stringify(report.counts));
    assert.equal(await exists(normal.dir), false, '正常收敛：热侧清掉');
    assert.equal(await exists(normal.cold), true, '正常收敛：冷侧保留');
    assert.equal(await exists(h.markerPath(normalId)), false);
  } finally {
    await h.dispose();
  }
});

test('4R-3（3 号项②）：启动兜底扫描——status=migrating/restoring 且无 marker 且热目录在盘 ⇒ 翻回 hot + 诊断', async () => {
  const h = await setup();
  try {
    const seedRow = async (id, status, { withDisk = true } = {}) => {
      if (withDisk) await h.addSession(id);
      h.store.upsertSession({
        session_id: id, project_key: h.pk, rel_dir: h.pk + '/' + id, log_names: 'session.v4.jsonl.zstd',
        format_version: 4, status, bytes: 10, source_sha: '',
      });
    };
    await seedRow('session-stray-migrating', 'migrating');
    await seedRow('session-stray-restoring', 'restoring');
    // 负对照 A：热目录不在盘 ⇒ 绝不凭空造热态（那是 lost / needs-review 面）
    await seedRow('session-stray-nohot', 'migrating', { withDisk: false });
    // 负对照 B：有 marker 的行归 marker 收敛（构造「src/dst 都不在 ⇒ lost」），兜底扫描不得覆盖它
    const withMarker = 'session-stray-marker';
    await seedRow(withMarker, 'migrating', { withDisk: false });
    await h.writeMarker(withMarker, {
      op: 'migrate', phase: 'moved', src: h.hotDir(withMarker), dst: h.coldDir(withMarker),
      coldRoot: h.paths.coldRootDefault, projectKey: h.pk, relDir: h.pk + '/' + withMarker,
      logNames: 'session.v4.jsonl.zstd', formatVersion: 4, bytes: 10, planSha: 'deadbeef', files: [],
    });

    const report = await h.engine.recoverOnBoot();
    assert.equal(report.ok, true);

    const migrated = h.store.getSession('session-stray-migrating');
    assert.equal(migrated.status, 'hot', 'migrating + 无 marker + 热目录在盘 ⇒ 翻回 hot');
    assert.equal(migrated.error, 'stray-status-recovered: migrating');
    const restoring = h.store.getSession('session-stray-restoring');
    assert.equal(restoring.status, 'hot');
    assert.equal(restoring.error, 'stray-status-recovered: restoring');
    assert.ok(report.counts.strayRecovered >= 2, JSON.stringify(report.counts));

    const noHot = h.store.getSession('session-stray-nohot');
    assert.equal(noHot.status, 'migrating', '热目录不在盘时不得凭空造热态');
    assert.equal(noHot.error, null, '负对照 A 不得被兜底扫描写诊断');
    const markerRow = h.store.getSession(withMarker);
    assert.equal(markerRow.error, 'lost', '有 marker 的行归 marker 收敛（兜底扫描跳过）');
    assert.equal(markerRow.status, 'migrating', 'marker 收敛不伪造成功');

    // 诊断面（status.errors）必须能看到兜底扫描的结果
    const status = await h.engine.status();
    assert.ok(
      status.errors.some((entry) => /^stray-status-recovered:/.test(String(entry.error))),
      '诊断面要展示游离状态收敛：' + JSON.stringify(status.errors),
    );
    // 翻回 hot 后 preflight 不再以 not-candidate 拒绝（可重试）
    h.archived.add('session-stray-migrating');
    await h.configStore.save({ archiveAgeDays: 14 });
    const retried = await h.engine.migrate('session-stray-migrating');
    assert.equal(retried.ok, true, '翻回 hot 后必须可重试：' + JSON.stringify(retried));
  } finally {
    await h.dispose();
  }
});
