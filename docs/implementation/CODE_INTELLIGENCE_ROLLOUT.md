# 代码理解与代码编写：实施分期

配套设计：[`docs/spec/CODE_INTELLIGENCE.md`](../spec/CODE_INTELLIGENCE.md)。
基线：dsh `fcc0ad4`、opencode `6b1db27`；本机 85 条能力。

## 0. 总览

| 期 | 交付 | 依赖 | 行为变化 |
| --- | --- | --- | --- |
| P7 | 寻址读 + LSP 运行时 + 符号工具 + 诊断接 LSP | 无 | 只读；无服务器时回退 |
| P8 | 快照/回退 + 写后自动诊断与测试 + 门禁升级 | P7 | 写操作后自动跑检查 |
| P9 | 影响面 + AGENTS.md 注入 + 工具输出裁剪/落盘 | P7/P8 | 上下文变准，不改用户话术 |
| P10 | 多 agent 代码任务 + 度量 | P8/P9 | 并发与预算 |

每期都要满足：`npm run typecheck`、对应测试、真机一条端到端场景。

## 1. P7 · 寻址读与符号理解（只读）

### 1.1 寻址读

改造 `src/agent/tools/filesystem.ts` 的 `readFile`：

- 加 `offset?`（1-based 行）与 `limit?`（默认并上限 2000 行）；
- 返回 `lineNumbers: true`，正文每行前缀 `<line>: `（前缀不是文件内容）；
- 单行超 2000 字符截断并标注；整页超 51200 字节时收窄窗口并在 footer 说明；
- 目录路径返回条目列表（一页 2000 条）；
- `sha256` 与 `bytes` 语义不变（哈希只算正文，不含行号前缀）。

验收：

- 3000 行文件分两页读完，行号连续；
- 读 1 行不返回整文件；
- 二进制/超限/符号链接的报错与现在一致。

### 1.2 LSP 运行时

新目录 `desktop-agent-macos/src/main/lsp/`：

| 文件 | 职责 |
| --- | --- |
| `detect.ts` | 按工作区找可用的语言服务器命令（项目内 `node_modules/.bin` 优先） |
| `client.ts` | stdio JSON-RPC：initialize、didOpen/didChange/didClose、request/notify、超时 |
| `manager.ts` | 按「root + 语言」懒启动、空闲退出、崩溃重启一次、诊断缓存与防抖 |
| `render.ts` | URI ↔ 路径、1-based 坐标转换、结果封顶与分组 |

- 启动命令白名单：`typescript-language-server`、`pyright-langserver`、`ruff`、
  `gopls`、`rust-analyzer`、`clangd`；设置里可覆盖，但必须仍是白名单内的可执行文件。
- 只读；不把工作区内容发到网络（LSP 本地进程）。
- 失败码：`LSP_UNAVAILABLE`、`LSP_TIMEOUT`、`LSP_MALFORMED_RESPONSE`。

### 1.3 新工具

在 `src/shared/contracts.ts` 增 schema、`src/agent/tools/code-intel.ts` 实现、
`src/agent/local-plugins.ts` 注册、`src/shared/capabilities.ts` 归族：

- `code.symbols { path?, max? }` → `{ file, line, name, kind }[]`
- `code.definition { path, line, character }`
- `code.references { path, line, character, includeDeclaration? }`
- `code.implementations { path, line, character }`
- `code.hover { path, line, character }`
- 全部只读；加入 `READ_ONLY_TOOLS`；空结果与「服务不可用」分开返回。

`code.diagnostics` 改造：`paths?` / `changedOnly?` / `timeoutMs?`；
优先 LSP 诊断（带文件/行/列/严重度/来源），无 LSP 时回退现有 tsc/eslint/ruff，
并在 `skipped` 里如实写「未用语言服务器」。

### 1.4 测试与验收

- `scripts/check-lsp.mjs`：临时 TS 工程（两个文件，A 调 B），
  `definition` 指到 B 的定义行，`references` 同时包含定义与调用；没有
  `typescript-language-server` 时整组 skip 并在输出写明原因。
- `scripts/check-code-read.mjs`：分页、行号、单行截断、目录列表、哈希不变。
- 真机：在 `desktop-agent-macos` 上问「`normalizeExecutionConfig` 在哪定义、
  谁调用」，得到精确文件:行，点回轨迹可定位。
