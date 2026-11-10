/**
 * 轨迹（Trajectory）与统计（Statistics）的共享模型。
 *
 * 两条约定贯穿整份文件：
 *
 * 1. **事件是唯一事实。** 主进程只追加 TraceEntry，不维护第二份统计状态；
 *    轨迹表格和统计表格都是这里的纯投影。
 * 2. **未知就是 null，不是 0。** 网页通道拿不到 token、没有首 token 时，
 *    派生值保持 null，界面显示 `—`；合计只累加真正上报过的步。
 *
 * 本文件不依赖 Electron、不依赖主进程，渲染进程与测试脚本共用。
 */

import type { Conversation, ConversationMessage } from './conversation';

export type TraceStage =
  | 'route'
  | 'prepare'
  | 'extract'
  | 'answer'
  | 'lead'
  | 'debate'
  | 'followup'
  | 'tool'
  | 'synthesis'
  | 'execute';

export type TraceGroup =
  | 'prepare'
  | 'first'
  | 'lead'
  | 'debate'
  | 'followup'
  | 'synthesis'
  | 'execute';

export type TraceStatus =
  | 'running'
  | 'ok'
  | 'failed'
  | 'busy'
  | 'skipped'
  | 'cancelled'
  | 'interrupted';

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

export interface TraceError {
  code: string;
  detail: string;
}

export interface TraceMeta {
  /** 第一轮：打算问 / 回答 / 失败 / 跳过。 */
  asked?: number;
  answered?: number;
  failed?: number;
  skipped?: number;
  /** 一场辩论的轮数。 */
  rounds?: number;
  /** 综合结构计数。 */
  claims?: number;
  disputes?: number;
  unique?: number;
  gaps?: number;
  degraded?: boolean;
  /** 这一轮的综合是主导人五段汇总，不是规则版句子对齐。 */
  leadSummary?: boolean;
  /** 证据 / 引用 / 字符数。 */
  evidence?: number;
  citations?: number;
  outputChars?: number;
  inputChars?: number;
  /** 这一轮的执行模式与参与名单。 */
  executionMode?: 'web' | 'local' | 'cloud' | 'hybrid';
  selectedCloudModels?: number;
  selectedWebChannels?: number;
  leadAgentId?: string;
  /** 工程路由：模型/规则判定这一问要不要读工程目录。 */
  readsProject?: boolean;
  /** ModelRoute 的预计值与降级说明。 */
  answerers?: number;
  synthesizers?: number;
  estimatedCalls?: number;
  degradedReason?: string;
  /** 事件原因码：no-project-read / not-asked / page-reset 等。 */
  code?: string;
}

/**
 * 追加日志的一行。
 *
 * 一步写成 start/end 两条：JSONL 不能原地改，投影时再合成一条 TraceStep。
 */
export interface TraceEntry {
  seq: number;
  at: number;
  conversationId: string;
  /** 第几轮，从 1 开始。 */
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
  /** 为什么是它：路由依据、主导人选择、降级原因。 */
  reason?: string;

  startedAt?: number;
  endedAt?: number;
  firstTokenAt?: number;
  usage?: TraceUsage;

  /** 有界预览；全文在消息表 / 证据 / 执行报告里。 */
  inputPreview?: string;
  outputPreview?: string;
  messageId?: string;
  /** 父步骤：工具调用、追加轮里的回答指向所属步。 */
  parentStep?: number;
  error?: TraceError;
  refs?: TraceRef[];
  meta?: TraceMeta;
}

/** 投影后的一步。 */
export interface TraceStep {
  key: string;
  turn: number;
  step: number;
  /** 事件行的 kind 是 event；步是 step。 */
  kind: 'step' | 'event';
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
  parentStep?: number;
  error?: TraceError;
  refs: readonly TraceRef[];
  meta?: TraceMeta;

  durationMs: number | null;
  ttftMs: number | null;
  decodeMs: number | null;
  contextTokens: number | null;
  outputTokens: number | null;
  cacheHit: number | null;
  tps: number | null;
  measured: { usage: boolean; ttft: boolean; decode: boolean };
}

export interface TraceFirstRound {
  asked: number;
  answered: number;
  failed: number;
  busy: number;
  skipped: number;
  wallMs: number | null;
  stepMs: number | null;
}

