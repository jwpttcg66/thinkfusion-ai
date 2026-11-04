import { LocalAdmission } from './local-admission';
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
 * Ollama 本地模型 Provider。
 *
 * 对应项目书第四章。四个端点：
 *
 * | Ollama | 这里 |
 * | --- | --- |
 * | `GET /api/tags` | `listModels` / `health` |
 * | `GET /api/ps` | 驻留检查，切换模型前卸载用 |
 * | `POST /api/show` | `context_length`、工具调用能力 |
 * | `POST /api/chat` | `generate`（`stream:false`）/ `stream`（`stream:true`） |
 *
 * 三处刻意不按项目书写，理由都写在字段旁边：
 *
 * 1. 超时不是一个数字，是三个。9B 首次加载可能要几十秒，用一个总超时，要么把
 *    冷加载误判成失败，要么让真卡死的请求等上两分钟。连接、首字、块间隔分开。
 * 2. `context_length` 不能写死 key。`model_info` 里是 `qwen2.context_length`、
 *    `llama.context_length` 这种「架构名 + 字段」，按后缀匹配，读不到就承认不知道。
 * 3. 模型不存在单独成一个错误码。它要的处理是 `ollama pull`，不是改请求。
 */

export interface OllamaOptions {
  id?: string;
  label?: string;
  baseUrl?: string;
  /** 默认模型。项目书 4.2 写的是 `qwen3.5:9b-q4_K_M`，本机没有就靠配置覆盖。 */
  defaultModel?: string;
  /** 默认上下文。实际会取它和模型真实值中较小的那个。 */
  contextTokens?: number;
  maxOutputTokens?: number;
  keepAlive?: string;
  /** 项目书 4.2：最多驻留 1 个模型。 */
  maxResident?: number;
  maxConcurrency?: number;
  queueTimeoutMs?: number;
  /** 探测和轻量端点（tags / ps / show）的上限。 */
  connectTimeoutMs?: number;
  /** 流式：从发请求到收到第一个块。冷加载要留足。 */
  firstTokenTimeoutMs?: number;
  /** 流式：两个块之间最长间隔。 */
  idleTimeoutMs?: number;
  /** 非流式：整次调用的上限。 */
  generateTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEFAULTS = {
  id: 'ollama',
  label: 'Ollama（本地）',
  baseUrl: 'http://127.0.0.1:11434',
  defaultModel: 'qwen3.5:9b-q4_K_M',
  contextTokens: 8192,
  maxOutputTokens: 4096,
  keepAlive: '5m',
  maxResident: 1,
  maxConcurrency: 1,
  queueTimeoutMs: 30_000,
  connectTimeoutMs: 3_000,
  firstTokenTimeoutMs: 120_000,
  idleTimeoutMs: 60_000,
  generateTimeoutMs: 180_000
} as const;

interface TagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    size?: number;
    details?: { parameter_size?: string; quantization_level?: string };
  }>;
}

interface PsResponse {
  models?: Array<{ name?: string; model?: string; expires_at?: string }>;
}

interface ShowResponse {
  model_info?: Record<string, unknown>;
  template?: string;
  /** 新版 Ollama 直接给能力列表：`completion` / `tools` / `thinking`。 */
  capabilities?: string[];
}

interface ChatChunk {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface ModelFacts {
  contextLength: number | null;
  toolCalling: boolean;
  structuredOutput: boolean;
  /** `/api/show` 原样返回，用来区分「能对话」和「只能做 embedding」。 */
  capabilities: string[];
}

/** 一个请求结束时，究竟是用户喊停还是我们自己等不下去了。 */
interface AbortReason {
  kind: 'timeout' | 'cancelled';
}

export class OllamaProvider implements ModelProvider {
  readonly type = 'local' as const;
  readonly id: string;
  readonly label: string;

  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly contextTokens: number;
  private readonly maxOutputTokens: number;
  private readonly keepAlive: string;
  private readonly maxResident: number;
  private readonly connectTimeoutMs: number;
  private readonly firstTokenTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly generateTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly admission: LocalAdmission;

