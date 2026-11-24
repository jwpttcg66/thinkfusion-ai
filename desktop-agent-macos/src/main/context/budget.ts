/**
 * 上下文预算（LT-P1-04）。
 *
 * 每个模型独立计算；窗口未知时保留 null，不伪造百分比。
 */

import type {
  BudgetConfidence,
  BudgetDecision,
  BudgetSource,
  ContextBudget
} from '../../shared/context';

export const DEFAULT_OUTPUT_RESERVE = 4096;
export const DEFAULT_SAFETY_MARGIN = 16_384;
export const CONSERVATIVE_INPUT_LIMIT = 32_768;

export interface ContextBudgetInput {
  providerId: string;
  modelId: string;
  /** Provider 声明/配置的窗口；未知 null。 */
  contextWindow: number | null;
  maxOutputTokens: number | null;
  estimatedInputTokens: number;
  actualInputTokens?: number | null;
  /** 用户/系统配置的保守输入上限。 */
  configuredInputLimit?: number;
  warningThreshold?: number;
  compactionThreshold?: number;
  confidence?: BudgetConfidence;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function computeContextBudget(input: ContextBudgetInput): ContextBudget {
  const window = positive(input.contextWindow);
  const configured = positive(input.configuredInputLimit);
  const outputReserve = positive(input.maxOutputTokens) ?? DEFAULT_OUTPUT_RESERVE;

  let budgetSource: BudgetSource = 'conservative';
  let confidence: BudgetConfidence = 'unknown';
  if (configured !== null) {
    budgetSource = 'config';
    confidence = 'configured';
  }
  if (window !== null) {
    budgetSource = 'provider';
    confidence = 'verified';
  }

  return {
    providerId: input.providerId,
    modelId: input.modelId,
    contextWindow: window,
    maxOutputTokens: positive(input.maxOutputTokens),
    estimatedInputTokens: Math.max(0, Math.round(input.estimatedInputTokens)),
    actualInputTokens: input.actualInputTokens ?? null,
    warningThreshold: input.warningThreshold ?? 0.65,
    compactionThreshold: input.compactionThreshold ?? 0.85,
    budgetSource,
    ...(configured !== null ? { configuredInputLimit: configured } : {}),
    confidence: input.confidence ?? confidence
  };
}

/**
 * 计算可用输入上限与触发级别。
 *
 * 未知窗口且没有配置上限时：inputLimit 用保守值，但 usageRatio=null、
 * level=unknown——不拿假分母算 65/75/85%。
 */
export function decideBudget(budget: ContextBudget): BudgetDecision {
  const configured = positive(budget.configuredInputLimit);
  const outputReserve = positive(budget.maxOutputTokens) ?? DEFAULT_OUTPUT_RESERVE;
  const safety = budget.contextWindow !== null
    ? Math.max(2048, Math.floor(budget.contextWindow * 0.08))
    : 0;

  let inputLimit: number | null = null;
  if (budget.contextWindow !== null) {
    inputLimit = Math.max(1, budget.contextWindow - outputReserve - safety);
  } else if (configured !== null) {
    inputLimit = configured;
  }

  const knownDenominator = inputLimit !== null
    && budget.confidence !== 'unknown'
    && budget.budgetSource !== 'conservative';

  if (!knownDenominator || inputLimit === null) {
    return {
      budget,
      inputLimit: inputLimit ?? CONSERVATIVE_INPUT_LIMIT,
      usageRatio: null,
      level: 'unknown',
      reason: '上下文窗口未提供；按保守输入上限做裁剪，不计算百分比'
    };
  }

  const ratio = budget.estimatedInputTokens / inputLimit;
  const level = ratio >= 1
    ? 'overflow'
    : ratio >= budget.compactionThreshold
      ? 'compaction'
      : ratio >= budget.warningThreshold
        ? 'warning'
        : 'normal';
  return {
    budget,
    inputLimit,
    usageRatio: ratio,
    level,
    reason: level === 'normal'
      ? `估算 ${String(budget.estimatedInputTokens)} / ${String(inputLimit)}`
      : `估算 ${String(budget.estimatedInputTokens)} / ${String(inputLimit)}，达到 ${String(Math.round(ratio * 100))}%`
  };
}
