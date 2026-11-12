/**
 * 会话任务板：DAG、CAS、完成证据、工作区串行规则。
 *
 * 这一层只做纯计算，不读 store、不调模型。主进程 handler 负责持久化，
 * 这里负责让「依赖没完成就开工」「拿旧 revision 覆盖」「没有证据就 done」
 * 在写盘之前失败，而不是事后靠一句 note 解释。
 *
 * 不是第二套任务系统：任务仍然存在 `Conversation.teamTasks` 里，和会话
 * 同生共死；`ExecutionReport` 仍然是执行结果的账本，证据可以指向它。
 */

import type { ConversationTeamTask, TeamTaskEvidence } from '../shared/conversation';

export type TeamTaskMode = 'read' | 'write';

export interface CreateTeamTaskInput {
  id: string;
  title: string;
  detail?: string;
  assignee?: string;
  /** 必须先完成的任务 id；创建时逐个校验存在且不重复。 */
  dependsOn?: string[];
  mode?: TeamTaskMode;
  /** 这条任务允许动的目录；write 任务用它做串行隔离。 */
  workspace?: string;
}

export interface UpdateTeamTaskInput {
  id: string;
  status: ConversationTeamTask['status'];
  /** 调用方拿到的 revision；不一致就是有人改过，拒绝覆盖。 */
  expectedRevision: number;
  note?: string;
  evidence?: TeamTaskEvidence[];
  workspace?: string;
}

export interface TeamProgress {
  total: number;
  done: number;
  /** 依赖都完成、可以开工的任务。 */
  ready: ConversationTeamTask[];
  /** 依赖还没完成的任务，带缺哪些 id。 */
  blocked: Array<{ task: ConversationTeamTask; missing: string[] }>;
  remaining: Array<{ id: string; title: string; status: ConversationTeamTask['status'] }>;
}

export class TeamBoardError extends Error {
  constructor(
    readonly code:
      | 'TASK_NOT_FOUND'
      | 'UNKNOWN_DEPENDENCY'
      | 'DUPLICATE_DEPENDENCY'
      | 'CAS_CONFLICT'
      | 'DEPENDENCY_BLOCKED'
      | 'EVIDENCE_REQUIRED'
      | 'WORKSPACE_BUSY'
      | 'UNKNOWN_PARENT'
      | 'MEMBER_CYCLE',
    message: string
  ) {
    super(message);
    this.name = 'TeamBoardError';
  }
}


/**
 * 成员树只记录显式父子关系；父级必须已经在这次协作里，且不能成环。
 * 这里不创建新成员：成员仍然来自现有参与者 id。
 */
export function mergeTeamRoster(
  currentMembers: readonly string[],
  currentParents: Readonly<Record<string, string>>,
  additions: readonly string[],
  parent?: string
): { members: string[]; parents: Record<string, string> } {
  const members = [...new Set([...currentMembers, ...additions])];
  if (parent && !members.includes(parent)) {
    throw new TeamBoardError('UNKNOWN_PARENT', `上级成员不在这次协作里：${parent}`);
  }
  const parents = { ...currentParents };
  const existing = new Set(currentMembers);
  if (parent) {
    // 只为这次新登记的成员写父级；已经存在的成员不重挂，避免把树改出环。
    for (const member of additions) {
      if (member === parent || existing.has(member)) continue;
      parents[member] = parent;
    }
  }
  for (const member of Object.keys(parents)) {
    const seen = new Set<string>();
    let cursor: string | undefined = member;
    while (cursor) {
      if (seen.has(cursor)) throw new TeamBoardError('MEMBER_CYCLE', '成员树不能成环');
      seen.add(cursor);
      cursor = parents[cursor];
    }
  }
  return { members, parents };
}

export function taskRevision(task: ConversationTeamTask): number {
  return Number.isInteger(task.revision) && (task.revision ?? 0) > 0 ? task.revision! : 1;
}

function dependencyIds(task: ConversationTeamTask): string[] {
  return [...new Set(task.dependsOn ?? [])];
}

function missingDependencies(tasks: readonly ConversationTeamTask[], task: ConversationTeamTask): string[] {
  const byId = new Map(tasks.map(item => [item.id, item]));
  return dependencyIds(task).filter(id => byId.get(id)?.status !== 'done');
}

function assertDependenciesDone(tasks: readonly ConversationTeamTask[], task: ConversationTeamTask): void {
  const missing = missingDependencies(tasks, task);
  if (missing.length > 0) {
    throw new TeamBoardError(
      'DEPENDENCY_BLOCKED',
      `DEPENDENCY_BLOCKED：${task.id} 还依赖未完成的任务 ${missing.join('、')}`
    );
  }
}

function workspaceOf(task: ConversationTeamTask, fallback?: string): string {
  const value = (task.workspace ?? fallback ?? '').trim();
  // 同一个目录写成 /repo 与 /repo/ 时不能算两个工作区。
  return value.length > 1 ? value.replace(/[\\/]+$/, '') : value;
}

