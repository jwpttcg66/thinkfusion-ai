# V4 P1 任务书（M1 / M2 / M3）

**上游：** [`../V4-IMPLEMENTATION-PLAN.md`](../V4-IMPLEMENTATION-PLAN.md) P1 +
4.1.1 里程碑拆分；事实底稿 [`../../audits/V4-P0-CODE-FACT-AUDIT.md`](../../audits/V4-P0-CODE-FACT-AUDIT.md)。
**状态：** M1-1 / M1-2 / M1-3 全部 `LIVE_TESTED`，**M1 里程碑判定完成**（最后一轮真机 50 项判定 0 失败）。
M1-2 的「同一 Goal 下 ≥2 Task」最初验不出来，根因是缺一个可被多条任务指向的目标实体，已补
`store.goals` + 绑定写入路径 + 界面「在此目标下新建任务」入口，并在真机上跑通跨任务扇出（场景④）。
M2-1 `LIVE_TESTED`（真机 19 项判定 0 未通过，证据
[`../../acceptance/v4-p1-m2-1-20261128/SUMMARY.md`](../../acceptance/v4-p1-m2-1-20261128/SUMMARY.md)），
其「指针未接线」的原前提已按代码事实改判，见该节前提修正。M2-2 / M2-3、M3 `DESIGN / NOT STARTED`。
真机证据 [`../../acceptance/v4-p1-m1-20261127/SUMMARY.md`](../../acceptance/v4-p1-m1-20261127/SUMMARY.md)。
实现进度以 [`../../STATUS.md`](../../STATUS.md) 为准，本文件只写任务口径。
**基线：** `main@bd5a883`
**通用规则：** 每个任务开工前按计划书 11.1 先核对引用的文件行号是否漂移；
只在独立 worktree 开发；每任务完成必须更新 `STATUS.md` 并留真机证据；
不新建第二套 Task/Runtime/Evidence。

---

# M1：Goal、Task、Execution 统一

**可交付结果：** 一个目标可以管理多个任务和多次执行（真机可见）。
**为什么最先做：** 审计 1.2 节已确认三层对象存在但 Execution 是「round+report」隐式表达；
M2 的检查点要记录多任务多执行结构，M3 的决策要读可区分的执行历史，M1 不成立则两者都是空中楼阁。

## P1-M1-1：Execution 显式化

- **业务目标：** 同一 Task 的每次执行可独立寻址、可列举、不互相覆盖。
- **架构归属：** L3 Execution Supervisor + L6 持久化。
- **当前状态（审计 1.1/2.2）：** 执行 = `AgentRound`（contracts.ts:1494）+ `ExecutionReport`
  （contracts.ts:1714，带 roundId/planId）；`store.reports` 全量保留（store.ts:262）；
  `runId` 已存在（contracts.ts:1439）但只在 context/history 用（orchestrator.ts:1844）。
- **目标状态：** 不新建表。给 `AgentTask` 增加 `executions` 视图函数（shared 层纯函数）：
  输入 rounds+reports+events，输出按 runId/round 分组的执行列表
  （每次执行的 agent/模型、起止时间、结果、证据引用、失败原因）。
- **文件范围：** `src/shared/execution-history.ts`（新，纯函数）、
  `src/shared/contracts.ts`（若需补类型）、消费方 `src/renderer/src/components/engineering/*`。
- **数据模型变化：** 零迁移——全部由既有事件推导；老任务按缺字段兼容。
- **IPC/API：** 新增只读投影 IPC（如 `task:execution-history`），不改既有通道。
- **状态机变化：** 无。
- **调用链变化：** 无新写入路径；纯读。
- **测试要求：** 纯函数单测（分组、排序、多次执行不覆盖、老任务无 runId 兼容）+
  UI 投影测试。
- **真机验收：** 真实任务跑 ≥2 轮（一轮失败一轮成功），界面能看到两次执行各自的结果与证据；
  截图 + 事件导出存 `acceptance/v4-p1-m1-<date>/`。
- **回退方案：** 纯新增，还原即回退。

## P1-M1-2：Goal 聚合视图（一个目标管理多个任务）

- **业务目标：** 同一 goalId 下多条 Task（含历史任务）可在界面按目标聚合一览。
- **当前状态：** goalId/goalVersion 在任务创建写入（contracts.ts:1466 起）、
  reviseGoal 按 impactedTaskIds 重打版本（orchestrator.ts:1381）；跨任务聚合**无视图**。
