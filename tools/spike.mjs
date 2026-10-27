#!/usr/bin/env node
/**
 * P0-3 服务面 spike（只读；人工读输出）
 *
 * 目的（设计档 §15 P0-3 / B-2）：
 *  ① 打印宿主真实成员：sessions / workspaceRegistry / webServer / slots；
 *  ② 显式验证三个面在 0.2.1-rc.2 可见：
 *       uiWorkspace.openSession
 *       sidebar.panellist
 *       conversation.session.header.utilities
 *  ③ 任何缺失面都要**显式记录降级**，不许静默。
 *
 * 为什么是静态扫描而不是活对象：本脚本在 DSH 之外的普通 Node 里运行，拿不到宿主 ctx。
 * 它读的是宿主的构建产物（resources/app.asar 或检出副本里的 node_modules/@deepseek-ai），
 * 提取符号是否存在。判据是「符号在宿主源码里出现」，人工复核后回填设计档。
 *
 * 用法：
 *   node tools/spike.mjs                        # 自动定位宿主
 *   node tools/spike.mjs --root <dir|app.asar>  # 指定宿主根
 *   node tools/spike.mjs --json                 # 机器可读输出（追加到报告末尾）
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MAX_FILES = 60;
const MAX_BYTES = 24 * 1024 * 1024;

const TOKEN_GROUPS = [
  {
    label: 'workspaceRegistry（dsh-workspace）',
    tokens: ['archiveSession', 'unarchiveSession', 'attachSession', 'detachSession', 'sessionPath', 'resolveByPath', 'archivedSessionIds', 'workspace/session-activity'],
  },
  {
    label: 'sessions（dsh-session）',
    tokens: ['"sessions"', 'sessionId', 'known-event-types', 'user/message', 'assistant/message'],
  },
  {
    label: 'webServer（dsh-webserver）',
    tokens: ['kind: "prefix"', 'kind: "exact"', 'register(', 'prefix', 'handler'],
  },
  {
    label: 'slots（client 插槽契约）',
    tokens: ['settings.section', 'sidebar.panellist', 'sidebar.footer.action', 'sidebar.workspaces', 'conversation.session.header.utilities', 'app.overlay', 'slots.inject'],
  },
];

const FACES = [
  {
    id: 'uiWorkspace.openSession',
    tokens: ['openSession'],
    degradations: ['热会话「打开」改为只复制会话 id 提示用户在手边侧栏自行打开（FR-9 的打开动作退化为提示）。'],
  },
  {
    id: 'sidebar.panellist',
    tokens: ['sidebar.panellist'],
    degradations: ['侧栏主入口不可用：自动回退到 settings.section 配置页 + Ctrl/Cmd+Shift+K 覆盖层（UI 档 §1 的兜底入口；普通 Ctrl+K 归宿主）。'],
  },
  {
    id: 'conversation.session.header.utilities',
    tokens: ['conversation.session.header.utilities'],
    degradations: ['会话头部搜索按钮不可用：只保留侧栏行与 Ctrl/Cmd+Shift+K，记录在本报告的降级清单。'],
  },
];

function parseArgs(argv) {
  const out = { json: false, root: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--root') out.root = argv[++i] || '';
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

/** 候选宿主位置（先显式参数，再环境变量，再常见安装布局）。 */
async function candidateRoots(explicit) {
  const list = [];
  const push = (p) => { if (p) list.push(path.resolve(p)); };
  push(explicit);
  push(process.env.DSH_HOST_ROOT);
  const execDir = path.dirname(process.execPath);
  push(path.join(execDir, '..', 'resources', 'app.asar'));
  push(path.join(execDir, 'resources', 'app.asar'));
  push(path.join('D:', 'dsh-desktop', 'resources', 'app.asar'));
  push(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'DSH', 'resources', 'app.asar'));
  push(path.join('D:', 'workspace', 'harness-checkout', 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64', 'dsh'));
  const out = [];
  for (const candidate of list) {
    try {
      const info = await stat(candidate);
      if (info.isFile() || info.isDirectory()) out.push(candidate);
    } catch {
      /* 不存在就跳过 */
    }
  }
  return out;
}

/** 极简 asar 读取（只读；格式：8 字节 pickle 头 + JSON 目录 + 文件数据）。 */
async function openAsar(asarPath) {
  const fd = await openFile(asarPath);
  const head = Buffer.alloc(8);
  await fd.read(head, 0, 8, 0);
  const headerSize = head.readUInt32LE(4);
  if (!headerSize || headerSize > 64 * 1024 * 1024) throw new Error('asar 头长度异常：' + headerSize);
  const raw = Buffer.alloc(headerSize);
  await fd.read(raw, 0, headerSize, 8);
  const jsonLength = raw.readUInt32LE(0);
  const jsonText = raw.subarray(4, 4 + jsonLength).toString('utf8');
  const tree = JSON.parse(jsonText);
  const dataStart = 8 + headerSize;
  const files = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const rel = prefix ? prefix + '/' + name : name;
      if (entry && entry.files) walk(entry, rel);
      else if (entry && typeof entry.size === 'number' && typeof entry.offset === 'string') {
        files.push({ path: rel, size: entry.size, offset: Number(entry.offset) });
      } else if (entry && typeof entry.size === 'number' && entry.unpacked !== true) {
        files.push({ path: rel, size: entry.size, offset: Number(entry.offset || 0) });
      }
    }
  };
  walk(tree, '');
  return {
    mode: 'asar',
    path: asarPath,
    files,
    read: async (entry) => {
      const buf = Buffer.alloc(entry.size);
      await fd.read(buf, 0, entry.size, dataStart + entry.offset);
      return buf.toString('utf8');
    },
    close: () => fd.close(),
  };
}

