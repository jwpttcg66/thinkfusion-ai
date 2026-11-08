import type { IntentKind } from './intent';
import type { PageEvidence } from './evidence';
import type { ModelRoute } from './model-route';
import type { DebateMode, EngineeringTaskKind, TaskRouting, WorkspaceMode } from './workspace';

/**
 * 工程证据：一次工程分析里，**真实从磁盘读到过**的文件片段。
 *
 * 和 `Claim.evidence`（网页回答里的原话）是两件事：这里有确定路径、行号、
 * 内容指纹与读取时间，能回答「这条分析到底看没看代码」。刻意不存全文，
 * 只存展示需要的那几行；`sha256` 用来在复盘时确认当时读的是哪一版。
 */
export interface EngineeringEvidence {
  /** 相对授权根目录的路径。 */
  path: string;
  /** 片段起始行（1 起）。 */
  line: number;
  /** 读到的片段，最多几行。 */
  excerpt: string;
  /** 整个文件内容的 sha256，不是片段的。 */
  sha256: string;
  /** 文件 mtime（毫秒）。 */
  mtime: number;
  /** 读取时间（毫秒）。 */
  readAt: number;
  /** 为什么把这一段挑出来：命中了哪个关键词，或来自目录概览。 */
  why: string;
  /**
   * 只有点名文件（问题里写了它的路径或文件名）才有：整个文件多少行。
   * 片段只是几行，但「这个文件总共多少条记录」这类问题要靠它回答。
   */
  totalLines?: number;
  /** 只有点名文件超过单文件上限才有：实际只读了前 bytes 字节 / 文件共 totalBytes 字节。 */
  partial?: { bytes: number; totalBytes: number };
  /**
   * 只有点名文件才有：本机把整个文件读完之后的**结构统计**。
   *
   * 「标签各出现多少次 / 级别各多少条」这类聚合问题，模型对着几百行片段是数不准的
   * （大文件还只喂前 256 KB），所以由本机数好再给它——和 `totalLines` 同一个思路，
   * 只是从「多少行」扩到「标签、属性、级别各多少」。
   */
  structure?: FileStructureStats;
}

/** 点名文件的结构统计。全部是本机数出来的整数，不含任何推测。 */
export interface FileStructureStats {
  /** 真正参与统计的行数（末尾空行不计）。 */
  lines: number;
  /**
   * 标签怎么数的：`line-head` 是「时间戳+级别+logger- [标签]」的行首标签
   * （日志类文件的主流情况，正文里的方括号不算）；`bracket` 是全文所有方括号
   * （文件没有可识别的行首格式时的兜底）。
   */
  tagScope: 'line-head' | 'bracket';
  /** 方括号标签（不是 key=value 的那些，如 `[CarromStream]`），按次数降序，最多 24 种。 */
  tags: TagCount[];
  /** 标签总次数与种类数——精确值，不受上面 24 种截断影响。 */
  tagTotal: number;
  tagDistinct: number;
  /** 方括号属性标签 `[key=value]`，按 key 归并。 */
  attributes: AttributeStat[];
  attributeTotal: number;
  attributeDistinct: number;
  /** 时间戳后面第一个全大写词（日志级别）的分布。 */
  levels: TagCount[];
  /** 文件过大只统计了前缀时，注明覆盖范围。 */
  truncated?: { bytes: number; totalBytes: number };
}

export interface TagCount {
  value: string;
  count: number;
}

