# 轨迹与统计：可落地方案

配套设计见 [TRAJECTORY_AND_STATS.md](TRAJECTORY_AND_STATS.md)。那份写“为什么”，
这份写“改哪些文件、按什么顺序、每步怎么验”。

基线：**`main@fccad54`**（2026-11-10 11:24）。上一版基于 `0.1.4@fdf0fb0`，
已按 main 的第一轮/第二轮通道条、`leading` 相位、执行模式归属、云端默认空名单
重新设计；`bee8b0e..fccad54` 的 5 个折叠页/顶栏改动不影响轨迹模型。

---

## 1. 交付目标（v1）

一次提问结束后，用户能在对话区顶部看到两个新页签：

- **轨迹**：这一问按时间顺序发生了什么。谁被问、谁回答、谁失败、为什么失败、
  每步多久、用了多少 token、读过哪些文件。失败原因原样保留。
- **统计**：这一问/这一轮/整条会话花了多少。第一轮、主导汇总、辩论、追加轮
  分开显示；未知项 `—`，并给出覆盖率。

这一版**只读**：不改问答链路、不改综合、不改权限、不改执行。轨迹是旁路记录，
写失败不能影响提问。

### 验收

跑一次三通道提问（两答一败），必须同时满足：

1. 轨迹页“第一轮 · 各家回答”有三条 `answer` 步，失败那条有原始原因；
2. 每条步有开始/结束时间，网页 token 是 `—` 不是 `0`；
3. 统计页这一轮“参与”写 `回答 2 / 失败 1`；
4. 合计行写“用量 0/3 步上报”或实际覆盖数，不写“0 tokens”；
5. `npm run typecheck`、`npm test`、`npm run test:trace` 全绿；
6. 模拟写盘失败时，提问本身照常完成。

---

## 2. 不做什么（v1）

- 不做流式逐 chunk 记录，只记开始、首 token（有就记）、结束；
- 不做辩论逐条辩词级耗时，先记一整场 `debate` 步；
- 不做执行计划逐步轨迹（`StepResult` 已在执行报告里，v2 接）；
- 不做跨会话排行榜、预算闸门、自动优化建议；
- 不用字符数估算 token；
- 不把轨迹塞进 `Conversation` 对象或 `AgentStore` 的单 JSON journal。

---

## 3. 总体结构

```
MasterAgent / ConversationRunner
        │  sink.join / sink.record / sink.phase（现有接口，不改 MasterAgent）
        ▼
TraceRecorder ──追加──► userData/traces/<conversationId>.jsonl
        │                        │
        │ emit trace.appended    │ 读
        ▼                        ▼
Renderer  ◄── IPC ──────  TraceStore
        │
        ├─ foldTrace(entries)  → 轨迹表格
        └─ aggregateTotals()   → 统计表格
```

三条边界：

1. **记录者不计算。** 主进程只写“发生了什么”，不算命中率、不算合计。
2. **投影是纯函数。** `shared/trace.ts` 只有类型和折叠，渲染进程与测试共用。
3. **写盘失败不抛出。** `TraceRecorder.append` 捕获 I/O 错误；提问链路看不到。

**最重要的简化：回答步完全由现有 `sink.phase` / `sink.record` 驱动，
`MasterAgent` 一行不用改。**

---

## 4. 文件清单

### 4.1 新增

| 文件 | 职责 | 依赖 |
| --- | --- | --- |
| `src/shared/trace.ts` | `TraceEntry` / `TraceStep` / `TraceTurn` / `TraceTotals` 类型；`foldTrace` / `aggregateTotals` / `traceFromMessages` / `preview` 纯函数 | 无 |
| `src/main/trace/trace-store.ts` | JSONL 追加、按 `seq` 分页读、删文件、`closeOpenTurns`、尾部元信息 | `node:fs` |
| `src/main/trace/trace-recorder.ts` | 分配 `seq/turn/step`；`join/record/phase`；`beginStep/endStep/event`；幂等 `endTurn` | `trace-store`、`shared/trace` |
| `src/renderer/src/components/TrajectoryPanel.tsx` | 轨迹页：分组表格、筛选、检查器 | `shared/trace` |
| `src/renderer/src/components/StatsPanel.tsx` | 统计页：轮次/步骤表、合计、覆盖率、质量卡 | `shared/trace` |
| `scripts/check-trace.mjs` | 存储与记录器测试 | `out-test` |
| `scripts/check-trace-stats.mjs` | 折叠/聚合纯函数测试 | `out-test` |

### 4.2 修改