/** write 任务在有重叠工作区时只能有一个 doing；只读任务可以共享。 */
function assertWorkspaceAvailable(
  tasks: readonly ConversationTeamTask[],
  task: ConversationTeamTask,
  workspaceRoot?: string
): void {
  if (task.mode !== 'write') return;
  const workspace = workspaceOf(task, workspaceRoot);
  if (!workspace) return;
  const busy = tasks.find(other =>
    other.id !== task.id &&
    other.status === 'doing' &&
    other.mode === 'write' &&
    workspaceOf(other, workspaceRoot) === workspace
  );
  if (busy) {
    throw new TeamBoardError(
      'WORKSPACE_BUSY',
      `WORKSPACE_BUSY：工作区 ${workspace} 正被 ${busy.id}（${busy.assignee ?? '未指派'}）写入；等它完成或换 worktree`
    );
  }
}

export function createTeamTask(
  tasks: readonly ConversationTeamTask[],
  input: CreateTeamTaskInput,
  now = Date.now()
): ConversationTeamTask {
  const dependsOn = [...new Set(input.dependsOn ?? [])];
  if (dependsOn.length !== (input.dependsOn ?? []).length) {
    throw new TeamBoardError('DUPLICATE_DEPENDENCY', '依赖列表里有重复 id');
  }
  for (const id of dependsOn) {
    if (id === input.id) throw new TeamBoardError('UNKNOWN_DEPENDENCY', '任务不能依赖自己');
    if (!tasks.some(task => task.id === id)) {
      throw new TeamBoardError('UNKNOWN_DEPENDENCY', `依赖的任务不存在：${id}`);
    }
  }
  return {
    id: input.id,
    title: input.title.trim(),
    ...(input.detail?.trim() ? { detail: input.detail.trim() } : {}),
    ...(input.assignee ? { assignee: input.assignee } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    mode: input.mode ?? 'read',
    ...(input.workspace?.trim() ? { workspace: input.workspace.trim() } : {}),
    status: 'todo',
    revision: 1,
    createdAt: now,
    updatedAt: now
  };
}

export function updateTeamTask(
  tasks: readonly ConversationTeamTask[],
  input: UpdateTeamTaskInput,
  options: { now?: number; workspaceRoot?: string } = {}
): ConversationTeamTask[] {
  const now = options.now ?? Date.now();
  const index = tasks.findIndex(item => item.id === input.id);
  if (index < 0) throw new TeamBoardError('TASK_NOT_FOUND', `没有这个任务：${input.id}`);
  const current = tasks[index];
  const revision = taskRevision(current);
  if (input.expectedRevision !== revision) {
    throw new TeamBoardError(
      'CAS_CONFLICT',
      `CAS_CONFLICT：${input.id} 已经被更新（当前 revision ${String(revision)}，你拿的是 ${String(input.expectedRevision)}）；先 team.task.get 再改`
    );
  }

  if (input.status === 'doing' || input.status === 'done') {
    assertDependenciesDone(tasks, current);
  }
  if (
    input.status === 'done' &&
    !(input.evidence && input.evidence.length > 0) &&
    (current.evidence?.length ?? 0) === 0
  ) {
    throw new TeamBoardError('EVIDENCE_REQUIRED', 'EVIDENCE_REQUIRED：done 必须带至少一条证据（执行报告 / 测试 / 诊断 / 提交）');
  }

  const next: ConversationTeamTask = {
    ...current,
    status: input.status,
    revision: revision + 1,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    ...(input.workspace?.trim() ? { workspace: input.workspace.trim() } : {}),
    ...(input.evidence && input.evidence.length > 0
      ? { evidence: [...(current.evidence ?? []), ...input.evidence].slice(-50) }
      : {}),
    updatedAt: now
  };

  if (input.status === 'doing') {
    assertWorkspaceAvailable(tasks, next, options.workspaceRoot);
    next.claimedBy = current.assignee ?? 'unassigned';
    next.startedAt = current.startedAt ?? now;
  }
  if (input.status === 'done') next.finishedAt = now;

  const out = [...tasks];
  out[index] = next;
  return out;
}

export function teamProgress(tasks: readonly ConversationTeamTask[]): TeamProgress {
  const ready: ConversationTeamTask[] = [];
  const blocked: TeamProgress['blocked'] = [];
  for (const task of tasks) {
    if (task.status === 'done') continue;
    const missing = missingDependencies(tasks, task);
    if (task.status === 'todo' && missing.length === 0) ready.push(task);
    else if (task.status === 'todo' || task.status === 'blocked') blocked.push({ task, missing });
  }
  return {
    total: tasks.length,
    done: tasks.filter(task => task.status === 'done').length,
    ready,
    blocked,
    remaining: tasks
      .filter(task => task.status !== 'done')
      .map(task => ({ id: task.id, title: task.title, status: task.status }))
  };
}

/** 任务板进度摘要；`team.wait` 直接把它交给模型。 */
export function teamWait(tasks: readonly ConversationTeamTask[]): {
  done: boolean;
  total: number;
  completed: number;
  ready: Array<{ id: string; title: string }>;
  blocked: Array<{ id: string; title: string; missing: string[] }>;
  remaining: TeamProgress['remaining'];
  note?: string;
} {
  const progress = teamProgress(tasks);
  return {
    done: tasks.length > 0 && progress.done === tasks.length,
    total: progress.total,
    completed: progress.done,
    ready: progress.ready.map(task => ({ id: task.id, title: task.title })),
    blocked: progress.blocked.map(item => ({ id: item.task.id, title: item.task.title, missing: item.missing })),
    remaining: progress.remaining,
    ...(tasks.length === 0 ? { note: '任务板还是空的' } : {})
  };
}
