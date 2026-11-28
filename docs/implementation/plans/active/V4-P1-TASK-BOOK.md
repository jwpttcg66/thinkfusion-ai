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

### 实现后的口径修正（2026-11-28；与本节上文不一致处以本节为准）

1. **续跑门槛不是字面的 `needsReconciliation==0`。** 账本分两类：`PATH_WRITE_TOOLS`
   （fs.writeFile / fs.applyPatch …）按路径存在性核对，落 `applied` / `missing`；
   `OPAQUE_WRITE_TOOLS`（shell.run / test.run / code.run / agent.exec / term.send …）没有路径
   可核对，落 `needs_reconciliation`。判定落在 `decideContinuation()`
   （`src/main/context/recovery/continuation.ts`）：`ledger.missing > 0`（记过的改动已不在盘上）
   或存在「结局未知且无路径可核对」的在途写 → 重规划；否则续跑。
   这与任务书原意的偏差只是换了度量名，方向不变：不可核对的写操作仍然挡住续跑。
2. **没有新增 `interrupted → executing` 转移边。** 续跑复用的是 resume 分支既有的
   `paused/interrupted → executing`，所以「状态机变化」一项实际为零，回退面比预估小。
3. **真机探针另写 `scripts/verify-v4-p1-m2-2-cdp.mjs`，没有复用 `verify-p0-5-restart-cdp.mjs`。**
   P0-5 那份走模型规划，步骤 id 与步数每轮都不同，命中不了「暂停时还剩 N 步」这个前提；
   M2-2 的两条路要确定性，所以改用固定工作流（`workflow:run`，节点 id 即步骤 id）。
   断言内容与任务书一致：恢复后第一个执行事件是 `step.reused`/`step.started`，不是 planning 轮。
4. **回退开关是注入点，不是环境变量。** 续跑分支的灰度口径落在
   `AgentOrchestratorDeps.resumeContinue?: () => boolean`（`orchestrator.ts:247`，
   判定处 `orchestrator.ts:1436` 取 `?.() ?? true`）：返回 false 即回到「继续一律重规划」，
   不用回滚续跑分支本身。主进程目前没有把它接到任何环境变量/设置项上，所以线上要关还得改一行
   注入——记为后续项，不在本任务里加开关面。

### 真机跑出来的四个产品缺陷（已修，各有回归测试）

- **没轮到的 `skipped` 步骤被当成副作用缺口。** `collectSideEffects()` 按 `args.path` 核对暂停时
  未执行的步骤，文件当然不存在 → 记 `missing` → 续跑门槛永远过不去（「暂停→重启」在真机上
  必然重规划，也就是本任务头号场景不可达）。修：`status:'skipped'` 且没有 `reusedFrom` 的条目
  跳过（本轮没动过手），带 `reusedFrom` 的照旧核对（上一轮真写过、本轮不重跑）。
  回归：`test:task-resume` 的「暂停报告后到：本轮没跑过的 skipped 步骤不算副作用缺口」与
  「复用步骤照旧算副作用：reusedFrom 的 skipped 路径消失要报 missing」；前者移除修复后确认变红。
- **暂停后落地的执行报告把 `paused` 带去 `cancelled`。** Runtime 对「暂停」与「取消」回的是同一份
  `status:'cancelled'` 报告，`finishPlanExecution()` 照报告收尾会把状态推到
  verifying → report_pending → cancelled，而 `resume()` 只认 paused/interrupted/budget_exhausted/blocked
  → 暂停检查点再也续不上（真机现象：点「继续」提示状态不允许）。修：任务处于
  pause_requested/pausing/paused 时报告照常落库（已完成步骤的证据不丢），状态保持暂停并留一条日志。
  回归：`test:pause-checkpoint` 的「暂停后取消报告才到：状态留在 paused，之后仍能从检查点续跑」。
- **续跑报告带 `reusedFrom`，被契约校验整份判非法。** M2-2c 给 `contracts.StepResult` 加了
  `reusedFrom`、Runtime 也真发这个字段，但 `src/shared/schemas.ts` 的 `StepResultSchema` 是
  `.strict()` 且没跟着加 → 续跑回到主进程的第一份报告整体非法，`task:resume` 抛
  「Runtime 返回的执行报告无效：unrecognized_keys reusedFrom」，本任务头号场景在真机上根本走不完
  （单测全绿的原因：测试自己造的假报告不经 IPC，摸不到这一层校验——这正是本任务要求真机跑一遍的理由）。
  修：schema 补 `reusedFrom`（`checkpointId` 允许空串，老检查点就是空串）。
  回归：`test:protocol` 的「续跑报告带 reusedFrom 的复用步骤必须通过 schema」，同条里保留
  「出现未知键仍要拒」的断言，防止为了过校验把 `.strict()` 拆掉。
