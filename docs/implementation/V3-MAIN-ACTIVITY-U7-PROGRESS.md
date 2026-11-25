# V3 主活动区 · U7 实施进度

基线：`main@8601fc2`  
分支：`feat/v3-main-activity-u7-quality`  
任务书：[`docs/spec/V3-MAIN-ACTIVITY-U7-QUALITY-CONVERGENCE-TASK-BOOK.md`](../spec/V3-MAIN-ACTIVITY-U7-QUALITY-CONVERGENCE-TASK-BOOK.md)

## 已落地

| 项 | 事实 |
| --- | --- |
| P0 展示去重 | `ConversationView.suppressStructuredResult`；`TaskConversation.omitResultSummaries`；`App.tsx` 在结果面板存在时开启 |
| P0 来源真实性 | `mapClaimsAsOpinions` 不再伪造 `evidence:${n}` messageId；证据挂真实 `messageId` 或仅 label |
| P1 意见质量 | Engineering 成员回答标 `supplement`；综合分歧立场进 `oppose`；面板支持展开全部意见 |
| P1 Debate 统一表达 | DebateSnapshot 投影含 claims / exchanges / verdict，进入同一结果面板 |
| P1 Review 语义 | `ReviewIssueDetail` 增加 rationale / targetRef / evidenceLabels；规则路径写明「关键词降级」 |
| 过程层默认收起 | `CollaborationResultPanel`：`compactProcess` 缺省 true |
| 文档对齐 | STATUS / 旧任务书 / U1 / U6 / U2–U6 记录与基线同步 |

## 仍待

| 项 | 说明 |
| --- | --- |
| 三场景真机 | General / Knowledge / Engineering 各至少一次完整展示验收 |
| 来源点击跳转 | 当前展示可读来源标签；定位跳转可后续迭代 |

## 自动化

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:collaboration-result
```