- **目标状态：** shared 纯函数 `groupTasksByGoal(tasks)`；工作台侧栏按目标分组渲染
  （目标标题 + 版本 + 各任务状态 pill）。
- **文件范围：** `src/shared/goal-view.ts`（新）、
  `src/renderer/src/components/TaskSidebar.tsx`、`App.tsx`（数据选择处）。
- **测试：** 纯函数单测（多任务同目标、无目标老任务、版本混排）+ 投影测试。
- **真机验收：** 修订一个目标后新任务与旧任务同组展示、版本号正确；截图存证。
- **回退：** UI 分组开关，出问题隐藏分组入口即回退。

## P1-M1-3：目标变更影响面确认页（补 STATUS 已知缺口）

- **业务目标：** 重大变更不再只走日志，用户能在确认前看到受影响任务清单。
- **当前状态：** `planGoalRevision` 已产 `impactedTaskIds`（orchestrator.ts:1322 调用），
  `requiresUserConfirmation` 时只发 log（orchestrator.ts:1337）——审计标注的
  「界面暂无独立确认页」缺口。
- **目标状态：** `requiresUserConfirmation` 时发结构化事件
  `goal.revision.pending`（带 impactedTaskIds 与 reason），UI 弹确认卡；
  确认后走既有 reviseGoal 带 `userConfirmedChange: true`。
- **文件范围：** `src/shared/contracts.ts`（新事件）、`src/main/orchestrator.ts:1310-1345`、
  `src/preload/index.ts`、`src/renderer/src/components/*`（确认卡组件）。
- **状态机变化：** 无新任务状态；确认前任务保持原状态。
- **测试：** 事件投影测试 + 确认/取消两条路径单测。
- **真机验收：** 重大修改目标 → 出确认卡（列出受影响任务）→ 确认后版本抬起、
  旧任务树作废事件可见；截图存证。
- **回退：** 事件与 UI 独立，可只回退 UI。

**M1 完成条件：** 三任务全部 LIVE_TESTED；同一 Goal 下 ≥2 Task、同一 Task 下 ≥2 Execution
在真机可区分展示。
**判定（2026-11-28）：** 达成——探针 `514d0787` 同目标下 2 条任务、同一 Task 下 3 条执行，
改标准确认后两条任务同抬 v2 且共用同一份标准。未覆盖项只有「同一 Task 跨 `runId` 的两次独立运行」，
属非阻断补充，见验收汇总。

---

# M2：Checkpoint、恢复、上下文重建

**可交付结果：** 真实任务暂停、应用重启后可以继续（常规路径，不再只是探针）。
**基础已有（审计 1.4/2.2）：** 检查点结构、暂停/取消中间态、副作用账本、版本链核对、
needs_replan 门禁均已 IMPLEMENTED/TESTED/VERIFIED（P0-1～P0-5）。

## P1-M2-1：checkpointId / contextId / activeRunId 接线

- **业务目标：** 审计 2.7-2 标注的「只定义未接线」字段全部生效。
- **当前状态：** `ContextCheckpoint` 完整（shared/context.ts，含 Journal 活动指针）；
  暂停路径已写 checkpoint（orchestrator.ts:967），但任务字段 `checkpointId/contextId`
  （contracts.ts:1441-1447）未与 Journal 指针保持一致更新。
- **前提修正（2026-11-28，实现前核对）：** 上面这条「未与 Journal 指针保持一致更新」已经不成立。
  P0-4 落地时 `store.commitContextCheckpoint()`（store.ts:441）把 `contextId/checkpointId/activeRunId`
  三个字段连同事件一次写完，`index.ts` 注入 `journal: store`，`task-recovery.ts` 也已优先读任务字段。
  真正的缺口是**反过来的**：`orchestrator.ts:1013` 在 Journal 事务之后又 `tasks.patch()` 了一遍
  `checkpointId/contextId`——那是第二个写者，而且它漏写 `activeRunId`，等于用半套指针盖掉权威值；
  恢复时 runId 门判不过，检查点看着在却读不出来。所以本节改判为「去掉重复写者 + 补重建路径」，
  原计划的「成功后 patch」不再做。
