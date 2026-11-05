import type { IntentKind } from './intent';

/**
 * A conversation is the unit the user actually thinks in: one question, some
 * answers, maybe a follow-up. It is deliberately not a "task" — a task in this
 * codebase means a plan that gets approved and executed, and most conversations
 * never produce one.
 */
export type ConversationStatus =
  | 'thinking'
  | 'collecting'
  | 'comparing'
  | 'synthesizing'
  | 'answered'
  | 'awaiting_user'
  | 'failed'
  | 'cancelled';

export interface Conversation {
  conversationId: string;
  /** First line of the first message, trimmed — the sidebar needs a label. */
  title: string;
  intent: IntentKind;
  /** Why the router chose that intent. Kept so routing can be argued with. */
  intentReason: string;
  status: ConversationStatus;
  /**
   * Channels that were asked in this conversation, in the order they were asked.
   *
   * Asked, not answered. A channel is listed here from the moment the question
   * is handed to it, so the strip above the pane can show a page being waited
   * on. That is also why this list is *not* the delete list: a channel that
   * timed out never created anything on its site, and warning that its copy has
   * to be removed by hand would send the user looking for a row that does not
   * exist.
   */
  channels: string[];
  /**
   * Channels that actually produced an answer in this conversation.
   *
   * The difference from `channels` is the whole point: `answered` is what may
   * exist on the sites, so it is what a delete has to report on, and it is what
   * a follow-up may continue without resetting the page. Absent on conversations
   * written before this field existed — readers treat a missing list as "we
   * cannot tell", which is the same as `threads` being empty.
   */
  answered?: string[];
  /**
   * Where each channel kept this conversation on its own site.
   *
   * `channelId → page URL` right after that channel answered. Deleting the
   * conversation uses it to find the same row in the site's own sidebar, and
   * the row's address is the only thing that identifies it without guessing
   * from a title — two conversations called 「3+5」 are not distinguishable by
   * text, and deleting the wrong one is not recoverable.
   *
   * Absent for channels that never answered, and empty for conversations that
   * predate this field. They fall back to leaving the page on a new chat.
   */
  threads?: Record<string, string>;
  /** Set only when the intent was `workspace`: the execution task behind it. */
  taskId?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  /**
   * 这一轮用哪些模型来源。老会话没有这个字段，读的时候一律走
   * `normalizeExecutionConfig()`，不要直接访问。
   */
  executionConfig?: ConversationExecutionConfig;
}

export type MessageRole = 'user' | 'channel' | 'synthesis' | 'system';

export interface ConversationMessage {
  messageId: string;
  conversationId: string;
  role: MessageRole;
  /** Present for `channel` messages: which agent said it. */
  channelId?: string;
  /** Present for `synthesis` messages: the structured result, JSON-encoded on disk. */
  synthesis?: Synthesis;
  text: string;
  at: number;
}

// ---------------------------------------------------------------------------
// research/v1 — the structure the app derives. No model is asked to emit this.
// ---------------------------------------------------------------------------

export interface Claim {
  text: string;
  /** Which channel messages said it. Empty `evidence` means it is an assertion. */
  sources: Array<{ channelId: string; messageId: string }>;
  evidence: string[];
}

export interface Dispute {
  /** The thing being disagreed about, in a few words. */
  topic: string;
  positions: Array<{ channelId: string; stance: string }>;
  /** The sentence pair that actually diverges — the part worth reading. */
  pivot: string;
}

export interface Gap {
  topic: string;
  why: string;
}

export interface Synthesis {
  consensus: Claim[];
  disputed: Dispute[];
  unique: Claim[];
  gaps: Gap[];
  /**
   * Subject matter every channel touched on, whether or not any sentence lined
   * up. Lets the UI show that two answers are comparable even when the rules
   * could not pair a single sentence.
   */
  overlap?: string[];
  recommendation: string;
  /**
   * True when the answers could not be segmented into claims and the result is
   * just the answers side by side. The UI must say so rather than present it as
   * a real synthesis.
   */
  degraded?: boolean;
  /**
   * Phase I 的融合报告摘要。可选字段：老数据、规则版综合都没有它，
   * 界面读不到就按原来的卡片显示，不需要数据迁移。
   */
  fusion?: {
    /**
     * 谁算的这份综合：
     * - `local`：本地规则（按句子比对，不联网）
     * - `local-model`：本地模型（Ollama 读完各家回答后归纳）
     * - `remote`：远程大模型 API
     * - `web`：一位网页通道当主导，读完全部回答后给的评判
     * 四种产物必须能分辨，否则「结论是模型说的还是规则说的」说不清。
     */
    backend: 'local' | 'local-model' | 'remote' | 'web';
    finalDecision: string | null;
    undetermined: boolean;
    confidence: { level: 'low' | 'medium' | 'high'; why: string };
    rejected: Array<{ text: string; why: string }>;
    unresolvedQuestions: Array<{ question: string; why: string }>;
    evidenceCount: number;
    relationCount: number;
    debateId?: string;
    /** 这一轮由谁主导；自动选择时 leadAuto 为真、leadReason 说明为什么。 */
    leadAgentId?: string;
    leadReason?: string;
    leadAuto?: boolean;
    /** 主导人指定的辩题；没有实质分歧时为空，这一轮就不辩。 */
    debateTopics?: string[];
    limits: string[];
  };
}

