import type { DebateMessage, Verdict } from '../debate/types';
import type { DebateQualityReport, FinalDebateDecision } from '../debate/quality-engine';

/**
 * 裁决结果（项目书 8.7 / Phase H）。
 *
 * 两条红线做成结构而不是注释：
 *
 * - `supportCount` 只是**描述**「多少人这么说」，永远不会自动变成
 *   `conclusion`。多数票不当真理（11.8）。
 * - `undetermined` 是一个正当结果。分歧无解时写 `conclusion: null`，
 *   不挑一个看起来最顺眼的说法当结论。
 */
export interface EvidenceAssessment {
  messageId: string;
  agentId: string;
  /** 0–1，只衡量这份**文本**里有没有可核查的线索，不判世界真伪。 */
  score: number;
  why: string;
  signals: string[];
}

export interface ArgumentQuality {
  agentId: string;
  score: number;
  why: string;
  /** 是否在后续轮次回应过质疑。 */
  responded: boolean;
}

export interface MinorityView {
  messageId: string;
  agentId: string;
  text: string;
  why: string;
}

export interface UnresolvedQuestion {
  question: string;
  why: string;
  sourceMessageIds: string[];
}

export type JudgeMode = 'self-review' | 'participant-review' | 'independent-judge' | 'rules-fallback';

/** 换裁判时失败的那一次。成功的那次由 `judgeAgentId` 本身说明，不重复记。 */
export interface JudgeReselectionAttempt {
  agentId: string;
  judgeModelId?: string;
  /** 这一次被选中时的身份；换人后要按新的人重算，不能沿用旧值。 */
  judgeMode: JudgeMode;
  reason: string;
}

/**
 * Gate 0A：首选裁判失败后换人的记录。
 *
 * 只有「模型确实被调过、且没给出可用结论」时才存在。`exhausted` 为 true
 * 表示候选全部试过、最终退回规则版——这与「本来就没有模型裁判」是两件事：
 * 前者是试过都不行，后者是没得试。两者在界面上不能被读成同一种状态。
 */
export interface JudgeReselection {
  attempts: JudgeReselectionAttempt[];
  /** 已经失败、不再参与重选的人。 */
  excludedAgentIds: string[];
  exhausted: boolean;
  finalJudgeAgentId: string | null;
}

/**
 * 规则版结论的权威口径（Gate 0B 契约）。
 *
 * 仓库里有两套规则：`debate/judges.ts` 的逐条三维判定，和裁判引擎里的文本
 * 线索打分。**前者是权威**——它能一条条指着原文复核，质量门槛
 * `verdict.recomputable` 也是按它建的；后者只负责在模型不可用时把话说完整。
 *
 * 两者结论不一致时记录在案，不静默吞掉。权威侧没给结论时 `agrees` 是 null
 * （不可比），不是「一致」。
 */
export interface RulesConclusionNote {
  authority: 'debate.claim-judgments';
  debateVerdict: Verdict;
  agrees: boolean | null;
}

export interface JudgeIndependence {
  judgeMode: JudgeMode;
  judgeIndependent: boolean;
  modelIndependence: boolean;
  judgeProviderId?: string;
  judgeModelId?: string;
  reason: string;
}

export interface JudgeConfidence {
  level: 'low' | 'medium' | 'high';
  why: string;
}

/**
 * 裁判对题目类型的判断。它约束裁判该怎么回答：
 * FACT 必须给明确结论；CONTEXTUAL 要给条件/边界/推荐；INSUFFICIENT 才说信息不足。
 * CONTEXTUAL 不等于 INSUFFICIENT。
 */
export type JudgeQuestionType = 'FACT' | 'CONTEXTUAL' | 'INSUFFICIENT';

export interface JudgeVerdict {
  verdictId: string;
  debateId: string;
  createdAt: number;
  /** null 表示没有独立裁判，用的是规则版；或兼任时由 sharedWith 说明。 */
  judgeAgentId: string | null;
  /** 实际向裁判模型问了几次；解析失败会重试一次。老记录没有。 */
  judgeAttempts?: number;
  /** 决策 5：资源不足允许兼任，但必须明确标记这一事实。 */
  sharedWith?: string;
  /** 独立性由实际参与者/模型身份派生；老记录没有。 */
  judgeMode?: JudgeMode;
  judgeIndependent?: boolean;
  modelIndependence?: boolean;
  judgeProviderId?: string;
  judgeModelId?: string;
  independenceReason?: string;
  backend: 'model' | 'rules';
  conclusion: string | null;
  undetermined: boolean;
  /** 为什么是这个结论，或为什么无法确定。 */
  reason: string;
  /** 分歧在哪里，两边各自成立的条件。 */
  disagreement: string;
  evidence: EvidenceAssessment[];
  argumentQuality: ArgumentQuality[];
  minorities: MinorityView[];
  unresolved: UnresolvedQuestion[];
  confidence: JudgeConfidence;
  /** 关联回辩论里的原始发言，一条都能查到。 */
  sourceMessageIds: string[];
  /** 仅描述，不作为正确性依据。 */
  supportCount: Record<string, number>;
  /** 模型裁决解析失败时会退回规则版，原因写在这里，不假装是模型给的。 */
  fallbackReason?: string;
  /** 0A：换过裁判才有；没换过不写空对象，免得被读成「换过但记不清」。 */
  judgeReselection?: JudgeReselection;
  /** 0B：规则版结论的权威口径，只有 `backend === 'rules'` 时存在。 */
  rulesConclusion?: RulesConclusionNote;
  /**
   * P1 自动质量报告。作为裁决的伴随对象，不改写 `conclusion` 或 `confidence`；
   * 老记录没有这个字段。`factualAccuracy` 不会因为模型评审而变成事实正确。
   */
  quality?: DebateQualityReport;
  /** P2 Final Judge 决策；映射到现有五档结论，不新增第三套结论状态。 */
  finalDecision?: FinalDebateDecision;
}

export function messagesOfVerdict(state: {
  rounds: Array<{ messages: DebateMessage[] }>;
}): DebateMessage[] {
  return state.rounds.flatMap(round => round.messages);
}
