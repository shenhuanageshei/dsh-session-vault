/**
 * zstd 多帧扫描（设计档 §8.1 / C-7）：**按结构走，不猜 magic**。
 *
 * v4 会话日志 = 多帧 zstd：首帧 header + 每次 append 一帧，帧内有 3 字节块头。
 * 这里只做「不解压的帧边界遍历」+「首帧增量读」+「逐帧解压的流式读取」：
 *  - 冷态允许自研只读帧遍历 + zstdDecompressSync（R-16，无写路径）；
 *  - torn tail（历史崩溃碎尾）只标记、不抛，前缀照常可用（R-17）；
 *  - 坏 magic / 保留位 / 块类型 3 一律抛错（照抄宿主三分支）；
 *  - header 增量读 = 8KB 起步 + maxFrames=1 + 1MB 硬上限（抄 readFirstZstdLine）。
 */
import { open } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';

/** 0xFD2FB528（小端字节 28 B5 2F FD） */
export const ZSTD_MAGIC = 4247762216;
export const DEFAULT_HEADER_CHUNK = 8192;
export const DEFAULT_HEADER_MAX_BYTES = 1024 * 1024;

export class FrameScanError extends Error {
  constructor(code, message, offset) {
    super(message || code);
    this.name = 'FrameScanError';
    this.code = code;
    if (typeof offset === 'number') this.offset = offset;
  }
}

function torn(message, offset) {
  return new FrameScanError('torn', message || '帧在 EOF 处被截断', offset);
}

/** 解码帧头（从 FHD 字节开始），返回绝对 headerBytes 与各标志。 */
function decodeFrameHeader(buf, pos, limit) {
  const need = (n) => {
    if (pos + n > limit) throw torn('帧头被截断（偏移 ' + pos + '）', pos);
  };
  need(1);
  const fhd = buf[pos];
  pos += 1;
  const fcsFlag = (fhd >> 6) & 3;
  const singleSegment = ((fhd >> 5) & 1) === 1;
  const checksum = ((fhd >> 2) & 1) === 1;
  const dictFlag = fhd & 3;
  if (((fhd >> 3) & 1) === 1) {
    throw new FrameScanError('reserved-bit', '帧头保留位被置位（偏移 ' + (pos - 1) + '）', pos - 1);
  }
  if (!singleSegment) {
    need(1);
    pos += 1; // window descriptor
  }
  const dictBytes = [0, 1, 2, 4][dictFlag];
  need(dictBytes);
  pos += dictBytes;
  let fcsBytes;
  if (fcsFlag === 0) fcsBytes = singleSegment ? 1 : 0;
  else if (fcsFlag === 1) fcsBytes = 2;
  else if (fcsFlag === 2) fcsBytes = 4;
  else fcsBytes = 8;
  need(fcsBytes);
  pos += fcsBytes;
  return { headerBytes: pos, fhd, fcsFlag, singleSegment, checksum, dictFlag };
}

/** 同步解析一个帧（buf 内 [start, limit)），成功返回 {start,end,blocks,...}。 */
export function parseFrameBuffer(buf, start, limit = buf.length) {
  if (start + 4 > limit) throw torn('帧魔数被截断（偏移 ' + start + '）', start);
  if (buf.readUInt32LE(start) !== ZSTD_MAGIC) {
    throw new FrameScanError('bad-magic', '偏移 ' + start + ' 处不是 zstd 帧魔数（0x' + buf.readUInt32LE(start).toString(16) + '）', start);
  }
  const header = decodeFrameHeader(buf, start + 4, limit);
  let pos = header.headerBytes;
  let blocks = 0;
  for (;;) {
    if (pos + 3 > limit) throw torn('块头被截断（偏移 ' + pos + '）', pos);
    const b0 = buf[pos];
    const b1 = buf[pos + 1];
    const b2 = buf[pos + 2];
    pos += 3;
    const last = (b0 & 1) === 1;
    const type = (b0 >> 1) & 3;
    const size = (b0 >>> 3) | (b1 << 5) | (b2 << 13);
    if (type === 3) throw new FrameScanError('reserved-block', '保留块类型 3（偏移 ' + (pos - 3) + '）', pos - 3);
    const payload = type === 1 ? 1 : size;
    if (pos + payload > limit) throw torn('块体被截断（偏移 ' + pos + '）', pos);
    pos += payload;
    blocks += 1;
    if (last) break;
    if (blocks > 1_000_000) throw new FrameScanError('bad-frame', '块数量异常（偏移 ' + start + '）', start);
  }
  if (header.checksum) {
    if (pos + 4 > limit) throw torn('帧校验和被截断（偏移 ' + pos + '）', pos);
    pos += 4;
  }
  return {
    start,
    end: pos,
    headerBytes: header.headerBytes - start,
    blocks,
    checksum: header.checksum,
    singleSegment: header.singleSegment,
  };
}