// ---------------------------------------------------------------------------
// Events (main -> renderer)
// ---------------------------------------------------------------------------

export type ChannelPhase = 'resetting' | 'asking' | 'answered' | 'failed' | 'busy';

export type ConversationEvent = { at: number } & (
  | { type: 'conversation.created'; conversation: Conversation }
  | { type: 'conversation.updated'; conversation: Conversation }
  /** Emitted by whoever deletes, so every open list drops the row. */
  | { type: 'conversation.deleted'; conversationId: string }
  | { type: 'message.added'; message: ConversationMessage }
  | { type: 'channel.phase'; conversationId: string; channelId: string; phase: ChannelPhase; detail?: string }
  | { type: 'synthesis.ready'; conversationId: string; synthesis: Synthesis }
  | { type: 'conversation.failed'; conversationId: string; error: string }
);

export interface SubmitConversationInput {
  text: string;
  /** Only used when the router picks `workspace`. */
  workspaceRoot?: string;
  permissionPreset?: string;
  /** 可选。不给就是默认 web 模式，老会话保持原样。 */
  executionConfig?: Partial<ConversationExecutionConfig>;
}

/**
 * What happened to the pages when a conversation was deleted.
 *
 * The local row is always gone by the time this exists. `failed` is the part
 * the user has to be told: those threads may still be sitting in their
 * accounts, and no retry from here can change that.
 */
export interface ConversationDeleteOutcome {
  /** Channels whose web-side thread was removed. */
  cleaned: string[];
  /**
   * Channels whose page was returned to a new chat.
   *
   * Every participating page is reset, whether or not it had a thread to
   * remove: leaving a page sitting on the conversation the user just deleted is
   * how the next question ends up appended to a thread that is supposed to be
   * gone. Kept apart from `cleaned` because "nothing to remove, page moved on"
   * and "removed it" are different facts.
   */
  reset: string[];
  failed: Array<{ channelId: string; label: string; detail: string }>;
}

/**
 * Per-channel availability.
 *
 * Lives in shared/ rather than next to the channel implementations because the
 * renderer needs it to say *which* page is logged out, and shared/ may not
 * depend on main/.
 */
export interface ChannelStatus {
  id: string;
  label: string;
  /** Usable right now: logged in, page ready, not mid-generation. */
  available: boolean;
  loggedIn: boolean;
  pageReady: boolean;
  generating: boolean;
  detail?: string;
}

// ---------------------------------------------------------------------------
// 执行模式（2026-11-05 重新定义，见 PHASE-E.md 附记）
// ---------------------------------------------------------------------------

/**
 * 执行模式 = **回答之后的处理流程**，它不决定「谁回答」。
 *
 * 硬规则（2026-11-05 用户裁决）：第一手回答永远来自网页通道，执行模式不包含
 * 回答。执行模式 = **谁当主导人**，四种主导人各自负责：
 *
 * 1. 汇总——读完全部网页回答，写【结论/一致/分歧/存疑】；
 * 2. 指定辩论——从分歧里点出要辩的议题（没有实质分歧就不辩）；
 * 3. 获取辩论——读懂辩论记录，给出最终意见。
 *
 * - `web`    网页主导：由某个网页回答者当主导（再发一条消息把各家答案递进页面）。
 * - `local`  本地主导：由本机 Ollama 模型当主导（API 调用，不上网）。
 * - `cloud`  云端主导：由配置了 Key 的云端模型当主导。
 * - `hybrid` 混合主导：不预先指定，由本地模型按「问题 + 答案质量」挑一位主导。
 *
 * 本地模型不当"来源"，但它可以当主导人、也可以当辩手。
 */