| 文件 | 改什么 |
| --- | --- |
| `src/shared/conversation.ts` | `ConversationEvent` 增加 `trace.appended` |
| `src/shared/contracts.ts` | `AgentApi.getTrace`；导出 trace 查询/返回类型 |
| `src/main/agents/types.ts` | `SubAgentAnswer` 增加可选 `usage` / `latencyMs` / `firstTokenAt` |
| `src/main/agents/provider-agent.ts` | 围绕 `adapter.ask` 计时，回填 `latencyMs` |
| `src/main/execution/provider-sub-agent.ts` | 把 `ModelResponse.usage/latencyMs` 回填到 `SubAgentAnswer` |
| `src/main/providers/types.ts` | `ModelUsage` 增加可选 `cacheReadTokens` / `cacheWriteTokens`（v1 可只留字段） |
| `src/main/conversation-runner.ts` | 每轮 begin/end；sink 接 trace；显式 `prepare/route/extract/tool/lead/debate/followup/synthesis` 步；`reconcile`/`delete` 接 trace |
| `src/main/index.ts` | 构造 `TraceStore`；注入 `trace` 依赖；`conversation:trace` IPC |
| `src/preload/index.ts` | `getTrace` |
| `src/renderer/src/App.tsx` | `topbar` 下加三页签；切会话时回到「对话」 |
| `src/renderer/src/mock-api.ts` | `getTrace` 样例 |
| `src/renderer/src/style.css` | 页签、表格、检查器、统计条 |
| `package.json` | `test:trace`、`test:trace-stats`，挂进 `npm test` |
| `tsconfig.test.json` | include `src/main/trace/**/*.ts` |

**不改**：`master-agent.ts`、`orchestrator.ts`、`synthesis/*`、`debate/*` 的调度逻辑。
只把它们的产物接到 trace。

---

## 5. 类型（可直接照抄）

### 5.1 entry

设计稿里一条 step 是一条记录；落地改成 **start/end 两条追加记录**，因为 JSONL
不能原地改。投影负责合成。

```ts
// src/shared/trace.ts
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

export interface TraceMeta {
  asked?: number;
  answered?: number;
  failed?: number;
  skipped?: number;
  rounds?: number;
  claims?: number;
  disputes?: number;
  unique?: number;
  gaps?: number;
  degraded?: boolean;
  evidence?: number;
  citations?: number;
  outputChars?: number;
  inputChars?: number;
  executionMode?: 'web' | 'local' | 'cloud' | 'hybrid';
  selectedCloudModels?: number;
  selectedWebChannels?: number;
  leadAgentId?: string;
  answerers?: number;
  synthesizers?: number;
  estimatedCalls?: number;
  degradedReason?: string;
  code?: string;
}

export interface TraceEntry {
  seq: number;
  at: number;
  conversationId: string;
  turn: number;
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

### 5.2 投影与聚合

```ts
export function foldTrace(entries: readonly TraceEntry[]): TraceTurn[];
export function aggregateTotals(turns: readonly TraceTurn[]): TraceTotals;
export function traceFromMessages(
  conversation: Conversation | null,
  messages: readonly ConversationMessage[]
): { entries: TraceEntry[]; source: 'messages' };
export function preview(text: string | null | undefined, max?: number): string | null;
export function errorCodeOf(detail: string): string;
```

折叠规则：

1. 按 `seq` 升序。
2. `turn start` 开轮，`turn end` 收轮。
3. `step start` 建步，`step end` 合并。
4. `event` 直接作为一条 step 形状的记录。
5. 有 start 无 end 的尾步：轮结束 → `interrupted`；轮未结束 → `running`。
6. 同一轮里后一步出现时，前一步若还 `running` → `interrupted`。

指标公式：

```ts
contextTokens = usage ? (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) : null
outputTokens  = usage?.outputTokens ?? null
cacheHit      = contextTokens > 0 && usage?.cacheReadTokens != null
                  ? min(1, cacheRead / contextTokens) : null
ttftMs        = startedAt != null && firstTokenAt != null ? firstTokenAt - startedAt : null
decodeMs      = firstTokenAt != null && endedAt != null ? endedAt - firstTokenAt : null
tps           = outputTokens != null && decodeMs > 0 ? outputTokens / (decodeMs / 1000) : null
durationMs    = startedAt != null && endedAt != null ? endedAt - startedAt : null
```

---

## 6. TraceStore

```ts
// src/main/trace/trace-store.ts
export class TraceStore {
  constructor(private readonly root: string) {} // userData/traces

  /** 追加一行；写失败返回 false，不抛。 */
  append(entry: TraceEntry): boolean;

  /** 按 seq 升序读取；beforeSeq 用于向上翻页。 */
  read(conversationId: string, options?: {
    beforeSeq?: number;
    limit?: number;
  }): { entries: TraceEntry[]; hasMore: boolean };

  /** 会话的最后一个 seq/turn；第一次调用扫一遍文件，之后缓存。 */
  meta(conversationId: string): { lastSeq: number; lastTurn: number };

  /** 整份文件，用于全量合计。 */
  readAll(conversationId: string): TraceEntry[];

  /** 未结束的轮（只有 turn start，没有 turn end）。 */
  openTurns(conversationId: string): number[];

