import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { resolveVaultPaths, createConfigStore, normalizeConfig, publicConfig, DEFAULT_CONFIG, RESERVED_CONFIG_FIELDS } from '../lib/config.js';
import { VaultStore, snippetFromText } from '../lib/store.js';
import { VaultEngine, projectKey, installArchiveTracker, ERROR_STATES } from '../lib/engine.js';
import { hashTree } from '../lib/marker.js';
import { buildIndexText } from '../lib/tokenize.js';
import { createVaultApi, PREFIX, assertSessionId } from '../lib/http.js';
import { Sweeper, createScheduler } from '../lib/sweeper.js';
import * as hostModule from '../lib/index.js';
import { registerBootTimer } from '../lib/index.js';

/**
 * P2.6 收口轮的锚测试（最终代码评审剩余 5 条 + P2.5 定时器修复的测试补丁）。
 *
 * A1 跨卷 moveBack 删源前必须过 marker 基线（篡改 ⇒ 冷源保留 + needs-review）
 * A2 取消归档对冷会话恒等于恢复（开关只约束官方入口）+ 设置页文案
 * A3 maxConcurrentJobs 进 RESERVED_CONFIG_FIELDS（写入按 unknown-field 拒绝）+ UI「本批不生效」
 * A4 /migrate /restore /archive /unarchive 的 id 形状校验（与 /preview 同口径 ⇒ 400）
 * A5 snippet 从原文 d.text 截取（原始大小写/标点，不含分词空格；tokens 不变）
 * A6 startSweeper 只在真的 started 时复用（否则重新 start）
 * B1 ctx.setTimeout/setInterval 访问即抛（timer 未 inject）⇒ 退全局并正常工作
 * B2 正常 ctx（函数）⇒ 走 ctx 路径，不退化
 *
 * 全部落在 os.tmpdir() 的临时 home 里：不安装、不重启、不碰真实 ~/.dsh。
 */
const quiet = { info() {}, warn() {}, error() {} };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T0 = 1800000000000;
const exists = (target) => stat(target).then(() => true).catch(() => false);
const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); if (timer && timer.unref) timer.unref(); });

function frames(id, cwd) {
  return [
    JSON.stringify({ type: 'request/header', sessionId: id, cwd, createdAt: 1791000000000 }),
    JSON.stringify({ type: 'user/message', seq: 1, ts: 1791000001000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '搬回校验样本 ' + id }] } }),
    JSON.stringify({ type: 'assistant/message', seq: 2, ts: 1791000002000, data: { message: { content: [{ type: 'text', text: '可以搬走了' }] } } }),
  ];
}

