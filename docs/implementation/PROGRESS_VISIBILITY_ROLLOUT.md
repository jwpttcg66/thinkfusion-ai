# 过程可见性：实施

> 配套设计：[PROGRESS_VISIBILITY](../spec/PROGRESS_VISIBILITY.md)。
> V1 已落地；V2–V4 按下面顺序做，每期都能单独回滚。

## 0. 分期

| 期 | 内容 | 状态 |
| --- | --- | --- |
| V1 | 五段进度条 + 非流式思考捕获/折叠显示 | ✅ 2026-11-10 |
| V2 | 本地/云端正文与汇总流式：逐字输出，保留 token 统计 | ✅ 2026-11-10 |
| V3 | 执行过程进对话：步骤行内可见，不只写日志 | ✅ 2026-11-10 |
| V4 | 汇总流式 + 重放（关掉应用后仍能按阶段还原） | 部分：汇总流式 ✅，重放未做 |

## 1. V1 · 五段进度（已落地）

### 1.1 文件

| 文件 | 改动 |
| --- | --- |
| `src/shared/progress.ts` | 新建：五段、从事件投影、失败只标当前段 |
| `src/renderer/src/components/ProgressPanel.tsx` | 新建：五段条 + 当前段 + 本地秒表 |
| `src/renderer/src/App.tsx` | 对话页顶部接入 `ProgressPanel` |
| `src/renderer/src/style.css` | `.progress-*` 样式 |
| `scripts/check-progress.mjs` | 6 条纯函数用例（含「评审后无当前段」「失败不假装完成」） |

### 1.2 思考内容

| 文件 | 改动 |
| --- | --- |
| `src/main/providers/openai-compatible.ts` | `generate()` 读 `reasoning_content` / `reasoning` |
| `src/main/providers/ollama.ts` | 读 `message.thinking` |
| `src/main/providers/types.ts` / `agents/types.ts` | `ModelResponse` / `SubAgentAnswer` 增加可选 `reasoning` |
| `src/main/execution/provider-sub-agent.ts` | 原样透传，不拼不截 |
| `src/shared/conversation.ts` | `ConversationMessage.reasoning?` |
| `src/main/conversation-runner.ts` | 写消息时带上；`addMessage` 只接受显式字段 |
| `ConversationView.tsx` | 折叠块「思考过程（N 字）」，默认收起 |

### 1.3 验收

```
npm run test:progress        # 五段投影 + 失败语义
npm run typecheck
npm run test:trace-stats     # 进度不碰 token 统计
```

真机：

1. 发一个会走网页的问题：应看到「提问 · 12s」在走，而不是只有「思考中」；
2. 用云端的推理模型问一句：回答卡片多出「思考过程」折叠块；普通模型没有这一块；
3. 故意让一个通道超时：该段变红，后面的段不显示完成。

## 2. V2 · 正文与汇总流式 · ✅ 已落地

落地方式（与本节原来的计划一致）：

- `ModelProvider.streamChunks()` 产出 `{text?, reasoning?, usage?}`；`stream()` 保留为只出正文的旧接口；
- `ProviderBackedSubAgent.askStream()` 累积正文/推理，回调增量，返回完整回答与 usage；
- 第一轮回答与主导人汇总都走流式（网页通道仍整段）；
- 增量按 50ms 合批后发 `answer.delta`，界面按 channelId 追加；消息落盘后由 `message.added` 清掉临时气泡；
- 本地/云端拿不到流时自动退回 `ask()`，不假装在流。

### 2.1 要改什么

| 文件 | 改动 |
| --- | --- |
| `providers/types.ts` | `stream()` 从 `AsyncIterable<string>` 升级为 `AsyncIterable<{ text?: string; reasoning?: string; usage?: ModelUsage }>`；保留旧方法名，内部适配 |
| `providers/openai-compatible.ts` / `ollama.ts` | SSE 逐块产出 text / reasoning；`stream_options.include_usage` 拿到 usage 后作为最后一块 |
| `execution/provider-sub-agent.ts` | 新增 `askStream(task, onDelta)`；有流式能力时走流式，没有就退回 `ask` |
| `conversation-runner.ts` | 第一轮回答改为流式：先落一条占位消息（`pending: true`），边收边更新 |
| `shared/conversation.ts` | 新增 `ConversationEvent: 'message.delta'`（`messageId + text + reasoning`） |
| `ConversationView.tsx` | 按 `messageId` 增量更新同一条气泡，末尾显示光标 |
| `trace.ts` | 首 token 时间用第一块 delta 的真实时间，不再用总耗时代替 |

