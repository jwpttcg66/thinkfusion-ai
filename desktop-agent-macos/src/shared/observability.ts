/** 工程工作台的统一可观测事件：只做展示投影，不替代业务存储。 */
import type { AgentEvent } from './contracts';
import type { ConversationEvent } from './conversation';
import type { TraceEntry } from './trace';
import { conversationEventToTaskEvent, taskIdOf } from './task-events';

export type ObservabilityActorType = 'system' | 'model' | 'tool' | 'subagent' | 'user';
export type ObservabilityCategory =
  | 'lifecycle' | 'reasoning' | 'assistant' | 'planning' | 'approval' | 'tool'
  | 'subagent' | 'file' | 'terminal' | 'test' | 'review' | 'delivery' | 'diagnostic';
export type ObservabilityPhase = 'preparing' | 'started' | 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface ObservabilityEvent {
  eventId: string;
  taskId: string;
  runId: string;
  roundId?: string;
  stepId?: string;
  attemptId?: string;
  callId?: string;
  streamId?: string;
  parentEventId?: string;
  sequence: number;
  occurredAt: number;
  actor: {
    type: ObservabilityActorType;
    id: string;
    label: string;
    provider?: string;
    model?: string;
  };
  category: ObservabilityCategory;
  phase: ObservabilityPhase;
  payload: Record<string, unknown>;
}

function inferPhase(type: AgentEvent['type']): ObservabilityPhase {
  if (type === 'round.delta') return 'streaming';
  if (type === 'step.preparing' || type === 'plan.ready' || type === 'step.approval') return 'preparing';
  if (type === 'step.started' || type === 'task.updated' || type === 'round.started' || type === 'round.peer') return 'started';
  if (type === 'step.failed' || type === 'plan.invalid' || type === 'task.failed') return 'failed';
  if (type === 'task.cancelled') return 'cancelled';
  if (type === 'task.completed' || type === 'step.completed' || type === 'report.ready' || type === 'review.ready') return 'completed';
  return 'started';
}

function inferCategory(type: AgentEvent['type']): ObservabilityCategory {
  if (type === 'round.delta') return 'reasoning';
  if (type === 'round.answer') return 'assistant';
  if (type === 'round.peer') return 'subagent';
  if (type === 'plan.ready' || type === 'plan.invalid' || type === 'plan.review.progress' || type === 'plan.debated') return 'planning';
  if (type === 'step.preparing' || type === 'step.started' || type === 'step.completed' || type === 'step.failed' || type === 'step.approval' || type === 'step.approval-resolved') return 'tool';
  if (type === 'report.ready') return 'test';
  if (type === 'review.ready') return 'review';
  if (type === 'task.completed') return 'delivery';
  if (type === 'log') return 'diagnostic';
  return 'lifecycle';
}

export function fromAgentEvent(event: AgentEvent): ObservabilityEvent | null {
  const taskId = taskIdOf(event);
  if (!taskId) return null;
  const roundId = 'roundId' in event ? event.roundId : undefined;
  const stepId = 'stepId' in event ? event.stepId : undefined;
  const callId = 'callId' in event ? event.callId : stepId;
  const streamId = 'streamId' in event ? event.streamId : undefined;
  const provider = 'providerId' in event ? event.providerId : undefined;
  const model = 'modelId' in event ? event.modelId : undefined;
  const isTool = inferCategory(event.type) === 'tool';
  // 成员身份：round.peer 自带 label；其它事件只有 participantId。两者都要能
  // 让人看出「这条是哪个模型」，否则轨迹里一排 tool 分不清谁发起的。
  const participantId = 'participantId' in event ? event.participantId : undefined;
  const peerLabel = event.type === 'round.peer' ? event.label : undefined;
  const actor = isTool
    ? { type: 'tool' as const, id: stepId ?? 'tool', label: ('tool' in event ? event.tool : stepId) ?? '工具' }
    : model
      ? { type: 'model' as const, id: participantId ?? model, label: model, ...(provider ? { provider } : {}), model }
      : peerLabel
        ? { type: 'subagent' as const, id: participantId ?? 'member', label: peerLabel, ...(provider ? { provider } : {}) }
        : participantId
          ? { type: 'subagent' as const, id: participantId, label: participantId, ...(provider ? { provider } : {}) }
          : provider
            ? { type: 'model' as const, id: provider, label: provider, provider }
            : { type: 'system' as const, id: 'orchestrator', label: '任务编排' };
  const peerPhase: ObservabilityPhase | null = event.type === 'round.peer'
    ? event.status === 'answered'
      ? 'completed'
      : event.status === 'failed'
        ? 'failed'
        : event.status === 'cancelled'
          ? 'cancelled'
          : 'started'
    : null;
  return {
    eventId: event.eventId ?? `${taskId}:${event.type}:${String(event.sequence ?? event.at)}`,
    taskId,
    runId: event.runId ?? taskId,
    ...(roundId ? { roundId } : {}),
    ...(stepId ? { stepId } : {}),
    ...(callId ? { callId } : {}),
    ...(streamId ? { streamId } : {}),
    sequence: event.sequence ?? event.at,
    occurredAt: event.at,
    actor,
    category: inferCategory(event.type),
    phase: peerPhase ?? inferPhase(event.type),
    payload: { ...event }
  };
}

