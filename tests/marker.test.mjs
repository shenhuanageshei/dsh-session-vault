import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { projectKey } from '../lib/marker.js';
import { readHeaderRegion } from '../lib/zstd-frames.js';

/**
 * 独立转写：宿主 @deepseek-ai/dsh-session-persistence-jsonl（构建副本 lib/index.js:875-894）
 * 的 projectKey 逐行对照版。它**不是**实现（实现见 lib/marker.js），而是差分测试的参照物。
 * 设计档 C-11 / I-4 / A-10：迁移前「目录名 == projectKey(header.cwd)」是硬门，算法必须逐字一致。
 */
function hostProjectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return '--' + (readable.replace(/^-+/, '') || 'root').slice(0, 251) + '--';
}

test('C-11/A-10（阻断 1）：projectKey 用真实目录名硬编码断言（宿主逐字一致）', () => {
  // 这三个是磁盘上真实存在的 projectKey 目录名（as-of 2026-10-23）。
  // 旧实现逐字符替换 + 不折叠分隔符连续段 ⇒ 产出 --D--dsh-desktop--（真实数据 100% 被 A-10 门拒）。
  assert.equal(projectKey('<DSH_INSTALL>'), '--D-dsh-desktop--');
  assert.equal(projectKey('<workspace-root>\\workspace-intel'), '--workspace-intel--');
  assert.equal(projectKey('<code-root>\\workspace-dns'), '--workspace-dns--');
  // 反例守卫：绝不能出现「双横线」（旧 bug 的指纹）
  assert.equal(projectKey('<DSH_INSTALL>').includes('--D--'), false);
});

test('C-11：分隔符连续段折叠 / ~ 转义 / 不安全字符 / 去前导 - / root / 截断 251', () => {
  // 分隔符连续段只折叠成一个 '-'
  assert.equal(projectKey('D:\\\\\\deep\\a'), '--D-deep-a--');
  assert.equal(projectKey('a//b::c'), '--a-b-c--');
  // '~' 本身也转义（不安全字符集不含 ~）
  assert.equal(projectKey('a~b'), '--a~007Eb--');
  // 不安全字符按 UTF-16 码元转义（大写十六进制、4 位）
  assert.equal(projectKey('a b'), '--a~0020b--');
  assert.equal(projectKey('Ünïcode'), '--~00DCn~00EFcode--');
  // 去前导 '-'：连续分隔符打头 → 只剩 'root' 或去掉前导后的内容
  assert.equal(projectKey('\\tmp\\x'), '--tmp-x--');
  assert.equal(projectKey('///'), '--root--');
  // 宿主口径：'C:' → slug 'C-'（尾部分隔符保留）⇒ --C---
  assert.equal(projectKey('C:'), '--C---');
  // 截断 251（slug 部分）
  const long = 'D:\\' + 'a'.repeat(400);
  assert.equal(projectKey(long), '--D-' + 'a'.repeat(249) + '--');
  // 空串按宿主口径抛错（不是静默返回 --root--）
  assert.throws(() => projectKey(''), /projectKey/);
});

test('C-11：与宿主转写版逐字一致（差分测试，含边界样本）', () => {
  const samples = [
    '<DSH_INSTALL>',
    '<workspace-root>\\workspace-intel',
    '<code-root>\\workspace-dns',
    '<workspace-root>\\workspace-agent',
    'D:\\a b\\c~d',
    '\\\\server\\share\\x',
    'C:/Users/x/y',
    'a',
    'D:',
    '///',
    '\\tmp\\x',
    'Ünïcode/路径',
    'D:\\' + 'long-segment-'.repeat(30),
  ];
  for (const sample of samples) assert.equal(projectKey(sample), hostProjectKey(sample), sample);
});

/**
 * A-22 / 阻断 1 的真数据回归（**只读**）：真实 ~/.dsh/sessions 里每个会话目录名都应当
 * 等于 projectKey(header.cwd)。旧实现在 Windows 路径上几乎 100% 不等，这条用例能直接抓住。
 */
test('C-11 真数据只读回归：真实会话目录名 == projectKey(header.cwd)', async (t) => {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  let projects = [];
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    t.skip('本机没有 ~/.dsh/sessions（跳过真数据只读回归）');
    return;
  }
  let checked = 0;
  const mismatches = [];
  for (const project of projects) {
    if (!project.isDirectory() || checked >= 150) continue;
    const dir = path.join(root, project.name);
    const sessions = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const session of sessions) {
      if (!session.isDirectory() || checked >= 150) continue;
      const sessionDir = path.join(dir, session.name);
      const files = (await readdir(sessionDir).catch(() => [])).filter((name) => /^session(?:\.v\d+)?\.jsonl\.zstd$/.test(name));
      if (!files.length) continue;
      files.sort((a, b) => Number(/(\d+)/.exec(a)?.[1] || 0) - Number(/(\d+)/.exec(b)?.[1] || 0));
      const file = path.join(sessionDir, files[files.length - 1]);
      try {
        const info = await stat(file);
        if (info.size > 4 * 1024 * 1024) continue;
        const region = await readHeaderRegion(file, { chunkSize: 8192, maxFrames: 1, maxBytes: 1024 * 1024 });
        if (!region.frames.length) continue;
        const frame = region.frames[0];
        const line = zlib.zstdDecompressSync(region.buffer.subarray(frame.start, frame.end)).toString('utf8').split('\n')[0];
        const value = JSON.parse(line);
        const cwd = (value.data && value.data.cwd) || value.cwd;
        if (!cwd) continue;
        checked += 1;
        if (projectKey(cwd) !== project.name) mismatches.push({ cwd, expected: projectKey(cwd), actual: project.name });
      } catch {
        /* 坏样本跳过（只读回归不追坏日志） */
      }
    }
  }
  if (!checked) {
    t.skip('本机没有可读的会话样本（跳过）');
    return;
  }
  assert.deepEqual(mismatches, [], '真数据上 projectKey 必须与目录名逐个命中（旧实现会大面积不等）');
  assert.ok(checked >= 1);
});