  /** 崩溃收尾：给未结束的轮追加 turn end / interrupted。 */
  closeOpenTurns(conversationId: string, at?: number): number;

  remove(conversationId: string): void;
}
```

实现要点：

- 路径 `path.join(root, `${path.basename(conversationId)}.jsonl`)`。
- `append`：`mkdirSync(root, { recursive: true })`，`openSync(file, 'a')`,
  `writeSync`, `fsyncSync`, `closeSync`；`try/catch` 返回 false。
- `read`：逐行 `JSON.parse`，坏行跳过；过滤 `conversationId`；按 `seq` 升序；
  `limit` 默认 500，最多 2000。
- `meta`：首次 `readAll` 后缓存；`append` 同步更新。
- `openTurns`：扫 `turn start`，去掉有 `turn end` 的。
- `closeOpenTurns`：对每个未结束轮追加 `{kind:'turn', phase:'end', status:'interrupted'}`。
- `remove`：`fs.rmSync(file, { force: true })`，清缓存。
- **不建 summary 文件（v1）**：`readAll` 扫几百行足够；等几万行再加。
- **不滚动（v1）**：只存 400 字预览；10,000 条约 20 MB；达到 10 MB 再实现 `.1`。

---

## 7. TraceRecorder

```ts
// src/main/trace/trace-recorder.ts
export interface StepHandle { turn: number; step: number }

export interface TraceJoin {
  agentId: string;
  label: string;
  sourceType: TraceSource;
}

export class TraceRecorder {
  constructor(
    private readonly store: TraceStore,
    private readonly conversationId: string,
    private readonly emit: (event: ConversationEvent) => void,
    private readonly clock: () => number = Date.now
  ) {}

  private closed = false;

  beginTurn(input: {
    inputPreview?: string;
    reason?: string;
    meta?: TraceMeta;
  }): { turn: number };

  endTurn(input: {
    status: TraceStatus;
    meta?: TraceMeta;
    reason?: string;
  }): void; // 幂等

  /** 只记名单，不建步；轮结束时没 asking 的记 skipped。 */
  join(input: TraceJoin): void;

  /** 暂存 answer 的 usage / 输出 / messageId，等 phase answered 收步。 */
  record(answer: SubAgentAnswer, messageId: string): void;

  /** 现有 channel.phase 的旁路。 */
  phase(agentId: string, phase: ChannelPhase, detail?: string): void;

  /** 切换后续 answer 步归属的组：first / followup。 */
  beginGroup(group: TraceGroup, inputPreview?: string): void;

  /** 显式阶段步。 */
  beginStep(input: {
    stage: TraceStage;
    group?: TraceGroup;   // 不传用当前 group
    actorId: string;
    actorLabel: string;
    sourceType: TraceSource;
    modelId?: string;
    inputPreview?: string;
    reason?: string;
    parentStep?: number;
    refs?: TraceRef[];
  }): StepHandle | undefined;

  endStep(handle: StepHandle | undefined, input: {
    status: TraceStatus;
    endedAt?: number;
    firstTokenAt?: number;
    usage?: TraceUsage | null;
    outputPreview?: string;
    messageId?: string;
    error?: { code: string; detail: string };
    meta?: TraceMeta;
    refs?: TraceRef[];
  }): void;

  event(input: {
    stage: TraceStage;
    group?: TraceGroup;
    status: TraceStatus;
    actorId?: string;
    actorLabel?: string;
    sourceType?: TraceSource;
    reason?: string;
    error?: { code: string; detail: string };
    refs?: TraceRef[];
    meta?: TraceMeta;
    step?: number;
  }): void;

  note(text: string): void;
  status(status: ConversationStatus): void;
}
```

实现：

- 构造时 `meta = store.meta(id)`，`seq = meta.lastSeq`，`turn = meta.lastTurn`。
- `beginTurn`：`turn += 1; step = 0; group = 'prepare'; closed = false`；
  清空上一轮的 `joined / started / open / answers`。
- `beginGroup`：设置 `group` 和 `currentInput`；`answering` 步按它归类。
  追加轮前调 `beginGroup('followup', followQuestion)`，执行阶段调
  `beginGroup('lead')`，综合前调 `beginGroup('synthesis')`。
- `beginStep`：`step += 1`，追加 `start`，返回 handle；`group` 不传用当前值。
- `endStep`：追加 `end`；`endedAt` 默认 `clock()`。
- `append`：分配 `seq += 1`、`at = clock()`；`store.append(entry)`；无论写盘成功
  与否都 `emit({type:'trace.appended', ...})`——界面实时行来自内存。
- `endTurn`：`if (closed) return; closed = true;`，把仍 `running` 的步标
  `interrupted`，把只 `join` 没 `asking` 的成员记 `skipped`。
- `preview(text, 400)`：压成一行、截断加 `…`。

### 7.1 `join/record/phase` 的行为

```ts
private joined = new Map<string, TraceJoin>();
private started = new Map<TraceGroup, Set<string>>(); // 每组问过的成员
private open = new Map<string, StepHandle>();        // agentId → 当前步
private answers = new Map<string, { answer: SubAgentAnswer; messageId: string }>();

