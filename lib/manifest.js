/**
 * manifest.jsonl（设计档 §4.3 / S-3 / Y-4）
 *
 * - **DB 是事实源，manifest 是审计副本**：DB 有、manifest 无 → 启动对账补 op:'repair'。
 * - append 前查重：迁移用 id+op+moved_at；恢复用 id+op+ts（恢复成功后 moved_at 置空，不能拿它做键）。
 * - 追加式、一行一条、坏行不阻塞读取（计入 invalid）。
 */
import { readFile, appendFile, mkdir, open, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export function dedupKey(record) {
  const op = record && record.op ? String(record.op) : 'unknown';
  const id = record && record.id ? String(record.id) : '';
  if (op === 'migrate') {
    const stamp = record.movedAt !== undefined && record.movedAt !== null ? record.movedAt : record.ts;
    return id + '|' + op + '|' + stamp;
  }
  return id + '|' + op + '|' + (record && record.ts);
}

export class Manifest {
  /**
   * @param {string} filePath manifest.jsonl 路径
   * @param {{assertPath?: (target: string) => string}} [hooks] 写路径断言钩子（A-19）
   */
  constructor(filePath, hooks = {}) {
    this.filePath = filePath;
    this.dir = path.dirname(filePath);
    this.assertPath = typeof hooks.assertPath === 'function' ? hooks.assertPath : null;
    /**
     * 查重键的内存索引（P2.4 🔵 #4）：旧 `appendDedup` 每写一行都把**整个** manifest 读回并逐行
     * 重新算键 —— 迁移/恢复每次都要 O(全档)。审计档只随本实例增长（单写者：插件的串行引擎队列），
     * 所以首次用时建一次索引、之后每次 append 同步维护即可。
     * 边界（如实声明）：若外部进程往同一个 manifest.jsonl 追加，本进程读不到那一行（可能重复一行审计），
     * 与「DB 是事实源、manifest 是审计副本」的口径一致，不因此阻塞迁移/恢复。
     */
    this.keys = null;
  }

  /** 惰性构建查重键索引（首次 appendDedup 才读盘）。 */
  async keyIndex() {
    if (this.keys) return this.keys;
    const { records } = await this.readAll();
    this.keys = new Set(records.map((record) => dedupKey(record)));
    return this.keys;
  }

  guard(target) {
    if (this.assertPath) this.assertPath(target);
    return target;
  }

  async ensureDir() {
    await mkdir(this.guard(this.dir), { recursive: true });
  }

  async readAll() {
    try {
      const text = await readFile(this.filePath, 'utf8');
      const records = [];
      let invalid = 0;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          invalid += 1;
        }
      }
      return { records, invalid };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { records: [], invalid: 0 };
      throw err;
    }
  }

  async append(record) {
    await this.ensureDir();
    const payload = { ts: record.ts || Date.now(), ...record };
    const line = JSON.stringify(payload) + '\n';
    const target = this.guard(this.filePath);
    await appendFile(target, line, 'utf8');
    // 索引已建时同步维护（保持与后续 appendDedup 的判据一致）。
    if (this.keys) this.keys.add(dedupKey(payload));
    try {
      const handle = await open(target, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      /* fsync 失败不阻塞审计 */
    }
    return record;
  }

  /**
   * 查重后追加；已存在同键记录则跳过（返回 {skipped:true, key}）。
   * P2.4 🔵 #4：查重走内存索引（`keyIndex()`），不再每次整档读取。
   */
  async appendDedup(record) {
    const keys = await this.keyIndex();
    const key = dedupKey(record);
    if (keys.has(key)) return { skipped: true, key };
    await this.append(record);
    keys.add(key);
    return { skipped: false, record };
  }

  /**
   * 启动对账 / /diagnose 修复：DB 有、manifest 无 → 补 repair 行。
   *
   * P3b（评审遗留 🔵）：这个方法此前**没有生产调用方**（engine.reconcileManifest 自己又写了一份
   * 「补齐 repair 行」的逻辑），两处判据迟早漂移。现在 engine.reconcileManifest 就调它，
   * 判据只有一份；`snapshot.records` 允许调用方传入**已读好的**记录快照，避免 118 行各读一次整档。
   *
   * @param {{id:string, ts?:number, reason?:string}} record
   * @param {{records?:object[]}} [snapshot] 已读好的 manifest 记录（省略则本方法自己 readAll）
   * @returns {Promise<{repaired:boolean}>}
   */
  async repairIfMissing(record, snapshot = null) {
    const records = snapshot && Array.isArray(snapshot.records) ? snapshot.records : (await this.readAll()).records;
    const id = String(record && record.id);
    if (!id) return { repaired: false };
    const found = records.some((existing) => existing && String(existing.id) === id && (existing.op === 'migrate' || existing.op === 'restore'));
    if (found) return { repaired: false };
    await this.append({ ...record, op: 'repair', ts: (record && record.ts) || Date.now(), reason: (record && record.reason) || 'manifest-missing' });
    return { repaired: true };
  }

  /**
   * 按谓词**删除**记录（P3b / FR-P3-5：安全的「删 manifest 行」修复动作）。
   *
   * manifest 是追加式审计档 ⇒ 删除只能整档重写：写临时名 → fsync → rename（与 marker 同款，
   * Windows 不能 fsync 目录，崩溃窗口由启动对账兜底）。
   *
   * **坏行（invalid JSON）无法逐行还原**（readAll 只回可解析的记录）：重写时它们不会以原文出现，
   * 但会在新档头部留一条 `reason:'manifest-rewrite'` 的说明记录，如实记下丢了几条 ——
   * 「重写丢过坏行」这件事本身不能被静默。
   *
   * 后置：返回 {removed, kept, invalid}；删完重建查重索引（避免 appendDedup 用旧键把行又「补」回去）。
   */
  async removeRecords(predicate) {
    const { records, invalid } = await this.readAll();
    const keep = [];
    let removed = 0;
    for (const record of records) {
      let drop = false;
      try {
        drop = typeof predicate === 'function' ? Boolean(predicate(record)) : false;
      } catch {
        drop = false;
      }
      if (drop) removed += 1;
      else keep.push(record);
    }
    if (!removed) return { removed: 0, kept: keep.length, invalid };
    // 坏行无法逐行恢复原文位置，只能按数量保留占位说明（不静默丢失审计的「有坏行」这一事实）。
    const header = invalid
      ? [{ ts: Date.now(), op: 'repair', id: null, reason: 'manifest-rewrite', note: '重写时保留 ' + invalid + ' 条无法解析的坏行（原文已丢弃）' }]
      : [];
    const body = [...header, ...keep].map((record) => JSON.stringify(record)).join('\n');
    await this.ensureDir();
    const target = this.guard(this.filePath);
    const tmp = this.guard(target + '.' + process.pid + '.' + Date.now().toString(16) + '.tmp');
    const text = body ? body + '\n' : '';
    await writeFile(tmp, text, 'utf8');
    try {
      const handle = await open(tmp, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      /* fsync 失败不阻塞（审计副本） */
    }
    await rename(tmp, target);
    this.keys = null;
    return { removed, kept: keep.length, invalid };
  }
}
