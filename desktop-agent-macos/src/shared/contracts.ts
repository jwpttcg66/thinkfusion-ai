import { z } from 'zod';

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
    lastTextPreview: string;
    selectorHits: Record<string, number>;
    chosen: Record<string, string>;
  };
}

/** Width of the pane reserved for the embedded page, in CSS pixels. */
export interface LayoutInfo {
  split: number;
}

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

export interface AgentApi {
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
  getDeepSeekDiagnostics(): Promise<DeepSeekDiagnostics>;
  reloadDeepSeek(): Promise<void>;
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

  // streams
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
  onDeepSeekEvent(callback: (event: DeepSeekEvent) => void): () => void;
  onLayoutChanged(callback: (info: LayoutInfo) => void): () => void;
}

export interface AccessibilitySnapshot {
  available: boolean;
  application: { name: string; bundleId?: string } | null;
  tree: Array<{ role: string; title?: string; value?: string; children?: unknown[] }>;
}
