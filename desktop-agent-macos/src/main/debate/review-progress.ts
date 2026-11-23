import type { AgentEvent } from '../../shared/contracts';
import type { DebateRound, DebateState } from './types';

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
  return `第 ${String(index + 1)} 轮评审`;
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

    for (const agentId of round.pending ?? []) {
      push(`${String(index)}:${agentId}:started`, {
        type: 'round.peer',
        at,
        taskId: input.taskId,
        roundId,
        memberId: `${String(index)}:${agentId}`,
        label: `${name(agentId)}（${roundLabel(index)}）`,
        status: 'started'
      });
    }

    for (const message of round.messages) {
      push(`${String(index)}:${message.messageId}:answered`, {
        type: 'round.peer',
        at,
        taskId: input.taskId,
        roundId,
        memberId: `${String(index)}:${message.agentId}`,
        label: `${name(message.agentId)}（${roundLabel(index)}）`,
        status: 'answered',
        text: message.text,
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        ...(message.providerId ? { providerId: message.providerId } : {}),
        ...(message.modelId ? { modelId: message.modelId } : {})
      });
    }

    for (const failure of round.failures ?? []) {
      push(`${String(index)}:${failure.agentId}:failed`, {
        type: 'round.peer',
        at,
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
