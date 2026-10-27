import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, copyFile, rename } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { resolveVaultPaths, createConfigStore } from '../lib/config.js';
import { VaultStore } from '../lib/store.js';
import { VaultEngine, installArchiveTracker, projectKey, FORMAT_WHITELIST } from '../lib/engine.js';
import { hashTree, statTree, isGenerationName } from '../lib/marker.js';
import { Manifest, dedupKey } from '../lib/manifest.js';
import { forEachJsonLine } from '../lib/zstd-frames.js';
import { extractEvent, parseLine, isLegacyFormat } from '../lib/extract.js';

const quiet = { info() {}, warn() {}, error() {} };
const exists = (target) => stat(target).then(() => true).catch(() => false);

function frames(id, cwd) {
  return [
    JSON.stringify({ type: 'request/header', sessionId: id, cwd, createdAt: 1791000000000 }),
    JSON.stringify({
      type: 'user/message', seq: 1, ts: 1791000001000,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '归档保险库的第一句人话' }] },
    }),
    JSON.stringify({
      type: 'assistant/message', seq: 2, ts: 1791000002000,
      data: { message: { content: [{ type: 'reasoning', text: '内部推理不该被索引' }, { type: 'text', text: '冷存储已经就绪' }] } },
    }),
    JSON.stringify({ type: 'session/title', seq: 3, ts: 1791000003000, data: { title: '归档演示' } }),
  ];
}

async function createHarness(options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-engine-'));
  const paths = resolveVaultPaths(home);
  const cwd = options.cwd || '<workspace-root>\\demo';
  const pk = projectKey(cwd);
  const archived = new Set();
  const calls = { archive: [], unarchive: [] };

  const registry = {
    archivedSessionIds: archived,
    async archiveSession(id) { archived.add(String(id)); calls.archive.push(String(id)); },
    async unarchiveSession(id) { archived.delete(String(id)); calls.unarchive.push(String(id)); },
    async resolveByPath() { return typeof options.workspace === 'function' ? options.workspace() : options.workspace; },
  };

  const persistence = {
    async list() {
      const out = [];
      const projects = await readdir(paths.sessionsRoot, { withFileTypes: true }).catch(() => []);
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        const sessions = await readdir(path.join(paths.sessionsRoot, project.name), { withFileTypes: true }).catch(() => []);
        for (const session of sessions) {
          if (session.isDirectory()) out.push({ sessionId: session.name });
        }
      }
      return out;
    },
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

  const configStore = createConfigStore({ home, paths });
  // 跨卷分支默认被配置门挡住（D13：allowCrossVolume 默认 false）；要测跨卷**路径**的用例
  // 必须显式开启，否则命中 cross-volume-disabled 而不是 copy+校验+删源。
  if (options.allowCrossVolume) await configStore.save({ allowCrossVolume: true });
  const store = await VaultStore.open(paths.dbPath);
  const engine = new VaultEngine({
    home, paths, configStore, store, registry, persistence, logger: quiet,
    isActive: async () => Boolean(options.active),
    sameVolume: options.sameVolume,
    copyFile: options.copyFile,
    fs: options.fs,
    onWrite: options.onWrite,
    detectAm: options.detectAm,
    resolveWorkspace: options.resolveWorkspace,
  });

  async function addSession(id, opts = {}) {
    const sessionCwd = opts.cwd || cwd;
    const dir = path.join(paths.sessionsRoot, pk, id);
    await mkdir(dir, { recursive: true });
    const logs = opts.logs || { 'session.v4.jsonl.zstd': opts.frames || frames(id, sessionCwd) };
    for (const [name, lines] of Object.entries(logs)) {
      await writeFile(path.join(dir, name), Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line + '\n')))));
    }
    return dir;
  }

  async function writeWorkspace(ids) {
    const file = path.join(home, 'storages', 'workspace.json');
    await mkdir(path.dirname(file), { recursive: true });
    const payload = { global: { archivedSessionIds: ids }, tables: { workspaces: [{ path: cwd, sessionIds: ids }] } };
    await writeFile(file, JSON.stringify(payload));
    return { file, text: await readFile(file, 'utf8') };
  }

  return {
    home, paths, cwd, pk, archived, calls, registry, persistence, configStore, store, engine,
    addSession, writeWorkspace,
    coldDir: (id) => path.join(paths.coldRootDefault, pk, id),
    hotDir: (id) => path.join(paths.sessionsRoot, pk, id),
    markerPath: (id) => path.join(paths.markerDir, id + '.json'),
    async dispose() {
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test('P1-4 A-1/A-15：迁移后热目录消失、冷目录与 marker 基线一致、记账不动、manifest 恰一行', async () => {
  const h = await createHarness();
  try {
    const id = 'session-a1';
    const dir = await h.addSession(id);
    const { text } = await h.writeWorkspace([id]);
    const baseline = await hashTree(dir);
    const beforeTree = await statTree(dir);
    h.archived.add(id);

    const result = await h.engine.migrate(id);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, 'cold');

    assert.equal(await exists(dir), false, '热目录必须消失');
    const cold = h.coldDir(id);
    assert.equal(await exists(cold), true, '冷目录必须存在');
    const coldBaseline = await hashTree(cold);
    assert.equal(coldBaseline.sha256, baseline.sha256, '全代际 sha 必须与 marker 基线一致');
    assert.equal(coldBaseline.bytes, baseline.bytes);

    const row = h.store.getSession(id);
    assert.equal(row.status, 'cold');
    assert.equal(row.cold_root, h.paths.coldRootDefault);
    assert.equal(row.format_version, 4);
    assert.equal(row.log_names, 'session.v4.jsonl.zstd');
    assert.ok(row.source_sha && row.source_sha.length === 16, 'source_sha = 首帧压缩字节 sha256 前 16 位');

    const lines = (await readFile(h.paths.manifestPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'manifest 恰一行');
    const record = JSON.parse(lines[0]);
    assert.equal(record.op, 'migrate');
    assert.equal(record.id, id);
    assert.equal(record.sha256, baseline.sha256);
    assert.equal(record.to, cold);

    assert.equal(await readFile(path.join(h.home, 'storages', 'workspace.json'), 'utf8'), text, '工作区记账一个字都不能动（D6′）');
    assert.equal(h.archived.has(id), true, 'archivedSessionIds 不变');
    assert.equal(await exists(h.markerPath(id)), false, 'marker 事后必须删除');

    const hits = h.store.searchDocs('归档保险库');
    assert.ok(hits.hits.length >= 1, '迁移后冷索引可搜');
    assert.equal(h.store.searchDocs('内部推理').hits.length, 0, 'reasoning 不入索引（A-5a）');
    assert.equal(row.title, '归档演示');
    assert.equal(beforeTree.bytes, coldBaseline.bytes);
    assert.ok(h.engine.getWriteLog().every((p) => p.startsWith(h.home)), 'A-19：写路径全部在 DSH_HOME 内');
  } finally {
    await h.dispose();
  }
});

test('P1-4 A-2：未归档 / 活跃会话永不进入迁移', async () => {
  const inactive = await createHarness();
  try {
    const id = 'session-ack';
    await inactive.addSession(id);
    const result = await inactive.engine.migrate(id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not-archived');
    assert.equal(await exists(inactive.coldDir(id)), false, '被拒绝时不得留下任何冷目录');
  } finally {
    await inactive.dispose();
  }

  const active = await createHarness({ active: true });
  try {
    const id = 'session-run';
    await active.addSession(id);
    active.archived.add(id);
    const result = await active.engine.migrate(id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'active');
    assert.equal(await exists(active.hotDir(id)), true);
    assert.equal(await exists(active.coldDir(id)), false);
  } finally {
    await active.dispose();
  }
});

test('P1-4 A-4：恢复后 stat 可见、id 离开归档集合、projectKey 复算一致、status=hot-restored 且不进候选', async () => {
  const h = await createHarness();
  try {
    const id = 'session-a4';
    const dir = await h.addSession(id);
    h.archived.add(id);
    assert.equal((await h.engine.migrate(id)).ok, true);

    const result = await h.engine.restore(id);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await exists(dir), true);
    assert.equal(await exists(h.coldDir(id)), false);
    assert.equal(h.archived.has(id), false, '恢复必须调官方原件取消归档');
    assert.equal(h.calls.unarchive.length, 1);
    assert.ok(await h.persistence.stat(id), 'persistence.stat 必须可见');

    const row = h.store.getSession(id);
    assert.equal(row.status, 'hot-restored');
    assert.equal(row.project_key, projectKey(h.cwd), 'projectKey == header.cwd 复算值');
    assert.equal(row.moved_at, null);

    await h.configStore.save({ autoMigrate: true, archiveAgeDays: 1 });
    const candidates = await h.engine.candidates(10);
    assert.equal(candidates.length, 0, 'hot-restored 不是迁移候选（§5）');
    const coldAgain = await h.engine.migrate(id);
    assert.equal(coldAgain.ok, false);
  } finally {
    await h.dispose();
  }
});

test('P1-4 A-10：目录名 ≠ projectKey(header.cwd) 时拒绝迁移（不制造 list() 抛错源）', async () => {
  const h = await createHarness();
  try {
    const id = 'session-badpk';
    const wrongPk = '--D--workspace--other--';
    const dir = path.join(h.paths.sessionsRoot, wrongPk, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'session.v4.jsonl.zstd'),
      Buffer.concat(frames(id, h.cwd).map((line) => zstdCompressSync(Buffer.from(line + '\n')))),
    );
    h.archived.add(id);
    const result = await h.engine.migrate(id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'project-key-mismatch');
    assert.equal(await exists(path.join(h.paths.coldRootDefault, wrongPk, id)), false);
    assert.equal(await exists(dir), true, '拒绝迁移不得动源目录');
  } finally {
    await h.dispose();
  }
});

test('P1-4 A-12：迁移后复检发现已取消归档 → 自动搬回并标 race-unarchived', async () => {
  const h = await createHarness();
  try {
    const id = 'session-a12';
    const dir = await h.addSession(id);
    h.archived.add(id);
    let calls = 0;
    h.engine.isArchived = () => {
      calls += 1;
      return calls <= 1; // preflight 通过、迁移后复检失败
    };
    const result = await h.engine.migrate(id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'race-unarchived');
    assert.equal(await exists(dir), true, '热目录必须搬回');
    assert.equal(await exists(h.coldDir(id)), false, '冷目录必须清掉');
    assert.equal(h.store.getSession(id).error, 'race-unarchived');
    assert.equal(await exists(h.markerPath(id)), false);
  } finally {
    await h.dispose();
  }
});

test('P1-4 A-20/A-21：v5 拒迁；v3+v4 多代目录整目录搬移、只索引当前代际、恢复后两文件俱在', async () => {
  const h = await createHarness();
  try {
    const v5 = 'session-v5';
    const v5dir = path.join(h.paths.sessionsRoot, h.pk, v5);
    await mkdir(v5dir, { recursive: true });
    await writeFile(path.join(v5dir, 'session.v5.jsonl.zstd'), zstdCompressSync(Buffer.from(JSON.stringify({ type: 'request/header', sessionId: v5, cwd: h.cwd }) + '\n')));
    h.archived.add(v5);
    const rejected = await h.engine.migrate(v5);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'format-unsupported');
    assert.deepEqual([...FORMAT_WHITELIST], [0, 3, 4]);

    const id = 'session-multi';
    const dir = await h.addSession(id, {
      logs: {
        'session.v3.jsonl.zstd': [JSON.stringify({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '只有 v3 才有的句子' }] } })],
        'session.v4.jsonl.zstd': frames(id, h.cwd),
      },
    });
    const baseline = await hashTree(dir);
    h.archived.add(id);
    const migrated = await h.engine.migrate(id);
    assert.equal(migrated.ok, true, JSON.stringify(migrated));
    const cold = h.coldDir(id);
    assert.deepEqual((await hashTree(cold)).files.map((f) => f.name), ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd']);
    assert.equal((await hashTree(cold)).sha256, baseline.sha256);
    assert.equal(h.store.getSession(id).log_names, 'session.v3.jsonl.zstd,session.v4.jsonl.zstd');
    assert.ok(h.store.searchDocs('冷存储').hits.length >= 1, '当前代际可搜');
    assert.equal(h.store.searchDocs('只有').hits.length, 0, '旧代际不入索引（R-11）');

    const restored = await h.engine.restore(id);
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.deepEqual((await hashTree(dir)).files.map((f) => f.name), ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd']);
  } finally {
    await h.dispose();
  }
});

