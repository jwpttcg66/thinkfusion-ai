# 阶段 C 真机验收：对话流呈现层改造（C1–C4）

- 时间：2026-11-26T05:35Z → 05:38Z
- 代码基线：`main@2538104` + 本轮本地改动（阶段 1 + C1–C4）
- 数据目录：**默认目录** `~/Library/Application Support/thinkfusion-ai`
  （遵守 `AGENTS.md §10.2`，未设置 `THINKFUSION_USER_DATA`、未复制隔离、未另开副本）
- 启动：`npm run dev:local`（ThinkFusion Dev + CDP 9333），默认数据目录；
  启动前确认无 ThinkFusion 实例在跑。

## 环境注意（影响能否启动）

当前 agent shell 注入了 `ELECTRON_RUN_AS_NODE=1` 与 `NODE_OPTIONS`，
直接 spawn `dev:local` 会让 Electron 退化成纯 Node，报
`electron.app is undefined`。验收脚本 spawn 时必须清除这两个环境变量。
这是 shell 环境问题，不是产品 bug。

## 检查

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| cdp-ready | PASS | http://127.0.0.1:9333 |
| renderer-target | PASS | http://localhost:5173/ |
| agent-api-ready | PASS | `submitConversation` 可用 |
| model-configured | PASS | `opencode-go:deepseek-v4.1-flash` |
| new-css-loaded | PASS | 五个新样式类全部进入渲染进程：capsule / block / deliverables / cluster / md |
| task-terminal | PASS | 真实任务 `completed`（echo 命令） |
| conversation-dom-ready | PASS | `.chat-feed` + `.chat-feed-layout` 存在，25 个 stream 锚点 |
| no-console-errors | PASS | 无 console error / exception |
| test-task-cleaned | PASS | 见下方「数据清理」 |

## 截图与逐项记录

- `smoke.json` / `stage-c-smoke.png`：C 阶段 CSS 加载与渲染进程冒烟。
- `full.json` / `stage-c-full.png`：真实 echo 任务完成后的工程对话流
  （定位轨、轮次、计划、成员回答、验证、结论均可见）。
- `markdown.json` / `stage-c-markdown.png`：要求表格输出的任务样本。

## 已知边界（如实记录，不冒充已验证）

1. 两次任务的模型输出都走了 `task_complete` 协议分支，正文按既有设计以
   `chat-stream-body` 的纯文本显示协议推导（协议原文去「输出」页）。
   因此本次样本**没有触发** Markdown 表格渲染（`.chat-member-md .md-table` 为 0）。
   C4 的非协议正文接入由单测接线断言守住（至少两处 `MarkdownBody`），
   但「表格在真机里渲染成 HTML 表格」这一条本轮**未取得真机证据**。
2. 样本是 echo / 问答任务，未产生 diff 改动，故 `chat-diff-capsule`、
   `chat-diff-block`、`chat-deliverables`、`chat-step-cluster` 的真机**数据驱动渲染**
   未触发；只验证了它们的 CSS 已加载、DOM 容器存在、无 console 错误。
   数据正确性由阶段 1 与 C1/C2 的 55 条单测覆盖。
3. D1 子 Agent 卡片未实施（`code.team.run` 结果里有 `proposals[].agentId/role/
   durationMs/text/failure`，但投影层仍塞在 `StepCard.result`，未抽成 `kind:'agent'`）。
   按 V1.1 属 P2 条件实施，如实标为未做，不伪造 AgentRun。

## 数据清理（项目硬规则）

验收产生的真实任务数据已按 taskId 精确删除：
- tasks 2 → 0、rounds 2 → 0、plans 1 → 0、reports 1 → 0；
- events 64 → 50（回到验收前数量），runEvents 3780 → 3764；
- store 中测试提示词（hello-stage-c / 水果名称颜色）匹配数 0；
- 临时工作区 `/tmp/tf-stage-c-workspace` 已删。

用户原有会话与事件未改动。JSON 重新序列化后缩进格式变化，数据内容不变。

## 自动化测试

- `npm run typecheck`：通过（三个 tsconfig）。
- `npm run build`：通过（renderer + agent）。
- `npm run test:task-conversation`：55 条全通过
  （阶段 1 逐文件 Diff 4 条、C1/C2 映射与聚合 2 条、接线断言 1 条）。
