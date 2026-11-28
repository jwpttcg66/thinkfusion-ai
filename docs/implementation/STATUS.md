# ThinkFusion 实现状态

**唯一当前状态来源**。快照对应 `main` 于 2026-11-28 合入 V4 P1 M3-3（合并点 `bf03d1f`）之后、任务分支
`v4/p1-m3-4-continuous-loop` 收口 M3-4 时的状态；此前记的 `e769af8`（M3-2 合并点）、`add2be9`（M2-3 合并点）、
`b39a587`（M2-2 合并点）、`5e72934`（M2-1 合并点）与 `b15ee56`（2026-11-27，目标卡鼠标交互与恢复契约核对）
已随 M1/M2-1/M2-2/M2-3/M3-1/M3-2/M3-3 七次合并过期。代码、测试和真实验收变化时更新本页；
不要在其他文档另建阶段完成度表。

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
| 长任务上下文 | `IMPLEMENTED / TESTED / VERIFIED` | 摘要、裁剪、检查点、恢复和副作用核对已实现；重启后优先从检查点续跑、续不了点名到步骤（M2-2），「统计」页「上下文」段可核对指针来源、核对结果与重建原因（M2-3）；默认关闭，优先级为 env > `context-manager.json` > 默认值 |
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
| M2-3 上下文重建显性化 | `LIVE_TESTED` | **前提修正**：任务书写「投影扩展落在 `src/shared/task-view.ts`」＋「测试＝投影测试＋组件测试」，核对代码后改为另建 `src/shared/context-state.ts`（`TaskView` 是逐事件增量折叠，这一栏要整份历史的全貌：多次暂停留多行、同刻按 `sequence` 保序、「暂停只给了待核对条数」要投影成 `null`），「组件测试」按本仓库惯例落成 5 条源码守卫＋真机按格读数（渲染层无 DOM 测试设施）。**新增**只读投影 `projectContextState(events) → ContextStateView`（contextId 取最新非空值并记下来源事件、`checkpoints[]` 分 pause/cancel/compaction 三类、`rebuilds[]` 覆盖 recovered/refresh-required/resume-continue/resume-replan/compaction-stale/checkpoint-missing、`lastReconciliation`、`budget`、`entries[]` 留原文 payload 作 §8 详情检查入口；措辞一律取自 M2-2 收敛的 `contextEventView()`，取不到的字段是 `null` 不是 0）；**新增** IPC `task:context`（`index.ts:3630`，`trustedUiSender` + `TaskIdSchema.parse`，读 `store.listEvents(id)`，不碰 orchestrator/不写事件/不落盘/不读检查点文件；取数口径同 M1-1 `task:executions`——界面那份事件流按配额裁剪过，读它会让早先的暂停存档"消失"），链路六处同步（contracts/preload/mock-api/global.d.ts/IPC.md）；**新增**「统计」页折叠段 `TaskContextCard.tsx`（10 格台账＋重建经过逐行带指针来源标签、原因、账本、`resume.reasons` 清单与可展开步骤清单＋逐条原文 JSON＋空态与口径说明）。**真机跑出来的三处需修**（都不是"功能没做"）：① 摘要行渲染成「上下文 上下文 …」（标题重复且 `pause:<taskId>:<ts>` 长串挤掉后两句）→ 摘要改说「N 条 context 事件 · 最近检查点 … · 核对 …」；② 探针在卡片自身 `getTaskContext` 的加载态就取数、拿到 8 个字符的壳子（照此判定会把功能判死）→ 判据等 `loading/errorText` 消失并把两者记进证据；③ 重规划行行头写「复用 0 步 · 本轮执行 0 步」，把"整轮作废"说成"这一轮没干活"→ 改「不复用上一轮步骤」。**测试**：新增 `test:context-state` 18 条（13 投影＋5 守卫：投影纯函数且不引用契约外的 `context.*` 名字、处理器只读、四处口径对齐、折叠段挂载与目标字段齐全、缺失写「未记录」），并入 `npm run verify`（55→**56 步**，exit 0）。**真机**（[验收汇总](acceptance/v4-p1-m2-3-20261128/SUMMARY.md)，47 项判定 0 未通过）：探针 A `275e5b15` 暂停后事件/投影/磁盘 `owners/agent-task/275e5b15-….json` 三方 `cp_8af45f5d…` 逐项相等（磁盘账本 applied 6/missing 0/nr 0），界面暂停点写「存在 未记录 · 已消失 未记录 · 待核对 0」＋口径说明、「上次重建」未重建、「续跑判定」没有点过「继续」；点继续后 `context.recovered`（`pointerSource=task-fields`、applied 7/missing 0/nr 0）与 `context.resume.continued`（沿用计划 `3bb24e9c…`、复用 write-1…6、本轮 write-7/8）原样落到五格里，重建经过两行都带「指针来自任务字段」、步骤清单展开到具体步骤 id，逐条原文 3 条含 `sideEffects`；探针 C `56f93127` 账本 `applied 2 / missing 0 / needs_reconciliation 1` → 界面「已重新规划：检查点不足以安全续跑」＋提醒色 `t-warn`＋行头「不复用上一轮步骤」＋理由点名「long-shell（needs_reconciliation）」＋「存在 2 · 已消失 0 · 待核对 1」，被拒的 `cp_0637ddb5…` 仍留在最近检查点栏；探针 B（没暂停过）`hasEvents=false`、界面只说「没有记录到上下文事件」且原文不串出 A 的检查点 id；只读性由「同一任务连读两次投影完全一致」守住；三探针删任务均 `checkpointsRemoved=true`、`owners/agent-task/` 回到 0 段、任务数 1→0。截图 01–05（截图前把命中行滚进视口）。**未覆盖**：`pointerSource=events-replay` 下这张卡的读数、跨重启后这张卡的读数、`budget` 水位与 `context.refresh.required` 的真机样本；另记录一条本案外的观察——两个探针（A 续跑、C 重规划）收尾时均为 `failed` 且未采到原因事件（验证链需要模型规划源），列为 M3-1/M3-2 的输入 |


