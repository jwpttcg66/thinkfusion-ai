# 代码理解与代码编写：实施任务书 V1.1

配套设计：[`docs/spec/CODE_INTELLIGENCE.md`](../spec/CODE_INTELLIGENCE.md)。
基线：dsh `fcc0ad4`、opencode `6b1db27`、本机 main `3eb2faa`。

V1.1 相对上一版的三条修正（已确立为架构约束）：

1. 第一阶段不引入多语言全量 AST / 全量 CodeGraph；
2. 不把 dsh / opencode 尚未实现的能力写成可直接复用的现成功能；
3. 不另建独立 Coding Runtime、审批、执行日志和权限系统。

另加一条顺序约束：**先跑通单 Agent 的完整工程闭环，再做多 Agent 并行。**

## 0. 总览

| 阶段 | 任务 | 复用点 | 新增 | 行为变化 |
| --- | --- | --- | --- | --- |
| P0 | 能力审计：契约 vs 实现 | — | — | 无 |
| P1 | 寻址读 | `fs.readFile` 改造 | 行号/分页/目录 | 读的行为变准 |
| P1 | LSP Provider + Definition / References / Diagnostics | `code.diagnostics` 保留回退 | `main/lsp/*`、`code.definition` 等 | 只读新增 |
| P1 | ContextBuilder | 现有工程证据、`project.outline` | 上下文包（带来源与指纹） | 只读 |
| P1 | 编码工作流 | `AgentOrchestrator`、`TaskGrant`、Journal、计划门禁、`reviewExecution` | 状态机 + 预算 | 写后自动验 |
| P1 | 改→编译→测试→修复闭环 | `fs.edit` / `fs.applyPatch` / `test.run` / `code.run` | 自动触发与门禁 | 写操作后自动跑检查 |
| P2 | 基础 CodeGraph | LSP 结果 | 关系缓存 + 置信等级 | 只读 |
| P2 | Call Hierarchy / 影响分析 | `code.impact` 雏形 | 调用层级（EXACT/POSSIBLE） | 只读 |
| P2 | 按需 AST | — | 按语言、有理由才加 | 只读 |
| P2 | 多 Agent 编码 | `team.*`、`git.worktree` | Explore/Code/Test/Review 分工 | 最后 |
| P3 | 持久化索引 / 向量库 | — | 视实际瓶颈 | 视需求 |

## 1. P0 · 能力审计（只读，必须）

| 项 | 已确认事实 | 结论 |
| --- | --- | --- |
| `fs.readFile` | 原始文本、256KB 上限、无行号/分页（`src/agent/tools/filesystem.ts`） | 要改 |
| `fs.edit` | 唯一字面量 + `expectedHash`（`src/agent/tools/fs-extra.ts`） | 复用 |
| `fs.applyPatch` | unified diff + `expectedHash`（`src/agent/tools/extended.ts`） | 复用 |
| `code.diagnostics` | tsc / eslint / ruff 一次性检查（`src/agent/tools/diagnostics.ts`） | 复用并接 LSP |
| `code.run` | node / python3 / bash（`src/agent/local-plugins.ts`） | 复用 |
| `team.spawn` / `team.task.*` | 已实现（`src/main/index.ts`、任务板） | P2 复用 |
| `git.worktree` | 已实现，参数逐个构造（`src/agent/tools/extended.ts`） | P2 复用 |
| `research/project-tools.ts` | `MAX_TOOL_ROUNDS = 1`，只读补充轮 | 编码循环要新建 |
| `engineering/analysis.ts` | 明确不引 AST，正则识别 | 保留为回退，不冒充语义 |
| `reviewExecution` / 证据账本 / 计划门禁 | 已实现 | 复用，P1 只加「真跑过」判据 |

验收：每项给出「实现文件 + 入口 + 权限档」；找不到的标「仅契约」，不进入 P1 设计。

## 2. P1 · 单 Agent 闭环（必须）

### 2.1 寻址读

改 `src/agent/tools/filesystem.ts` 的 `readFile`：

