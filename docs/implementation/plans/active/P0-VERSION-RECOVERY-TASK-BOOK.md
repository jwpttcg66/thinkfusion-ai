# P0 详细实施任务书：版本一致性与长任务中断恢复

**状态：** `DESIGN / NOT STARTED`（本文只定义任务、门禁和回滚；实现事实以 [`../../STATUS.md`](../../STATUS.md) 为准）
**基线：** `main@af7b312`（2026-11-27，已核对本地 HEAD 与 origin/main 一致，工作树干净）
**上游计划：** [`../V3-PRODUCTION-CLOSURE-PLAN.md`](../V3-PRODUCTION-CLOSURE-PLAN.md) 第六节 P0
**只读审计：** 2026-11-27 针对本任务的代码核对（本文 §1 逐项给出代码行号与函数名）
**实施约束：** 遵守仓库 `AGENTS.md` §5（从最新 main 建独立 worktree/任务分支，不在 main 直接开发）、§4（本地 commit，不 push）、§10（每任务真机验证，默认数据目录）。

> 本任务书里的现状都是 `af7b312` 的代码事实。每项 P0-x 开工前先在任务 worktree 里复核行号；
> 若上游已合入其它改动，先更新本节的"现状证据"再实施。不要据任务书标题推断已实现。

## 0. 为什么先做 P0

`main@af7b312` 上，`version-consistency.ts` 的纯函数、`checkVersionChain` 的调用、`recoverTaskContext`
的副作用核对都**已经存在**，但有三处让它们在生产中失效：

1. **版本链同源比对恒真**：恢复时 `goal.version` 取 `task.goalVersion ?? 1`，`current.goalVersion` 也取
   `task.goalVersion ?? 1`；`contribution.snapshotId` 与 `decision.contributionSnapshotId` 同取
   `lastDecisionEvent.snapshot`。于是指纹完全相同的两个值被送进一致性检查，过期分支在生产中永远不触发
   （只有测试用人工构造的不同值覆盖到）。`contribution.goalVersion` 字段在调用处根本没传。
2. **`needs_replan` 只进提示、不阻断**：`versionChain.requiresReplan` 和 `recovery.status === 'needs_replan'`
   都只被拼进继续提示词或写成日志，`orchestrator.ts:1168` 照常 `transition(..., 'planning')`，
   旧计划仍可在下一轮被批准执行。
3. **暂停/取消不真正中断在途工具**：`pause()`/`cancel()` 下发 `cancelPlan` 后立刻改状态，
   不等 Runtime 回传终止结果、不建检查点、不核对副作用；`shell.run` 没有 `AbortSignal` / `isCancelled`
   入口，在途 `sleep 300` 会继续跑完。

结果就是计划书 5.2/5.3 的语义（旧任务不得冒充新任务、暂停必须真正控制执行）在代码层没有闭合。
P1 的 AQC、P2 的目标证据闭环都依赖"恢复后状态可信"，因此 P0 是最高优先级。

## 1. 现状证据（main@af7b312 逐项核对）

### 1.1 版本一致性：纯函数已实现，生产同源恒真

| 事实 | 位置 |
| --- | --- |
| `checkVersionChain` 逐层比对 goal/worktask/eco/contribution/decision，传播作废，`requiresReplan` 定义 | `src/shared/version-consistency.ts:55-152` |
| goal 层"当前版本 vs 任务记录"比对分支 | `src/shared/version-consistency.ts:65-72` |
| contribution 层版本比对（需 `contribution.goalVersion`） | `src/shared/version-consistency.ts:91-99` |
| decision 层快照 id 比对 | `src/shared/version-consistency.ts:111-118` |
| 7 个测试覆盖（含"目标变更整链作废""缺字段不误判"） | `scripts/check-version-consistency.mjs`；`test:version-consistency` |
| 生产调用：`goal.version` 与 `current.goalVersion` 同源 | `src/main/orchestrator.ts:1075-1101`（`:1077-1079` 与 `:1100`） |
| 生产调用：contribution/decision 快照同源，且 contribution 未传 goalVersion | `src/main/orchestrator.ts:1091-1099` |
| `requiresReplan` 只发事件 + 写提示，`:1168` 照常 planning | `src/main/orchestrator.ts:1102-1122`、`1171-1179`、`1168` |
| `recovery.status === 'needs_replan'` 在 resume 无分支 | `src/main/context/recovery/task-recovery.ts:126-139`；`orchestrator.ts` 仅 `:1133` 是 goalRecovery 分支 |

