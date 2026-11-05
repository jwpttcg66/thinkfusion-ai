/**
 * 质量指标（任务书 14.3 / Phase 5）。
 *
 * 只算**从落盘数据里真的能算出来**的那几项。任务书另外三项——事实准确率、
 * 错误前提纠正率、校准度——需要人工标注的正确答案；没有标注集就算，等于
 * 编一个数字。那三项在 `eval.ts` 里按标注集算，有标注才有值。
 *
 * 每一项都同时给出分子、分母与比率：比率没有分母时是 `null`，不是 0。
 * 「没有可判定的主张」和「一条都不可追溯」是两件事，混成一个 0% 会让人
 * 以为辩论质量差，其实是没跑起来。
 */
import type {
  DebateEvidence,
  DebateRound,
  DebateState,
  DebateStrategy,
  DebateVerdict
} from './types';

export interface DebateMetrics {
  debateId: string;
  strategy: DebateStrategy;
  rounds: number;
  /** 关键结论能不能定位到有效来源。 */
  traceability: { judged: number; traceable: number; rate: number | null };
  /** 除了首轮，有多少轮没有新增证据也没有修订——这些轮基本白跑。 */
  invalidRounds: { total: number; invalid: number; rate: number | null };
  /** 少数派原文是不是完整留到了最后（设计上必须 100%，掉了就是回归）。 */
  minority: { count: number; preserved: number; rate: number | null };
  /** 耗时与调用次数。Token 与费用没有数据来源，这里不出现。 */
  latency: { totalMs: number; averageRoundMs: number | null; rounds: Array<{ index: number; ms: number }> };
  calls: { messages: number; failures: number };
  /** 结论状态。没跑裁判时为 null。 */
  verdict: DebateVerdict['verdict'] | null;
  createdAt: number;
}

/** 一条主张有没有可核验、且独立（不是转载）的页面来源。 */
export function traceableEvidence(
  evidence: readonly DebateEvidence[],
  claimId: string
): DebateEvidence[] {
  return evidence.filter(
    item => item.claimIds.includes(claimId) && item.verified === 'page-link' && item.independent
  );
}

/**
 * 这一轮有没有产生新东西。
 *
 * 三个判据任何一个成立就算有进展：新证据、实质修订（接受/修正/撤回）、
 * 新争议。仅仅「又说了几句」不算——那正是无效辩论的定义。
 */
export function roundProgress(
  state: Pick<DebateState, 'evidence' | 'revisions' | 'disputes'>,
  round: DebateRound
): { evidence: number; revisions: number; disputes: number; stalled: boolean } {
  const evidence = (state.evidence ?? []).filter(item => item.roundIndex === round.index).length;
  const revisions = (state.revisions ?? []).filter(
    item =>
      item.roundIndex === round.index &&
      (item.decision === 'accept' || item.decision === 'revise' || item.decision === 'withdraw')
  ).length;
  const disputes = (state.disputes ?? []).filter(item => item.roundIndex === round.index).length;
  return { evidence, revisions, disputes, stalled: evidence === 0 && revisions === 0 && disputes === 0 };
}

export function debateMetrics(state: DebateState): DebateMetrics {
  const evidence = state.evidence ?? [];
  const judgments = state.judgments ?? [];
  const judged = judgments.length;
  const traceable = judgments.filter(item => traceableEvidence(evidence, item.claimId).length > 0).length;

  // 首轮本来就是各说各的，没有「新证据」是正常的，不计入无效轮。
  const roundsAfterOpening = state.rounds.filter(round => round.index > 0);
  const invalid = roundsAfterOpening.filter(round => roundProgress(state, round).stalled).length;

  const messageIds = new Set(
    state.rounds.flatMap(round => round.messages.map(message => message.messageId))
  );
  const preserved = state.minorities.filter(message => messageIds.has(message.messageId)).length;

  const roundTimes = state.rounds.map(round => ({
    index: round.index,
    ms: Math.max(0, (round.endedAt ?? round.startedAt) - round.startedAt)
  }));
  const totalRoundMs = roundTimes.reduce((sum, item) => sum + item.ms, 0);
  const messages = state.rounds.reduce((sum, round) => sum + round.messages.length, 0);
  const failures = state.rounds.reduce((sum, round) => sum + round.failures.length, 0);

  return {
    debateId: state.debateId,
    strategy: state.config.strategy,
    rounds: state.rounds.length,
    traceability: {
      judged,
      traceable,
      rate: judged > 0 ? round2(traceable / judged) : null
    },
    invalidRounds: {
      total: roundsAfterOpening.length,
      invalid,
      rate: roundsAfterOpening.length > 0 ? round2(invalid / roundsAfterOpening.length) : null
    },
    minority: {
      count: state.minorities.length,
      preserved,
      rate: state.minorities.length > 0 ? round2(preserved / state.minorities.length) : null
    },
    latency: {
      totalMs: Math.max(0, state.updatedAt - state.createdAt),
      averageRoundMs: roundTimes.length > 0 ? Math.round(totalRoundMs / roundTimes.length) : null,
      rounds: roundTimes
    },
    calls: { messages, failures },
    verdict: state.verdict?.verdict ?? null,
    createdAt: state.createdAt
  };
}

/**
 * 一场辩论的汇总指标：分布与均值。
 *
 * 只做算术，不做「综合评分」：把可追溯率和耗时分乘加成一个分数，就没有人
 * 知道那个分数变高是因为证据变好，还是因为跑得更久。分开看。
 */
export interface MetricsSummary {
  debates: number;
  byVerdict: Record<string, number>;
  byStrategy: Record<string, number>;
  traceability: { judged: number; traceable: number; rate: number | null };
  invalidRounds: { total: number; invalid: number; rate: number | null };
  minority: { count: number; preserved: number; rate: number | null };
  averageTotalMs: number | null;
  averageRounds: number | null;
  calls: { messages: number; failures: number };
}

export function summarizeMetrics(items: readonly DebateMetrics[]): MetricsSummary {
  const sum = (pick: (item: DebateMetrics) => number): number =>
    items.reduce((total, item) => total + pick(item), 0);
  const judged = sum(item => item.traceability.judged);
  const traceable = sum(item => item.traceability.traceable);
  const invalidTotal = sum(item => item.invalidRounds.total);
  const invalid = sum(item => item.invalidRounds.invalid);
  const minorityCount = sum(item => item.minority.count);
  const minorityPreserved = sum(item => item.minority.preserved);
  const byVerdict: Record<string, number> = {};
  const byStrategy: Record<string, number> = {};
  for (const item of items) {
    byVerdict[item.verdict ?? 'no-verdict'] = (byVerdict[item.verdict ?? 'no-verdict'] ?? 0) + 1;
    byStrategy[item.strategy] = (byStrategy[item.strategy] ?? 0) + 1;
  }
  return {
    debates: items.length,
    byVerdict,
    byStrategy,
    traceability: { judged, traceable, rate: judged > 0 ? round2(traceable / judged) : null },
    invalidRounds: {
      total: invalidTotal,
      invalid,
      rate: invalidTotal > 0 ? round2(invalid / invalidTotal) : null
    },
    minority: {
      count: minorityCount,
      preserved: minorityPreserved,
      rate: minorityCount > 0 ? round2(minorityPreserved / minorityCount) : null
    },
    averageTotalMs: items.length > 0 ? Math.round(sum(item => item.latency.totalMs) / items.length) : null,
    averageRounds: items.length > 0 ? round2(sum(item => item.rounds) / items.length) : null,
    calls: { messages: sum(item => item.calls.messages), failures: sum(item => item.calls.failures) }
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
