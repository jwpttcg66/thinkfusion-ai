# ThinkFusion 实现状态

**唯一当前状态来源**。快照对应 `main@b15ee56`（2026-11-27，目标卡鼠标交互与恢复契约核对）。代码、测试和真实验收变化时更新本页；不要在其他文档另建阶段完成度表。

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
| M1-1 Execution 显式化 | `LIVE_TESTED` | 新增 `desktop-agent-macos/src/shared/execution-history.ts` 纯函数投影：`rounds + reports + events` → 按轮次分组的执行台账。口径为「一次执行＝一轮」，同轮多份报告合并成一条（结论取最新、证据取并集），缺字段一律 `null` 或空数组，不用 0 顶替。只读 IPC `task:executions` 从 store 取数而非渲染层事件流（`trimEvents` 会裁掉早期 `step.*`，用事件推导会让先前的执行凭空消失），配 preload `getTaskExecutions`、`AgentApi` 声明与 `mock-api` 实现。统计页新增「执行历史」卡 `components/engineering/ExecutionHistory.tsx`，逐条列出结果、成员、步骤、验证、交付、证据与失败原因。零迁移、不建表、不改状态机。`test:execution-history` 9 条（多次执行互不覆盖、无报告轮如实标注、跨任务报告不混入、排序按轮次号）已并入 `verify`。真机（[验收汇总](acceptance/v4-p1-m1-20261127/SUMMARY.md)）：一个 Task 投影出 4 条执行、`roundId` 去重 4 条，第 1 条仍是 `round 1 / outcome=failed`（`steps.failed=1`、`COMMAND_FAILED: 命令退出码 3`），第 2/3 轮无报告如实显示「未收口」而非 0 次失败，统计页 `.exec-item` 4 条＝同时刻投影 4 条；第 2 条及以后由目标驱动闭环自动续出，脚本未调 `resumeRepair`、未放行审批（`loopActions` 为空）。缺口：同一 Task 跨 `runId` 的两次独立运行未覆盖（本次 4 轮共用一个 `runId`） |
| M1-2 Goal 聚合视图 | `IMPLEMENTED / AUTOMATED_TESTED`（真机部分验证：分组渲染与退回已跑，「同一 Goal ≥2 Task」当前无法产生） | 新增 `src/shared/goal-view.ts`：`groupTasksByGoal()` 用任务上已有的 `goalId/goalVersion`（其次取契约正文里的 `goalId`）分组，组标题取版本最高的契约原文、没有才退回任务标题，版本列表升序去重；没记目标的老任务落在「未绑定目标」一组并永远排最后，不硬塞关系。侧栏 `TaskSidebar.tsx` 在工程模式下按目标分组渲染（目标名 + 版本 + 逐条任务状态点），并留「◈」开关一键退回时间平铺。会话行只挂到它绑定任务的目标上。无新表、无新写入。`test:goal-view` 9 条（同目标多任务、老任务、版本混排、契约-only、缺时间不顶替当前时间、空输入 + 侧栏接线源码守卫）已并入 `verify`。真机（[验收汇总](acceptance/v4-p1-m1-20261127/SUMMARY.md)）：侧栏 3 个目标分组渲染正常、「◈」`aria-pressed=true`、关掉后 `.goal-group` 归零且 `.task-item` 仍列 3 条。**阻断项**：现网没有任何两条任务共用一个 `goalId`——没有把新任务绑到既有 `goalId` 的写入路径（`task-manager.create` 一律写 `goal:<taskId>`），所以 M1 完成条件里的「同一 Goal 下 ≥2 Task」在界面产生不出来；要补的是目标绑定入口，属产品决定，不在只读投影范围内 |
| M1-3 目标变更影响面确认页 | `LIVE_TESTED` | `reviseGoal` 在 `requiresUserConfirmation` 分支除原有 warn 日志外，增发结构化事件 `goal.revision.pending`（`goalId`、`fromVersion→nextVersion`、`reason`、变更后标准原文、`impactedTaskIds` 与当时重建任务树里的受影响条目标题/状态、可继承条数），并加入 `store.ts` 的 `KEEP_FOREVER`——待用户回答的确认不能因事件裁剪而凭空消失。新增投影 `projectPendingGoalRevision()`（取时间最新一条；任务版本已追平 `nextVersion` 即认为已生效或过期不再弹卡；「暂不变更」不写库所以卡片仍在）与确认卡组件 `engineering/GoalRevisionConfirm.tsx`，确认走既有 `reviseTaskGoal(criteria, true)`，无新任务状态。`GoalContractCard` 的删标准不再用 `window.confirm` 只问一句，改为提交后由确认卡列出影响面。`test:goal-revision` 8 条（确认/取消两条路径、多 pending 取最新、非 pending 事件过滤、三处源码守卫）已并入 `verify`。真机（[验收汇总](acceptance/v4-p1-m1-20261127/SUMMARY.md)）：契约 1 条标准时追加 1 条判 `clarify`、不要求确认、版本仍 v1；删标准判 `change` 且 `requiresUserConfirmation=true`、确认前 `goalVersion` 保持 v1；`goal.revision.pending` 落库带原文（影响 7 条、可继承 5 条、`nextVersion=2`）；确认卡显示「目标变更待确认 v1 → v2 · 确认前不抬版本、不改任务」＋标准 1 条/受影响 7 条，点「确认变更」后版本抬到 v2 且卡片消失。待修口径：受影响清单把 `wt-work-*`/`wt-group-*` 两个汇总节点（同名「执行计划」）和真实步骤并列，界面读起来像重复项 |


## M1 里程碑判定

任务书的 M1 完成条件是三件事同时成立：三任务全部 `LIVE_TESTED`、同一 Goal 下 ≥2 Task、同一 Task 下 ≥2 Execution。真机跑完后：Execution 侧已满足（一个 Task 内 4 条执行、界面与投影同时刻一致），M1-1/M1-3 已 `LIVE_TESTED`，M1-2 的分组渲染已验但「同一 Goal 下 ≥2 Task」没有写入路径能产生。**M1 因此还不能判完成**，缺口只剩目标绑定入口这一项，等用户决定是否补。


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

> GCE 是设计冻结后的实施轨道，不改变现有代码事实；“已设计”不等于“已实现”。

## 已验证的专项证据

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
5. **Goal ↔ WorkTask 版本闭环**：任务创建写入 `goalId/goalVersion`，种树全量继承；目标修订有版本
   递增、影响闭包与继承判定，并经 `task:revise-goal` 落事件；版本链核对覆盖
   Goal→WorkTask→ECO→贡献→决策。尚缺界面确认入口与自动重开规划轮。
6. **Workflow**：注册表、条件/循环/审批与 `workflow:run` 已接线；但 `until` 运行时循环不支持（明确报错），parallel 为串行执行，且没有界面入口。
7. **深层 Java 分析**：AST/类型绑定/调用图不属于当前已交付能力。
8. **发布门禁**：签名、公证、干净机器安装和发布回滚仍需完成。

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
