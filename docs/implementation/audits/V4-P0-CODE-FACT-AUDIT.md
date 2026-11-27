# V4 P0 全量代码事实审计

**审计日期：** 2026-11-27
**代码基线：** `main@bd5a883`（V4 计划 + M1/M2/M3 里程碑调整之后）
**审计范围：** `desktop-agent-macos/src` 全部 412 个 TS/TSX 文件（约 115,000 行），
`scripts/` 下 266 个测试脚本，`docs/implementation/acceptance/` 全部证据目录。
**性质：** 本文档是 [`plans/V4-IMPLEMENTATION-PLAN.md`](../plans/V4-IMPLEMENTATION-PLAN.md)
P0-02（符合性矩阵）与 P0-03（模块职责）、P0-04（对象关系）的事实底稿。
所有结论都带 `文件:行号` 证据；抽样部分明确标注「抽查」，未标注的为全量清点。

> 规模分布（全量统计，非抽样）：
> `src/main` 232 文件 / 60,589 行；`src/shared` 81 / 26,122；`src/renderer` 53 / 18,873；
> `src/agent` 40 / 9,240；`src/preload` 5 / 390。
> `src/main` 内最大子目录：debate 6,934、adapters 5,040、code-index 3,447、engineering 3,334、
> memory 3,173、evidence-pack 2,613、collaboration 2,433、providers 2,391、context 2,221。
> 最大单文件：`main/index.ts` 7,455、`shared/contracts.ts` 3,620、`main/conversation-runner.ts` 3,651、
> `main/orchestrator.ts` 3,245。

---

# 一、核心对象与生命周期（P0-04 底稿）

## 1.1 真实对象清单

| 对象 | 类型定义 | 存储 | 说明 |
|---|---|---|---|
| Goal（无独立实体） | `AgentTask.goalId/goalVersion/goalCriteria/goalContract`（contracts.ts:1434 起） | 任务记录 + 事件流 | **Goal 不是独立表**，绑定在任务上；契约正文是 `GoalContract`（goal-contract.ts:105） |
| GoalContract | `src/shared/goal-contract.ts:105`（criteria/dimensions/goalVersion/status） | `goal.contract.updated` 事件 | 完成判定结构 `DeliveryState`（execution/verification/goal 三态分开）、`GoalFitAssessment` 同文件 |
| Task | `AgentTask`（contracts.ts:1434，字段见 1.3） | `store.tasks` | 状态机 22 态（contracts.ts TaskStatus：created→…→cancelled），转移表在 `task-manager.ts` |
| WorkTask（TDL 子任务树） | `src/shared/task-decomposition.ts:34`（L0–L3） | `work.task.upserted` 事件流重建 | 生产者 `ensurePlanDecomposition`（task-decomposition.ts:765），恢复时 `rebuildWorkTasksFromEvents` |
| Round（≈执行次） | `AgentRound`（contracts.ts:1494，inputType 四类） | `store.rounds` | **一次执行 = 一轮 round + 一份 ExecutionReport**；没有独立 "Execution" 实体 |
| ExecutionReport | contracts.ts:1714（status/results/nextAction/verification/evidence） | `store.reports` | `allReportsFor(taskId)` 保留全部历史；`updateReport` 只许「口径重判」不许改事实（store.ts:271 注释） |
| Run | `AgentTask.runId`（contracts.ts:1439 注释「一次连续执行过程的身份」） | 任务字段 | 暂停/恢复复用同一 runId；`context/history` 按 `owner{taskId,runId}` 定位（orchestrator.ts:1844-1850） |
| Plan | `StoredPlan`（contracts.ts:1510 附近） | `store.plans` | 带 `contentHash` 与 `approvalStatus`（pending/approved/rejected/expired） |
| Checkpoint | `ContextCheckpoint`（shared/context.ts） | `userData/context-checkpoints/` | 字段：sourceEventIds 全量、summary+hash、evidenceRefs、token 前后、status；提交权威是 Journal 活动指针 |
| Event | `AgentEvent`（contracts.ts 1900 行起，约 90 种） | `store.events` + `runEvents`（真实库 128 + 3,929 条） | Journal 单调序列，事务由 `store.ts:415` 起的专用方法保证 |
| Evidence | `EvidenceLedger`（shared/engineering-evidence.ts:27） | 报告内嵌 + evidence-pack | 另有 `src/main/evidence-pack/`（12 文件）做仓库快照与主张核验 |

## 1.2 对象关系链（真实字段连接，非概念图）

