/**
 * 协作结果统一投影（V3 主活动区 U1）。
 *
 * 这是**展示派生视图**，不是权威状态库：
 * - Engineering：从 AgentEvent + TaskView / TaskConversation 投影重建；
 * - General / Knowledge：从 Conversation.Synthesis / DebateSnapshot 投影重建。
 *
 * 刷新、恢复、重放必须能从权威事件/会话对象重新得到同一份结构。
 * Renderer 只读这里，不得在本地 state 再造一份「评审决定」或「裁决」。
 */

import type { AgentEvent, PlanDebate } from './contracts';
import type {
  Claim,
  Conversation,
  ConversationMessage,
  DebateSnapshot,
  Dispute,
  Synthesis
} from './conversation';
import { buildConclusion, buildTaskConversation } from './task-conversation';
import { projectTaskView } from './task-view';

export type CollaborationScene = 'general' | 'knowledge' | 'engineering';

export type OpinionPosition = 'support' | 'oppose' | 'supplement' | 'revise' | 'neutral';

export type DisputeStatus =
  | 'identified'
  | 'pending_exchange'
  | 'exchanging'
  | 'verdict'
  | 'partially_resolved'
  | 'undetermined'
  | 'retained';

export type ReviewDisposition = 'accepted' | 'rejected' | 'deferred' | 'pending';

/**
 * 统一来源引用。字段尽量对齐现有事件/消息，不要求一次填满。
 * renderer 不得仅凭文案猜测来源。
 */
export interface SourceReference {
  /** 任务或会话身份。 */
  subjectId: string;
  runId?: string;
  kind: 'event' | 'message' | 'debate' | 'report' | 'review' | 'verification' | 'claim' | 'other';
  eventType?: string;
  eventAt?: number;
  messageId?: string;
  participantId?: string;
  /** 人类可读的定位说明（不是证据本身）。 */
  label?: string;
}

export interface ConclusionView {
  text: string;
  facts: string[];
  uncertainties: string[];
  openItems: string[];
  tone: 'info' | 'ok' | 'warn' | 'error' | 'muted';
  sourceRefs: SourceReference[];
}

export interface OpinionView {
  opinionId: string;
  author: string;
  position: OpinionPosition;
  statement: string;
  rationale?: string;
  evidenceRefs: SourceReference[];
  targetRefs: string[];
  sourceRefs: SourceReference[];
}

export interface DisputeClaimView {
  claimId: string;
  author: string;
  statement: string;
  sourceRefs: SourceReference[];
}

export interface DisputeExchangeView {
  exchangeId: string;
  kind: 'challenge' | 'response' | 'revision' | 'note';
  author: string;
  text: string;
  sourceRefs: SourceReference[];
}

export interface DisputeView {
  disputeId: string;
  topic: string;
  disputeClass?: string;
  status: DisputeStatus;
  claims: DisputeClaimView[];
  exchanges: DisputeExchangeView[];
  evidenceRefs: SourceReference[];
  verdict?: string;
  unresolvedReason?: string;
  sourceRefs: SourceReference[];
}

export interface ReviewIssueView {
  issueId: string;
  title: string;
  description: string;
  severity?: 'high' | 'medium' | 'low' | 'unknown';
  rationale?: string;
  recommendation?: string;
  disposition: ReviewDisposition;
  dispositionReason?: string;
  evidenceRefs: SourceReference[];
  resolutionRefs: SourceReference[];
  verificationRefs: SourceReference[];
  sourceRefs: SourceReference[];
}

export interface ReviewView {
  reviewId: string;
  index: number;
  reviewer: string;
  backend: 'model' | 'rules' | 'unknown';
  targetRef?: string;
  verdict: string;
  needsFix: boolean;
  issues: ReviewIssueView[];
  sourceRefs: SourceReference[];
}

export interface VerificationView {
  verificationId: string;
  index: number;
  verified: boolean;
  fullyVerified: boolean;
  statusLabel: string;
  reasons: string[];
  evidenceRefs: SourceReference[];
  sourceRefs: SourceReference[];
}

export interface ProgressView {
  phase?: string;
  summary: string;
  participantCount: number;
}

export interface DeliverableView {
  deliverableId: string;
  kind: 'file' | 'artifact' | 'summary' | 'other';
  label: string;
  path?: string;
  sourceRefs: SourceReference[];
}

