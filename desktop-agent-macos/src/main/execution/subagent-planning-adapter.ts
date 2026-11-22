/**
 * 把任意 `SubAgent` 包成 `PlanningAdapter`。
 *
 * 为什么需要它：工程任务的并行成员里既有 Provider 模型（已有
 * `ProviderPlanningAdapter`），也有 CLI（`CliAnswerAgent` 只实现 `SubAgent`，
 * 没有流式）。工作台要按成员分列，就必须让所有成员都从编排器那一个入口被问，
 * 而不是「模型走一条路、CLI 走另一条路」——两条路最终会有一处漏了身份字段，
 * 界面就把那个成员算成主导。
 *
 * 这里不伪造流式：SubAgent 没有 `askStream` 时只在拿到全文后发一次 snapshot
 * 增量。卡片会显示「未提供 reasoning / Token」，这是事实，不是缺陷。
 */
import type { DeepSeekStatus } from '../../shared/contracts';
import type { MessageSnapshot, PlanningAdapter, SendOutcome } from '../adapters/browser/page-driver';
import type { SubAgent } from '../agents/types';

export class SubAgentPlanningAdapter implements PlanningAdapter {
  readonly siteLabel: string;
  /** CLI 与 Provider 一样可以并发：它们各自是独立进程/HTTP 请求，不共享页面。 */
  readonly concurrent = true;

  private readonly pending = new Map<string, Promise<string>>();

  constructor(
    private readonly agent: SubAgent,
    private readonly timeoutMs = 180_000
  ) {
    this.siteLabel = agent.label;
  }

  async getStatus(): Promise<DeepSeekStatus> {
    const status = await this.agent.health();
    return {
      url: `subagent://${this.agent.id}`,
      pageReady: status.available,
      loggedIn: status.available,
      hasInput: true,
      hasSendButton: true,
      generating: false,
      messageCount: 0,
      ...(status.detail ? { detail: status.detail } : {})
    };
  }

  async sendMessage(
    text: string,
    requestId: string,
    onDelta?: (chunk: { text?: string; reasoning?: string; reset?: boolean; mode?: 'snapshot' | 'delta'; providerId?: string; modelId?: string }) => void
  ): Promise<SendOutcome> {
    const promise = this.agent
      .ask({ question: text, stage: 'initial', timeoutMs: this.timeoutMs })
      .then(answer => {
        // 一次性给全文：这个来源没有增量可透传，不能把一次全文拆成假 delta。
        onDelta?.({ text: answer.text, reset: true, mode: 'snapshot' });
        return answer.text;
      });
    this.pending.set(requestId, promise);
    const snapshot: MessageSnapshot = {
      messageCount: 0,
      lastText: '',
      url: `subagent://${this.agent.id}`,
      capturedAt: Date.now(),
      conversationText: '',
      composerText: ''
    };
    return { submitted: true, snapshotBefore: snapshot, method: 'subagent', signals: [], waitedMs: 0 };
  }

  async waitForAnswer(requestId: string): Promise<string> {
    const promise = this.pending.get(requestId);
    if (!promise) throw new Error('没有找到这次规划请求');
    try {
      return await promise;
    } finally {
      this.pending.delete(requestId);
    }
  }

  async newConversation(): Promise<{ ok: boolean; method: string }> {
    return { ok: true, method: 'subagent' };
  }

  cancelWait(requestId: string): void {
    this.pending.delete(requestId);
    // SubAgent 的取消签名是 requestId；CLI 代理按它掐进程。
    (this.agent as { cancel?: (id: string) => void }).cancel?.(requestId);
  }
}
