import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { resolveVaultPaths, createConfigStore } from '../lib/config.js';
import { VaultStore } from '../lib/store.js';
import { VaultEngine, projectKey } from '../lib/engine.js';
import { VaultIndexer } from '../lib/indexer.js';

/**
 * 评审 #14：>=1000 会话索引下搜索 p95 < 1s。
 * 全部落在 os.tmpdir() 的临时 home 里，不触碰真实 ~/.dsh。
 */
const quiet = { info() {}, warn() {}, error() {} };
const N = 1000;
const T0 = 1800000000000;

function tinyFrames(id, cwd, text, title) {
  return [
    JSON.stringify({ type: 'request/header', sessionId: id, cwd, createdAt: 1791000000000 }),
    JSON.stringify({ type: 'user/message', seq: 1, ts: 1791000001000, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }),
    JSON.stringify({ type: 'assistant/message', seq: 2, ts: 1791000002000, data: { message: { content: [{ type: 'text', text: '回复 ' + id }] } } }),
    JSON.stringify({ type: 'session/title', seq: 3, ts: 1791000003000, data: { title } }),
  ];
}

/**
 * §15.1 #4（评审 #5）：p95 验收保留，但**另外打印 p50 / p95 / 重索引耗时**；
 * 慢机用 VAULT_PERF_RELAX=1 放宽（日志里明说放宽了，不静默）。
 */
const RELAX = process.env.VAULT_PERF_RELAX === '1';
const P95_LIMIT_MS = RELAX ? 5000 : 1000;

test('P2-2 性能：' + N + ' 会话索引下搜索 p95 < 1s（VAULT_PERF_RELAX=1 可放宽）', { timeout: 600000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-search-perf-'));
  const paths = resolveVaultPaths(home);
  const cwd = '<workspace-root>\\perf';
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
    home, paths, configStore, store, registry, persistence, logger: quiet,
    now: () => T0,
    isActive: async () => false,
    sameVolume: async () => true,
    detectAm: async () => ({ present: false, matches: [], sources: ['injected'] }),
    resolveWorkspace: async () => undefined,
  });
  const indexer = new VaultIndexer({ engine, store, paths, logger: quiet, now: () => T0 });

  try {
    // 造 1000 个真实小日志（每 40 个里有 1 个带 needle 标记）
    const ids = [];
    for (let i = 0; i < N; i += 1) ids.push('session-perf-' + String(i).padStart(4, '0'));
    const create = async (id, index) => {
      const dir = path.join(paths.sessionsRoot, pk, id);
      await mkdir(dir, { recursive: true });
      const text = index % 40 === 0 ? 'needle 标记的会话正文 ' + index : '普通会话正文 ' + index + ' 的搜索样本';
      const buffer = Buffer.concat(tinyFrames(id, cwd, text, '性能标题 ' + index).map((line) => zstdCompressSync(Buffer.from(line + '\n'))));
      await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), buffer);
    };
    for (let offset = 0; offset < ids.length; offset += 50) {
      const batch = ids.slice(offset, offset + 50);
      await Promise.all(batch.map((id) => create(id, Number(id.slice(-4)))));
    }

    const indexStartedAt = Date.now();
    const progress = await indexer.runFullIndex();
    const indexMs = Date.now() - indexStartedAt;
    assert.equal(progress.total, N, '全量索引必须覆盖 ' + N + ' 个会话');
    assert.equal(progress.failed, 0, JSON.stringify(progress.errors));
    assert.ok(progress.indexed >= N - 5, '索引覆盖必须接近全量：' + JSON.stringify(progress));

    const timings = [];
    const queries = ['needle', '普通会话正文', '搜索样本', 'needle 标记的会话正文', '性能标题'];
    for (let round = 0; round < 20; round += 1) {
      const query = queries[round % queries.length];
      const startedAt = Date.now();
      const result = await indexer.search(query, { limit: 20 });
      timings.push(Date.now() - startedAt);
      assert.ok(Array.isArray(result.groups), '搜索结果必须是分组数组');
      assert.ok(result.groups.length > 0, '查询必须有命中：' + query);
      assert.equal(result.index.phase, 'done');
    }
    // 重索引耗时（§15.1 #4）：强制重建一个会话（走一遍帧遍历 + 抽取 + 分词 + 写库）
    const oneTarget = indexer.targets.get(ids[0]);
    const reindexStart = Date.now();
    const rebuilt = await indexer.indexTarget(oneTarget, { force: true });
    const reindexMs = Date.now() - reindexStart;
    assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt));

    timings.sort((a, b) => a - b);
    const p95 = timings[Math.min(timings.length - 1, Math.ceil(timings.length * 0.95) - 1)];
    const p50 = timings[Math.floor(timings.length / 2)];
    const summary = '[perf] 搜索 p50=' + p50 + 'ms p95=' + p95 + 'ms（n=' + timings.length + '）· 全量索引 ' + indexMs + 'ms' +
      ' · 单会话强制重索引 ' + reindexMs + 'ms · ' + N + ' 会话';
    console.log(summary);
    if (RELAX) console.log('[perf] VAULT_PERF_RELAX=1：p95 阈值放宽为 <' + P95_LIMIT_MS + 'ms（默认 1000ms）');
    assert.ok(p95 < P95_LIMIT_MS, '搜索 p95 必须 <' + P95_LIMIT_MS + 'ms（' + summary + '）');
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
