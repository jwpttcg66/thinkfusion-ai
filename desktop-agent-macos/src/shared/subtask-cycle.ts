/**
 * 子任务独立 Cycle（P1-02）。
 *
 * 以前一个工程任务只有一条执行链：L2 子任务只是进度树上的分组，进度、失败、
 * 结论都归到整条任务上——一个子任务改坏了，整个工程跟着重跑。
 *
 * 这里给每个 L2 一条自己的循环（分析→设计→实现→审核），但**不新建调度器**：
 * - 周期从既有 WorkTask 事件派生，步骤生命周期仍由 Runtime 发；
 * - 失败只把「依赖它的子任务」标 blocked，其余子任务结论照常成立；
 * - 主任务集成时能看到每个子任务的结论与跨子任务的写冲突。
 */

import type { AgentEvent } from './contracts';
import type { WorkTask, WorkTaskStatus } from './task-decomposition';

export type SubtaskCycleStage = 'analysis' | 'design' | 'implementation' | 'review' | 'done';
export type SubtaskCycleVerdict = 'pending' | 'accepted' | 'failed' | 'blocked' | 'skipped';

export interface SubtaskCycleView {
  cycleId: string;
  workId: string;
  workTaskId: string;
  title: string;
  stage: SubtaskCycleStage;
  /** 已经走完的阶段；分析/设计随计划定稿，不假装又跑了一遍。 */
  stagesCompleted: SubtaskCycleStage[];
  status: WorkTaskStatus;
  verdict: SubtaskCycleVerdict;
  blockedBy: string[];
  stepIds: string[];
  completedStepIds: string[];
  failedStepIds: string[];
  notes: string[];
  updatedAt: number;
}

export interface SubtaskCyclePlan {
  cycles: SubtaskCycleView[];
  /** 按依赖排序后的子任务 id；有环时保持定义顺序并写 note。 */
  order: string[];
  /** 依赖没满足的子任务：现在不能执行，也不该被算作「失败」。 */
  blocked: Array<{ workTaskId: string; blockedBy: string[] }>;
  notes: string[];
}

export interface SubtaskConflict {
  path: string;
  workTaskIds: string[];
  stepIds: string[];
  reason: string;
}

export interface SubtaskIntegration {
  total: number;
  accepted: number;
  failed: number;
  blocked: number;
  pending: number;
  skipped: number;
  allAccepted: boolean;
  summary: string;
}

export function subtaskCycleId(workId: string, workTaskId: string): string {
  return `cycle:${workId}:${workTaskId}`;
}

const FORMAL_L2 = (task: WorkTask): boolean => {
  const level = task.level ?? (task.parentTaskId ? 3 : 0);
  return level === 2;
};

/** 子任务的执行步骤：自己的 planStepId + 挂在它下面的 L3。 */
function stepsOf(task: WorkTask, tasks: readonly WorkTask[]): string[] {
  const out: string[] = [];
  if (task.planStepId) out.push(task.planStepId);
  for (const child of tasks) {
    if (child.parentTaskId !== task.workTaskId) continue;
    const level = child.level ?? 3;
    if (level !== 3) continue;
    if (child.planStepId) out.push(child.planStepId);
  }
  return [...new Set(out)];
}

function verdictOf(status: WorkTaskStatus): SubtaskCycleVerdict {
  switch (status) {
    case 'completed':
      return 'accepted';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
    case 'skipped':
      return 'skipped';
    default:
      return 'pending';
  }
}

function stageOf(status: WorkTaskStatus): SubtaskCycleStage {
  switch (status) {
    case 'reviewing':
      return 'review';
    case 'completed':
      return 'done';
    default:
      return 'implementation';
  }
}

/**
 * 从 WorkTask 树建每个 L2 的循环。
 *
 * 「分析/设计已完成」写在 stagesCompleted 里并附注来源：这两段是计划阶段定稿的，
 * 不是又跑了一次——不这么写就会凭空多出两个「完成」的假阶段。
 *
 * 状态以步骤事实为准：Runtime 只给 L3 写生命周期事件，L2 的「全部步骤完成」
 * 要靠这里归纳。否则进度树上子任务永远停在 pending，结论也永远算「未完成」。
 */
