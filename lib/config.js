/**
 * 运行期配置（设计档 §3.2 / §4.1 / 需求 FR-1）
 *
 * - 落盘：<DSH_HOME>/session-vault/config.json（插件自有 JSON，保存即生效，无需重载/重启）。
 * - cordis config 只在自有配置缺失时作为「种子」（不覆盖已有文件）。
 * - 冷根必须在 sessions 之外（I-9 / A-11），且默认同卷。
 */
import { readFile, writeFile, rename, mkdir, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 检索范围（P3 / FR-P3-2 / P3-D2）：枚举两值，默认 body。
 *
 * - body            = 正文（用户消息 + 助手回复 + 标题）——默认，工具输出不入库（I-14）；
 * - body+toolResults = 额外收录 tool/result 的**文本结果**（绝不含工具参数，见 P3-D3）。
 *
 * `SCOPE_META` 记录的是**库内实际 scope**（indexer 写、engine/status 读）——它与配置
 * 可以短暂不一致（升级 pass 在跑时库内仍是旧值，旧 scope 保持可查，见 FR-P3-2 的后置条件）。
 */
export const SEARCH_SCOPE_BODY = 'body';
export const SEARCH_SCOPE_TOOL_RESULTS = 'body+toolResults';
export const SEARCH_SCOPES = Object.freeze([SEARCH_SCOPE_BODY, SEARCH_SCOPE_TOOL_RESULTS]);
export const DEFAULT_SEARCH_SCOPE = SEARCH_SCOPE_BODY;
/** meta 键：库内实际检索范围（indexer 写；engine/status 读）。 */
export const SEARCH_SCOPE_META = 'index:scope';

/**
 * M3（P3a.1 偏离审计）：**索引 schema 版本常量**（idx 版本）。
 *
 * 落点 meta key 'index:schema'：索引器初始化时读；缺失或与下面的常量不一致 ⇒ 后台全量重建
 * （可暂停、清水位重抽），完成后把版本写回。/status.index 暴露 schema / schemaStored /
 * rebuildNeeded 三个读数。常量放在 config.js 与 SEARCH_SCOPE_META 同处：engine 与 indexer 都要读，
 * 而 indexer 已 import engine ⇒ 常量不能放 indexer（会造成循环依赖）。
 *
 * P3b.1（真机）：写回条件不再要求「本轮 failed===0」——真实库固定有 29 个 extract-empty，
 * 那样 schema 永远写不回、每次启动清水位全量重抽（永远跑不完）。现在只把**瞬态失败**
 * （IO / 未知异常）当作尚未收敛；**确定性数据失败**（extract-empty / frame-corrupt /
 * identity-mismatch）不阻塞写回，未覆盖会话落 meta 'index:schema-gaps' 供 UI 黄条展示。
 */
export const INDEX_SCHEMA_VERSION = 2;
/** meta 键：库内已完成的索引 schema 版本。 */
export const INDEX_SCHEMA_META = 'index:schema';
/** meta 键：schema 写回时仍未覆盖的会话 `[{id,error}]`（JSON；全部覆盖后删除）。 */
export const INDEX_SCHEMA_GAPS_META = 'index:schema-gaps';

/**
 * 读 meta 'index:schema'（缺失 / 空值 / 脏值 ⇒ null）。
 * engine 与 indexer 共用这一份读法：两处各写一遍数字解析，口径迟早会漂。
 */
export function readIndexSchemaStored(store) {
  try {
    const raw = store.getMeta(INDEX_SCHEMA_META);
    if (raw === null || raw === undefined || String(raw).trim() === '') return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  } catch {
    return null;
  }
}

/**
 * 读 meta 'index:schema-gaps'（脏值 / 非数组 ⇒ []）。元素形状固定为 `{id, error}`；
 * 形状不对的元素被丢掉（读面不猜、也不把假数据喂给 UI）。
 */
export function readIndexSchemaGaps(store) {
  let parsed = null;
  try {
    const raw = store.getMeta(INDEX_SCHEMA_GAPS_META);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item) => item && typeof item === 'object' && item.id !== undefined && item.id !== null)
    .map((item) => ({ id: String(item.id), error: item.error === undefined || item.error === null ? '' : String(item.error) }));
}

