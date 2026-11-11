# 代码智能 P0 · 能力审计（2026-11-11，0.1.9）

审计对象：本机 main `3eb2faa` 的代码理解/编写相关能力。
方法：逐个读实现文件与入口，不把「契约里有」当成「跑通过」。
结论先行：**P0 没有发现「只登记、没实现」的工具；真正的缺口是三条读路径不一致、
运行时读不能寻址、以及没有 LSP / 验证闭环 / 回退。** 运行时的寻址读已在
0.1.9 补上，其余按 P1/P2 推进。

## 1. 读

| 能力 | 实现 | 事实 | 结论 |
| --- | --- | --- | --- |
| 运行时 `fs.readFile` | `src/agent/tools/filesystem.ts` | 0.1.9 前：原始文本、256KB 直接拒、无行号；0.1.9：`offset`/`limit`、默认 2000 行、8MB 载入上限、返回 `totalLines/startLine/endLine/truncated/content/numbered`、`sha256` 按整份文件 | **已补**；`content` 默认只给前 2000 行，超过要分页 |
| 工程分析补读 | `src/main/research/project-tools.ts` | `fs.stat` / `fs.readFile` 已有行号与 offset/limit（1-based、总行数、4000 字摘要、64MB 上限），范围是工程根 + 本问附件；`MAX_TOOL_ROUNDS = 1` | 语义正确，但**只用于分析阶段、只多问一轮**；与运行时是两套实现 |
| 计划树/搜索 | `src/agent/tools/project-read.ts` | `fs.tree` / `fs.search` / `fs.find`，跳过依赖/凭证，有上限 | 可复用；不做行号读 |
| `fs.stat` | `src/agent/tools/fs-extra.ts` | 0.1.9 前只有 bytes/哈希；0.1.9 起对小文本文件给 `lines`（与 `readFile.totalLines` 同口径） | 已补；>256KB 不给行数（避免整份载入） |

**审计发现**：同一件事（带行号、可寻址地读）有两套实现，语义接近但不完全一致；
P1 应把运行时读当作唯一入口，工程分析补读逐步收敛到它（或至少共享行数/分页语义）。

## 2. 改

| 能力 | 实现 | 事实 |
| --- | --- | --- |
| `fs.writeFile` | `src/agent/tools/filesystem.ts` | `O_EXCL` 只建新文件；1MB 内容上限 |
| 覆盖写 | 同上 `overwriteFile` | 必须回填 `expectedHash`；同目录临时文件 + rename，原子替换 |
| `fs.edit` | `src/agent/tools/fs-extra.ts` | 唯一字面量才替换；`replaceAll` 显式；`expectedHash` 防止读后被改；写临时文件 + rename |
| `fs.applyPatch` | `src/agent/tools/extended.ts` | unified diff 多 hunk；`expectedHash`；逐个构造参数、不拼 shell |
| 回读验证 | `src/agent/verify.ts` | 写后按哈希/内容回读 |

结论：**改的能力已具备**，与 dsh 的 read-before-edit 同义；缺的是「改完自动触发诊断/测试」
和「本轮一键回退」。

## 3. 验证

| 能力 | 实现 | 事实 |
| --- | --- | --- |
| `code.diagnostics` | `src/agent/tools/diagnostics.ts` | 一次性跑 tsc `--pretty false`、eslint `-f json`、ruff；归一化到 文件:行:列；没有语言服务器 |
| `test.run` | `src/agent/tools/test-run.ts` | 白名单测试命令；退出码与输出 |
| `code.run` | `src/agent/tools/code-run.ts` | node / python3 / bash，真落盘真跑 |
| 证据账本 / 计划门禁 | `engineering` + `shared` | 有证据记账、P3 门禁（缺判据不许标「已验证」）；**没有「判据必须真跑过」** |
| 独立评审 | `src/main/engineering/review.ts` | 规则版 / 模型评审已有 |

结论：验证工具都在，**没有自动串成闭环**；门禁只查「写了判据」，不查「跑没跑」。

## 4. 协作与回退

| 能力 | 实现 | 事实 |
| --- | --- | --- |
| `team.spawn` / `team.task.*` | `src/main/index.ts`（4442 起）、任务板 | 已实现，成员复用现有参与者 |
| `git.worktree` | `src/agent/tools/extended.ts` | 已实现，参数逐个构造 |
| 本轮快照 / 一键回退 | — | **没有**；只有 git 命令可用，界面无回退 |

