import type { SubAgentAnswer, SubAgentTask } from '../agents/types';
import { judgeDebate } from '../debate/judges';
import { evaluateDebateQuality, finalizeDebate } from '../debate/quality-engine';
import { applyJudgePackEvidence, refreshClaimEvidenceLinks } from '../debate/claim-evidence-links';
import type { DebateState } from '../debate/types';
import { JudgeEngine } from './engine';
import { resolveJudge, type JudgeCandidateInfo } from './resolve';
import type {
  JudgeReselection,
  JudgeReselectionAttempt,
  JudgeVerdict,
  RulesConclusionNote
} from './types';

/**
 * 裁决的公共编排层（Gate 0B）。
 *
 * 之前同一件事有三个入口、两套选人逻辑：IPC 里内联一遍、24 题回归脚本自己
 * `new JudgeEngine` 一遍（连裁判都是脚本按轮换指定、不走 `resolveJudge`）、
 * 每场辩论结束时又跑一遍三维规则。回归绿了不代表产品路径绿，说的就是这种分叉。
 *
 * 这里只做**机制**：选人 → 调用 → 解析 → 失败换人 → 兜底 → 归一化 → 附带质量
 * 报告与最终决策。它不定义评价标准：`judgeDebate` 仍然持有三维判定，
 * `evaluateDebateQuality` 仍然持有质量维度，一行都没搬。
 *
 * 两处刻意不改：
 *
 * 1. **不动 `judgeDebate` 的判定**。`debate/quality.ts` 用它对落盘结论做复算
 *    校验（`verdict.recomputable`），动一次判定，全部历史辩论这条门槛会集体
 *    翻红，24 题里已过的题会变成「需要修订」。
 * 2. **不改结论措辞的来源**。退回规则版时用哪句话当结论，属于语义变更，
 *    会直接改变 24 题的答案，不该混在「抽公共核」这一步里做；这里只把
 *    「谁是权威」写进记录（`rulesConclusion`），让两套规则不一致时看得见。
 */

export interface AdjudicateDeps {
  /** 每次现选：用户可能刚配好 Key、刚改完模型名。 */
  candidates: () => Promise<readonly JudgeCandidateInfo[]>;
  ask: (agentId: string, task: SubAgentTask) => Promise<SubAgentAnswer>;
  /** 调用方指定优先用谁（回归脚本按轮换指定裁判就走这里）。 */
  preferredJudgeId?: string;
  /** 最多换几个人；默认 2。再多就是在赌小概率，不如如实退回规则版。 */
  maxReselections?: number;
}

const DEFAULT_MAX_RESELECTIONS = 2;

export async function adjudicateDebate(
  state: DebateState,
  deps: AdjudicateDeps
): Promise<JudgeVerdict> {
  const max = Math.max(0, deps.maxReselections ?? DEFAULT_MAX_RESELECTIONS);
  const attempts: JudgeReselectionAttempt[] = [];
  const excluded = new Set<string>();
  const participants = participantsOf(state);
  const participantModelIds = participantModelIdsOf(state);
  let preferred = deps.preferredJudgeId;

  for (;;) {
    // 每次现选，并把已经失败的人排除掉。不排除的话会「失败 → 又选中它 →
    // 再失败」，最多换几个人也换不动。
    const candidates = (await deps.candidates()).filter(candidate => !excluded.has(candidate.id));
    const resolution = resolveJudge({
      candidates,
      participants,
      participantModelIds,
      ...(preferred ? { preferredJudgeId: preferred } : {})
    });

    if (!resolution.judgeAgentId) {
      // 没人可问：可能是本来就没配模型，也可能是全都试过了。两种都在
      // `judgeReselection` 上分得清。
      const rules = await new JudgeEngine({}).judge(state);
      return finish(state, withReselection(rules, attempts, excluded, true, null));
    }

    const verdict = await new JudgeEngine({
      ask: deps.ask,
      judgeAgentId: resolution.judgeAgentId,
      participants,
      participantModelIds,
      judgeModelId: resolution.judgeModelId,
      judgeProviderId: resolution.judgeProviderId,
      ...(resolution.sharedWith ? { sharedWith: resolution.sharedWith } : {})
    }).judge(state);

    if (verdict.backend === 'model') {
      // 换人成功：独立性等七个字段由这次 resolution 重新派生，不用上一次的。
      return finish(state, withReselection(verdict, attempts, excluded, false, resolution.judgeAgentId));
    }

    // 走到这里说明这个模型被调过、但没给出可用结论（调用失败，或两次输出
    // 都不可解析）。记下来、出池、换下一个；用户指定的那个已经试过，之后
    // 交给规则重新挑。
    attempts.push({
      agentId: resolution.judgeAgentId,
      ...(resolution.judgeModelId ? { judgeModelId: resolution.judgeModelId } : {}),
      judgeMode: resolution.judgeMode,
      reason: verdict.fallbackReason ?? '裁判模型没有给出可用结论'
    });
    excluded.add(resolution.judgeAgentId);
    preferred = undefined;

    if (attempts.length > max) {
      return finish(state, withReselection(verdict, attempts, excluded, true, null));
    }
  }
}

