import { randomUUID } from 'node:crypto';
import type { AgentTask } from '../shared/contracts';
import type { Conversation, ConversationEvent, ConversationMessage } from '../shared/conversation';
import { classifyIntent, isMultiChannel } from '../shared/intent';
import { buildConversationPrompt } from '../shared/prompts';
import type { AgentStore } from './store';
import type { ChannelRegistry } from './channels/registry';
import { ChannelBusyError, ChannelUnavailableError, type ChannelAnswer } from './channels/types';
import { synthesize } from '../shared/synthesizer';

export interface ConversationDeps {
  store: AgentStore;
  registry: ChannelRegistry;
  emit: (event: ConversationEvent) => void;
  /**
   * Hand-off for the one intent that touches disk. Injected rather than
   * imported so this file cannot reach the runtime by accident — the whole
   * point of the split is that the conversation path has no execution in it.
   */
  submitWorkspace: (input: { prompt: string; permissionPreset: string; workspaceRoot?: string }) => Promise<AgentTask>;
}

const TITLE_CHARS = 42;

/**
 * Runs one conversation: route, ask, collect, synthesise.
 *
 * There is no plan, no approval and no runtime in this file. A question that
 * needs none of those should not pass through any of them.
 */
export class ConversationRunner {
  /** conversationId -> requestIds in flight, so cancel can actually stop a wait. */
  private readonly inFlight = new Map<string, Set<{ channelId: string; requestId: string }>>();
  private readonly cancelled = new Set<string>();

  constructor(private readonly deps: ConversationDeps) {}

  list(): Conversation[] {
    return this.deps.store.listConversations();
  }

  get(conversationId: string): Conversation | null {
    return this.deps.store.getConversation(conversationId);
  }

  messages(conversationId: string): ConversationMessage[] {
    return this.deps.store.listMessages(conversationId);
  }

  delete(conversationId: string): void {
    this.deps.store.deleteConversation(conversationId);
  }

