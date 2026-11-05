/**
 * 标注集评测（任务书 14.3 / Phase 5）。
 *
 * 这里只做「拿标签和实际结果比一比」，不产生标签。标签文件是
 * `scripts/fixtures/debate-labels.json`，每条都写着 `labelSource`：
 * `seed` 是本仓库自带的示例标注，**未经人工复核**；`human` 才是人写的。
 * 报告里两种分开算，不把示例标注的准确率说成人工基准。
 *
 * 事实准确率、错误前提纠正率、校准度这三项只能在这里算，因为它们都需要
 * 一个「正确答案」。前两项用标签；校准度需要结论带置信度——目前五档结论
 * 不带置信度，所以这一项是**不适用**，不是 0。
 */
import type { DebateState, Verdict } from './types';

export interface LabeledCase {
  id: string;
  /** 任务书 14.2 的 TF-D 编号，或自定的编号。 */
  question: string;
  strategy?: string;
  /** 期望的五档结论。`null` 表示「只要别给出确定性结论」都算对。 */
  expectVerdict: Verdict | null;
  /** 结论或发言里应当出现的词（至少命中一个）。 */
  expectAnyOf?: string[];
  /** 结论或发言里不应出现的绝对化说法。 */
  forbidAnyOf?: string[];
  /** 问题本身带错误前提：这一条同时计入「错误前提纠正率」。 */
  wrongPremise?: boolean;
  /** 标签从哪来。 */
  labelSource: 'seed' | 'human';
  note?: string;
}

export interface CaseOutcome {
  id: string;
  expected: Verdict | null;
  actual: Verdict | null;
  verdictPass: boolean;
  keywordPass: boolean;
  forbidPass: boolean;
  pass: boolean;
  detail: string;
}

export interface EvalReport {
  total: number;
  passed: number;
  /** 通过率；没有用例时为 null，不是 0。 */
  accuracy: number | null;
  /** 只看 seed 标签的那一份。 */
  seed: { total: number; passed: number; accuracy: number | null };
  human: { total: number; passed: number; accuracy: number | null };
  /** 问题带错误前提的用例中，纠正了的比例。 */
  premiseCorrection: { total: number; corrected: number; rate: number | null };
  outcomes: CaseOutcome[];
  /** 结论不带置信度，校准度算不出来。写清楚，不留一个空格让人猜。 */
  calibration: 'not-applicable';
  calibrationReason: string;
}

/** 把一场辩论的全部可见文字拼起来，用来查关键词。 */
export function debateText(state: DebateState): string {
  const parts: string[] = [];
  for (const round of state.rounds) {
    for (const message of round.messages) parts.push(message.text);
    for (const claim of round.claims ?? []) parts.push(claim.text);
  }
  if (state.verdict?.conclusion) parts.push(state.verdict.conclusion);
  if (state.verdict?.rationale) parts.push(state.verdict.rationale);
  return parts.join('\n');
}

export function scoreCase(item: LabeledCase, state: DebateState): CaseOutcome {
  const actual = state.verdict?.verdict ?? null;
  // `expectVerdict: null` 表示「不要求具体档位，但不能是 supported」——
  // 场景是「证据不足或工具失败」，此时给 supported 就是伪造结论。
  const verdictPass = item.expectVerdict === null
    ? actual !== null && actual !== 'supported'
    : actual === item.expectVerdict;
  const text = debateText(state);
  const anyOf = item.expectAnyOf ?? [];
  const keywordPass = anyOf.length === 0 || anyOf.some(word => text.includes(word));
  const forbid = item.forbidAnyOf ?? [];
  const forbidPass = forbid.every(word => !text.includes(word));
  const pass = verdictPass && keywordPass && forbidPass;
  const detail = [
    `结论 ${actual ?? '无'}`,
    item.expectVerdict === null ? '要求：非 supported' : `要求：${item.expectVerdict}`,
    anyOf.length > 0 ? `关键词 ${keywordPass ? '命中' : `未命中（${anyOf.join(' / ')}）`}` : '',
    forbid.length > 0 ? `禁词 ${forbidPass ? '未出现' : '出现了'}` : ''
  ].filter(Boolean).join('；');
  return {
    id: item.id,
    expected: item.expectVerdict,
    actual,
    verdictPass,
    keywordPass,
    forbidPass,
    pass,
    detail
  };
}

export function evaluateCases(
  cases: readonly LabeledCase[],
  states: ReadonlyMap<string, DebateState>
): EvalReport {
  const outcomes: CaseOutcome[] = [];
  for (const item of cases) {
    const state = states.get(item.id);
    if (!state) {
      outcomes.push({
        id: item.id,
        expected: item.expectVerdict,
        actual: null,
        verdictPass: false,
        keywordPass: false,
        forbidPass: true,
        pass: false,
        detail: '这场辩论没有跑起来'
      });
      continue;
    }
    outcomes.push(scoreCase(item, state));
  }

  const rate = (passed: number, total: number): number | null =>
    total > 0 ? Math.round((passed / total) * 100) / 100 : null;
  const group = (source: LabeledCase['labelSource']) => {
    const ids = new Set(cases.filter(item => item.labelSource === source).map(item => item.id));
    const items = outcomes.filter(item => ids.has(item.id));
    const passed = items.filter(item => item.pass).length;
    return { total: items.length, passed, accuracy: rate(passed, items.length) };
  };

  const premiseCases = cases.filter(item => item.wrongPremise);
  // 「纠正了错误前提」只看到底有没有说出正确说法，不看结论档位：
  // 一句算术事实没有页面链接时，裁判会如实给 insufficient_evidence，
  // 那和「有没有纠正前提」是两件事，混在一起算会把纠正记成没纠正。
  const corrected = premiseCases.filter(item => {
    const outcome = outcomes.find(entry => entry.id === item.id);
    return Boolean(outcome?.keywordPass);
  }).length;
  const passed = outcomes.filter(item => item.pass).length;

  return {
    total: outcomes.length,
    passed,
    accuracy: rate(passed, outcomes.length),
    seed: group('seed'),
    human: group('human'),
    premiseCorrection: {
      total: premiseCases.length,
      corrected,
      rate: rate(corrected, premiseCases.length)
    },
    outcomes,
    calibration: 'not-applicable',
    calibrationReason: '五档结论不带置信度，没有可信的置信度就谈不上校准；要做得先让裁判输出概率并有人工基准集'
  };
}
