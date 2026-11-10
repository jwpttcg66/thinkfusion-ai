# 过程可见性：思考、汇总、执行都要看得见

> 2026-11-10。问题：一轮研究里，界面只有「思考中 / 收集中 / 综合中」三个粗状态，
> 看不到现在走到哪一段、等了多久、模型在做什么。用户的原话是「什么都没有，看着
> 就像是卡死了」。
>
> 实现见 [PROGRESS_VISIBILITY_ROLLOUT](../implementation/PROGRESS_VISIBILITY_ROLLOUT.md)。

## 0. 一句话结论

> 进度不是新造一份状态，而是把**已经存在的事件**投影成五段：判定 → 提问 → 汇总 →
> 执行 → 评审；每段带「当前/完成/失败」和真实开始时间，界面自己走秒。
> 思考内容只在模型真的返回过时显示，不猜、不编。

## 1. 现在为什么像卡死

| 层 | 现状 | 用户看到什么 |
| --- | --- | --- |
| 会话状态 | `Conversation.status` 只有 `thinking / collecting / synthesizing / answered`（`shared/conversation.ts`） | 一句话，不说明卡在哪 |
| 通道相位 | `channel.phase` 有 `asking / leading / answered / failed`，通道条会走秒（`ConversationView.ChannelStrip`） | 只有「提问中」，没有全局阶段 |
| 轨迹 | `shared/trace.ts` 记录了 answer/tool/step 用时与状态 | 要点进「轨迹」页才看得到，对话页没有 |
| 执行 | `step.started / step.completed` 事件与 `ExecutionLog` | 在折叠的日志里，不是「现在第几步」 |
| 思考 | 没有。Provider 的 `generate()` 只取了 `message.content` | 什么都没有 |
| 流式 | Provider 有 `stream()`（`providers/openai-compatible.ts`、`ollama.ts`） | **从未被调用**（`src/main` 里没有任何 `.stream(` 调用） |

所以不是执行慢，是**只播了结果、没播过程**。

## 2. 参考实现

### 2.1 DeepSeek Harness（`~/data/dsh-src`，0.2.2-alpha.2）

dsh 的过程可见性由三件事组成，每一件都是结构化数据，不是日志文案：

1. **流式装配**：`packages/llm/llm/src/assembler.ts` 把 `text-delta`、`reasoning-delta`、
   `tool-call-delta` 按 index 累积成块，`block-end` 收口。推理和正文是两种块，不混在一起。
2. **会话事件**：`tool/call` → `tool/result` 成对出现，UI 能显示「正在跑什么命令 / 读哪个路径」，
   结束后同一行改成结果；失败也是同一行的状态变化，不新增一条日志。
3. **展示策略**：`packages/client/ui-chat/src/client/presentation-policy.ts` 决定
   推理行折叠、settled 后只预览第一行；`reasoning-text.ts` 负责把 `<signature>…</signature>`
   这类封装剥掉。推理默认是「Think」一行，点开才看全文——不是把思考塞满屏幕。

### 2.2 opencode（sst/opencode）

opencode 的会话是 **message parts** 模型：一条消息由 `text`、`reasoning`、`tool`、
`step-start`、`step-finish` 等 part 组成，每个 part 有稳定 id，流式时不断 `part.updated`，
界面按 id 增量更新同一块，而不是整段重刷。

值得抄的三点：

- **阶段也是 part**（step-start / step-finish），所以「开始做」和「做完」有同一条记录，
  能算耗时，也能在重放时还原顺序；
- **工具调用有状态机**（pending → running → completed / error），不是只有成功和失败；
- **推理单独成块**，默认折叠，正文和推理在数据结构上就分开了。

## 3. 我们的设计：一个投影，五段，三个来源

### 3.1 五段

`src/shared/progress.ts`：

```ts
export const PROGRESS_STAGES = ['routing','asking','synthesis','execution','review'] as const;
```

