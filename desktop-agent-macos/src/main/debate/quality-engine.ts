/**
 * DebateQualityEngine（V3.0 P1/P2 的规则+模型评审编排层）。
 *
 * 这里不调用模型，也不新建 Runtime；它只把现有规则质量门槛、JudgeVerdict、
 * Evidence/Dispute/Revision 组合成可审计的质量报告和 Final Judge 决策。
 * 模型评审由 JudgeEngine 完成，结果作为输入传进来。
 *
 * 三层验收（V3.0 审核结论）：
 *
 * 1. `rule-confirmed`：规则/源码/测试直接确认，能自动判；
 * 2. `model-assessed`：模型评审，只能标「模型评估过」，不是事实准确率；
 * 3. `unknown` / `insufficient`：没有依据，必须留白。
 *
 * 关键边界：`factualAccuracy` 没有外部可验证来源时只能是 `model-assessed`、
 * `insufficient` 或 `unknown`，不能因为模型 Judge 说 passed 就变成事实正确。
 */
import { assessDebate, type QualityAssessment } from './quality';
import type {
  DebateDispute,
  DebateRevision,
  DebateState,
  DebateVerdict,
  DimensionJudgment,
  Verdict
} from './types';
import type { ArgumentQuality, JudgeVerdict } from '../judge/types';

export type QualityStatus =
  | 'supported'
  /** 模型评审过，但未经外部事实核验；不能读成事实正确。 */
  | 'model-assessed'
  | 'contradicted'
  | 'insufficient'
  | 'unknown';

export interface QualityDimension {
  status: QualityStatus;
  basis: string[];
  evidenceRefs?: string[];
  note?: string;
}

export interface DebateQualityReport {
  debateId: string;
  /**
   * `passed` 只表示「评估流程完成」：规则门槛通过、模型评审实际发生、
   * 裁判没有标 undetermined。它永远不表示事实已核验。
   */
  status: 'passed' | 'needs_revision' | 'insufficient_evidence' | 'inconclusive' | 'failed';
  dimensions: {
    factualAccuracy: QualityDimension;
    logicalValidity: QualityDimension;
    evidenceQuality: QualityDimension;
    counterargumentCoverage: QualityDimension;
    revisionQuality: QualityDimension;
    contradictionDetection: QualityDimension;
    uncertaintyCalibration: QualityDimension;
    conclusionConsistency: QualityDimension;
  };
  unresolvedDisputes: string[];
  criticalIssues: string[];
  recommendedAction:
    | 'accept'
    | 'continue_debate'
    | 'request_evidence'
    | 'independent_review'
    | 'stop_with_uncertainty';
  explanation: string;
  rule: QualityAssessment;
  modelAssessed: boolean;
}

export interface FinalDebateDecision {
  debateId: string;
  /**
   * 直接复用现有五档结论，不新增第三套“结论状态”。模型版裁判没有五档时，
   * 有结论也只标 `partially_supported`：模型评审不等于外部事实核验。
   */
  verdict: Verdict;
  /**
   * 基于 `verdict` + 质量报告的处理建议；它是动作，不是事实判断。
   * 只有 factualAccuracy 真的 `supported` 才会出现 `accept`。
   */
  action: 'accept' | 'accept_with_caveats' | 'reject' | 'hold';
  conclusion: string | null;
  supportingArguments: string[];
  opposingArguments: string[];
  unresolvedDisputes: string[];
  uncertainty: { level: string; explanation: string };
  reviewSummary: string;
  recommendedFollowUp?: string;
}

/** 规则版结论与模型版裁判的结构不同；这里只收两种真实存在的形状。 */
export type QualityVerdict = JudgeVerdict | DebateVerdict;

export interface QualityInputs {
  state: DebateState;
  /** 模型版 JudgeVerdict 或规则版 DebateVerdict；不传时读 state.verdict。 */
  verdict?: QualityVerdict | null;
  /** 模型评审是否实际发生过；由调用方如实传入，不能猜。 */
  modelAssessed?: boolean;
}