## M2 里程碑判定

任务书的 M2 完成条件是三件事同时成立：三任务全部 `LIVE_TESTED`、「暂停→强退→重启→续跑」与
「暂停→强退→重启→明确重规划」两条路径都有真机证据、UI 可核对上下文状态。三件已分别落到证据：
M2-1/M2-2/M2-3 全部 `LIVE_TESTED`（19/43/47 项判定，0 未通过）；两条路径由 M2-2 在同一轮真机里
都经过 SIGKILL 停进程再重启——续跑正例探针 `36ea5531` 点「继续」后复用 6 步续跑 8 步、沿用被中断的
计划且 14 步全 `completed`，重规划反例探针 `9487adcf` 因账本留下 `needs_reconciliation 1` 判成
`context.resume.replanned`、理由点名 `long-shell（needs_reconciliation）`并新开一轮；UI 侧由 M2-3 的
「上下文」折叠段把暂停存档、恢复核对结果、续跑/重规划判定与理由逐格显示出来（探针 A `275e5b15`、
B `464b50b0`、C `56f93127`，截图 01–05），卡片只读、数字全部来自持久化事件，与磁盘检查点文件三方一致。
**M2 判定完成**。剩余非阻断项：① 这张卡在 `pointerSource=events-replay` 下的读数未采样（M2-1 验到重建指针本身、M2-3 只验到 `task-fields`，两者共用同一份 `projectContextState()` 与同一格呈现）；② 跨重启后这张卡的读数未采样——取数走 `store.listEvents()` 而非渲染层那份按配额裁剪过的事件流，在线与刷新后读的是同一份落库事实，但本案没有重启后再截图；③ `budget` 水位与 `context.refresh.required` 只有单测口径、无真机样本；④ 探针 A（续跑）与 C（重规划）收尾时均为 `failed`
且未采到原因事件（现象指向验证链需要模型规划源），与上下文卡无关，列为 M3-1/M3-2 的输入；⑤ 临时目录（`os.tmpdir()`）下 M2-2/M2-3 的探针工作区（10 + 6 个）按 §5.1 不自动清理，默认数据目录已核对为 0 任务 / 0 目标 / 0 owner 段。


