# ThinkFusion 实现状态

**唯一当前状态来源**。快照对应 `main` 于 2026-11-28 合入 V4 P1 M2-2（任务分支
`v4/p1-m2-2-checkpoint-resume`，基线 `5e72934` = M2-1 合并点）之后的状态；此前记的 `b15ee56`
（2026-11-27，目标卡鼠标交互与恢复契约核对）已随 M1/M2-1/M2-2 三次合并过期。代码、测试和真实
验收变化时更新本页；不要在其他文档另建阶段完成度表。

> 设计说明不是实现证据；单测不是真机证据；一个真机样本不代表所有环境。
> 缺证据时标“未确认”，不要从目录、类型或任务书标题推断完成。

## 状态口径

| 标记 | 含义 |
| --- | --- |
| `IMPLEMENTED` | 生产代码路径存在 |
| `TESTED` | 有自动化回归 |
| `VERIFIED` | 有可核对真实应用/任务证据 |
| `PARTIAL` | 核心路径存在，但仍有已知缺口 |
| `DESIGN` | 目标设计，不声明实现 |
| `NOT STARTED` | 尚无可交付实现 |
| `HISTORICAL` | 旧基线材料，只供追溯 |

## 当前能力

| 能力 | 状态 | 当前边界/证据 |
| --- | --- | --- |
| Web / Local / Cloud / CLI 参与者 | `IMPLEMENTED / TESTED` | 按执行配置和任务选择；网页与 CLI 输入边界见 [ADR 0008/0009](../adr/README.md) 与 `AGENTS.md` |
| General / Knowledge | `PARTIAL` | 多轮研究、召回、Memory 注入存在；知识索引跨会话复用和产品化仍有缺口 |
| Engineering | `VERIFIED` | 分流、计划、审批、独立 Runtime、验证/评审、交付和中断恢复有真实链路 |
| Collaboration / DMOCA / GDC / TDL / ECO | `IMPLEMENTED / TESTED` | 共用现有协作与任务运行时；详见 [acceptance](acceptance/README.md)，不要据某专项测试推断所有场景均真机通过 |
| Debate / Plan Review | `IMPLEMENTED / TESTED` | 按需触发；模型选择、收尾和预算受测试约束 |
| Global Memory | `IMPLEMENTED / TESTED / VERIFIED` | 存储、注入、治理已接线；历史 M2/M3 证据在 [evidence/global-memory](evidence/global-memory) |
| 长任务上下文 | `IMPLEMENTED / TESTED / VERIFIED` | 摘要、裁剪、检查点、恢复和副作用核对已实现；默认关闭，优先级为 env > `context-manager.json` > 默认值 |
| macOS Computer Use | `IMPLEMENTED / TESTED / VERIFIED` | 支持范围与锁屏限制见 [实现说明](features/computer-use/IMPLEMENTATION.md) |
| 发布与运维 | `PARTIAL` | 有打包/备份/回滚流程；签名和公证未执行 |

## 模块级状态（V3 治理层）

每项分「已实现 / 已接线 / 自动化测试 / 真机验证」四列。**TESTED 不等于 VERIFIED**：
本轮只补了自动化与生产接线，没有为新增分支跑真机样本，因此真机列保持「未验证」。

