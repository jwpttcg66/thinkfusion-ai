import {
  normalizeExecutionConfig,
  type ConversationExecutionConfig
} from '../../shared/conversation';
import type { SubAgent } from '../agents/types';
import type { ProviderBackedSubAgent } from './provider-sub-agent';

/**
 * 选人（2026-11-05 重定义）。
 *
 * 执行模式 = 谁当主导人，不决定「谁回答」——第一手回答永远来自网页通道。
 * 所以这里选出两份名单：
 *
 * - `answerIds`  第一轮回答成员 = 网页通道（按 `selectedWebChannels` 裁）。
 *                这是 MasterAgent 要问的全部对象。
 * - `executorIds` 执行阶段成员 = 本地模型 + 云端模型（按 `selectedCloudModels`
 *                裁云端）。它们不参与第一轮回答，但可以当主导人，也可以当
 *                辩论的辩手：读完全部网页回答后汇总、交锋、给最终意见。
 *
 * 本地模型不进第一轮回答（它不是来源），但它不再是「只能做裁判」——按用户
 * 裁决，本地模型可以当主导人（本地主导档）和辩手。
 */
export interface ParticipantSelection {
  /** 第一轮回答成员（网页通道）。 */
  answerIds: ReadonlySet<string>;
  /** 执行阶段成员（本地模型 + 云端模型，可当主导/辩手）。 */
  executorIds: ReadonlySet<string>;
  reason: string;
  blocked: Array<{ id: string; why: string }>;
}

function matchesSelection(agent: SubAgent, selected: string[] | undefined): boolean {
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
  const blocked: ParticipantSelection['blocked'] = [];
  const answers: string[] = [];
  const executors: string[] = [];

  for (const agent of webAgents) {
    if (!matchesSelection(agent, effective.selectedWebChannels)) {
      blocked.push({ id: agent.id, why: '没有在这一轮被选中' });
      continue;
    }
    answers.push(agent.id);
  }
  for (const agent of extraAgents) {
    if (agent.sourceType === 'cloud' && !matchesSelection(agent, effective.selectedCloudModels)) {
      blocked.push({ id: agent.id, why: '没有在这一轮被选中' });
      continue;
    }
    // 本地与云端模型都进执行名单：可当主导人、可当辩手，但不参与第一轮回答。
    executors.push(agent.id);
  }

  const reason = `回答 = 网页 ${answers.length} 个；执行阶段（主导/辩手候选）= ${executors.length} 个`;
  return { answerIds: new Set(answers), executorIds: new Set(executors), reason, blocked };
}