async function createHarness(options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p26-'));
  const paths = resolveVaultPaths(home);
  const cwd = '<workspace-root>\\demo';
  const pk = projectKey(cwd);
  const archived = new Set();
  const clock = { now: options.now === undefined ? T0 : options.now };
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
      // 与 engine.test.mjs 同口径：热目录里真有文件才算「可见」（§7 的 stat 校验）。
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
  await configStore.save({ autoMigrate: false, archiveAgeDays: 14, ...(options.config || {}) });
  const store = await VaultStore.open(paths.dbPath);
  const engine = new VaultEngine({
    home, paths, configStore, store, registry, persistence, logger: quiet,
    now: () => clock.now,
    isActive: async () => Boolean(options.active),
    sameVolume: options.sameVolume,
    copyFile: options.copyFile,
    detectAm: async () => ({ present: false, matches: [], sources: ['injected'] }),
    resolveWorkspace: async () => undefined,
  });

  async function addSession(id, opts = {}) {
    const dir = path.join(paths.sessionsRoot, pk, id);
    await mkdir(dir, { recursive: true });
    const lines = opts.frames || frames(id, opts.cwd || cwd);
    await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line + '\n')))));
    return dir;
  }

  function api(overrides = {}) {
    return createVaultApi({
      home, configStore, version: '0.1.0-test',
      getEngine: async () => engine,
      logger: quiet,
      ...overrides,
    });
  }

  return {
    home, paths, cwd, pk, archived, calls, registry, persistence, configStore, store, engine,
    addSession, api,
    hotDir: (id) => path.join(paths.sessionsRoot, pk, id),
    coldDir: (id) => path.join(paths.coldRootDefault, pk, id),
    markerPath: (id) => path.join(paths.markerDir, id + '.json'),
    async dispose() {
      store.close();
      await rm(home, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function fakeRes() {
  const res = {
    statusCode: 0, headers: {}, body: '',
    writeHead(status, headers) { res.statusCode = status; for (const [k, v] of Object.entries(headers || {})) res.headers[String(k).toLowerCase()] = v; },
    setHeader(key, value) { res.headers[String(key).toLowerCase()] = value; },
    end(chunk) { res.body = chunk ? Buffer.from(chunk).toString('utf8') : ''; },
  };
  return res;
}
function fakeReq({ url = PREFIX + '/status', body = '{}', method = 'POST', remoteAddress = '127.0.0.1' } = {}) {
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:53210' };
  req.socket = { remoteAddress };
  return req;
}
async function call(apiOrHandler, options) {
  const handler = typeof apiOrHandler === 'function' ? apiOrHandler : apiOrHandler.handler;
  const res = fakeRes();
  await handler(fakeReq(options), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* keep null */ }
  return { status: res.statusCode, json };
}

// ===========================================================================
// A1：跨卷 moveBack 删源前必须过 marker 基线
// ===========================================================================
test('A1（P2.6）：跨卷搬回内容被篡改 ⇒ 冷源保留 + needs-review（绝不删冷源）', async () => {
  let harness = null;
  const coldRootOf = () => (harness ? path.join(harness.paths.home, 'session-vault', 'cold') : '');
  harness = await createHarness({
    sameVolume: async () => false,
    config: { allowCrossVolume: true },
    copyFile: async (from, to) => {
      const { copyFile } = await import('node:fs/promises');
      await copyFile(from, to);
      // 只篡改「冷 → 热」方向的搬回副本（模拟搬回内容被写坏）：基线校验必须拦住它。
      const coldRoot = coldRootOf();
      if (coldRoot && from.startsWith(coldRoot) && to.startsWith(harness.paths.sessionsRoot)) {
        const buffer = await readFile(to);
        if (buffer.length) {
          buffer[0] = buffer[0] ^ 0xff;
          await writeFile(to, buffer);
        }
      }
    },
  });
  try {
    const id = 'session-a1-tampered';
    const dir = await harness.addSession(id);
    const baseline = await hashTree(dir);
    harness.archived.add(id);
    // preflight(=1) 与删源前复检(=2) 判「仍在归档集合」；迁移后复检(=3) 判「已取消归档」⇒ 触发 moveBack。
    let calls = 0;
    harness.engine.isArchived = () => {
      calls += 1;
      return calls <= 2;
    };

    const result = await harness.engine.migrate(id);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, ERROR_STATES.NEEDS_REVIEW, '搬回校验不通过必须是显式标记态：' + JSON.stringify(result));
    assert.equal(await exists(harness.coldDir(id)), true, 'A1：冷源（唯一通过基线的副本）必须保留');
    assert.equal(await exists(harness.hotDir(id)), true, '双份保留（热侧副本不合格但也不删）');
    assert.equal((await hashTree(harness.coldDir(id))).sha256, baseline.sha256, '保留的冷源必须仍与基线一致');
    assert.equal((await hashTree(harness.hotDir(id))).sha256 === baseline.sha256, false, '前提：热侧副本确实被篡改');
    const row = harness.store.getSession(id);
    assert.equal(row.error, ERROR_STATES.NEEDS_REVIEW);
    assert.equal(row.status, 'migrating', '显式标记态：status 仍是 migrating（不伪装成 hot）');
    assert.equal(await exists(harness.markerPath(id)), true, 'marker 必须保留（人工处置的证据）');
  } finally {
    await harness.dispose();
  }
});

test('A1（P2.6）正向对照：跨卷搬回通过基线时才删冷源（race-unarchived 老行为不变）', async () => {
  const h = await createHarness({ sameVolume: async () => false, config: { allowCrossVolume: true } });
  try {
    const id = 'session-a1-clean';
    const dir = await h.addSession(id);
    const baseline = await hashTree(dir);
    h.archived.add(id);
    let calls = 0;
    h.engine.isArchived = () => {
      calls += 1;
      return calls <= 2;
    };
    const result = await h.engine.migrate(id);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, ERROR_STATES.RACE_UNARCHIVED, JSON.stringify(result));
    assert.equal(await exists(dir), true, '热目录必须搬回');
    assert.equal(await exists(h.coldDir(id)), false, '基线通过 ⇒ 冷源才允许删');
    assert.equal((await hashTree(dir)).sha256, baseline.sha256);
    assert.equal(h.store.getSession(id).error, ERROR_STATES.RACE_UNARCHIVED);
    assert.equal(await exists(h.markerPath(id)), false);
  } finally {
    await h.dispose();
  }
});

// ===========================================================================
// A2：取消归档对冷会话恒等于恢复（开关只约束官方入口）
// ===========================================================================
test('A2（P2.6）：hydrateOnUnarchive=false 时本插件 unarchive 对冷会话仍恒等于恢复（数据完整性优先）', async () => {
  const h = await createHarness({ config: { hydrateOnUnarchive: false } });
  try {
    const id = 'session-a2-panel';
    const dir = await h.addSession(id);
    h.archived.add(id);
    assert.equal((await h.engine.migrate(id)).ok, true);
    assert.equal(await exists(dir), false, '前提：文件已在冷侧');

    const result = await h.engine.unarchiveSession(id);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.hydrated, true);
    assert.equal(await exists(dir), true, '面板/HTTP 的取消归档对冷会话必须搬回（不看开关）');
    assert.equal(h.store.getSession(id).status, 'hot-restored');
    assert.equal(h.archived.has(id), false, '官方取消归档仍由原件执行（照常摘标记）');

    // 对照：**官方入口**（包装）在开关关闭时不水合 —— 只摘标记，文件留在冷侧（开关的唯一作用面）。
    const officialId = 'session-a2-official';
    await h.addSession(officialId);
    h.archived.add(officialId);
    assert.equal((await h.engine.migrate(officialId)).ok, true);
    const disposer = installArchiveTracker({
      registry: h.registry,
      engine: h.engine,
      getConfig: () => ({ hydrateOnUnarchive: false }),
      log: quiet,
    });
    try {
      await h.registry.unarchiveSession(officialId);
      assert.equal(h.archived.has(officialId), false, '官方入口照常摘标记');
      assert.equal(await exists(h.coldDir(officialId)), true, '开关关闭 ⇒ 官方入口不水合（文件留在冷侧）');
      assert.equal(h.store.getSession(officialId).status, 'cold');
    } finally {
      disposer();
    }
  } finally {
    await h.dispose();
  }
});

