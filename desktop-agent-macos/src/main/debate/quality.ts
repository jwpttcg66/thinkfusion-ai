/**
 * 辩论质量门槛（任务书 §14.3 / §7）。
 *
 * 「质量达标」必须先能判定。这里只放**能从落盘数据算出来、且与任何模型措辞
 * 无关**的硬门槛：结论是不是当前规则算出来的、结论档位和证据强度自不自洽、
 * 有没有票数、少数派原文还在不在、同源有没有被重复计数。
 *
 * 三项明确不放进来，因为本仓库算不了，写个 0 分或 100 分都是编的：
 *
 * - **人工事实准确率**：需要人逐条标注的基准集。`eval.ts` 里的标签是规则
 *   推出来的（`labelSource: rule / seed`），报告里分开算，不叫准确率。
 * - **概率校准度**：五档结论不带置信度。这里做的是「档位 ↔ 证据强度自洽」，
 *   是确定性一致性检查，不是置信度校准，两者不能互相冒充。
 * - **Token / 费用**：三条通道都不报用量。
 *
 * 门槛是布尔的，不打分、不设「综合质量分」：把十项乘加成一个数字，就没人
 * 知道分数变高是因为不投票了，还是因为跑得更久。
 */
import { judgeDebate } from './judges';
import { independentSourceCount } from './evidence';
import type { DebateState, DimensionJudgment, Verdict } from './types';

export interface QualityGate {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
  /** 为什么这条算硬门槛：任务书条款或可复核的事实。 */
  basis: string;
}

export interface QualityAssessment {
  debateId: string;
  question: string;
  gates: QualityGate[];
  passed: number;
  total: number;
  ok: boolean;
}

/** 结论里不该出现的字段：一出现就说明有人把三维压回一个数或按人头计数。 */
const FORBIDDEN_VERDICT_KEYS = [
  'score', 'confidence', 'supportCount', 'opposeCount', 'votes',
  'voteCount', 'weightedScore', 'majority'
];

function gate(
  id: string,
  label: string,
  passed: boolean,
  detail: string,
  basis: string
): QualityGate {
  return { id, label, passed, detail, basis };
}

/**
 * 单场辩论的质量门槛。
 *
 * 输入是**已经跑完并落盘**的状态：不重新问模型，也不修改任何东西。
 * 老辩论文件缺字段时，相关门槛按「没记录过」处理，不假装失败也不假装通过。
 */
