import { PageBusyError } from '../adapters/browser/types';
import type { NewSessionResult } from '../adapters/browser/types';
import type { ChannelStatus } from '../../shared/conversation';
import type { SubAgent, SubAgentAnswer, SubAgentPool, SubAgentTask } from './types';

/**
 * The agents available right now, and the only place that decides how many run
 * at once.
 *
 * Two separate limits, for two different reasons:
 *
 * - Per agent: a chat page has one writer. A second question sent while the
 *   first is still being answered gets interleaved with it and both answers are
 *   then misread. So one ask per agent, and a second one is refused rather than
 *   queued.
 * - Global: each agent is a full `WebContentsView`, i.e. a renderer process.
 *   Three is already a lot of memory; six would make the machine the bottleneck
 *   and look like the app hanging.
 *
 * Refusing immediately is deliberate. A queued request looks like a stuck UI,
 * and the caller can always retry or skip that agent.
 *
 * The registry is a *pool*, not a scheduler: it does not decide who joins a
 * round. That is the Master Agent's call, and keeping the two apart is what
 * stops "how many can run" from quietly becoming "who gets asked".
 */
export class SubAgentRegistry implements SubAgentPool {
  private readonly byId = new Map<string, SubAgent>();
  private readonly active = new Set<string>();

  constructor(
    agents: readonly SubAgent[],
    private readonly maxConcurrent = 3
  ) {
    for (const agent of agents) this.byId.set(agent.id, agent);
  }

  /**
   * Swap the whole agent set, keeping this instance.
   *
   * The list is no longer fixed at startup: turning a source on in 设置 has to
   * make it an agent, and turning it off has to stop it counting toward the
   * readiness pill. Replacing the object instead would leave every holder — the
   * Master Agent, the status poller — talking to a registry nobody updates,
   * which is a class of bug that only shows up after a settings change.
   */
  replaceAll(agents: readonly SubAgent[]): void {
    this.byId.clear();
    for (const agent of agents) this.byId.set(agent.id, agent);
  }

  list(): SubAgent[] {
    return [...this.byId.values()];
  }

  get(id: string): SubAgent | undefined {
    return this.byId.get(id);
  }

  async statuses(): Promise<ChannelStatus[]> {
    return Promise.all(this.list().map(agent => agent.health()));
  }

  /**
   * The agents that could take a task right now.
   *
   * Order is the registry's order, i.e. the order the sources are configured in,
   * so "the first one" means the same thing to the Master as it does to the
   * user looking at the source rail.
   */
  async available(): Promise<SubAgent[]> {
    const statuses = await this.statuses();
    const usable = new Set(statuses.filter(status => status.available).map(status => status.id));
    return this.list().filter(agent => usable.has(agent.id));
  }

  async ask(agentId: string, task: SubAgentTask): Promise<SubAgentAnswer> {
    const agent = this.byId.get(agentId);
    if (!agent) throw new Error(`找不到 agent ${agentId}`);
    if (this.active.has(agentId)) throw new PageBusyError(agentId);
    if (this.active.size >= this.maxConcurrent) throw new PageBusyError(agentId);

    this.active.add(agentId);
    try {
      return await agent.ask(task);
    } finally {
      this.active.delete(agentId);
    }
  }

  cancel(agentId: string, requestId: string): void {
    this.byId.get(agentId)?.cancel(requestId);
  }

  /** Stop waiting on everything this agent has in flight. Used by 停止. */
  cancelAll(agentId: string): void {
    this.byId.get(agentId)?.cancelAll?.();
  }

  /**
   * Reset one agent's own session.
   *
   * Not counted against `maxConcurrent`: a reset is a page interaction that
   * happens *before* the ask, one per agent, and the per-agent "one writer"
   * rule is already enforced by the fact that a busy agent is never a target.
   */
  async newConversation(agentId: string): Promise<NewSessionResult> {
    const agent = this.byId.get(agentId);
    if (!agent) return { ok: false, detail: '没有这个 agent' };
    if (!agent.newConversation) return { ok: false, detail: '该 agent 不支持开新会话' };
    try {
      return await agent.newConversation();
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  get concurrency(): number {
    return this.maxConcurrent;
  }
}
