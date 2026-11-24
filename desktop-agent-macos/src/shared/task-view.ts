/** 工程任务视图投影：Renderer 只读这一份派生结果，不自行拼业务状态。 */
import type { AgentEvent, PlanPreview } from './contracts';
import {
  EMPTY_TASK_STREAM,
  reduceTaskMembers,
  reduceTaskStream,
  type TaskMemberStream,
  type TaskStreamState
} from './task-stream';
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
  /**
   * V2.1：这一轮每个成员各自的输出。单成员任务时长度为 1 或 0
   * （旧事件没有 participantId 时为空，界面退回 `live` 一路显示）。
   */
  members: TaskMemberStream[];
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
      compile: { status: 'passed' | 'failed' | 'skipped'; exitCode?: number; command?: string; detail?: string; output?: string };
      /** 程序真的跑起来了吗（V1.3）。老报告没有这一项。 */
      run?: { status: 'passed' | 'failed' | 'skipped'; exitCode?: number; command?: string; detail?: string; output?: string };
      tests: { status: 'passed' | 'failed' | 'skipped'; exitCode?: number; command?: string; detail?: string; output?: string };
      diagnostics: { status: 'passed' | 'failed' | 'skipped'; errors: number; warnings: number; source?: string; detail?: string };
    };
  } | null;
  /** 按轮次保存的模型思考/输出历史，刷新后可从事件重建。 */
  modelTrace: Array<{ roundId: string; reasoning: string; text: string }>;
  diagnostics: TaskDiagnosticCard[];
  /**
   * 改动文件。没有 before/after 的（fs.writeFile 只回路径+字节）也要留下来：
   * 「改动 3 个文件」却一个路径都列不出来，就是用户看到的「产物没有保存」。
   */
  changes: Array<{
    path: string;
    before?: string;
    after?: string;
    patch?: string;
    created?: boolean;
    replaced?: boolean;
    bytes?: number;
  }>;
  /** 构建产物：编译/运行命令真实打印出来的 .class / .jar 等文件。 */
  artifacts: Array<{ path: string; source: string; command?: string; output?: string }>;
}

export const EMPTY_TASK_VIEW: TaskView = {
  plan: null,
  questions: [],
  answer: '',
  live: EMPTY_TASK_STREAM,
  members: [],
  modelTrace: [],
  review: null,
  verification: null,
  diagnostics: [],
  changes: [],
  artifacts: []
};

/**
 * 单个事件落到视图上（增量路径）。
 *
 * 全量 `projectTaskView` 也走这一支：两处各写一遍「round.started 要清空什么」，
 * 迟早会变成「刷新后和在线时显示不一样」。恢复与实时必须同源。
 */
export function applyTaskViewEvent(view: TaskView, event: AgentEvent): TaskView {
  const live = reduceTaskStream(view.live, event);
  const members = reduceTaskMembers(view.members, event);
  if (event.type === 'round.started') {
    /**
     * 只有「会重新出计划」的轮次才清掉旧计划。
     *
     * 报告轮（execution_report）和补充回答轮（clarification_answer）问的是**同一份**
     * 计划：清掉它，进度卡就从「3 / 3 步」退回「已执行 3 步」、计划预览整块消失，
     * 看起来像执行过的步骤没人认账。真正换了计划的轮次（user_prompt / plan_repair）
     * 照旧清空——新计划马上由 `plan.ready` 补上。
     * 老事件没有 `inputType` 时按「会重新出计划」处理，保持升级前的行为。
     */
    const replans = event.inputType !== 'execution_report' && event.inputType !== 'clarification_answer';
    return { ...view, live, members, questions: [], answer: '', plan: replans ? null : view.plan };
  }
  if (event.type === 'plan.ready') return { ...view, live, members, plan: event.plan };
  if (event.type === 'clarification.required') return { ...view, live, members, questions: event.questions };
  if (event.type === 'round.answer') return { ...view, live, members, answer: event.text };
  /**
   * 报告与评审也要走增量路径。
   *
   * 只写在 `projectTaskView` 里的话，运行中的任务永远看不到「验证」这一行：
   * 在线事件走的是这里，视图里 verification / review 一直是 null，直到用户
   * 重新点开这条任务（走全量重算）才出现——2026-11-22 真机就是这样：任务已经
   * 完成、验证也通过了，交付卡整块不渲染，用户只看到评审在说「无法验证」。
   */
  if (event.type === 'report.ready') return { ...view, live, members, ...reportView(event.report) };
  if (event.type === 'review.ready') {
    return {
      ...view,
      live,
      members,
      review: {
        reviewer: event.reviewer,
        backend: event.backend,
        verdict: event.verdict,
        issues: event.issues,
        needsFix: event.needsFix
      }
    };
  }
  if (event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.cancelled') {
    return { ...view, live, members, questions: [] };
  }
  return { ...view, live, members };
}