export function buildSubtaskCycles(input: {
  workId: string;
  tasks: readonly WorkTask[];
  at?: number;
}): SubtaskCyclePlan {
  const at = input.at ?? Date.now();
  const l2 = input.tasks.filter(FORMAL_L2);
  const notes: string[] = [];
  const byId = new Map(l2.map(task => [task.workTaskId, task]));
  const stepsOfTask = new Map<string, WorkTask[]>();
  for (const task of input.tasks) {
    const level = task.level ?? (task.parentTaskId ? 3 : 0);
    if (level !== 3 || !task.parentTaskId) continue;
    const list = stepsOfTask.get(task.parentTaskId) ?? [];
    list.push(task);
    stepsOfTask.set(task.parentTaskId, list);
  }
  const effectiveStatus = (task: WorkTask): WorkTaskStatus => {
    if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'skipped') return task.status;
    const children = stepsOfTask.get(task.workTaskId) ?? [];
    if (children.length === 0) return task.status;
    if (children.some(child => child.status === 'failed')) return 'failed';
    if (children.every(child => child.status === 'completed')) return 'completed';
    if (children.some(child => child.status === 'running')) return 'running';
    return task.status;
  };
  const cycles = l2.map(task => {
    const status = effectiveStatus(task);
    const stage = stageOf(status);
    const steps = stepsOf(task, input.tasks);
    const completed = status === 'completed'
      ? [...steps]
      : steps.filter(stepId => input.tasks.some(child => child.planStepId === stepId && child.status === 'completed'));
    const failed = steps.filter(stepId => input.tasks.some(child => child.planStepId === stepId && child.status === 'failed'));
    const stagesCompleted: SubtaskCycleStage[] = ['analysis', 'design'];
    if (stage === 'review' || stage === 'done') stagesCompleted.push('implementation');
    if (stage === 'done') stagesCompleted.push('review');
    return {
      cycleId: task.cycleId ?? subtaskCycleId(input.workId, task.workTaskId),
      workId: input.workId,
      workTaskId: task.workTaskId,
      title: task.title,
      stage,
      stagesCompleted,
      status,
      verdict: verdictOf(status),
      blockedBy: status === 'blocked'
        ? task.dependencies.filter(dep => byId.has(dep))
        : [],
      stepIds: steps,
      completedStepIds: completed,
      failedStepIds: failed,
      notes: [
        '分析/设计随计划定稿完成，不在子任务里另跑一遍',
        ...(steps.length === 0 ? ['没有绑定执行步骤：这个子任务无法独立验收'] : [])
      ],
      updatedAt: at
    } satisfies SubtaskCycleView;
  });

  // 依赖序：只排 L2 之间的依赖；有环就照定义顺序，并如实写出来。
  const order: string[] = [];
  const indegree = new Map<string, number>();
  for (const task of l2) {
    indegree.set(task.workTaskId, task.dependencies.filter(dep => byId.has(dep)).length);
  }
  const queue = l2.filter(task => (indegree.get(task.workTaskId) ?? 0) === 0).map(task => task.workTaskId);
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const task of l2) {
      if (!task.dependencies.includes(id)) continue;
      const next = (indegree.get(task.workTaskId) ?? 0) - 1;
      indegree.set(task.workTaskId, next);
      if (next === 0) queue.push(task.workTaskId);
    }
  }
  if (order.length !== l2.length) {
    notes.push('L2 依赖存在环：执行顺序退回定义顺序');
    for (const task of l2) if (!order.includes(task.workTaskId)) order.push(task.workTaskId);
  }

  const blocked = l2
    .filter(task => (task.dependencies ?? []).some(dep => {
      const depTask = byId.get(dep);
      return depTask !== undefined && depTask.status !== 'completed' && depTask.status !== 'skipped';
    }))
    .map(task => ({
      workTaskId: task.workTaskId,
      blockedBy: task.dependencies.filter(dep => {
        const depTask = byId.get(dep);
        return depTask !== undefined && depTask.status !== 'completed' && depTask.status !== 'skipped';
      })
    }));

  return { cycles, order, blocked, notes };
}

/**
 * 单步推进一个子任务循环。步骤不属于它时原样返回（changed=false），
 * 避免把别的子任务的成败记到这一条上。
 */
