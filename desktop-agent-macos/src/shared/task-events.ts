/** 统一任务事件契约的兼容层：旧 AgentEvent 逐步补齐，不要求一次改完所有 emit。 */
import type { AgentEvent, TaskEventPhase } from './contracts';

export function phaseOfEvent(type: AgentEvent['type']): TaskEventPhase {
  switch (type) {
    case 'task.updated': return 'understanding';
    case 'round.started':
    case 'round.delta':
    case 'round.answer': return 'planning';
    case 'plan.ready':
    case 'plan.invalid':
    case 'plan.debated':
    case 'step.approval':
    case 'step.approval-resolved': return 'approval';
    case 'step.started':
    case 'step.completed':
    case 'step.failed': return 'execution';
    case 'report.ready': return 'verification';
    case 'review.ready': return 'review';
    case 'task.completed': return 'delivery';
    case 'task.failed':
    case 'task.cancelled': return 'terminal';
    default: return 'execution';
  }
}

export function taskIdOf(event: AgentEvent): string | null {
  if ('taskId' in event && typeof event.taskId === 'string') return event.taskId;
  if (event.type === 'task.updated') return event.task.taskId;
  return null;
}

/** 同一任务内按 sequence 排序，无 sequence 的旧事件保持到达顺序。 */
export function mergeTaskEvent<T extends AgentEvent>(list: readonly T[], event: T): T[] {
  if (event.eventId && list.some(item => item.eventId === event.eventId)) return [...list];
  const next = [...list, event];
  return next.sort((a, b) => {
    if (typeof a.sequence === 'number' && typeof b.sequence === 'number' && a.sequence !== b.sequence) {
      return a.sequence - b.sequence;
    }
    return a.at - b.at;
  });
}
