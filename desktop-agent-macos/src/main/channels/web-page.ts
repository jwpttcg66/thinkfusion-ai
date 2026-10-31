import { randomUUID } from 'node:crypto';
import type { DeepSeekAdapter } from '../deepseek-adapter';
import {
  ChannelBusyError,
  ChannelUnavailableError,
  type AiChannel,
  type AskInput,
  type ChannelAnswer,
  type ChannelStatus,
  type NewSessionResult
} from './types';

/**
 * An AI that lives behind a chat page.
 *
 * Everything that knows about DOM — selectors, probing, waiting for the bubble
 * to settle, stripping our own echoed prompt — stays behind this class. Callers
 * get text, or an error that says which of the three things went wrong.
 *
 * The adapter underneath is still called `DeepSeekAdapter`; the name is
 * historical. What it actually does is drive a generic chat page through a
 * `PageDriver`, which is why the same class can back a second site once it is
 * given its own selector profile.
 */
export class WebPageChannel implements AiChannel {
  private inFlight = new Set<string>();

  constructor(
    private readonly spec: {
      id: string;
      label: string;
      adapter: DeepSeekAdapter;
      /** Page-driven answers are slow; a question deserves more than a socket timeout. */
      timeoutMs?: number;
    }
  ) {}

  get id(): string {
    return this.spec.id;
  }

  get label(): string {
    return this.spec.label;
  }

  async status(): Promise<ChannelStatus> {
    try {
      const status = await this.spec.adapter.getStatus();
      const available = status.loggedIn && status.pageReady && !status.generating;
      return {
        id: this.id,
        label: this.label,
        available,
        loggedIn: status.loggedIn,
        pageReady: status.pageReady,
        generating: status.generating,
        detail: status.detail
      };
    } catch (error) {
      return {
        id: this.id,
        label: this.label,
        available: false,
        loggedIn: false,
        pageReady: false,
        generating: false,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async ask(input: AskInput): Promise<ChannelAnswer> {
    if (this.inFlight.size > 0) throw new ChannelBusyError(this.id);

    const status = await this.status();
    if (!status.pageReady) throw new ChannelUnavailableError(this.id, status.detail ?? '页面未就绪');
    if (!status.loggedIn) throw new ChannelUnavailableError(this.id, status.detail ?? '未登录');

    const requestId = randomUUID();
    this.inFlight.add(requestId);
    try {
      const { snapshotBefore } = await this.spec.adapter.sendMessage(input.question, requestId);
      const text = await this.spec.adapter.waitForAnswer(
        requestId,
        snapshotBefore,
        // Long enough for a slow page, short enough that a broken one becomes a
        // visible failure instead of a conversation that never settles.
        //
        // Ninety seconds used to be the number, and it was measured against a
        // plain chat answer. A page that decides to search the web first spends
        // that long collecting sources before it writes a word: a real DeepSeek
        // answer that opened thirteen pages finished well after the old limit,
        // so the app declared failure while the answer was still being written.
        // Three minutes covers a search-backed answer and still ends.
        input.timeoutMs ?? this.spec.timeoutMs ?? 180_000,
        input.question
      );
      return {
        channelId: this.id,
        text,
        receivedAt: Date.now(),
        attribution: { requestId, note: '气泡增量 + 连续三次稳定' }
      };
    } finally {
      this.inFlight.delete(requestId);
    }
  }

  /**
   * Start a new chat on the page.
   *
   * Never throws: the caller has to be able to ask the question anyway, and a
   * page that cannot reset is a fact to display, not a reason to lose the
   * answer. The detail says which of the two things happened.
   */
  async newConversation(): Promise<NewSessionResult> {
    try {
      const result = await this.spec.adapter.newConversation();
      return result.ok ? { ok: true } : { ok: false, detail: result.detail ?? '未能开新会话' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  cancel(requestId: string): void {
    this.spec.adapter.cancelWait(requestId);
  }
}
