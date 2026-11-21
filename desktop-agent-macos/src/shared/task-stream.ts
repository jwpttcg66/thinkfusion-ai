/**
 * 任务流式状态的唯一归约器。
 *
 * 规则：
 * - reasoning 与 assistant text 分开保存，界面分开展示，绝不混合；
 * - 事件必须带 roundId；旧轮次或已结算轮次的迟到 delta 直接丢弃；
 * - Provider/Adapter 负责说明这是 snapshot（累计全文）还是 delta（增量）；
 * - 新一轮开始、回答到达或任务终态都清理临时流。
 */

export interface TaskStreamEvent {
  type: string;
  roundId?: string;
  streamId?: string;
  text?: string;
  reasoning?: string;
  reset?: boolean;
  mode?: 'snapshot' | 'delta';
  providerId?: string;
  modelId?: string;
  at?: number;
}

export interface TaskStreamState {
  roundId: string | null;
  streamId: string | null;
  settledRoundId: string | null;
  /** 模型接口实际返回的 reasoning 原文。 */
  reasoning: string;
  /** 模型正常 assistant 输出原文。 */
  text: string;
  providerId: string | null;
  modelId: string | null;
  updatedAt: number | null;
}

export const EMPTY_TASK_STREAM: TaskStreamState = {
  roundId: null,
  streamId: null,
  settledRoundId: null,
  reasoning: '',
  text: '',
  providerId: null,
  modelId: null,
  updatedAt: null
};

function apply(current: string, incoming: string | undefined, mode: 'snapshot' | 'delta'): string {
  if (!incoming) return current;
  return mode === 'delta' ? current + incoming : incoming;
}

export function reduceTaskStream(
  state: TaskStreamState,
  event: TaskStreamEvent
): TaskStreamState {
  switch (event.type) {
    case 'round.started':
      return {
        ...EMPTY_TASK_STREAM,
        roundId: event.roundId ?? state.roundId,
        updatedAt: event.at ?? state.updatedAt
      };
    case 'round.delta': {
      const roundId = event.roundId ?? state.roundId;
      if (!roundId) return state;
      if (state.roundId !== roundId) return state;
      if (state.settledRoundId === roundId) return state;
      const reset = event.reset === true;
      const mode = event.mode ?? 'snapshot';
      return {
        ...state,
        streamId: event.streamId ?? state.streamId,
        reasoning: reset ? (event.reasoning ?? '') : apply(state.reasoning, event.reasoning, mode),
        text: reset ? (event.text ?? '') : apply(state.text, event.text, mode),
        providerId: event.providerId ?? state.providerId,
        modelId: event.modelId ?? state.modelId,
        updatedAt: event.at ?? state.updatedAt
      };
    }
    case 'round.answer':
      return {
        ...state,
        roundId: event.roundId ?? state.roundId,
        settledRoundId: event.roundId ?? state.settledRoundId,
        reasoning: '',
        text: '',
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

/** 是否应该显示实时区。已结算、无内容且无身份时不显示。 */
export function isLive(state: TaskStreamState): boolean {
  return (
    state.roundId !== null &&
    state.settledRoundId !== state.roundId &&
    (state.reasoning.length > 0 || state.text.length > 0)
  );
}