### 1.2 暂停/取消/中断：状态机部分存在，工具中断缺失

| 事实 | 位置 |
| --- | --- |
| 状态含 `paused/interrupted/blocked/cancelled`，无 `pausing/cancelling` 中间态 | `src/shared/contracts.ts:1409-1415`；`src/main/task-manager.ts:13-37` |
| `pause()` 下发 cancelPlan 后立即 transition，返回 boolean 未用、不等 Runtime | `src/main/orchestrator.ts:949-971` |
| `cancel()` 同理 | `src/main/orchestrator.ts:1319-1332` |
| cancelPlan 走 UtilityProcess → `task.cancel` → cancelled Set / cancelCliRuns | `src/main/agent-manager.ts:404-409`；`src/agent/index.ts:228-234` |
| CLI 进程组有真实 SIGTERM→SIGKILL，终端有 signalTerminal | `src/agent/tools/cli-agent.ts:224-237,284-323`；`src/agent/tools/terminal.ts:486-510` |
| **`shell.run` 无中断入口**：只超时 SIGKILL，无 AbortSignal/isCancelled | `src/agent/tools/shell.ts:123-223`（`:198-201`）；`src/agent/local-plugins.ts:223-224` |
| 取消后步骤只被 skip，在途 shell 继续跑完 | `src/agent/index.ts:439-445` |
| 暂停/取消不建检查点；checkpoint 唯一调用点在 compaction 回调 | `src/main/index.ts:1422`；`orchestrator.ts:949-971` 仅日志 |
| 副作用核对只在 resume 侧，且 shell.run 属 OPAQUE_WRITE_TOOLS、无路径 | `src/main/context/recovery/side-effects.ts:30-33,54-165` |

### 1.3 恢复：目标与副作用核对已有，工具状态与内容一致性缺失

| 事实 | 位置 |
| --- | --- |
| 启动收敛 interrupted：`reconcileInterrupted()` 转 planning/executing/verifying → interrupted | `src/main/index.ts:5919`；`src/main/task-manager.ts:104-113` |
| `recoverTaskContext` 校验 runId/hash、ECO 目标版本、副作用路径 | `src/main/context/recovery/task-recovery.ts:80-179` |
| 副作用仅核"路径在不在"，无内容 hash，applied 不声称内容一致 | `src/main/context/recovery/side-effects.ts:9,118-155` |
| 目标契约过期核对 | `src/shared/goal-recovery.ts:25-71`；`orchestrator.ts:1124-1150` |
| 恢复后工具状态不重连/不复核，退出时是 cancelAllCliRuns/closeAllTerminals | `src/agent/index.ts:35-46`；`src/tools` 无 resume/reconcile |
| 旧真机证据基线 `main@40c7fed`，未覆盖版本一致性，暂停发生在规划阶段而非 shell 执行中 | `docs/implementation/acceptance/long-task-context/ACCEPTANCE.md:5,105-130,194-197` |

## 2. 任务拆解

> 依赖顺序：P0-1 → P0-2 → P0-3 → P0-4 → P0-5。P0-1/P0-2 是纯函数与门禁（低风险），
> P0-3/P0-4 触及 agent 运行时，P0-5 是真机验证。每项独立提交，禁止跨项混提。

### P0-1　版本链输入去同源化，让过期分支在生产中真的触发

**目标**：把恢复时送进 `checkVersionChain` 的"当前事实"与"记录事实"分开取源，
使 `goal` / `contribution` / `decision` 三层比对不再是自己跟自己比。

**动作**：
- 为 `orchestrator.resume()` 引入独立的"当前目标版本"来源：优先取 `goal.contract.updated` /
  `task:revise-goal` 事件里的最新版本（`planGoalRevision` 已递增），没有再用 `task.goalVersion`；
  明确记录取源，禁止两个字段都写 `task.goalVersion ?? 1`。