| 段 | 什么时候进入 | 判据（事件） |
| --- | --- | --- |
| `routing` 判定 | 任务开始 | 还没有 `round.started`，且后面没有阶段 |
| `asking` 提问 | 第一轮发出去 | `round.started` |
| `synthesis` 汇总 | 各家答完、开始汇总 | 会话状态 `synthesizing` / `plan.ready` |
| `execution` 执行 | 计划批准、开始跑步骤 | `step.started` / 任务 `executing` |
| `review` 评审 | 报告出来、独立评审 | `report.ready` / `review.ready` |

规则：

- **只投影，不记账。** 输入是已有的 `AgentEvent[]` + 会话/任务状态；没有第二份进度表，
  也就不存在「进度显示完成、实际还在跑」。
- **未知就是 pending。** 没有事件就不猜它完成。
- **失败只标当前段。** 后面没发生的段保持 pending，不假装跑过。

### 3.2 来源

| 界面 | 数据来源 | 现在的状态 |
| --- | --- | --- |
| 全局五段条 | `deriveProgress` 投影 | ✅ 已实现 |
| 每通道等待秒数 | `channel.phase.at` + 本地计时 | ✅ 已有 |
| 执行步骤 | `step.started/completed/failed` | ✅ 胶囊列表 + 五段 detail |
| 思考内容 | Provider 的 `reasoning_content` / `thinking` | ✅ 卡片上方独立一条，默认折叠 |
| 流式正文（本地/云端） | Provider `streamChunks()` → `answer.delta` | ✅ 第一轮、工程模式首轮、汇总 |
| 流式正文（网页） | 轮询 DOM 的 `onPartial` → 增量 / reset | ✅ 见 [WEB_ANSWER_STREAMING](WEB_ANSWER_STREAMING.md) |

### 3.3 思考：只显示模型真的返回过的

- OpenAI 兼容：`choices[0].message.reasoning_content`（DeepSeek）或 `message.reasoning`；
- Ollama：`message.thinking`；
- 两个都没有 → 不写这个字段，界面上也没有「思考过程」这一块。**不拿一句「正在思考」冒充推理内容。**
- 显示是**单独一条**，在回答卡片上方，不放进卡片正文：结论型回答（【结论】【一致】…）
  与推理内容天然重合，混在一起会把结论顶下去；独立条既保留思考，也不干扰结论。
- 流式期间自动展开并实时增长（标题「思考中（N 字）」），落盘后收起为「思考过程（N 字）」；
  它不参与答案、不参与引用、不参与综合。

## 4. 交互

```
┌ 判定 ✓  提问 ● 汇总 ○ 执行 ○ 评审 ○ ───────────── 12s
│ ◌ 提问   问题已发出，等待各家回答
└
```

- 已完成的段打勾变灰；当前段有转圈与秒数；失败段变红并写原因。
- 秒数由渲染层每秒本地走（和通道条同一套做法），主进程不每秒发事件。
- 任务结束后整条消失——不留一条「已完成」的条占着页面。
- 超时看门狗按「连续多久没有进展」计时，不按总时长：辩论 + 最终意见本来就可能
  超过 5 分钟，按总时长会误杀正常长任务；真的卡死仍然会在连续 5 分钟无进展后失败。

## 5. 隐私与边界

- **推理内容可能包含用户问题里的敏感信息**：默认折叠、只存在本机会话记录里，
  不进入导出默认内容、不进入综合、不发回任何网页。
- 不新增固定提示词，不为了「让过程好看」让模型多说废话。
- 不伪造阶段：拿不到思考就不显示思考；拿不到流式就只显示阶段，不假装在逐字输出。

## 6. 验收

| 判据 | 怎么测 |
| --- | --- |
| 五段投影正确（含失败只标当前段） | `test:progress` 6 条纯函数用例 |
| 推理字段只在 Provider 返回时存在 | 单元：Provider 解析；没有就不写 |
| 界面不出现假进度 | 代码审查 + 真机：慢页面只显示「提问 · 12s」，不显示编造的思考 |
| 不破坏既有 token 统计 | `test:trace-stats` / `test:cloud` 全过 |