test('P1-4 A-13：冷会话被取消归档时透明水合；搬不回来则明确拒绝，绝不静默消失', async () => {
  const h = await createHarness();
  try {
    const id = 'session-a13';
    const dir = await h.addSession(id);
    h.archived.add(id);
    assert.equal((await h.engine.migrate(id)).ok, true);
    const disposer = installArchiveTracker({ registry: h.registry, engine: h.engine, getConfig: () => ({ hydrateOnUnarchive: true }), log: quiet });
    try {
      const hydrated = await h.registry.unarchiveSession(id);
      // 5 号项：水合成功路径的返回值。包装契约是「返回官方 unarchiveSession 的结果」，
      // 而恢复流程内部已消费那次调用（§7 顺序：搬回 → stat → 原件 unarchive → attach）⇒ 显式 true。
      // 旧实现的裸 `return;` 让成功路径返回 undefined，调用方无法与「没走到」区分。
      assert.equal(hydrated, true, '水合成功必须返回 true（不是 undefined）');
      assert.equal(await exists(dir), true, '取消归档必须把文件搬回热目录');
      assert.equal(h.store.getSession(id).status, 'hot-restored');
      assert.equal(h.archived.has(id), false);
      assert.equal(h.calls.unarchive.length, 1);

      const failId = 'session-a13-fail';
      await h.addSession(failId);
      h.archived.add(failId);
      assert.equal((await h.engine.migrate(failId)).ok, true);
      await rm(h.coldDir(failId), { recursive: true, force: true });
      await assert.rejects(
        () => h.registry.unarchiveSession(failId),
        (err) => err && err.code === 'vault-hydrate-failed',
        '搬不回来必须抛明确错误',
      );
      assert.equal(h.archived.has(failId), true, '失败时不得假装取消归档成功');
      assert.equal(h.store.getSession(failId).error, 'lost');
    } finally {
      disposer();
    }
  } finally {
    await h.dispose();
  }
});

test('P1-4 A-17/A-9：restore 全程调 original；卸载后引用还原', async () => {
  const h = await createHarness();
  try {
    const originalArchive = h.registry.archiveSession;
    const originalUnarchive = h.registry.unarchiveSession;
    const disposer = installArchiveTracker({ registry: h.registry, engine: h.engine, getConfig: () => ({ hydrateOnUnarchive: true }), log: quiet });
    try {
      assert.notEqual(h.registry.unarchiveSession, originalUnarchive, '安装后应有包装');
      assert.notEqual(h.registry.archiveSession, originalArchive);

      const id = 'session-a17';
      await h.addSession(id);
      h.archived.add(id);
      assert.equal((await h.engine.migrate(id)).ok, true);
      const result = await h.engine.restore(id);
      assert.equal(result.ok, true);
      assert.equal(h.calls.unarchive.length, 1, 'restore 只调一次 original，不得重入包装');
    } finally {
      disposer();
    }
    assert.equal(h.registry.archiveSession, originalArchive, '卸载后引用必须还原（坑 2）');
    assert.equal(h.registry.unarchiveSession, originalUnarchive);
  } finally {
    await h.dispose();
  }
});

test('P1-4 跨卷迁移：copy + 校验 + 删源；中断时源完整、.partial 被清、可重试（A-6）', async () => {
  let failNextCopy = true;
  const h = await createHarness({
    sameVolume: async () => false,
    allowCrossVolume: true,
    copyFile: async (from, to) => {
      if (failNextCopy) {
        failNextCopy = false;
        throw new Error('simulated interruption');
      }
      const { copyFile } = await import('node:fs/promises');
      await copyFile(from, to);
    },
  });
  try {
    const id = 'session-cross';
    const dir = await h.addSession(id);
    const baseline = await hashTree(dir);
    h.archived.add(id);

    // 配置门仍须被验证（D13）：关掉 allowCrossVolume ⇒ 拒绝跨卷，且一个字节都不碰
    await h.configStore.save({ allowCrossVolume: false });
    const gated = await h.engine.migrate(id);
    assert.equal(gated.ok, false);
    assert.equal(gated.code, 'cross-volume-disabled', JSON.stringify(gated));
    assert.equal(await exists(dir), true, '配置门拒绝时源目录必须原样留着');
    assert.equal(await exists(h.coldDir(id)), false);
    assert.equal(await exists(h.coldDir(id) + '.partial'), false);
    // 显式开启后才进入跨卷 copy + 校验 + 删源路径
    await h.configStore.save({ allowCrossVolume: true });

    const first = await h.engine.migrate(id);
    assert.equal(first.ok, false);
    assert.equal(await exists(dir), true, '中断后源必须完整');
    assert.equal(await exists(h.coldDir(id) + '.partial'), false, '中断的 .partial 必须被清掉');
    assert.equal(h.store.getSession(id).status, 'hot');

    const retry = await h.engine.migrate(id);
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(await exists(dir), false);
    assert.equal((await hashTree(h.coldDir(id))).sha256, baseline.sha256);
    assert.equal(await exists(h.coldDir(id) + '.partial'), false);
  } finally {
    await h.dispose();
  }
});

