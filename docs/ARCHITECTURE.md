# 技术架构

产品定位见 [PRODUCT.md](PRODUCT.md)。这份文档只回答一个问题：**要让那个定位成立，代码该怎么切。**

一句话结论：

> 把「通道」「编排」「综合」「执行」四件事从当前的一个循环里拆开，让 `desktop-agent/v1` 从"全局协议"降级为"只有本地执行时才用的协议"。

---

## 1. 定位转变对架构的三个硬要求

| 要求 | 现状 | 冲突点 |
| --- | --- | --- |
| 普通问题不能要求生成 JSON 计划 | 每个任务都走 `buildInitialPrompt`，开头就是「你是本地 ThinkFusion 的任务规划引擎……输出执行计划」 | `src/shared/protocol.ts:381` |
| 一个通道失败不能拖垮整条链路 | `AgentOrchestrator` 一个循环同时负责发问、解析、审批、执行、回传 | `src/main/orchestrator.ts:37` |
| 增加第二个 AI 不需要改主流程 | `DeepSeekAdapter` 是唯一通道，892 行里混了选择器、探测、发送、归属判断 | `src/main/deepseek-adapter.ts` |

三条都指向同一个动作：**先定义通道接口，再谈编排。**

---

## 2. 五层与代码的映射

| 层 | 职责 | 现有代码 | 目标 | 动作 |
| --- | --- | --- | --- | --- |
| **1. User Interaction** | 输入、进度、对话呈现 | `App.tsx`、`SourceRail.tsx`、`TaskInput.tsx` | 同左 + `ConversationView` | 扩展 |
| **2. Intent & Task Orchestrator** | 判定任务类型、选流程 | 无。所有输入都被当成计划任务 | `IntentRouter` + `ConversationRunner` | **新建** |
| **3. AI Collaboration Engine** | 分头发问、收集、比较、追问 | 无。只有一个通道，一轮一问 | `AiChannel` 接口 + `CollaborationEngine` | **新建** |
| **4. Tool & Execution Runtime** | 工具、权限、复验 | `src/agent/*`、`agent-manager.ts` | 保留原样 | **收敛为按需** |
| **5. Knowledge & Synthesis** | 观点、证据、分歧、索引 | 无。只有 `AgentStore` 的事件流 | `SynthesisStore` + `Synthesizer` | **新建** |

第 2、3、5 层目前是空的。这不是"待优化"，是产品定位没落地。

### 2.1 第 2 层：意图路由

```ts
export type Intent =
  | { kind: 'answer'; question: string }          // 问答
  | { kind: 'research'; question: string }        // 多来源研究
  | { kind: 'compare'; question: string }         // 多 AI 观点比较
  | { kind: 'extract'; url: string }              // 网页提取
  | { kind: 'workspace'; goal: string; workspaceRoot: string }; // 本地执行
```

判定顺序（**规则优先，模型兜底**）：

1. 用户显式声明（"改一下这个文件"）→ `workspace`
2. 附带了 URL 且要求整理/总结 → `extract`
3. 出现工作区路径、文件路径、明确的动词（改、写、删、跑）→ `workspace`
4. 出现"比较 / 哪个更好 / 分别" → `compare`
5. 其余 → `answer`

只有 `workspace` 进入第 4 层。默认分支必须是 `answer`——**默认走执行是当前所有错位的第一因。**

路由结果要落进事件流，用户可回看"系统把这次当成了什么"。

### 2.2 第 3 层：通道接口

这是整个重构的支点。所有 AI 接入（网页版 DeepSeek、ChatGPT、将来的 API 通道）实现同一个接口：