interface NormalizedVerdict {
  backend: 'model' | 'rules';
  fiveTier: Verdict | null;
  conclusion: string | null;
  undetermined: boolean;
  confidence: { level: 'low' | 'medium' | 'high'; why: string } | null;
  argumentQuality: ArgumentQuality[];
  unresolved: string[];
  dimensions: DimensionJudgment[];
}

function dim(
  status: QualityStatus,
  basis: string[],
  evidenceRefs?: string[]
): QualityDimension {
  return { status, basis, ...(evidenceRefs && evidenceRefs.length > 0 ? { evidenceRefs } : {}) };
}

/**
 * `DebateVerdict.backend` 也是 `'rules'`，不能靠 backend 区分；
 * 只有模型版裁判才有 `argumentQuality`。
 */
export function isJudgeVerdict(verdict: QualityVerdict): verdict is JudgeVerdict {
  return 'argumentQuality' in verdict;
}

export function normalizeVerdict(verdict: QualityVerdict): NormalizedVerdict {
  if (isJudgeVerdict(verdict)) {
    return {
      backend: verdict.backend,
      // 模型版没有五档结论；undetermined 是它自己的「证据不足」表达。
      fiveTier: verdict.undetermined ? 'insufficient_evidence' : null,
      conclusion: verdict.conclusion,
      undetermined: verdict.undetermined,
      confidence: verdict.confidence,
      argumentQuality: verdict.argumentQuality,
      unresolved: verdict.unresolved.map(item => item.question),
      dimensions: []
    };
  }
  return {
    backend: verdict.backend,
    fiveTier: verdict.verdict,
    conclusion: verdict.conclusion,
    undetermined: verdict.verdict === 'insufficient_evidence',
    // 规则版没有置信度；给一个数字就是编的。
    confidence: null,
    argumentQuality: [],
    unresolved: verdict.unresolved,
    dimensions: verdict.dimensions
  };
}

function disputesOf(state: DebateState): DebateDispute[] {
  return state.disputes ?? [];
}

function revisionsOf(state: DebateState): DebateRevision[] {
  return state.revisions ?? [];
}

function logicalValidityOf(
  verdict: QualityVerdict,
  normalized: NormalizedVerdict
): QualityDimension {
  if (isJudgeVerdict(verdict)) {
    if (normalized.argumentQuality.length === 0) {
      return dim('unknown', ['模型裁判没有给出论证质量记录']);
    }
    const average = normalized.argumentQuality.reduce((sum, item) => sum + item.score, 0) /
      normalized.argumentQuality.length;
    if (average >= 0.7) {
      return dim('supported', [`模型裁判论证质量均值 ${average.toFixed(2)}（model-assessed）`]);
    }
    if (average >= 0.4) {
      return dim('insufficient', [`模型裁判论证质量均值 ${average.toFixed(2)}，证据不足以判为通过`]);
    }
    return dim('contradicted', [`模型裁判论证质量均值 ${average.toFixed(2)}`]);
  }

  const logic = normalized.dimensions.find(item => item.dimension === 'logic');
  if (!logic) return dim('unknown', ['规则结论没有逻辑维度']);
  const reason = logic.rationale ? `：${logic.rationale}` : '';
  switch (String(logic.outcome)) {
    case 'valid':
      return dim('supported', [`规则判定 logic=valid${reason}`]);
    case 'questionable':
      return dim('insufficient', [`规则判定 logic=questionable${reason}`]);
    case 'invalid':
      return dim('contradicted', [`规则判定 logic=invalid${reason}`]);
    default:
      return dim('unknown', [`规则判定 logic=${String(logic.outcome)}，不可判${reason}`]);
  }
}

