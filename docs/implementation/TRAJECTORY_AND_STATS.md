# 轨迹与统计（Trajectory & Statistics）

日期 2026-11-10，基线 **`main@fccad54`**（2026-11-10 11:24；上一版设计基于
`0.1.4@fdf0fb0`，中间 main 先到 `bee8b0e`，再到 `fccad54`）。
参考实现：`~/data/dsh-src`（DeepSeek Harness，MIT），重点读的是
`packages/client/ui-trajectory`、`packages/experimental/client-ui-stats`、
`packages/session/session-stats`、`packages/llm/token-meter`。

一句话：**轨迹是事件账本，统计是同一份账本的聚合。两者都不新增业务状态，
只把已经发生的事记下来、算出来。**

> 开工看 [TRAJECTORY_AND_STATS_PLAN.md](TRAJECTORY_AND_STATS_PLAN.md)；
> 已实现状态与真机验证见那份文档第 14 节。

---

## 0. 为什么基于 main 重新设计

上一版设计基于 `0.1.4` 的 `fdf0fb0`。之后 main 又进了 30 个提交，其中六类改动
直接改变轨迹/统计的语义。最后 5 个（`bee8b0e..fccad54`）只动折叠页与顶栏
就绪条，不改变轨迹模型；设计已按 `fccad54` 校对过。

| main 的变化 | 对设计的影响 |
| --- | --- |
| `ChannelPhase` 增加 `leading`，界面拆成「第一轮 · 各家回答」和「第二轮 · 主导人汇总」 | 轨迹不能再把主导汇总算成一次普通回答；步必须带 `group: 'first' \| 'lead'` |
| 执行模式改为**决定第一手回答由谁给**：`local`/`cloud` 不再退回网页 | 统计的“参与”必须按 `sourceType` 分开；跳过原因要写“该模式不问网页 / 没勾选云端模型” |
| 云端参与默认 `[]`，并新增跨会话 `execution-defaults.json` | 没被选中的模型不是“失败”，不能记成 failed；只有**想用但不可用**才记 skipped |
| `prepareWebViews()` 在提问前补建网页视图（`openOnLaunch=false` 时） | 冷启动的准备时间要能被看见，单独记 `prepare` 步/事件 |
| 工程编排按执行模式挑人；`needsLocalRead=false` 时不开放读文件工具 | 要能看出“这一问没读工程、也没开工具”是决定还是失败 |
| `MasterAgent` 先 `join` 全部成员再逐个 `asking`；`channels` 每轮重置 | 轨迹按 `join` 记“本轮打算问谁”，按 `asking` 记“真的开始问”，两者对不上要能看出来 |

所以这一版不是改几个字段，而是把模型重新对齐到**第一轮 / 执行阶段**这条
现在真实存在的分界线上。

---

## 1. deepharness 做对了什么（保留结论）

### 1.1 轨迹（`client/ui-trajectory`）

- 按轮次组织的事件记录表：用户、助手、工具、子工具、压缩各一行。
- 每行有输入/输出（有上限）、耗时、token、附件；点开是检查器。
- 上方真实时间轴：助手时间条拆 TTFT 与解码；拖选过滤、滚轮缩放。
- 运行中的行只画开始标记，**不编耗时**；窗口截断时显示「起止未知」。

关键实现：`trajectory-snapshot-builder.ts`、`TrajectoryTable.tsx`、
`TrajectoryTimeline.tsx`、`trajectory-record.ts`。

### 1.2 统计（`experimental/client-ui-stats`）

- 每轮一行、展开是每步：触发、执行内容、上下文、输出、缓存命中、TTFT、
  模型用时、输出速度、工具用时、总用时条。
- 全量合计来自宿主投影（`session-stats` + `token-meter`），分页不影响；
  投影不可用才退回「本窗口合计」。
- 缓存按 token 加权；工具有「逐次求和」与「并行并集」两个口径。
- **未知就是未知**：没上报 usage 显示 `—`，合计写「N 步未上报」。
- 事件行（请求头、系统提示词、工具集、重试、审批、裁剪）默认折叠。

### 1.3 借的四条原则

1. **事件是唯一事实，视图是纯投影。**
2. **未知 ≠ 0。**
3. **起止不可知就不算。**
4. **全量合计与窗口合计分开。**

---

## 2. 本工程的差异

