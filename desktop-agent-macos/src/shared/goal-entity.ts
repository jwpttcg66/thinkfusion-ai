/**
 * 目标实体与懒迁移（V4 P1 M1-2）。
 *
 * 一个目标下挂多条任务后，版本与成功标准不能再由某一条任务单独持有：从 A 改
 * 目标只抬 A 的版本，B 还停在旧口径，侧栏看着是同一目标、跑的却是两个版本。
 * 所以目标口径落到 `store.goals` 这一份实体上，任务上的 `goalContract` 降级成
 * 快照（GCE 取证链路照旧读它）。
 *
 * 老数据里没有实体，只有任务快照：这里按侧栏同一口径（版本最高且真写了标准的
 * 那条任务）派生一份，不批量刷盘、不给没记版本的任务编一个 v1。
 */

import { goalIdOf, goalVersionOf, type GoalViewTask } from './goal-view';

/** `store.goals` 里那条实体的最小形状。 */
export interface StoredGoalShape {
  goalId: string;
  title: string;
  version: number;
  criteria: readonly string[];
  updatedAt: number;
}

export interface GoalEntity {
  goalId: string;
  /** 目标原文；没有依据时是空串，不拿任务标题冒充目标原文。 */
  title: string;
  /** 没有任何一条任务记过版本时为 null，不顶成 v1。 */
  version: number | null;
  criteria: string[];
  /** 组内最新活动时间；一条都没有时为 null。 */
  updatedAt: number | null;
  /** 这份口径的真实来源，界面与日志要能说清它是哪来的。 */
  source: 'stored' | 'contract' | 'none';
  /** 当前挂在这个目标下的任务。 */
  taskIds: string[];
}

export function tasksUnderGoal<T extends GoalViewTask>(goalId: string, tasks: readonly T[]): T[] {
  return tasks.filter(task => goalIdOf(task) === goalId);
}

/**
 * 取这个目标当前的口径：落库实体优先，没有才从任务契约快照派生。
 *
 * 派生口径与 `groupTasksByGoal` 的组标题一致——同一份事实只能有一套算法，
 * 否则侧栏显示的目标和确认卡里改的就是两个东西。
 */
export function resolveGoalEntity<T extends GoalViewTask>(input: {
  goalId: string;
  stored?: StoredGoalShape | null;
  tasks: readonly T[];
}): GoalEntity {
  const bound = tasksUnderGoal(input.goalId, input.tasks);
  const taskIds = bound.map(task => task.taskId);
  const times = bound
    .map(task => task.updatedAt)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const latestAt = times.length > 0 ? Math.max(...times) : null;

  const stored = input.stored ?? null;
  if (stored) {
    return {
      goalId: input.goalId,
      title: stored.title,
      version: Number.isFinite(stored.version) ? Math.trunc(stored.version) : null,
      criteria: stored.criteria.map(item => item.trim()).filter(Boolean),
      updatedAt: stored.updatedAt,
      source: 'stored',
      taskIds
    };
  }

  let best: T | null = null;
  let bestVersion = -1;
  for (const task of bound) {
    if ((task.goalContract?.criteria ?? []).length === 0) continue;
    const version = goalVersionOf(task) ?? 0;
    if (version >= bestVersion) {
      bestVersion = version;
      best = task;
    }
  }
  if (!best) {
    const versions = bound
      .map(task => goalVersionOf(task))
      .filter((value): value is number => value !== null);
    return {
      goalId: input.goalId,
      title: '',
      version: versions.length > 0 ? Math.max(...versions) : null,
      criteria: [],
      updatedAt: latestAt,
      source: 'none',
      taskIds
    };
  }
  return {
    goalId: input.goalId,
    title: (best.goalContract?.originalRequest ?? '').trim(),
    version: goalVersionOf(best) ?? (best.goalContract?.goalVersion ?? null),
    criteria: (best.goalContract?.criteria ?? []).map(item => item.description.trim()).filter(Boolean),
    updatedAt: latestAt,
    source: 'contract',
    taskIds
  };
}
