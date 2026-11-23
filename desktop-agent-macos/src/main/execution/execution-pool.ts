import type { SubAgent, SubAgentAnswer, SubAgentPool, SubAgentTask } from '../agents/types';
import type { DeleteThreadResult, NewSessionResult } from '../adapters/browser/types';
import { ProviderBackedSubAgent } from './provider-sub-agent';
import { attachFromTask } from '../memory/runtime';

/**
 * 一轮研究的名单：按两份名单裁过的视图（2026-11-15 更新）。
 *
 * - `answerIds`：`all()` / `available()` 只返回它们，所以 `MasterAgent`
 *   第一轮只问这些人。网页主导 / 混合 = 网页 + CLI 软件源；本地主导 = 本地
 *   模型；云端主导 = 勾选的云端模型。
 * - `executorIds`：不进 `all()`（除非也在 answerIds 里），但 `ask()` 放行。
 *   执行阶段点名主导人 / 辩手；工程编排也从这里取模型。
 *
 * 三类成员（网页 / 模型 / CLI）共用 `SubAgent` 接口，所以这里不需要知道它们
 * 各自怎么实现；只在「有没有网页会话可删」这种只有网页才有的概念上分一次叉。
 *
 * `SubAgentPool` 是 `MasterAgent` 唯一的入口，所以裁名单放在这一层，
 * `MasterAgent` 和 `ConversationRunner.conduct()` 都不用知道「执行模式」
 * 这个概念。
 */
export class ExecutionPool implements SubAgentPool {
  /** 模型来源（本地 / 云端）。 */
  private readonly extraById = new Map<string, ProviderBackedSubAgent>();
  /** CLI 软件源：跟网页同一层级的回答者，但没有页面。 */
  private readonly cliById = new Map<string, SubAgent>();

  constructor(
    private readonly base: SubAgentPool,
    extra: readonly ProviderBackedSubAgent[],
    private readonly answerIds: ReadonlySet<string>,
    private readonly executorIds: ReadonlySet<string>,
    cliAgents: readonly SubAgent[] = []
  ) {
    for (const agent of extra) this.extraById.set(agent.id, agent);
    for (const agent of cliAgents) this.cliById.set(agent.id, agent);
  }

  private keepAnswers<T extends SubAgent>(agents: readonly T[]): T[] {
    return agents.filter(agent => this.answerIds.has(agent.id));
  }

  /** 非网页来源：没有站点侧栏，也没有「回到上一条会话」这回事。 */
  private isPageAgent(agentId: string): boolean {
    return !this.extraById.has(agentId) && !this.cliById.has(agentId);
  }

  private agentOf(agentId: string): SubAgent | undefined {
    return this.extraById.get(agentId) ?? this.cliById.get(agentId);
  }

  async all(): Promise<SubAgent[]> {
    const base = this.keepAnswers(await this.base.all());
    const extra = [...this.extraById.values()].filter(agent => this.answerIds.has(agent.id));
    const cli = [...this.cliById.values()].filter(agent => this.answerIds.has(agent.id));
    return [...base, ...extra, ...cli];
  }

  /** 探测一个非网页成员的可用性；探测本身抛错算不可用，不带走整轮。 */
  private static async usable(agent: SubAgent): Promise<{ agent: SubAgent; ok: boolean }> {
    try {
      return { agent, ok: (await agent.health()).available };
    } catch {
      return { agent, ok: false };
    }
  }

  async available(): Promise<SubAgent[]> {
    const base = this.keepAnswers(await this.base.available());
    const extra = await Promise.all(
      [...this.extraById.values()].filter(agent => this.answerIds.has(agent.id)).map(ExecutionPool.usable)
    );
    const cli = await Promise.all(
      [...this.cliById.values()].filter(agent => this.answerIds.has(agent.id)).map(ExecutionPool.usable)
    );
    return [
      ...base,
      ...extra.filter(item => item.ok).map(item => item.agent),
      ...cli.filter(item => item.ok).map(item => item.agent)
    ];
  }

  async ask(agentId: string, task: SubAgentTask): Promise<SubAgentAnswer> {
    // 回答者与执行者都能被问：前者在第一轮，后者只在主导轮被点名。
    if (!this.answerIds.has(agentId) && !this.executorIds.has(agentId)) {
      throw new Error(`这一轮不选 ${agentId}，拒绝发问`);
    }
    const agent = this.agentOf(agentId);
    // 走 base（SubAgentRegistry）时由它 attach；这里再包一次会在 system 里
    // 放两个记忆块，哈希也对不上。所以只有「直接问本地/云端成员」这条分支
    // 自己 attach——真机验收发现工程链路正是走这条，之前一次 usage 都没记。
    if (!agent) return this.base.ask(agentId, task);
    const hook = attachFromTask(task, { sourceType: agent.sourceType ?? 'web', agentId });
    try {
      const answer = await agent.ask(hook.task);
      hook.finalize(answer);
      return answer;
    } catch (error) {
      hook.finalize(undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * 流式问：名单校验与 `ask` 相同，然后交给真正拥有这个成员的那一层。
   * 少了这个方法，云端第一轮会静默退回整段——界面就看不到「写作中」。
   */
  async askStream(
    agentId: string,
    task: SubAgentTask,
    onDelta: (chunk: { text?: string; reasoning?: string; reset?: boolean }) => void
  ): Promise<SubAgentAnswer> {
    if (!this.answerIds.has(agentId) && !this.executorIds.has(agentId)) {
      throw new Error(`这一轮不选 ${agentId}，拒绝发问`);
    }
    const agent = this.agentOf(agentId);
    if (!agent) {
      if (this.base.askStream) return this.base.askStream(agentId, task, onDelta);
      return this.ask(agentId, task);
    }
    const hook = attachFromTask(task, { sourceType: agent.sourceType ?? 'web', agentId });
    try {
      const answer = agent.askStream
        ? await agent.askStream(hook.task, onDelta)
        : await agent.ask(hook.task);
      hook.finalize(answer);
      return answer;
    } catch (error) {
      hook.finalize(undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async newConversation(agentId: string): Promise<NewSessionResult> {
    if (!this.isPageAgent(agentId)) {
      return { ok: true, detail: '这条来源没有网页会话，每次提问本身就是新的' };
    }
    return this.base.newConversation(agentId);
  }

  async deleteConversation(agentId: string, threadUrl: string): Promise<DeleteThreadResult> {
    if (!this.isPageAgent(agentId)) return ProviderBackedSubAgent.noThread();
    return this.base.deleteConversation(agentId, threadUrl);
  }

  cancel(agentId: string, requestId: string): void {
    if (!this.answerIds.has(agentId) && !this.executorIds.has(agentId)) return;
    const agent = this.agentOf(agentId);
    if (agent) agent.cancel(requestId);
    else this.base.cancel(agentId, requestId);
  }
}
