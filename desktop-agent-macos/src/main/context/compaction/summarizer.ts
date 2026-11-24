/**
 * 历史摘要生成（LT-P3-02）。
 *
 * 只负责：构建摘要请求、调用注入的 ask、解析、校验。不写检查点、不删历史。
 * 失败/超时/取消都不返回可用摘要。
 */

import type {
  ContextHistoryItem,
  ContextOwner,
  ContextSummary
} from '../../../shared/context';
import {
  hashContextSummary,
  validateContextSummary,
  type SummaryValidationContext
} from './summary';

export interface SummarizeInput {
  owner: ContextOwner;
  runId: string;
  history: readonly ContextHistoryItem[];
  evidenceRefs: readonly string[];
  modelId: string;
  /** 默认 60 秒；到点中止并抛错。 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SummarizeDeps {
  ask: (input: { prompt: string; timeoutMs: number; signal: AbortSignal }) => Promise<string>;
}

export interface SummarizeResult {
  summary: ContextSummary;
  summaryHash: string;
  sourceEventIds: string[];
  modelId: string;
}

export class SummaryValidationError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`摘要未通过校验：${reasons.join('；')}`);
    this.name = 'SummaryValidationError';
  }
}

export class SummaryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`摘要生成超时（${String(timeoutMs)}ms）`);
    this.name = 'SummaryTimeoutError';
  }
}

function unfence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[A-Za-z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

export function parseContextSummary(text: string): ContextSummary {
  const parsed = JSON.parse(unfence(text)) as ContextSummary;
  if (!parsed || typeof parsed !== 'object') throw new Error('摘要不是 JSON 对象');
  return parsed;
}

/**
 * 摘要请求只带数据与机器契约，不写角色设定/流程话术。
 * 历史按事件 ID 给出，返回必须引用这些 ID。
 */
export function buildSummaryPrompt(input: SummarizeInput): string {
  return [
    '请把下面的历史压缩成 JSON 摘要。只输出一个 JSON 对象，不要 Markdown 之外的文字。',
    '要求：',
    '1. goal/constraints 保留用户原始目标与明确约束；',
    '2. completed/decisions 必须引用 eventIds；certainty=verified 只能用于执行事件证明的事实；',
    '3. evidence 必须引用已有 evidenceRefs；',
    '4. 未解决问题放 openIssues，下一步放 nextActions；',
    '5. 不要声称测试通过，除非对应事件存在。',
    '',
    '严格按这个形状输出（所有 text 都是字符串；没有内容就给空数组）：',
    JSON.stringify({
      goal: '用户目标',
      constraints: ['约束'],
      completed: [{ text: '已完成的事', certainty: 'claim', eventIds: ['事件 id'] }],
      decisions: [{ text: '决定', status: 'active', eventIds: ['事件 id'] }],
      evidence: [{ ref: '已有 evidenceRef', kind: 'test', eventIds: ['事件 id'] }],
      openIssues: ['未解决问题'],
      currentStep: null,
      nextActions: ['下一步'],
      risks: ['风险'],
      stopConditions: ['停止条件']
    }, null, 2),
    '',
    `owner：${input.owner.ownerType}:${input.owner.ownerId}`,
    `runId：${input.runId}`,
    `evidenceRefs：${JSON.stringify(input.evidenceRefs)}`,
    '',
    '历史事件：',
    JSON.stringify(input.history.map(item => ({
      eventId: item.eventId,
      kind: item.kind,
      role: item.role,
      text: item.text,
      at: item.at,
      roundId: item.roundId,
      stepId: item.stepId
    })), null, 2)
  ].join('\n');
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  abort: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new SummaryTimeoutError(timeoutMs));
      abort();
    }, timeoutMs);
    // controller 由调用方创建；这里只负责 abort 入口。
    function cleanup() {
      clearTimeout(timer);
    }
    promise.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); }
    );
    signal.addEventListener('abort', () => {
      if (timedOut) return;
      cleanup();
      reject(new Error('摘要生成已取消'));
    }, { once: true });
  });
}

export async function summarizeHistory(
  input: SummarizeInput,
  deps: SummarizeDeps
): Promise<SummarizeResult> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (input.signal) input.signal.addEventListener('abort', abort, { once: true });

  try {
    const prompt = buildSummaryPrompt(input);
    const answer = await withTimeout(
      deps.ask({ prompt, timeoutMs, signal: controller.signal }),
      timeoutMs,
      controller.signal,
      abort
    );
    if (typeof answer !== 'string' || !answer.trim()) {
      throw new Error('摘要模型返回空文本');
    }
    const summary = parseContextSummary(answer);
    const validationContext: SummaryValidationContext = {
      eventIds: new Set(input.history.map(item => item.eventId)),
      evidenceRefs: new Set(input.evidenceRefs)
    };
    const validation = validateContextSummary(summary, validationContext);
    if (!validation.ok) throw new SummaryValidationError(validation.reasons);
    return {
      summary,
      summaryHash: hashContextSummary(summary),
      sourceEventIds: input.history.map(item => item.eventId),
      modelId: input.modelId
    };
  } finally {
    if (input.signal) input.signal.removeEventListener('abort', abort);
  }
}