test('P1-4 跨卷恢复：.part → 校验 → 最终名（最新代际最后）；中断不留半截热目录（A-14）', async () => {
  let copiesBeforeFailure = 0;
  let armed = false;
  const h = await createHarness({
    sameVolume: async () => false,
    allowCrossVolume: true,
    copyFile: async (from, to) => {
      if (armed && copiesBeforeFailure-- <= 0) throw new Error('simulated restore interruption');
      const { copyFile } = await import('node:fs/promises');
      await copyFile(from, to);
    },
  });
  try {
    const id = 'session-r14';
    const dir = await h.addSession(id, {
      logs: {
        'session.v3.jsonl.zstd': [JSON.stringify({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '旧代际' }] } })],
        'session.v4.jsonl.zstd': frames(id, h.cwd),
      },
    });
    h.archived.add(id);
    assert.equal((await h.engine.migrate(id)).ok, true);

    armed = true;
    copiesBeforeFailure = 1; // 第二个文件时中断
    const failed = await h.engine.restore(id);
    assert.equal(failed.ok, false);
    const hotFiles = await readdir(dir).catch(() => []);
    assert.equal(hotFiles.some((name) => name.endsWith('.part')), false, '不得留下 .part');
    assert.equal(hotFiles.length, 0, '半截热目录必须整目录丢弃（A-14）');
    assert.equal(h.store.getSession(id).status, 'cold');

    armed = false;
    const retry = await h.engine.restore(id);
    assert.equal(retry.ok, true, JSON.stringify(retry));
    const after = (await readdir(dir)).sort();
    assert.deepEqual(after, ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd']);
    assert.equal((await readdir(dir)).some((name) => name.endsWith('.part')), false);
  } finally {
    await h.dispose();
  }
});

test('P1-4 审计：manifest 查重键（迁移 id+op+moved_at；恢复 id+op+ts）', async () => {
  const h = await createHarness();
  try {
    const manifest = new Manifest(path.join(h.home, 'session-vault', 'manifest.jsonl'));
    const record = { ts: 1, op: 'migrate', id: 's1', movedAt: 7 };
    assert.equal(dedupKey(record), 's1|migrate|7');
    assert.equal(dedupKey({ ts: 9, op: 'restore', id: 's1' }), 's1|restore|9');
    assert.equal((await manifest.appendDedup(record)).skipped, false);
    assert.equal((await manifest.appendDedup(record)).skipped, true);
    const lines = (await readFile(path.join(h.home, 'session-vault', 'manifest.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const repaired = await manifest.repairIfMissing({ ts: 11, id: 's2' });
    assert.equal(repaired.repaired, true);
  } finally {
    await h.dispose();
  }
});
// ---------------------------------------------------------------------------
// 第二轮独立审计（2026-10-23）修复的验收锚
// ---------------------------------------------------------------------------

const v0Frames = (id, cwd) => [
  JSON.stringify({ type: 'session', version: 0, id, createdAt: 1791000000000, cwd }),
  JSON.stringify({ type: 'user/message', seq: 1, time: 1791000001000, data: { content: [{ type: 'text', text: '旧格式里的人话' }] } }),
  JSON.stringify({
    type: 'assistant/message',
    seq: 2,
    time: 1791000002000,
    data: { message: { content: [{ type: 'reasoning', text: '旧推理不该入索引' }, { type: 'text', text: '旧格式的回复' }] } },
  }),
];

/** 造「热侧只有 .part、没有合法代际」的跨卷恢复残留。 */
async function writePartResidue(h, id) {
  const dir = path.join(h.paths.sessionsRoot, h.pk, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'session.v4.jsonl.zstd.part'), Buffer.from('partial-copy'));
  return dir;
}

test('A-19（6 号项）：假 fs 断言所有写/删路径前缀 ∈ 白名单根（含 rm），越界必抛', async () => {
  const real = await import('node:fs/promises');
  const ops = [];
  const fs = {
    mkdir: async (target, options) => { ops.push({ kind: 'mkdir', path: target }); return real.mkdir(target, options); },
    rename: async (from, to) => { ops.push({ kind: 'rename', from, to }); return real.rename(from, to); },
    rm: async (target, options) => { ops.push({ kind: 'rm', path: target }); return real.rm(target, options); },
    unlink: async (target) => { ops.push({ kind: 'unlink', path: target }); return real.unlink(target); },
  };
  const h = await createHarness({ fs, sameVolume: async () => false, allowCrossVolume: true });
  try {
    const id = 'session-writelog';
    await h.addSession(id, {
      logs: {
        'session.v3.jsonl.zstd': [JSON.stringify({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '旧代际' }] } })],
        'session.v4.jsonl.zstd': frames(id, h.cwd),
      },
    });
    h.archived.add(id);
    assert.equal((await h.engine.migrate(id)).ok, true);
    assert.equal((await h.engine.restore(id)).ok, true);
    await writePartResidue(h, 'session-writelog-residue');
    await h.engine.cleanupPartials({ partials: 0 });

    const home = path.resolve(h.home).toLowerCase();
    const roots = [h.paths.vaultRoot, h.paths.sessionsRoot, h.paths.coldRootDefault].map((root) => path.resolve(root).toLowerCase());
    const inside = (target) => {
      const value = path.resolve(target).toLowerCase();
      return roots.some((root) => value === root || value.startsWith(root + path.sep));
    };
    assert.ok(ops.length > 0, '必须真的产生过写操作');
    for (const op of ops) {
      const target = op.path || op.to;
      assert.ok(target.toLowerCase().startsWith(home), '写路径必须在 DSH_HOME 之内：' + target);
      assert.ok(inside(target), '写路径必须在 {vaultRoot, coldRoot, sessionsRoot} 之内：' + target);
    }
    assert.ok(ops.some((op) => op.kind === 'rm'), '本用例必须覆盖 rm（删热源/清残留）');
    assert.ok(ops.some((op) => op.kind === 'rename'), '本用例必须覆盖 rename');
    assert.ok(ops.every((op) => !op.from || inside(op.from)), 'rename 的源端也必须落在白名单内');
    // 负向：白名单外一律抛（不是静默忽略）
    assert.throws(() => h.engine.assertWritable(path.join(os.tmpdir(), 'session-vault-outside', 'x')), /写路径越界/);
    const writeLog = h.engine.getWriteLog();
    assert.equal(
      writeLog.every((target) => target.toLowerCase().startsWith(home)),
      true,
      'A-19：writeLog 里不得出现 DSH_HOME 之外的路径',
    );
    assert.ok(writeLog.some((target) => target.includes('markers')), 'marker 写入也要过写路径白名单');
    assert.ok(writeLog.some((target) => target.includes('manifest.jsonl')), 'manifest 追加也要过写路径白名单');
    assert.ok(writeLog.length > ops.length, 'writeLog 覆盖的范围应比假 fs 更广（含 marker/manifest/mkdir）');
  } finally {
    await h.dispose();
  }
});

