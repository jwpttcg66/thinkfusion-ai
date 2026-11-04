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
    backend: 'local' | 'remote';
    finalDecision: string | null;
    undetermined: boolean;
    confidence: { level: 'low' | 'medium' | 'high'; why: string };
    rejected: Array<{ text: string; why: string }>;
    unresolvedQuestions: Array<{ question: string; why: string }>;
    evidenceCount: number;
    relationCount: number;
    debateId?: string;
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
// 执行模式（项目书 6.1）
// ---------------------------------------------------------------------------

export type ExecutionMode = 'web' | 'local' | 'cloud' | 'hybrid';
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
  selectedWebChannels?: string[];
  selectedLocalModels?: string[];
  selectedCloudModels?: string[];
  fallbackEnabled: boolean;
  privacyMode: PrivacyMode;
  /** 协作策略，Phase F 才用；这里先留位置，避免到时候再改一次持久化结构。 */
  strategy?: 'smart' | 'parallel' | 'all-selected' | 'sequential';
}

/**
 * 老会话 / 缺省配置的唯一入口。
 *
 * `web` + `allow-cloud` 是刻意的：老对话本来就是发给网页 AI 的，默认成
 * `local-only` 会让它们一打开就处于违规状态。
 */
export const DEFAULT_EXECUTION_CONFIG: ConversationExecutionConfig = {
  executionMode: 'web',
  fallbackEnabled: false,
  privacyMode: 'allow-cloud'
};

/**
 * 把界面传来的配置收成一份合法的。
 *
 * 关键的硬规则（项目书 6.3 + 2026-11-04 裁决）：`web` 模式的全部内容都发往
 * 网页 Channel，而 `local-only` 禁止向网页和云端发送用户内容，两者不能共存。
 * 我们保留 web 模式，做法是 web 下把 privacyMode 归一成 `allow-cloud`，
 * 而不是禁用 web 模式、也不是悄悄突破隐私约束。
 */
export function normalizeExecutionConfig(
  input?: Partial<ConversationExecutionConfig> | null
): ConversationExecutionConfig {
  // IPC 的输入来自 renderer，不能假设它守规矩。非法值一律退回默认 web，
  // 不让一个拼错的字符串把选人策略带到 undefined 分支里。
  const modes: ExecutionMode[] = ['web', 'local', 'cloud', 'hybrid'];
  const requested = input?.executionMode;
  const executionMode = requested && modes.includes(requested) ? requested : DEFAULT_EXECUTION_CONFIG.executionMode;
  const privacyMode: PrivacyMode =
    executionMode === 'web'
      ? 'allow-cloud'
      : input?.privacyMode === 'local-only'
        ? 'local-only'
        : 'allow-cloud';
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
  // 只放有值的字段。全塞 undefined 看着无害，但持久化后的对象和测试里的
  // 期望值对不上，而且「没配置」和「配置成 undefined」变成一个说不清的状态。
  const result: ConversationExecutionConfig = {
    executionMode,
    fallbackEnabled: input?.fallbackEnabled === true,
    privacyMode
  };
  if (typeof input?.primaryProviderId === 'string') result.primaryProviderId = input.primaryProviderId;
  if (typeof input?.primaryModelId === 'string') result.primaryModelId = input.primaryModelId;
  const webChannels = strings(input?.selectedWebChannels);
  const localModels = strings(input?.selectedLocalModels);
  const cloudModels = strings(input?.selectedCloudModels);
  if (webChannels) result.selectedWebChannels = webChannels;
  if (localModels) result.selectedLocalModels = localModels;
  if (cloudModels) result.selectedCloudModels = cloudModels;
  if (input?.strategy) result.strategy = input.strategy;
  return result;
}
