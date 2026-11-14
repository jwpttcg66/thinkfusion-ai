/**
 * 辩论的数据结构（项目书 8.5）。
 *
 * 决策 2：辩论是独立子系统，不堆在 MasterAgent 或 Synthesis 里。
 * 决策 6/7：原始回答不可丢失、少数派观点完整保留，所以每条发言都存原文，
 * 修正另存一条 `revision` 并带 `targetMessageId`，绝不覆盖前一条。
 */

import type { ClaimKind, ClaimSpan, EvidenceKind } from '../../shared/fusion';
import type { PageCitation } from '../../shared/evidence';
import type { EvidenceDraft } from '../synthesis/claim-extractor';
import type { DebateLead, DebateLeadMode, LeadPlan } from './lead';
import { isStrategy, STRATEGY_PROFILES } from './strategies';
import type { DebateMetrics } from './metrics';

/**
 * 协作策略（任务书 4.2 的六种 + 两个旧名字）。
 *
 * 六种是可选值，`standard` / `deep` 只用于读回 0.1.0 的辩论文件。各策略做什么
 * 见 `strategies.ts`——那里是行为，这里是取值。
 */
export type DebateStrategy =
  | 'truth'
  | 'adversarial'
  | 'expert'
  | 'assumption'
  | 'solution'
  | 'discovery'
  | 'standard'
  | 'deep';
export type DebateStatus = 'running' | 'completed' | 'stopped' | 'cancelled';

/**
 * 这一场是谁发起的。
 *
 * - `manual`：用户在「研究设置 → 辩论」里直接发起，属于用户自己的一笔记录；
 * - `conversation`：会话里主导人发现分歧后自动发起，是那条会话的证据；
 * - `plan-review`：工程计划审批前由系统发起，是那份计划的评审材料。
 *
 * 「历史辩论」只列 `manual`：另外两类已经在各自会话 / 计划里显示过，再混进
 * 用户自己的辩论清单，会让人以为那些题是自己问的。
 */
export type DebateOrigin = 'manual' | 'conversation' | 'plan-review';

/** 计划评审问题的固定开头，用于识别来源标记上线之前写的旧记录。 */
const PLAN_REVIEW_QUESTION_PREFIX = '【待评审的工程计划】';

/**
 * 读一场辩论的来源。老文件没有 `origin`，按「有没有挂会话 / 是不是计划评审」
 * 回推；回推只发生在读取时，不写盘，不把推断值伪装成当时记录过的值。
 */
export function debateOriginOf(
  state: Pick<DebateState, 'origin' | 'conversationId' | 'question'>
): DebateOrigin {
  if (state.origin) return state.origin;
  if (state.question.startsWith(PLAN_REVIEW_QUESTION_PREFIX)) return 'plan-review';
  if (state.conversationId) return 'conversation';
  return 'manual';
}
/**
 * 角色（任务书 5.1 的 `ParticipantRole` 去掉 `judge`——裁判是规则，不是某位成员）。
 * `critic` 对应任务书的 `challenger`，沿用旧名是为了老文件读得回来。
 */
export type DebateRole = 'proposer' | 'critic' | 'peer' | 'domain_expert' | 'evidence_reviewer';
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
 * 五类都能由规则判出来：极性/数字相反是 `factual` / `evidence_conflict`，
 * 一边带条件一边是绝对表述是 `scope`，有转向词的反驳是 `logical`，
 * 同一个术语被定义成两件事是 `definitional`。
 *
 * `definitional` 判据要窄：只认「X 是指 Y」这类显式定义，普通判断句不算——
 * 否则「连接池是一种缓存」和「连接池不是缓存」会被当成定义差异，而它们
 * 本来就是事实冲突。
 */
