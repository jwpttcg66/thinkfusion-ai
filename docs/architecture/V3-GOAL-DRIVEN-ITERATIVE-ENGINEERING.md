# ThinkFusion V3 用户目标驱动的循环式工程协作系统说明书

**文档版本：** V1.0  
**文档性质：** 产品设计与系统架构说明书  
**适用范围：** ThinkFusion V3  
**状态：** DESIGN（方向冻结；运行时以 STATUS + 任务书为准）  
**基线：** `origin/main@d152137`  
**核心机制：** Goal-Driven Iterative Engineering Collaboration  
**设计原则：** 用户目标驱动、循环式协作、证据驱动决策、持续迭代、全过程可追溯

> 本文确立产品和架构方向。正式实施见  
> [`docs/spec/V3-GOAL-DRIVEN-CYCLE-TASK-BOOK.md`](../spec/V3-GOAL-DRIVEN-CYCLE-TASK-BOOK.md)。  
> **不另建** Agent Runtime / Journal / Approval / Verifier / EvidenceStore；复用 Collaboration Engine。

---

## 一、项目背景与设计目标

### 1.1 背景

传统 AI Agent 工程任务常为一次性：接收 → 分析 → 计划 → 实现 → 输出。复杂工程中：用户目标常不完整；分析/设计会出现新约束与多方案；实现与审核可能互相否定；一轮通过不等于目标达成。

ThinkFusion V3 应从一次性执行升级为**用户目标驱动的循环式工程协作**。

### 1.2 核心目标

理解真实问题；将用户目标转为可验证工程目标；持续分析与多方案比较；对真实分歧辩论；计划 → 协同实现 → 独立审核 → 证据复核 → 决定下一轮；保留产物与历史；支持长任务暂停/恢复。

### 1.3 核心产品定义

系统围绕用户最终目标组织分析、设计、辩论、计划、实现、审核与决策。每轮必须回答：真正目标是什么、为何如此、方案是否合理、实现是否正确、是否满足目标、下一步继续/修正/重设计还是调目标。

---

## 二、核心设计原则

1. **用户目标优先** — 不满足于表面任务；目标不清先澄清。  
2. **循环推进** — 允许局部回退，不因局部问题推倒全部。  
3. **辩论由真实分歧触发** — 禁止为记录而造争议。  
4. **证据优先** — 无证据结论标为假设/推断/待验证。  
5. **目标与技术质量双重验收**。  
6. **过程可追溯** — 目标、设计、辩论、计划、变更、审核、结论皆可回看。

---

## 三、总体工作机制

### 三层

| 层 | 职责 | 实现落点 |
| --- | --- | --- |
| Goal Layer | 理解/维护/评估用户目标 | `ConversationGoal` + collab `Goal` + GDC 投影 |
| Cycle Layer | 多轮阶段、回退、辩论组织、下一轮决策 | 薄 `CycleCoordinator`（派生视图） |
| Execution Layer | 模型/工具/测试/审核/验证 | Orchestrator + Collaboration Engine |

```
用户 → Goal Layer → Cycle Layer → Collaboration Engine / AgentOrchestrator → Tools
```

模块名是逻辑职责，**不要求**新增同名基础设施。

---

## 四、目标理解与推演

六维：用户意图、最终目标、目标价值、成功标准、约束、可行性。  
状态：DRAFT / CLARIFYING / CONFIRMED / ACTIVE / AT_RISK / CHANGE_PROPOSED / BLOCKED / ACHIEVED / ABANDONED。  
区分：目标澄清、目标优化、目标变更（重大变更需记录并在需要时确认）。**不得擅自降低目标。**

---

## 五、循环式工程协作流程

前置：目标理解与推演（持续参与决策）。  
阶段：1 分析 → 2 设计 → 3 方案辩论（可跳过）→ 4 计划 → 5 实现 → 6 审核 → 7 审核辩论（可跳过）→ 8 结论 → 是否达标 → 下一轮或整体验收。

实现遵守 TaskGrant、审批、Journal、真实工具结果。审核含技术质量与目标符合度。

---

## 六、循环决策机制

结论类型：ACCEPTED / ACCEPTED_WITH_RISKS / NEEDS_FIX / NEEDS_REVIEW / NEEDS_REDESIGN / NEEDS_ANALYSIS / UNRESOLVED / BLOCKED / ABORTED。

允许局部回退；下一轮继承已确认目标与已验证成果；须有收敛（预算、无进展、重复问题、用户介入）。

---

## 七、多任务与多层循环

主工程 + 子任务独立循环；子任务通过 ≠ 主工程通过；并行须有边界与冲突规则。

---

## 八、工程产物与数据模型

逻辑产物：Goal / Analysis / Design / Debate / Plan / Implementation / Review / ReviewDebate / Conclusion。  
逻辑对象：Work / Goal / WorkCycle / WorkTask / WorkArtifact / WorkDecision。  
正式实现前审计现有类型与 Journal；**版本化**，SUPERSEDED 不得当现行有效。

---

## 九、长任务运行与恢复

复用 Journal、Checkpoint、暂停/恢复；不另建恢复栈。

---

## 十、三场景适配

| 场景 | 机制 |
| --- | --- |
| General | 目标理解 → 分析 → 必要时验证/辩论 → 结论 |
| Knowledge | 目标理解 → 调查 → 分析 → 必要时辩论 → 结论（默认不改代码） |
| Engineering | 完整八阶段循环（辩论按需） |

---

## 十一、主活动区 UI

须可见：最终目标、完成度、轮次/阶段、核心意见与争议、审核、为何下一轮、下一步。  
结构：目标区 / 循环进度 / 核心意见 / 执行结果 / 结论与下一步。  
遵守 U7 去重与真实性（不伪造 reasoning）。

---

## 十二、与现有架构关系

复用：AgentOrchestrator、TaskGrant、Debate、Review、Verifier、Journal、Evidence、Checkpoint、Permission/Approval。  
禁止未经审计新增第二套 Runtime/调度/权限/Journal/Verifier/Evidence/审批。

---

## 十三、质量、安全与治理

每轮不自动扩大权限；角色逻辑分离（实现者不得自宣审核通过）；高风险决策可人工介入。

---

## 十四、验收标准

目标理解、循环管理、辩论按需、工程执行、审核独立、可追溯、UI 可见性——均须真实代码/测试/运行证据，不得仅凭文档或模型自述。

---

## 十五、实施顺序（摘要）

P0 审计 → P1 目标层 → P2 循环管理 → P3 产物历史 → P4 协作接入 → P5 长任务治理 → P6 主活动区 → P7 端到端验收。

---

## 十六、最终产品原则

目标优先；循环推进；辩论按需；审核独立；证据优先；成果继承；持续收敛；过程透明。

---

## 十七、最终定义

**理解用户目标 → 分析 → 设计 → 必要时辩论 → 计划 → 实现 → 独立审核 → 必要时审核辩论 → 结论 → 下一轮。**  
最终评价标准：用户真正希望达到的目标是否被可靠实现。