function phaseFromStatus(status: TraceEntry['status']): ObservabilityPhase {
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'ok') return 'completed';
  if (status === 'running') return 'started';
  return 'preparing';
}

function categoryFromTrace(entry: TraceEntry): ObservabilityCategory {
  if (entry.reasoning) return 'reasoning';
  if (entry.stage === 'answer' || entry.stage === 'lead') return 'assistant';
  if (entry.stage === 'debate') return 'review';
  if (entry.stage === 'prepare' || entry.stage === 'extract') return 'planning';
  return 'lifecycle';
}

export function fromTraceEntry(entry: TraceEntry, opts: { taskId?: string; runId?: string } = {}): ObservabilityEvent {
  const taskId = opts.taskId ?? entry.conversationId;
  return {
    eventId: `trace:${entry.conversationId}:${String(entry.seq)}`,
    taskId,
    runId: opts.runId ?? taskId,
    sequence: entry.seq,
    occurredAt: entry.at,
    actor: entry.actorId
      ? { type: 'model', id: entry.actorId, label: entry.actorLabel ?? entry.actorId, ...(entry.modelId ? { model: entry.modelId } : {}) }
      : { type: 'system', id: 'trace', label: entry.actorLabel ?? '轨迹' },
    category: categoryFromTrace(entry),
    phase: phaseFromStatus(entry.status),
    payload: { ...entry }
  };
}

export function fromConversationEvent(event: ConversationEvent, meta: { eventId: string; sequence: number }): ObservabilityEvent | null {
  const mapped = conversationEventToTaskEvent(event, meta);
  if (!mapped) return null;
  return {
    eventId: mapped.eventId,
    taskId: mapped.taskId,
    runId: mapped.runId,
    ...(mapped.roundId ? { roundId: mapped.roundId } : {}),
    ...(mapped.stepId ? { stepId: mapped.stepId } : {}),
    ...(mapped.stepId ? { callId: mapped.stepId } : {}),
    sequence: mapped.sequence,
    occurredAt: mapped.occurredAt,
    actor: { type: 'system', id: 'conversation', label: '会话' },
    category: mapped.type === 'answer.delta' || mapped.type === 'message.added' ? 'assistant' : 'lifecycle',
    phase: event.type === 'answer.delta' ? 'streaming' : 'started',
    payload: mapped.payload
  };
}

/** 同一任务的活动流：按 sequence 排序、按 eventId 去重、同一 stream 的增量合成一条。 */
export function projectActivity(events: readonly ObservabilityEvent[]): ObservabilityEvent[] {
  const seen = new Set<string>();
  const unique: ObservabilityEvent[] = [];
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    unique.push(event);
  }
  const ordered = unique.sort((a, b) => a.sequence - b.sequence || a.occurredAt - b.occurredAt);
  const merged: ObservabilityEvent[] = [];
  const streamAt = new Map<string, number>();
  for (const event of ordered) {
    const streamKey = event.streamId && (event.category === 'reasoning' || event.category === 'assistant')
      ? `${event.category}:${event.roundId ?? ''}:${event.streamId}`
      : null;
    if (streamKey && streamAt.has(streamKey)) {
      const at = streamAt.get(streamKey)!;
      merged[at] = { ...merged[at], occurredAt: event.occurredAt, phase: event.phase, payload: event.payload };
      continue;
    }
    if (streamKey) streamAt.set(streamKey, merged.length);
    merged.push(event);
  }
  return merged;
}

/** 详情检查器/导出前脱敏；只按字段名判断，不改写非敏感值。 */
export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/api[-_]?key|token|password|secret|authorization|cookie/i.test(key)) {
      out[key] = item ? '***' : item;
      continue;
    }
    out[key] = maskSecrets(item);
  }
  return out;
}