export function evaluateDebateQuality(inputs: QualityInputs): DebateQualityReport {
  const state = inputs.state;
  const verdict = inputs.verdict ?? state.verdict ?? null;
  const normalized = verdict ? normalizeVerdict(verdict) : null;
  // 只有「调用方说评审过」且「裁决真的是模型版」才算模型评审；退回规则版
  // 时 backend 是 'rules'，不能因为入参写 true 就冒充。
  const modelAssessed = inputs.modelAssessed === true && normalized?.backend === 'model';
  const rule = assessDebate(state);
  const evidence = state.evidence ?? [];
  const disputes = disputesOf(state);
  const revisions = revisionsOf(state);
  const sourceRefs = evidence
    .filter(item => item.verified === 'page-link')
    .map(item => item.evidenceId);
  const unresolved = normalized?.unresolved ?? [];
  const critical: string[] = [];
  if (!verdict) critical.push('没有可复算的裁判结论');
  if (disputes.some(item => item.status === 'open')) critical.push('仍有未解决争议');
  if (revisions.some(item => item.decision === null)) critical.push('存在无法判定的观点修订');
  if (normalized?.backend === 'rules' && inputs.modelAssessed === true) {
    critical.push('标了 modelAssessed，但 verdict.backend 是 rules；按规则版处理');
  }

  const factualBasis: string[] = [];
  if (sourceRefs.length > 0) {
    factualBasis.push(`${String(sourceRefs.length)} 条页面链接，只证明来源存在，未抓取正文核验`);
  }
  if (modelAssessed) {
    factualBasis.push('模型裁判评估了主张与引用的一致性，未经外部事实核验');
  }
  if (factualBasis.length === 0) factualBasis.push('没有外部可验证来源');

  // 模型评审只能标 model-assessed；没有模型评审但有链接只算 insufficient；
  // 两者都没有就是 unknown。任何情况下都不自动升成 supported。
  const factualAccuracy = modelAssessed
    ? dim('model-assessed', factualBasis, sourceRefs)
    : sourceRefs.length > 0
      ? dim('insufficient', factualBasis, sourceRefs)
      : dim('unknown', factualBasis);

  const evidenceQuality = evidence.length === 0
    ? dim('insufficient', ['没有工程/网页证据'])
    : sourceRefs.length > 0
      ? dim('insufficient', [`有 ${String(evidence.length)} 条证据，但没有验证为可核验事实`], sourceRefs)
      : dim('unknown', [`有 ${String(evidence.length)} 条证据，来源未核验`]);

  const counterargumentCoverage = disputes.length > 0 && revisions.length > 0
    ? dim('supported', [`${String(disputes.length)} 条争议，${String(revisions.length)} 条修订`])
    : disputes.length > 0
      ? dim('insufficient', ['有争议，但没有修订记录'])
      : dim('unknown', ['没有检测到争议']);

  const revisionQuality = revisions.length === 0
    ? dim('unknown', ['没有观点修订'])
    : revisions.every(item => item.decision !== null)
      ? dim('supported', [`${String(revisions.length)} 条修订都有明确 decision`])
      : dim('insufficient', ['存在 decision 为 null 的修订']);

  const contradictionDetection = disputes.length > 0
    ? dim('supported', [`检测到 ${String(disputes.length)} 条争议`])
    : dim('unknown', ['没有检测到可判定争议']);

  const uncertaintyCalibration = normalized?.undetermined === true ||
    normalized?.confidence?.level === 'low'
    ? dim('supported', [
        normalized.undetermined
          ? '裁判保留了 undetermined，没有强行给结论'
          : '模型裁判给了 low confidence，没有把结论说死'
      ])
    : verdict
      ? dim('insufficient', ['给出了结论，但没有外部事实核验'])
      : dim('unknown', ['没有裁判结论']);

  const conclusionConsistency = rule.ok
    ? dim('supported', ['规则质量门槛通过'])
    : dim('contradicted', rule.gates.filter(gate => !gate.passed).map(gate => gate.label));

  let status: DebateQualityReport['status'];
  if (!verdict) status = 'failed';
  else if (!rule.ok) status = 'needs_revision';
  else if (normalized?.undetermined) status = 'inconclusive';
  else if (!modelAssessed) status = 'insufficient_evidence';
  else status = 'passed';

  const recommendedAction: DebateQualityReport['recommendedAction'] =
    status === 'failed' ? 'independent_review'
      : status === 'needs_revision' ? 'continue_debate'
        : status === 'inconclusive' ? 'request_evidence'
          : status === 'insufficient_evidence' ? 'request_evidence'
            // 评估流程通过也不等于事实已核验；只有外部核验支持时才 accept。
            : factualAccuracy.status === 'supported' ? 'accept' : 'request_evidence';

  return {
    debateId: state.debateId,
    status,
    dimensions: {
      factualAccuracy,
      logicalValidity: verdict
        ? logicalValidityOf(verdict, normalized as NormalizedVerdict)
        : dim('unknown', ['没有裁判结论']),
      evidenceQuality,
      counterargumentCoverage,
      revisionQuality,
      contradictionDetection,
      uncertaintyCalibration,
      conclusionConsistency
    },
    unresolvedDisputes: unresolved,
    criticalIssues: critical,
    recommendedAction,
    explanation: [
      `规则门槛 ${String(rule.passed)}/${String(rule.total)}`,
      `证据 ${String(evidence.length)} 条`,
      `争议 ${String(disputes.length)} 条`,
      `修订 ${String(revisions.length)} 条`,
      modelAssessed ? '含模型评审（model-assessed，不是事实核验）' : '仅规则/结构评估'
    ].join('；'),
    rule,
    modelAssessed
  };
}

