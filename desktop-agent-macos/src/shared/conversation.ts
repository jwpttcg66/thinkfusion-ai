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