export interface CollaborationResultView {
  taskId: string;
  scene: CollaborationScene;
  conclusion?: ConclusionView;
  keyOpinions: OpinionView[];
  disputes: DisputeView[];
  reviews: ReviewView[];
  verifications: VerificationView[];
  progress: ProgressView;
  deliverables: DeliverableView[];
  sourceRefs: SourceReference[];
  /**
   * 原始投影附件：保留 TaskView / 对话条目数量，便于测试核对，
   * 不作为 UI 主阅读路径。
   */
  meta: {
    projectedAt: number;
    eventCount?: number;
    conversationEntryCount?: number;
    hasDebateSnapshot?: boolean;
  };
}

function ref(partial: SourceReference): SourceReference {
  return partial;
}

function issueIdOf(reviewIndex: number, issueIndex: number, text: string): string {
  // 稳定：同一次评审、同一序号、同一原文 → 同一 id；不依赖随机数。
  const slug = text.trim().slice(0, 48).replace(/\s+/g, ' ');
  return `review:${String(reviewIndex)}:issue:${String(issueIndex)}:${slug}`;
}

function mapReviewIssues(
  subjectId: string,
  reviewIndex: number,
  issues: readonly string[],
  eventAt: number
): ReviewIssueView[] {
  return issues.map((text, issueIndex) => {
    const description = text.trim();
    const source = ref({
      subjectId,
      kind: 'review',
      eventType: 'review.ready',
      eventAt,
      label: `评审 #${String(reviewIndex)} 问题 ${String(issueIndex + 1)}`
    });
    return {
      issueId: issueIdOf(reviewIndex, issueIndex, description),
      title: description.slice(0, 80) || `问题 ${String(issueIndex + 1)}`,
      description,
      severity: 'unknown',
      disposition: 'pending',
      evidenceRefs: [],
      resolutionRefs: [],
      verificationRefs: [],
      sourceRefs: [source]
    };
  });
}

/**
 * Engineering：从权威事件重建结果视图。
 *
 * 复用 `projectTaskView` 与 `buildTaskConversation`，不另存状态。
 * 今日生产端 Review 只有 issues 字符串 —— 投影成完整 ReviewIssueView 形状，
 * disposition 一律 `pending`，避免 UI 把「有评审事件」当成「问题已处理」。
 */
