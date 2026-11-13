/**
 * Agentic Search 的预算、状态与确定性收束。
 *
 * 这层不调用模型，也不执行工具；它只决定「还能不能继续」以及
 * 「预算耗尽时怎样把已有证据写成报告」。真正的模型/工具调用仍在
 * conversation-runner 和 mainCapabilities 里。
 */

import { createHash } from 'node:crypto';
import type { ModelUsage } from '../providers/types';

export type UsageSource = 'provider' | 'estimated' | 'unavailable';

export type AgenticSearchState =
  | 'PLANNING'
  | 'SEARCHING'
  | 'OBSERVING'
  | 'FINALIZING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type SearchTerminationReason =
  | 'COMPLETED'
  | 'BUDGET_EXHAUSTED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'TOOL_ERROR'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED';

export type ToolCallingMode = 'native' | 'json_protocol' | 'web_only';
export type ToolCallStatus =
  | 'requested'
  | 'validated'
  | 'rejected'
  | 'executing'
  | 'success'
  | 'failed';

export interface ToolCall {
  callId: string;
  searchId: string;
  agentId: string;
  round: number;
  toolName: string;
  args: Record<string, unknown>;
  mode: ToolCallingMode;
  status: ToolCallStatus;
}

export interface SearchBudget {
  maxRounds: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxDurationMs: number;
  maxEvidenceChars: number;
}

export interface SearchBudgetUsage {
  rounds: number;
  toolCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  inputUsageSource: UsageSource;
  outputUsageSource: UsageSource;
  durationMs: number;
  evidenceChars: number;
  softLimitReached: boolean;
  exhaustedDimensions: string[];
}

export interface SearchBudgetRemaining {
  rounds: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  evidenceChars: number;
}

export type EngineeringToolName = 'fs.stat' | 'fs.readFile' | 'fs.search' | 'fs.list';

export interface ToolValidationError {
  ok: false;
  code: 'invalid-args' | 'unknown-tool' | 'missing-arg' | 'bad-type' | 'out-of-range';
  message: string;
}

export type ToolValidationResult =
  | { ok: true; args: Record<string, unknown> }
  | ToolValidationError;

const TOOL_ARG_KEYS: Record<EngineeringToolName, readonly string[]> = {
  'fs.stat': ['path'],
  'fs.readFile': ['path', 'offset', 'limit'],
  'fs.search': ['pattern', 'path'],
  'fs.list': ['path']
};

export function validateToolArgs(tool: string, rawArgs: unknown): ToolValidationResult {
  if (!(tool in TOOL_ARG_KEYS)) return { ok: false, code: 'unknown-tool', message: `未注册工具：${tool}` };
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return { ok: false, code: 'invalid-args', message: '工具参数必须是对象' };
  }
  const args = rawArgs as Record<string, unknown>;
  const allowed = TOOL_ARG_KEYS[tool as EngineeringToolName];
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) return { ok: false, code: 'invalid-args', message: `不支持的参数：${key}` };
  }
  const text = (key: string, required: boolean, max: number) => {
    const value = args[key];
    if (value === undefined) {
      if (required) return { ok: false as const, code: 'missing-arg' as const, message: `缺少参数：${key}` };
      return null;
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > max) {
      return { ok: false as const, code: 'bad-type' as const, message: `参数 ${key} 必须是 1-${String(max)} 字符的字符串` };
    }
    return null;
  };
  const number = (key: string, min: number, max: number) => {
    const value = args[key];
    if (value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
      return { ok: false as const, code: 'out-of-range' as const, message: `参数 ${key} 必须是 ${String(min)}-${String(max)} 的整数` };
    }
    return null;
  };
  const errors = tool === 'fs.search'
    ? [text('pattern', true, 200), text('path', false, 2000)]
    : tool === 'fs.list'
      ? [text('path', false, 2000)]
      : tool === 'fs.readFile'
        ? [text('path', true, 2000), number('offset', 1, 1_000_000), number('limit', 1, 2000)]
        : [text('path', true, 2000)];
  const error = errors.find(item => item !== null);
  if (error) return error;
  return { ok: true, args: { ...args } };
}

export interface SearchEvidenceRef {
  path: string;
  line?: number;
  endLine?: number;
  contentHash?: string;
  excerpt?: string;
  toolCallId: string;
  generation?: number;
  source: 'file_search' | 'file_read' | 'symbol_lookup' | 'git';
  verificationStatus: 'verified' | 'inferred' | 'unverified';
}

export interface SearchToolResult {
  callId: string;
  searchId?: string;
  toolName: string;
  argsSummary: string;
  status: 'success' | 'failed' | 'denied' | 'timeout' | 'cancelled';
  data?: unknown;
  error?: { code: string; message: string };
  evidenceRefs: SearchEvidenceRef[];
  warnings: string[];
  truncated: boolean;
  durationMs: number;
  mode?: ToolCallingMode;
  generation?: number;
}

export interface SearchFinding {
  description: string;
  evidenceRefs: SearchEvidenceRef[];
  confidence: 'verified' | 'inferred' | 'unverified';
}

