# V3 主活动区重构 · U2–U6 实施记录

基线：`origin/main@cdc8308`  
分支：`feat/v3-main-activity-collab-result`  
任务书：[`docs/spec/V3-MAIN-ACTIVITY-COLLABORATION-RESULT-TASK-BOOK.md`](../spec/V3-MAIN-ACTIVITY-COLLABORATION-RESULT-TASK-BOOK.md)

## U2 · Debate 争议驱动与结果展示

| 项 | 事实 |
| --- | --- |
| `PlanDebate.result` | 新增结构化切片：claims / disputes / exchanges / verdict |
| 生产 | `compactPlanDebateResult(DebateState)`；`debatePlan` 返回时写入 |
| 投影 | 有 disputes 才进 `CollaborationResultView.disputes`；无争议不伪造双方 |
| 触发 | 仍复用 `shouldDebatePlan`（auto 跳过小只读计划；`convergenceStop` 提前停） |

## U3 · Review 内容与闭环形状

| 项 | 事实 |
| --- | --- |
| `ReviewIssueDetail` | title / description / severity / disposition / recommendation |
| `review.ready` | 增加 `rawVerdict`、`issueDetails` |
| `review.disposition` | 权威处理决定事件；拒绝/暂缓强制 reason |
| `reviewExecution` | 规则/模型路径都产出 issueDetails；disposition 默认 `pending` |
| 系统写回 | `continueAfterReport` 进入修复轮时对问题发 `accepted`（带 `repairRoundId`） |
| 用户写回 | IPC `task:set-review-disposition` + 结果面板采纳/拒绝/暂缓 |
| 投影 | `applyReviewDispositionEvents` 叠写 disposition，挂 resolutionRefs / verificationRefs；验证失败仍算未关闭 |
| UI | `ReviewMessage` / `CollaborationResultPanel` 展示结构化问题与处理状态；未处理不自动关闭 |

## U4 / U5 · 主活动区

| 项 | 事实 |
| --- | --- |
| 共享组件 | `CollaborationResultPanel`（五层：结论→意见/争议→评审/验证→过程→证据入口） |
| General/Knowledge | 会话结束后结果面板置顶；进行中仍显示 ProgressPanel |
| Engineering | 结果面板在对话流之上；对话页去掉与面板重复的「最终交付」堆叠（输出页保留文件/检查明细） |

## U6 · 测试与验收

详见 [`V3-MAIN-ACTIVITY-U6-ACCEPTANCE.md`](./V3-MAIN-ACTIVITY-U6-ACCEPTANCE.md)。

### 自动化（本机已跑）

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:collaboration-result   # 含 disposition 闭环
npm run test:plan-review
npm run test:task-conversation
npm run test:review-detail
npm run test:review-closure
```

### Electron 真机

未代跑完整真机（需真实 Key / 工程目录 / 用户授权）。勾选清单见 U6 验收记录；自动化通过 ≠ 真机 VERIFIED。

### 已知边界

- Debate 引擎 Claim 全量图仍在存档；事件只带切片。  
- 未执行 `git push`；未做签名/打包。
