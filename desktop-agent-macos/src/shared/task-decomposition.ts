/**
 * Task Decomposition Layer（TDL）：WorkTask 契约、状态机、写入闸门与事件投影。
 *
 * 进度只从事件派生；禁止把模型自报百分比写成权威完成度。
 * 有 work.* 事件时以其为准；否则从 plan.ready + step.* 派生临时分解（可重放）。
 */

import type { AgentEvent, PlanPreview } from './contracts';

export const WORK_TASK_STATUSES = [
  'pending',
  'ready',
  'running',
  'blocked',
  'reviewing',
  'completed',
  'failed',
  'cancelled'
] as const;
export type WorkTaskStatus = (typeof WORK_TASK_STATUSES)[number];

export type WorkTaskComplexity = 'low' | 'medium' | 'high' | 'high_risk';

export interface WorkTaskEvidence {
  kind: 'execution_report' | 'test' | 'diagnostic' | 'commit' | 'note' | 'step_result';
  ref?: string;
  detail: string;
}

/** V2.0 四级：0=Work 1=TaskGroup 2=Subtask 3=PlanStep */
export type WorkTaskLevel = 0 | 1 | 2 | 3;

export interface WorkTask {
  workTaskId: string;
  workId: string;
  parentTaskId?: string | null;
  /** L0–L3；缺省按有无 parent / planStep 推断。 */
  level?: WorkTaskLevel;
  groupId?: string;
  title: string;
  description?: string;
  dependencies: string[];
  acceptanceCriteria: string[];
  assignedAgent?: string;
  status: WorkTaskStatus;
  priority?: string;
  complexity: WorkTaskComplexity;
  collaborationPolicy: {
    debate: 'off' | 'auto' | 'on';
    review: 'auto' | 'targeted' | 'independent';
  };
  cycleId?: string;
  agentTaskId?: string;
  planStepId?: string;
  artifacts: string[];
  evidence: WorkTaskEvidence[];
  blockedReason?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkTaskRow {
  workTaskId: string;
  title: string;
  priority?: string;
  status: WorkTaskStatus;
  dependsOn: string[];
  acceptanceMet: boolean;
  artifactCount: number;
  planStepId?: string;
  parentTaskId?: string | null;
  level: WorkTaskLevel;
  depth: number;
  source: 'work-events' | 'derived-from-plan';
}

export interface WorkBreakdownView {
  workId: string;
  title: string;
  status: 'idle' | 'running' | 'completed' | 'blocked' | 'failed';
  summary: {
    completed: number;
    total: number;
    /** 0–1，仅统计叶子（L2/L3）可验收任务；阻塞/取消不计完成。 */
    ratio: number;
    runningIds: string[];
    blockedIds: string[];
    failedIds: string[];
  };
  tasks: WorkTaskRow[];
  currentTaskId?: string;
  source: 'work-events' | 'derived-from-plan' | 'empty';
  projectedAt: number;
}

const TERMINAL: ReadonlySet<WorkTaskStatus> = new Set(['completed', 'cancelled']);

const ALLOWED: Record<WorkTaskStatus, readonly WorkTaskStatus[]> = {
  pending: ['ready', 'blocked', 'cancelled'],
  ready: ['running', 'blocked', 'cancelled'],
  running: ['reviewing', 'completed', 'failed', 'blocked', 'cancelled'],
  blocked: ['ready', 'cancelled', 'failed'],
  reviewing: ['completed', 'failed', 'ready', 'cancelled'],
  completed: [],
  failed: ['ready', 'cancelled'],
  cancelled: []
};

export function collaborationPolicyFor(complexity: WorkTaskComplexity): WorkTask['collaborationPolicy'] {
  switch (complexity) {
    case 'low':
      return { debate: 'off', review: 'auto' };
    case 'medium':
      return { debate: 'auto', review: 'targeted' };
    case 'high':
      return { debate: 'on', review: 'independent' };
    case 'high_risk':
      return { debate: 'on', review: 'independent' };
  }
}

export function canTransition(from: WorkTaskStatus, to: WorkTaskStatus): boolean {
  if (from === to) return true;
  return ALLOWED[from].includes(to);
}

export function dependenciesSatisfied(
  task: Pick<WorkTask, 'dependencies'>,
  byId: Map<string, Pick<WorkTask, 'status'>>
): boolean {
  return task.dependencies.every(id => byId.get(id)?.status === 'completed');
}

export function assertTransition(from: WorkTaskStatus, to: WorkTaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法状态迁移：${from} → ${to}`);
  }
}

export interface StatusUpdateInput {
  workTaskId: string;
  status: WorkTaskStatus;
  expectedRevision: number;
  evidence?: WorkTaskEvidence[];
  blockedReason?: string;
  at?: number;
}

/** 写入闸门：CAS、依赖、完成证据。返回更新后的任务。 */
export function applyWorkTaskStatus(
  tasks: readonly WorkTask[],
  input: StatusUpdateInput
): WorkTask[] {
  const list = tasks.map(item => ({ ...item, dependencies: [...item.dependencies], evidence: [...item.evidence], artifacts: [...item.artifacts] }));
  const index = list.findIndex(item => item.workTaskId === input.workTaskId);
  if (index < 0) throw new Error(`没有这个子任务：${input.workTaskId}`);
  const current = list[index]!;
  if ((current.revision ?? 1) !== input.expectedRevision) {
    throw new Error('CAS_CONFLICT');
  }
  if (input.status === 'running' || input.status === 'ready') {
    const byId = new Map(list.map(item => [item.workTaskId, item]));
    if (!dependenciesSatisfied(current, byId)) {
      throw new Error('依赖未完成，不能开工');
    }
  }
  assertTransition(current.status, input.status);
  if (input.status === 'completed') {
    const evidence = input.evidence?.length ? input.evidence : current.evidence;
    if (!evidence.length) throw new Error('完成必须带验收证据');
    current.evidence = evidence;
  }
  current.status = input.status;
  current.revision = (current.revision ?? 1) + 1;
  current.updatedAt = input.at ?? Date.now();
  if (input.status === 'blocked') current.blockedReason = input.blockedReason ?? current.blockedReason;
  if (input.status !== 'blocked') current.blockedReason = undefined;
  list[index] = current;
  return refreshReady(list);
}

export function upsertWorkTask(tasks: readonly WorkTask[], task: WorkTask): WorkTask[] {
  const list = tasks.map(item => ({ ...item }));
  const index = list.findIndex(item => item.workTaskId === task.workTaskId);
  if (index >= 0) list[index] = { ...task };
  else list.push({ ...task });
  return refreshReady(list);
}

function refreshReady(tasks: WorkTask[]): WorkTask[] {
  const byId = new Map(tasks.map(item => [item.workTaskId, item]));
  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    if (dependenciesSatisfied(task, byId)) {
      task.status = 'ready';
      task.updatedAt = Math.max(task.updatedAt, Date.now());
    }
  }
  return tasks;
}

/** 范围变更时，只返回变更点及其后继闭包。 */
export function impactedByReplan(tasks: readonly WorkTask[], changedIds: readonly string[]): string[] {
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      const list = children.get(dep) ?? [];
      list.push(task.workTaskId);
      children.set(dep, list);
    }
  }
  const out = new Set<string>(changedIds);
  const queue = [...changedIds];
  while (queue.length) {
    const id = queue.shift()!;
    for (const child of children.get(id) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return [...out];
}

function inferLevel(task: Pick<WorkTask, 'level' | 'parentTaskId' | 'planStepId'>): WorkTaskLevel {
  if (task.level === 0 || task.level === 1 || task.level === 2 || task.level === 3) return task.level;
  if (task.planStepId) return 3;
  if (task.parentTaskId) return 2;
  return 1;
}

function rowDepth(level: WorkTaskLevel): number {
  return Math.max(0, level - 1);
}

/** 真实进度：叶子任务完成数 / 活动叶子总数；group 不单独占分母。 */
export function progressRatioFromRows(rows: readonly WorkTaskRow[]): number {
  const leaves = rows.filter(item => item.level >= 2 && item.status !== 'cancelled');
  const pool = leaves.length > 0 ? leaves : rows.filter(item => item.status !== 'cancelled');
  if (pool.length === 0) return 0;
  const done = pool.filter(item => item.status === 'completed' && item.acceptanceMet).length;
  return done / pool.length;
}

function summarize(rows: WorkTaskRow[]): WorkBreakdownView['summary'] {
  const active = rows.filter(item => item.status !== 'cancelled' && item.level >= 2);
  const pool = active.length > 0 ? active : rows.filter(item => item.status !== 'cancelled');
  return {
    completed: pool.filter(item => item.status === 'completed').length,
    total: pool.length,
    ratio: progressRatioFromRows(rows),
    runningIds: rows.filter(item => item.status === 'running').map(item => item.workTaskId),
    blockedIds: rows.filter(item => item.status === 'blocked').map(item => item.workTaskId),
    failedIds: rows.filter(item => item.status === 'failed').map(item => item.workTaskId)
  };
}

function viewStatus(summary: WorkBreakdownView['summary'], rows: WorkTaskRow[]): WorkBreakdownView['status'] {
  if (summary.failedIds.length) return 'failed';
  if (summary.blockedIds.length) return 'blocked';
  if (summary.total > 0 && summary.completed === summary.total) return 'completed';
  if (summary.runningIds.length || rows.some(item => item.status === 'ready' || item.status === 'reviewing')) return 'running';
  return 'idle';
}

function currentTaskId(rows: WorkTaskRow[]): string | undefined {
  return rows.find(item => item.status === 'running')?.workTaskId
    ?? rows.find(item => item.status === 'ready')?.workTaskId
    ?? rows.find(item => item.status === 'reviewing')?.workTaskId;
}

/** 从 work.* 事件重建任务表（供写入侧读 revision / CAS）。 */
export function rebuildWorkTasksFromEvents(
  workId: string,
  events: readonly AgentEvent[]
): Map<string, WorkTask> {
  const tasks = new Map<string, WorkTask>();
  for (const event of events) {
    if (!('taskId' in event) || event.taskId !== workId) continue;
    if (event.type === 'work.task.upserted') {
      const prev = tasks.get(event.task.workTaskId);
      tasks.set(event.task.workTaskId, {
        ...event.task,
        revision: event.task.revision ?? prev?.revision ?? 1,
        dependencies: [...(event.task.dependencies ?? [])],
        acceptanceCriteria: [...(event.task.acceptanceCriteria ?? [])],
        artifacts: [...(event.task.artifacts ?? [])],
        evidence: [...(event.task.evidence ?? [])]
      });
    } else if (event.type === 'work.task.status') {
      const current = tasks.get(event.workTaskId);
      if (!current) continue;
      try {
        const next = applyWorkTaskStatus([...tasks.values()], {
          workTaskId: event.workTaskId,
          status: event.status,
          expectedRevision: event.expectedRevision,
          evidence: event.evidence,
          blockedReason: event.blockedReason,
          at: event.at
        });
        tasks.clear();
        for (const item of next) tasks.set(item.workTaskId, item);
      } catch {
        // 坏事件不炸投影：跳过非法迁移，保持可重放 UI。
      }
    } else if (event.type === 'work.task.blocked') {
      const current = tasks.get(event.workTaskId);
      if (!current) continue;
      try {
        const next = applyWorkTaskStatus([...tasks.values()], {
          workTaskId: event.workTaskId,
          status: 'blocked',
          expectedRevision: event.expectedRevision,
          blockedReason: event.reason,
          at: event.at
        });
        tasks.clear();
        for (const item of next) tasks.set(item.workTaskId, item);
      } catch {
        /* ignore */
      }
    } else if (event.type === 'work.task.accepted') {
      const current = tasks.get(event.workTaskId);
      if (!current) continue;
      try {
        const next = applyWorkTaskStatus([...tasks.values()], {
          workTaskId: event.workTaskId,
          status: 'completed',
          expectedRevision: event.expectedRevision,
          evidence: event.evidence,
          at: event.at
        });
        tasks.clear();
        for (const item of next) tasks.set(item.workTaskId, item);
      } catch {
        /* ignore */
      }
    }
  }
  return tasks;
}

function projectFromWorkEvents(workId: string, events: readonly AgentEvent[], title: string): WorkBreakdownView | null {
  let breakdownTitle = title;
  let saw = false;
  for (const event of events) {
    if (!('taskId' in event) || event.taskId !== workId) continue;
    if (
      event.type === 'work.breakdown.created' ||
      event.type === 'work.task.upserted' ||
      event.type === 'work.task.status' ||
      event.type === 'work.task.blocked' ||
      event.type === 'work.task.accepted'
    ) {
      saw = true;
    }
    if (event.type === 'work.breakdown.created') {
      breakdownTitle = event.title || breakdownTitle;
    }
  }
  const tasks = rebuildWorkTasksFromEvents(workId, events);
  if (!saw) return null;
  const rows: WorkTaskRow[] = [...tasks.values()].map(task => {
    const level = inferLevel(task);
    return {
      workTaskId: task.workTaskId,
      title: task.title,
      priority: task.priority,
      status: task.status,
      dependsOn: task.dependencies,
      acceptanceMet: task.status === 'completed' && task.evidence.length > 0,
      artifactCount: task.artifacts.length,
      planStepId: task.planStepId,
      parentTaskId: task.parentTaskId ?? null,
      level,
      depth: rowDepth(level),
      source: 'work-events' as const
    };
  }).sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.workTaskId.localeCompare(b.workTaskId);
  });
  const summary = summarize(rows);
  return {
    workId,
    title: breakdownTitle,
    status: viewStatus(summary, rows),
    summary,
    tasks: rows,
    currentTaskId: currentTaskId(rows),
    source: 'work-events',
    projectedAt: Date.now()
  };
}

function deriveFromPlanAndSteps(workId: string, events: readonly AgentEvent[], title: string): WorkBreakdownView {
  let plan: PlanPreview | null = null;
  const stepState = new Map<string, WorkTaskStatus>();
  for (const event of events) {
    if (!('taskId' in event) || event.taskId !== workId) continue;
    if (event.type === 'plan.ready') {
      plan = event.plan;
      for (const step of event.plan.steps) {
        if (!stepState.has(step.id)) stepState.set(step.id, 'pending');
      }
    } else if (event.type === 'step.started' || event.type === 'step.preparing') {
      const id = event.stepId;
      if (stepState.has(id) || plan?.steps.some(step => step.id === id)) {
        stepState.set(id, event.type === 'step.started' ? 'running' : (stepState.get(id) === 'completed' ? 'completed' : 'ready'));
      }
    } else if (event.type === 'step.completed') {
      stepState.set(event.stepId, 'completed');
    } else if (event.type === 'step.failed') {
      stepState.set(event.stepId, 'failed');
    }
  }
  if (!plan || plan.steps.length === 0) {
    return {
      workId,
      title,
      status: 'idle',
      summary: { completed: 0, total: 0, ratio: 0, runningIds: [], blockedIds: [], failedIds: [] },
      tasks: [],
      source: 'empty',
      projectedAt: Date.now()
    };
  }
  const rows: WorkTaskRow[] = plan.steps.map((step, index) => {
    const dependsOn = index === 0 ? [] : [plan!.steps[index - 1]!.id].map(id => `wt-${id}`);
    let status = stepState.get(step.id) ?? 'pending';
    if (status === 'pending' && index === 0) status = 'ready';
    if (status === 'pending' && index > 0) {
      const prev = stepState.get(plan!.steps[index - 1]!.id);
      if (prev === 'completed') status = 'ready';
    }
    return {
      workTaskId: `wt-${step.id}`,
      title: step.description?.trim() || step.tool,
      status,
      dependsOn,
      acceptanceMet: status === 'completed',
      artifactCount: 0,
      planStepId: step.id,
      parentTaskId: null,
      level: 3 as WorkTaskLevel,
      depth: 2,
      source: 'derived-from-plan' as const
    };
  });
  const summary = summarize(rows);
  return {
    workId,
    title: plan.title || title,
    status: viewStatus(summary, rows),
    summary,
    tasks: rows,
    currentTaskId: currentTaskId(rows),
    source: 'derived-from-plan',
    projectedAt: Date.now()
  };
}

export function projectWorkBreakdownFromEvents(input: {
  workId: string;
  events: readonly AgentEvent[];
  title?: string;
}): WorkBreakdownView {
  const title = input.title?.trim() || input.workId;
  const fromWork = projectFromWorkEvents(input.workId, input.events, title);
  if (fromWork) return fromWork;
  return deriveFromPlanAndSteps(input.workId, input.events, title);
}

/** 从计划步骤生成显式 work.* 种子事件（L1 组 + L3 步骤，挂父子）。 */
export function seedWorkEventsFromPlan(input: {
  workId: string;
  title: string;
  plan: PlanPreview;
  at?: number;
  cycleId?: string;
}): AgentEvent[] {
  const at = input.at ?? Date.now();
  const events: AgentEvent[] = [
    { type: 'work.breakdown.created', at, taskId: input.workId, workId: input.workId, title: input.title || input.plan.title }
  ];
  const groupId = `wt-group-${input.workId.slice(0, 8)}`;
  const group: WorkTask = {
    workTaskId: groupId,
    workId: input.workId,
    parentTaskId: null,
    level: 1,
    title: '执行计划',
    description: input.title || input.plan.title,
    dependencies: [],
    acceptanceCriteria: ['下属步骤全部完成并有验收证据'],
    status: 'ready',
    priority: 'G1',
    complexity: 'low',
    collaborationPolicy: collaborationPolicyFor('low'),
    cycleId: input.cycleId,
    artifacts: [],
    evidence: [],
    revision: 1,
    createdAt: at,
    updatedAt: at
  };
  events.push({ type: 'work.task.upserted', at, taskId: input.workId, workId: input.workId, task: group });
  input.plan.steps.forEach((step, index) => {
    const workTaskId = `wt-${step.id}`;
    const dependencies = index === 0 ? [] : [`wt-${input.plan.steps[index - 1]!.id}`];
    const complexity: WorkTaskComplexity = 'low';
    const task: WorkTask = {
      workTaskId,
      workId: input.workId,
      parentTaskId: groupId,
      level: 3,
      groupId,
      title: step.description?.trim() || step.tool,
      description: step.description,
      dependencies,
      acceptanceCriteria: [`步骤 ${step.tool} 执行完成`],
      status: index === 0 ? 'ready' : 'pending',
      priority: `S${index + 1}`,
      complexity,
      collaborationPolicy: collaborationPolicyFor(complexity),
      cycleId: input.cycleId,
      planStepId: step.id,
      artifacts: [],
      evidence: [],
      revision: 1,
      createdAt: at,
      updatedAt: at
    };
    events.push({ type: 'work.task.upserted', at, taskId: input.workId, workId: input.workId, task });
  });
  return events;
}

export function workStatusEventFromStep(input: {
  workId: string;
  stepId: string;
  phase: 'started' | 'completed' | 'failed';
  expectedRevision: number;
  at?: number;
  detail?: string;
}): AgentEvent {
  const status: WorkTaskStatus = input.phase === 'started' ? 'running' : input.phase === 'completed' ? 'completed' : 'failed';
  return {
    type: 'work.task.status',
    at: input.at ?? Date.now(),
    taskId: input.workId,
    workId: input.workId,
    workTaskId: `wt-${input.stepId}`,
    status,
    expectedRevision: input.expectedRevision,
    evidence: input.phase === 'completed'
      ? [{ kind: 'step_result', ref: input.stepId, detail: input.detail ?? `步骤 ${input.stepId} 已完成` }]
      : undefined
  };
}

export function isTerminalWorkStatus(status: WorkTaskStatus): boolean {
  return TERMINAL.has(status);
}
