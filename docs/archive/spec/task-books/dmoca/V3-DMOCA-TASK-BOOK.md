# ThinkFusion V3 动态多模型协作与贡献对齐架构及实施任务书

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


**文档版本：** V1.0  
**项目：** ThinkFusion V3  
**任务编号：** DMOCA-V3  
**文档性质：** 架构设计与正式实施任务书  
**参考代码基线：** `e903c56854e1bfb6c5b9afd38b234803ca917f2f`  
**实施原则：** 先审计、再修订契约、分阶段实施、真实运行验证  
**发布要求：** 本任务不包含正式发布、签名、公证或分发。  
**架构摘要：** [`../architecture/V3-DYNAMIC-MULTI-MODEL-ORCHESTRATION.md`](../../../../architecture/V3-DYNAMIC-MULTI-MODEL-ORCHESTRATION.md)

> 涉及代码改造的阶段，必须重新读取当时最新的 `main`、分支和 `AGENTS.md`。参考基线是审计依据，不代表远程仍停留在该提交。

---

# 第一章 项目背景

## 1.1 当前问题

1. **模型参与缺少动态决策**：不论任务大小与阶段都重复调用；简单任务也多模型；完成后仍参与无关阶段；关键问题又缺针对性补充。
2. **角色固定化**：不得把某模型永久定为主力/审核/设计；应按阶段与任务动态分配。
3. **输出方式不一致**：一次完整 / 分阶段 / 流式修订混用；初稿与终稿混淆；决策无法追溯贡献版本。
4. **辩论审核缺少统一参与控制**：不能只控轮数，还要控是否加人、是否独立分析、是否辩论/审核/复核、是否够证据、是否该停。
5. **与 TDL/GDC 未完全闭环**：每个子任务需明确参与者、角色、交付、对齐快照、进入辩论/审核的版本。

## 1.2 项目目标

建设 DMOCA：动态选模、动态角色、人数与预算、加入退出替换、兼容三种输出、贡献版本、异步对齐、按需辩论审核、成本可控、与 Goal/TDL/GDC/Collaboration/Journal 闭环、主活动区可解释。

最终：**自主决定需要哪些模型、承担什么、何时加协作、何时足够可停。**

---

# 第二章 总体架构

DMOCA **不是**新 Agent Runtime，是 Collaboration Engine 内的动态协作决策与贡献管理。

必须复用：Orchestrator、Collaboration Engine、Planner、Provider、TaskGrant、Debate、Review、Verifier、Journal、GDC、TDL、Permission、预算与事件。

禁止第二套：Runtime、调度器、任务状态机、Journal、EvidenceStore、权限、Verifier、与 GDC/TDL 重复工作流。

## 2.3 两个核心子系统

**A. Dynamic Model Orchestration**：能力匹配、筛选、人数、角色、预算、生命周期、是否新增。  
**B. Model Contribution Alignment**：接收输出、统一事件、完整贡献、版本、交付状态、快照、影响追踪、决策输入引用。

通过 ParticipationDecision、ModelRun、ContributionArtifact 关联。

逻辑结构：Goal → TDL → GDC → Dynamic Model Orchestration → Provider 执行 → Contribution Alignment → Collaboration（Synthesis/Debate/Review/Verify）→ DecisionSnapshot → Journal/GDC/TDL → 主活动区。

---

# 第三章 动态模型选择

## 3.1 ModelCapability（建议契约）

`providerId` / `modelId`；capabilities（analysis/architecture/coding/review/reasoning/longContext/toolUse/structuredOutput）；runtime（available/streaming/contextWindow）；costProfile；performanceProfile。

实施前必须核对现有 Provider 配置；**不得**为 Registry 重复维护已有可用性信息。

## 3.2 能力评价

任务适配、阶段需求、历史质量、结构化可靠性、延迟、费用、可用性；按角色/任务类别记表现；需样本量、时间窗、置信度。

## 3.3 选择流程

WorkTask → 类型与复杂度 → 阶段 → 所需能力与角色 → 候选能力 → 用户硬约束 → 预算 → ParticipationDecision → 调用。

每次记录：原因、任务、阶段、角色、候选、实选、未选重要候选及原因、预算、是否用户指定。

## 3.4 约束

用户指定不得擅自替换；禁用不得参与；Local/Remote/Hybrid 范围有效；Local 不可用不得静默 Remote；不可用不得登记为已完成；能力未知不得假装；超预算不得静默加调用；高风险审核失败不得伪装通过；用户可查看覆盖；选择与退出可追溯。

---

# 第四章 动态角色

角色（任务级）：Lead / Analyst / Architect / Challenger / Planner / Implementer / Reviewer / Verifier / Synthesizer / Adjudicator。

规则：一模型多角色；一角色多模型；执行实例区分；绑定 WorkTask+Cycle；可变化且记原因；Reviewer 独立；Verifier 不得仅凭主观意见认定成功。

独立性：审核不得把主方案当未质疑事实；须引用被审版本；高风险可要求不同模型/实例。

---

# 第五章 按阶段动态参与

| 阶段 | 策略摘要 |
| --- | --- |
| 分析 | L0 单模；L1 必要时+独立；L2/L3 多模独立；完成后不强制进设计 |
| 设计 | Lead/Architect；关键分歧才 Challenger；不为凑数制造分歧 |
| 辩论 | 按需：事实/数字/实质方案冲突；措辞差异不辩 |
| 计划 | 通常一 Planner；对接 TDL；不让所有设计模型重写计划 |
| 实现 | 模型给方案；工具走受治理执行；子任务可并行不同模型 |
| 审核 | 按风险；意见须 ACCEPTED/FIX_REQUIRED/REJECTED/DEFERRED/NOT_APPLICABLE/UNRESOLVED |
| 结论 | 基于固定贡献快照；不得直接用最新流式片段 |

