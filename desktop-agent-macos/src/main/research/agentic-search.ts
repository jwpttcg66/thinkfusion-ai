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
  toolName: string;
  argsSummary: string;
  status: 'success' | 'failed' | 'denied' | 'timeout' | 'cancelled';
  data?: unknown;
  error?: { code: string; message: string };
  evidenceRefs: SearchEvidenceRef[];
  warnings: string[];
  truncated: boolean;
  durationMs: number;
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
    model: options.model
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
