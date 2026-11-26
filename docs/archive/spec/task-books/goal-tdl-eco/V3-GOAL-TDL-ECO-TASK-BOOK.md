# ThinkFusion V3 分层任务分解与长任务进度管理架构及实施任务书

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


**版本：V2.0**  
**性质：正式架构与实施任务书**  
**适用项目：ThinkFusion V3**  
**核心范围：Goal、TDL、Cycle、Execution、ECO、DMOCA、长任务管理**  
**实施原则：复用现有架构、事实驱动、增量实施、可恢复、可验证**  
**架构摘要：** [`../architecture/V3-GOAL-TDL-ECO-ARCHITECTURE.md`](../../../../architecture/V3-GOAL-TDL-ECO-ARCHITECTURE.md)

> 本 V2.0 **重新整合** Goal/TDL/Cycle/Execution，并正式增加 **ECO**；不是在旧任务书上简单加一个模块。P0–P8 是否已实现必须以代码与真机为准，不得用文档冒充完成。

---

# 一、背景与修订目标

复杂工程协作需：理解目标 → 读工程 → 分解任务 → 动态选模 → **准备工程上下文** → 分析设计辩论 → 计划执行 → 审核回环 → 目标检查 → 长任务可恢复。

本次七个问题：任务层级、虚假进度、持久化/恢复、上下文膨胀、旁听模型无工程事实、多模型输出难对齐、偏离用户目标。

最终：Goal 驱动 + L0–L3 树 + Cycle 循环 + ECO 上下文保障 + DMOCA 协作 + 长任务压缩恢复 + UI 可观察。

---

# 二、总体架构

四层：Goal / TDL / Cycle / Execution。  
横向：ECO / DMOCA。跨层：Long Task Manager。

原则摘要：Goal 定方向；TDL 管结构；Cycle 管阶段；Execution 复用 Orchestrator；ECO 管工程认知；DMOCA 管协作；进度与正式决策必须可追溯证据。

---

# 三、L0 Goal Layer

Goal 模型含 intent、desiredOutcome、successCriteria、constraints、assumptions、openQuestions、goalVersion、status（ACTIVE / NEEDS_CLARIFICATION / BLOCKED / COMPLETED / CANCELLED）。

区分澄清 / 优化 / 变更；重大变更须用户确认。在拆分、设计、计划、子任务完成、重设计、恢复、最终结论处做 Goal 检查。

---

# 四、L1 TDL Layer

四级：L0 Work / L1 Task Group / L2 Subtask / L3 PlanStep。  
WorkTask：父子、依赖、验收、状态、进度、blockers、goalId/goalVersion。  
状态含 SKIPPED（须记原因，不算成功）。  
进度加权汇总但禁止未启动计完成、禁止阻塞因时间涨进度、完成须验收证据。  
允许动态新增/拆分/合并/重规划，变更须记原因；新增须重算分母。

---

# 五、L2 Cycle Layer

标准循环：Goal Reasoning → Analysis → Design → Design Debate? → Planning → Implementation → Review → Review Debate? → Conclusion → ACCEPTED | NEEDS_FIX | NEEDS_REDESIGN | NEEDS_ANALYSIS | BLOCKED。  
支持局部回退与多层独立 Cycle；父任务做集成审核。结论须含依据、贡献快照、证据、未决问题、后续动作。

---

# 六、H1 ECO（本次核心新增）

**没有完整读仓 ≠ 不能参与；没有足够工程上下文 ≠ 可承担超认知职责。**

职责：基础上下文、任务上下文、裁剪分配、按需探索、事实/推断分类、充分度、版本追踪。  
不负责：任务顺序、最终角色、辩论组织、权限、改代码、第二 Runtime。

三层：工程基础 / 任务相关 / ContextRequest 补充。  
充分度：SUFFICIENT / PARTIAL / INSUFFICIENT / STALE（按架构/实现/依赖/数据/约束/证据/版本维）。  
事实类：VERIFIED_FACT / PROVIDED_CONTEXT / INFERENCE / GENERAL_KNOWLEDGE / UNKNOWN。  
EngineeringContextPackage 有版本；代码/目标变化触发失效检查。

与 DMOCA：ECO 管「知道什么、够不够」；DMOCA 管「谁参与、交什么」。

---

# 七、H2 DMOCA

按风险/能力/预算/ECO 充分度动态选模与角色；统一贡献协议与快照；按需辩论审核（无新证据则停）。复用已有 `shared/dmoca.ts` 与 CB 门禁。

---

# 八、长任务管理

四类状态分离：Task / Execution / Session / Context。  
持久化 = 任务状态 + 事件日志 + 检查点 + 分层上下文。  
复用 ContextManager；压缩阈值按窗口比例可调；检查点原子提交；恢复须检查工程上下文版本与贡献有效性。

---

# 九、执行层复用

复用 Orchestrator、Collaboration、TaskGrant、Approval、Journal、Verifier、Evidence、Checkpoint、ContextManager、Provider。  
禁止重复 Runtime/Scheduler/Journal/Verifier/EvidenceStore/权限/状态机/执行器。  
Local/Remote/Hybrid 与 Web 独立通道规则不变。

---

# 十、UI

主工作区：目标、阶段、任务树、进度、模型参与、**ECO 充分度**、交付、阻塞、审核、下一步。  
独立入口：对话 / 轨迹 / 统计。不展示虚构内部思考。

---

# 十一、实施阶段 P0–P8

| 阶段 | 目标 |
| --- | --- |
| P0 | 最新代码审计与基线 |
| P1 | Goal + L0–L3 任务模型 |
| P2 | 真实进度与汇总 |
| P3 | ECO 工程上下文编排 |
| P4 | Cycle 循环与局部回退 |
| P5 | DMOCA 与贡献对齐（含 ECO 充分度门） |
| P6 | 长任务持久化/压缩/恢复 |
| P7 | UI 任务树与可观察性 |
| P8 | 端到端与真机 |

依赖：P0→P1→P2；P3∥P4 后 →P5；P6→P7→P8。每阶段区分 DESIGNED / IMPLEMENTED / INTEGRATED / TESTED / E2E / DEVICE。

---

# 十二–十五、验收与约束

架构/工程认知/进度/长任务/用户目标五类验收。  
禁止：未审计假设缺失、重复建设、ECO=第二理解引擎或调度器、旁听裁决、推断当事实、自报进度、压缩丢证据、静默换 Local/Remote、跳过必要审核、无条件重复辩论、擅自降目标、文档冒充真机。

**最终原则：** 用户目标定方向；任务树定结构；循环定过程；工程上下文定能否正确参与；动态编排定职责；执行证据定是否完成；检查点定能否延续。
