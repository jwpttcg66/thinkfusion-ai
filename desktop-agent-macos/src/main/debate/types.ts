/**
 * 辩论的数据结构（项目书 8.5）。
 *
 * 决策 2：辩论是独立子系统，不堆在 MasterAgent 或 Synthesis 里。
 * 决策 6/7：原始回答不可丢失、少数派观点完整保留，所以每条发言都存原文，
 * 修正另存一条 `revision` 并带 `targetMessageId`，绝不覆盖前一条。
 */

import type { DebateLead, DebateLeadMode, LeadPlan } from './lead';

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
  /** 谁主导：本地 / 网页 / 混合。老数据没有这个字段，按 hybrid 读。 */
  leadMode?: DebateLeadMode;
  /** 用户指定的主辩。没有指定就由 planLead 按模式挑，并把结果写进 lead。 */
  leadAgentId?: string;
  /**
   * 会话执行阶段发起辩论时的「基准材料」：网页通道已经给出的回答，以及
   * 主导人指定的辩题。第一轮辩手读到的就是这些，不是从零开始重复回答。
   * 独立辩论面板不传这个字段，行为不变。
   */
  seed?: { positions: string[]; topics: string[] };
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
  /**
   * 网页成员发言时页面留下的会话地址。只有网页通道有；本地/云端为空。
   * 辩论是独立子系统，不会往 Conversation 里登记，所以清理网页侧记录
   * 得靠这个地址，不能靠 deleteConversation。
   */
  threadUrl?: string;
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
  /** 这一场谁主导、为什么这么选，落盘供历史查询和界面显示。 */
  lead: DebateLead;
  /** planLead 的完整结果：界面照实显示，编排器也用它决定每轮谁发言。 */
  plan: LeadPlan;
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

/** 老辩论文件没有主导信息时的兜底：如实说没记录，不假装是混合模式。 */
export const LEGACY_LEAD: DebateLead = {
  mode: 'hybrid',
  agentId: null,
  label: '未记录',
  reason: '这场辩论创建于主导模式上线之前，当时的主导方式没有落盘',
  drivenBy: 'orchestrator'
};

export const LEGACY_PLAN: LeadPlan = {
  lead: LEGACY_LEAD,
  openingSpeakers: [],
  debaters: [],
  participants: [],
  webOnly: [],
  reason: '这场辩论创建于主导模式上线之前，没有保存选人说明',
  warnings: [],
  excluded: []
};

export function normalizeDebateConfig(input: Partial<DebateConfig> | undefined): DebateConfig {
  const strategies: DebateStrategy[] = ['standard', 'deep', 'adversarial'];
  const strategy = input?.strategy && strategies.includes(input.strategy) ? input.strategy : 'standard';
  const participants = Array.isArray(input?.participants)
    ? input.participants.filter((id): id is string => typeof id === 'string')
    : [];
  const modes: DebateLeadMode[] = ['local', 'web', 'hybrid'];
  const normalized: DebateConfig = {
    strategy,
    maxRounds: typeof input?.maxRounds === 'number' && input.maxRounds >= 1 && input.maxRounds <= 10
      ? Math.floor(input.maxRounds)
      : DEFAULT_ROUNDS[strategy],
    participants,
    convergenceStop: input?.convergenceStop !== false,
    leadMode: input?.leadMode && modes.includes(input.leadMode) ? input.leadMode : 'hybrid',
    leadAgentId: typeof input?.leadAgentId === 'string' ? input.leadAgentId : undefined
  };
  // seed 只在真的传了的时候才存在：老调用方拿到的对象形状不变，deepEqual 对得上。
  if (input?.seed && Array.isArray(input.seed.positions) && Array.isArray(input.seed.topics)) {
    normalized.seed = {
      positions: input.seed.positions.filter((text): text is string => typeof text === 'string'),
      topics: input.seed.topics.filter((text): text is string => typeof text === 'string')
    };
  }
  return normalized;
}