join(input) { this.joined.set(input.agentId, input); }

record(answer, messageId) { this.answers.set(answer.agentId, { answer, messageId }); }

private startedIn(group: TraceGroup): Set<string> {
  const set = this.started.get(group) ?? new Set<string>();
  this.started.set(group, set);
  return set;
}

phase(agentId, phase, detail) {
  if (phase === 'asking') {
    if (this.open.has(agentId)) return;
    this.startedIn(this.group).add(agentId);
    const who = this.joined.get(agentId) ?? { agentId, label: agentId, sourceType: 'web' };
    const handle = this.beginStep({
      stage: 'answer',
      group: this.group,             // first / followup
      actorId: agentId,
      actorLabel: who.label,
      sourceType: who.sourceType,
      inputPreview: this.currentInput   // 当前问题，由 beginTurn / beginGroup 更新
    });
    if (handle) this.open.set(agentId, handle);
    return;
  }

  if (phase === 'answered' || phase === 'failed' || phase === 'busy') {
    const handle = this.open.get(agentId);
    const saved = this.answers.get(agentId);
    if (!handle) {
      // 主导/辩论/综合组没有 answer 步；收尾由显式步负责，不要补 skipped。
      if (this.group === 'lead' || this.group === 'debate' || this.group === 'synthesis') return;
      // 本组已经问过：这是同一组的后续相位，不要补 skipped。
      if (this.startedIn(this.group).has(agentId)) return;
      // 从没 asking 过：不是 failed，是跳过。截图上的“失败”芯片对应这里的原因。
      this.event({
        stage: 'answer', group: this.group, status: 'skipped',
        actorId: agentId, actorLabel: this.joined.get(agentId)?.label ?? agentId,
        sourceType: this.joined.get(agentId)?.sourceType ?? 'web',
        error: detail ? { code: errorCodeOf(detail), detail } : undefined,
        meta: { code: 'not-asked' }
      });
      return;
    }
    this.open.delete(agentId);
    this.answers.delete(agentId);
    this.endStep(handle, {
      status: phase === 'answered' ? 'ok' : phase === 'busy' ? 'busy' : 'failed',
      endedAt: this.clock(),
      ...(saved ? {
        usage: saved.answer.usage ?? null,
        firstTokenAt: saved.answer.firstTokenAt,
        outputPreview: saved.answer.text,
        messageId: saved.messageId,
        meta: { outputChars: saved.answer.text.length, citations: saved.answer.citations?.length ?? 0 }
      } : {}),
      ...(detail && phase !== 'answered' ? { error: { code: errorCodeOf(detail), detail } } : {})
    });
    return;
  }

  if (phase === 'resetting') {
    this.event({
      stage: 'prepare', group: 'prepare', status: 'ok',
      actorId: agentId, actorLabel: this.joined.get(agentId)?.label ?? agentId,
      reason: 'page.reset',
      ...(detail ? { error: { code: errorCodeOf(detail), detail } } : {})
    });
  }
}
```

- `leading` 不在这里建步：一场执行阶段包含汇总、辩论、最终意见多次模型调用，
  由 `runExecutionStage` 显式起止。
- `beginGroup('followup')` 在 `deepenResearch` 每轮前调用，`phase('asking')`
  因此把新回答记到 `followup` 组；同一个 agent 上一轮已 end，所以会新建步。
- `beginGroup('lead')` / `beginGroup('synthesis')` 只影响显式步的默认 group，
  `beginStep` 也可显式传。

---

## 8. 记录点（按当前 main 的函数）

### 8.1 `ConversationRunner.start()` / `followup()`

| 位置 | 记录 |
| --- | --- |
| 建完 `conversation`、写完 user 消息 | `trace.beginTurn({ inputPreview: text, reason: intent.reason, meta: { executionMode, selectedCloudModels: n, selectedWebChannels: n, leadAgentId } })` |
| `routing` 算完 | `trace.event({ stage:'route', group:'prepare', status:'ok', reason: routing.reason, meta:{ code: routing.taskKind } })` |
| `applyModelRoute` 之后 | `trace.event({ stage:'route', group:'prepare', status:'ok', reason: conversation.modelRoute?.degraded, meta:{ answerers, synthesizers, estimatedCalls, degradedReason } })` |
| `needsProjectEvidence` 判定不读 | `trace.event({ stage:'route', group:'prepare', status:'skipped', reason: read.reason, meta:{ code:'no-project-read' } })` |
| `project.scan` 前后 | `beginStep({stage:'tool', group:'prepare', actor:'system'})`；`endStep` 带 `refs`（evidence 的 path/line/sha256）和 `meta.evidence` |
| `handoff` 进入执行 | `trace.event({ stage:'execute', group:'execute', status:'ok', reason: '转交执行计划' })` |
| `awaitUser` | `trace.endTurn({status:'ok', reason:'等待用户补充'})` |
| `fail` / `cancel` / `abandon` | `trace.endTurn({status:'failed'|'cancelled'})`；幂等 |

### 8.2 `ConversationRunner.conduct()`

| 位置 | 记录 |
| --- | --- |
| `prepareWebViews()` 前后 | 显式 `prepare` 步；失败 `status:'failed'`，不阻断。同一轮只记第一次（`conduct` 与工程编排都可能调用） |
| `restoreThreads` | 事件 `page.restore`；耗时可选 |
| `fetchPageText` | 显式 `extract` 步；`refs:[{kind:'url', id: page.url}]`；`meta.outputChars` |
| `engineeringRound = researchEngineering(...)` | 里面的 `asking` 自动建 `answer` 步；编排 fallback 记 `event` |
| `master.research(...)` | 里面的 `asking` 自动建 `answer` 步 |
| `runExecutionStage(...)` | 见 8.3 |
| `deepenResearch(...)` | 见 8.4 |
| `synthesizeWithFusion(...)` | 显式 `synthesis` 步；`meta` 填 claims/disputes/unique/gaps/degraded |
| `setStatus('answered')` | `trace.endTurn({status:'ok'})`；实际在 `run()` 的 finally 兜底 |

### 8.3 `runExecutionStage()`

| 位置 | 记录 |
| --- | --- |
| `sink.phase(lead, 'leading', ...)` 之前/之后 | 不建步；`leading` 只驱动界面 |
| 汇总 `pool.ask(lead, ...)` 前后 | `beginStep({stage:'lead', group:'lead', reason:'汇总'})`；`endStep` 带 usage/输出 |
| `deps.runDebate(...)` 前后 | `beginStep({stage:'debate', group:'debate', actor: lead})`；`endStep` 带 `meta.rounds`，`status` 按 debate.status |
| 最终意见 `pool.ask(lead, ...)` 前后 | `beginStep({stage:'lead', group:'lead', reason:'读辩论记录'})`；`endStep` |
| 没有辩论 / 最终意见 | `sink.phase(lead,'answered')` 现有逻辑不动；trace 无额外步 |

### 8.4 `deepenResearch()`

| 位置 | 记录 |
| --- | --- |
| 每轮 `master.research(...)` 前后 | `beginGroup('followup')`；父 `beginStep({stage:'followup', group:'followup', meta:{round}})`；`endStep` |
| 汇总更新 `pool.ask` 前后 | `beginStep({stage:'lead', group:'lead', reason:'追加轮更新汇总'})`；`endStep` |

### 8.5 `askWithReadTool()`

每次 `mainCapabilities.execute('project.read')` 前后：

```ts
const readStep = trace.beginStep({
  stage: 'tool', group: 'prepare', actorId: target.agentId, actorLabel: target.label,
  sourceType: 'local', reason: `读文件：${request.tool}`, parentStep: parent?.step
});
const result = await mainCapabilities.execute(...);
trace.endStep(readStep, {
  status: result.ok ? 'ok' : 'failed',
  outputPreview: result.summary,
  refs: result.refs,          // 若能力返回路径/行号；没有就省略
  meta: { outputChars: result.text.length }
});
```

### 8.6 `reconcile()` / `delete()`

- `reconcile()`：对每个 `IN_FLIGHT_STATUSES` 会话，除现有标 failed 外，
  调 `traceStore.closeOpenTurns(conversationId)`。
- `delete()`：`traceStore.remove(conversationId)`；失败只 `console.warn`。

---

## 9. IPC 与界面

### 9.1 契约

```ts
// shared/contracts.ts
export interface TraceQuery {
  conversationId: string;
  beforeSeq?: number;
  limit?: number;
}

