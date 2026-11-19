/** P2 知识卡与主题的契约；与 KNOWLEDGE_SPACE 对齐。 */
export type CardStatus = 'active' | 'superseded' | 'refuted';
export type FreshnessState = 'fresh' | 'stale' | 'refuted';

export interface Freshness {
  asOf: number;
  version?: string;
  commit?: string;
  sourceAt?: number;
  state: FreshnessState;
  reasons: string[];
}

export interface KnowledgeCard {
  cardId: string;
  topicId: string;
  /** 一条可独立复述的结论。 */
  statement: string;
  /** 引用 P1-002 的 Claim，不复制正文。 */
  claimIds: string[];
  /** 引用 EvidenceRef，不复制正文。 */
  evidenceRefs: string[];
  conditions: string[];
  freshness: Freshness;
  status: CardStatus;
  supersedes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Topic {
  topicId: string;
  title: string;
  aliases: string[];
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeFile {
  version: 1;
  topics: Topic[];
  cards: KnowledgeCard[];
}