export interface AttributeStat {
  key: string;
  count: number;
  /** 这个 key 有多少种不同取值。 */
  distinct: number;
  /** 取值样本，最多 3 个（按次数降序）。 */
  samples: string[];
}

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
  /**
   * V2.1 工作空间。老会话没有这个字段，读的时候按知识空间处理——历史会话
   * 不因为升级就变成工程会话，也不要求用户补选项目。
   */
  workspaceMode?: WorkspaceMode;
  /** 工程空间绑定的项目根目录。只有工程会话才写。 */
  workspaceRoot?: string;
  /** 这一轮的路由结果。存下来是为了「识别结果可见、可追溯」。 */
  routing?: TaskRouting;
  /** 工程分析真的读到过的文件片段。 */
  engineeringEvidence?: EngineeringEvidence[];
  /**
   * V2.1：这一轮的结构关系（符号索引 / 调用点 / 模块依赖 / 变更影响）。
   *
   * 和 `engineeringEvidence` 一起存，而不是每次现算：分析是在提问那一刻基于
   * 当时读到的文件算的，汇总时再算一遍会得到另一份行号。存下来也让「主导人
   * 到底看到了什么」可以事后核对。
   */
  engineeringAnalysis?: string;
  /**
   * V2.1：`extract` 意图里用户点名的那个地址。
   *
   * 存在会话上而不是每次现算，是因为追问时用户不会再说一遍链接，而「这条会话
   * 到底读的是哪一页」必须能回答。
   */
  extractUrl?: string;
  /**
   * 真正抓回来的那一页正文。
   *
   * 只在抓取成功时存在。没有它时界面不该假装做过提取——那会变成「让模型凭
   * 常识讲这个网站」。正文只在主导人汇总时作为材料出现，不进第一手提问。
   */
  pageEvidence?: PageEvidence;
  /**
   * V2.1：这一轮用哪些模型、为什么（Model Router，产品定义第 8 节）。
   *
   * 路由是在提问之前算的，所以它记录的是**决定**，不是事后统计；真的问了谁
   * 仍以 `channels` / `answered` 为准。两者对不上时界面要能看出来。
   */
  modelRoute?: ModelRoute;
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
   * 这段结论，以及「哪些一致、哪里有分歧」这套结构，都是主导人读过全部回答
   * 之后写的。置位时规则版那几段（共识/分歧/缺口/共同提到）已经清空，界面
   * 只该显示主导人这一段。
   *
   * 单独立一个字段，而不是靠 `fusion.leadAgentId` 推：没有融合报告时
   * （`fusion` 为空）照样要能说清这段字是谁写的。
   */
  leadSummary?: boolean;
  /**
   * 主导人读完辩论记录后给的最终意见。
   *
   * 和 `recommendation` 分开存：那是辩论**前**的五段汇总（结论/一致/
   * 分歧/存疑/辩题），这是辩论**后**的判断。以前用最终意见直接覆盖汇总，
   * 结果综合卡里只剩下最后一段话——分歧、答辩过程、辩题都看不见了。
   *
   * 可选：没有辩论的轮次、以及老会话都没有这个字段。
   */
  finalOpinion?: string;
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
  /** V2.1：本次提问属于哪个工作空间。不给 = 知识空间（旧行为）。 */
  workspaceMode?: WorkspaceMode;
  /** V2.1：用户在输入框里手动选的「本次按分析 / 本次按实施」。 */
  taskKindOverride?: EngineeringTaskKind;
}

/**
 * 在已有会话里再问一句。
 *
 * `executionConfig` 是这一次用的研究设置。不传就沿用会话里存的那份；传了就以
 * 这次为准——研究设置是给「下一条提问」用的，而那条提问可能就是追问。
 *
 * 工作空间与项目目录**不在这里传**：一条会话属于哪个空间、绑的是哪个项目，
 * 创建时就定了，追问跟着会话走。允许临时改只会让「这条会话到底读过哪些
 * 文件」变成说不清的事。
 */
export interface FollowupConversationInput {
  conversationId: string;
  text: string;
  executionConfig?: Partial<ConversationExecutionConfig>;
  /** 追问时可以重新指定分析/实施，例如「先分析再修改」的第二阶段。 */
  taskKindOverride?: EngineeringTaskKind;
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
  /**
   * 站点自己说「这条会话装不下更多上下文了」（ChatGPT：「上下文窗口已达上限」）。
   *
   * 不算不可用：输入框还在，换一条会话就能继续。但它是一个要处理的状态——
   * 下一条问题会落到一条新会话里，所以界面不该装作什么都没发生。
   */
  contextFull?: boolean;
  detail?: string;
}

// ---------------------------------------------------------------------------
// 执行模式（2026-11-05 重新定义，见 PHASE-E.md 附记）
// ---------------------------------------------------------------------------