| 模块 | 已实现 | 已接线（生产调用链） | 自动化测试 | 真机验证 | 当前缺口 | 证据位置 |
| --- | --- | --- | --- | --- | --- | --- |
| Goal | 目标投影、变更分类、版本递增、影响面与继承 | `Orchestrator.reviseGoal` + IPC `task:revise-goal`；任务创建写入 `goalId/goalVersion` | `test:gdc-goal`（6） | 目标卡修改成功标准已点验 | 尚缺自动重开规划轮；界面暂无独立的“目标变更影响面”确认页 | `shared/goal-driven-cycle.ts`、`shared/contracts.ts` |
| TDL | L0–L3 WorkTask、状态机、依赖、验收、CAS、局部重规划；每个 L2 独立 cycleId | 种树时 `ensurePlanDecomposition` 定稿 L2；NEEDS_ANALYSIS 取消自动批准；步骤生命周期推进子任务循环并阻塞失败依赖者 | `test:tdl*`（17）、`test:subtask-cycle`（8） | 未验证 | 模型不给分解且目录不可归纳时只阻断、不自动补问模型；子任务循环复用主任务轮次，非物理并行 | `shared/task-decomposition.ts`、`shared/subtask-cycle.ts`、`main/index.ts` |
| GDC | 八阶段投影、结论与下一步、目标符合度 | `Orchestrator` 每轮投影 | `test:gdc-cycle`、`test:gdc-goal` | 部分（历史 P7 样本） | 阶段投影不等于真实独立子循环；子任务层由 TDL 循环补充 | `shared/goal-driven-cycle.ts` |
| ECO | 上下文包、充分度、六类类型化补充请求、来源与版本、失效判定 | 计划可带 `contextRequests` 主动请求；`eco-explore.ts` 真读文件/目录/符号/调用/测试/diff；代码或目标变化发 `eco.context.invalidated` | `test:eco`（10）、`test:eco-explore`（7） | 未验证 | 符号/调用是正则级定位，不是 AST/类型绑定；扫不到如实跳过 | `shared/eco.ts`、`main/engineering/eco-explore.ts`、`main/orchestrator.ts` |
| DMOCA | 参与决策、风险策略、贡献版本、决策快照、完整性校验 | 计划评审前选人；ECO 门禁拆参与/职责；工程评审与会话轮次都走 `snapshotFromExchanges` 出口并发 `model.decision.snapshot` | `test:dmoca`（25） | 未验证 | 会话决策快照已落事件，界面尚未展示每轮钉住的是哪一稿 | `shared/dmoca.ts`、`main/orchestrator.ts`、`main/conversation-runner.ts` |
| 长任务上下文 | 预算、压缩、检查点、恢复、副作用核对、版本链核对 | 恢复分档 `needs_context_refresh` / `needs_replan`；`resume` 发 `version.consistency` 并改写继续提示词 | `test:context-*` 系列、`test:version-consistency`（7） | 历史证据见 acceptance | 默认仍关闭；刷新后由下一轮真实读取重建 ECO 包，不强制同步重算 | `main/context/`、`shared/version-consistency.ts` |
| Workflow | 定义、校验、拓扑序、条件/循环/并行/审批节点、生产注册表、按目标选择 | `Orchestrator.submitWorkflow` + IPC `workflow:run` 复用审批/授权/报告 | `test:workflow`（10） | 未验证 | `until` 运行时循环明确拒绝；parallel 如实串行；只有 IPC 无界面入口 | `shared/workflow.ts`、`shared/workflow-registry.ts`、`main/orchestrator.ts` |
| Java 工程理解 | 文本检索与正则定位 | 代码索引/搜索路径 | `test:code-index*` | 部分 | P2-01：AST、类型绑定、调用图、增量索引 | `main/code-index/` |
| 工程对话流（TaskConversation） | A/B 定位轨·计时·稳定 ID·统一状态·diff 汇总；阶段 1 逐文件 Diff；C1 subtype 映射、C2 step 聚合、C3a/b/c 三元素、C4 MarkdownBody；D1 子 Agent 卡片；D2 并行对话浮层 | `buildTaskConversation` + `TaskConversation.tsx` 生产链路，`clusterSteps`/`noteEmphasisOf`/`diffSummaryOf`/`teamProposalsOf` 纯函数接线；`shared/parallel-lanes.ts` + `ParallelConversationRail.tsx` + App 挂点 | `test:task-conversation`（65） | 冒烟（A 完整证据；C 见 stage-c，D1/D2 见 stage-d1d2，样本未触发 agent/diff/表格/并行 lane） | C4 协议正文仍按既有设计走纯文本；D1/D2 真机缺 `code.team.run` 与多通道样本，由单测覆盖 | `docs/spec/TASK_CONVERSATION_STREAM.md`、`docs/spec/evidence/stage-{a,c,d1d2}/` |

## V3 全局生产闭环（计划书 P0–P5）

以 [总计划](plans/V3-PRODUCTION-CLOSURE-PLAN.md) 与 [P0 任务书](plans/active/P0-VERSION-RECOVERY-TASK-BOOK.md) 为准；阶段编号与下面的 GCE 轨道不同。P0 已合入 `main`（压缩提交 `173b85a`，原六个提交见 `backup/pre-squash-20261127`）；下表证据来自任务分支 `p0-version-recovery` 的真机运行，代码与 `main` 一致。V4 阶段计划见 [V4 实施计划](plans/V4-IMPLEMENTATION-PLAN.md)，其 P0 是架构事实统一，不是重复开发本批功能。