export interface TraceResult {
  entries: TraceEntry[];
  hasMore: boolean;
  source: 'trace' | 'messages';
  totals: TraceTotals;
}

export interface AgentApi {
  getTrace(input: TraceQuery): Promise<TraceResult>;
}
```

`ConversationEvent`：

```ts
| { type: 'trace.appended'; conversationId: string; entries: TraceEntry[] }
```

### 9.2 主进程

启动时（`index.ts`，`store = new AgentStore(...)` 附近）：

```ts
traceStore = new TraceStore(path.join(app.getPath('userData'), 'traces'));
```

`ConversationRunner` 依赖增加：

```ts
trace: {
  recorder: (conversationId: string) => TraceRecorder;
  remove: (conversationId: string) => void;
};
```

`index.ts` 注入：

```ts
trace: {
  recorder: id => new TraceRecorder(traceStore, id, emitConversation),
  remove: id => traceStore.remove(id)
}
```

runner 内部：

```ts
private readonly traces = new Map<string, TraceRecorder>();

private traceFor(id: string): TraceRecorder {
  const existing = this.traces.get(id);
  if (existing) return existing;
  const created = this.deps.trace.recorder(id);
  this.traces.set(id, created);
  return created;
}
```

- `start/followup` 取同一个 recorder，`beginTurn`。
- `conduct` 的 sink 用同一个 recorder。
- `run()` 的 `finally`：`recorder.endTurn({ status: map(conversation.status) })`。
- `delete`：`this.traces.delete(id); this.deps.trace.remove(id)`。

IPC：

```ts
ipcMain.handle('conversation:trace', (event, raw: unknown) => {
  trustedUiSender(event);
  const input = raw as TraceQuery;
  if (typeof input?.conversationId !== 'string') throw new Error('缺少对话 id');
  const limit = Math.min(Math.max(Number(input.limit) || 500, 1), 2000);
  const all = traceStore.readAll(input.conversationId);
  if (all.length > 0) {
    const page = traceStore.read(input.conversationId, {
      ...(typeof input.beforeSeq === 'number' ? { beforeSeq: input.beforeSeq } : {}),
      limit
    });
    return {
      ...page,
      source: 'trace' as const,
      totals: aggregateTotals(foldTrace(all))
    };
  }
  const conversation = store.getConversation(input.conversationId);
  const messages = store.listMessages(input.conversationId);
  const fallback = traceFromMessages(conversation, messages);
  return {
    ...fallback,
    entries: fallback.entries.slice(-limit),
    hasMore: fallback.entries.length > limit,
    totals: aggregateTotals(foldTrace(fallback.entries))
  };
});
```

### 9.3 `App.tsx`

在 `topbar` 之后、`.scroll` 之前：

```tsx
{showingConversation && (
  <nav className="conversation-tabs" role="tablist" aria-label="对话视图">
    <button role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>对话</button>
    <button role="tab" aria-selected={tab === 'trajectory'} onClick={() => setTab('trajectory')}>轨迹</button>
    <button role="tab" aria-selected={tab === 'stats'} onClick={() => setTab('stats')}>统计</button>
  </nav>
)}
<div className={`scroll${activeTask || showingConversation ? '' : ' is-empty'}`}>
  <div className="inner">
    {showingConversation && activeConversation && tab === 'chat' && (
      <ConversationView ... />
    )}
    {showingConversation && activeConversation && tab === 'trajectory' && (
      <TrajectoryPanel conversationId={activeConversation.conversationId} />
    )}
    {showingConversation && activeConversation && tab === 'stats' && (
      <StatsPanel conversationId={activeConversation.conversationId} conversation={activeConversation} />
    )}
    ...
