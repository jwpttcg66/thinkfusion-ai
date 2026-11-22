/**
 * 事件身份补齐（V2.1 P1b）。
 *
 * 为什么要单独一个纯函数模块：工程工作台要按成员分列显示独立输出，也要能让一次
 * 工具调用的三个事件（preparing / started / completed|failed）聚成同一张卡。
 * 但真正能提供这些身份的是**不同层**：
 *
 * - `step.preparing` 由编排器发出，天然带 `roundId + callId`；
 * - `step.started/completed/failed` 由 Runtime 发回，只带 `stepId + tool`；
 * - `round.delta` 由编排器发出，一次请求一个 `streamId`。
 *
 * 于是身份在主干上补齐：把 `step.preparing` 的身份记下来，转发后续事件时只填**缺的**
 * 字段。这里只做机械补齐，不猜、不造：查不到就留空，读取方按「单成员/无轮次」退化。
 * 纯函数放在 shared，测试不用起 Electron。
 */
import type { AgentEvent } from './contracts';

export interface StepIdentity {
  roundId: string;
  callId: string;
  participantId?: string;
}

/** 同一任务里 stepId 可能跨计划复用，所以 key 带 taskId。 */
function keyOf(taskId: string, stepId: string): string {
  return `${taskId}\u0000${stepId}`;
}

/** 索引上限：只防内存无限长，不做 LRU——超出说明这份计划异常，清掉重记。 */
const MAX_ENTRIES = 2000;

/**
 * 把一条事件里的身份记进索引：只有 `step.preparing` 携带完整身份。
 * `plan.ready` 意味着新计划、新 stepId 空间，旧记录一律作废。
 */
export function rememberStepIdentity(index: Map<string, StepIdentity>, event: AgentEvent): void {
  if (event.type === 'plan.ready') {
    forgetTask(index, event.taskId);
    return;
  }
  if (event.type !== 'step.preparing') return;
  if (index.size >= MAX_ENTRIES) index.clear();
  index.set(keyOf(event.taskId, event.stepId), {
    roundId: event.roundId,
    callId: event.callId,
    ...(event.participantId ? { participantId: event.participantId } : {})
  });
}

/** 任务被删除或结束：丢掉它的步骤身份，别让旧 stepId 影响下一轮。 */
export function forgetTask(index: Map<string, StepIdentity>, taskId: string): void {
  const prefix = `${taskId}\u0000`;
  for (const key of [...index.keys()]) {
    if (key.startsWith(prefix)) index.delete(key);
  }
}

/**
 * 返回补齐后的事件；已有字段一律不覆盖。
 *
 * - `step.started/completed/failed` 缺 `roundId`/`callId` 时按索引补；
 * - `round.delta` 缺 `modelCallId` 时用 `streamId`（一次请求一个 id，本就是同一个东西）；
 * - `round.answer` 没有 streamId 可用，查不到就留空，不拿 roundId 顶替。
 */
export function applyEventIdentity(index: Map<string, StepIdentity>, event: AgentEvent): AgentEvent {
  if (event.type === 'step.started' || event.type === 'step.completed' || event.type === 'step.failed') {
    const known = index.get(keyOf(event.taskId, event.stepId));
    if (!known) return event;
    const needsRound = !event.roundId;
    const needsCall = !event.callId;
    if (!needsRound && !needsCall && event.participantId) return event;
    return {
      ...event,
      ...(needsRound ? { roundId: known.roundId } : {}),
      ...(needsCall ? { callId: known.callId } : {}),
      ...(event.participantId ? {} : known.participantId ? { participantId: known.participantId } : {})
    };
  }
  if (event.type === 'round.delta' && !event.modelCallId && event.streamId) {
    return { ...event, modelCallId: event.streamId };
  }
  return event;
}
