import {
  normalizeExecutionConfig,
  type ConversationExecutionConfig
} from '../../shared/conversation';
import type { SubAgent } from '../agents/types';
import type { ProviderBackedSubAgent } from './provider-sub-agent';

/**
 * 选人（2026-11-15 更新）。
 *
 * 执行模式同时决定「谁第一手回答」与「谁做汇总/交锋/最终意见」：
 *
 * - `web` / `hybrid`：第一手是网页通道 + **CLI 软件源**；本地 + 云端只进执行阶段。
 * - `local`：第一手与执行都是本地模型，不问网页、不问 CLI。
 * - `cloud`：第一手是勾选的云端模型**和 CLI**（CLI 属云端一类，2026-11-15 裁决），
 *   不问网页。
 *
 * CLI 跟网页同一层级但不是网页：它按「用户开着的软件源」进场，不受
 * `selectedWebChannels` 约束——那个字段选的是站点，不是软件。这一问还可以在
 * 输入框「模型」弹层里再筛一遍：`selectedCliAgents`
 * （undefined = 开着的全部，[] = 一个都不问）。
 *
 * CLI 同时进执行名单：用户裁决它「可以主导、可以回答、可以辩论、可以执行」，
 * 归属上算云端一类（见 runner 的 `ownershipSourceOf`）。它仍然不进工程编排，
 * 因为回答链拿不到本机文件。
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
  extraAgents: readonly ProviderBackedSubAgent[],
  /** CLI 软件源：跟网页同一层级的第一手回答成员，缺省空。 */
  cliAgents: readonly SubAgent[] = []
): ParticipantSelection {
  const effective = normalizeExecutionConfig(config);
  const blocked: ParticipantSelection['blocked'] = [];
  const answers: string[] = [];
  const executors: string[] = [];
  const mode = effective.executionMode;

  // CLI 名单是独立的一层：undefined = 设置里开着的全部，[] = 一个都不问。
  const cliSelected = effective.selectedCliAgents;
  const cliChosen = (agent: SubAgent): boolean =>
    !Array.isArray(cliSelected) || cliSelected.includes(agent.id);

  // 执行名单始终收本地 + 勾选云端：工程编排要「本地优先、云端补充」，
  // 不随知识空间归属把本地剔掉；归属过滤在汇总/交锋阶段另做。
  for (const agent of extraAgents) {
    if (agent.sourceType === 'cloud' && !matchesSelection(agent, effective.selectedCloudModels)) {
      blocked.push({ id: agent.id, why: '没有在这一轮被选中' });
      continue;
    }
    executors.push(agent.id);
  }
  // CLI 也进执行名单：裁决是「可以主导、可以辩论」。没勾的照样不进。
  for (const agent of cliAgents) {
    if (!cliChosen(agent)) continue;
    pushUnique(executors, agent.id);
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
    // CLI 属云端一类（2026-11-15 裁决）：云端主导时它照样被问，并可当主导/辩手。
    const cloudCount = answers.length;
    for (const agent of cliAgents) {
      if (!cliChosen(agent)) {
        blocked.push({ id: agent.id, why: '没有在这一轮被选中' });
        continue;
      }
      pushUnique(answers, agent.id);
    }
    for (const agent of webAgents) {
      blocked.push({ id: agent.id, why: '云端主导不问网页通道' });
    }
    return {
      answerIds: new Set(answers),
      executorIds: new Set(executors),
      reason: `云端主导：回答 = 云端 ${cloudCount} 个 + CLI ${answers.length - cloudCount} 个；执行阶段候选 = ${executors.length} 个；不问网页`,
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
    for (const agent of cliAgents) {
      blocked.push({ id: agent.id, why: '本地主导只用本地模型，不问 CLI（云端一类）' });
    }
    return {
      answerIds: new Set(answers),
      executorIds: new Set(executors),
      reason: `本地主导：回答 = 本地 ${answers.length} 个；执行阶段候选 = ${executors.length} 个；不问网页与 CLI`,
      blocked
    };
  }

  // web / hybrid：第一手是网页 + CLI 软件源。
  for (const agent of webAgents) {
    if (!matchesSelection(agent, effective.selectedWebChannels)) {
      blocked.push({ id: agent.id, why: '没有在这一轮被选中' });
      continue;
    }
    answers.push(agent.id);
  }
  // CLI 不看 `selectedWebChannels`：那是站点名单，不是软件名单。它自己的名单是
  // `selectedCliAgents`——undefined = 设置里开着的全部（老会话缺省），[] = 这一问
  // 一个都不问。跟云端勾选是同一种三态语义。
  const activeCli = cliAgents.filter(agent => {
    if (cliChosen(agent)) return true;
    blocked.push({ id: agent.id, why: '没有在这一轮被选中' });
    return false;
  });
  const webCount = answers.length;
  for (const agent of activeCli) pushUnique(answers, agent.id);

  const reason =
    mode === 'hybrid'
      ? `混合：回答 = 网页 ${webCount} 个 + CLI ${activeCli.length} 个；执行阶段候选 = ${executors.length} 个`
      : `网页主导：回答 = 网页 ${webCount} 个 + CLI ${activeCli.length} 个；执行阶段候选 = ${executors.length} 个`;
  return { answerIds: new Set(answers), executorIds: new Set(executors), reason, blocked };
}