export type DisputeType = 'factual' | 'logical' | 'scope' | 'evidence_conflict' | 'definitional';

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
  /**
   * 这句话在原话里提到的出处/数字（Phase 3 / AC-09 的证据草稿）。
   * 只是「作者提到了它」，不是我们核对过的来源，`verified` 会如实标成
   * `reported` 或 `unverified`。
   */
  evidenceDrafts?: EvidenceDraft[];
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
  /**
   * 连续两轮没有新增证据、没有实质修订、也没有新争议时停止（Phase 5 的成本
   * 优化）。默认关闭：它会改变「打满 N 轮」的预期，得由调用方明确选择。
   */
  earlyStopOnStall?: boolean;
  /** 谁主导：本地 / 网页 / 混合。老数据没有这个字段，按 hybrid 读。 */
  leadMode?: DebateLeadMode;
  /** 用户指定的主辩。没有指定就由 planLead 按模式挑，并把结果写进 lead。 */
  leadAgentId?: string;
  /**
   * 会话执行阶段发起辩论时的「基准材料」：网页通道已经给出的回答，以及
   * 主导人指定的辩题。第一轮辩手读到的就是这些，不是从零开始重复回答。
   * 独立辩论面板不传这个字段，行为不变。
   *
   * `entries` 是同一批回答的结构化形式。网页主导时页面互不可见、也不接
   * context，编排器会把它们直接当作第一轮的发言落盘，避免把同一句用户
   * 原话再问一遍刚答过的页面（既慢又会让辩论基于第二份答案）。
   */
  seed?: { positions: string[]; topics: string[]; entries?: DebateSeedEntry[] };
  /**
   * 预算（任务书 10）。只在调用方真的传了的时候才存在，老调用方拿到的对象
   * 形状不变。不传时：单次调用 60 秒超时、整场不设时间上限、同时问 3 位。
   */
  budget?: DebateBudget;
}

/** 一条已经拿到的网页回答，作为会话内辩论第一轮的基准观点。 */
export interface DebateSeedEntry {
  agentId: string;
  label: string;
  text: string;
}