- **目标状态：**
  1. 指针三字段只由 Journal 事务写（`commitPauseCheckpoint` 返回完整指针，不再补 patch）；
  2. `context.checkpoint.paused` 事件带完整指针（`contextId/checkpointId/activeRunId`），
     使任务字段缺失时能从事件流重建；
  3. resume 优先按任务字段定位指针，字段不全才按事件流回溯重建，重建结果仍走同一套
     runId/hash/归档校验（读不出就 stale，不放行）；
  4. 走的是哪条路必须能被看见：恢复结论带 `pointerSource`，并写进
     `context.recovered` / `context.refresh.required` / `context.compaction.stale` 事件。
- **文件范围：** `src/main/orchestrator.ts`（commitPauseCheckpoint、resume 打点）、
  `src/main/context/recovery/task-recovery.ts`（`resolveTaskPointer`）、
  `src/main/context/checkpoint/pause.ts`（返回完整指针）、
  `src/shared/contracts.ts` + `src/shared/context.ts`（事件加字段，无结构变化）。
- **不做：** 启动时全量扫一遍任务字段与检查点文件对账。指针读不出时恢复本来就会
  在校验处停下并点名原因，加一道启动扫描只是把同样的判断提前，还要付全量磁盘读的代价。
- **测试：** `test:checkpoint-pointer`（新增：字段↔文件一致、事件带指针、两条恢复路径打点）；
  `test:pause-checkpoint` 扩展（字段一致性 + 半套指针重建 + 无指针判 none，并把事件同时落 Journal
  以贴合主进程）；`test:context-recovery` 扩展（指针优先、回溯兜底、兜底后仍要过校验）。
- **真机验收：** 暂停后 store 里任务字段与检查点文件一致；重启恢复走的路径打点可见。
  脚本 `scripts/verify-v4-p1-m2-1-cdp.mjs`（默认数据目录；重启前把探针任务的指针字段抹掉，
  抹之前整份 store 备份进验收目录）。
- **回退：** resume 的回溯兜底就是旧行为，字段写入可独立回退。

## P1-M2-2：重启后从检查点继续执行成为常规路径

- **业务目标：** SIGKILL 重启 → resume 不再只到 `planning` 重新规划，
  能从最近检查点恢复上下文直接续跑（副作用核对通过时）。
- **当前状态：** P0-5 场景③ 验收到 `interrupted → version.consistency → planning`；
  上下文重建依赖下一轮真实读取（STATUS「刷新后由下一轮重建 ECO 包」），无「直接续跑」路径。
- **目标状态：** resume 时若检查点 fresh 且副作用账本 `needsReconciliation==0`，
  提供直接续跑分支：重建 adapter（P0-5 已修）+ 注入检查点摘要 +
  从「下一个未完成步骤」继续，而不是整轮重规划。
- **文件范围：** `src/main/orchestrator.ts:1073-1308`（resume 主函数）、
  `src/main/context/recovery/task-recovery.ts`、`src/main/context/checkpoint/pause.ts`。
- **状态机变化：** 无新状态；`interrupted → executing` 直达需要 task-manager 转移表
  补这条边（现走 planning 中转）。
- **测试：** `test:task-resume` 新增「fresh 检查点 + 无缺口 → 直达执行」用例；
  「有缺口 → 仍走重规划」负例必须同时存在。
- **真机验收：** 复用 `verify-p0-5-restart-cdp.mjs` 场景，断言恢复后第一个事件是
  `step.started`（续跑）而非 planning 轮；两条路径都要有真机样本。
- **垃圾回收（顺带关闭缺口 9/10）：** `store.deleteTask()` 目前只清 tasks/rounds/plans/reports/events，
  磁盘上的检查点归属文件与 `store.goals` 里的孤儿目标都不回收（M1 真机验收收尾实测：用户任务 0 条、
  检查点 owner 文件 11 个、孤儿目标 6 条）。本任务要给 checkpoint store 加删除接口并在删任务时回收
  已无绑定任务的目标实体；回收口径必须只认「最后一条绑定任务被删」，不能按时间猜。
- **回退：** 转移表补边可撤；续跑分支按环境开关（默认走重规划）灰度。

## P1-M2-3：上下文重建显性化

- **业务目标：** 「重建了什么上下文」对用户可见、可核对。
- **当前状态：** ECO 包重建在下一轮真实读取时发生（STATUS 长任务行）；
  `context.refresh.required`/`context.recovered` 事件已发但 **UI 零消费**（审计 2.5）。
