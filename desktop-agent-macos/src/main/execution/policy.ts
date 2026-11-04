import {
  normalizeExecutionConfig,
  type ConversationExecutionConfig,
  type ExecutionMode
} from '../../shared/conversation';
import type { SubAgent } from '../agents/types';
import type { ProviderBackedSubAgent } from './provider-sub-agent';

/**
 * 执行模式 → 这一轮到底问谁。
 *
 * 这是隐私边界唯一生效的地方。Provider 自己不知道 `privacyMode`（云端重试
 * 也不会去读它），一旦在选人阶段没被放进名单，后面就没有路径能把它加回来。
 * 这比在每一层都写一句「如果是 local-only 就别发」可靠得多。
 */
export interface ParticipantSelection {
  ids: ReadonlySet<string>;
  reason: string;
  blocked: Array<{ id: string; why: string }>;
}

type SourceKind = 'web' | 'local' | 'cloud';

function kindsFor(config: ConversationExecutionConfig): SourceKind[] {
  // local-only 是硬约束，压过执行模式：hybrid + local-only 只剩本地。
  if (config.privacyMode === 'local-only') return ['local'];

  const byMode: Record<ExecutionMode, SourceKind[]> = {
    web: ['web'],
    local: ['local'],
    cloud: ['cloud'],
    hybrid: ['web', 'local', 'cloud']
  };
  return byMode[config.executionMode];
}

function matchesSelection(agent: SubAgent, kind: SourceKind, selected?: string[]): boolean {
  if (selected === undefined) return true;
  const extra = agent as ProviderBackedSubAgent;
  const candidates = [agent.id, extra.modelId, extra.provider?.id].filter(
    (value): value is string => typeof value === 'string'
  );
  return candidates.some(id => selected.includes(id));
}

export function selectParticipants(
  config: ConversationExecutionConfig | undefined,
  webAgents: readonly SubAgent[],
  extraAgents: readonly ProviderBackedSubAgent[]
): ParticipantSelection {
  const effective = normalizeExecutionConfig(config);
  const kinds = kindsFor(effective);
  const blocked: ParticipantSelection['blocked'] = [];
  const picked: string[] = [];

  const consider = (agent: SubAgent, kind: SourceKind, selected?: string[]) => {
    if (!kinds.includes(kind)) {
      blocked.push({
        id: agent.id,
        why: effective.privacyMode === 'local-only'
          ? 'local-only 禁止向网页和云端发送内容'
          : `${effective.executionMode} 模式不包含 ${kind} 来源`
      });
      return;
    }
    if (!matchesSelection(agent, kind, selected)) {
      blocked.push({ id: agent.id, why: '没有在这一轮被选中' });
      return;
    }
    picked.push(agent.id);
  };

  for (const agent of webAgents) consider(agent, 'web', effective.selectedWebChannels);
  for (const agent of extraAgents) {
    const kind = agent.sourceType;
    consider(
      agent,
      kind,
      kind === 'local' ? effective.selectedLocalModels : effective.selectedCloudModels
    );
  }

  let fallbackNote = '';
  if (picked.length === 0 && effective.fallbackEnabled && effective.privacyMode !== 'local-only') {
    // 只有明确开了 fallback、且不在隐私模式里，才允许退回网页通道。
    for (const agent of webAgents) picked.push(agent.id);
    fallbackNote = '；选中的来源都不可用，按 fallback 退回网页通道';
  }

  // 防御性检查：真出现了，说明上面哪条分支写漏了，宁可炸也不能外发。
  if (effective.privacyMode === 'local-only') {
    const illegal = extraAgents.filter(agent => picked.includes(agent.id) && agent.sourceType !== 'local');
    if (illegal.length > 0 || picked.some(id => webAgents.some(agent => agent.id === id))) {
      throw new Error(`local-only 被突破：${[...picked].join(', ')}`);
    }
  }

  const reason = `${effective.executionMode} / ${effective.privacyMode} → ${kinds.join('+') || '无'}${fallbackNote}`;
  return { ids: new Set(picked), reason, blocked };
}