/**
 * /status.index 的 schema 读数（M3 + P3b.1）：期望版本 + 库内版本 + 是否需要重建 + 未覆盖会话。
 *
 * 后置口径（必须互相自洽）：
 *  - `rebuildNeeded = stored !== INDEX_SCHEMA_VERSION`（**与 gaps 无关**：有 gaps 也不重建，
 *    否则真实库 29 个 extract-empty 会让每次启动都清水位全量重抽）；
 *  - `doneWithGaps = stored === 版本 && gaps 非空`（UI 黄条的唯一判据）。
 */
export function indexSchemaSnapshotFrom(store) {
  const stored = readIndexSchemaStored(store);
  const gaps = readIndexSchemaGaps(store);
  const done = stored === INDEX_SCHEMA_VERSION;
  return {
    schema: INDEX_SCHEMA_VERSION,
    stored,
    rebuildNeeded: !done,
    gaps,
    gapsCount: gaps.length,
    doneWithGaps: done && gaps.length > 0,
  };
}

/**
 * M1（P3a.1，用户裁定方案 A）：scope 升级 pass 的**自动重试轮数上限**（含首轮）。
 * 有失败/被跳过的会话 ⇒ 不写 index:scope、phase=partial，按未覆盖集合自动重试；
 * 轮数用尽仍失败 ⇒ phase=done-with-gaps + meta index:scope-gaps。禁止无限阻塞、禁止静默 done。
 * 放 config.js：engine（/status 兜底读数）与 indexer 都要用它，indexer 已 import engine ⇒ 不能放 indexer。
 */
export const SCOPE_MAX_ROUNDS = 3;
/** meta 键：done-with-gaps 的未覆盖会话 id 列表（JSON 数组；成功后清空）。 */
export const SCOPE_GAPS_META = 'index:scope-gaps';

/**
 * P3b（FR-P3-4）：索引水位的 meta 键前缀 —— indexer 写、engine 删。
 *
 * 删除（trash）会把 docs 一起删掉，但水位 `wm:<id>` 留着的话，恢复之后 indexer 会认为
 * 「水位未变 ⇒ 不需要重索引」，于是恢复回来的会话永远搜不到（静默失效）。所以 trash / trash-restore
 * 都要能删掉这个键；常量放 config.js 是为了让 engine 与 indexer 共用同一份（indexer 已 import engine，
 * 反过来 import 会成环）。
 */
export const WATERMARK_META_PREFIX = 'wm:';
/** P3b：scope 升级 pass 的「已抽取」标记前缀（删除时一并清掉，避免恢复后跳过抽取）。 */
export const TOOL_SCOPE_META_PREFIX = 'tscope:';

/** 把任意值归一成合法 scope（非法值回退 fallback，默认 body）；不做静默「猜」。 */
export function normalizeSearchScope(value, fallback = DEFAULT_SEARCH_SCOPE) {
  return SEARCH_SCOPES.includes(value) ? value : fallback;
}

export const DEFAULT_CONFIG = Object.freeze({
  /** 空串 = 用默认冷根 <DSH_HOME>/session-vault/cold */
  coldRoot: '',
  /** 检索范围（P3）：默认 body；写入非法值按 invalid-config 拒绝（normalizeConfig 见下） */
  searchScope: DEFAULT_SEARCH_SCOPE,
  /** 已归档 + 上次活跃超过 N 天；0 = 关闭自动迁移 */
  archiveAgeDays: 14,
  /** 默认关（首次安装 = 观察模式） */
  autoMigrate: false,
  sweepIntervalMinutes: 30,
  dailyBudgetCount: 20,
  allowCrossVolume: false,
  hydrateOnUnarchive: true,
  /**
   * P4（FR-P4-1 / 设计档 §19.5）：**子代理会话冷存（class S）**三个字段。
   *
   * - subagentMigrate：自动清扫开关（默认关 = 观察模式）。**手动批量不受它限制**（那是用户显式动作）。
   * - subagentAgeDays：年龄门槛；**0 = 关闭**（自动与手动候选都为空，与 archiveAgeDays=0 同义）。
   * - subagentDailyBudgetCount：自动清扫的日预算（键 subscan:budget:<UTC 日>，跨重启不重置）。
   *   手动批量走 SUBAGENT_BATCH_CAP（2000）而不是这个预算 —— 它是自动兜底的节流阀。
   */
  subagentMigrate: false,
  subagentAgeDays: 14,
  subagentDailyBudgetCount: 50,
});

