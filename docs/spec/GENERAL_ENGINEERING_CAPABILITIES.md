# 通用工程能力：整体设计

> 2026-11-10。设计对象是工程空间的**通用工程能力层**：它要覆盖 DeepSeek Harness
> （`~/data/dsh-src`，提交 `ce7073d5`，包版本 0.2.2-alpha.2，`docs/tool-catalog.zh.md`）
> 的**全部 76 条工具 schema（71 个唯一名字）**，以及本仓库已有的 64 个能力插件。
>
> 相关文档：[ARCHITECTURE](../ARCHITECTURE.md)（五层）、
> [CAPABILITY_PLUGINS](../implementation/CAPABILITY_PLUGINS.md)（能力插件与清单）、
> [LOCAL_HARNESS_TOOLS](../implementation/LOCAL_HARNESS_TOOLS.md)（上一轮只对齐了「本机干活」那一半）、
> [ENGINEERING_ROUTING](../implementation/ENGINEERING_ROUTING.md)、
> [ENGINEERING_READ_TOOLS](../implementation/ENGINEERING_READ_TOOLS.md)、
> [ENGINEERING_EXPERTISE](../implementation/ENGINEERING_EXPERTISE.md)。
>
> 逐期改动见 [GENERAL_ENGINEERING_ROLLOUT](../implementation/GENERAL_ENGINEERING_ROLLOUT.md)。
>
> **当前状态（2026-11-10）**：P0 已落地——76 条清单冻结在 `src/shared/dsh-tools.ts`，
> 64 个本机能力归族在 `src/shared/engineering-capabilities.ts`，`test:dsh-coverage` 与
> `test:engineering-capabilities` 全绿；P1（证据账本）、P3（计划门禁）、
> P5 的 `ask.user` 与 `code.diagnostics` 已落地，其余见实施文档。

## 0. 一句话结论

> 通用能力不是再新增一路「能力路由模型」，而是把 dsh 的 76 条 + 我们的 64 条**逐条登记**，
> 按 **8 个工作族 + 5 个治理族** 归族；每条都有族、对应物、落地层级与验收，
> 缺口排进 P5/P6，不留「刻意不做」的黑洞。
>
> 一次任务属于哪几族，由**计划里的工具序列反推**，不由请求前的自我声明决定。

这里要先把「包含」的口径钉死，后面所有表格都按它判：

| 层级 | 含义 | 是否算「包含」 |
| --- | --- | --- |
| **L0 已有工具** | 我们有同名能力，名字不同（`read` → `fs.readFile`） | 是，直接可用 |
| **L1 等价机制** | 能力存在，但由宿主承担，不向模型暴露任意调用（`working_directory` → 会话级 `workspaceRoot`） | 是，能力在，形态不同 |
| **L2 待补** | 真的缺，已排进 P5/P6 | 是，有归属、有计划、有验收 |
| **L3 平台不适用** | `pwsh` 系列，darwin 产品没有对应物 | 是，登记并写明原因 |

**「包含」不等于「都做成模型可见工具」。** 把 `stagehand_act`（任意点击页面）或
`plugin_manager`（装第三方包）直接开放给模型，会推翻两条已有裁决：网页通道只回答、
不代操作；不开放第三方插件安装。所以这两类落在 L1 / L2，而不是硬塞成工具——
但它们在矩阵里有位置、有替代方案、有验收，不存在「没人知道它算不算覆盖」的灰区。

## 1. 原来错在哪

五件事，按影响从大到小：

| # | 现状 | 后果 |
| --- | --- | --- |
| 1 | 能力清单是**工具清单**：`fs.edit`、`git.diff`、`sqlite.query`……64 条，全是操作系统式动词（`src/shared/capabilities.ts`） | 设置页能看见「能执行什么操作」，看不见「能承担什么工程活动」 |
| 2 | 工作流只有一份：`resources/expertise/skills/engineering-design/SKILL.md`，45 行、三阶段通用流程 | 设计/实现有流程；调试、审阅、数据、前端靠模型自由发挥 |
| 3 | 判据写在提示词句子和 `ruleReview` 的 issue 文案里（`src/main/engineering/review.ts`） | 「改了文件必须有 `test.run`」只在执行后作为一句话出现，不拦任何东西 |
| 4 | 读工具一次回答最多请求一次（`engineeringToolSystem()` 明写） | 跨文件定位必须靠用户催第二轮 |
| 5 | `LOCAL_HARNESS_TOOLS.md` 明确把 dsh 的 4 类划到「不在这层」：agent 编排、扩展生态、持久终端、LSP；`HARNESS_BASELINE.md` 也只对齐了「本机干活」 | 能力清单**天然缺一半**。dsh 是 76 条 schema，我们登记 64 条，差额既没有对应物记录、也没有「为什么没有」的记录。用户问「你能开终端吗」只能靠猜 |

