import {
  ProviderError,
  type ModelMetadata,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ProviderCapabilities,
  type ProviderHealth
} from './types';

/**
 * OpenAI 兼容的云端 Provider（项目书 5.2 第一阶段只要求这一个）。
 *
 * 与本地 Provider 的三点不同，决定了这里不能照抄 ollama.ts：
 *
 * 1. 流式是 SSE（`data: {...}` 行 + `[DONE]`），不是 NDJSON。
 * 2. 用量默认不随流式返回，必须显式开 `stream_options.include_usage`，
 *    否则流式调用的 token 数永远是「不知道」。
 * 3. 429 / 5xx 是常态而非故障，需要重试；但**只在还没吐出第一个字之前**
 *    重试。已经 yield 出去的内容收不回来，重试会把两段回答拼在一起。
 *
 * API Key 每次请求现取，用户改完立刻生效；取不到就报 auth，不缓存明文。
 * 单价做成传入配置，不硬编码——写死在代码里的价目表过期之后，估出来的
 * 数比没有更糟。
 */

export interface PriceRule {
  /** 每百万 input token 的价格，币种与 `currency` 一致。 */
  inputPerMillion: number;
  outputPerMillion: number;
  currency: string;
}

export interface CloudOptions {
  id?: string;
  label?: string;
  baseUrl?: string;
  defaultModel?: string;
  /** 界面上的模型候选。云端 /v1/models 各家返回不一致，配置更可靠。 */
  models?: string[];
  keyStore: { get(id: string): string | null; has(id: string): boolean };
  pricing?: Record<string, PriceRule>;
  maxConcurrency?: number;
  timeoutMs?: number;
  /** 429 / 5xx / 网络错误的最大重试次数，不含首次。 */
  maxRetries?: number;
  retryBaseMs?: number;
  /** Token / 费用闸门。累计达到上限后不再发请求，避免一次误操作烧完预算。 */
  budget?: { maxTokens?: number; maxCost?: number; currency?: string };
  /**
   * 额外的固定请求头。有些网关（OpenCode Go）要求客户端自报 User-Agent 和
   * 稳定的会话标识；不能放鉴权头里，也不该让每个调用点自己拼。
   */
  extraHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  id: 'openai',
  label: 'OpenAI 兼容 API',
  baseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o-mini',
  models: ['gpt-4o-mini'],
  maxConcurrency: 4,
  timeoutMs: 120_000,
  maxRetries: 2,
  retryBaseMs: 400
} as const;

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string }; delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** OpenAI: 命中缓存的提示词 token。 */
    prompt_tokens_details?: { cached_tokens?: number };
    /** DeepSeek 等网关的扁平写法。 */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    /** 部分网关（含 OpenCode 翻译层）的 Anthropic 风格写法。 */
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  error?: { message?: string; type?: string };
}

export interface UsageRecord {
  at: number;
  modelId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cost: { amount: number; currency: string } | null;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly type = 'cloud' as const;
  readonly id: string;
  readonly label: string;

  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly models: string[];
  private readonly keys: CloudOptions['keyStore'];
  private readonly pricing: Record<string, PriceRule>;
  private readonly maxConcurrency: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly budget: CloudOptions['budget'];
  private readonly extraHeaders: Record<string, string>;
  private readonly inflight = new Map<string, AbortController>();
  private readonly usageLog: UsageRecord[] = [];
  private seq = 0;

  constructor(options: CloudOptions) {
    this.id = options.id ?? DEFAULTS.id;
    this.label = options.label ?? DEFAULTS.label;
    this.baseUrl = (options.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
    this.defaultModel = options.defaultModel ?? DEFAULTS.defaultModel;
    this.models = [...(options.models ?? DEFAULTS.models)];
    this.keys = options.keyStore;
    this.pricing = options.pricing ?? {};
    this.maxConcurrency = options.maxConcurrency ?? DEFAULTS.maxConcurrency;
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULTS.retryBaseMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.budget = options.budget;
    this.extraHeaders = { ...(options.extraHeaders ?? {}) };
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      streaming: true,
      cancellation: 'abort',
      modelDiscovery: 'static',
      maxConcurrency: this.maxConcurrency,
      structuredOutput: true,
      toolCalling: true
    };
  }

