# 代码理解与代码编写：对照 dsh / opencode 的落地方案

2026-11-11。为了设计「能读懂工程、也能改对代码」的能力，读了两个开源工程的
最新代码：

| 工程 | 读的版本 | 读到的位置 |
| --- | --- | --- |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh） | `fcc0ad4`（master，0.2.2-rc.1） | `packages/fs/*`、`packages/lsp/*`、`packages/core/{tools,agent-loop,system-prompt}`、`packages/compaction`、`packages/{plan,skill,guard,preset}` |
| [anomalyco/opencode](https://github.com/anomalyco/opencode)（opencode） | `6b1db27`（dev，2026-11-11） | `packages/core/src/tool/plugin/*`、`packages/core/src/{session,vcs,instructions,skill}`、`packages/app/src/settings/workspaces/project-lsp.ts` |

对照的是本机现状：`src/shared/contracts.ts` 的 85 条能力、`src/agent/tools/*`、
`src/main/engineering/*`、`docs/spec/GENERAL_ENGINEERING_CAPABILITIES.md`（§3.1
`code.read`、§3.2 `code.change`）、`docs/implementation/LOCAL_HARNESS_TOOLS.md`
（那里把 LSP 明确划到「不在这层」）。

## 0. 一句话结论

两家的写代码能力都不来自「更强的模型」，而来自四件事：**可寻址的读、原子的改、
改完能验的闭环、能退回去的快照**。

我们已经有一半：`fs.edit` / `fs.applyPatch` 都要求 `expectedHash`（改之前必须读过，
读过之后被改过就拒绝，和 dsh 的观察策略同义），`code.diagnostics` 能跑
tsc / eslint / ruff，`test.run` / `shell.run` / `git.worktree` 都在。

缺的是另一半：

1. **读没有寻址**：`fs.readFile` 返回原始文本、256KB 直接拒，没有行号、没有
   offset/limit；模型改一处只能整段拿、靠猜位置。
2. **没有符号级理解**：没有 definition / references，影响面只能靠 grep 猜；
   `project.outline` 是正则大纲，评语里已注明「按正则识别」。
3. **改完没有自动验证闭环**：诊断要模型自己记得调；计划门禁只管「有没有写判据」，
   不管「判据真跑过没有」。
4. **没有一键回退**：diff 只在工具返回值里，界面不成卡；没有本轮快照。

下面先摆两家的做法（都指到读过的文件），再给分期落地方案。

## 1. 两家怎么做的

### 1.1 dsh：策略是插件，工具是叶子

- **读**（`packages/fs/tool-fs/README.md`、`src/read.ts`）：1-based 行号前缀、
  `offset`/`limit` 分页，`readLimit` 默认并上限 2000 行、每行截 2000 字符、
  单次 51200 字节；≥10MB 的文件走流式而不是整读；目录也能读；另有 `read_image`。
- **搜**（`packages/fs/tool-fs-search`）：自带 `glob` / `grep`，**不需要宿主装 rg**；
  glob 按修改时间排序、`*` 匹配全部深度；grep 用 ripgrep 语义、按文件分组给
  `Line N: 预览`；超上限的结果可以落 spill，模型拿 locator 回查完整列表。
- **符号**（`packages/lsp/tool-lsp`，后端 `packages/lsp-stdio`）：一个只读 `lsp`
  工具，四种操作 `goToDefinition` / `findReferences` / `goToImplementation` /
  `hover`；坐标是 1-based UTF-16；结果按文件分组、先按条数再按字符数封顶；
  `findReferences` 必含声明，避免漏掉定义处。系统提示写得很克制：
  「普通导航用 search/read，文本匹配有歧义或改动需要精确符号关系时才用 lsp」。
- **改**：`write`（原子替换）、`edit`（**唯一字面量**才替换，`replace_all` 显式
  允许多处）、`apply_patch`（add/update/delete/move，先 preflight 全部校验再提交；
  即使部分失败也保留已知效果与 diff）。字段名用 snake_case，对齐 Claude Code 的
  训练分布。
- **改的安全**（`packages/fs/fs-observation-policy`）：**改之前必须读过**；没读过
  报 `FS_NOT_OBSERVED`、读过之后文件变了报 `FS_STALE_VERSION`，两者都被工具包装成
  「先读再试」；观察状态不跨会话持久化。沙箱里要提权必须给理由，拒绝时回
  `[sandbox: file access denied under <mode> mode]`。
- **工具面**（`packages/core/tools`）：`defineTool` 声明参数 schema、输出、超时、
  是否可并行、UI 展示；allow/deny/ask 策略；**普通工具失败返回错误结果，不终止回合**。
- **上下文**（`packages/compaction`）：自动压缩 + `/compact` 手动 + 工具输出裁剪 +
  超预算图片卸载；长结果落 spill。
- **引导**：`guard/repeat-tool-reminder`（同一工具同一参数重复 3/5/8 次就提醒换路）、
  `plan/plan-mode`（先探索设计再动手，计划要人批准）、`skill/*`（按需加载技能）。
- **组合**（`packages/preset`）：standard / minimal（只留 bash + editor）/ ptc / cordis，
  用配置行决定给模型哪些工具，不是改代码。

### 1.2 opencode：Effect 模块 + 权限 + 快照

- **读**（`packages/core/src/tool/plugin/read.ts`）：1-based 行号前缀、`offset`/`limit`、
  目录列表、图片与 PDF；**读完一个文件后向上遍历到 Location 根，发现 AGENTS.md 并作为
  durable instruction 注入**（外部目录跳过，发现失败不影响读）。
- **改**（`edit.ts`）：`oldString`/`newString` 精确替换，默认要求**唯一匹配**，
  否则报错让模型给更长上下文；对 CRLF、弯引号、破折号、全角空格先归一化再匹配；
  每次修改走 `Permission.assert`；产出 `FileDiff`（unified patch + 增删行数）。
- **补丁**（`patch.ts` + 自带 `patch-grammar.txt`）：自定义 add/update/delete 文法的
  多文件补丁，先 preflight、再按序提交，处理 BOM，成功后返回 `applied` 列表 + diffs。
- **写**（`write.ts`）：整文件写，权限动作 `edit`；文件里留着两条 TODO——
  「snapshots / undo 还没做」「**LSP notification and diagnostics 还没接**」。
- **回退**（`session/revert.ts` + `snapshot.ts`）：会话级快照，按 message 边界
  `stage` 一次还原，返回这次还原涉及的文件 diff；`vcs/patch.ts` 负责 diff 文本与
  增删行统计。
- **上下文**：`session/compaction.ts`（自动压缩、保留最近若干 token、可后台预计算）、
  `instructions/builtins.ts`（日期、cwd、workspace root、是否 git 仓库）。
- **符号/诊断**：有 LSP 的配置与事件 schema（`packages/schema/src/config/lsp.ts`、
  `lsp-event.ts`、`packages/app/src/settings/workspaces/project-lsp.ts`），但**工具
  循环里还没接**——这正好说明「配了 LSP」不等于「模型用得上」。
- **约束**：`Location`（工作区边界）+ `FileAccess`（授权读）+ `Permission`（ask/save）
  三层；外部目录单独审批。

### 1.3 对照

| 维度 | dsh | opencode | 我们现状 |
| --- | --- | --- | --- |
| 架构 | 一切皆插件（Cordis） | TS / Effect 模块 | 主进程 + Runtime，85 条能力清单，不装插件 |
| 读 | 行号 + 分页 + 上限 + 流式 | 行号 + 分页 + AGENTS.md 注入 | `fs.readFile` 原始文本、256KB 上限，无行号/分页 |
| 搜 | 内置 glob/grep + spill | ripgrep | `fs.search` / `fs.find` / `fs.tree`，够用 |
| 符号 | LSP 四操作 | 配置有、工具未接 | 无；`project.outline` 是正则大纲 |
| 改 | write / edit / apply_patch + 观察策略 | write / edit / patch + 权限 + diff | writeFile / overwriteFile / edit / applyPatch，都带 `expectedHash` |
| 验证 | 工具返回 diff/效果；测试靠外部 | diff + 权限；测试靠模型 | `code.diagnostics` 一次性 tsc/eslint/ruff，无自动闭环 |
| 回退 | 无会话级 undo（观察不持久） | 会话快照 + revert | `git.worktree` 有，但没有「本轮一键回退」 |
| 上下文 | 压缩 + 裁剪 + spill | 压缩 + AGENTS.md + skills | 有 followUpRounds；无工具输出裁剪/落盘 |
| 引导 | 计划模式 / 技能 / 重复提醒 | AGENTS.md / skills / 子代理 | 工程证据 / 计划门禁 / 单份技能 |

### 1.4 与另一份《Code Intelligence & Coding Engine》提案的取舍

2026-11-11 还有一份基于同一轮代码阅读的方案（ChatGPT 会话
「制定辩论主题方案 (4)」，导出文件 16809 字）。它把目标拆成
**CodeIntelligence**（理解）与 **CodingEngine**（编写）两个模块，提出
AST + LSP + CodeGraph + ContextBuilder + ImpactAnalyzer、CodingEngine
状态机与预算、以及 Explore / Code / Test / Review 多 Agent 分工。

方向与本文一致，但有四处要改：

| 它的主张 | 取舍 | 理由 |
| --- | --- | --- |
| CodeIntelligence / CodingEngine 分离；不替换 MasterAgent / Debate / Judge | **采用** | 和现有五段、辩论、裁判的边界一致；命名比「Observation/Mutation」更像产品模块 |
| CodingEngine 状态机（ANALYZING → … → COMPLETED/FAILED/BLOCKED）与预算（轮数/工具调用/时长/改动文件/并发） | **采用** | 我们现在只有 `MAX_TOOL_ROUNDS = 1` 的只读补充轮，确实没有编码循环；状态与预算要显式写进编排器 |
| 先建 AST（TS Compiler API / JavaParser / Go AST / Python AST / Tree-sitter）+ CodeGraph + SQLite 索引 | **后置、按需** | 多套解析器 + JVM 依赖 + 全量调用图是第一版最贵的部分；LSP 已能给定义/引用，先用 LSP + 轻量关系缓存，AST 只在没有 LSP 的语言补 |
| OpenCode 已支持 `prepareCallHierarchy` / `incomingCalls` / `outgoingCalls`，调用层级可直接借鉴 | **修正** | 读到的 opencode `6b1db27` 里 LSP 只有配置与事件 schema，工具循环**没有接**（`write.ts` 明确留着「LSP diagnostics 未接」的 TODO）；dsh 的 `lsp` 只有 definition/references/implementations/hover 四个操作。调用层级在两家现成代码里都不是成品，要自己建 |
| 多 Agent：Explore / Architecture / Code / Test / Review，worktree 隔离 | **采用，放到最后** | 现有 `team.*`、`git.worktree` 可复用；并发改同一文件的风险要先用 worktree 隔离 |
| Phase 0：先审计「契约里有 ≠ 实现跑通」 | **采用** | 真机确认：`research/project-tools.ts` 的 `MAX_TOOL_ROUNDS = 1`；`code.run`、`team.spawn`、`git.worktree` 有实现，但没有被串成编码循环 |

一句话：**它的架构分层与阶段目标作为总纲，本文的工具契约、顺序与测试门禁作为落地细则。**

## 2. 落地方案

### 2.1 总原则

- **本地优先**：LSP 用机器上已有的语言服务器；没有就明说没有，不伪造符号结果。
- **结论可回指**：诊断给文件:行:列，测试给命令与退出码，改动给 diff，回退给快照 id。
- **不新建对话形态**：仍是判定 → 提问 → 汇总 → 执行 → 评审；代码是其中一族能力。
- **不拼用户提示**：AGENTS.md、技能、诊断都作为**工具结果/系统事实**进入，不写进
  用户原话（AGENTS.md 规则 1）。
- **不自动 push、不自动改测试断言**。

### 2.2 CodeIntelligence 与 CodingEngine

对外用两个模块名，内部仍是四层：

- **CodeIntelligence**：索引、符号、引用、诊断、影响面、上下文包。只读。
- **CodingEngine**：状态机 + 预算 + 改/验/修的循环。写操作仍走现有
  `AgentOrchestrator` 与计划门禁，不另起一个执行器。

CodingEngine 的状态（写进 `shared/conversation.ts` 的进度枚举与轨迹）：

```
ANALYZING → PLANNING → WAITING_APPROVAL → EDITING → VERIFYING
             ↑                              │          │
             └────────── FIXING ←───────────┴── failed ┘
VERIFYING → REVIEWING → COMPLETED
任意状态 → FAILED / BLOCKED / CANCELLED
```

预算（默认值，按任务规模可调）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxIterations` | 8 | 改 → 验 → 修 的轮数上限 |
| `maxToolCalls` | 80 | 单任务工具调用上限 |
| `maxDurationMs` | 15 分钟 | 连续无进展 5 分钟先触发一次提醒 |
| `maxChangedFiles` | 20 | 超过就要求拆任务 |
| `maxParallelAgents` | 3 | 只对只读探索/测试并行开放；写同一文件必须串行或 worktree 隔离 |

### 2.3 四层

```
Observation（读）   fs.readFile 分页/行号 · fs.search · code.symbols/definition/references
        │
Mutation（改）      fs.edit · fs.applyPatch · fs.writeFile（expectedHash 强制）
        │
Verification（验）  code.diagnostics(changedOnly) → 选定 test.run → 证据账本
        │
Context（记）       AGENTS.md · skill · 工具输出裁剪/spill · 快照与回退
```

### 2.4 工具面（模型可见的改动）

| 工具 | 类型 | 输入 | 输出 | 说明 |
| --- | --- | --- | --- | --- |
| `fs.readFile` | 改造 | 加 `offset?` / `limit?` | 行号前缀 + `sha256` + 是否分页 | 上限从「256KB 直接拒」改为分页；目录也能读 |
| `code.symbols` | 新·只读 | `path` 或全库 | 符号名、kind、文件:行 | LSP `documentSymbol`；无 LSP 回退正则并标注 |
| `code.definition` / `code.references` / `code.implementations` / `code.hover` | 新·只读 | `path, line, character`（1-based） | 按文件分组的 `path:line:char` | 无服务器返回 `LSP_UNAVAILABLE`，不猜 |
| `code.diagnostics` | 改造 | 加 `paths?` / `changedOnly?` / `timeoutMs?` | 归一化 issues + `source` | LSP 优先（快、带位置），回退现有 tsc/eslint/ruff |
| `code.impact` | 新·只读 | 符号或文件 | references + 可能受影响的测试 | 明确标「启发式」 |
| `fs.revert` | 新·写 | 快照 id | 还原结果 + diff | 或复用 `git.worktree` / `git.stash` |
| `repo.instructions` | 新·只读 | — | AGENTS.md 原文 + 路径 | 作为工具结果注入，不拼用户话术 |

### 2.5 LSP 运行时（主进程新模块）

- 位置：`desktop-agent-macos/src/main/lsp/`。
- 生命周期：按「工作区根 + 语言」懒启动；空闲 5 分钟退出；崩溃重启一次；
  `didOpen/didChange/didClose`；诊断防抖 300ms。
- 探测顺序：项目内 `node_modules/.bin/typescript-language-server` →
  `pyright-langserver` / `ruff` → `gopls` → `rust-analyzer` → `clangd`；
  设置里可显式指定命令。
- 失败语义：没有服务器 → `LSP_UNAVAILABLE`；没有该扩展名 → 同样明说；
  payload 损坏 → `LSP_MALFORMED_RESPONSE`。**不拿正则结果冒充 AST**。
- 安全：只读、只在授权根内启动、命令白名单、超时、不联网。

### 2.6 改完自动验证（核心闭环）

写工具成功一次就触发一次：

1. 取本次变更文件列表；
2. `code.diagnostics({ changedOnly: true })`（LSP 优先）；
3. **有错误**：把结构化错误（文件:行:列 + 原文）回灌给模型；这一轮不得标「已验证」；
4. **无错误**：`code.impact` 选出受影响的测试；选不到就退到包默认 `test.run`；
   记录命令、退出码、失败摘要；
5. 全通过 → 证据账本记 `verified`；任一失败 → 记 `failed`，原文交 `review`。

配套的门禁升级：

- `checkPlanCapabilities` 已有「改代码要有检查」；新增「检查必须**真跑过**」——
  只有 `code.diagnostics` / `test.run` 的成功证据才算，写了判据没跑不算。
- 本次改动碰到测试文件时，结论必须标「测试也被改过」，不许把「改了断言才过」
  写成「通过」。

### 2.7 快照与回退

- 一轮任务第一次写之前打快照：git 仓库用 `git stash create` 或临时 worktree；
  非 git 目录把变更文件的 before 文本 + hash 落到
  `~/.thinkfusion/snapshots/<taskId>/`。
- 提供界面「还原本轮」与 `fs.revert` 工具；快照留到任务结束。
- 不自动提交、不 push（沿用现有 git 纪律）。

### 2.8 上下文与引导

- `AGENTS.md`（以及 CLAUDE.md 兼容）作为**工具结果/系统事实**注入；
  向上发现，只读。
- 工具输出裁剪：诊断/测试输出超过阈值时，正文只放头部 + 摘要，完整输出落文件，
  给模型一个可回查的 locator（对齐 dsh 的 spill）。
- 技能仍维持单份；LSP / 诊断 / 回退的用法写进技能与工程提示。

### 2.9 界面

- 对话卡：**diff 卡**（文件、+/-、可展开前后文）、**诊断卡**（错误列表，点回行号）、
  **测试卡**（命令、退出码、失败摘要）、**还原本轮**按钮。
- 轨迹：读 / 搜 / 符号 / 改 / 诊断 / 测试各成一步，带耗时、输入输出预览与证据；
  延续现有轨迹泳道（成员 + 阶段）。
- 过程可见性：每一步都有输出，不出现只转圈。

## 3. 分期（P7–P10）

| 期 | 内容 | 风险 |
| --- | --- | --- |
| P0 | 基线审计：契约 vs 实现（`MAX_TOOL_ROUNDS = 1`、`code.run`、`team.*`、`git.worktree`、`code.diagnostics`），逐项给出「已实现/仅契约」 | 只读 |
| P7 | 寻址读（行号/分页/目录）+ LSP 运行时 + `code.symbols`/`definition`/`references`/`hover` + `code.diagnostics` 接 LSP | 只读，不改行为；无 LSP 时回退 |
| P8 | 快照与回退 + 写后自动诊断/测试闭环 + 门禁升级为「真跑过」 | 中：测试选择是启发式，必须先明说 |
| P9 | `code.impact` + AGENTS.md 注入 + 工具输出裁剪/落盘 | 低 |
| P10 | 多 agent 代码任务（团队/子代理）与度量面板 | 中：并发与预算 |

每期的交付物、测试与验收写在
[`docs/implementation/CODE_INTELLIGENCE_ROLLOUT.md`](../implementation/CODE_INTELLIGENCE_ROLLOUT.md)。

## 4. 风险与不做的事

- **语言覆盖**：LSP 服务器不是每台机器每种语言都有；没有就回退，并如实说「未用
  语言服务器」。
- **诊断滞后**：LSP 诊断是异步的；只在写后主动拉取，加超时，并区分「没有诊断」
  和「检查器没跑」。
- **测试选择**：`code.impact` 是启发式；选不到或不确定时跑包默认测试，结论里写明
  按什么选的。
- **不做**：第三方插件市场、运行时下载 LSP、自动 push、自动改测试断言、把 LSP
  不可用说成「没有问题」。

## 5. 度量

- 首次诊断通过率（改一次就过）
- 改动被接受率（未回退、未被复审打回）
- 测试红 → 绿转化率
- 回退次数与原因
- 平均每个任务读/搜/符号调用数
- 从「开始改」到「verified」的耗时