- **目标状态：** 任务详情页新增「上下文」折叠段：当前 contextId、最近检查点、
  副作用核对结果、上次重建时间与原因。数据全部来自既有事件投影，新 IPC 只读。
- **文件范围：** `src/shared/task-view.ts`（投影扩展）、渲染层组件、`src/preload/index.ts`。
- **测试：** 投影测试（事件→字段）+ 组件测试。
- **真机验收：** 暂停→恢复一次后，「上下文」段显示核对结果与重建原因；截图存证。
- **回退：** 纯 UI 新增，可独立移除。

**M2 完成条件：** 三任务 LIVE_TESTED；「暂停→强退→重启→续跑」与
「暂停→强退→重启→明确重规划」两条路径都有真机证据，UI 可核对上下文状态。

---

# M3：Decision、Verification、持续循环（判定点）

**可交付结果：** 系统能判断下一步并持续推进，直到目标完成或需要用户介入。
**这是整个 P1 的判定点：** M3 不成立不进入 P2，也不以「M1/M2 已完成」宣布 P1 完成。

## P1-M3-1：决策函数收敛为一套（消灭双轨）

- **业务目标：** 全系统只有一个「下一步」判定出口。
- **当前状态（审计 2.1/2.7-1）：** `decideCycleAction`（cycle-decision.ts:118，完整纯函数）
  **零调用**；orchestrator.ts:2742 `emitCycleDecision` 是并存的简化实现（11 值枚举硬编码）。
- **目标状态：** `continueAfterReport`（orchestrator.ts:2801）与 resume 门禁改调
  `decideCycleAction`，简化版删除；决策事件带 `CycleDecisionResult` 全字段
  （reason/evidenceRefs/风险），不再是裸枚举。
- **文件范围：** `src/main/orchestrator.ts:2742-2766/2801+`、`src/shared/cycle-decision.ts`
  （若需补输入字段）、相关测试。
- **调用链变化：** 这是本任务核心——把死代码变成唯一活代码。
- **测试：** `test:cycle-decision` 扩展「orchestrator 场景 → 决策函数」映射用例；
  源码守卫断言 `emitCycleDecision` 简化实现已删。
- **真机验收：** 真实任务连跑两轮，`cycle.decision.created` 事件带完整 reason 与 evidenceRefs；
  事件流 diff 存证。
- **回退：** 简化版实现保留在一个 revert 提交里。

## P1-M3-2：反空转激活（detectNoProgress 接线）

- **业务目标：** 连续无进展能被识别，并触发「换路径 / 请求用户 / 暂停」。
- **当前状态：** `detectNoProgress`（cycle-decision.ts:221）死代码；无任何无进展检测。
- **目标状态：** 每轮报告后调用 `detectNoProgress`（输入：连续 N 轮的证据事实与决策序列）；
  判定无进展时决策只能是 `WAIT_USER` 或 `REPLAN`（带无进展原因分类：
  重复调用 / 缺上下文 / 缺权限 / 需换工具），**不允许**无进展时继续 EXECUTE。
- **文件范围：** `src/main/orchestrator.ts:2801+`、`src/shared/cycle-decision.ts`、
  `src/shared/contracts.ts`（事件带无进展分类字段）。
- **测试：** 构造 3 轮同证据任务 → 断言第三轮决策非 EXECUTE 且带分类；
  正常波动任务不误伤。
- **真机验收：** 构造一个会空转的任务（如反复读同一文件不产出），系统在阈值轮停下并
  说明原因；截图 + 事件流存证。
- **回退：** 阈值配置化，调大即等效关闭。

## P1-M3-3：Budget Manager 收敛

- **业务目标：** 任务级预算统一管理，超限暂停、用户批准后继续。
- **当前状态（审计 2.3）：** 三处零散——`checkCodingBudget`（coding-workflow.ts:39，计划期
  轮数/步数警告）、ContextBudget（context.ts:39，token，四档置信）、评审/辩论预算在
  plan-review.ts 内部。无跨轮累计、无超限暂停。
