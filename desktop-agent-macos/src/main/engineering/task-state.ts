/**
 * P3-01：工程任务状态。S1/S2 是快照，不叫流程基线。
 *
 * 缺失 S1/S2、测试未过、评审未过时不能标 done。
 */
export interface EngineeringContext {
  repoRoot: string;
  branch: string;
  worktree?: string;
}

export interface Snapshot {
  commit: string;
  dirty: boolean;
  dirtyFiles: string[];
  snapshot: string;
  diffHash?: string;
  at: number;
}

export interface TestReport {
  command: string;
  exitCode: number;
  status: 'passed' | 'failed' | 'skipped';
  attestationId?: string;
  at: number;
}

export interface BuildReport {
  command: string;
  exitCode: number;
  status: 'passed' | 'failed';
  at: number;
}

export interface ReviewVerdict {
  verdict: 'pass' | 'fail';
  reviewer: string;
  issues: string[];
  at: number;
}

export interface EngineeringTaskState {
  taskId: string;
  implementerId: string;
  context: EngineeringContext;
  start?: Snapshot;
  end?: Snapshot;
  testReports: TestReport[];
  build?: BuildReport;
  review?: ReviewVerdict;
  worktree?: { dir: string; branch: string };
}

export interface Completeness {
  ok: boolean;
  reasons: string[];
}

export function createEngineeringTaskState(input: {
  taskId: string;
  implementerId: string;
  context: EngineeringContext;
  worktree?: { dir: string; branch: string };
}): EngineeringTaskState {
  if (!input.context.repoRoot || !input.context.branch) throw new Error('工程任务缺少 repoRoot/branch');
  return {
    taskId: input.taskId,
    implementerId: input.implementerId,
    context: input.context,
    testReports: [],
    ...(input.worktree ? { worktree: input.worktree } : {})
  };
}

export function recordStart(state: EngineeringTaskState, snapshot: Omit<Snapshot, 'at'>): EngineeringTaskState {
  if (state.start) throw new Error('S1 已存在');
  return { ...state, start: { ...snapshot, at: Date.now() } };
}

export function recordEnd(state: EngineeringTaskState, snapshot: Omit<Snapshot, 'at'>): EngineeringTaskState {
  if (!state.start) throw new Error('缺少 S1，不能记 S2');
  if (state.end) throw new Error('S2 已存在');
  return { ...state, end: { ...snapshot, at: Date.now() } };
}

export function recordTest(state: EngineeringTaskState, report: Omit<TestReport, 'at'>): EngineeringTaskState {
  return { ...state, testReports: [...state.testReports, { ...report, at: Date.now() }] };
}

export function recordBuild(state: EngineeringTaskState, report: Omit<BuildReport, 'at'>): EngineeringTaskState {
  return { ...state, build: { ...report, at: Date.now() } };
}

export function recordReview(
  state: EngineeringTaskState,
  report: Omit<ReviewVerdict, 'at'>
): EngineeringTaskState {
  if (report.reviewer === state.implementerId) throw new Error('评审者不能是实现者');
  return { ...state, review: { ...report, at: Date.now() } };
}

export function canComplete(state: EngineeringTaskState): Completeness {
  const reasons: string[] = [];
  if (!state.start) reasons.push('缺少 S1');
  if (!state.end) reasons.push('缺少 S2');
  if (state.testReports.length === 0) reasons.push('没有测试报告');
  if (state.testReports.some(report => report.status === 'failed')) reasons.push('测试未通过');
  if (!state.build) reasons.push('缺少构建报告');
  else if (state.build.status !== 'passed') reasons.push('构建未通过');
  if (!state.review) reasons.push('缺少评审');
  else if (state.review.verdict !== 'pass') reasons.push('评审未通过');
  return { ok: reasons.length === 0, reasons };
}
