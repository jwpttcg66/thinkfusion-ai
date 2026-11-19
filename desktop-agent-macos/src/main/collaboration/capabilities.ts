/** P5-01：通道能力注册表；声明与调度共用同一份。 */
import type { AgentCapabilities, CapabilityId, ModelScope } from './domain/types';
import type { ParticipantView } from './participants/manager';

export type ParticipantRole = 'answerer' | 'questioner';

export const CHANNEL_CAPABILITIES: Record<ParticipantView['kind'], AgentCapabilities> = {
  web: {
    kind: 'web', canSystemPrompt: false, canUseTools: false, canStream: true,
    canSeeOtherAgents: false, maxConcurrency: 1, costClass: 'low'
  },
  local: {
    kind: 'local', canSystemPrompt: true, canUseTools: true, canStream: true,
    canSeeOtherAgents: true, maxConcurrency: 1, costClass: 'low'
  },
  cloud: {
    kind: 'cloud', canSystemPrompt: true, canUseTools: true, canStream: true,
    canSeeOtherAgents: true, maxConcurrency: 2, costClass: 'medium', requiresLogin: true
  },
  cli: {
    kind: 'cli', canSystemPrompt: false, canUseTools: false, canStream: false,
    canSeeOtherAgents: false, maxConcurrency: 1, costClass: 'low'
  }
};

export function capabilitiesOf(kind: ParticipantView['kind']): AgentCapabilities {
  return CHANNEL_CAPABILITIES[kind];
}

export function supportsRole(
  kind: ParticipantView['kind'],
  workspace: 'knowledge' | 'engineering' | 'general',
  role: ParticipantRole
): boolean {
  if (role === 'answerer') return true;
  return workspace !== 'engineering' && kind === 'web';
}

export function hasCapabilities(kind: ParticipantView['kind'], required: readonly CapabilityId[]): boolean {
  const capabilities: CapabilityId[] = kind === 'web'
    ? ['knowledge', 'web-research']
    : kind === 'cli'
      ? ['reasoning']
      : ['reasoning', 'knowledge'];
  return required.every(item => capabilities.includes(item));
}

export function inScope(kind: ParticipantView['kind'], scope: ModelScope, includeWeb: boolean): boolean {
  if (kind === 'web') return includeWeb;
  if (scope === 'local') return kind === 'local';
  if (scope === 'remote') return kind === 'cloud' || kind === 'cli';
  return true;
}