第 5 条是这轮的主要修正：上一轮的对齐范围是「本地机器能力」，结论没错，但它被当成了
**全部能力的结论**。缺的不是实现，是**登记**——没有登记的缺口，永远排不进计划。

## 2. 三层模型

```
能力族 family (13 = 8 工作族 + 5 治理族)
   └── 能力项 item (每族 1–4 条，带触发词与判据)
          └── 工具 tool (本仓库 64 个 + dsh 76 条对照，id 不改)
```

一条能力项固定包含七个字段：

```ts
interface EngineeringCapability {
  id: string;              // 稳定 id，如 'code.change'
  family: FamilyId;        // 所属族
  goal: string;            // 这件事「做完」是什么样，一句话
  tools: string[];         // 工具 id 或机制名；可以重叠，族不互斥
  preconditions: string[]; // 下结论前必须已经拿到的事实
  outputs: string[];       // 产出物：文件 / 报告 / 命令输出
  antiPatterns: string[];  // 明确不做的事
  acceptance: string[];    // 验收判据，必须是能跑或能查的
}
```

**为什么拆成两类族。** 8 个工作族回答「在干什么活」，判据是**证据**（路径行号、退出码、diff）；
5 个治理族回答「活是谁在推进、在什么环境里推进」，判据是**状态机**（计划是否批准、任务是否
终止、会话是否有记录）。混成一套会让「调试」和「定时任务」共用一条验收口径，两边都不成立。

三条硬约束不变：

1. **判据可执行**：命令与退出码、文件与行号、diff 非空，不接受「质量良好」。
2. **证据可追溯**：每条断言能指回 `(path, line)` / `(command, exitCode)` / `(url)`。
3. **可按族关闭**：停用一族后退回「只读分析」并说出来，不允许降到半套流程。

## 3. 工作族（8）

| 族 | 活动 | 主要工具（真实 id） | 必备证据 | 典型反模式 |
| --- | --- | --- | --- | --- |
| `code.read` | 读懂代码 | `fs.tree` `fs.search` `fs.find` `fs.stat` `fs.readFile` `project.outline` `project.dependencies` `git.status` `git.diff` `git.log` `git.show` `json.query` `web.fetch` `web.search` | 路径:行号；计数类要给真实行数/字节数 | 拿关键词片段当「工程全貌」；附件被截断还报总数 |
| `code.change` | 改代码 | `fs.edit` `fs.applyPatch` `fs.writeFile` `fs.move` `fs.copy` `fs.remove` `git.worktree` `test.run` | diff + 测试退出码；写入后回读 | 一次改十个文件说「应该可以」；测试红了继续下一步 |
| `debug` | 调试定位 | `fs.search`（报错串）`fs.readFile` `git.log` `git.diff` `test.run` `shell.run` `process.list` `port.list` | 复现命令 + 退出码 → 根因行 → 修复 → 复跑 | 连续三次盲改；把「不报错了」当「修好了」 |
| `test` | 测试验证 | `test.run` `code.run` `fs.readFile`（读现有测试风格）`text.diff` | 命令 + 退出码 + 用例数 | 为通过而写测试；改断言迁就实现 |
| `docs` | 文档说明 | `fs.readFile` `fs.writeFile` `fs.applyPatch` `git.diff` | 文档里的行为描述能对上代码位置 | 复述代码当文档；写「已支持」但代码没接 |
| `data` | 数据与脚本 | `json.query` `csv.summary` `sqlite.query` `code.run` `text.base64` `archive.*` | 输入指纹 + 命令 + 输出摘要 | 全量读进上下文口算；不带 `LIMIT` 就跑 SQL |
| `frontend` | 前端界面 | `fs.*` `test.run` `code.run` `screen.capture` `window.list` | 构建退出码 + 截图或可复现步骤 | 只改样式不验证布局；只说「应该没问题」 |
| `review` | 审阅风险 | `git.diff` `git.show` `fs.readFile` `text.diff` `project.outline` | 每条意见指到行 + 触发条件 | 把 diff 念一遍；只提「建议加注释」 |

### 3.1 `code.read` 读懂代码

- **做完的样子**：能回答「有什么 / 在哪 / 谁用谁 / 改它会波及什么」，位置可点回去。
- **前置事实**：读过的文件清单；计数类问题的真实统计来源（`fs.stat` 的 `lines` / `bytes`）。
- **反模式**：把 `project.outline` 的正则识别结果说成 AST 结论（`engineering/analysis.ts`
  已约定要写明「按正则识别」）；用 8 个关键词片段代替整份文件去数行数。
- **验收**：问「多少行」→ 引用 `fs.stat`；问「谁调用 X」→ 定义处与调用处行号；没有 → 说「未找到」。