```ts
export interface AiChannel {
  readonly id: string;
  readonly label: string;

  /** 现在能不能用：登录态、页面就绪、是否正在生成。 */
  status(): Promise<ChannelStatus>;

  /** 发一句话，拿回一段话。 */
  ask(input: AskInput): Promise<ChannelAnswer>;
}

export interface AskInput {
  /** 用户的原话，或据此派生的一句追问。不是重写过的任务规格。 */
  question: string;
  /** 同一会话里更早的轮次，旧的在前。 */
  history?: readonly Turn[];
  /** 这次提问的目的，只影响编排，不影响线格式。 */
  stage: 'initial' | 'followup' | 'challenge' | 'synthesis';
}

export interface ChannelAnswer {
  text: string;
  /** 这一段是怎么被认定为"本轮回答"的，排障用。 */
  attribution: Attribution;
  receivedAt: number;
}
```

两个刻意的设计：

1. **`ask()` 只返回 `text`。** 没有 `data`、没有 `payload`、没有 `structured`。类型系统层面禁止"让通道吐 JSON"，因为那正是现在所有问题的源头。
2. **通道不知道协议存在。** 需要 JSON 的场景由调用方在 `question` 后面追加协议后缀，通道照常发、照常取回文本。

现在的 `DeepSeekAdapter` 按这个接口拆成三块：

| 拆分后 | 内容 | 依据 |
| --- | --- | --- |
| `channels/web-page/` | 选择器、probe、发送、`waitForAnswer`、回声剥离、回答归属 | `deepseek-adapter.ts` 现有全部 |
| `channels/registry.ts` | 按 id 注册、并发队列、健康状态 | 新建 |
| `channels/status.ts` | `ChannelStatus` 投影（上层只看得到这个） | 新建 |

上层永远拿不到 DOM 选择器，也拿不到 `WebContentsView`。站点改版只影响 `channels/web-page/`。

### 2.3 第 5 层：综合

输入是 N 个 `ChannelAnswer`，输出是结构化的 `Synthesis`：

```ts
export interface Synthesis {
  consensus: Claim[];      // 多数通道一致，且各自给了依据
  disputed: Dispute[];     // 有冲突：谁说了什么，分歧点在哪一句
  unique: Claim[];         // 只有一个通道提到，可能是增量，也可能是幻觉
  gaps: Gap[];             // 没有任何通道覆盖的角度
  recommendation: string;  // 结论，必须能追到上面的条目
}
```

实现顺序很重要：

1. **规则版先上。** 句子切分 + 关键实体对齐 + 否定词检测，够用且可解释。
2. **模型归纳后上。** 用一个通道当 judge，但它的输入是已经标注好的候选观点，不是原始长文——否则又变成"把 N 个回答压缩一次"。
3. **抽取失败必须降级。** 降级形态是"原文并列 + 标注未能结构化"，流程继续走。不允许因为结构化失败而中断一次研究。

---

## 3. 三套协议

| 协议 | 谁跟谁 | 载体 | 要求模型输出 JSON |
| --- | --- | --- | --- |
| `thinkfusion/conversation/v1` | 渲染进程 ↔ 主进程 | IPC 事件流 | **否** |
| `thinkfusion/research/v1` | 系统内部（观点 / 证据 / 分歧） | 本地存储 + 事件 | **否**，由系统抽取 |
| `desktop-agent/v1` | 应用 → 模型 → Runtime | 渲染后 markdown 里的 JSON | **是**，且仅此一处 |

### 3.1 `thinkfusion/conversation/v1`

就是 IPC 契约，描述一次对话里发生了什么：

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `conversation.started` | `{ conversationId, intent }` | 路由结果在这里落地 |
| `user.message` | `{ conversationId, text }` | 用户原话，不改写 |
| `channel.asked` | `{ conversationId, channelId, question }` | 便于回看"到底问了什么" |
| `channel.answered` | `{ conversationId, channelId, text, attribution }` | 一段文本，没有结构 |
| `stage.changed` | `{ conversationId, stage }` | thinking / collecting / comparing / synthesizing |
| `question.asked` | `{ conversationId, questions }` | 信息不足，交回用户 |
| `synthesis.ready` | `{ conversationId, synthesis }` | 见 `research/v1` |

关键：**这套协议里没有任何"计划""审批""执行"的概念。** 问答链路不经过 Runtime。

### 3.2 `thinkfusion/research/v1`