```
用户 prompt
  → submit() (orchestrator.ts:359) 建 AgentTask{goalId?, goalVersion}
    → driveRound (orchestrator.ts:1512) 建 AgentRound
      → handleAnswer (orchestrator.ts:1920)
        → 计划落 StoredPlan；ensureGoalContract (orchestrator.ts:2766) 建 GoalContract
          → goal.contract.updated 事件
        → ensurePlanDecomposition (task-decomposition.ts:765) 产 WorkTask 树（L0–L3，各带 goalVersion）
        → 审批 approve() (orchestrator.ts:609)
          → runPlan (agent-manager.ts:374) 经 UtilityProcess 执行（src/agent/index.ts:523 step.started）
            → ExecutionReport{roundId, planId, evidence, verification}
              → continueAfterReport (orchestrator.ts:2801)
                → verifyExecution (agent/verification.ts:178) + assessReportsAgainstGoal
                  → GoalFitAssessment → cycle.decision.created (orchestrator.ts:2742)
                    → COMPLETE / 下一轮 driveRound
  → 暂停/取消：commitPauseCheckpoint (orchestrator.ts:967)
    → 恢复 resume() (orchestrator.ts:1073)：contextRecovery → buildResumeVersionChainInput
      (version-consistency.ts) → checkVersionChain → needsReplan 门禁 (P0-2) → 重新规划
```

关键结论：**Goal→Task→Execution 三层在代码里是「任务字段 + 事件流重建」而不是三张表**；
Execution 层由 round+report 组合表达，同一 Task 多次执行靠 roundId 区分、reports 全量保留
（store.ts:262-265），不存在覆盖执行历史的问题。M1 要做的是把这层隐式结构显式化，
不是新建三张表。

## 1.3 reviseGoal 影响面（已接线的完整链）

`reviseGoal`（orchestrator.ts:1310-1418）：
`planGoalRevision`（纯函数，比较新旧 criteria，判 clarify/优化/变更）
→ 需用户确认时只发日志、不抬版本（:1337）
→ 可生效时 patch 任务 `goalVersion/goalCriteria/goalContract`（:1370）
→ 对 `plan.impactedTaskIds` 里的 WorkTask 逐个发 `work.task.upserted`（revision+1、goalVersion=next，:1381）
→ `work.breakdown.replanned` 带 impactedIds（:1399）。
**已完成且不受影响的子任务保留原版本**（:1308 注释），继承语义存在。

## 1.4 恢复链（M2 相关，已闭合的部分）

`resume()`（orchestrator.ts:1073-1308）按序做六件事：
1. waiting 状态直接回 `resumeStatus`（:1083）；
2. `contextRecovery` 判 stale/recovered/needs_context_refresh（:1094-1147），
   stale 直接抛错不恢复（:1099）；
3. 副作用缺口如实播报（:1148）；
4. P0-1 版本链：`buildResumeVersionChainInput` 分「任务记录 / 事件流当前事实」两源取数
   （version-consistency.ts: buildResumeVersionChainInput；契约过期时回退任务记录），
   贡献快照取自 `plan.debated`、决策钉版取自 `model.decision.snapshot`；
5. GCE 契约过期合并判定 `reconcileGoalContractOnResume`（:1186）；
6. P0-2 门禁：`needsReplan && !gateConsumed` → 作废任务树、WAIT_USER、`blocked`（:1197 起）。

---

# 二、模块职责与调用链（P0-03 底稿）

## 2.1 Goal / TDL / GDC

| 项 | 生产代码 | 调用链 | 测试 | 判定 |
|---|---|---|---|---|
| Goal 生命周期 | orchestrator.ts:359/1310/2766 | submit→reviseGoal→ensureGoalContract；`test:gdc-goal` 6 条 | 真机：目标卡修订已点验（STATUS.md） | **PASS-PARTIAL**：缺「独立目标变更影响面确认页」，确认走日志 |
| Goal Contract | shared/goal-contract.ts:105 | ensureGoalContract(:2766) 计划期建立，只由证据更新 | test:goal-contract（142 行） | PASS |
| TDL 分解 | task-decomposition.ts:765 ensurePlanDecomposition | orchestrator.ts:2027（种树）、plan-review.ts:47（评审判定） | test:tdl 系列 + test:subtask-cycle 8 条 | PASS：NEEDS_ANALYSIS 已降级为质量警告（approval.ts planApprovalGate） |
| GDC 八阶段投影 | goal-driven-cycle.ts:729 projectGoalDrivenWorkbench | **双端消费**：orchestrator.ts:2879（主进程投影）+ App.tsx:554（渲染层投影） | test:gdc-cycle | PASS：不是死代码，UI 有真实消费（CollaborationResultPanel.tsx:107-129 目标符合度） |
| Cycle Decision | cycle-decision.ts:118 decideCycleAction、:221 detectNoProgress | **零调用方**（全仓 grep 仅定义处命中） | test:cycle-decision（116 行）测纯函数 | **REDUNDANT（现状）**：orchestrator.ts:2742 的 `emitCycleDecision` 是独立简化实现（11 种 decisionType 硬编码枚举），两者并存。P2/M3 必须二选一收敛 |

