# P0 设计书：最新代码审计与质量基线

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


**阶段：** P0  
**状态：** DESIGNED → 本文件完成后 = AUDITED  
**验收：** 每条结论有代码路径；区分 Existing / Partial / Missing / Thin（已有但质量不足）。

## 1. 范围

确认 `main@e47fd59` 上 Goal / TDL / Cycle / Execution / ECO / DMOCA / LT 真实状态，作为后续 P1–P8 **不得重复施工** 的基线。不改业务代码。

## 2. 审计矩阵

| 能力 | 判定 | 路径证据 | 质量缺口（本整改要补） |
| --- | --- | --- | --- |
| Goal 投影 | Existing | `shared/goal-driven-cycle.ts` `projectEngineeringGoal` / `assessGoalFit` | 无独立 Goal 持久模型与 goalVersion 变更事件 |
| GDC Cycle | Existing | 同文件 `projectWorkCycleFromEvents`；`orchestrator` `cycle.snapshot` | 与 `WorkTask.cycleId` 未绑定 |
| TDL WorkTask | Existing | `shared/task-decomposition.ts` | level 有字段；缺环依赖检测、SKIPPED、goalId |
| TDL 进度 | Thin | `progressRatioFromRows` | 缺加权、缺「阻塞不计完成」专项用例扩展 |
| TDL 种子 | Thin | `seedWorkEventsFromPlan` L1+L3 | 无 L0 Work 节点；无 L2 中间层 |
| DMOCA | Existing | `shared/dmoca.ts` + Eng 接线 | 未读 ECO 充分度做硬门禁（只写 reasons） |
| ECO | Thin | `shared/eco.ts` + `eco.context.prepared` | 资源多为 plan 占位；无 ContextRequest 闭环；无失效刷新 |
| LT Context | Existing | `shared/context.ts` + `main/context/` | 检查点未挂 `contextPackageId` / goalVersion |
| UI | Thin | `WorkBreakdownPanel` / `CollaborationResultPanel` | 有 L 标签与 ECO 区；缺请求补充展示与过期态 |
| 测试 | Thin | `test:eco` 4 / `test:dmoca` 7 / `test:tdl*` | 无分阶段 `test:gtec-pN`；缺契约负面用例 |

## 3. P0 关键三问（复核）

1. **预算：** CB 覆盖计划辩论与执行模型审核；会话并行仍靠 planLead → P5 再收紧。  
2. **完成事件：** delta≠final 已在 DMOCA 投影；ECO 不得把未核验资源标 verified_fact → P3。  
3. **贡献/上下文关联：** DecisionSnapshot 未引用 contextPackageId → P3/P5。

## 4. 整改依赖图

```
P0(本文件)
 → P1 Goal+TDL 契约加深
 → P2 进度规则加深
 → P3 ECO 实质化 ─┐
 → P4 Cycle↔TDL ──┼→ P5 DMOCA×ECO 硬门禁
 → P6 LT 挂版本 ←──┘
 → P7 UI
 → P8 真机分场景
```

## 5. 本阶段交付

- [x] 本设计书  
- [x] 总计划 `docs/superpowers/plans/2026-11-25-gtec-phased-quality.md`  
- [ ] STATUS § 注明「gtec-phased 质量整改进行中」  
- **不修改** `desktop-agent-macos/src/**` 业务逻辑  

## 6. 验收命令

无代码测试。人工核对：打开上表路径文件，确认「判定」与仓库一致。