test('4 号项：无 marker 基线时 restore 绝不删冷源（双份保留 + needs-review）；有基线才续跑', async () => {
  const h = await createHarness();
  try {
    const id = 'session-nobase';
    const dir = await h.addSession(id);
    h.archived.add(id);
    assert.equal((await h.engine.migrate(id)).ok, true);
    const cold = h.coldDir(id);
    // 造「双份 + 无 marker」：把冷目录原样复制回热目录（模拟恢复中断在搬移前后）
    await mkdir(dir, { recursive: true });
    for (const name of await readdir(cold)) await copyFile(path.join(cold, name), path.join(dir, name));
    h.store.updateSession(id, { status: 'cold', error: null });
    const blocked = await h.engine.restore(id);
    assert.equal(blocked.ok, false, JSON.stringify(blocked));
    assert.equal(blocked.code, 'needs-review');
    assert.equal(await exists(dir), true, '热侧不得删');
    assert.equal(await exists(cold), true, '冷侧不得删（无基线＝不许删源）');
    assert.equal(h.store.getSession(id).error, 'needs-review');

    // 正对照：marker 有全量基线且热侧与基线一致 → 允许清冷残留并续跑
    const id2 = 'session-withbase';
    const dir2 = await h.addSession(id2);
    h.archived.add(id2);
    assert.equal((await h.engine.migrate(id2)).ok, true);
    const cold2 = h.coldDir(id2);
    const base = await hashTree(cold2);
    await mkdir(dir2, { recursive: true });
    for (const name of await readdir(cold2)) await copyFile(path.join(cold2, name), path.join(dir2, name));
    await h.engine.markers.write(id2, {
      op: 'restore', phase: 'moved', src: cold2, dst: dir2, coldRoot: h.paths.coldRootDefault,
      projectKey: h.pk, relDir: h.pk + '/' + id2, logNames: 'session.v4.jsonl.zstd',
      currentGeneration: 'session.v4.jsonl.zstd', bytes: base.bytes, planSha: base.sha256, files: base.files,
    });
    h.store.updateSession(id2, { status: 'restoring', error: null });
    const resumed = await h.engine.restore(id2);
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(await exists(cold2), false, '热侧通过基线 ⇒ 清冷残留');
    assert.equal(await exists(dir2), true);
    assert.equal(h.store.getSession(id2).status, 'hot-restored');

    // 冷侧已不在 + marker 在 + 热侧与基线不一致 → 不得当成「已完成恢复」去 unarchive
    const id3 = 'session-hotonly-bad';
    const dir3 = await h.addSession(id3);
    h.archived.add(id3);
    assert.equal((await h.engine.migrate(id3)).ok, true);
    const cold3 = h.coldDir(id3);
    const base3 = await hashTree(cold3);
    await rename(cold3, dir3);
    await writeFile(path.join(dir3, 'session.v4.jsonl.zstd'), Buffer.from('truncated-half-copy'));
    await h.engine.markers.write(id3, {
      op: 'restore', phase: 'moved', src: cold3, dst: dir3, coldRoot: h.paths.coldRootDefault,
      projectKey: h.pk, relDir: h.pk + '/' + id3, logNames: 'session.v4.jsonl.zstd',
      currentGeneration: 'session.v4.jsonl.zstd', bytes: base3.bytes, planSha: base3.sha256, files: base3.files,
    });
    h.store.updateSession(id3, { status: 'restoring', error: null });
    const blockedResume = await h.engine.restore(id3);
    assert.equal(blockedResume.ok, false);
    assert.equal(blockedResume.code, 'needs-review');
    assert.equal(h.archived.has(id3), true, '不得对半截热目录调 unarchive');
    assert.equal(h.calls.unarchive.includes(id3), false);
    assert.equal(await exists(dir3), true);
  } finally {
    await h.dispose();
  }
});

test('5 号项：cleanupPartials 删残留前先探测冷侧（不可用保留 + 只读降级；冷副本缺失也保留）', async () => {
  const h = await createHarness();
  try {
    // ① 冷根不可用（父路径是文件 ⇒ mkdir 必失败）→ 一个字节都不删
    const blockedFile = path.join(h.home, 'blocked-file');
    await writeFile(blockedFile, 'x');
    await h.configStore.save({ coldRoot: path.join(blockedFile, 'cold') });
    const kept = await writePartResidue(h, 'session-res-blocked');
    const countsBlocked = {};
    await h.engine.cleanupPartials(countsBlocked);
    assert.equal(await exists(kept), true, '冷卷不可用时热侧残留必须保留');
    assert.ok(countsBlocked.coldUnavailable >= 1, JSON.stringify(countsBlocked));
    assert.equal(h.engine.coldDegraded, true, 'A-7：冷根不可用要落只读降级标记');

    // ② 冷根可用但没有该会话的冷副本 → 保留（可能是唯一线索）
    const h2 = await createHarness();
    try {
      const kept2 = await writePartResidue(h2, 'session-res-nocopy');
      const counts2 = {};
      await h2.engine.cleanupPartials(counts2);
      assert.equal(await exists(kept2), true, '冷侧没有完整副本时不得删热侧残留');
      assert.ok(counts2.hotResidueKept >= 1, JSON.stringify(counts2));
      assert.equal(h2.engine.coldDegraded, false);

      // ③ 冷侧有完整副本 → 残留可删（可重试）
      const id3 = 'session-res-ok';
      const kept3 = await writePartResidue(h2, id3);
      const coldDir = h2.coldDir(id3);
      await mkdir(coldDir, { recursive: true });
      await writeFile(
        path.join(coldDir, 'session.v4.jsonl.zstd'),
        zstdCompressSync(Buffer.from(JSON.stringify({ type: 'request/header', sessionId: id3, cwd: h2.cwd }) + '\n')),
      );
      const counts3 = {};
      await h2.engine.cleanupPartials(counts3);
      assert.equal(await exists(kept3), false, '冷副本在 ⇒ 热侧半成品可删（可重试）');
      assert.ok(counts3.partials >= 1);
    } finally {
      await h2.dispose();
    }
  } finally {
    await h.dispose();
  }
});

test('7 号项：跨卷「删源中断（部分删）」→ 按 marker 基线逐文件补齐并继续；补不齐则 needs-review', async () => {
  const h = await createHarness({ sameVolume: async () => false, allowCrossVolume: true });
  try {
    const seed = async (id) => {
      const dir = await h.addSession(id, {
        logs: {
          'session.v3.jsonl.zstd': [JSON.stringify({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '旧代际' }] } })],
          'session.v4.jsonl.zstd': frames(id, h.cwd),
        },
      });
      const baseline = await hashTree(dir);
      h.archived.add(id);
      assert.equal((await h.engine.migrate(id)).ok, true);
      const cold = h.coldDir(id);
      const marker = {
        op: 'migrate', phase: 'moved', src: dir, dst: cold, coldRoot: h.paths.coldRootDefault,
        projectKey: h.pk, relDir: h.pk + '/' + id,
        logNames: 'session.v3.jsonl.zstd,session.v4.jsonl.zstd', currentGeneration: 'session.v4.jsonl.zstd',
        formatVersion: 4, bytes: baseline.bytes, planSha: baseline.sha256, files: baseline.files,
        headerCwd: h.cwd, title: '', archivedAt: Date.now(), createdAt: Date.now(),
      };
      return { dir, cold, baseline, marker };
    };

    // ① 热残留（只删到一半）→ 逐文件比对通过 ⇒ 删残留 + 续尾段
    const one = await seed('session-pdel');
    await h.engine.markers.write('session-pdel', one.marker);
    await mkdir(one.dir, { recursive: true });
    await copyFile(path.join(one.cold, 'session.v3.jsonl.zstd'), path.join(one.dir, 'session.v3.jsonl.zstd'));
    h.store.updateSession('session-pdel', { status: 'migrating' });
    let report = await h.engine.recoverOnBoot();
    assert.equal(report.counts.needsReview, 0, JSON.stringify(report.counts));
    assert.equal(await exists(one.dir), false, '残留热文件（逐文件与基线一致）应被删');
    assert.equal((await hashTree(one.cold)).sha256, one.baseline.sha256);
    assert.equal(h.store.getSession('session-pdel').status, 'cold');
    assert.equal(await exists(h.markerPath('session-pdel')), false);

    // ② 冷侧缺一个文件、热侧还在 → 补齐冷侧后继续
    const two = await seed('session-refill');
    await h.engine.markers.write('session-refill', two.marker);
    await mkdir(two.dir, { recursive: true });
    await copyFile(path.join(two.cold, 'session.v3.jsonl.zstd'), path.join(two.dir, 'session.v3.jsonl.zstd'));
    await rm(path.join(two.cold, 'session.v3.jsonl.zstd'), { force: true });
    h.store.updateSession('session-refill', { status: 'migrating' });
    report = await h.engine.recoverOnBoot();
    assert.equal(report.counts.needsReview, 0, JSON.stringify(report.counts));
    assert.equal((await hashTree(two.cold)).sha256, two.baseline.sha256, '缺的文件必须从热侧按基线补齐');
    assert.deepEqual((await readdir(two.cold)).sort(), ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd']);
    assert.equal(await exists(two.dir), false);

    // ③ 热残留含「基线之外/被改」的内容 → 不能补 ⇒ needs-review，双份保留
    const three = await seed('session-norepair');
    await h.engine.markers.write('session-norepair', three.marker);
    await mkdir(three.dir, { recursive: true });
    await writeFile(path.join(three.dir, 'session.v4.jsonl.zstd'), Buffer.from('tampered-new-content'));
    h.store.updateSession('session-norepair', { status: 'migrating' });
    report = await h.engine.recoverOnBoot();
    assert.ok(report.counts.needsReview >= 1, JSON.stringify(report.counts));
    assert.equal(h.store.getSession('session-norepair').error, 'needs-review');
    assert.equal(await exists(three.dir), true, '不能补齐时热侧一个字节都不能删');
    assert.equal(await exists(three.cold), true, '不能补齐时冷侧一个字节都不能删');
    assert.equal(await exists(h.markerPath('session-norepair')), true, 'marker 保留作为人工处置证据');
  } finally {
    await h.dispose();
  }
});