### 3.2 `code.change` 改代码

- **做完的样子**：工作区出现可展示的 diff，且有一个真实检查跑过。
- **前置事实**：要改的位置读过；改动前哈希（`fs.edit` 支持 `expectedHash`）；现有测试怎么跑。
- **反模式**：多文件一起改完再说「应该可以」；测试失败时把断言改松；把「跳过检查」写进交付清单。
- **验收**：每个写操作后 3 步内出现一次 `test.run` 或等价构建检查；失败即停，交 `review` 判。

### 3.3 `debug` 调试定位

- **做完的样子**：报告四段齐全——复现、根因、修复、复跑。
- **前置事实**：一条能稳定复现的命令与退出码；报错原文（不转述）。
- **反模式**：没有复现就改；同一处连改三次仍无解释；根因写成「可能是缓存」。
- **验收**：缺哪段标「未验证」；连续三次未解决必须停下说明已试方案（`SKILL.md` 已有同口径）。

### 3.4 `test` 测试验证

- **做完的样子**：新增/修改的断言能在失败时失败、修复后通过。
- **前置事实**：现有测试组织方式；这条测试覆盖的那一行代码。
- **反模式**：断言实现细节而不断言行为；为了新测试过而改动旧断言。
- **验收**：给出「改动前是红」的证据；做不到先红必须说明原因。

### 3.5 `docs` 文档说明

- **做完的样子**：读者能据此复现或接手；每个路径都真实存在。
- **反模式**：把 diff 翻译成自然语言；写「已支持」但没接线；只写「改了什么」不写「原来错在哪」。
- **验收**：引用的路径存在；声称的行为有代码行或测试可指。

### 3.6 `data` 数据与脚本

- **做完的样子**：分析可复跑，数字有来源。
- **前置事实**：输入指纹（`fs.stat` 的 `sha256`）；数据规模（行数/字节数）。
- **反模式**：十万行 CSV 读进上下文口算；`sqlite.query` 不带 `LIMIT`；把推测当统计。
- **验收**：脚本落盘、命令可复跑、输出摘要带样本量。

### 3.7 `frontend` 前端界面

- **做完的样子**：构建通过，关键路径有截图或可复现步骤。
- **反模式**：只改 CSS 就断言「布局没问题」；没有运行态就评价交互。
- **验收**：`test.run` 构建退出码 0；至少一张 `screen.capture` 或一段用户可照做的步骤。

### 3.8 `review` 审阅风险

- **做完的样子**：至少指出一个具体输入下的错误行为，或明确「未发现阻断问题」。
- **反模式**：逐行复述 diff；只提风格；把「我看不懂」写成「有风险」。
- **验收**：每条意见带位置与触发条件；`reviewExecution` 规则版仍只陈述报告里读得到的事实。

## 4. 治理族（5）

| 族 | 回答什么 | 判据形态 | dsh 对应（数量） |
| --- | --- | --- | --- |
| `runtime.exec` | 用什么进程/终端/语言服务把活跑起来 | 进程状态、退出码、端口、会话 cwd | `bash` `pwsh` `terminal_*`(6) `run_code` `lsp` `job_*`(3) `working_directory` |
| `plan.control` | 这次要做到什么、谁批准、什么时候做 | 计划状态、步骤状态、目标状态 | `todo_write` `exit_plan_mode` `goal_*`(3) `schedule_*`(4) `propose_action` `ask_user_question` `present` |
| `collab.delegate` | 谁来做、怎么分工、怎么收 | 参与者与任务板状态 | `subagent` `subagent_oar` `list_subagent_models` `interrupt_agent` `list_agents` `send_message` `ralph` `workflow` `spawn_teammate` `team_task_*`(4) `wait_agent` |
| `memory.context` | 以前怎么做的、这次该加载什么 | 检索命中、技能加载记录 | `skill` `session_search` `session_event_*`(3) `session_trace` |
| `platform.extend` | 运行时还能装什么、有什么 | 插件清单、MCP 资源、探针结果 | `plugin_manager` `plugin_market` `list_mcp_*`(2) `read_mcp_resource` `cordis_inspect_*`(2) `stagehand_*`(6) |

五族的共同底线：**治理族不产生工程结论**。它们决定「跑不跑、谁来跑、跑完存哪」，
不判断「这行代码对不对」。任何治理族的输出都不能被当成 `code.change` 的证据。

## 5. dsh 76 条全覆盖对照

### 5.1 层级定义

见第 0 节。这里只补一条判据：**L1 必须写清「由谁承担」**，不是「我们决定不做」；
**L2 必须写清「排进哪一期、验收是什么」**。两条缺一条，这条就不算覆盖。