| deepharness | ThinkFusion（main@bee8b0e） | 设计后果 |
| --- | --- | --- |
| 单 agent、单模型 | 一问多通道：网页 / 本地 / 云端 | 步带 `actorId` / `sourceType`；一轮内并行 |
| 一次模型调用 = 一步 | 第一轮回答 + 主导汇总 + 辩论 + 追加研究 + 工程读取 + 执行 | 步带 `stage` 与 `group`；执行阶段单独聚合 |
| API 通道，token/TTFT/缓存齐全 | 网页通道没有 token；TTFT 不可靠 | 大面积 `—`；统计覆盖率；不估算 |
| 关心 token 效率 | 产品主张是交叉验证 | 统计还要有协作质量：几个答/几个失败、共识/分歧/缺口、证据数、辩论轮次 |
| 压缩（compaction） | 没有压缩；有工程证据、附件、网页正文 | 事件行换成上下文来源与路由决定 |
| 会话事件日志 | 单 JSON journal + `AgentEvent[]` | 轨迹单独 append-only JSONL，不把主 journal 写大 |

---

## 3. 词汇

### 3.1 轮（Turn）

一条用户消息：`conversation:submit` 或 `conversation:followup`。追问算新的一轮。
轮边界由 `ConversationRunner` 决定。

### 3.2 组（Group）

main 的界面已经把一轮拆成两段，轨迹必须跟着拆：

| group | 界面上的位置 | 包含 |
| --- | --- | --- |
| `prepare` | 提问前 | 路由、网页视图准备、页面重置、网页抓取、工程扫描 |
| `first` | 第一轮 · 各家回答 | 每个参与者的第一手 `answer` 步 |
| `lead` | 第二轮 · 主导人汇总 | 汇总、指定辩题、读辩论给最终意见 |
| `debate` | 第二轮 · 辩论 | 一整场辩论（v1 记一场，不拆每条辩词） |
| `followup` | 追加轮 | 每个追加轮及其中的再次回答 |
| `synthesis` | 综合 | 规则版 / 融合 / 主导产物落成 `Synthesis` |
| `execute` | 执行 | 已批准计划的步骤（v2 接） |

### 3.3 步（Step）

一次有开始、有结束、可能失败的工作：

| `stage` | 是什么 | 谁产生 |
| --- | --- | --- |
| `route` | 意图判定 / 模型路由 | `classifyIntent`、`routeTask`、`routeEngineeringWithModel` |
| `prepare` | 网页视图补建、页面重置 | `prepareWebViews`、`newConversation` |
| `extract` | 抓用户点名的网页正文 | `fetchPageText` |
| `answer` | 一个通道的第一手/追问回答 | `MasterAgent.askOne`、`researchEngineering.askMember` |
| `lead` | 主导汇总 / 最终意见 | `runExecutionStage`、`deepenResearch` |
| `debate` | 辩论的整场 | `deps.runDebate` |
| `followup` | 一个追加研究轮 | `deepenResearch` |
| `tool` | 工程扫描 / 模型自读文件 | `project.scan`、`project.read` |
| `synthesis` | 规则版 / 融合综合 | `synthesizeWithFusion` |
| `execute` | 已批准计划的某一步 | `AgentOrchestrator` / `StepResult` |

### 3.4 事件（Event）

不是“步”，但需要出现在轨迹里：页面重置、通道跳过、重试、超时、降级、
附件、证据来源、审批、取消、上下文截断。

### 3.5 轨迹 vs 统计

- **轨迹**回答「按时间顺序发生了什么」：谁在什么时候做了什么、输入输出、
  为什么失败。
- **统计**回答「这些事花了多少」：每轮/每组/每步/每通道的用时、token、
  缓存、成本、成功率、协作质量。

同一份记录，两种读法。统计不重新采集。

---

## 4. 数据模型

放在 `src/shared/trace.ts`（纯类型 + 纯函数，主进程与渲染进程共用）。

### 4.1 追加记录：`TraceEntry`

JSONL 不能原地改，所以一步写成 **start / end 两条**，投影时合成一条步。

