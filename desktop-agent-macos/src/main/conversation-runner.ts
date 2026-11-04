import { randomUUID } from 'node:crypto';
import type { AgentTask } from '../shared/contracts';
import type { Conversation, ConversationDeleteOutcome, ConversationEvent, ConversationExecutionConfig, ConversationMessage } from '../shared/conversation';
import { normalizeExecutionConfig } from '../shared/conversation';
import { classifyIntent } from '../shared/intent';
import type { AgentStore } from './store';
import type { SubAgentRegistry } from './agents/registry';
import type { SubAgentAnswer, SubAgentPool } from './agents/types';
import { MasterAgent, type ResearchOutcome, type ResearchRequest, type ResearchSink } from './master-agent';
import { CollaborationResearch, type CollaborationRecord } from './collaboration/runner';
import { synthesizeWithFusion } from './synthesis/engine';
import type { JudgeVerdict } from './judge/types';

export interface ConversationDeps {
  store: AgentStore;
  registry: SubAgentRegistry;
  emit: (event: ConversationEvent) => void;
  /**
   * Hand-off for the one intent that touches disk. Injected rather than
   * imported so this file cannot reach the runtime by accident — the whole
   * point of the split is that the conversation path has no execution in it.
   */
  submitWorkspace: (input: { prompt: string; permissionPreset: string; workspaceRoot?: string }) => Promise<AgentTask>;
  /**
   * Test seam for the turn budget. Five minutes is a product number, not a
   * behaviour — a test that has to wait five minutes to see what happens when
   * the budget runs out is a test nobody runs.
   */
  budgetMs?: number;
  /**
   * 把「这一轮问谁」交给外面组装，runner 自己不认识执行模式。
   *
   * 不传就是老行为（整份网页注册表），所以现有测试和没有接线的环境都不受影响。
   */
  poolFor?: (config: ConversationExecutionConfig, base: SubAgentPool) => SubAgentPool;
  /**
   * 哪些成员有「网页里那一份会话」。本地/云端没有站点侧栏，删除时不该
   * 提示用户去手动删网页记录，也不该去重置一个不存在的页面。
   */
  isPageChannel?: (agentId: string) => boolean;
  /** Phase F：每个子任务状态变化时的旁路通知，给界面和记录用。 */
  onCollaborationRecord?: (record: CollaborationRecord) => void;
  /** Phase I：打开融合引擎。不传时继续用规则版 synthesize，老行为不变。 */
  fusionEnabled?: boolean;
  /** 这一轮的独立裁决（如果有），给综合报告的 finalDecision 用。 */
  verdictFor?: (conversationId: string) => JudgeVerdict | null;
}

/** MasterAgent 与协作执行器共有的接口，conduct 只认这一个方法。 */
export interface ResearchRunner {
  research(request: ResearchRequest, sink: ResearchSink): Promise<ResearchOutcome>;
}

const TITLE_CHARS = 42;

/**
 * How long one turn may take before the runner stops waiting on it.
 *
 * A channel has its own three-minute deadline for the answer itself, and that
 * deadline is only reachable if every call underneath it returns. When something
 * in that chain never returns — a page call that hangs on a stuck renderer, a
 * navigation that never finishes — the per-answer deadline is never even
 * consulted, and the turn sits at 「思考中」 forever. This is the outer bound:
 * past it the turn ends as a failure that names what was still being waited on,
 * because 「等了五分钟，ChatGPT 没有回应」 is a usable thing to read and
 * 「思考中」 is not.
 */
const TURN_BUDGET_MS = 5 * 60_000;

/** Statuses that mean a turn is running — i.e. the ones a crash can strand. */
const IN_FLIGHT_STATUSES = new Set<Conversation['status']>([
  'thinking',
  'collecting',
  'comparing',
  'synthesizing'
]);

/**
 * Runs one conversation: route it, hand it to the Master Agent, record what came back.
 *
 * This file used to contain the whole research loop. It no longer does, and the
 * split is the point: who participates, how many rounds there are and when a
 * dispute gets put back to the agents is a *research* decision, and it now lives
 * in `master-agent.ts` where it can be tested without a store or an event bus.
 *
 * What is left here is bookkeeping: the conversation row, the messages, the
 * events the renderer listens to. There is still no plan, no approval and no
 * runtime in this file — a question that needs none of those should not pass
 * through any of them.
 */