清单已冻结在 `src/shared/dsh-tools.ts`（P0，2026-11-10），`test:dsh-coverage` 断言
76 条、71 个唯一名、五组同名不同包与层级统计；升 dsh 版本时跑
`node scripts/check-dsh-drift.mjs` 按 `(包名, 工具名)` 集合比对，不要按下标对。

本节的编号是**本工程的表序**（按主题分组），不是 dsh 目录里的 schema 顺序；
升 dsh 版本时按 `(包名, 工具名)` 集合比对，不要按下标对。

### 5.2 文件、搜索、执行与运行时（22 条）

| # | dsh 工具 | 包 | 族 | 我们的对应物 | 层级 |
| --- | --- | --- | --- | --- | --- |
| 1 | `read` | dsh-tool-fs | `code.read` | `fs.readFile` | L0 |
| 2 | `read_image` | dsh-tool-fs | `code.read` | `fs.readImage` | L0 |
| 3 | `write` | dsh-tool-fs | `code.change` | `fs.writeFile`（写完回读） | L0 |
| 4 | `edit` | dsh-tool-fs | `code.change` | `fs.edit`（唯一字面量 + `expectedHash`） | L0 |
| 5 | `apply_patch` | dsh-tool-fs | `code.change` | `fs.applyPatch`（unified diff） | L0 |
| 6 | `str_replace_editor` | dsh-tool-str-replace-editor | `code.change` | `fs.edit` + `fs.readFile`（view 形态） | L0 |
| 7 | `glob` | dsh-tool-fs-search | `code.read` | `fs.find` | L0 |
| 8 | `grep` | dsh-tool-fs-search | `code.read` | `fs.search` | L0 |
| 9 | `load_workspace_dependencies` | dsh-tool-workspace-dependencies | `code.read` | `project.dependencies` | L0 |
| 10 | `create_worktree` | dsh-experimental-tool-worktree | `code.change` | `git.worktree`（参数逐个构造，不拼 shell） | L0 |
| 11 | `web_fetch` | dsh-tool-web | `code.read` | `web.fetch`（SSRF 防护、10s、2 MB） | L0 |
| 12 | `web_search` | dsh-tool-web | `code.read` | `web.search`（凭据或应用内浏览器） | L0 |
| 13 | `run_code` | dsh-tool-executor-ptc | `runtime.exec` | `code.run`（写盘后交给 node/python3/bash） | L0 |
| 14 | `bash` | dsh-tool-bash | `runtime.exec` | `shell.run`（`/bin/sh -c`，真实退出码） | L0 |
| 15 | `job_list` | dsh-tool-jobs | `runtime.exec` | `job.list` | L0 |
| 16 | `job_output` | dsh-tool-jobs | `runtime.exec` | `job.output` | L0 |
| 17 | `job_kill` | dsh-tool-jobs | `runtime.exec` | `job.kill` | L0 |
| 18 | `bash`（持久 PTY） | dsh-tool-bash-persistent | `runtime.exec` | 无持久 cwd：`shell.run` + `job.*` 顶一半 | L2 · P5 |
| 19 | `pwsh` | dsh-tool-pwsh | `runtime.exec` | 无：darwin 产品 | L3 |
| 20 | `pwsh`（持久） | dsh-tool-pwsh-persistent | `runtime.exec` | 无：darwin 产品 | L3 |
| 21 | `lsp` | dsh-tool-lsp | `runtime.exec` | `code.diagnostics`（tsc / eslint 输出归一，不常驻语言服务器） | L0 |
| 22 | `working_directory` | dsh-tool-working-directory | `runtime.exec` | 会话级 `workspaceRoot`；每个 path 相对它 | L1 |

### 5.3 终端（6 条）

| # | dsh 工具 | 族 | 我们的对应物 | 层级 |
| --- | --- | --- | --- | --- |
| 23 | `terminal_open` | `runtime.exec` | 无 | L2 · P5 |
| 24 | `terminal_read` | `runtime.exec` | 无 | L2 · P5 |
| 25 | `terminal_send` | `runtime.exec` | 无 | L2 · P5 |
| 26 | `terminal_signal` | `runtime.exec` | 无 | L2 · P5 |
| 27 | `terminal_close` | `runtime.exec` | 无 | L2 · P5 |
| 28 | `terminal_list` | `runtime.exec` | 无 | L2 · P5 |

### 5.4 计划、目标、交互与技能（13 条）

