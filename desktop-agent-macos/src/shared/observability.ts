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
  if (type === 'step.started' || type === 'task.updated' || type === 'round.started') return 'started';
  if (type === 'step.failed' || type === 'plan.invalid' || type === 'task.failed') return 'failed';
  if (type === 'task.cancelled') return 'cancelled';
  if (type === 'task.completed' || type === 'step.completed' || type === 'report.ready' || type === 'review.ready') return 'completed';
  return 'started';
}

function inferCategory(type: AgentEvent['type']): ObservabilityCategory {
  if (type === 'round.delta') return 'reasoning';
  if (type === 'round.answer') return 'assistant';
  if (type === 'plan.ready' || type === 'plan.invalid' || type === 'plan.debated') return 'planning';
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
  const provider = 'providerId' in event ? event.providerId : undefined;
  const model = 'modelId' in event ? event.modelId : undefined;
  const isTool = inferCategory(event.type) === 'tool';
  const actor = isTool
    ? { type: 'tool' as const, id: stepId ?? 'tool', label: ('tool' in event ? event.tool : stepId) ?? '工具' }
    : provider || model
      ? { type: 'model' as const, id: model ?? provider ?? 'model', label: model ?? provider ?? '模型', ...(provider ? { provider } : {}), ...(model ? { model } : {}) }
      : { type: 'system' as const, id: 'orchestrator', label: '任务编排' };
  return {
    eventId: event.eventId ?? `${taskId}:${event.type}:${String(event.sequence ?? event.at)}`,
    taskId,
    runId: event.runId ?? taskId,
    ...(roundId ? { roundId } : {}),
    ...(stepId ? { stepId } : {}),
    ...(callId ? { callId } : {}),
    sequence: event.sequence ?? event.at,
    occurredAt: event.at,
    actor,
    category: inferCategory(event.type),
    phase: inferPhase(event.type),
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

/** 同一任务的活动流：按 sequence 排序，按 eventId 去重。 */
export function projectActivity(events: readonly ObservabilityEvent[]): ObservabilityEvent[] {
  const seen = new Set<string>();
  const unique: ObservabilityEvent[] = [];
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    unique.push(event);
  }
  return unique.sort((a, b) => a.sequence - b.sequence || a.occurredAt - b.occurredAt);
}