export function finalizeDebate(
  state: DebateState,
  verdict: QualityVerdict | null,
  quality: DebateQualityReport
): FinalDebateDecision {
  const normalized = verdict ? normalizeVerdict(verdict) : null;
  // 质量报告通过不等于事实通过：只有在 factualAccuracy 真的 supported 时才
  // 允许 accept；当前没有外部核验通道，所以实际只会落到带保留的处理。
  const factVerified = quality.dimensions.factualAccuracy.status === 'supported';
  const finalVerdict: Verdict =
    normalized?.fiveTier ??
      (!normalized || normalized.undetermined || normalized.conclusion === null
        ? 'insufficient_evidence'
        : factVerified ? 'supported' : 'partially_supported');
  const action: FinalDebateDecision['action'] =
    finalVerdict === 'unsupported' || finalVerdict === 'contradicted'
      ? 'reject'
      : finalVerdict === 'insufficient_evidence' ||
          quality.status === 'failed' ||
          quality.status === 'needs_revision'
        ? 'hold'
        : finalVerdict === 'supported' && factVerified
          ? 'accept'
          : 'accept_with_caveats';

  const supporting = verdict
    ? isJudgeVerdict(verdict)
      ? verdict.argumentQuality
        .filter(item => item.score >= 0.5)
        .map(item => `${item.agentId}：${item.why}`)
      : verdict.claimJudgments
        .filter(item => item.verdict === 'supported' || item.verdict === 'partially_supported')
        .map(item => `${item.agentId}：${item.claimText}`)
    : [];
  const opposing = state.minorities.map(item => `${item.agentId}：${item.text.slice(0, 180)}`);

  return {
    debateId: state.debateId,
    verdict: finalVerdict,
    action,
    conclusion: normalized?.conclusion ?? null,
    supportingArguments: supporting,
    opposingArguments: opposing,
    unresolvedDisputes: quality.unresolvedDisputes,
    uncertainty: {
      level: normalized?.confidence?.level ?? 'low',
      explanation: normalized?.confidence?.why ??
        (normalized
          ? '规则版结论没有置信度；也不代表外部事实核验'
          : '没有裁判结论，不能把辩论结果当确定事实')
    },
    reviewSummary: quality.explanation,
    ...(quality.recommendedAction === 'request_evidence'
      ? { recommendedFollowUp: '补充可核验来源后再裁决' }
      : {})
  };
}

/**
 * 供调用方判断是否可以把质量报告标成通过；不能只看 modelAssessed，也不能
 * 把模型评审当事实核验。事实维度必须是 model-assessed，且模型版裁判实际
 * 运行过（不是退回规则版）。
 */
export function isQualityPass(report: DebateQualityReport): boolean {
  return report.status === 'passed' &&
    report.dimensions.conclusionConsistency.status === 'supported' &&
    report.dimensions.factualAccuracy.status === 'model-assessed' &&
    report.modelAssessed;
}