| 项 | 状态 | 事实 |
| --- | --- | --- |
| P0-1 版本链输入去同源化 | `IMPLEMENTED / TESTED / VERIFIED` | `buildResumeVersionChainInput` 分开取「任务记录」与「事件流当前事实」；当前目标取自 `goal.contract.updated`，贡献快照取自 `plan.debated`，决策钉版取自 `model.decision.snapshot`，`version.consistency.sources` 记录取源；`test:version-consistency` 12 条（含源码守卫）；真实任务修订到 v2 后恢复，判出任务树 v1 过期、`requiresReplan=true`，见 [P0-1 验收](acceptance/p0-1-version-chain-20261127/EVIDENCE.md) |
| P0-2 needs_replan 硬门禁 | `IMPLEMENTED / TESTED / VERIFIED` | 过期时作废旧任务树、发 `WAIT_USER`、转 `blocked`，不再生成 planning 轮；`version.consistency.actedOnReplan` 记录门禁是否真的执行；`test:task-resume` 6 条；真机同一探针任务恢复后 `blocked`、无新规划轮，见 [P0-2 验收](acceptance/p0-2-replan-gate-20261127/EVIDENCE.md) |
| P0-3 在途 shell.run 中断 | `IMPLEMENTED / TESTED / VERIFIED` | `runShell` 接收运行时取消集合，按进程组 SIGTERM→SIGKILL 并记录 `interrupted/signal/exitCode/stdout/stderr`；插件返回 `COMMAND_INTERRUPTED`；Runtime 在工具收尾后才发取消回执，主进程有界等待、`未能确认终止` 如实记日志；`test:shell-interrupt` 4 条；真机长 shell 在 628ms 内中断，标记文件未出现，见 [P0-3 验收](acceptance/p0-3-shell-interrupt-20261127/EVIDENCE.md) |
| P0-4 暂停状态机与检查点 | `IMPLEMENTED / TESTED / VERIFIED` | `pause/cancel` 走 `请求态 → 停止中 → 实际态`；暂停/取消复用 `commitContextCheckpoint` 落目标版本、任务树 revision、工具状态与副作用账本；没有执行报告的在途写操作也标 `needs_reconciliation`，不假装已核对；重启时中间态收敛为 `interrupted/cancelled`；`test:pause-checkpoint` 5 条、`test:state-machine` 9 条；真机状态序列 `executing → pause_requested → pausing → paused`，检查点文件与事件一致，标记文件未出现，见 [P0-4 验收](acceptance/p0-4-pause-checkpoint-20261127/EVIDENCE.md) |
| P0-5 当前基线真机恢复验收 | `IMPLEMENTED / TESTED / VERIFIED` | 三场景真机证据已按「启动配置 / 任务 ID / 证据路径 / 未覆盖项」汇总到 [P0-5 验收汇总](acceptance/p0-5-current-baseline-20261127/SUMMARY.md)；① 目标修订后进入 `blocked + WAIT_USER`、② 在途 shell 中断且暂停检查点带副作用缺口、③ SIGKILL 重启后 `interrupted → version.consistency(sources) → planning`。场景③ 同时修掉固定工作流未记规划成员、重启后退回网页 planner 的缺口，探针任务记下并执行档选中的云端模型，日志无 ChatGPT 回退；typecheck、P0 相关单测与 `verify-p0-5-restart-cdp.mjs` 均通过 |

## V4 P1 Engineering Runtime（M1：Goal / Task / Execution 统一）

以 [V4 实施计划](plans/V4-IMPLEMENTATION-PLAN.md) 与 [P1 任务书](plans/active/V4-P1-TASK-BOOK.md) 为准。
口径为五态 `DESIGNED → IMPLEMENTED → AUTOMATED_TESTED → LIVE_TESTED → PRODUCTION_VERIFIED`；真机未跑不升级。

