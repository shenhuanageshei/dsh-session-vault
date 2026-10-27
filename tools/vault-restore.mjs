#!/usr/bin/env node
/**
 * 会话保险库 · 卸载后手工恢复脚本（设计档 §15 P1-5 / I-10 演练 / AC-12）
 *
 * 用途：DSH 已卸载或插件损坏时，不加载任何插件、纯 Node 把冷目录搬回原 projectKey，
 *       并可把会话 id 写回 storages/workspace.json 的 sessionIds 槽位。
 *
 * 用法（默认 dry-run，只看计划不动文件）：
 *   node tools/vault-restore.mjs                      # 预览全部可恢复会话
 *   node tools/vault-restore.mjs --id session-abc     # 只预览一个
 *   node tools/vault-restore.mjs --apply              # 真正搬文件
 *   node tools/vault-restore.mjs --apply --write-workspace   # 同时写回记账（必须先关 DSH）
 *
 * 安全：
 *  - 默认 dry-run；--apply 才动文件，--write-workspace 才动 workspace.json（先留 .bak 备份）。
 *  - 只搬 manifest 记录的迁移行；目标已存在则跳过（幂等），绝不覆盖热侧数据。
 *  - 不删冷目录里的任何文件：目标是「复制 + 校验 + 落最终名」，失败即保留双份并报错。
 *  - 不改 archivedSessionIds（恢复完成后请在官方 UI 里点「取消归档」，那是官方 API 的事）。
 *  - DSH 运行时会自己写 workspace.json：--write-workspace 前请确认 DSH 已退出。
 */
import { readFile, writeFile, rename, mkdir, stat, copyFile, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readHeaderRegion, decompressFrame } from '../lib/zstd-frames.js';
import { projectKey, hashTree, sortGenerations, isGenerationName } from '../lib/marker.js';

function parseArgs(argv) {
  const out = { apply: false, writeWorkspace: false, json: false, id: null, home: '', manifest: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--dry-run') out.apply = false;
    else if (arg === '--write-workspace') out.writeWorkspace = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--id') out.id = argv[++i] || null;
    else if (arg === '--home') out.home = argv[++i] || '';
    else if (arg === '--manifest') out.manifest = argv[++i] || '';
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function resolveHome(flag) {
  if (flag) return path.resolve(flag);
  const env = (process.env.DSH_HOME || '').trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), '.dsh');
}

async function readManifest(file) {
  try {
    const text = await readFile(file, 'utf8');
    const records = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        /* 坏行跳过（审计副本，不是事实源） */
      }
    }
    return records;
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readHeader(coldDir) {
  try {
    const entries = (await (await import('node:fs/promises')).readdir(coldDir)).filter((name) => isGenerationName(name));
    const current = sortGenerations(entries).slice(-1)[0];
    if (!current) return null;
    const region = await readHeaderRegion(path.join(coldDir, current), { chunkSize: 8192, maxFrames: 1, maxBytes: 1024 * 1024 });
    if (!region.frames.length) return null;
    const frame = region.frames[0];
    const line = decompressFrame(region.buffer.subarray(frame.start, frame.end)).toString('utf8').split('\n')[0];
    const value = JSON.parse(line);
    const data = value && typeof value.data === 'object' && value.data ? value.data : {};
    const id = value.sessionId || value.id || data.sessionId || data.id || null;
    const cwd = value.cwd || data.cwd || null;
    return { id, cwd, current };
  } catch {
    return null;
  }
}

function latestMigrates(records) {
  const latest = new Map();
  for (const record of records) {
    if (!record || record.op !== 'migrate' || record.ok === false) continue;
    if (!record.id || !record.to) continue;
    latest.set(String(record.id), record);
  }
  return [...latest.values()];
}