export function assessDebate(state: DebateState): QualityAssessment {
  const verdict = state.verdict;
  /**
   * 用**全量**逐条判定，不用 `verdict.claimJudgments`：后者在整场合成时有意
   * 过滤掉了问句（`logic.outcome === 'not_applicable'`），拿它比「每条主张
   * 有没有判定」会把模型说的每一个问句都误报成漏判。真机第二次跑出
   * 「主张 45 条、漏判 3」就是这么来的——那 3 条恰好是 challenge 轮的问句。
   */
  const judgments = state.judgments ?? verdict?.claimJudgments ?? [];
  const hasFullJudgments = (state.judgments ?? []).length > 0;
  const evidence = state.evidence ?? [];
  const gates: QualityGate[] = [];
  const add = (...args: Parameters<typeof gate>) => gates.push(gate(...args));

  // 1. 结论可复算：落盘的结论必须是当前规则对同一份发言/证据算出来的。
  //    规则升级后读老文件会对不上——那正是要暴露的，而不是悄悄沿用旧结论。
  const recomputed = judgeDebate(state, { at: verdict?.createdAt ?? state.updatedAt });
  const sameVerdict = Boolean(verdict) && recomputed.verdict.verdict === verdict?.verdict;
  const sameConclusion = Boolean(verdict) && recomputed.verdict.conclusion === verdict?.conclusion;
  const sameJudgments = judgments.length === recomputed.judgments.length &&
    judgments.every((item, index) =>
      item.claimId === recomputed.judgments[index]?.claimId &&
      item.verdict === recomputed.judgments[index]?.verdict
    );
  add(
    'verdict.recomputable',
    '结论可由当前规则复算',
    sameVerdict && sameConclusion && sameJudgments,
    verdict
      ? `落盘 ${verdict.verdict} / 重算 ${recomputed.verdict.verdict}；逐条判定 ${sameJudgments ? '一致' : '不一致'}`
      : '这场没有结论',
    '任务书 §17「所有模型输出均需结构化校验」；结论不该是读不回来的黑箱'
  );

  // 2. 没有票数、没有平均分、没有伪造置信度。
  const keys = verdict ? Object.keys(verdict) : [];
  const forbidden = keys.filter(key => FORBIDDEN_VERDICT_KEYS.includes(key));
  add(
    'verdict.no_vote_or_score',
    '结论里没有票数、总分或伪造置信度',
    forbidden.length === 0,
    forbidden.length > 0 ? `出现了：${forbidden.join('、')}` : '没有票数字段，也没有把三维压成一个分',
    'AC-12 不按多数投票判真伪；任务书 §7.1 三维各自保留独立 verdict 与理由'
  );

  // 3. 三维独立且各带理由（界面上直接显示的就是这三份）。
  const dimensions: DimensionJudgment[] = verdict?.dimensions ?? [];
  const dimsOk = dimensions.length === 3 &&
    new Set(dimensions.map(item => item.dimension)).size === 3 &&
    dimensions.every(item => item.rationale.trim().length > 0);
  add(
    'verdict.three_dimensions',
    '逻辑 / 证据 / 反例三维各自出结论与理由',
    dimsOk,
    dimsOk ? '三维齐全且都有理由' : `实际 ${dimensions.length} 维`,
    'AC-11；用户明确要求「不要让 FinalJudge 把三个维度简单平均」'
  );

  // 4. 结论档位与证据强度自洽：说「有证据支持」，被选中那句就必须真有
  //    可核验的独立来源；说「证据不足」，就不能同时存在充分证据的主张被晾着。
  const chosen = verdict?.conclusionClaimId
    ? judgments.find(item => item.claimId === verdict.conclusionClaimId)
    : undefined;
  const evidenceOutcomeOf = (claimId: string): string | null =>
    judgments.find(item => item.claimId === claimId)?.dimensions
      .find(dim => dim.dimension === 'evidence')?.outcome ?? null;
  let consistent = true;
  const consistency: string[] = [];
  if (verdict) {
    if (verdict.verdict === 'supported' || verdict.verdict === 'partially_supported') {
      const outcome = chosen ? evidenceOutcomeOf(chosen.claimId) : null;
      if (outcome !== 'sufficient' && outcome !== 'partial') {
        consistent = false;
        consistency.push(`结论是 ${verdict.verdict}，被选中主张的证据维度却是 ${outcome ?? '缺失'}`);
      }
    }
    if (verdict.verdict === 'insufficient_evidence') {
      const sufficient = judgments.filter(item => evidenceOutcomeOf(item.claimId) === 'sufficient');
      if (sufficient.length > 0 && verdict.rationale && !/争议的双方|未解决|冲突/.test(verdict.rationale)) {
        consistent = false;
        consistency.push(`${sufficient.length} 条主张有充分证据，整场却写成证据不足且未说明是分歧未决`);
      }
    }
    if (verdict.verdict === 'unsupported') {
      const notUnsupported = judgments.filter(item => item.verdict !== 'unsupported');
      if (notUnsupported.length > 0) {
        consistent = false;
        consistency.push(`还有 ${notUnsupported.length} 条不是「不成立」，整场不该判 unsupported`);
      }
    }
  }
  add(
    'verdict.evidence_consistent',
    '结论档位与证据强度自洽',
    consistent,
    consistency.length > 0 ? consistency.join('；') : '档位与三维判定一致',
    'AC-13：insufficient_evidence 不等于 unsupported；任务书 §7.3 充分性'
  );

  // 5. 没有页面链接时，任何一句都不许被判成「有证据支持」。
  //    这里只看「有没有可点开的地址」，不管独立性——同源是第 6 项的事。
  //    `independent` 是整场视角的「谁是第一条」，转载那条也有真实地址，
  //    拿它过滤会凭空把转载主张说成「没有链接」。
  const pageLinks = evidence.filter(item => item.verified === 'page-link');
  const supported = judgments.filter(item => item.verdict === 'supported');
  const noLinkOverclaim = supported.filter(item =>
    !evidence.some(e => e.claimIds.includes(item.claimId) && e.verified === 'page-link')
  );
  add(
    'evidence.no_support_without_link',
    '没有可核验链接就不能判 supported',
    noLinkOverclaim.length === 0,
    `${pageLinks.length} 条页面链接 / ${supported.length} 条 supported 主张；越界 ${noLinkOverclaim.length} 条`,
    '任务书 §7.2 证据优先级；「页面没给链接」不能当成「来源已核验」'
  );

  // 6. 同源只算一个独立来源。口径与 `independentSourceCount` 保持一致：
  //    按 `originKey` 去重后的地址数，而不是整场 `independent` 标记。
  //    TF-D-012 禁止的是「同一份材料被算成 2 个独立来源」，不是禁止
  //    两条不同主张各引一次同一份文档。
  let duplicateCounted = false;
  const originFirst = new Map<string, number>();
  for (const item of evidence) {
    if (item.verified !== 'page-link' || !item.originKey) continue;
    originFirst.set(item.originKey, (originFirst.get(item.originKey) ?? 0) + 1);
  }
  for (const item of evidence) {
    if (item.verified === 'page-link' && item.originKey && item.independent &&
        (originFirst.get(item.originKey) ?? 0) > 1) {
      // 同一 originKey 只允许一条证据被标成 independent=true。
      const others = evidence.filter(e =>
        e !== item && e.verified === 'page-link' && e.originKey === item.originKey && e.independent
      );
      if (others.length > 0) duplicateCounted = true;
    }
  }
  for (const judgment of judgments) {
    const mine = evidence.filter(item => item.claimIds.includes(judgment.claimId));
    const independent = independentSourceCount(mine, judgment.claimId);
    const uniqueOrigins = new Set(
      mine.filter(item => item.verified === 'page-link').map(item => item.originKey ?? item.evidenceId)
    );
    if (independent > uniqueOrigins.size) duplicateCounted = true;
  }
  add(
    'evidence.no_duplicate_independence',
    '同源转载不重复计为独立来源',
    !duplicateCounted,
    duplicateCounted ? '同一来源被计成多条独立证据' : '独立来源数等于按地址去重后的来源数',
    'AC-10 / TF-D-012；用户明确要求「内容指纹不等于来源独立性」'
  );

  // 7. 少数派原文完整保留（设计上必须 100%，掉了就是回归）。
  const messageIds = new Set(state.rounds.flatMap(round => round.messages.map(msg => msg.messageId)));
  const minorities = state.minorities ?? [];
  const preserved = minorities.filter(msg => messageIds.has(msg.messageId)).length;
  add(
    'minority.preserved',
    '少数派原文完整保留',
    preserved === minorities.length,
    `${preserved}/${minorities.length}`,
    '任务书 §14.3 分歧保留率；TF-D-008 少数派可以胜出'
  );

  // 8. 事件流幂等（老文件没有 events 就跳过，不伪造通过）。
  const events = state.events;
  let eventsOk = true;
  let eventDetail = '老文件没有事件流，不判定';
  if (events && events.length > 0) {
    const keys = events.map(item => item.key);
    const seqs = events.map(item => item.seq);
    eventsOk = new Set(keys).size === keys.length &&
      seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]);
    eventDetail = eventsOk ? `${events.length} 条事件，key 唯一且 seq 单调` : 'key 重复或 seq 不单调';
  }
  add('events.idempotent', '事件 key 幂等、seq 单调', eventsOk, eventDetail, 'AC-14 幂等事件记录');

  // 9. 每条主张都有三维判定，且没有凭空多出来的 judgment。
  const claims = state.rounds.flatMap(round => round.claims ?? []);
  const judgedIds = new Set(judgments.map(item => item.claimId));
  const claimIds = new Set(claims.map(item => item.claimId));
  const missing = [...claimIds].filter(id => !judgedIds.has(id));
  const orphan = [...judgedIds].filter(id => !claimIds.has(id));
  add(
    'judgments.cover_claims',
    '每条主张都有判定，没有孤儿判定',
    claims.length === 0 || !hasFullJudgments
      ? true
      : missing.length === 0 && orphan.length === 0,
    claims.length === 0
      ? '没有抽出主张，不判定'
      : !hasFullJudgments
        ? '老文件只有整场合成用的判定子集，不判定覆盖率'
        : `主张 ${claims.length} 条；漏判 ${missing.length}，孤儿 ${orphan.length}`,
    '任务书 §17「所有模型输出均需结构化校验」'
  );

  // 整场合成用的子集必须正好是「全量判定里去掉问句」的那部分。
  const subset = verdict?.claimJudgments;
  let subsetOk = true;
  let subsetDetail = '老文件没有全量判定，不判定';
  if (hasFullJudgments && subset) {
    const expected = new Set(
      judgments.filter(item =>
        item.dimensions.find(dim => dim.dimension === 'logic')?.outcome !== 'not_applicable'
      ).map(item => item.claimId)
    );
    const actual = new Set(subset.map(item => item.claimId));
    subsetOk = expected.size === actual.size && [...expected].every(id => actual.has(id));
    subsetDetail = subsetOk
      ? `合成子集 ${actual.size} 条 = 全量 ${judgments.length} 条去掉 ${judgments.length - actual.size} 条问句`
      : `合成子集 ${actual.size} 条，应为 ${expected.size} 条`;
  }
  add(
    'judgments.verdict_subset',
    '整场合成只去掉问句，不丢可判主张',
    subsetOk,
    subsetDetail,
    'AC-11 / §7.1：问句不判真假，但其他主张一条都不能在合成时消失'
  );

  // 10. 论证图的边都带轮次与来源（老文件没有图就跳过）。
  const graph = state.graph;
  let graphOk = true;
  let graphDetail = '老文件没有论证图，不判定';
  if (graph && graph.edges.length > 0) {
    const bad = graph.edges.filter(edge =>
      typeof edge.roundIndex !== 'number' || !edge.source ||
      (!edge.source.messageIds?.length && !edge.source.claimIds?.length &&
        !edge.source.disputeId && !edge.source.revisionId && !edge.source.evidenceId)
    );
    graphOk = bad.length === 0;
    graphDetail = `${graph.edges.length} 条边，缺轮次或来源 ${bad.length} 条`;
  }
  add('graph.traceable_edges', '论证边关联轮次与来源对象', graphOk, graphDetail,
    'AC-08；用户明确要求「不要只保存最终图，否则无法还原关系如何形成」');

  const passed = gates.filter(item => item.passed).length;
  return {
    debateId: state.debateId,
    question: state.question,
    gates,
    passed,
    total: gates.length,
    ok: passed === gates.length
  };
}

