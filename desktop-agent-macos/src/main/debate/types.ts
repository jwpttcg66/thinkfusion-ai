/**
 * 辩论的数据结构（项目书 8.5）。
 *
 * 决策 2：辩论是独立子系统，不堆在 MasterAgent 或 Synthesis 里。
 * 决策 6/7：原始回答不可丢失、少数派观点完整保留，所以每条发言都存原文，
 * 修正另存一条 `revision` 并带 `targetMessageId`，绝不覆盖前一条。
 */

export type DebateStrategy = 'standard' | 'deep' | 'adversarial';
export type DebateStatus = 'running' | 'completed' | 'stopped' | 'cancelled';
export type DebateRole = 'proposer' | 'critic' | 'peer';
export type DebateMessageKind = 'position' | 'question' | 'rebuttal' | 'revision';

export interface DebateConfig {
  strategy: DebateStrategy;
  maxRounds: number;
  /** 参与成员的 agentId。至少两个才有辩论的意义。 */
  participants: string[];
  /** 观点不再变化时提前停止。 */
  convergenceStop: boolean;
}

export interface DebateMessage {
  messageId: string;
  roundIndex: number;
  agentId: string;
  role: DebateRole;
  kind: DebateMessageKind;
  /** 模型原文，不被摘要、不被覆盖。 */
  text: string;
  /** 质疑/反驳/修正针对哪一条发言。 */
  targetMessageId?: string;
  createdAt: number;
}

export interface DebateRound {
  index: number;
  messages: DebateMessage[];
  startedAt: number;
  endedAt?: number;
  converged: boolean;
  /** 这一轮没能完成的成员及原因，不静默丢掉。 */
  failures: Array<{ agentId: string; detail: string }>;
}

export interface DebateState {
  debateId: string;
  /** 关联的 Conversation；可以没有（独立发起的辩论）。 */
  conversationId?: string;
  question: string;
  config: DebateConfig;
  status: DebateStatus;
  rounds: DebateRound[];
  /** 与多数立场不同的发言，完整保留原文。 */
  minorities: DebateMessage[];
  createdAt: number;
  updatedAt: number;
  stopReason?: string;
}

export const DEFAULT_ROUNDS: Record<DebateStrategy, number> = {
  standard: 2,
  deep: 3,
  adversarial: 3
};

export function normalizeDebateConfig(input: Partial<DebateConfig> | undefined): DebateConfig {
  const strategies: DebateStrategy[] = ['standard', 'deep', 'adversarial'];
  const strategy = input?.strategy && strategies.includes(input.strategy) ? input.strategy : 'standard';
  const participants = Array.isArray(input?.participants)
    ? input.participants.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    strategy,
    maxRounds: typeof input?.maxRounds === 'number' && input.maxRounds >= 1 && input.maxRounds <= 10
      ? Math.floor(input.maxRounds)
      : DEFAULT_ROUNDS[strategy],
    participants,
    convergenceStop: input?.convergenceStop !== false
  };
}
