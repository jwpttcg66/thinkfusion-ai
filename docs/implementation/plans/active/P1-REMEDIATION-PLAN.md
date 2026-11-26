# P1 整改执行计划（基于 2026-11-26 V3 架构一致性整改）

本文只记录整改项的落地结论与仍未闭合的边界。当前状态总表见
[STATUS.md](../../STATUS.md)；已落地项保留一行结论与证据，不再写「未开始」，
避免旧审计被误读成当前事实。

## 已闭合（第一批 P0，2026-11-26）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| ECO 正式角色门禁 | 参与与职责拆开；不足/过期时摘除 architect/reviewer/verifier/adjudicator，钉住的人仍可旁听；派发前 `roleEligibility` 复核 | `test:dmoca`（25） |
| TDL L2 自动分解 | 模型优先，其次按写入目标目录归纳；归纳不出来标 `NEEDS_ANALYSIS` 并取消自动批准 | `test:tdl*`（17） |
| Goal → WorkTask 版本绑定 | 任务创建写 `goalId/goalVersion`，种树继承；修订有版本/影响闭包/继承判定与 IPC 入口 | `test:gdc-goal`（6） |
| 恢复 ECO 门禁 | 检查点有效但 ECO 不兼容 → `needs_context_refresh` + `context.refresh.required` | `test:context-recovery`（8） |
| DMOCA 贡献快照 | 评审交锋生成 artifact/snapshot/decision，钉住每人最后一版终稿；完整性校验不静默改数据 | `test:dmoca`（25） |

## 第二批 P1（2026-11-26，代码 `7727abb`）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| P1-01 ECO 按需工程探索 | `ContextRequest` 支持 FILE_READ / DIRECTORY_DISCOVERY / SYMBOL_LOOKUP / CALL_RELATION / TEST_DISCOVERY / DIFF_READ；计划里可用 `contextRequests` 主动发起；`eco-explore.ts` 真实读取（有上限、越界跳过），每条资源盖 `provenance`、包记 `sources` 与版本；代码/目标变化发 `eco.context.invalidated` | `test:eco-explore`（7）、`test:eco`（10） |
| P1-02 子任务独立 Cycle | 每个 L2 独立 `cycleId`，L3 步骤跟随；`subtask-cycle.ts` 投影阶段/结论；步骤失败只把依赖者标 `blocked`（`emitSubtaskCycleFollowup`）；跨子任务写冲突发 `cycle.subtask.conflict`；修复轮只让做未通过的子任务 | `test:subtask-cycle`（8） |
| P1-03 三场景 DMOCA 统一 | 会话轮次走 `conversationDecisionSnapshot`（内部复用 `snapshotFromExchanges`），发 `model.decision.snapshot`（含 artifacts）；`projectDmocaFromConversationEvents` 与工程投影同一视图；单模型不假装交叉验证；无正文不造决策 | `test:dmoca`（25） |
| P1-04 Workflow 生产闭环 | 注册表 4 条固定流程（能力 id 全部来自 `TOOL_NAMES`）；条件/循环/并行/审批节点有真实语义（循环按 count 展开、并行如实串行、approval 强制人工批准、`until` 明确拒绝）；`Orchestrator.submitWorkflow` + IPC `workflow:run` 复用审批/授权/报告 | `test:workflow`（10） |
| P1-05 长任务版本一致性 | `checkVersionChain` 逐层比对 Goal → WorkTask → ECO → 贡献 → 决策并向下游传播作废；`resume` 发 `version.consistency`、目标变化判 `needs_replan` 并改写继续提示词 | `test:version-consistency`（7）、`test:context-recovery`（8） |

以上均为 `IMPLEMENTED / TESTED`：`npm run verify` 全绿，但**没有**为这批新增分支跑
真机样本（工作流入口、会话决策快照、子任务循环面板都还没有界面路径），
因此一律不标 `VERIFIED`。

## 仍未闭合的边界（不藏）

1. **ECO 符号/调用定位**是正则级扫描，不是 AST/类型绑定；扫不到就如实进 `skipped`，
   不推测。深度 Java 结构理解仍在 P2-01。
2. **子任务循环**复用主任务的执行轮次，不新建调度器（硬性约束）。因此同一计划仍是
   一次 `runPlan`，失败隔离发生在 WorkTask 状态与修复轮范围上，不是物理并行。
3. **Workflow**：`until` 这类运行时条件循环不支持（`validateWorkflow` 明确报错）；
   parallel 节点按定义顺序串行执行并在 `notes` 里写明；`workflow:run` 只有 IPC，
   没有界面入口。
4. **会话决策快照**已落事件，界面还没有展示「这一轮钉住的是哪一稿」。
5. **Goal 修订**仍只有 IPC（`task:revise-goal`），没有界面确认流程。

## 顺序与回退

1. P1-01/P1-02 是 P1-05 的前置，已按此顺序落地；
2. Workflow 最后接，复用已稳定的 TDL/执行链，没有第二套 Runtime；
3. 任一步不通过时回退对应入口接线，保留旧状态与已落库事件；不删除已完成能力；
4. 提交前跑 typecheck 与相关专项测试；不做全量「回归」流程；真机验收用隔离 userData。
