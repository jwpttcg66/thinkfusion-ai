import type { AgentEvent } from '../../shared/contracts';
import type { DebateClaim, DebateDispute, DebateRound, DebateState, DebateStatus } from './types';

/**
 * 方案评审辩论的过程 → 对话流的成员事件。
 *
 * 辩论引擎边跑边落盘：轮次一开就把 `pending`（还在等谁）写下去，每有一个
 * 成员说完就 push 一条 message 再落盘。但 `debatePlan` 原来只 `waitFor`
 * 最后一次性拿结果，中间两分钟界面上只有「已等 N 秒」——用户要的是看见
 * 每个成员怎么评、想到了什么，而不是一个倒计时。
 *
 * 这里把快照翻译成与第一轮回答同一种 `round.peer` 事件，对话流就能用
 * 「模型思考」那张卡逐条显示评审细节。纯函数 + 调用方持有去重键，轮询
 * 多次也不会重复出卡。
 *
 * 只读快照，不写回辩论文件：评审的真相仍然只有那一份 DebateState。
 */
export interface ReviewPeerInput {
  taskId: string;
  debateId: string;
  /** agentId → 人类可读名字（来自这一场的候选成员）。 */
  labels: ReadonlyMap<string, string>;
  /** 已发过的去重键，调用方跨轮询累积。 */
  seen: Set<string>;
  state: Pick<DebateState, 'rounds' | 'runningRound'>;
  at?: number;
}

type PeerEvent = Extract<AgentEvent, { type: 'round.peer' }>;

export interface ReviewPeerBatch {
  events: PeerEvent[];
  /** 本次新占用的去重键；调用方在 emit 成功后加入 `seen`。 */
  keys: string[];
}

/** 评审的成员事件统一挂在同一个虚拟轮次下，靠 memberId 区分第几轮。 */
export function reviewRoundIdOf(debateId: string): string {
  return `review:${debateId}`;
}

function roundLabel(index: number): string {
  // 轮次不是「又开了一场评审」，而是同一场评审里的表态 → 质疑 → 回应。
  // 标签写清楚，用户才知道第二轮在评什么。
  const phase = index === 0 ? '表态' : index === 1 ? '质疑' : '回应';
  return `第 ${String(index + 1)} 轮评审 · ${phase}`;
}

/**
 * 把一个辩论快照翻译成「这一瞬间新出现」的成员事件。
 *
 * - `pending` 里的成员 → `started`（卡片先出来，显示「等待发言」）
 * - 已落盘的发言 → `answered`（带正文与推理）
 * - `failures` → `failed`（失败原因照实写，不静默丢掉）
 */
export function reviewPeerEvents(input: ReviewPeerInput): ReviewPeerBatch {
  const at = input.at ?? Date.now();
  const roundId = reviewRoundIdOf(input.debateId);
  const events: PeerEvent[] = [];
  const keys: string[] = [];

  const name = (agentId: string) => input.labels.get(agentId) ?? agentId;

  const rounds: DebateRound[] = [...input.state.rounds];
  if (input.state.runningRound) rounds.push(input.state.runningRound);

  const push = (key: string, event: PeerEvent) => {
    if (input.seen.has(key) || keys.includes(key)) return;
    keys.push(key);
    events.push(event);
  };

  for (const round of rounds) {
    const index = round.index ?? 0;
    // 时间戳用轮次/发言自己的真实时间：一律填落盘时刻会让「已等 28 秒」
    // 变成假数字，也让同一批事件挤在同一个时间点上分不出先后。
    const roundStart = round.startedAt ?? at;

    for (const agentId of round.pending ?? []) {
      push(`${String(index)}:${agentId}:started`, {
        type: 'round.peer',
        at: roundStart,
        taskId: input.taskId,
        roundId,
        memberId: `${String(index)}:${agentId}`,
        label: `${name(agentId)}（${roundLabel(index)}）`,
        status: 'started'
      });
    }

    for (const message of round.messages) {
      const endedAt = message.endedAt ?? message.createdAt ?? at;
      const durationMs = message.startedAt && message.endedAt
        ? Math.max(0, message.endedAt - message.startedAt)
        : undefined;
      push(`${String(index)}:${message.messageId}:answered`, {
        type: 'round.peer',
        at: endedAt,
        taskId: input.taskId,
        roundId,
        memberId: `${String(index)}:${message.agentId}`,
        label: `${name(message.agentId)}（${roundLabel(index)}）`,
        status: 'answered',
        text: message.text,
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(message.providerId ? { providerId: message.providerId } : {}),
        ...(message.modelId ? { modelId: message.modelId } : {})
      });
    }

    for (const failure of round.failures ?? []) {
      push(`${String(index)}:${failure.agentId}:failed`, {
        type: 'round.peer',
        at: round.endedAt ?? at,
        taskId: input.taskId,
        roundId,
        memberId: `${String(index)}:${failure.agentId}`,
        label: `${name(failure.agentId)}（${roundLabel(index)}）`,
        status: 'failed',
        error: failure.detail
      });
    }
  }

  return { events, keys };
}


/**
 * 一轮结束后给用户看的那句话：为什么继续、还是为什么停。
 *
 * 轮次不是写死的：引擎每轮结束都判断一次收敛。界面必须把「进入下一轮」
 * 的依据说出来（还有争议 / 质疑没人答复 / 达到上限），否则用户只会看到
 * 又一张评审卡，不知道为什么要多等一轮。
 */
