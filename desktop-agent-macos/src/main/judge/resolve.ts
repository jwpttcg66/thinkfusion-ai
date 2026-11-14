/**
 * Judge 选择与独立性派生。
 *
 * IPC、回归脚本、CLI 都应该走这里，避免各自手写 `sharedWith`：
 * - 优先选未参与辩论、且模型身份不同的成员；
 * - 找不到时允许参与者复评，但必须标 participant-review；
 * - 只有一个参与者且由它自评，标 self-review；
 * - 没有任何可用成员，标 rules-fallback。
 */
export type JudgeMode =
  | 'self-review'
  | 'participant-review'
  | 'independent-judge'
  | 'rules-fallback';

export interface JudgeCandidateInfo {
  id: string;
  label?: string;
  type: 'web' | 'local' | 'cloud';
  available: boolean;
  modelId?: string;
  providerId?: string;
}

export interface JudgeResolution {
  judgeAgentId: string | null;
  judgeModelId?: string;
  judgeProviderId?: string;
  judgeMode: JudgeMode;
  judgeIndependent: boolean;
  modelIndependence: boolean;
  reason: string;
  sharedWith?: string;
}

export interface ResolveJudgeInput {
  candidates: readonly JudgeCandidateInfo[];
  participants: readonly string[];
  participantModelIds?: readonly string[];
  /** 用户或调用方指定的裁判；不可用时按规则重新选。 */
  preferredJudgeId?: string;
}

export function resolveJudge(input: ResolveJudgeInput): JudgeResolution {
  const available = input.candidates.filter(candidate => candidate.available);
  const participants = new Set(input.participants);
  const participantModels = new Set(
    (input.participantModelIds && input.participantModelIds.length > 0
      ? input.participantModelIds
      : input.participants).filter(Boolean)
  );
  const modelOf = (candidate: JudgeCandidateInfo): string => candidate.modelId ?? candidate.id;
  const isParticipant = (candidate: JudgeCandidateInfo): boolean =>
    participants.has(candidate.id) ||
    participantModels.has(modelOf(candidate)) ||
    participants.has(modelOf(candidate));
  const independent = available.filter(candidate =>
    !isParticipant(candidate) && !participantModels.has(modelOf(candidate))
  );
  const preferred = input.preferredJudgeId
    ? available.find(candidate => candidate.id === input.preferredJudgeId)
    : undefined;
  const pick = preferred && !isParticipant(preferred)
    ? preferred
    : independent[0] ?? preferred ?? available[0];

  if (!pick) {
    return {
      judgeAgentId: null,
      judgeMode: 'rules-fallback',
      judgeIndependent: false,
      modelIndependence: false,
      reason: '没有可用的模型裁判，退回规则版'
    };
  }

  const pickIsParticipant = isParticipant(pick);
  const modelIndependent = !participantModels.has(modelOf(pick)) &&
    !participants.has(modelOf(pick));
  if (pickIsParticipant || !modelIndependent) {
    const self = pickIsParticipant && participants.size <= 1;
    return {
      judgeAgentId: pick.id,
      judgeModelId: modelOf(pick),
      ...(pick.providerId ? { judgeProviderId: pick.providerId } : {}),
      judgeMode: self ? 'self-review' : 'participant-review',
      judgeIndependent: false,
      modelIndependence: false,
      reason: self
        ? 'Judge 与唯一参与者是同一个模型，属于自我评估'
        : 'Judge 参与了前序辩论，或与参辩模型身份相同，不是独立第三方',
      ...(pickIsParticipant ? { sharedWith: pick.id } : {})
    };
  }

  return {
    judgeAgentId: pick.id,
    judgeModelId: modelOf(pick),
    ...(pick.providerId ? { judgeProviderId: pick.providerId } : {}),
    judgeMode: 'independent-judge',
    judgeIndependent: true,
    modelIndependence: true,
    reason: 'Judge 未参与前序辩论，且模型身份与参辩成员不同'
  };
}