test('A2（P2.6）：设置页文案写明「面板取消归档恒等于恢复；开关只管官方入口」', async () => {
  const code = await readFile(path.join(ROOT, 'lib', 'client.js'), 'utf8');
  assert.match(code, /本插件面板的「取消归档」对冷会话恒等于恢复/, '设置页必须写明面板语义（A2 裁定）');
  assert.match(code, /开关只管官方入口/, '设置页必须写明开关的作用面只有官方入口');
  assert.equal(code.includes('关闭后，官方「取消归档」不会把冷会话搬回'), false, '旧文案（暗示面板也受影响）必须消失');
});

// ===========================================================================
// A3：maxConcurrentJobs 进 RESERVED_CONFIG_FIELDS
// ===========================================================================
test('A3（P2.6）：maxConcurrentJobs 写入被按 unknown-field 明确拒绝（且错误可读）', async () => {
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, 'maxConcurrentJobs'), false, '预留字段不得留在默认配置里');
  const reserved = RESERVED_CONFIG_FIELDS.find((entry) => entry.field === 'maxConcurrentJobs');
  assert.ok(reserved, 'maxConcurrentJobs 必须登记在 RESERVED_CONFIG_FIELDS');
  assert.equal(reserved.stage, 'P3');

  const normalized = normalizeConfig({ maxConcurrentJobs: 2 });
  assert.equal(normalized.ok, false);
  assert.equal(normalized.errors.length, 1);
  const error = normalized.errors[0];
  assert.equal(error.code, 'unknown-field', '错误码仍是 unknown-field（不静默丢弃、也不假装接受）');
  assert.equal(error.field, 'maxConcurrentJobs');
  assert.equal(error.reserved, true);
  assert.match(error.message, /本批不生效/, '错误必须可读：' + error.message);
  assert.match(error.message, /预留/, error.message);

  const h = await createHarness();
  try {
    const api = h.api({ getEngine: async () => null });
    const res = await call(api, { url: PREFIX + '/config', body: JSON.stringify({ patch: { maxConcurrentJobs: 2 } }) });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.equal(res.json.code, 'invalid-config');
    assert.equal(res.json.details[0].code, 'unknown-field');
    assert.equal(res.json.details[0].field, 'maxConcurrentJobs');
    assert.match(res.json.message, /本批不生效/, res.json.message);
    const view = publicConfig((await h.configStore.load()).config, { home: h.home, paths: h.paths });
    assert.equal(Object.prototype.hasOwnProperty.call(view, 'maxConcurrentJobs'), false, '对外配置视图不再暴露该字段');

    // 旧版本保存的 config.json **必然**含 maxConcurrentJobs（它曾在 DEFAULT_CONFIG 里）：
    // 读取必须容错（否则每个存量安装的 configErrors 永久挂一条自己造成的历史字段），写入仍拒绝。
    await writeFile(h.paths.configPath, JSON.stringify({ archiveAgeDays: 7, maxConcurrentJobs: 1 }, null, 2));
    h.configStore.invalidate();
    const legacy = await h.configStore.load();
    assert.equal(legacy.ok, true, '旧配置文件不得被判成「配置坏了」：' + JSON.stringify(legacy.errors));
    assert.equal(legacy.errors.length, 0, JSON.stringify(legacy.errors));
    assert.deepEqual(legacy.reserved, ['maxConcurrentJobs'], '摘掉的预留字段必须如实记录（读取容错 ≠ 静默）');
    assert.equal(legacy.config.archiveAgeDays, 7, '其它字段照常读取');
    assert.equal(Object.prototype.hasOwnProperty.call(legacy.config, 'maxConcurrentJobs'), false, '预留字段不进入生效配置');
    const statusRes = await call(h.api({ getEngine: async () => null }), { url: PREFIX + '/status', body: '{}' });
    assert.deepEqual(statusRes.json.configReserved, ['maxConcurrentJobs'], '/status 必须列出被摘掉的预留字段');
    assert.equal(statusRes.json.configErrors.length, 0, '历史字段不得进 configErrors');
    // 即便配置文件里有该字段，**再次写入**仍被拒绝（严格门只在写面）
    const rewrite = await call(h.api({ getEngine: async () => null }), { url: PREFIX + '/config', body: JSON.stringify({ patch: { maxConcurrentJobs: 3 } }) });
    assert.equal(rewrite.status, 400, JSON.stringify(rewrite.json));

    const code = await readFile(path.join(ROOT, 'lib', 'client.js'), 'utf8');
    assert.match(code, /本批不生效/, 'UI 必须标注「本批不生效」');
    assert.equal(code.includes('队列容量上限'), false, '「队列容量上限」措辞必须删除');
    assert.equal(code.includes("update('maxConcurrentJobs'"), false, 'UI 不得再提交该字段（服务端会拒）');
  } finally {
    await h.dispose();
  }
});