这是 `Synthesis` 的持久化形态，`Claim` 至少包含：

```ts
export interface Claim {
  text: string;
  /** 哪几个通道说过，按支持度排序。 */
  sources: Array<{ channelId: string; turnId: string }>;
  /** 原话里的依据片段；空数组表示这是一句断言，没有依据。 */
  evidence: string[];
}
```

`Dispute` 额外带 `positions: Array<{ channelId; stance }>` 和 `pivot`（分歧具体落在哪一句）。

再次强调：这套结构由系统产出，**不要求任何模型按它输出**。

### 3.3 `desktop-agent/v1`

**保持不变。** 现有的解析、回声剥离、id 回填校验、`clarification_required` / `task_complete` 全部保留，见 [PROTOCOL.md](../desktop-agent-macos/docs/PROTOCOL.md)。

唯一变化是**触发条件**：只有 `intent.kind === 'workspace'` 时，`Executor` 才会在问题后追加协议后缀。其余场景这段协议文本根本不会出现在对话里。

---

## 4. 两条主链路

### 4.1 问答 / 研究链路（不碰 Runtime）

```
用户输入
  → IntentRouter           判定 answer / research / compare / extract
  → CollaborationEngine    拆问题，分发给 N 个通道（并行，每通道独立队列）
  → 收集 ChannelAnswer[]   文本，可能伴随归属失败重试
  → Synthesizer            规则抽取 → consensus / disputed / unique / gaps
  → conversation 事件流     渲染成对话 + 左侧协作进度
```

没有计划、没有审批、没有文件系统。

### 4.2 工作区任务链路（进入 Runtime）

```
用户输入
  → IntentRouter           判定 workspace
  → Executor               用同一个通道 ask(goal + desktop-agent/v1 后缀)
  → 解析计划 → 人审批 → UtilityProcess 执行 → 执行报告回传 → 下一轮
```

两条链路**共用通道与事件日志**，但只有第二条进入 `src/agent/*`。

---

## 5. 状态机

现在只有一套（计划-执行），需要两套。

### 5.1 会话状态机（新建）

```
draft ──route──► thinking ──► collecting ──► comparing ──► synthesizing ──► answered
                    │             │              │
                    └─────────────┴──────────────┴──► awaiting_user ──► thinking
                                                        （澄清/追问）
任意状态 ──► failed / cancelled
```

`answered` 不是终点：用户追问会回到 `thinking`，并把已有 `Synthesis` 作为上下文带入。

### 5.2 执行状态机（保留）

`created → planning → awaiting_clarification → plan_ready → awaiting_approval → executing → verifying → report_pending → awaiting_next_round → completed`

这套状态机、它的守卫、以及 `TaskManager` 的 `TERMINAL` 集合都不动。它只是不再服务所有任务。

---

## 6. 并发模型

现在的 `pageQueue` 是**全局单页面串行**（`orchestrator.ts:50`），原因是"一个页面只有一个写者"。这个判断在多通道场景下要变成：

```
每个通道一条队列（同一页面仍然只能有一个写者）
+ 全局并发上限（默认 3，可配）
```

上限存在的原因不是正确性，是资源：每个通道是一个 `WebContentsView`，各占一份渲染进程内存。同时开 6 个网页版 AI，机器会先撑不住。

队列满时**不排队等待**，直接返回 `ChannelBusy`，由编排层决定是跳过该通道还是稍后重试——排队的任务在用户眼里就是"卡住了"。

---

## 7. 保留与解耦清单

### 7.1 原样保留

| 模块 | 理由 |
| --- | --- |
| `src/agent/`（UtilityProcess、`policy.ts`、`tools/filesystem.ts`、`verify.ts`） | 权限、路径校验、sha256 复验是产品底线，不因重构放宽 |
| 权限预设与 30 分钟授权 TTL | 同上 |
| `AgentStore` 事件日志 | 回放与追溯的地基 |
| `layout.ts` + 来源栏 + 三个导航钩子 | 原生视图几何与白名单，已经踩平 |
| `stripEcho` / `repairJson` / `extractJsonBlocks` | 转为 `desktop-agent/v1` 专用工具，逻辑不变 |