## 2.2 执行运行时

| 项 | 生产代码 | 说明 | 判定 |
|---|---|---|---|
| 执行主链 | driveRound:1512 → askRound:1609 → handleAnswer:1920 → approve:609 → runPlan(agent-manager.ts:374) → UtilityProcess(src/agent/index.ts:523) | 规划空闲看门狗（:1534 只看「多久无新输出」）；上下文满自动换会话重试一次（:1583 注释） | PASS |
| 暂停/取消 | pause:1017 / cancel:1419 / commitPauseCheckpoint:967 | 请求态→停止中→实际态；检查点带副作用账本（含在途 `step.started` 写操作，side-effects.ts collectInFlightSideEffects） | PASS（P0-4 真机验收 20261127） |
| 恢复 | resume:1073 + task-manager.ts reconcileInterrupted | 见 1.4；重启收敛 `pause_requested/pausing→interrupted`、`cancel_requested/cancelling→cancelled` | PASS（P0-5 真机验收） |
| 在途中断 | agent/tools/shell.ts + agent/index.ts:52 activeSteps、:245 ackCancel、agent-manager.ts:424 cancelPlan | 进程组 SIGTERM→SIGKILL；Runtime 收尾后才回执；主进程有界等待 | PASS（P0-3 真机 628ms 中断） |
| Runtime | agent-manager.ts:183 startAgentProcess（Electron UtilityProcess） | 超时先真取消再拒绝（:396 注释「不能只停止等待」） | PASS |

## 2.3 质量治理（Debate / Review / Verifier / DMOCA）

| 项 | 生产代码 | 接线情况 | 判定 |
|---|---|---|---|
| Plan Debate | main/debate/（21 文件 6,934 行）；触发 `shouldDebatePlan`（plan-review.ts:285）、轮数 `planReviewRounds`（:348，按规模 2/3 轮） | reviewPlanWithDebate（orchestrator.ts:2207）；辩题解析 `hasDebateTopicsSection`——写了【辩题】段就以模型为准（2026-11-26 修复） | PASS：真机辩论跳过/执行均有证据 |
| Verifier | agent/verification.ts:178 verifyExecution、:319 hasGenuineDelivery；口径 shared/verification-evidence.ts（compile/tests/run/diagnostics 四类） | continueAfterReport 消费；失败走 `report_pending`，出口 `acceptUnverified:887` / `recheckVerification:935` | PASS |
| DMOCA | shared/dmoca.ts；选人 `selectParticipants`（execution/policy.ts:16，工程编排=本地+勾选云端）、风险 `assessCollaborationRisk`（orchestrator.ts:2215 消费）、快照 `snapshotFromExchanges`（:2480 消费，发 `model.decision.snapshot`） | 快照已落事件但 **UI 零消费**（renderer 下 grep 0 命中） | PASS-PARTIAL |
| repair-loop | shared/repair-loop.ts；`shouldOpenRepairRound` 在 guardRepairRound（orchestrator.ts:2681）真实调用 | 修复轮闸门有生产接线 | PASS |
| AQC | **全仓无 AQC 概念**（grep 0 文件） | MISSING（P2-01 待建，且必须复用 decideCycleAction 或 emitCycleDecision 之一，不建第三套） |
| Issue Registry | **全仓无 Issue 对象**（grep 0 命中） | MISSING（P2-02） |
| 统一 Budget | 零散三处：`checkCodingBudget`（coding-workflow.ts:39，计划期预算警告）、ContextBudget（context.ts:39，上下文 token 预算，含 verified/configured/estimated/unknown 四档置信）、debate/planReview 预算在 plan-review.ts 内部 | 无跨任务/Goal 级预算、无超限暂停、无费用记账 | MISSING（P2-03：不是从零建，是把三处收敛成一个 Budget Manager） |
| 反空转 | `detectNoProgress`（cycle-decision.ts:221）**死代码**；无其他无进展检测 | MISSING（P2-04：函数已有，接线缺失） |

