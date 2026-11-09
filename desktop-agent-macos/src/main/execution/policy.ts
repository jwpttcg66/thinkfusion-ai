import {
  normalizeExecutionConfig,
  type ConversationExecutionConfig
} from '../../shared/conversation';
import type { SubAgent } from '../agents/types';
import type { ProviderBackedSubAgent } from './provider-sub-agent';

/**
 * 选人（2026-11-09 更新）。
 *
 * 执行模式同时决定「谁第一手回答」与「谁做汇总/交锋/最终意见」：
 *
 * - `web` / `hybrid`：第一手仍是网页通道；本地 + 云端只进执行阶段。
 * - `local`：第一手与执行都是本地模型，不问网页。
 * - `cloud`：第一手与执行都是勾选的云端模型（可点名主导人），不问网页。
 *
 * 工程空间另有编排：`executorIds` 里的本地 + 云端仍可供 `modelMembers` 使用；
 * 网页只在混合档由编排计划单独拉进场，不走这里的 `answerIds`。
 */
export interface ParticipantSelection {
  /** 第一轮回答成员。 */
  answerIds: ReadonlySet<string>;
  /** 执行阶段成员（可当主导/辩手；工程编排也从这里取模型）。 */
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

function pushUnique(list: string[], id: string): void {
  if (!list.includes(id)) list.push(id);
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
  const mode = effective.executionMode;

  // 执行名单始终收本地 + 勾选云端：工程编排要「本地优先、云端补充」，
  // 不随知识空间归属把本地剔掉；归属过滤在汇总/交锋阶段另做。
  for (const agent of extraAgents) {
    if (agent.sourceType === 'cloud' && !matchesSelection(agent, effective.selectedCloudModels)) {
      blocked.push({ id: agent.id, why: '没有在这一轮被选中' });
      continue;
    }
    executors.push(agent.id);
  }

  // 点名的主导人必须能进场：勾选名单空着但点了主导时，至少放它进来。
  if (effective.leadAgentId) {
    const lead = extraAgents.find(agent => agent.id === effective.leadAgentId);
    if (lead && lead.sourceType === 'cloud') {
      pushUnique(executors, lead.id);
    }
  }

  if (mode === 'cloud') {
    for (const agent of extraAgents) {
      if (agent.sourceType !== 'cloud') continue;
      if (!matchesSelection(agent, effective.selectedCloudModels)) continue;
      pushUnique(answers, agent.id);
    }
    if (effective.leadAgentId) {
      const lead = extraAgents.find(
        agent => agent.id === effective.leadAgentId && agent.sourceType === 'cloud'
      );
      if (lead) pushUnique(answers, lead.id);
    }
    for (const agent of webAgents) {
      blocked.push({ id: agent.id, why: '云端主导不问网页通道' });
    }
    return {
      answerIds: new Set(answers),
      executorIds: new Set(executors),
      reason: `云端主导：回答 = 云端 ${answers.length} 个；执行阶段候选 = ${executors.length} 个；不问网页`,
      blocked
    };
  }

  if (mode === 'local') {
    for (const agent of extraAgents) {
      if (agent.sourceType === 'cloud') continue;
      pushUnique(answers, agent.id);
    }
    for (const agent of webAgents) {
      blocked.push({ id: agent.id, why: '本地主导不问网页通道' });
    }
    return {
      answerIds: new Set(answers),
      executorIds: new Set(executors),
      reason: `本地主导：回答 = 本地 ${answers.length} 个；执行阶段候选 = ${executors.length} 个；不问网页`,
      blocked
    };
  }

  // web / hybrid：第一手仍是网页。
  for (const agent of webAgents) {
    if (!matchesSelection(agent, effective.selectedWebChannels)) {
      blocked.push({ id: agent.id, why: '没有在这一轮被选中' });
      continue;
    }
    answers.push(agent.id);
  }

  const reason =
    mode === 'hybrid'
      ? `混合：回答 = 网页 ${answers.length} 个；执行阶段候选 = ${executors.length} 个`
      : `网页主导：回答 = 网页 ${answers.length} 个；执行阶段候选 = ${executors.length} 个`;
  return { answerIds: new Set(answers), executorIds: new Set(executors), reason, blocked };
}