```ts
export type TraceStage =
  | 'route' | 'prepare' | 'extract' | 'answer' | 'lead' | 'debate'
  | 'followup' | 'tool' | 'synthesis' | 'execute';

export type TraceGroup =
  | 'prepare' | 'first' | 'lead' | 'debate' | 'followup' | 'synthesis' | 'execute';

export type TraceStatus =
  | 'running' | 'ok' | 'failed' | 'busy' | 'skipped' | 'cancelled' | 'interrupted';

export type TraceSource = 'web' | 'local' | 'cloud' | 'system';
export type TracePhase = 'start' | 'end' | 'instant';

export interface TraceUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  cost?: { amount: number; currency: string } | null;
}

export interface TraceRef {
  kind: 'file' | 'url' | 'attachment' | 'thread' | 'message';
  id: string;
  label?: string;
  line?: number;
  sha256?: string;
}

export interface TraceMeta {
  /** 第一轮回答数 / 失败数 / 跳过数；只由 turn/answer 步填。 */
  asked?: number;
  answered?: number;
  failed?: number;
  skipped?: number;
  /** 执行阶段里这一场辩论的轮数。 */
  rounds?: number;
  /** 综合结构计数；规则版与主导产物都往这里填。 */
  claims?: number;
  disputes?: number;
  unique?: number;
  gaps?: number;
  degraded?: boolean;
  /** 证据 / 引用 / 字符数。 */
  evidence?: number;
  citations?: number;
  outputChars?: number;
  inputChars?: number;
  /** 这一轮的执行模式与参与名单，turn.start 用。 */
  executionMode?: 'web' | 'local' | 'cloud' | 'hybrid';
  selectedCloudModels?: number;
  selectedWebChannels?: number;
  leadAgentId?: string;
  /** ModelRoute：这一轮预计问几个、谁汇总、预计几次调用、是否降级。 */
  answerers?: number;
  synthesizers?: number;
  estimatedCalls?: number;
  degradedReason?: string;
  /** 页面重置、视图准备、跳过等事件的原因码。 */
  code?: string;
}

export interface TraceEntry {
  seq: number;
  at: number;
  conversationId: string;
  turn: number;
  /** 轮内第几步；turn/event 用 0。 */
  step: number;
  kind: 'turn' | 'step' | 'event';
  phase: TracePhase;

  stage?: TraceStage;
  group?: TraceGroup;
  status?: TraceStatus;
  actorId?: string;
  actorLabel?: string;
  sourceType?: TraceSource;
  modelId?: string;
  reason?: string;

  startedAt?: number;
  endedAt?: number;
  firstTokenAt?: number;
  usage?: TraceUsage;

  inputPreview?: string;
  outputPreview?: string;
  messageId?: string;
  parentStep?: number;
  error?: { code: string; detail: string };
  refs?: TraceRef[];
  meta?: TraceMeta;
}
```

### 4.2 投影后的步：`TraceStep`

```ts
export interface TraceStep {
  key: string;                 // `${turn}:${step}`
  turn: number;
  step: number;
  stage: TraceStage;
  group: TraceGroup;
  status: TraceStatus;
  actorId: string;
  actorLabel: string;
  sourceType: TraceSource;
  modelId?: string;
  reason?: string;

  startedAt: number | null;
  endedAt: number | null;
  firstTokenAt: number | null;
  usage: TraceUsage | null;
  inputPreview: string | null;
  outputPreview: string | null;
  messageId?: string;
  error?: { code: string; detail: string };
  refs: readonly TraceRef[];
  meta?: TraceMeta;

  /** 派生值；没有数据就是 null，不是 0。 */
  durationMs: number | null;
  ttftMs: number | null;
  decodeMs: number | null;
  contextTokens: number | null;
  outputTokens: number | null;
  cacheHit: number | null;
  tps: number | null;
  measured: { usage: boolean; ttft: boolean; decode: boolean };
}
```

### 4.3 轮与合计

```ts
export interface TraceTurn {
  turn: number;
  startedAt: number | null;
  endedAt: number | null;
  status: TraceStatus;
  trigger: string | null;
  steps: readonly TraceStep[];
  events: readonly TraceStep[];

  first: {
    asked: number;
    answered: number;
    failed: number;
    busy: number;
    skipped: number;
    wallMs: number | null;
    stepMs: number | null;
  };
  leadMs: number | null;
  debateMs: number | null;
  followupMs: number | null;
  synthesisMs: number | null;

  wallMs: number | null;
  stepMs: number | null;
  toolMs: number | null;
  contextTokens: number | null;
  outputTokens: number | null;
  cacheHit: number | null;
  ttftMs: number | null;
  tps: number | null;
  coverage: { usage: number; ttft: number; decode: number; total: number };
}

export interface TraceTotals {
  turns: number;
  /** 所有阶段的步数；下面四个只统计 group='first' 的 answer 步。 */
  steps: number;
  answered: number;
  failed: number;
  busy: number;
  skipped: number;
  wallMs: number | null;
  stepMs: number | null;
  toolMs: number | null;
  contextTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheHit: number | null;
  ttftMs: number | null;
  tps: number | null;
  cost: Array<{ currency: string; amount: number }>;
  coverage: { usage: number; ttft: number; decode: number; total: number };
}
```

### 4.4 折叠规则

1. 按 `seq` 升序。
2. `kind:'turn'` + `start` 开轮；`end` 收轮。
3. `kind:'step'` + `start` 建步；`end` 合并状态、结束时间、usage、输出预览、
   `messageId`、error。
4. `kind:'event'` 直接作为一条 `step` 形状的记录，`step` 号用它自己的。
5. 同一轮里，若某步 `running` 但后面还有步（或轮已结束）→ 标 `interrupted`。
6. 只有 start 没有 end 的尾步：轮结束 → `interrupted`；轮未结束 → `running`。

### 4.5 `ChannelPhase` 到 trace 的映射

