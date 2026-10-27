import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import {
  ZSTD_MAGIC,
  FrameScanError,
  scanFramesBuffer,
  scanFramesFile,
  parseFrameBuffer,
  readHeaderRegion,
  readFirstLine,
  decompressFrame,
  forEachJsonLine,
} from '../lib/zstd-frames.js';

const FRAME_TOTAL = 8246;
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

async function withTmp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vault-frames-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function frameOf(text) {
  return zstdCompressSync(Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'));
}

test('P1-1: 15MB 级样本扫出 8246 帧（torn tail 不抛、坏 magic 抛）', async () => {
  await withTmp(async (dir) => {
    const parts = [];
    for (let i = 0; i < FRAME_TOTAL; i++) {
      const line = JSON.stringify({ type: 'user/message', seq: i, pad: randomBytes(1100).toString('base64') }) + '\n';
      parts.push(frameOf(line));
    }
    const all = Buffer.concat(parts);
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    await writeFile(file, all);

    const info = await stat(file);
    assert.ok(info.size > 5 * 1024 * 1024, '样本应达到 MB 级（实际 ' + info.size + ' bytes）');

    const fromBuffer = scanFramesBuffer(all);
    assert.equal(fromBuffer.count, FRAME_TOTAL);
    assert.equal(fromBuffer.tornStart, null);
    assert.equal(fromBuffer.complete, true);

    const fromFile = await scanFramesFile(file);
    assert.equal(fromFile.count, FRAME_TOTAL);
    assert.equal(fromFile.tornStart, null);
    assert.equal(fromFile.bytes, info.size);
    assert.equal(fromFile.frames[0].start, 0);
    assert.equal(fromFile.frames[FRAME_TOTAL - 1].end, info.size);

    // torn tail：最后一个不完整帧不得抛
    const torn = Buffer.concat([all, MAGIC.subarray(0, 2)]);
    const tornScan = scanFramesBuffer(torn);
    assert.equal(tornScan.count, FRAME_TOTAL);
    assert.equal(tornScan.tornStart, all.length, 'tornStart 指向碎尾起点');
    assert.equal(tornScan.complete, false);

    await writeFile(file + '.torn', torn);
    const tornFile = await scanFramesFile(file + '.torn');
    assert.equal(tornFile.count, FRAME_TOTAL);
    assert.equal(tornFile.tornStart, all.length);

    // 坏 magic：不是 zstd 帧就抛错（不静默跳过）
    assert.throws(
      () => scanFramesBuffer(Buffer.from('this-is-not-a-zstd-frame-at-all', 'utf8')),
      (err) => err instanceof FrameScanError && err.code === 'bad-magic',
    );
    await assert.rejects(() => scanFramesFile(path.join(dir, 'nope.bin')), (err) => Boolean(err));
  });
});

test('P1-1: 保留位 / 保留块类型 3 / 截断帧都按设计分类', () => {
  // 保留位（FHD bit3）
  const reservedBit = Buffer.concat([MAGIC, Buffer.from([0x28, 0x00, 0x00, 0x00, 0x00])]);
  assert.throws(
    () => parseFrameBuffer(reservedBit, 0),
    (err) => err.code === 'reserved-bit',
  );

  // 保留块类型 3：FHD=0x20（single segment, FCS 1 byte）+ FCS 0 + 块头 b0=0x07
  const badBlock = Buffer.concat([MAGIC, Buffer.from([0x20, 0x00, 0x07, 0x00, 0x00])]);
  assert.throws(
    () => parseFrameBuffer(badBlock, 0),
    (err) => err.code === 'reserved-block',
  );

  // 截断：只有魔数
  assert.throws(
    () => parseFrameBuffer(MAGIC, 0),
    (err) => err.code === 'torn',
  );

  assert.equal(parseFrameBuffer(frameOf('hello'), 0).end, frameOf('hello').length);
  assert.equal(ZSTD_MAGIC, 4247762216);
});

test('P1-1: header 增量读 = 8KB / maxFrames=1 / 1MB 上限', async () => {
  await withTmp(async (dir) => {
    const headFrames = [
      frameOf(JSON.stringify({ type: 'request/header', id: 'session-a', cwd: '<workspace-root>\\demo' }) + '\n'),
      frameOf(JSON.stringify({ type: 'user/message', seq: 1, data: { source: { kind: 'user' } } }) + '\n'),
      frameOf(JSON.stringify({ type: 'turn/end' }) + '\n'),
    ];
    // 「只读 8KB」断言要求文件本身 > 8192 字节（否则 read 必然读到 EOF）。
    // 首帧之后追加足够的帧把文件撑到 16KB+，首帧仍在 8KB 内完成，语义与设计 §8.1 一致。
    const padded = headFrames.slice();
    while (Buffer.concat(padded).length <= 16 * 1024) {
      padded.push(
        frameOf(JSON.stringify({ type: 'turn/start', seq: padded.length, pad: randomBytes(400).toString('base64') }) + '\n'),
      );
    }
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    await writeFile(file, Buffer.concat(padded));
    const info = await stat(file);
    assert.ok(info.size > 8192, '样本必须大于 8KB（实际 ' + info.size + ' bytes）');

    const region = await readHeaderRegion(file, { chunkSize: 8192, maxFrames: 1, maxBytes: 1024 * 1024 });
    assert.equal(region.frames.length, 1);
    assert.equal(region.bytesRead, 8192, '首帧在 8KB 内完成时只读 8KB');
    assert.equal(region.buffer.length, 8192);
    assert.equal(region.torn, false);
    assert.ok(region.bytesRead < info.size, '不得把整个文件读进内存');
    assert.equal(region.frames[0].end, headFrames[0].length, 'maxFrames=1 只覆盖首帧，不越界到后续帧');

    const firstLine = await readFirstLine(file);
    const header = JSON.parse(firstLine);
    assert.equal(header.id, 'session-a');
    assert.equal(header.cwd, '<workspace-root>\\demo');

    // 保留 tiny 文件用例：chunkSize=8 时首帧不完整 → 翻倍读直到首帧完整
    const tiny = Buffer.concat(headFrames);
    await writeFile(path.join(dir, 'tiny.bin'), tiny);
    const grown = await readHeaderRegion(path.join(dir, 'tiny.bin'), { chunkSize: 8, maxFrames: 1, maxBytes: 1024 * 1024 });
    assert.equal(grown.frames.length, 1);
    assert.ok(grown.bytesRead > 8, '8 字节读不满首帧，必须翻倍');
    assert.ok(grown.bytesRead <= tiny.length);
  });
});

test('P1-1: 首帧超过 1MB 上限时抛 header-too-large', async () => {
  await withTmp(async (dir) => {
    const big = frameOf(randomBytes(2 * 1024 * 1024));
    const file = path.join(dir, 'big.v4.jsonl.zstd');
    await writeFile(file, big);
    await assert.rejects(
      () => readHeaderRegion(file, { chunkSize: 8192, maxFrames: 1, maxBytes: 1024 * 1024 }),
      (err) => err instanceof FrameScanError && err.code === 'header-too-large',
    );
  });
});

test('P1-1: 损坏帧解压抛 frame-corrupt（不写半截索引的前提）', () => {
  const frame = frameOf(randomBytes(4096));
  assert.ok(decompressFrame(frame).length === 4096);

  // 截断帧：Node 的 zstdDecompressSync 对截断**不报错**（静默解出前缀），必须靠结构校验拒绝
  assert.throws(
    () => decompressFrame(frame.subarray(0, frame.length - 6)),
    (err) => err instanceof FrameScanError && err.code === 'frame-corrupt',
  );
  // trailing 垃圾不是「一帧完整帧」
  assert.throws(
    () => decompressFrame(Buffer.concat([frame, Buffer.from('trailing-junk', 'utf8')])),
    (err) => err instanceof FrameScanError && err.code === 'frame-corrupt',
  );
  // 两帧拼接也不是「一帧」——调用方必须按 scan 出来的 [start,end) 切片传入
  assert.throws(
    () => decompressFrame(Buffer.concat([frame, frame])),
    (err) => err instanceof FrameScanError && err.code === 'frame-corrupt',
  );
  // 坏 magic：结构校验直接判死
  assert.throws(
    () => decompressFrame(Buffer.from('this-is-not-a-zstd-frame', 'utf8')),
    (err) => err instanceof FrameScanError && err.code === 'frame-corrupt',
  );
});

test('P1-1: 多块帧可扫；跨帧半行可拼接', async () => {
  await withTmp(async (dir) => {
    const multiBlock = zstdCompressSync(randomBytes(300 * 1024));
    const scan = scanFramesBuffer(multiBlock);
    assert.equal(scan.count, 1);
    assert.ok(scan.frames[0].blocks > 1, '大帧应拆成多个块');

    // 一行被 append 切在帧边界
    const file = path.join(dir, 'split.v4.jsonl.zstd');
    await writeFile(file, Buffer.concat([frameOf('{"a":1}\n{"b":'), frameOf('2}\n{"c":3}')]));
    const lines = [];
    const result = await forEachJsonLine(file, async (line) => lines.push(line));
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
    assert.equal(result.frames, 2);
    assert.equal(result.lines, 3);
  });
});