| # | dsh 工具 | 包 | 族 | 我们的对应物 | 层级 |
| --- | --- | --- | --- | --- | --- |
| 29 | `ask_user_question` | dsh-tool-ask-user | `plan.control` | `ask.user`（执行中提问；计划前仍走协议澄清） | L0 |
| 30 | `exit_plan_mode` | dsh-plan-mode | `plan.control` | `plan.ready` → 批准 / 退回重规划 | L1 |
| 31 | `propose_action` | dsh-action-cards | `plan.control` | `plan.ready` + `step-approval`（逐次审批） | L1 |
| 32 | `present` | dsh-tool-present | `plan.control` | `document.export` / `page.save-document` | L1 |
| 33 | `todo_write` | dsh-tool-todo | `plan.control` | `AgentPlan` 步骤 + 进度事件 | L1 |
| 34 | `create_goal` | dsh-tool-goal | `plan.control` | 无：会话没有目标模型 | L2 · P6 |
| 35 | `get_goal` | dsh-tool-goal | `plan.control` | 无 | L2 · P6 |
| 36 | `update_goal` | dsh-tool-goal | `plan.control` | 无 | L2 · P6 |
| 37 | `schedule_create` | dsh-tool-schedule | `plan.control` | 无 | L2 · P6 |
| 38 | `schedule_edit` | dsh-tool-schedule | `plan.control` | 无 | L2 · P6 |
| 39 | `schedule_list` | dsh-tool-schedule | `plan.control` | 无 | L2 · P6 |
| 40 | `schedule_view` | dsh-tool-schedule | `plan.control` | 无 | L2 · P6 |
| 41 | `skill` | dsh-tool-skill | `memory.context` | `resources/expertise` 按规则自动加载（不是模型工具） | L1 |

**`ask.user` 的契约（已落地）**

现有 `clarification_required` / `awaiting_user` 只覆盖**计划生成前**：模型还没动手时把问题抛回来。
执行到一半才发现「这里要用户确认用哪个目录 / 要不要覆盖 / 这两个方案选哪个」时没有通道，
模型只能猜或者停在原地。所以这不是等价机制，要做成真工具：

| 项 | 约定 |
| --- | --- |
| id | `ask.user`，归 `plan.control`，权限 `read-only` |
| 参数 | `{ question: string, options?: string[], allowFreeText?: boolean, timeoutMs?: number }` |
| 行为 | 执行到这一步时暂停计划，发 `user.question` 事件；用户回答后作为步骤结果返回 |
| 超时/取消 | 返回 `{ answered: false, reason: 'timeout' \| 'cancelled' }`，模型不得把未回答当默认值 |
| 预算 | 每份计划最多 3 次，超过即拒绝，防止拿提问当拖延 |
| 落盘 | 问题与回答写进会话，可审计；不复用「系统消息」通道刷屏 |
| 不做 | 不新增第二种提问 UI：复用现有澄清卡片；网页通道仍然不可调用（收不到 `system`） |

### 5.5 委派与协作（17 条）

| # | dsh 工具 | 包 | 族 | 我们的对应物 | 层级 |
| --- | --- | --- | --- | --- | --- |
| 42 | `subagent` | dsh-tool-subagent | `collab.delegate` | `SubAgentRegistry` + 辩论成员（无委派工具） | L1 |
| 43 | `subagent_oar` | dsh-experimental-tool-subagent-oar | `collab.delegate` | 辩论成员 / `execution-pool` | L1 |
| 44 | `list_subagent_models` | dsh-tool-subagent | `collab.delegate` | 设置页模型清单 | L1 |
| 45 | `interrupt_agent` | dsh-tool-subagent-control | `collab.delegate` | 会话停止 / 取消 | L1 |
| 46 | `list_agents` | dsh-tool-subagent-control | `collab.delegate` | 参与者栏 + `selectParticipants` | L1 |
| 47 | `send_message` | dsh-tool-subagent-control | `collab.delegate` | 会话内追问 | L1 |
| 48 | `interrupt_agent` | dsh-experimental-tool-agent-team | `collab.delegate` | 同 45（同名不同包） | L1 |
| 49 | `list_agents` | dsh-experimental-tool-agent-team | `collab.delegate` | 同 46 | L1 |
| 50 | `send_message` | dsh-experimental-tool-agent-team | `collab.delegate` | 同 47 | L1 |
| 51 | `ralph` | dsh-tool-ralph | `collab.delegate` | 多轮编排与执行重试 | L1 |
| 52 | `workflow` | dsh-tool-workflow | `collab.delegate` | 计划 + 编排（无脚本工作流） | L1 |
| 53 | `spawn_teammate` | dsh-experimental-tool-agent-team | `collab.delegate` | 无 | L2 · P6 |
| 54 | `team_task_create` | dsh-experimental-tool-agent-team | `collab.delegate` | 无 | L2 · P6 |
| 55 | `team_task_get` | dsh-experimental-tool-agent-team | `collab.delegate` | 无 | L2 · P6 |
| 56 | `team_task_list` | dsh-experimental-tool-agent-team | `collab.delegate` | 无 | L2 · P6 |
| 57 | `team_task_update` | dsh-experimental-tool-agent-team | `collab.delegate` | 无 | L2 · P6 |
| 58 | `wait_agent` | dsh-experimental-tool-agent-team | `collab.delegate` | 无 | L2 · P6 |