- **恢复走了哪条路、复用了哪几步，界面上看不出来。** 时间线与对话流各写了一份 context 事件标签表，
  两张表都缺 `context.resume.continued`/`context.resume.replanned`/`context.refresh.required`
  → 续跑与被迫重规划都显示成「上下文事件」四个字；`context.checkpoint.paused` 在 UI 里零消费
  （暂停到底留下了哪份检查点，只能去翻磁盘文件）；报告明细与交付事实把被复用的步骤写成「已跳过」，
  等于对人说「这一步没做」。修：标签与配色收进 `shared/context.ts` 的 `contextEventView()` 一处、
  两处投影共用；新增暂停检查点里程碑（带 checkpointId，没落盘时如实写「未提交」并标成提醒色）；
  被复用的步骤标「复用自上次执行」。顺手修 `target('fs.search')` 丢掉检索词——`test:execution-timeline`
  里这条断言一直是红的，因为这个脚本没进 `verify` 闸门，所以从没拦住过任何事。
  回归：`test:execution-timeline` 新增 3 条 + `test:task-conversation` 新增 2 条；
  `test:protocol` 与 `test:execution-timeline` 已并入 `npm run verify`（53 步 → 55 步）。

### 真机验收结果（2026-11-28，43 项判定 0 未通过）

见 [验收汇总](../../acceptance/v4-p1-m2-2-20261128/SUMMARY.md)。两条路径都拿到真机样本：

- **续跑正例**（探针 `36ea5531`，固定工作流 14 步，跑到 `write-4` 暂停 → SIGKILL → 重启 → 点继续）：
  `context.resume.continued`，`pointerSource=task-fields`，沿用被中断那份计划
  `79289ed1`（续跑 planId 与暂停时任务上的完全相同），复用 6 步
  `seed-test, write-1…write-5`、本轮执行 `write-6…write-12, final-gate`；恢复打点之后第一个执行事件是
  `step.reused`，打点之后 `round.started` 0 条（没重开规划轮）；落库报告 14 步全 `completed`、
  6 条带 `reusedFrom`、收尾 `shell.run` 退出码 0，任务 `verifying → report_pending → completed`。
- **重规划反例**（探针 `9487adcf`，暂停时留一条起了但没路径可核对的 `shell.run`）：
  检查点账本 `applied 1 / missing 0 / needs_reconciliation 1`，`context.resume.replanned`
  理由点名「1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）」并开出新轮。
- **回收**：删任务时 `checkpointsRemoved=true`（owner 文件删掉）、`archiveSegments=0`、
  探针目标实体随之不再被任何任务绑定；启动扫描只删「任务表里查不到」的段，
  本轮实测扫前/扫后归属文件 0→0、孤儿目标 0→0，且重启时活任务 `36ea5531` 的 owner 文件被保留。
- **界面可核对**：「输出」页时间线里「暂停已提交检查点 cp_…（待核对 N 项）」
  「已从检查点续跑：沿用已批准计划，未重新规划」「已重新规划：检查点不足以安全续跑」都是
  可点开详情的行，报告明细把复用步骤标「复用自上次执行」；「对话」页同样有这两条上下文备注。
  截图 05/06/07 为证。

### 真机跑出来的三个判据缺陷（已修，属探针自身，不是产品）

- **段名带扩展名比对**：`listSegments()` 返回 `4a6776de….json`，而 `contextOwnerSegment()` 是不带
  扩展名的段名，于是「活任务保留」永远 0 条、「孤儿残留」永远非空——两条启动扫描判据一直是假红，
  另一条（任务表为空时）是空跑。修：与产品 `listOwnerSegments()` 同口径先剥 `.json`。
- **恢复打点找不到**：`event === aResumeEvent` 跨两次取数比对象引用必然为 `false`，`resumeIndex` 恒为 -1，
  「续跑后第一个事件是 step 不是 planning」这条最关键的判据实际是在整份事件流上取的。修：按
  `at + event` 值定位，并新增 `A-resume-marker-located-in-event-stream` 把下标与条数写进证据。