- 加 `offset?`（1-based 行）、`limit?`（默认/上限 2000 行）；
- 正文每行前缀 `<line>: `（前缀不是内容）；单行超 2000 字符截断并标注；
- 单次超 51200 字节时收窄窗口并在 footer 说明；
- 目录返回条目列表（一页 2000 条）；
- `sha256` / `bytes` 语义不变（哈希只算正文）。

测试：`scripts/check-code-read.mjs`——3000 行文件分两页、行号连续、单行截断、
目录列表、哈希与旧行为一致；二进制/超限/符号链接报错不变。

### 2.2 LSP Provider

新目录 `desktop-agent-macos/src/main/lsp/`：

| 文件 | 职责 |
| --- | --- |
| `detect.ts` | 按工作区找语言服务器（项目内 `node_modules/.bin` 优先） |
| `client.ts` | stdio JSON-RPC：initialize、didOpen/didChange/didClose、超时 |
| `manager.ts` | root+语言懒启动、空闲 5 分钟退出、崩溃重启一次、诊断防抖 300ms |
| `render.ts` | URI ↔ 路径、1-based 坐标、结果封顶与分组 |

- 白名单：`typescript-language-server`、`pyright-langserver`、`ruff`、`gopls`、
  `rust-analyzer`、`clangd`；设置可覆盖但仍在白名单内。
- 失败码：`LSP_UNAVAILABLE` / `LSP_TIMEOUT` / `LSP_MALFORMED_RESPONSE`。
- **不联网、不伪造、不拿正则结果冒充语义结果。**

### 2.3 工具

新增（只读，加入 `READ_ONLY_TOOLS`）：

- `code.definition { path, line, character }`
- `code.references { path, line, character, includeDeclaration? }`
- `code.symbols { path?, max? }`（documentSymbol，先做单文件）
- `code.hover { path, line, character }`

改造 `code.diagnostics`：`paths?` / `changedOnly?` / `timeoutMs?`；LSP 优先，
回退 tsc/eslint/ruff，并写明「未用语言服务器」。

测试：`scripts/check-lsp.mjs`（临时 TS 工程 A→B，definition 指到 B 定义行，
references 同时含定义与调用；没有 `typescript-language-server` 时 skip 并写明原因）。

### 2.4 ContextBuilder

输入任务 + 目标文件/符号，输出一个**有证据的上下文包**：

```
线索 → 相关文件 → 符号 → 定义/引用 → 配置来源 → 相关测试
```

每条包含：路径、行号、片段、关系、来源（`source`/`ast`/`lsp`/`grep`）、
置信度、文件指纹（sha256）与索引时间。模型只能看到这个包，不整库塞入。

### 2.5 编码工作流（挂在现有执行器上）

`CodingEngine` 只是控制层：

```
ANALYZING → PLANNING → WAITING_APPROVAL → EDITING → VERIFYING
             ↑                             │          │
             └────────── FIXING ←──────────┴── failed ┘
VERIFYING → REVIEWING → COMPLETED
任意状态 → FAILED / BLOCKED / CANCELLED
```

- 工具执行仍走 `AgentOrchestrator`；权限 `TaskGrant`；日志 Journal；证据账本；
  评审 `reviewExecution`。**不新增第二套。**
- 预算：`maxIterations` 8、`maxToolCalls` 80、`maxDurationMs` 15 分钟
  （连续无进展 5 分钟提醒）、`maxChangedFiles` 20、`maxParallelAgents` 3；
  超预算由现有治理体系阻止 / 重新审批 / 取消。

### 2.6 改 → 编译 → 测试 → 修复

写工具成功后自动：

1. 取变更文件 → `code.diagnostics({ changedOnly: true })`；
2. 有 error → 结构化回灌（文件:行:列 + 原文），本轮不得 `verified`；
3. 无 error → 选测试（P1 先用包默认 `test.run`；P2 再接影响面）；
4. 记录 `{ command, exitCode, durationMs, summary, artifactPath }` 到证据账本；
5. 全通过才 `verified`；失败进入 `FIXING`，受预算约束。

