import type { DebateMessage } from '../debate/types';

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

export interface JudgeConfidence {
  level: 'low' | 'medium' | 'high';
  why: string;
}

export interface JudgeVerdict {
  verdictId: string;
  debateId: string;
  createdAt: number;
  /** null 表示没有独立裁判，用的是规则版；或兼任时由 sharedWith 说明。 */
  judgeAgentId: string | null;
  /** 决策 5：资源不足允许兼任，但必须明确标记这一事实。 */
  sharedWith?: string;
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
}

export function messagesOfVerdict(state: {
  rounds: Array<{ messages: DebateMessage[] }>;
}): DebateMessage[] {
  return state.rounds.flatMap(round => round.messages);
}
