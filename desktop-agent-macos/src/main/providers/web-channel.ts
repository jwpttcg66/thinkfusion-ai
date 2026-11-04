import type { SubAgent } from '../agents/types';
import { PageBusyError, PageUnavailableError } from '../adapters/browser/types';
import {
  ProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelMetadata,
  type ProviderCapabilities,
  type ProviderHealth
} from './types';

/**
 * 把现有的网页通道包成统一的 Provider。
 *
 * 只读适配：`SubAgent`、`SubAgentPool`、`MasterAgent` 一行不改，现有调用路径
 * 完全不受影响。这一层的存在是为了让本地和云端 Provider 将来能并进同一份
 * 名单，不是为了把网页通道「重构成」Provider。
 *
 * 能力描述里有三条必须诚实的地方：
 *
 * - `streaming: false`。页面不是流。它可能一边写一边变，但那个变化不可靠、
 *   也不带增量语义，当流用会把半句话当句话。
 * - `cancellation: 'give-up'`。`cancelAll` 只是让本地不再等，页面还在生成。
 *   写成 `true` 会让上层以为取消能省配额。
 * - `modelDiscovery: 'unknown'`。网页不会告诉你后台在跑哪个模型，很多站点
 *   还会自己路由。`listModels` 返回的是「这个站点的默认模型」，不是列表。
 */
export class WebChannelProvider implements ModelProvider {
  readonly type = 'web' as const;
  readonly id: string;
  readonly label: string;

  constructor(private readonly agent: SubAgent) {
    this.id = agent.id;
    this.label = agent.label;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      streaming: false,
      cancellation: 'give-up',
      modelDiscovery: 'unknown',
      // 一个页面只有一个输入框。第二个问题会和第一个的回答缠在一起。
      maxConcurrency: 1,
      structuredOutput: false,
      toolCalling: false
    };
  }

  async listModels(): Promise<ModelMetadata[]> {
    return [
      {
        id: `${this.id}:default`,
        label: this.label,
        providerId: this.id,
        // 问不出来。写一个数字会被拿去切上下文，而那个数字是编的。
        contextTokens: null
      }
    ];
  }

  async health(): Promise<ProviderHealth> {
    try {
      const status = await this.agent.health();
      return { available: status.available, detail: status.detail, checkedAt: Date.now() };
    } catch (error) {
      // 探测本身失败也是一条状态，不是一次崩溃。
      return {
        available: false,
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: Date.now()
      };
    }
  }

  async generate(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    if (signal?.aborted) {
      throw new ProviderError('cancelled', '请求在发出前就被取消', this.id);
    }

    const started = Date.now();
    let onAbort: (() => void) | undefined;

    const abandoned = new Promise<never>((_, reject) => {
      onAbort = () => {
        // 只能做到「不等了」。页面不会因此停止生成，这一点写在 capabilities 里。
        this.agent.cancelAll?.();
        reject(new ProviderError('cancelled', '已放弃等待这一页', this.id));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    const asking = this.agent
      .ask({
        question: request.question,
        stage: request.continuation ? 'followup' : 'initial',
        timeoutMs: request.timeoutMs
      })
      .then(answer => ({
        text: answer.text,
        providerId: this.id,
        modelId: request.modelId ?? `${this.id}:default`,
        usage: { inputTokens: null, outputTokens: null },
        latencyMs: Date.now() - started
      }));

    try {
      return await Promise.race([asking, abandoned]);
    } catch (error) {
      throw this.mapError(error);
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      // 被放弃的那一支如果之后才失败，不该变成一个没人处理的 rejection。
      asking.catch(() => undefined);
    }
  }

  cancel(requestId: string): void {
    this.agent.cancel(requestId);
  }

  /** 现有错误 → 统一错误。`cause` 一定带上，原始信息比 code 细。 */
  private mapError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    if (error instanceof PageBusyError) {
      return new ProviderError('busy', error.message, this.id, error);
    }
    if (error instanceof PageUnavailableError) {
      return new ProviderError('unavailable', error.message, this.id, error);
    }
    const message = error instanceof Error ? error.message : String(error);
    // 现有实现用消息文本表达超时，没有专门类型。这里按文本识别，同时把
    // 原错误挂到 cause 上——将来它有了 TimeoutError，改这一行就够。
    if (message.includes('超时') || message.includes('timeout')) {
      return new ProviderError('timeout', message, this.id, error);
    }
    return new ProviderError('unknown', message, this.id, error);
  }
}