```

- `const [tab, setTab] = useState<'chat'|'trajectory'|'stats'>('chat');`
- `useEffect(() => setTab('chat'), [activeConversationId]);`
- 页签在 `.scroll` 外，滚动正文时不跟着滚走。
- 不改 `ConversationView` 的导出/滚动/settling。

### 9.4 `TrajectoryPanel`

```tsx
export function TrajectoryPanel(props: { conversationId: string }) {
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [source, setSource] = useState<'trace'|'messages'>('trace');
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<TraceStatus | null>(null);

  useEffect(() => {
    let alive = true;
    void window.agentAPI.getTrace({ conversationId: props.conversationId }).then(result => {
      if (!alive) return;
      setEntries(result.entries);
      setSource(result.source);
    });
    return () => { alive = false; };
  }, [props.conversationId]);

  useEffect(() => window.agentAPI.onConversationEvent(event => {
    if (event.type !== 'trace.appended' || event.conversationId !== props.conversationId) return;
    setEntries(prev => mergeBySeq(prev, event.entries));
  }), [props.conversationId]);

  const turns = useMemo(() => foldTrace(entries), [entries]);
  ...
}
```

渲染：

- 旧会话：顶部一条 `.trace-banner`：“这条会话没有轨迹，下面是按消息时间重建的；没有 token/耗时。”
- 每轮一个 `<section>`；轮内按 `group` 分组：
  `prepare`（可折叠）→ `first` → `lead` → `debate` → `followup` → `synthesis`。
- 每步一行；`status` 用颜色点；`—` 用于未知。
- 行点击 → 右侧/下方检查器；`MarkdownBody` 渲染输出。
- 输出超过 16k 显示“已截断，完整内容在消息里”。
- `error.detail` 原样显示，不翻译成“请求失败”这种更空的话。

### 9.5 `StatsPanel`

```tsx
const turns = useMemo(() => foldTrace(entries), [entries]);
const totals = useMemo(() => aggregateTotals(turns), [turns]);
const [showEvents, setShowEvents] = useState(false);
const [contextMode, setContextMode] = useState<'latest'|'cumulative'>('latest');
```

- 轮次行：`轮次 / 触发 / 参与 / 第一轮用时 / 汇总 / 辩论 / 上下文 / 输出 / 缓存 / 首 token / 模型用时 / TPS / 工具 / 总用时 / 状态`。
- 展开：按 group 分组的步骤行。
- 合计行：`totals` + 覆盖率。
- 质量卡：从 `group='synthesis'` 步的 `meta` 读 claims/disputes/unique/gaps/degraded；
  没有就显示“这一轮没有综合”。
- `—` 统一用 `<Unknown/>`，`title` 写“未上报 / 无法测量”。

### 9.6 mock

`mock-api.ts` 的 `getTrace` 返回：

- 1 条 `turn` start/end；
- 3 条 `answer` 步（两 ok、一 failed）；
- 1 条 `route` 事件（“没有读取工程目录”）；
- 1 条 `lead` 步；
- 1 条 `synthesis` 步。

浏览器预览 `VITE_MOCK=1` 可直接点两个页签。

---

## 10. 测试

### 10.1 纯函数 `scripts/check-trace-stats.mjs`

1. 三通道两答一败 → `first.answered=2`、`failed=1`，轮状态 `partial`。
2. 网页 usage null → context/output/cache null；`coverage.usage=0`。
3. 并行三步 → `stepMs > wallMs`，两个数字都保留。
4. 缓存加权：`(read=80,ctx=100)+(read=0,ctx=100)` → 0.4。
5. 轮结束但尾步没有 end → `interrupted`，`wallMs` 可测。
6. 只有 step start、没有 turn end → `running`。
7. 事件行不计入 steps 求和，但出现在 `events`。
8. 旧会话 `traceFromMessages` → `source:'messages'`，只有 `at`，无 token。
9. `join` 了没 `asking` → `skipped`，不算 failed。
10. `selectedCloudModels=[]` → 没有 cloud 跳过行；只有 `turn.meta` 数量。
11. 订阅制 cost=null → `totals.cost` 为空，不出现 0 元。
12. `leading` 阶段不被拆成多条 answer 步；lead 步由显式记录产生。

### 10.2 存储/记录器 `scripts/check-trace.mjs`

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

### 10.3 主进程集成（扩展 `scripts/check-runner.mjs`）

1. 两答一败 → 3 条 `answer` 步，失败步有 `error.detail`。
2. 每次 answer 步有 `startedAt/endedAt`；`latencyMs` 来自假 answer。
3. 一轮结束只有一条 `turn end`。
4. `cancel()` 后 `turn end` 是 `cancelled`，不是 running。
5. `delete()` 后 trace 文件不存在。
6. 工程编排 `needsLocalRead=false` → 没有 `tool` 步，有一条 `route`/`skipped`
   说明“不读工程、不开工具”。
7. `prepareWebViews` 失败 → `prepare` 步 `failed`，但提问继续。

### 10.4 命令

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:trace-stats
npm run test:trace
npm run test:runner
npm test
```