### 5.6 会话记忆与浏览器（8 条）

| # | dsh 工具 | 包 | 族 | 我们的对应物 | 层级 |
| --- | --- | --- | --- | --- | --- |
| 59 | `session_event_read` | dsh-tool-session-query | `memory.context` | `store` 会话读取 + 轨迹页 | L1 |
| 60 | `session_event_trace` | dsh-tool-session-query | `memory.context` | trace 事件流 | L1 |
| 61 | `session_trace` | dsh-tool-session-query | `memory.context` | 轨迹 / 统计页 | L1 |
| 62 | `session_event_search` | dsh-tool-session-query | `memory.context` | 无 | L2 · P5 |
| 63 | `session_search` | dsh-tool-session-query | `memory.context` | 无（跨会话检索） | L2 · P5 |
| 64 | `stagehand_navigate` | dsh-experimental-browser-use-stagehand-native | `runtime.exec` | 通道页面装载与切换（`WebContentsView`） | L1 |
| 65 | `stagehand_observe` | dsh-experimental-browser-use-stagehand-native | `runtime.exec` | `selector-profile` + 页面探针 | L1 |
| 66 | `stagehand_extract` | dsh-experimental-browser-use-stagehand-native | `runtime.exec` | 取答案（`readAnswer` + 选择器） | L1 |

### 5.7 扩展与运行时治理（10 条）

| # | dsh 工具 | 包 | 族 | 我们的对应物 | 层级 |
| --- | --- | --- | --- | --- | --- |
| 67 | `stagehand_act` | dsh-experimental-browser-use-stagehand-native | `runtime.exec` | 宿主受控驱动：只发问/取答案，不开放任意点击 | L1 |
| 68 | `stagehand_screenshot` | dsh-experimental-browser-use-stagehand-native | `runtime.exec` | `screen.capture`（整屏；页面级截图待补） | L1 |
| 69 | `stagehand_tabs` | dsh-experimental-browser-use-stagehand-native | `runtime.exec` | 多页面管理（宿主，不是工具） | L1 |
| 70 | `plugin_manager` | dsh-plugin-manager | `platform.extend` | 设置页「内置插件」开关 + `CAPABILITY_CATALOG` 只读清单 | L1（仅开关，不安装） |
| 71 | `plugin_market` | dsh-plugin-market | `platform.extend` | 无 | L2 · 需裁决 |
| 72 | `list_mcp_resources` | dsh-mcp-resources | `platform.extend` | 无 | L2 · 需裁决 |
| 73 | `list_mcp_resource_templates` | dsh-mcp-resources | `platform.extend` | 无 | L2 · 需裁决 |
| 74 | `read_mcp_resource` | dsh-mcp-resources | `platform.extend` | 无 | L2 · 需裁决 |
| 75 | `cordis_inspect_list` | dsh-tool-cordis | `platform.extend` | 设置页插件清单（同一份 `CAPABILITY_CATALOG`） | L1 |
| 76 | `cordis_inspect_query` | dsh-tool-cordis | `platform.extend` | 无 | L2 · P5 |

### 5.8 统计

| 层级 | 条数 | 占比 | 说明 |
| --- | --- | --- | --- |
| L0 已有工具 | 19 | 25% | 文件、搜索、执行、作业、git、联网、提问、诊断 |
| L1 等价机制 | 28 | 37% | 计划、交互、委派、会话记忆、浏览器、插件清单 |
| L2 待补 | 27 | 35% | 终端 6、团队 7、目标 3、定时 4、会话检索 2、持久 bash 1、运行时查询 1、MCP/市场 3 |
| L3 平台不适用 | 2 | 3% | `pwsh` 两条 |
| **合计** | **76** | 100% | 71 个唯一名字；`bash` `pwsh` `interrupt_agent` `list_agents` `send_message` 各有两条同名 schema |

覆盖率判据：`76/76` 有族、有对应物、有层级；L2 有期号；L1 有承担者。任何一条缺字段，
`test:dsh-coverage` 直接失败（见实施文档 P0）。

## 6. 能力从哪来：工具序列反推

### 6.1 为什么不在提问前让模型声明「这次属于哪族」

1. **声明与行为会不一致。** 模型说「这次是调试」，计划里却一条复现命令都没有，该信谁？
   工具序列是事实，声明只是意图。
2. **多一次模型往返就多一种失败。** `ENGINEERING_ROUTING` 刚把「程序猜意图」换成模型判定，
   再加一层能力路由，等于在 4 秒/15 秒预算里再塞一次超时。
