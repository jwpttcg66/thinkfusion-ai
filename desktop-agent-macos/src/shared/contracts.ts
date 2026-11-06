import { z } from 'zod';
import type { PageSource } from './sources';
import type { IntentKind } from './intent';
import type { LearnSelectorsReport } from './selectors';
import type {
  ChannelStatus,
  Conversation,
  ConversationDeleteOutcome,
  ConversationEvent,
  ConversationMessage,
  ExecutionMode,
  SubmitConversationInput
} from './conversation';

/**
 * desktop-agent/v1 wire + IPC contracts.
 *
 * Everything that crosses a trust boundary (DeepSeek page -> main, renderer ->
 * main, main -> runtime) is described here or in schemas.ts. Nothing in this
 * file may depend on Electron so the runtime process can import it.
 */

export const PROTOCOL = 'desktop-agent/v1';

export const TOOL_NAMES = ['fs.list', 'fs.readFile', 'fs.mkdir', 'fs.writeFile'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type PermissionPreset = 'read-only' | 'workspace-write' | 'danger-full-access';

const Id = z.string().min(1).max(80);
const RelativePath = z.string().min(1).max(500);

// ---------------------------------------------------------------------------
// Plan (produced by DeepSeek, never trusted until validated)
// ---------------------------------------------------------------------------

export const StepSchema = z.discriminatedUnion('tool', [
  z.object({ id: Id, tool: z.literal('fs.list'), args: z.object({ path: RelativePath }).strict(), description: z.string().max(500).optional() }).strict(),
  z.object({ id: Id, tool: z.literal('fs.readFile'), args: z.object({ path: RelativePath, maxBytes: z.number().int().min(1).max(262144).optional() }).strict(), description: z.string().max(500).optional() }).strict(),
  z.object({ id: Id, tool: z.literal('fs.mkdir'), args: z.object({ path: RelativePath }).strict(), description: z.string().max(500).optional() }).strict(),
  z.object({ id: Id, tool: z.literal('fs.writeFile'), args: z.object({ path: RelativePath, content: z.string().max(1_000_000) }).strict(), description: z.string().max(500).optional() }).strict()
]);

export const PlanSchema = z
  .object({
    protocol: z.literal(PROTOCOL),
    type: z.literal('plan'),
    taskId: Id,
    roundId: Id,
    planId: Id.optional(),
    title: z.string().min(1).max(120),
    description: z.string().max(2000),
    steps: z.array(StepSchema).min(1).max(30),
    completion: z.object({ condition: z.string().min(1).max(1000) }).strict()
  })
  .strict()
  .refine(plan => new Set(plan.steps.map(step => step.id)).size === plan.steps.length, {
    message: 'step id 必须唯一'
  });

export type AgentPlan = z.infer<typeof PlanSchema>;
export type PlanStep = z.infer<typeof StepSchema>;

export const ClarificationSchema = z
  .object({
    protocol: z.literal(PROTOCOL),
    type: z.literal('clarification_required'),
    taskId: Id,
    roundId: Id,
    questions: z.array(z.string().min(1).max(500)).min(1).max(5)
  })
  .strict();

export const TaskCompleteSchema = z
  .object({
    protocol: z.literal(PROTOCOL),
    type: z.literal('task_complete'),
    taskId: Id,
    roundId: Id,
    summary: z.string().max(2000)
  })
  .strict();

/** Every structured message DeepSeek is allowed to send back. */
export const WireMessageSchema = z.union([PlanSchema, ClarificationSchema, TaskCompleteSchema]);

export type WireMessage = z.infer<typeof WireMessageSchema>;

// ---------------------------------------------------------------------------
// Task / Round / Plan records (local truth, persisted)
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'created'
  | 'planning'
  /**
   * DeepSeek asked a question and nothing can proceed until it is answered.
   *
   * Distinct from `planning` on purpose. While it was folded into `planning`,
   * the task sat in a state that reads as "the app is working" while the app
   * was in fact waiting for the user — the pill said 正在规划, the composer was
   * disabled, and the only way forward was a card further up the page. That
   * looks exactly like a hang.
   */
  | 'awaiting_clarification'
  | 'plan_ready'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'report_pending'
  | 'awaiting_next_round'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RoundStatus =
  | 'sending'
  | 'awaiting_answer'
  | 'answer_ready'
  | 'plan_ready'
  | 'plan_invalid'
  | 'executing'
  | 'report_sent'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentTask {
  taskId: string;
  title: string;
  userPrompt: string;
  status: TaskStatus;
  permissionPreset: PermissionPreset;
  workspaceRoot?: string;
  conversationId?: string;
  currentRoundId?: string;
  currentPlanId?: string;
  createdAt: number;
  updatedAt: number;
  maxRounds: number;
  maxSteps: number;
  timeoutMs: number;
  error?: string;
  summary?: string;
}

export interface AgentRound {
  roundId: string;
  taskId: string;
  roundNumber: number;
  requestId: string;
  inputType: 'user_prompt' | 'execution_report' | 'clarification_answer';
  requestText: string;
  answerText?: string;
  status: RoundStatus;
  /** Questions DeepSeek asked in this round, kept so the answer can be matched to them. */
  pendingQuestions?: string[];
  createdAt: number;
  completedAt?: number;
}

export interface StoredPlan {
  planId: string;
  taskId: string;
  roundId: string;
  plan: AgentPlan;
  contentHash: string;
  approvalStatus: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: number;
}

export interface PlanPreview {
  planId: string;
  taskId: string;
  roundId: string;
  title: string;
  description: string;
  completion: string;
  steps: Array<{ id: string; tool: ToolName; description?: string; args: Record<string, unknown> }>;
}

// ---------------------------------------------------------------------------
// Grant / execution
// ---------------------------------------------------------------------------

export const TaskGrantSchema = z
  .object({
    taskId: Id,
    permissionPreset: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
    approvalPolicy: z.literal('ask'),
    rootDir: z.string().min(1).max(2000),
    allowedTools: z.array(z.enum(TOOL_NAMES)).min(1).max(4),
    expiresAt: z.number().int().positive(),
    maxSteps: z.number().int().min(1).max(30),
    grantVersion: z.number().int().min(1).optional()
  })
  .strict();

export type TaskGrant = z.infer<typeof TaskGrantSchema>;

export interface StepResult {
  stepId: string;
  tool: ToolName;
  status: 'completed' | 'failed' | 'skipped';
  verified: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

export interface ExecutionReport {
  protocol: typeof PROTOCOL;
  type: 'execution_report';
  taskId: string;
  roundId: string;
  planId: string;
  status: 'completed' | 'partial' | 'failed' | 'cancelled';
  results: StepResult[];
  errors: Array<{ stepId?: string; code: string; message: string }>;
  nextAction: 'continue' | 'complete' | 'retry' | 'stop';
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Events (main -> renderer)
// ---------------------------------------------------------------------------

export interface AgentEventBase {
  at: number;
}

export type AgentEvent = AgentEventBase &
  (
    | { type: 'task.updated'; task: AgentTask }
    | { type: 'round.started'; taskId: string; roundId: string; roundNumber: number; inputType: AgentRound['inputType'] }
    | { type: 'round.answer'; taskId: string; roundId: string; text: string }
    | { type: 'plan.ready'; taskId: string; roundId: string; plan: PlanPreview }
    | { type: 'plan.invalid'; taskId: string; roundId: string; error: string }
    | { type: 'clarification.required'; taskId: string; roundId: string; questions: string[] }
    | { type: 'step.started'; taskId: string; stepId: string; tool: string }
    | { type: 'step.completed'; taskId: string; stepId: string; tool: string; result: unknown }
    | { type: 'step.failed'; taskId: string; stepId: string; tool: string; error: string }
    | { type: 'report.ready'; taskId: string; roundId: string; report: ExecutionReport }
    | { type: 'report.sent'; taskId: string; roundId: string }
    | { type: 'task.completed'; taskId: string; summary?: string }
    | { type: 'task.failed'; taskId: string; error: string }
    | { type: 'task.cancelled'; taskId: string }
    /** Emitted on delete, so a list built from events drops the row too. */
    | { type: 'task.deleted'; taskId: string }
    | { type: 'log'; taskId?: string; level: 'info' | 'warn' | 'error'; message: string }
  );

export type DeepSeekEvent =
  | { type: 'status'; status: DeepSeekStatus }
  | { type: 'send.failed'; requestId: string; reason: string };

export interface DeepSeekStatus {
  url: string;
  pageReady: boolean;
  loggedIn: boolean;
  hasInput: boolean;
  hasSendButton: boolean;
  generating: boolean;
  messageCount: number;
  detail?: string;
  diagnostics?: PageDiagnostics;
}

/**
 * What the probe actually saw, in enough detail to debug a selector failure
 * without a debugger.
 *
 * The selectors are guesses about someone else's markup. When they stop
 * matching, the only useful output is "which candidate matched, how many times,
 * and how much text was found" — a bare "页面异常" cannot be acted on.
 */
export interface PageDiagnostics {
  probeVersion: string;
  /** Hit count per selector, so a dead selector is visibly zero. */
  selectorHits: Record<string, number>;
  /** Which selector (or structural fallback) won for each role. */
  chosen: Record<string, string>;
  composerChars: number;
  conversationChars: number;
}

export interface DeepSeekDiagnostics {
  probeVersion: string;
  /**
   * Which channel was read.
   *
   * The panel can diagnose any channel, not just the one in the pane, so the
   * reply has to say which page these numbers came from — otherwise the header
   * can name Gemini while the numbers are ChatGPT's.
   */
  sourceId?: string;
  url: string;
  title: string;
  status: DeepSeekStatus;
  selectors: Record<string, string[]>;
  /**
   * Where the native page view actually is.
   *
   * The page is a `WebContentsView` laid over the window, not an element, so
   * nothing in the app's DOM can report this — which is exactly how it ended up
   * painted on top of the app's own column without anything noticing. These are
   * the numbers the main process passed to `setBounds`, i.e. the truth.
   */
  view: { x: number; y: number; width: number; height: number } | null;
  /** True while a divider drag has the view parked outside the window. */
  dragging: boolean;
  probe: {
    hasInput: boolean;
    inputKind: string;
    hasSendButton: boolean;
    generating: boolean;
    messageCount: number;
    /**
     * Characters sitting in the composer.
     *
     * Load bearing for the verdict, not decoration: Gemini only renders its
     * send button once there is something to send, so "no send button" on an
     * empty composer is the normal state of a perfectly working page.
     */
    composerChars: number;
    lastTextPreview: string;
    selectorHits: Record<string, number>;
    chosen: Record<string, string>;
  };
}

/** Width of the pane reserved for the embedded page, in CSS pixels. */
export interface LayoutInfo {
  split: number;
  /**
   * True while the page pane is folded away.
   *
   * `split` alone cannot say it: while folded the right edge still has to
   * reserve the rail and the stub, so the number is small but not zero, and a
   * renderer that only compared it to zero would draw a page bar over a pane
   * that is not there.
   */
  collapsed: boolean;
}

/**
 * Which embedded pages exist and which one is on screen.
 *
 * The rail on the right edge renders straight from this, so the list of sources
 * is defined once (shared/sources.ts) instead of being duplicated in the UI.
 *
 * `sources` carries disabled ones too. The rail filters them out, and the
 * settings panel needs the whole list — sending two different lists would mean
 * two chances for them to disagree about which sources exist.
 */
export interface SourcesState {
  sources: PageSource[];
  activeId: string;
  /**
   * The source the agent plans through, as it is right now.
   *
   * Not `source.planning`: that flag says which source *ships* as the planner,
   * and the user can switch it off. When they do, planning falls to the next
   * enabled source, and a panel that kept drawing the tag on the shipped one
   * would be pointing at a page the app no longer uses.
   */
  planningId: string | null;
  /** True while the active source's view is still being created or loaded. */
  loading: boolean;
}

/** An edit to one source, from 设置 · 模型. */
export interface SourcePatch {
  /** The address to load. Normalized and allow-list-checked in the main process. */
  url?: string;
  /** Whether the source is part of the app right now. */
  enabled?: boolean;
}

/** A source the user adds in 设置. */
export interface NewSourceInput {
  label: string;
  url: string;
}

/**
 * The name on the row at the bottom of the sidebar.
 *
 * There is no account system and this does not pretend to be one: it is a name
 * the person chose, defaulting to 本机用户, so the bottom of the sidebar has
 * something to say other than "本地工作区". Everything stays on this machine,
 * which is the honest description of what the app actually is.
 *
 * Note what is *not* here: nothing read from the operating system about its
 * owner. See `shared/identity.ts` for why that matters.
 */
export interface Identity {
  name: string;
  /** One character for the avatar square. */
  initial: string;
  /** Platform description — "这台 Mac", not the machine's name. */
  device: string;
}

/**
 * Whether a page has been pulled out into its own window.
 *
 * The main window cannot see a native view, so "the pane looks empty" and "the
 * page is in another window" are the same pixels. This is the fact that tells
 * the two apart, and it is what flips the button between 放大 and 吸附回来.
 */
export interface PageState {
  detachedId: string | null;
  /**
   * True while the pane is folded shut.
   *
   * Separate from `detachedId` on purpose: a folded page is still *here* — the
   * same view, the same viewport, still askable — it is simply not painted. A
   * detached page is somewhere else. Folding one does not detach it, and
   * unfolding must not reload anything.
   */
  collapsed: boolean;
}

/** Where one native page view currently sits, in window coordinates. */
export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Every created view's position, keyed by source id.
 *
 * These views are painted above the DOM, so the app cannot observe them by
 * querying elements — the same blindness that once let a page view sit on top
 * of the app column unnoticed. Anything that needs to prove "the buttons are
 * not covered" or "the parked page really is offscreen" has to ask here.
 */
export type ViewBoundsMap = Record<string, ViewRect>;

// ---------------------------------------------------------------------------
// IPC surface
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  prompt: string;
  permissionPreset: PermissionPreset;
  workspaceRoot: string;
}

export interface SubmitPromptInput {
  prompt: string;
  permissionPreset: PermissionPreset;
  workspaceRoot?: string;
}

export interface ApprovePlanInput {
  taskId: string;
  roundId: string;
  planId: string;
  approved: true;
}

/** 新建对话设置页能看到的选项。刻意不含 API Key 明文或密文。 */
export interface DebateCandidateView {
  id: string;
  label: string;
  type: 'web' | 'local' | 'cloud';
  available: boolean;
  detail?: string;
}

export interface CloudProviderView {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  /** 这个服务有哪些模型不能用、为什么。界面照实显示。 */
  note?: string;
  hasKey: boolean;
}

/**
 * 勾选清单里的一个云端成员。
 *
 * `id` 是 `provider:model`，不是裸模型名：DeepSeek 和 OpenCode Zen 都有
 * `deepseek-v4-flash`，用模型名当 id 会出现两个一模一样的复选框，而且勾一
 * 个等于把两家一起勾上——用户没法只问其中一家。
 */
export interface CloudMemberView {
  id: string;
  /** 带服务名前缀，界面上才分得清是哪一家。 */
  label: string;
  /** 服务级的 Key 配了没有。没配的成员运行时会被 health() 挡掉。 */
  hasKey: boolean;
}

export interface ExecutionOptions {
  modes: readonly ExecutionMode[];
  webChannels: Array<{ id: string; label: string }>;
  localModels: string[];
  cloudMembers: CloudMemberView[];
  providers: Array<{ id: string; label: string; type: 'web' | 'local' | 'cloud'; hasKey: boolean }>;
  /** 各云端服务的端点与模型（预设 + 用户覆盖）。 */
  cloudProviders: CloudProviderView[];
  /** 辩论用的真实可用成员；health() 判出来的，不是注册表里的名字。 */
  debateCandidates: DebateCandidateView[];
}

/** Phase F 的子任务执行记录。放在 shared 是为了让 renderer 不依赖 main。 */
/** 辩论的界面契约。结构与 main/debate/types.ts 一致，避免 renderer 依赖 main。 */
/** 裁决的界面契约。字段与 main/judge/types.ts 对齐。 */
export interface JudgeVerdictView {
  verdictId: string;
  debateId: string;
  createdAt: number;
  judgeAgentId: string | null;
  sharedWith?: string;
  backend: 'model' | 'rules';
  conclusion: string | null;
  undetermined: boolean;
  reason: string;
  disagreement: string;
  evidence: Array<{ messageId: string; agentId: string; score: number; why: string; signals: string[] }>;
  argumentQuality: Array<{ agentId: string; score: number; why: string; responded: boolean }>;
  minorities: Array<{ messageId: string; agentId: string; text: string; why: string }>;
  unresolved: Array<{ question: string; why: string; sourceMessageIds: string[] }>;
  confidence: { level: 'low' | 'medium' | 'high'; why: string };
  sourceMessageIds: string[];
  supportCount: Record<string, number>;
  fallbackReason?: string;
}

export type DebateLeadMode = 'local' | 'web' | 'cloud' | 'hybrid';

/**
 * 协作策略（任务书 4.2）。六个可选值 + 两个只用于读旧记录的名字。
 * 行为在 `main/debate/strategies.ts`，渲染层只需要这个联合类型。
 */
export type DebateStrategyId =
  | 'truth'
  | 'adversarial'
  | 'expert'
  | 'assumption'
  | 'solution'
  | 'discovery'
  | 'standard'
  | 'deep';

export interface DebateConfigInput {
  strategy?: DebateStrategyId;
  maxRounds?: number;
  participants?: string[];
  convergenceStop?: boolean;
  /** 连续两轮没进展就停，默认关闭。 */
  earlyStopOnStall?: boolean;
  /**
   * 预算覆盖（任务书 §10）。主进程的 `normalizeDebateConfig` 一直支持，但渲染层
   * 契约漏了这个字段，UI 之外的调用方传了也会被类型挡掉；三项都可选，不传用
   * 默认值（单次 60s / 并发 3 / 不设整场总时限）。Token 与费用没有数据来源，
   * 契约里也不留这两个字段。
   */
  budget?: {
    stageTimeoutMs?: number;
    totalMs?: number;
    maxConcurrency?: number;
  };
  /** 谁主导这一场：本地 / 网页 / 云端 / 混合（混合会先综合决定采用哪一种）。 */
  leadMode?: DebateLeadMode;
  /** 用户指定的主辩；不传由 planLead 按模式挑。 */
  leadAgentId?: string;
}

export interface DebateLeadView {
  mode: DebateLeadMode;
  agentId: string | null;
  label: string;
  reason: string;
  /** 流程由代码编排，不是模型主持。 */
  drivenBy: 'orchestrator';
}

export interface DebatePlanView {
  reason: string;
  warnings: string[];
  excluded: Array<{ id: string; reason: string }>;
  openingSpeakers: string[];
  debaters: string[];
  webOnly: string[];
  participants: string[];
}

export interface DebateCleanupOutcome {
  cleaned: string[];
  reset: string[];
  failed: Array<{ agentId: string; detail: string }>;
  /** 网页成员回答了但页面没给地址，无法按地址删除，如实列出。 */
  noAddress: string[];
}

export interface DebateMessageView {
  messageId: string;
  roundIndex: number;
  agentId: string;
  role: 'proposer' | 'critic' | 'peer' | 'domain_expert' | 'evidence_reviewer';
  kind: 'position' | 'question' | 'rebuttal' | 'revision';
  text: string;
  targetMessageId?: string;
  /** 只有网页成员有；清理网页侧会话靠它。 */
  threadUrl?: string;
  createdAt: number;
}

/** 一条主张。报告里的「关键主张」读这个。 */
export interface DebateClaimView {
  claimId: string;
  messageId: string;
  agentId: string;
  text: string;
  kind: string;
  kindCue?: string;
  assumptions: string[];
  status: string;
}

export interface DebateRoundView {
  index: number;
  messages: DebateMessageView[];
  startedAt: number;
  endedAt?: number;
  converged: boolean;
  failures: Array<{ agentId: string; detail: string }>;
  /** 这一轮切出来的主张。老辩论文件没有这个字段。 */
  claims?: DebateClaimView[];
}

/** 证据（Phase 3）。界面用它画证据链：来源、地址、可核验程度。 */
export interface DebateEvidenceView {
  evidenceId: string;
  claimIds: string[];
  kind: string;
  excerpt: string;
  url?: string;
  finalUrl?: string;
  pageTitle?: string;
  sourceId: string;
  roundIndex: number;
  fetchedAt?: number;
  fingerprint: string;
  originKey: string | null;
  verified: 'page-link' | 'reported' | 'unverified';
  independent: boolean;
  duplicateOf?: string;
  assessment: string;
}

export interface DebateDisputeView {
  disputeId: string;
  roundIndex: number;
  claimIds: [string, string];
  agents: [string, string];
  type: string;
  reason: string;
  status: string;
}

export interface DebateRevisionView {
  revisionId: string;
  agentId: string;
  roundIndex: number;
  decision: string | null;
  source: string;
  reason: string;
  before: string;
  after: string;
}

export interface DebateJudgmentView {
  claimId: string;
  claimText: string;
  agentId: string;
  verdict: string;
  rationale: string;
  dimensions: Array<{ dimension: string; outcome: string; rationale: string }>;
  evidenceIds: string[];
}

/** 质量指标（Phase 5）。比率没有分母时是 null，不是 0。 */
export interface DebateMetricsView {
  rounds: number;
  traceability: { judged: number; traceable: number; rate: number | null };
  invalidRounds: { total: number; invalid: number; rate: number | null };
  minority: { count: number; preserved: number; rate: number | null };
  latency: { totalMs: number; averageRoundMs: number | null };
  calls: { messages: number; failures: number };
}

/**
 * 一场辩论的三维结论，界面读这一份（Phase 3）。
 *
 * 三个维度各自带着 outcome 与理由，**没有总分**：逻辑对而证据不足，和
 * 证据强而推理跳步，是两种不同的判断，压成一个数字就再也分不开。
 * `backend: 'rules'` 说明这是本地规则算的，不是模型裁决。
 */
export interface DebateVerdictView {
  verdict:
    | 'supported'
    | 'partially_supported'
    | 'unsupported'
    | 'contradicted'
    | 'insufficient_evidence';
  conclusion: string | null;
  rationale: string;
  /** 被支持的结论来自少数派发言：它赢在证据，不在人数。 */
  minorityWins: boolean;
  minorityReason?: string;
  unresolved: string[];
  dimensions: Array<{
    dimension: 'logic' | 'evidence' | 'counterexample';
    outcome: string;
    rationale: string;
  }>;
  backend: 'rules';
}

export interface DebateView {
  debateId: string;
  conversationId?: string;
  question: string;
  config: {
    strategy: DebateStrategyId;
    maxRounds: number;
    participants: string[];
    convergenceStop: boolean;
    earlyStopOnStall?: boolean;
    leadMode: DebateLeadMode;
    leadAgentId?: string;
  };
  lead: DebateLeadView;
  plan: DebatePlanView;
  status: 'running' | 'completed' | 'stopped' | 'cancelled';
  rounds: DebateRoundView[];
  minorities: DebateMessageView[];
  createdAt: number;
  updatedAt: number;
  stopReason?: string;
  /**
   * 跑完才有的五档结论。`debate:get` 返回的就是落盘的辩论状态，所以这个
   * 字段直接来自那份文件，不需要第二个接口。
   */
  verdict?: DebateVerdictView;
  /** 每条主张的三维判断（Phase 4 报告用）。 */
  judgments?: DebateJudgmentView[];
  /** 证据链（Phase 4 报告用）。 */
  evidence?: DebateEvidenceView[];
  /** 逐轮争议。 */
  disputes?: DebateDisputeView[];
  /** 修订记录：观点怎么因为证据变了。 */
  revisions?: DebateRevisionView[];
  /** 质量指标（Phase 5）。 */
  metrics?: DebateMetricsView;
}

/** 与当前问题相似的历史辩论。只作提示，不会自动跳过或复用结论。 */
export interface RelatedDebateView {
  debateId: string;
  question: string;
  similarity: number;
  verdict: DebateVerdictView['verdict'] | null;
  conclusion: string | null;
  strategy: DebateStrategyId;
  status: 'running' | 'completed' | 'stopped' | 'cancelled';
  createdAt: number;
  updatedAt: number;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: Array<{ currency: string; amount: number }>;
  unknownUsageCalls: number;
}

export interface CollaborationTaskRecord {
  taskId: string;
  agentId: string;
  label: string;
  stage: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  attempts: number;
  contextCount: number;
  startedAt?: number;
  endedAt?: number;
  latencyMs?: number;
  text?: string;
  error?: string;
}

export interface ProviderHealthInfo {
  available: boolean;
  detail?: string;
  checkedAt: number;
}

export interface AgentApi {
  // conversations — the primary path
  /**
   * Ask something. The router decides whether this becomes a conversation or a
   * workspace task; the caller does not have to know which.
   */
  submitConversation(input: SubmitConversationInput): Promise<Conversation>;
  /**
   * Ask the router what it would do, without doing it.
   *
   * `submitConversation` is not a dry run: a `workspace` verdict immediately
   * sends the planning prompt to a real web page, which then keeps that thread
   * in its history forever. Anything that only wants to inspect routing — the
   * routing preview in the UI, a check script — has to be able to ask without
   * leaving a conversation behind on somebody's account.
   */
  classifyIntent(text: string): Promise<{ intent: IntentKind; reason: string }>;
  followupConversation(input: { conversationId: string; text: string }): Promise<Conversation>;
  getConversations(): Promise<Conversation[]>;
  getConversation(conversationId: string): Promise<Conversation | null>;
  getConversationMessages(conversationId: string): Promise<ConversationMessage[]>;
  cancelConversation(conversationId: string): Promise<void>;
  deleteConversation(conversationId: string): Promise<ConversationDeleteOutcome>;
  /** Per-channel availability, so the UI can say *which* page needs a login. */
  getChannelStatuses(): Promise<ChannelStatus[]>;

  // 执行模式（Phase E）
  getExecutionOptions(): Promise<ExecutionOptions>;
  /** 只写主进程的密文库；返回值里没有 Key。 */
  setApiKey(input: { id: string; key: string }): Promise<{ id: string; configured: boolean }>;
  removeApiKey(id: string): Promise<{ id: string; configured: boolean }>;
  /** 改云端服务的端点或模型列表；不含 API Key。 */
  setCloudConfig(input: { id: string; baseUrl?: string; models?: string[] }): Promise<CloudProviderView>;
  getProviderHealth(): Promise<Record<string, ProviderHealthInfo>>;
  getCollaborationRecords(): Promise<CollaborationTaskRecord[]>;
  getUsage(): Promise<UsageSummary | null>;
  startDebate(input: { question: string; config: DebateConfigInput; conversationId?: string }): Promise<DebateView>;
  getDebate(debateId: string): Promise<DebateView | null>;
  listDebates(): Promise<DebateView[]>;
  /** 历史上辩过相似问题的记录（Phase 5）。只读，不改任何状态。 */
  relatedDebates(input: { question: string; exclude?: string }): Promise<RelatedDebateView[]>;
  stopDebate(debateId: string): Promise<DebateView | null>;
  resumeDebate(debateId: string): Promise<DebateView | null>;
  cleanupDebateWeb(debateId: string): Promise<DebateCleanupOutcome>;
  removeDebate(debateId: string): Promise<{ id: string; removed: boolean }>;
  adjudicate(debateId: string): Promise<JudgeVerdictView>;
  getVerdict(debateId: string): Promise<JudgeVerdictView | null>;

  // task lifecycle
  submitPrompt(input: SubmitPromptInput): Promise<AgentTask>;
  getTask(taskId: string): Promise<AgentTask | null>;
  getTaskHistory(): Promise<AgentTask[]>;
  getTaskEvents(taskId: string): Promise<AgentEvent[]>;
  approvePlan(input: ApprovePlanInput): Promise<void>;
  rejectPlan(input: { taskId: string; planId: string; reason?: string }): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  answerClarification(input: { taskId: string; answer: string }): Promise<void>;
  deleteTask(taskId: string): Promise<void>;

  // environment
  getPermissionPreset(): Promise<PermissionPreset>;
  setPermissionPreset(preset: PermissionPreset): Promise<{ preset: PermissionPreset; approvalPolicy: 'ask' }>;
  chooseDirectory(): Promise<string | null>;
  getPlatform(): Promise<string>;
  getDeepSeekStatus(): Promise<DeepSeekStatus>;
  /**
   * Read one channel's page. Without an id it reads the planning channel —
   * kept so an old caller (and the sources-reload window) still gets an answer.
   */
  getDeepSeekDiagnostics(sourceId?: string): Promise<DeepSeekDiagnostics>;
  getAccessibilitySnapshot(): Promise<AccessibilitySnapshot>;

  // layout
  getLayout(): Promise<LayoutInfo>;
  /**
   * Ask for a page-pane width. The value is clamped in the main process, and
   * the reply is the width that was actually applied — the renderer must use
   * the reply, not its own request, or the two panes drift apart mid-drag.
   * Passing 0 restores the default ratio.
   */
  setSplit(value: number): Promise<LayoutInfo>;
  /**
   * Tell the main process a divider drag started or ended. While dragging, the
   * native page view is parked outside the window so it cannot swallow the
   * pointer moves the drag depends on.
   */
  setPageDragging(active: boolean): Promise<void>;

  // embedded sources
  /** The pages this app embeds, and which one is currently on screen. */
  getSources(): Promise<SourcesState>;
  /**
   * Bring one embedded page to the front. The view is created on first use, so
   * the reply returns before the page has loaded — `loading` says so, and a
   * `sources:changed` event follows when the view is actually up.
   */
  setSource(id: string): Promise<SourcesState>;
  /**
   * Where the native page views are right now.
   *
   * Only the ones that have been created appear. A view missing from the map
   * has never been shown; a view present but with `x` past the window width is
   * parked, which is how a hidden-but-alive page looks.
   */
  getViewBounds(): Promise<ViewBoundsMap>;
  /**
   * Change one source: its address, whether it is on, or both.
   *
   * The URL is normalized and checked against the source's allow-list before
   * anything is written, and the reply is the resulting state — a rejected
   * address must not leave the panel showing something that was never saved.
   */
  saveSource(id: string, patch: SourcePatch): Promise<SourcesState>;
  /** Add a web page as a new source. Its first address is its allow-list. */
  addSource(input: NewSourceInput): Promise<SourcesState>;
  /** Remove a source that was added in 设置. Built-ins are only disabled. */
  removeSource(id: string): Promise<SourcesState>;

  /**
   * 「刷新」: load the page again, in place.
   *
   * Not a navigation back to the home address — the thread that is open stays
   * open, because the point is to recover a page that stopped responding, not to
   * abandon the conversation. The home address is only used as a fallback when
   * the reload itself does not settle, which is the one case where the old
   * document is unreachable anyway.
   */
  reloadPage(id?: string): Promise<SourcesState>;

  /** The display name, for the row at the bottom of the sidebar. */
  getIdentity(): Promise<Identity>;
  /**
   * Rename the row at the bottom of the sidebar.
   *
   * Pass an empty string to go back to the shipped name. The reply is the
   * resulting identity, so the caller never has to guess how the input was
   * normalized (trimmed, upper-cased initial) before showing it.
   */
  setDisplayName(name: string): Promise<Identity>;

  // page pane
  /** Which page, if any, is currently in its own window. */
  getPageState(): Promise<PageState>;
  /**
   * Pull a page out into its own window — the 「放大」 button.
   *
   * This moves the live view, it does not reload the site: a half-written answer
   * keeps writing, and the session is the same one. Closing that window (or
   * pressing 吸附回去) puts it back.
   */
  detachPage(sourceId?: string): Promise<PageState>;
  /** Put the detached page back into the main window. */
  reattachPage(): Promise<PageState>;
  /**
   * Fold the page pane away, or unfold it — the chevron on the page bar.
   *
   * Folding hides the view without shrinking it, so the page keeps the viewport
   * it was given and can still be asked questions while the app column uses the
   * full window. Unfolding restores the width the user had dragged to.
   */
  setPageCollapsed(collapsed: boolean): Promise<PageState>;
  /**
   * Re-read the page and repair selectors that no longer match.
   *
   * Runs in the page, validates the proposal against a real probe, and persists
   * only what measurably fixed something. Safe to press on a healthy page: it
   * reports that nothing needed changing.
   */
  learnSelectors(sourceId?: string): Promise<LearnSelectorsReport>;

  // streams
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
  onDeepSeekEvent(callback: (event: DeepSeekEvent) => void): () => void;
  onLayoutChanged(callback: (info: LayoutInfo) => void): () => void;
  onSourcesChanged(callback: (state: SourcesState) => void): () => void;
  onPageChanged(callback: (state: PageState) => void): () => void;
  onConversationEvent(callback: (event: ConversationEvent) => void): () => void;
}

export interface AccessibilitySnapshot {
  available: boolean;
  application: { name: string; bundleId?: string } | null;
  tree: Array<{ role: string; title?: string; value?: string; children?: unknown[] }>;
}