export function reviewRoundNote(input: {
  round: DebateRound;
  status: DebateStatus;
  stopReason?: string;
  disputes: number;
  maxRounds: number;
}): string {
  const number = input.round.index + 1;
  const phase = input.round.phase === 'analysis'
    ? '表态'
    : input.round.phase === 'challenge'
      ? '质疑'
      : '回应';
  if (input.round.converged) {
    return `第 ${String(number)} 轮评审（${phase}）已收敛，不再继续`;
  }
  if (input.status !== 'running') {
    return `第 ${String(number)} 轮评审（${phase}）结束：${input.stopReason ?? '评审结束'}`;
  }
  if (number >= input.maxRounds) {
    return `第 ${String(number)} 轮评审（${phase}）结束：达到最多 ${String(input.maxRounds)} 轮，评审收尾`;
  }
  if (input.round.phase === 'response') {
    return `第 ${String(number)} 轮回应结束：按收敛结果收尾`;
  }
  if (input.round.phase === 'challenge') {
    return `第 ${String(number)} 轮质疑结束：仍有 ${String(input.disputes)} 条争议需要答复 → 进入第 ${String(number + 1)} 轮回应`;
  }
  return `第 ${String(number)} 轮表态结束：仍有 ${String(input.disputes)} 条争议未解决 → 进入第 ${String(number + 1)} 轮质疑`;
}

/** 下一轮要质疑/回应的具体对象：必须带双方原话，不能只报「还有 N 条」。 */
export interface ReviewContinueTarget {
  left: string;
  right: string;
  reason: string;
  agents: [string, string];
}

export interface ReviewContinueBridge {
  action: 'continue' | 'stop';
  fromRound: number;
  fromPhase: 'analysis' | 'challenge' | 'response';
  fromPhaseLabel: string;
  nextPhase?: 'challenge' | 'response';
  nextPhaseLabel?: string;
  message: string;
  targets: ReviewContinueTarget[];
}

function phaseLabelOf(phase: DebateRound['phase'] | undefined): string {
  if (phase === 'analysis') return '表态';
  if (phase === 'challenge') return '质疑';
  return '回应';
}

function claimById(claims: readonly DebateClaim[], claimId: string): DebateClaim | undefined {
  return claims.find(item => item.claimId === claimId);
}

function clipClaim(text: string, max = 220): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

/** 从争议 + 主张原文抽出「对什么质疑 / 对什么回应」。 */
export function reviewDisputeTargets(
  disputes: readonly DebateDispute[],
  claims: readonly DebateClaim[],
  limit = 8
): ReviewContinueTarget[] {
  const open = disputes.filter(item => item.status === 'open');
  const out: ReviewContinueTarget[] = [];
  for (const dispute of open) {
    if (out.length >= limit) break;
    const left = claimById(claims, dispute.claimIds[0]);
    const right = claimById(claims, dispute.claimIds[1]);
    out.push({
      left: left ? clipClaim(left.text) : `（主张 ${dispute.claimIds[0].slice(0, 8)}）`,
      right: right ? clipClaim(right.text) : `（主张 ${dispute.claimIds[1].slice(0, 8)}）`,
      reason: dispute.reason,
      agents: dispute.agents
    });
  }
  return out;
}

/**
 * 一轮结束后、下一轮开始前的桥接说明。
 *
 * 用户要先看见「对什么质疑 / 对什么回应」，才能理解为何开下一轮；
 * 只写「还有 N 条争议」不够——必须带双方原话与判定理由。
 */
export function reviewContinueBridge(input: {
  round: DebateRound;
  status: DebateStatus;
  stopReason?: string;
  disputes: readonly DebateDispute[];
  claims: readonly DebateClaim[];
  maxRounds: number;
}): ReviewContinueBridge {
  const fromRound = input.round.index + 1;
  const fromPhase = (input.round.phase ?? 'analysis') as ReviewContinueBridge['fromPhase'];
  const fromPhaseLabel = phaseLabelOf(fromPhase);
  const note = reviewRoundNote({
    round: input.round,
    status: input.status,
    ...(input.stopReason ? { stopReason: input.stopReason } : {}),
    disputes: input.disputes.length,
    maxRounds: input.maxRounds
  });
  const willContinue =
    input.status === 'running' &&
    !input.round.converged &&
    fromRound < input.maxRounds &&
    fromPhase !== 'response';
  if (!willContinue) {
    return {
      action: 'stop',
      fromRound,
      fromPhase,
      fromPhaseLabel,
      message: note,
      targets: reviewDisputeTargets(input.disputes, input.claims)
    };
  }
  const nextPhase = fromPhase === 'analysis' ? 'challenge' as const : 'response' as const;
  const nextPhaseLabel = phaseLabelOf(nextPhase);
  const targets = reviewDisputeTargets(input.disputes, input.claims);
  const lead = nextPhase === 'challenge'
    ? `先画出以下 ${String(targets.length)} 条分歧，再发起第 ${String(fromRound + 1)} 轮质疑`
    : `先画出以下 ${String(targets.length)} 条待答复质疑，再发起第 ${String(fromRound + 1)} 轮回应`;
  return {
    action: 'continue',
    fromRound,
    fromPhase,
    fromPhaseLabel,
    nextPhase,
    nextPhaseLabel,
    message: `${note}。${lead}`,
    targets
  };
}