- `contribution` 补齐 `goalVersion`：从贡献快照对应的 `model.contribution.*` 事件取，
  取不到就留 `undefined`（`checkVersionChain` 的"缺字段不误判"语义保持不变），不要填当前版本冒充。
- `decision.contributionSnapshotId` 与 `contribution.snapshotId` 必须分别取"决策当时钉住的快照"
  与"当前最新贡献快照"，不能用同一个 `lastDecisionEvent.snapshot`。
- 不改 `checkVersionChain` 的判定规则（改它会翻红历史辩论，见 `AGENTS.md` 与既有测试）。

**验收**：
- `test:version-consistency` 增加"用真实 resume 事件序列构造、当前版本来自契约更新事件"的用例，
  断言 goal / contribution / decision 三层过期分别能被判出。
- 增加一个源码守卫测试：生产调用处不得再出现 `goal.version` 与 `current.goalVersion` 同取
  `task.goalVersion`、`contribution.snapshotId` 与 `decision.contributionSnapshotId` 同取一个 snapshot。
- `npm run typecheck` 与 `npm run verify` 全绿。

**回退**：保留 `checkVersionChain` 纯函数不动；只回退 `orchestrator.ts` 的取源改动，旧事件不受影响。

### P0-2　`needs_replan` 从"提示"升级为硬门禁

**目标**：目标或任务树过期时，不能照常 `transition(..., 'planning')` 让旧步骤继续被批准执行。

**动作**：
- 在 `orchestrator.resume()` 的 `:1168` 之前加门禁：`versionChain.requiresReplan === true` 或
  `goalRecovery.status === 'needs_replan'` 时，不进入 planning，而是走明确出口。
- 出口按 `AGENTS.md` 的决策语义：能自动局部重规划则标 `work.breakdown.replanned` 并重种树
  （复用 `seedWorkEventsFromPlan`，不新建任务树）；不能自动则 `transition(..., 'blocked')` 或
  发 `WAIT_USER` 决策，摘要写明"旧目标计划未执行，等待确认/重规划"。
- 兼容：非恢复路径（`submit` 首次规划）不受影响；已完成子任务保留原版本并接受新目标检验
  （计划 §5.2），不因为门禁把历史成果清空。
- `version.consistency` 事件补一个字段 `actedOnReplan`（是否真的触发了门禁），供 UI 与验收核对。

**验收**：
- `test:task-resume` / 新增测试：构造"目标 v2、任务树 v1"的恢复，断言不发 planning、
  发 `work.breakdown.replanned` 或 blocked，且 `actedOnReplan === true`。
- 断言旧 `goal.fit` / 旧 `model.decision.snapshot` 不被当作当前有效决策复用。
- typecheck + verify 全绿。

**回退**：门禁可加开关（默认开）旁路，回退后恢复到"只写提示"行为；不删除已落库事件。

### P0-3　在途 `shell.run` 可中断，并等待终止结果

**目标**：暂停/取消时向运行中的 shell 进程发中断信号、等待并记录终止结果，而不是让它跑完。

**动作**：
- 给 `runShell` 的 `args` 增加 `signal?: AbortSignal` 或 `isCancelled?: () => boolean`
  （沿用现有 `cancelCliRuns` 的 cancelled Set 语义，不新造第二套取消机制）。
- 收到中断时按 `detached: true` 的进程组发 `SIGTERM`，宽限期后 `SIGKILL`；
  结果里如实记 `exitCode / signal / interrupted: true`，与超时 `timedOut` 区分开。
- `src/agent/local-plugins.ts:223-224` 把运行时的取消信号透传给 `shell.run`。
- `pause()` / `cancel()` 下发 `cancelPlan` 后**等待** Runtime 回传终止结果（有界超时，
  超时要如实记"未能确认终止"），不再立即改状态当"已暂停"。
- 后台作业（`startJob`）走 `job.kill`，与前台 shell 同一语义。

**验收**：
- 新测试：`shell.run` 中断用例，断言进程真的被杀、结果 `interrupted: true`、
  stdout/stderr 与退出码被记录；"无法安全中断"路径有明确报告。
- `pause()` 测试：断言状态在 Runtime 确认前不是 `paused`（中间态），确认后才落 `paused`。
- typecheck + verify 全绿。

**回退**：新增参数可选，默认行为不变；回退后 shell 仍是超时 SIGKILL，取消只 skip 后续步骤。