export function advanceSubtaskCycle(
  view: SubtaskCycleView,
  event: {
    kind: 'step.started' | 'step.completed' | 'step.failed';
    stepId: string;
    at: number;
    error?: string;
  }
): { view: SubtaskCycleView; changed: boolean } {
  if (!view.stepIds.includes(event.stepId)) return { view, changed: false };
  // 已经定论的子任务不再被后到的步骤事件改写：迟到的 started 不能把「已通过」拉回实现中。
  if (view.verdict === 'accepted' || view.verdict === 'skipped') return { view, changed: false };
  const next: SubtaskCycleView = {
    ...view,
    completedStepIds: [...view.completedStepIds],
    failedStepIds: [...view.failedStepIds],
    notes: [...view.notes],
    updatedAt: event.at
  };
  if (event.kind === 'step.started') {
    next.stage = 'implementation';
    if (next.verdict === 'blocked') next.verdict = 'pending';
    next.blockedBy = [];
  } else if (event.kind === 'step.completed') {
    if (!next.completedStepIds.includes(event.stepId)) next.completedStepIds.push(event.stepId);
    if (next.stepIds.every(id => next.completedStepIds.includes(id))) {
      next.stage = 'review';
      if (!next.stagesCompleted.includes('implementation')) next.stagesCompleted.push('implementation');
    }
  } else {
    if (!next.failedStepIds.includes(event.stepId)) next.failedStepIds.push(event.stepId);
    if (!next.stagesCompleted.includes('implementation')) next.stagesCompleted.push('implementation');
    next.verdict = 'failed';
    if (event.error) next.notes.push(`失败：${event.error.slice(0, 200)}`);
  }
  return { view: next, changed: true };
}

/** 失败子任务的直接与间接依赖者：只标 blocked，不判它们失败。 */
export function dependentSubtasksToBlock(
  tasks: readonly WorkTask[],
  failedWorkTaskId: string
): string[] {
  const l2 = tasks.filter(FORMAL_L2);
  const out = new Set<string>();
  const frontier = [failedWorkTaskId];
  while (frontier.length > 0) {
    const current = frontier.shift()!;
    for (const task of l2) {
      if (task.workTaskId === failedWorkTaskId || out.has(task.workTaskId)) continue;
      if (!task.dependencies.includes(current)) continue;
      out.add(task.workTaskId);
      frontier.push(task.workTaskId);
    }
  }
  return [...out];
}

