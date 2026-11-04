import { PageBusyError } from '../adapters/browser/types';
import type { NewSessionResult, DeleteThreadResult } from '../adapters/browser/types';
import type { ChannelStatus } from '../../shared/conversation';
import type { SubAgent, SubAgentAnswer, SubAgentPool, SubAgentTask } from './types';

/**
 * The agents available right now, and the only place that decides how many run
 * at once.
 *
 * One limit, and it is per agent: a chat page has one writer. A second question
 * sent while the first is still being answered gets interleaved with it and
 * both answers are then misread. So one ask per agent, and a second one is
 * refused rather than queued — a queued request looks like a stuck UI, and the
 * caller can retry or skip that agent.
 *
 * There used to be a second, global limit: three at a time, justified by "each
 * agent is a whole renderer process". That number was really "how many sites
 * the app shipped with", and it broke the moment a fourth was switched on —
 * measured, four channels enabled: `deepseek` and `chatgpt` answered, Gemini was
 * handed the question and then told 「通道正在处理上一个问题，本次跳过」 while
 * three others were simply answering, and Kimi failed. Nothing was busy; the
 * cap was. It never saved memory either: a channel's `WebContentsView` exists
 * from the moment the source is switched on, whether it is being asked or not.
 *
 * So there is no global cap. Every channel the user has switched on gets the
 * question at the same time, which is the whole point of asking several at once.
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
    /** Only for tests that need to observe the refusal path. */
    private readonly maxConcurrent = Number.POSITIVE_INFINITY
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
   * Everything switched on, usable or not.
   *
   * `available()` answers "who can be asked"; this answers "who exists", which
   * is what the Master needs when nobody can be asked — the useful message then
   * is which pages to go and log into, not that there are none.
   */
  async all(): Promise<SubAgent[]> {
    return this.list();
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

  /**
   * Delete one agent's copy of a conversation on its own site.
   *
   * Resolves rather than throws, for the same reason as `newConversation`: the
   * local delete has already happened, and a page that cannot be cleaned is
   * something to report, not something to fail the whole operation over.
   */
  async deleteConversation(agentId: string, threadUrl: string): Promise<DeleteThreadResult> {
    const agent = this.byId.get(agentId);
    if (!agent) return { ok: false, detail: '没有这个 agent' };
    if (!agent.deleteConversation) return { ok: false, detail: '该 agent 不支持删除会话' };
    try {
      return await agent.deleteConversation(threadUrl);
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  get concurrency(): number {
    return this.maxConcurrent;
  }
}