test('8 号项（A-22）：v0/v3 旧格式（无 source）入索引；v4 缺 source 仍 fail-closed', async () => {
  const h = await createHarness();
  try {
    const v0 = 'session-legacy-v0';
    await h.addSession(v0, { logs: { 'session.jsonl.zstd': v0Frames(v0, h.cwd) } });
    h.archived.add(v0);
    const migrated = await h.engine.migrate(v0);
    assert.equal(migrated.ok, true, JSON.stringify(migrated));
    const row = h.store.getSession(v0);
    assert.equal(row.format_version, 0);
    assert.equal(row.user_msgs, 1, 'v0 的 user/message 必须被当成真人输入');
    assert.ok(h.store.searchDocs('旧格式里的人话').hits.length >= 1, 'v0 会话必须可搜（旧实现 docs==0 → extract-empty）');
    assert.equal(h.store.searchDocs('旧推理').hits.length, 0, 'reasoning 仍不入索引');

    const v4 = 'session-legacy-v4';
    await h.addSession(v4, {
      logs: {
        'session.v4.jsonl.zstd': [
          JSON.stringify({ type: 'request/header', sessionId: v4, cwd: h.cwd, createdAt: 1791000000000 }),
          JSON.stringify({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'v4 缺 source 的人话' }] } }),
        ],
      },
    });
    h.archived.add(v4);
    assert.equal((await h.engine.migrate(v4)).ok, true, '索引失败不阻塞迁移（R-9）');
    assert.equal(h.store.getSession(v4).error, 'extract-empty', 'v4 缺 source.kind 必须 fail-closed');
    assert.equal(h.store.searchDocs('v4 缺 source').hits.length, 0);
    assert.equal(await exists(h.coldDir(v4)), true);
  } finally {
    await h.dispose();
  }
});

test('A-22 真实 v0 样本只读回归：真实 ~/.dsh 的 v0 会话可抽取，且文件未被改动', async (t) => {
  const realRoot = path.join(os.homedir(), '.dsh', 'sessions');
  let sample = null;
  try {
    const projects = await readdir(realRoot, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory() || sample) continue;
      const sessions = await readdir(path.join(realRoot, project.name), { withFileTypes: true }).catch(() => []);
      for (const session of sessions) {
        if (!session.isDirectory() || sample) continue;
        const dir = path.join(realRoot, project.name, session.name);
        const files = await readdir(dir).catch(() => []);
        if (!files.includes('session.jsonl.zstd')) continue;
        const file = path.join(dir, 'session.jsonl.zstd');
        const info = await stat(file);
        if (info.size > 800000) continue;
        const docs = [];
        const stats = { legacyNoSource: 0 };
        try {
          await forEachJsonLine(file, async (line) => {
            const parsed = parseLine(line);
            if (!parsed.ok) return;
            const extracted = extractEvent(parsed.value, docs.length, { legacy: true });
            if (extracted.stats.legacyNoSource) stats.legacyNoSource += 1;
            for (const doc of extracted.docs) docs.push(doc);
          });
        } catch {
          continue;
        }
        if (!docs.some((doc) => doc.type === 'user')) continue;
        sample = { dir, file, before: { size: info.size, mtimeMs: info.mtimeMs }, docs, stats };
      }
    }
  } catch {
    sample = null;
  }
  if (!sample) {
    // 7 号项（🔵）：台账必须能区分「绿」与「没跑」。t.skip 只把这条从 pass 挪进 skipped，
    // 输出里不出现任何名字 ⇒ 很容易被读成「这条也绿了」。显式打一行机器可读诊断。
    t.diagnostic('real-sample skipped: 本机没有可用的真实 v0 样本（~/.dsh/sessions 不存在或没有带 user/message 的 v0 会话）');
    t.skip('本机没有可用的真实 v0 样本（~/.dsh/sessions 不存在或没有带 user/message 的 v0 会话）');
    return;
  }
  t.diagnostic('real-sample ran: ' + sample.dir);
  assert.equal(isLegacyFormat(0), true);
  assert.ok(sample.docs.length > 0, '真实 v0 样本必须抽出文档');
  assert.ok(sample.docs.some((doc) => doc.type === 'assistant'), 'assistant 的 text 也应收');
  const after = await stat(sample.file);
  assert.equal(after.size, sample.before.size, '只读回归：不得改动真实日志');
  assert.equal(after.mtimeMs, sample.before.mtimeMs, '只读回归：mtime 不得变化');
});

test('AC-2（11 号项）：恢复后工作区重新挂上（命中 / 已在槽位 / 失败不阻断）', async () => {
  const attached = [];
  const h = await createHarness({ workspace: { sessionIds: [], attachSession: async (id) => { attached.push(id); } } });
  try {
    const id = 'session-attach';
    await h.addSession(id);
    h.archived.add(id);
    assert.equal((await h.engine.migrate(id)).ok, true);
    const result = await h.engine.restore(id);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.attach, { attached: true });
    assert.deepEqual(attached, [id], 'attachSession 必须被调用（AC-2：工作区重新挂上）');
  } finally {
    await h.dispose();
  }

  const slotted = await createHarness({
    workspace: { sessionIds: ['session-slotted'], attachSession: async () => { throw new Error('不该调用'); } },
  });
  try {
    const id = 'session-slotted';
    await slotted.addSession(id);
    slotted.archived.add(id);
    assert.equal((await slotted.engine.migrate(id)).ok, true);
    const result = await slotted.engine.restore(id);
    assert.equal(result.ok, true);
    assert.deepEqual(result.attach, { attached: false, reason: 'already-slotted' });
  } finally {
    await slotted.dispose();
  }

  const failing = await createHarness({
    workspace: { sessionIds: [], attachSession: async () => { throw new Error('attach-boom'); } },
  });
  try {
    const id = 'session-attach-fail';
    await failing.addSession(id);
    failing.archived.add(id);
    assert.equal((await failing.engine.migrate(id)).ok, true);
    const result = await failing.engine.restore(id);
    assert.equal(result.ok, true, '挂回失败不阻断恢复（D6′ / BL-3）');
    assert.equal(result.attach.attached, false);
    assert.match(String(result.attach.reason), /attach-boom/);
    assert.equal(failing.store.getSession(id).status, 'hot-restored');
  } finally {
    await failing.dispose();
  }
});

test('A-16（11 号项）：改冷根后，旧根上的会话仍可一键恢复', async () => {
  const h = await createHarness();
  try {
    const id = 'session-multicold';
    const dir = await h.addSession(id);
    h.archived.add(id);
    assert.equal((await h.engine.migrate(id)).ok, true);
    const oldCold = h.coldDir(id);
    const saved = await h.configStore.save({ coldRoot: path.join(h.home, 'cold-moved') });
    assert.equal(saved.ok, true, JSON.stringify(saved.errors));
    h.engine.invalidate();
    const result = await h.engine.restore(id);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await exists(dir), true);
    assert.equal(await exists(oldCold), false, '旧冷根的副本应被搬走（按行记忆的绝对冷根，D17）');
    assert.equal(h.store.getSession(id).status, 'hot-restored');
  } finally {
    await h.dispose();
  }
});

