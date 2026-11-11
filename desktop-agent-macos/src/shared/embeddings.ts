/** Embedding 的协议类型：只描述「文本 → 向量」这一层，不含代码索引。 */

export type EmbeddingBackend = 'ollama' | 'openai';

export interface EmbeddingRequest {
  texts: string[];
  backend?: EmbeddingBackend;
  /** openai 后端必填：用哪一家已经配置好的云端服务。 */
  providerId?: string;
  /** 模型名；ollama 不给时自动挑一个已安装的 embedding 模型。 */
  model?: string;
}

export interface EmbeddingResult {
  backend: EmbeddingBackend;
  model: string;
  vectors: number[][];
}

export interface EmbeddingStatus {
  ollama: { available: boolean; models: string[]; picked?: string; detail?: string };
  openai: { configured: boolean; detail: string };
}