/**
 * 同步扫描内存里的 zstd 多帧。
 * @returns {{frames:Array, count:number, bytes:number, tornStart:number|null, stoppedAt:number|null, complete:boolean}}
 */
export function scanFramesBuffer(buf, { maxFrames = 0 } = {}) {
  const frames = [];
  let offset = 0;
  let tornStart = null;
  let stoppedAt = null;
  while (offset < buf.length) {
    if (maxFrames > 0 && frames.length >= maxFrames) {
      stoppedAt = offset;
      break;
    }
    let parsed;
    try {
      parsed = parseFrameBuffer(buf, offset, buf.length);
    } catch (err) {
      if (err && err.code === 'torn') {
        tornStart = offset;
        break;
      }
      throw err;
    }
    frames.push({ index: frames.length, start: parsed.start, end: parsed.end, blocks: parsed.blocks });
    offset = parsed.end;
  }
  return {
    frames,
    count: frames.length,
    bytes: buf.length,
    tornStart,
    stoppedAt,
    complete: tornStart === null && stoppedAt === null && offset === buf.length,
  };
}

/** 小窗口随机读：读 15MB / 8246 帧时避免每帧一次 pread。 */
class CachedReader {
  constructor(fh, size, windowSize = 256 * 1024) {
    this.fh = fh;
    this.size = size;
    this.windowSize = windowSize;
    this.base = 0;
    this.buf = Buffer.alloc(0);
  }

  async at(pos, length) {
    if (pos >= this.size) return Buffer.alloc(0);
    const end = Math.min(pos + length, this.size);
    if (pos < this.base || end > this.base + this.buf.length) {
      const span = Math.min(this.size - pos, Math.max(this.windowSize, length));
      const chunk = Buffer.allocUnsafe(span);
      const { bytesRead } = await this.fh.read(chunk, 0, span, pos);
      this.buf = chunk.subarray(0, bytesRead);
      this.base = pos;
    }
    const offset = pos - this.base;
    return this.buf.subarray(offset, Math.min(offset + length, this.buf.length));
  }
}

async function parseFrameAt(reader, start) {
  const head = await reader.at(start, 4 + 18);
  if (head.length < 4) return null;
  if (head.readUInt32LE(0) !== ZSTD_MAGIC) {
    throw new FrameScanError('bad-magic', '偏移 ' + start + ' 处不是 zstd 帧魔数', start);
  }
  const header = decodeFrameHeader(head, 4, head.length);
  let pos = start + header.headerBytes;
  let blocks = 0;
  for (;;) {
    const blockHead = await reader.at(pos, 3);
    if (blockHead.length < 3) return null;
    const b0 = blockHead[0];
    const b1 = blockHead[1];
    const b2 = blockHead[2];
    const blockPos = pos;
    pos += 3;
    const last = (b0 & 1) === 1;
    const type = (b0 >> 1) & 3;
    const size = (b0 >>> 3) | (b1 << 5) | (b2 << 13);
    if (type === 3) throw new FrameScanError('reserved-block', '保留块类型 3（偏移 ' + blockPos + '）', blockPos);
    const payload = type === 1 ? 1 : size;
    pos += payload;
    if (pos > reader.size) return null;
    blocks += 1;
    if (last) break;
    if (blocks > 1_000_000) throw new FrameScanError('bad-frame', '块数量异常（偏移 ' + start + '）', start);
  }
  if (header.checksum) pos += 4;
  if (pos > reader.size) return null;
  return { index: 0, start, end: pos, blocks, checksum: header.checksum };
}

/** 扫描文件（增量、常数内存按帧）。返回帧边界，不解压。 */
export async function scanFramesFile(filePath, { windowSize = 256 * 1024 } = {}) {
  const fh = await open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const reader = new CachedReader(fh, size, windowSize);
    const frames = [];
    let offset = 0;
    let tornStart = null;
    while (offset < size) {
      const frame = await parseFrameAt(reader, offset);
      if (!frame) {
        tornStart = offset;
        break;
      }
      frame.index = frames.length;
      frames.push(frame);
      offset = frame.end;
    }
    return { frames, count: frames.length, bytes: size, tornStart, stoppedAt: null, complete: tornStart === null && offset === size };
  } finally {
    await fh.close();
  }
}

