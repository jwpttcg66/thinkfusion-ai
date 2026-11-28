/**
 * 目标聚合视图（V4 P1 M1-2）。
 *
 * 一个目标下常常挂着好几条任务：改一版目标重跑一次、同一目标补做一次，都是
 * 各自独立的任务。侧栏原先只按时间平铺，看不出「这几条说的是同一件事」，
 * 于是目标修订之后没人知道哪几条已经过期。
 *
 * 这里只做投影：分组用的 goalId/goalVersion 早就写在任务上（建任务时写入，
 * 修订时由 reviseGoal 重打），不新建 Goal 表、不改任何写入路径、不推断关系。
 * 任务上没记目标就落在「未绑定目标」一组——不把老任务硬塞给某个目标，
 * 那等于凭空造一层不存在的关系。
 */

/** 分组所需的最小任务形状：AgentTask 和侧栏行都能直接喂进来。 */
export interface GoalViewTask {
  taskId: string;
  title: string;
  status: string;
  updatedAt?: number;
  goalId?: string;
  goalVersion?: number;
  goalContract?: { goalId?: string; originalRequest?: string; goalVersion?: number; criteria?: readonly { description: string }[] };
}

export interface GoalGroup<T extends GoalViewTask> {
  /** 未绑定目标的那一组是 null，界面上如实写「未绑定目标」。 */
  goalId: string | null;
  /**
   * 目标标题：取该目标下版本号最高、且真写了契约原文的那条任务；
   * 一条都没写原文时退回组内最新任务的标题。不拼句子、不做摘要。
   */
  label: string;
  /** 该目标下出现过的版本，升序去重；老任务没记版本就不进这个列表。 */
  versions: number[];
  /** 是否是「未绑定目标」这一组。 */
  unbound: boolean;
  /** 组内最新活动时间；一条都没有则为 null，不用当前时间顶替。 */
  latestAt: number | null;
  /** 组内任务，按活动时间倒序；没有时间字段的保持原先后。 */
  items: T[];
}

/** 任务真正挂在哪条目标上：任务字段优先，其次契约正文里的 goalId。 */
export function goalIdOf(task: GoalViewTask): string | null {
  const fromTask = typeof task.goalId === 'string' ? task.goalId.trim() : '';
  if (fromTask) return fromTask;
  const fromContract = typeof task.goalContract?.goalId === 'string' ? task.goalContract.goalId.trim() : '';
  return fromContract || null;
}

/** 任务记的目标版本：任务字段优先，其次契约里的版本；都没记就返回 null，不顶成 v1。 */
export function goalVersionOf(task: GoalViewTask): number | null {
  const candidates = [task.goalVersion, task.goalContract?.goalVersion];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  }
  return null;
}

function timeOf(task: GoalViewTask): number | null {
  return typeof task.updatedAt === 'number' && Number.isFinite(task.updatedAt) ? task.updatedAt : null;
}

/**
 * 按目标聚合任务。
 *
 * 组的先后：有目标的按最新活动时间倒序，未绑定目标的一组永远排最后——
 * 它是历史遗留，不该挤在正经目标中间。
 */
export function groupTasksByGoal<T extends GoalViewTask>(tasks: readonly T[]): GoalGroup<T>[] {
  const buckets = new Map<string, T[]>();
  const unbound: T[] = [];
  for (const task of tasks ?? []) {
    const goalId = goalIdOf(task);
    if (goalId === null) {
      unbound.push(task);
      continue;
    }
    const list = buckets.get(goalId);
    if (list) list.push(task);
    else buckets.set(goalId, [task]);
  }

  const groups: GoalGroup<T>[] = [];
  for (const [goalId, list] of buckets) groups.push(build(goalId, list, false));
  if (unbound.length > 0) groups.push(build(null, unbound, true));

  return groups.sort((a, b) => {
    if (a.unbound !== b.unbound) return a.unbound ? 1 : -1;
    return (b.latestAt ?? -1) - (a.latestAt ?? -1);
  });
}

function build<T extends GoalViewTask>(goalId: string | null, list: T[], unbound: boolean): GoalGroup<T> {
  // 时间倒序；缺时间的任务保持在后，不拿 Date.now() 或 0 冒充一个时间点。
  const items = [...list].sort((a, b) => (timeOf(b) ?? -1) - (timeOf(a) ?? -1));
  const versions = [...new Set(items.map(goalVersionOf).filter((v): v is number => v !== null))].sort((a, b) => a - b);

  let label = '';
  let labelVersion = -1;
  for (const task of items) {
    const text = typeof task.goalContract?.originalRequest === 'string' ? task.goalContract.originalRequest.trim() : '';
    const version = goalVersionOf(task) ?? 0;
    if (text && version >= labelVersion) {
      labelVersion = version;
      label = text;
    }
  }
  if (!label) label = items[0]?.title ?? '';

  const times = items.map(timeOf).filter((t): t is number => t !== null);
  return {
    goalId,
    label: unbound ? '未绑定目标' : label,
    versions,
    unbound,
    latestAt: times.length > 0 ? Math.max(...times) : null,
    items
  };
}

/** 组头的版本描述：只有一个版本就写 v2，跨版本写 v1→v3，一个都没记就不写。 */
export function goalVersionLabel(group: Pick<GoalGroup<GoalViewTask>, 'versions'>): string {
  if (group.versions.length === 0) return '';
  const first = group.versions[0];
  const last = group.versions[group.versions.length - 1];
  return first === last ? `v${String(first)}` : `v${String(first)}→v${String(last)}`;
}

/** 目标下有几条任务还没收口，用于组头提示；口径由调用方给出，这里只做计数。 */
export function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
