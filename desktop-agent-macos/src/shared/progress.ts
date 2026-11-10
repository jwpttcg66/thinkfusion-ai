/**
 * 统一的「现在在做什么」模型。
 *
 * 这一层只回答三个问题，别的都不管：
 *
 * 1. 这次任务走到哪一段了（判定 / 提问 / 汇总 / 执行 / 评审）；
 * 2. 当前这一段是不是还活着，活了多久；
 * 3. 哪一段失败了、为什么。
 *
 * 输入是**已经存在的事件**（任务状态、轮次、步骤、报告），不新增第二份状态；
 * 事件是唯一事实，这里只是投影。这样界面不会因为「又加了一套进度表」而和
 * 真实执行分叉。
 *
 * 设计参照：
 * - DeepSeek Harness 的 session 事件投影（tool/call → tool/result → 会话行）；
 * - opencode 的 step-start / step-finish：阶段是结构化的，不是一句日志。
 */

export const PROGRESS_STAGES = [
  'routing',
  'asking',
  'synthesis',
  'execution',
  'review'
] as const;

export type ProgressStage = (typeof PROGRESS_STAGES)[number];
export type ProgressState = 'pending' | 'active' | 'done' | 'failed';

export interface ProgressStageView {
  stage: ProgressStage;
  label: string;
  state: ProgressState;
  /** 这一段第一次被看到的时间；用来算「已经等了多久」。 */
  at: number | null;
  /** 当前这一段的补充说明：第几步、哪个通道、为什么失败。 */
  detail?: string;
}

export interface ProgressEventLike {
  type: string;
  at: number;
  tool?: string;
  stepId?: string;
  index?: number;
  total?: number;
  error?: string;
  report?: { status?: string; results?: Array<{ status?: string }> };
  review?: { needsFix?: boolean };
  plan?: { steps?: Array<{ id: string; tool: string }> };
}

export interface ProgressInput {
  /** 会话状态：thinking / synthesizing / answered / failed ... */
  conversationStatus: string | null;
  /** 任务状态：planning / executing / verifying / completed / failed ... */
  taskStatus?: string | null;
  /** 这次任务的事件，按时间先后。 */
  events: readonly ProgressEventLike[];
  /** 会话开始时间；没有就用第一条事件的时间。 */
  startedAt?: number | null;
}

export interface ProgressView {
  stages: ProgressStageView[];
  /** 当前活动阶段；全都结束或还没开始时为 null。 */
  current: ProgressStageView | null;
  /** 从开始到现在（任务结束就停在结束时刻）。 */
  elapsedMs: number;
  endedAt: number | null;
}

const LABELS: Record<ProgressStage, string> = {
  routing: '判定',
  asking: '提问',
  synthesis: '汇总',
  execution: '执行',
  review: '评审'
};

const TERMINAL_FAILED = new Set(['failed', 'cancelled']);

function firstAt(events: readonly ProgressEventLike[], type: string): number | null {
  const found = events.find(event => event.type === type);
  return found ? found.at : null;
}

function lastOf(events: readonly ProgressEventLike[], type: string): ProgressEventLike | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === type) return events[index];
  }
  return null;
}

/**
 * 从事件投影出阶段列表。
 *
 * 规则全部可解释：
 * - 有 `round.started` 就说明已进入提问；
 * - 有 `plan.ready` 或状态到 `synthesizing` 就进入汇总；
 * - 有 `step.started` 或任务 `executing` 就进入执行；
 * - 有 `report.ready`/`review.ready` 说明执行收尾；
 * - 失败状态只把「当前段」标红，不把后面的段假装完成。
 */
