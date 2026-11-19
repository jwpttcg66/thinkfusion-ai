/**
 * P2-03：时效三态。fresh / stale / refuted；旧卡不被静默覆盖。
 */
import type { Freshness, KnowledgeCard } from './types';

export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface FreshnessOptions {
  ttlMs?: number;
  version?: string;
}

export function evaluateFreshness(
  card: KnowledgeCard,
  now = Date.now(),
  options: FreshnessOptions = {}
): Freshness {
  const reasons: string[] = [];
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  if (card.status === 'refuted' || card.freshness.state === 'refuted') {
    return { ...card.freshness, state: 'refuted', reasons: [...card.freshness.reasons, '已被推翻'] };
  }
  if (card.status === 'superseded') reasons.push('已被新卡取代');
  if (now - card.freshness.asOf > ttl) reasons.push('超过时效');
  if (options.version && card.freshness.version && options.version !== card.freshness.version) {
    reasons.push('来源版本已变化');
  }
  const state = reasons.length > 0 ? 'stale' : 'fresh';
  return { ...card.freshness, state, reasons };
}

export interface ReuseDecision {
  reusable: boolean;
  state: Freshness['state'];
  reasons: string[];
}

export function canReuse(
  card: KnowledgeCard,
  now = Date.now(),
  options: FreshnessOptions = {}
): ReuseDecision {
  const freshness = evaluateFreshness(card, now, options);
  return {
    reusable: freshness.state === 'fresh',
    state: freshness.state,
    reasons: freshness.reasons
  };
}