  /** 正在跑的请求，给 `cancel(requestId)` 用。 */
  private readonly inflight = new Map<string, AbortController>();
  /** 模型事实的缓存：`/api/show` 一次几毫秒，但每次生成前都问一遍很蠢。 */
  private readonly facts = new Map<string, ModelFacts>();
  private listCache?: { at: number; models: ModelMetadata[] };
  private seq = 0;

  constructor(options: OllamaOptions = {}) {
    this.id = options.id ?? DEFAULTS.id;
    this.label = options.label ?? DEFAULTS.label;
    this.baseUrl = (options.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
    this.defaultModel = options.defaultModel ?? DEFAULTS.defaultModel;
    this.contextTokens = options.contextTokens ?? DEFAULTS.contextTokens;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULTS.maxOutputTokens;
    this.keepAlive = options.keepAlive ?? DEFAULTS.keepAlive;
    this.maxResident = options.maxResident ?? DEFAULTS.maxResident;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
    this.firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? DEFAULTS.firstTokenTimeoutMs;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs;
    this.generateTimeoutMs = options.generateTimeoutMs ?? DEFAULTS.generateTimeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.admission = new LocalAdmission(
      this.id,
      options.maxConcurrency ?? DEFAULTS.maxConcurrency,
      options.queueTimeoutMs ?? DEFAULTS.queueTimeoutMs
    );
  }

  /** 排队情况，给界面显示「正在等本地模型」。 */
  queue(): { running: number; queued: number } {
    return this.admission.stats();
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      streaming: true,
      /**
       * 2026-11-04 实测（qwen2.5:7b，本机）：abort 一个正在流式的请求之后，
       * `/api/ps` 里该模型的 `expires_at` 停在请求结束那一刻不再推进，紧接着
       * 发一个新请求 207ms 就返回了。说明断开连接确实让 Ollama 停下了生成，
       * 不是「本地不等、对面还在算」。
       *
       * 这条和网页通道的能力值不同，是对的：网页那条只能 `give-up`。如果哪天
       * 换了 Ollama 版本这里不成立了，得跟着改成 `give-up`——上层靠这个值
       * 决定要不要宣称「省下了算力」。
       */
      cancellation: 'abort',
      modelDiscovery: 'listed',
      maxConcurrency: 1,
      // Ollama 支持 `format` 传 JSON Schema。
      structuredOutput: true,
      toolCalling: true
    };
  }

  async listModels(): Promise<ModelMetadata[]> {
    if (this.listCache && this.now() - this.listCache.at < 30_000) {
      return this.listCache.models;
    }

    const res = await this.simple('/api/tags', { method: 'GET' });
    const data = (await res.json()) as TagsResponse;
    const names = (data.models ?? [])
      .map(item => item.name ?? item.model)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);

    const entries = await Promise.all(
      names.map(async name => ({ name, facts: await this.factsOf(name).catch(() => null) }))
    );

    /**
     * 真实 `/api/show` 里 `nomic-embed-text:latest` 的 capabilities 是
     * `["embedding"]`，而 `/api/tags` 照样把它列进 models。不在这里挡一下，
     * 界面上就会出现一个「选了必然失败」的模型。
     *
     * 只在**明确**是纯 embedding 时排除：老版本 Ollama 没有 capabilities 字段，
     * 那时候我们不知道，就别替用户决定。
     */
    const models = entries
      .filter(({ facts }) => !(facts?.capabilities.includes('embedding') && !facts.capabilities.includes('completion')))
      .map(({ name, facts }) => ({
        id: name,
        label: name,
        providerId: this.id,
        // 读不到就是 null，不拿配置值冒充模型事实。
        contextTokens: facts?.contextLength ?? null
      }) satisfies ModelMetadata);

    this.listCache = { at: this.now(), models };
    return models;
  }

