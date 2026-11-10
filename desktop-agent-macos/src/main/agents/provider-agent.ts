import type { ChannelStatus } from '../../shared/conversation';
import type { BrowserAdapter, DeleteThreadResult, NewSessionResult } from '../adapters/browser/types';
import { diffPartial } from '../../shared/partial-stream';
import type { SubAgent, SubAgentAnswer, SubAgentIdentity, SubAgentTask } from './types';

/**
 * One AI site, as a participant.
 *
 * The adapter underneath is replaceable — a different selector profile, a
 * recorded fixture, a future Playwright driver — and this class does not change
 * when it is. What lives here is what the adapter has no business knowing:
 *
 * - identity: which model is speaking, so a claim can be attributed to it;
 * - the session: whether this page has been given a fresh thread yet;
 * - the result: text as a page produced it, or a failure with a reason;
 * - the health record: what went wrong last time, kept so the next round can
 *   say "this one has failed twice" instead of silently skipping it.
 *
 * A failure is not hidden. `health()` still reports whatever the page says, and
 * the streak is appended to `detail` — a participant that keeps failing is a
 * fact the Master needs to see, not a participant that quietly disappears.
 */
export class ProviderSubAgent implements SubAgent {
  readonly identity: SubAgentIdentity;
  private failures = 0;
  private lastFailure: string | null = null;

  constructor(
    identity: Omit<SubAgentIdentity, 'kind'> & { kind?: SubAgentIdentity['kind'] },
    private readonly adapter: BrowserAdapter
  ) {
    this.identity = { ...identity, kind: identity.kind ?? 'provider' };
  }

  get id(): string {
    return this.identity.id;
  }

  get label(): string {
    return this.identity.label;
  }

  async health(): Promise<ChannelStatus> {
    const status = await this.adapter.status();
    if (this.failures === 0) return status;
    return {
      ...status,
      detail: [status.detail, `连续失败 ${this.failures} 次：${this.lastFailure ?? '原因未知'}`]
        .filter(Boolean)
        .join('；')
    };
  }

  /**
   * 网页流式：轮询已渲染的文本，按增量交给界面。
   *
   * 页面会改写自己（Markdown 收尾、引用 chip 后插），新文本不一定以旧文本开头；
   * 这时发 reset 整段替换，绝不能硬拼成「半截旧 + 半截新」。
   */
  async askStream(
    task: SubAgentTask,
    onDelta: (chunk: { text?: string; reasoning?: string; reset?: boolean }) => void
  ): Promise<SubAgentAnswer> {
    let last = '';
    const startedAt = Date.now();
    try {
      const answer = await this.adapter.ask({
        question: task.question,
        stage: task.stage,
        timeoutMs: task.timeoutMs,
        onPartial: text => {
          const diff = diffPartial(last, text);
          if (!diff) return;
          last = text;
          if (diff.append !== undefined) onDelta({ text: diff.append });
          else if (diff.reset !== undefined) onDelta({ text: diff.reset, reset: true });
        }
      });
      // 最终文本如果比最后一版多了尾巴，补出去；已经一致就什么都不做。
      const finalDiff = diffPartial(last, answer.text);
      if (finalDiff?.append !== undefined) onDelta({ text: finalDiff.append });
      else if (finalDiff?.reset !== undefined) onDelta({ text: finalDiff.reset, reset: true });
      this.failures = 0;
      this.lastFailure = null;
      return { ...answer, stage: task.stage, receivedAt: Date.now(), latencyMs: Date.now() - startedAt };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.failures += 1;
      this.lastFailure = detail;
      throw error;
    }
  }

  async ask(task: SubAgentTask): Promise<SubAgentAnswer> {
    const startedAt = Date.now();
    try {
      const answer = await this.adapter.ask({
        question: task.question,
        stage: task.stage,
        timeoutMs: task.timeoutMs
      });
      const text = normalizeAnswer(answer.text);
      if (!text) throw new Error('页面没有给出可读的回答');
      this.failures = 0;
      this.lastFailure = null;
      return {
        ...answer,
        text,
        stage: task.stage,
        // 网页不会报 token。这里写 null 是“不知道”，不是 0。
        usage: { inputTokens: null, outputTokens: null },
        latencyMs: Date.now() - startedAt
      };
    } catch (error) {
      this.failures += 1;
      this.lastFailure = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async newConversation(): Promise<NewSessionResult> {
    if (!this.adapter.newConversation) return { ok: false, detail: '该页面不支持开新会话' };
    return this.adapter.newConversation();
  }

  async deleteConversation(threadUrl: string): Promise<DeleteThreadResult> {
    if (!this.adapter.deleteConversation) return { ok: false, detail: '该页面不支持删除会话' };
    return this.adapter.deleteConversation(threadUrl);
  }

  cancel(requestId: string): void {
    this.adapter.cancel(requestId);
  }

  cancelAll(): void {
    this.adapter.cancelAll?.();
  }
}

/**
 * Text as a page produced it, minus the parts that are an artefact of scraping.
 *
 * Not the same job as `shared/text.ts`: that one removes what the *page* adds
 * (speaker labels, footnotes, our own echoed prompt). This one only fixes the
 * shape — trailing whitespace, and the runs of blank lines that appear when a
 * bubble is captured mid-render.
 */
export function normalizeAnswer(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
