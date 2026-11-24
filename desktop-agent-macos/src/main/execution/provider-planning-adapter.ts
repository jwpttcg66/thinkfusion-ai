/** 用云端/本地 Provider 承担执行规划，不再依赖网页登录。 */
import type { DeepSeekStatus } from '../../shared/contracts';
import type { PlanningAdapter, PlanningContext } from '../adapters/browser/page-driver';
import type { MessageSnapshot, SendOutcome } from '../adapters/browser/page-driver';
import type { ProviderBackedSubAgent } from './provider-sub-agent';

export class ProviderPlanningAdapter implements PlanningAdapter {
  readonly siteLabel: string;
  readonly concurrent = true;
  private readonly pending = new Map<string, Promise<string>>();
  private readonly progress = new Map<string, { text: number; reasoning: number }>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly agent: ProviderBackedSubAgent,
    /** 规划阶段的硬上限：推理模型只输出 reasoning 时不能无限等待。 */
    private readonly planTimeoutMs = 120_000,
    /** LT-P4-02：Engineering 规划上下文；Web/CLI 没有这条路径。 */
    private readonly planningContext: PlanningContext = {}
  ) {
    this.siteLabel = agent.label;
  }

  get contextMeta(): { providerId: string; modelId: string } {
    return {
      providerId: this.agent.provider.id,
      modelId: this.agent.modelId ?? this.agent.provider.id
    };
  }

  withContext(context: PlanningContext): PlanningAdapter {
    return new ProviderPlanningAdapter(this.agent, this.planTimeoutMs, context);
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

  async sendMessage(
    text: string,
    requestId: string,
    onDelta?: (chunk: { text?: string; reasoning?: string; reset?: boolean; mode?: 'snapshot' | 'delta'; providerId?: string; modelId?: string }) => void
  ): Promise<SendOutcome> {
    this.progress.set(requestId, { text: 0, reasoning: 0 });
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    const promise = (async () => {
      if (!onDelta) {
        const answer = await this.agent.ask({
          question: text,
          stage: 'initial',
          timeoutMs: 180_000,
          ...(this.planningContext.system && this.planningContext.system.length > 0
            ? { system: this.planningContext.system }
            : {}),
          ...(this.planningContext.context && this.planningContext.context.length > 0
            ? { context: this.planningContext.context }
            : {})
        });
        return answer.text;
      }
      let accumulated = '';
      let reasoning = '';
      const answer = await this.agent.askStream(
        {
          question: text,
          stage: 'initial',
          timeoutMs: 180_000,
          signal: controller.signal,
          ...(this.planningContext.system && this.planningContext.system.length > 0
            ? { system: this.planningContext.system }
            : {}),
          ...(this.planningContext.context && this.planningContext.context.length > 0
            ? { context: this.planningContext.context }
            : {})
        },
        chunk => {
          if (chunk.reset) {
            accumulated = '';
            reasoning = '';
          }
          if (chunk.text) accumulated += chunk.text;
          if (chunk.reasoning) reasoning += chunk.reasoning;
          this.progress.set(requestId, { text: accumulated.length, reasoning: reasoning.length });
          onDelta({
            text: accumulated,
            reasoning,
            reset: false,
            mode: 'snapshot',
            providerId: this.agent.provider.id,
            ...(this.agent.modelId ? { modelId: this.agent.modelId } : {})
          });
        }
      );
      return answer.text;
    })();
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
    const effective = Math.min(timeoutMs, this.planTimeoutMs);
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.controllers.get(requestId)?.abort();
          const progress = this.progress.get(requestId);
          const detail = progress
            ? `模型只输出了 ${progress.reasoning} 字符推理，没有计划文本。请换一个非推理模型，或取消后重试。`
            : '模型没有返回计划文本。请重试或换模型。';
          reject(new Error(`规划超时（${Math.round(effective / 1000)} 秒）：${detail}`));
        }, effective);
      });
      try {
        return await Promise.race([promise, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } finally {
      this.pending.delete(requestId);
      this.progress.delete(requestId);
      this.controllers.delete(requestId);
    }
  }

  async newConversation(): Promise<{ ok: boolean; method: string }> {
    return { ok: true, method: 'provider' };
  }

  cancelWait(requestId: string): void {
    this.controllers.get(requestId)?.abort();
    this.controllers.delete(requestId);
    this.pending.delete(requestId);
    this.agent.cancel?.(requestId);
  }
}