| 任务 | 状态 | 事实 |
| --- | --- | --- |
| M1-1 Execution 显式化 | `LIVE_TESTED` | 新增 `desktop-agent-macos/src/shared/execution-history.ts` 纯函数投影：`rounds + reports + events` → 按轮次分组的执行台账。口径为「一次执行＝一轮」，同轮多份报告合并成一条（结论取最新、证据取并集），缺字段一律 `null` 或空数组，不用 0 顶替。只读 IPC `task:executions` 从 store 取数而非渲染层事件流（`trimEvents` 会裁掉早期 `step.*`，用事件推导会让先前的执行凭空消失），配 preload `getTaskExecutions`、`AgentApi` 声明与 `mock-api` 实现。统计页新增「执行历史」卡 `components/engineering/ExecutionHistory.tsx`，逐条列出结果、成员、步骤、验证、交付、证据与失败原因。零迁移、不建表、不改状态机。`test:execution-history` 9 条（多次执行互不覆盖、无报告轮如实标注、跨任务报告不混入、排序按轮次号）已并入 `verify`。真机（[验收汇总](acceptance/v4-p1-m1-20261127/SUMMARY.md)）：一个 Task 投影出 4 条执行、`roundId` 去重 4 条，第 1 条仍是 `round 1 / outcome=failed`（`steps.failed=1`、`COMMAND_FAILED: 命令退出码 3`），第 2/3 轮无报告如实显示「未收口」而非 0 次失败，统计页 `.exec-item` 4 条＝同时刻投影 4 条；第 2 条及以后由目标驱动闭环自动续出，脚本未调 `resumeRepair`、未放行审批（`loopActions` 为空）。复跑（探针 `0a429d96`，即影响面分账改动后的回归跑）同样如实：2 条执行都带报告，第 1 条 `round 1 / outcome=failed`（`COMMAND_FAILED: 命令退出码 3`）、第 2 条 `round 2 / completed`（5 步全完成），`.exec-item` 2 条＝同时刻投影 2 条，`loopActions` 仍为空。最终复跑（探针 `2b0a189a`）3 条执行：第 1 条 `round 1 / failed`、第 2 条无报告如实标 `unknown`（成员列表保留「未记录成员」不抹平）、第 3 条 `plan_repair / partial`（2 步 1 完成 1 失败，失败原因如实带出 `TOOL_ERROR: 这次执行没有关联会话，无法使用会话级能力`），卡片头「执行历史 3 次执行 · 1 次失败」＝同时刻投影 3 条；上一轮 `514d0787` 同样是 3 条（第 3 轮为 `completed`、6 步全完成）。缺口：同一 Task 跨 `runId` 的两次独立运行未覆盖（四轮各自都只有一个 `runId`） |
| M1-2 Goal 聚合视图 | `LIVE_TESTED` | 分组投影 `src/shared/goal-view.ts`：`groupTasksByGoal()` 用任务上已有的 `goalId/goalVersion`（其次取契约正文里的 `goalId`）分组，组标题取版本最高的契约原文、没有才退回任务标题，版本列表升序去重；没记目标的老任务落在「未绑定目标」一组并永远排最后，不硬塞关系。侧栏 `TaskSidebar.tsx` 在工程模式下按目标分组渲染（目标名 + 版本 + 逐条任务状态点），并留「◈」开关一键退回时间平铺。会话行只挂到它绑定任务的目标上。**目标实体化（解除「同一 Goal 下 ≥2 Task」阻断项）**：首两轮真机发现现网没有任何两条任务共用一个 `goalId`——根因是目标口径只存在于各任务自己的契约里，没有可被多条任务指向的实体，`task-manager.create` 一律写 `goal:<taskId>`。新增 `store.goals`（`StoredGoal[]`，journal `version` 仍为 1，靠可选字段让老 `agent-store` 直接读通、不写迁移脚本）持有版本与成功标准的真源，任务上的契约降级为快照；读不到实体时按 `groupTasksByGoal` 现成口径懒迁移（取该目标下版本最高的契约派生），不批量刷盘、不凭空造版本，`listGoals` 只报仍有绑定任务的 goal。新建链路接受 `goalId/goalVersion/goalCriteria`，界面在目标契约卡上加「在此目标下新建任务」入口。`test:goal-view` 9 条 + 新增 `test:goal-entity` 11 条（实体读写、懒迁移、绑定继承、按 goalId 跨任务扇出、删除任务不删实体）均已并入 `verify`。真机（[验收汇总](acceptance/v4-p1-m1-20261127/SUMMARY.md)，探针 `2b0a189a` + `38be442b`）：侧栏分组渲染、「◈」`aria-pressed=true`、关掉后 `.goal-group` 归零且 `.task-item` 仍在列；界面点「在此目标下新建任务」真实产出第二条任务并绑定同一 `goal:2b0a189a`，分组里 2 条，`second-task-inherits-goal/-version/-criteria` 三条继承断言全绿，`store.goals` 落盘 `version:2` 带标准。**前提修复**：`task:submit` 过去无条件探网页通道再把 input 原样交给编排器，云端档下新建任务仍报「ChatGPT 未登录」，场景④ 断在第一步；现按 AGENTS.md §9.1 的源归属规则统一走 `pickPlanningAdapter`（经模块级 `planningLeadPicker` 暴露，与「会话转交工程」共用一份选人逻辑），只有网页/混合档才探页面，挑不出主导就点名报错，防回归并入 `test:cli-answer` |
| M1-3 目标变更影响面确认页 | `LIVE_TESTED` | `reviseGoal` 在 `requiresUserConfirmation` 分支除原有 warn 日志外，增发结构化事件 `goal.revision.pending`（`goalId`、`fromVersion→nextVersion`、`reason`、变更后标准原文、`impactedTaskIds` 与当时重建任务树里的受影响条目标题/状态、可继承条数），并加入 `store.ts` 的 `KEEP_FOREVER`——待用户回答的确认不能因事件裁剪而凭空消失。新增投影 `projectPendingGoalRevision()`（取时间最新一条；任务版本已追平 `nextVersion` 即认为已生效或过期不再弹卡；「暂不变更」不写库所以卡片仍在）与确认卡组件 `engineering/GoalRevisionConfirm.tsx`，确认走既有 `reviseTaskGoal(criteria, true)`，无新任务状态。`GoalContractCard` 的删标准不再用 `window.confirm` 只问一句，改为提交后由确认卡列出影响面。`test:goal-revision` 11 条（确认/取消两条路径、多 pending 取最新、非 pending 事件过滤、影响面按步骤与节点分账、四处源码守卫）已并入 `verify`。真机（[验收汇总](acceptance/v4-p1-m1-20261127/SUMMARY.md)）：契约 1 条标准时追加 1 条判 `clarify`、不要求确认、版本仍 v1；删标准判 `change` 且 `requiresUserConfirmation=true`、确认前 `goalVersion` 保持 v1；`goal.revision.pending` 落库带原文；确认卡显示「目标变更待确认 v1 → v2 · 确认前不抬版本、不改任务」，点「确认变更」后版本抬到 v2 且卡片消失。影响面呈现已按「可执行步骤 / 任务级节点」分账：新增 shared 纯函数 `partitionImpactedTasks()`（`wt-work-*`/`wt-group-*` 归节点，L2 子任务与步骤归可执行），确认卡只逐条列步骤，节点折成一行「另有 N 条任务级节点（任务本体 / 执行计划组）· 状态，随下属步骤一起重规划」，汇总数字仍取事件原文 `impactedTaskIds.length`；事件本体不改，折叠只发生在呈现层。真机复跑（探针 `0a429d96`）：受影响 2 条＝0 步骤 + 2 节点，卡片分账行与事件数字一致，步骤列表里不再出现同名「执行计划」。**目标扇出（场景④）**：`reviseGoal` 的受影响集合改为按 `goalId` 跨任务计算，确认后在同一事务里 `upsertGoal` + 逐任务 patch 版本与标准快照 + 逐任务发 `goal.revision.pending`，取消路径继续不写库；确认卡新增「本目标下 N 条任务一起生效」一行，事件带 `goalTasks`。真机（探针 `2b0a189a` + `38be442b`）：事件 `goalTasks` 2 条、卡片逐条列出两条任务与状态，点确认后第一条 v2、第二条同抬 v2 且两条标准完全相同（`fan-out-bumps-sibling-task`、`fan-out-shares-criteria`）；同一轮的影响面分账两类同时非零——「受影响 9 条： 可执行步骤 7 条，任务级节点 2 条。」与事件 `impactedTaskIds.length=9` 一致，步骤行逐条列出 `goal.get`/`session.search` 等，节点仍折成一行。**遗留观察**：本轮 6 个步骤全部终态（`inheritedCount=6`）但 `wt-work-*`/`wt-group-*` 仍是 `ready`——汇总节点状态没有从下属收敛，所以「全部做完」的计划重规划时仍会被列进受影响清单；属状态收敛问题，不在 M1-3 范围 |


