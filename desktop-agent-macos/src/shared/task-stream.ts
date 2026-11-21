/**
 * 任务流式状态的唯一归约器。
 *
 * 规则：
 * - reasoning 是模型内部数据，只计数，不进入展示文本；
 * - 流按 roundId 隔离，旧轮次或已结算轮次的迟到 delta 直接丢弃；
 * - 新一轮开始、回答到达或任务终态都必须清理临时流；
 * - 页面只根据这份状态显示“正在做什么 + 已接收多少”，不展示原始 reasoning。
 */

export interface TaskStreamEvent {
  type: string;
  roundId?: string;
  text?: string;
  reasoning?: string;
  at?: number;
}

export interface TaskStreamState {
  /** 当前正在流式输出的轮次；null 表示没有活动流。 */
  roundId: string | null;
  /** 已经收到正式 answer 的轮次；该轮后续迟到 delta 必须忽略。 */
  settledRoundId: string | null;
  textChars: number;
  reasoningChars: number;
  updatedAt: number | null;
}

export const EMPTY_TASK_STREAM: TaskStreamState = {
  roundId: null,
  settledRoundId: null,
  textChars: 0,
  reasoningChars: 0,
  updatedAt: null
};

export function reduceTaskStream(
  state: TaskStreamState,
  event: TaskStreamEvent
): TaskStreamState {
  switch (event.type) {
    case 'round.started':
      return {
        roundId: event.roundId ?? state.roundId,
        settledRoundId: null,
        textChars: 0,
        reasoningChars: 0,
        updatedAt: event.at ?? state.updatedAt
      };
    case 'round.delta': {
      const roundId = event.roundId ?? state.roundId;
      if (!roundId) return state;
      if (state.roundId !== roundId) return state;
      if (state.settledRoundId === roundId) return state;
      // Provider 适配器发的是累计文本；用 max 兼容“累计/增量”两种实现，
      // 至少不会因为增量片段把进度算小。
      return {
        ...state,
        textChars: Math.max(state.textChars, event.text?.length ?? 0),
        reasoningChars: Math.max(state.reasoningChars, event.reasoning?.length ?? 0),
        updatedAt: event.at ?? state.updatedAt
      };
    }
    case 'round.answer':
      return {
        ...state,
        roundId: event.roundId ?? state.roundId,
        settledRoundId: event.roundId ?? state.settledRoundId,
        textChars: 0,
        reasoningChars: 0,
        updatedAt: event.at ?? state.updatedAt
      };
    case 'task.completed':
    case 'task.failed':
    case 'task.cancelled':
      return { ...EMPTY_TASK_STREAM };
    default:
      return state;
  }
}

/** 是否应该显示“当前工作进展”。已结算或没有字符时不显示。 */
export function isLive(state: TaskStreamState): boolean {
  return (
    state.roundId !== null &&
    state.settledRoundId !== state.roundId &&
    state.textChars + state.reasoningChars > 0
  );
}