---

## 11. 提交拆分

### 提交 1：数据层

```
feat(trace): 记录每一问的通道耗时与失败原因

原来一次提问结束后只留下最终回答：谁失败、为什么失败、每步多久、
用了多少 token 都不落盘，排查只能靠内存里的阶段和一句错误文本。

现在主进程旁路写 userData/traces/<id>.jsonl：轮开始/结束、每个通道的
回答步、页面重置、路由决定、失败原因。回答步直接听现有的
sink.join / sink.record / sink.phase，MasterAgent 不改；轨迹只存预览，
全文仍在消息表；写盘失败不影响提问。
```

改动：`shared/trace.ts`、`main/trace/*`、`agents/types.ts`、
`provider-agent.ts`、`execution/provider-sub-agent.ts`、`conversation-runner.ts`、
`index.ts`、`tsconfig.test.json`、两个测试脚本、`package.json`。

### 提交 2：轨迹页

```
feat(trace): 对话区可以查看这一问的轨迹

原来失败只有一个芯片，用户看不到发问顺序、耗时、失败原因和读了哪些
文件。现在对话区顶部多一个「轨迹」页：按第一轮/第二轮分组的表格、
行检查器、失败原因原样显示、未知值显示 —，旧会话退回消息级时间线
并标明来源。
```

改动：`contracts.ts`、`conversation.ts`、`preload/index.ts`、`index.ts`、
`App.tsx`、`TrajectoryPanel.tsx`、`mock-api.ts`、`style.css`。

### 提交 3：统计页

```
feat(stats): 对话区可以查看每轮/每步的耗时与用量

原来只有全局 UsageSummary，看不出哪一轮、哪个模型、哪一步慢，也看不出
网页通道的 token 根本拿不到。现在统计页按轮/组/步展示第一轮用时、汇总、
辩论、token、缓存、TPS、成功率和协作质量；未知显示 — 并给出覆盖率，
并行时间与墙钟分开。
```

改动：`StatsPanel.tsx`、`shared/trace.ts` 聚合函数、`style.css`、
`check-trace-stats.mjs`。

### 可选提交 4：时间轴