## M1 里程碑判定

任务书的 M1 完成条件是三件事同时成立：三任务全部 `LIVE_TESTED`、同一 Goal 下 ≥2 Task、同一 Task 下 ≥2 Execution。最后一轮真机（探针 `2b0a189a`，50 项判定 0 失败）三件同时满足：M1-1/M1-2/M1-3 全部 `LIVE_TESTED`；同一 Goal 下 2 条 Task 由界面「在此目标下新建任务」真实产出并落在同一侧栏分组；同一 Task 下 3 条 Execution 且界面与投影同时刻一致。场景④（改标准 → 确认卡列出跨两条任务 → 确认后同抬 v2 并共用同一份标准）已验。**M1 判定完成**。剩余非阻断项：跨 `runId` 的独立重跑未覆盖、汇总节点状态不收敛（见缺口）、确认后不自动重开规划轮（缺口 5）。


## V4 P1 Engineering Runtime（M2：检查点续跑与上下文显性化）

| 任务 | 状态 | 事实 |
| --- | --- | --- |
| M2-1 检查点指针接线 | `LIVE_TESTED` | **前提修正**：任务书原写「暂停后 patch 任务 `{checkpointId, contextId, activeRunId}`」，核对代码发现 P0-4 落地时 `store.commitContextCheckpoint()`（`store.ts:441`）已在一次持久化里写完三项，`index.ts` 注入 `journal: store`，`task-recovery.ts` 也已优先读任务字段——缺口是反的：`orchestrator.ts:1013` 在 Journal 事务之后又 `tasks.patch({checkpointId, contextId})`，那是第二个写者且漏了 `activeRunId`，等于把权威指针盖成半套，恢复时 `recoverContext()` 的 runId 门判不过，出现「检查点文件在、任务读不出上下文」。现删除重复写者，`commitPauseCheckpoint()` 改返回完整指针 `PauseCheckpointOutcome`。① `context.checkpoint.paused` 事件新增 `contextId/activeRunId`，与 `checkpointId` 成对落库，使任务字段缺失时事件流本身即可重建指针；② 新增 `resolveTaskPointer()`：字段齐全走 `task-fields`，不全则倒扫事件流取最后一条带完整指针的检查点事件（暂停事件或 `context.compaction.committed`）走 `events-replay`，重建结果继续过同一套 runId/摘要 hash/归档校验，读不出即 `stale`，两者皆无判 `none` 不凭空造指针；③ 恢复结论带 `pointerSource` 并写进 `context.recovered` / `context.refresh.required` / `context.compaction.stale`，`recoveryPromptData()` 在走重放时如实标注指针来源弱于落库指针。**不做**启动全量对账：指针读不出时恢复已在校验处点名停下，提前扫描要多付全量磁盘读。**测试**：新增 `test:checkpoint-pointer`（4 条：字段↔文件一致、事件带指针、两条路径打点）；`test:pause-checkpoint` 扩到 7 条并修掉 harness 自身口径——过去 `emit` 只收数组不落 Journal，导致「靠事件流重建」这条路径在本能通过的代码上永远测不到，现与主进程同口径（转发即 `store.appendEvent`）；`test:context-recovery` 扩到 9 条（重建仍要过校验、无事件判 none、指针来源进提示词）。**真机**（[验收汇总](acceptance/v4-p1-m2-1-20261128/SUMMARY.md)，探针 `41d81e2d`，19 项判定 0 未通过）：暂停后任务三项指针与 `agent-store.json`、`owners/agent-task/<taskId>.json` 的 `contextId/runId` 逐项相等，暂停事件带同一组指针，检查点摘要「目标版本 v1 / 任务树 revision 3 / applied 1 · missing 0 · needs_reconciliation 1」且证据含真实写出路径；SIGTERM 停进程抹掉探针任务三项指针后重启，任务仍 `paused` 且指针为空，点继续产出 `context.recovered` 带 `pointerSource=events-replay`、重建 `checkpointId` 正是暂停那份、副作用账本 `applied 2 / missing 0 / needsReconciliation 1`。**遗留**：探针删除后 `context-checkpoints/owners/agent-task/` 累积 22 个孤立 owner 文件（M1 记录 11 个），回收并入 M2-2；「事件已落库、检查点文件未落」的窗口未覆盖 |
| M2-2 从检查点续跑成为常规路径 | `LIVE_TESTED` | **前提修正**：门槛不是字面的 `needsReconciliation==0`（账本分两档：有路径的 `fs.writeFile`/`fs.applyPatch` 落 `applied`/`missing`，无路径的 `shell.run`/`test.run` 等落 `needs_reconciliation`），且没有新增 `interrupted → executing` 转移边——续跑复用 resume 既有的 `paused/interrupted → executing`，状态机变化为零；真机探针另写 `verify-v4-p1-m2-2-cdp.mjs`（P0-5 那份走模型规划、步骤 id 每轮不同，命中不了「暂停时还剩 N 步」），改用固定工作流 14 步、暂停点定在 `write-4`。**新增** `src/main/context/recovery/continuation.ts`：`collectCompletedSteps()` 只认同轮 `started+completed`（同名步骤不跨轮误认）、`decideContinuation()` 逐条给理由（缺指针/文件不在/hash 不符/`missing>0`/有结局未知且无路径可核对的在途写/步骤已跑完）、`mergeReusedResults()` 把复用步骤还原成上一轮真实结果（无证据的保留 `skipped`，不把缺口判成已完成）。Runtime 侧加 `skipStepIds` 与 `step.reused` 事件（带 `checkpointId` 与真实时间戳），resume 判定为 continue 时直达执行不建新一轮，结论写进 `context.resume.continued`/`context.resume.replanned`（带 `pointerSource` 与理由）；灰度口径落在注入点 `AgentOrchestratorDeps.resumeContinue`（`orchestrator.ts:247`，`?.() ?? true`），改一行即回到「继续一律重规划」。**新增** `src/main/context/checkpoint/gc.ts` 关闭缺口 9/10：`deleteTaskContextArtifacts()` 删任务按 owner 回收检查点文件与归档段，`reclaimOrphanContextArtifacts()` 启动时只回收「任务表里查不到」的段（按归属文件比对不按时间猜，只扫 `agent-task`，会话归档不动），目标回收只认「最后一条绑定任务被删」。**界面**：context 事件标签/配色收进 `shared/context.ts` 的 `contextEventView()` 一处、两处投影共用（过去时间线与对话流各写一份表且都缺 resume 两类 → 续跑与被迫重规划都显示成「上下文事件」四个字）；新增暂停检查点里程碑（未落盘如实写「未提交」并标提醒色）、复用步骤标「复用自上次执行」、修 `target('fs.search')` 丢检索词。**真机跑出来的四个产品缺陷**（详见[任务书](plans/active/V4-P1-TASK-BOOK.md)）：① 没轮到的 `skipped` 步骤被当成副作用缺口 → 真机上「暂停→重启」必然重规划；② 暂停后迟到的报告把 `paused` 带去 `cancelled` → 点「继续」提示状态不允许；③ `reusedFrom` 没进 `StepResultSchema`（`.strict()`）→ 续跑第一份报告整体非法、`task:resume` 抛错，单测全绿因为假报告不经 IPC；④ 恢复走了哪条路界面看不出来。**测试**：`test:task-resume` 6→16、`test:pause-checkpoint` 7→14、`test:execution-timeline` 5→8、`test:task-conversation` 68→70、`test:protocol` +1；`test:protocol`(177) 与 `test:execution-timeline` 并入 `verify`（53→55 步，全绿 exit 0）。**真机**（[验收汇总](acceptance/v4-p1-m2-2-20261128/SUMMARY.md)，43 项判定 0 未通过）：A 续跑探针 `36ea5531` 暂停后 SIGKILL 重启，`context.resume.continued` 用正是暂停那份 `cp_33b18923…`（`pointerSource=task-fields`）、沿用被中断计划 `79289ed1…`、复用 6 步续跑 8 步、打点后 `round.started` 0 条、12 个写文件齐且收尾 `shell.run` 退出码 0、报告 14 步全 `completed` 其中 6 步带 `reusedFrom`、任务 `verifying → report_pending → completed`；B 反例 `9487adcf` 账本 `applied 1 / missing 0 / needs_reconciliation 1` → `context.resume.replanned` 点名「long-shell（needs_reconciliation）」并开新轮；两条路在「输出」时间线与「对话」流里都是可点开详情的行（截图 05/06/07，截图前已把命中行滚进视口）；活任务 owner 文件穿过启动扫描被保留、删任务 `checkpointsRemoved=true`、扫后无孤儿。**未覆盖**：`pointerSource=events-replay` 下的续跑（M2-1 只验到重建指针本身）与跨重启的 `budget_exhausted` 续跑 |

