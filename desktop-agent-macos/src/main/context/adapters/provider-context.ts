/**
 * Provider 上下文能力适配（LT-P1-05）。
 *
 * 只把已有能力归一成统一结构；不探测、不改 Provider 选择。
 * 未知窗口保持 null，不写一个虚构的 128K/200K。
 */

import type { BudgetConfidence } from '../../../shared/context';

export type ProviderContextSource = 'provider' | 'config' | 'web' | 'cli' | 'unknown';

export interface ProviderContextInput {
  providerId: string;
  modelId: string;
  contextTokens?: number | null;
  maxOutputTokens?: number | null;
  source?: ProviderContextSource;
}

export interface ProviderContextCapability {
  providerId: string;
  modelId: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  confidence: BudgetConfidence;
  source: ProviderContextSource;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function providerContextCapability(input: ProviderContextInput): ProviderContextCapability {
  const source = input.source ?? 'unknown';
  const window = positive(input.contextTokens);
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    contextWindow: source === 'web' || source === 'cli' ? null : window,
    maxOutputTokens: positive(input.maxOutputTokens),
    confidence: source === 'web' || source === 'cli'
      ? 'unknown'
      : source === 'config'
        ? 'configured'
        : window !== null ? 'verified' : 'unknown',
    source
  };
}