main 的通道相位是界面事实，轨迹直接吃它，不另造一套：

| `ChannelPhase` | trace |
| --- | --- |
| `resetting` | `prepare` 事件（页面重置），不建步 |
| `asking` | 开始一个 `answer` 步（若该成员已有打开的步则复用） |
| `leading` | 不自动建步；主导汇总由 `runExecutionStage` 显式起 `lead` 步 |
| `answered` | 有打开步 → 结束该步，`status:'ok'`；没有且该成员**问过** → 忽略（这是主导阶段收尾）；没有且从未问过 → `skipped` |
| `failed` | 有打开步 → `failed`；没有且问过 → 忽略（显式 `lead` 步已收）；没有且从未问过 → `skipped` |
| `busy` | 有打开步 → `busy`；没有且问过 → 忽略；没有且从未问过 → `skipped` |

`MasterAgent` 现在先 `join` 全部成员再逐个 `asking`。所以：

- `join` 记“本轮打算问谁”，不建步；
- `asking` 记“真的开始问”，建步，并把成员记进**当前组**的 `started` 集合；
- 轮结束时仍只有 `join`、没有 `asking` 的成员 → 记 `skipped` 事件，
  原因用 `join` 时能拿到的话（用户取消、没轮到、模式不问网页等）。

`started` 必须是**按组**的：第一轮答过的成员，在追加轮里也可能因为掉登录
而没被问；只看本轮全局的 `started` 会把它误当成“主导阶段收尾”而吞掉。
`lead` / `debate` / `synthesis` 组的无步相位一律忽略，由显式步负责。

**这是这一版最重要的简化：回答步完全由现有 `sink.phase` / `sink.record` 驱动，
`MasterAgent` 一行不用改。**

---

## 5. 记录点

原则：**谁拥有这个事实，谁记录。** 不让渲染层猜。

### 5.1 回答步：只听 sink

`ConversationRunner.conduct` 里构造 `ResearchSink` 时，把 phase/record 接到
`TraceRecorder`：

```ts
const sink: ResearchSink = {
  join: agentId => {
    trace.join(agentId, labelOf(agentId));   // 只记名单，不建步
    // 原有 channels 逻辑不动
  },
  record: answer => {
    const messageId = /* 原有 addMessage */;
    trace.record(answer, messageId);         // 暂存 usage / 输出 / messageId
    return messageId;
  },
  phase: (agentId, phase, detail) => {
    trace.phase(agentId, phase, detail);     // asking 建步；answered 收步
    this.deps.emit({ type: 'channel.phase', ... }); // 原有事件不动
  },
  note: text => { trace.note(text); /* 原有 */ },
  status: status => { trace.status(status); /* 原有 */ },
  cancelled: () => this.cancelled.has(conversationId)
};
```

这样：

- 知识空间、工程编排、本地逐个问、云端并行问、追加轮，全部自动覆盖；
- 失败原因、忙、未参与提问，全部来自现有 `sink.phase` 的 detail；
- 不会出现“轨迹说问了、界面没问”的两套事实。

### 5.2 显式步

| 位置 | 记什么 | 备注 |
| --- | --- | --- |
| `start()` / `followup()` 建会话后 | `turn start` | `inputPreview: text`；`meta.executionMode`、名单数、`leadAgentId` |
| `start()` 路由完成 | `route` 事件/步 | `reason: routing.reason`；工程“不需要读目录”也在这里，`meta.code='no-project-read'` |
| `applyModelRoute` 之后 | `route` 事件 | `meta.answerers/synthesizers/estimatedCalls/degradedReason`，来自 `conversation.modelRoute` |
| `conduct()` 的 `prepareWebViews()` | `prepare` 步 | 冷启动补建视图的耗时；失败记 `status:'failed'`，不阻断 |
| `start()`/`followup()` 的 `project.scan` | `tool` 步 | `refs` 来自 `scan.evidence`（path/line/sha256），`meta.evidence` |
| `askWithReadTool` 的 `project.read` | `tool` 步 | `parentStep` 指向所属回答步；`refs` 用结果里的路径/行号 |
| `conduct()` 的 `fetchPageText` | `extract` 步 | `refs: [{kind:'url'}]`，`meta.outputChars` |
| `runExecutionStage` 汇总 `pool.ask` | `lead` 步 | `group:'lead'`，`reason:'汇总'` |
| `runExecutionStage` 的 `deps.runDebate` | `debate` 步 | `meta.rounds = debate.rounds.length`；状态用 debate.status |
| `runExecutionStage` 最终意见 `pool.ask` | `lead` 步 | `reason:'读辩论记录'`，与汇总分开 |
| `synthesizeWithFusion` | `synthesis` 步 | `meta` 填 claims/disputes/unique/gaps/degraded |
| `deepenResearch` 每轮 `master.research` | `followup` 步 | 父步；里面的回答步由 `asking` 自动产生，`group:'followup'` |
| `deepenResearch` 汇总更新 `pool.ask` | `lead` 步 | `reason:'追加轮更新汇总'` |
| `conduct()` 结束 | `turn end` | 状态映射见 5.3 |
| `fail()` / `abandon()` / `cancel()` / `awaitUser()` | `turn end` | 幂等；只收一次 |
| `reconcile()` | 收尾未结束的轮 | `TraceStore` 直接追加 `turn end / interrupted` |
| `delete()` | 删除 trace 文件 | 失败只记日志，不阻断会话删除 |

