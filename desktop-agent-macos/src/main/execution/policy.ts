import {
  normalizeExecutionConfig,
  type ConversationExecutionConfig
} from '../../shared/conversation';
import type { SubAgent } from '../agents/types';
import type { ProviderBackedSubAgent } from './provider-sub-agent';

/**
 * 选人（2026-11-05 重定义）。
 *
 * 执行模式不再决定「谁回答」——第一手回答永远来自网页通道。所以这里选出
 * 两份名单：
 *
 * - `answerIds`  第一轮回答成员 = 网页通道（按 `selectedWebChannels` 裁）。
 *                这是 MasterAgent 要问的全部对象。
 * - `executorIds` 执行阶段成员 = 云端模型（按 `selectedCloudModels` 裁）。
 *                它们不参与第一轮回答，但可以当主导：读完全部网页回答后
 *                指出错误、比较优劣、给出最终答案。
 *
 * 本地模型两份名单都不进：它不是来源，只在汇总（`summarizeLocal`）和自动
 * 选主导（`pickLead`）时出场，那两处直接持有 Provider 引用，不经过名单。
 */
export interface ParticipantSelection {
  /** 第一轮回答成员（网页通道）。 */
  answerIds: ReadonlySet<string>;
  /** 执行阶段成员（云端模型，可当主导）。 */
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
    if (agent.sourceType !== 'cloud') {
      // 本地模型不进任何名单：汇总与选主导不经过 ExecutionPool。
      blocked.push({ id: agent.id, why: '本地模型不是来源，只在汇总/选主导时出场' });
      continue;
    }
    if (!matchesSelection(agent, effective.selectedCloudModels)) {
      blocked.push({ id: agent.id, why: '没有在这一轮被选中' });
      continue;
    }
    executors.push(agent.id);
  }

  const reason = `回答 = 网页 ${answers.length} 个；执行阶段（云端主导候选）= ${executors.length} 个`;
  return { answerIds: new Set(answers), executorIds: new Set(executors), reason, blocked };
}