/** 从命令真实 stdout 里认构建产物；只认常见产物后缀，不把源码/日志当产物。 */
const ARTIFACT_SUFFIX = /\.(?:class|jar|war|exe|bin|so|dylib|dll|o|a|zip)$/i;
export function artifactPaths(output: string): string[] {
  const found = output.match(/[^\s'"`<>|;,]+\.(?:class|jar|war|exe|bin|so|dylib|dll|o|a|zip)/gi) ?? [];
  return [...new Set(found.filter(item => ARTIFACT_SUFFIX.test(item)))];
}

/** 执行报告 → 视图里的验证 / 改动 / 产物 / 诊断四块（全量与增量共用）。 */
function reportView(report: unknown): Pick<TaskView, 'verification' | 'changes' | 'artifacts' | 'diagnostics'> {
  type RawResult = {
    path?: string;
    before?: string;
    after?: string;
    patch?: string;
    created?: boolean;
    replaced?: boolean;
    bytes?: number;
    command?: string;
    cwd?: string;
    stdout?: string;
    stderr?: string;
    diagnostics?: {
      source?: string;
      path?: string;
      counts?: { errors?: number; warnings?: number };
      issues?: Array<{ line?: number; column?: number; message?: string }>;
    };
  };
  const typed = report as {
    verification?: {
      verified: boolean;
      reasons: string[];
      changedFiles: number;
      changedPaths?: string[];
      checks?: NonNullable<TaskView['verification']>['checks'];
    };
    results?: Array<{ tool?: string; result?: RawResult }>;
  } | null;
  const verification = typed?.verification ?? null;
  const results = typed?.results ?? [];

  const changes: TaskView['changes'] = [];
  const seen = new Set<string>();
  for (const item of results) {
    const result = item.result;
    if (!result) continue;
    const path = result.path;
    if (typeof path !== 'string' || seen.has(path)) continue;
    let change: TaskView['changes'][number] | null = null;
    if (typeof result.before === 'string' && typeof result.after === 'string') {
      change = { path, before: result.before, after: result.after };
    } else if (typeof result.patch === 'string') {
      change = { path, patch: result.patch };
    } else if (item.tool === 'fs.writeFile') {
      // 写文件工具只回 {path, created, replaced, bytes}。以前这里直接丢掉，
      // 于是「改动 3 个文件」的交付卡里一个路径都没有。
      change = {
        path,
        ...(result.created === true ? { created: true } : {}),
        ...(result.replaced === true ? { replaced: true } : {}),
        ...(typeof result.bytes === 'number' ? { bytes: result.bytes } : {})
      };
    }
    if (change) { seen.add(path); changes.push(change); }
  }
  // 验证器记录的 changedPaths 是相对路径，作为兜底补齐（写文件事件缺失的老报告）。
  for (const path of typed?.verification?.changedPaths ?? []) {
    if (seen.has(path) || [...seen].some(existing => existing.endsWith(`/${path}`) || path.endsWith(`/${existing}`))) continue;
    seen.add(path);
    changes.push({ path });
  }

  const artifacts: TaskView['artifacts'] = [];
  const seenArtifact = new Set<string>();
  const addArtifact = (path: string, source: string, command?: string) => {
    // 同一产物常被 shell 打印成绝对路径、被编译检查打印成相对路径。
    const duplicate = [...seenArtifact].some(existing =>
      existing === path || existing.endsWith(`/${path}`) || path.endsWith(`/${existing}`)
    );
    if (duplicate) return;
    seenArtifact.add(path);
    artifacts.push({ path, source, ...(command ? { command } : {}) });
  };
  for (const item of results) {
    const result = item.result;
    if (item.tool !== 'shell.run' || !result) continue;
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    for (const match of artifactPaths(output)) {
      const absolute = /^(\/|[A-Za-z]:[\\/])/.test(match)
        ? match
        : result.cwd ? `${result.cwd.replace(/\/$/, '')}/${match}` : match;
      addArtifact(absolute, 'shell.run', result.command);
    }
  }
  // 编译器自己打印的产物路径也算，避免 stdout 只列文件名时漏掉。
  for (const [source, rawCheck] of Object.entries(verification?.checks ?? {})) {
    const check = rawCheck as { output?: string };
    if (typeof check.output !== 'string' || !check.output) continue;
    for (const match of artifactPaths(check.output)) {
      addArtifact(match, `check.${source}`);
    }
  }

  const diagnostics = diagnosticsOfReport(report);
  return { verification, changes, artifacts, diagnostics };
}

/**
 * 执行报告里的诊断问题（`code.diagnostics` 的原始结果）。
 *
 * 对话时间线里每次验证都要带自己那一份诊断，不能只留最新一份；
 * `reportView` 与对话投影共用这一处，避免两边解释不同。
 */
export function diagnosticsOfReport(report: unknown): TaskView['diagnostics'] {
  const typed = report as {
    results?: Array<{
      result?: {
        diagnostics?: {
          source?: string;
          path?: string;
          counts?: { errors?: number; warnings?: number };
          issues?: Array<{ line?: number; column?: number; message?: string }>;
        };
      };
    }>;
  } | null;
  return (typed?.results ?? [])
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

export function projectTaskView(events: readonly AgentEvent[]): TaskView {
  let view: TaskView = EMPTY_TASK_VIEW;
  const trace = new Map<string, { roundId: string; reasoning: string; text: string }>();
  const settledRounds = new Set<string>();

  for (const event of events) {
    view = applyTaskViewEvent(view, event);
    if (event.type === 'plan.debated' && view.plan && view.plan.planId === event.planId) {
      view = { ...view, plan: { ...view.plan, debate: event.debate } };
    }
    if (event.type === 'round.delta' && event.roundId && !settledRounds.has(event.roundId)) {
      const entry = trace.get(event.roundId) ?? { roundId: event.roundId, reasoning: '', text: '' };
      const mode = event.mode ?? 'snapshot';
      if (event.reasoning) entry.reasoning = mode === 'delta' ? entry.reasoning + event.reasoning : event.reasoning;
      if (event.text) entry.text = mode === 'delta' ? entry.text + event.text : event.text;
      trace.set(event.roundId, entry);
    }
    if (event.type === 'round.answer') settledRounds.add(event.roundId);
    // 报告与评审由 applyTaskViewEvent 统一处理：全量与增量同源，在线时也看得见。
  }

  return { ...view, modelTrace: [...trace.values()] };
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