  async listModels(): Promise<ModelMetadata[]> {
    return this.models.map(id => ({
      id,
      label: id,
      providerId: this.id,
      // 云端接口不返回上下文长度。写 128000 是编的，上层会拿它切上下文。
      contextTokens: null
    }));
  }

  /** 只探活不烧 token：/v1/models 是免费的，不调用 chat completions。 */
  async health(): Promise<ProviderHealth> {
    if (!this.keys.has(this.id)) {
      return { available: false, detail: '还没有配置 API Key', checkedAt: this.now() };
    }
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000)
      });
      if (res.status === 401 || res.status === 403) {
        return { available: false, detail: 'API Key 被拒绝（401/403）', checkedAt: this.now() };
      }
      if (res.status === 429) {
        return { available: false, detail: '云端限流中（429）', checkedAt: this.now() };
      }
      if (!res.ok) {
        return { available: false, detail: `云端返回 ${res.status}`, checkedAt: this.now() };
      }
      return { available: true, detail: `可用，已配置 ${this.models.length} 个模型`, checkedAt: this.now() };
    } catch (error) {
      return {
        available: false,
        detail: `连不上 ${this.baseUrl}：${error instanceof Error ? error.message : String(error)}`,
        checkedAt: this.now()
      };
    }
  }

  async generate(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const model = request.modelId ?? this.defaultModel;
    this.assertBudget();
    const started = this.now();
    const body = this.body(request.question, model, false, request.context, request.system);

    const data = await this.withRetry(body, signal) as ChatCompletion;
    const text = data.choices?.[0]?.message?.content ?? '';
    const usage = this.usageOf(
      data.usage?.prompt_tokens,
      data.usage?.completion_tokens,
      model,
      this.cacheOf(data.usage)
    );
    this.record(usage, model);
    return { text, providerId: this.id, modelId: model, usage, latencyMs: this.now() - started };
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncGenerator<string> {
    this.assertBudget();
    const model = request.modelId ?? this.defaultModel;
    const controller = this.fork(signal, request.timeoutMs ?? this.timeoutMs);
    const requestId = request.requestId ?? this.newRequestId();
    this.inflight.set(requestId, controller.controller);

    let lastUsage: ChatCompletion['usage'];
    try {
      // 重试只能发生在第一个字之前。拿到响应头之后就一路读到底，
      // 中途失败不会重新发一次请求把两段回答拼在一起。
      const res = await this.withRetryResponse(this.body(request.question, model, true, request.context, request.system), controller.controller.signal);
      for await (const chunk of this.readSse(res)) {
        if (chunk.usage) lastUsage = chunk.usage;
        const piece = chunk.choices?.[0]?.delta?.content;
        if (piece) yield piece;
      }
      const usage = this.usageOf(
        lastUsage?.prompt_tokens,
        lastUsage?.completion_tokens,
        model,
        this.cacheOf(lastUsage)
      );
      this.record(usage, model);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.controller.signal.aborted) {
        throw signal?.aborted
          ? new ProviderError('cancelled', '已取消', this.id, error)
          : new ProviderError('timeout', '请求超时', this.id, error);
      }
      throw error;
    } finally {
      controller.detach();
      this.inflight.delete(requestId);
    }
  }

  cancel(requestId: string): void {
    this.inflight.get(requestId)?.abort();
  }

  /** 给 Phase J 的预算视图用。只汇总，不返回任何请求内容或 Key。 */
  usageSummary(): {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cost: Array<{ currency: string; amount: number }>;
    unknownUsageCalls: number;
  } {
    const byCurrency = new Map<string, number>();
    let input = 0;
    let output = 0;
    let unknown = 0;
    for (const record of this.usageLog) {
      if (record.inputTokens === null || record.outputTokens === null) unknown += 1;
      input += record.inputTokens ?? 0;
      output += record.outputTokens ?? 0;
      if (record.cost) {
        byCurrency.set(record.cost.currency, (byCurrency.get(record.cost.currency) ?? 0) + record.cost.amount);
      }
    }
    return {
      calls: this.usageLog.length,
      inputTokens: input,
      outputTokens: output,
      cost: [...byCurrency].map(([currency, amount]) => ({ currency, amount })),
      // 「服务端没给 usage」必须能被看见，否则汇总会把不知道当成 0。
      unknownUsageCalls: unknown
    };
  }

  private record(
    usage: {
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
      cost: { amount: number; currency: string } | null;
    },
    model: string
  ): void {
    this.usageLog.push({ at: this.now(), modelId: model, ...usage });
  }

  /**
   * 请求前的预算闸门。检查的是**已经发生**的累计用量，不去猜这次会花多少：
   * 猜出来的数会让人以为还剩预算，实际早超了。重试不再过这道门，因为一次
   * 请求只算一次调用。
   */
  private assertBudget(): void {
    if (!this.budget) return;
    const summary = this.usageSummary();
    const total = summary.inputTokens + summary.outputTokens;
    if (this.budget.maxTokens !== undefined && total >= this.budget.maxTokens) {
      throw new ProviderError('budget-exceeded', `Token 预算已用尽（累计 ${total}）`, this.id);
    }
    if (this.budget.maxCost !== undefined) {
      const currency = this.budget.currency ?? 'CNY';
      const spent = summary.cost.find(item => item.currency === currency)?.amount ?? 0;
      if (spent >= this.budget.maxCost) {
        throw new ProviderError('budget-exceeded', `费用预算已用尽（累计 ${spent} ${currency}）`, this.id);
      }
    }
  }

  /** 缓存 token：各网关字段名不同，能读到就记，读不到保持 null。 */
  private cacheOf(usage: ChatCompletion['usage']): {
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
  } {
    const read =
      usage?.prompt_tokens_details?.cached_tokens ??
      usage?.prompt_cache_hit_tokens ??
      usage?.cache_read_input_tokens;
    const write = usage?.cache_creation_input_tokens;
    return {
      cacheReadTokens: typeof read === 'number' ? read : null,
      cacheWriteTokens: typeof write === 'number' ? write : null
    };
  }

  /** 单价配置缺失时返回 null，不写 0——「不知道费用」和「免费」是两回事。 */
  private usageOf(
    input: number | undefined,
    output: number | undefined,
    model: string,
    cache: { cacheReadTokens: number | null; cacheWriteTokens: number | null } = {
      cacheReadTokens: null,
      cacheWriteTokens: null
    }
  ) {
    const inputTokens = typeof input === 'number' ? input : null;
    const outputTokens = typeof output === 'number' ? output : null;
    const rule = this.pricing[model];
    let cost: { amount: number; currency: string } | null = null;
    if (rule && inputTokens !== null && outputTokens !== null) {
      cost = {
        amount: (inputTokens * rule.inputPerMillion + outputTokens * rule.outputPerMillion) / 1_000_000,
        currency: rule.currency
      };
    }
    return { inputTokens, outputTokens, ...cache, cost };
  }

  private body(question: string, model: string, stream: boolean, context?: string[], system?: string[]) {
    return JSON.stringify({
      model,
      messages: this.messages(question, context, system),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {})
    });
  }

  /** 同 ollama.ts：上下文只走结构化 messages，不改用户问题，不加引导句。 */
  private messages(question: string, context?: string[], system?: string[]): Array<{ role: string; content: string }> {
    const first = [{ role: 'user', content: question }];
    const prefix = (system ?? []).filter(Boolean).map(text => ({ role: 'system', content: text }));
    const turns = (context ?? []).filter(Boolean);
    if (!turns.length && !prefix.length) return first;
    if (!turns.length) return [...prefix, ...first];
    return [
      ...prefix,
      ...first,
      ...turns.map(text => ({ role: 'assistant', content: text })),
      { role: 'user', content: question }
    ];
  }

  private headers(): Record<string, string> {
    const key = this.keys.get(this.id);
    if (!key) throw new ProviderError('auth', `没有配置 ${this.label} 的 API Key`, this.id);
    // 额外头放在后面：网关要求的 User-Agent / 会话标识不能被子类默认值盖掉。
    return { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...this.extraHeaders };
  }

  /** 整次响应结束才算一次尝试：重试不会把两段回答拼在一起。 */
  private async withRetry(body: string, signal?: AbortSignal): Promise<ChatCompletion> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = this.fork(signal, this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body,
          signal: controller.controller.signal
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const error = this.httpError(res.status, text);
          if (this.retryable(res.status) && attempt < this.maxRetries) {
            lastError = error;
            await this.backoff(attempt, signal);
            continue;
          }
          throw error;
        }
        return (await res.json()) as ChatCompletion;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (this.retryableNetwork(error) && attempt < this.maxRetries) {
          lastError = error;
          await this.backoff(attempt, signal);
          continue;
        }
        throw this.mapError(error, signal, controller.controller.signal.aborted);
      } finally {
        controller.detach();
      }
    }
    throw this.mapError(lastError, signal, false);
  }

  /** 流式：只在拿响应头这一阶段重试，一旦开始 yield 就回不来了。 */
  private async withRetryResponse(body: string, signal: AbortSignal): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body,
          signal
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const error = this.httpError(res.status, text);
          if (this.retryable(res.status) && attempt < this.maxRetries) {
            lastError = error;
            await this.backoff(attempt, signal);
            continue;
          }
          throw error;
        }
        return res;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (this.retryableNetwork(error) && attempt < this.maxRetries) {
          lastError = error;
          await this.backoff(attempt, signal);
          continue;
        }
        throw this.mapError(error, undefined, signal.aborted);
      }
    }
    throw this.mapError(lastError, undefined, false);
  }

  private async *readSse(res: Response): AsyncGenerator<ChatCompletion> {
    const body = res.body;
    if (!body) throw new ProviderError('unknown', '云端返回了空响应体', this.id);
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (payload && payload !== '[DONE]') yield JSON.parse(payload) as ChatCompletion;
          }
          index = buffer.indexOf('\n');
        }
      }
      const tail = buffer.trim();
      if (tail.startsWith('data:')) {
        const payload = tail.slice(5).trim();
        if (payload && payload !== '[DONE]') yield JSON.parse(payload) as ChatCompletion;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private retryable(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private retryableNetwork(error: unknown): boolean {
    if (error instanceof ProviderError) return false;
    const message = error instanceof Error ? error.message : String(error);
    return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|timeout/i.test(message);
  }

  private async backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new ProviderError('cancelled', '已取消', this.id);
    await this.sleep(this.retryBaseMs * 2 ** attempt);
    if (signal?.aborted) throw new ProviderError('cancelled', '已取消', this.id);
  }

  private fork(parent: AbortSignal | undefined, timeoutMs: number): {
    controller: AbortController;
    detach: () => void;
  } {
    const controller = new AbortController();
    const cleanups: Array<() => void> = [];
    if (parent) {
      if (parent.aborted) controller.abort();
      else {
        const onAbort = () => controller.abort();
        parent.addEventListener('abort', onAbort, { once: true });
        cleanups.push(() => parent.removeEventListener('abort', onAbort));
      }
    }
    if (timeoutMs > 0) {
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      cleanups.push(() => clearTimeout(timer));
    }
    return { controller, detach: () => cleanups.forEach(fn => fn()) };
  }

  private httpError(status: number, body: string): ProviderError {
    const detail = body.trim().slice(0, 200);
    if (status === 401 || status === 403) {
      return new ProviderError('auth', `API Key 被拒绝（${status}）：${detail}`, this.id);
    }
    if (status === 429) {
      return new ProviderError('busy', `云端限流（429）：${detail}`, this.id);
    }
    if (status === 404 && /model/i.test(detail)) {
      return new ProviderError('model-not-found', `云端没有这个模型：${detail}`, this.id);
    }
    if (status >= 500) {
      return new ProviderError('unavailable', `云端服务错误 ${status}：${detail}`, this.id);
    }
    if (status >= 400) {
      return new ProviderError('bad-request', `云端说请求有问题（${status}）：${detail}`, this.id);
    }
    return new ProviderError('unknown', `云端返回 ${status}`, this.id);
  }

  private mapError(error: unknown, parent: AbortSignal | undefined, aborted: boolean): ProviderError {
    if (error instanceof ProviderError) return error;
    if (aborted) {
      return parent?.aborted
        ? new ProviderError('cancelled', '已取消', this.id, error)
        : new ProviderError('timeout', '请求超时', this.id, error);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/fetch failed|ECONNREFUSED/i.test(message)) {
      return new ProviderError('unavailable', `连不上 ${this.baseUrl}`, this.id, error);
    }
    return new ProviderError('unknown', message, this.id, error);
  }

  private newRequestId(): string {
    this.seq += 1;
    return `${this.id}-${this.seq}`;
  }
}
