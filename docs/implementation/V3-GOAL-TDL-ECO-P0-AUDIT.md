# V3 Goal → TDL → Cycle → Execution + ECO + DMOCA + Long Task · P0 架构审计

| 字段 | 值 |
| --- | --- |
| **审计日** | 2026-11-25 |
| **仓库** | `feat/v3-goal-tdl-eco` @ `1524d2e`（含 DMOCA） |
| **规则** | 不另建 Runtime；Journal 为事件权威 |

## 总览

| 支柱 | 判定 | 说明 |
| --- | --- | --- |
| Goal / GDC | Existing / Partial | 八阶段投影 + `cycle.snapshot`；与 TDL `cycleId` 交叉弱 |
| TDL | Existing / Partial | WorkTask + 进度投影；种子多为扁平 L2，缺正式 level 树 UI |
| Cycle | Partial | Engineering Orchestrator 主路径；General/Knowledge 分叉 |
| DMOCA | Existing | `shared/dmoca.ts` + Eng 接线 + UI |
| **ECO** | **Missing→本次补** | 无 Package / Request / sufficiency / fact class |
| Long Task | Partial | `main/context/` 全栈；未绑 stage/workTask |
| Journal / Evidence | Existing | 缺 ECO 充分性门 |
| UI | Partial | GDC/TDL/DMOCA 有；缺树缩进与 ECO 卡 |

## P0 三问

1. **预算入口：** CB 覆盖计划辩论与执行审核；会话并行选模仍靠 planLead。  
2. **完成事件：** `round.delta` ≠ final；`round.answer`/`peer`/`plan.ready` 为正式交付。  
3. **贡献关联：** GDC/TDL 有证据数组；DMOCA 有快照投影；**无** ECO 上下文版本引用（本次补）。

## 实施顺序（本分支）

1. ECO 契约与投影薄层  
2. TDL `level` + 树投影 / UI  
3. Orchestrator 发 `eco.context.prepared`，DMOCA 尊重充分度  
4. 进度与 Goal 展示增强  
5. 测试 + 真机  

## 禁止重复

勿把 LT ContextManager 当 ECO；勿再建 GDC/TDL 状态机；勿用摘要 claim 当阶段放行。
