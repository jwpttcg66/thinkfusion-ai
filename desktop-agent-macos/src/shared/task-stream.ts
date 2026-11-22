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
      // 同一轮可能有多个成员在流式输出。live 只保留第一路：把两路 delta 拼进
      // 同一个字符串，界面上就会看到 A 的思考接在 B 的回答后面——这不是显示
      // 问题，是内容错误。其余成员各自在 `reduceTaskMembers` 里。
      if (state.streamId && event.streamId && state.streamId !== event.streamId) return state;
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

// ---------------------------------------------------------------------------
// 每个成员独立一路（V2.1 多模型独立输出）
// ---------------------------------------------------------------------------

/**
 * 成员卡片的展示状态。
 *
 * 与 `ChannelPhase` 不是一回事：那是知识空间「一轮里每个通道」的阶段，
 * 这里是一次工程任务里每个模型的生命周期。`interrupted` 只在本任务结束时
 * 仍有成员在跑时出现——那表示「它的回答没回来」，不是它自己失败。
 */
export type TaskMemberStatus =
  | 'preparing'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface TaskMemberUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface TaskMemberStream {
  memberId: string;
  label: string;
  status: TaskMemberStatus;
  roundId: string | null;
  modelCallId: string | null;
  reasoning: string;
  text: string;
  error: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  durationMs: number | null;
  providerId: string | null;
  modelId: string | null;
  usage: TaskMemberUsage | null;
  /** 这个来源是否真的给过 reasoning；false 时卡片写「未提供」，不写空。 */
  reasoningSupported: boolean;
  /** 是否给过 token 用量。CLI 与网页通常没有，这是事实。 */
  tokenSupported: boolean;
}

/** 成员事件的最小形状：`reduceTaskMembers` 不依赖完整 AgentEvent，便于测试。 */
export interface TaskMemberEvent {
  type: string;
  at?: number;
  roundId?: string;
  participantId?: string;
  memberId?: string;
  label?: string;
  status?: string;
  text?: string;
  reasoning?: string;
  error?: string;
  durationMs?: number;
  startedAt?: number;
  providerId?: string;
  modelId?: string;
  usage?: TaskMemberUsage | null;
  streamId?: string;
  modelCallId?: string;
  reset?: boolean;
  mode?: 'snapshot' | 'delta';
}

function upsertMember(
  members: readonly TaskMemberStream[],
  memberId: string,
  patch?: Partial<TaskMemberStream>
): TaskMemberStream[] {
  const index = members.findIndex(item => item.memberId === memberId);
  if (index < 0) {
    return [
      ...members,
      {
        memberId,
        label: memberId,
        status: 'preparing',
        roundId: null,
        modelCallId: null,
        reasoning: '',
        text: '',
        error: null,
        startedAt: null,
        updatedAt: null,
        durationMs: null,
        providerId: null,
        modelId: null,
        usage: null,
        reasoningSupported: false,
        tokenSupported: false,
        ...patch
      }
    ];
  }
  const next = [...members];
  next[index] = { ...next[index], ...patch };
  return next;
}

function ordered(members: readonly TaskMemberStream[]): TaskMemberStream[] {
  // 按开始时间排；还没开始的排在最后，保持插入顺序（sort 是稳定的）。
  return [...members].sort((a, b) => (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER));
}

/**
 * 把事件折成「每个成员一张卡」。
 *
 * 为什么不是增量 reducer 的 Map：渲染层拿到的是完整事件列表（刷新后要重建），
 * 而 Map 在 React 里做不可变更新又容易漏；这里统一返回数组，排序稳定。
 *
 * 不伪造：没有 reasoning 的来源 `reasoningSupported=false`，没有 usage 的
 * `tokenSupported=false`，界面据此写「未提供」。空字符串不等于「思考为空」。
 */
