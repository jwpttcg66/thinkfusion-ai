# V3 主活动区 · U6 验收记录

基线分支：`feat/v3-main-activity-collab-result`  
对照任务书：`docs/spec/V3-MAIN-ACTIVITY-COLLABORATION-RESULT-TASK-BOOK.md` §九 / D09–D10

## 1. 自动化（本机可重复）

在 `desktop-agent-macos/`：

| 命令 | 覆盖点 |
| --- | --- |
| `npm run typecheck` | 契约 / 投影 / IPC / UI 类型 |
| `npm run test:collaboration-result` | 投影重建、无争议不伪造、disposition 采纳→修正→验证、拒绝/暂缓留原因、验证失败不关闭 |
| `npm run test:plan-review` | 计划评审门禁 |
| `npm run test:task-conversation` | 时间线条目与验证/评审卡 |
| `npm run test:review-detail` | 方案评审过程卡 |
| `npm run test:review-closure` | 独立评审材料与闭环闸门 |

事件重放口径：同一 `AgentEvent[]` 两次调用 `projectEngineeringCollaborationResult` 得到相同 `issueId` / disposition 叠写结果（见 `test:collaboration-result`）。

## 2. Electron 真机

**状态：未代跑完整真机任务**（需要真实 Key、工程目录与用户授权）。  
不以自动化通过冒充真机 VERIFIED。

### 清单（用户本机勾选）

1. [ ] 普通问答结束后，主活动区顶部出现「任务结果」，结论在进度之上。  
2. [ ] 工程任务出现评审问题时，结果面板与时间线都显示问题正文与「待决定」。  
3. [ ] 进入下一轮修复后，对应问题变为「已采纳」，并可见修正轮/计划引用。  
4. [ ] 修复后验证失败：问题仍留在未关闭项；验证通过后未关闭项清空。  
5. [ ] 在结果面板对待决定问题点「拒绝/暂缓」，必须填原因，刷新后原因仍在。  
6. [ ] 计划辩论无争议时，不出现空辩论/伪造正反双方。  
7. [ ] 对话页不再与结果面板重复堆「最终交付」结论。  
8. [ ] 「打开完整轨迹」跳到轨迹页后仍能回到同一任务。

### 建议最小真机任务

- General：一句事实问答，确认结果面板结论置顶。  
- Engineering：故意缺测试的小改动 → 触发 needsFix → 自动/手动修复一轮 → 观察 disposition 与验证关联。

## 3. 结论

| 项 | 状态 |
| --- | --- |
| 自动化回归 / 事件重放 | ✅ |
| Electron 真机勾选 | ⏳ 待用户执行上表清单 |