export interface TraceTurn {
  turn: number;
  startedAt: number | null;
  endedAt: number | null;
  status: TraceStatus;
  trigger: string | null;
  steps: readonly TraceStep[];
  events: readonly TraceStep[];
  first: TraceFirstRound;
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
  coverage: TraceCoverage;
}

export interface TraceCoverage {
  usage: number;
  ttft: number;
  decode: number;
  total: number;
}

export interface TraceTotals {
  turns: number;
  steps: number;
  /** 下面四个只统计 group='first' 的 answer 步。 */
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
  coverage: TraceCoverage;
}

/** 压成一行，并截断到 `max` 个字符。 */
export function preview(text: string | null | undefined, max = 400): string | null {
  if (typeof text !== 'string') return null;
  const value = text.replace(/\s+/g, ' ').trim();
  if (!value) return null;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** 把错误文本尽力归到一个稳定 code；归不了就是 unknown，不编。 */
export function errorCodeOf(detail: string): string {
  if (/超时|timeout/i.test(detail)) return 'timeout';
  if (/忙|正在处理上一个问题|busy/i.test(detail)) return 'busy';
  if (/模型不存在|model[- ]not[- ]found|找不到模型/i.test(detail)) return 'model-not-found';
  if (/API Key|apikey|api key|凭据|401|403/i.test(detail)) return 'auth';
  if (/未登录|登录|不可用|找不到输入框|页面结构|unavailable/i.test(detail)) return 'unavailable';
  return 'unknown';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function contextOf(usage: TraceUsage | null | undefined): number | null {
  if (!usage) return null;
  const parts = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
  // 网页通道报的是 { inputTokens: null, outputTokens: null }：这不是 0，
  // 是「不知道」。只有至少一个数值时才算上下文。
  if (!parts.some(value => isNumber(value))) return null;
  let total = 0;
  for (const value of parts) if (isNumber(value)) total += value;
  return total;
}

function derived(entry: TraceEntry): Pick<
  TraceStep,
  'durationMs' | 'ttftMs' | 'decodeMs' | 'contextTokens' | 'outputTokens' | 'cacheHit' | 'tps' | 'measured'
> {
  const started = isNumber(entry.startedAt) ? entry.startedAt : null;
  const ended = isNumber(entry.endedAt) ? entry.endedAt : null;
  const first = isNumber(entry.firstTokenAt) ? entry.firstTokenAt : null;
  const usage = entry.usage ?? null;
  const contextTokens = contextOf(usage);
  const outputTokens = usage?.outputTokens ?? null;
  const durationMs = started !== null && ended !== null ? Math.max(0, ended - started) : null;
  const ttftMs = started !== null && first !== null ? Math.max(0, first - started) : null;
  const decodeMs = first !== null && ended !== null ? Math.max(0, ended - first) : null;
  const cacheHit =
    contextTokens !== null && contextTokens > 0 && isNumber(usage?.cacheReadTokens)
      ? Math.min(1, usage.cacheReadTokens / contextTokens)
      : null;
  const tps =
    outputTokens !== null && decodeMs !== null && decodeMs > 0
      ? outputTokens / (decodeMs / 1000)
      : null;
  return {
    durationMs,
    ttftMs,
    decodeMs,
    contextTokens,
    outputTokens,
    cacheHit,
    tps,
    measured: {
      usage: contextTokens !== null || outputTokens !== null,
      ttft: ttftMs !== null,
      decode: decodeMs !== null
    }
  };
}

interface StepDraft {
  start?: TraceEntry;
  end?: TraceEntry;
  event?: TraceEntry;
}

interface TurnDraft {
  turn: number;
  start?: TraceEntry;
  end?: TraceEntry;
  steps: Map<string, StepDraft>;
  events: TraceStep[];
}

function entryToStep(entry: TraceEntry, kind: 'step' | 'event'): TraceStep {
  const d = derived(entry);
  return {
    // 事件行常常共用 step=0；用 seq 保证每一行有稳定且唯一的 key。
    key: kind === 'event' ? `${entry.turn}:event:${entry.seq}` : `${entry.turn}:${entry.step}`,
    turn: entry.turn,
    step: entry.step,
    kind,
    stage: entry.stage ?? 'route',
    group: entry.group ?? (kind === 'event' ? 'prepare' : 'first'),
    status: entry.status ?? (kind === 'event' ? 'ok' : 'running'),
    actorId: entry.actorId ?? 'system',
    actorLabel: entry.actorLabel ?? '系统',
    sourceType: entry.sourceType ?? 'system',
    ...(entry.modelId ? { modelId: entry.modelId } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
    startedAt: isNumber(entry.startedAt) ? entry.startedAt : null,
    endedAt: isNumber(entry.endedAt) ? entry.endedAt : null,
    firstTokenAt: isNumber(entry.firstTokenAt) ? entry.firstTokenAt : null,
    usage: entry.usage ?? null,
    inputPreview: entry.inputPreview ?? null,
    outputPreview: entry.outputPreview ?? null,
    ...(entry.messageId ? { messageId: entry.messageId } : {}),
    ...(isNumber(entry.parentStep) ? { parentStep: entry.parentStep } : {}),
    ...(entry.error ? { error: entry.error } : {}),
    refs: entry.refs ?? [],
    ...(entry.meta ? { meta: entry.meta } : {}),
    ...d
  };
}

function mergeStep(draft: StepDraft): TraceStep {
  const start = draft.start;
  const end = draft.end;
  const base = start ?? end;
  if (!base) throw new Error('trace step has neither start nor end');
  const merged: TraceEntry = {
    ...base,
    ...end,
    // start 的输入/阶段不能被 end 的空字段覆盖。
    stage: end?.stage ?? base.stage,
    group: end?.group ?? base.group,
    actorId: end?.actorId ?? base.actorId,
    actorLabel: end?.actorLabel ?? base.actorLabel,
    sourceType: end?.sourceType ?? base.sourceType,
    inputPreview: base.inputPreview ?? end?.inputPreview,
    startedAt: start?.startedAt ?? start?.at ?? end?.startedAt ?? undefined,
    endedAt: end?.endedAt ?? end?.at ?? start?.endedAt ?? undefined
  };
  return entryToStep(merged, 'step');
}

function maxOf(values: Array<number | null>): number | null {
  let max: number | null = null;
  for (const value of values) if (value !== null && (max === null || value > max)) max = value;
  return max;
}

function minOf(values: Array<number | null>): number | null {
  let min: number | null = null;
  for (const value of values) if (value !== null && (min === null || value < min)) min = value;
  return min;
}

function sumMeasured(values: Array<number | null>): { value: number | null; measured: number } {
  let sum = 0;
  let measured = 0;
  for (const value of values) {
    if (value === null) continue;
    sum += value;
    measured += 1;
  }
  return { value: measured > 0 ? sum : null, measured };
}

function coverageOf(steps: readonly TraceStep[]): TraceCoverage {
  return {
    usage: steps.filter(step => step.measured.usage).length,
    ttft: steps.filter(step => step.measured.ttft).length,
    decode: steps.filter(step => step.measured.decode).length,
    total: steps.length
  };
}

function firstRoundOf(steps: readonly TraceStep[]): TraceFirstRound {
  const first = steps.filter(step => step.group === 'first' && step.stage === 'answer');
  const durations = first.map(step => step.durationMs);
  const starts = first.map(step => step.startedAt);
  const ends = first.map(step => step.endedAt);
  const start = minOf(starts);
  const end = maxOf(ends);
  return {
    asked: first.length,
    answered: first.filter(step => step.status === 'ok').length,
    failed: first.filter(step => step.status === 'failed').length,
    busy: first.filter(step => step.status === 'busy').length,
    skipped: first.filter(step => step.status === 'skipped').length,
    wallMs: start !== null && end !== null ? Math.max(0, end - start) : null,
    stepMs: sumMeasured(durations).value
  };
}

function turnCache(steps: readonly TraceStep[]): {
  rate: number | null;
  read: number | null;
  write: number | null;
  context: number | null;
} {
  let read = 0;
  let write = 0;
  let context = 0;
  let measured = false;
  for (const step of steps) {
    if (step.cacheHit === null || step.contextTokens === null) continue;
    read += step.usage?.cacheReadTokens ?? 0;
    write += step.usage?.cacheWriteTokens ?? 0;
    context += step.contextTokens;
    measured = true;
  }
  return {
    rate: measured && context > 0 ? Math.min(1, read / context) : null,
    read: measured ? read : null,
    write: measured ? write : null,
    context: measured ? context : null
  };
}

function lastContext(steps: readonly TraceStep[]): number | null {
  let context: number | null = null;
  for (const step of steps) if (step.contextTokens !== null) context = step.contextTokens;
  return context;
}

function stepDurationSum(steps: readonly TraceStep[], filter: (step: TraceStep) => boolean): number | null {
  return sumMeasured(steps.filter(filter).map(step => step.durationMs)).value;
}

/**
 * 把追加日志折成轮和步。
 *
 * @param entries 按任意顺序传入的原始记录；内部按 seq 排序。
 * @returns 按轮号升序的投影。
 */
export function foldTrace(entries: readonly TraceEntry[]): TraceTurn[] {
  const sorted = [...entries].sort((left, right) => left.seq - right.seq);
  const turns = new Map<number, TurnDraft>();

  const draftFor = (turn: number): TurnDraft => {
    const existing = turns.get(turn);
    if (existing) return existing;
    const created: TurnDraft = { turn, steps: new Map(), events: [] };
    turns.set(turn, created);
    return created;
  };

  for (const entry of sorted) {
    const draft = draftFor(entry.turn);
    if (entry.kind === 'turn') {
      if (entry.phase === 'start') draft.start = entry;
      else draft.end = entry;
      continue;
    }
    if (entry.kind === 'event') {
      draft.events.push(entryToStep(entry, 'event'));
      continue;
    }
    const key = `${entry.turn}:${entry.step}`;
    const step = draft.steps.get(key) ?? {};
    if (entry.phase === 'start') step.start = entry;
    else step.end = entry;
    draft.steps.set(key, step);
  }

  const result: TraceTurn[] = [];
  for (const draft of [...turns.values()].sort((left, right) => left.turn - right.turn)) {
    const steps = [...draft.steps.values()]
      .map(mergeStep)
      .sort((left, right) => left.step - right.step);

    const turnEnded = draft.end !== undefined;
    // A step followed by another step cannot still be running: a trimmed window
    // can lose its end record, and the row would otherwise stay running forever.
    for (let index = 0; index < steps.length - 1; index += 1) {
      const step = steps[index];
      if (step && step.status === 'running') {
        steps[index] = { ...step, status: 'interrupted' };
      }
    }
    const tail = steps[steps.length - 1];
    if (turnEnded && tail && tail.status === 'running') {
      steps[steps.length - 1] = { ...tail, status: 'interrupted' };
    }

    const start = draft.start;
    const end = draft.end;
    const startedAt = start?.startedAt ?? start?.at ?? null;
    const endedAt = end?.endedAt ?? end?.at ?? null;
    const cache = turnCache(steps);
    const output = sumMeasured(steps.map(step => step.outputTokens));
    const ttft = sumMeasured(steps.map(step => step.ttftMs));
    const decode = sumMeasured(steps.map(step => step.decodeMs));
    const tool = sumMeasured(steps.filter(step => step.stage === 'tool').map(step => step.durationMs));
    const decodeMs = decode.value;

    result.push({
      turn: draft.turn,
      startedAt,
      endedAt,
      status: end?.status ?? (turnEnded ? 'interrupted' : 'running'),
      trigger: start?.inputPreview ?? null,
      steps,
      events: draft.events,
      first: firstRoundOf(steps),
      leadMs: stepDurationSum(steps, step => step.stage === 'lead'),
      debateMs: stepDurationSum(steps, step => step.stage === 'debate'),
      followupMs: stepDurationSum(steps, step => step.stage === 'followup'),
      synthesisMs: stepDurationSum(steps, step => step.stage === 'synthesis'),
      wallMs:
        startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null,
      stepMs: sumMeasured(steps.map(step => step.durationMs)).value,
      toolMs: tool.value,
      contextTokens: lastContext(steps),
      outputTokens: output.value,
      cacheHit: cache.rate,
      ttftMs: ttft.value,
      tps:
        output.value !== null && decodeMs !== null && decodeMs > 0
          ? output.value / (decodeMs / 1000)
          : null,
      coverage: coverageOf(steps)
    });
  }
  return result;
}

/**
 * 把当前加载的轮次聚成一行合计。
 *
 * 只累加真正上报过的值；一项都没测到时返回 null，不返回 0。
 */
export function aggregateTotals(turns: readonly TraceTurn[]): TraceTotals {
  const steps = turns.flatMap(turn => turn.steps);
  const output = sumMeasured(steps.map(step => step.outputTokens));
  const ttft = sumMeasured(steps.map(step => step.ttftMs));
  const decode = sumMeasured(steps.map(step => step.decodeMs));
  const tool = sumMeasured(
    steps.filter(step => step.stage === 'tool').map(step => step.durationMs)
  );
  const wall = sumMeasured(turns.map(turn => turn.wallMs));
  const stepMs = sumMeasured(steps.map(step => step.durationMs));
  const cacheContext = sumMeasured(steps.map(step => step.contextTokens));
  const cacheRead = sumMeasured(steps.map(step => step.usage?.cacheReadTokens ?? null));
  const cacheWrite = sumMeasured(steps.map(step => step.usage?.cacheWriteTokens ?? null));
  const costs = new Map<string, number>();
  for (const step of steps) {
    const cost = step.usage?.cost;
    if (!cost) continue;
    costs.set(cost.currency, (costs.get(cost.currency) ?? 0) + cost.amount);
  }
  const first = turns.map(turn => turn.first);
  return {
    turns: turns.length,
    steps: steps.length,
    answered: first.reduce((sum, item) => sum + item.answered, 0),
    failed: first.reduce((sum, item) => sum + item.failed, 0),
    busy: first.reduce((sum, item) => sum + item.busy, 0),
    skipped: first.reduce((sum, item) => sum + item.skipped, 0),
    wallMs: wall.value,
    stepMs: stepMs.value,
    toolMs: tool.value,
    contextTokens: cacheContext.value,
    outputTokens: output.value,
    cacheReadTokens: cacheRead.value,
    cacheWriteTokens: cacheWrite.value,
    cacheHit:
      cacheRead.value !== null && cacheContext.value !== null && cacheContext.value > 0
        ? Math.min(1, cacheRead.value / cacheContext.value)
        : null,
    ttftMs: ttft.value,
    tps:
      output.value !== null && decode.value !== null && decode.value > 0
        ? output.value / (decode.value / 1000)
        : null,
    cost: [...costs.entries()].map(([currency, amount]) => ({ currency, amount })),
    coverage: coverageOf(steps)
  };
}

/**
 * 旧会话回退：没有 trace 文件时，只按消息时间重建一份最小轨迹。
 *
 * 只有 `at`，没有 token、没有首 token、没有失败原因。界面必须标明
 * “旧记录，仅消息时间”，不能把它当成完整的统计。
 */
export function traceFromMessages(
  conversation: Conversation | null,
  messages: readonly ConversationMessage[]
): { entries: TraceEntry[]; source: 'messages' } {
  const sorted = [...messages].sort((left, right) => left.at - right.at);
  const entries: TraceEntry[] = [];
  let seq = 0;
  let turn = 0;
  let step = 0;
  let openTurn: number | null = null;

  const append = (entry: Omit<TraceEntry, 'seq' | 'at' | 'conversationId'> & { at?: number }) => {
    seq += 1;
    entries.push({
      seq,
      at: entry.at ?? (entry.startedAt ?? Date.now()),
      conversationId: conversation?.conversationId ?? '',
      ...entry
    });
  };

  const closeTurn = (at: number, status: TraceStatus) => {
    if (openTurn === null) return;
    append({ kind: 'turn', phase: 'end', turn: openTurn, step: 0, status, endedAt: at });
    openTurn = null;
  };

  for (const message of sorted) {
    if (message.role === 'user') {
      closeTurn(message.at, 'interrupted');
      turn += 1;
      step = 0;
      openTurn = turn;
      append({
        kind: 'turn',
        phase: 'start',
        turn,
        step: 0,
        status: 'running',
        startedAt: message.at,
        inputPreview: preview(message.text) ?? undefined,
        meta: { code: 'legacy-messages' }
      });
      continue;
    }
    if (message.role === 'system' || openTurn === null) continue;
    step += 1;
    append({
      kind: 'step',
      phase: 'end',
      turn: openTurn,
      step,
      stage: message.role === 'synthesis' ? 'synthesis' : 'answer',
      group: message.role === 'synthesis' ? 'synthesis' : 'first',
      status: 'ok',
      actorId: message.channelId ?? (message.role === 'synthesis' ? 'synthesis' : 'system'),
      actorLabel: message.channelId ?? (message.role === 'synthesis' ? '综合' : '系统'),
      sourceType: message.channelId ? 'web' : 'system',
      startedAt: message.at,
      endedAt: message.at,
      outputPreview: preview(message.text) ?? undefined,
      messageId: message.messageId
    });
  }
  closeTurn(sorted.at(-1)?.at ?? Date.now(), 'ok');
  return { entries, source: 'messages' };
}
