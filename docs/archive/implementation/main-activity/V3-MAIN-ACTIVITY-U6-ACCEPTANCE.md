# V3 主活动区 · U6 验收记录

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


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
| `npm run test:verify` | 交付确认门禁（含写失败后空轮不得假完成） |

事件重放口径：同一 `AgentEvent[]` 两次调用 `projectEngineeringCollaborationResult` 得到相同 `issueId` / disposition 叠写结果（见 `test:collaboration-result`）。

本机已跑通 typecheck + 上述测试（2026-11-24）。

## 2. Electron 真机

**状态：云端工程任务已真实 `completed`，结果面板状态为 completed。**

### 2.1 环境

| 项 | 值 |
| --- | --- |
| 设备 | macOS darwin，本机 |
| 启动 | `THINKFUSION_USER_DATA=$HOME/Library/Application Support/thinkfusion-ai` + `electron-vite dev --remoteDebuggingPort 9333` |
| 用户数据 | **真实** userdata（含 OpenCode Go Key）；不用空临时 userdata |
| 执行默认 | `executionMode=cloud`；`selectedCloudModels=["opencode-go:deepseek-v4.1-flash","opencode-go:gpt-6-luna"]` |
| OpenCode Go | 探活 `withKey=30/30` |
| 网页源 | `openOnLaunch=false`，`webViewsOpen=false`；CDP 仅 `http://localhost:5173/` |
| 用户问题 | 原样：`工作区根目录下有哪些文件名？`（不拼完成条件/核对话术） |
| 脚本 | `desktop-agent-macos/scripts/u6-main-activity-live.mjs` |
| 报告 | `/tmp/tf-v3-u6-report.json` |
| 任务 | `taskId=0753851d-6dab-4e11-b4f2-83ead4bd8e69`，`conversationId=b688398e-dfc7-4ac6-a45b-5c71f4cb4e77`，终态 **`completed`** |

### 2.2 清单

1. [x] 主活动区出现「任务结果」面板；终态 `工程 · completed`，核心结论「任务完成」。  
2. [x] 评审问题正文可见；修复轮 disposition 写回为「已采纳 · 已并入下一轮修复计划」（本轮自动采纳路径）。  
3. [x] 进入下一轮修复后可见修正轮引用。  
4. [ ] 验证失败仍留未关闭项 / 通过后清空——本轮验证为通过，未覆盖失败分支（自动化已覆盖）。  
5. [x] disposition 写回事件存在（`review.disposition` ×3）。  
6. [x] 计划辩论无空伪造双方。  
7. [x] 不重复堆「最终交付」标题。  
8. [x] 「打开完整轨迹」按钮可见。

### 2.3 交付确认口径（本轮修复）

- 怎么检查交付由模型在计划/步骤里完成；用户问题不套话术。  
- 报告已验证且评审无待修项时，即使 `nextAction=continue` 也直接 `completed`，避免再开一轮被非法协议拖成 failed、面板状态残缺。

## 3. 结论

| 项 | 状态 |
| --- | --- |
| 自动化回归 / 事件重放 | ✅ |
| Electron 真机（云端 OpenCode Go / 不开网页 / `completed`） | ✅ Engineering 单路径冒烟 |
| 验证失败分支的未关闭项勾选 | ⏳ 自动化已覆盖；真机可另跑 |
| General / Knowledge 真机 | ❌ 未覆盖 → 移交 U7 |
| 结果面板与时间线去重 / 来源定位 | ❌ 移交 U7 |

> **口径修订（2026-11-25）：** 本报告证明 Engineering 冒烟通过，**不等于**整体 U6 VERIFIED。  
> 完整三场景验收见 [`V3-MAIN-ACTIVITY-U7-QUALITY-CONVERGENCE-TASK-BOOK.md`](../../spec/task-books/main-activity/V3-MAIN-ACTIVITY-U7-QUALITY-CONVERGENCE-TASK-BOOK.md)。