## 2.4 证据链

| 项 | 生产代码 | 判定 |
|---|---|---|
| 执行证据账本 | EvidenceLedger（engineering-evidence.ts:27）挂在 ExecutionReport.evidence | PASS |
| 仓库证据包 | main/evidence-pack/ 12 文件：repository snapshot、claim verification、hash、GC、mapping | 抽查：结构完整，**未确认** UI/完成判定是否消费全部能力 |
| 目标符合度 | engineering/goal-contract-runtime.ts `assessReportsAgainstGoal` → GoalContractFit（MET/WITH_RISKS/PARTIAL/GAP/UNKNOWN） | PASS：UI 有消费（CollaborationResultPanel.tsx:107） |
| 证据过期 | ECO 侧有 `eco.context.invalidated`（orchestrator.ts:2254）；Evidence 本体**无过期字段**（contracts 里 evidence 无 expiresAt） | PASS-PARTIAL：P3-03 要补「证据有效期」 |

## 2.5 场景与 UI

| 项 | 事实 | 判定 |
|---|---|---|
| 场景概念 | `WorkspaceMode = 'knowledge' \| 'engineering'`（workspace.ts:23）；**没有 General 枚举**——非工程对话走 `intent === 'research' ? 'knowledge' : 'general'` 推导（App.tsx:573-575） | PASS-PARTIAL：三场景是「2 个显式模式 + 1 个推导值」，V4 P4-01 要把 scene 提升为一等概念 |
| IPC 面 | `ipcMain.handle` 共 **174 个**（main/index.ts）；preload 暴露 `window.agentAPI` 单命名空间 | PASS |
| 主会话流 | buildTaskConversation（task-conversation.ts:689）→ TaskConversation.tsx；流式文档式渲染 + 步骤并入正文（2026-11-27 系列改造） | PASS：test:task-conversation 65 条 |
| 多模型展示 | round.answer 带 participantId/modelCallId（orchestrator.ts:1580）；工作台按成员分列 | PASS |
| **UI 消费缺口**（事件有、UI 无） | `cycle.decision.created`、`model.decision.snapshot`、`version.consistency`、`context.checkpoint.paused` 详情在 renderer 下 **grep 0 命中**；用户只能从日志/状态 pill 感知 | **MISSING（P6 的具体清单）**：这正是「决策可解释」缺的 UI 面 |
| 按模型统计 | TaskStats.tsx 有状态标签；「按模型」统计存在 | PASS-PARTIAL |

## 2.6 Native / External

| 项 | 事实 | 判定 |
|---|---|---|
| 原生工具 | TOOL_NAMES（contracts.ts:81）共约 **100 个**：fs.* 15、git.* 6、code.*（含 LSP 桥）10、computer.* 13、team.* 6、term.* 6 等 | PASS：Native 工具面已远超「基础工程任务」所需 |
| LSP | main/lsp/ 5 文件（tsserver.ts、ts-ast.ts、impact.ts、providers.ts） | TS 系可用；Java 无 LSP 接线 |
| Java 理解 | code-index/ 10 文件为文本/正则级；`web-tree-sitter` 0.27.2 与 `@vscode/tree-sitter-wasm` **已在 package.json:314-321**，`spike:tree-sitter` 脚本存在（spikes/tree-sitter-java-spike.mjs） | **P5-02 不是从零开始**：依赖已装、spike 已做，缺的是把 AST 接进 code-index 生产链 |
| 外部 Agent | adapters/ 仅 browser+providers；外部执行走 `code.team.run`（contracts.ts:110 注释「不是又一个 shell.run」）+ execution/cli-executor.ts | OpenCode/ACP 适配器 MISSING（P5-03） |
| 权限边界 | TaskGrant 拦不到 CLI 内部工具循环（contracts.ts:110 注释明示） | 与 V4 P5-04 要求一致：边界已如实声明，未伪造统一 |

## 2.7 死代码与冗余清单（P0-03 明确要求项）

1. `decideCycleAction`（cycle-decision.ts:118）+ `detectNoProgress`（:221）：**零生产调用方**，
   只有测试。同时 orchestrator.ts:2742 另有一套 emitCycleDecision 简化实现。两套并存，
   P2-01/M3 必须收敛为一套（建议：保留 cycle-decision.ts 纯函数，orchestrator 的简化版改为调用它）。