test('9 号项：list/status 提供 archiveAgeDays（阈值不再恒 —），归档回填带 archivedAt', async () => {
  const h = await createHarness();
  try {
    const id = 'session-archmeta';
    await h.addSession(id);
    h.archived.add(id);
    await h.engine.recoverOnBoot();
    const row = h.store.getSession(id);
    assert.ok(row && row.archived_at, 'FR-2：存量归档 id 启动回填 archivedAt');
    assert.equal(row.backfilled, 1);
    assert.equal(row.status, 'hot');

    const list = await h.engine.list();
    assert.equal(list.stats.archiveAgeDays, 14, '阈值统计必须有真实读数（旧 UI 恒 —）');
    assert.equal(list.stats.autoMigrate, false);
    const item = list.items.find((entry) => entry.id === id);
    assert.ok(item && item.archivedAt, '列表项必须带 archivedAt（归档时间列的数据面）');

    const status = await h.engine.status();
    assert.equal(status.stats.archiveAgeDays, 14);
    assert.equal(status.stats.autoMigrate, false);

    // FR-14：恢复过的行要出现在列表里（行操作「归档」有真实目标），归档后 archivedAt 落库
    const restoredId = 'session-restored-row';
    await h.addSession(restoredId);
    h.archived.add(restoredId);
    assert.equal((await h.engine.migrate(restoredId)).ok, true);
    assert.equal((await h.engine.restore(restoredId)).ok, true);
    h.engine.invalidate();
    const afterRestore = await h.engine.list();
    assert.ok(afterRestore.items.some((entry) => entry.id === restoredId && entry.status === 'hot-restored'), '恢复后的行必须在列表里');
    const archivedAgain = await h.engine.archiveSession(restoredId);
    assert.equal(archivedAgain.ok, true);
    assert.ok(h.store.getSession(restoredId).archived_at, '归档成功后必须记录 archivedAt（FR-2/FR-14）');
  } finally {
    await h.dispose();
  }
});

test('12 号项：冷根不可用 / AM 在场 → banners 是真读数（旧实现恒 false / null）', async () => {
  const h = await createHarness();
  try {
    const blockedFile = path.join(h.home, 'blocked-banner');
    await writeFile(blockedFile, 'x');
    await h.configStore.save({ coldRoot: path.join(blockedFile, 'cold') });
    // A-7：冷根不可用 ⇒ 迁移被拒（只读降级），源目录一个字节都不动
    const id = 'session-cold-gone';
    const dir = await h.addSession(id);
    h.archived.add(id);
    const denied = await h.engine.migrate(id);
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'cold-unavailable', JSON.stringify(denied));
    assert.equal(await exists(dir), true, 'A-7：冷根不可用时不得搬移/删除源');
    h.archived.delete(id);
    const list = await h.engine.list();
    assert.equal(list.banners.coldUnavailable, true);
    assert.equal(list.banners.coldRoots.some((item) => item.available === false), true);
    assert.equal(list.coldDegraded, true);
    const status = await h.engine.status();
    assert.equal(status.vault.coldRootAvailable, false);
    assert.equal(status.banners.coldUnavailable, true);
  } finally {
    await h.dispose();
  }

  const am = await createHarness();
  try {
    const profileDir = path.join(am.home, 'profiles', 'desktop');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      path.join(profileDir, 'package.json'),
      JSON.stringify({ dependencies: { '@michengai/dsh-archive-manager': '1.1.6' } }),
    );
    const detected = await am.engine.detectAm();
    assert.equal(detected.present, true, JSON.stringify(detected));
    assert.ok(detected.matches.some((item) => /archive-manager/.test(item.id)));
    assert.ok(detected.sources.includes('profile:desktop'), JSON.stringify(detected.sources));
    const list = await am.engine.list();
    assert.equal(list.banners.am.present, true);
    assert.equal(list.banners.am.matches[0].id, '@michengai/dsh-archive-manager');
  } finally {
    await am.dispose();
  }
});

test('13 号项 + F3：归档包装自检（被后装插件覆盖 ⇒ 自动重装，未修复时 drifted 进 UI 读数）', async () => {
  const h = await createHarness();
  try {
    const disposer = installArchiveTracker({
      registry: h.registry,
      engine: h.engine,
      getConfig: () => ({ hydrateOnUnarchive: true }),
      log: quiet,
    });
    try {
      const healthy = h.engine.verifyOverlay();
      assert.equal(healthy.installed, true);
      assert.equal(healthy.drifted, false);
      const list = await h.engine.list();
      assert.equal(list.banners.overlay.installed, true);
      assert.equal(list.banners.overlay.drifted, false);

      // F3：被第三方覆盖 ⇒ 下一次 reconcile **自动链式重装**（drifted 归零，并记录谁覆盖了我们）。
      const original = h.registry.archiveSession;
      h.registry.archiveSession = async function thirdPartyArchive() {};
      const repaired = h.engine.verifyOverlay();
      assert.equal(repaired.drifted, false, 'F3：漂移必须被自动重装修复');
      assert.equal(repaired.archiveOk, true);
      const list2 = await h.engine.list();
      assert.equal(list2.banners.overlay.drifted, false);
      assert.equal(list2.banners.overlay.replacedBy.archive.name, 'thirdPartyArchive', '必须记录谁覆盖了我们');
      assert.ok(list2.banners.overlay.reinstalls >= 1);
      h.registry.archiveSession = original;

      // 关掉自愈（autoRepair:false）时，漂移必须如实暴露（不再静默）。
      h.engine.overlayRepair = null;
      h.registry.archiveSession = async function anotherPlugin() {};
      const drifted = h.engine.verifyOverlay({ autoRepair: false });
      assert.equal(drifted.drifted, true);
      assert.equal(drifted.archiveOk, false);

      // 列表读口同样触发 reconcile（F3：任一读口都能自愈，UI 不必等下一轮清扫）。
      const list3 = await h.engine.list();
      assert.equal(list3.banners.overlay.drifted, false, 'F3：/list 读口也要自动重装');
      assert.equal(list3.banners.overlay.replacedBy.archive.name, 'anotherPlugin');
      assert.ok(list3.banners.overlay.autoRepair === true);
      h.registry.archiveSession = original;
    } finally {
      disposer();
    }
  } finally {
    await h.dispose();
  }
});
// ---------------------------------------------------------------------------
// 第三轮小修（代码评审剩余 4 条 🔵 中的 2 条引擎侧）
// ---------------------------------------------------------------------------

test('R3-1（R-26）：archiveAgeDays=0「关闭」时 list/status 的 pendingCount/pendingBytes 恒 0', async () => {
  const h = await createHarness();
  try {
    const id = 'session-agezero';
    await h.addSession(id);
    h.archived.add(id);
    await h.engine.recoverOnBoot();
    const row = h.store.getSession(id);
    assert.ok(row && row.status === 'hot', '前提：一条 hot 归档行');
    // 造「够老」的行：lastActiveAt = max(docs.time, file_mtime_ms, created_at)
    const old = Date.now() - 40 * 86400 * 1000;
    h.store.updateSession(id, { file_mtime_ms: old, created_at: old });
    h.engine.invalidate();

    // 正对照：阈值 > 0 时，respect=false（list/status 的读数路径）必须真的数得到它——
    // 否则下面「=0 ⇒ 0」可能只是因为这一行从来不是候选（空转断言）。
    await h.configStore.save({ autoMigrate: false, archiveAgeDays: 14 });
    h.engine.invalidate();
    const counted = await h.engine.list();
    assert.equal(counted.stats.pendingCount, 1, JSON.stringify(counted.stats));
    assert.ok(counted.stats.pendingBytes > 0);
    assert.equal((await h.engine.status()).stats.candidates, 1);

    // 阈值 0 = 关闭：与 respectAutoMigrate 无关（旧实现只在 respect 分支早退）
    await h.configStore.save({ archiveAgeDays: 0 });
    h.engine.invalidate();
    assert.deepEqual(await h.engine.candidates(50), [], '阈值 0 不得有候选');
    assert.deepEqual(
      await h.engine.candidates(50, { respectAutoMigrate: false }),
      [],
      'respect=false 也必须遵守「0=关闭」（list/status 走的就是这条）',
    );
    const list = await h.engine.list();
    assert.equal(list.stats.pendingCount, 0, '阈值 0 时 pendingCount 必须为 0');
    assert.equal(list.stats.pendingBytes, 0, '阈值 0 时 pendingBytes 必须为 0');
    assert.equal(list.stats.autoMigrate, false);
    const status = await h.engine.status();
    assert.equal(status.stats.candidates, 0);
    assert.equal(status.stats.candidatesBytes, 0);
    assert.equal(status.stats.archiveAgeDays, 0);
    assert.equal(h.store.getSession(id).status, 'hot', '统计读数不得挪动行状态');
  } finally {
    await h.dispose();
  }
});