- **目标状态：** 新 `src/shared/budget.ts` 纯函数 + orchestrator 单点记账：
  每轮结束后累计（模型调用次数、token 已知值——未知按 `unknown` 如实标，**不伪造数字**）、
  对比任务级上限（默认继承现状不设限），超限 → 决策函数返回 `PAUSE` +
  `budget_exhausted`（状态机已有该状态与恢复路径，P0 已验证）。
- **文件范围：** `src/shared/budget.ts`（新）、`src/main/orchestrator.ts`（记账点：
  driveRound 尾部 + continueAfterReport）、`src/shared/contracts.ts`（任务字段 `budget?`）。
- **数据模型：** `TaskBudget { maxRounds?: number; maxModelCalls?: number; maxTokens?: 'unknown'|number }`，
  老任务无字段 = 不限。
- **测试：** 预算累计、超限判定、unknown 不误判、恢复后继续（接 budget_exhausted→resume）。
- **真机验收：** 设 2 轮上限的任务跑到第 2 轮结束进 `budget_exhausted`，界面可批准继续；
  截图存证。
- **回退：** 不设预算即现状。

## P1-M3-4：持续循环（无人值守推进 + 用户介入出口）

- **业务目标：** 计划书 4.6 的基本循环落地：目标→分析→设计→（必要时辩论）→计划→执行→
  验证→修复→复核目标→决定下一轮，每轮有可检查的状态变化。
- **当前状态：** 单轮内循环完整（driveRound→handleAnswer→runPlan→continueAfterReport，
  修复轮有闸门）；「复核目标并决定下一轮」由 `awaiting_next_round` + 用户手点衔接，
  无自动续推。
- **目标状态：** 新增任务级开关 `autoContinue`（默认关，**行为不默认变化**）：
  开启时 continueAfterReport 决策为 CONTINUE 且预算未超、无空转、无 WAIT_USER 判定 →
  自动进入下一轮（复用 driveRound），每轮发 `cycle.decision.created` 说明为什么继续。
  决策为 WAIT_USER/PAUSE/COMPLETE 时停下等用户——**持续循环的每一类停止原因都必须可解释**。
- **文件范围：** `src/main/orchestrator.ts:2801+`、`src/shared/contracts.ts`（任务字段）、
  渲染层开关 + 停止原因展示（接 M2-3 的上下文段或任务头）。
- **测试：** 决策映射单测（CONTINUE→自动续、四类停止→停）；与 M3-2 空转、M3-3 预算的
  组合用例（预算超限优先于继续）。
- **真机验收：** 一个 ≥3 轮的真实小任务在 autoContinue 下无人值守推进到 COMPLETE，
  事件流里每轮决策带 reason；中途 WAIT_USER 一次（如审批）证明介入出口有效；
  事件流 + 截图存证。
- **回退：** 开关默认关；关掉即完全回到现状。

**M3 完成条件（=P1 完成条件）：**
真机完成一次 ≥2 小时墙钟的持续任务：多轮自动推进、至少一次失败与修复、
至少一次空转识别或预算暂停、至少一次用户介入后继续、最终按 GoalFit 判定完成或如实 NOT_MET。
P1 完成前不启动 P2。

---

# 依赖与顺序总览

```
M1-1 Execution 显式化 ──┐
M1-2 Goal 聚合视图     ──┼→ M2-1 指针接线 → M2-2 续跑常规化 → M2-3 上下文显性
M1-3 影响面确认页      ──┘         │
                                   ↓
                    M3-1 决策收敛 → M3-2 反空转 → M3-3 预算 → M3-4 持续循环
```

- M1 三个任务可并行（互不依赖，都只读既有事件）。
- M2-1 依赖 M1 无（字段接线独立），但 M2-2 的「续跑」语义要读 M1-1 的执行分组来定位
  「下一个未完成步骤」，实现顺序上 M2-2 在 M1-1 之后。
- M3-1 必须最先（后续三个都往决策函数里加输入）；M3-4 依赖 M3-2/3-3 的停止判定。

# 验收证据归档

每任务真机证据存 `docs/implementation/acceptance/v4-p1-<milestone>-<task>-<date>/`：
`EVIDENCE.md`（场景/步骤/断言/未覆盖项）+ 截图 + 事件导出 JSON。
`STATUS.md` 按 DESIGNED → IMPLEMENTED → AUTOMATED_TESTED → LIVE_TESTED 五态逐级更新，
禁止一步写成 PRODUCTION_VERIFIED。