---

# 第六章 参与生命周期

`CANDIDATE → SELECTED → ACTIVE → CONTRIBUTED → NEEDS_REASSESSMENT → ACTIVE|RELEASED`  
异常：`ACTIVE → FAILED|TIMED_OUT|CANCELLED → REPLACEMENT_CHECK`

加入：证据不足、实质争议、缺能力、审核未解、范围变、失败、需独立验证——先过预算权限。  
退出：角色完成、不再需要、超时失败、预算、取消、范围变——保留历史贡献。  
替换：新 ModelRun；旧状态与贡献保留；不把旧未完成输出伪装成新贡献。

---

# 第七章 统一贡献协议

支持：一次完整、分阶段、流式、修订、部分完成、失败超时、中断、重跑。不强制统一提示词/人设/内部阶段。

**ModelRun**：runId、work/workTask/cycle、participant/provider/model、role、status、时间、requestId、usageRef。  
**ContributionArtifact**：artifactId、runId、kind(stream_snapshot|phase_output|complete_response|revision)、phase?、version、status(partial|final|superseded)、contentRef、source/evidence refs、supersedes。

流式：delta 实时显示；不全量持久化为正式贡献；未完成不作最终；修订新版本。  
阶段识别优先级：Provider 结构 → 任务协议 → 可验证边界 → 确认规则 → UNKNOWN（保留原文，不伪造）。

---

# 第八章 异步贡献对齐

原则：正式综合/决策必须明确使用了哪些模型、贡献与版本。  
对齐对象是决策所需交付物，不是内部阶段同步。  
状态：WAITING / PARTIAL / READY / DEGRADED / BLOCKED / FINALIZED。  
完成屏障由 ParticipationPolicy 决定，不要求全员完成。  
部分快照须记完成/未完成/失败/排除原因与影响；不得展示为全员共识。

---

# 第九章 快照与决策版本

**ContributionSnapshot**：participants（runId/role/artifactIds/selected/status）、alignmentStatus。  
**DecisionSnapshot**：contributionSnapshotId、opinion/dispute/evidence/review/verification refs、conclusion、unresolved、status。

版本变更：新 artifact → supersede 旧 → 影响分析 → 局部重评 → 必要时新快照。禁止因局部修订无条件重跑所有模型。

---

# 第十章 辩论、审核与验证控制

统一参与决策与预算；不建冲突的人数预算。  
辩论优先实质冲突；非实质合并意见不建 Dispute。  
预算：轮数、新增模型、追加调用、费用、时间、无新证据停、重复争议停。  
审核按风险；复核关联原问题/版本/修复/新结果/证据。  
停止：达成功标准、争议解、无新意见、边际收益低、预算、取消、等用户、关键证据缺失。

---

# 第十一章 预算

复用现有预算基础设施（Work/WorkTask/Cycle/阶段/ModelRun/Debate/Review），不另建预算库。  
维度：调用次数、token、费用、耗时、并行人数、辩论轮、审核次、追加调用。  
L0–L3 默认策略与 CB 对齐；普通可降级；高风险缺门禁须阻断并说明。

---

# 第十二章 集成

Goal：选模服务目标。TDL：策略绑定 WorkTask。GDC：阶段权威。Collaboration：复用执行。Journal：扩展事件（participation/run/contribution/alignment/decision.* 为建议名，优先扩展现有体系）。UI：任务/阶段/参与/角色/贡献/版本/争议/审核/结论；轨迹费用走独立入口。

---

# 第十三章 主活动区 UI

回答六问：目标、在做什么、谁参与、交付了什么、未解问题、下一步。  
禁止：流式当终结论、部分当全员、模型数=意见数、重复意见=争议、规则伪装模型审核、未验证显示通过、历史与有效版本混放。

---

# 第十四章 实施阶段

| ID | 目标 | 关键验收 |
| --- | --- | --- |
| DMOCA-P0 | 最新代码审计 | 判断可追溯代码；不改业务代码 |
| DMOCA-P1 | 能力与参与策略 | 普通不多模；复杂可加；用户指定遵守；理由可追溯 |
| DMOCA-P2 | 角色与生命周期 | 多角色；退出保留历史；替换不覆盖 |
| DMOCA-P3 | 统一贡献协议 | 三种输出可登记；流式不误完成；修订不覆盖 |
| DMOCA-P4 | 对齐与决策快照 | 正式结论引用版本；部分不成全员共识 |
| DMOCA-P5 | 辩论审核预算 | 无争议不辩；小任务不强制模型审；高风险不静默跳 |
| DMOCA-P6 | TDL/GDC/UI | 子任务独立策略；主活动区清晰 |
| DMOCA-P7 | 端到端验收 | 三场景+异步+超时失败+预算+真机证据 |

---

# 第十五～十九章（指标、安全、工程规则、交付物、产品定义）

见架构摘要文档与本仓库 `AGENTS.md`。验收标准：**不是调用更多，而是每次调用有目的、贡献可追踪、决策有依据、无效协作更少。**

## 附录 A 优先级

P0：审计、动态选模、贡献协议、对齐快照。P1：角色生命周期、Debate/Review/Budget、TDL/GDC/UI、E2E。顺序以 P0 审计为准。

## 附录 B 十项原则

见架构文档。

## 实施建议（启动顺序）

先做 P0。确认三件事再建码：  
1) 预算覆盖了哪些调用入口；  
2) 完成事件能否区分阶段/完整/流式中间态；  
3) TDL/GDC/Journal 是否已有可复用贡献关联。