export function reduceTaskMembers(
  members: readonly TaskMemberStream[],
  event: TaskMemberEvent
): TaskMemberStream[] {
  const at = event.at ?? Date.now();
  if (event.type === 'round.started') {
    // 新一轮开始：上一轮的卡片属于上一轮，清掉，避免同一成员被两次回答混在一起。
    return [];
  }
  if (event.type === 'round.peer') {
    const memberId = event.memberId ?? event.participantId;
    if (!memberId) return [...members];
    const status = event.status;
    if (status === 'started') {
      return upsertMember(members, memberId, {
        label: event.label ?? memberId,
        status: 'preparing',
        roundId: event.roundId ?? null,
        startedAt: event.startedAt ?? at,
        updatedAt: at,
        error: null
      });
    }
    if (status === 'answered') {
      return upsertMember(members, memberId, {
        label: event.label ?? memberId,
        status: 'completed',
        text: event.text ?? '',
        updatedAt: at,
        durationMs: event.durationMs ?? null,
        usage: event.usage ?? null,
        tokenSupported: Boolean(event.usage)
      });
    }
    if (status === 'failed' || status === 'cancelled') {
      return upsertMember(members, memberId, {
        label: event.label ?? memberId,
        status: status === 'failed' ? 'failed' : 'cancelled',
        error: event.error ?? null,
        updatedAt: at,
        durationMs: event.durationMs ?? null
      });
    }
    return [...members];
  }
  if (event.type === 'round.delta') {
    const memberId = event.participantId;
    // 旧事件没有 participantId：归到「单成员」语义，由 live 那一份负责，
    // 这里不凭空造一个叫 undefined 的成员。
    if (!memberId) return [...members];
    const current = members.find(item => item.memberId === memberId);
    const mode = event.mode ?? 'snapshot';
    const reset = event.reset === true;
    const merge = (existing: string, incoming: string | undefined): string => {
      if (reset) return incoming ?? '';
      if (!incoming) return existing;
      // snapshot = 这份就是累计全文；delta = 只有新增的一段。
      return mode === 'delta' ? existing + incoming : incoming;
    };
    const reasoning = merge(current?.reasoning ?? '', event.reasoning);
    const text = merge(current?.text ?? '', event.text);
    return upsertMember(members, memberId, {
      roundId: event.roundId ?? current?.roundId ?? null,
      modelCallId: event.modelCallId ?? event.streamId ?? current?.modelCallId ?? null,
      reasoning,
      text,
      status: reasoning || text ? 'streaming' : (current?.status ?? 'preparing'),
      updatedAt: at,
      startedAt: current?.startedAt ?? at,
      providerId: event.providerId ?? current?.providerId ?? null,
      modelId: event.modelId ?? current?.modelId ?? null,
      reasoningSupported: current?.reasoningSupported === true || Boolean(event.reasoning),
      label: current?.label ?? event.modelId ?? event.providerId ?? memberId
    });
  }
  if (event.type === 'round.answer') {
    const memberId = event.participantId;
    if (!memberId) return [...members];
    const current = members.find(item => item.memberId === memberId);
    return upsertMember(members, memberId, {
      status: 'completed',
      // round.answer 是这一轮的最终回答；同一成员的 delta 可能已经把全文拼好了，
      // 这里以 round.answer 为准（它是落盘前最后一份原文）。
      text: event.text ?? current?.text ?? '',
      updatedAt: at,
      durationMs: current?.startedAt ? at - current.startedAt : current?.durationMs ?? null
    });
  }
  if (event.type === 'task.cancelled') {
    return members.map(member =>
      member.status === 'preparing' || member.status === 'streaming'
        ? { ...member, status: 'cancelled' as const, updatedAt: at }
        : member
    );
  }
  if (event.type === 'task.completed' || event.type === 'task.failed') {
    return members.map(member =>
      member.status === 'preparing' || member.status === 'streaming'
        ? { ...member, status: 'interrupted' as const, updatedAt: at }
        : member
    );
  }
  return [...members];
}

/** 从完整事件列表重建成员卡片（刷新/重启后恢复）。 */
export function projectTaskMembers(events: readonly TaskMemberEvent[]): TaskMemberStream[] {
  let members: TaskMemberStream[] = [];
  for (const event of events) members = reduceTaskMembers(members, event);
  return ordered(members);
}
