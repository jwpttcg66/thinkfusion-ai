/** 三个工作空间共享的生命周期词汇；具体状态由各自已有状态机映射。 */
import type { AgentTask } from './contracts';
import type { ConversationStatus } from './conversation';

export type LifecyclePhase =
  | 'understanding'
  | 'planning'
  | 'clarification'
  | 'approval'
  | 'executing'
  | 'verifying'
  | 'reviewing'
  | 'delivering'
  | 'completed'
  | 'failed'
  | 'cancelled';

export function lifecycleOfTask(status: AgentTask['status']): LifecyclePhase {
  switch (status) {
    case 'created': return 'understanding';
    case 'planning': return 'planning';
    case 'plan_ready': return 'approval';
    case 'awaiting_clarification': return 'clarification';
    case 'awaiting_approval': return 'approval';
    case 'executing': return 'executing';
    case 'verifying': return 'verifying';
    case 'report_pending': return 'reviewing';
    case 'awaiting_next_round': return 'planning';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'pause_requested':
    case 'pausing':
    case 'paused':
    case 'interrupted':
    case 'budget_exhausted':
    case 'blocked':
      return 'executing';
    case 'cancel_requested':
    case 'cancelling':
    case 'cancelled': return 'cancelled';
    default: return 'understanding';
  }
}

/** 会话状态映射到同一套阶段；General/Knowledge 先用它，不创建假 AgentTask。 */
export function lifecycleOfConversation(status: ConversationStatus): LifecyclePhase {
  switch (status) {
    case 'thinking': return 'planning';
    case 'collecting': return 'executing';
    case 'comparing': return 'reviewing';
    case 'synthesizing': return 'delivering';
    case 'awaiting_user': return 'clarification';
    case 'answered': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'understanding';
  }
}

export function isTerminalPhase(phase: LifecyclePhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled';
}
