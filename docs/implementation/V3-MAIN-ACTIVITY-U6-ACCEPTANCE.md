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

本机已跑通上述 typecheck + 五组测试（2026-11-24）。

## 2. Electron 真机

**状态：已代跑一轮云端工程任务（部分清单项有证据；disposition 闭环项仍靠自动化）。**  
不以「任务最终 failed」冒充全链路 VERIFIED；下面只勾能核对到的现象。

### 2.1 环境

| 项 | 值 |
| --- | --- |
| 设备 | macOS darwin，本机 |
| 启动 | `THINKFUSION_USER_DATA=$HOME/Library/Application Support/thinkfusion-ai` + `electron-vite dev --remoteDebuggingPort 9333` |
| 用户数据 | **真实** userdata（含 OpenCode Go Key）；**禁止**用空临时 userdata 冒充 |
| 执行默认 | `executionMode=cloud`；`selectedCloudModels=["opencode-go:deepseek-v4.1-flash","opencode-go:gpt-6-luna"]` |
| OpenCode Go | 探活 `withKey=30/30` |
| 网页源 | `openOnLaunch=false`，`webViewsOpen=false`；CDP 仅 `http://localhost:5173/`，未打开 DeepSeek/ChatGPT |
| 脚本 | `desktop-agent-macos/scripts/u6-main-activity-live.mjs`（`submitConversation` + 既有 defaults，不改配置、不走 `submitPrompt`） |
| 报告 | `/tmp/tf-v3-u6-report.json` |
| 任务 | `taskId=69b49172-1b95-4109-949a-236ff63190d1`，`conversationId=d55be625-9fad-4ad3-b274-84f5e112b60d`，约 155s 终态 `failed` |

### 2.2 清单

1. [x] 工程任务进行中/结束后，主活动区出现「任务结果」面板（`.collab-result`，含核心结论区）。  
2. [ ] 工程任务出现评审问题时，结果面板与时间线都显示问题正文与「待决定」——本轮 `review.ready` 无 issueDetails；该项仍以 `test:collaboration-result` 为准。  
3. [ ] 进入下一轮修复后，对应问题变为「已采纳」——本轮未触发带 issue 的修复闭环。  
4. [ ] 修复后验证失败 / 通过后未关闭项变化——本轮未覆盖。  
5. [ ] 结果面板「拒绝/暂缓」填原因并持久化——本轮走未知 issue 契约守卫；写回逻辑见自动化。  
6. [x] 计划辩论无争议时不伪造正反双方：面板显示「意见 4 · 争议 0」，双方为 OpenCode Go 模型中立意见，无空辩论双方。  
7. [x] 对话页不与结果面板重复堆「最终交付」：`delivery headings=0`。  
8. [x] 「打开完整轨迹」入口存在：`.collab-result-evidence button` 可见。

### 2.3 建议最小真机任务（剩余）

- 故意缺测试的小改动 → `needsFix` → 修复一轮 → 观察 disposition / 验证关联（清单 2–5）。

## 3. 结论

| 项 | 状态 |
| --- | --- |
| 自动化回归 / 事件重放 | ✅ |
| Electron 真机（结果面板 / 云端 OpenCode Go / 不开网页） | ✅ 有报告 |
| Electron 真机（disposition 完整闭环勾选） | ⏳ 待下一轮带 issue 的修复任务 |