M2 还剩 M2-3（上下文重建显性化）未到 `LIVE_TESTED`，因此 M2 里程碑判定暂未成立。任务书的 M2 完成
条件里两条路径的真机证据（「暂停→强退→重启→续跑」与「→明确重规划」）与「UI 可核对上下文状态」
已由 M2-2 拿到，「上下文」独立视图归 M2-3。


## 目标契约证据闭环（GCE）

| 项 | 状态 | 事实 |
| --- | --- | --- |
| 架构/契约/ADR/UI/测试/灰度 | `DESIGN` | [架构](../architecture/V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md) · [契约](../spec/GOAL_CONTRACT_EVIDENCE_CONTRACTS.md) · [UI](../spec/GOAL_CONTRACT_UI.md) · [测试](GCE-TEST-PLAN.md) · [灰度](../operations/GCE-ROLLOUT.md) · [ADR 0011](../adr/0011-goal-contract-evidence-cycle.md) |
| 实施任务书 | `P1–P5 设计完成；P1–P4 已接线，P5 UI 已接线` | [P0–P5 任务书](V3-GOAL-CONTRACT-EVIDENCE-TASK-BOOK.md) · [P1](../architecture/GCE-P1-GOAL-CONTRACT-DESIGN.md) · [P2](../architecture/GCE-P2-CRITERION-EVIDENCE-DESIGN.md) · [P3](../architecture/GCE-P3-CYCLE-DECISION-DESIGN.md) · [P4](../architecture/GCE-P4-COLLABORATION-DESIGN.md) · [P5](../architecture/GCE-P5-UI-RECOVERY-DESIGN.md) |
| P0 现状审计 | 完成（只读） | [GCE-P0 审计](audits/GCE-P0-CURRENT-SYSTEM-AUDIT.md)：确认真实事件、投影阶段和 7 项缺口 |
| 真机验收 | 部分验证 | [GCE 验收](acceptance/gce/ACCEPTANCE.md)：固定工作流目标 MET 并交付；真实模型 PARTIAL 自动修复轮；General/Knowledge answered；目标修订 IPC v1→v2；目标卡鼠标交互已点验；应用重启恢复与 stale 投影已点验；三场景未在最新基线重跑 |
| Goal Contract | `IMPLEMENTED / TESTED / VERIFIED（固定工作流）` | `shared/goal-contract.ts` + `main/engineering/goal-contract-runtime.ts`：计划生成时建立契约，`AgentTask.goalContract` 持久化；`goal.contract.updated` 事件；工程目标卡支持修改成功标准，删减标准二次确认。 |
| Criterion / Evidence | `IMPLEMENTED / TESTED / VERIFIED（固定工作流）` | `shared/goal-evidence.ts` + 报告取证：全轮 `ExecutionReport` 并集 → Criterion 状态；MODEL_CLAIM 不能单独成立；`test:goal-evidence`、`test:goal-runtime` |
| 兼容层 | `IMPLEMENTED / TESTED` | 新增 `shared/goal-compat.ts`：GoalContract→EngineeringGoalView 单向派生、状态/Fit 映射、`goal.fit` 扩展；`test:goal-compat`（4） |
| 目标分解/参与门禁 | `IMPLEMENTED / TESTED` | `shared/goal-decomposition.ts` + 计划门禁：Criterion 保守映射到 L2/L3；MUST 无承接时加入计划警告且不自动批准；`test:goal-decomposition`（4）、`test:tdl-decomposition`（8） |
| Cycle Decision | `IMPLEMENTED / TESTED / VERIFIED（事件链路）` | `shared/cycle-decision.ts`：完整决策类型、诊断分层、无进展检测；Orchestrator 已发真实 `cycle.stage.*` / `cycle.decision.created`；旧四出口仍是执行选择器 |
| UI / 真机验收 | `IMPLEMENTED / TESTED（PARTIAL）` | 工程目标卡与协作结果面板显示 GCE Fit、逐条 Criterion、证据数；目标修订 IPC 真机验证（补充不抬版本、删除确认后 v1→v2），目标卡鼠标交互已点验；应用重启后 `goal.contract.stale` 清空旧 Criterion 并显示原因；General/Knowledge/Engineering 三场景已跑但未在最新基线统一重跑 |