export function projectEngineeringCollaborationResult(input: {
  taskId: string;
  events: readonly AgentEvent[];
  summary?: string;
  status?: string;
}): CollaborationResultView {
  const { taskId, events, summary, status } = input;
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const taskView = projectTaskView(ordered);
  const entries = buildTaskConversation(ordered, { summary, status });
  const conclusionRaw = buildConclusion(ordered, { summary, status });

  const reviews: ReviewView[] = [];
  let reviewIndex = 0;
  for (const event of ordered) {
    if (event.type !== 'review.ready') continue;
    reviewIndex += 1;
    const source = ref({
      subjectId: taskId,
      kind: 'review',
      eventType: 'review.ready',
      eventAt: event.at,
      participantId: event.reviewer,
      label: `第 ${String(reviewIndex)} 次独立评审`
    });
    const issues = event.issueDetails && event.issueDetails.length > 0
      ? event.issueDetails.map(detail => ({
          issueId: detail.issueId,
          title: detail.title,
          description: detail.description,
          severity: detail.severity,
          recommendation: detail.recommendation,
          disposition: detail.disposition,
          dispositionReason: detail.dispositionReason,
          evidenceRefs: [] as SourceReference[],
          resolutionRefs: [] as SourceReference[],
          verificationRefs: [] as SourceReference[],
          sourceRefs: [source]
        }))
      : mapReviewIssues(taskId, reviewIndex, event.issues, event.at);
    reviews.push({
      reviewId: `review:${taskId}:${String(reviewIndex)}:${String(event.at)}`,
      index: reviewIndex,
      reviewer: event.reviewer,
      backend: event.backend,
      verdict: event.verdict,
      needsFix: event.needsFix,
      issues,
      sourceRefs: [source]
    });
  }

  const verifications: VerificationView[] = entries
    .filter((entry): entry is Extract<typeof entry, { kind: 'verification' }> => entry.kind === 'verification')
    .map(entry => {
      const statusLabel = entry.fullyVerified
        ? '已验证'
        : entry.verified
          ? '部分通过'
          : '未验证 / 未通过';
      const source = ref({
        subjectId: taskId,
        kind: 'verification',
        eventType: 'report.ready',
        eventAt: entry.at,
        label: `第 ${String(entry.index)} 次验证`
      });
      return {
        verificationId: `verification:${taskId}:${String(entry.index)}:${String(entry.at)}`,
        index: entry.index,
        verified: entry.verified,
        fullyVerified: entry.fullyVerified,
        statusLabel,
        reasons: entry.reasons,
        evidenceRefs: [source],
        sourceRefs: [source]
      };
    });

  const disputes: DisputeView[] = [];
  const debateOpinions: OpinionView[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'debate') continue;
    if (entry.status === 'skipped') {
      // 没辩不是争议；跳过，避免空辩论面板靠投影硬造一条。
      continue;
    }
    const source = ref({
      subjectId: taskId,
      kind: 'debate',
      eventType: 'plan.debated',
      eventAt: entry.at,
      label: entry.topics[0] ?? '计划评审辩论'
    });
    const slice = entry.result;
    if (slice) {
      for (const claim of slice.claims) {
        debateOpinions.push({
          opinionId: `debate-claim:${claim.claimId}`,
          author: claim.author,
          position: 'neutral',
          statement: claim.text,
          sourceRefs: [source],
          evidenceRefs: [],
          targetRefs: []
        });
      }
      if (slice.disputes.length === 0) {
        // 有结构但无争议：不伪造正反双方；裁决（若有）进结论层。
        continue;
      }
      for (const dispute of slice.disputes) {
        const relatedClaims = slice.claims.filter(claim => dispute.claimIds.includes(claim.claimId));
        disputes.push({
          disputeId: dispute.disputeId,
          topic: entry.topics.join('；') || dispute.reason.slice(0, 80) || '计划评审争议',
          disputeClass: dispute.type,
          status: slice.verdict ? 'verdict' : entry.status === 'running' ? 'exchanging' : 'identified',
          claims: (relatedClaims.length > 0 ? relatedClaims : [
            { claimId: dispute.claimIds[0], author: dispute.agents[0], text: dispute.reason },
            { claimId: dispute.claimIds[1], author: dispute.agents[1], text: dispute.reason }
          ]).map(claim => ({
            claimId: claim.claimId,
            author: claim.author,
            statement: 'text' in claim ? claim.text : dispute.reason,
            sourceRefs: [source]
          })),
          exchanges: slice.exchanges.map((exchange, index) => ({
            exchangeId: `exchange:${dispute.disputeId}:${String(index)}`,
            kind: exchange.kind === 'rebuttal' || exchange.kind === 'question'
              ? 'challenge' as const
              : exchange.kind === 'revision'
                ? 'revision' as const
                : 'response' as const,
            author: exchange.author,
            text: exchange.text,
            sourceRefs: [source]
          })),
          evidenceRefs: [],
          verdict: slice.verdict?.conclusion ?? slice.verdict?.rationale ?? entry.summary,
          unresolvedReason: slice.verdict?.unresolved?.join('；') || undefined,
          sourceRefs: [source]
        });
      }
      continue;
    }
    // 老事件没有切片：只有摘要时，不拿参与者名单冒充争议双方。
    if (!entry.summary.trim()) continue;
    disputes.push({
      disputeId: `plan-debate:${taskId}:${String(entry.at)}`,
      topic: entry.topics.join('；') || '计划评审',
      disputeClass: 'plan_review',
      status: entry.status === 'completed' ? 'verdict' : entry.status === 'running' ? 'exchanging' : 'undetermined',
      claims: [],
      exchanges: [],
      evidenceRefs: [],
      verdict: entry.status === 'completed' || entry.status === 'stopped' ? entry.summary : undefined,
      unresolvedReason: entry.status === 'stopped' ? (entry.skippedReason ?? entry.roundsReason) : undefined,
      sourceRefs: [source]
    });
  }

  const keyOpinions: OpinionView[] = [
    ...debateOpinions,
    ...entries
      .filter((entry): entry is Extract<typeof entry, { kind: 'member' }> =>
        entry.kind === 'member' && entry.status === 'completed' && entry.text.trim().length > 0 && entry.protocol === null)
      .map(entry => {
        const source = ref({
          subjectId: taskId,
          kind: 'message',
          eventAt: entry.at,
          participantId: entry.memberId,
          label: entry.label
        });
        return {
          opinionId: `member:${entry.roundId ?? 'none'}:${entry.memberId}:${String(entry.at)}`,
          author: entry.label,
          position: 'neutral' as const,
          statement: entry.text.trim().slice(0, 500),
          sourceRefs: [source],
          evidenceRefs: [],
          targetRefs: []
        };
      })
  ];

  const deliverables: DeliverableView[] = [
    ...taskView.changes.map((change, index) => ({
      deliverableId: `change:${change.path}:${String(index)}`,
      kind: 'file' as const,
      label: change.path,
      path: change.path,
      sourceRefs: [ref({ subjectId: taskId, kind: 'report', label: '改动文件' })]
    })),
    ...taskView.artifacts.map((artifact, index) => ({
      deliverableId: `artifact:${artifact.path}:${String(index)}`,
      kind: 'artifact' as const,
      label: artifact.path,
      path: artifact.path,
      sourceRefs: [ref({ subjectId: taskId, kind: 'report', label: artifact.source })]
    }))
  ];

  const conclusion: ConclusionView | undefined = conclusionRaw
    ? {
        text: conclusionRaw.text,
        facts: conclusionRaw.facts,
        uncertainties: verifications.some(item => !item.fullyVerified)
          ? ['存在未完成或未通过的验证项']
          : [],
        openItems: reviews.flatMap(review =>
          review.needsFix
            ? review.issues.filter(issue => issue.disposition === 'pending').map(issue => issue.title)
            : []),
        tone: conclusionRaw.tone,
        sourceRefs: [ref({ subjectId: taskId, kind: 'event', eventType: 'task.completed', label: '任务结论' })]
      }
    : undefined;

  const sourceRefs = [
    ...(conclusion?.sourceRefs ?? []),
    ...reviews.flatMap(item => item.sourceRefs),
    ...verifications.flatMap(item => item.sourceRefs),
    ...disputes.flatMap(item => item.sourceRefs)
  ];

  return {
    taskId,
    scene: 'engineering',
    conclusion,
    keyOpinions,
    disputes,
    reviews,
    verifications,
    progress: {
      summary: status ?? 'unknown',
      participantCount: new Set(keyOpinions.map(item => item.author)).size
    },
    deliverables,
    sourceRefs,
    meta: {
      projectedAt: Date.now(),
      eventCount: ordered.length,
      conversationEntryCount: entries.length
    }
  };
}