3. **纯事实题会被误套流程。** `expertise/trigger.ts` 已踩过：给「这个文件多少行」套上
   「先给执行计划、写→验→报」，本地 14b 会回一段任务分解而不是 664。

### 6.2 反推规则

`deriveCapabilities(plan)` 是纯函数，输入 `AgentPlan`，输出族集合与主族：

| 优先级 | 触发条件 | 主族 |
| --- | --- | --- |
| 1 | 计划含写工具（`fs.writeFile` / `fs.edit` / `fs.applyPatch` / `fs.move` / `fs.copy` / `fs.remove`） | `code.change` |
| 2 | 计划含 `test.run` 且无写工具 | `test` |
| 3 | 计划只含读工具且问题是事实题（命中 `FACT_ONLY` 且无 `WORK_VERBS`） | 族为空，直接回答 |
| 4 | 计划含 `shell.run` + 报错串搜索 / 日志读取 | `debug`（与 1、2 同时成立时仍以 1 为主族） |
| 5 | 计划含 `screen.capture` + 前端路径改动 | `frontend` |
| 6 | 其余含读工具 | `code.read` |

治理族**不由计划反推**，由会话状态判定：有未批准计划 → `plan.control`；有后台作业 →
`runtime.exec`；有子代理在跑 → `collab.delegate`。它们不参与技能加载。

### 6.3 反推的代价与缓解

事后才知道族归属，意味着「计划错了才发现要补流程」。缓解点在 `plan-review`
（`shouldDebatePlan` 之前）：计划生成后、执行前跑一次 `checkPlanCapabilities`，
缺判据在这里拦下，而不是执行完再报 issue。

## 7. 技能加载：一族一份技能

现状是一份 `engineering-design` 技能，覆盖设计/实现/改造。目标形态：

```
resources/expertise/
  EXPERT.md                        常驻人设（不改）
  skills/
    engineering-design/SKILL.md    设计/实现/改造（保留，扩写交付判据）
    engineering-debug/SKILL.md     复现→根因→修复→复跑
    engineering-review/SKILL.md    正确性优先的审阅顺序
    engineering-data/SKILL.md      指纹、样本量、可复跑
```

前端与文档暂不单独开技能，合并进 `engineering-design`：流程与「写→验→报」同构，
拆开只会让 system 变长、触发更难解释。技能目录数量与族数量不强制一一对应，这是有意的。

加载规则（顺序固定，任一命中即停）：

1. 事实题且无实施动作 → 不加载（沿用 `trigger.ts` 现有的优先出局）；
2. 主族是 `debug` → `engineering-debug`；
3. 主族是 `review` → `engineering-review`；
4. 主族是 `data` → `engineering-data`；
5. 其余 → `engineering-design`；
6. 一次最多一份，正文合计不超过现有 20000 字上限。

三条边界不变（`expertise/system.ts` 已写明）：只在工程空间返回；只拼 `system`，不碰 `question`；
网页通道收不到 `system`，所以天然只影响本地/云端第一意见。

## 8. 证据账本与结论规则

### 8.1 三种可验证事实

```ts
type EvidenceRef =
  | { kind: 'file'; path: string; line?: number; sha256?: string; lines?: number }
  | { kind: 'command'; command: string; exitCode: number | null; at: number; timedOut?: boolean }
  | { kind: 'url'; url: string; fetchedAt: number };
```

- **读到过**：`file`，计数类必须带 `sha256` 或 `lines`。
- **跑过**：`command`，没有退出码（后台/超时）记 `null`，不能当成功。
- **改过**：`file` + 写前写后哈希，或一条非空 diff。

### 8.2 三个校验点

| 时机 | 校验 | 失败时的行为 |
| --- | --- | --- |
| 计划生成后、执行前 | `checkPlanCapabilities`：主族要求的判据是否在计划里 | 拦下计划，列出缺哪条，给「按现状执行」与「补计划」两个选择 |
| 执行后 | `ruleReview` 扩写：除「写文件没配 `test.run`」，增加「测试红」「后台作业当成功」 | 产出 `needsFix`，不自动改 |
| 回答前 | 引用检查：结论里的每条断言能否落到账本 | 落不到的断言降级成「未验证」或删除 |

### 8.3 措辞规则（`AGENTS.md` 第 3 条的落地）

| 看到的事实 | 能说 | 不能说 |
| --- | --- | --- |
| 只有一个通道回答 | 「只有一个通道给出了回答」 | 「多数通道认为」 |
| 三个通道答案一致 | 「三个通道给出了相同结论」 | 「几乎没有重合」 |
| 页面结构没识别出来 | 「没找到回答区域」 | 拿侧边栏/推荐位文字冒充回答 |
| 读到了文件但没跑测试 | 「改动已写入，未验证」 | 「已修复」 |
| 后台命令还在跑 | 「命令已启动，结果未出」 | 「命令执行成功」 |