// ===========================================================================
// A4：批量接口 id 形状校验（与 /preview 同口径）
// ===========================================================================
test('A4（P2.6）：/migrate /restore /archive /unarchive 的非法 id 一律 400，且与 /preview 同码', async () => {
  const h = await createHarness();
  try {
    const api = h.api();
    const cases = [
      { url: PREFIX + '/migrate', body: { id: '../escape' } },
      { url: PREFIX + '/restore', body: { ids: ['session-ok', 'a/b'] } },
      { url: PREFIX + '/archive', body: { id: '..' } },
      { url: PREFIX + '/unarchive', body: { id: 'x y' } },
    ];
    for (const item of cases) {
      const res = await call(api, { url: item.url, body: JSON.stringify(item.body) });
      assert.equal(res.status, 400, item.url + ' 必须 400：' + JSON.stringify(res.json));
      assert.equal(res.json.code, 'invalid-id', item.url + ' 的错误码：' + JSON.stringify(res.json));
      assert.match(String(res.json.message), /会话 id 形状非法/, res.json.message);
    }
    // 与 /preview 同口径（同一个 assertSessionId，同样的 400 + invalid-id）
    const preview = await call(api, { url: PREFIX + '/preview', body: JSON.stringify({ id: '../escape' }) });
    assert.equal(preview.status, 400, JSON.stringify(preview.json));
    assert.equal(preview.json.code, 'invalid-id');
    assert.throws(() => assertSessionId('../escape'), (err) => err && err.status === 400 && err.code === 'invalid-id');

    // 合法 id 不被形状门拦下（继续走到引擎）：不存在的会话 ⇒ 200 + source-missing
    const ok = await call(api, { url: PREFIX + '/migrate', body: JSON.stringify({ id: 'session-does-not-exist' }) });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.results[0].ok, false);
    assert.equal(ok.json.results[0].code, 'source-missing');
  } finally {
    await h.dispose();
  }
});

