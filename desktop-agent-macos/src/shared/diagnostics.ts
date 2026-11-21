/** 可观测诊断包与关联检查；导出前统一脱敏。 */
import type { AgentEvent, AgentTask } from './contracts';
import type { TaskEventEnvelope } from './task-events';
import { maskSecrets, type ObservabilityEvent } from './observability';

export interface ActivityAudit {
  missingTaskId: number;
  missingSequence: number;
  duplicateEventIds: string[];
  outOfOrder: number;
  total: number;
}

export function auditActivity(events: readonly ObservabilityEvent[]): ActivityAudit {
  const seen = new Set<string>();
  const duplicateEventIds: string[] = [];
  let missingTaskId = 0;
  let missingSequence = 0;
  let outOfOrder = 0;
  let previous: ObservabilityEvent | null = null;
  for (const event of events) {
    if (!event.taskId) missingTaskId += 1;
    if (!Number.isFinite(event.sequence)) missingSequence += 1;
    if (seen.has(event.eventId)) duplicateEventIds.push(event.eventId);
    seen.add(event.eventId);
    if (previous && event.sequence < previous.sequence) outOfOrder += 1;
    previous = event;
  }
  return { missingTaskId, missingSequence, duplicateEventIds, outOfOrder, total: events.length };
}

export interface DiagnosticBundle {
  version: 1;
  generatedAt: number;
  taskId: string;
  task: AgentTask | null;
  plan: unknown;
  events: AgentEvent[];
  runEvents: TaskEventEnvelope[];
  audit: ActivityAudit;
}

const MASKED_KEYS = /api[-_]?key|token|password|secret|authorization|cookie/i;

export function buildDiagnosticBundle(input: {
  taskId: string;
  task: AgentTask | null;
  plan: unknown;
  events: readonly AgentEvent[];
  runEvents: readonly TaskEventEnvelope[];
  activity?: readonly ObservabilityEvent[];
}): DiagnosticBundle {
  const activity = input.activity ?? [];
  return {
    version: 1,
    generatedAt: Date.now(),
    taskId: input.taskId,
    task: input.task ? (maskSecrets(input.task) as AgentTask) : null,
    plan: maskSecrets(input.plan),
    events: input.events.map(event => maskSecrets(event) as AgentEvent),
    runEvents: input.runEvents.map(event => maskSecrets(event) as TaskEventEnvelope),
    audit: auditActivity(activity)
  };
}
