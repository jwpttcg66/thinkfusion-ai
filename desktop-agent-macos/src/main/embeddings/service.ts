/**
 * Embedding 提供方：只提供「文本 → 向量」这一层能力。
 *
 * 对齐 opencode 的做法：把 embeddings 放在 provider/API 层，**不接进**
 * 代码工具循环，也不建代码向量索引。要不要用它做语义搜索，由上层决定。
 *
 * 支持两种后端：
 * - 本地 Ollama：`POST /api/embed`，不需要 Key，代码不出本机；
 * - OpenAI 兼容：`POST {baseUrl}/embeddings`，Key 由调用方解析后传进来。
 *
 * 没有安装 embedding 模型 / 没有配置 Key 时明确报 EMBEDDING_UNAVAILABLE，
 * 不做「字符长度当向量」之类的假实现。
 */

import type {
  EmbeddingBackend,
  EmbeddingRequest,
  EmbeddingResult,
  EmbeddingStatus
} from '../../shared/embeddings';

export interface EmbeddingDeps {
  ollamaUrl?: string;
  /** 返回云端服务的 baseUrl 与 Key；没有 Key 返回 null。 */
  resolveCloud?: (providerId: string) => { baseUrl: string; key: string } | null;
  /** 是否至少有一家云端服务配了 Key；只用于状态展示。 */
  hasCloudKey?: () => boolean;
  fetchImpl?: typeof fetch;
}

const EMBEDDING_MODEL = /embed|bge|nomic|mxbai|minilm|e5|gte/i;

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

export class EmbeddingService {
  private readonly ollamaUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: EmbeddingDeps = {}) {
    this.ollamaUrl = trimBase(deps.ollamaUrl ?? 'http://127.0.0.1:11434');
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  private async tags(): Promise<string[]> {
    const response = await this.fetchImpl(`${this.ollamaUrl}/api/tags`, { method: 'GET' });
    if (!response.ok) throw new Error(`Ollama 不可用（HTTP ${String(response.status)}）`);
    const body = (await response.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map(item => item.name ?? '').filter(Boolean);
  }

  async status(): Promise<EmbeddingStatus> {
    try {
      const models = await this.tags();
      const picked = models.find(name => EMBEDDING_MODEL.test(name));
      return {
        ollama: {
          available: Boolean(picked),
          models,
          ...(picked ? { picked } : {}),
          ...(picked ? {} : { detail: 'Ollama 在线，但没有 embedding 模型；先 ollama pull nomic-embed-text' })
        },
        openai: {
          configured: this.deps.hasCloudKey?.() ?? false,
          detail: '调用 embedding:embed 时指定 providerId 与 model；Key 从云端配置读取'
        }
      };
    } catch (error) {
      return {
        ollama: { available: false, models: [], detail: error instanceof Error ? error.message : String(error) },
        openai: {
          configured: this.deps.hasCloudKey?.() ?? false,
          detail: '调用 embedding:embed 时指定 providerId 与 model；Key 从云端配置读取'
        }
      };
    }
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const texts = request.texts.map(text => text.trim()).filter(Boolean);
    if (texts.length === 0) throw new Error('没有要 embed 的文本');
    if (texts.length > 64) throw new Error('一次最多 64 条文本');
    const backend = request.backend ?? 'ollama';
    if (backend === 'ollama') return this.embedOllama(texts, request.model);
    return this.embedOpenAI(texts, request);
  }

  private async embedOllama(texts: string[], requested?: string): Promise<EmbeddingResult> {
    const model = requested ?? (await this.status()).ollama.picked;
    if (!model) throw new Error('EMBEDDING_UNAVAILABLE：Ollama 没有 embedding 模型（先 ollama pull nomic-embed-text）');
    const response = await this.fetchImpl(`${this.ollamaUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts })
    });
    if (!response.ok) throw new Error(`Ollama embed 失败（HTTP ${String(response.status)}）`);
    const body = (await response.json()) as { embeddings?: number[][] };
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) {
      throw new Error('Ollama 返回的向量数量与输入不一致');
    }
    return { backend: 'ollama', model, vectors: body.embeddings };
  }

  private async embedOpenAI(texts: string[], request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (!request.providerId) throw new Error('openai 后端需要 providerId');
    if (!request.model) throw new Error('openai 后端需要 model（例如 text-embedding-3-small）');
    const cloud = this.deps.resolveCloud?.(request.providerId);
    if (!cloud) throw new Error(`EMBEDDING_UNAVAILABLE：${request.providerId} 没有配置 Key 或不存在`);
    const response = await this.fetchImpl(`${trimBase(cloud.baseUrl)}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cloud.key}`
      },
      body: JSON.stringify({ model: request.model, input: texts })
    });
    if (!response.ok) throw new Error(`embedding 请求失败（HTTP ${String(response.status)}）`);
    const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const vectors = (body.data ?? []).map(item => item.embedding ?? []);
    if (vectors.length !== texts.length || vectors.some(vector => vector.length === 0)) {
      throw new Error('embedding 返回的向量数量与输入不一致');
    }
    return { backend: 'openai', model: request.model, vectors };
  }
}
