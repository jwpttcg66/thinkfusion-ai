# 阶段 D1/D2 真机验收：子 Agent 卡片与并行对话浮层

- 时间：2026-11-26T06:18Z → 06:35Z
- 代码基线：`main@2538104` + 本地 D1/D2 改动（`kind:'agent'` 投影 + `ParallelConversationRail`）
- 数据目录：**默认目录** `~/Library/Application Support/thinkfusion-ai`
  （遵守 `AGENTS.md §10.2`，未设置 `THINKFUSION_USER_DATA`、未复制隔离、未另开副本）
- 启动：`npm run dev:local`（ThinkFusion Dev + CDP 9333）。启动前已向用户说明会中断
  当前 dev 窗口，用户确认后停掉原实例（`PID 70770/70705/70625`）再独占启动；
  验收结束关闭验收实例。启动脚本清除 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`
  （shell 注入会让 Electron 退化为纯 Node，非产品缺陷）。
- 数据保护：启动前 `agent-store.json` sha256 = `f25afeaeebf8c86622c0d04a4e678a4947780cefa690e4941061acc79f9aeebd`，
  验收后 sha256 完全一致；tasks=1 / reports=3 / events=381 / conversations=1 / runEvents=3780 / messages=5，
  全程只读打开已有会话，未创建、未删除、未修改任何真实任务或消息。

## 检查

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| cdp-ready | PASS | `http://localhost:5173/`，CDP 9333 |
| agent-api-ready | PASS | `getTaskHistory` / `getConversations` 可用 |
| data-baseline | PASS | tasks=1、conversations=1（见上方 sha 核对） |
| new-css-loaded | PASS | 五个新样式类全部进入渲染进程：`chat-agent` / `chat-agent-output` / `parallel-rail` / `parallel-lane` / `parallel-turn-prompt` |
| parallel-rail-no-empty-shell | PASS | 当前无并行回答时 `.parallel-rail` 不存在——按设计不画空壳 |
| dom-coexistence | PASS | 首页与工程对话页均正常渲染，无新增元素挤占主流 |
| open-conversation | PASS | 点开侧栏会话（只读），进入工程工作页 |
| conversation-dom | PASS | `.chat-feed` 存在，`chat-agent` 卡为 0（样本无 `code.team.run`） |
| rail-expanded | SKIP | 该会话 `channels=[]`、仅 1 条 channel 消息，且落在工程 tab，没有真实并行回答触发浮层 |
| console-errors | SKIP | 本次脚本未挂 CDP Log 收集；接线由单测断言守住 |
| screenshot | PASS | `stage-d1d2.png`（启动态）、`stage-d1d2-conversation.png`（会话页） |

## 通过项与边界

**通过**：
- 新增的 D1/D2 样式随构建进入渲染进程，页面无崩溃、无空白；
- 没有真实并行回答时浮层不出现，主流对话结构未被新组件干扰；
- 只读打开已有会话不改动任何真实数据（sha 前后一致）。

**未覆盖（样本边界，非缺陷）**：
- 当前数据里没有 `code.team.run` 事件，D1 子 Agent 卡（`kind:'agent'`）未能在真机触发，
  其字段来源、状态映射、WorkTask 关联与可重复计算由 `test:task-conversation` 的 5 条 D1 单测覆盖；
- 现有会话 `channels` 为空、只有 1 条 channel 回答，且打开后落在工程 tab，
  D2 浮层的多轮 lane / 展开 / 跳主流交互未能在真机触发，
  由 5 条 D2 单测（分轮、不画空壳、增量让位、可重复计算、接线）覆盖；
- 未新造测试任务，避免污染真实数据；若要覆盖上述两点需专门跑一次带多模型并行回答的会话。

## 对应单测

`npm run test:task-conversation` 65 条全绿，其中 D1 五条、D2 五条。
`npm run typecheck` 与 `npm run build` 均通过。

## 原始结果

- `d1d2.json`：启动态检查逐项结果
- `d1d2-open.json`：会话页 DOM 复验逐项结果
- `stage-d1d2.png` / `stage-d1d2-conversation.png`：真机截图