export interface SearchReport {
  searchId: string;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
  terminationReason: SearchTerminationReason;
  summary: string;
  findings: SearchFinding[];
  evidenceRefs: SearchEvidenceRef[];
  completedActions: string[];
  unresolvedQuestions: string[];
  budgetUsage: SearchBudgetUsage;
  warnings: string[];
  canContinue: boolean;
}

export interface AgenticSearchContext {
  searchId: string;
  projectId?: string;
  generation?: number;
  state: AgenticSearchState;
  terminationReason?: SearchTerminationReason;
  budget: SearchBudget;
  manager: SearchBudgetManager;
  evidenceRefs: SearchEvidenceRef[];
  toolResults: SearchToolResult[];
  startedAt: number;
  cancelled: boolean;
  model: string;
  toolSequence: number;
  finalReport?: SearchReport;
}

export const DEFAULT_SEARCH_BUDGET: SearchBudget = {
  maxRounds: 8,
  maxToolCalls: 20,
  maxInputTokens: 30_000,
  maxOutputTokens: 8_000,
  maxDurationMs: 180_000,
  maxEvidenceChars: 30_000
};

function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

export class SearchBudgetManager {
  private rounds = 0;
  private toolCalls = 0;
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private inputUsageSource: UsageSource = 'unavailable';
  private outputUsageSource: UsageSource = 'unavailable';
  private evidenceChars = 0;
  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(
    readonly budget: SearchBudget = DEFAULT_SEARCH_BUDGET,
    options: { now?: () => number; startedAt?: number } = {}
  ) {
    this.now = options.now ?? Date.now;
    this.startedAt = options.startedAt ?? this.now();
  }

  remaining(): SearchBudgetRemaining {
    return {
      rounds: Math.max(0, this.budget.maxRounds - this.rounds),
      toolCalls: Math.max(0, this.budget.maxToolCalls - this.toolCalls),
      inputTokens: Math.max(0, this.budget.maxInputTokens - (this.inputTokens ?? 0)),
      outputTokens: Math.max(0, this.budget.maxOutputTokens - (this.outputTokens ?? 0)),
      durationMs: Math.max(0, this.budget.maxDurationMs - (this.now() - this.startedAt)),
      evidenceChars: Math.max(0, this.budget.maxEvidenceChars - this.evidenceChars)
    };
  }

  canStartRound(inputChars = 0, outputReserve = 0): boolean {
    const left = this.remaining();
    if (left.rounds <= 0 || left.durationMs <= 0) return false;
    const inputEstimate = estimateTokens(inputChars);
    if (left.inputTokens < inputEstimate) return false;
    if (left.outputTokens < Math.min(outputReserve, this.budget.maxOutputTokens)) return false;
    return true;
  }

  startRound(): void {
    this.rounds += 1;
  }

  canUseTool(): boolean {
    const left = this.remaining();
    return left.toolCalls > 0 && left.durationMs > 0;
  }

  useTool(): void {
    this.toolCalls += 1;
  }

  addEvidence(chars: number): void {
    this.evidenceChars += Math.max(0, chars);
  }

  recordModelUsage(usage: ModelUsage | null | undefined, requestChars: number, answerChars: number): void {
    const input = typeof usage?.inputTokens === 'number' ? usage.inputTokens : null;
    const output = typeof usage?.outputTokens === 'number' ? usage.outputTokens : null;
    this.inputTokens = (this.inputTokens ?? 0) + (input ?? estimateTokens(requestChars));
    this.outputTokens = (this.outputTokens ?? 0) + (output ?? estimateTokens(answerChars));
    this.inputUsageSource = input === null ? 'estimated' : 'provider';
    this.outputUsageSource = output === null ? 'estimated' : 'provider';
  }

  usage(): SearchBudgetUsage {
    const expired = this.exhaustedDimensions();
    return {
      rounds: this.rounds,
      toolCalls: this.toolCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      inputUsageSource: this.inputUsageSource,
      outputUsageSource: this.outputUsageSource,
      durationMs: this.now() - this.startedAt,
      evidenceChars: this.evidenceChars,
      softLimitReached: this.softLimitReached(),
      exhaustedDimensions: expired
    };
  }

  softLimitReached(): boolean {
    return this.remaining().rounds <= Math.ceil(this.budget.maxRounds * 0.3) ||
      this.remaining().toolCalls <= Math.ceil(this.budget.maxToolCalls * 0.3) ||
      this.remaining().durationMs <= Math.ceil(this.budget.maxDurationMs * 0.3) ||
      this.remaining().evidenceChars <= Math.ceil(this.budget.maxEvidenceChars * 0.3);
  }

  exhaustedDimensions(): string[] {
    const out: string[] = [];
    if (this.rounds >= this.budget.maxRounds) out.push('rounds');
    if (this.toolCalls >= this.budget.maxToolCalls) out.push('toolCalls');
    if ((this.inputTokens ?? 0) >= this.budget.maxInputTokens) out.push('inputTokens');
    if ((this.outputTokens ?? 0) >= this.budget.maxOutputTokens) out.push('outputTokens');
    if (this.now() - this.startedAt >= this.budget.maxDurationMs) out.push('durationMs');
    if (this.evidenceChars >= this.budget.maxEvidenceChars) out.push('evidenceChars');
    return out;
  }

