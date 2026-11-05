/**
 * 历史辩论的复用（Phase 5 的「历史知识」）。
 *
 * 只回答一个问题：**这个问题以前辩过吗，当时结论是什么？** 答案交给界面，
 * 由人决定要不要再跑一遍。不做自动跳过、不把旧结论直接当新结论——
 * 同一句话隔一周问，证据可能已经变了，静默复用比重复跑一遍危险得多。
 *
 * 相似度用与综合层同一套词袋（`features` / `jaccard`），所以「什么算相似」
 * 在整个项目里只有一个口径。
 */
import { features, jaccard } from '../../shared/synthesizer';
import type { DebateState, Verdict } from './types';

export interface RelatedDebate {
  debateId: string;
  question: string;
  /** 0–1。低于 0.45 的不要。 */
  similarity: number;
  verdict: Verdict | null;
  /** 结论原文，可能为 null（没判出结论时）。 */
  conclusion: string | null;
  strategy: string;
  status: DebateState['status'];
  createdAt: number;
  updatedAt: number;
}

const DEFAULT_THRESHOLD = 0.45;

/**
 * 找相似的历史辩论。
 *
 * `exclude` 用来排掉当前这一场——正在跑的辩论不该在「历史上辩过什么」里
 * 出现自己。
 */
export function relatedDebates(
  states: readonly DebateState[],
  question: string,
  options: { exclude?: string; limit?: number; threshold?: number } = {}
): RelatedDebate[] {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const limit = options.limit ?? 5;
  const target = features(question);
  if (target.size === 0) return [];
  const found: RelatedDebate[] = [];
  for (const state of states) {
    if (state.debateId === options.exclude) continue;
    const similarity = jaccard(target, features(state.question));
    if (similarity < threshold) continue;
    found.push({
      debateId: state.debateId,
      question: state.question,
      similarity: Math.round(similarity * 100) / 100,
      verdict: state.verdict?.verdict ?? null,
      conclusion: state.verdict?.conclusion ?? null,
      strategy: state.config.strategy,
      status: state.status,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt
    });
  }
  return found
    .sort((a, b) => b.similarity - a.similarity || b.updatedAt - a.updatedAt)
    .slice(0, limit);
}
