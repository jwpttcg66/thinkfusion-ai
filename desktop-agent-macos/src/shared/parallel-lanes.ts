/**
 * D2 并行对话轨：把一轮里各通道的真实回答组织成侧边浮层的 lane（纯投影）。
 *
 * 三条边界必须守住：
 * - 不占主流位置：这里只产出数据，主流的 `ConversationView` 一个字不改；
 * - 通过真实成员 / 轮次 / 消息关联：lane 的身份来自 `turn` + `channelId`，
 *   正文来自真正落盘的 `channel` 消息或还在流的 `delta`；
 * - 多轮不清空：每轮各成一组，新一轮追加，不覆盖上一轮。
 *
 * 没有真实消息、没有在跑的通道就不出线——浮层不凭 `conversation.channels`
 * 的提问名单画空卡，那会把「问了没答」伪装成「有并行对话」。
 */

import type { ConversationMessage } from './conversation';

export type ParallelLaneStatus = 'streaming' | 'answered' | 'failed';

export interface ParallelLane {
  /** 稳定身份：轮次 key + channelId，重算不变，不用数组下标。 */
  key: string;
  /** 轮次 key，与主流 `groupTurns` 同构（turn-<userId> / turn-leading）。 */
  turnKey: string;
  turnIndex: number;
  channelId: string;
  label: string;
  status: ParallelLaneStatus;
  text: string;
  reasoning: string;
  at: number;
  /** 关联主流消息 id：落盘回答有；纯增量没有，届时为空不伪造。 */
  messageId: string | null;
}

export interface ParallelTurn {
  key: string;
  index: number;
  prompt: string;
  lanes: ParallelLane[];
}

export interface ParallelInput {
  messages: readonly ConversationMessage[];
  /** 还没落盘的流式增量，按 channelId 累积。 */
  deltas?: Readonly<Record<string, { text: string; reasoning: string; done: boolean }>>;
  /** 通道 id → 显示名。 */
  labels?: ReadonlyMap<string, string>;
  /** 当前是否还在收 / 比 / 综合：只有这时才把 delta 画成「输出中」。 */
  live?: boolean;
  /** 注入当前时间，保证纯函数可重复计算；缺省用最后一条消息的时间。 */
  now?: number;
}

export function parallelLabelOf(
  channelId: string,
  labels: ReadonlyMap<string, string> | undefined
): string {
  if (channelId === '__routing__') return '工程判定';
  const known = labels?.get(channelId);
  if (known) return known;
  const parts = channelId.split(':');
  return parts.length > 1 && parts[0].length > 0 ? parts.slice(1).join(':') : channelId;
}

/**
 * 轮次划分与主流 `groupTurns` 保持一致：一条 user 消息开启新一轮；
 * channel / synthesis / system 落在最近一轮。并行轨只取 channel 回答。
 */
function turnKeyFor(
  messages: readonly ConversationMessage[],
  index: number
): { turnKey: string; turnIndex: number } {
  let turnIndex = 0;
  let turnKey = 'turn-leading';
  for (let i = 0; i <= index; i += 1) {
    if (messages[i].role === 'user') {
      turnIndex += 1;
      turnKey = `turn-${messages[i].messageId}`;
    }
  }
  return { turnKey, turnIndex };
}

export function buildParallelLanes(input: ParallelInput): ParallelTurn[] {
  const ordered = [...input.messages].sort((a, b) => a.at - b.at || a.messageId.localeCompare(b.messageId));
  const turns = new Map<string, ParallelTurn>();
  const live = input.live === true;
  const now = input.now ?? ordered[ordered.length - 1]?.at ?? 0;

  const turnOf = (message: ConversationMessage) => {
    const { turnKey, turnIndex } = turnKeyFor(ordered, ordered.indexOf(message));
    let turn = turns.get(turnKey);
    if (!turn) {
      turn = { key: turnKey, index: turnIndex, prompt: '', lanes: [] };
      turns.set(turnKey, turn);
    }
    return turn;
  };

  // user 消息只负责开轮和记下原话；原话照抄，不加角色行、不改写。
  for (const message of ordered) {
    if (message.role === 'user') {
      const turn = turnOf(message);
      turn.prompt = message.text;
    }
  }

  // 落盘回答：每次回答都是一条真实 lane，同轮同通道重复回答各自保留。
  for (const message of ordered) {
    if (message.role !== 'channel') continue;
    const channelId = message.channelId ?? 'unknown';
    const turn = turnOf(message);
    turn.lanes.push({
      key: `${turn.key}::${channelId}::${message.messageId}`,
      turnKey: turn.key,
      turnIndex: turn.index,
      channelId,
      label: parallelLabelOf(channelId, input.labels),
      status: 'answered',
      text: message.text,
      reasoning: message.reasoning ?? '',
      at: message.at,
      messageId: message.messageId
    });
  }

  // 还没落盘的增量：只有这一轮还没有该通道的落盘回答时才出「输出中」线，
  // 否则同一路会既在主流有卡、又在浮层多一条假线。
  if (live && input.deltas) {
    for (const [channelId, delta] of Object.entries(input.deltas)) {
      const hasSettled = ordered.some(
        message => message.role === 'channel' && message.channelId === channelId
      );
      if (hasSettled || (!delta.text && !delta.reasoning)) continue;
      const last = ordered[ordered.length - 1];
      const turn = last
        ? turnOf(last)
        : { key: 'turn-leading', index: 0, prompt: '', lanes: [] } as ParallelTurn;
      if (!turns.has(turn.key)) turns.set(turn.key, turn);
      turn.lanes.push({
        key: `${turn.key}::${channelId}::delta`,
        turnKey: turn.key,
        turnIndex: turn.index,
        channelId,
        label: parallelLabelOf(channelId, input.labels),
        status: delta.done ? 'answered' : 'streaming',
        text: delta.text,
        reasoning: delta.reasoning,
        at: now,
        messageId: null
      });
    }
  }

  return [...turns.values()]
    .map(turn => ({ ...turn, lanes: turn.lanes.sort((a, b) => a.at - b.at) }))
    .sort((a, b) => a.index - b.index);
}

/** 浮层只在至少一轮真有 lane 时出现；空壳不画。 */
export function shouldShowParallelRail(turns: readonly ParallelTurn[]): boolean {
  return turns.some(turn => turn.lanes.length > 0);
}
