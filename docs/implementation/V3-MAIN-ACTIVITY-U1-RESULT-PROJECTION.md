# V3 主活动区重构 · U1 统一协作结果投影

状态：投影层已落地（TESTED）· UI 尚未消费  
基线：`origin/main@cdc8308`  
分支：`feat/v3-main-activity-collab-result`  
任务书：[`docs/spec/V3-MAIN-ACTIVITY-COLLABORATION-RESULT-TASK-BOOK.md`](../spec/V3-MAIN-ACTIVITY-COLLABORATION-RESULT-TASK-BOOK.md)  
U0 审计：[`V3-MAIN-ACTIVITY-U0-AUDIT.md`](./V3-MAIN-ACTIVITY-U0-AUDIT.md)

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
- **Renderer 尚未接线**：U4/U5 才改主活动区消费此投影；当前无第二套权威状态。

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

- U2：把 Debate 引擎 Claim/Dispute 完整挂进投影；争议触发策略。
- U3：生产端补齐 severity / recommendation / disposition 真值与修正关联。
- U4/U5：主活动区改读 `CollaborationResultView`。
- 生产端 `review.ready` 事件形状尚未扩展（投影已预留字段）。
