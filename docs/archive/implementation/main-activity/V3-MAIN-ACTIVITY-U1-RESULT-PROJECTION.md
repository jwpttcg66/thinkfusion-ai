# V3 主活动区重构 · U1 统一协作结果投影

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


状态：投影层已落地（TESTED）· UI 已在 U4/U5 接线 · 来源真实性由 U7 收敛  
基线（历史）：`cdc8308` → 当前 `main@8601fc2`  
分支（历史）：`feat/v3-main-activity-collab-result`（已合入 main）  
任务书：[`docs/spec/V3-MAIN-ACTIVITY-COLLABORATION-RESULT-TASK-BOOK.md`](../../spec/task-books/main-activity/V3-MAIN-ACTIVITY-COLLABORATION-RESULT-TASK-BOOK.md)（HISTORICAL）<br>
U7：[`docs/spec/V3-MAIN-ACTIVITY-U7-QUALITY-CONVERGENCE-TASK-BOOK.md`](../../spec/task-books/main-activity/V3-MAIN-ACTIVITY-U7-QUALITY-CONVERGENCE-TASK-BOOK.md)<br>
U0 审计：[`V3-MAIN-ACTIVITY-U0-AUDIT.md`](V3-MAIN-ACTIVITY-U0-AUDIT.md)

## 本阶段做了什么

| 交付 | 路径 |
| --- | --- |
| 统一结果类型 | `desktop-agent-macos/src/shared/collaboration-result.ts` |
| Engineering 适配器 | `projectEngineeringCollaborationResult(events…)` |
| General/Knowledge 适配器 | `projectConversationCollaborationResult(conversation, messages…)` |
| 回归测试 | `npm run test:collaboration-result` → `scripts/check-collaboration-result.mjs` |

## 数据调用链变化

- **权威来源不变**：AgentEvent / ConversationMessage / Synthesis / DebateSnapshot。
- **新增派生层**：`CollaborationResultView`（结论 / 意见 / 争议 / 评审 / 验证 / 交付 / SourceReference）。
- **Renderer 已接线**（U4/U5）：`CollaborationResultPanel`；U7 处理与时间线去重及来源真实性。

## 关键语义决定

1. Review `issues: string[]` 投影为完整 `ReviewIssueView`，`disposition` 默认 `pending`——有评审事件 ≠ 已处理。
2. `plan.debated` 且 `status === 'skipped'` **不**进入 `disputes`，避免空辩论。
3. issueId 由评审序号 + 原文稳定生成，同输入重放不变。
4. General 消息与会话分存：投影必须同时接收 `messages`。

## 测试

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:collaboration-result
```

实测（本机）：typecheck 通过；3/3 测试通过。

## 未完成（留给后续阶段）

- U2：计划辩论边界今日经 `summarizePlanDebate` 压成 `PlanDebate.summary`；需事件结构化切片或按 `debateId` 水合，投影才能有真 Claim/Dispute；并校正争议触发策略。
- U3：生产端拆开 `rawVerdict` 与结构化 issue（severity / recommendation / disposition），并打通修正关联。
- U4/U5：主活动区改读 `CollaborationResultView`；General 压缩进度面板，Engineering 收敛重复「最终交付」。
- 生产端 `review.ready` 事件形状尚未扩展（投影已预留字段）。
