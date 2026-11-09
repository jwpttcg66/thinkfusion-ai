import type { SubAgent, SubAgentAnswer, SubAgentPool, SubAgentTask } from '../agents/types';
import type { DeleteThreadResult, NewSessionResult } from '../adapters/browser/types';
import { ProviderBackedSubAgent } from './provider-sub-agent';

/**
 * 一轮研究的名单：按两份名单裁过的视图（2026-11-09 更新）。
 *
 * - `answerIds`：`all()` / `available()` 只返回它们，所以 `MasterAgent`
 *   第一轮只问这些人。网页主导 / 混合 = 网页；本地主导 = 本地模型；
 *   云端主导 = 勾选的云端模型。
 * - `executorIds`：不进 `all()`（除非也在 answerIds 里），但 `ask()` 放行。
 *   执行阶段点名主导人 / 辩手；工程编排也从这里取模型。
 *
 * `SubAgentPool` 是 `MasterAgent` 唯一的入口，所以裁名单放在这一层，
 * `MasterAgent` 和 `ConversationRunner.conduct()` 都不用知道「执行模式」
 * 这个概念。
 */
export class ExecutionPool implements SubAgentPool {
  private readonly extraById = new Map<string, ProviderBackedSubAgent>();

  constructor(
    private readonly base: SubAgentPool,
    extra: readonly ProviderBackedSubAgent[],
    private readonly answerIds: ReadonlySet<string>,
    private readonly executorIds: ReadonlySet<string>
  ) {
    for (const agent of extra) this.extraById.set(agent.id, agent);
  }

  private keepAnswers<T extends SubAgent>(agents: readonly T[]): T[] {
    return agents.filter(agent => this.answerIds.has(agent.id));
  }

  async all(): Promise<SubAgent[]> {
    const base = this.keepAnswers(await this.base.all());
    const extra = [...this.extraById.values()].filter(agent => this.answerIds.has(agent.id));
    return [...base, ...extra];
  }

  async available(): Promise<SubAgent[]> {
    const base = this.keepAnswers(await this.base.available());
    const extra = await Promise.all(
      [...this.extraById.values()]
        .filter(agent => this.answerIds.has(agent.id))
        .map(async agent => ({
          agent,
          ok: (await agent.health()).available
        }))
    );
    return [...base, ...extra.filter(item => item.ok).map(item => item.agent)];
  }

  async ask(agentId: string, task: SubAgentTask): Promise<SubAgentAnswer> {
    // 回答者与执行者都能被问：前者在第一轮，后者只在主导轮被点名。
    if (!this.answerIds.has(agentId) && !this.executorIds.has(agentId)) {
      throw new Error(`这一轮不选 ${agentId}，拒绝发问`);
    }
    const extra = this.extraById.get(agentId);
    return extra ? extra.ask(task) : this.base.ask(agentId, task);
  }

  async newConversation(agentId: string): Promise<NewSessionResult> {
    if (this.extraById.has(agentId)) return ProviderBackedSubAgent.noSession();
    return this.base.newConversation(agentId);
  }

  async deleteConversation(agentId: string, threadUrl: string): Promise<DeleteThreadResult> {
    if (this.extraById.has(agentId)) return ProviderBackedSubAgent.noThread();
    return this.base.deleteConversation(agentId, threadUrl);
  }

  cancel(agentId: string, requestId: string): void {
    if (!this.answerIds.has(agentId) && !this.executorIds.has(agentId)) return;
    const extra = this.extraById.get(agentId);
    if (extra) extra.cancel(requestId);
    else this.base.cancel(agentId, requestId);
  }
}