- 轨迹里出现「符号」步骤，带输入位置与结果条数。

## 2. P8 · 快照、自动验证与门禁

### 2.1 快照

新目录 `src/main/snapshots/`：

- 一轮任务第一次写之前：git 仓库 `git stash create`（不改变工作区）或
  `git worktree`；非 git 目录复制变更文件 before 文本到
  `~/.thinkfusion/snapshots/<taskId>/`，附 sha256。
- `fs.revert { snapshotId }` 与界面「还原本轮」；还原也走权限与 diff。
- 快照在任务结束时清理；失败保留并在轨迹里给路径。

### 2.2 写后自动验证

在 `conversation-runner` / `orchestrator` 的工具执行结果处挂一个钩子
（只对 `fs.writeFile` / `fs.edit` / `fs.applyPatch` 成功时）：

1. 取变更文件 → `code.diagnostics({ changedOnly: true })`；
2. 有 error → 把结构化错误回给模型（文件:行:列 + 原文），本轮 `verified=false`；
3. 无 error → `code.impact` 选测试；选不到用包默认 `test.run`；
4. 记录 `{ command, exitCode, durationMs, summary, artifactPath }` 到证据账本；
5. 全通过才允许标 `verified`。

门禁：扩展 `checkPlanCapabilities`（P3 已有）为「有判据 + 真跑过」；
没有诊断/测试证据的「已验证」直接失败（测试里钉死）。

### 2.3 界面

- diff 卡（文件、+/-、可展开前后文，数据来自工具返回的 `FileDiff`）；
- 诊断卡（按文件分组，错误点回行号）；
- 测试卡（命令、退出码、失败摘要，完整输出落文件可打开）；
- 「还原本轮」按钮，二次确认。

### 2.4 测试与验收

- `scripts/check-code-verify.mjs`：fixture 里故意引入一个类型错误 → 自动诊断
  返回该行；修好后测试跑一次并记录退出码；门禁拒绝「没跑过」的 verified。
- 真机：让模型改一个已知 bug，轨迹出现 改 → 诊断 → 测试 → verified 或 failed；
  一键还原后文件回到改动前。
- 失败场景：诊断超时 / 没有测试命令 → 必须写「未验证」，不许写「通过」。

## 3. P9 · 影响面、仓库约定与上下文

- `code.impact { path? , symbol? }`：`references` + 读 import 图（grep 近似）+
  找出引用该文件的测试文件；输出标 `heuristic: true`。
- `repo.instructions`：从目标文件向上找 `AGENTS.md` / `CLAUDE.md`，返回最近一份
  与路径；作为系统事实注入（不拼用户问题）。
- 工具输出裁剪：诊断/测试/搜索超过阈值时，正文只留头部 + 总数，完整内容落
  `~/.thinkfusion/spill/<taskId>/`，返回 locator；搜索工具先接。
- 测试：fixture 里 A→B→C 的调用链，impact 能列出 B 的调用点与 A 的测试；
  AGENTS.md 注入不改变用户消息文本（断言 IPC 入参）。

## 4. P10 · 多 agent 与度量

- 代码任务复用现有 `team.*`：一个读（探索）、一个改（实施）、一个验（诊断/测试），
  由主 agent 汇总；预算沿用会话预算，不新开池。
- 度量面板：首次诊断通过率、改动接受率、红→绿、回退次数、verified 耗时。
- 测试：`check-code-team.mjs` 用假 agent 回放三条记录，断言预算与顺序。

## 5. 每期的完成定义

1. 代码：typecheck + 对应测试全绿；
2. 真机：一条可复现的端到端场景（记录命令、文件、退出码）；
3. 文档：设计/README 与实现一致；新的失败码有解释；
4. 轨迹：新步骤在时间轴上可见，带输入输出预览；
5. 提交：中文说明「原来错在哪」，不 push。

## 6. 先做哪一个

先做 P7 的 **寻址读**（半天级、纯改造、立刻减少「猜位置」），
再做 LSP 的 **definition/references** 两个操作（不做 hover/implementations 也能覆盖
八成场景）；P8 的自动诊断可以独立于测试先接，测试选择留到影响面就绪。

这样即使某台机器没有语言服务器，也能先拿到「分页读 + 行号 + 已有的 tsc 诊断」，
不会因为 LSP 不可用而整期停摆。
