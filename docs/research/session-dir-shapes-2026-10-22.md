# 会话目录形态复核（2026-10-22 16:0x 独立实测）

- 目的：补齐设计档 §2 约束表（C-15）、§6.1 前置校验、§4.2 schema 所缺的实测事实
- 实测范围：本机 DSH 桌面 profile 的 ~/.dsh/sessions 全量枚举（不是抽样）
- 关联：[设计档](../2026-10-22-session-vault-design.md) · [安全边界档](../2026-10-22-session-vault-safety.md) · [工程交接档](../2026-10-22-session-vault-eng-readiness.md)

## 0 三句话结论

1. **会话目录里只有日志**：2097 个会话目录中，非日志文件 **0** 个、`*.tmp` **0** 个 → 原 C-15「搬移单位 = 整目录、附件不随会话走」成立。
2. **但一个目录可能并存多个代际日志**：22/2097（1.05%）的目录里有 2~3 个代际文件并存；**118 个归档会话里只有 1 个命中**（workspace-agent 的 session-3ed98fee-cb49-4849-9f74-938f1d56654d，v3 + v4）。
3. **对设计的唯一影响**：§6.1 前置第 3 条「仅含合法代际日志」会把那 1 个会话挡住；§4.2 的 log_name 单值装不下多代目录。

## 1 全量读数（as-of 2026-10-22 16:0x）

| 目录内文件形态 | 目录数 |
| --- | --- |
| `session.v4.jsonl.zstd` | 1581 |
| `session.v3.jsonl.zstd` | 284 |
| `session.jsonl.zstd`（旧名，v0 代际） | 210 |
| `session.v3.jsonl.zstd` + `session.v4.jsonl.zstd` | 11 |
| `session.jsonl.zstd` + `session.v3.jsonl.zstd` | 6 |
| `session.jsonl.zstd` + `session.v3.jsonl.zstd` + `session.v4.jsonl.zstd` | 3 |
| `session.jsonl.zstd` + `session.v4.jsonl.zstd` | 2 |
| **合计** | **2097** |

- 多代并存目录：**22**（1.05%）；单文件目录：2075。
- 含旧名 `session.jsonl.zstd`（v0 代际）的目录：**221**（与需求档「v0 旧格式 221」一致）→ 落 C-13「冷态只读第 0 帧、禁止 `persistence.open`」。
- 非日志文件（附件/锁/spill 等）：**0**；`*.tmp`：**0**。
- 归档会话中命中多代的：**1** 个 → `session-3ed98fee-cb49-4849-9f74-938f1d56654d` @ `--workspace-agent--`（`session.v3.jsonl.zstd,session.v4.jsonl.zstd`）。
- 成因未取证（推断：v3→v4 升级时写了新代际文件但旧文件未清理，与 C-13「读 v0/v3 会写新文件」一致）。对插件不构成风险，因为搬移单位是整目录。

## 2 设计档需要改的 4 处（原文 → 新文）

| # | 位置 | 原文 | 改成 |
| --- | --- | --- | --- |
| E-1 | §2 约束表 C-15 行 | 「一个会话目录只放日志（无附件/锁/spill）；2083 个目录实测」 | 「…；2097 个目录实测：非日志文件 0、`.tmp` 0；**22 个目录并存 2~3 个代际文件**（见 C-16）」 |
| E-2 | §2 约束表新增 C-16 | — | 「会话目录可能并存多个代际日志（22/2097 目录；118 个归档会话中 1 个命中）→ 搬移按整目录即可，但 **preflight 不得要求「只有一个日志文件」**；索引只取宿主当前代际」 |
| E-3 | §6.1 前置校验第 3 条 | 「源目录存在、仅含合法代际日志、无 `*.tmp`（C-14）、非符号链接」 | 「源目录存在、**只含代际日志文件（可能多代并存，见 C-16）**、无 `*.tmp`（C-14）、非符号链接」 |
| E-4 | §4.2 schema | `log_name TEXT NOT NULL, -- 代际文件名，必须原样搬回（C-11）` | `log_names TEXT NOT NULL, -- 逗号分隔的代际文件名（可能多代并存，C-16），必须原样搬回（C-11）` |

附带：§12 防偏离建议加一条锚 **A-13（多代目录）**：注入一个 v3+v4 并存的会话目录 → 迁移后冷目录两个文件都在、字节数一致、索引只收宿主当前代际、恢复后宿主仍能打开该会话。

## 3 为什么这条重要（和「不会丢」的关系）

- 多代目录**不是损坏态**：宿主自己就这么存着，插件没有义务清理。
- 整目录搬移对它**是安全的**：文件一起走、一起回来，sha256 校验覆盖全部文件。
- 真正的风险只在**按「目录里应该只有一个日志」去校验**：那 1 个会话会被永久拒绝迁移 —— 表现是「搬不走」，不是「搬丢」。属可用性问题，不属数据安全问题。

## 4 复现命令（PowerShell，只读）

```powershell
$h="$env:USERPROFILE\.dsh"
$j=Get-Content "$h\storages\workspace.json" -Raw | ConvertFrom-Json
$arch=@($j.global.archivedSessionIds)
$shapes=@{}; $n=0
Get-ChildItem "$h\sessions" -Directory | ForEach-Object {
  Get-ChildItem $_.FullName -Directory | ForEach-Object {
    $n++
    $key=((Get-ChildItem $_.FullName -File -EA SilentlyContinue | Sort-Object Name).Name -join ",")
    if(-not $shapes.ContainsKey($key)){$shapes[$key]=0}
    $shapes[$key]++
    if($arch -contains $_.Name){"ARCHIVED: " + $_.Name + " :: " + $key}
  }
}
"dirs=$n"
$shapes.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { "$($_.Value) x $($_.Key)" }
```

## 5 恢复路径的实测验证（2026-10-22 16:2x）

设计档 C-11 说「会话身份 = 路径，搬回必须回原 projectKey = projectKey(header.cwd)」。这条不能只靠读源码 —— 已用真实归档会话验证：

- 取 `session-persistence-jsonl/src/format.ts:225` 的 `projectKey()` 算法（分隔符 `/ \\ :` → `-`；非 `[A-Za-z0-9._-]` 且非 `~` → `~XXXX`；去首部 `-`；`--` + slug.slice(0,251) + `--`）；
- 用 Node 24.14.1 的 `zstdDecompressSync` 解每个归档会话日志的第 0 帧，取首行 JSON 的 `cwd`；
- 复算 projectKey(cwd)，与磁盘上的实际父目录名逐个比对。

| 读数 | 值 |
| --- | --- |
| 参与比对的归档会话 | **35**（单日志文件且 < 4 MB） |
| 复算 projectKey == 实际目录名 | **35 / 35** |
| 不一致 | **0** |
| 跳过：多代并存目录 | 1 |
| 跳过：单文件 > 4 MB | 82 |
| Node | v24.14.1（`zstdDecompressSync` 内置可用，**零原生依赖**） |

⇒ **恢复路径的身份复算是可执行的**：只要冷目录里保留日志第 0 帧，就能算出它原来该待在哪个 projectKey 目录下 —— 这是「超过 14 天的会话可以搬回来」这条保证的技术底座。

复现：`node --test tests/marker.test.mjs`（真实目录名断言；原 `tools/pk-check.cjs` 已删除，2026-10-23）。
