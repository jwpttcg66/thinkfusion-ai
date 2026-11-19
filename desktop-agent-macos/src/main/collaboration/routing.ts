/**
 * P5-02：先范围、再能力、再角色；降级不越界。
 */
import type { CapabilityId, ModelScope } from './domain/types';
import type { ParticipantView } from './participants/manager';
import { hasCapabilities, inScope, supportsRole, type ParticipantRole } from './capabilities';

export interface RouteInput {
  participants: readonly ParticipantView[];
  modelScope: ModelScope;
  includeWeb: boolean;
  requiredCapabilities?: readonly CapabilityId[];
  role?: ParticipantRole;
  workspace?: 'knowledge' | 'engineering' | 'general';
}

export interface RouteResult {
  selected: ParticipantView[];
  skipped: Array<{ participantId: string; reason: string }>;
}

export function routeParticipants(input: RouteInput): RouteResult {
  const role = input.role ?? 'answerer';
  const workspace = input.workspace ?? 'general';
  const selected: ParticipantView[] = [];
  const skipped: RouteResult['skipped'] = [];
  for (const participant of input.participants) {
    if (!participant.available) {
      skipped.push({ participantId: participant.participantId, reason: participant.reason ?? '不可用' });
      continue;
    }
    if (!inScope(participant.kind, input.modelScope, input.includeWeb)) {
      skipped.push({ participantId: participant.participantId, reason: '超出模型范围' });
      continue;
    }
    if (!supportsRole(participant.kind, workspace, role)) {
      skipped.push({ participantId: participant.participantId, reason: '该空间不允许此角色' });
      continue;
    }
    if (!hasCapabilities(participant.kind, input.requiredCapabilities ?? [])) {
      skipped.push({ participantId: participant.participantId, reason: '缺少所需能力' });
      continue;
    }
    selected.push(participant);
  }
  return { selected, skipped };
}
