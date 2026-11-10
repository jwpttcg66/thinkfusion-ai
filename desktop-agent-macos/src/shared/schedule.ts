/**
 * 定时任务：只跑本地模型或云端 API，绝不发网页。
 *
 * 这条限制来自仓库既有规则：无人值守的东西不许发送提示词——网页会把它记进
 * 用户账号。所以 `mode` 只有两个值，没有 `web` 这个选项，schema 层就写死。
 *
 * 这一层是纯函数：什么时候该跑、下一次什么时候，能离线测，不依赖计时器。
 */

export type ScheduleMode = 'local' | 'cloud';

export interface Schedule {
  id: string;
  /** 到点要问的事，原样发给本地/云端模型。 */
  text: string;
  mode: ScheduleMode;
  /** 一次性任务：到这个时间点跑一次。 */
  at?: number;
  /** 重复任务：每隔多少分钟跑一次（最少 5 分钟）。 */
  repeatMinutes?: number;
  nextRunAt: number | null;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastError?: string;
}

export const MIN_REPEAT_MINUTES = 5;
export const MAX_SCHEDULES = 50;

/** 下一条运行时间；一次性任务跑过之后是 null。 */
export function computeNextRun(
  input: { at?: number; repeatMinutes?: number; lastRunAt?: number },
  now: number
): number | null {
  if (input.repeatMinutes && input.repeatMinutes >= MIN_REPEAT_MINUTES) {
    if (!input.lastRunAt) return input.at && input.at > now ? input.at : now + input.repeatMinutes * 60_000;
    return input.lastRunAt + input.repeatMinutes * 60_000;
  }
  if (input.at) return input.at > now ? input.at : now;
  return null;
}

export function isDue(schedule: Schedule, now: number): boolean {
  return schedule.enabled && schedule.nextRunAt !== null && schedule.nextRunAt <= now;
}

/** 到点之后推进到下一次；一次性任务禁用自己，不再触发。 */
export function advance(schedule: Schedule, now: number): Schedule {
  const ranAt = now;
  if (schedule.repeatMinutes && schedule.repeatMinutes >= MIN_REPEAT_MINUTES) {
    return {
      ...schedule,
      lastRunAt: ranAt,
      nextRunAt: ranAt + schedule.repeatMinutes * 60_000,
      enabled: true
    };
  }
  return { ...schedule, lastRunAt: ranAt, nextRunAt: null, enabled: false };
}

/** 校验 IPC/模型输入；只接受明确列出的字段。 */
export function normalizeScheduleInput(raw: unknown, now: number): Omit<Schedule, 'id' | 'createdAt'> {
  if (!raw || typeof raw !== 'object') throw new Error('定时任务参数无效');
  const input = raw as { text?: unknown; mode?: unknown; at?: unknown; repeatMinutes?: unknown };
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new Error('定时任务需要一句要问的事');
  if (text.length > 2000) throw new Error('定时任务的文字超过 2000 字');
  if (input.mode !== 'local' && input.mode !== 'cloud') {
    throw new Error('定时任务只能选 local 或 cloud：不碰网页');
  }
  const at = typeof input.at === 'number' ? input.at : undefined;
  const repeatMinutes = typeof input.repeatMinutes === 'number' ? input.repeatMinutes : undefined;
  if (at === undefined && repeatMinutes === undefined) throw new Error('要么给 at，要么给 repeatMinutes');
  if (repeatMinutes !== undefined && repeatMinutes < MIN_REPEAT_MINUTES) {
    throw new Error(`重复间隔不能短于 ${MIN_REPEAT_MINUTES} 分钟`);
  }
  const nextRunAt = computeNextRun({ at, repeatMinutes }, now);
  if (nextRunAt === null) throw new Error('算不出下一次运行时间');
  return {
    text,
    mode: input.mode,
    ...(at === undefined ? {} : { at }),
    ...(repeatMinutes === undefined ? {} : { repeatMinutes }),
    nextRunAt,
    enabled: true
  };
}