export interface DebateMessage {
  messageId: string;
  roundIndex: number;
  agentId: string;
  role: DebateRole;
  kind: DebateMessageKind;
  /** 模型原文，不被摘要、不被覆盖。 */
  text: string;
  /** 这条发言的推理内容；本地/云端模型有，网页没有。 */
  reasoning?: string;
  /** 质疑/反驳/修正针对哪一条发言。 */
  targetMessageId?: string;
  /**
   * 网页成员发言时页面留下的会话地址。只有网页通道有；本地/云端为空。
   * 辩论是独立子系统，不会往 Conversation 里登记，所以清理网页侧记录
   * 得靠这个地址，不能靠 deleteConversation。
   */
  threadUrl?: string;
  /**
   * 页面在回答里给出的引用链接（Phase 3 / AC-09）。
   *
   * 只有网页通道有；本地/云端模型的回答里没有 DOM，也就没有可抓的链接。
   * 抓不到就是 `undefined`，不补空数组：老辩论文件读出来也该是「没记录过」。
   */
  citations?: PageCitation[];
  /** 实际 Provider / 模型；老记录没有。 */
  providerId?: string;
  modelId?: string;
  /** 实际 token 用量；网页/老记录没有。 */
  usage?: { inputTokens: number | null; outputTokens: number | null; cost?: { amount: number; currency: string } | null };
  retryCount?: number;
  outcome?: 'success' | 'failed' | 'cancelled';
  failureReason?: string;
  createdAt: number;
  /** 这一条发言从开始问模型到拿到回答的时间；老记录没有。 */
  startedAt?: number;
  endedAt?: number;
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

/**
 * 证据的可核验程度（Phase 3 / AC-09）。
 *
 * - `page-link`：页面把链接画出来了，我们读到了真实地址。仍然不等于内容为真，
 *   只等于「这条来源确实存在，可以点开复核」。
 * - `reported`：主张自己说「官方文档 / 源码 / 实测」，但页面没给链接。这是作者
 *   的说法，不是我们核对过的来源。
 * - `unverified`：连说法都没有，只有一句断言或一个数字。
 */
export type EvidenceVerification = 'page-link' | 'reported' | 'unverified';

/**
 * 一条证据（任务书 5 的 `DebateEvidence` + 7.3 要求的来源元数据）。
 *
 * 与综合层 `shared/fusion.ts` 的 `Evidence` 是两份东西：那份给界面排序用，
 * 这份要能回答「这条结论凭什么」，所以必须带地址、时间、指纹、同源标识和
 * 评价理由。字段缺一个，回溯时就少一环。
 */
export interface DebateEvidence {
  evidenceId: string;
  /** 支持或反驳哪些主张。空数组 = 页面给了这条来源，但没法归到某一句上。 */
  claimIds: string[];
  kind: EvidenceKind;
  /** 原文里的那一小段，不是整句。 */
  excerpt: string;
  /** 原文定位：哪条消息、第几字到第几字。 */
  span: ClaimSpan;
  /** 哪个通道/来源给的。 */
  sourceId: string;
  messageId: string;
  roundIndex: number;
  /** 页面给的原始地址。 */
  url?: string;
  /** 展开已知跳转包装后的地址；没有包装就没有这个字段。 */
  finalUrl?: string;
  /** 抓取时页面标题。 */
  pageTitle?: string;
  /** 读到这条来源的时间（不是发布的时间）。 */
  fetchedAt?: number;
  /** 内容指纹：去空白与标点后的 FNV-1a。用于识别「同一段文字」。 */
  fingerprint: string;
  /** 同源标识：同一份原始材料的所有记录共用它（见 `sameOrigin`）。 */
  originKey: string | null;
  /** 同一份材料的第一条记录；非空表示这条是转载/重复。 */
  duplicateOf?: string;
  /** 同一份材料只算一次独立来源：第一条为 true，其后为 false。 */
  independent: boolean;
  verified: EvidenceVerification;
  /** 评价理由，必须能读成人话。 */
  assessment: string;
  /**
   * 这条链接是「页面气泡里唯一的一句主张 + 唯一一个引用」认领来的。
   * 此时关联由页面给出，不是靠锚文字与主张字面重合猜的，所以证据相关性
   * 检查不再用字面重合二次否决它。老文件没有这个字段，按 false 处理。
   */
  soleAttribution?: boolean;
}

/** 论证图的节点类型（Phase 3 / AC-08）。 */
export type ArgumentNodeType = 'claim' | 'evidence' | 'challenge' | 'judgment';

/**
 * 论证边。任务书列了六种，这里一个不多一个不少。
 *
 * 刻意没有 `unrelated` / `refines`：前者是零信息，后者和 `qualifies` 的边界
 * 永远说不清。判不出关系就不连边。
 */
export type ArgumentRelation =
  | 'supports'
  | 'rebuts'
  | 'qualifies'
  | 'depends_on'
  | 'contradicts'
  | 'derived_from';

export interface ArgumentNode {
  nodeId: string;
  type: ArgumentNodeType;
  /** 指回原对象：claimId / evidenceId / disputeId / judgmentId。 */
  ref: string;
  roundIndex: number;
  agentId?: string;
  /** 节点上的原话。judgment 存的是判断理由的第一句。 */
  text: string;
  /** claim 才有。 */
  kind?: ClaimKind;
  /** claim 才有；裁判判完会更新。 */
  status?: ClaimStatus;
  /** evidence 才有。 */
  url?: string;
  /** judgment 才有。 */
  verdict?: Verdict;
  /** judgment 才有。 */
  dimension?: JudgeDimension;
  createdAt: number;
}

/**
 * 一条论证边。
 *
 * `roundIndex` + `source` 是硬要求（用户明确说过「不要只保存最终图，否则
 * 还原不出这条关系是怎么形成的」）：一条边必须能回答「第几轮、由哪条发言/
 * 哪条争议/哪次修订产生」。
 */
export interface ArgumentEdge {
  edgeId: string;
  fromId: string;
  toId: string;
  relation: ArgumentRelation;
  roundIndex: number;
  /** 凭什么连这条边（规则原话）。 */
  rationale: string;
  source: {
    messageIds: string[];
    claimIds: string[];
    disputeId?: string;
    revisionId?: string;
    evidenceId?: string;
  };
  createdAt: number;
}

export interface ArgumentGraph {
  version: 1;
  nodes: ArgumentNode[];
  edges: ArgumentEdge[];
  /** 达到节点上限时被丢掉的节点数。有值就说明这不是全部，别当成完整图。 */
  truncated?: number;
}

/**
 * 三维裁判（Phase 3 / AC-11）。
 *
 * 三个维度各自给结论，**不压成一个分数**：逻辑对而证据不足，和证据强而逻辑
 * 跳步，是两种完全不同的判断，压成平均分之后这两种就再也分不开了。
 */
export type JudgeDimension = 'logic' | 'evidence' | 'counterexample';

export type LogicOutcome = 'valid' | 'questionable' | 'invalid' | 'not_applicable';
export type EvidenceOutcome = 'sufficient' | 'partial' | 'unverifiable' | 'absent' | 'conflicting';
export type CounterexampleOutcome = 'none' | 'limited' | 'refuted';

export interface DimensionJudgment {
  dimension: JudgeDimension;
  /** 这一维自己的结论。不进任何平均值。 */
  outcome: LogicOutcome | EvidenceOutcome | CounterexampleOutcome;
  rationale: string;
  /** 判成这个结论的依据（信号、原话、来源）。 */
  signals: string[];
  evidenceIds: string[];
  sourceRefs?: {
    claimIds?: string[];
    messageIds?: string[];
    disputeIds?: string[];
  };
}

/** 五档结论（任务书 5.1）。`insufficient_evidence` 不等于 `unsupported`。 */
export type Verdict =
  | 'supported'
  | 'partially_supported'
  | 'unsupported'
  | 'contradicted'
  | 'insufficient_evidence';

export interface ClaimJudgment {
  judgmentId: string;
  claimId: string;
  agentId: string;
  claimText: string;
  /** 固定三项，顺序为 逻辑 / 证据 / 反例。 */
  dimensions: DimensionJudgment[];
  verdict: Verdict;
  /** 哪几维决定了这个结论；读的人据此知道分歧在哪一维。 */
  decidedBy: JudgeDimension[];
  rationale: string;
  evidenceIds: string[];
  /** 这条结论与多数发言不同，但证据支持它（TF-D-011 的情形）。 */
  minority: boolean;
  createdAt: number;
}

/** 整场结论。 */
export interface DebateVerdict {
  verdictId: string;
  debateId: string;
  createdAt: number;
  verdict: Verdict;
  /** 被支持的主张原文；无法判定时为 null，不挑一句看起来顺眼的顶上。 */
  conclusion: string | null;
  conclusionClaimId?: string;
  claimJudgments: ClaimJudgment[];
  /** 整场三维的独立结论，供界面直接显示。 */
  dimensions: DimensionJudgment[];
  rationale: string;
  minorityWins: boolean;
  minorityReason?: string;
  /** 仍然悬着的问题：缺证据、来源冲突、裁判判不了。 */
  unresolved: string[];
  /** 这一版是本地规则，不是模型裁决（模型裁决见 `judge/engine.ts`）。 */
  backend: 'rules';
  /** 明确写死一句，防止以后有人把 `claimJudgments` 当票箱。 */
  note: string;
}

export interface DebateRound {
  /** 本轮还在等哪些成员发言；没有就是都回来了。 */
  pending?: string[];
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

/**
 * 辩论事件（任务书 9 的 `debate_events` / AC-14）。
 *
 * 状态快照回答「现在是什么样」，事件流回答「怎么走到这一步的」。两者都要，
 * 因为快照只能恢复到最后一次写盘，而事件能说明最后那一轮为什么没跑完。
 *
 * `key` 是幂等键：同一件事只写一次。恢复后重跑同一轮不会再多出一条
 * `round.started`，取消后重试也不会把 `session.cancelled` 写成两条。
 */
export type DebateEventType =
  | 'session.created'
  | 'round.started'
  | 'round.finished'
  | 'revision.recorded'
  | 'verdict.recorded'
  | 'session.stopped'
  | 'session.resumed'
  | 'session.completed'
  | 'session.cancelled';

export interface DebateEvent {
  /** 从 1 开始，单调递增；同一场辩论里唯一。 */
  seq: number;
  eventId: string;
  type: DebateEventType;
  at: number;
  roundIndex?: number;
  /** 幂等键。同一个键第二次写入会被丢掉。 */
  key: string;
  detail?: string;
}

export interface DebateState {
  debateId: string;
  /** 关联的 Conversation；可以没有（独立发起的辩论）。 */
  conversationId?: string;
  /**
   * 谁发起的。老文件没有这个字段，读的时候用 debateOriginOf 回推，
   * 不让「没记录」被当成「用户直接发起」。
   */
  origin?: DebateOrigin;
  question: string;
  config: DebateConfig;
  /** 这一场谁主导、为什么这么选，落盘供历史查询和界面显示。 */
  lead: DebateLead;
  /** planLead 的完整结果：界面照实显示，编排器也用它决定每轮谁发言。 */
  plan: LeadPlan;
  status: DebateStatus;
  /** 辩论执行结果，和 status（生命周期）分开。 */
  outcome?: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
  rounds: DebateRound[];
  /** 正在跑、还没收口的那一轮；界面据此显示「等待谁发言」，不等到轮末才见。 */
  runningRound?: DebateRound;
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
  /**
   * 采集到的证据（Phase 3 / AC-09）。每轮重算一次全量：证据是从原话和页面
   * 链接里读出来的，重算比增量合并更不容易漏；条数很小，代价可以忽略。
   * 老文件没有这个字段，读出来是 undefined。
   */
  evidence?: DebateEvidence[];
  /**
   * 论证图（Phase 3 / AC-08）。每轮追加，边带轮次与来源对象。
   * 老文件没有这个字段。
   */
  graph?: ArgumentGraph;
  /** 每一条主张的三维判断。老文件没有这个字段。 */
  judgments?: ClaimJudgment[];
  /** 整场结论（五档）。裁判没跑或没有可判主张时为 undefined。 */
  verdict?: DebateVerdict;
  /**
   * 质量指标（Phase 5）。收尾时算一次写进来：可追溯率、无效轮次占比、
   * 少数派是否完整保留、耗时与调用次数。老文件没有这个字段。
   */
  metrics?: DebateMetrics;
  /**
   * 追加事件流（AC-14）。只追加，不改写；`seq` 单调，`key` 幂等。
   * 老文件没有这个字段，读出来是 undefined——不补空数组冒充「记录过」。
   */
  events?: DebateEvent[];
  /**
   * 这一场用的 Prompt 模板版本（任务书 §12）。开场时写死，之后升级模板不回写：
   * 历史会话要能看出「它是用哪一版指令跑的」。老文件没有这个字段，读出来是
   * undefined，不补一个当前版本冒充记录过。
   */
  promptVersion?: string;
  createdAt: number;
  updatedAt: number;
  stopReason?: string;
}

export const DEFAULT_ROUNDS: Record<DebateStrategy, number> = {
  truth: STRATEGY_PROFILES.truth.rounds,
  adversarial: STRATEGY_PROFILES.adversarial.rounds,
  expert: STRATEGY_PROFILES.expert.rounds,
  assumption: STRATEGY_PROFILES.assumption.rounds,
  solution: STRATEGY_PROFILES.solution.rounds,
  discovery: STRATEGY_PROFILES.discovery.rounds,
  standard: STRATEGY_PROFILES.standard.rounds,
  deep: STRATEGY_PROFILES.deep.rounds
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
  const strategy = isStrategy(input?.strategy) ? input.strategy : 'truth';
  const participants = Array.isArray(input?.participants)
    ? input.participants.filter((id): id is string => typeof id === 'string')
    : [];
  const modes: DebateLeadMode[] = ['local', 'web', 'cloud', 'hybrid'];
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
    const entries = Array.isArray(input.seed.entries)
      ? input.seed.entries
          .filter(entry => entry && typeof entry.agentId === 'string' && typeof entry.text === 'string' && entry.text.trim().length > 0)
          .map(entry => ({
            agentId: entry.agentId,
            label: typeof entry.label === 'string' ? entry.label : entry.agentId,
            text: entry.text
          }))
      : [];
    if (entries.length > 0) normalized.seed.entries = entries;
  }
  // 预算同理：不传就没有这个字段，默认值在使用处兜（见 orchestrator 的 budgetOf）。
  if (input?.earlyStopOnStall === true) normalized.earlyStopOnStall = true;
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