切组：`beginGroup('followup')` 在 `deepenResearch` 每轮前；`beginGroup('lead')`
在执行阶段每段前；`beginGroup('synthesis')` 在综合前。`asking` 建的 answer 步
按当前组归类，所以追加轮的回答不会混进第一轮。

### 5.3 轮结束状态

| `conversation.status` | trace `turn.end.status` |
| --- | --- |
| `answered` | `ok` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |
| `awaiting_user` | `ok`（这一轮正常停下来问用户） |
| `thinking` / `collecting` / `synthesizing` | `interrupted`（正常路径不该在这里收尾） |

`TraceRecorder.endTurn` 幂等：`cancel()` 可以先收，`run()` 的 `finally` 再调一次
不会重复写。

### 5.4 未开始问的成员

`MasterAgent` 先 `join` 全体，再逐个 `asking`。轮结束时：

- `join` 了、但从未 `asking`：`skipped` 事件，`reason` 用现有 detail
  （“本轮未参与提问：…” / 用户取消 / 本地模型排队没轮到）；
- 选中但 health 不可用：`skipped`，`reason` 写“未登录 / 没配 Key / Ollama 未启动”；
- 云端模型**没被勾选**：不记任何步。默认 `selectedCloudModels=[]`，把 30 个
  没选的模型逐条记成“跳过”只是噪音。只在 `turn.start.meta.selectedCloudModels`
  里记数量。

---

## 6. 统计口径

实现放在 `src/shared/trace-stats.ts`（或 `trace.ts` 的同一文件），全部纯函数：

```ts
buildTurns(records: readonly TraceEntry[]): TraceTurn[]
stepMetrics(entryStart, entryEnd): TraceStep
aggregateTurn(turn: TraceTurn): TurnMetrics
aggregateTotals(turns: readonly TraceTurn[]): TraceTotals
```

### 6.1 每步

| 指标 | 公式 | 未知时 |
| --- | --- | --- |
| 上下文 | `input + cacheRead + cacheWrite` | `—` |
| 输出 | `outputTokens` | `—` |
| 缓存命中 | `cacheRead / 上下文`，限制 `[0,1]` | `—` |
| 首 token | `firstTokenAt - startedAt` | `—` |
| 模型/页面用时 | `endedAt - startedAt` | `—` |
| 解码时间 | `endedAt - firstTokenAt` | `—` |
| 输出速度 | `output / (解码时间/1000)` | `—` |
| 工具用时 | 子工具 `endedAt - startedAt` 之和 | `—` |
| 总用时 | `endedAt - startedAt`；运行中为空 | `—` |

### 6.2 每轮

- **第一轮参与**：只统计 `group='first'` 的 `answer` 步。答了/失败/忙/跳过分开。
- **第一轮墙钟**：第一个 `first` 步开始 → 最后一个 `first` 步结束。
- **执行阶段**：`leadMs`、`debateMs`、`followupMs`、`synthesisMs` 分开求和。
  不把“汇总 + 辩论 + 最终意见”压成一个数，否则看不出时间花在哪。
- **上下文**：默认「最新」= 最后一步的上下文；可切「累计」= 各步之和。
- **缓存命中**：按 token 加权，`sum(cacheRead) / sum(context)`。
- **首 token / 模型用时 / 输出**：各步求和；有未知步就标“部分”并给未知步数。
- **工具用时**：并行调用的并集优先；同时保留逐次求和用于解释。
- **总用时**：`turn.end - turn.start` 的真实墙钟；`stepMs` 是各步之和。
  并行时 `stepMs > wallMs`，两个都显示。
- **并行度**：`stepMs / wallMs`，两者都可测时才有。
- **状态**：有一个步失败 → `partial`；全部失败 → `failed`；运行中 → `running`；
  取消 → `cancelled`；被截断的尾步 → `interrupted`。

### 6.3 合计

- **全量合计**：来自整份 trace 文件，不受分页影响。
- **本窗口合计**：只覆盖当前加载的轮次；投影不可用时才用，并明确写出来。
- **覆盖率**：`measured.usage / steps`、`measured.ttft / steps` 等。
  网页通道多时 usage 覆盖率会很低，这是事实。