async function moveBack(coldDir, hotDir) {
  await mkdir(path.dirname(hotDir), { recursive: true });
  try {
    await rename(coldDir, hotDir);
    return { mode: 'rename' };
  } catch (err) {
    if (err && err.code !== 'EXDEV') throw err;
  }
  await mkdir(hotDir, { recursive: true });
  const entries = await (await import('node:fs/promises')).readdir(coldDir);
  for (const name of entries) {
    const from = path.join(coldDir, name);
    const to = path.join(hotDir, name + '.part');
    await copyFile(from, to);
    const handle = await open(to, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(to, path.join(hotDir, name));
  }
  return { mode: 'copy+rename' };
}

async function writeWorkspaceSession(file, cwd, sessionId) {
  let payload;
  try {
    payload = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    return { ok: false, error: '读不到 workspace.json：' + (err && err.message ? err.message : err) };
  }
  const tables = payload && payload.tables;
  const workspaces = tables && Array.isArray(tables.workspaces) ? tables.workspaces : [];
  const target = workspaces.find((workspace) => workspace && workspace.path === cwd);
  if (!target) return { ok: false, error: 'workspace.json 里找不到 path=' + cwd + ' 的工作区' };
  const ids = Array.isArray(target.sessionIds) ? target.sessionIds : [];
  if (!ids.includes(sessionId)) {
    target.sessionIds = [sessionId, ...ids];
  }
  const backup = file + '.vault-backup-' + Date.now() + '.bak';
  await copyFile(file, backup);
  await writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  return { ok: true, backup, slots: target.sessionIds.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node tools/vault-restore.mjs [--id <sessionId>] [--apply] [--write-workspace] [--home <DSH_HOME>] [--manifest <file>] [--json]');
    return 0;
  }
  const home = resolveHome(args.home);
  const vaultRoot = path.join(home, 'session-vault');
  const manifestFile = args.manifest ? path.resolve(args.manifest) : path.join(vaultRoot, 'manifest.jsonl');
  const sessionsRoot = path.join(home, 'sessions');

  const records = await readManifest(manifestFile);
  let targets = latestMigrates(records);
  if (args.id) targets = targets.filter((record) => String(record.id) === String(args.id));
  if (!targets.length) {
    console.log('[vault-restore] manifest 里没有可恢复的迁移记录：' + manifestFile);
    return 1;
  }

  console.log('== 会话保险库 · 手工恢复（' + (args.apply ? 'APPLY' : 'DRY-RUN') + '） ==');
  console.log('DSH_HOME : ' + home);
  console.log('manifest : ' + manifestFile);
  console.log('待处理   : ' + targets.length + ' 个已迁移会话');
  if (args.writeWorkspace && !args.apply) console.log('注意     : --write-workspace 只在 --apply 时生效');
  console.log('');

  const results = [];
  for (const record of targets) {
    const id = String(record.id);
    const coldDir = path.resolve(record.to);
    const projectKeyDir = path.basename(path.dirname(coldDir));
    const hotDir = path.join(sessionsRoot, projectKeyDir, id);
    const header = await readHeader(coldDir);
    /**
     * P4（FR-P4-5 / A-P4-12）：manifest 行带 `class` 时按类分域 ——
     * class=subagent（子代理会话）**不**写回 workspace.json 的 sessionIds：
     * 它本来就不该进侧栏/工作区记账，写回等于制造幽灵挂载（I-16）。
     * 缺字段 = archived（class A 的历史行形状不变）。
     */
    const cls = record.class === 'subagent' ? 'subagent' : 'archived';
    const row = { id, cls, coldDir, hotDir, projectKeyDir, header, ok: false, action: 'skip', reason: null };

    if (!(await pathExists(coldDir))) {
      row.reason = '冷目录不存在（manifest 记录过期，可能已恢复过）';
      results.push(row);
      continue;
    }
    if (await pathExists(hotDir)) {
      row.reason = '热目录已存在，跳过（不覆盖现有会话）';
      row.action = 'skip-existing-hot';
      results.push(row);
      continue;
    }
    if (header && header.id && String(header.id) !== id) {
      row.reason = 'header.id=' + header.id + ' 与 manifest id 不一致（拒绝搬移）';
      results.push(row);
      continue;
    }
    if (header && header.cwd) {
      const expected = projectKey(header.cwd);
      if (expected !== projectKeyDir) {
        row.reason = 'projectKey(header.cwd)=' + expected + ' ≠ 目录名 ' + projectKeyDir + '（拒绝搬移，避免制造 list() 抛错源）';
        results.push(row);
        continue;
      }
    }
    if (!header) row.reason = 'header 读不出来：按 manifest 落点恢复（搬回后 DSH 仍可打开）';

    if (!args.apply) {
      row.ok = true;
      row.action = 'plan';
      row.reason = row.reason || '将搬回 ' + hotDir;
      results.push(row);
      continue;
    }

    try {
      const move = await moveBack(coldDir, hotDir);
      let verified = true;
      let detail = 'move=' + move.mode;
      if (record.sha256) {
        try {
          const baseline = await hashTree(hotDir);
          verified = baseline.sha256 === record.sha256;
          detail += ' sha256=' + (verified ? 'ok' : 'MISMATCH');
        } catch (err) {
          verified = false;
          detail += ' sha256=error(' + (err && err.message ? err.message : err) + ')';
        }
      }
      row.ok = verified;
      row.action = 'moved';
      row.reason = detail + (verified ? '' : ' —— 校验不一致：冷侧仍保留，请人工核对');
      if (verified && cls === 'subagent') {
        // 负向断言（A-P4-12）：class S **绝不**写 --write-workspace，即使调用方显式加了该开关。
        row.reason += '；子代理会话（manifest class=subagent）：按设计不写回 workspace.json 的 sessionIds（侧栏本来就不该出现它）';
      } else if (verified && args.writeWorkspace && header && header.cwd) {
        const ws = await writeWorkspaceSession(path.join(home, 'storages', 'workspace.json'), header.cwd, id);
        row.workspace = ws;
        if (!ws.ok) row.reason += '；写回 workspace.json 失败：' + ws.error;
      }
      if (verified && cls !== 'subagent' && !args.writeWorkspace) {
        row.reason += '；未写回 workspace.json（加 --write-workspace 可写，需先关 DSH）';
      }
    } catch (err) {
      row.ok = false;
      row.action = 'failed';
      row.reason = err && err.message ? err.message : String(err);
    }
    results.push(row);
  }

  for (const row of results) {
    const where = row.header && row.header.cwd ? row.header.cwd : '（header 未读到）';
    console.log((row.ok ? '✓ ' : '✗ ') + row.id + '（' + (row.cls === 'subagent' ? '子代理会话 class=subagent' : '归档会话 class A') + '）');
    console.log('   冷: ' + row.coldDir);
    console.log('   热: ' + row.hotDir);
    console.log('   工作区: ' + where);
    console.log('   动作: ' + row.action + (row.reason ? ' —— ' + row.reason : ''));
    if (row.workspace) console.log('   workspace.json: ' + (row.workspace.ok ? '已写回（备份 ' + row.workspace.backup + '）' : '失败：' + row.workspace.error));
    console.log('');
  }

  const subagentMoved = results.filter((row) => row.cls === 'subagent' && row.action === 'moved' && row.ok).length;
  const moved = results.filter((row) => row.action === 'moved' && row.ok).length;
  const planned = results.filter((row) => row.action === 'plan').length;
  const skipped = results.filter((row) => row.action.startsWith('skip')).length;
  const failed = results.filter((row) => row.action === 'failed').length;
  console.log('汇总: 计划 ' + planned + ' / 已搬回 ' + moved + '（其中子代理会话 ' + subagentMoved + '） / 跳过 ' + skipped + ' / 失败 ' + failed);

  if (!args.apply) {
    console.log('');
    console.log('这是 dry-run：没有移动任何文件。确认无误后加 --apply 执行；');
    console.log('要连工作区记账一起写回，加 --write-workspace（**必须先退出 DSH**）。');
  } else {
    console.log('');
    console.log('下一步：启动 DSH，在官方 UI 里对上述会话点「取消归档」（脚本不碰 archivedSessionIds）。');
    console.log('若未写回 workspace.json，会话可能不在侧栏：可重跑本脚本并加 --write-workspace（先关 DSH）。');
  }
  if (args.json) {
    console.log('');
    console.log(JSON.stringify({ home, manifest: manifestFile, dryRun: !args.apply, results }, null, 2));
  }
  return failed > 0 ? 1 : 0;
}

const code = await main();
process.exitCode = code;