test('R3-2（R-11）：meta 缺 logNames/currentGeneration 时兜底索引最高代际（v3+v4 目录只索引 v4）', async () => {
  const h = await createHarness();
  try {
    const id = 'session-fallback-gen';
    const dir = await h.addSession(id, {
      logs: {
        'session.v3.jsonl.zstd': [JSON.stringify({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '只有 v3 才有的句子' }] } })],
        'session.v4.jsonl.zstd': frames(id, h.cwd),
      },
    });
    h.archived.add(id);
    await h.engine.recoverOnBoot();
    assert.ok(h.store.getSession(id), '前提：有 DB 行（indexSession 会写回行）');
    h.store.replaceDocs(id, []);
    assert.equal(h.store.countDocs(id), 0);

    // marker 缺 logNames / currentGeneration 的续跑与冷根导入路径：meta 为空 ⇒ 走目录兜底
    const collected = await h.engine.collectIndex(id, dir, {});
    assert.equal(collected.ok, true, JSON.stringify(collected));
    assert.equal(collected.currentGeneration, 'session.v4.jsonl.zstd', '兜底必须取最高代际（不是 readdir 里的首个）');
    assert.equal(collected.formatVersion, 4);
    assert.equal(collected.legacy, false);

    const indexed = await h.engine.indexSession(id, dir, {});
    assert.equal(indexed.ok, true, JSON.stringify(indexed));
    assert.ok(h.store.searchDocs('归档保险库').hits.length >= 1, 'v4 的正文必须入索引');
    assert.equal(h.store.searchDocs('只有').hits.length, 0, 'v3 低代际文本不得入索引（R-11）');
    const texts = h.store.prepare('SELECT text FROM docs WHERE session_id = ?').all(id).map((entry) => String(entry.text));
    assert.ok(texts.length > 0, 'docs 不能是空集');
    assert.equal(texts.some((text) => text.includes('只有 v3')), false, 'docs 里不得出现 v3 文本');

    // 反向对照：logNames 乱序时也必须取最高代际（排序，不是数组顺序）
    const unsorted = await h.engine.collectIndex(id, dir, { logNames: 'session.v4.jsonl.zstd,session.v3.jsonl.zstd' });
    assert.equal(unsorted.currentGeneration, 'session.v4.jsonl.zstd', 'logNames 乱序也要取最高代际');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// 第四轮微修（代码评审 PASS 后的 🟡/🔵）
// ---------------------------------------------------------------------------

test('4A-1（1 号项）：**同卷**迁移+恢复的写/删路径全走统一写入口（不注入 sameVolume）', async () => {
  const real = await import('node:fs/promises');
  const ops = [];
  const fs = {
    mkdir: async (target, options) => { ops.push({ kind: 'mkdir', path: target }); return real.mkdir(target, options); },
    rename: async (from, to) => { ops.push({ kind: 'rename', from, to }); return real.rename(from, to); },
    rm: async (target, options) => { ops.push({ kind: 'rm', path: target }); return real.rm(target, options); },
    unlink: async (target) => { ops.push({ kind: 'unlink', path: target }); return real.unlink(target); },
  };
  // **不注入 sameVolume** ⇒ 走真实判定（临时目录与默认冷根同卷 ⇒ 同卷分支）。
  const h = await createHarness({ fs });
  try {
    const id = 'session-samevol';
    const dir = await h.addSession(id, {
      logs: {
        'session.v3.jsonl.zstd': [JSON.stringify({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '旧代际' }] } })],
        'session.v4.jsonl.zstd': frames(id, h.cwd),
      },
    });
    const baseline = await hashTree(dir);
    h.archived.add(id);
    assert.equal(await h.engine.sameVolume(dir, h.coldDir(id)), true, '前提：本用例必须落在同卷分支');

    const migrated = await h.engine.migrate(id);
    assert.equal(migrated.ok, true, JSON.stringify(migrated));
    const cold = h.coldDir(id);
    assert.ok(
      ops.some((op) => op.kind === 'rename' && op.from === dir && op.to === cold),
      '同卷迁移的 rename 必须经 fsOps（= writeOp/assertWritable），不得直调 fs: ' + JSON.stringify(ops),
    );

    const opsBeforeRestore = ops.length;
    const restored = await h.engine.restore(id);
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const restoreOps = ops.slice(opsBeforeRestore);
    // 旧实现：同卷恢复直接 `mkdir`/`rename`，假 fs 一条都看不见 ⇒ 下面两条断言必然失败。
    assert.ok(
      restoreOps.some((op) => op.kind === 'mkdir' && String(op.path).toLowerCase().startsWith(path.resolve(h.paths.sessionsRoot).toLowerCase())),
      '同卷恢复必须先 mkdirp 目标父目录（经 writeOp）：' + JSON.stringify(restoreOps),
    );
    assert.ok(
      restoreOps.some((op) => op.kind === 'rename' && op.from === cold && op.to === dir),
      '同卷恢复的 rename 必须经 fsOps（冷 → 热）：' + JSON.stringify(restoreOps),
    );

    // 全部写/删路径 ∈ 白名单根，且都在 DSH_HOME 内（A-19 口径，同卷分支也一视同仁）
    const home = path.resolve(h.home).toLowerCase();
    const roots = [h.paths.vaultRoot, h.paths.sessionsRoot, h.paths.coldRootDefault].map((root) => path.resolve(root).toLowerCase());
    const inside = (target) => {
      const value = path.resolve(target).toLowerCase();
      return roots.some((root) => value === root || value.startsWith(root + path.sep));
    };
    assert.ok(ops.length > 0, '必须真的产生过写操作');
    for (const op of ops) {
      const target = op.path || op.to;
      assert.ok(String(target).toLowerCase().startsWith(home), '写路径必须在 DSH_HOME 之内：' + target);
      assert.ok(inside(target), '写路径必须在 {vaultRoot, coldRoot, sessionsRoot} 之内：' + target);
      assert.ok(!op.from || inside(op.from), 'rename 的源端也必须落在白名单内：' + op.from);
    }
    const writeLog = h.engine.getWriteLog();
    assert.ok(writeLog.includes(path.resolve(dir)), '同卷恢复的目标（热目录）必须过 assertWritable（写日志里要有）');
    assert.ok(writeLog.every((target) => target.toLowerCase().startsWith(home)), 'writeLog 不得出现 DSH_HOME 之外的路径');
    assert.equal((await hashTree(dir)).sha256, baseline.sha256, '往返后内容与基线一致');
  } finally {
    await h.dispose();
  }
});

test('4A-3（3 号项①）：marker 写失败 ⇒ status 回滚 hot（不卡死在 migrating，且可重试）', async () => {
  const h = await createHarness();
  try {
    const id = 'session-marker-fail';
    const dir = await h.addSession(id);
    h.archived.add(id);

    const originalWrite = h.engine.markers.write.bind(h.engine.markers);
    h.engine.markers.write = async () => { throw new Error('marker-disk-full'); };
    try {
      const failed = await h.engine.migrate(id);
      assert.equal(failed.ok, false);
      assert.equal(failed.code, 'marker-failed', JSON.stringify(failed));
      const stuck = h.store.getSession(id);
      assert.equal(stuck.status, 'hot', 'marker 写失败必须回滚 hot（否则 preflight 以 not-candidate 永久拒绝重试）');
      assert.match(String(stuck.error), /^marker-failed: marker-disk-full/, '诊断必须落在行上：' + stuck.error);
      assert.equal(await exists(dir), true, '源目录一个字节都不能动');
      assert.equal(await exists(h.coldDir(id)), false, '不得留下冷目录');
      assert.equal(await exists(h.markerPath(id)), false, '没有 marker（写就失败了）');
    } finally {
      h.engine.markers.write = originalWrite;
    }

    // 重试：旧实现在这里返回 not-candidate（status=migrating ⇒ 只有 hot 行可迁移）
    const retried = await h.engine.migrate(id);
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(h.store.getSession(id).status, 'cold');
    assert.equal(h.store.getSession(id).error, null, '迁移成功后诊断清空');
  } finally {
    await h.dispose();
  }
});