```
feat(trace): 轨迹页增加时间概览

表格能看出顺序，看不出重叠。现在每一步按真实起止画成泳道条，
拖选过滤、滚轮缩放、运行中只画开始标记。
```

---

## 12. 风险与回退

| 风险 | 处理 |
| --- | --- |
| 写盘拖慢提问 | 每次 append 一行；本地 `fsync` 可接受；真机 >2ms/条改成进程内队列批量 flush，接口不变 |
| 轨迹文件变大 | 只存 400 字预览；10 MB 再轮转 |
| IPC 事件过多 | 每步 start/end 两条；一轮通常 < 30 条；按 `seq` 去重 |
| 旧会话没有文件 | `traceFromMessages` 回退，`source:'messages'`，界面明说 |
| 崩溃留下 running | `reconcile()` 调 `closeOpenTurns` |
| 写 trace 抛错 | `append` 吞 I/O 错误；`beginStep` 永远返回 handle；`endStep` 不抛 |
| 统计说假话 | 未知 `null`；界面 `—`；覆盖率单独显示；不估算 |
| 与 main 的第一轮/第二轮条不一致 | 直接吃 `sink.phase`，不另造通道状态；`leading` 只由显式 `lead` 步表达 |

回退：删掉 `start/followup` 里的 recorder 创建和 `sink` 里的 trace 调用即可，
问答链路不依赖 trace 类型。

---

## 13. 工作量

| 部分 | 人日 |
| --- | --- |
| 数据层 + sink 接线 + 测试 | 1.5 |
| 轨迹页 | 1 |
| 统计页 | 1 |
| 时间轴（可选） | 1 |
| 真机回归与文案 | 0.5 |

v1（提交 1–3）约 3–3.5 人日；时间轴再加 1 人日。

---

## 14. 已落地（2026-11-10，分支 0.1.6）

全部计划项已经实现并通过验证：

| 项 | 状态 |
| --- | --- |
| `shared/trace.ts`：类型、折叠、合计、旧会话回退 | ✅ |
| `main/trace/trace-store.ts`：JSONL 追加、分页、损坏行跳过、崩溃收尾、删除 | ✅ |
| `main/trace/trace-recorder.ts`：turn/step、join/record/phase、幂等 endTurn、写失败不抛 | ✅ |
| `main/trace/execution-trace.ts`：`StepResult` → `execute` 步 | ✅ |
| `ConversationRunner`：轮起止、路由/准备/抓网页/工程扫描/工具/汇总/辩论/追加/综合 | ✅ |
| 回答步直接听 `sink.join / record / phase`，`MasterAgent` 未改 | ✅ |
| `SubAgentAnswer` 回填 usage / latency / firstTokenAt；网页 usage 为 null | ✅ |
| 网页首 token：`waitForAnswer` 第一次看到非空正文时回调 | ✅ |
| 辩论逐条发言：`startedAt / endedAt` 落盘，轨迹按条记步 | ✅ |
| 缓存 token：OpenAI `prompt_tokens_details.cached_tokens` / DeepSeek / Anthropic 风格字段 | ✅ |
| 轨迹时间轴：泳道、悬停、滚轮缩放、拖选过滤、右键复位 | ✅ |
| IPC `conversation:trace` + `trace.appended` 事件 | ✅ |
| 对话区「对话 / 轨迹 / 统计」页签 | ✅ |
| 轨迹表格、检查器、分页加载、失败原因、未知 `—` | ✅ |
| 统计表格、全量/窗口合计、覆盖率、协作质量、按通道汇总 | ✅ |
| 旧会话消息级回退 | ✅ |
| `check-trace.mjs` / `check-trace-stats.mjs` | ✅ |

**真机验证**（`npm run start:debug` + CDP，未向任何账号发问题）：

- 主进程正常启动，`window.agentAPI.getTrace` 可用；
- 新建一个「工程空间未选目录」的会话：`submit → awaitUser`，轨迹文件实际写出
  4 条记录（turn start、两条事件、turn end），`getTrace` 返回 `source:'trace'`；
- 删除该会话后轨迹文件消失，`getTrace` 退回 `source:'messages'`；
- 打开历史会话 → 轨迹页显示“旧记录，仅消息时间”横幅，按消息重建三步；
- 统计页在真实渲染进程里显示第一轮计数、覆盖率、`—` 和按通道表；
- 浏览器预览（`VITE_MOCK=1`）里点开对话、轨迹、统计三个页签，检查器正常。

**原本在 main 上就红、这次一并对齐的两个测试**：

- `test:web-orchestration`：换成提到「工程」的决策问题，让
  `needsProjectEvidence` 真的扫描目录；旧问题按新规则默认不读工程，
  没有证据可摘不是编排坏了。
- `test:scenarios`：云端/本地主导从 2026-11-09 起就是对应模型回答、
  不问网页；断言改成按执行模式取回答名单，不再写「回答永远来自网页」。

两处都是期望值跟着既有产品规则更新，不是把断言改松。