/** 一组辩论的汇总：任一门槛不过就算整组不达标。 */
export function assessAll(states: readonly DebateState[]): {
  assessments: QualityAssessment[];
  byGate: Array<{ id: string; label: string; basis: string; passed: number; total: number }>;
  total: number;
  passed: number;
  ok: boolean;
} {
  const assessments = states.map(assessDebate);
  const byGate = new Map<string, { id: string; label: string; basis: string; passed: number; total: number }>();
  for (const item of assessments) {
    for (const g of item.gates) {
      const row = byGate.get(g.id) ?? { id: g.id, label: g.label, basis: g.basis, passed: 0, total: 0 };
      row.total += 1;
      if (g.passed) row.passed += 1;
      byGate.set(g.id, row);
    }
  }
  const all = [...byGate.values()];
  return {
    assessments,
    byGate: all,
    total: all.reduce((sum, row) => sum + row.total, 0),
    passed: all.reduce((sum, row) => sum + row.passed, 0),
    ok: assessments.every(item => item.ok)
  };
}

/** 报告里如实列出的「本仓库无法达标」项，以及要达标需要什么。 */
export const NOT_MEASURABLE: Array<{ item: string; reason: string; needs: string }> = [
  {
    item: '人工事实准确率',
    reason: '基准集标签由任务书规则推出，未经人工逐条复核；一致率只能读作「与规则基准一致」',
    needs: '人对每个场景标注正确结论档位与依据（`labelSource: human`），并扩充到有统计意义的条数'
  },
  {
    item: '概率校准度',
    reason: '五档结论不带置信度；给一个数字就是编的。这里做的是确定性的「档位 ↔ 证据强度自洽」',
    needs: '先让裁判输出有依据的概率，再有人工标注集可比'
  },
  {
    item: 'Token / 费用预算',
    reason: '网页通道无接口，本地 Ollama 响应无 usage，云端 Provider 只有部分返回',
    needs: '三条通道统一上报用量'
  },
  {
    item: '裁判读网页正文',
    reason: '只保留页面回答里的链接与文本线索，不抓取网页内容，判不了「引用内容确实存在」',
    needs: '独立的正文抓取与快照留存（另立项，不破坏现有提取器）'
  }
];

/** 五档结论的中文标签，报告用。 */
export const VERDICT_LABEL: Record<Verdict, string> = {
  supported: '有证据支持',
  partially_supported: '部分支持',
  unsupported: '不成立',
  contradicted: '被反证推翻',
  insufficient_evidence: '证据不足（不等于错）'
};