- **成本**：按币种分组；没有单价或订阅制时不累加，显示“未配置单价 / 订阅制不估算”。

### 6.4 协作质量（本工程新增）

| 指标 | 来源 |
| --- | --- |
| 被问 / 回答 / 失败 / 跳过 | 第一轮 `answer` 步 + `join` 对账 |
| 共识 / 分歧 / 独有 / 缺口 | `Synthesis`；主导人五段用 `splitSummarySections` 解析 |
| 证据条数、可追溯比例 | `Claim.sources` / `Claim.evidence` |
| 辩论轮次、主张数 | `DebateRoundView` / `DebateMetricsView` |
| 主导人来源与依据 | `lead` 步 `reason` |
| 综合是否降级 | `Synthesis.degraded` |
| 工程证据文件数 / 读取字节 | `engineeringEvidence` |
| 网页引用条数 | `Answer.citations` |

这些不参与性能合计，单独显示。它们回答“值不值得再问一次”，不是“快不快”。

### 6.5 三条硬规则

1. **未知不写 0。** `null` 一路到界面，显示 `—`；合计写“N 步未上报”。
2. **不估算。** 不拿字符数换 token，不拿平均耗时补缺失步。
3. **不把并行时间相加当墙钟。** 两个数字都显示，标签写清楚。

---

## 7. 界面

### 7.1 入口

对话区顶部（`topbar` 之下、`.scroll` 之上）加三个页签：**对话 / 轨迹 / 统计**。
只影响右侧对话面板，不碰左侧工作区、不碰右缘来源栏。

```tsx
{showingConversation && (
  <nav className="conversation-tabs" role="tablist">…</nav>
)}
```

不放进 `ConversationView`：那个组件已经绑了导出、滚动、settling；拆它风险大于收益。
页签放在 `.scroll` 外，滚动正文时不会跟着滚走。

### 7.2 轨迹页

**分组**（跟着第一轮/第二轮）：

```
第 2 轮 · 2026-11-10 10:42
  提问前        路由 / 网页视图准备 / 抓网页
  第一轮 · 各家回答
    #2.1  deepseek-v4.1-flash  已回答  12.4s
    #2.2  gpt-6-luna           失败    3.1s   400 / 模型不存在 / 未配置 Key
    #2.3  hy4                  已回答  28.7s
  第二轮 · 主导人汇总
    #2.4  hy4                  汇总    9.8s
    #2.5  hy4                  读辩论  6.2s
  辩论
    #2.6  2 轮 · completed     45.0s
  综合
    #2.7  规则版 / 融合        0.2s
```

表格列：`# / 阶段 / 参与者 / 状态 / 输入 / 输出 / 用时 / tokens / 开始时间`。
行点击 → 检查器：

- 概览：阶段、参与者、状态、起止、耗时拆分；
- 输入：完整问题/命令（16k 以内）；
- 输出：完整回答（16k 以内），Markdown 渲染；
- 用量：input/output/cache/cost，未知写“未上报”；
- 错误：code + detail + 原始 cause；
- 引用：文件（path:line + sha256）、网址、附件、网页线程；
- 跳转：按 `messageId` 跳到对话里的原回答。

**事件行**：默认折叠。打开后显示页面重置、跳过、重试、超时、降级、
附件、证据来源、审批、截断。事件行不计入步骤求和。

**时间概览**（P2）：每个参与者一条泳道，真实时间条；悬停 500ms 显示精确起止；
拖选过滤；滚轮缩放；右键清除；运行中的步只画开始标记。

### 7.3 统计页

**轮次行**：

| 列 | 说明 |
| --- | --- |
| 轮次 | 第 N 轮；展开看每一步 |
| 触发 | 用户问题摘要 / 追问 |
| 参与 | 第一轮 `回答 2 / 失败 1 / 跳过 1`；主导人是谁 |
| 第一轮用时 | 第一个回答开始 → 最后一个回答结束 |
| 汇总 | `leadMs` |
| 辩论 | 轮数 + `debateMs` |
| 上下文 | 最新或累计 |
| 输出 | token；未知 `—` |
| 缓存命中 | 加权比例；未知 `—` |
| 首 token | 求和；有未知步标“部分” |
| 模型/页面用时 | 求和；网页标“含页面生成” |
| 输出速度 | 输出 / 解码时间 |
| 工具用时 | 并集 |
| 总用时 | 墙钟 + 组成条（第一轮 / 汇总 / 辩论 / 其余） |
| 状态 | 完成 / 部分失败 / 失败 / 运行中 / 已取消 / 中断 |

**合计行**：全量合计；投影不可用退回“本窗口合计”。旁边写覆盖率：
`用量 3/5 步 · TTFT 2/5 步 · 工具 1/5 步`。

