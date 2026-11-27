# GCE-P3：Cycle 与决策引擎详细设计

**状态：** `DESIGN`，未实现。  
**基线：** `main@9026e0e`  
**总设计：** [V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md](V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md)  
**契约：** [GOAL_CONTRACT_EVIDENCE_CONTRACTS.md](../spec/GOAL_CONTRACT_EVIDENCE_CONTRACTS.md)  
**任务：** [GCE-P3](../implementation/V3-GOAL-CONTRACT-EVIDENCE-TASK-BOOK.md#6-gce-p3cycle-生命周期与决策引擎)

## 1. 目标

把当前 `complete/repair/fail_budget/fail_delivery` 四出口升级为可解释的下一步决策，同时保留现有 Orchestrator/Runtime/审批，不新增调度器。

核心区别：

| 旧 | 新 |
| --- | --- |
| 计划→执行→报告→修复/完成 | 目标复核→分析→设计→计划→执行→审核→证据→目标符合度→决策 |
| Round Number 兼作循环身份 | Work / Cycle / Round 分离 |
| 阶段由投影推导 | 阶段有真实开始/结束/跳过事件 |
| 修复是默认出口 | 按问题层级选择修复/重规划/重设计/重分析/澄清/等待 |

## 2. 身份模型

| 对象 | 标识 | 说明 |
| --- | --- | --- |
| Work | `workId` | 用户交付的一项完整工作 |
| Goal | `goalId + goalVersion` | 当前契约版本 |
| Cycle | `cycleId + cycleNumber` | 一次完整决策循环 |
| Round | `roundId` | 某阶段的一次模型/执行尝试 |
| WorkTask | `workTaskId + revision` | TDL 任务 |
| Evidence | `evidenceId` | 真实执行/验证事实 |

规则：

- 一个 Cycle 可包含多个 Round；
- 一次局部 REPAIR 不强制新 Cycle；
- 只有目标/设计/关键约束发生实质变化，或需要重新走完整决策链时，才创建新 Cycle；
- `cycleNumber` 只统计完整 Cycle，不能用 `roundNumber` 替代。

## 3. Cycle 阶段与事件

阶段顺序：

```text
GOAL_REASONING
ANALYSIS
DESIGN
DESIGN_DEBATE (按需)
PLANNING
IMPLEMENTATION
REVIEW
REVIEW_DEBATE (按需)
CONCLUSION
GOAL_FIT
NEXT_DECISION
```

事件：

```text
cycle.created
cycle.stage.started   { cycleId, stage, reason? }
cycle.stage.completed { cycleId, stage, artifactRefs? }
cycle.stage.skipped   { cycleId, stage, reason }
cycle.decision.created{ cycleId, decisionType, reason, evidenceRefs, versions }
goal.fit.assessed     { goalId, goalVersion, cycleId, counts, fit }
```

约束：

- `stage.started` 必须由真实流程入口发出，不从旧事件反推；
- `SKIPPED` 必须有原因；
- `stage.completed` 才能将阶段标 done；
- 旧 `cycle.snapshot` 可继续作为兼容快照，但不能覆盖真实阶段事件；
- 投影重放只读事件，不写状态。

## 4. 阶段跳过

允许：

- 简单文本修改跳过 DESIGN/DEBATE；
- 小修复跳过 GOAL_REASONING/ANALYSIS；
- 无真实分歧跳过 DESIGN_DEBATE/REVIEW_DEBATE；
- General/Knowledge 跳过 IMPLEMENTATION。

必须：

- 记录跳过原因和决策；
- 不允许跳过 GOAL_FIT（目标最终判定）；
- 不允许跳过 NEXT_DECISION（除非任务终止）。

## 5. 决策引擎

### 5.1 输入

```ts
interface CycleDecisionInput {
  goal: GoalContract;
  goalFit: GoalFitAssessment;
  cycle: CycleSnapshot;
  verification: DeliveryState;
  review: { needsFix: boolean; blockingIssues: number; unresolved: number };
  budget: { atMaxRounds: boolean; tokenExhausted?: boolean };
  task: { status: string; cancelled?: boolean; blockedReason?: string };
  progress: { fingerprint: string; repeated: number; criterionStalled: boolean };
}
```

### 5.2 输出

```ts
interface CycleDecisionResult {
  decision: CycleDecisionType;
  reason: string;
  evidenceRefs: string[];
  targetStage?: CycleStage;
  requiresUser?: boolean;
}
```

### 5.3 算法优先级

```text
1. 用户取消/终止 → ABORT
2. 权限/安全限制 → BLOCKED 或 WAIT_USER
3. 目标契约无效/重大歧义 → CLARIFY_GOAL
4. 目标变更待确认 → CHANGE_PROPOSED / WAIT_USER
5. 外部不可恢复阻塞 → BLOCKED
6. 证据不足/关键事实错误 → REANALYZE
7. 设计无法满足标准 → REDESIGN
8. 任务拆分/依赖不合理 → REPLAN
9. 实现有明确缺陷且设计成立 → REPAIR
10. 无进展 → REPLAN/REDESIGN/WAIT_USER
11. 预算耗尽 → BLOCKED/WAIT_USER
12. Goal Fit MET → COMPLETE
13. 否则 → CONTINUE/REPAIR
```

`COMPLETE` 只能在 `fit === MET` 或用户明确接受 `WITH_RISKS` 时产生；`verification.PASSED` 单独不足。

## 6. 无进展检测

指纹至少包含：

```text
goalVersion
cycleId
currentStage
plan content hash
step tool + args + exitCode + output hash
review issue fingerprints
criterion status map
```

判定：

- 连续 2 轮相同失败指纹 → 不再 REPAIR；
- 同一设计被否决 ≥2 次 → REDESIGN；
- Criterion 状态连续 ≥3 轮无变化且证据无新增 → REPLAN/WAIT_USER；
- 修复完成声明与评审结论冲突 ≥2 次 → WAIT_USER；
- 达到预算且未达标 → BLOCKED/WAIT_USER，不用无限重试。

停止自动循环必须写入决策原因和证据引用。

## 7. 与 Orchestrator 的集成

```text
Orchestrator 每轮结束
  → 收集 GoalFit/Verification/Review/Progress/版本
  → decideCycleAction()
  → 发 cycle.decision.created
  → 按 decision 执行：
       COMPLETE → 完成任务，保留 Goal Fit
       REPAIR → 现有修复轮（受无进展门禁）
       REPLAN → 修改 TDL/计划，不重跑已完成写入
       REDESIGN → 回到 DESIGN，新设计产物
       REANALYZE → 重新收集事实/ECO
       CLARIFY_GOAL → 目标澄清
       WAIT_USER → 停止自动执行
       BLOCKED/ABORT → 收尾
```

旧四出口保留兼容映射：

| 旧 | 新 |
| --- | --- |
| complete | COMPLETE（必须 Goal Fit 支持） |
| repair | REPAIR（无进展时升级） |
| fail_budget | BLOCKED/WAIT_USER |
| fail_delivery | REPLAN/BLOCKED |

## 8. 预算与并发

- 预算只限制资源，不直接等于失败；
- 达到预算但仍有可执行路径 → WAIT_USER/BLOCKED，说明缺口；
- 同一 Work 同时只允许一个决策引擎写入；
- Cycle 决策是幂等的：相同输入/版本产生相同 decisionId 或可去重。

## 9. 恢复

恢复时读取：

- 当前 Cycle 与阶段；
- 最后决策及原因；
- TDL revision、Plan 版本；
- Goal/Criterion/ECO/贡献/Evidence 版本。

版本不一致：`needs_replan`/`needs_context_refresh`，不复用旧决策。

## 10. 验收

- Cycle/Round 身份可区分；
- 真实阶段可重放，跳过有原因；
- 决策矩阵每个出口有测试；
- 无进展不靠轮数掩盖；
- `task.completed` 不能覆盖 Goal Fit；
- 真机：一次 REDESIGN 或 REANALYZE 真实发生并可追溯。

## 11. 未决

- Cycle 划分的触发阈值（哪些修复可留在同 Cycle）；
- 无进展指纹的稳定序列化；
- 旧 `cycle.snapshot` 与新阶段事件的兼容窗口。