  exhausted(): boolean {
    return this.exhaustedDimensions().length > 0;
  }
}

export function nextToolCallId(context: AgenticSearchContext, agentId: string): string {
  context.toolSequence += 1;
  return `tc_${context.searchId}_${agentId}_${String(context.toolSequence)}`;
}

const ALLOWED_TRANSITIONS: Record<AgenticSearchState, ReadonlySet<AgenticSearchState>> = {
  PLANNING: new Set(['SEARCHING', 'FINALIZING', 'CANCELLED']),
  SEARCHING: new Set(['OBSERVING', 'FINALIZING', 'CANCELLED', 'FAILED']),
  OBSERVING: new Set(['SEARCHING', 'FINALIZING', 'CANCELLED', 'FAILED']),
  FINALIZING: new Set(['COMPLETED', 'FAILED', 'CANCELLED']),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set()
};

export function transitionSearchState(
  context: AgenticSearchContext,
  nextState: AgenticSearchState,
  reason?: string
): void {
  if (!ALLOWED_TRANSITIONS[context.state].has(nextState)) {
    throw new Error(`非法的 Agentic Search 状态转换：${context.state} -> ${nextState}${reason ? `（${reason}）` : ''}`);
  }
  context.state = nextState;
}

export function createSearchContext(options: {
  projectId?: string;
  generation?: number;
  model: string;
  budget?: SearchBudget;
  now?: () => number;
}): AgenticSearchContext {
  const budget = options.budget ?? DEFAULT_SEARCH_BUDGET;
  return {
    searchId: `s_${createHash('sha256').update(`${Date.now()}|${options.model}|${Math.random()}`).digest('hex').slice(0, 16)}`,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.generation !== undefined ? { generation: options.generation } : {}),
    state: 'PLANNING',
    budget,
    manager: new SearchBudgetManager(budget, { ...(options.now ? { now: options.now } : {}) }),
    evidenceRefs: [],
    toolResults: [],
    startedAt: Date.now(),
    cancelled: false,
    model: options.model,
    toolSequence: 0
  };
}

export interface DeterministicReportInput {
  context: AgenticSearchContext;
  terminationReason: SearchTerminationReason;
  warnings?: string[];
  unresolvedQuestions?: string[];
}

export function deterministicFinalReport(input: DeterministicReportInput): SearchReport {
  const { context, terminationReason } = input;
  const evidence = context.evidenceRefs.filter(item => item.verificationStatus === 'verified');
  const findings: SearchFinding[] = evidence
    .filter(item => item.path)
    .map(item => ({
      description: `${item.path}${item.line ? `:${String(item.line)}` : ''} 命中证据${item.excerpt ? `：${item.excerpt.slice(0, 160)}` : ''}`,
      evidenceRefs: [item],
      confidence: 'verified'
    }));
  const hasEvidence = findings.length > 0;
  const status = terminationReason === 'CANCELLED'
    ? 'CANCELLED'
    : hasEvidence ? 'PARTIAL' : 'FAILED';
  const summary = hasEvidence
    ? `本次搜索未正常完成：${terminationReason}。已执行 ${String(context.manager.usage().rounds)} 轮、${String(context.manager.usage().toolCalls)} 次工具调用，取得 ${String(evidence.length)} 条有效证据。以下内容只反映实际取得的证据。`
    : `本次搜索未取得有效证据：${terminationReason}。报告只包含实际执行记录，不包含未经验证的结论。`;
  return {
    searchId: context.searchId,
    status,
    terminationReason,
    summary,
    findings,
    evidenceRefs: context.evidenceRefs,
    completedActions: context.toolResults.map(item => `${item.toolName}（${item.status}）`),
    unresolvedQuestions: input.unresolvedQuestions ?? [],
    budgetUsage: context.manager.usage(),
    warnings: input.warnings ?? [],
    canContinue: false
  };
}

export function formatSearchReport(report: SearchReport): string {
  const lines = [
    '## Agentic Search 报告',
    '',
    report.summary,
    '',
    `- 状态：${report.status}`,
    `- 终止原因：${report.terminationReason}`,
    `- 轮数：${String(report.budgetUsage.rounds)}`,
    `- 工具调用：${String(report.budgetUsage.toolCalls)}`,
    `- 证据：${String(report.evidenceRefs.length)} 条`
  ];
  if (report.findings.length > 0) {
    lines.push('', '### 已取得的证据');
    for (const finding of report.findings) lines.push(`- ${finding.description}`);
  }
  if (report.unresolvedQuestions.length > 0) {
    lines.push('', '### 尚未解决');
    for (const item of report.unresolvedQuestions) lines.push(`- ${item}`);
  }
  if (report.warnings.length > 0) {
    lines.push('', '### 警告');
    for (const item of report.warnings) lines.push(`- ${item}`);
  }
  return lines.join('\n');
}