export class ConversationRunner {
  /** Conversations the user pressed stop on. The Master checks this between steps. */
  private readonly cancelled = new Set<string>();

  /**
   * Turns that are still in flight, with their budget timer.
   *
   * The set is not only bookkeeping: it is what keeps a second question from
   * being started on top of a running one. That happened, and it does not look
   * like an error — the pane simply gained a second identical user bubble while
   * the page was asked nothing new, because only one ask per page can be in
   * flight. Two bubbles and one stuck channel is a worse outcome than a refusal.
   */
  private readonly running = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: ConversationDeps) {}

  private get budgetMs(): number {
    return this.deps.budgetMs ?? TURN_BUDGET_MS;
  }

  list(): Conversation[] {
    return this.deps.store.listConversations();
  }

  get(conversationId: string): Conversation | null {
    return this.deps.store.getConversation(conversationId);
  }

  messages(conversationId: string): ConversationMessage[] {
    return this.deps.store.listMessages(conversationId);
  }

  /**
   * Delete a conversation, and the copies of it the sites are holding.
   *
   * The local row goes first and unconditionally: the user asked for it to
   * disappear, and a web page that cannot be cleaned is not a reason to keep
   * showing it. What happens to the pages afterwards is reported back, because
   * "已删除" over a ChatGPT sidebar that still lists the thread is a lie the
   * user only discovers later.
   *
   * Three states, and each site gets the same treatment regardless of which one
   * it is in — that is the point of this pass:
   *
   * - answered with an address: the thread is removed from the site's sidebar;
   * - answered with no address: it may still be in the account, so the user is
   *   told plainly instead of being told a deletion succeeded;
   * - asked but never answered: nothing was created, so nothing is reported.
   *   This used to be lumped in with the second case, and the "please delete it
   *   by hand" it produced sent people looking for a row that never existed.
   *
   * Whichever of the three, the page is then moved to a new chat. A page left
   * sitting on a deleted conversation silently continues it on the next
   * question, which is the failure that makes a delete look like it did
   * nothing.
   */
  async delete(conversationId: string): Promise<ConversationDeleteOutcome> {
    const conversation = this.deps.store.getConversation(conversationId);
    const asked = conversation?.channels ?? [];
    const threads = conversation?.threads ?? {};
    // Conversations written before `answered` existed only carry evidence of
    // the answers that left an address behind. That is enough: every channel
    // with a thread is one this conversation definitely talked to.
    const answered = new Set(conversation?.answered ?? Object.keys(threads));

    // A running turn would keep typing into a page whose row is being removed.
    this.cancelled.add(conversationId);
    this.release(conversationId);
    for (const agentId of asked) this.deps.registry.cancelAll(agentId);

    this.deps.store.deleteConversation(conversationId);

    const cleaned: string[] = [];
    const reset: string[] = [];
    const failed: ConversationDeleteOutcome['failed'] = [];

    await Promise.all(
      asked.map(async agentId => {
        const isPage = this.deps.isPageChannel
          ? this.deps.isPageChannel(agentId)
          : this.deps.registry.get(agentId) !== undefined;
        // 真机回归抓到的：本地模型回答完也在 `answered` 里，但没有网页地址。
        // 走原来的分支会报「网页里的那份请手动删除」，让用户去一个不存在
        // 的侧栏找记录。非网页来源没有需要清理的副本，直接跳过。
        if (!isPage) return;

        const label = this.deps.registry.get(agentId)?.label ?? agentId;
        const threadUrl = threads[agentId];

        if (threadUrl) {
          const result = await this.deps.registry.deleteConversation(agentId, threadUrl);
          if (result.ok) cleaned.push(agentId);
          else failed.push({ channelId: agentId, label, detail: result.detail ?? '删除失败' });
        } else if (answered.has(agentId)) {
          // It answered, so the site almost certainly saved something, and the
          // app has no address to find it by. Saying so is the only actionable
          // thing left.
          failed.push({ channelId: agentId, label, detail: '这条会话没有记录网页地址，网页里的那份请手动删除' });
        }

        // Leaving the page on the deleted thread used to be the fallback after
        // a failed delete, and a no-op after a successful one. Both are wrong
        // for the next question, so all of them move on.
        const moved = await this.deps.registry.newConversation(agentId);
        if (moved.ok) reset.push(agentId);
      })
    );

    return { cleaned, reset, failed };
  }

  async start(input: {
    text: string;
    workspaceRoot?: string;
    permissionPreset?: string;
    executionConfig?: Partial<ConversationExecutionConfig>;
  }): Promise<Conversation> {
    const text = input.text.trim();
    if (!text) throw new Error('先写一句你想研究或完成的事情。');

    const intent = classifyIntent(text);
    const now = Date.now();
    const conversation: Conversation = {
      conversationId: randomUUID(),
      title: text.slice(0, TITLE_CHARS),
      intent: intent.kind,
      intentReason: intent.reason,
      status: 'thinking',
      channels: [],
      createdAt: now,
      updatedAt: now,
      executionConfig: normalizeExecutionConfig(input.executionConfig)
    };

    this.save(conversation);
    this.deps.emit({ type: 'conversation.created', at: now, conversation });
    this.addMessage(conversation, { role: 'user', text });

    // The one branch that leaves this file. Everything about it — approval,
    // grants, the runtime — is the executor's business, and the conversation
    // just records that it happened.
    if (intent.kind === 'workspace') {
      try {
        const task = await this.deps.submitWorkspace({
          prompt: text,
          permissionPreset: input.permissionPreset ?? 'workspace-write',
          workspaceRoot: input.workspaceRoot
        });
        conversation.taskId = task.taskId;
        conversation.status = 'answered';
        conversation.updatedAt = Date.now();
        this.save(conversation);
        this.addMessage(conversation, {
          role: 'system',
          text: `这是一次工作区操作，已转交执行计划（任务 ${task.taskId.slice(0, 8)}）。左侧会显示计划与审批。`
        });
      } catch (error) {
        this.fail(conversation, error);
      }
      return this.deps.store.getConversation(conversation.conversationId)!;
    }

    // Returned immediately: a web answer can take a minute, and an IPC call
    // that blocks for a minute is indistinguishable from a hung app. Progress
    // arrives as events.
    void this.run(conversation, text, { followup: false }).catch(error =>
      this.fail(conversation, error)
    );
    return conversation;
  }

  async followup(conversationId: string, text: string): Promise<Conversation> {
    const conversation = this.deps.store.getConversation(conversationId);
    if (!conversation) throw new Error('对话不存在');
    if (conversation.taskId) throw new Error('这是一次工作区任务，请到左侧任务里继续');

    const question = text.trim();
    if (!question) throw new Error('先写一句你想追问的内容。');

    // Refused before the message is written, not after: a second bubble for the
    // same question is a lie about what was asked, and it is the part that
    // survives in the history.
    if (this.running.has(conversationId)) {
      throw new Error('上一轮还在等回答。等它结束，或先点「停止等待」，再发下一句。');
    }

    this.cancelled.delete(conversationId);
    this.addMessage(conversation, { role: 'user', text: question });
    void this.run(conversation, question, { followup: true }).catch(error =>
      this.fail(conversation, error)
    );
    return conversation;
  }

  /**
   * Stop waiting.
   *
   * Two things have to happen and they are not the same: the conversation stops
   * (this flag, which the Master checks between steps), and the page stops being
   * waited on. The second one used to be a no-op — the request id was only known
   * *after* the answer arrived, so cancelling mid-flight passed an empty string.
   * Now the adapter is asked to drop every pending wait it has for that agent.
   */
  cancel(conversationId: string): void {
    this.cancelled.add(conversationId);
    this.release(conversationId);
    const conversation = this.deps.store.getConversation(conversationId);
    for (const agentId of conversation?.channels ?? []) {
      this.deps.registry.cancelAll(agentId);
    }
    if (!conversation) return;
    conversation.status = 'cancelled';
    conversation.updatedAt = Date.now();
    this.save(conversation);
  }

  // -------------------------------------------------------------------------

  /**
   * Turns a previous process left mid-flight.
   *
   * They are loaded from disk as 「思考中」 and nothing will ever move them: the
   * promise that would have finished the turn died with the process that owned
   * it. Left alone they read as work still in progress — a spinner over a
   * conversation nobody is working on, which is indistinguishable from a hang
   * and therefore worse than an honest interruption.
   */
  reconcile(): number {
    let changed = 0;
    for (const conversation of this.deps.store.listConversations()) {
      if (!IN_FLIGHT_STATUSES.has(conversation.status)) continue;
      conversation.status = 'failed';
      conversation.error = '上一轮在应用退出前没有结束，已标记为中断。重新发一次即可。';
      conversation.updatedAt = Date.now();
      this.save(conversation);
      changed += 1;
    }
    return changed;
  }

  private release(conversationId: string): void {
    const timer = this.running.get(conversationId);
    if (timer) clearTimeout(timer);
    this.running.delete(conversationId);
  }

  /**
   * The turn ran out of budget.
   *
   * Shaped like a user pressing stop, for the same two reasons: the flag is what
   * the Master checks between steps, and cancelling the pages is what stops a
   * late answer from being written into a turn that has already been declared
   * over. Without the second part the failure card would grow an answer minutes
   * after the fact.
   */
  private abandon(conversation: Conversation): void {
    const conversationId = conversation.conversationId;
    if (!this.running.has(conversationId)) return;

    this.cancelled.add(conversationId);
    this.release(conversationId);
    for (const agentId of conversation.channels) {
      this.deps.registry.cancelAll(agentId);
    }

    const waiting = conversation.channels
      .map(id => this.deps.registry.get(id)?.label ?? id)
      .join('、');
    const budget = this.budgetMs;
    const spent = budget >= 60_000 ? `${String(Math.round(budget / 60_000))} 分钟` : `${String(Math.round(budget / 1000))} 秒`;
    this.fail(
      conversation,
      new Error(
        `等了 ${spent}还没有结果${waiting ? `（${waiting}）` : ''}。` +
          '页面可能卡住了：点「停止等待」后重新加载那一页再问。'
      )
    );
  }

  private async run(
    conversation: Conversation,
    question: string,
    options: { followup: boolean }
  ): Promise<void> {
    const conversationId = conversation.conversationId;
    const config = normalizeExecutionConfig(conversation.executionConfig);
    const pool = this.deps.poolFor ? this.deps.poolFor(config, this.deps.registry) : this.deps.registry;
    // 默认（含 parallel）仍走原来的 MasterAgent，老路径零风险。只有显式选了
    // sequential / all-selected / smart 才换协作执行器。
    const master: ResearchRunner =
      config.strategy && config.strategy !== 'parallel'
        ? new CollaborationResearch(pool, config.strategy, question, undefined, this.deps.onCollaborationRecord)
        : new MasterAgent(pool);

    this.running.set(
      conversationId,
      setTimeout(() => this.abandon(conversation), this.budgetMs)
    );
    try {
      await this.conduct(conversation, master, question, options);
    } finally {
      this.release(conversationId);
    }
  }

  private async conduct(
    conversation: Conversation,
    master: ResearchRunner,
    question: string,
    options: { followup: boolean }
  ): Promise<void> {
    const conversationId = conversation.conversationId;

    const sink: ResearchSink = {
      join: (agentId: string) => {
        // Recorded before the ask, not after the answer: the strip above the
        // pane is how the user sees what is happening, and an agent being waited
        // on is the single most important thing to see. Recording it only on
        // success made a slow page look exactly like a hang.
        if (conversation.channels.includes(agentId)) return;
        conversation.channels.push(agentId);
        this.save(conversation);
      },
      record: (answer: SubAgentAnswer) => {
        // The address is what makes the web-side copy findable later. Recorded
        // with the message so a delete does not depend on the page still being
        // open on that thread — it usually is not.
        if (answer.threadUrl) {
          conversation.threads = { ...(conversation.threads ?? {}), [answer.agentId]: answer.threadUrl };
        }
        // Answered, which is not the same as asked: a channel that timed out
        // was still in `channels`, and pretending it produced something is what
        // made a delete warn about rows that were never created.
        if (!conversation.answered?.includes(answer.agentId)) {
          conversation.answered = [...(conversation.answered ?? []), answer.agentId];
        }
        const message = this.addMessage(conversation, {
          role: 'channel',
          channelId: answer.agentId,
          text: answer.text
        });
        this.save(conversation);
        return message.messageId;
      },
      phase: (agentId, phase, detail) =>
        this.deps.emit({
          type: 'channel.phase',
          at: Date.now(),
          conversationId,
          channelId: agentId,
          phase,
          detail
        }),
      note: text => this.addMessage(conversation, { role: 'system', text }),
      status: status => this.setStatus(conversation, status),
      cancelled: () => this.cancelled.has(conversationId)
    };

    const outcome = await master.research(
      {
        question,
        followup: options.followup,
        // Continuity is per answered channel, not per asked one. A channel that
        // failed last turn is not holding this conversation's thread, so a
        // follow-up has to start it clean — otherwise its answer arrives with
        // whatever unrelated history the page was left on.
        continuing: new Set(conversation.answered ?? [])
      },
      sink
    );

    if (this.cancelled.has(conversationId)) return;

    // A channel that stayed silent is a fact the user needs. It used to be
    // dropped on the floor: two answers arrived out of three, the pane showed
    // two bubbles and no explanation, and the only way to learn that Gemini had
    // timed out was to reconstruct the round by hand.
    if (outcome.failures.length > 0) {
      this.addMessage(conversation, {
        role: 'system',
        text: `以下通道没有给出回答：${outcome.failures.join('；')}`
      });
    }

    // 融合引擎失败时保留原来的规则版综合，不抛错（ARCHITECTURE 11.9）。
    // 规则版本身已经是各通道回答的合成，降级后界面仍有东西可看。
    let synthesis = outcome.synthesis;
    if (this.deps.fusionEnabled && outcome.answers.length >= 2) {
      try {
        const fused = synthesizeWithFusion(
          outcome.answers.map(answer => ({
            channelId: answer.agentId,
            messageId: outcome.messageIds?.get(answer.agentId) ?? '',
            text: answer.text
          })),
          { verdict: this.deps.verdictFor?.(conversationId) ?? undefined }
        );
        synthesis = fused.synthesis;
      } catch {
        // 故意不记日志刷屏：降级是正常路径，原来的 synthesis 还在。
      }
    }

    if (synthesis) {
      const message = this.addMessage(conversation, {
        role: 'synthesis',
        synthesis,
        text: synthesis.recommendation
      });
      this.deps.emit({ type: 'synthesis.ready', at: Date.now(), conversationId, synthesis });
      void message;
    }

    this.setStatus(conversation, 'answered');
  }

  private setStatus(conversation: Conversation, status: Conversation['status']): void {
    conversation.status = status;
    conversation.updatedAt = Date.now();
    this.save(conversation);
  }

  private save(conversation: Conversation): void {
    this.deps.store.upsertConversation(conversation);
    this.deps.emit({ type: 'conversation.updated', at: Date.now(), conversation });
  }

  private addMessage(
    conversation: Conversation,
    input: Pick<ConversationMessage, 'role' | 'text'> & Partial<Pick<ConversationMessage, 'channelId' | 'synthesis'>>
  ): ConversationMessage {
    const message: ConversationMessage = {
      messageId: randomUUID(),
      conversationId: conversation.conversationId,
      role: input.role,
      channelId: input.channelId,
      synthesis: input.synthesis,
      text: input.text,
      at: Date.now()
    };
    this.deps.store.appendMessage(message);
    this.deps.emit({ type: 'message.added', at: message.at, message });
    return message;
  }

  private fail(conversation: Conversation, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    conversation.status = 'failed';
    conversation.error = message;
    conversation.updatedAt = Date.now();
    this.save(conversation);
    this.deps.emit({ type: 'conversation.failed', at: Date.now(), conversationId: conversation.conversationId, error: message });
  }
}