### 2.2 硬约束

1. **usage 不能丢。** 现在的 token 统计来自 `generate()`；切流式必须把 usage 一起带回来，
   否则轨迹页的 token 会变成 `—`，这是回退不是进步。
2. **失败只能重试一次，且在第一个字之前。** 和现有 `stream()` 的注释一致：拿到响应头之后
   不再重发，避免把两段回答拼在一起。
3. **网页通道没有流。** 页面不是流，`streaming:false`；它继续用「提问中 + 秒表」，
   不假装逐字输出。
4. **取消要能立刻停。** `cancel(requestId)` 在流式期间必须生效，落盘的是已产出的前缀，
   状态标 `cancelled`，不能留一条永远 `pending` 的消息。

### 2.3 验收

- 云端：逐字出现，结束后 token 与改造前同一量级；首 token 时间小于总耗时；
- 本地 Ollama：同上；模型不支持流式时自动退回整段；
- 取消：消息停在已产出的部分，状态 `cancelled`；
- 断网：已有前缀保留，错误写在同一张卡片上，不新开一条。

## 3. V3 · 执行过程进对话 · ✅ 已落地

落地方式：`ProgressPanel` 直接从 `step.started / step.completed / step.failed` 投影出步骤
胶囊（序号 + 工具 + 执行中/完成/失败），与全局五段共用同一批事件，不新增状态。
完整参数与结果仍在执行日志里，这里只解决「现在跑到哪一步」。

### 3.1 要改什么

- `ConversationView` 增加 `ExecutionInline` 区块：从 `step.*` 事件投影出步骤行
  （复用 `deriveProgress` 的 execution detail）；
- 每行三态：等待 / 执行中（带秒表）/ 完成（带退出码或 diff 字数）；
- 失败行展开错误原文，不折叠；
- 与 `ProgressPanel` 的「执行」段共用同一个 `step.started` 数据，不新增事件。

### 3.2 验收

- 计划 5 步：对话页看到 1→5 的推进，而不是等全部结束才出现；
- 某步失败：该行红，后续行标「未执行」，不是全绿；
- 与轨迹页的步骤序号一致（同一个 `index/total`）。

## 4. V4 · 汇总流式与重放（部分落地）

- ✅ 汇总与追加轮汇总都走 V2 的流式通道，主导人回答时界面显示「写作中」；
- ⏳ 阶段事件落盘与重放还没做：目前进度由任务事件投影，应用重启后任务结束后不再显示历史阶段；
- 导出 Markdown 时，思考默认不导出（可勾选），执行步骤导出为表格。

## 5. 风险

| 风险 | 表现 | 处置 |
| --- | --- | --- |
| 流式破坏 token 统计 | 轨迹页突然全是 `—` | V2 必须先做 usage 回传，再切流式 |
| 推理内容泄露 | 思考里带用户隐私或密钥 | 默认折叠、不导出、不进综合；只存在本机会话 |
| 进度条说谎 | 显示「完成」但实际失败 | 只用事件投影；失败只标当前段；任务结束就隐藏 |
| 视觉噪音 | 每来一块就重渲染整段 | 按 `messageId` 增量更新；只重渲染变化的块 |
| 网页通道被误改成流式 | 页面被当成流读，答案被截断 | 保留 `streaming:false` 分支，类型上分开 |

## 6. 提交约定

每期一个提交，信息写清「原来错在哪」，例如：

```
过程可见性 V1：一轮研究只有三个粗状态，用户看不出卡在哪

原来对话页只有「思考中/收集中/综合中」，通道条也只覆盖提问；执行要翻日志，
思考内容根本没解析。现在把已有的 round/plan/step/report 事件投影成五段，
当前段带秒表与「第几步」；Provider 返回过 reasoning 就折叠显示，没有就不显示。
```