> GCE 是设计冻结后的实施轨道，不改变现有代码事实；“已设计”不等于“已实现”。## 已验证的专项证据

- 长任务压缩、暂停/恢复和检查点恢复：[验收记录](acceptance/long-task-context/ACCEPTANCE.md)。默认仍关闭。
- DMOCA、GDC、Goal/TDL/ECO、GTEC、协作预算和主活动区：各专项真实验收入口见
  [acceptance/README.md](acceptance/README.md)。每份报告只适用于其注明的基线和样本。
- 原始 JSON / 截图 / CDP 记录集中在 [evidence/README.md](evidence/README.md)，不复制到状态表。

## 当前已知缺口

1. **主活动区 U7**：工程场景有验收记录；General/Knowledge 的完整真实场景验收仍未闭合。
2. **Knowledge**：跨会话索引复用、时效与知识地图的产品化仍有缺口；不能把 Memory 召回等同于 Knowledge 完成。
3. **长任务默认策略**：运行时功能可用但默认关闭；扩大真实场景覆盖后再决定是否改变默认值。
4. **ECO 恢复兼容性**：`Orchestrator.resume` 已用不兼容结果改判 `needs_context_refresh` / `needs_replan`
   并发对应事件；仍未强制同步重建包，刷新由下一轮规划的真实读取完成。
