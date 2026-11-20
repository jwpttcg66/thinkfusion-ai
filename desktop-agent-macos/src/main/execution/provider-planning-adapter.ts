/** 用云端/本地 Provider 承担执行规划，不再依赖网页登录。 */
import type { DeepSeekStatus } from '../../shared/contracts';
import type { PlanningAdapter } from '../adapters/browser/page-driver';
import type { MessageSnapshot, SendOutcome } from '../adapters/browser/page-driver';
import type { ProviderBackedSubAgent } from './provider-sub-agent';

export class ProviderPlanningAdapter implements PlanningAdapter {
  readonly siteLabel: string;
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly agent: ProviderBackedSubAgent) {
    this.siteLabel = agent.label;
  }

  async getStatus(): Promise<DeepSeekStatus> {
    const status = await this.agent.health();
    return {
      url: `provider://${this.agent.id}`,
      pageReady: status.available,
      loggedIn: status.available,
      hasInput: true,
      hasSendButton: true,
      generating: false,
      messageCount: 0,
      ...(status.detail ? { detail: status.detail } : {})
    };
  }

  async sendMessage(text: string, requestId: string): Promise<SendOutcome> {
    const promise = this.agent
      .ask({ question: text, stage: 'initial', timeoutMs: 180_000 })
      .then(answer => answer.text);
    this.pending.set(requestId, promise);
    const snapshot: MessageSnapshot = {
      messageCount: 0,
      lastText: '',
      url: `provider://${this.agent.id}`,
      capturedAt: Date.now(),
      conversationText: '',
      composerText: ''
    };
    return {
      submitted: true,
      snapshotBefore: snapshot,
      method: 'provider',
      signals: [],
      waitedMs: 0
    };
  }

  async waitForAnswer(
    requestId: string,
    _snapshot: MessageSnapshot,
    timeoutMs: number,
    _sentText?: string
  ): Promise<string> {
    const promise = this.pending.get(requestId);
    if (!promise) throw new Error('没有找到这次规划请求');
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`规划超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
      });
      try {
        return await Promise.race([promise, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } finally {
      this.pending.delete(requestId);
    }
  }

  async newConversation(): Promise<{ ok: boolean; method: string }> {
    return { ok: true, method: 'provider' };
  }

  cancelWait(requestId: string): void {
    this.pending.delete(requestId);
    this.agent.cancel?.(requestId);
  }
}