export function deriveProgress(input: ProgressInput): ProgressView {
  const events = input.events;
  const conversationStatus = input.conversationStatus;
  const taskStatus = input.taskStatus ?? null;
  const startedAt =
    input.startedAt ??
    (events.length > 0 ? events[0].at : null);

  // 状态也是事实：`collecting` 说明问题已经发出，即使 round.started 事件因为
  // 提交与订阅的时序没进到列表里（真机遇到过：界面一直停在「判定」）。
  const roundStart =
    firstAt(events, 'round.started') ??
    (conversationStatus === 'collecting' || conversationStatus === 'synthesizing' ? startedAt : null);
  const planReady = firstAt(events, 'plan.ready');
  const firstStep = firstAt(events, 'step.started');
  const report = lastOf(events, 'report.ready');
  const review = firstAt(events, 'review.ready');
  const taskFailed = taskStatus ? TERMINAL_FAILED.has(taskStatus) : false;
  const convFailed = TERMINAL_FAILED.has(conversationStatus ?? '');
  const failed = taskFailed || convFailed;
  const cancelled = conversationStatus === 'cancelled' || taskStatus === 'cancelled';

  // 汇总开始：状态进入 synthesizing，或者已经有了计划（说明汇总写完并进入执行）。
  const synthesisAt =
    (conversationStatus === 'synthesizing' ? startedAt : null) ??
    planReady ??
    (conversationStatus === 'answered' ? firstAt(events, 'round.answer') : null);

  const executionAt = firstStep ?? planReady ?? (taskStatus === 'executing' ? startedAt : null);
  const reviewAt = review ?? (report ? report.at : null);

  const stages: ProgressStageView[] = PROGRESS_STAGES.map(stage => ({
    stage,
    label: LABELS[stage],
    state: 'pending' as ProgressState,
    at: null as number | null
  }));

  const mark = (stage: ProgressStage, at: number | null, state: ProgressState, detail?: string) => {
    const item = stages.find(entry => entry.stage === stage);
    if (!item) return;
    item.at = at;
    item.state = state;
    if (detail) item.detail = detail;
  };

  // 判定：从开始到第一轮发出去之前。没有 round.started 但后面已经有阶段
  // （直接出计划、只执行）时，判定同样算走过了。
  const laterReached = synthesisAt !== null || executionAt !== null || reviewAt !== null;
  if (roundStart === null && !laterReached && startedAt !== null) {
    mark('routing', startedAt, failed ? 'failed' : 'active', failed ? '任务在这一段失败' : '正在判定任务类型与参与者');
  } else {
    mark('routing', startedAt, 'done');
  }

  if (roundStart !== null) {
    const synthesisReached = synthesisAt !== null || planReady !== null;
    mark('asking', roundStart, synthesisReached ? 'done' : failed ? 'failed' : 'active', roundPayload(events));
  }

  if (synthesisAt !== null) {
    const executionReached = executionAt !== null;
    mark('synthesis', synthesisAt, executionReached ? 'done' : failed ? 'failed' : 'active', '汇总各家回答，指定辩题或给出结论');
  }

  if (executionAt !== null) {
    const done = report !== null || review !== null;
    const detail = executionDetail(events);
    mark('execution', executionAt, done ? 'done' : failed ? 'failed' : 'active', detail);
  }

  if (reviewAt !== null) {
    mark('review', reviewAt, failed ? 'failed' : review !== null ? 'done' : 'active', reviewDetail(events));
  }

  const current = stages.find(entry => entry.state === 'active') ?? null;
  const endedAt =
    conversationStatus === 'answered' || taskStatus === 'completed'
      ? lastEventAt(events) ?? startedAt
      : failed
        ? lastEventAt(events) ?? startedAt
        : null;

  return {
    stages,
    current,
    elapsedMs: startedAt === null ? 0 : Math.max(0, (endedAt ?? Date.now()) - startedAt),
    endedAt
  };
}

function lastEventAt(events: readonly ProgressEventLike[]): number | null {
  return events.length > 0 ? events[events.length - 1].at : null;
}

function roundPayload(events: readonly ProgressEventLike[]): string | undefined {
  const started = lastOf(events, 'round.started');
  if (!started) return undefined;
  return '问题已发出，等待各家回答';
}

function executionDetail(events: readonly ProgressEventLike[]): string | undefined {
  const started = lastOf(events, 'step.started');
  if (!started || typeof started.index !== 'number' || typeof started.total !== 'number') {
    return '正在执行计划';
  }
  return `第 ${started.index}/${started.total} 步 · ${started.tool ?? ''}`.trim();
}

function reviewDetail(events: readonly ProgressEventLike[]): string | undefined {
  const review = lastOf(events, 'review.ready');
  if (!review) return '等待独立评审';
  return review.review?.needsFix ? '评审要求修复' : '评审通过';
}