async function openFile(target) {
  const { open } = await import('node:fs/promises');
  return open(target, 'r');
}

/** 目录模式（检出副本）：只收 node_modules/@deepseek-ai 下的 .js，且按文件名过滤候选。 */
async function openDirectory(dir) {
  const files = [];
  const walk = async (current) => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') await walk(abs);
        else if (/^dsh-|^@deepseek-ai$/.test(entry.name) && files.length < 4000) await walk(abs);
      } else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) {
        try {
          const info = await stat(abs);
          files.push({ path: path.relative(dir, abs).replace(/\\/g, '/'), size: info.size, abs });
        } catch { /* ignore */ }
      }
    }
  };
  await walk(dir);
  return {
    mode: 'directory',
    path: dir,
    files,
    read: async (entry) => readFile(entry.abs, 'utf8'),
    close: async () => {},
  };
}

function pickCandidates(files) {
  const patterns = [
    /dsh-workspace/,
    /dsh-session-persistence-jsonl/,
    /dsh-webserver/,
    /slots/,
    /ui-workspace/,
    /ui-conversation/,
    /dsh-session\/(?:lib|dist)/,
    /known-event-types/,
    /dsh-client-ui-settings/,
  ];
  const chosen = [];
  for (const file of files) {
    if (!/\.(js|mjs|cjs)$/.test(file.path)) continue;
    if (file.size > 4 * 1024 * 1024) continue;
    if (!patterns.some((re) => re.test(file.path))) continue;
    chosen.push(file);
  }
  return chosen.slice(0, MAX_FILES);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node tools/spike.mjs [--root <dir|app.asar>] [--json]');
    return 0;
  }

  const roots = await candidateRoots(args.root);
  if (!roots.length) {
    console.log('[spike] 未找到宿主安装（可用 --root 指定 resources/app.asar 或检出副本目录）');
    console.log('降级记录：三个关键面均未验证 —— uiWorkspace.openSession / sidebar.panellist / conversation.session.header.utilities');
    return 2;
  }

  let archive = null;
  for (const root of roots) {
    try {
      const info = await stat(root);
      archive = info.isDirectory() ? await openDirectory(root) : await openAsar(root);
      break;
    } catch (err) {
      console.log('[spike] 打开 ' + root + ' 失败：' + err.message);
    }
  }
  if (!archive) return 2;

  const chosen = pickCandidates(archive.files);
  const texts = [];
  let bytes = 0;
  let version = 'unknown';
  for (const entry of chosen) {
    if (bytes > MAX_BYTES) break;
    try {
      const text = await archive.read(entry);
      bytes += text.length;
      texts.push({ path: entry.path, text });
      const versionHit = text.match(/"version"\s*:\s*"([0-9][^"]*)"/);
      if (version === 'unknown' && /app\.asar|dsh\/package\.json/.test(entry.path) && versionHit) version = versionHit[1];
    } catch {
      /* 单个文件失败不影响整体 */
    }
  }

  const haystack = texts.map((t) => t.text).join('\n');
  const hits = (token) => {
    const foundIn = [];
    for (const file of texts) if (file.text.includes(token)) foundIn.push(file.path);
    return foundIn;
  };

  console.log('== dsh-session-vault 服务面 spike ==');
  console.log('宿主根: ' + archive.path + '（' + archive.mode + '）');
  console.log('扫描文件: ' + texts.length + ' / ' + chosen.length + ' 候选，共 ' + Math.round(bytes / 1024) + ' KB');
  console.log('宿主版本（尽力读取）: ' + version);
  console.log('说明: 静态源码面（在 DSH 之外无法取得活 ctx），判定 = 符号在宿主构建产物中出现；');
  console.log('      人工复核后把结论回填设计档 §15 P0-3 / B-2。');
  console.log('');

  const groupReport = [];
  for (const group of TOKEN_GROUPS) {
    console.log('[成员] ' + group.label);
    for (const token of group.tokens) {
      const where = hits(token);
      console.log('   ' + (where.length ? '✓' : '✗') + ' ' + token + (where.length ? '  ← ' + where[0] : '  （未命中：可能改名，按缺失面处理）'));
      groupReport.push({ group: group.label, token, present: where.length > 0, firstFile: where[0] || null });
    }
    console.log('');
  }

  const faceReport = [];
  const degradations = [];
  console.log('[关键面验证]');
  for (const face of FACES) {
    const where = hits(face.tokens[0]);
    const status = where.length ? 'PASS' : 'DEGRADED';
    console.log('   ' + status + '  ' + face.id + (where.length ? '  ← ' + where[0] : ''));
    if (!where.length) {
      for (const note of face.degradations) {
        console.log('         降级：' + note);
        degradations.push({ face: face.id, note });
      }
    }
    faceReport.push({ face: face.id, status, firstFile: where[0] || null });
  }
  console.log('');

  console.log('[附加事实]');
  const workspacesPresent = hits('sidebar.workspaces').length > 0;
  console.log('   sidebar.workspaces ' + (workspacesPresent ? '存在（我们明确不接管，UI 档 §1 / D22）' : '未发现（可能已改名）'));
  if (!workspacesPresent) degradations.push({ face: 'sidebar.workspaces', note: '未在宿主源码命中：不接管策略不受影响，但 better-sidebar 共存假设需复核。' });
  console.log('   ctx.effect / ctx.on("dispose") 口径: 见设计档 §16 约束 1（本脚本不验证运行时生命周期）');
  console.log('');

  if (!degradations.length) {
    console.log('结论：三个关键面全部命中；无降级。');
  } else {
    console.log('结论：存在 ' + degradations.length + ' 条降级记录（已写入本报告，不得静默）：');
    for (const d of degradations) console.log('  - ' + d.face + '：' + d.note);
  }

  if (args.json) {
    console.log('');
    console.log(JSON.stringify({ root: archive.path, mode: archive.mode, version, scannedFiles: texts.length, tokens: groupReport, faces: faceReport, degradations }, null, 2));
  }
  await archive.close();
  return 0;
}

const code = await main();
process.exitCode = code;
