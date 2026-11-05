import { randomUUID } from 'node:crypto';
import type { AgentTask } from '../shared/contracts';
import type { Conversation, ConversationDeleteOutcome, ConversationEvent, ConversationExecutionConfig, ConversationMessage, Synthesis } from '../shared/conversation';
import { normalizeExecutionConfig } from '../shared/conversation';
import { classifyIntent } from '../shared/intent';
import type { AgentStore } from './store';
import type { SubAgentRegistry } from './agents/registry';
import type { SubAgentAnswer, SubAgentPool } from './agents/types';
import { MasterAgent, type ResearchOutcome, type ResearchRequest, type ResearchSink } from './master-agent';
import { CollaborationResearch, type CollaborationRecord } from './collaboration/runner';
import { synthesizeWithFusion } from './synthesis/engine';
import {
  buildLeadSummaryQuestion,
  buildVerdictQuestion,
  formatDebateTranscript,
  inlineLeadInstructions,
  LEAD_SUMMARY_SYSTEM,
  LEAD_SUMMARY_TIMEOUT_MS,
  LEAD_VERDICT_SYSTEM,
  parseTopics,
  rewriteSourceRefs
} from './synthesis/lead-stage';
import { heuristicPick } from './synthesis/lead-selector';
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
   * 执行阶段成员（本地 + 云端模型）：它们不参与第一轮回答，但可以当主导人，
   * 也可以当辩手。不传表示没有执行阶段成员。
   */
  executorIdsFor?: (config: ConversationExecutionConfig) => ReadonlySet<string>;
  /**
   * 跑一场「会话内辩论」：主导人指定辩题后，由本地/云端模型多轮交锋。
   *
   * 辩论是独立子系统（`debate/`），runner 不认识它的调度；这里只拿回一份
   * 可读的轮次记录，交给主导人写最终意见。不传表示这一轮不跑辩论（只汇总）。
   */
  runDebate?: (input: {
    conversationId: string;
    question: string;
    topics: string[];
    /** 网页通道的第一轮回答，作为辩论的基准观点。 */
    seeds: Array<{ label: string; text: string }>;
    debaters: string[];
    lead: { agentId: string; label: string; kind: 'web' | 'local' | 'cloud' };
  }) => Promise<{
    debateId: string;
    rounds: Array<{
      index: number;
      messages: Array<{ author: string; kind: string; text: string }>;
      failures?: Array<{ agentId: string; detail: string }>;
    }>;
    status: string;
  } | null>;
  /** 删除会话时连带删掉这一轮的辩论记录；不传表示辩论记录不归会话管。 */
  deleteDebatesFor?: (conversationId: string) => void;
  /**
   * 哪些成员有「网页里那一份会话」。本地/云端没有站点侧栏，删除时不该
   * 提示用户去手动删网页记录，也不该去重置一个不存在的页面。
   */
  isPageChannel?: (agentId: string) => boolean;
  /**
   * 这个成员是什么来源。网页主导和云端主导在产物上要分开标注，所以要能问
   * 出来。不传就当网页（老行为）。
   */
  agentSource?: (agentId: string) => 'web' | 'local' | 'cloud' | undefined;
  /** Phase F：每个子任务状态变化时的旁路通知，给界面和记录用。 */
  onCollaborationRecord?: (record: CollaborationRecord) => void;
  /** Phase I：打开融合引擎。不传时继续用规则版 synthesize，老行为不变。 */
  fusionEnabled?: boolean;
  /** 这一轮的独立裁决（如果有），给综合报告的 finalDecision 用。 */
  verdictFor?: (conversationId: string) => JudgeVerdict | null;
  /**
   * 主导的自动选择：本地模型不是来源，不参与被提问名单；它在这里作为中立的
   * 评审，读「问题 + 各来源回答」挑出哪一份最适合主导辩论。返回 null（没装
   * 模型、超时、解析不出编号）时 runner 退回到按回答完整度的确定性兜底。
   */
  pickLead?: (input: {
    question: string;
    answers: Array<{ agentId: string; label: string; text: string }>;
  }) => Promise<{ agentId: string; label: string; reason: string } | null>;
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
    // 会话内辩论的产物随会话一起消失，否则辩论面板会留下一场没有归属的记录。
    this.deps.deleteDebatesFor?.(conversationId);

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
    const executorIds = this.deps.executorIdsFor?.(config) ?? new Set<string>();
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
      await this.conduct(conversation, master, question, options, pool, executorIds);
    } finally {
      this.release(conversationId);
    }
  }

  private async conduct(
    conversation: Conversation,
    master: ResearchRunner,
    question: string,
    options: { followup: boolean },
    pool: SubAgentPool,
    executorIds: ReadonlySet<string>
  ): Promise<void> {
    const conversationId = conversation.conversationId;
    const config = normalizeExecutionConfig(conversation.executionConfig);

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

    // 执行阶段（回答之后）：执行模式 = 谁当主导人，不决定谁回答——
    // 第一手回答永远来自网页通道（上面那轮）。主导人做三件事：
    //   1. 汇总全部回答，写【结论/一致/分歧/存疑】；
    //   2. 从分歧里指定辩题（没有实质分歧就不辩）；
    //   3. 读辩论记录，给最终意见。
    const execution = await this.runExecutionStage(
      pool,
      conversation,
      question,
      outcome,
      sink,
      executorIds
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

    // 主导人的产物盖过默认综合：结论、以及「哪些一致、哪里有分歧」这套结构，
    // 都由读过全部回答的主导人来说，规则版那套不再并列展示。
    if (execution && synthesis) {
      const { lead, summaryText, topics, debate, verdictText } = execution;
      const backend: NonNullable<Synthesis['fusion']>['backend'] =
        lead.kind === 'web' ? 'web' : lead.kind === 'local' ? 'local-model' : 'remote';
      const parts: string[] = [];
      parts.push(
        lead.auto
          ? `系统按「问题 + 答案质量」自动选 ${lead.label} 当主导人（${lead.reason ?? '本地模型判定'}）：它汇总了 ${outcome.answers.length} 份网页回答`
          : `由主导人 ${lead.label} 汇总了 ${outcome.answers.length} 份网页回答`
      );
      if (topics.length > 0) {
        parts.push(`它指定了 ${topics.length} 个辩题（${topics.join('；')}）`);
      } else {
        parts.push('回答之间没有需要辩的实质分歧，没有发起辩论');
      }
      if (debate) {
        parts.push(`辩论跑了 ${debate.rounds.length} 轮（${debate.status}）`);
      } else if (topics.length > 0) {
        parts.push('但可用的本地/云端辩手不足两位，这一轮没有真的辩起来，只给了汇总');
      }
      if (verdictText) parts.push('它读完辩论记录后给出最终意见');

      const text = verdictText ?? summaryText;
      if (text) {
        synthesis = {
          ...synthesis,
          recommendation: text,
          // 界面据此只显示这一段；和下面的清空是同一件事的两半。
          leadSummary: true,
          // 主导人给了结论，这一轮的结构也归它：五段里就有【一致】和【分歧】。
          // 规则版那套「共同提到 / 分歧 / 覆盖缺口 / 只有一个通道提到的」是按
          // 句子比对算出来的另一份判断，两者并存时界面就成了两张互相矛盾的
          // 结论——真机同一张卡片里，上面写着「没有实质性结论冲突」，下面却列
          // 着「分歧（3）」，而那三条是拿同一家的两句半截话凑的。一次只留一套。
          consensus: [],
          disputed: [],
          unique: [],
          gaps: [],
          overlap: [],
          // 「没有形成共识」说的是规则没能把句子对上，不适用于主导人读完全文
          // 之后写下的结论。
          degraded: false,
          fusion: synthesis.fusion
            ? {
                ...synthesis.fusion,
                backend,
                leadAgentId: lead.agentId,
                leadReason: lead.reason ?? undefined,
                leadAuto: lead.auto,
                debateId: debate?.debateId,
                debateTopics: topics.length > 0 ? topics : undefined,
                confidence: {
                  ...synthesis.fusion.confidence,
                  why: `${synthesis.fusion.confidence.why}；${parts.join('；')}`
                }
              }
            : synthesis.fusion
        };
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

  /**
   * 执行阶段：主导人的三步。
   *
   * 1. 汇总——读完全部网页回答，写【结论/一致/分歧/存疑】，并点出【辩题】；
   * 2. 指定辩论——辩题非空、且有两位以上本地/云端辩手时，交由辩论子系统交锋；
   * 3. 获取辩论——主导人读辩论记录，给最终意见。
   *
   * 网页通道也能当主导：它读不到别人的页面，只能由我们把各家答案拼成一条
   * 消息发进去（页面上表现为用户说的第二段话）。所以网页主导会多花两次生成。
   *
   * 失败不抛：任何一步没成，都退回「有回答、有规则版综合」的状态，原因写进
   * 系统消息，用户能看到是谁没说话、卡在哪。
   */
  private async runExecutionStage(
    pool: SubAgentPool,
    conversation: Conversation,
    question: string,
    outcome: ResearchOutcome,
    sink: ResearchSink,
    executorIds: ReadonlySet<string>
  ): Promise<{
    lead: { agentId: string; label: string; kind: 'web' | 'local' | 'cloud'; auto: boolean; reason: string | null };
    summaryText: string | null;
    topics: string[];
    debate: { debateId: string; rounds: Array<{ index: number; messages: Array<{ author: string; kind: string; text: string }>; failures?: Array<{ agentId: string; detail: string }> }>; status: string } | null;
    verdictText: string | null;
  } | null> {
    const config = normalizeExecutionConfig(conversation.executionConfig);
    const labels = new Map(outcome.channels.map(item => [item.agentId, item.label] as const));
    const answers = outcome.answers.map(answer => ({
      channelId: answer.agentId,
      label: labels.get(answer.agentId) ?? answer.agentId,
      text: answer.text
    }));
    // 一份回答没有可汇总的分歧，也没有可辩的对象：执行阶段直接跳过，
    // 保留规则版综合。只有多个来源时才需要主导人。
    if (answers.length < 2) return null;

    const lead = await this.resolveLead(config, question, answers, executorIds);
    if (!lead) return null;
    const isPage = lead.kind === 'web';
    const label = lead.label;

    this.setStatus(conversation, 'synthesizing');
    sink.phase(
      lead.agentId,
      'asking',
      lead.auto ? `自动选 ${label} 当主导人：汇总各家回答并指定辩题` : `${label} 当主导人：汇总各家回答并指定辩题`
    );

    // —— 第一步：汇总 + 指定辩题 ————————————————————————————
    let summaryText: string | null = null;
    try {
      const answer = await pool.ask(lead.agentId, {
        question: isPage
          ? inlineLeadInstructions(question, answers)
          : buildLeadSummaryQuestion(question, answers),
        stage: 'challenge',
        // 网页主导要把一整段重新键入并等它写完，和第一次回答一样慢，给足时间。
        timeoutMs: isPage ? 180_000 : LEAD_SUMMARY_TIMEOUT_MS,
        // 只有 API 主导用得上 system；网页通道会忽略它。
        system: isPage ? undefined : LEAD_SUMMARY_SYSTEM
      });
      const text = rewriteSourceRefs(answer.text.trim(), answers);
      summaryText = text || null;
      if (summaryText) sink.phase(lead.agentId, 'answered', '汇总完成');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      sink.phase(lead.agentId, 'failed', detail);
      this.addMessage(conversation, { role: 'system', text: `主导人 ${label} 没能完成汇总：${detail}` });
    }
    if (!summaryText) {
      return { lead, summaryText: null, topics: [], debate: null, verdictText: null };
    }

    // —— 第二步：指定辩论 ————————————————————————————————
    const topics = parseTopics(summaryText);
    const debaters = [...executorIds];
    let debate: Awaited<ReturnType<NonNullable<typeof this.deps.runDebate>>> = null;
    if (topics.length === 0) {
      this.addMessage(conversation, {
        role: 'system',
        text: `${label} 判断回答之间没有需要辩的实质分歧，这一轮只汇总、不发起辩论。`
      });
    } else if (debaters.length < 2) {
      this.addMessage(conversation, {
        role: 'system',
        text: `${label} 列出了 ${topics.length} 个辩题（${topics.join('；')}），但可用的本地/云端辩手不足两位，这一轮只汇总、不发起辩论。`
      });
    } else if (this.deps.runDebate) {
      this.addMessage(conversation, {
        role: 'system',
        text: `${label} 指定了 ${topics.length} 个辩题：${topics.join('；')}`
      });
      try {
        debate = await this.deps.runDebate({
          conversationId: conversation.conversationId,
          question,
          topics,
          seeds: answers.map(answer => ({ label: answer.label, text: answer.text })),
          debaters,
          lead: { agentId: lead.agentId, label, kind: lead.kind }
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.addMessage(conversation, { role: 'system', text: `辩论没能跑起来：${detail}` });
      }
    }

    // —— 第三步：获取辩论结果，给最终意见 ————————————————————
    let verdictText: string | null = null;
    if (debate && debate.rounds.length > 0) {
      const transcript = formatDebateTranscript(debate.rounds);
      sink.phase(lead.agentId, 'asking', '读辩论记录，给最终意见');
      try {
        const answer = await pool.ask(lead.agentId, {
          question: buildVerdictQuestion(question, summaryText, transcript),
          stage: 'challenge',
          timeoutMs: isPage ? 180_000 : LEAD_SUMMARY_TIMEOUT_MS,
          system: isPage ? undefined : LEAD_VERDICT_SYSTEM
        });
        const text = rewriteSourceRefs(answer.text.trim(), answers);
        verdictText = text || null;
        if (verdictText) sink.phase(lead.agentId, 'answered', '最终意见完成');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        sink.phase(lead.agentId, 'failed', detail);
        this.addMessage(conversation, { role: 'system', text: `${label} 读辩论记录时没给出最终意见：${detail}` });
      }
    }

    return { lead, summaryText, topics, debate, verdictText };
  }

  /**
   * 谁当主导人。
   *
   * - 手动指定且名额合法：就用它；
   * - 网页/本地/云端：取该类型第一个可用成员；
   * - 混合：交给本地模型按「问题 + 答案质量」挑（挑不出来按回答完整度兜底）。
   *
   * 该模式没有可用成员时如实退回网页回答者，并在系统消息里说明，不假装
   * 「本地主导」成功了。
   */
  private async resolveLead(
    config: ConversationExecutionConfig,
    question: string,
    answers: ReadonlyArray<{ channelId: string; label: string; text: string }>,
    executorIds: ReadonlySet<string>
  ): Promise<{
    agentId: string;
    label: string;
    kind: 'web' | 'local' | 'cloud';
    auto: boolean;
    reason: string | null;
  } | null> {
    const answerById = new Map(answers.map(answer => [answer.channelId, answer] as const));
    const kindOf = (agentId: string): 'web' | 'local' | 'cloud' => {
      if (this.deps.isPageChannel?.(agentId)) return 'web';
      const source = this.deps.agentSource?.(agentId);
      if (source === 'local' || source === 'cloud') return source;
      return answerById.has(agentId) ? 'web' : 'cloud';
    };
    const usable = (agentId: string) => answerById.has(agentId) || executorIds.has(agentId);
    const labelOf = (agentId: string) => answerById.get(agentId)?.label ?? agentId;

    const fixed = config.leadAgentId;
    if (fixed && usable(fixed)) {
      return { agentId: fixed, label: labelOf(fixed), kind: kindOf(fixed), auto: false, reason: null };
    }

    const executors = [...executorIds];
    const pickKind = (kind: 'local' | 'cloud') =>
      executors.find(agentId => this.deps.agentSource?.(agentId) === kind);

    if (config.executionMode === 'local' || config.executionMode === 'cloud') {
      const wanted = config.executionMode;
      const agentId = pickKind(wanted);
      if (agentId) {
        return { agentId, label: labelOf(agentId), kind: wanted, auto: false, reason: null };
      }
      const fallback = answers[0];
      // 该模式没有可用成员：如实退回网页回答者，reason 会写进结论文案，
      // 让用户看到「本地主导没成立」，而不是静默换成别人。
      return fallback
        ? {
            agentId: fallback.channelId,
            label: fallback.label,
            kind: 'web',
            auto: false,
            reason: `没有可用的${wanted === 'local' ? '本地' : '云端'}模型，退回网页通道 ${fallback.label} 主导`
          }
        : null;
    }

    if (config.executionMode === 'hybrid') {
      const candidates = answers.map(answer => ({
        agentId: answer.channelId,
        label: answer.label,
        text: answer.text
      }));
      const picked = (await this.deps.pickLead?.({ question, answers: candidates })) ?? heuristicPick(candidates);
      if (picked && usable(picked.agentId)) {
        return {
          agentId: picked.agentId,
          label: labelOf(picked.agentId),
          kind: kindOf(picked.agentId),
          auto: true,
          reason: picked.reason
        };
      }
    }

    const first = answers[0];
    if (!first) return null;
    return { agentId: first.channelId, label: first.label, kind: 'web', auto: false, reason: null };
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