/** 附上质量报告与最终决策；规则版额外记下权威口径。 */
function finish(state: DebateState, verdict: JudgeVerdict): JudgeVerdict {
  const quality = evaluateDebateQuality({
    state,
    verdict,
    modelAssessed: verdict.backend === 'model'
  });
  const judged: JudgeVerdict = {
    ...verdict,
    quality,
    finalDecision: finalizeDebate(state, verdict, quality)
  };
  const finished = verdict.backend !== 'rules'
    ? judged
    : { ...judged, rulesConclusion: noteRulesConclusion(state, verdict) };
  applyJudgePackEvidence(state, finished);
  refreshClaimEvidenceLinks(state, finished.packEvidence?.length ? 'model-judge' : 'rules-judge');
  return finished;
}

/**
 * 一个失败都没换过（`attempts` 为空）时不写 `judgeReselection`：那不是
 * 「换过没换成」，是根本没得换，两种情况在记录上必须分得开。
 */
function withReselection(
  verdict: JudgeVerdict,
  attempts: readonly JudgeReselectionAttempt[],
  excluded: ReadonlySet<string>,
  exhausted: boolean,
  finalJudgeAgentId: string | null
): JudgeVerdict {
  if (attempts.length === 0) return verdict;
  const reselection: JudgeReselection = {
    attempts: [...attempts],
    excludedAgentIds: [...excluded],
    exhausted,
    finalJudgeAgentId
  };
  if (!exhausted) return { ...verdict, judgeReselection: reselection };
  return {
    ...verdict,
    judgeReselection: reselection,
    fallbackReason: `${attempts.map(item => `${item.agentId}：${item.reason}`).join('；')}。候选已全部试过，退回规则版`
  };
}

/**
 * 规则版结论的权威口径。
 *
 * 权威侧直接用 `state.verdict`（辩论收尾时算好并落盘的那份）；老记录没有
 * 就按当前规则现算一次。这里只读不写，也不拿它去覆盖本份结论。
 */
function noteRulesConclusion(state: DebateState, verdict: JudgeVerdict): RulesConclusionNote {
  const authoritative = state.verdict ?? judgeDebate(state, { at: verdict.createdAt }).verdict;
  const agrees = authoritative.conclusion === null && verdict.conclusion === null
    ? true
    : authoritative.conclusion !== null && verdict.conclusion !== null
      ? authoritative.conclusion === verdict.conclusion
      : null;
  return {
    authority: 'debate.claim-judgments',
    debateVerdict: authoritative.verdict,
    agrees
  };
}

/**
 * 这一场的实际参与者。有降级记录时以**实际**参与者为准：一个模型中途失败
 * 退出后，它不算参辩，也就不该被当成「裁判不能是它」的理由。
 */
function participantsOf(state: DebateState): string[] {
  return state.degradation?.actualParticipants ??
    state.plan?.participants ??
    state.config.participants ??
    [];
}

function participantModelIdsOf(state: DebateState): string[] {
  return state.rounds
    .flatMap(round => round.messages)
    .map(message => message.modelId)
    .filter((modelId): modelId is string => Boolean(modelId));
}