门禁：`checkPlanCapabilities` 升级为「有判据 + 真跑过」；没有诊断/测试证据的
「已验证」直接失败。测试文件被本次改动触碰时，结论必须标「测试也被改过」。

### 2.7 快照与回退

- 本轮第一次写之前：git 仓库 `git stash create` / 临时 worktree；非 git 目录
  把变更文件 before 文本 + sha256 落到 `~/.thinkfusion/snapshots/<taskId>/`。
- `fs.revert { snapshotId }` + 界面「还原本轮」（二次确认）。
- 不自动提交、不 push。

### 2.8 界面

- diff 卡、诊断卡（点回行号）、测试卡（命令/退出码/失败摘要）、还原本轮。
- 轨迹：读 / 符号 / 改 / 诊断 / 测试各成一步，带耗时与证据。

### 2.9 P1 验收

- 3000 行文件分页读、行号正确；
- 「`normalizeExecutionConfig` 在哪定义、谁调用」得到精确文件:行；
- 改一个已知 bug：轨迹出现 改 → 诊断 → 测试 → verified（或 failed + 修复），
  一键还原后文件回到改动前；
- 无 LSP 的机器：`code.definition` 返回 `LSP_UNAVAILABLE`，`code.diagnostics`
  仍能用 tsc/eslint，结论写明「未用语言服务器」；
- `test:code-read`、`test:lsp`、`test:code-verify` 全绿。

## 3. P2 · CodeGraph、影响面与多 Agent（后续）

1. **基础 CodeGraph**：Definition / References / Implementation 的关系缓存，
   全部 `EXACT`。
2. **Call Hierarchy**：有 LSP 调用层级的语言直接用；没有的用「References 候选 +
   AST 调用表达式 + 类型消歧」，确认不了标 `POSSIBLE_CALL`。每条关系带
   `EXACT | HIGH | POSSIBLE | UNKNOWN`。
3. **ImpactAnalyzer**：改动点 → 直接调用者 → 递归上游 → 接口实现 → 关联测试；
   报告里每条标来源与置信度。
4. **按需 AST**：只对「没有 LSP 且确有需求」的语言引入；不为统一强上多套解析器，
   不为了 AST 引 JVM / 原生依赖（Java 优先 jdtls LSP）。
5. **多 Agent**：单 Agent 闭环稳定后再做；Explore（只读）/ Code（工作区写）/
   Test（测试）/ Review（只读）；写同一文件必须串行或 worktree 隔离，最后统一
   收 diff、检冲突、合并前测试。

## 4. P3 · 持久化与长期知识（视需求）

只有在出现「重复查询耗时 / 工程过大 / 跨会话分析要持久化」的实际问题后才做：
SQLite 关系索引、增量更新、可选的向量检索。第一版不做。

## 5. 禁止事项（写死）

1. 禁止第一阶段引入多语言全量 AST 与全量 CodeGraph。
2. 禁止把 dsh / opencode 尚未实现的能力写成「可直接复用」；引用时标注是设计借鉴
   还是已有实现。
3. 禁止另建 Coding Runtime、审批、执行日志、权限或第二套证据账本。
4. 禁止把「编译成功」写成「测试通过」；禁止在测试失败后放宽断言。
5. 禁止自动 push、自动提交。

## 6. 每期的完成定义

1. 代码：typecheck + 对应测试全绿；
2. 真机：一条可复现的端到端场景（命令、文件、退出码）；
3. 文档：设计/README 与实现一致；新失败码有解释；
4. 轨迹：新步骤可见，带输入输出预览；
5. 提交：中文说明「原来错在哪」，不 push。

## 7. 从哪开始

P0 审计 → P1 的「寻址读 + LSP definition/references」是最小可交付；随后接
`code.diagnostics(changedOnly)` 的写后自动验证。AST、CodeGraph、多 Agent 都在
单 Agent 闭环跑通之后再谈。
