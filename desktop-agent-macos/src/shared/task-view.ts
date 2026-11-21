/** 工程任务视图投影：Renderer 只读这一份派生结果，不自行拼业务状态。 */
import type { AgentEvent, PlanPreview } from './contracts';
import { EMPTY_TASK_STREAM, reduceTaskStream, type TaskStreamState } from './task-stream';
import type { TaskEventEnvelope } from './task-events';

export type TaskDiagnosticCard = {
  path: string;
  source: string;
  errors: number;
  warnings: number;
  issues: Array<{ line: number; column: number; message: string }>;
};

export interface TaskView {
  plan: PlanPreview | null;
  questions: string[];
  answer: string;
  /** 流式进度：只含轮次和字符数，不展示 reasoning 原文。 */
  live: TaskStreamState;
  review: {
    reviewer: string;
    backend: 'model' | 'rules';
    verdict: string;
    issues: string[];
    needsFix: boolean;
  } | null;
  verification: {
    verified: boolean;
    reasons: string[];
    changedFiles: number;
    checks?: {
      compile: { status: 'passed' | 'failed' | 'skipped'; exitCode?: number; command?: string; detail?: string };
      tests: { status: 'passed' | 'failed' | 'skipped'; exitCode?: number; command?: string; detail?: string };
      diagnostics: { status: 'passed' | 'failed' | 'skipped'; errors: number; warnings: number; source?: string; detail?: string };
    };
  } | null;
  /** 按轮次保存的模型思考/输出历史，刷新后可从事件重建。 */
  modelTrace: Array<{ roundId: string; reasoning: string; text: string }>;
  diagnostics: TaskDiagnosticCard[];
  changes: Array<{ path: string; before?: string; after?: string; patch?: string }>;
}

export const EMPTY_TASK_VIEW: TaskView = {
  plan: null,
  questions: [],
  answer: '',
  live: EMPTY_TASK_STREAM,
  modelTrace: [],
  review: null,
  verification: null,
  diagnostics: [],
  changes: []
};

export function projectTaskView(events: readonly AgentEvent[]): TaskView {
  let plan: PlanPreview | null = null;
  let questions: string[] = [];
  let answer = '';
  let live: TaskStreamState = EMPTY_TASK_STREAM;
  let review: TaskView['review'] = null;
  let verification: TaskView['verification'] = null;
  const trace = new Map<string, { roundId: string; reasoning: string; text: string }>();
  const settledRounds = new Set<string>();
  let diagnostics: TaskDiagnosticCard[] = [];
  let changes: TaskView['changes'] = [];

  for (const event of events) {
    if (event.type === 'round.started') {
      questions = [];
      answer = '';
      plan = null;
    }
    if (event.type === 'plan.ready') plan = event.plan;
    if (event.type === 'plan.debated' && plan && plan.planId === event.planId) {
      plan = { ...plan, debate: event.debate };
    }
    if (event.type === 'clarification.required') questions = event.questions;
    live = reduceTaskStream(live, event);
    if (event.type === 'round.delta' && event.roundId && !settledRounds.has(event.roundId)) {
      const entry = trace.get(event.roundId) ?? { roundId: event.roundId, reasoning: '', text: '' };
      const mode = event.mode ?? 'snapshot';
      if (event.reasoning) entry.reasoning = mode === 'delta' ? entry.reasoning + event.reasoning : event.reasoning;
      if (event.text) entry.text = mode === 'delta' ? entry.text + event.text : event.text;
      trace.set(event.roundId, entry);
    }
    if (event.type === 'round.answer') { answer = event.text; settledRounds.add(event.roundId); }
    if (event.type === 'report.ready') {
      const report = event.report as {
        verification?: {
          verified: boolean;
          reasons: string[];
          changedFiles: number;
          checks?: NonNullable<TaskView['verification']>['checks'];
        };
        results?: Array<{ result?: { path?: string; before?: string; after?: string; patch?: string; diagnostics?: { source?: string; path?: string; counts?: { errors?: number; warnings?: number }; issues?: Array<{ line?: number; column?: number; message?: string }> } } }>;
      };
      verification = report.verification ?? null;
      changes = (report.results ?? [])
        .map((item): TaskView['changes'][number] | null => {
          const result = item.result;
          if (!result?.path) return null;
          if (typeof result.before === 'string' && typeof result.after === 'string') {
            return { path: result.path, before: result.before, after: result.after };
          }
          if (typeof result.patch === 'string') return { path: result.path, patch: result.patch };
          return null;
        })
        .filter((item): item is TaskView['changes'][number] => item !== null);
      diagnostics = (report.results ?? [])
        .map(item => item.result?.diagnostics)
        .filter((item): item is NonNullable<typeof item> => Boolean(item && item.path))
        .map(item => ({
          path: String(item.path),
          source: String(item.source ?? 'tsserver'),
          errors: Number(item.counts?.errors ?? 0),
          warnings: Number(item.counts?.warnings ?? 0),
          issues: (item.issues ?? []).slice(0, 10).map(issue => ({
            line: Number(issue.line ?? 0),
            column: Number(issue.column ?? 0),
            message: String(issue.message ?? '')
          }))
        }));
    }
    if (event.type === 'review.ready') {
      review = {
        reviewer: event.reviewer,
        backend: event.backend,
        verdict: event.verdict,
        issues: event.issues,
        needsFix: event.needsFix
      };
    }
    if (event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.cancelled') {
      questions = [];
    }
  }

  return { plan, questions, answer, live, modelTrace: [...trace.values()], review, verification, diagnostics, changes };
}


/** General/Knowledge 会话的轻量视图投影：阶段、最后事件、事件数。 */
export interface RunView {
  phase: TaskEventEnvelope['phase'];
  count: number;
  lastType: string | null;
  lastAt: number | null;
}

export function projectRunView(events: readonly TaskEventEnvelope[]): RunView {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const last = ordered.at(-1) ?? null;
  return {
    phase: last?.phase ?? 'understanding',
    count: ordered.length,
    lastType: last?.type ?? null,
    lastAt: last?.occurredAt ?? null
  };
}