- **收尾命令写法在这台 node 上不通**：`node --test .` 回「Could not find '.'」，退出码 1，
  把「续跑把剩余步骤跑完了」盖成一条假红。修：点名文件 `node --test probe.test.mjs`，
  并让那份测试自己断言 12 个写文件齐备（收尾步骤亲自核对，而不是脚本站在外面数）。
- 另有两处探针自身炸点：`evidence.statusAfterResume` / `evidence.uiText` 未在初始化里声明就被赋值
  （`Cannot set properties of undefined`，直接把探针 B 与收尾回收整段跳掉），以及界面判据找错页签
  （执行时间线挂在「输出」`output`，不是「轨迹」）。都已修，并让「页签没切过去」把现存页签名写进证据。

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

### 实现后的口径修正

- **投影落在新建的 `src/shared/context-state.ts`，不是任务书写的 `src/shared/task-view.ts`。**
  `TaskView` 是逐事件增量折叠（`applyTaskViewEvent` 一次喂一条，供会话流与状态条消费），而这一栏要的是
  整份历史的全貌：多次暂停留多行、同刻事件按 `sequence` 保序、「暂停只给了待核对条数」要投影成 `null`
  而不是 0。塞进 `TaskView` 会让每个消费者都背一份自己用不上的检查点台账。取数口径与 M1-1 的
  `task:executions` 一致：只读投影 + 只读 IPC，读 `store.listEvents(taskId)`，不读界面那份按配额
  裁剪过的事件流——否则早先的暂停存档会被裁没，「这一栏说没有检查点」就成了假话。
- **卡片只转述事件，不读检查点文件、也不读任务上的指针字段。** 一栏里出现两个真相源，就再也说不清
  「界面显示的那份」与「恢复链路实际用的那份」是不是同一个。字段与事件不一致由恢复打点的
  `pointerSource` 点名（M2-1 已埋），卡片把它原样摆在「重建经过」每一行的标签上。
- **「组件测试」按本仓库惯例落成源码守卫 + 真机按格读数。** 渲染层没有 DOM 测试设施
  （`check-goal-entity.mjs:166+`、`check-expertise.mjs:270` 的界面覆盖都是源码断言），所以
  `test:context-state` = 13 条投影 + 5 条守卫（投影是纯函数、处理器只读、契约/preload/mock/文档四处对齐、
  折叠段挂载与目标字段齐全、缺失写「未记录」）；界面真值由 `scripts/verify-v4-p1-m2-3-cdp.mjs` 读
  `.task-context-card` 每一格的 `innerText`，与投影 / 事件原文 / 磁盘检查点三方对账。
  `npm run verify` 55 步 → 56 步。
- **摘要行不带 contextId。** 它是 `pause:<taskId>:<时间戳>` 这种长串，跟在标题「上下文」后面会把
  「最近检查点 / 核对」两句挤没；真机第一轮还暴露了「上下文 上下文 …」的重复。摘要现在只说三件事
  （几条事件、最近检查点、核对到什么程度），完整 contextId 留在展开后的「当前上下文」栏。
- **与「统计」页既有那排计数的分工：** TaskStats 给的是次数（压缩 N 次 / 恢复 N 次，且只覆盖界面收到的
  事件），这一段给的是台账（哪份检查点、核对结果、走落库指针还是事件流重建、为什么重规划）。
  两者口径不同，所以卡片底部写明「依据 N 条持久化的 context 事件」，不与 TaskStats 共用一个数字。

### 真机验收结果（2026-11-28，47 项判定 0 未通过）

脚本 `desktop-agent-macos/scripts/verify-v4-p1-m2-3-cdp.mjs`（默认数据目录 + CDP 9333，同一进程内暂停→继续，
三个探针：A 续跑、B 没暂停过的反例、C 暂停时留一条无路径可核对的在途命令）。
明细与截图见 [验收汇总](../../acceptance/v4-p1-m2-3-20261128/SUMMARY.md)。

- **暂停即对账：** 暂停事件、投影、磁盘 `owners/agent-task/275e5b15-….json` 三方的 `checkpointId/contextId` 逐项相等
  （`cp_8af45f5d…`，磁盘账本 `applied 6 / missing 0 / needs_reconciliation 0`）；界面这一栏在暂停点写
  「存在 未记录 · 已消失 未记录 · 待核对 0」并附口径说明——暂停没核对过，就不给 0。