## 5. 工程理解（现有）

| 能力 | 实现 | 事实 |
| --- | --- | --- |
| 工程扫描 / 证据 | `src/main/engineering/project.ts` | 真读授权目录，带路径/行号/指纹 |
| 符号 / 调用点 / 依赖 | `src/main/engineering/analysis.ts` | **明确不引 AST**，正则识别，结论自述「按正则识别」 |
| 源码骨架 | `src/agent/tools/extended.ts` `projectOutline` | 正则大纲；最多 120 文件 / 200 符号 |
| 编码循环 | — | `MAX_TOOL_ROUNDS = 1` 的只读补读，不是「改→验→修」循环 |

结论：与设计判断一致——**正则可以起步，但不能冒充语义**；LSP 是 P1 的缺口。

## 6. 契约 vs 实现

- `TOOL_NAMES` 79 条运行时工具全部能落到注册点（`local(...)` 或主进程能力），
  没有「只登记、没实现」的孤儿。
- 真正的「契约有、能力弱」是语义层：`project.outline` 正则、`code.diagnostics`
  一次性、没有 LSP 符号/引用、没有快照。
- `research/project-tools.ts` 的 `MAX_TOOL_ROUNDS = 1` 是**设计边界**，不是 bug；
  编码循环需要新工作流，不是把 1 改大。

## 6.1 0.1.9 补齐的 P1 核心（本次）

| 能力 | 实现 | 验证 |
| --- | --- | --- |
| 语义导航 | `src/main/lsp/tsserver.ts`：TypeScript 的 tsserver（不引新依赖），definition / references / hover / navtree / 语义诊断；1-based 坐标、结果封顶、mtime 变化自动重开 | 真机在本仓库：`normalizeExecutionConfig` 定义跳到 `src/shared/conversation.ts:689`，22 处引用，hover 有签名，199 个符号，0 诊断 |
| 工具接线 | `code.definition/references/symbols/hover/context` 经 `callMain` 桥接；`root` 由授权根注入，模型传 root 会被覆盖（有测试钉住） | `test:lsp` 8 条 |
| ContextBuilder | `src/main/lsp/context.ts`：符号 + 定义 + 引用 + hover + 候选测试，每条标 `source: tsserver`，带 sha256/totalLines | `test:lsp` 覆盖 |
| 诊断 | `code.diagnostics` 先走 tsserver，拿不到再回退 tsc/eslint/ruff | `test:lsp` 覆盖 |
| 写后自动诊断 | `fs.writeFile` / `fs.edit` / `fs.applyPatch` 成功后自动取 tsserver 诊断，挂在结果 `diagnostics`；不可用就跳过，不假装 | `test:lsp` 覆盖 |
| 快照 / 还原 | `src/main/snapshots/store.ts` + `fs.revert`：第一次改之前留底，新建的还原时删除，路径钉在根内 | `test:snapshot` 5 条 |

## 7. P0 结论

1. 复用：`fs.edit` / `fs.applyPatch` / `fs.stat` / `fs.search` / `fs.tree` /
   `code.diagnostics` / `test.run` / `code.run` / `team.*` / `git.worktree` /
   `reviewExecution` / 证据账本 / 计划门禁。
2. 已补（0.1.9）：运行时 `fs.readFile` 寻址读 + 行号 + 总行数 + 8MB 载入上限；
   `fs.stat` 给文本文件行数。
3. 0.1.9 已补：LSP Provider + definition/references/hover/symbols、ContextBuilder、
   写后自动诊断、快照/还原（后端）。
   仍缺（P1）：编码工作流状态机与预算（挂在 AgentOrchestrator 上）、
   按影响面选测试、门禁「测试真跑过」、diff/诊断/测试/还原的界面卡片。
4. 仍缺（P2）：基础 CodeGraph、调用层级与影响分析、按需 AST、多 Agent。

测试：`npm run test:code-read`（9 条，分页/行号/哈希一致/空文件/目录/超限）；
`test:security`、`test:engineering-tools`、`test:capabilities`、`test:extended-tools`、
`test:protocol` 全部通过。