### 7.2 解耦

| 现在 | 问题 | 改成 |
| --- | --- | --- |
| `buildInitialPrompt` 无条件注入计划协议 | 每个任务都被迫变成计划任务 | `buildRolePrompt`（稳定角色）+ `buildStagePrompt`（本轮动态内容）+ `buildPlanSuffix`（仅执行链路） |
| `AgentOrchestrator` 409 行，五件事混在一起 | 改一处牵全身 | `IntentRouter` / `ConversationRunner` / `Executor` 三个类 |
| `DeepSeekAdapter` 892 行 | 加第二个 AI 要复制一遍 | 按 `AiChannel` 拆分 |
| `pageQueue` 全局串行 | 多通道互相阻塞 | 每通道队列 + 全局并发上限 |

---

## 8. 迁移步骤

每一步都能独立发布、独立回滚，不做"大爆炸重写"。

| 步骤 | 内容 | 行为变化 | 验收 |
| --- | --- | --- | --- |
| **M1** | 抽出 `AiChannel` 接口，`DeepSeekAdapter` 实现它，行为不变 | 无 | 现有 59 项实机检查全绿 |
| **M2** | 引入 `IntentRouter`，`answer` 分支先只做一件事：**不注入计划提示词**，直接把用户原话发出去并展示回答 | 问答不再产出计划 | 问一个知识问题，回答里没有 JSON |
| **M3** | `ConversationRunner` + 右侧对话流 UI，来源栏保留为"看原始页面" | 右侧从网页视图变成对话视图 | 能连续追问两轮，上下文不断 |
| **M4** | 接入第二个通道（ChatGPT），per-channel 队列 | 可并行收集 | 两个通道同时提问互不干扰 |
| **M5** | `Synthesizer` 规则版 | 出现"分歧/缺失"标注 | 输出里至少一处明确分歧 |
| **M6** | `Executor` 收敛：只有 `workspace` 意图进入 | 计划与审批变稀有 | 关掉 Runtime，问答与研究仍可用 |

M6 的验收就是 [PRODUCT.md](PRODUCT.md) 第 7 节最后一条：**拔掉 Runtime 不影响核心产品。**

---

## 9. 风险与反面模式

| 风险 | 具体形态 | 对策 |
| --- | --- | --- |
| **逼模型吐 JSON 复发** | 给 `research/v1` 也定义一套模型输出格式，换个名字回到老路 | `AiChannel.ask()` 的返回类型里只有 `string`；结构化只在应用侧发生 |
| **综合退化成压缩** | 把 N 个回答拼给一个模型"总结一下" | `Synthesis` 必须包含 `disputed` 与 `gaps`，缺任一项视为未完成综合 |
| **多页面资源爆炸** | 同时开 6 个网页版 AI | 全局并发上限 + 队列满即返回 `ChannelBusy` |
| **回答归属失效** | 多通道下把 A 的回答当成 B 的 | 归属逻辑留在各通道内部，`attribution` 随答案一起返回，可回查 |
| **站点改版** | 选择器失效，整条链路静默变空 | 全部收在 `channels/web-page/`；`ChannelStatus` 暴露 `probeVersion` 与命中选择器 |
| **旧任务数据** | 迁移后历史任务无法回看 | `AgentStore` 只读兼容，旧任务标记 `legacy`，不尝试续跑 |

---

## 10. 与现有文档的关系

| 文档 | 定位变化 |
| --- | --- |
| [PROTOCOL.md](../desktop-agent-macos/docs/PROTOCOL.md) | 从"系统通信协议"降级为"三协议之一：本地执行协议"。内容不变，适用范围收窄 |
| [IPC.md](../desktop-agent-macos/docs/IPC.md) | 继续描述主进程与渲染进程的通道；`conversation/v1` 落地后在这里补事件表 |
| [SECURITY.md](../desktop-agent-macos/SECURITY.md) | 不变。安全边界只收紧，不放松 |