**协作质量卡**：

- 第一轮几个通道回答、几个失败、几个跳过；
- 共识 / 分歧 / 独有 / 缺口；
- 证据条数与可追溯比例；
- 辩论轮次、少数派是否保留；
- 综合是否降级；
- 一句结论，例如：“3 个通道回答，2 条共识、1 处分歧、1 个缺口；没有降级。”

**按通道汇总**：

| 通道 | 来源 | 被问 | 回答 | 失败 | 忙 | 成功率 | P50 / P95 用时 | 平均字符数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

网页、本地、云端分开展示。网页没有 token，但有可靠性。

**开关**：

- 显示事件行（默认关）；
- 上下文口径：最新 / 累计；
- 显示上下文增量（默认关；负增量用错误色）。

### 7.4 截图里的两个元素

- `deepseek-v4.1-flash 已回答 / gpt-6-luna 失败 / hy4 已回答 / kimi-k2.7-code 已回答`
  = 第一轮 `answer` 步摘要。轨迹页“第一轮 · 各家回答”组第一列显示，点芯片定位到行。
- “没有读取工程目录：模型判定这一问不必看工程目录。需要看工程时再说一声，我再去读。”
  = `route` 步的 `reason` / `meta.code='no-project-read'`，同时作为统计页事件行。
  它不是普通正文，而是一个可核对的决定。

---

## 8. 持久化

### 8.1 位置

`userData/traces/<conversationId>.jsonl`，append-only。

- 一行一条 `TraceEntry`；
- 写完 `fsync`；崩溃最多丢最后一行，读取时跳过坏行；
- 不塞进 `AgentStore` 的单 JSON journal：那份文件每次消息都整体重写，
  轨迹是高频追加、体积更大。

边界：

- 轨迹是**诊断数据**，不是状态数据。最后一行丢了可以接受；会话/消息/计划仍在
  主 journal 里。
- 删除会话时同时删 `traces/<id>.jsonl`；删除失败只记日志，不阻断会话删除。
- 旧会话没有文件：轨迹页显示“这条会话没有轨迹（旧版本记录）”，统计页退回
  从 `ConversationMessage` 派生的消息级时间线，并标明“旧记录，仅消息时间”。

### 8.2 保留策略

- 单会话超过 10 MB 或 20,000 条时滚动到 `.1`，只保留最近两份；
- 合计在读取时从整份文件算；滚动后明确写“更早的明细已滚动，合计仍为全量”。
- v1 先不滚动，写进注释，别悄悄无限长。

### 8.3 崩溃收尾

`ConversationRunner.reconcile()` 现在只把卡在 `thinking/collecting/synthesizing`
的会话标成 `failed`。同时调用 `TraceStore.closeOpenTurns(conversationId)`，
追加 `turn end / interrupted`，这样轨迹不会永远显示“运行中”。

---

## 9. IPC 与事件

```ts
// AgentApi
getTrace(input: {
  conversationId: string;
  beforeSeq?: number;
  limit?: number;
}): Promise<{
  entries: TraceEntry[];
  hasMore: boolean;
  /** 'trace' 新记录；'messages' 旧会话回退。 */
  source: 'trace' | 'messages';
  /** 整份文件的全量合计，不受 entries 分页影响。 */
  totals: TraceTotals;
}>;
```

`ConversationEvent` 增加：

```ts
| { type: 'trace.appended'; conversationId: string; entries: TraceEntry[] }
```

- 主进程按步结束批量发；轨迹页按 `seq` 去重。
- 统计页先拿 `totals`；展开某轮时再分页拉明细。
- `getTrace` 的 `entries` 默认最近 500 条；`beforeSeq` 向上翻。

---

## 10. 实现顺序

### P0：能看（1–2 天）

1. `shared/trace.ts` 类型 + 折叠/聚合纯函数。
2. `main/trace/trace-store.ts`：append、分页读、删文件、closeOpenTurns。
3. `main/trace/trace-recorder.ts`：seq/turn/step 分配，`join/record/phase`，
   `beginStep/endStep/event`，幂等 `endTurn`。
4. `ConversationRunner`：turn 起止、sink 接线、`prepare`/`route`/`extract`/
   `project.scan`；`reconcile`/`delete` 接 trace。
5. 轨迹表格（不含时间轴）+ 行检查器。
6. 统计表格（核心列）+ 覆盖率。

验收：三通道提问（两答一败）→ 轨迹三条 answer 步 + 失败原因；统计
“回答 2 / 失败 1”；网页 token 为 `—`；关掉轨迹写盘提问照常完成。

### P1：看全（2–3 天）