2. `AgentTask.contextId/checkpointId/activeRunId`（contracts.ts:1441-1447）：注释自述
   「LT-P0 只定义，未接线」——P0-4 之后 checkpointId 已在 pause 路径写入，
   contextId/activeRunId 仍待接。
3. `updateReport`（store.ts:271）：有「只许口径重判」约束，grep 未见滥用；保留。
4. 无发现「第二套 Runtime/任务系统」——计划书 1.4-1 的红线目前没有违反。

---

# 三、V4 六层架构符合性矩阵（P0-02 底稿）

| V4 层 | 要求 | 现状 | 状态 | 实施决策 |
|---|---|---|---|---|
| L1 用户交互层 | 三场景入口、目标管理、暂停/继续、审批、轨迹 | TaskConversation 流式文档 + 状态 pill + 审批卡；场景=2 模式+推导 | PASS-PARTIAL | P4-01 把 scene 提为一等概念 |
| L2 目标与项目层 | Goal/Requirement/AC/版本 | Goal 绑定任务字段；Contract/Criterion 完整；**Requirement 无独立实体** | PASS-PARTIAL | M1 用 GoalContract.criteria 承担 Requirement，不新表 |
| L3 Engineering Runtime | 六控制器 | Goal Controller=reviseGoal✓；Decision=emitCycleDecision（简化版）△；Scheduler=TDL✓；Execution Supervisor=pause/cancel/resume✓；Context Manager=context/✓；Verification=verification.ts+goal-contract-runtime✓ | ADAPT | M3 收敛 Decision；其余四层已有真实实现 |
| L4 能力执行层 | Native+外部+多模型 | 100 工具 + UtilityProcess + CLI/网页/云端通道 | PASS | P5 只补 OpenCode/ACP adapter |
| L5 理解与验证层 | 符号/调用/审核/证据 | LSP(TS)+code-index(正则级)+evidence-pack；Java AST 依赖已装未接 | PASS-PARTIAL | P5-02 接 tree-sitter 进生产 |
| L6 持久化层 | Goal/Task/Execution/Event/Evidence/Checkpoint/Memory/权限 | store(json)+Journal+context-checkpoints+memory/+permission-store | PASS | Execution 显式化为 M1 任务 |

---

# 四、审计结论

**能支撑 M1/M2/M3 直接开工的判断：**

1. **M1 是「显式化」不是「新建」**：Goal（契约+版本+影响面）、Task（状态机+子树）、
   Execution（round+report）三层对象与生命周期全部存在且有真机证据；
   缺的是独立 Execution 实体字段、跨任务 Goal 聚合视图、执行历史 UI。
2. **M2 大部分已由 P0（恢复轨道）交付**：检查点（含副作用账本）、中断收敛、
   版本链核对、needs_replan 门禁都有真机证据。M2 剩余 = 把「重启后从检查点继续执行」
   从探针场景变成常规路径 + contextId/activeRunId 接线。
3. **M3 是最大缺口，也是收敛点**：Decision 现在是 orchestrator 内 11 值枚举的简化实现，
   cycle-decision.ts 的完整纯函数（含 detectNoProgress）没人调；
   Budget 三处零散、AQC/Issue Registry 不存在、反空转死代码。
   M3 的真实工作 = 选定 cycle-decision.ts 为唯一决策纯函数 → 接线 → 补 AQC 输入 →
   Budget Manager 收敛 → 反空转激活。
4. **P2 的地基比计划书估计的好**：Issue Registry 确实是 MISSING，但决策纯函数、
   修复闸门、验证口径、证据结构都在，P2 主要是「接线 + 补对象」而非「造系统」。

**审计方法自述（诚实边界）：**

- 全量清点：文件数、行数分布、TOOL_NAMES、IPC 数（174）、测试脚本数（266/241 test:）、
  store 数据结构、事件种类、acceptance 目录。
- 逐点核实（带 path:line）：本报告第一、二节全部结论。
- 抽查（未逐文件读）：debate/ 21 个文件只核了入口与触发判定；evidence-pack/ 12 文件只核了
  结构与生产入口，消费端标「未确认」；renderer 53 文件只核了投影函数与组件清单；
  `src/agent` 40 文件只核了 runtime/verification/tools 关键路径。这四块的逐文件结论
  在对应任务（M1 任务书、P5-02、P6）开工时随做随补，本文不假装已覆盖。

**下一步**（对应任务 #64/#65/#66）：本报告即矩阵与对象图底稿；
P1 任务书按 M1→M2→M3 拆分，任务级文件范围与调用链直接引用本文第一、二节行号。