  async health(): Promise<ProviderHealth> {
    try {
      const res = await this.simple('/api/tags', { method: 'GET' });
      const data = (await res.json()) as TagsResponse;
      const count = data.models?.length ?? 0;
      return {
        available: true,
        detail: count > 0 ? `已安装 ${count} 个模型` : '服务在跑，但一个模型都没有装',
        checkedAt: this.now()
      };
    } catch (error) {
      // 探测失败是一条状态，不是一次崩溃。
      return { available: false, detail: this.describeDown(error), checkedAt: this.now() };
    }
  }

  async generate(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const model = request.modelId ?? this.defaultModel;
    const started = this.now();

    return this.admission.run(`生成（${model}）`, async () => {
      await this.evictOthers(model);

      const { controller, detach, reason } = this.fork(signal, request.timeoutMs ?? this.generateTimeoutMs);
      const requestId = request.requestId ?? this.newRequestId();
      this.inflight.set(requestId, controller);

      try {
        const res = await this.call(
          '/api/chat',
          {
            method: 'POST',
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: request.question }],
              stream: false,
              keep_alive: this.keepAlive,
              options: {
                num_ctx: await this.contextFor(model),
                num_predict: this.maxOutputTokens
              }
            })
          },
          controller.signal
        );

        const data = (await res.json()) as ChatChunk;
        return {
          text: data.message?.content ?? '',
          providerId: this.id,
          modelId: model,
          usage: {
            inputTokens: data.prompt_eval_count ?? null,
            outputTokens: data.eval_count ?? null
          },
          latencyMs: this.now() - started
        };
      } catch (error) {
        throw this.mapError(error, reason, controller.signal.aborted, model);
      } finally {
        detach();
        this.inflight.delete(requestId);
      }
    });
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncGenerator<string> {
    const model = request.modelId ?? this.defaultModel;

    await this.admission.acquire(`流式（${model}）`);
    const { controller, detach, reason } = this.fork(signal, 0);
    const requestId = request.requestId ?? this.newRequestId();
    this.inflight.set(requestId, controller);

    try {
      await this.evictOthers(model);

      const res = await this.call(
        '/api/chat',
        {
          method: 'POST',
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: request.question }],
            stream: true,
            keep_alive: this.keepAlive,
            options: {
              num_ctx: await this.contextFor(model),
              num_predict: this.maxOutputTokens
            }
          })
        },
        controller.signal
      );

      for await (const chunk of this.readChunks(res, controller, reason)) {
        const text = chunk.message?.content;
        if (text) yield text;
        if (chunk.done) break;
      }
    } catch (error) {
      throw this.mapError(error, reason, controller.signal.aborted, model);
    } finally {
      detach();
      this.inflight.delete(requestId);
      this.admission.release();
    }
  }

  cancel(requestId: string): void {
    this.inflight.get(requestId)?.abort();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 逐行读 NDJSON。
   *
   * 必须按行切，不能按 chunk 切：一个 JSON 对象可能被拆在两个 chunk 里，也可能
   * 一个 chunk 里塞了三行。按 chunk 解析，长回答会在中间某处突然报 JSON 语法错。
   */
  private async *readChunks(
    res: Response,
    controller: AbortController,
    reason: AbortReason
  ): AsyncGenerator<ChatChunk> {
    const body = res.body;
    if (!body) throw new ProviderError('unknown', 'Ollama 返回了空响应体', this.id);

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let first = true;

    try {
      for (;;) {
        const budget = first ? this.firstTokenTimeoutMs : this.idleTimeoutMs;
        const next = await this.readWithTimeout(reader, budget, first, controller, reason);
        if (next.done) break;
        first = false;

        buffer += decoder.decode(next.value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) yield JSON.parse(line) as ChatChunk;
          index = buffer.indexOf('\n');
        }
      }

      const tail = buffer.trim();
      if (tail) yield JSON.parse(tail) as ChatChunk;
    } finally {
      // 调用方 break 掉也会走到这里，连接必须断，否则本地模型会一直算下去。
      await reader.cancel().catch(() => undefined);
    }
  }

  private async readWithTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    ms: number,
    first: boolean,
    controller: AbortController,
    reason: AbortReason
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // 先定性再断连接：abort 会让读操作立刻 reject，两条 rejection 谁先到
        // 不取决于我们。把原因标成 timeout，无论哪条赢都是同一个答案。
        reason.kind = 'timeout';
        reject(
          new ProviderError(
            'timeout',
            first
              ? `等了 ${ms} 毫秒还没有第一个字。模型可能正在冷加载，或者卡住了`
              : `回答中断超过 ${ms} 毫秒，已放弃`,
            this.id
          )
        );
        // 光抛错不够：不 abort，请求还挂在服务端，模型继续算。
        controller.abort();
      }, ms);
    });

    try {
      return await Promise.race([reader.read(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 一个 controller，两路来源：调用方的 signal，和本地超时。 */
  private fork(parent: AbortSignal | undefined, timeoutMs: number): {
    controller: AbortController;
    detach: () => void;
    reason: AbortReason;
  } {
    const controller = new AbortController();
    const reason: AbortReason = { kind: 'cancelled' };
    const cleanups: Array<() => void> = [];

    if (parent) {
      if (parent.aborted) {
        controller.abort();
      } else {
        const onAbort = () => {
          reason.kind = 'cancelled';
          controller.abort();
        };
        parent.addEventListener('abort', onAbort, { once: true });
        cleanups.push(() => parent.removeEventListener('abort', onAbort));
      }
    }

    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        reason.kind = 'timeout';
        controller.abort();
      }, timeoutMs);
      cleanups.push(() => clearTimeout(timer));
    }

    return { controller, detach: () => cleanups.forEach(fn => fn()), reason };
  }

  /**
   * 只发一次请求，**不碰 signal 的生命周期**。
   *
   * 流式响应在 fetch 返回 Response 之后才刚开始读。如果这里在返回时就拆掉
   * abort 监听，用户只按「停止」而没有 break 迭代，连接会一直挂着到空闲超时
   * ——看起来像取消了，其实模型还在算。所以 controller 由调用方从发起到
   * 读完整个周期持有。
   */
  private async call(
    path: string,
    init: { method: string; body?: string },
    signal: AbortSignal | undefined
  ): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: { 'content-type': 'application/json' },
      body: init.body,
      signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw this.httpError(res.status, text);
    }
    return res;
  }

  /** tags / ps / show 这类一次就结束的端点，自己管一个短超时。 */
  private async simple(path: string, init: { method: string; body?: string }): Promise<Response> {
    const { controller, detach, reason } = this.fork(undefined, this.connectTimeoutMs);
    try {
      return await this.call(path, init, controller.signal);
    } catch (error) {
      throw this.mapError(error, reason, controller.signal.aborted, undefined);
    } finally {
      detach();
    }
  }

  private httpError(status: number, body: string): ProviderError {
    const detail = body.trim().slice(0, 200);

    if (status === 404 && /not found|no such model/i.test(body)) {
      return new ProviderError(
        'model-not-found',
        `Ollama 里没有这个模型（${detail || '404'}）。先 ollama pull 一下，或者去设置里换一个`,
        this.id
      );
    }
    if (status === 401 || status === 403) {
      return new ProviderError('auth', `Ollama 拒绝了请求（${status}）`, this.id);
    }
    if (status === 503) {
      return new ProviderError('unavailable', `Ollama 正忙（503）：${detail}`, this.id);
    }
    if (status >= 400 && status < 500) {
      return new ProviderError('bad-request', `Ollama 说请求有问题（${status}）：${detail}`, this.id);
    }
    return new ProviderError('unknown', `Ollama 返回 ${status}：${detail}`, this.id);
  }

  private mapError(
    error: unknown,
    reason: AbortReason,
    aborted: boolean,
    model: string | undefined
  ): ProviderError {
    if (error instanceof ProviderError) return error;

    if (aborted) {
      // 分清楚是「用户不要了」还是「我们等不下去了」，这两种在界面上是两句话。
      return reason.kind === 'timeout'
        ? new ProviderError('timeout', '请求超时', this.id, error)
        : new ProviderError('cancelled', '已取消', this.id, error);
    }

    const message = error instanceof Error ? error.message : String(error);
    if (/ECONNREFUSED|fetch failed|Failed to fetch|ENOTFOUND/i.test(message)) {
      return new ProviderError(
        'unavailable',
        `连不上 Ollama（${this.baseUrl}）。确认 ollama serve 在运行`,
        this.id,
        error
      );
    }
    if (/JSON/i.test(message)) {
      return new ProviderError('unknown', `Ollama 返回的内容不是预期的格式：${message}`, this.id, error);
    }
    return new ProviderError(
      'unknown',
      model ? `${model}：${message}` : message,
      this.id,
      error
    );
  }

  private describeDown(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ProviderError && error.code === 'timeout') {
      return `Ollama 没有在 ${Math.round(this.connectTimeoutMs / 1000)} 秒内响应（${this.baseUrl}）`;
    }
    if (/ECONNREFUSED|fetch failed|Failed to fetch/i.test(message)) {
      return `连不上 Ollama（${this.baseUrl}）。确认 ollama serve 在运行`;
    }
    return message;
  }

  /**
   * 上下文取「配置值」和「模型真实值」里小的那个。
   *
   * 反过来（按配置写死 8192）在 4B 模型上会让 Ollama 报错。取小值是安全的：
   * 少给一点上下文不会出错，超了会。
   */
  private async contextFor(model: string): Promise<number> {
    const facts = await this.factsOf(model).catch(() => null);
    if (!facts?.contextLength) return this.contextTokens;
    return Math.min(this.contextTokens, facts.contextLength);
  }

  private async factsOf(model: string): Promise<ModelFacts> {
    const cached = this.facts.get(model);
    if (cached) return cached;

    const res = await this.simple(
      '/api/show',
      { method: 'POST', body: JSON.stringify({ model }) }
    );
    const data = (await res.json()) as ShowResponse;

    /**
     * `model_info` 的键是「架构名.字段」：`qwen2.context_length`、
     * `llama.context_length`、`gemma3.context_length`。写死任何一个 key，
     * 换个模型就读不到，然后静默退回默认值——那正是最不该猜的地方。
     */
    let contextLength: number | null = null;
    for (const [key, value] of Object.entries(data.model_info ?? {})) {
      if (!key.endsWith('.context_length')) continue;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        contextLength = value;
        break;
      }
    }

    const facts: ModelFacts = {
      contextLength,
      capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
      toolCalling: Array.isArray(data.capabilities)
        ? data.capabilities.includes('tools')
        : /tools/i.test(data.template ?? ''),
      structuredOutput: true
    };
    this.facts.set(model, facts);
    return facts;
  }

  /**
   * 名额是「一个模型」的，不是「一个请求」的。
   *
   * 切模型前先把别的卸掉（`keep_alive: 0`）。不做这一步，两个 6GB 模型会在
   * 24GB 内存里同时驻留，然后表现为「两个都变慢」，而不是一个明确的错误。
   *
   * 查不到 `/api/ps` 时**什么都不做**：宁可多占一点内存，也不要因为一次探测
   * 失败就把用户正在别处用的模型卸掉。
   */
  private async evictOthers(model: string): Promise<void> {
    if (this.maxResident > 1) return;

    let resident: string[];
    try {
      const res = await this.simple('/api/ps', { method: 'GET' });
      const data = (await res.json()) as PsResponse;
      resident = (data.models ?? [])
        .map(item => item.name ?? item.model)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
    } catch {
      return;
    }

    const target = normalize(model);
    for (const name of resident) {
      if (normalize(name) === target) continue;
      try {
        await this.simple(
          '/api/generate',
          {
            method: 'POST',
            body: JSON.stringify({ model: name, keep_alive: 0, prompt: '' })
          }
        );
      } catch {
        // 卸不掉就算了，最多慢一点，不该因为清理失败就让这次请求失败。
      }
    }
  }

  private newRequestId(): string {
    this.seq += 1;
    return `${this.id}-${this.seq}`;
  }
}

/** `qwen2.5` 和 `qwen2.5:latest` 是同一个模型，比较前统一。 */
function normalize(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}
