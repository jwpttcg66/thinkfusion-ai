import {
  ChannelBusyError,
  type AiChannel,
  type AskInput,
  type ChannelAnswer,
  type ChannelStatus,
  type NewSessionResult
} from './types';

/**
 * The set of channels, and the only place that decides how many run at once.
 *
 * Two separate limits, for two different reasons:
 *
 * - Per channel: a chat page has one writer. A second question sent while the
 *   first is still being answered gets interleaved with it and both answers are
 *   then misread. So one ask per channel, and a second one is refused rather
 *   than queued.
 * - Global: each channel is a full `WebContentsView`, i.e. a renderer process.
 *   Three is already a lot of memory; six would make the machine the bottleneck
 *   and look like the app hanging.
 *
 * Refusing immediately is deliberate. A queued request looks like a stuck UI,
 * and the caller can always retry or skip that channel.
 */
export class ChannelRegistry {
  private readonly byId = new Map<string, AiChannel>();
  private readonly active = new Set<string>();

  constructor(
    channels: readonly AiChannel[],
    private readonly maxConcurrent = 3
  ) {
    for (const channel of channels) this.byId.set(channel.id, channel);
  }

  /**
   * Swap the whole channel set, keeping this instance.
   *
   * The list is no longer fixed at startup: turning a source on in 设置 has to
   * make it a channel, and turning it off has to stop it counting toward the
   * readiness pill. Replacing the object instead would leave every holder —
   * `ConversationRunner`, the status poller — talking to a registry nobody
   * updates, which is a class of bug that only shows up after a settings change.
   */
  replaceAll(channels: readonly AiChannel[]): void {
    this.byId.clear();
    for (const channel of channels) this.byId.set(channel.id, channel);
  }

  list(): AiChannel[] {
    return [...this.byId.values()];
  }

  get(id: string): AiChannel | undefined {
    return this.byId.get(id);
  }

  async statuses(): Promise<ChannelStatus[]> {
    return Promise.all(this.list().map(channel => channel.status()));
  }

  /**
   * Which channels a given intent should be asked.
   *
   * A plain question goes to one channel: asking three and synthesising is
   * slower and noisier for something like "what does SETNX do". Research and
   * comparison fan out, because the disagreement between channels is the
   * product.
   */
  async available(): Promise<AiChannel[]> {
    const statuses = await this.statuses();
    const usable = new Set(statuses.filter(status => status.available).map(status => status.id));
    return this.list().filter(channel => usable.has(channel.id));
  }

  async ask(channelId: string, input: AskInput): Promise<ChannelAnswer> {
    const channel = this.byId.get(channelId);
    if (!channel) throw new ChannelBusyError(channelId);
    if (this.active.has(channelId)) throw new ChannelBusyError(channelId);
    if (this.active.size >= this.maxConcurrent) throw new ChannelBusyError(channelId);

    this.active.add(channelId);
    try {
      return await channel.ask(input);
    } finally {
      this.active.delete(channelId);
    }
  }

  cancel(channelId: string, requestId: string): void {
    this.byId.get(channelId)?.cancel(requestId);
  }

  /**
   * Reset one channel's own session.
   *
   * Not counted against `maxConcurrent`: a reset is a page interaction that
   * happens *before* the ask, one per channel, and the per-channel "one writer"
   * rule is already enforced by the fact that a busy channel is never a target.
   */
  async newConversation(channelId: string): Promise<NewSessionResult> {
    const channel = this.byId.get(channelId);
    if (!channel) return { ok: false, detail: '通道不存在' };
    if (!channel.newConversation) return { ok: false, detail: '该通道不支持开新会话' };
    try {
      return await channel.newConversation();
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  get concurrency(): number {
    return this.maxConcurrent;
  }
}