export type ExecutionMode = 'web' | 'local' | 'cloud' | 'hybrid';
/**
 * 遗留字段：回答必发网页，「仅本地」已经没有成立的前提。类型保留是为了老
 * 会话数据不崩，normalize 一律归一成 `allow-cloud`，界面不再提供这个选项。
 */
export type PrivacyMode = 'local-only' | 'allow-cloud';

/**
 * 执行模式存在每个 Conversation 里，不是全局设置。
 *
 * 全部字段可选是为了老数据：现有会话全是网页产生的，读不到这个字段时要能
 * 原样打开，不能因为升级就变成一个「没配过」的坏对象。
 */
export interface ConversationExecutionConfig {
  executionMode: ExecutionMode;
  primaryProviderId?: string;
  primaryModelId?: string;
  /**
   * 这一轮的主导人。不指定时按执行模式取第一个可用的同类成员：
   * 网页主导取第一个回答了的网页通道，本地/云端主导取第一个可用模型，
   * 混合主导交给本地模型按答案质量挑。
   *
   * 主导人可以做三件事：汇总全部回答、指定辩论议题、读辩论结果给最终意见。
   * 网页通道能当主导——代价是多发一条消息，因为页面读不到别人的回答，只能
   * 由我们把各家答案拼成一条发进去。
   */
  leadAgentId?: string;
  selectedWebChannels?: string[];
  /** 遗留字段；本地模型现在可当主导/辩手，不再是"回答者"。 */
  selectedLocalModels?: string[];
  /** 可当主导/辩手的云端模型清单；空缺表示全部可用云端模型。 */
  selectedCloudModels?: string[];
  fallbackEnabled: boolean;
  privacyMode: PrivacyMode;
  /** 协作策略，Phase F 才用；这里先留位置，避免到时候再改一次持久化结构。 */
  strategy?: 'smart' | 'parallel' | 'all-selected' | 'sequential';
}

/**
 * 老会话 / 缺省配置的唯一入口。
 *
 * `allow-cloud` 是刻意的：回答必发网页，不存在「不出本机」的回答模式。
 */
export const DEFAULT_EXECUTION_CONFIG: ConversationExecutionConfig = {
  executionMode: 'web',
  fallbackEnabled: false,
  privacyMode: 'allow-cloud'
};

/**
 * 把界面传来的配置收成一份合法的。
 *
 * 老值映射：2026-11-05 上午短暂上线过「处理动作」四档（direct/summary/lead/
 * auto），与现在的「主导人」四档同名不同义，读到时按最接近的主导人归位：
 * direct/lead→web、summary→local、auto→hybrid。这只是在**读取**时归位，不回写历史。
 */
export function normalizeExecutionConfig(
  input?: Partial<ConversationExecutionConfig> | null
): ConversationExecutionConfig {
  const legacy: Record<string, ExecutionMode> = {
    direct: 'web',
    lead: 'web',
    summary: 'local',
    auto: 'hybrid'
  };
  const modes: ExecutionMode[] = ['web', 'local', 'cloud', 'hybrid'];
  const requested = input?.executionMode;
  const executionMode =
    requested && modes.includes(requested)
      ? requested
      : requested && legacy[requested]
        ? legacy[requested]
        : DEFAULT_EXECUTION_CONFIG.executionMode;
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
  // 只放有值的字段。全塞 undefined 看着无害，但持久化后的对象和测试里的
  // 期望值对不上，而且「没配置」和「配置成 undefined」变成一个说不清的状态。
  const result: ConversationExecutionConfig = {
    executionMode,
    fallbackEnabled: input?.fallbackEnabled === true,
    // 回答必发网页，local-only 没有成立的前提；统一归一，不让老数据装作还能「不出本机」。
    privacyMode: 'allow-cloud'
  };
  if (typeof input?.primaryProviderId === 'string') result.primaryProviderId = input.primaryProviderId;
  if (typeof input?.primaryModelId === 'string') result.primaryModelId = input.primaryModelId;
  if (typeof input?.leadAgentId === 'string' && input.leadAgentId.trim()) result.leadAgentId = input.leadAgentId.trim();
  const webChannels = strings(input?.selectedWebChannels);
  const localModels = strings(input?.selectedLocalModels);
  const cloudModels = strings(input?.selectedCloudModels);
  if (webChannels) result.selectedWebChannels = webChannels;
  if (localModels) result.selectedLocalModels = localModels;
  if (cloudModels) result.selectedCloudModels = cloudModels;
  if (input?.strategy) result.strategy = input.strategy;
  return result;
}