- **恢复后可核对：** `context.recovered`（`pointerSource=task-fields`、账本 `applied 7 / missing 0 / nr 0`）与
  `context.resume.continued`（沿用计划 `3bb24e9c…`、复用 `write-1…6`、本轮 `write-7/8`）原样落进
  「副作用核对 / 核对来源 / 上次重建 / 重建原因 / 续跑判定」，重建经过每行带「指针来自任务字段」标签，
  步骤清单可展开到具体步骤 id；「逐条原文」3 条展开即事件 payload（§8 详情检查入口）。
- **不可核对时点名：** 探针 C 判成 `context.resume.replanned`，理由「1 个写操作结局未知且无路径可核对：
  long-shell（needs_reconciliation）」在「重建原因」栏与理由清单里都可见，行是提醒色（`t-warn`），
  副作用核对是「存在 2 · 已消失 0 · 待核对 1」，被拒的 `cp_0637ddb5…` 仍留在「最近检查点」栏。
- **不做判据之外的让步：** 只读性由「同一任务连读两次投影完全一致」守住；没暂停过的任务（探针 B）该栏只说
  「没有记录到上下文事件」，10 格不出现，且原文里不串出探针 A 的检查点 id。

**真机暴露的三处需要修的（都不是"功能没做"）：** 摘要行渲染成「上下文 上下文 …」（标题重复 + contextId 挤掉后两句）；
探针首轮在加载态就取数、拿到 8 个字符的壳子（若照此判定会把功能判死）；重规划行的行头写「复用 0 步 · 本轮执行 0 步」，
把「整轮作废」说成了「这一轮没干活」。三处已分别改为「N 条 context 事件 ·…」、判据等加载态消失、
「不复用上一轮步骤」，并有断言钉住。

**未覆盖（留给后续）：** `pointerSource=events-replay` 下这张卡的读数（M2-1/M2-2 已在事件与续跑链路验过重建）、
跨重启后这张卡的读数、`budget` 水位与 `context.refresh.required` 的真机样本（固定工作流未触发 ECO 过期与预算告警）。
另记录一条与本案无关的观察：探针 A（续跑）与 C（重规划）收尾时状态均为 `failed`，且本轮未采到原因事件
（现象指向续跑/重规划之后的验证链需要模型规划源），
是 M3-1/M3-2 的输入。

**M2 完成条件：** 三任务 LIVE_TESTED；「暂停→强退→重启→续跑」与
「暂停→强退→重启→明确重规划」两条路径都有真机证据，UI 可核对上下文状态。

---

# M3：Decision、Verification、持续循环（判定点）

**可交付结果：** 系统能判断下一步并持续推进，直到目标完成或需要用户介入。
**这是整个 P1 的判定点：** M3 不成立不进入 P2，也不以「M1/M2 已完成」宣布 P1 完成。

## M3 开工前的现状审计（2026-11-28，基线 main `add2be9`）

下面几条是核对代码后对**本节任务书原文**的修正，实施时以本节为准。

1. **M3-1 的「双轨」比原文写的多一条轨，而且缺口不在"没人调用"。** 现网判定链是
   `decideNextEngineeringAction`（`goal-driven-cycle.ts:152`，四出口 `complete|repair|fail_budget|fail_delivery`，
   **决定行为**）→ `orchestrator.ts:3372-3382` 一段三元映射把它翻译成 11 值枚举 →
   `emitCycleDecision`（`orchestrator.ts:3152`，只是个事件发射器，`decisionType` 由调用点硬编码）。
   `decideCycleAction`（`cycle-decision.ts:118`）确实零生产调用，但**直接接上它不会得到正确决策**：
   它的输入里 `diagnosis`（七值病因分类）与 `progress`（跨轮指纹计数）在生产里**从来没有来源**——
   没有任何代码产出 diagnosis，`CycleProgress` 也只出现在 `check-cycle-decision.mjs` 里。缺了这两项，
   所有轮次都会落到 `WAIT_USER`（"目标符合度不足或未知"）或 `CONTINUE`，等于把决策权交回去之前先锁死。
   所以 M3-1 的真实工作量是**先补两个输入的来源，再收敛出口**，见 M3-1a。