7. `lead` / `debate` / `followup` / `tool` / `synthesis` 显式步。
8. 事件行（路由、跳过、重试、超时、降级、附件、证据、准备网页视图）。
9. 全量合计 + 按通道汇总 + 协作质量卡。

### P2：看好（2–3 天）

10. 时间概览（泳道、缩放、拖选）。
11. 搜索/筛选/跟随最新。
12. 上下文口径与增量。
13. 导出 JSON / CSV。
14. 滚动保留策略与旧会话回退。

### 暂时不做

- 逐 chunk 流式记录；
- 辩论逐条辩词耗时（先整场）；
- 执行计划逐步轨迹（v2）；
- 跨会话对比/排行榜；
- 自动预算闸门；
- 用字符数估算网页 token。

---

## 11. 测试

### 11.1 纯函数

1. 一轮三通道：两答一败 → `first.answered=2`、`failed=1`，轮状态 `partial`。
2. 网页 usage null → context/output/cache 都是 null；`coverage.usage=0`。
3. 并行三步 → `stepMs > wallMs`，两个都保留；并行度 > 1。
4. 缓存加权：`(read=80,ctx=100)+(read=0,ctx=100)` → 0.4。
5. 轮结束但尾步没有 end → `interrupted`，`wallMs` 可测。
6. 只有 step start、没有 turn end → `running`。
7. 事件行不计入步骤求和，但出现在 `events`。
8. 旧会话 `traceFromMessages` → `source:'messages'`，只有 `at`，无 token。
9. `join` 了没 `asking` → `skipped`，不算 failed。
10. `selectedCloudModels=[]` → 没有 cloud 跳过行；只有 `turn.meta` 数量。
11. 订阅制 cost=null → `totals.cost` 为空，不出现 0 元。
12. 主导 `leading` 阶段不被拆成多条 answer 步；lead 步由显式记录产生。

### 11.2 存储/记录器

1. 追加 3 行，读回顺序与 seq 一致。
2. 最后一行半截 → 跳过坏行，前两行仍在。
3. `beforeSeq` 分页，`hasMore` 正确。
4. `meta` 返回 lastSeq/lastTurn；重启新实例仍能读到。
5. `openTurns` 找出没有 turn end 的轮；`closeOpenTurns` 收尾。
6. `remove` 后文件不存在，读回空。
7. `beginTurn/endTurn` 幂等：重复 end 只写一条。
8. `endStep(undefined)` 不抛、不写。
9. 写盘失败（只读目录）→ `append` 返回 false；`beginStep` 仍返回 handle。
10. `emit` 收到的 `trace.appended` 与写入条数一致。

### 11.3 主进程集成

用现有 `check-runner.mjs` 的假 `SubAgentPool`：

1. 两答一败 → 3 条 `answer` 步，失败步有 `error.detail`。
2. 每次 answer 步有 `startedAt/endedAt`；`latencyMs` 来自假 answer。
3. 一轮结束只有一条 `turn end`。
4. `cancel()` 后 `turn end` 是 `cancelled`，不是 running。
5. `delete()` 后 trace 文件不存在。
6. 工程编排 `needsLocalRead=false` → 没有 `tool` 步，有一条 `route`/`skipped`
   说明“不读工程、不开工具”。
7. `prepareWebViews` 失败 → `prepare` 步 `failed`，但提问继续。

### 11.4 命令

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:trace-stats
npm run test:trace
npm run test:runner
npm test
```

---

## 12. 已定的取舍

1. **入口**：对话区顶部三页签（`topbar` 下、`.scroll` 外）。不拆 `ConversationView`。
2. **粒度**：每次尝试一行（重试/追问/追加轮各一行），同一模型可以出现多次；
   统计里再按模型汇总。
3. **网页首 token**：v1 不插桩，显示 `—`。后续可在 `ChatPageDriver` 轮询里加
   “第一次看到非空增量”的记录；不加也不影响总用时。
4. **持久化**：单独 `traces/*.jsonl`，不塞进 `Conversation.trace`。
5. **权限**：轨迹只在本机；导出必须显式点，并在导出前提示包含哪些路径。

---

## 13. 和现有文档的关系

- `docs/ARCHITECTURE.md` 第 5 节：会话状态机。本设计不新增状态，只给已有状态补时间线。
- `docs/PRODUCT.md` 4.7「每一步可回溯」：本设计是它的落地。
- `docs/implementation/DEBATE_*`：辩论指标已经存在，本设计只接到统一轨迹里。
- `docs/implementation/ENGINEERING_READ_TOOLS.md`：证据结构已经存在，本设计只引用。
- `docs/implementation/TRAJECTORY_AND_STATS_PLAN.md`：文件清单、函数签名、提交拆分。
- `desktop-agent-macos/docs/HARNESS_BASELINE.md`：沿用“借鉴协议词汇与分层，
  不依赖其包”的既有决定。
