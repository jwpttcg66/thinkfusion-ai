# V3 主活动区 · U7 验收记录

基线：`main@8601fc2` → 分支 `feat/v3-main-activity-u7-quality`  
任务书：`docs/spec/V3-MAIN-ACTIVITY-U7-QUALITY-CONVERGENCE-TASK-BOOK.md`

## 1. 自动化

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck`（json/agent/renderer） | ✅ |
| `npm run test:collaboration-result`（含 U7 伪造 id / Debate 裁决） | ✅ 9/9 |
| `npm run test:task-conversation` | ✅ |
| `npm run test:review-closure` | ✅ |

## 2. Engineering 真机（去重）

| 项 | 值 |
| --- | --- |
| 启动 | `THINKFUSION_USER_DATA=$HOME/Library/Application Support/thinkfusion-ai` + `npm run dev:local`（CDP 9333） |
| 脚本 | `desktop-agent-macos/scripts/u7-main-activity-live.mjs` |
| 报告 | `docs/implementation/evidence/V3-U7-ENGINEERING-LIVE.json` / `/tmp/tf-v3-u7-report.json` |
| taskId | `84068cfe-493f-4b9a-8281-44a454b5f248` |
| 终态 | **completed** |

断言：

- [x] 结果面板可见  
- [x] 无完整 `.chat-conclusion` 重复（`chat-conclusion=0`）  
- [x] 无完整 `.chat-review` / `.chat-verification` 重复  
- [x] 协作过程默认收起（`processOpen=false`）  
- [x] 时间线保留「详见上方」标记（`markers=3`）  

## 3. General / Knowledge

| 场景 | 状态 | 说明 |
| --- | --- | --- |
| General | 部分 | 会话 `f9d2bcce-…` 已 `answered`；CDP 切会话未稳定落到问答结果面板（仍见上一工程任务面板）。证据：`evidence/V3-U7-GENERAL-ATTEMPT.json` |
| Knowledge | 未跑 | 待补独立真机 |

## 4. 结论

| 项 | 状态 |
| --- | --- |
| P0 去重（Engineering 真机） | ✅ |
| P0 来源真实性（自动化） | ✅ |
| P1 投影/面板（自动化 + Engineering 真机） | ✅ |
| 三场景完整真机 | ⏳ Engineering 通过；General/Knowledge 待补 |

> 不得因 Engineering 单路径通过而把 U7 整体标为 VERIFIED。