// ===========================================================================
// A5：snippet 从原文截取（原始大小写/标点，不含分词空格；tokens 不变）
// ===========================================================================
test('A5（P2.6）：snippet 含原始大小写与原文标点，不含分词空格；tokens 口径不变', async () => {
  const h = await createHarness();
  try {
    const text = 'Query: DSH-Navbar, Search Works.';
    h.store.upsertSession({ session_id: 'session-a5', project_key: h.pk, rel_dir: h.pk + '/session-a5', log_names: 'session.v4.jsonl.zstd', format_version: 4, status: 'hot' });
    h.store.replaceDocs('session-a5', [
      { seq: 1, type: 'user', role: 'user', time: 1792000000000, text, index_text: buildIndexText(text) },
    ]);

    const hit = h.store.searchDocs('DSH');
    assert.equal(hit.hits.length, 1, JSON.stringify(hit));
    assert.deepEqual(hit.tokens, ['dsh'], 'tokens 口径不变（仍来自同一套分词）');
    const snippet = String(hit.hits[0].snippet);
    assert.equal(snippet, text, 'snippet 必须是原文（大小写、冒号、连字符、逗号原样）');
    assert.equal(snippet.includes('dsh navbar'), false, 'A5：不得出现 index_text 的分词形态');
    assert.equal(snippet.includes('DSH Navbar'), false, 'A5：不得把连字符/标点换成空格');
    assert.equal(/^query/.test(snippet), false, 'A5：不得小写化');

    // 长文本：命中窗口裁剪（首尾 '…'），仍取原文片段
    const longText = '开头' + 'x'.repeat(60) + '保险库' + 'y'.repeat(60) + '结尾';
    h.store.replaceDocs('session-a5', [
      { seq: 1, type: 'user', role: 'user', time: 1792000000000, text: longText, index_text: buildIndexText(longText) },
    ]);
    const zh = h.store.searchDocs('保险库');
    const zhSnippet = String(zh.hits[0].snippet);
    assert.ok(zhSnippet.includes('保险库'), zhSnippet);
    assert.equal(zhSnippet.startsWith('…'), true, '裁剪必须有前导省略号：' + zhSnippet);
    assert.equal(zhSnippet.endsWith('…'), true, '裁剪必须有尾部省略号：' + zhSnippet);
    assert.ok(zhSnippet.length < longText.length);
    assert.equal(zhSnippet.includes('保险 库'), false, 'A5：中文不得出现分词插词空格');

    // 纯函数边界 + 词边界差异的兜底（命中词按字面找不到时退回原文开头，仍不是 index_text）
    assert.equal(snippetFromText('', ['x']), '');
    assert.equal(snippetFromText(null, []), '');
    assert.equal(snippetFromText('Hello World', ['absent']), 'Hello World');
    assert.equal(snippetFromText('a'.repeat(200), ['absent']).includes(' '), false);
  } finally {
    await h.dispose();
  }
});

// ===========================================================================
// A6：startSweeper 只在真的 started 时复用
// ===========================================================================
function makeHostCtx() {
  const routes = [];
  const webServer = { register(route) { routes.push(route); return () => {}; } };
  const ctx = {
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    get(service) {
      if (service === 'webServer') return webServer;
      return undefined;
    },
    setTimeout(fn, ms) {
      const timer = setTimeout(fn, ms);
      if (timer && timer.unref) timer.unref();
      return () => clearTimeout(timer);
    },
    logger: quiet,
  };
  return { ctx, routes };
}

