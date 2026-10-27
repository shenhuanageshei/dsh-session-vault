import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

test('P0-1: package.json 是合法 npm 包骨架', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.name, 'dsh-session-vault');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'lib/index.js');
  assert.equal(pkg.exports['.'], './lib/index.js');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.engines.dsh, '>=0.2.1-rc.2 <0.3.0');
});

test('P0-1: host 与 client 入口分离，两个文件都存在', async () => {
  const pkg = JSON.parse(await read('package.json'));
  for (const rel of [pkg.main, pkg.exports['./client']]) {
    const info = await stat(path.join(ROOT, rel));
    assert.ok(info.isFile(), rel + ' 必须是文件');
  }
  const host = await read('lib/index.js');
  assert.ok(!/from\s+['"]\.\/client(\.js)?['"]/.test(host), 'host 入口不得 import client bundle');
  assert.ok(!/require\(['"]\.\/client/.test(host), 'host 入口不得 require client bundle');
  assert.ok(!/^\s*import\s[^;]*node:/m.test(await read('lib/client.js')), 'client bundle 不得 import node:*');
  assert.ok(!/require\(['"]node:/.test(await read('lib/client.js')), 'client bundle 不得 require node:*');
});

test('P0-1: host 半身是可加载的 cordis 插件', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href);
  assert.equal(mod.name, 'dsh-session-vault');
  assert.deepEqual(mod.inject, ['webServer']);
  assert.equal(typeof mod.apply, 'function');
  assert.equal(mod.ROUTE_PREFIX, '/session-vault/api');

  const effects = [];
  const ctx = {
    effect(fn) { effects.push(fn); return () => {}; },
    // 真实宿主由 cordis-plugin-timer 提供 ctx.setTimeout；测试里给 no-op，避免启动收敛触碰真实 DSH_HOME
    setTimeout() { return () => {}; },
    logger: { info() {}, warn() {} },
  };
  const dispose = mod.apply(ctx, {});
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('P0-1: cordis.patch.yml 有 insert 行', async () => {
  const yml = await read('cordis.patch.yml');
  assert.match(yml, /^- insert:/m);
  assert.match(yml, /id: dsh-session-vault/);
  assert.match(yml, /name: 'dsh-session-vault'/);
});

test('P0-1: client bundle 是 window.__ModuleLoader__.load 格式', async () => {
  const code = await read('lib/client.js');
  assert.match(code, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(code, /id: 'dsh-session-vault'/);
  assert.match(code, /factory: function \(require\) \{/);
  assert.match(code, /exports\.apply = apply;/);
  assert.ok(code.trimEnd().endsWith('});'), 'bundle 必须以 }); 收尾');
});
