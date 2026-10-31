# 通信协议：`desktop-agent/v1`

模型通道是一条网页。DeepSeek 不会给我们回调，也不会遵守我们的 schema——它只是在聊天框里写字。所以协议必须能在**渲染后的 markdown** 上工作，而不是在理想的 JSON 输出上工作。

这份文档记录协议词汇、解析规则，以及每条规则对应的真实故障。

代码：`src/shared/protocol.ts`（解析与提示词）、`src/shared/contracts.ts`（Zod 校验）。

## 三个方向的流量

| 方向 | 形式 | 谁产生 |
| --- | --- | --- |
| 应用 → DeepSeek | 纯文本提示词，内嵌一个 JSON 结构示例 | `buildInitialPrompt` / `buildReportPrompt` |
| DeepSeek → 应用 | 三种结构化消息（见下） | 模型 |
| 执行结果 → DeepSeek | `execution_report`，由本地 Runtime 产生后作为文本发回 | `src/agent/index.ts` |

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

**渲染后的代码块没有围栏。** 这是本会话最重要的发现。DeepSeek 页面上 `innerText` 拿到的只有 JSON 本体，没有 ``` 标记——围栏是 DOM 结构，不是文本。只认围栏的解析器在真实页面上必然失败。

`extractJsonBlocks` 因此按三级顺序尝试：

1. 围栏块（```json … ```）
2. `<AGENT_PLAN>…</AGENT_PLAN>`（旧格式，兼容保留）
3. **裸平衡对象**：从每个 `{` 起做括号计数扫描

第三级有两个必须处理的细节：

- **跳过字符串内的花括号。** `{"content": "function f() { }"}` 里的 `{}` 会把朴素的计数器提前截断。`matchBrace` 跟踪字符串状态和转义。
- **修复 JSON 非法片段。** 渲染后的文本里，字符串内可能带裸换行或制表符（markdown 折叠所致），对象末尾可能有尾逗号。`repairJson` 在字符串状态下转义裸换行，并删除尾逗号，**不改动结构**。

散文里出现的花括号（例如讨论代码时）不会构成完整对象，因此不会被误判——`check-protocol.mjs` 有对应用例。

## 回声剥离（echo stripping）

发回执行报告时，页面里同时存在我们的提示词和模型的回答。把整段文本当回答会把自己的话当成对方的。

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

不写这条时，DeepSeek 会把绝对工作区路径拼进 path，被 Runtime 拒绝（`GRANT_INVALID`），然后下一轮才改用 `.`——每个任务白白浪费一轮。`check-protocol.mjs` 断言了这条规则的存在。