/**
 * 头部增量读：8KB 起步，帧不满则翻倍，硬上限 1MB；maxFrames=1 时读到首帧即停。
 * @returns {{buffer:Buffer, bytesRead:number, frames:Array, torn:boolean, complete:boolean}}
 */
export async function readHeaderRegion(filePath, options = {}) {
  const chunkSize = options.chunkSize || DEFAULT_HEADER_CHUNK;
  const maxBytes = options.maxBytes || DEFAULT_HEADER_MAX_BYTES;
  const maxFrames = options.maxFrames || 1;
  const fh = await open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    if (size === 0) return { buffer: Buffer.alloc(0), bytesRead: 0, frames: [], torn: false, complete: true };
    let want = Math.min(Math.max(chunkSize, 4), size);
    for (;;) {
      const buffer = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buffer, 0, want, 0);
      const view = buffer.subarray(0, bytesRead);
      let scan = null;
      try {
        scan = scanFramesBuffer(view, { maxFrames });
      } catch (err) {
        if (!err || err.code !== 'torn') throw err;
        scan = null;
      }
      if (scan && scan.frames.length >= maxFrames) {
        return { buffer: view, bytesRead, frames: scan.frames, torn: false, complete: bytesRead >= size };
      }
      if (bytesRead >= size) {
        // 读到 EOF 仍未凑满 maxFrames：整文件被扫完（可能只有 torn 尾）
        if (scan) return { buffer: view, bytesRead, frames: scan.frames, torn: Boolean(scan.tornStart !== null), complete: true };
        return { buffer: view, bytesRead, frames: [], torn: true, complete: true };
      }
      if (want >= maxBytes) {
        throw new FrameScanError('header-too-large', '首帧超过 ' + maxBytes + ' 字节上限（文件 ' + filePath + '）', 0);
      }
      want = Math.min(size, maxBytes, Math.max(want * 2, chunkSize));
    }
  } finally {
    await fh.close();
  }
}

/**
 * 解压单个帧的压缩字节；失败抛 frame-corrupt（不吞）。
 *
 * **先做结构校验，再解压**（§8.1「任一干净帧失败 → error='frame-corrupt'，不写半截索引」）：
 * Node 的 zstdDecompressSync 对**截断帧**并不报错（会静默解出前缀内容），只靠解压异常挡不住
 * 损坏帧。所以这里要求输入恰好是**一帧完整帧**：parseFrameBuffer 能按结构走完（魔数/保留位/
 * 帧头/块头/块体/checksum 全在界内），且帧尾 == 缓冲区末尾（没有 trailing 垃圾）。
 * 任何不符合 → FrameScanError('frame-corrupt')，调用方据此把会话记为 frame-corrupt 而不是写半截索引。
 */
export function decompressFrame(compressed) {
  if (!Buffer.isBuffer(compressed) || compressed.length === 0) {
    throw new FrameScanError('frame-corrupt', '空帧或非 Buffer 输入（无法解压）');
  }
  let parsed;
  try {
    parsed = parseFrameBuffer(compressed, 0);
  } catch (err) {
    const code = err && err.code ? err.code : 'bad-frame';
    throw new FrameScanError(
      'frame-corrupt',
      '帧结构校验失败（' + code + '）：' + (err && err.message ? err.message : err),
      err && typeof err.offset === 'number' ? err.offset : undefined,
    );
  }
  if (parsed.end !== compressed.length) {
    throw new FrameScanError(
      'frame-corrupt',
      '帧末尾有多余字节（帧结束于 ' + parsed.end + '，缓冲区 ' + compressed.length + ' 字节）',
      parsed.end,
    );
  }
  try {
    return zstdDecompressSync(compressed.subarray(parsed.start, parsed.end));
  } catch (err) {
    throw new FrameScanError('frame-corrupt', 'zstd 解压失败：' + (err && err.message ? err.message : err));
  }
}

/**
 * 读日志首行（header）。返回 string|undefined。
 * 增量读：默认只读 8KB；首帧更大才继续加倍到 1MB 上限。
 */
