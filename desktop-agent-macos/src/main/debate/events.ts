import type { DebateEvent, DebateEventType, DebateState } from './types';

/**
 * 事件流（任务书第 9 节 / AC-14）。
 *
 * 两条规则，写在这里是为了让调用方不用每处都重复判断：
 *
 * 1. **幂等**：同一个 `key` 只写一次。恢复一场辩论时，编排器会重跑那个没跑完
 *    的轮次，`round.started:2` 会被写第二次——靠 key 挡掉，事件流才不会因为
 *    一次恢复就多出一段假的「又开始了」。
 * 2. **顺序稳定**：`seq` 从 1 开始单调递增，且只在追加时生成。并发写同一场
 *    辩论在现有结构里不会发生（一场辩论只有一个 run 在跑），所以不需要锁。
 *
 * 这里没有引入事件溯源：状态仍然是整份快照，事件是**旁证**。要改成「事件是
 * 唯一真相」得重写恢复路径，代价远大于收益（一场辩论最多几十个事件）。
 */
export function appendEvent(
  state: Pick<DebateState, 'debateId' | 'events'>,
  event: {
    type: DebateEventType;
    key: string;
    at: number;
    roundIndex?: number;
    detail?: string;
  }
): DebateEvent | null {
  const events = state.events ?? [];
  if (events.some(item => item.key === event.key)) return null;

  const seq = events.reduce((max, item) => Math.max(max, item.seq), 0) + 1;
  const appended: DebateEvent = {
    seq,
    eventId: `${state.debateId}#${String(seq)}`,
    type: event.type,
    at: event.at,
    key: event.key,
    ...(typeof event.roundIndex === 'number' ? { roundIndex: event.roundIndex } : {}),
    ...(event.detail ? { detail: event.detail } : {})
  };
  state.events = [...events, appended];
  return appended;
}

/** 读事件流时的排序兜底：老文件或有并发写坏的顺序，按 seq 读。 */
export function eventsOf(state: Pick<DebateState, 'events'>): DebateEvent[] {
  return [...(state.events ?? [])].sort((a, b) => a.seq - b.seq);
}

/** 最近一条事件；恢复时可用来判断「上次停在哪一步」。 */
export function lastEvent(state: Pick<DebateState, 'events'>): DebateEvent | null {
  const events = eventsOf(state);
  return events.length > 0 ? events[events.length - 1] : null;
}

/**
 * 恢复点：最后一个「轮次结束」事件之后还没开始的轮次。
 *
 * 只用来解释和测试，不参与状态机——状态机看的仍然是 `rounds.length`，
 * 因为发言本身才是不可丢的东西。
 */
export function resumePointOf(state: Pick<DebateState, 'events'>): number {
  const events = eventsOf(state);
  const finished = new Set(
    events.filter(item => item.type === 'round.finished' && typeof item.roundIndex === 'number')
      .map(item => item.roundIndex as number)
  );
  let index = 0;
  while (finished.has(index)) index += 1;
  return index;
}