/**
 * 预留配置位（§15.1 #8）：登记「有字段名、但本批没有消费者」的配置。
 *
 * 刻意**不**放进 DEFAULT_CONFIG——放进去就成了「静默 no-op」（用户以为生效、实现什么都不做）。
 * 写入这些字段会被 normalizeConfig 按 **unknown-field 明确拒绝**（错误里点名「本批不生效」与批次），
 * 既不静默丢弃、也不伪造一个生效的回读。
 *
 * A3（P2.6 评审）：`maxConcurrentJobs` 从 DEFAULT_CONFIG 移到这里 —— 它从来没有消费者
 * （引擎写操作**始终**是单串行队列，见 engine.enqueue），旧 UI 却把它说成队列容量，
 * 等于对外承诺了一个不存在的上限。
 */
export const RESERVED_CONFIG_FIELDS = Object.freeze([
  { field: 'indexRecentDays', stage: 'P3', note: '只索引最近 N 天（§8.4）：本批不实现，配置位留空' },
  {
    field: 'maxConcurrentJobs',
    stage: 'P3',
    note: '并发任务上限：引擎写操作始终单串行队列（engine.enqueue），本批没有任何消费者',
  },
]);

const RESERVED_FIELDS = new Map(RESERVED_CONFIG_FIELDS.map((entry) => [entry.field, entry]));

const BOOLEAN_FIELDS = ['autoMigrate', 'allowCrossVolume', 'hydrateOnUnarchive', 'subagentMigrate'];
const INTEGER_FIELDS = {
  archiveAgeDays: { min: 0, max: 3650 },
  sweepIntervalMinutes: { min: 1, max: 1440 },
  dailyBudgetCount: { min: 0, max: 1000 },
  // P4（FR-P4-1）：0 = 关闭子代理冷存（自动与手动候选都为空）
  subagentAgeDays: { min: 0, max: 3650 },
  subagentDailyBudgetCount: { min: 0, max: 1000 },
};

/** DSH_HOME 优先；空串视为未设置；缺省 ~/.dsh（不写死路径的另一种写法）。 */
export function resolveHome(env = process.env) {
  const raw = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), '.dsh');
}

export function resolveVaultPaths(home) {
  const vaultRoot = path.join(home, 'session-vault');
  return {
    home,
    vaultRoot,
    sessionsRoot: path.join(home, 'sessions'),
    storagesRoot: path.join(home, 'storages'),
    workspaceFile: path.join(home, 'storages', 'workspace.json'),
    configPath: path.join(vaultRoot, 'config.json'),
    dbPath: path.join(vaultRoot, 'vault.db'),
    manifestPath: path.join(vaultRoot, 'manifest.jsonl'),
    markerDir: path.join(vaultRoot, 'markers'),
    trashRoot: path.join(vaultRoot, 'trash'),
    coldRootDefault: path.join(vaultRoot, 'cold'),
  };
}

/** child 是否严格位于 parent 之内（大小写不敏感，Windows 语义）。 */
export function isPathInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (!rel) return false;
  if (path.isAbsolute(rel)) return false;
  const lowered = rel.toLowerCase();
  return lowered !== '..' && !lowered.startsWith('..' + path.sep) && !lowered.startsWith('../');
}

export function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export function effectiveColdRoot(config, paths) {
  const raw = config && typeof config.coldRoot === 'string' ? config.coldRoot.trim() : '';
  return raw ? path.resolve(raw) : paths.coldRootDefault;
}

