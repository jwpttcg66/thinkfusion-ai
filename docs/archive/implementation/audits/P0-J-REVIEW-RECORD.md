# P0-J 设计评审记录

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


状态：**通过（2026-11-19 关闭）**。
日期：2026-11-19。

> 本文关闭的是**设计/契约评审门禁**，不等于 P1–P6 全部实现完成。
> 当前代码/阶段状态见 [STATUS.md](../../../implementation/STATUS.md)。
评审对象：`product-v3`。
被评审快照：`2fc5ce3`（P0-J 修复提交）。
修复提交：`6135f0f`（复评残余项）。
代码基线：`cd30be3`（自该提交后无源代码变更）。

## 1. 评审方式

由两个独立子代理完成，作者未参与判定：

| 评审 | 范围 | 方法 |
| --- | --- | --- |
| 文档一致性评审 | 契约、状态、角色、Policy、证据、任务书、快照、链接 | 只读审计，逐项给 `文件:行` |
| 代码事实评审 | P1-001 结论、四条回路、Planner、Debate、Prompt 构造器、证据归属 | 只读审计，核对源码与 git |

## 2. 结论

**P0-J：通过（2026-11-19 关闭）。**

条件已满足：

1. 文档评审的 3 个阻断项、6 个应修项全部关闭；
2. 代码评审的 3 处事实偏差修正；
3. P0-04（Feature Flag）与 P0-06（回滚演练）完成；
4. P1-001 已按用户授权签收。

关闭记录：P0-04 `collaboration/mode.ts` + 模式测试；P0-06 钻取记录；
P1-001 签收（2026-11-19）。

## 3. 文档评审结果

### 3.1 阻断项（全部关闭）

| # | 问题 | 处理 | 状态 |
| --- | --- | --- | --- |
| B1 | `Verdict` 悬空，P0 冻结清单不一致 | P1-002 定义 `Verdict`，`Verification` 为别名；01 与 TASK-BOOK 冻结清单统一为 17 类 | 已关闭 |
| B2 | `EngineeringTaskState` 三份定义 | 以 `ENGINEERING_CONTRACT §1` 为唯一权威；工作空间与 04-p3 改为引用 | 已关闭 |
| B3 | `KnowledgeCard/Topic` 两套定义 | 以 `KNOWLEDGE_SPACE` 为唯一权威；03-p2 改为引用 | 已关闭 |

### 3.2 应修项

| # | 问题 | 处理 | 状态 |
| --- | --- | --- | --- |
| 1 | ARCHITECTURE 的旧 `Claim` 与 V3 冲突 | 标注为 V2.1 旧类型，不用于 V3 | 已关闭 |
| 2 | 重复 TS 契约 | 去掉 QuestionInput/ContractInput/EvidencePackContext/CollaborationMode/AgentCapabilities 重复定义 | 已关闭 |
| 3 | 06-p5 的 Policy 缺 `allowWebQuestioner` | 改为引用 P1-002 的 `Policy` | 已关闭 |
| 4 | 05-p4 的 EvidenceRef 字段不符 | 改为顶层 `hash` + `source.capturedAt` | 已关闭 |
| 5 | 状态字面不统一 | README/架构文档统一为「方向确认；P0 门禁未过；未实施」 | 已关闭 |
| 6 | P0-02 冻结范围不一致 | 01 与 TASK-BOOK 统一为 P1-002 的 17 类对象 | 已关闭 |

### 3.3 复评新增（已修）

| # | 问题 | 处理 |
| --- | --- | --- |
| 1 | P0-F 结论行重复、粗体破损 | 恢复单句 |
| 2 | `Participant` 与 `AgentCapabilities` 七项字段重复 | `Participant extends AgentCapabilities`，后者补进对象目录 |

### 3.4 建议项

已处理：旧名称（AgentProfile/CollaborationPlan/Task/Evidence）、Verdict 命名、
P1-002 `Verdict[]`、5 份架构文档重复基线行、状态字面。
保留：`forceAllChannels` 明确为 UI 覆盖、不进 `Policy`。

## 4. 代码事实评审结果

| 项 | 结论 |
| --- | --- |
| 统一协作引擎 | 未实现；`collaboration/` 仍只有 strategy/runner |
| Planner 选人 | 未实现；MasterAgent 仍全量 |
| Debate 主流程 | 仍在；ConversationRunner/AgentOrchestrator 未拆 |
| EvidencePack 归属 | 仍用 debateId；新 ownerType 仅设计 |
| Prompt 构造器 | 27 个构造点存在；网页指令仍在 |
| QuestionerInput/allowWebQuestioner | 零代码实现 |
| 四条回路 | 仍在 |
| cd30be3 后源码 | 零变更 |

修正的文档偏差：

- 构造器清单从 16 扩到 27，并注明另有 3 个装配点由 P1-00A 补入；
- `buildEngineeringAnswerQuestion` 改为“数据块、无指令”；
- `buildToolFollowupQuestion` 标注 local/cloud、非网页；
- `buildLeadSummaryQuestion` 标注非网页（网页走 `inlineLeadInstructions`）；
- `buildPickPrompt` 标注仅 local/cloud 且生产未引用；
- P1-001 的 round-evidence 改为“已停止写入；类型与 GC 读取仍在”。

## 5. 验证

| 项 | 结果 |
| --- | --- |
| 文档相对链接 | 69 篇全通 |
| 任务书 | 69 任务 / 69 章节，1:1 |
| 冻结清单 | 01 与 TASK-BOOK 一致 |
| 重复核心契约 | 各只剩一处 |
| 代码变更 | `cd30be3..6135f0f` 源码零变更 |

## 6. 残余门禁

- [x] P0-04 Feature Flag 实现
- [x] P0-06 回滚演练
- [x] P1-001 形式签收（用户）
- [x] P0-J 关闭；开工 P1-00A

## 7. 下一步

1. 完成 P0-04 / P0-06；
2. 用户签收 P1-001；
3. P0-J 正式关闭；
4. 从 P1-00A（代码职责映射）开始实施。