test('4A-6（6 号项 / R-17）：seq 跳号只落诊断（error/meta），不整会话拒收', async () => {
  const h = await createHarness();
  try {
    const id = 'session-seqgap';
    // 事件流 seq：1,2 → 40,41（中间 37 个号缺失）。docs 照常入库。
    const dir = await h.addSession(id, {
      logs: {
        'session.v4.jsonl.zstd': [
          JSON.stringify({ type: 'request/header', sessionId: id, cwd: h.cwd, createdAt: 1791000000000 }),
          JSON.stringify({ type: 'user/message', seq: 1, ts: 1791000001000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '跳号会话的第一句人话' }] } }),
          JSON.stringify({ type: 'assistant/message', seq: 2, ts: 1791000002000, data: { message: { content: [{ type: 'text', text: '跳号会话的第一句回复' }] } } }),
          JSON.stringify({ type: 'user/message', seq: 40, ts: 1791000040000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '跳号会话的第四句人话' }] } }),
          JSON.stringify({ type: 'assistant/message', seq: 41, ts: 1791000041000, data: { message: { content: [{ type: 'text', text: '跳号会话的第四句回复' }] } } }),
        ],
      },
    });
    h.archived.add(id);
    const migrated = await h.engine.migrate(id);
    assert.equal(migrated.ok, true, 'seq 跳号不得阻塞迁移/索引：' + JSON.stringify(migrated));

    const row = h.store.getSession(id);
    assert.match(String(row.error), /^seq-gap: 37\/41（90%）/, '诊断必须落进行的 error：' + row.error);
    assert.ok(row.indexed_at, '仍是「已索引」状态（不整会话拒收）');
    assert.ok(h.store.searchDocs('跳号会话的第一句人话').hits.length >= 1, 'docs 必须照常入库');
    assert.ok(h.store.searchDocs('跳号会话的第四句回复').hits.length >= 1);

    const meta = JSON.parse(h.store.getMeta('seq-gap:' + id, '{}'));
    assert.equal(meta.events, 4);
    assert.equal(meta.count, 4);
    assert.equal(meta.min, 1);
    assert.equal(meta.max, 41);
    assert.equal(meta.expected, 41);
    assert.equal(meta.gaps, 37);
    assert.ok(meta.ratio > 0.9, 'ratio=' + meta.ratio);
    assert.equal(meta.docs, 4, 'docs 侧读数一并留档（供交叉核对）');
    assert.equal(meta.docGaps, 37);

    // 诊断面（status.errors）必须能看到它
    const status = await h.engine.status();
    assert.ok(
      status.errors.some((entry) => entry.id === id && /^seq-gap:/.test(String(entry.error))),
      '诊断面要展示 seq 跳号：' + JSON.stringify(status.errors),
    );

    // 负对照：连续 seq 的会话不得被误报（error 为空，meta 记 0 缺口）
    const ok = 'session-seqok';
    await h.addSession(ok);
    h.archived.add(ok);
    assert.equal((await h.engine.migrate(ok)).ok, true);
    assert.equal(h.store.getSession(ok).error, null, '连续 seq 不得报 seq-gap');
    const okMeta = JSON.parse(h.store.getMeta('seq-gap:' + ok, '{}'));
    assert.equal(okMeta.gaps, 0);
    assert.equal(okMeta.ratio, 0);

    // collectIndex 直接暴露读数（诊断面/修复入口可复用）
    const collected = await h.engine.collectIndex(id, h.coldDir(id), { logNames: 'session.v4.jsonl.zstd', currentGeneration: 'session.v4.jsonl.zstd', formatVersion: 4 });
    assert.equal(collected.ok, true);
    assert.equal(collected.seq.gaps, 37);
    assert.deepEqual(collected.docs.map((doc) => doc.seq), [1, 2, 40, 41]);
    assert.equal(await exists(dir), false, '迁移后热目录应消失（与诊断无关）');
  } finally {
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// P2-0（2026-10-23 运行时首启验收缺陷）：数据面与列表性能
// 运行时事实：/list 首次 36.8s、118 行全部「（未索引）」、title/workspace/lastActive/archivedAt 为空；
// 根因 = 逐 id persistence.stat（每次扫全库）+ backfill 未把归档行入库。
// ---------------------------------------------------------------------------

test('P2-0 A：list 冷启动（无 DB 行）只做一次目录扫描、零 persistence.stat，118 行 <2s', async () => {
  const h = await createHarness();
  try {
    const ids = [];
    for (let i = 0; i < 118; i += 1) {
      const id = 'session-bulk-a-' + String(i).padStart(3, '0');
      ids.push(id);
      await h.addSession(id);
      h.archived.add(id);
    }
    // 回归探针：运行时实测的 36.8s 来自逐 id persistence.stat（每次扫全库）。
    let statCalls = 0;
    const originalStat = h.persistence.stat;
    h.persistence.stat = async (sessionId) => {
      statCalls += 1;
      return originalStat.call(h.persistence, sessionId);
    };
    assert.equal(h.store.listSessions().length, 0, '前提：DB 里一行都没有（首次安装的真实状态）');

    const startedAt = Date.now();
    const list = await h.engine.list();
    const elapsed = Date.now() - startedAt;

    assert.equal(list.items.length, 118, '118 个归档会话必须全部出现在列表里');
    assert.equal(statCalls, 0, 'P2-0：列表不得逐 id 调 persistence.stat（首启 36.8s 的根因）');
    assert.ok(elapsed < 2000, '冷启动列表必须 <2s，实测 ' + elapsed + 'ms');
    const perf = h.engine.perfStats();
    assert.equal(perf.scans, 1, '一次 list 只允许扫一遍目录（实测 ' + perf.scans + '）');
    for (const item of list.items) {
      assert.equal(item.status, 'hot-archived');
      assert.ok(item.projectKey, 'projectKey 不能为空：' + JSON.stringify(item));
      assert.match(String(item.workspace), /demo/, 'workspace 不能是「未知工作区」：' + item.workspace);
      assert.ok(item.sizeBytes > 0, 'sizeBytes 必须来自目录扫描');
      assert.ok(item.lastActiveAt > 0, 'lastActiveAt 必须来自代际文件 mtime');
      assert.equal(item.formatVersion, 4);
    }
    // 缓存有效期内：不得再扫目录
    await h.engine.list();
    assert.equal(h.engine.perfStats().scans, perf.scans, 'TTL 内必须命中缓存，不得重复扫描');
  } finally {
    await h.dispose();
  }
});

test('P2-0 B：backfillArchivedAt 把 118 个归档 id 入库（字段齐全）；list 热缓存 <500ms', async () => {
  const h = await createHarness();
  try {
    const ids = [];
    const projcache = path.join(h.home, 'storages', 'session_projcache', 'sessions');
    await mkdir(projcache, { recursive: true });
    for (let i = 0; i < 118; i += 1) {
      const id = 'session-bulk-b-' + String(i).padStart(3, '0');
      ids.push(id);
      await h.addSession(id);
      h.archived.add(id);
      // 宿主投影缓存的 title hint（per-record 文件顶部就是 rows.title.val）
      await writeFile(
        path.join(projcache, id + '.json'),
        JSON.stringify({ version: 7, record: { identity: { cwd: h.cwd }, rows: { title: { ver: 1, seq: 1, val: '标题 ' + i } } } }),
      );
    }

    const created = await h.engine.backfillArchivedAt({});
    assert.equal(created, 118, '118 个归档 id 必须全部入库');
    for (const id of ids) {
      const row = h.store.getSession(id);
      assert.ok(row, '缺行：' + id);
      assert.equal(row.project_key, h.pk);
      assert.ok(row.title && row.title.startsWith('标题'), 'title 必须写入（hint 只读 4KB，不解析整份 JSON）：' + row.title);
      assert.ok(row.file_mtime_ms > 0, 'lastActiveAt 的数据面（mtime）必须落库');
      assert.ok(row.archived_at > 0, 'archivedAt 必须落库');
      assert.equal(row.format_version, 4);
      assert.equal(row.backfilled, 1);
      assert.equal(row.status, 'hot');
      assert.ok(row.log_names);
      assert.ok(row.bytes > 0);
      assert.ok(row.header_cwd, 'workspace 的数据面（header.cwd）必须落库');
    }
    // 第二次回填必须幂等（不新建、不覆盖已落库事实）
    assert.equal(await h.engine.backfillArchivedAt({}), 0, '回填必须幂等');

    h.engine.invalidate();
    const coldStart = Date.now();
    const list1 = await h.engine.list();
    const coldElapsed = Date.now() - coldStart;
    assert.equal(list1.items.length, 118);
    for (const item of list1.items) {
      assert.ok(item.title && item.title !== '（未索引）' && item.title !== '（无标题）', 'title 必须齐全：' + JSON.stringify(item));
      assert.match(String(item.workspace), /demo/);
      assert.ok(item.lastActiveAt > 0);
      assert.ok(item.archivedAt > 0, 'archivedAt 必须齐全');
      assert.equal(item.formatVersion, 4);
    }
    assert.ok(coldElapsed < 2000, '冷启动列表 <2s，实测 ' + coldElapsed + 'ms');

    const hotStart = Date.now();
    const list2 = await h.engine.list();
    const hotElapsed = Date.now() - hotStart;
    assert.equal(list2, list1, 'TTL 内必须命中同一份缓存（不重新扫描、不重算）');
    assert.ok(hotElapsed < 500, '命中缓存必须 <500ms，实测 ' + hotElapsed + 'ms');
    assert.ok(h.engine.perfStats().listHits >= 1);
  } finally {
    await h.dispose();
  }
});