## V4 P1 Engineering Runtime（M3：周期判定收敛、反空转、预算与持续循环）

| 任务 | 状态 | 事实 |
| --- | --- | --- |
| M3-1 周期判定收敛为一个出口 | `LIVE_TESTED` | **前提修正**：任务书说「双轨」，核对代码是三条轨——`decideNextEngineeringAction`（`goal-driven-cycle.ts:152`，四出口，决定行为）→ orchestrator 里一段三元映射翻译成 11 值枚举 → `emitCycleDecision`（只是事件发射器，`decisionType` 由调用点硬编码），而「权威」纯函数 `decideCycleAction` 零生产调用；更致命的是它的输入 `diagnosis`/`progress` 在生产里从来没有来源，直接接上会让所有轮次落到 `WAIT_USER`，故拆成 M3-1a（补输入）+ M3-1b（收出口）。**新增** `CycleDecisionResult.nextAction`（`finish_completed｜open_next_round｜stop_and_wait｜fail_budget｜fail_delivery｜abort`）与标签 `FAIL_DELIVERY`，`requiresUser` 由落点推导而非标签推导（同为 `BLOCKED`，版本链冲突是停下等人、预算耗尽是判死）；**补齐两个输入**：`deriveCycleDiagnosis(facts)` 用结构化事实（GCE 未覆盖标准数、验证三查、报告状态、失败步骤、错误码、评审问题）翻译七值病因且不看模型自述，`detectNoProgress` 的上一份进展从事件流读（`lastCycleProgress()`）故重启不忘记；**事件扩全** `cycle.decision.created`（`reason/evidenceRefs/nextAction/requiresUser/targetStage/diagnosis/progress/goalFit/budget`，取不到记 `null` 不用 0 冒充，生效阈值随 progress 落库）；**删除** `emitCycleDecision()` 与手写映射，换成 `decideAndEmit()`，`cycle.snapshot.decision` 必须等于 `legacyDecisionOf(decisionType)` 且非收尾时 `nextAction` 逐字等于事件 `reason`（源码守卫判失败）；**判定句单源** `CYCLE_NEXT_ACTION_TEXT` + `latestCycleDecision()`/`cycleDecisionText()`，任务侧「工程目标」卡与对话侧结果面板渲染同一句话，两个组件都不得再出现 `finish_completed:` 字面量。**测试**：新增 `test:cycle-decision`（21 项，含源码守卫）并入 `verify`。**真机**（[验收汇总](acceptance/v4-p1-m3-1-20261128/SUMMARY.md)，21 项判定 0 未通过，同一进程两轮）：两轮判定 `REPAIR→open_next_round`、`COMPLETE→finish_completed` 字段缺失 0 项，`file:`/`cmd:`/`evidence:` 引用逐条对上磁盘与事件流，progress 反算逐字段相同，`open_next_round` 后有新 `round.started`、`finish_completed` 后有 `task.completed`，事件流 diff 95 增 1 移除存证。**遗留**：`plan.invalid` 白烧一轮（模型多写 `dependsOn`/`expect`/`checksCategory`，计划 zod strict 整份拒绝）；`isNoProgress()` 命中时仍可能返回 `REDESIGN`/`REANALYZE`（M3-2）；预算见底仍给 `fail_budget`→任务落 `failed`（M3-3） |
| M3-2 反空转激活 | `LIVE_TESTED / PARTIAL` | **前提修正**：任务书「测试构造 3 轮同证据」在真机上拿不到——探针每轮都在换工具（`fs.writeFile`×6+`shell.run` → `session.search`/`fs.tree`/`fs.search`/`fs.find`/`git status` → `fs.tree`/`fs.search`×3/`fs.find`×2），三轮 `progress.repeated` 恒为 0，空转是靠第二维度 `criterionStalled`（未满足标准集合连续不变）触发的；「同证据 3 轮」留在离线用例按默认阈值 2/2 覆盖，真机这轮反而更硬（换了手段却没推进任何标准，正是只按重复调用判空转会漏掉的那类）。真机另把阈值下调 1/1 以把用例从 70+ 分钟压到 30 分钟，触发轮数不由真机证明。**新增/改**：`orchestrator.ts` 抽出 `previousReport(report)`（原来错在拿 store 里「最后两份」当相邻两轮，续跑或 `plan.invalid` 吃轮后 streak 会跳错，第二次空转可能被算成第一次而少停一轮）；`cycle-decision.ts`（+227 行）加四类病因与 `CYCLE_NO_PROGRESS_CAUSE_TEXT` 单源文案，判定理由点名「连续无进展（原因分类：X，这是连续第 N 轮）」，`noProgressCause` 进事件且无分类记 `null` 不省键；无进展只许 `REPLAN`/`WAIT_USER`（`CONTINUE`/`REPAIR`/`COMPLETE` 全禁），自动重规划只给一次机会（`streak≥2` 必 `WAIT_USER`；`missing_permission` 不给重规划；第一次就停手也判失败）；`buildReportPrompt({noProgress})` 把判定原话 + `#<退出码>` 禁止重复清单真正下发到下一轮计划请求；`resolveNoProgressLimits({env,config})` 优先级 env > `userData/no-progress.json` > 默认 2/2、脏值回退默认并记录，宿主注入 `noProgressLimits: () => …`（`index.ts:6255`，守卫用例断言必须是函数形式而非启动时快照）；轮次用途按判定标签映射 `roundPurpose`（原来写死「进入下一轮修复」，`REPLAN` 轮也这么说）。**测试**：`test:cycle-decision` 21→28 项、`test:repair-loop` 11 项，`npm run verify`（59 步）exit 0。**真机**（[验收汇总](acceptance/v4-p1-m3-2-20261128/SUMMARY.md)，18 项判定 / 17 通过 / 1 未通过，同一进程）：15:17:03 `REPAIR→open_next_round`（`criteriaStreak 0`、无分类，不误伤）→ 15:25:51 `REPLAN→open_next_round`（`missing_context`、streak 1、下一轮计划请求 6176 字节含「系统判定：」）→ 15:31:34 `WAIT_USER→stop_and_wait`（streak 2、无新轮、日志「GDC 停在待确认：」与事件 `reason` 逐字相同），任务停 `report_pending` 未判死，「工程目标」卡 472 字符判定句与最新事件逐字对齐，三条判定 progress 反算逐字段一致，`no-progress.json` 跑完已恢复为不存在。**未通过的一条是产品缺口不是用例错**：B 段阈值热切 99/99 后从「继续修复」接回去被主进程拒绝「这一轮已经完成全部检查，不需要继续修复」——第 3 轮报告 `verified:yes` 而 compile/run/tests 三项全 `skipped`，`resumeRepair()` 前置门禁要求「验证尚未完成」，于是判定说「停下等你决定」却没有「再来一轮」的用户入口（只剩「接受未验证并结束」与取消）；故「关得掉」只证到配置侧，用户侧归 **M3-4**。另两条如实标注：`a-threshold-applies-without-restart` 是本轮跑完才加的断言，且第一版把配置写在 `startDev` 之前（那只能证明文件读得到、证不到不用重启），已把写入挪到渲染进程连上之后并用 `rendererReadyAt`/`configWrittenAt` 时间戳判定，**本轮不认领现场热生效**；快败与删除回执同样是 run 5 之后补进脚本的，所以 `evidence.json` 留下的是 B 段等待超时而非 `b-hot-threshold-pending-m3-4` 标记。第 1 具探针 `7af5a428` 因「模型连续 120 秒没有输出」落 `task.failed`（终态）后重建第 2 具才跑完，两次尝试原文留在 `evidence.phases[0].attempts`。**收尾**：run 5 抛错导致探针 `5c8edc7b` 残留在默认数据目录，已另起短生命周期实例走 `cancelTask`+`deleteTask` 删除并核对（store 任务 0 条、`owners/agent-task` 为空） |
| M3-3 Budget Manager 收敛 | `LIVE_TESTED` | **前提修正**：① 任务书写「新 `src/shared/budget.ts`」，实际落在 [src/shared/task-budget.ts](../../desktop-agent-macos/src/shared/task-budget.ts)——`budget` 这个名字在仓库里已被上下文预算（`context.ts:39`）与编码迭代预算（`CycleSnapshot.budget`）占用，同名模块会让「还能不能再开一轮」与「上下文还剩多少」再次混用；契约文档已把两种口径分开注明（§9.5 与 `CycleSnapshot.budget` 的注释）。② 任务书说「默认继承现状不设限」，实况是 `task.maxRounds` 默认 **20** 且被六处算术各读各的，改成不设限等于放宽现网行为，故默认值原样保留（`DEFAULT_TASK_BUDGET`）。③ 任务书说「超限 → `PAUSE` + `budget_exhausted`，状态机已有该状态与恢复路径」，实况是那条恢复路径**没人走得进**：`fail_budget` 落 `transition(..., 'failed')` 是终态，`budget_exhausted` 只能从 `created/planning/executing` 进入，界面上「追加预算或结束」的文案对着一条死边。④ 任务书要「累计模型调用次数、token 已知值」，实况是主进程根本没有任务级模型调用计数，`round.peer.usage` 的 token 只覆盖辩论成员——两条都如实传 `null` 记「未记账」，不伪造数字也不因读不到就判超限。**新增**：纯函数 `normalizeTaskBudget`/`budgetStateOf`/`canOpenRound`/`extendTaskBudget`（脏值回落默认并留 `dirty[]`、未写的维度是「不设限」不是「上限 0」、追加只增不减）；`TaskManager.budgetView()` 为唯一读点、`extendBudget()` 为唯一写点（写盘 + 发 `task.budget.updated`）；决策出口新增 `PAUSE`/`pause_budget`（`legacyDecisionOf('PAUSE')='observe'`，兼容镜像不再判死）；唯一超限落点 `Orchestrator.pauseOnBudget()` → 状态 `budget_exhausted` + `task.error` 说清「为什么停、怎么回来」+ `task.budget.exhausted` 事件（带 `reason`/`budget`/`budgetUsage`）+ warn 日志；`decideAndEmit()` 的预算输入与事件读数取自**同一次** `budgetView()`（原来 `used/limit` 由调用点各算各的，可以与判定布尔悄悄不一致）；**删除** orchestrator 里六处轮数比较（`:1455/:1485/:3004/:3325/:3502/:3611`）与 `fail_budget` 判死分支，改为 `resume` 前、计划自纠前、报告后判定共用同一道门禁；状态表补齐九条进 `budget_exhausted` 的边（`executing/verifying/report_pending/awaiting_next_round/planning/paused/interrupted/blocked`）；IPC `task:set-budget`（`SetTaskBudgetSchema` strict：正整数、至少指出一条维度、多余键拒绝）+ preload `setTaskBudget` + 活动流旁注「预算用尽，任务已暂停 · <读数>」与折叠详情「追加预算后可继续，或直接结束任务」+ 统计页预算卡（`未设限`/`未记账`/卡头 `已用尽：轮数`/停手后才出现的「追加并继续」入口），`docs/IPC.md` 加该入口行。**测试**：新增 `test:task-budget`（11 项，含两条源码守卫：orchestrator 里 `>= task.maxRounds`/`rounds.length >=` 必须为 0 处、事件与状态表与写路径齐备）并入 `verify`；`npm run verify`（59 步，含三份 tsconfig 全量 typecheck）exit 0、916 项用例 0 失败。**真机**（[验收记录](acceptance/v4-p1-m3-3-20261128/EVIDENCE.md)，41 项判定 0 未通过，墙钟 45 秒，默认数据目录）：脏值六条各自点名被拒（`0`/`-2`/`1.5`/`"12"`/一条维度都不给/多余键 `nonsense`）；追加到 25 轮后 `task.budget.updated` 的 `gate.reason`「轮数 1/25」与脚本用同一批纯函数反算逐字相同、落库与显示别名同步；填小（1）被拒且原值仍可读；给模型调用设上限 40 后界面读「未记账」、门禁 `ok:true` 且理由点名「模型调用已设上限但没有调用计数」（既不判超限也不当 0）；停进程改探针落库为「轮数 1/1 + 无当前计划 + interrupted」后重启走常规 `task:resume` → 状态 **`budget_exhausted`（不是 `failed`）**、`task.budget.exhausted.reason`=「轮数 1/1，模型调用已设上限但没有调用计数」＝反算、停手期间轮数 1→1 未偷开轮、旁注与折叠详情同时给出「为什么停/怎么回来」、卡头「已用尽：轮数」且追加入口在场；追加到 3 轮后 gate 放行并接回循环（状态 `planning`、轮数 **1→2**）、卡头回到「仍可开新一轮」读数 2/3；探针删净（store 任务 0→0，工作区已移除）。**超限前置条件是造出来的**：默认 20 轮在验收窗口内不可能自然跑满，故动盘备份后只改探针任务自己的记录（备份 `agent-store.before.json`，按 `.gitignore:51` 不入库），判定/落点/事件/界面代码路径一行未绕。**未覆盖**：① 20 轮自然跑满的真路径未采（门禁本身已证，缺的是「跑到默认上限」这一小时级样本）；② token 维度无真机样本（现网确实不回报）；③ 「追加预算后一路跑到完成」未证，本轮只证到真的开出下一轮，无人值守推进归 M3-4 闸门；④ A 段探针再次因「模型连续 120 秒没有输出」落 `failed`（与 M3-2 同一现象，列为 M3-4 输入）；⑤ `TaskProgressCard.tsx` 已无引用（任务级 `error` 原本只有它渲染），暂停提示的实际入口是统计页预算卡与活动流旁注 |
| M3-4 持续循环 | `LIVE_TESTED` | **前提修正**：① 任务书写「任务级 `autoContinue`（默认关）」在存量数据上做不到——该字段本轮新增，老存档根本没有它，把「读不到」当 `false` 等于给每条存量任务悄悄改了行为（原本会自开下一轮的升级后全停在「等你继续」），故 `autoContinueOf()` 只认显式 `false`（[src/shared/task-continue.ts:76](../../desktop-agent-macos/src/shared/task-continue.ts#L76)），缺省按自动续轮算；「默认关」只在「新建任务后开关在统计页看得见、拨一下即落库并发事件」这个意义上成立。② 要补的出口比任务书多一个、且两个落点都得补：`report_pending` 的「继续修复」先过 `verificationIsComplete`，四类检查全过但目标仍有未满足标准时当场抛「这一轮已经完成全部检查」——这正是 M3-2 的 `b-resume-fired` 未通过项；而关档落点 `awaiting_next_round` 原本不在 `DELIVERY_CLOSE_STATUSES` 里，**关掉自动续轮的人比留着的人少一条收口出口**，只剩「白烧一轮去够那颗按钮」与「取消（把已交付的记成没交付）」。③ 「瞬时通道故障不该判死」不是一个 `if` 而是四个判死口：关键词表漏中文（生产方自己把网络异常包成中文，`providers/openai-compatible.ts:648`、`ollama.ts:635`，run 8 现场那句「主导模型五段汇总失败：连不上 https://api.scnet.cn…」里 `fetch failed`/`ECONNREFUSED` 一个都没有，判成 `task_fault→failed`）；`approve` 与「恢复执行」两条 `catch` 直接 `fail()`；零步骤报告走显式 `failed`；`budget_exhausted`/`blocked` 缺 `→interrupted` 边使 `transition()` 抛错，而 `fail()` 兜底**只补发 `task.failed` 事件不写状态**——行还停在非终态、事件流却说它已死，列表显示「已失败」而这条其实还能 resume。④ `plan.invalid` 白烧一轮的根因是 `StepSchema` 每分支 `.strict()`（真机样本 8 步全带 `dependsOn`/`expect`，5 步带 `checksCategory`），不是模型乱写。**新增**：IPC `task:set-auto-continue`（`index.ts:3704`，`SetTaskAutoContinueSchema` strict 且只收布尔——字符串 `"false"` 在代码里 `!== false` 会显示成「已打开」）+ `task:continue-round`（`index.ts:3696`，只对 `report_pending`/`awaiting_next_round` 开放，指令非空白 ≤2000 字，不重跑 GDC 判定但照过 M3-3 预算门禁，新轮 `inputType='user_continue'` 带用户原话 + `meansOfRound()` 的上一轮手段清单）；关档落点 `transition→awaiting_next_round`（`orchestrator.ts:3777`，已在该状态不再自环）+ 事件 `task.round.await_user`（带 `purpose`/`reason`/`gate`）；`classifyFault()` 六类病因→三个可恢复落点（`channel_stall`/`channel_timeout`/`channel_context_full`→`interrupted`、`source_disabled`/`plan_unusable`→`blocked`、仅 `task_fault`→`failed`）+ `stopIntent()` 保住用户已选的暂停/取消结局 + 统一 `task.fault.stopped`（`kind`/`error` 原文/`landedStatus`/`headline`/`howBack`）；`page-driver.ts` 把设置里那句原话递到 `adapterFor` 使 `SOURCE_CLOSED` 认得出来（`src/shared/task-fault.ts:59`）；`IGNORED_STEP_KEYS` + `describeIgnoredAnnotations()` 接住说明字段并在界面明说忽略了什么（`dependsOn` 声明的依赖执行器**不会强制**，这句必须可见）；「为什么停/怎么回来」单源 `continueExitText()`，活动流旁注与统计页念同一句；状态表补 `budget_exhausted→interrupted`/`blocked→interrupted`/`awaiting_next_round→completed` 三条边、`fail()` 兜底改成「要么真写终态再发事件，要么只留日志」；`store.ts` 的 `KEEP_FOREVER` 纳入 `task.auto_continue.updated`/`task.round.await_user`/`task.round.user_continue`/`task.fault.stopped`；顺带修三处（`PlanPreview` 告警原来固定念一句「计划缺少判据」、切任务时上一条续轮指令串到下一条输入框、`task:set-budget` 回执读的是改前快照）。**测试**：新增 `test:task-fault`（28 项）+ `test:task-continue`（22 项）并入 `verify`；两条守卫从「正则扫源码」挪到「真跑」（状态表用真 `TaskManager` 走 `planning→…→awaiting_next_round→completed` 全链；`fail()` 用内存 orchestrator 断 `blocked`/`budget_exhausted` 遇通道故障只留 fault、`task.failed` 0 条，对照组仍落 `failed` 且恰好一条）；并修掉一条会误伤的旧守卫（`check-goal-revision.mjs:103` 把 `KEEP_FOREVER` 钉成「名单最后一条」）。**真机**（[验收汇总](acceptance/v4-p1-m3-4-20261128/SUMMARY.md)，run 13 / 51 项判定 **0 未通过** / 3 跳过，墙钟 965 秒，默认数据目录 + CDP 9334 同一进程，通道按用户指示用 Qoder CLI v1.1.101）：开关四条脏值全拒并点名 zod 路径；关掉真落盘（回执 `{autoContinue:false,previous:true}`、落库 `false`、事件 1 条、界面读数「停在轮次开始前，等你点「继续下一轮」」）；`task:continue-round` 四条越界拒且没偷开轮，`report_pending`→轮数 **1→2**、新轮带用户原话与 `fs.list path=.` 手段清单、`gate` 读数与纯函数反算逐字相同；SIGSTOP 停住 CLI 子进程（pid 94738）后现网看门狗说出「模型连续 120 秒没有输出」→落 `interrupted` 且 `task.failed` **0 条**、旁注与折叠详情给出「为什么停/怎么回来」、「继续任务」真接回（`planning`、轮数 1→2）；**两个方向各自有现场**——没碰开关的探针判定 `REPAIR/open_next_round` 后 0 次点击自动开出 `execution_report` 轮，显式拨关的探针（`9bdcf62b`）同一判定停在 **`awaiting_next_round`**、`task.round.await_user` 与界面原文「判定要开下一轮，按你的设置停在这里」及该状态多给的「接受未验证并结束」出口同场实拍（`06-awaiting-next-round.png`）、轮数 1→1；`plan.invalid` 本轮 **0 次**（M3-2 一轮里 2 次），前四里程碑真机原文 5 条通道错误回放当前分类器落点 `channel_timeout→interrupted`、仍判死 `[]`；收尾四条基线断言全绿（任务 0→0、会话 0→0、探针会话 5 条 0 残留、工作区移除）。**未覆盖**：① `source_disabled→blocked` 无现网样本，且已查清不是「没撞见」——F 段指定关着的 `deepseek` 却被上游提交门禁（`orchestrator.ts:479` 探默认适配器，选不出成员就退回当前开着的那条页面）判成「ChatGPT 未登录」，`model-route.ts:181` 那句正确提示轮不到执行，属通道选择层，记为后续项（任务书 M3-4 落地校正 4）；② P1 闸门的 ≥2 小时无人值守按用户指示暂缓，多轮自动推进样本最多到 2 轮；③ 「同一条任务从开→关→停一路走下来」未串采（落点由 G 段独立探针取证）；④ token/模型调用计数仍不回报（M3-3 遗留）；⑤ run 11/12 两轮因我把真机 harness 并发跑在同一 dev 实例上而作废（`FAIL tasks-back-to-baseline`、`SKIP e-default-auto-open`、F 段误删下一轮探针会话），采信 run 13，教训写在汇总「收尾补做」 |

## M3 里程碑判定（M3-1…M3-4 全部 `LIVE_TESTED`；闸门仅剩「≥2 小时无人值守」一项，按用户指示暂缓）

任务书 M3 的完成条件是 M3-1…M3-4 全部 `LIVE_TESTED` 且 P1 闸门（一次 ≥2 小时无人值守任务：多轮自动推进、≥1 次失败修复、≥1 次空转检测或预算暂停、≥1 次用户介入后继续、最终 GoalFit 结论）有真机证据。当前四条全部 `LIVE_TESTED`：M3-1（21/21）、M3-2（17/18，唯一未通过项 `b-resume-fired` 是产品缺口，本轮由 M3-4 的「换手段再来一轮」补上并真机通过）、M3-3（41/41）、M3-4（51 项判定 0 未通过 / 3 跳过）。闸门要素的对账：**≥1 次空转检测**由 M3-2 现场满足、**≥1 次预算暂停 + 介入后继续**由 M3-3 满足（前置条件由改盘制造）、**≥1 次用户介入后继续**由 M3-4 的 B 段满足（`report_pending`→轮数 1→2、原话与手段清单进请求）、**多轮自动推进**由 M3-4 的 E 段满足（缺省即开，0 次点击自动开出 `execution_report` 轮）并由 G 段证到反方向（关档时同一判定停在 `awaiting_next_round` 且不偷开轮）、**≥1 次失败修复**由 M3-1/M3-2 的 `REPAIR→open_next_round` 现场覆盖。**未采**：≥2 小时连续无人值守、跑满 20 轮默认预算、以及随之而来的最终 GoalFit 长任务结论——按用户 2026-11-28 指示暂缓，样本目前最多到 2 轮；`token`/模型调用计数维度仍不回报（M3-3 遗留）。**M3 判定：代码与既有取证口径完成，闸门时长项挂起**，P1 整体判定须等那次小时级长跑之后另写。


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