export function publicConfig(config, { home, paths } = {}) {
  const p = paths ?? resolveVaultPaths(home ?? resolveHome());
  const merged = { ...DEFAULT_CONFIG, ...config };
  return {
    ...merged,
    // 派生字段只出现在**对外视图**里，绝不进 config.json / merge 输入（否则保存会被当成未知字段）
    autoMigrateEffective: merged.archiveAgeDays > 0 && Boolean(merged.autoMigrate),
    // P4：派生字段只出现在对外视图（同 autoMigrateEffective 的口径）——阈值 0 = 关闭。
    subagentMigrateEffective: merged.subagentAgeDays > 0 && Boolean(merged.subagentMigrate),
    coldRoot: config?.coldRoot ?? '',
    coldRootEffective: effectiveColdRoot(config, p),
    configPath: p.configPath,
    sessionsRoot: p.sessionsRoot,
  };
}

function normalizeBool(value, field, errors) {
  if (typeof value === 'boolean') return value;
  errors.push({ code: 'invalid-config', field, message: field + ' 必须是布尔值' });
  return DEFAULT_CONFIG[field];
}

/**
 * 合并默认值并校验（纯函数，不落盘）。
 * @returns {{ok:boolean, config:object, errors:Array<{code:string,field?:string,message:string}>}}
 */
export function normalizeConfig(raw, { home, sessionsRoot, paths } = {}) {
  const p = paths ?? resolveVaultPaths(home ?? resolveHome());
  const sessions = sessionsRoot ?? p.sessionsRoot;
  const errors = [];
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    errors.push({ code: 'invalid-config', message: '配置必须是 JSON 对象' });
  }
  for (const key of Object.keys(input)) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) continue;
    const reserved = RESERVED_FIELDS.get(key);
    if (reserved) {
      // A3：预留字段的错误码仍是 unknown-field（调用方/测试按它判定），但文案必须说清
      // 「这是登记过的预留位、本批不生效」——旧实现把它当普通字段接受，用户以为设置生效了。
      errors.push({
        code: 'unknown-field',
        field: key,
        reserved: true,
        stage: reserved.stage,
        message: '预留配置字段 ' + key + ' 本批不生效（' + reserved.stage + ' 才启用），写入被拒绝：' + reserved.note,
      });
      continue;
    }
    errors.push({ code: 'unknown-field', field: key, message: '未知配置字段：' + key });
  }

  const config = { ...DEFAULT_CONFIG };

  const coldRootRaw = input.coldRoot;
  if (coldRootRaw !== undefined && coldRootRaw !== null && typeof coldRootRaw !== 'string') {
    errors.push({ code: 'invalid-config', field: 'coldRoot', message: 'coldRoot 必须是字符串' });
  } else if (typeof coldRootRaw === 'string' && coldRootRaw.trim() !== '') {
    const cold = coldRootRaw.trim();
    if (!path.isAbsolute(cold)) {
      errors.push({ code: 'invalid-config', field: 'coldRoot', message: 'coldRoot 必须是绝对路径' });
    } else {
      config.coldRoot = path.resolve(cold);
      if (samePath(config.coldRoot, sessions) || isPathInside(config.coldRoot, sessions)) {
        errors.push({
          code: 'cold-root-inside-sessions',
          field: 'coldRoot',
          message: '冷根目录不能放在 <DSH_HOME>/sessions 之内：它会让宿主 persistence.list() 抛错（C-5），并可能拖垮启动（I-9 / D14）',
        });
      }
    }
  }

  // P3 / FR-P3-2：枚举字段——非法值一律 invalid-config 拒绝（不静默回退成默认值后假装保存成功）。
  if (input.searchScope !== undefined) {
    const raw = input.searchScope;
    if (typeof raw !== 'string' || !SEARCH_SCOPES.includes(raw)) {
      errors.push({
        code: 'invalid-config',
        field: 'searchScope',
        message: 'searchScope 必须是 ' + SEARCH_SCOPES.join(' | ') + ' 之一（收到 ' + JSON.stringify(raw) + '）',
      });
    } else {
      config.searchScope = raw;
    }
  }

  for (const field of BOOLEAN_FIELDS) {
    if (input[field] !== undefined) config[field] = normalizeBool(input[field], field, errors);
  }

  for (const [field, range] of Object.entries(INTEGER_FIELDS)) {
    if (input[field] === undefined) continue;
    const value = input[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      errors.push({ code: 'invalid-config', field, message: field + ' 必须是整数' });
      continue;
    }
    if (value < range.min || value > range.max) {
      errors.push({
        code: 'invalid-config',
        field,
        message: field + ' 必须在 ' + range.min + '..' + range.max + ' 之间（收到 ' + value + '）',
      });
      continue;
    }
    config[field] = value;
  }

  return { ok: errors.length === 0, config, errors };
}