5. **Goal ↔ WorkTask 版本闭环**：任务创建写入 `goalId/goalVersion`，种树全量继承；目标口径由 `store.goals`
   实体持有（M1-2），任务上的契约是它的快照；版本递增、影响闭包与继承判定经 `task:revise-goal` 落事件，
   界面确认入口由 M1-3 的待确认卡提供；版本链核对覆盖 Goal→WorkTask→ECO→贡献→决策。仍缺「确认后自动
   重开规划轮」——目前只重打版本，下一轮要用户手动继续。
6. **Workflow**：注册表、条件/循环/审批与 `workflow:run` 已接线；但 `until` 运行时循环不支持（明确报错），parallel 为串行执行，且没有界面入口。
7. **深层 Java 分析**：AST/类型绑定/调用图不属于当前已交付能力。
8. **发布门禁**：签名、公证、干净机器安装和发布回滚仍需完成。
9. **检查点残留**（M2-2 已关闭）：原缺口是 `store.deleteTask()` 只清 tasks/rounds/plans/reports/events，
   磁盘上的检查点归属文件不受影响，checkpoint store 也没有删除接口——M1 收尾实测 owner 目录 11 个文件
   对应用户任务 0 条，M2-1 收尾复测涨到 22 个（每跑一轮真机验收就多攒几条）。现由
   `src/main/context/checkpoint/gc.ts` 两处收口：删任务时 `deleteTaskContextArtifacts()` 按 owner 回收
   检查点文件与归档段，启动时 `reclaimOrphanContextArtifacts()` 只回收「任务表里查不到」的段（按归属
   文件比对、不按时间猜，且只扫 `agent-task`，会话归档不动）。M2-2 真机实测（[验收汇总](acceptance/v4-p1-m2-2-20261128/SUMMARY.md)）：
   默认数据目录 `owners/agent-task/` 已由 22 个降到 **0 段**，两个探针任务删除时 `checkpointsRemoved=true`、
   `archiveSegments=0`，扫后无孤儿归属文件（`disk-has-no-orphan-after-run`），且暂停中的活任务
   `36ea5531-…` 的 owner 文件穿过重启扫描被保留。仍在的只有 `owners/conversation/b614fc2e-….json` 1 段
   ——会话生命周期，不在本回收口径内。
10. **目标实体残留**（M2-2 已关闭）：原缺口是 `store.deleteTask()` 不清 `store.goals`，M1 收尾实测
    用户任务 0 条而 `store.goals` 仍有 6 条孤儿实体（`ea994813`/`22713ed3`/`b5cd244e`/`b4ed7aee`/
    `514d0787`/`2b0a189a`）。现在回收只认「最后一条绑定任务被删」这一条判据（`reclaimOrphanContextArtifacts()`
    同事务里比对任务表），不按活动新旧猜。M2-2 真机实测：默认数据目录 `store.goals` **0 条**（M1 那 6 条
    已随启动扫描清掉），探针目标 `goal:36ea5531…`/`goal:9487adcf…` 在删任务后不再存在；
    `test:pause-checkpoint` 的「目标回收只认『最后一条绑定任务被删』」用例守住多任务共用同一目标时不误删。

这些缺口按计划排序见 [plans/README.md](plans/README.md)。某项代码变动关闭缺口时，应同步补测试、状态和对应验收证据。

## 文档权威关系

| 文档 | 只负责 |
| --- | --- |
| `PRODUCT.md` | 产品目标和取舍 |
| `ARCHITECTURE.md` | 当前代码结构与数据流 |
| `architecture/` | 领域目标架构；不声明当前完成度 |
| `spec/` | 规范、类型和行为契约 |
| `adr/` | 架构决策 |
| **本文件** | 当前实现/测试/验证/缺口 |
| `implementation/acceptance/` | 特定基线和场景的验收记录 |
| `archive/` | 历史计划、评审和快照，不约束当前实现 |