2. **`goalStatus` 门槛不会误伤（这条是收敛安全性的前提）。** `goalContractFromPlan` 建契约时写
   `status: 'ACTIVE'`（`main/engineering/goal-contract-runtime.ts:102`），不在 `USER_GATE` 名单里；只有目标修订
   流程会把它推到 `CHANGE_PROPOSED`（`goal-contract.ts:441`），那时纯函数返回 `CHANGE_PROPOSED` 正好与
   P0-2 已有的 replan 门禁同向，不会新增"待用户确认目标"的死锁。
3. **M3-2 的「无任何无进展检测」不成立。** `orchestrator.ts:3078 guardRepairRound()` 已在用
   `shouldOpenRepairRound()`（`shared/repair-loop.ts:135`）比对上一轮与本轮的 `evidenceFacts()`（同文件 :50，
   含命令/参数哈希/退出码/输出哈希/验证结论/changedPaths）与评审问题，**0 新事实且 0 新评审问题就停自动修复**，
   真机 2026-11-24 起就在生效。真正的缺口是三条，不是"没有检测"：① 只在 `decision === 'repair'` 时才跑
   （`orchestrator.ts:3370`），complete/observe 路径完全不判；② 只比相邻两轮，**不累计**，所以"每轮都改一点点但方向错"
   与"第三轮重复同一件事"分不开；③ 计数不落库，重启后从零开始。`detectNoProgress` 接线必须与它**合流**
   （同一份事实来源 `evidenceFacts` + `cycleFingerprint`），否则就造出第二套空转判定，正是 M3-1 要消灭的东西。
4. **M3-3 的「状态机已有该状态与恢复路径，P0 已验证」只对了一半。** `budget_exhausted` 在
   `task-manager.ts:36` 有完整出边、`resume()` 认它（`orchestrator.ts:1238/1402`）、UI 有标签（`TaskStats.tsx:30` 等），
   但**全仓没有任何一处 `transition(..., 'budget_exhausted')`**——没有任何代码会把任务放进这个状态，
   历次验收也没有一条入边样本。因此"超限 → 暂停 → 用户批准继续"是**新增行为**，不是接回既有行为，
   真机验收必须自己造出入边证据。现在超限的实际落点是 `failed`（`orchestrator.ts:1449-1451` 与 `:3512-3525`），
   文案「达到最大轮数 N，无法继续」。
5. **给决策事件加字段是安全的。** `cycle.decision.created` 只有 TS 联合类型（`contracts.ts:2209-2228`），
   全仓没有事件级 zod 校验（无 `AgentEventSchema`）——与 M2-2 的 `StepResultSchema.strict()` 教训不同，
   加字段不会让报告变非法。但消费方 `goal-driven-cycle.ts:793` 与 `check-task-resume.mjs:112` 按
   `decisionType` 读，字段名与取值必须保持向后兼容。

