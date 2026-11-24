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
| `reviewExecution` | 规则/模型路径都产出 issueDetails；disposition 默认 `pending` |
| UI | `ReviewMessage` 展示结构化问题 + 可展开原文；未处理不自动关闭 |

## U4 / U5 · 主活动区

| 项 | 事实 |
| --- | --- |
| 共享组件 | `CollaborationResultPanel`（五层：结论→意见/争议→评审/验证→过程→证据入口） |
| General/Knowledge | 会话结束后结果面板置顶；进行中仍显示 ProgressPanel |
| Engineering | 结果面板在对话流之上；对话页去掉与面板重复的「最终交付」堆叠（输出页保留文件/检查明细） |

## U6 · 测试与验收

### 自动化（本机已跑）

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:collaboration-result   # 5/5
npm run test:plan-review            # 24/24
npm run test:task-conversation      # 20/20
npm run test:review-detail          # 11/11
```

### Electron 真机

未在本阶段代跑完整真机任务（需真实 Key / 工程目录 / 用户授权）。验收清单：

1. 普通问答结束后，主活动区顶部出现「任务结果」且先见结论。  
2. 工程任务有评审问题时，结果面板与时间线均显示问题正文与「待决定」。  
3. 计划辩论无争议时，不出现空辩论/伪造正反双方。  
4. 对话页不再与结果面板重复堆「最终交付」结论。  
5. 「打开完整轨迹」跳到轨迹页后仍能回到同一任务。

### 未完成 / 已知边界

- 评审 disposition 的「采纳→修正→验证」真值闭环仍需后续把审批/修复事件写回 issueDetails（形状已预留）。  
- Debate 引擎 Claim 全量图仍在存档；事件只带切片。  
- 未执行 `git push`；未做签名/打包。
