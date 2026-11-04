import type { SubAgent, SubAgentAnswer, SubAgentPool, SubAgentTask } from '../agents/types';
import type { DeleteThreadResult, NewSessionResult } from '../adapters/browser/types';
import { ProviderBackedSubAgent } from './provider-sub-agent';

/**
 * 一轮研究的名单：原有网页注册表 + 新来源，再按执行配置裁一遍。
 *
 * `SubAgentPool` 是 `MasterAgent` 唯一的入口，所以过滤放在这一层，
 * `MasterAgent` 和 `ConversationRunner.conduct()` 都不用知道「执行模式」
 * 这个概念。开关一个来源也不会影响全局注册表——每轮研究各有一份视图。
 */
export class ExecutionPool implements SubAgentPool {
  private readonly extraById = new Map<string, ProviderBackedSubAgent>();

  constructor(
    private readonly base: SubAgentPool,
    extra: readonly ProviderBackedSubAgent[],
    private readonly allowedIds: ReadonlySet<string>
  ) {
    for (const agent of extra) this.extraById.set(agent.id, agent);
  }

  private keep<T extends SubAgent>(agents: readonly T[]): T[] {
    return agents.filter(agent => this.allowedIds.has(agent.id));
  }

  async all(): Promise<SubAgent[]> {
    const base = this.keep(await this.base.all());
    const extra = this.keep([...this.extraById.values()]);
    return [...base, ...extra];
  }

  async available(): Promise<SubAgent[]> {
    const base = this.keep(await this.base.available());
    const extra = await Promise.all(
      this.keep([...this.extraById.values()]).map(async agent => ({
        agent,
        ok: (await agent.health()).available
      }))
    );
    return [...base, ...extra.filter(item => item.ok).map(item => item.agent)];
  }

  async ask(agentId: string, task: SubAgentTask): Promise<SubAgentAnswer> {
    if (!this.allowedIds.has(agentId)) {
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
    if (!this.allowedIds.has(agentId)) return;
    const extra = this.extraById.get(agentId);
    if (extra) extra.cancel(requestId);
    else this.base.cancel(agentId, requestId);
  }
}