function mapSynthesisDisputes(subjectId: string, disputed: readonly Dispute[]): DisputeView[] {
  return disputed.map((item, index) => {
    const source = ref({
      subjectId,
      kind: 'claim',
      label: item.topic
    });
    return {
      disputeId: `synthesis-dispute:${subjectId}:${String(index)}:${item.topic.slice(0, 40)}`,
      topic: item.topic,
      disputeClass: 'synthesis',
      status: 'identified',
      claims: item.positions.map((position, claimIndex) => ({
        claimId: `synthesis-claim:${String(index)}:${String(claimIndex)}`,
        author: position.channelId,
        statement: position.stance,
        sourceRefs: [source]
      })),
      exchanges: item.pivot
        ? [{
            exchangeId: `synthesis-pivot:${String(index)}`,
            kind: 'note' as const,
            author: 'system',
            text: item.pivot,
            sourceRefs: [source]
          }]
        : [],
      evidenceRefs: [],
      sourceRefs: [source]
    };
  });
}

function mapClaimsAsOpinions(
  subjectId: string,
  claims: readonly Claim[],
  position: OpinionPosition,
  prefix: string
): OpinionView[] {
  return claims.map((claim, index) => {
    const sourceRefs: SourceReference[] = claim.sources.map(source =>
      ref({
        subjectId,
        kind: 'message',
        messageId: source.messageId,
        participantId: source.channelId,
        label: source.channelId
      }));
    return {
      opinionId: `${prefix}:${subjectId}:${String(index)}:${claim.text.slice(0, 40)}`,
      author: claim.sources[0]?.channelId ?? 'unknown',
      position,
      statement: claim.text,
      evidenceRefs: claim.evidence.map((item, evidenceIndex) =>
        ref({ subjectId, kind: 'other', label: item, messageId: `evidence:${String(evidenceIndex)}` })),
      targetRefs: [],
      sourceRefs
    };
  });
}

/**
 * General / Knowledge：从会话综合与辩论快照投影。
 *
 * 不改 Conversation 存档形状；只读 Synthesis / DebateSnapshot。
 */
