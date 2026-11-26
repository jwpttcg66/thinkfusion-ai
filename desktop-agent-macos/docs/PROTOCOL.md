# 通信协议：`desktop-agent/v1`

> **适用范围已收窄。** 这是按需工程执行协议：当工程任务需要本地工具 Runtime 时使用。Planner 可由 Web、Local 或 Cloud adapter 承担；问答、研究和多 AI 综合不要求输出此 JSON 协议。当前代码没有独立的 `thinkfusion/conversation/v1` / `thinkfusion/research/v1` 外部协议；对话结果走共享 TypeScript 契约和持久化事件。见 [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。
>
> 本文档以下内容不变：解析规则、回声剥离、回答归属，全部继续适用于执行链路。

模型适配器的共同输出是文本。Web adapter 从真实页面渲染结果提取文本，Local/Cloud adapter 从 Provider response 取文本；所有文本都按不可信输入解析，不能假设模型严格返回 JSON。

这份文档记录协议词汇、解析规则，以及每条规则对应的真实故障。

代码：`src/shared/protocol.ts`（解析与提示词）、`src/shared/contracts.ts`（Zod 校验）。

## 三个方向的流量

| 方向 | 形式 | 谁产生 |
| --- | --- | --- |
| 应用 → Planner adapter | 工程计划契约与本轮数据 | `buildInitialPrompt` / `buildReportPrompt` |
| Planner adapter → 应用 | 文本，其中可能含以下协议消息 | Web DOM adapter 或 Local/Cloud Provider |
| Runtime → Planner adapter | `execution_report`，本地 Runtime 产生并编码为文本 | `src/agent/index.ts` |

提示词里给出的 id（`taskId` / `roundId`）必须原样回填。模型改写 id 是最常见的失败形态，因此解析时会比对当前轮次，不匹配即拒绝。

## 消息类型

`protocol` 字段固定为 `desktop-agent/v1`。

### `plan`

```json
{
  "protocol": "desktop-agent/v1",
  "type": "plan",
  "taskId": "…",
  "roundId": "…",
  "planId": "…",
  "title": "计划标题",
  "description": "计划说明",
  "steps": [
    { "id": "step-1", "tool": "fs.list", "description": "说明", "args": { "path": "." } }
  ],
  "completion": { "condition": "可验证的完成条件" }
}
```

约束（`PlanSchema`，全部 `.strict()`）：

- `steps` 1–30 条，`id` 必须唯一
- `tool` 是判别式联合：`fs.list` / `fs.readFile` / `fs.mkdir` / `fs.writeFile`
- `args` 逐工具严格匹配，多一个字段即拒绝
- `completion.condition` 必填：没有完成条件的计划无法判断何时结束

### `clarification_required`

```json
{ "protocol": "desktop-agent/v1", "type": "clarification_required",
  "taskId": "…", "roundId": "…", "questions": ["问题"] }
```

1–5 个问题。应用把它呈现给用户，回答后作为新一轮的输入。

### `task_complete`

```json
{ "protocol": "desktop-agent/v1", "type": "task_complete",
  "taskId": "…", "roundId": "…", "summary": "完成摘要" }
```

### `execution_report`

不是模型产生的，而是本地 Runtime 产生、发给模型的。它的 `roundId` / `planId` 在 `status !== 'failed'` 时必须非空（`superRefine` 校验）——空 id 一路传到编排层才炸，是最难查的一类故障。

## 解析：为什么不能只找 ```json

Web 页面可能只在 DOM 结构上呈现代码围栏，`innerText` 读到的只有 JSON 本体；Local/Cloud 返回文本也可能有无围栏 JSON。因此解析器不能只依赖 ```json 标记。

`extractJsonBlocks` 因此按三级顺序尝试：

1. 围栏块（```json … ```）
2. `<AGENT_PLAN>…</AGENT_PLAN>`（旧格式，兼容保留）
3. **裸平衡对象**：从每个 `{` 起做括号计数扫描

第三级有两个必须处理的细节：

- **跳过字符串内的花括号。** `{"content": "function f() { }"}` 里的 `{}` 会把朴素的计数器提前截断。`matchBrace` 跟踪字符串状态和转义。
- **修复 JSON 非法片段。** 渲染后的文本里，字符串内可能带裸换行或制表符（markdown 折叠所致），对象末尾可能有尾逗号。`repairJson` 在字符串状态下转义裸换行，并删除尾逗号，**不改动结构**。

散文里出现的花括号（例如讨论代码时）不会构成完整对象，因此不会被误判——`check-protocol.mjs` 有对应用例。

## 回声剥离（echo stripping）

Web 执行规划时，页面里可能同时存在发送的请求和模型回答。把整段页面文本当回答会把自己的话当成对方的；API Provider 则用 requestId 关联请求和响应。

`stripEcho` 先用规范化文本定位提示词，再用 offset 映射回原文切掉那一段。**必须按连续区域删除，不能按行删除**：协议块里 `"protocol": "desktop-agent/v1",` 这类行两边都有，按行删会把 JSON 的字段删掉——这个 bug 曾经让所有报告轮的解析全部失败。

还有首尾窗口兜底：提示词过长被截断时，用前 80 / 后 80 字符定位。

## 回答归属

一段页面文本只有在同时满足下面几条时才算"这一轮的回答"：

1. 消息数比发送前快照多（页面确实新增了一条）
2. 最新气泡文本非空且与快照不同
3. 未闭合的 JSON 不算回答（`answerLooksComplete`）
4. 连续 3 次轮询文本一致（`stableCount >= 3`）

第 3、4 条是为了不接受流式前缀：曾经出现过接受 36 个字符的半截 JSON，随后解析失败并误报"回答里没有协议块"。

无气泡可用时退化为增量文本，但增量必须包含协议标记，否则不接受——否则聊天标题、"深度思考"、"智能搜索"、免责声明会被当成 33 个字符的回答。

## 提示词里的路径规则

所有 `args.path` 都是**相对工作区的相对路径**。提示词里明确写了这一条，并说明工作区路径本身不要写进 path。

不写这条时，Planner 可能把绝对工作区路径拼进 path，被 Runtime 拒绝（`GRANT_INVALID`）。`check-protocol.mjs` 断言路径规则存在。