/**
 * 执行模式 = **回答之后的处理流程**，它不决定「谁回答」。
 *
 * 硬规则（2026-11-05 用户裁决）：知识空间里的第一手回答永远来自网页通道，执行
 * 模式不包含回答。**工程空间是例外**（2026-11-08 用户裁决）：「工程模式，不需要
 * 优先问网页，读取本地应该是模型所做的」——那里的第一手回答由本地/云端模型读
 * 工程证据给出，没有可用模型时才退回网页。归属规则（2026-11-06 用户裁决）不变：
 * 执行模式决定**由哪一类成员做后面三步**，一类方式只用一类成员，混合先择一：
 *
 * 1. 汇总——读完全部网页回答，写【结论/一致/分歧/存疑】；
 * 2. 指定辩论——从分歧里点出要辩的议题（没有实质分歧就不辩）；
 * 3. 获取辩论——读懂辩论记录，给出最终意见。
 *
 * `local` 只用本地模型、`web` 只用网页通道、`cloud` 只用远程 API；只有一个
 * 可用成员时由它一个主导（自辩），不再因「不足两位」跳过。详见
 * docs/implementation/DEBATE_LEAD_MODES.md 开头「归属规则」节。
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
  /**
   * 会话内辩论用哪种协作策略（任务书 4.2）。
   *
   * 与上面的 `strategy` 是两件事：那个决定「这一轮怎么调度子任务」，这个决定
   * 「辩手怎么辩」。和 `executionMode` 也相互独立：执行模式回答在哪执行，
   * 策略回答怎么协作，四种执行模式都能配六种策略里的任意一种。
   */
  debateStrategy?: DebateStrategyChoice;
  /**
   * V2.1：辩论开关。
   *
   * - `auto`（老会话缺省）：主导人给出辩题才辩，和现在完全一致；
   * - `off`：这一轮不辩，连辩题都不生成；
   * - `on`：即使主导人没找到分歧，也拿问题本身当辩题辩一次。
   *
   * 任务书要求「用户明确关闭时不强制启动」，而原来辩论是自动触发、
   * 没有任何开关的。字段可选，老数据读不到就按 auto，不需要迁移。
   */
  debateMode?: DebateMode;
  /**
   * P6：追加研究轮数（0 = 单轮，老行为）。
   *
   * 一轮追加 = 把主导人指出的缺口重新拼成一个问题，再问一遍所有网页通道，
   * 然后让主导人更新汇总。它**不是**默认开启的：每多一轮就多一轮网页生成，
   * 且用户看不到那些页面在替谁干活。所以默认 0，上限 3，界面上必须能看见
   * 「这一轮会多问几遍」。
   */
  followUpRounds?: number;
  /**
   * 工程空间的「网页编排」开关（2026-11-08 裁决，覆盖同日更早的第二意见定义）。
   *
   * 工程默认是多 agent 编排：本地 + 云端模型并行读工程证据。网页读不到本机
   * 文件，所以**只有执行模式选「混合」(hybrid) 时**网页才被允许作为编排成员
   * 一起进场；local / web / cloud 三档一个网页都不问。
   *
   * - `auto`（缺省）：混合档下只在判定为决策类问题时把网页编进来；
   * - `always`：混合档下每个工程问题都编网页；
   * - `off`：混合档也不编网页，纯本地/云端模型编排。
   *
   * 非混合档下这三档都不生效——设置项保留是为了不迁移老会话，不是留了
   * 一条「在任何模式下都能问网页」的后门。
   */
  webSecondOpinion?: SecondOpinionMode;
}

/**
 * 工程空间「网页编排」的三档（历史名称沿用 `webSecondOpinion`，老会话不迁移）。
 * 只在 `executionMode === 'hybrid'` 生效，见上面字段注释。
 */
export type SecondOpinionMode = 'auto' | 'always' | 'off';

/** 六种可选策略。旧名字（standard/deep）不接受新配置，只用于读旧记录。 */
export type DebateStrategyChoice =
  | 'truth'
  | 'adversarial'
  | 'expert'
  | 'assumption'
  | 'solution'
  | 'discovery';

/** 追加研究轮数上限。三档之外再多就是拿用户的等待时间换边际收益。 */
export const MAX_FOLLOW_UP_ROUNDS = 3;

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
  const debateStrategies: DebateStrategyChoice[] = [
    'truth', 'adversarial', 'expert', 'assumption', 'solution', 'discovery'
  ];
  if (input?.debateStrategy && debateStrategies.includes(input.debateStrategy)) {
    result.debateStrategy = input.debateStrategy;
  }
  const debateModes: DebateMode[] = ['auto', 'on', 'off'];
  if (input?.debateMode && debateModes.includes(input.debateMode)) {
    result.debateMode = input.debateMode;
  }
  // 追加研究轮数：只接受 0–3 的整数。老会话没有这个字段 → 0（单轮），
  // 与升级前行为完全一致；写成 "2" 这种字符串也收，省得界面多一处转换。
  const rounds = Number(input?.followUpRounds);
  if (Number.isFinite(rounds) && rounds > 0) {
    result.followUpRounds = Math.min(Math.floor(rounds), MAX_FOLLOW_UP_ROUNDS);
  }
  // 网页第二意见：只收三档，非法值按缺省的 auto 处理（不写进结果，读的时候
  // 也按 auto 兜底）。`off` 要能被持久化，所以三个值都要显式记下来。
  const secondOpinions: SecondOpinionMode[] = ['auto', 'always', 'off'];
  if (input?.webSecondOpinion && secondOpinions.includes(input.webSecondOpinion)) {
    result.webSecondOpinion = input.webSecondOpinion;
  }
  return result;
}