export function projectConversationCollaborationResult(input: {
  conversation: Conversation;
  /** 消息与会话分存；投影必须同时吃两边，不能假设 Conversation 自带 messages。 */
  messages: readonly ConversationMessage[];
  scene?: 'general' | 'knowledge';
  debate?: DebateSnapshot | null;
}): CollaborationResultView {
  const { conversation, messages } = input;
  const scene = input.scene ?? 'general';
  const subjectId = conversation.conversationId;
  const synthesis: Synthesis | undefined = [...messages]
    .reverse()
    .map(message => message.synthesis)
    .find((item): item is Synthesis => Boolean(item));
  const debateFromMessages = [...messages].reverse().find(message => message.debate)?.debate ?? null;

  const keyOpinions: OpinionView[] = synthesis
    ? [
        ...mapClaimsAsOpinions(subjectId, synthesis.consensus, 'support', 'consensus'),
        ...mapClaimsAsOpinions(subjectId, synthesis.unique, 'supplement', 'unique')
      ]
    : [];

  const disputes = synthesis ? mapSynthesisDisputes(subjectId, synthesis.disputed) : [];
  const debate = input.debate ?? debateFromMessages;
  if (debate && debate.rounds.length > 0) {
    // 辩论快照有轮次就记一条过程争议容器，裁决文案留给 VerdictStrip / fusion。
    disputes.push({
      disputeId: `debate-snapshot:${subjectId}`,
      topic: '会话辩论',
      disputeClass: 'debate',
      status: debate.status === 'completed' || debate.status === 'stopped' ? 'verdict' : 'exchanging',
      claims: [],
      exchanges: debate.rounds.flatMap(round =>
        round.messages.map((message, index) => ({
          exchangeId: `debate:${String(round.index)}:${String(index)}`,
          kind: message.kind === 'rebuttal' || message.kind === 'question'
            ? 'challenge' as const
            : message.kind === 'revision'
              ? 'revision' as const
              : 'response' as const,
          author: message.author,
          text: message.text,
          sourceRefs: [ref({ subjectId, kind: 'debate', participantId: message.author, label: `第 ${String(round.index)} 轮` })]
        }))),
      evidenceRefs: [],
      unresolvedReason: debate.stopReason,
      sourceRefs: [ref({ subjectId, kind: 'debate', label: 'DebateSnapshot' })]
    });
  }

  const conclusionText = synthesis?.finalOpinion?.trim()
    || synthesis?.recommendation?.trim()
    || '';
  const conclusion: ConclusionView | undefined = conclusionText
    ? {
        text: conclusionText,
        facts: [
          ...(synthesis?.consensus?.length ? [`一致观点 ${String(synthesis.consensus.length)} 条`] : []),
          ...(synthesis?.disputed?.length ? [`分歧 ${String(synthesis.disputed.length)} 处`] : [])
        ],
        uncertainties: (synthesis?.gaps ?? []).map(gap => `${gap.topic}：${gap.why}`),
        openItems: (synthesis?.disputed ?? []).map(item => item.topic),
        tone: synthesis?.disputed?.length ? 'warn' : 'ok',
        sourceRefs: [ref({ subjectId, kind: 'message', label: synthesis?.leadSummary ? '主导人综合' : '综合结果' })]
      }
    : undefined;

  return {
    taskId: subjectId,
    scene,
    conclusion,
    keyOpinions,
    disputes,
    reviews: [],
    verifications: [],
    progress: {
      summary: conversation.status,
      participantCount: conversation.channels?.length
        ?? new Set(keyOpinions.map(item => item.author)).size
    },
    deliverables: [],
    sourceRefs: [
      ...(conclusion?.sourceRefs ?? []),
      ...disputes.flatMap(item => item.sourceRefs)
    ],
    meta: {
      projectedAt: Date.now(),
      hasDebateSnapshot: Boolean(debate && debate.rounds.length > 0)
    }
  };
}

/** 测试与调试用：从 PlanDebate 摘要构造最小争议视图。 */
export function disputeFromPlanDebate(taskId: string, debate: PlanDebate, at: number): DisputeView | null {
  if (debate.status === 'skipped') return null;
  const source = ref({
    subjectId: taskId,
    kind: 'debate',
    eventType: 'plan.debated',
    eventAt: at,
    label: debate.topics[0] ?? '计划评审'
  });
  return {
    disputeId: `plan-debate:${taskId}:${debate.debateId ?? String(at)}`,
    topic: debate.topics.join('；') || '计划评审',
    disputeClass: 'plan_review',
    status: debate.status === 'completed' ? 'verdict' : 'undetermined',
    claims: debate.participants.map((participant, index) => ({
      claimId: `plan-debate-claim:${String(index)}`,
      author: participant,
      statement: debate.summary,
      sourceRefs: [source]
    })),
    exchanges: [],
    evidenceRefs: [],
    verdict: debate.summary,
    unresolvedReason: debate.skippedReason,
    sourceRefs: [source]
  };
}
