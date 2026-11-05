/**
 * 辩论的数据结构（项目书 8.5）。
 *
 * 决策 2：辩论是独立子系统，不堆在 MasterAgent 或 Synthesis 里。
 * 决策 6/7：原始回答不可丢失、少数派观点完整保留，所以每条发言都存原文，
 * 修正另存一条 `revision` 并带 `targetMessageId`，绝不覆盖前一条。
 */

import type { ClaimKind, ClaimSpan } from '../../shared/fusion';
import type { DebateLead, DebateLeadMode, LeadPlan } from './lead';

export type DebateStrategy = 'standard' | 'deep' | 'adversarial';
export type DebateStatus = 'running' | 'completed' | 'stopped' | 'cancelled';
export type DebateRole = 'proposer' | 'critic' | 'peer';
export type DebateMessageKind = 'position' | 'question' | 'rebuttal' | 'revision';

/**
 * 一条主张走到了哪一步（任务书 5.1 的 ClaimStatus）。
 *
 * Phase 1 只到 `challenged`（抽出来是 `proposed`，卷进争议是 `challenged`）。
 * Phase 2 接上回应之后：撤回的记 `withdrawn`，接受/修正的记 `revised`，
 * 判不了的记 `unresolved`，坚持的那条留在 `challenged`——它仍然是有争议的。
 * `supported` 要等裁判（Phase 3），没人判过就不给自己盖章。
 */
export type ClaimStatus = 'proposed' | 'supported' | 'challenged' | 'revised' | 'withdrawn' | 'unresolved';

/**
 * 争议的类型。
 *
 * 只有规则判得出来的四种。任务书 5.1 还列了 `definitional`（同一个词各指
 * 不同的东西），本地规则没有判据——宁可少一个值，也不把「定义不同」塞进
 * `factual` 里冒充。
 */
export type DisputeType = 'factual' | 'logical' | 'scope' | 'evidence_conflict';

/** 从发言里抽出的一句可单独判断真假的话。 */
export interface DebateClaim {
  claimId: string;
  messageId: string;
  /** 谁说的。跨参与者才算得出争议，靠的就是这一列。 */
  agentId: string;
  roundIndex: number;
  text: string;
  kind: ClaimKind;
  /** 判成这个类型的原词，保留下来供人复核。 */
  kindCue: string;
  /** 这句话在原发言里的起止，能跳回原话。 */
  span: ClaimSpan;
  /** 句子自带的前提/范围。它们是 `scope` 争议的依据，不是形容词。 */
  assumptions: string[];
  status: ClaimStatus;
}

/** 两个参与者的两句话对不上。 */
export interface DebateDispute {
  disputeId: string;
  roundIndex: number;
  /** 固定的两句，方向不重要；`reason` 说明怎么判的。 */
  claimIds: [string, string];
  agents: [string, string];
  type: DisputeType;
  /** 0–1，只决定先处理哪一条，不是「谁更可能正确」。 */
  priority: number;
  /** 凭什么判成争议（规则原话）。 */
  reason: string;
  status: 'open';
}

/**
 * 预算与会话级资源上限（任务书第 10 节）。
 *
 * 只做这个仓库拿得到的两个维度：**时间**与**并发**。任务书还要求 Token 与
 * 费用预算，但本地 Ollama 和网页通道都拿不到用量——与其编一个数字，不如
 * 在类型里就不留这个字段。
 */
export interface DebateBudget {
  /** 单次模型调用的超时。超时算这一位失败，不拖住整轮。 */
  stageTimeoutMs?: number;
  /** 整场的时间上限。到点就停，已说完的话保留。 */
  totalMs?: number;
  /** 同时向几位模型发问。默认 3，与任务书建议一致。 */
  maxConcurrency?: number;
}

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
  /**
   * 预算（任务书 10）。只在调用方真的传了的时候才存在，老调用方拿到的对象
   * 形状不变。不传时：单次调用 60 秒超时、整场不设时间上限、同时问 3 位。
   */
  budget?: DebateBudget;
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

/** 一轮在做哪一步（任务书 5 的 `DebateRound.phase`）。 */
export type DebatePhase = 'analysis' | 'challenge' | 'response';

/**
 * 参与者对质疑作出的决定（任务书 5.1 的 RevisionDecision）。
 *
 * 五个值都能走到，`null` 是第六种情况：模型既没写决策行，规则也判不出来。
 * 这时候如实记 `null`，不替它挑一个。
 */
export type RevisionDecision = 'accept' | 'defend' | 'revise' | 'withdraw' | 'inconclusive';

/** 一次修订：谁、对哪些主张、改成了什么。 */
export interface DebateRevision {
  revisionId: string;
  messageId: string;
  agentId: string;
  roundIndex: number;
  decision: RevisionDecision | null;
  /** 决策从哪来：模型自己写的行 / 规则按措辞与相似度推的 / 没判出来。 */
  source: 'stated' | 'inferred' | 'unknown';
  /** 模型给出的理由（决策行后面的那句，或它原文的第一句）。 */
  reason: string;
  /** 上一轮同一位的发言原文——修订前后的对照，不覆盖原话。 */
  before: string;
  after: string;
  /** 这位被质疑的是哪几句。 */
  targetClaimIds: string[];
  createdAt: number;
}

export interface DebateRound {
  index: number;
  /** 这一轮是独立表态、质疑，还是回应质疑。老文件没有这个字段。 */
  phase?: DebatePhase;
  messages: DebateMessage[];
  startedAt: number;
  endedAt?: number;
  converged: boolean;
  /** 这一轮没能完成的成员及原因，不静默丢掉。 */
  failures: Array<{ agentId: string; detail: string }>;
  /**
   * 这一轮每条发言切出来的主张。老辩论文件没有这个字段，读出来是 undefined，
   * 不迁移——它们没有记录过结构，补一个空数组等于伪造「分析过但没抽到」。
   */
  claims?: DebateClaim[];
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
  /**
   * 整场下来发现的分歧，按轮次累加。每一轮只跟同一轮的其他参与者比：
   * 跨轮比较会把「第一轮的前提」和「第三轮的修订」判成冲突，那是同一个人在
   * 改口，不是两个人对不上。
   */
  disputes?: DebateDispute[];
  /**
   * 回应阶段每次决定的记录（任务书 9 的 `debate_revisions`）。
   * 原话不被覆盖：`before` / `after` 都是原文，这里只补「改没改、为什么」。
   */
  revisions?: DebateRevision[];
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
  // 预算同理：不传就没有这个字段，默认值在使用处兜（见 orchestrator 的 budgetOf）。
  if (input?.budget) {
    const budget: DebateBudget = {};
    if (typeof input.budget.stageTimeoutMs === 'number' && input.budget.stageTimeoutMs > 0) {
      budget.stageTimeoutMs = Math.floor(input.budget.stageTimeoutMs);
    }
    if (typeof input.budget.totalMs === 'number' && input.budget.totalMs > 0) {
      budget.totalMs = Math.floor(input.budget.totalMs);
    }
    if (typeof input.budget.maxConcurrency === 'number' && input.budget.maxConcurrency > 0) {
      budget.maxConcurrency = Math.max(1, Math.floor(input.budget.maxConcurrency));
    }
    if (Object.keys(budget).length > 0) normalized.budget = budget;
  }
  return normalized;
}