### P0-4　暂停/取消状态机补齐 + 副作用核对 + 检查点

**目标**：区分请求态与实际态，暂停/取消不是只改一个状态字；真正控制执行并留下可恢复检查点。

**动作**：
- 在 `contracts.ts` / `task-manager.ts` 增加 `PAUSE_REQUESTED → PAUSING → PAUSED`、
  `CANCEL_REQUESTED → CANCELLING → CANCELLED`，`INTERRUPTED` 与 `RESUMABLE` / `BLOCKED`
  的转移语义；`pause()` 收到请求先置 `PAUSE_REQUESTED`，Runtime 确认后置 `PAUSING`，
  工具终止+副作用核对后置 `PAUSED`。
- 暂停/取消时调用检查点能力（复用 `commitContextCheckpoint`，不新写存储）：
  记录当前目标版本、任务树 revision、工具执行状态、证据账本。
- 对有明确路径的写入工具做副作用核对；`shell.run` 这类 `OPAQUE_WRITE_TOOLS` 如实标
  `needs_reconciliation`，不假装已核对（计划 §5.3 第 5 步）。
- 恢复入口消费 P0-2 的 `actedOnReplan` 与 P0-4 的检查点，核对工具状态而非只看路径。

**验收**：
- `test:state-machine` / `test:task-resume` 覆盖新转移；断言"请求暂停但未确认"时任务不是 paused。
- 检查点测试：暂停后检查点含目标版本与任务 revision；恢复时读它而不是重用旧结论。
- typecheck + verify 全绿。

**回退**：新增状态可用 feature flag 旁路，老任务（无新状态）按既有路径处理。

### P0-5　当前基线真机恢复验收

**目标**：补 `main@af7b312` + P0 分支上的真机证据，覆盖旧证据缺失的场景。

**动作**：
- 按 `AGENTS.md` §10，用默认数据目录（隔离目录需用户明确同意后使用并删除）；
  启动前说明是否中断当前窗口。
- 至少三个场景：① 目标修订后中断恢复——旧目标计划不得执行；② 规划中执行中暂停——
  在途 shell 被中断且状态为 `paused`/`PAUSING` 有据；③ 强制退出重启——`interrupted → resume`
  按新状态机核对目标/证据/副作用后继续或明确阻断。
- 输出任务 ID、事件序列（`version.consistency` / `task.paused` / `context.checkpoint.*`）、
  交付文件和截图，存入 `docs/implementation/acceptance/` 下新建的 P0 验收目录。

**验收**：
- 每条验收写清"启动配置 / 任务 ID / 证据路径 / 未覆盖项"，不得把未跑的场景写通过。
- 状态只在 `STATUS.md` 更新；`P0-x` 各自标 `IMPLEMENTED/TESTED/VERIFIED` 的真实层级。

**回退**：验收产物只新增文档与截图，不改生产代码。

## 3. 串行集成规则

- 本任务一个 worktree / 分支（`p0-version-recovery`），从最新 `main` 创建；
  P0-1 到 P0-5 顺序提交，每个提交可独立审查。
- 完成实现 + typecheck + `npm run verify` + P0-5 真机后，才合并回 `main`；合并前确认 main 干净。
- 不 `git push`；不做发布、签名、公证。
- 合并后如发现回归，回到本任务 worktree 修复，再单独提交合并，不在 main 上补丁式修改。
- 合并并验证通过后**不自动删 worktree**，由用户手动触发清理（AGENTS.md §5.1）。
- 状态只在 [`../../STATUS.md`](../../STATUS.md) 更新，本文不维护第二张完成度表。

## 4. 与后续阶段的接口

| 本阶段产物 | 下游消费者 |
| --- | --- |
| `version.consistency.actedOnReplan` | P1 AQC 的决策输入、P5 UI 的"停止原因"栏 |
| `PAUSING/CANCELLING` 中间态与检查点 | P4 长任务恢复、P5 UI 的暂停/恢复入口 |
| `shell.run.interrupted` 结果 | P1 反空转（中断不算失败命令重试）、P2 Evidence 账本 |
| `needs_reconciliation` 副作用标记 | P2 Goal Fit 的证据完整性判定 |