test('A6（P2.6）：Sweeper 实例已建但 start 抛错 ⇒ 启动链重试时重新 start（旧实现直接返回半成品）', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vault-p26-a6-'));
  const previous = { home: process.env.DSH_HOME, delay: process.env.VAULT_BOOT_DELAY_MS, retry: process.env.VAULT_BOOT_RETRY_MS };
  process.env.DSH_HOME = home;
  process.env.VAULT_BOOT_DELAY_MS = '5';
  process.env.VAULT_BOOT_RETRY_MS = '5';
  const originalStart = Sweeper.prototype.start;
  let startCalls = 0;
  Sweeper.prototype.start = function patchedStart() {
    startCalls += 1;
    if (startCalls === 1) throw new Error('simulated start failure');
    return originalStart.call(this);
  };
  let dispose = null;
  try {
    const { ctx, routes } = makeHostCtx();
    dispose = hostModule.apply(ctx, {});
    assert.equal(routes.length, 1);
    const handler = routes[0].handler;
    let last = null;
    for (let i = 0; i < 200; i += 1) {
      await sleep(20);
      const status = await call(handler, { url: PREFIX + '/status', body: '{}' });
      last = status.json;
      if (last && last.sweep && last.sweep.attached && last.sweep.started) break;
    }
    assert.ok(last && last.sweep, '必须能读到 sweep 读数：' + JSON.stringify(last && last.sweep));
    assert.equal(last.sweep.attached, true, 'Sweeper 必须真的挂上：' + JSON.stringify(last.sweep));
    assert.equal(last.sweep.started, true, 'A6：重试必须**重新 start**（旧实现返回未启动实例 ⇒ started=false）');
    assert.ok(startCalls >= 2, '首次 start 失败必须触发重试：' + startCalls);
    assert.ok(last.boot.attempts >= 2, '启动链必须重试过：' + JSON.stringify(last.boot));
    assert.equal(last.sweep.sweepError, null, '失败的 start 不是启动收敛失败');

    // 已 started 之后不再重建 / 不再重试（复用同一实例）
    const attempts = last.boot.attempts;
    const again = await call(handler, { url: PREFIX + '/status', body: '{}' });
    assert.equal(again.json.sweep.started, true);
    assert.equal(again.json.boot.attempts, attempts, '挂上之后不得再重试启动链');

    // Sweeper.started 是只读位（暴露给 index.js 判断，不许被外部改写）
    const sweeper = new Sweeper({
      engine: { store: {}, config: async () => ({}) },
      scheduler: { after() { return () => {}; }, every() { return () => {}; } },
    });
    assert.equal(sweeper.started, false);
    sweeper.start();
    assert.equal(sweeper.started, true);
    sweeper.stop();
    assert.equal(sweeper.started, false);
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sweeper), 'started');
    assert.equal(typeof descriptor.get, 'function');
    assert.equal(descriptor.set, undefined, 'started 必须是只读（只有 get）');
  } finally {
    Sweeper.prototype.start = originalStart;
    if (dispose) { try { dispose(); } catch { /* ignore */ } }
    await sleep(120);
    if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
    if (previous.delay === undefined) delete process.env.VAULT_BOOT_DELAY_MS; else process.env.VAULT_BOOT_DELAY_MS = previous.delay;
    if (previous.retry === undefined) delete process.env.VAULT_BOOT_RETRY_MS; else process.env.VAULT_BOOT_RETRY_MS = previous.retry;
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

// ===========================================================================
// B1：ctx 定时器「访问即抛」⇒ 退全局，仍能正常工作
// ===========================================================================
function throwingTimerCtx() {
  const message = 'cannot get property "timer" without inject';
  const ctx = {};
  Object.defineProperty(ctx, 'setTimeout', { configurable: true, get() { throw new Error(message); } });
  Object.defineProperty(ctx, 'setInterval', { configurable: true, get() { throw new Error(message); } });
  return { ctx, message };
}

test('B1（P2.6）：ctx.setTimeout/setInterval 代理访问即抛 ⇒ registerBootTimer 退全局 setTimeout 且真的触发', async () => {
  const { ctx, message } = throwingTimerCtx();
  let starts = 0;
  const chain = { start() { starts += 1; return Promise.resolve(); }, stop() {} };
  const disposers = [];
  const state = registerBootTimer({ ctx, bootChain: chain, delayMs: 10, log: quiet, disposers });
  assert.equal(state.registered, true, '必须退全局并注册成功：' + JSON.stringify(state));
  assert.equal(typeof state.via, 'string');
  assert.equal(String(state.via).startsWith('ctx.'), false, 'B1：不得报告走 ctx 路径：' + state.via);
  assert.equal(state.via, 'global.setTimeout');
  assert.ok(String(state.registrationError).includes(message), '访问即抛的原因必须进可读状态（不吞）：' + state.registrationError);
  assert.equal(disposers.length, 1, '全局兜底的 disposer 必须交给调用方');
  await sleep(80);
  assert.equal(starts, 1, '全局定时器必须真的触发启动链');
  assert.equal(typeof state.firedAt, 'number');
  assert.doesNotThrow(() => disposers[0]());
});

test('B1（P2.6）：同样「访问即抛」的 ctx ⇒ createScheduler 的 after/every 退全局并正常工作、dispose 可清', async () => {
  const { ctx } = throwingTimerCtx();
  const scheduler = createScheduler(ctx);
  let afterFired = 0;
  let everyFired = 0;
  const stopAfter = scheduler.after(() => { afterFired += 1; }, 10);
  assert.equal(typeof stopAfter, 'function', 'after 必须返回 disposer（退全局路径也要有）');
  await sleep(60);
  assert.equal(afterFired, 1, 'after 必须退全局并触发');
  stopAfter();

  const stopEvery = scheduler.every(() => { everyFired += 1; }, 10);
  assert.equal(typeof stopEvery, 'function');
  await sleep(80);
  assert.ok(everyFired >= 2, 'every 必须退全局并反复触发：' + everyFired);
  stopEvery();
  const frozen = everyFired;
  await sleep(60);
  assert.equal(everyFired, frozen, 'dispose 必须真的清掉全局 interval');
});

// ===========================================================================
// B2：正常 ctx（函数）⇒ 走 ctx 路径，不退化
// ===========================================================================
test('B2（P2.6）：正常 ctx（函数）⇒ registerBootTimer 与 createScheduler 都走 ctx 路径，不退化', async () => {
  let starts = 0;
  const chain = { start() { starts += 1; return Promise.resolve(); }, stop() {} };
  const disposers = [];
  let ctxTimerCalls = 0;
  let ctxTimerDisposed = false;
  const ctx = {
    setTimeout(fn, ms) {
      ctxTimerCalls += 1;
      const timer = setTimeout(fn, ms);
      if (timer && timer.unref) timer.unref();
      return () => { ctxTimerDisposed = true; clearTimeout(timer); };
    },
    setInterval(fn, ms) {
      const timer = setInterval(fn, ms);
      if (timer && timer.unref) timer.unref();
      return () => clearInterval(timer);
    },
  };
  const state = registerBootTimer({ ctx, bootChain: chain, delayMs: 10, log: quiet, disposers });
  assert.equal(state.registered, true, JSON.stringify(state));
  assert.equal(state.via, 'ctx.setTimeout', 'B2：正常 ctx 不得退化');
  assert.equal(state.registrationError, null);
  assert.equal(ctxTimerCalls, 1);
  assert.equal(disposers.length, 1);
  await sleep(80);
  assert.equal(starts, 1);
  disposers[0]();
  assert.equal(ctxTimerDisposed, true, '交回的必须是 ctx 定时器的 disposer（不是全局兜底的）');

  // createScheduler：正常 ctx ⇒ after/every 都走 ctx（返回 ctx 的 disposer）
  let afterCalls = 0;
  let everyCalls = 0;
  let afterDisposed = false;
  let everyDisposed = false;
  const scheduler = createScheduler({
    setTimeout(fn, ms) { afterCalls += 1; const timer = setTimeout(fn, ms); if (timer && timer.unref) timer.unref(); return () => { afterDisposed = true; clearTimeout(timer); }; },
    setInterval(fn, ms) { everyCalls += 1; const timer = setInterval(fn, ms); if (timer && timer.unref) timer.unref(); return () => { everyDisposed = true; clearInterval(timer); }; },
  });
  const stopAfter = scheduler.after(() => {}, 5000);
  assert.equal(afterCalls, 1, 'B2：after 必须走 ctx');
  stopAfter();
  assert.equal(afterDisposed, true);
  const stopEvery = scheduler.every(() => {}, 5000);
  assert.equal(everyCalls, 1, 'B2：every 必须走 ctx');
  stopEvery();
  assert.equal(everyDisposed, true);
});