function seedToRaw(seed) {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) return null;
  const out = {};
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (Object.prototype.hasOwnProperty.call(seed, key) && seed[key] !== undefined) out[key] = seed[key];
  }
  return Object.keys(out).length ? out : null;
}

export async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now().toString(16) + '.tmp';
  const text = JSON.stringify(value, null, 2) + '\n';
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}

export async function readConfigFile(paths) {
  try {
    return JSON.parse(await readFile(paths.configPath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return { missing: true };
    return { corrupt: true, error: err.message };
  }
}

/**
 * 配置存储（带内存缓存：保存后立即读到新值；冷根本次保存只影响之后的迁移）。
 */
export function createConfigStore(options = {}) {
  const home = options.home ?? resolveHome();
  const paths = options.paths ?? resolveVaultPaths(home);
  const seed = options.seed ?? null;
  const sessionsRoot = options.sessionsRoot ?? paths.sessionsRoot;
  let cache = null;

  async function load() {
    if (cache) return cache;
    const raw = await readConfigFile(paths);
    const errors = [];
    let source = 'defaults';
    let input = {};

    if (raw && raw.corrupt) {
      errors.push({ code: 'config-corrupt', message: 'config.json 无法解析，已回退默认值（原文件保留）：' + raw.error });
    } else if (raw && raw.missing) {
      const seeded = seedToRaw(seed);
      if (seeded) {
        input = seeded;
        source = 'seed';
      }
    } else {
      input = raw;
      source = 'file';
    }

    // A3（P2.6）：**读取容错、写入严格**。
    //
    // `maxConcurrentJobs` 曾经在 DEFAULT_CONFIG 里 ⇒ 旧版本保存的 config.json 必然含它。
    // 它现在只登记在 RESERVED_CONFIG_FIELDS。如果读也当成未知字段报错，每个存量安装的
    // /status.configErrors 都会永久挂一条「自己造成的历史字段」、`ok` 恒 false ——
    // 把「历史遗留」伪装成「配置坏了」。所以读的时候先摘掉预留字段（它们本来就没有消费者），
    // 把摘掉的名字记进 `reserved` 供读面展示；`save()` 仍走**严格** normalize（写入必拒）。
    const reserved = [];
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const filtered = { ...input };
      for (const entry of RESERVED_CONFIG_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(filtered, entry.field)) continue;
        reserved.push(entry.field);
        delete filtered[entry.field];
      }
      input = filtered;
    }

    const result = normalizeConfig(input, { home, sessionsRoot, paths });
    cache = {
      ok: result.ok,
      source,
      config: result.config,
      errors: errors.concat(result.errors),
      reserved,
      paths,
      home,
    };
    return cache;
  }

  async function save(patch) {
    const current = (await load()).config;
    const delta = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const result = normalizeConfig({ ...current, ...delta }, { home, sessionsRoot, paths });
    if (!result.ok) {
      return { ok: false, errors: result.errors, config: current };
    }
    await atomicWriteJson(paths.configPath, result.config);
    cache = { ok: true, source: 'file', config: result.config, errors: [], reserved: [], paths, home };
    return {
      ok: true,
      errors: [],
      config: result.config,
      publicConfig: publicConfig(result.config, { home, paths }),
    };
  }

  return {
    home,
    paths,
    sessionsRoot,
    load,
    save,
    invalidate() { cache = null; },
    peek() { return cache; },
    publicConfig: async () => publicConfig((await load()).config, { home, paths }),
    effectiveColdRoot: async () => effectiveColdRoot((await load()).config, paths),
  };
}
