/**
 * 统一模型 Provider 的接口。
 *
 * 这是 `docs/proposals/UPGRADE_PROPOSAL.md` 第三章的落地，但有两处按仓库
 * 现状改了写法，理由写在字段旁边：
 *
 * 1. `supportsCancellation: boolean` 换成三态的 `cancellation`。网页通道能
 *    「不等了」，但不能「让它别写了」——第一问答已经在页面里生成。把这两种
 *    能力压成一个 `true`，上层就会以为取消能省下 token 和配额。
 * 2. `available` 从能力描述挪到 `health()`。能力是静态的（这个 Provider 会不会
 *    流式），可用性是动态的（这一秒登没登录）。放一起，每次判断可用性都要
 *    重新拿一遍能力。
 *
 * 还有一个刻意的缺失：接口里没有 `newConversation`。那是网页特有的生命周期
 * （页面里得先点「新对话」），本地和云端每次请求本来就是新的。把它放进统一
 * 接口，等于要求另外两种 Provider 去实现一个对它们没有意义的方法。
 */

export type ProviderType = 'web' | 'local' | 'cloud';

/**
 * 取消的三种语义。
 *
 * - `abort`：真的中止请求，服务端不再计费。
 * - `give-up`：本地不再等，但对方还在生成。网页通道就是这个。
 * - `none`：连放弃都做不到。
 */
export type CancellationMode = 'abort' | 'give-up' | 'none';

/** 模型列表是怎么来的。`static` 是配置里写死的，`unknown` 是问不出来。 */
export type DiscoveryMode = 'listed' | 'static' | 'unknown';

export interface ModelMetadata {
  id: string;
  label: string;
  providerId: string;
  /**
   * 上下文长度。不知道就是 `null`——网页通道不会告诉你，写 8192 是编的，
   * 而调用方会拿这个数字去切上下文。
   */
  contextTokens: number | null;
}

export interface ProviderCapabilities {
  streaming: boolean;
  cancellation: CancellationMode;
  modelDiscovery: DiscoveryMode;
  /** 同时能发几个请求。网页通道是 1：一个页面只有一个输入框。 */
  maxConcurrency: number;
  structuredOutput: boolean;
  toolCalling: boolean;
}

export interface ModelRequest {
  /** 用户的原话。这一层不做任何包装，理由见 MasterAgent 的注释。 */
  question: string;
  modelId?: string;
  timeoutMs?: number;
  /**
   * 是否接着同一个会话问。网页通道靠它决定要不要先点「新对话」；
   * 本地和云端可以忽略。
   */
  continuation?: boolean;
  /**
   * 这次请求的名字，用来调 `cancel(requestId)`。
   *
   * 不传就内部生成一个：调用方通常靠 `AbortSignal` 取消，这个字段是给
   * 「手上只有 ID、拿不到 signal」的场景留的（例如界面上的「停止」）。
   */
  requestId?: string;
}

export interface ModelUsage {
  /**
   * 网页通道拿不到 token 数。`null` 不是「0」，是「不知道」。
   * 费用估算必须能区分这两种，否则界面上会出现「本次花费 ¥0.00」。
   */
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * 本次调用的费用。只有云端 Provider 会填，而且必须有可编辑的单价配置
   * 才算得出来；没有单价时是 `null`，不是 0。
   */
  cost?: { amount: number; currency: string } | null;
}

export interface ModelResponse {
  text: string;
  providerId: string;
  modelId: string;
  usage: ModelUsage;
  latencyMs: number;
}

export interface ProviderHealth {
  available: boolean;
  /** 不可用时给人看的一句话。可用时通常为空。 */
  detail?: string;
  checkedAt: number;
}

export interface ModelProvider {
  readonly id: string;
  readonly label: string;
  readonly type: ProviderType;

  capabilities(): Promise<ProviderCapabilities>;
  listModels(): Promise<ModelMetadata[]>;
  health(): Promise<ProviderHealth>;
  generate(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;

  /**
   * 流式输出。不支持就不实现这个方法——返回一个空的可迭代对象比抛错更难查：
   * 调用方会以为自己在流式接收，实际上一个字都没来。
   */
  stream?(request: ModelRequest, signal?: AbortSignal): AsyncIterable<string>;

  /** 放弃某个请求。语义取决于 `capabilities().cancellation`。 */
  cancel(requestId: string): void;
}

export type ProviderErrorCode =
  | 'unavailable'
  | 'busy'
  | 'timeout'
  | 'cancelled'
  | 'auth'
  | 'bad-request'
  /**
   * 服务在，但找不到这个模型。
   *
   * 和 `bad-request` 分开是因为处理方式完全不同：前者要做的是
   * `ollama pull <tag>` 或去设置里改模型名，后者要改的是请求内容。
   * 混在一起，界面只能提示一句「请求有误」。
   */
  | 'model-not-found'
  | 'unknown';

/**
 * 统一的错误。
 *
 * `cause` 保留原始错误：网页通道的 `PageBusyError` 里有页面阶段，本地通道的
 * `ECONNREFUSED` 里有端口号，这两样在 `code` 里都装不下，丢了就查不出来。
 */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly providerId: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