export async function readFirstLine(filePath, options = {}) {
  const region = await readHeaderRegion(filePath, {
    chunkSize: options.chunkSize || DEFAULT_HEADER_CHUNK,
    maxBytes: options.maxBytes || DEFAULT_HEADER_MAX_BYTES,
    maxFrames: 1,
  });
  if (!region.frames.length) return undefined;
  const frame = region.frames[0];
  const text = decompressFrame(region.buffer.subarray(frame.start, frame.end)).toString('utf8');
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(0, newline);
}

export const DEFAULT_PREVIEW_MAX_FRAMES = 2048;
export const DEFAULT_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * **尾部优先**逐行遍历（§15.1 #5：预览的「遍历整份日志」必须有上限）。
 *
 * 预览只要「最近 N 条消息」，所以从最后一帧往前解压，最多 maxFrames 帧 / maxBytes 压缩字节；
 * 截断时首行一定是半行 ⇒ 丢弃（truncated=true 由调用方回传，不静默当成完整结果）。
 * 帧扫描本身仍是结构化遍历（不解压全文），所以 34.5 MB 量级的日志也只解压尾部若干帧。
 *
 * @returns {{frames:number, totalFrames:number, lines:number, bytes:number, truncated:boolean, tornStart:number|null}}
 */
export async function forEachJsonLineTail(filePath, onLine, options = {}) {
  const maxFrames = Math.max(1, Number(options.maxFrames) || DEFAULT_PREVIEW_MAX_FRAMES);
  const maxBytes = Math.max(1, Number(options.maxBytes) || DEFAULT_PREVIEW_MAX_BYTES);
  const scan = await scanFramesFile(filePath, { windowSize: options.windowSize });
  const all = scan.frames;
  if (!all.length) return { frames: 0, totalFrames: 0, lines: 0, bytes: 0, truncated: false, tornStart: scan.tornStart };
  const picked = [];
  let bytes = 0;
  for (let i = all.length - 1; i >= 0 && picked.length < maxFrames; i -= 1) {
    const frame = all[i];
    const size = frame.end - frame.start;
    if (picked.length && bytes + size > maxBytes) break;
    picked.push(frame);
    bytes += size;
    if (bytes >= maxBytes) break;
  }
  picked.reverse();
  const truncated = picked.length < all.length;
  const fh = await open(filePath, 'r');
  try {
    const reader = new CachedReader(fh, scan.bytes, options.windowSize);
    const chunks = [];
    for (const frame of picked) {
      chunks.push(decompressFrame(await reader.at(frame.start, frame.end - frame.start)).toString('utf8'));
      if (chunks.length % 128 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    const text = chunks.join('');
    // 截断点的**首行**可能只是半行（它属于更早的帧）。这里刻意不丢它，而交给调用方的
    // parseLine 处理：半行 JSON 解析必然失败并被忽略，而「帧边界恰好是整行」时不至于白丢一条消息。
    const lines = text.split('\n').filter((line) => line.trim());
    for (const line of lines) await onLine(line);
    return { frames: picked.length, totalFrames: all.length, lines: lines.length, bytes, truncated, tornStart: scan.tornStart };
  } finally {
    await fh.close();
  }
}

/**
 * 逐帧解压 + 逐行回调（流式；每 N 帧 / 16MB 让出事件循环，R-22）。
 * 跨帧的半行会拼接（JSONL 的一行可能被 append 切在帧边界）。
 */
export async function forEachJsonLine(filePath, onLine, options = {}) {
  const yieldEveryFrames = options.yieldEveryFrames || 256;
  const yieldEveryBytes = options.yieldEveryBytes || 16 * 1024 * 1024;
  const scan = await scanFramesFile(filePath, { windowSize: options.windowSize });
  const fh = await open(filePath, 'r');
  const reader = new CachedReader(fh, scan.bytes, options.windowSize);
  let carry = '';
  let lines = 0;
  let frames = 0;
  let sinceYield = 0;
  try {
    for (const frame of scan.frames) {
      const raw = await reader.at(frame.start, frame.end - frame.start);
      const text = decompressFrame(raw).toString('utf8');
      sinceYield += raw.length;
      const parts = (carry + text).split('\n');
      carry = parts.pop() || '';
      for (const line of parts) {
        if (!line.trim()) continue;
        await onLine(line);
        lines += 1;
      }
      frames += 1;
      if (frames % yieldEveryFrames === 0 || sinceYield >= yieldEveryBytes) {
        sinceYield = 0;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    if (carry.trim()) {
      await onLine(carry);
      lines += 1;
    }
    return { frames: scan.count, lines, tornStart: scan.tornStart, bytes: scan.bytes };
  } finally {
    await fh.close();
  }
}