## 9. 权限与拒绝

族不改变权限，只声明「这一族通常需要什么」：

| 族 | 至少需要的权限 | 达不到时 |
| --- | --- | --- |
| `code.read` `review` `data`（只读查询）`memory.context` | `read-only` | 直接报错，说明缺哪个授权 |
| `code.change` `test` `docs` `frontend` | `workspace-write` | 拒绝写，但允许给 diff 让用户自己应用 |
| `runtime.exec`（前台命令） | `workspace-write` | 只读模式下只允许诊断类命令 |
| `runtime.exec`（`process.kill`、永久删除） | `danger-full-access` | 必须用户显式确认 |
| `plan.control` 的批准 | 用户本人 | 模型不能代批 |
| `platform.extend`（安装/卸载） | `danger-full-access` + 本次批准 | 目前未开放（L2 · 需裁决） |

强制点不变：`assertGrant` / `resolveGrantedPath` 在每一步执行时判，清单里的 `permission`
只是展示。任何「按族取消权限检查」的改法都不接受。

## 10. 边界与待裁决

**不做的是「照搬实现形态」，不是「删除能力」：**

- 不引入 dsh 的包或 Cordis 运行时（`HARNESS_BASELINE` 的既有决定继续成立）。
- 不把 `stagehand_act` 这类「让模型任意点页面」的能力放给模型：网页通道只回答，
  代操作会破坏「用户原话原样发页面」和归属判断。
- 不新增一路「能力路由」模型调用；能力由计划反推。
- 不为了「像 agent」而把技能配成独立成员：技能是内容，不是 `SubAgent`。
- 不给网页通道加任何 `system`，不往用户提问里拼话术（`test:prompt-policy` 守着）。
- 不自动修：`review` 只产出问题与建议，是否重修由用户确认。

**需要用户裁决的一项**：`plugin_market` / `list_mcp_resources` / `read_mcp_resource`
意味着「运行时安装第三方能力」。这与 2026-11-08 的裁决「不开放第三方包、不支持运行时
下载插件」直接冲突。本设计把它们登记为 L2，但实现前必须先改那条裁决；不改就停在 L2，
并在设置页写明「不支持第三方扩展」，而不是留空。

## 11. 成功判据

| 指标 | 目标 | 怎么量 | 现状 |
| --- | --- | --- | --- |
| dsh 工具覆盖率 | 76/76 有族、对应物、层级 | `test:dsh-coverage` | ✅ 76/76 |
| 本机工具归族覆盖率 | 100%，孤儿 0 | `test:engineering-capabilities` | ✅ 64/64 |
| 主族 `code.change` 的计划中带真实检查的比例 | 100% | 门禁拦截日志 + 场景回放 | 待 P3 |
| 结论可追溯率 | 抽样 ≥ 90% | 场景回放的引用检查 | 待 P1/P4 |
| 事实题被误加载技能的比例 | 0 | `trigger` 单测 + s20/s21/s24 回放 | 待 P2 |
| 真机回归场景通过数 | 只增不减 | `test:engineering-scenarios` | 待 P4 |

指标全部来自可跑的检查或回放，不靠人工打分。

## 12. 与现有实现的关系

| 现有东西 | 这次怎么用 | 改不改 |
| --- | --- | --- |
| `src/shared/capabilities.ts`（64 条） | 工具表是族的输入；不改 id | 不改 |
| `src/shared/contracts.ts`（`TOOL_NAMES` / `READ_ONLY_TOOLS`） | 归族扫描的唯一来源 | 不改 |
| `src/main/engineering/analysis.ts` | 读族的结构事实来源，保留「按正则识别」声明 | 不改 |
| `src/main/engineering/review.ts` | 证据账本的执行后校验点 | 扩写 |
| `src/main/engineering/plan-review.ts` | 执行前门禁挂在这里 | 扩写 |
| `src/main/expertise/trigger.ts` | 事实题短路 + 技能选择 | 扩写 |
| `src/main/expertise/system.ts` | 唯一拼 `system` 的地方 | 不改语义，只加技能来源 |
| `src/main/research/engineering-round.ts` | 读工具回环；预算从「一次」放开到按族配额 | 改一处常量 |
| `src/main/execution/policy.ts` | 选人，与族无关 | 不改 |
| `src/shared/evidence.ts` | 页面引用与正文指纹，**不并入**执行证据 | 不改 |
| 新增 `src/shared/engineering-evidence.ts` | 执行证据账本（file / command / url） | 新建 |
| 新增 `src/shared/dsh-tools.ts` | dsh 76 条的冻结清单 + 我们的映射，覆盖测试的唯一来源 | 新建 |