**顺序结论：** M3-1 必须先做（它决定"下一步"由谁说了算），M3-2 的空转计数要作为 M3-1 那个唯一出口的输入接进去，
M3-3 的预算超限改成 `PAUSE` 也走同一个出口，M3-4 只是把"出口判完要不要自动再跑一轮"这一步从人手点变成开关。


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
- **落地后的实况修正（2026-11-28 真机，[验收汇总](../../acceptance/v4-p1-m3-2-20261128/SUMMARY.md)）：**
  1. **空转在现网不是靠「重复调用」触发的。** 探针每轮都在换工具（`fs.writeFile`×6 → `session.search`/
     `fs.tree`/`fs.find`/`git status` → `fs.tree`/`fs.search`×3/`fs.find`×2），`progress.repeated` 三轮
     恒为 0，拦住它的是第二维 `criterionStalled`（未满足的标准集合连续不变）。所以测试口径必须是两条：
     同证据 3 轮（离线 `check-cycle-decision.mjs` 覆盖）**加**「换手段但不推进标准」（真机覆盖）——
     只写前者会让人以为现网永远撞不到反空转。
  2. **「停下等人」之后用户接不回去。** 阈值调大确实让判定不再拦（离线证到），但真机上任务已经停在
     `report_pending`，`resumeRepair()` 在「本轮三项检查都已跑（哪怕全 `skipped`）」的前提下直接拒绝
     「这一轮已经完成全部检查，不需要继续修复」，界面上只剩「接受未验证并结束」与取消。**本条「回退：
     调大即等效关闭」在用户侧因此不成立**，补齐入口归 M3-4：`stop_and_wait` 之后要有一条「换手段再来一轮」
     的用户动作，它必须绕开「已验证完」的门禁（要改的是计划与手段，不是补一次验证）。
  3. 阈值读取口落在 `resolveNoProgressLimits({env, config})`（env > `userData/no-progress.json` > 默认 2/2，
     脏值回退默认），宿主注入的是 `noProgressLimits: () => …` 因而每次判定现读。**本轮只证到「配置文件真的
     进了判定」**（事件里记录的阈值就是写入值）；「运行中改文件不重启就跟着变」需要按修正后的写入时机
     （渲染进程连上之后）再跑一次才算现场证据，脚本已加 `a-threshold-applies-without-restart` 断言。

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
- **落地后的实况修正（2026-11-28 真机，[验收记录](../../acceptance/v4-p1-m3-3-20261128/EVIDENCE.md)）：**
  1. **文件名与「不设限」两条按现场改。** 模块落在 `src/shared/task-budget.ts`（不是 `budget.ts`）：
     `budget` 已被上下文预算与 `CycleSnapshot.budget`（单个计划的编码迭代）占用，同名会让「还能不能再开
     一轮」和「上下文还剩多少」继续混用——契约文档 §9.5 与那个字段各自补了口径注释。默认值保持现网
     `maxRounds=20`：任务书写「默认继承现状不设限」，但现状就是 20，改成不设限等于放宽行为。
  2. **「状态机已有恢复路径」不成立，是这条任务真正要补的东西。** `budget_exhausted` 原先只能从
     `created/planning/executing` 进入，而超限的落点是 `transition(..., 'failed')`（终态），所以界面
     那句「追加预算或结束」对着一条谁也进不去的边。现在补齐九条入边（`executing/verifying/report_pending/
     awaiting_next_round/planning/paused/interrupted/blocked`），并把落点收敛成唯一一处 `pauseOnBudget()`。
  3. **「累计模型调用/token」在现网没有账本。** 任务级没有模型调用计数，`round.peer.usage` 的 token 只覆盖
     辩论成员，所以两条维度如实记 `null` → 界面显示「未记账」（设了上限）或「未设限」（没设上限）；
     记 0 是「装作还有余量」，把未知判成超限是误停任务，两条都不许。真机样本：设 `maxModelCalls=40` 后
     门禁 `ok:true`、理由点名「模型调用已设上限但没有调用计数」、卡片读「未记账」。
  4. **超限的真机前置条件只能制造。** 默认 20 轮在验收窗口（墙钟 45 秒，按「用例暂时不用跑那么久」压短）
     内不可能自然跑满，且预算按设计只增不减、无法用小上限新建任务。做法是跑出 1 个真轮次后停进程，只改
     探针任务自己的落库记录（`轮数已用满 + 无当前计划 + interrupted`，等价于「老任务带着小上限被恢复」这条
     真实形态），重启后走常规 `task:resume`；判定、落点、事件、界面读数四段代码路径一行未绕，动盘前备份、
     跑完删探针。**代价是「跑到默认上限」这一小时级自然路径仍未采**，留给 M3-4 的 ≥2 小时闸门任务顺手覆盖。
  5. **「加得回去」证到的是接回循环，不是跑完全程。** 追加到 3 轮后状态从 `budget_exhausted` 回到 `planning`、
     轮数 1→2（真的开了下一轮），但这一轮之后能否无人值守一路到完成属 M3-4（`autoContinue`）范围，本条不认领。

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
- **硬前置（M3-2 真机挖出，2026-11-28）：** 「停下等用户」目前没有可用的出口。任务被 `WAIT_USER` 停在
  `report_pending` 时，唯一的续跑入口 `resumeRepair()` 要求「验证尚未完成」，而模型完全可以给出
  `verified:yes` + 三项检查全 `skipped` 的报告（本轮真机就是这样），于是界面只剩「接受未验证并结束」
  与取消——**没有任何一条路径能让用户说「换手段再来一轮」**。本任务必须先补这条入口（含事件与界面痕迹，
  §8 三件齐），再谈 autoContinue；否则 ≥2 小时无人值守任务一旦撞上空转就永久停住，M3 的闸门也过不了。
  另两条同源放大器一并收口：瞬时通道故障（「模型连续 120 秒没有输出」）不该把任务判成终态 `failed`；
  `plan.invalid`（步骤多写 `mapsTo`/`expect`/`checksCategory` 被 zod strict 整份拒绝）会白烧整轮。
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
