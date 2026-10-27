/**
 * marker（设计档 §4.1 / §6.2 / §7）+ 全代际基线工具。
 *
 * marker 是崩溃收敛的**唯一校验基线**（planSha + files[]），但它只记「意图 + 基线」，
 * **不决定动作**——动作由 §11 的 (src,dst) 真值表决定。
 *
 * 落盘：<DSH_HOME>/session-vault/markers/<sessionId>.json
 * Windows 不能对目录 fsync（D24）：走「临时名写入 + 文件 fsync + rename」，父目录同步跳过，
 * 断电窗口由 recoverOnBoot() 对账覆盖。
 */
import { readdir, readFile, writeFile, rename, unlink, mkdir, open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const MARKER_VERSION = 1;

const GENERATION_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

/** 会话目录里允许出现的唯一文件形态：代际日志（v0 = session.jsonl.zstd）。 */
export function isGenerationName(name) {
  return GENERATION_RE.test(String(name));
}

export function generationVersion(name) {
  const match = GENERATION_RE.exec(String(name));
  if (!match) return null;
  return match[1] === undefined ? 0 : Number(match[1]);
}

/** 目录内代际文件按版本升序（v0→v3→v4）；currentGeneration = 末项。 */
export function sortGenerations(names) {
  return [...names].sort((a, b) => {
    const va = generationVersion(a);
    const vb = generationVersion(b);
    if (va === null || vb === null) return String(a).localeCompare(String(b));
    return va - vb;
  });
}

export function currentGeneration(names) {
  const sorted = sortGenerations(names);
  return sorted.length ? sorted[sorted.length - 1] : null;
}

/**
 * projectKey —— **与宿主逐字一致**的实现（设计档 C-11 / I-4 / A-10）。
 *
 * 宿主源码：@deepseek-ai/dsh-session-persistence-jsonl（构建副本 lib/index.js:875-894）
 *
 * ```js
 * function projectKey(cwd) {
 *   if (cwd.length === 0) throw new Error("cannot encode an empty project path");
 *   let readable = ""; let separatorRun = false;
 *   for (let i = 0; i < cwd.length; i++) {
 *     const code = cwd.charCodeAt(i); const ch = String.fromCharCode(code);
 *     if (ch === "/" || ch === "\\" || ch === ":") { if (!separatorRun) readable += "-"; separatorRun = true; }
 *     else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; separatorRun = false; }
 *     else { readable += "~" + code.toString(16).toUpperCase().padStart(4, "0"); separatorRun = false; }
 *   }
 *   return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
 * }
 * ```
 *
 * 三个必须逐字对齐的细节（旧实现三处全错，会让真实归档会话 100% 被 A-10 门拒绝）：
 *  ① `/ \ :` 的**连续段**折叠成一个 `-`（separatorRun 标志）—— `D:\DSH-x` → `D-DSH-x`，
 *     不是逐字符替换出来的 `D--DSH-x`；
 *  ② `~` 本身也要转义成 `~007E`（不安全字符集不含 `~`）；
 *  ③ 按 **UTF-16 码元**（charCodeAt）转义，不是 code point。
 *
 * @param {string} cwd 会话 header 里的 cwd。
 * @returns {string} 宿主同款 `--<slug>--` 目录名。
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('projectKey 需要非空 cwd 字符串（宿主同款：空路径直接抛错）');
  }
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

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function hashFile(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

export async function listDirFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    files.push({ name: entry.name, dir: entry.isDirectory(), link: entry.isSymbolicLink() });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** 全代际哈希基线：{files:[{name,bytes,sha256}], bytes, sha256}。 */
export async function hashTree(dir) {
  const entries = await listDirFiles(dir);
  const files = [];
  let bytes = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const abs = path.join(dir, entry.name);
    const info = await stat(abs);
    const sha256 = await hashFile(abs);
    files.push({ name: entry.name, bytes: info.size, sha256 });
    bytes += info.size;
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  const aggregate = createHash('sha256');
  for (const file of files) aggregate.update(file.name + '\t' + file.bytes + '\t' + file.sha256 + '\n');
  return { files, bytes, sha256: aggregate.digest('hex') };
}

/** 轻量指纹（名字+字节+mtime），用于「copy 前后源未变」与写栅栏。 */
export async function statTree(dir) {
  const entries = await listDirFiles(dir);
  const files = [];
  let bytes = 0;
  let maxMtimeMs = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const info = await stat(path.join(dir, entry.name));
    files.push({ name: entry.name, bytes: info.size, mtimeMs: Math.trunc(info.mtimeMs) });
    bytes += info.size;
    maxMtimeMs = Math.max(maxMtimeMs, Math.trunc(info.mtimeMs));
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { files, bytes, maxMtimeMs };
}

export function fingerprint(tree) {
  return tree.files.map((f) => f.name + ':' + f.bytes + ':' + f.mtimeMs).join('|');
}

export async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** 文件 fsync（目录 fsync 在 Windows 上不可用，D24：明确跳过）。 */
export async function fsyncFile(filePath) {
  const handle = await open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function fsyncDir() {
  return false;
}

export class MarkerStore {
  /**
   * @param {string} dir markers 目录
   * @param {{assertPath?: (target: string) => string}} [hooks] 写路径断言钩子（A-19：引擎注入 assertWritable）
   */
  constructor(dir, hooks = {}) {
    this.dir = dir;
    this.assertPath = typeof hooks.assertPath === 'function' ? hooks.assertPath : null;
  }

  guard(target) {
    if (this.assertPath) this.assertPath(target);
    return target;
  }

  pathFor(sessionId) {
    return path.join(this.dir, sessionId + '.json');
  }

  async ensureDir() {
    await mkdir(this.guard(this.dir), { recursive: true });
  }

  async read(sessionId) {
    try {
      return JSON.parse(await readFile(this.pathFor(sessionId), 'utf8'));
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw new Error('marker 读取失败（' + sessionId + '）：' + (err && err.message ? err.message : err));
    }
  }

  async list() {
    try {
      const names = await readdir(this.dir);
      return names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async write(sessionId, marker) {
    await this.ensureDir();
    const now = Date.now();
    const payload = {
      v: MARKER_VERSION,
      ...marker,
      id: sessionId,
      updatedAt: now,
      createdAt: marker && marker.createdAt ? marker.createdAt : now,
    };
    const target = this.guard(this.pathFor(sessionId));
    const tmp = this.guard(target + '.' + process.pid + '.' + now.toString(16) + '.tmp');
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    try {
      await fsyncFile(tmp);
    } catch {
      /* 文件 fsync 失败不阻塞（启动对账兜底） */
    }
    await rename(tmp, target);
    return payload;
  }

  async patch(sessionId, delta) {
    const current = await this.read(sessionId);
    if (!current) throw new Error('marker 不存在：' + sessionId);
    return this.write(sessionId, { ...current, ...delta });
  }

  async remove(sessionId) {
    try {
      await unlink(this.guard(this.pathFor(sessionId)));
      return true;
    } catch (err) {
      if (err && err.code === 'ENOENT') return false;
      throw err;
    }
  }
}