function writeTargetOf(tool: string, args: Record<string, unknown>): string | null {
  if (!/(writeFile|mkdir|remove|rename|move|patch)$/.test(tool)) return null;
  const raw = args.path ?? args.to ?? args.target;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.replaceAll('\\', '/').replace(/^\.\//, '');
}

/**
 * 跨子任务写冲突：两个子任务都要写同一个文件，就必须在主任务里显式看到。
 * 同一子任务里的多次写入不算冲突（那是它自己的实现过程）。
 */
export function detectSubtaskConflicts(input: {
  cycles: readonly SubtaskCycleView[];
  results: ReadonlyArray<{ stepId: string; tool: string; args?: Record<string, unknown> }>;
}): SubtaskConflict[] {
  const owners = new Map<string, { workTaskId: string; stepId: string }[]>();
  const cycleByStep = new Map<string, string>();
  for (const cycle of input.cycles) {
    for (const stepId of cycle.stepIds) cycleByStep.set(stepId, cycle.workTaskId);
  }
  for (const result of input.results) {
    const workTaskId = cycleByStep.get(result.stepId);
    if (!workTaskId) continue;
    const target = writeTargetOf(result.tool, result.args ?? {});
    if (!target) continue;
    const list = owners.get(target) ?? [];
    list.push({ workTaskId, stepId: result.stepId });
    owners.set(target, list);
  }
  const conflicts: SubtaskConflict[] = [];
  for (const [target, list] of owners) {
    const distinct = [...new Set(list.map(item => item.workTaskId))];
    if (distinct.length < 2) continue;
    conflicts.push({
      path: target,
      workTaskIds: distinct,
      stepIds: [...new Set(list.map(item => item.stepId))],
      reason: `${String(distinct.length)} 个子任务都写入 ${target}：需要确认顺序或拆开文件`
    });
  }
  return conflicts;
}

/** 主任务集成：子任务结论汇总成一句可核对的话，而不是「大体完成」。 */
export function integrateSubtaskCycles(cycles: readonly SubtaskCycleView[]): SubtaskIntegration {
  const count = (verdict: SubtaskCycleVerdict) => cycles.filter(item => item.verdict === verdict).length;
  const accepted = count('accepted');
  const failed = count('failed');
  const blocked = count('blocked');
  const pending = count('pending');
  const skipped = count('skipped');
  const allAccepted = cycles.length > 0 && accepted === cycles.length;
  const parts = [
    `共 ${String(cycles.length)} 个子任务`,
    `通过 ${String(accepted)}`,
    ...(failed > 0 ? [`失败 ${String(failed)}`] : []),
    ...(blocked > 0 ? [`受阻 ${String(blocked)}`] : []),
    ...(pending > 0 ? [`未完成 ${String(pending)}`] : []),
    ...(skipped > 0 ? [`跳过 ${String(skipped)}`] : [])
  ];
  return { total: cycles.length, accepted, failed, blocked, pending, skipped, allAccepted, summary: parts.join(' · ') };
}

/**
 * 从事件重放每个子任务的循环。
 *
 * 先把步骤生命周期还原到 L3 任务状态，再按任务树归纳 L2 的循环——这样
 * 「步骤全完成但 L2 没有终态事件」也能得出 `accepted`。落库的
 * `cycle.subtask.snapshot` 比由步骤重算更权威（它带中止原因），后到者覆盖。
 */
export function projectSubtaskCyclesFromEvents(input: {
  workId: string;
  tasks: readonly WorkTask[];
  events: readonly AgentEvent[];
  at?: number;
}): SubtaskCyclePlan {
  const ordered = [...input.events]
    .filter(event => 'taskId' in event && event.taskId === input.workId)
    .sort((a, b) => a.at - b.at);
  const byId = new Map<string, WorkTask>(input.tasks.map(task => [task.workTaskId, { ...task }]));
  const stepTask = new Map<string, WorkTask>();
  for (const task of input.tasks) {
    if (task.planStepId) stepTask.set(task.planStepId, task);
  }
  const snapshots = new Map<string, SubtaskCycleView>();
  const applyStep = (stepId: string, status: WorkTaskStatus): void => {
    const task = stepTask.get(stepId);
    if (!task) return;
    const current = byId.get(task.workTaskId);
    if (!current) return;
    byId.set(task.workTaskId, { ...current, status });
  };
  for (const event of ordered) {
    if (event.type === 'step.started') {
      const stepId = 'stepId' in event ? event.stepId : '';
      if (stepId) applyStep(stepId, 'running');
      continue;
    }
    if (event.type === 'step.completed') {
      const stepId = 'stepId' in event ? event.stepId : '';
      if (stepId) applyStep(stepId, 'completed');
      continue;
    }
    if (event.type === 'step.failed') {
      const stepId = 'stepId' in event ? event.stepId : '';
      if (stepId) applyStep(stepId, 'failed');
      continue;
    }
    if (event.type === 'cycle.subtask.snapshot') {
      snapshots.set(event.workTaskId, event.cycle as SubtaskCycleView);
      continue;
    }
    if (event.type === 'work.task.upserted') {
      byId.set(event.task.workTaskId, { ...event.task });
      if (event.task.planStepId) stepTask.set(event.task.planStepId, event.task);
      continue;
    }
    if (event.type === 'work.task.status') {
      const current = byId.get(event.workTaskId);
      if (!current) continue;
      byId.set(event.workTaskId, { ...current, status: event.status });
    }
  }
  const plan = buildSubtaskCycles({
    workId: input.workId,
    tasks: [...byId.values()],
    ...(input.at === undefined ? {} : { at: input.at })
  });
  const views = new Map(plan.cycles.map(cycle => [cycle.workTaskId, cycle]));
  for (const [id, snapshot] of snapshots) views.set(id, snapshot);
  return {
    cycles: plan.order.map(id => views.get(id)!).filter(Boolean),
    order: plan.order,
    blocked: plan.blocked,
    notes: plan.notes
  };
}