  async start(input: { text: string; workspaceRoot?: string; permissionPreset?: string }): Promise<Conversation> {
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
      updatedAt: now
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
    void this.run(conversation, text, { followup: false, intent: intent.kind }).catch(error =>
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

    this.cancelled.delete(conversationId);
    this.addMessage(conversation, { role: 'user', text: question });
    void this.run(conversation, question, { followup: true, intent: conversation.intent }).catch(error =>
      this.fail(conversation, error)
    );
    return conversation;
  }

  cancel(conversationId: string): void {
    this.cancelled.add(conversationId);
    for (const request of this.inFlight.get(conversationId) ?? []) {
      this.deps.registry.cancel(request.channelId, request.requestId);
    }
    const conversation = this.deps.store.getConversation(conversationId);
    if (!conversation) return;
    conversation.status = 'cancelled';
    conversation.updatedAt = Date.now();
    this.save(conversation);
  }

  // -------------------------------------------------------------------------

  private async run(
    conversation: Conversation,
    question: string,
    options: { followup: boolean; intent: Conversation['intent'] }
  ): Promise<void> {
    const conversationId = conversation.conversationId;
    const multi = isMultiChannel(options.intent);

    const usable = await this.deps.registry.available();
    const targets = multi ? usable : usable.slice(0, 1);

    if (targets.length === 0) {
      this.fail(conversation, new Error('没有可用的通道：请先在右侧页面登录 DeepSeek 或 ChatGPT。'));
      return;
    }

    this.setStatus(conversation, multi ? 'collecting' : 'thinking');

    const askedBefore = new Set(conversation.channels);
    const pending = new Set<{ channelId: string; requestId: string }>();
    this.inFlight.set(conversationId, pending);

    const answers: Array<{ answer: ChannelAnswer; messageId: string }> = [];
    /** Channels whose page could not start over. Reported once, after the asks. */
    const resetFailures: string[] = [];

    await Promise.all(
      targets.map(async channel => {
        if (this.cancelled.has(conversationId)) return;

        // The first time this conversation talks to this channel, give the page
        // a fresh session — otherwise the thread a user opens later is an
        // unrelated history with today's question glued onto the end. A
        // follow-up deliberately skips this: the page's own history is the
        // context that makes it a follow-up. Gated per channel rather than per
        // turn, so a channel that failed last turn still starts clean when it
        // is retried.
        const fresh = !askedBefore.has(channel.id);
        if (fresh) {
          this.deps.emit({
            type: 'channel.phase',
            at: Date.now(),
            conversationId,
            channelId: channel.id,
            phase: 'resetting'
          });
          const reset = await this.deps.registry.newConversation(channel.id);
          if (!reset.ok) resetFailures.push(`${channel.label}：${reset.detail ?? '未能开新会话'}`);
          if (this.cancelled.has(conversationId)) return;
        }

        const prompt = buildConversationPrompt({
          question,
          intent: options.intent === 'workspace' ? 'answer' : options.intent,
          first: fresh,
          followup: options.followup
        });

        // Recorded before the ask, not after the answer. The strip is how the
        // user sees what is happening, and a channel that is being waited on is
        // the single most important thing to see — the old order meant a slow
        // page showed up as nothing at all, i.e. exactly like a hang.
        if (!conversation.channels.includes(channel.id)) {
          conversation.channels.push(channel.id);
          this.save(conversation);
        }

        this.deps.emit({
          type: 'channel.phase',
          at: Date.now(),
          conversationId,
          channelId: channel.id,
          phase: 'asking'
        });

        // Tracked before the ask so a cancel arriving mid-flight can reach it.
        const slot = { channelId: channel.id, requestId: '' };
        pending.add(slot);

        try {
          const answer = await this.deps.registry.ask(channel.id, {
            question: prompt,
            stage: options.followup ? 'followup' : 'initial'
          });
          slot.requestId = answer.attribution.requestId;

          if (this.cancelled.has(conversationId)) return;

          const message = this.addMessage(conversation, {
            role: 'channel',
            channelId: channel.id,
            text: answer.text
          });
          answers.push({ answer, messageId: message.messageId });
          this.save(conversation);

          this.deps.emit({
            type: 'channel.phase',
            at: Date.now(),
            conversationId,
            channelId: channel.id,
            phase: 'answered'
          });
        } catch (error) {
          // One channel failing is a fact to display, not a reason to abort:
          // the other answers are still worth having.
          this.deps.emit({
            type: 'channel.phase',
            at: Date.now(),
            conversationId,
            channelId: channel.id,
            phase: error instanceof ChannelBusyError ? 'busy' : 'failed',
            detail: describeChannelError(error, channel.id)
          });
        } finally {
          pending.delete(slot);
        }
      })
    );

    this.inFlight.delete(conversationId);

    if (this.cancelled.has(conversationId)) return;

    // A channel that could not reset was still asked: an answer carrying old
    // context beats no answer, but a wrong answer that looks fresh is worse
    // than a slow one, so the drift is stated rather than hidden.
    if (resetFailures.length > 0) {
      this.addMessage(conversation, {
        role: 'system',
        text: `以下通道没能开新会话，回答可能带着网页里的旧上下文：${resetFailures.join('；')}`
      });
    }

    if (answers.length === 0) {
      this.fail(conversation, new Error('所有通道都没有给出回答，请检查右侧页面是否已登录并可用。'));
      return;
    }

    // Two or more answers is the only case where synthesis means anything. With
    // one, the honest output is the answer itself.
    if (answers.length >= 2) {
      this.setStatus(conversation, 'synthesizing');
      const synthesis = synthesize(
        answers.map(item => ({
          channelId: item.answer.channelId,
          messageId: item.messageId,
          text: item.answer.text
        }))
      );

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

function describeChannelError(error: unknown, channelId: string): string {
  if (error instanceof ChannelBusyError) return '通道正在处理上一个问题，本次跳过';
  if (error instanceof ChannelUnavailableError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  return `${channelId}: ${message}`;
}
