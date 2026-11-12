import { app, BrowserWindow, WebContentsView, session, ipcMain, dialog, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  DeepSeekDiagnostics,
  DeepSeekEvent,
  DeepSeekStatus,
  Identity,
  LayoutInfo,
  PageState,
  PermissionPreset,
  SourcesState,
  ViewBoundsMap
} from '../shared/contracts';
import {
  AnswerStepQuestionSchema,
  ApprovePlanSchema,
  ApproveStepSchema,
  ClarificationAnswerSchema,
  RejectPlanSchema,
  RejectStepSchema,
  SubmitPromptSchema,
  TaskIdSchema
} from '../shared/schemas';
import { AgentStore } from './store';
import { aggregateTotals, errorCodeOf, foldTrace, preview, traceFromMessages, type TraceSource } from '../shared/trace';
import { TraceStore } from './trace/trace-store';
import { TraceRecorder, type StepHandle } from './trace/trace-recorder';
import { recordExecutionReport } from './trace/execution-trace';
import { TaskManager } from './task-manager';
import { callPage, ChatPageDriver, createElectronDriver, DISCOVER_SCRIPT, PROBE_SCRIPT, type PageProbe } from './adapters/browser/page-driver';
import { SubAgentRegistry } from './agents/registry';
import { ProviderSubAgent } from './agents/provider-agent';
import { PageBrowserAdapter } from './adapters/browser/page-adapter';
import { isSameThread, navigateToThread } from './adapters/browser/thread-navigation';
import { profileFor, providerFor, reasoningFor, signedOutFor, signedOutTextFor, signedOutPathsFor, guestUsableFor, contextLimitFor, dismissTextFor, blockedPathsFor, challengeTextFor, userFor } from './adapters/providers';
import { ConversationRunner } from './conversation-runner';
import { OllamaProvider } from './providers/ollama';
import { OpenAICompatibleProvider } from './providers/openai-compatible';
import { WebChannelProvider } from './providers/web-channel';
import { ProviderRegistry } from './providers/registry';
import { ApiKeyStore } from './providers/secrets';
import type { ModelProvider } from './providers/types';
import { ProviderBackedSubAgent } from './execution/provider-sub-agent';
import { ExecutionPool } from './execution/execution-pool';
import { selectParticipants } from './execution/policy';
import { routeModels } from '../shared/model-route';
import type { CollaborationRecord } from './collaboration/runner';
import { DebateStore } from './debate/store';
import { DebateOrchestrator } from './debate/orchestrator';
import { relatedDebates } from './debate/history';
import { debateOriginOf, normalizeDebateConfig, type DebateState } from './debate/types';
import { normalizeLeadMode, planLead, type DebateCandidate, type LeadPlan } from './debate/lead';
import {
  catalogEntryOf,
  CLOUD_PRESETS,
  isUserProvider,
  normalizeModels,
  presetOf,
  PROVIDER_CATALOG,
  resolvePreset,
  userProviderId,
  type CloudPreset
} from './providers/cloud-presets';
import { pruneCloudParticipantsForProvider } from '../shared/cloud-selection';
import {
  buildRoutingQuestion,
  parseRoutingVerdict,
  ROUTING_SYSTEM,
  ROUTING_TIMEOUT_MS,
  CLOUD_ROUTING_TIMEOUT_MS,
  type RoutingVerdict
} from './research/routing-classifier';
import { CloudConfigStore } from './providers/cloud-config';
import { JudgeEngine } from './judge/engine';
import { VerdictStore } from './judge/store';
import type { JudgeVerdict } from './judge/types';
import { classifyIntent } from '../shared/intent';
import {
  DEFAULT_EXECUTION_CONFIG,
  normalizeExecutionConfig,
  type ChannelStatus,
  type Conversation,
  type ConversationEvent,
  type ConversationExecutionConfig,
  type ConversationMessage,
  type DebateSnapshot,
  type ExecutionMode
} from '../shared/conversation';
import { AgentOrchestrator } from './orchestrator';
import { setAgentEventSink, setMainCallHandler, startAgentProcess } from './agent-manager';
import { collapsedSplit, computePageBounds, computeSplit, type PageBounds } from '../shared/layout';
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  restoreWindowPlacement,
  type WindowPlacement
} from '../shared/window-state';
import { writeFileAtomic } from './atomic-write';
import { LspProviderRegistry, TypeScriptProvider } from './lsp/providers';
import {
  createTeamTask,
  mergeTeamRoster,
  taskRevision,
  teamProgress,
  teamWait,
  updateTeamTask
} from './team-board';
import type { TeamTaskEvidence } from '../shared/conversation';
import { buildCodeContext } from './lsp/context';
import { buildImpact } from './lsp/impact';
import { runCodingTeam } from './coding/team';
import { CodeIndexService } from './code-index/service';
import { Neo4jHttpClient } from './code-index/neo4j-http';
import { CgcAdapter, GraphitiAdapter } from './code-index/external';
import { CodeIntelligenceConfigStore } from './code-index/config';
import type { CodeIntelligenceConfig, CodeIntelligencePatch, CodeIntelligenceStatus } from '../shared/code-intelligence';
import { EmbeddingService } from './embeddings/service';
import { loadTypeScript, summarizeAst } from './lsp/ts-ast';
import { SnapshotStore } from './snapshots/store';
import {
  EMPTY_STORED_SOURCES,
  isAllowedSourceUrl,
  makeCustomSource,
  normalizeSourceUrl,
  planningSource,
  resolveSources,
  sourceById,
  sourcesOpenOnLaunch,
  type PageSource,
  type SourceOverride,
  type StoredSources
} from '../shared/sources';
import { SourceStore } from './source-store';
import { ProfileStore } from './profile-store';
import { ExecutionDefaultsStore } from './execution-defaults-store';
import { WorkspaceStore } from './workspace-store';
import { WorkspaceListStore } from './workspace-list-store';
import { runSearchTest, saveSearchSettings, viewSearchSettings } from './search-settings';
import { SEARCH_PROVIDERS, type SearchProvider } from '../shared/search';
import { reviewExecution } from './engineering/review';
import { planReviewQuestion, summarizePlanDebate } from './engineering/plan-review';
import {
  normalizeWorkspaceState,
  routeTask,
  type EngineeringTaskKind as WorkspaceTaskKind,
  type WorkspaceEntry
} from '../shared/workspace';
import { deviceLabel, initialOf, DEFAULT_DISPLAY_NAME } from '../shared/identity';
import { mergeProfile, SelectorStore } from './selector-profile';
import { confirmRepairs, proposeRepairs } from '../shared/selectors';
import { ICON_DOCK_BACK_PATHS, ICON_SAVE_PATHS, ICON_SAVE_WORD_PATHS, iconSvg } from '../shared/icons';
import type {
  DiscoveredSelectors,
  LearnSelectorsReport,
  LearnedRole,
  RepairableRole,
  SelectorProfile,
  SelectorRole
} from '../shared/selectors';
import { PlatformAccessibility } from '../platform/accessibility';
import {
  previewPageDocument,
  type ExportConversationInput,
  type PageDocumentContent,
  type PageExtractPreview,
  type SavePageDocumentInput,
  type SavePageDocumentResult
} from '../shared/export';
import { describeCapabilities, RUNTIME_CAPABILITY_IDS } from '../shared/capabilities';
import { mainCapabilities, type MainCapabilityContext } from './capabilities';
import { attachFiles, referenceFiles } from './attachments';
import { MAX_ATTACHMENTS, type AttachmentText, type ConversationAttachment } from '../shared/attachments';
import { CapabilityStore } from './capability-store';
import { disabledCapabilities, setDisabledCapabilities } from './capability-state';
import { searchSessions } from '../shared/session-search';
import { ScheduleStore, startScheduler } from './schedule-store';
import { computeNextRun, MAX_SCHEDULES, normalizeScheduleInput } from '../shared/schedule';
import {
  buildEngineeringExpertise,
  describeExpertise,
  ExpertiseStore,
  loadExpertise
} from './expertise';

let win: BrowserWindow | null = null;

/**
 * 附件读取的执行入口，由 `registerIpc` 在拿到能力上下文之后接上。
 *
 * `ConversationRunner` 在启动链里构造，那时能力宿主还不存在（它要对话框、
 * 存盘和网页视图）。用一个模块级钩子，比把整份 `capabilityContext` 提到
 * 模块作用域干净，也避免 runner 直接 import 读盘实现。
 */
let attachmentReader: ((paths: readonly string[]) => Promise<AttachmentText[]>) | null = null;

/**
 * 「保存文档」的执行入口，由 `registerIpc` 接上。
 *
 * 独立窗口工具栏通过自己的小 preload 调 `page:save-from-detached`，再走
 * 这条钩子——和主窗口页面栏同一个插件，不另写一份落盘逻辑。
 */
let pageDocumentSaver:
  | ((input: SavePageDocumentInput) => Promise<SavePageDocumentResult | null>)
  | null = null;

/**
 * One native view per embedded page, created on first use.
 *
 * All of them stay alive once created: tearing a view down and rebuilding it
 * throws away the site's in-memory state, and for a chat page that means the
 * reply being written right now.
 */
const views = new Map<string, WebContentsView>();
/**
 * The sources in effect right now: shipped defaults merged with the user's file.
 *
 * Never mutated in place — `applyStored` replaces the array wholesale so a
 * reader can never see a half-applied edit (URL updated but hosts not).
 */
let sources: PageSource[] = resolveSources();
/** Where those edits live. Created in `whenReady`, next to the other stores. */
let sourceStore: SourceStore | null = null;
/** The display name in the sidebar's bottom row. Also created in `whenReady`. */
let profileStore: ProfileStore | null = null;
/** 研究设置的跨会话默认值（主导人、参与的云端模型…）。created in `whenReady`. */
let executionDefaults: ExecutionDefaultsStore | null = null;
/** V2.1：上次使用的空间与项目。created in `whenReady`. */
let workspaceStore: WorkspaceStore | null = null;
/** 多项目工作区清单（侧栏分组）。created in `whenReady`. */
let workspaceList: WorkspaceListStore | null = null;
/** 内置插件的开关。created in `whenReady`, next to the other stores. */
let capabilityStore: CapabilityStore | null = null;
/** 专家 / 技能的开关与文件目录。created in `whenReady`. */
let expertiseStore: ExpertiseStore | null = null;
let expertiseUserDir = '';
let expertiseBuiltinDirs: string[] = [];

/**
 * 每次用都重新读盘：用户改完 md 不用重启应用，下一次提问就是新内容。
 * 开关从自己的 store 读，不写进 .md，也不进 capabilities.json。
 */
function currentExpertise() {
  return {
    state: loadExpertise({ builtinDirs: expertiseBuiltinDirs, userDir: expertiseUserDir }),
    disabled: expertiseStore?.disabledIds() ?? []
  };
}
/**
 * The source on screen. Only this view is visible; the rest are parked.
 *
 * A parked view keeps the viewport it was primed with (see `primeViewports`) —
 * that is what makes a background channel answerable. Hiding a view before it
 * has ever had a size is the one thing that must not happen.
 */
let activeSourceId: string = sources[0]?.id ?? 'deepseek';
/** Last geometry handed to each native view, so `layout()` only pushes changes. */
const applied = new Map<string, PageBounds & { visible: boolean }>();
/** True while the active source's view is being created or first loaded. */
let sourceLoading = false;

const accessibility = new PlatformAccessibility();
let permissionPreset: PermissionPreset = 'workspace-write';
let statusTimer: NodeJS.Timeout | null = null;
/** Width the user dragged the page pane to, or null for the default ratio. */
let preferredSplit: number | null = null;
/**
 * 上次关窗时的窗口位置、大小与分栏，下次启动照它开。
 *
 * 单独一个文件，理由和 sources.json 那些一样：读坏了最多退回默认大小，不该
 * 把会话或通道一起带走。路径在 `whenReady` 里定（`userData` 那时才可靠）。
 */
let windowStateFile = '';
let saveWindowStateTimer: NodeJS.Timeout | null = null;
/**
 * True while the divider is being dragged.
 *
 * The page pane is a native view, and macOS routes mouse events by native hit
 * test — so the instant the pointer crosses that view's left edge the renderer
 * stops hearing about the drag. With the view parked exactly on the boundary,
 * the very first pixel of a rightward drag is swallowed and the gesture dies.
 * So while dragging the view is parked just outside the window instead, and
 * the renderer draws a placeholder where it will land.
 */
let draggingPage = false;

/**
 * True while the page pane is folded shut.
 *
 * Not "split = 0". The split is a share of the window; folding is a visibility
 * switch. Keeping them apart is what lets the folded page keep the real box it
 * was primed with — a view handed a zero-width rectangle loses its viewport, and
 * a page with no viewport cannot answer anything. So a folded page is parked
 * offscreen and hidden, exactly like a page whose source is not active.
 */
let pageCollapsed = false;

/**
 * The page that has been pulled out into its own window, if any.
 *
 * A `WebContentsView` can only have one parent, so "放大" is literally a
 * re-parent: the view leaves the main window's contentView and joins a second
 * window's. The page inside keeps running — same webContents, same session,
 * same scroll position — which is the point. Closing that window puts it back.
 */
let detached: { window: BrowserWindow; sourceId: string } | null = null;

/** Height of the toolbar drawn above the page inside a detached window. */
const DETACHED_BAR_HEIGHT = 40;

/**
 * Learned selectors, per source and per host.
 *
 * Created in `whenReady` because it lives in the user-data directory, and read
 * on every probe: the profile is resolved at call time so a repair takes effect
 * on the next question without rebuilding any adapter.
 */
let selectorStore: SelectorStore | null = null;

/**
 * The built-in selectors for a source.
 *
 * One lookup, no `if`: adding a site is a file in `adapters/providers/` and an
 * entry in its index. A source the app does not know — one the user added — gets
 * the generic profile, which is the one the probe's structural fallbacks were
 * tuned against.
 */
function baseProfile(sourceId: string): SelectorProfile {
  return profileFor(sourceId);
}

function hostOf(view: WebContentsView | undefined): string {
  if (!view) return '';
  try {
    return new URL(view.webContents.getURL()).hostname;
  } catch {
    return '';
  }
}

/**
 * The selector profile for a source right now.
 *
 * Built-ins first, then whatever was learned for this exact host (see
 * `mergeProfile`). A page sitting on a login host gets the built-in profile and
 * nothing else, so a repair done on the chat page cannot leak into the sign-in
 * flow.
 */
function selectorsFor(sourceId: string): SelectorProfile {
  const base = baseProfile(sourceId);
  const view = views.get(sourceId);
  const host = hostOf(view);
  if (!selectorStore || !host) return base;
  return mergeProfile(base, selectorStore.forHost(sourceId, host));
}

let store: AgentStore;
/** 轨迹 append-only 日志；与主 journal 分开，写失败不影响提问。 */
let traceStore: TraceStore;
let tasks: TaskManager;
let orchestrator: AgentOrchestrator;
let conversations: ConversationRunner;

/**
 * One adapter per source, created on first use.
 *
 * Reusing `ChatPageDriver` rather than writing a driver per site is the point
 * of the M1 split: the probe, the send path, the "is this answer mine" logic
 * and the echo stripping are all site-agnostic. Only the allowed hosts and the
 * selector profile differ — and the hosts are passed as a function because the
 * user can change the URL while the adapter is alive.
 */
const adapters = new Map<string, ChatPageDriver>();

function adapterFor(id: string): ChatPageDriver {
  const existing = adapters.get(id);
  if (existing) return existing;
  const created = new ChatPageDriver(
    () => {
      const view = views.get(id);
      return view
        ? createElectronDriver(
            view,
            () => selectorsFor(id),
            () => reasoningFor(id),
            () => signedOutFor(id),
            () => signedOutTextFor(id),
            () => contextLimitFor(id),
            // 站点自己弹的纯提示层（Kimi 排队提示）会吃掉发送点击；填字和
            // 点发送前先关掉，别让一条本来可用的通道白等到超时。
            () => dismissTextFor(id),
            // 人机验证：认出来是为了请用户手动过，不是为了替他去解。
            () => challengeTextFor(id)
          )
        : null;
    },
    {
      // A function, not a Set: `saveSource` can add a host at any time, and a
      // driver that captured yesterday's list would refuse the new address
      // with "当前页面不是允许的…页面" — which reads like a network failure.
      hosts: () => new Set(sourceById(sources, id)?.hosts ?? providerFor(id)?.hosts ?? []),
      // Same reason: a repair in the page status bar has to take effect on the
      // next probe, and the diagnostics panel must report the profile that is
      // actually in use rather than the built-in one.
      selectors: () => selectorsFor(id),
      // What to cut out of an answer bubble before its text counts as the
      // answer. Site knowledge like the selectors, so it is resolved per call.
      reasoning: () => reasoningFor(id),
      // How this page looks when it is signed out. The password-field check is
      // not enough for a site that lets a guest type (Gemini), and the symptom
      // of getting it wrong is an answer that never arrives.
      signedOut: () => signedOutFor(id),
      // The second shape of the same state: a site that redirects to its own
      // sign-in route instead of rendering a guest page (Gemini does both).
      signedOutPaths: () => signedOutPathsFor(id),
      // 站点说「这条会话装不下更多上下文了」时用的那句话。认出来才有出路：
      // 换一条会话再问，而不是把横幅当回答、或者白等到超时。
      contextLimit: () => contextLimitFor(id),
      challengeText: () => challengeTextFor(id),
      // 站点把页面转到会员/排队页时立刻停，别让一条注定发不出去的问题
      // 白等 20 秒确认、再白等 180 秒回答，最后只报一句「发送未确认」。
      blockedPaths: () => blockedPathsFor(id),
      siteLabel: sourceById(sources, id)?.label ?? providerFor(id)?.label ?? id
    }
  );
  adapters.set(id, created);
  return created;
}

/** The adapter the agent plans through. */
function planningAdapter(): ChatPageDriver {
  return adapterFor(planningChannelId());
}

/**
 * 这次规划用哪条通道的页面。
 *
 * 为什么不在提交时才报错：DeepSeek 掉登录之后，界面上 ChatGPT 明明可用，
 * 用户点一下却收到「DeepSeek 未登录」，任务连计划都没生成。那条通道是
 * `planning: true` 的默认值，不是用户这一次的选择——默认值坏掉不该让整个
 * 功能停摆。
 *
 * 顺序仍然「设置里的规划源优先」，所以没坏时行为不变；全都不可用时退回原首选，
 * 让报错保持准确（那时候该说的是「去登录」，不是「换一个」）。
 *
 * 判据必须是「能真的发出问题」，所以除了 `available` 还要看 `loggedIn`：
 * DeepSeek 掉登录时页面本身是活的（`available: true`），只有 `loggedIn` 为假，
 * 而编排器在提交开头就卡这一条——只认 `available` 的话，掉登录的通道会被当成
 * 可用通道挑回来，然后任务在第一步死掉。
 *
 * 判断依据是最近一次探活快照：这个函数必须同步返回，而探活是异步的。
 * 快照为空（刚启动、界面还没轮询）时不做判断，退化为旧行为；提交前
 * `ensureChannelSnapshot()` 会把快照补上，所以这个退化只在非用户路径上出现。
 */
function planningChannelId(): string {
  const preferred = planningSource(sources);
  if (lastChannelStatuses.length === 0) return preferred?.id ?? 'deepseek';

  const blocked = new Set(
    lastChannelStatuses.filter(status => !status.available || !status.loggedIn).map(status => status.id)
  );
  const usable = sources.filter(source => source.enabled && !blocked.has(source.id));
  // 能用的里面，仍然是「规划源优先」，其次按来源栏顺序。
  const pick = usable.find(source => source.planning) ?? usable[0];
  return pick?.id ?? preferred?.id ?? 'deepseek';
}

/**
 * 提交前把通道快照探一次（只在没有快照、或快照超过 15 秒时）。
 *
 * 快照原本只由界面轮询写入，而 `conversation:submit` 可以从任何地方来：
 * 应用刚启动时界面还没轮询，快照为空，`planningChannelId()` 只能退化为
 * 「按设置里的规划源挑」——于是「跳过掉线通道」在真正需要它的那一刻失效。
 * 这一步把「读一份可能过期的快照」补成「读一份刚测过的快照」。
 *
 * 探活失败不抛：探不通的时候该报的是执行链路里的具体原因（未登录 / 找不到
 * 输入框），而不是这里一句笼统的「状态获取失败」。
 */
async function ensureChannelSnapshot(maxAgeMs = 15_000): Promise<void> {
  if (lastChannelStatuses.length > 0 && Date.now() - lastChannelSnapshotAt < maxAgeMs) return;
  try {
    lastChannelStatuses = await registry.statuses();
    lastChannelSnapshotAt = Date.now();
  } catch {
    /* 沿用旧快照 */
  }
}

/**
 * The channel a diagnostics request is about.
 *
 * An unknown or disabled id falls back to the planning channel instead of
 * throwing: the panel is opened from a bar whose id comes from the last
 * `app:sources` reply, and during a sources reload that id can be one edit
 * stale. A diagnostics button that errors out because of an edit elsewhere
 * would be worse than one that reads the wrong page and says so.
 */
function diagnosedSource(id: unknown): PageSource | undefined {
  const wanted = typeof id === 'string' ? sourceById(sources, id) : undefined;
  if (wanted?.enabled) return wanted;
  return planningSource(sources);
}

const registry = new SubAgentRegistry([]);

/**
 * 最近一次通道探活结果。
 *
 * 存在的唯一理由是 `planningChannelId()` 必须同步返回：挑通道发生在一次
 * 提交的开头，而探活要等页面回答。没有快照时按「都可用」处理（旧行为），
 * 有快照时才知道该跳过谁。界面会轮询，提交前也会再探一次（见
 * `ensureChannelSnapshot`），所以快照不会停留在启动那一刻。
 */
let lastChannelStatuses: ChannelStatus[] = [];
/** 上面那份快照是什么时候测的。用来判断该不该在提交前重探。 */
let lastChannelSnapshotAt = 0;

/**
 * Phase E：三种来源共用一份名单。
 *
 * `SubAgentRegistry` 仍是唯一执行名单（决策 3：不重写 Web Channel），
 * `ProviderRegistry` 只回答「有谁、各自什么能力」，不参与调度。
 * `extraAgents` 是把本地/云端 Provider 包成 SubAgent 后的成员，每个模型一个，
 * 这样执行模式里的 selectedLocalModels / selectedCloudModels 才有得选。
 */
const providerRegistry = new ProviderRegistry();
let apiKeys: ApiKeyStore | null = null;
let extraAgents: ProviderBackedSubAgent[] = [];
/**
 * 本地模型的兜底清单。
 *
 * 启动后会用 `ollama list` 的真实结果覆盖它：写死一个名字，用户拉了新模型
 * 也用不上，写死多个又会在没装的机器上造出「不可用成员」。Ollama 没起时保留
 * 这个默认值，health() 会如实说不可用。
 */
let localModels: string[] = ['qwen2.5:7b'];
/**
 * 本地调用的默认模型。
 *
 * 成员清单按安装情况动态生成之后，`localModels[0]` 可能是用户后来拉的小模型
 * （0.5b 之类）。默认值不该因为「谁排在前面」而变，所以固定挑这个；它不在
 * 安装清单里时再用第一个可用的。
 */
const PREFERRED_LOCAL_MODEL = 'qwen2.5:7b';
let collaborationRecords: CollaborationRecord[] = [];
let cloudConfigs: CloudConfigStore | null = null;
/** 当前生效的云端清单（预设 + 用户覆盖）。界面、成员、裁决都读它。 */
let cloudCatalog: CloudPreset[] = [];
let cloudProviders: OpenAICompatibleProvider[] = [];
/**
 * 正在问 `/models` 的服务 id。
 *
 * 模型清单不从预设写死：配好 Key 就向网关要一次真实清单，写进
 * `cloud-config.json`。这份 Set 只防「同一次重建里反复发请求」，请求结束就
 * 删——失败的服务下次重建还能再试。
 */
const cloudModelRefresh = new Set<string>();
/**
 * 本地模型（Ollama）。它有两个身份：
 *
 * - 「本地」模式下唯一的回答者（隐私任务）；
 * - 其他模式下不参与提问，只在**汇总**阶段读各家回答并写结论。
 *
 * 保存一份引用是因为汇总要直接调它，而汇总不走选人名单——它不在 SubAgent
 * 池里被挑中，而是在回答都回来之后才被叫到。
 */
let localProvider: OllamaProvider | null = null;
let debates: DebateOrchestrator | null = null;
/** 语义导航：按工作区根复用 tsserver；只读，不联网。Provider 目前只有 TypeScript。 */
let lspRegistry: LspProviderRegistry | null = null;
/** 本轮改动快照："还原本轮" 用；按 taskId 分目录。 */
let snapshotStore: SnapshotStore | null = null;
/** Embedding 提供方：只提供 provider API，不接代码索引（与 opencode 对齐）。 */
let embeddingService: EmbeddingService | null = null;
/** 本地工程智能：AST + SQLite/FTS5 + 记忆 + Link；CGC/Graphiti 有运行时再替换 Adapter。 */
let codeIndexService: CodeIndexService | null = null;
/** 工程智能运行模式/外部服务配置；密码在 apiKeys。 */
let codeIntelligenceConfigStore: CodeIntelligenceConfigStore | null = null;
let codeIntelligenceConfig: CodeIntelligenceConfig = {
  mode: 'local', cgcEnabled: true, graphitiEnabled: true, neo4jUrl: '', neo4jUser: 'neo4j', passwordConfigured: false
};
let verdicts: VerdictStore | null = null;
const verdictByConversation = new Map<string, JudgeVerdict>();

/**
 * 合并多个云端 Provider 的用量。
 *
 * 分开求和而不是取第一个：用户可能同时配了 DeepSeek 和 OpenCode，只看第一个
 * 会让预算显示偏低一半。`cost` 按币种分组，不同币种不能相加。
 */
function mergedUsage(): {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: Array<{ currency: string; amount: number }>;
  unknownUsageCalls: number;
} | null {
  const summaries = cloudProviders.map(provider => provider.usageSummary()).filter(Boolean);
  if (summaries.length === 0) return null;
  const cost = new Map<string, number>();
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let unknownUsageCalls = 0;
  for (const summary of summaries) {
    calls += summary.calls;
    inputTokens += summary.inputTokens;
    outputTokens += summary.outputTokens;
    unknownUsageCalls += summary.unknownUsageCalls;
    for (const item of summary.cost) cost.set(item.currency, (cost.get(item.currency) ?? 0) + item.amount);
  }
  return {
    calls,
    inputTokens,
    outputTokens,
    cost: [...cost.entries()].map(([currency, amount]) => ({ currency, amount })),
    unknownUsageCalls
  };
}

/**
 * Rebuild the agent pool from the sources that are switched on.
 *
 * Two layers, deliberately: a `ProviderSubAgent` is the participant (identity,
 * session, health) and a `PageBrowserAdapter` is the thing that types into the
 * page. They are built here and nowhere else, so "which AI is speaking" and
 * "which DOM does it speak through" are decided in one place and can be argued
 * about in one place.
 *
 * A disabled source is not an agent: it is a page that is not there, and
 * counting it would make the readiness pill say "1/4" on a fresh install. The
 * registry is mutated rather than replaced because `ConversationRunner` holds
 * this exact instance.
 */
function rebuildChannels() {
  registry.replaceAll(
    sources
      .filter(source => source.enabled)
      .map(source => {
        const adapter = new PageBrowserAdapter({
          id: source.id,
          label: source.label,
          adapter: adapterFor(source.id),
          // Only a site whose profile measured it gets to answer while signed
          // out; everything else keeps the old "login first" gate.
          guestUsable: guestUsableFor(source.id)
        });
        return new ProviderSubAgent(
          {
            id: source.id,
            label: source.label,
            role: `代表 ${source.label} 参与研究，只说自己看到的和能证明的部分`
          },
          adapter
        );
      })
  );
  rebuildProviders();
  // Ollama 里实际装了哪些模型，只有问它才知道；问到了就重建成员清单，
  // 让新拉的模型立刻能当辩手。
  void refreshLocalModels();
}

/**
 * 用 Ollama 的真实模型清单覆盖兜底值。
 *
 * 失败不抛：Ollama 没起是常见状态，兜底清单还在，health() 会逐条说明不可用。
 */
async function refreshLocalModels(): Promise<void> {
  if (!localProvider) return;
  try {
    const models = await localProvider.listModels();
    const names = models.map(model => model.id).filter(name => typeof name === 'string' && name.length > 0);
    if (names.length === 0) return;
    if (names.join('\u0000') === localModels.join('\u0000')) return;
    localModels = names;
    rebuildProviders();
  } catch {
    /* 读不到就用兜底清单，不把启动流程拖垮 */
  }
}

/**
 * 名单随来源开关一起重建。网页 Provider 直接包现有的 SubAgent（只读适配，
 * 不碰页面）；本地与云端每个模型一个可执行成员。
 *
 * `apiKeys` 还没初始化时不注册云端——一个没有 Key 的 Cloud Provider 在
 * health() 里就是不可用，没必要先造出来再解释。
 */
function rebuildProviders() {
  const providers: ModelProvider[] = [];
  for (const agent of registry.list()) providers.push(new WebChannelProvider(agent));
  providers.push(new OllamaProvider({
    defaultModel: localModels.includes(PREFERRED_LOCAL_MODEL)
      ? PREFERRED_LOCAL_MODEL
      : localModels[0] ?? PREFERRED_LOCAL_MODEL
  }));
  localProvider = providers[providers.length - 1] as OllamaProvider;
  cloudCatalog = [];
  cloudProviders = [];
  if (apiKeys) {
    // OpenCode Go 的官方「客户端要求」：自报 User-Agent，并带一个稳定的
    // x-opencode-session。用安装目录指纹当会话标识——同一套安装每次都一样，
    // 不落盘、不含任何个人信息，也不随重启变化。
    const openCodeSession = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 24);
    // 内置三条 + 用户从目录加进来的 + 自定义端点。
    // 「有配置记录」就是「已经加过」：目录项只有在添加/改端点时才写记录，
    // 没加过的不会凭空出现在列表里。自定义服务没有代码里的预设可查，名字
    // 与端点只能从 cloud-config.json 读回来；读不出端点就不注册，免得列表
    // 里出现一个点了必然报错的空壳。
    const entries: CloudPreset[] = [...CLOUD_PRESETS];
    for (const [id, record] of Object.entries(cloudConfigs?.all() ?? {})) {
      const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : '';
      if (!/^https?:\/\//.test(baseUrl)) continue;
      const models = normalizeModels(record.models);
      if (isUserProvider(id)) {
        entries.push({
          id,
          label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : id.replace(/^user:/, ''),
          baseUrl,
          models
        });
        continue;
      }
      // 内置三条已经在里面，不要重复注册；目录里的其它服务（Groq、百炼…）
      // 只有被添加过才会有记录。
      if (CLOUD_PRESETS.some(preset => preset.id === id)) continue;
      const entry = catalogEntryOf(id);
      if (!entry) continue;
      entries.push({
        id,
        label: entry.label,
        baseUrl,
        models: models.length > 0 ? models : [...entry.models],
        note: entry.note
      });
    }
    for (const preset of entries) {
      const resolved = resolvePreset(preset, cloudConfigs?.get(preset.id));
      cloudCatalog.push(resolved);
      const provider = new OpenAICompatibleProvider({
        id: resolved.id,
        label: resolved.label,
        baseUrl: resolved.baseUrl,
        models: resolved.models,
        defaultModel: resolved.models[0],
        keyStore: apiKeys,
        ...(resolved.id === 'opencode-go'
          ? { extraHeaders: { 'user-agent': `ThinkFusion/${app.getVersion() || '0.1.0'}`, 'x-opencode-session': openCodeSession } }
          : {})
      });
      cloudProviders.push(provider);
      providers.push(provider);
    }
  }
  providerRegistry.replaceAll(providers);
  extraAgents = [];
  for (const provider of providers) {
    if (provider.type === 'web') continue;
    // 本地模型的候选来自 Ollama 的配置常量；云端用刚才解析出的清单，
    // 不再有任何一处硬编码的 CLOUD_MODELS。
    const models = provider.type === 'local'
      ? localModels
      : cloudCatalog.find(item => item.id === provider.id)?.models ?? [];
    for (const modelId of models) extraAgents.push(new ProviderBackedSubAgent(provider, modelId));
  }
  // 有 Key、但模型清单还停在预设（或为空）的服务，后台补一次真实清单。
  // 放在重建末尾而不是启动流程里：任何一条改配置的路径都会走到这里。
  refreshMissingCloudModels();
}

/**
 * 读网关的真实模型清单（OpenAI 的 `{ data: [{ id }] }`）。
 *
 * 为什么不让界面 / 预设替用户填模型名：网关今天返回 30 个模型，预设只敢列
 * 其中几个，用户照着预设选就会以为「这家只有这几条」。这里每次免费问一次
 * `/models`（不烧 token），拿到的才是这一问真能调的东西。
 *
 * 认不出结构就明确报错，不回空数组——「这家没有模型」和「我没读懂回执」是
 * 两件事，混成一件会让界面显示一个不可能正确的清单。
 */
async function discoverModelsFrom(baseUrl: string, key: string): Promise<string[]> {
  const openCodeSession = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 24);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: {
        authorization: `Bearer ${key}`,
        // OpenCode Go 的客户端要求：自报 User-Agent，并带稳定的会话标识。
        ...(baseUrl.includes('opencode.ai')
          ? { 'user-agent': `ThinkFusion/${app.getVersion() || '0.1.0'}`, 'x-opencode-session': openCodeSession }
          : {})
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`端点返回 ${response.status}，检查 Key 或端点是否以 /v1 结尾`);
    const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = normalizeModels(
      (Array.isArray(payload.data) ? payload.data : []).map(item => (typeof item?.id === 'string' ? item.id : ''))
    );
    if (models.length === 0) throw new Error('端点没有返回可识别的模型清单（只认 OpenAI 的 /models 格式）');
    return models.slice(0, 200);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('获取模型超时（10 秒）');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把网关的完整清单记进配置。
 *
 * `catalog` 永远是网关报的全部模型；`models` 是用户勾选的那一部分。第一次
 * 读到清单时两者相同；用户之后在「选择模型」里取消勾选，`catalog` 仍然
 * 留着，想加回来还有候选可勾。用户勾过（`modelsPicked`）就不再拿新清单
 * 覆盖他的选择——那是他自己的决定，不是我们需要帮他更新的缓存。
 *
 * @returns 记完之后这一问实际会用的模型清单。
 */
function recordDiscoveredModels(id: string, models: string[]): string[] {
  const record = cloudConfigs?.get(id);
  const keepSelection = record?.modelsPicked === true;
  const selected = keepSelection ? normalizeModels(record?.models) : [];
  cloudConfigs?.set(id, {
    catalog: models,
    modelsFromGateway: true,
    ...(keepSelection && selected.length > 0 ? {} : { models })
  });
  return keepSelection && selected.length > 0 ? selected : models;
}

/** 一家服务可勾选的完整候选：网关报过的，加上已选但网关这次没报的旧模型。 */
function cloudCandidates(id: string): string[] {
  const record = cloudConfigs?.get(id);
  const resolved = cloudCatalog.find(item => item.id === id);
  return normalizeModels([...(record?.catalog ?? []), ...(resolved?.models ?? [])]);
}

/**
 * 已配 Key、清单还不是网关给的，后台补一次真实清单。
 *
 * 判断依据是「这份清单有没有从 `/models` 读过」，不是「列表空不空」：
 * 预设本来就带几条模型名，按长度判断会永远认为已经拿到了，用户也就永远
 * 看不到网关的真实清单。问到了就写进去并重建，下次启动直接用它。失败就保持
 * 原样——断网或 Key 无效时，预设仍是一个能显示的兜底，不会让列表变成空白。
 */
function refreshMissingCloudModels(): void {
  if (!cloudConfigs || !apiKeys) return;
  for (const service of cloudCatalog) {
    if (!apiKeys.has(service.id)) continue;
    if (cloudConfigs.get(service.id)?.modelsFromGateway) continue;
    if (cloudModelRefresh.has(service.id)) continue;
    const key = apiKeys.get(service.id);
    if (!key) continue;
    cloudModelRefresh.add(service.id);
    void discoverModelsFrom(service.baseUrl, key)
      .then(models => {
        if (models.length === 0) return;
        recordDiscoveredModels(service.id, models);
        rebuildProviders();
      })
      // 拿不到清单不是故障：预设兜底还在，界面照实显示「已配置 Key」。
      .catch(() => undefined)
      .finally(() => cloudModelRefresh.delete(service.id));
  }
}

/** `providerId:modelId` —— 模型名里也可能有冒号，所以只在第一个冒号切开。 */
function splitCloudMemberId(id: string): { providerId: string; modelId: string } | null {
  const colon = id.indexOf(':');
  if (colon <= 0 || colon >= id.length - 1) return null;
  return { providerId: id.slice(0, colon), modelId: id.slice(colon + 1) };
}

/**
 * 工程空间的路由判定。
 *
 * 为什么不用网页通道：网页读不到别人的回答，把「这句是分析还是实施」发进去
 * 会在用户账号里留下一条无意义会话，且要走 5-20 秒。所以这里只碰模型。
 *
 * 用哪家模型按执行模式定：
 * - 云端主导：只用云端，优先用户点名的主导人 / 勾选的参与模型，不先烧本地 4 秒；
 * - 本地主导：只用本地；
 * - 混合：本地先试，失败再云端。
 *
 * 任何一步失败（没 Key、超时、回的不是 JSON）都返回 null，由 runner 退回
 * `routeTask()` 的规则结论——判定失败不该让提问卡住。
 */
async function routeEngineeringWithModel(input: {
  text: string;
  attachmentNames: readonly string[];
  attachmentExcerpts?: ReadonlyArray<{ name: string; text: string }>;
  hasProject: boolean;
  executionMode?: ExecutionMode;
  leadAgentId?: string;
  selectedCloudModels?: string[];
}): Promise<RoutingVerdict | null> {
  const question = buildRoutingQuestion(input);
  const request = { question, system: [ROUTING_SYSTEM] };
  const mode = input.executionMode ?? 'hybrid';

  const tryLocal = async (): Promise<RoutingVerdict | null> => {
    if (!localProvider) return null;
    try {
      const answer = await localProvider.generate(request, AbortSignal.timeout(ROUTING_TIMEOUT_MS));
      return parseRoutingVerdict(answer.text);
    } catch {
      return null;
    }
  };

  const tryCloudPair = async (providerId: string, modelId: string): Promise<RoutingVerdict | null> => {
    if (!apiKeys?.has(providerId)) return null;
    const provider = cloudProviders.find(item => item.id === providerId);
    if (!provider) return null;
    try {
      const answer = await provider.generate(
        { ...request, modelId },
        AbortSignal.timeout(CLOUD_ROUTING_TIMEOUT_MS)
      );
      return parseRoutingVerdict(answer.text);
    } catch {
      return null;
    }
  };

  /** 用户点名 / 勾选的云端成员，按顺序试；都没有就退到「每家第一个模型」。 */
  const tryCloud = async (): Promise<RoutingVerdict | null> => {
    const preferred: string[] = [];
    if (input.leadAgentId) preferred.push(input.leadAgentId);
    for (const id of input.selectedCloudModels ?? []) {
      if (!preferred.includes(id)) preferred.push(id);
    }
    for (const id of preferred) {
      const parts = splitCloudMemberId(id);
      if (!parts) continue;
      const verdict = await tryCloudPair(parts.providerId, parts.modelId);
      if (verdict) return verdict;
    }
    for (const provider of cloudProviders) {
      if (!apiKeys?.has(provider.id)) continue;
      const model = cloudCatalog.find(item => item.id === provider.id)?.models[0];
      if (!model) continue;
      const verdict = await tryCloudPair(provider.id, model);
      if (verdict) return verdict;
    }
    return null;
  };

  if (mode === 'cloud') return tryCloud();
  if (mode === 'local') return tryLocal();

  // 混合：本地先试，失败再云端（和文档里「本地优先、云端兜底」一致）。
  return (await tryLocal()) ?? (await tryCloud());
}

/**
 * 辩论候选：逐个问 health()，不用「注册表里有这个名字」冒充可用。
 *
 * Phase G 的 eligible 只看 extraAgents 里有没有这个 id，于是没配 Key 的
 * openai:gpt-4o-mini 也被算成可用成员，界面能发起、实际每轮都失败，
 * 一场双边辩论静默变成单边。这里把真实原因（detail）一并交给界面。
 */
async function debateCandidates(): Promise<DebateCandidate[]> {
  const entries: Array<{ id: string; label: string; type: DebateCandidate['type']; health: () => Promise<{ available: boolean; detail?: string }> }> = [
    ...registry.list().map(agent => ({ id: agent.id, label: agent.label, type: 'web' as const, health: () => agent.health() })),
    ...extraAgents.map(agent => ({ id: agent.id, label: agent.label, type: agent.sourceType, health: () => agent.health() }))
  ];
  return Promise.all(entries.map(async entry => {
    try {
      const status = await entry.health();
      return { id: entry.id, label: entry.label, type: entry.type, available: status.available, detail: status.detail };
    } catch (error) {
      return {
        id: entry.id, label: entry.label, type: entry.type, available: false,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }));
}

/** Single funnel for events: persist for replay, then push to the renderer. */
function emit(event: AgentEvent) {
  try {
    store?.appendEvent(event);
  } catch {
    /* Persisting events must never break the running task. */
  }
  win?.webContents.send('agent:event', event);
}

function emitDeepSeek(event: DeepSeekEvent) {
  win?.webContents.send('deepseek:event', event);
}

function emitConversation(event: ConversationEvent) {
  win?.webContents.send('conversation:event', event);
}

/** 一场辩论在某一刻能读到的东西；实时面板与落盘快照共用同一份。 */
function debateSnapshotOf(state: DebateState): DebateSnapshot {
  return {
    status: state.status,
    ...(state.stopReason ? { stopReason: state.stopReason } : {}),
    rounds: [...state.rounds, ...(state.runningRound ? [state.runningRound] : [])].map(round => ({
      index: round.index,
      phase: round.phase ?? '',
      ...(round.pending && round.pending.length > 0 ? { pending: round.pending } : {}),
      messages: round.messages.map(message => ({
        author: message.agentId,
        kind: message.kind,
        text: message.text.length > 1200 ? `${message.text.slice(0, 1200)}…` : message.text,
        ...(message.reasoning ? { reasoning: message.reasoning } : {})
      }))
    }))
  };
}

/**
 * 「直接辩论」也输出到回答界面。
 *
 * 辩论本来只在「研究设置 → 辩论」弹窗里有时间线，主区域什么都看不到。
 * 现在把它挂到一条会话上：每 1.5 秒把轮次快照推给界面（谁在说、还在等谁），
 * 结束后落成一条带辩论快照的消息——重开这条会话还能读。
 *
 * 同时把同一批事实写进轨迹：轨迹页不是给「问答」专用的，辩论也要能看见
 * 谁在第几轮、用哪家模型、说了多少字、为什么失败。这里不另造一套状态，
 * 只读编排器的落盘快照再翻译成轨迹步。
 *
 * 只推不发：真正的编排仍在 DebateOrchestrator 里，这个定时器只做投影。
 */
function watchDebateInConversation(debateId: string, conversationId: string): void {
  const trace = new TraceRecorder(traceStore, conversationId, emitConversation);
  let turnStarted = false;
  let parent: StepHandle | undefined;
  let traceClosed = false;
  const seenMessages = new Set<string>();
  const seenFailures = new Set<string>();
  const labelOfActor = (agentId: string): string =>
    extraAgents.find(agent => agent.id === agentId)?.label
    ?? registry.get(agentId)?.label
    ?? agentId;
  const sourceOfActor = (agentId: string): TraceSource => {
    const extra = extraAgents.find(agent => agent.id === agentId);
    if (extra) return extra.sourceType;
    return registry.get(agentId) ? 'web' : 'system';
  };

  /** 把这一刻能看到的新发言 / 新失败写成轨迹步；只写没写过的。 */
  const recordTrace = (current: DebateState): void => {
    if (!turnStarted) {
      turnStarted = true;
      trace.beginTurn({
        inputPreview: current.question,
        reason: '直接辩论：跳过第一轮回答与汇总，只跑交锋与裁决',
        meta: { executionMode: current.config.leadMode, rounds: current.config.maxRounds }
      });
      parent = trace.beginStep({
        stage: 'debate',
        group: 'debate',
        actorId: current.lead.agentId ?? 'system',
        actorLabel: current.lead.label,
        sourceType: current.lead.agentId ? sourceOfActor(current.lead.agentId) : 'system',
        reason: `${current.config.strategy} · 最多 ${current.config.maxRounds} 轮`,
        inputPreview: current.question,
        meta: { rounds: current.rounds.length }
      });
    }
    const rounds = [...current.rounds, ...(current.runningRound ? [current.runningRound] : [])];
    for (const round of rounds) {
      for (const message of round.messages) {
        if (seenMessages.has(message.messageId)) continue;
        seenMessages.add(message.messageId);
        const handle = trace.beginStep({
          stage: 'debate',
          group: 'debate',
          actorId: message.agentId,
          actorLabel: labelOfActor(message.agentId),
          sourceType: sourceOfActor(message.agentId),
          reason: `第 ${round.index + 1} 轮 · ${message.kind}`,
          inputPreview: current.question,
          ...(parent ? { parentStep: parent.step } : {}),
          startedAt: message.startedAt ?? message.createdAt
        });
        trace.endStep(handle, {
          status: 'ok',
          ...(message.reasoning ? { reasoning: message.reasoning } : {}),
          outputPreview: message.text,
          endedAt: message.endedAt ?? message.createdAt,
          meta: { rounds: round.index + 1, outputChars: message.text.length }
        });
      }
      for (const failure of round.failures) {
        const key = `${round.index}:${failure.agentId}`;
        if (seenFailures.has(key)) continue;
        seenFailures.add(key);
        const handle = trace.beginStep({
          stage: 'debate',
          group: 'debate',
          actorId: failure.agentId,
          actorLabel: labelOfActor(failure.agentId),
          sourceType: sourceOfActor(failure.agentId),
          reason: `第 ${round.index + 1} 轮 · 没有发言`,
          inputPreview: current.question,
          ...(parent ? { parentStep: parent.step } : {})
        });
        trace.endStep(handle, {
          status: 'failed',
          endedAt: round.endedAt ?? Date.now(),
          error: { code: errorCodeOf(failure.detail), detail: failure.detail }
        });
      }
    }
    if (current.status !== 'running' && !traceClosed) {
      traceClosed = true;
      const status = current.status === 'completed'
        ? 'ok' as const
        : current.status === 'cancelled'
          ? 'cancelled' as const
          : 'interrupted' as const;
      trace.endStep(parent, {
        status,
        ...(current.stopReason ? { reason: current.stopReason } : {}),
        meta: { rounds: current.rounds.length, failed: current.rounds.reduce((total, round) => total + round.failures.length, 0) }
      });
      trace.endTurn({
        status,
        ...(current.stopReason ? { reason: current.stopReason } : {}),
        meta: { rounds: current.rounds.length }
      });
    }
  };

  const timer = setInterval(tick, 1500);
  function tick(): void {
    if (!debates) { clearInterval(timer); return; }
    const current = debates.get(debateId);
    const conversation = store.getConversation(conversationId);
    // 会话被删了就不再往这里写：留下一条没有会话的记录，侧栏里也打不开。
    if (!current || !conversation) { clearInterval(timer); return; }
    recordTrace(current);
    const snapshot = debateSnapshotOf(current);
    emitConversation({
      type: 'debate.progress',
      at: Date.now(),
      conversationId,
      debateId,
      status: current.status,
      rounds: snapshot.rounds,
      ...(current.stopReason ? { stopReason: current.stopReason } : {})
    });
    if (current.status === 'running') return;
    clearInterval(timer);
    const message: ConversationMessage = {
      messageId: randomUUID(),
      conversationId,
      role: 'system',
      // 问题已经作为一条用户消息出现在上面了，这里不重复。
      text: '',
      debate: snapshot,
      debateId,
      at: Date.now()
    };
    store.appendMessage(message);
    emitConversation({ type: 'message.added', at: message.at, message });
    // 辩论跑着的时候用户可能又追问了：那条链路的状态优先，别把「正在回答」
    // 改成「已回答」。只有已经结束的会话才补成 answered。
    const busy = ['thinking', 'collecting', 'comparing', 'synthesizing'].includes(conversation.status);
    const next: Conversation = {
      ...conversation,
      status: busy ? conversation.status : 'answered',
      updatedAt: Date.now()
    };
    store.upsertConversation(next);
    emitConversation({ type: 'conversation.updated', at: next.updatedAt, conversation: next });
  }
  // 立即写第一条：用户切到轨迹页时不该先空白 1.5 秒。
  tick();
}

function trustedUiSender(event: Electron.IpcMainInvokeEvent) {
  if (!win || event.sender.id !== win.webContents.id || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC sender rejected');
  }
  const url = event.senderFrame?.url ?? '';
  const isDev = url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');
  if (!isDev && !url.startsWith('file://')) throw new Error('Untrusted renderer origin');
}

/**
 * 渲染进程递上来的搜索设置，只认这三个字段。
 *
 * 不直接 `as SearchSettings` 是有原因的：渲染进程是网页环境，任何字段都可能
 * 是 `{ toString: ... }` 之类的怪东西，写进 JSON 就成了脏数据；而这里多接受
 * 一个字段（比如未来某人加了 `configPath`）就等于让它能改文件路径。
 */
function sanitizeSearchPatch(raw: unknown): {
  provider?: SearchProvider | null;
  apiKey?: string;
  searxngUrl?: string;
} {
  if (!raw || typeof raw !== 'object') throw new Error('搜索设置格式不正确');
  const input = raw as Record<string, unknown>;
  const out: { provider?: SearchProvider | null; apiKey?: string; searxngUrl?: string } = {};

  if ('provider' in input) {
    const value = input.provider;
    if (value === null) out.provider = null;
    else if (typeof value === 'string' && (SEARCH_PROVIDERS as readonly string[]).includes(value)) {
      out.provider = value as SearchProvider;
    } else {
      throw new Error('未知的搜索提供方');
    }
  }
  if ('apiKey' in input) {
    if (typeof input.apiKey !== 'string') throw new Error('API key 必须是字符串');
    out.apiKey = input.apiKey.trim().slice(0, 400);
  }
  if ('searxngUrl' in input) {
    if (typeof input.searxngUrl !== 'string') throw new Error('实例地址必须是字符串');
    const url = input.searxngUrl.trim();
    if (url && !/^https?:\/\//i.test(url)) throw new Error('实例地址要以 http:// 或 https:// 开头');
    out.searxngUrl = url.slice(0, 2000);
  }
  return out;
}

/**
 * Split the window between the app and the embedded page.
 *
 * The arithmetic lives in layout.ts so it can be asserted; both sides then
 * derive the boundary from the same number instead of each guessing.
 */
function layout() {
  if (!win) return;
  const [width, height] = win.getContentSize();
  const split = computeSplit(width, preferredSplit);
  const shown = computePageBounds(width, height, split);
  const offstage = computePageBounds(width, height, split, { parked: true });

  for (const [id, view] of views) {
    // A detached page belongs to another window now. Touching its bounds here
    // would drag it back into the main window's coordinate space while it is
    // being displayed somewhere else.
    if (detached?.sourceId === id) continue;
    // Only the active source is on screen, and never while dragging: an
    // offscreen-but-visible view on the boundary still eats the pointer.
    //
    // The parked view keeps the viewport it was given while it was on screen
    // (`primeViewports`), so it stays askable in the background even though it
    // is not laid out against the current split. A folded pane is the same
    // situation, which is why it goes through this branch rather than through a
    // zero-width bounds.
    const onScreen = id === activeSourceId && !draggingPage && !pageCollapsed;
    const bounds = onScreen ? shown : offstage;
    const last = applied.get(id);
    if (!last || last.x !== bounds.x || last.y !== bounds.y || last.width !== bounds.width || last.height !== bounds.height) {
      view.setBounds(bounds);
      applied.set(id, { ...bounds, visible: last?.visible ?? true });
    }
    if (!last || last.visible !== onScreen) {
      view.setVisible(onScreen);
      const entry = applied.get(id);
      if (entry) entry.visible = onScreen;
    }
  }

  win.webContents.send('layout:changed', layoutInfo());
}

/**
 * What the renderer needs to draw the boundary.
 *
 * While folded the reservation is only the rail, not zero: the app column has
 * to stop before the rail or the source buttons end up painted over the
 * composer. `collapsed` is what tells the renderer the small number means
 * "no page here" rather than "a 46px page".
 */
function layoutInfo(): LayoutInfo {
  const width = win ? win.getContentSize()[0] : 0;
  return {
    split: pageCollapsed ? collapsedSplit() : computeSplit(width, preferredSplit),
    collapsed: pageCollapsed
  };
}

/**
 * 上次的窗口状态。读不出来就是默认值——一个记不住尺寸的窗口，好过一个打不开的。
 *
 * 屏幕信息是现读的（`screen` 只能在 ready 之后问），所以「上次那块屏还在不在」
 * 这件事在每次启动时重新判一次。
 */
function readWindowState(): WindowPlacement {
  const displays = screen.getAllDisplays().map(display => display.workArea);
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(windowStateFile, 'utf8'));
    return restoreWindowPlacement(raw, displays);
  } catch {
    return restoreWindowPlacement(null, displays);
  }
}

/**
 * 记住现在的窗口状态。
 *
 * 最大化时取 `getNormalBounds()`：要记的是「还原以后多大」，否则下次启动会先
 * 出现一个铺满屏幕的窗口、再被 `maximize()` 一次，闪一下。
 */
function saveWindowState(): void {
  if (saveWindowStateTimer) {
    clearTimeout(saveWindowStateTimer);
    saveWindowStateTimer = null;
  }
  if (!win || win.isDestroyed() || !windowStateFile) return;

  const maximized = win.isMaximized();
  const bounds = maximized ? win.getNormalBounds() : win.getBounds();
  const state: WindowPlacement = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized,
    split: preferredSplit ?? undefined
  };
  try {
    writeFileAtomic(windowStateFile, JSON.stringify(state));
  } catch {
    // 写不进去不该挡住关闭窗口：这条记录只影响下次启动的大小。
  }
}

/** 拖动时每一帧都会触发 resize/move；等手停下来再写盘。 */
function saveWindowStateSoon(): void {
  if (saveWindowStateTimer) clearTimeout(saveWindowStateTimer);
  saveWindowStateTimer = setTimeout(saveWindowState, 400);
}

/**
 * Give every page a real box once, while the window is still off screen.
 *
 * A `WebContentsView` that has never been shown has a **0x0 viewport**: every
 * element measures zero, so the probe cannot see an input box and cannot read an
 * answer. The channel then reports "未找到输入框，页面结构可能已变化" about a page
 * that is perfectly healthy, and a source the user has never clicked is never
 * askable at all — multi-channel comparison silently degrades to whichever page
 * happens to be in front.
 *
 * A viewport, once given, survives being hidden, so this only has to happen
 * before the first paint. Doing it before `win.show()` is what keeps it
 * invisible: showing the views afterwards would flash the second site over the
 * pane the user is looking at.
 */
function showOnce(id: string, view: WebContentsView): void {
  if (!win) return;
  const [width, height] = win.getContentSize();
  const shown = computePageBounds(width, height, computeSplit(width, preferredSplit));
  view.setBounds(shown);
  view.setVisible(true);
  applied.set(id, { ...shown, visible: true });
}

async function primeViewports(): Promise<void> {
  if (!win) return;
  for (const [id, view] of views) showOnce(id, view);
  // One layout pass is not enough: the page needs a frame with a non-zero size
  // before its own layout runs.
  await new Promise(resolve => setTimeout(resolve, 150));
}

/**
 * The same priming, for a view that is created while the window is on screen.
 *
 * Switching a source on in 设置 builds a view that has never been painted, so it
 * starts at 0x0 exactly like a startup view would — and then `layout()` parks it
 * offstage because it is not the active source, which it can never recover from
 * on its own. The symptom is the misleading one: the channel says "未找到输入框，
 * 页面结构可能已变化" about a page that has simply never been given a box.
 *
 * `createSourceView` puts every view at the bottom of the stack, so showing it
 * here does not cover the page the user is looking at — z-order has nothing to
 * do with layout, and the box is real either way.
 */
async function primeViewport(id: string, view: WebContentsView): Promise<void> {
  showOnce(id, view);
  await new Promise(resolve => setTimeout(resolve, 150));
}

function sourcesState(): SourcesState {
  return {
    sources: sources.map(source => ({ ...source })),
    activeId: activeSourceId,
    planningId: planningSource(sources)?.id ?? null,
    loading: sourceLoading,
    openOnLaunch: sourceStore ? sourceStore.openOnLaunch() : sourcesOpenOnLaunch(EMPTY_STORED_SOURCES),
    webViewsOpen: [...views.values()].some(view => !view.webContents.isDestroyed())
  };
}

function emitSources() {
  win?.webContents.send('sources:changed', sourcesState());
}

/** Replace the live list with the file's contents. Never mutates in place. */
function applyStored(stored: StoredSources) {
  sources = resolveSources(stored);
}

/**
 * Tear down one source's WebContentsView.
 *
 * Used when a source is switched off, when 「启动时打开」 is turned off, and
 * when a custom source is deleted. Closing — not parking — is what makes the
 * 设置 switch mean "this page is not open": a parked view still holds the
 * site in memory and still counts against the next launch.
 */
function destroySourceView(id: string): void {
  if (detached?.sourceId === id) reattachSource();
  const view = views.get(id);
  if (view && !view.webContents.isDestroyed()) {
    win?.contentView.removeChildView(view);
    view.webContents.close();
  }
  views.delete(id);
  applied.delete(id);
  adapters.delete(id);
  // 页面全关了就收起分栏：空着的右栏会让人以为「还有页面开着」。
  if (views.size === 0 && !detached && pageCollapsed === false) setCollapsed(true);
}

/**
 * Make the running app match a new setting for one source.
 *
 * Three things can change and they are independent:
 *
 * - a new address means a real navigation, but **the same view**. The partition
 *   — and therefore the login — belongs to the source id, not to the URL, so
 *   recreating the view would silently sign the user out of the site they just
 *   fixed the address for;
 * - switching on means the view has to exist at all;
 * - switching off closes the view and, if that page was on screen, moves the
 *   pane to another enabled source — otherwise the pane would keep showing a
 *   page the rail no longer lists.
 */
function syncSource(before: PageSource | undefined, after: PageSource) {
  const view = views.get(after.id);

  if (!after.enabled) {
    if (view) destroySourceView(after.id);
    if (activeSourceId === after.id) {
      const next = sources.find(source => source.enabled);
      if (next) activeSourceId = next.id;
    }
    rebuildChannels();
    emitSources();
    layout();
    return;
  }

  // A view that does not exist yet has to be primed before the layout pass at
  // the end of this function parks it, or it spends its whole life at 0x0.
  const created = !view ? createSourceView(after) : null;

  if (view && before?.url !== after.url && after.url) {
    void view.webContents.loadURL(after.url).catch(() => undefined);
  }

  rebuildChannels();
  emitSources();

  if (created) {
    void primeViewport(after.id, created)
      .then(() => loadSource(after))
      .catch(() => undefined)
      .finally(() => layout());
    return;
  }

  layout();
}

/**
 * Save one source's settings.
 *
 * Every rejection here is something the settings panel has to be able to say
 * out loud, so they are messages rather than codes: a URL that does not parse,
 * a URL that is not https, and the one rule that is a product decision — the
 * last source cannot be switched off, because the agent would then have nowhere
 * to ask and the failure would surface later as "规划没有返回".
 *
 * The rule used to be "the planning channel cannot be switched off". That was
 * the wrong shape: it made one source special and left the user unable to turn
 * off a page they had stopped paying for. "Leave at least one on" says the same
 * thing about the invariant without carving out an exception — and
 * `planningSource` moves planning to whatever is still on.
 */
function saveSource(raw: unknown): SourcesState {
  if (!raw || typeof raw !== 'object') throw new Error('无效的来源设置');
  const input = raw as { id?: unknown; url?: unknown; enabled?: unknown };
  if (typeof input.id !== 'string') throw new Error('无效的来源设置');
  const current = sourceById(sources, input.id);
  if (!current) throw new Error('未知来源');
  if (!sourceStore) throw new Error('设置还没有准备好');

  const patch: SourceOverride = {};
  if (input.url !== undefined) {
    if (typeof input.url !== 'string') throw new Error('网址必须是一段文字');
    const check = normalizeSourceUrl(input.url);
    if (!check.ok || !check.url) throw new Error(check.error ?? '这个网址不能用');
    patch.url = check.url;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new Error('启用状态只能是开或关');
    const stays = sources.some(source => source.id !== current.id && source.enabled);
    if (!input.enabled && current.enabled && !stays) throw new Error('至少要留一个来源，全关掉 Agent 就没地方问了');
    // A source with no address cannot answer, so switching it on would only add
    // a channel that reports a failure forever. WorkBuddy ships this way on
    // purpose: there is no single address for it to default to.
    if (input.enabled && !(patch.url ?? current.url)) throw new Error('先填网址，再打开这个提供商');
    patch.enabled = input.enabled;
  }
  if (Object.keys(patch).length === 0) return sourcesState();

  applyStored(sourceStore.patch(current.id, patch));
  syncSource(current, sourceById(sources, current.id) ?? current);
  return sourcesState();
}

/** Add a web page as a new source. Its first address is its allow-list. */
function addSource(raw: unknown): SourcesState {
  if (!raw || typeof raw !== 'object') throw new Error('无效的来源');
  const input = raw as { label?: unknown; url?: unknown };
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label) throw new Error('请填写名称');
  const check = normalizeSourceUrl(typeof input.url === 'string' ? input.url : '');
  if (!check.ok || !check.url) throw new Error(check.error ?? '这个网址不能用');
  if (!sourceStore) throw new Error('设置还没有准备好');

  const created = makeCustomSource({ label, url: check.url }, sources);
  applyStored(sourceStore.addCustom(created));
  const source = sourceById(sources, created.id);
  rebuildChannels();
  emitSources();
  if (!source) {
    layout();
    return sourcesState();
  }
  // Same reason as in `syncSource`: prime before parking, or the page is 0x0
  // and the new channel reports a structural failure it does not have.
  const view = createSourceView(source);
  void primeViewport(source.id, view)
    .then(() => loadSource(source))
    .catch(() => undefined)
    .finally(() => layout());
  return sourcesState();
}

/**
 * Remove a source that was added in 设置.
 *
 * Built-ins are refused rather than deleted: disabling one already means "I do
 * not want this", and deleting a shipped source would make the next release's
 * fixes to it invisible. Removing a custom one closes its view the same way
 * switching it off does.
 */
function removeSource(raw: unknown): SourcesState {
  const id = typeof raw === 'string' ? raw : '';
  const source = sourceById(sources, id);
  if (!source) throw new Error('未知来源');
  if (!source.custom) throw new Error('内置来源不能删除，可以先关掉');
  if (!sourceStore) throw new Error('设置还没有准备好');
  // Deleting is the other way to end up with nothing to ask: the same invariant
  // as switching the last source off, so it gets the same answer.
  if (source.enabled && !sources.some(other => other.id !== id && other.enabled)) {
    throw new Error('至少要留一个来源，删掉它 Agent 就没地方问了');
  }

  destroySourceView(id);

  applyStored(sourceStore.removeCustom(id));
  if (!sourceById(sources, activeSourceId)) {
    const next = sources.find(item => item.enabled);
    if (next) activeSourceId = next.id;
  }
  rebuildChannels();
  layout();
  emitSources();
  return sourcesState();
}

/**
 * Persist 「启动时打开网页源」 and apply it to the running session.
 *
 * Off: every open view is closed now, and the next launch skips creating them.
 * On: every enabled source is created and loaded the same way a cold start
 * with the switch on would — otherwise "保存后生效" would only mean "next
 * reboot", which is the opposite of what the button promises.
 */
function setSourcesOpenOnLaunch(raw: unknown): SourcesState {
  if (typeof raw !== 'boolean') throw new Error('启动时打开只能是开或关');
  if (!sourceStore) throw new Error('设置还没有准备好');
  applyStored(sourceStore.setOpenOnLaunch(raw));

  if (!raw) {
    for (const id of [...views.keys()]) destroySourceView(id);
    rebuildChannels();
    emitSources();
    layout();
    return sourcesState();
  }

  const enabled = sources.filter(source => source.enabled && source.url);
  const created: Array<{ id: string; view: WebContentsView }> = [];
  for (const source of enabled) {
    if (views.has(source.id)) continue;
    created.push({ id: source.id, view: createSourceView(source) });
  }
  rebuildChannels();
  emitSources();
  if (created.length === 0) {
    layout();
    return sourcesState();
  }
  void (async () => {
    for (const item of created) {
      await primeViewport(item.id, item.view).catch(() => undefined);
      const source = sourceById(sources, item.id);
      if (source) await loadSource(source).catch(() => undefined);
    }
    layout();
  })();
  return sourcesState();
}

/**
 * Create every enabled source that does not have a view yet.
 *
 * Used when an ask needs the pages but 「启动时打开」 left them closed, and
 * when a follow-up has to restore a thread that no longer has a view after a
 * restart with the switch off.
 */
async function ensureEnabledViews(): Promise<void> {
  let opened = false;
  for (const source of sources) {
    if (!source.enabled || !source.url) continue;
    const before = views.has(source.id);
    try {
      await ensureSource(source);
      if (!before && views.has(source.id)) opened = true;
    } catch {
      /* leave the channel unavailable; ask path reports it */
    }
  }
  // 顶栏靠 webViewsOpen 决定要不要显示「页面就绪」；提问路径建起视图后要通知界面。
  if (opened) emitSources();
}

/**
 * Who is using this app.
 *
 * There is no account system, and this does not pretend to be one: it is a name
 * the person chose, defaulting to 本机用户. It used to be the operating system's
 * user name with the machine name as its tooltip — see `shared/identity.ts` for
 * why that had to go. Nothing here reads the OS about its owner.
 */
function identity(): Identity {
  const name = profileStore?.displayName() ?? DEFAULT_DISPLAY_NAME;
  return { name, initial: initialOf(name), device: deviceLabel(process.platform) };
}

/** Which page (if any) is living in its own window. */
function pageState(): PageState {
  return { detachedId: detached?.sourceId ?? null, collapsed: pageCollapsed };
}

function emitPageState() {
  win?.webContents.send('page:changed', pageState());
}

/**
 * Fold the page pane away, or bring it back — the chevron at the end of the bar.
 *
 * The view is hidden, never resized. A `WebContentsView` that is handed a
 * zero-width rectangle loses the viewport `primeViewports` gave it, and every
 * element in the page then measures zero — the channel would report "找不到输入框"
 * about a page that is perfectly fine, and the next question would go nowhere.
 * Parking it offscreen keeps the box and drops only the painting.
 *
 * Folding is allowed while a page is detached: the pane is empty in that case
 * anyway, and refusing would mean the bar has one button that sometimes lies.
 */
function setCollapsed(next: boolean): PageState {
  if (next === pageCollapsed) return pageState();
  pageCollapsed = next;
  layout();
  emitPageState();
  return pageState();
}

/**
 * The toolbar for a detached window.
 *
 * A `WebContentsView` paints over its window's own document, so the bar only
 * shows in the band the view does not cover. `-webkit-app-region: drag` is what
 * makes that band work as a title bar under `hiddenInset` — without it the
 * window cannot be moved at all, which is a trap a frameless window sets for
 * every first attempt at this.
 *
 * The button closes the window, and the main process listens for `closed`. That
 * is deliberately the only mechanism: the red traffic light, Cmd+W and the
 * button then all mean the same thing, so there is no second path to keep in
 * sync.
 */
function detachedDocument(source: PageSource): string {
  const label = source.label.replace(/[<>&]/g, '');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${label}</title>
<style>
  html, body { margin: 0; height: 100%; background: #fff; }
  body { font: 12px/1.4 -apple-system, "SF Pro Text", "PingFang SC", system-ui, sans-serif; color: #2b2b2b; }
  .bar {
    position: fixed; inset: 0 0 auto 0; height: ${String(DETACHED_BAR_HEIGHT)}px;
    display: flex; align-items: center; gap: 8px;
    padding: 0 12px 0 84px; box-sizing: border-box;
    background: #f7f7f5; border-bottom: 1px solid rgba(0, 0, 0, 0.12);
    -webkit-app-region: drag; user-select: none;
  }
  .name { font-weight: 600; letter-spacing: 0.02em; }
  .hint { color: #8a8a86; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hint.is-error { color: #b42318; }
  .spacer { flex: 1; }
  .actions { display: flex; align-items: center; gap: 6px; -webkit-app-region: no-drag; }
  /* Same 24px square as the main window's page bar, and the same glyph: the two
     windows perform the same action, so they must not look different. */
  button.icon {
    display: grid; place-items: center;
    width: 24px; height: 24px; padding: 0; border-radius: 6px;
    border: 1px solid rgba(0, 0, 0, 0.16); background: #fff;
    color: #6b6b6b; cursor: pointer;
  }
  button.icon:hover { background: #efefec; color: #1a1a1a; }
  button.icon:disabled { opacity: 0.55; cursor: default; }
  button.icon svg { display: block; }
</style></head><body>
<div class="bar">
  <span class="name">${label}</span>
  <span class="hint" id="hint">独立窗口 · 关闭即吸附回去</span>
  <span class="spacer"></span>
  <span class="actions">
    <button id="save" class="icon" type="button" aria-label="保存文档" title="保存文档：提取这一页里的文档和计划，默认存成 Markdown">${iconSvg(ICON_SAVE_PATHS)}</button>
    <button id="save-word" class="icon" type="button" aria-label="保存为 Word" title="单独指定才生成 Word 文档（版式沿用导出模板）">${iconSvg(ICON_SAVE_WORD_PATHS)}</button>
    <button id="back" class="icon" type="button" aria-label="吸附回去" title="吸附回去">${iconSvg(ICON_DOCK_BACK_PATHS)}</button>
  </span>
</div>
<script>
  /* 通过独立窗口自己的 preload 调主进程，和放大前页面栏走同一条保存插件。
     以前改 location.hash 指望 did-navigate-in-page——在 data: 页上经常不触发，
     按钮看起来在，点了却什么都不发生。 */
  function save(format) {
    var api = window.tfDetached;
    if (!api || typeof api.saveDocument !== 'function') {
      var hint = document.getElementById('hint');
      if (hint) { hint.className = 'hint is-error'; hint.textContent = '保存桥没接上，请重启应用后再试'; }
      return;
    }
    api.saveDocument(format).catch(function (error) {
      var hint = document.getElementById('hint');
      if (!hint) return;
      hint.className = 'hint is-error';
      hint.textContent = error && error.message ? error.message : String(error);
    });
  }
  document.getElementById('save').addEventListener('click', function () { save('md'); });
  document.getElementById('save-word').addEventListener('click', function () { save('docx'); });
  document.getElementById('back').addEventListener('click', function () { window.close(); });
</script>
</body></html>`;
}

/**
 * 独立窗口工具栏上的一句话反馈。没有 React、没有 toast，只能改 hint。
 */
function setDetachedHint(text: string, tone: 'ok' | 'error' = 'ok') {
  const frame = detached?.window;
  if (!frame || frame.isDestroyed()) return;
  const safe = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
  const cls = tone === 'error' ? 'hint is-error' : 'hint';
  void frame.webContents.executeJavaScript(
    `(() => { const el = document.getElementById('hint'); if (!el) return; el.className = '${cls}'; el.textContent = '${safe}'; })()`
  );
}

/**
 * 独立窗口点「保存」时走这里。和主窗口页面栏同一个插件，不另读一遍页面。
 */
async function saveFromDetached(format: 'md' | 'docx') {
  if (!detached || !pageDocumentSaver) return;
  const { window: frame, sourceId } = detached;
  setDetachedHint(format === 'docx' ? '正在保存 Word…' : '正在保存…');
  try {
    // 禁用两个按钮，防止连点把同一页存两份。
    if (!frame.isDestroyed()) {
      void frame.webContents.executeJavaScript(
        `(() => { for (const id of ['save','save-word']) { const b = document.getElementById(id); if (b) b.disabled = true; } })()`
      );
    }
    const result = await pageDocumentSaver({ sourceId, format });
    if (!result) {
      setDetachedHint('已取消保存');
      return;
    }
    const where = result.path.split('/').pop() ?? result.path;
    setDetachedHint(
      `已保存 ${where} · ${result.documents} 份文档 / ${result.planItems} 条计划`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setDetachedHint(message, 'error');
  } finally {
    if (!frame.isDestroyed()) {
      void frame.webContents.executeJavaScript(
        `(() => { location.hash = ''; for (const id of ['save','save-word']) { const b = document.getElementById(id); if (b) b.disabled = false; } })()`
      );
    }
  }
}

/**
 * Pull a page out into its own window.
 *
 * This is a re-parent, not a copy: `WebContentsView` has exactly one parent, so
 * the same webContents moves from the main window's contentView to the new
 * window's. The page keeps its session, its cookies, its scroll position and
 * any answer it is in the middle of writing — which is why this is a move and
 * not a second view onto the same URL.
 */
function detachSource(id: string): PageState {
  const source = sourceById(sources, id);
  const view = views.get(id);
  if (!source || !view) throw new Error('页面尚未创建');
  if (!win) throw new Error('窗口尚未创建');
  if (detached?.sourceId === id) return pageState();
  if (detached) reattachSource();

  const [width, height] = win.getContentSize();
  const frame = new BrowserWindow({
    width: Math.max(900, Math.round(width * 0.8)),
    height: Math.max(680, Math.round(height * 0.92)),
    minWidth: 520,
    minHeight: 400,
    title: `${source.label} · 独立窗口`,
    // Keeps the traffic lights and makes the page's own bar the title bar.
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 只挂保存用的小桥：没有它，工具栏点保存没有任何通路到主进程。
      preload: path.join(__dirname, '../preload/detached.js')
    }
  });

  win.contentView.removeChildView(view);
  frame.contentView.addChildView(view);
  // The remembered geometry belongs to the main window. Forgetting it is what
  // makes the next `layout()` push real numbers instead of deciding nothing
  // changed.
  applied.delete(id);

  const place = () => {
    if (frame.isDestroyed() || view.webContents.isDestroyed()) return;
    const [w, h] = frame.getContentSize();
    view.setBounds({
      x: 0,
      y: DETACHED_BAR_HEIGHT,
      width: Math.max(1, w),
      height: Math.max(1, h - DETACHED_BAR_HEIGHT)
    });
    view.setVisible(true);
  };
  place();
  frame.on('resize', place);
  frame.on('closed', () => {
    // `reattachSource` clears `detached` before destroying the window, so this
    // branch only runs for a close the user performed.
    if (detached?.window !== frame) return;
    const sourceId = detached.sourceId;
    // 「关掉页面」就是关掉：以前这里把页面搬回主窗口的分栏，用户明明点了关闭，
    // 下一次提问又把同一页摆回来。现在连同视图一起销毁，并在没有页面时收起
    // 分栏，不留下一个空列。
    detached = null;
    destroySourceView(sourceId);
    if (views.size === 0) setCollapsed(true);
    layout();
    emitPageState();
  });
  detached = { window: frame, sourceId: id };
  void frame.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(detachedDocument(source))}`);
  layout();
  emitPageState();
  return pageState();
}

/** Put a detached page back where it came from. */
function reattachSource(): PageState {
  if (!detached) return pageState();
  const { window: frame, sourceId } = detached;
  detached = null;

  const view = views.get(sourceId);
  if (view && !view.webContents.isDestroyed() && win && !win.isDestroyed()) {
    if (!frame.isDestroyed()) frame.contentView.removeChildView(view);
    win.contentView.addChildView(view);
    applied.delete(sourceId);
  }
  layout();
  if (!frame.isDestroyed()) frame.destroy();
  emitPageState();

  // Force one real resize after the move.
  //
  // A view that has just changed parents does not always re-lay-out its page:
  // the native frame takes the new bounds while the document inside keeps the
  // viewport of the window it came from, so a page returns from 1248px wide
  // still laid out at 1248 inside a 599px pane. It is intermittent — it depends
  // on whether the destination window happens to be painting at that moment —
  // and it never heals on its own, because every later `setBounds` pushes the
  // same numbers and Chromium sees no change. Two calls one pixel apart is the
  // cheapest thing that is guaranteed to be a change.
  if (view && !view.webContents.isDestroyed() && win && !win.isDestroyed()) {
    const [width, height] = win.getContentSize();
    const target = computePageBounds(width, height, computeSplit(width, preferredSplit));
    view.setBounds({ ...target, width: Math.max(1, target.width - 1) });
    setTimeout(() => {
      if (view.webContents.isDestroyed()) return;
      view.setBounds(target);
      applied.set(sourceId, { ...target, visible: true });
    }, 32);
  }

  return pageState();
}

/**
 * Run a script in the page with a deadline.
 *
 * `executeJavaScript` has no timeout of its own, and a page that is mid-load can
 * leave the promise pending for tens of seconds. A button that hangs forever is
 * the exact failure this app keeps having to apologise for, so a repair that
 * cannot finish has to fail out loud instead.
 */
function runInPage<T>(view: WebContentsView, script: string, label: string, timeoutMs = 8000): Promise<T> {
  // Same deadline the driver uses. It lived here first, in a second copy, and a
  // second copy of a timeout is a second place for the number to be wrong.
  return callPage<T>(view, label, script, timeoutMs);
}

/**
 * Re-read the page and repair the selectors that stopped matching.
 *
 * The sequence is: discover from the live DOM, compare against what the current
 * profile can already see, then **prove the proposal with a real probe** before
 * writing it down. Only the third step makes this a repair instead of a guess —
 * a selector that matches during discovery can still be useless at question
 * time (it may match a hidden duplicate, or the node may be replaced on the
 * next render), and persisting that would turn "the site changed" into "the app
 * is broken in a new way".
 *
 * Roles the built-in profile already handles are never touched: appending a
 * learned selector for a working role is how a repair becomes a regression.
 */
async function learnSelectorsFor(sourceId: string): Promise<LearnSelectorsReport> {
  const view = views.get(sourceId);
  if (!view) throw new Error('页面尚未创建');
  if (view.webContents.isDestroyed()) throw new Error('页面已关闭');

  const label = sourceById(sources, sourceId)?.label ?? sourceId;
  const base = baseProfile(sourceId);
  const host = hostOf(view);
  const notes: Record<string, string> = { input: '输入框', sendButton: '发送键', assistant: '回答区域' };

  // Nothing to read yet, and running three scripts against a half-built page is
  // how this took twenty seconds on a cold start.
  if (view.webContents.isLoading()) {
    return {
      sourceId,
      learned: [],
      intact: [],
      failed: ['input', 'sendButton', 'assistant'],
      probe: { hasInput: false, hasSendButton: false, messageCount: 0, viewportWidth: 0 },
      message: `${label}：页面还在加载，等它显示出来再试`
    };
  }

  const discovered = await runInPage<DiscoveredSelectors>(view, DISCOVER_SCRIPT, '读取页面结构');
  const before = await runInPage<PageProbe>(view, PROBE_SCRIPT(base, reasoningFor(sourceId), signedOutFor(sourceId), signedOutTextFor(sourceId), contextLimitFor(sourceId)), '检查页面状态');

  const probe = {
    hasInput: before.hasInput,
    hasSendButton: before.hasSendButton,
    messageCount: before.messageCount,
    viewportWidth: before.viewportWidth
  };

  if (before.viewportWidth === 0) {
    return {
      sourceId,
      learned: [],
      intact: [],
      failed: ['input', 'sendButton', 'assistant'],
      probe,
      message: `${label}：页面还没有尺寸，先让窗口显示出来再试`
    };
  }

  // A role is "working" when the current profile can already see it. Note the
  // asymmetry for `assistant`: zero messages is also what an empty new chat
  // looks like, so a working chat cannot be told apart from a renamed one until
  // there is at least one answer on screen.
  const working = {
    input: before.hasInput,
    sendButton: before.hasSendButton,
    assistant: before.messageCount > 0
  };

  const proposal = proposeRepairs(working, discovered.roles, { composerEmpty: discovered.composerEmpty });
  const intact: SelectorRole[] = [...proposal.intact];
  const failed: SelectorRole[] = [...proposal.failed];
  const pending: RepairableRole[] = [...proposal.pending];

  let after = before;
  if (Object.keys(proposal.candidate).length > 0) {
    after = await runInPage<PageProbe>(view, PROBE_SCRIPT(mergeProfile(base, proposal.candidate), reasoningFor(sourceId), signedOutFor(sourceId), signedOutTextFor(sourceId), contextLimitFor(sourceId)), '验证新选择器');
  }

  const verdict = confirmRepairs(proposal.candidate, after);
  failed.push(...verdict.failed);

  const confirmed: Partial<Record<SelectorRole, string[]>> = verdict.confirmed;
  const learned: LearnedRole[] = verdict.learned.map(role => ({
    role,
    selector: confirmed[role]?.[0] ?? '',
    note: notes[role] ?? role
  }));

  if (Object.keys(confirmed).length > 0 && selectorStore && host) {
    const existing = selectorStore.forHost(sourceId, host) ?? {};
    selectorStore.save(sourceId, host, { ...existing, ...confirmed });
  }

  probe.hasInput = after.hasInput;
  probe.hasSendButton = after.hasSendButton;
  probe.messageCount = after.messageCount;

  // Two reasons a role can be absent without anything being wrong: the send
  // control only exists once the composer has text, and the answer area only
  // exists once there is an answer. Both are states, not breakage, and saying
  // "仍没找到" there is how a working page got reported as a broken one.
  const unmeasurable: RepairableRole[] = [...pending];
  if (before.messageCount === 0 && failed.includes('assistant')) unmeasurable.push('assistant');
  const hardFailed = failed.filter((role): role is RepairableRole => !unmeasurable.includes(role as RepairableRole));
  const failedText = hardFailed.map(role => notes[role] ?? role).join('、');

  const waiting: string[] = [];
  if (unmeasurable.includes('sendButton')) waiting.push('发送键要等输入框里有字才会出现');
  if (unmeasurable.includes('assistant')) waiting.push('回答区域要等页面上有一条回答才能校准');

  const message = learned.length
    ? `${label}：已重新提取 ${String(learned.length)} 项（${learned.map(item => item.note).join('、')}）` +
      (hardFailed.length > 0 ? `；${failedText} 仍没找到` : '')
    : hardFailed.length > 0
      ? `${label}：${failedText} 仍没找到${before.hasInput ? '' : '，页面可能还没加载完或需要登录'}`
      : waiting.length > 0
        ? `${label}：${intact.length > 0 ? `${intact.map(role => notes[role] ?? role).join('、')}正常；` : ''}${waiting.join('，')}，到时候再点一次「更新样式」`
        : `${label}：现有选择器都还命中，不需要更新`;

  return { sourceId, learned, intact, failed, probe, message };
}

/**
 * Create a source's view. Loading is a separate step.
 *
 * Each source gets its own persistent partition, its own permission handlers
 * (all denied) and its own navigation allow-list — a shared session would let
 * one site read the other's cookies, which is the whole point of keeping them
 * apart.
 */
function createSourceView(source: PageSource): WebContentsView {
  if (!win) throw new Error('窗口尚未创建');

  const partition = `persist:${source.id}`;
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);

  const view = new WebContentsView({
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: true
    }
  });
  // Bottom of the stack, always. Only one page is visible at a time, so stacking
  // order would not matter — except while a view created after startup is being
  // primed: it has to be shown to get a viewport, and it must not cover the page
  // the user is reading while that happens.
  win.contentView.addChildView(view, 0);
  // Background throttling would be a second way to break a channel that is not
  // the one on screen: Chromium slows timers and paints for a page it believes
  // is hidden, and a chat page that stops painting also stops updating the text
  // the probe reads. These pages are the product's workers, not decoration, so
  // they keep running at full rate whether or not the user is looking.
  view.webContents.setBackgroundThrottling(false);

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedSourceUrl(source, url)) return { action: 'allow' };
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedSourceUrl(source, url)) event.preventDefault();
  });
  // `will-navigate` covers navigations the page starts, but a server-side
  // redirect goes through `will-redirect` instead — which is exactly how an
  // OAuth hop leaves the allow-list without anyone noticing.
  view.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedSourceUrl(source, url)) event.preventDefault();
  });
  view.webContents.on('will-attach-webview', event => event.preventDefault());

  views.set(source.id, view);
  return view;
}

/**
 * Load a source's page.
 *
 * Separate from creating the view so the window can be shown — and the viewport
 * primed — before any site is given a turn on the network.
 */
async function loadSource(source: PageSource): Promise<void> {
  const view = views.get(source.id);
  if (!view) return;
  // An address that has not been filled in yet is a real state (WorkBuddy ships
  // that way). Loading `''` throws a confusing net error and leaves the view on
  // about:blank with no hint why, so it is skipped instead.
  if (!source.url) return;
  await view.webContents.loadURL(source.url);
}

/** Create the view on first use, and make sure its page is on its way. */
async function ensureSource(source: PageSource): Promise<WebContentsView> {
  const existing = views.get(source.id);
  if (existing) return existing;
  if (!win) throw new Error('窗口尚未创建');
  const view = createSourceView(source);
  layout();
  await loadSource(source);
  return view;
}

/**
 * Bring a source to the front.
 *
 * The view is created in the background: the rail must switch immediately even
 * when the site takes seconds to load, otherwise the button looks broken for
 * exactly as long as the network is slow.
 */
function activateSource(id: string) {
  const source = sourceById(sources, id);
  if (!source) throw new Error(`未知来源：${id}`);
  if (!source.enabled) throw new Error(`${source.label} 还没启用，先在设置里打开`);
  // Clicking a source's rail button means "show me that page here". A page that
  // is living in its own window has to come home first, or the pane would stay
  // empty while the button claims it is active.
  if (detached?.sourceId === id) reattachSource();
  if (id === activeSourceId && views.has(id)) return;

  activeSourceId = id;
  // A view that exists is not necessarily a page that has arrived: every source
  // is created at startup now, so "has a view" no longer answers "is it ready".
  sourceLoading = views.get(id)?.webContents.isLoading() ?? true;
  layout();
  emitSources();
  if (!sourceLoading) return;

  void ensureSource(source)
    .then(() => {
      if (activeSourceId !== id) return;
      sourceLoading = false;
      layout();
      emitSources();
    })
    .catch(() => {
      if (activeSourceId !== id) return;
      sourceLoading = false;
      emitSources();
    });
}

/**
 * Load a page again and wait, but not forever.
 *
 * `did-finish-load` is the only signal that the document actually came back, and
 * a renderer that has wedged itself never sends it. Waiting on it without a
 * budget would put the button in 「刷新中…」 for the rest of the session, which is
 * the exact failure the button exists to fix.
 */
function settleLoad(view: WebContentsView, action: () => void, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      view.webContents.off('did-finish-load', onLoad);
      view.webContents.off('did-fail-load', onFail);
      resolve(ok);
    };
    const onLoad = () => finish(true);
    // Only the main frame counts, and `ERR_ABORTED` is not a failure at all: it
    // is what a site's blocked iframe and its own redirects report, and treating
    // those as "the reload did not work" would navigate the page home for no
    // reason.
    const onFail = (_event: unknown, errorCode: number, _desc: string, _url: string, isMainFrame: boolean) => {
      if (isMainFrame && errorCode !== -3) finish(false);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    view.webContents.on('did-finish-load', onLoad);
    view.webContents.on('did-fail-load', onFail);
    action();
  });
}

/**
 * 追问前把网页视图带回这条会话记录的会话地址。
 *
 * `conversation.threads` 是上一轮回答后记下的 threadUrl。应用重启、页面刷新
 * 或手动点过别处之后，视图会停在站点首页；只「不重置」是不够的，追问会自然
 * 在站点侧栏多建一条会话。这里按记录地址导航回去，只在同一站点内、只认
 * http(s)，失败如实回报，不假装已经回到原窗口。
 */
async function restoreThreadViews(threads: Readonly<Record<string, string>>): Promise<{
  restored: string[];
  failed: Array<{ agentId: string; detail: string }>;
}> {
  const restored: string[] = [];
  const failed: Array<{ agentId: string; detail: string }> = [];
  await Promise.all(Object.entries(threads).map(async ([agentId, raw]) => {
    let view = views.get(agentId);
    // 「启动时打开」关掉后，追问时视图可能还不存在——先按记录建起来，再导航回
    // 原会话，否则只会报「网页视图不存在」，等于开关把追问一起关了。
    if (!view || view.webContents.isDestroyed()) {
      const source = sourceById(sources, agentId);
      if (!source?.enabled) {
        failed.push({ agentId, detail: '网页源已关闭' });
        return;
      }
      try {
        view = await ensureSource(source);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failed.push({ agentId, detail: detail || '网页视图不存在' });
        return;
      }
    }
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      failed.push({ agentId, detail: '记录的会话地址无效' });
      return;
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      failed.push({ agentId, detail: '会话地址不是 http(s)' });
      return;
    }
    const before = view.webContents.getURL();
    try {
      const current = new URL(before);
      if (current.origin !== target.origin) {
        failed.push({ agentId, detail: '会话地址与当前站点不同源，拒绝导航' });
        return;
      }
    } catch {
      // 空地址 / about:blank：没有可比的同源信息，允许按记录地址导航。
    }
    // 已经在这一条会话上（query 差异不算换会话）就什么都不做。
    if (isSameThread(before, target)) {
      restored.push(agentId);
      return;
    }
    // 只看 did-finish-load 会误报：SPA 站点常常地址已经回到原会话，12 秒内
    // 却没派发该事件。改成以最终 URL 判定，成功也不必白等满 12 秒。
    const result = await navigateToThread(view, target, 12_000);
    if (result.ok) restored.push(agentId);
    else failed.push({
      agentId,
      detail: `页面停在 ${shortUrl(result.url) || shortUrl(before) || '空地址'}，没回到记录的地址 ${shortUrl(target.href)}`
    });
  }));
  return { restored, failed };
}

/** 失败原因里给一段可读的地址，别把完整 URL 塞进会话消息。 */
function shortUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname.length > 42 ? `${url.pathname.slice(0, 42)}…` : url.pathname;
    return `${url.host}${path}`;
  } catch {
    return raw.slice(0, 60);
  }
}

/**
 * 「刷新」: reload the page on screen, in place.
 *
 * In place, because the thread that is open has to stay open — a person presses
 * this when the page stopped responding, not when they want a new conversation.
 * The home address is the fallback, and only when the reload did not settle:
 * at that point the old document is unreachable anyway, and a full navigation is
 * the one thing that can replace a wedged renderer.
 *
 * The first load is bounded at 8s so the button always comes back. The fallback
 * navigation is not awaited for the same reason; the status poller reports the
 * outcome, which is where 「就绪 / 未就绪」already comes from.
 */
async function reloadPage(rawId?: unknown): Promise<SourcesState> {
  const source = sourceById(sources, typeof rawId === 'string' && rawId ? rawId : activeSourceId);
  if (!source) throw new Error('没有可刷新的页面');
  if (!source.enabled) throw new Error(`${source.label} 还没启用，先在设置里打开`);

  const view = views.get(source.id);
  // A page that was never created is not a reload, it is the first load — the
  // same path 「点开这个来源」 takes.
  if (!view || view.webContents.isDestroyed()) {
    activeSourceId = source.id;
    await ensureSource(source);
    return sourcesState();
  }

  sourceLoading = true;
  emitSources();
  try {
    const settled = await settleLoad(view, () => view.webContents.reload(), 8000);
    if (!settled && source.url) {
      void view.webContents.loadURL(source.url).catch(() => undefined);
    }
  } finally {
    sourceLoading = false;
    emitSources();
  }
  return sourcesState();
}

async function createWindow() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const isAppPage =
      details.url.startsWith('file://') || details.url.startsWith('http://localhost:') || details.url.startsWith('http://127.0.0.1:');
    if (!isAppPage) return callback({ responseHeaders: details.responseHeaders });
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'unsafe-inline' http://localhost:* http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        ]
      }
    });
  });

  // 上次关窗时的样子：大小、位置、分栏。`preferredSplit` 要在第一次 `layout()`
  // 之前定好，否则第一帧按默认比例画出来再跳一下。
  const saved = readWindowState();
  preferredSplit = saved.split ?? null;

  win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: 'ThinkFusion',
    // Shown after the views have been primed: see the startup order below.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.setMenuBarVisibility(false);

  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Every configured source is a channel, and a channel whose page was never
  // created cannot answer. Loading only the active one meant a fresh start could
  // read "0/2 通道就绪 · 页面尚未加载" and then quietly ask one AI, because the
  // rail was a prerequisite nobody knew they had to click.
  //
  // The order matters and is not the obvious one: every view is created and
  // given a real box while the window is still off screen, because a view that
  // has never been shown can never be asked. Only then is the window shown, and
  // only then does any site get a turn on the network — so startup is not gated
  // on the slower site, and nothing flashes over the pane.
  // The window is created hidden (`show: false`) so the views can be primed
  // before anything is painted. A window that never gets shown is worse than a
  // flash, so the show is in `finally`: whatever the priming does, the app
  // appears.
  const openOnLaunch = sourceStore ? sourceStore.openOnLaunch() : true;
  try {
    // 「启动时打开网页源」关掉时，这里一个视图都不建：来源栏和提问链路会在
    // 真正用到时走 `ensureSource`。建了再藏着，开关就只是少闪一下，内存和
    // 登录态仍被冷启动拖着走。
    if (openOnLaunch) {
      for (const source of sources.filter(item => item.enabled)) createSourceView(source);
      await primeViewports();
    }
    layout();
    win.on('resize', layout);
    // 大小和位置一起记：只记大小的话，把窗口拖到另一块屏上，下次还是开回原处。
    win.on('resize', saveWindowStateSoon);
    win.on('move', saveWindowStateSoon);
    win.on('maximize', saveWindowStateSoon);
    win.on('unmaximize', saveWindowStateSoon);
    // 关闭时立刻写一次，不等那个 400ms 的窗口——退出路径上它可能来不及跑。
    win.on('close', saveWindowState);
    startStatusPolling();
  } finally {
    win.show();
    if (saved.maximized) win.maximize();
  }

  if (!openOnLaunch) return;

  // Only the enabled ones: a disabled source has no view, and asking for its
  // page would create one behind the settings panel's back.
  const active = sourceById(sources, activeSourceId) ?? sources.find(source => source.enabled);
  if (active) await loadSource(active).catch(() => undefined);
  for (const source of sources) {
    if (!source.enabled || source.id === active?.id) continue;
    void loadSource(source).catch(() => undefined);
  }
}

function startStatusPolling() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    const planning = planningSource(sources);
    if (!planning) return;
    const view = views.get(planning.id);
    if (!view || view.webContents.isLoading()) return;
    try {
      const status: DeepSeekStatus = await planningAdapter().getStatus();
      emitDeepSeek({ type: 'status', status });
    } catch {
      /* transient; next tick retries */
    }
  }, 1500);
  statusTimer.unref();
}

/**
 * 本次运行里用户亲手在「添加文件」里挑过的路径。
 *
 * IPC 收到的输入一律当不可信（这是这个文件里一贯的约定）。附件是一条新的
 * 读盘通道：不设边界的话，渲染层里任何一段代码都能让主进程读 `~/.ssh/id_rsa`
 * 再发给网页。所以只认两处来源——本次亲手挑的，以及**这条会话已经存着的**
 * 引用（「引用对话中的文件」那条路）。
 */
const pickedAttachments = new Set<string>();

/**
 * IPC 里来的附件路径，收成一份可用的清单。
 *
 * 只认绝对路径字符串；多余条目按上限截掉。空数组与「没传」在这里都变成
 * `undefined`，下游据此保持「没有附件时问题逐字不变」。不在允许来源里的
 * 路径直接报错——静默丢掉会变成「附件没送到但界面说有」。
 */
function trustedAttachmentPaths(raw: unknown, extra: readonly string[] = []): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
    .slice(0, MAX_ATTACHMENTS);
  if (list.length === 0) return undefined;
  for (const item of list) {
    if (!pickedAttachments.has(item) && !extra.includes(item)) {
      throw new Error(`附件「${path.basename(item)}」不是通过「添加文件」挑的，不能作为附件读取。`);
    }
  }
  return list;
}

function registerIpc() {
  /**
   * 主进程插件的环境依赖。
   *
   * 插件自己不碰 Electron：会话存盘、保存对话框、网页探针都由这里注入。
   * 这与 harness 的 `inject` 是同一种意思——插件声明「我要什么」，宿主决定
   * 「怎么给」，于是插件在 node 里也能被单独测试。
   */
  const capabilityContext: MainCapabilityContext = {
    exportDeps: () => {
      const labels: Record<string, string> = {};
      for (const agent of registry.list()) labels[agent.id] = agent.label;
      for (const item of cloudCatalog) {
        for (const model of item.models) labels[`${item.id}:${model}`] = `${item.label} · ${model}`;
      }
      return {
        conversation: id => conversations.get(id),
        messages: id => conversations.messages(id),
        labels: () => labels,
        defaultDir: () => app.getPath('downloads'),
        pickPath: async (name, format) => {
          const target = await dialog.showSaveDialog({
            title: format === 'docx' ? '导出为 Word 文档' : '导出为 Markdown',
            defaultPath: path.join(app.getPath('downloads'), name),
            filters:
              format === 'docx'
                ? [{ name: 'Word 文档', extensions: ['docx'] }]
                : [{ name: 'Markdown', extensions: ['md'] }]
          });
          return target.canceled || !target.filePath ? null : target.filePath;
        }
      };
    },
    savePageDeps: () => ({
      defaultDir: () => app.getPath('downloads'),
      pickPath: async (name, format) => {
        // 页面在独立窗口里时，对话框挂到那个窗口上——挂到主窗口会让人以为
        // 点了保存却什么都没发生。
        const parent =
          detached?.window && !detached.window.isDestroyed()
            ? detached.window
            : win && !win.isDestroyed()
              ? win
              : null;
        const options = {
          title: format === 'docx' ? '把网页文档保存为 Word' : '把网页文档保存为 Markdown',
          defaultPath: path.join(app.getPath('downloads'), name),
          filters:
            format === 'docx'
              ? [{ name: 'Word 文档', extensions: ['docx'] }]
              : [{ name: 'Markdown', extensions: ['md'] }]
        };
        const target = parent
          ? await dialog.showSaveDialog(parent, options)
          : await dialog.showSaveDialog(options);
        return target.canceled || !target.filePath ? null : target.filePath;
      },
      /** 逐条保存：选一个目录，每条对话写一个文件。 */
      pickDirectory: async () => {
        const parent =
          detached?.window && !detached.window.isDestroyed()
            ? detached.window
            : win && !win.isDestroyed()
              ? win
              : null;
        const options = {
          title: '选择保存这些对话的文件夹',
          defaultPath: app.getPath('downloads'),
          buttonLabel: '保存到这里',
          properties: ['openDirectory' as const, 'createDirectory' as const]
        };
        const target = parent
          ? await dialog.showOpenDialog(parent, options)
          : await dialog.showOpenDialog(options);
        return target.canceled || target.filePaths.length === 0 ? null : target.filePaths[0];
      }
    }),
    readPage: async sourceId => {
      const id = typeof sourceId === 'string' && sourceById(sources, sourceId) ? sourceId : activeSourceId;
      const source = sourceById(sources, id);
      if (!source) throw new Error('这个网页源已经不在了');
      const view = views.get(id);
      if (!view || view.webContents.isDestroyed()) {
        throw new Error(`${source.label}：这个网页源还没打开，先切到它再保存`);
      }
      if (view.webContents.isLoading()) {
        throw new Error(`${source.label}：页面还在加载，等它显示出来再保存`);
      }

      // 探针就是提问链路用的那个，只在末尾多要一份「全部回答」。默认不带
      // 这个开关，轮询照旧只读最后一条，保存动作不会拖慢正在进行的问答。
      const probe = await runInPage<PageProbe>(
        view,
        PROBE_SCRIPT(
          baseProfile(id),
          reasoningFor(id),
          signedOutFor(id),
          signedOutTextFor(id),
          contextLimitFor(id),
          challengeTextFor(id),
          true,
          // 提问气泡只用于把保存列表排成聊天记录；站点没给就只列回答。
          userFor(id)
        ),
        '读取网页文档',
        12000
      );
      const documents = probe.allAnswers?.length ? probe.allAnswers : probe.lastText ? [probe.lastText] : [];
      if (documents.length === 0) {
        throw new Error(`${source.label}：这一页还没有可保存的文档（可能停在登录页或空会话）`);
      }
      const content: PageDocumentContent = {
        sourceLabel: source.label,
        pageTitle: probe.title || view.webContents.getTitle() || source.label,
        url: probe.url || view.webContents.getURL(),
        documents,
        // 有提问选择器时按 DOM 顺序带上问答；没有就交给 preview/save 退化成只列回答。
        ...(probe.allMessages && probe.allMessages.length > 0 ? { messages: probe.allMessages } : {}),
        transcript: probe.conversationText || ''
      };
      return content;
    },
    /**
     * 「＋ · 添加文件」的读取实现本体。
     *
     * 这里只给能力插件用；提问链路走 `mainCapabilities.execute('file.attach')`，
     * 那个插件在设置里可以被停用，停用时必须明确报错，而不是这条提问悄悄
     * 少了几份附件。
     */
    readAttachments: paths => attachFiles(paths)
  };

  // 提问链路走注册表，不直接用上面那份本体：`file.attach` 停用时必须报错。
  attachmentReader = paths =>
    mainCapabilities.execute<AttachmentText[]>('file.attach', { paths: [...paths] }, capabilityContext);

  // 独立窗口工具栏点「保存」也走同一条插件，不另写一份落盘逻辑。
  pageDocumentSaver = input =>
    mainCapabilities.execute<SavePageDocumentResult | null>('page.save-document', input, capabilityContext);

  ipcMain.handle('task:submit', async (event, raw: unknown) => {
    trustedUiSender(event);
    const input = SubmitPromptSchema.parse(raw);
    await ensureChannelSnapshot();
    return orchestrator.submit(input);
  });

  ipcMain.handle('task:get', (event, taskId: unknown) => {
    trustedUiSender(event);
    return store.getTask(TaskIdSchema.parse(taskId));
  });

  ipcMain.handle('task:history', event => {
    trustedUiSender(event);
    return tasks.list();
  });

  ipcMain.handle('task:events', (event, taskId: unknown) => {
    trustedUiSender(event);
    return store.listEvents(TaskIdSchema.parse(taskId));
  });

  ipcMain.handle('task:approve', async (event, raw: unknown) => {
    trustedUiSender(event);
    await orchestrator.approve(ApprovePlanSchema.parse(raw));
  });

  ipcMain.handle('task:reject', async (event, raw: unknown) => {
    trustedUiSender(event);
    await orchestrator.reject(RejectPlanSchema.parse(raw));
  });

  ipcMain.handle('task:approve-step', async (event, raw: unknown) => {
    trustedUiSender(event);
    await orchestrator.approveStep(ApproveStepSchema.parse(raw));
  });

  ipcMain.handle('task:answer-question', async (event, raw: unknown) => {
    trustedUiSender(event);
    await orchestrator.answerQuestion(AnswerStepQuestionSchema.parse(raw));
  });

  ipcMain.handle('task:reject-step', async (event, raw: unknown) => {
    trustedUiSender(event);
    await orchestrator.rejectStep(RejectStepSchema.parse(raw));
  });

  ipcMain.handle('task:cancel', async (event, taskId: unknown) => {
    trustedUiSender(event);
    await orchestrator.cancel(TaskIdSchema.parse(taskId));
  });

  ipcMain.handle('task:answer', async (event, raw: unknown) => {
    trustedUiSender(event);
    const input = ClarificationAnswerSchema.parse(raw);
    await orchestrator.answerClarification(input);
  });

  ipcMain.handle('task:delete', async (event, taskId: unknown) => {
    trustedUiSender(event);
    const id = TaskIdSchema.parse(taskId);
    await orchestrator.deleteTask(id);
    // The list is built from events, so a delete that is only persisted leaves
    // the row on screen until the window is reloaded.
    win?.webContents.send('agent:event', { type: 'task.deleted', taskId: id, at: Date.now() });
  });

  ipcMain.handle('permission:get', event => {
    trustedUiSender(event);
    return permissionPreset;
  });

  ipcMain.handle('permission:set', (event, preset: unknown) => {
    trustedUiSender(event);
    if (typeof preset !== 'string' || !['read-only', 'workspace-write', 'danger-full-access'].includes(preset)) {
      throw new Error('未知权限预设');
    }
    permissionPreset = preset as PermissionPreset;
    return { preset: permissionPreset, approvalPolicy: 'ask' as const };
  });

  ipcMain.handle('app:platform', event => {
    trustedUiSender(event);
    return process.platform;
  });

  // --- conversations -------------------------------------------------------
  //
  // The primary path. Note what is absent: no workspace, no permission, no
  // approval. A question does not need any of those, and asking for them is how
  // the old build turned every question into a file operation.

  ipcMain.handle('conversation:submit', async (event, raw: unknown) => {
    trustedUiSender(event);
    if (!raw || typeof raw !== 'object') throw new Error('无效输入');
    const input = raw as {
      text?: unknown;
      workspaceRoot?: unknown;
      permissionPreset?: unknown;
      executionConfig?: unknown;
      workspaceMode?: unknown;
      workspaceId?: unknown;
      taskKindOverride?: unknown;
      attachments?: unknown;
    };
    if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('先写一句你想研究或完成的事情。');
    // 规划通道是在这一步挑的，所以探活必须发生在这一步之前。
    await ensureChannelSnapshot();
    return conversations.start({
      text: input.text,
      workspaceRoot: typeof input.workspaceRoot === 'string' ? input.workspaceRoot : undefined,
      permissionPreset: typeof input.permissionPreset === 'string' ? input.permissionPreset : undefined,
      // 原样交给 runner 里的 normalizeExecutionConfig 收敛：IPC 输入不可信，
      // 非法模式一律退回默认 web，local-only 的硬约束也在那里生效。
      executionConfig:
        input.executionConfig && typeof input.executionConfig === 'object'
          ? (input.executionConfig as Record<string, unknown>)
          : undefined,
      workspaceMode: normalizeWorkspaceState({ workspaceMode: input.workspaceMode }).workspaceMode,
      // 只接受真实存在的组：消失的工作区不能悄悄挂到「未分组」之外的别处。
      workspaceId:
        typeof input.workspaceId === 'string' && workspaceList?.get(input.workspaceId)
          ? input.workspaceId
          : undefined,
      taskKindOverride:
        input.taskKindOverride === 'analysis' || input.taskKindOverride === 'execution'
          ? (input.taskKindOverride as WorkspaceTaskKind)
          : undefined,
      attachments: trustedAttachmentPaths(input.attachments)
    });
  });

  /**
   * Routing, without the side effect.
   *
   * Submitting a `workspace` sentence sends the planning prompt to a live web
   * page, and that page keeps the thread in its history forever. Anything that
   * only wants to know how a sentence would be routed — a preview in the UI, a
   * check script — must be able to ask without writing to someone's account.
   */
  ipcMain.handle('conversation:classify', (event, raw: unknown) => {
    trustedUiSender(event);
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('先写一句想做的事。');
    const intent = classifyIntent(raw);
    return { intent: intent.kind, reason: intent.reason };
  });

  ipcMain.handle('conversation:followup', async (event, raw: unknown) => {
    trustedUiSender(event);
    const input = raw as { conversationId?: unknown; text?: unknown; executionConfig?: unknown; taskKindOverride?: unknown; attachments?: unknown };
    if (typeof input.conversationId !== 'string') throw new Error('缺少对话 id');
    if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('先写一句你想追问的内容。');
    // 追问也要带上当前的研究设置：执行模式存在会话里，只按创建时那份跑的话，
    // 用户后来改成「本地主导」，追问仍然由网页主导——界面上写着本地，实际照旧。
    //
    // 附件多认一处来源：这条会话早先存下的引用。重开应用之后「引用对话中的
    // 文件」仍然能用，靠的就是它。
    const stored = conversations.get(input.conversationId)?.attachments?.map(item => item.path) ?? [];
    return conversations.followup(
      input.conversationId,
      input.text,
      input.executionConfig && typeof input.executionConfig === 'object'
        ? (input.executionConfig as Record<string, unknown>)
        : undefined,
      input.taskKindOverride === 'analysis' || input.taskKindOverride === 'execution'
        ? (input.taskKindOverride as WorkspaceTaskKind)
        : undefined,
      trustedAttachmentPaths(input.attachments, stored)
    );
  });

  /**
   * 「＋ · 添加文件」。
   *
   * 只回引用（名字、路径、体积），正文在主进程按发送那一刻的磁盘内容读。
   * 挑多了由 `referenceFiles` 截到上限：一次发六份以上，网页输入框先撑不住。
   */
  ipcMain.handle('attachment:choose', async event => {
    trustedUiSender(event);
    const result = await dialog.showOpenDialog(win!, {
      title: '选择要随这一问一起发出去的文件',
      buttonLabel: '添加',
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled || result.filePaths.length === 0) return [] as ConversationAttachment[];
    const picked = referenceFiles(result.filePaths);
    // 记下来：随后提交时只认这些路径（见 `trustedAttachmentPaths`）。
    for (const item of picked) pickedAttachments.add(item.path);
    return picked;
  });

  // --- V2.1 workspace -----------------------------------------------------
  //
  // 纯状态读写与纯路由预览。路由预览不写任何东西、不碰网页：输入框要能实时
  // 显示「这句话会被判成什么」，而不产生任何副作用。
  ipcMain.handle('workspace:get', event => {
    trustedUiSender(event);
    return workspaceStore?.get() ?? normalizeWorkspaceState(null);
  });

  ipcMain.handle('workspace:set', (event, raw: unknown) => {
    trustedUiSender(event);
    if (!workspaceStore) throw new Error('工作空间状态还没准备好');
    if (!raw || typeof raw !== 'object') throw new Error('无效的工作空间设置');
    const input = raw as { workspaceMode?: unknown; workspaceRoot?: unknown; activeWorkspaceId?: unknown };
    // 指向不存在的工作区是界面 bug，不是用户输入：宁可报错，也不假装切过去了。
    if (typeof input.activeWorkspaceId === 'string' && input.activeWorkspaceId && !workspaceList?.get(input.activeWorkspaceId)) {
      throw new Error('这个工作区已经不在了。');
    }
    return workspaceStore.set({
      ...(input.workspaceMode === 'engineering' || input.workspaceMode === 'knowledge'
        ? { workspaceMode: input.workspaceMode }
        : {}),
      ...(typeof input.workspaceRoot === 'string' ? { workspaceRoot: input.workspaceRoot.slice(0, 2000) } : {}),
      ...(typeof input.activeWorkspaceId === 'string' ? { activeWorkspaceId: input.activeWorkspaceId.slice(0, 64) } : {})
    });
  });

  // --- 工作区（多项目） ---------------------------------------------------
  //
  // 工作区只决定「会话归哪一组」和「新会话默认项目」，不授权任何目录访问：
  // 真正读写文件仍要走计划审批与 `TaskGrant`。
  ipcMain.handle('workspace:list', event => {
    trustedUiSender(event);
    return workspaceList?.all() ?? ([] as WorkspaceEntry[]);
  });

  ipcMain.handle('workspace:add', (event, raw: unknown) => {
    trustedUiSender(event);
    if (!workspaceList || !workspaceStore) throw new Error('工作区还没准备好');
    const input = (raw ?? {}) as { root?: unknown; name?: unknown };
    if (typeof input.root !== 'string' || !input.root.trim()) throw new Error('先选择一个工作区目录。');
    const result = workspaceList.add({
      root: input.root,
      ...(typeof input.name === 'string' ? { name: input.name } : {})
    });
    // 添加即切过去：用户点「＋」挑完目录，期待下一句话就在这个组里。
    workspaceStore.set({
      activeWorkspaceId: result.workspace.workspaceId,
      workspaceRoot: result.workspace.root
    });
    return { ...result, workspaces: workspaceList.all() };
  });

  ipcMain.handle('workspace:rename', (event, raw: unknown) => {
    trustedUiSender(event);
    if (!workspaceList) throw new Error('工作区还没准备好');
    const input = (raw ?? {}) as { workspaceId?: unknown; name?: unknown };
    if (typeof input.workspaceId !== 'string' || !input.workspaceId) throw new Error('缺少工作区 id');
    if (typeof input.name !== 'string') throw new Error('缺少工作区名字');
    const workspace = workspaceList.rename(input.workspaceId, input.name);
    return { workspace, workspaces: workspaceList.all() };
  });

  ipcMain.handle('workspace:remove', (event, raw: unknown) => {
    trustedUiSender(event);
    if (!workspaceList || !workspaceStore) throw new Error('工作区还没准备好');
    const input = (raw ?? {}) as { workspaceId?: unknown };
    if (typeof input.workspaceId !== 'string' || !input.workspaceId) throw new Error('缺少工作区 id');
    const removed = workspaceList.remove(input.workspaceId);
    // 会话不删，只掉出这个分组；历史一条都不能因为删一个目录名而消失。
    const clearedConversations = store?.clearConversationWorkspace(removed.workspaceId) ?? 0;
    const state = workspaceStore.get();
    if (state.activeWorkspaceId === removed.workspaceId) {
      workspaceStore.set({
        activeWorkspaceId: '',
        ...(state.workspaceRoot === removed.root ? { workspaceRoot: '' } : {})
      });
    }
    return { workspaces: workspaceList.all(), removed, clearedConversations };
  });

  ipcMain.handle('conversation:route', (event, raw: unknown) => {
    trustedUiSender(event);
    if (!raw || typeof raw !== 'object') throw new Error('无效输入');
    const input = raw as {
      text?: unknown; workspaceMode?: unknown; hasProject?: unknown; override?: unknown; attachmentCount?: unknown;
    };
    return routeTask({
      text: typeof input.text === 'string' ? input.text : '',
      workspaceMode: normalizeWorkspaceState({ workspaceMode: input.workspaceMode }).workspaceMode,
      hasProject: input.hasProject === true,
      attachmentCount: typeof input.attachmentCount === 'number' && Number.isFinite(input.attachmentCount)
        ? Math.max(0, Math.floor(input.attachmentCount))
        : 0,
      override:
        input.override === 'analysis' || input.override === 'execution'
          ? (input.override as WorkspaceTaskKind)
          : undefined
    });
  });

  ipcMain.handle('conversation:config', (event, raw: unknown) => {
    trustedUiSender(event);
    const input = raw as { conversationId?: unknown; executionConfig?: unknown };
    if (typeof input.conversationId !== 'string') throw new Error('缺少对话 id');
    if (!input.executionConfig || typeof input.executionConfig !== 'object') {
      throw new Error('缺少研究设置');
    }
    return conversations.updateExecutionConfig(
      input.conversationId,
      input.executionConfig as Record<string, unknown>
    );
  });

  ipcMain.handle('conversation:list', event => {
    trustedUiSender(event);
    return conversations.list();
  });

  ipcMain.handle('conversation:get', (event, id: unknown) => {
    trustedUiSender(event);
    if (typeof id !== 'string') throw new Error('缺少对话 id');
    return conversations.get(id);
  });

  ipcMain.handle('conversation:messages', (event, id: unknown) => {
    trustedUiSender(event);
    if (typeof id !== 'string') throw new Error('缺少对话 id');
    return conversations.messages(id);
  });

  /**
   * 轨迹与统计的原始记录。
   *
   * `totals` 从整份文件算，不受 entries 分页影响；旧会话没有轨迹文件时退回
   * 消息级时间线，并明确标 source='messages'——界面不能把只有 at 的旧记录
   * 当成完整统计。
   */
  ipcMain.handle('conversation:trace', (event, raw: unknown) => {
    trustedUiSender(event);
    const input = (raw ?? {}) as { conversationId?: unknown; beforeSeq?: unknown; limit?: unknown };
    if (typeof input.conversationId !== 'string') throw new Error('缺少对话 id');
    const conversationId = input.conversationId;
    const limit = Math.min(Math.max(Number(input.limit) || 500, 1), 2000);
    const all = traceStore.readAll(conversationId);
    if (all.length > 0) {
      const page = traceStore.read(conversationId, {
        ...(typeof input.beforeSeq === 'number' && Number.isFinite(input.beforeSeq)
          ? { beforeSeq: input.beforeSeq }
          : {}),
        limit
      });
      return {
        ...page,
        source: 'trace' as const,
        totals: aggregateTotals(foldTrace(all))
      };
    }
    const fallback = traceFromMessages(
      store.getConversation(conversationId),
      store.listMessages(conversationId)
    );
    return {
      entries: fallback.entries.slice(-limit),
      hasMore: fallback.entries.length > limit,
      source: 'messages' as const,
      totals: aggregateTotals(foldTrace(fallback.entries))
    };
  });

  ipcMain.handle('conversation:cancel', (event, id: unknown) => {
    trustedUiSender(event);
    if (typeof id !== 'string') throw new Error('缺少对话 id');
    conversations.cancel(id);
  });

  ipcMain.handle('conversation:delete', async (event, id: unknown) => {
    trustedUiSender(event);
    if (typeof id !== 'string') throw new Error('缺少对话 id');
    // The row disappears first and the pages are cleaned after: a site that
    // will not give up its copy must not make the delete look like it did
    // nothing. What could not be cleaned comes back in `failed`, so the caller
    // can say which thread is still there.
    const outcome = await conversations.delete(id);
    // Deletion is silent otherwise: the store loses the row while every open
    // list keeps showing it, which looks like the delete button did nothing.
    emitConversation({ type: 'conversation.deleted', at: Date.now(), conversationId: id });
    return outcome;
  });

  /**
   * 会话导出走内置插件 `document.export`。内容全部来自主进程自己存的会话与
   * 消息，所以导出的字和界面上看到的一致；插件停用时注册表会明确报错。
   */
  ipcMain.handle('document:export', async (event, raw: unknown) => {
    trustedUiSender(event);
    const input = raw as ExportConversationInput | undefined;
    if (!input || typeof input.conversationId !== 'string') throw new Error('缺少对话 id');
    return mainCapabilities.execute('document.export', input, capabilityContext);
  });

  /** 设置页「内置插件」看到的是同一份清单，不是界面自己抄的一串名字。 */
  ipcMain.handle('capabilities:list', event => {
    trustedUiSender(event);
    return describeCapabilities(disabledCapabilities(), [
      ...mainCapabilities.ids(),
      ...RUNTIME_CAPABILITY_IDS
    ]);
  });

  /** 开关落盘，并同步给主进程注册表；Runtime 在下次执行时收到。 */
  ipcMain.handle('capabilities:set', (event, raw: unknown) => {
    trustedUiSender(event);
    const input = raw as { id?: unknown; enabled?: unknown } | null;
    if (!input || typeof input.id !== 'string' || typeof input.enabled !== 'boolean') {
      throw new Error('开关参数无效');
    }
    if (!capabilityStore) throw new Error('插件开关还没初始化');
    const disabled = capabilityStore.setEnabled(input.id, input.enabled);
    setDisabledCapabilities(disabled);
    return describeCapabilities(disabledCapabilities(), [
      ...mainCapabilities.ids(),
      ...RUNTIME_CAPABILITY_IDS
    ]);
  });

  /**
   * 设置页「专家与技能」看到的是磁盘上真实读到的两份文件，不是界面抄的名单。
   * 用户替换了 md、或者把文件写坏了，这里立刻能看到来源与原因。
   */
  ipcMain.handle('expertise:list', event => {
    trustedUiSender(event);
    const { state, disabled } = currentExpertise();
    return describeExpertise(state, disabled);
  });

  ipcMain.handle('expertise:set', (event, raw: unknown) => {
    trustedUiSender(event);
    const input = raw as { id?: unknown; enabled?: unknown } | null;
    if (!input || typeof input.id !== 'string' || typeof input.enabled !== 'boolean') {
      throw new Error('开关参数无效');
    }
    if (!expertiseStore) throw new Error('专家与技能开关还没初始化');
    expertiseStore.setEnabled(input.id, input.enabled);
    const { state, disabled } = currentExpertise();
    return describeExpertise(state, disabled);
  });

  ipcMain.handle('channel:statuses', async event => {
    trustedUiSender(event);
    return registry.statuses();
  });
  ipcMain.handle('deepseek:status', async event => {
    trustedUiSender(event);
    return planningAdapter().getStatus();
  });

  ipcMain.handle('deepseek:diagnose', async (event, sourceId: unknown) => {
    trustedUiSender(event);
    const source = diagnosedSource(sourceId);
    const report = await adapterFor(source?.id ?? 'deepseek').diagnose();
    // The page is a native view, so its position is only knowable here. When
    // the two panes disagree, this is the number that settles it.
    return {
      ...report,
      sourceId: source?.id,
      view: source ? (views.get(source.id)?.getBounds() ?? null) : null,
      dragging: draggingPage
    } satisfies DeepSeekDiagnostics;
  });


  /**
   * 研究设置的跨会话默认值。
   *
   * 和某一条会话上的 `executionConfig` 是两份：会话那份跟着线程走；这份是
   * 「新对话 / 重启之后还用什么」。云端参与默认空数组，主导人默认不点名——
   * 用户勾了、点了才写进盘。
   */
  ipcMain.handle('app:execution-defaults', event => {
    trustedUiSender(event);
    return executionDefaults?.get() ?? { ...DEFAULT_EXECUTION_CONFIG };
  });

  ipcMain.handle('app:set-execution-defaults', (event, raw: unknown) => {
    trustedUiSender(event);
    if (!executionDefaults) throw new Error('设置还没有准备好');
    if (!raw || typeof raw !== 'object') throw new Error('无效输入');
    return executionDefaults.set(raw as Partial<ConversationExecutionConfig>);
  });

  /** 设置页 / 新建对话用的选项。绝不包含 API Key 明文或密文。 */
  ipcMain.handle('app:execution-options', async event => {
    trustedUiSender(event);
    return {
      modes: ['web', 'local', 'cloud', 'hybrid'] as const,
      webChannels: registry.list().map(agent => ({ id: agent.id, label: agent.label })),
      localModels,
      // 每个「服务 + 模型」是一个成员：同名模型在不同服务上是两件事，
      // 用裸模型名当 id 会勾一个等于勾两家。
      cloudMembers: cloudCatalog.flatMap(item =>
        item.models.map(model => ({
          id: `${item.id}:${model}`,
          label: `${item.label} · ${model}`,
          hasKey: apiKeys?.has(item.id) ?? false
        }))
      ),
      cloudProviders: cloudCatalog.map(item => ({
        id: item.id,
        label: item.label,
        baseUrl: item.baseUrl,
        models: item.models,
        // 未勾选的候选也要给界面：没有它，「选择模型」只能列已选的那几条，
        // 用户想加回来一个模型都没有入口。
        catalog: cloudCandidates(item.id),
        note: item.note,
        hasKey: apiKeys?.has(item.id) ?? false,
        // 清单是不是从网关 `/models` 拿回来的。界面靠它决定「打开设置时还要
        // 不要顺手再问一次」，而不是每次都发一遍请求。
        modelsDiscovered: cloudConfigs?.get(item.id)?.modelsFromGateway === true,
        // 「能不能整个删掉」：内置三条不行（它们是默认锚点），目录项与自定义都可以。
        custom: !CLOUD_PRESETS.some(preset => preset.id === item.id)
      })),
      providerCatalog: PROVIDER_CATALOG.map(entry => ({
        id: entry.id,
        label: entry.label,
        baseUrl: entry.baseUrl,
        models: [...entry.models],
        note: entry.note,
        custom: entry.custom
      })),
      providers: providerRegistry.list().map(provider => ({
        id: provider.id,
        label: provider.label,
        type: provider.type,
        hasKey: apiKeys?.has(provider.id) ?? false
      })),
      debateCandidates: await debateCandidates()
    };
  });

  ipcMain.handle('app:set-api-key', async (event, raw: unknown) => {
    trustedUiSender(event);
    if (!apiKeys) throw new Error('设置还没有准备好');
    if (!raw || typeof raw !== 'object') throw new Error('无效输入');
    const input = raw as { id?: unknown; key?: unknown };
    if (typeof input.id !== 'string' || !input.id.trim() || typeof input.key !== 'string') {
      throw new Error('无效输入');
    }
    const key = input.key.trim();
    apiKeys.set(input.id, key);
    /**
     * Key 存下之后顺手问一次 `/models`，把这家真实有哪些模型拿回来。
     *
     * 这是「模型名不该由界面自己填」的落点：配好凭据就该看到网关的清单，
     * 而不是我们预设的六条。拿不到不算保存失败——Key 已经写进密文库了，
     * 只是让界面如实说一句，并保留原清单，不拿预设名字冒充网关答案。
     */
    let models: string[] | undefined;
    let selected: string[] | undefined;
    let modelNote: string | undefined;
    const service = cloudCatalog.find(item => item.id === input.id);
    if (service) {
      try {
        models = await discoverModelsFrom(service.baseUrl, key);
        if (models.length > 0) selected = recordDiscoveredModels(service.id, models);
      } catch (error) {
        modelNote = error instanceof Error ? error.message : String(error);
      }
    }
    rebuildProviders();
    const resolved = cloudCatalog.find(item => item.id === input.id);
    return {
      id: input.id,
      configured: true,
      models: selected ?? resolved?.models ?? models ?? [],
      catalog: models ?? (input.id ? cloudCandidates(input.id) : []),
      ...(modelNote ? { modelNote } : {})
    };
  });

  /**
   * 改云端服务的 baseUrl / 模型列表。Key 不在这里——它只走 set-api-key，
   * 两件事分开，读配置不需要解密。
   */
  ipcMain.handle('app:set-cloud-config', (event, raw: unknown) => {
    trustedUiSender(event);
    if (!cloudConfigs) throw new Error('设置还没有准备好');
    if (!raw || typeof raw !== 'object') throw new Error('无效输入');
    const input = raw as { id?: unknown; baseUrl?: unknown; models?: unknown };
    if (typeof input.id !== 'string' || (!presetOf(input.id) && !isUserProvider(input.id))) throw new Error('未知的云端服务');
    const patch: { baseUrl?: string; models?: string[]; modelsFromGateway?: boolean } = {};
    if (input.baseUrl !== undefined) {
      if (typeof input.baseUrl !== 'string' || !/^https?:\/\//.test(input.baseUrl.trim())) {
        throw new Error('baseUrl 必须是 http(s) 地址');
      }
      patch.baseUrl = input.baseUrl.trim();
    }
    if (input.models !== undefined) {
      const models = normalizeModels(input.models);
      if (models.length === 0) throw new Error('至少保留一个模型');
      patch.models = models;
      // 手写进来的清单不是网关给的，界面不能标成「来自网关 /models」。
      patch.modelsFromGateway = false;
    }
    cloudConfigs.set(input.id, patch);
    rebuildProviders();
    const resolved = cloudCatalog.find(item => item.id === input.id);
    return resolved
      ? {
          id: resolved.id,
          label: resolved.label,
          baseUrl: resolved.baseUrl,
          models: resolved.models,
          catalog: cloudCandidates(resolved.id),
          note: resolved.note,
          hasKey: apiKeys?.has(resolved.id) ?? false,
          modelsDiscovered: cloudConfigs.get(resolved.id)?.modelsFromGateway === true,
          custom: !CLOUD_PRESETS.some(preset => preset.id === resolved.id)
        }
      : { id: input.id, label: input.id, baseUrl: patch.baseUrl ?? '', models: patch.models ?? [], hasKey: false };
  });

  /**
   * 「选择模型」：从完整候选里勾出这一问要用的子集。
   *
   * 与 `app:set-cloud-config` 分开，是因为来源不同：那条路是手写清单，这条
   * 路勾的就是网关报过的模型。混成一条会把「来自网关 /models」标成手写，
   * 下次启动又会把用户的勾选覆盖成整张清单。
   */
  ipcMain.handle('app:set-cloud-models', (event, raw: unknown) => {
    trustedUiSender(event);
    if (!cloudConfigs) throw new Error('设置还没有准备好');
    if (!raw || typeof raw !== 'object') throw new Error('无效输入');
    const input = raw as { id?: unknown; models?: unknown };
    if (typeof input.id !== 'string' || (!presetOf(input.id) && !isUserProvider(input.id) && !catalogEntryOf(input.id))) {
      throw new Error('未知的云端服务');
    }
    const models = normalizeModels(input.models);
    if (models.length === 0) throw new Error('至少保留一个模型');
    const candidates = new Set(cloudCandidates(input.id));
    const unknown = models.filter(model => !candidates.has(model));
    if (unknown.length > 0) throw new Error(`候选里没有这些模型：${unknown.join('、')}`);
    cloudConfigs.set(input.id, { models, modelsPicked: true });
    rebuildProviders();
    // 池子缩了，默认研究设置里挂着的旧成员也要裁掉——否则下次新对话仍按旧勾选提问。
    if (executionDefaults) {
      const defaults = executionDefaults.get();
      const pruned = pruneCloudParticipantsForProvider(
        defaults.selectedCloudModels,
        defaults.leadAgentId,
        input.id,
        models
      );
      if (pruned.changed) {
        const next = normalizeExecutionConfig({
          ...defaults,
          ...(pruned.selectedCloudModels ? { selectedCloudModels: pruned.selectedCloudModels } : {}),
          ...(pruned.clearLead ? { leadAgentId: undefined } : {})
        });
        if (pruned.clearLead) delete next.leadAgentId;
        executionDefaults.set(next);
      }
    }
    const resolved = cloudCatalog.find(item => item.id === input.id);
    if (!resolved) throw new Error('未知的云端服务');
    return {
      id: resolved.id,
      label: resolved.label,
      baseUrl: resolved.baseUrl,
      models: resolved.models,
      catalog: cloudCandidates(resolved.id),
      note: resolved.note,
      hasKey: apiKeys?.has(resolved.id) ?? false,
      modelsDiscovered: cloudConfigs.get(resolved.id)?.modelsFromGateway === true,
      custom: !CLOUD_PRESETS.some(preset => preset.id === resolved.id)
    };
  });

  ipcMain.handle('app:remove-api-key', (event, id: unknown) => {
    trustedUiSender(event);
    if (!apiKeys || typeof id !== 'string') throw new Error('无效输入');
    apiKeys.remove(id);
    rebuildProviders();
    return { id, configured: false };
  });

  /**
   * 添加一个云端服务（从目录挑一家，或自定义 OpenAI 兼容端点）。
   *
   * 与「导入配置」的区别：Key 与端点分两个文件存（Key 进密文库，端点进
   * 明文配置），这一条只是把两件事按顺序做一次，任何一步失败都不留下
   * 半个服务——所以先在内存里校验完，再落盘。
   */
  ipcMain.handle('app:cloud-add', async (event, raw: unknown) => {
    trustedUiSender(event);
    if (!cloudConfigs || !apiKeys || !raw || typeof raw !== 'object') throw new Error('设置还没有准备好');
    const input = raw as {
      catalogId?: unknown;
      label?: unknown;
      baseUrl?: unknown;
      models?: unknown;
      key?: unknown;
    };
    const entry = typeof input.catalogId === 'string' ? catalogEntryOf(input.catalogId) : undefined;
    if (!entry) throw new Error('未知的云端服务');

    const baseUrl = (typeof input.baseUrl === 'string' ? input.baseUrl.trim().replace(/\/+$/, '') : '') || entry.baseUrl;
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('端点必须是 http(s) 地址，例如 https://api.example.com/v1');

    const key = typeof input.key === 'string' ? input.key.trim() : '';
    const models = normalizeModels(input.models);
    let finalModels = models.length > 0 ? models : [...entry.models];
    // 界面带来的清单要么是它刚向网关要到的，要么是目录默认值。前者标成
    // 「来自网关」，后者不能冒充。
    let modelsFromGateway = models.length > 0;
    // 没带清单就向网关要一次。要不到也不拦添加——服务下一条 Key 保存或下次
    // 启动还会再问，清单空着只是暂时没成员。
    if (finalModels.length === 0 && key) {
      try {
        finalModels = await discoverModelsFrom(baseUrl, key);
        modelsFromGateway = finalModels.length > 0;
      } catch {
        finalModels = [];
      }
    }

    const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim() : entry.label;
    const taken = new Set(cloudCatalog.map(item => item.id));
    const id = entry.custom ? userProviderId(label, taken) : entry.id;
    if (!entry.custom && taken.has(id)) throw new Error(`${entry.label} 已经在列表里，直接填 Key 就行`);

    const record = { baseUrl, models: finalModels, catalog: finalModels, modelsFromGateway };
    if (entry.custom) cloudConfigs.set(id, { ...record, label });
    else cloudConfigs.set(id, record);
    if (key) apiKeys.set(id, key);
    rebuildProviders();
    const resolved = cloudCatalog.find(item => item.id === id);
    return resolved
      ? {
          id: resolved.id,
          label: resolved.label,
          baseUrl: resolved.baseUrl,
          models: resolved.models,
          catalog: cloudCandidates(resolved.id),
          note: resolved.note,
          hasKey: apiKeys.has(resolved.id),
          modelsDiscovered: cloudConfigs.get(resolved.id)?.modelsFromGateway === true,
          custom: !CLOUD_PRESETS.some(preset => preset.id === resolved.id)
        }
      : { id, label, baseUrl, models: finalModels, catalog: finalModels, hasKey: apiKeys.has(id), custom: true };
  });

  /** 删掉用户加的服务（目录项或自定义）。内置三条只能清 Key——删掉就没有「恢复默认」的锚点了。 */
  ipcMain.handle('app:cloud-remove', (event, id: unknown) => {
    trustedUiSender(event);
    if (!cloudConfigs || !apiKeys || typeof id !== 'string') throw new Error('无效输入');
    if (CLOUD_PRESETS.some(preset => preset.id === id)) throw new Error('内置服务不能删除，只能清空 Key');
    if (!isUserProvider(id) && !catalogEntryOf(id)) throw new Error('未知的云端服务');
    cloudConfigs.remove(id);
    apiKeys.remove(id);
    rebuildProviders();
    return { id, removed: true };
  });

  /**
   * 从 `/models` 读真实模型清单。
   *
   * 各家返回结构不统一，这里只认 OpenAI 的 `{ data: [{ id }] }`——认不出就
   * 明确报错，而不是返回空数组让界面以为「这家没有模型」。Key 优先用输入框
   * 里还没保存的那个，其次用已存的。
   */
  ipcMain.handle('app:cloud-discover', async (event, raw: unknown) => {
    trustedUiSender(event);
    if (!raw || typeof raw !== 'object') throw new Error('无效输入');
    const input = raw as { baseUrl?: unknown; key?: unknown; id?: unknown };
    const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim().replace(/\/+$/, '') : '';
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('先填端点，再获取模型');
    const key =
      (typeof input.key === 'string' && input.key.trim()) ||
      (typeof input.id === 'string' && apiKeys?.get(input.id)) ||
      '';
    if (!key) throw new Error('先填 API Key，再获取模型');
    const models = await discoverModelsFrom(baseUrl, key);
    // 带服务 id 来的调用（设置里点「重新获取」）就是要把清单记下来：只回给界面
    // 不落盘，下次打开又得再问一遍，界面也会一直停在「还没从网关读到」。
    // 记的时候只更新 `catalog`，不覆盖用户挑过的 `models`——「重新获取」是
    // 刷新候选，不是替用户重新勾一遍。
    let selected: string[] | undefined;
    if (typeof input.id === 'string' && models.length > 0) {
      selected = recordDiscoveredModels(input.id, models);
      rebuildProviders();
    }
    return { models, ...(selected ? { selected } : {}) };
  });

  ipcMain.handle('app:provider-health', async event => {
    trustedUiSender(event);
    return providerRegistry.health();
  });

  /** Phase F：最近一轮每个子任务的独立执行记录。 */
  ipcMain.handle('app:collaboration', event => {
    trustedUiSender(event);
    return collaborationRecords;
  });

  ipcMain.handle('debate:start', async (event, raw: unknown) => {
    trustedUiSender(event);
    if (!debates || !raw || typeof raw !== 'object') throw new Error('辩论还没有准备好');
    const input = raw as {
      question?: unknown;
      config?: unknown;
      conversationId?: unknown;
      workspaceMode?: unknown;
      workspaceId?: unknown;
      workspaceRoot?: unknown;
    };
    if (typeof input.question !== 'string' || !input.question.trim()) throw new Error('先写一句要辩论的问题');
    const question = input.question.trim();
    const rawConfig = (input.config ?? {}) as Record<string, unknown>;
    const requestedId = typeof input.conversationId === 'string' ? input.conversationId : undefined;
    let conversation = requestedId ? store.getConversation(requestedId) : null;
    // 正在回答的会话不接辩论：两条流同时往一个会话里写，界面上分不清哪句是
    // 哪一轮，结束后还会互相覆盖状态。
    if (conversation && ['thinking', 'collecting', 'comparing', 'synthesizing'].includes(conversation.status)) {
      throw new Error('这条会话还在回答，等它结束后再发起辩论');
    }
    // 同一会话里同时跑两场辩论：两条时间线会往同一份轨迹里交叉写，界面上
    // 也分不清哪个发言属于哪一场。前一场结束（或停止）后再开。
    if (conversation && debates.list().some(item => item.conversationId === conversation!.conversationId && item.status === 'running')) {
      throw new Error('这条会话里还有一场辩论在跑，等它结束后再发起');
    }
    const selected = Array.isArray(rawConfig.participants) && rawConfig.participants.length > 0
      ? rawConfig.participants.filter((id): id is string => typeof id === 'string')
      : undefined;
    const plan = planLead({
      mode: normalizeLeadMode(rawConfig.leadMode),
      strategy: normalizeDebateConfig(rawConfig).strategy,
      // 本地模型可以参辩：本地/离网主导靠它给基准观点，网页/混合模式靠它做
      // 交叉质疑。它只是不算会话「来源」，在辩论里是合法的发言成员。三种
      // 主导方式都不依赖云端 API，云端只是可选成员。
      candidates: await debateCandidates(),
      selected,
      leadAgentId: typeof rawConfig.leadAgentId === 'string' ? rawConfig.leadAgentId : undefined
    });
    // 网页成员要提问就得先给页面一个干净的会话：否则会追进用户正在看的
    // 那条对话里，测试题混进历史，事后也无法按 threadUrl 精确删除。
    for (const agentId of plan.webOnly) {
      try { await registry.newConversation(agentId); } catch { /* 页面没准备好时由 ask 如实报错 */ }
    }
    // 直接辩论也走回答界面：没有会话就新开一条，有会话就作为新的一轮追加。
    const at = Date.now();
    if (!conversation) {
      // 会话按空间分组：工程空间里起的辩论也要挂回那条工作区，否则侧栏
      // 按空间过滤时它直接消失，用户只能靠「当前会话」这一个入口再看到。
      const workspaceMode = input.workspaceMode === 'engineering' ? 'engineering' as const : undefined;
      const workspaceId = workspaceMode && typeof input.workspaceId === 'string' && workspaceList?.get(input.workspaceId)
        ? input.workspaceId
        : undefined;
      const workspaceRoot = workspaceMode && typeof input.workspaceRoot === 'string'
        ? input.workspaceRoot
        : undefined;
      conversation = {
        conversationId: randomUUID(),
        title: question.slice(0, 42),
        intent: 'answer',
        intentReason: '直接辩论：跳过第一轮回答与汇总，只跑交锋与裁决',
        debateOnly: true,
        status: 'answered',
        channels: [],
        createdAt: at,
        updatedAt: at,
        executionConfig: executionDefaults?.get() ?? { ...DEFAULT_EXECUTION_CONFIG },
        ...(workspaceMode
          ? {
              workspaceMode,
              ...(workspaceRoot ? { workspaceRoot } : {}),
              ...(workspaceId ? { workspaceId } : {})
            }
          : {})
      };
      store.upsertConversation(conversation);
      emitConversation({ type: 'conversation.created', at, conversation });
    }
    const userMessage: ConversationMessage = {
      messageId: randomUUID(),
      conversationId: conversation.conversationId,
      role: 'user',
      text: question,
      at
    };
    store.appendMessage(userMessage);
    emitConversation({ type: 'message.added', at, message: userMessage });
    const state = debates.start(question, rawConfig, conversation.conversationId, plan, 'manual');
    watchDebateInConversation(state.debateId, conversation.conversationId);
    return state;
  });

  ipcMain.handle('debate:get', (event, id: unknown) => {
    trustedUiSender(event);
    if (!debates || typeof id !== 'string') throw new Error('无效输入');
    return debates.get(id);
  });

  ipcMain.handle('debate:list', event => {
    trustedUiSender(event);
    // 「历史辩论」只列用户自己发起的。会话里自动发起的和工程计划评审的
    // 已经在各自会话 / 计划里显示过；混进这份清单会被误读成用户问过这些题。
    return (debates?.list() ?? []).filter(item => debateOriginOf(item) === 'manual');
  });

  /**
   * 相似的历史辩论（Phase 5）。只读：界面拿它提示「这个问题以前辩过」，
   * 要不要复用由人决定。自动跳过会把「旧结论」当成「新结论」。
   */
  ipcMain.handle('debate:related', (event, raw: unknown) => {
    trustedUiSender(event);
    if (!debates || !raw || typeof raw !== 'object') return [];
    const input = raw as { question?: unknown; exclude?: unknown };
    if (typeof input.question !== 'string' || !input.question.trim()) return [];
    // 只拿用户自己发起过的辩论做「以前辩过」的提示：会话内自动辩论的题
    // 往往是上一轮问题的衍生，计划评审更是内部材料，拿来提示只会误导。
    return relatedDebates(
      debates.list().filter(item => debateOriginOf(item) === 'manual'),
      input.question,
      {
        exclude: typeof input.exclude === 'string' ? input.exclude : undefined
      }
    );
  });

  ipcMain.handle('debate:stop', (event, id: unknown) => {
    trustedUiSender(event);
    if (!debates || typeof id !== 'string') throw new Error('无效输入');
    return debates.stop(id);
  });

  ipcMain.handle('debate:resume', (event, id: unknown) => {
    trustedUiSender(event);
    if (!debates || typeof id !== 'string') throw new Error('无效输入');
    return debates.resume(id);
  });

  /**
   * 清理某场辩论在网页侧留下的会话。辩论是独立子系统，不往 Conversation
   * 登记，所以不能用 deleteConversation；地址存在每条发言的 threadUrl 上。
   * 没有地址的成员会如实列在 noAddress 里，不假装已经删掉。
   */
  ipcMain.handle('debate:cleanup-web', async (event, debateId: unknown) => {
    trustedUiSender(event);
    if (!debates || typeof debateId !== 'string') throw new Error('无效输入');
    const state = debates.get(debateId);
    if (!state) throw new Error('找不到这场辩论');
    const webIds = state.plan.webOnly;
    const addresses = new Map<string, string>();
    for (const round of state.rounds) {
      for (const message of round.messages) {
        if (message.threadUrl && webIds.includes(message.agentId)) {
          addresses.set(message.agentId, message.threadUrl);
        }
      }
    }
    const cleaned: string[] = [];
    const reset: string[] = [];
    const failed: Array<{ agentId: string; detail: string }> = [];
    for (const agentId of webIds) {
      const threadUrl = addresses.get(agentId);
      if (threadUrl) {
        try {
          const result = await registry.deleteConversation(agentId, threadUrl);
          if (result.ok) cleaned.push(agentId);
          else failed.push({ agentId, detail: result.detail ?? '网页侧删除失败' });
        } catch (error) {
          failed.push({ agentId, detail: error instanceof Error ? error.message : String(error) });
        }
      }
      try {
        const moved = await registry.newConversation(agentId);
        if (moved.ok) reset.push(agentId);
      } catch { /* 页面暂时不可用，下一轮 reset 会再试 */ }
    }
    return {
      cleaned, reset, failed,
      noAddress: webIds.filter(id => !addresses.has(id))
    };
  });

  /** 删除一场辩论的本地记录。正在跑的不让删，避免后台 run 又写回来。 */
  ipcMain.handle('debate:remove', (event, debateId: unknown) => {
    trustedUiSender(event);
    if (!debates || typeof debateId !== 'string') throw new Error('无效输入');
    const state = debates.get(debateId);
    if (state?.status === 'running') throw new Error('先停止这场辩论再删除');
    debates.remove(debateId);
    return { id: debateId, removed: true };
  });

  ipcMain.handle('judge:adjudicate', async (event, debateId: unknown) => {
    trustedUiSender(event);
    if (!debates || !verdicts || typeof debateId !== 'string') throw new Error('裁决还没有准备好');
    const state = debates.get(debateId);
    if (!state) throw new Error('找不到这场辩论');

    // 裁决模型每次现选，不在启动时定死：用户可能刚配好 Key、刚改完模型名。
    // 优先选**没参加这一场**的成员（本地或云端都行），它不参辩、天然独立；
    // 全都在参辩时按决策 5 允许兼任，但必须标 sharedWith，让人知道它既当
    // 运动员又当裁判。
    const askAgent = (agentId: string, task: Parameters<ProviderBackedSubAgent['ask']>[0]) => {
      const extra = extraAgents.find(agent => agent.id === agentId);
      return extra ? extra.ask(task) : registry.ask(agentId, task);
    };
    const all = await debateCandidates();
    const usable = all.filter(item => item.available && (item.type === 'local' || item.type === 'cloud'));
    const independent = usable.find(item => !state.plan.participants.includes(item.id));
    const pick = independent ?? usable[0];
    const engine = new JudgeEngine(pick ? {
      ask: askAgent,
      judgeAgentId: pick.id,
      sharedWith: state.plan.participants.includes(pick.id) ? pick.id : undefined
    } : {});
    const verdict = await engine.judge(state);
    verdicts.save(verdict);
    if (state.conversationId) verdictByConversation.set(state.conversationId, verdict);
    return verdict;
  });

  ipcMain.handle('judge:get', (event, debateId: unknown) => {
    trustedUiSender(event);
    if (!verdicts || typeof debateId !== 'string') throw new Error('无效输入');
    return verdicts.get(debateId);
  });

  /** 预算统计：多云端 Provider 的用量合并；一个都没配时返回 null。 */
  ipcMain.handle('app:usage', event => {
    trustedUiSender(event);
    return mergedUsage();
  });

  ipcMain.handle('app:sources', event => {
    trustedUiSender(event);
    return sourcesState();
  });

  ipcMain.handle('app:set-source', (event, id: unknown) => {
    trustedUiSender(event);
    if (typeof id !== 'string' || !sourceById(sources, id)) throw new Error('未知来源');
    activateSource(id);
    return sourcesState();
  });

  // 设置 · 模型. One source, one edit: the URL, whether it is on, or both.
  ipcMain.handle('sources:save', (event, raw: unknown) => {
    trustedUiSender(event);
    return saveSource(raw);
  });

  // 联网搜索的凭据。三个通道都在主进程校验：渲染进程只能提议，不能直接写盘。
  ipcMain.handle('search:get', (event) => {
    trustedUiSender(event);
    return viewSearchSettings();
  });

  ipcMain.handle('search:save', (event, raw: unknown) => {
    trustedUiSender(event);
    return saveSearchSettings(sanitizeSearchPatch(raw));
  });

  ipcMain.handle('search:test', (event, raw: unknown) => {
    trustedUiSender(event);
    return runSearchTest(sanitizeSearchPatch(raw));
  });

  ipcMain.handle('sources:add', (event, raw: unknown) => {
    trustedUiSender(event);
    return addSource(raw);
  });

  ipcMain.handle('sources:remove', (event, raw: unknown) => {
    trustedUiSender(event);
    return removeSource(raw);
  });

  ipcMain.handle('sources:set-open-on-launch', (event, raw: unknown) => {
    trustedUiSender(event);
    return setSourcesOpenOnLaunch(raw);
  });

  // 「刷新」. Not routed through `sources:save`: nothing is being saved, and a
  // reload that looks like an edit would make the settings panel think the URL
  // changed.
  ipcMain.handle('page:reload', (event, raw: unknown) => {
    trustedUiSender(event);
    return reloadPage(raw);
  });

  ipcMain.handle('app:identity', event => {
    trustedUiSender(event);
    return identity();
  });

  // An empty string is not a rejected name: it is 「恢复默认」, and the panel says
  // so next to the button. The reply is the identity after normalization, so the
  // renderer shows what was actually stored rather than what was typed.
  ipcMain.handle('app:set-name', (event, raw: unknown) => {
    trustedUiSender(event);
    if (!profileStore) throw new Error('设置还没有准备好');
    if (raw === '') profileStore.reset();
    else profileStore.setDisplayName(raw);
    return identity();
  });

  // ---------------------------------------------------------------- page pane
  ipcMain.handle('page:state', event => {
    trustedUiSender(event);
    return pageState();
  });

  // 「放大」. Pulls the page into its own window; the reply is the new state so
  // the button can flip without waiting for the event.
  ipcMain.handle('page:detach', (event, raw: unknown) => {
    trustedUiSender(event);
    const id = typeof raw === 'string' && sourceById(sources, raw) ? raw : activeSourceId;
    return detachSource(id);
  });

  // 「吸附回去」, and also what happens when the detached window is closed.
  ipcMain.handle('page:reattach', event => {
    trustedUiSender(event);
    return reattachSource();
  });

  // 「收起」/「展开」. The page keeps running while folded — this only stops
  // painting it and gives the width back to the app column.
  ipcMain.handle('page:set-collapsed', (event, raw: unknown) => {
    trustedUiSender(event);
    return setCollapsed(raw === true);
  });

  // 「更新样式」. Deliberately explicit: it runs three scripts in the page and
  // writes to disk, so it must never fire as a side effect of a poll.
  ipcMain.handle('page:learn-selectors', async (event, raw: unknown) => {
    trustedUiSender(event);
    const id = typeof raw === 'string' && sourceById(sources, raw) ? raw : activeSourceId;
    return learnSelectorsFor(id);
  });

  /**
   * 「保存网页对话」的勾选列表。只读：不写盘、不弹对话框。
   *
   * 内容是页面当场显示的助手回答；界面拿它画多选列表，保存时只回传下标，
   * 正文仍然由 `page:save-document` 重新读一次页面。
   */
  ipcMain.handle('embedding:status', event => {
    trustedUiSender(event);
    return embeddingService?.status() ?? { ollama: { available: false, models: [] }, openai: { configured: false, detail: 'embedding 未初始化' } };
  });

  ipcMain.handle('embedding:embed', async (event, raw: unknown) => {
    trustedUiSender(event);
    if (!embeddingService) throw new Error('embedding 未初始化');
    if (!raw || typeof raw !== 'object') throw new Error('无效输入');
    return embeddingService.embed(raw as never);
  });

  ipcMain.handle('code-index:status', async (event, root: unknown) => {
    trustedUiSender(event);
    if (typeof root !== 'string' || !root.trim()) throw new Error('代码索引需要工作区路径');
    if (!codeIndexService) throw new Error('代码索引未初始化');
    return codeIndexService.summary(root);
  });

  ipcMain.handle('code-index:build', async (event, root: unknown) => {
    trustedUiSender(event);
    if (typeof root !== 'string' || !root.trim()) throw new Error('代码索引需要工作区路径');
    if (!codeIndexService) throw new Error('代码索引未初始化');
    await codeIndexService.index(root);
    return codeIndexService.summary(root);
  });

  ipcMain.handle('code-intelligence:get', (event) => {
    trustedUiSender(event);
    return {
      ...codeIntelligenceConfig,
      passwordConfigured: apiKeys?.has('code-intelligence') ?? false
    };
  });

  ipcMain.handle('code-intelligence:set', (event, raw: unknown) => {
    trustedUiSender(event);
    if (!raw || typeof raw !== 'object') throw new Error('无效输入');
    if (!codeIntelligenceConfigStore) throw new Error('工程智能配置未初始化');
    const patch = raw as CodeIntelligencePatch;
    if (patch.password !== undefined) {
      if (patch.password === '') apiKeys?.remove('code-intelligence');
      else apiKeys?.set('code-intelligence', patch.password);
    }
    codeIntelligenceConfig = codeIntelligenceConfigStore.save(patch, codeIntelligenceConfig);
    codeIntelligenceConfig.passwordConfigured = apiKeys?.has('code-intelligence') ?? false;
    codeIndexService?.setExternal(buildCodeIntelligenceExternal(codeIntelligenceConfig));
    return codeIntelligenceConfig;
  });

  ipcMain.handle('code-intelligence:test', async (event): Promise<CodeIntelligenceStatus> => {
    trustedUiSender(event);
    const url = process.env.THINKFUSION_NEO4J_HTTP ?? (codeIntelligenceConfig.mode === 'external' ? codeIntelligenceConfig.neo4jUrl : '');
    if (!url) {
      return {
        configured: false,
        mode: codeIntelligenceConfig.mode,
        cgc: 'disabled',
        graphiti: 'disabled',
        detail: '本地回退模式：没有配置外部 Neo4j 地址',
        lastCheckedAt: Date.now()
      };
    }
    const client = new Neo4jHttpClient({
      baseUrl: url,
      user: process.env.THINKFUSION_NEO4J_USER ?? codeIntelligenceConfig.neo4jUser,
      password: process.env.THINKFUSION_NEO4J_PASSWORD ?? apiKeys?.get('code-intelligence') ?? ''
    });
    try {
      await client.query('RETURN 1 AS ok');
    } catch (error) {
      return {
        configured: true,
        mode: codeIntelligenceConfig.mode,
        cgc: 'error',
        graphiti: 'error',
        detail: error instanceof Error ? error.message : String(error),
        lastCheckedAt: Date.now()
      };
    }
    let cgc: CodeIntelligenceStatus['cgc'] = codeIntelligenceConfig.cgcEnabled ? 'error' : 'disabled';
    let graphiti: CodeIntelligenceStatus['graphiti'] = codeIntelligenceConfig.graphitiEnabled ? 'error' : 'disabled';
    const details: string[] = [];
    if (codeIntelligenceConfig.cgcEnabled) {
      try {
        await client.query('MATCH (r:Repository) RETURN count(r) AS n');
        cgc = 'ready';
      } catch (error) {
        details.push(`CGC: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (codeIntelligenceConfig.graphitiEnabled) {
      try {
        await client.query('MATCH (e:Episodic) RETURN count(e) AS n');
        graphiti = 'ready';
      } catch (error) {
        details.push(`Graphiti: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      configured: true,
      mode: codeIntelligenceConfig.mode,
      cgc,
      graphiti,
      ...(details.length > 0 ? { detail: details.join('；') } : {}),
      lastCheckedAt: Date.now()
    };
  });

  ipcMain.handle('code-index:memories', async (event, root: unknown) => {
    trustedUiSender(event);
    if (typeof root !== 'string' || !root.trim()) throw new Error('代码索引需要工作区路径');
    if (!codeIndexService) throw new Error('代码索引未初始化');
    return codeIndexService.memories(root);
  });

  ipcMain.handle('code-index:link', async (event, raw: unknown) => {
    trustedUiSender(event);
    if (!raw || typeof raw !== 'object') throw new Error('无效输入');
    const input = raw as {
      root?: unknown;
      filePath?: unknown;
      line?: unknown;
      memoryEntityId?: unknown;
      linkType?: unknown;
    };
    if (typeof input.root !== 'string' || !input.root.trim()) throw new Error('需要工作区路径');
    if (typeof input.filePath !== 'string' || !input.filePath.trim()) throw new Error('需要代码路径');
    const line = Number(input.line);
    if (!Number.isInteger(line) || line < 1) throw new Error('需要有效行号');
    if (typeof input.memoryEntityId !== 'string' || !input.memoryEntityId) throw new Error('需要记忆 id');
    if (!codeIndexService) throw new Error('代码索引未初始化');
    return codeIndexService.linkMemory(input.root, {
      filePath: input.filePath,
      line,
      memoryEntityId: input.memoryEntityId,
      ...(typeof input.linkType === 'string' ? { linkType: input.linkType } : {})
    });
  });

  ipcMain.handle('code-index:vectors', async (event, root: unknown) => {
    trustedUiSender(event);
    if (typeof root !== 'string' || !root.trim()) throw new Error('代码索引需要工作区路径');
    if (!codeIndexService) throw new Error('代码索引未初始化');
    return codeIndexService.buildVectors(root);
  });

  ipcMain.handle('code-index:remember', async (event, raw: unknown) => {
    trustedUiSender(event);
    if (!raw || typeof raw !== 'object') throw new Error('无效输入');
    const input = raw as {
      root?: unknown;
      kind?: unknown;
      title?: unknown;
      content?: unknown;
      source?: unknown;
      sourceRef?: unknown;
      status?: unknown;
      confidence?: unknown;
    };
    if (typeof input.root !== 'string' || !input.root.trim()) throw new Error('需要工作区路径');
    if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('记忆需要标题');
    if (typeof input.content !== 'string' || !input.content.trim()) throw new Error('记忆需要内容');
    if (typeof input.source !== 'string' || !input.source.trim()) throw new Error('记忆需要来源');
    if (!['fact', 'decision', 'constraint', 'issue', 'solution', 'debate'].includes(String(input.kind))) {
      throw new Error('记忆类型不合法');
    }
    if (!codeIndexService) throw new Error('代码索引未初始化');
    const status = input.status === 'confirmed' ? 'confirmed' : 'candidate';
    return codeIndexService.remember(input.root, {
      kind: input.kind as 'fact' | 'decision' | 'constraint' | 'issue' | 'solution' | 'debate',
      title: input.title.trim(),
      content: input.content.trim(),
      source: input.source.trim(),
      ...(typeof input.sourceRef === 'string' ? { sourceRef: input.sourceRef } : {}),
      status,
      ...(typeof input.confidence === 'number' ? { confidence: input.confidence } : {})
    });
  });

  ipcMain.handle('code-index:watch', (event, root: unknown) => {
    trustedUiSender(event);
    if (typeof root !== 'string' || !root.trim()) throw new Error('代码索引需要工作区路径');
    if (!codeIndexService) throw new Error('代码索引未初始化');
    return { watching: codeIndexService.watch(root) };
  });

  ipcMain.handle('code-index:unwatch', (event, root: unknown) => {
    trustedUiSender(event);
    if (typeof root !== 'string' || !root.trim()) return;
    codeIndexService?.unwatch(root);
  });

  ipcMain.handle('code-index:search', async (event, raw: unknown) => {
    trustedUiSender(event);
    if (!raw || typeof raw !== 'object') throw new Error('无效输入');
    const input = raw as {
      root?: unknown;
      query?: unknown;
      mode?: unknown;
      limit?: unknown;
      context?: unknown;
    };
    if (typeof input.root !== 'string' || !input.root.trim()) throw new Error('代码索引需要工作区路径');
    if (typeof input.query !== 'string' || !input.query.trim()) throw new Error('检索需要 query');
    if (!codeIndexService) throw new Error('代码索引未初始化');
    const mode = input.mode === 'CODE' || input.mode === 'MEMORY' || input.mode === 'HYBRID' ? input.mode : undefined;
    const limit = typeof input.limit === 'number' ? input.limit : undefined;
    const status = await codeIndexService.summary(input.root);
    if (status.generation === null) await codeIndexService.index(input.root);
    const result = await codeIndexService.retrieve(input.root, input.query.trim(), {
      ...(mode ? { mode } : {}),
      ...(limit ? { limit } : {})
    });
    if (input.context === true) {
      const context = await codeIndexService.context(input.root, input.query.trim(), 6000);
      return {
        ...result,
        context: context.text,
        contextMeta: { used: context.used, omitted: context.omitted, stale: context.stale }
      };
    }
    return result;
  });

  ipcMain.handle('snapshot:revert', (event, taskId: unknown) => {
    trustedUiSender(event);
    if (typeof taskId !== 'string') throw new Error('无效输入');
    return snapshotStore?.revert(taskId) ?? { taskId, restored: [], removed: [], failed: [] };
  });

  ipcMain.handle('page:extract', async (event, raw: unknown) => {
    trustedUiSender(event);
    const input = (raw && typeof raw === 'object' ? raw : {}) as { sourceId?: unknown };
    const sourceId = typeof input.sourceId === 'string' ? input.sourceId : undefined;
    const content = await capabilityContext.readPage?.(sourceId);
    if (!content) throw new Error('读取网页内容的能力没有准备好');
    const preview: PageExtractPreview = {
      ...previewPageDocument(content),
      ...(sourceId ? { sourceId } : {})
    };
    return preview;
  });

  /**
   * 「保存文档」走内置插件 `page.save-document`：页面探针由宿主注入，插件
   * 只管把读到的内容落盘。内容不经过模型，也不改写；页面没打开、还在加载、
   * 停在登录页都在探针里明确报错，不写空文件。
   */
  ipcMain.handle('page:save-document', async (event, raw: unknown) => {
    trustedUiSender(event);
    const input = (raw && typeof raw === 'object' ? raw : {}) as SavePageDocumentInput;
    return mainCapabilities.execute('page.save-document', input, capabilityContext);
  });

  /**
   * 独立窗口工具栏点「保存」。发送方必须是当前那扇独立窗口——它没有主窗口
   * 的 `trustedUiSender` 身份，但也不能让任意页面随便调落盘。
   */
  ipcMain.handle('page:save-from-detached', async (event, raw: unknown) => {
    if (!detached || event.sender.id !== detached.window.webContents.id) {
      throw new Error('IPC sender rejected');
    }
    if (raw !== 'md' && raw !== 'docx') throw new Error('无效的保存格式');
    await saveFromDetached(raw);
  });

  // The page views are native, so this is the only honest answer to "is the
  // rail covered?". It exists because that failure is silent: the buttons just
  // stop responding, and nothing throws.
  ipcMain.handle('app:view-bounds', event => {
    trustedUiSender(event);
    const out: ViewBoundsMap = {};
    for (const [id, view] of views) out[id] = view.getBounds();
    return out;
  });

  ipcMain.handle('app:layout', event => {
    trustedUiSender(event);
    return layoutInfo();
  });

  // Dragging the divider. The renderer only proposes a width; the clamp lives
  // here so a stale or hostile value cannot produce an unusable layout.
  ipcMain.handle('app:set-split', (event, value: unknown) => {
    trustedUiSender(event);
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('无效的分栏宽度');
    const [width] = win!.getContentSize();
    preferredSplit = computeSplit(width, value);
    layout();
    // 拖完就记：分栏是「我看页面要多大」的判断，重启回到 42% 等于每次都重做一遍。
    saveWindowStateSoon();
    return layoutInfo();
  });

  // Told when a drag starts and ends so the page view can step out of the way.
  ipcMain.handle('app:drag-page', (event, active: unknown) => {
    trustedUiSender(event);
    const next = active === true;
    if (next === draggingPage) return;
    draggingPage = next;
    layout();
  });

  ipcMain.handle('ax:snapshot', async event => {
    trustedUiSender(event);
    if (process.platform !== 'darwin') throw new Error('当前构建版本只实现 macOS Accessibility 读取');
    const available = await accessibility.isAvailable();
    if (!available) throw new Error('Accessibility 权限未授予或原生辅助程序不存在');
    const application = await accessibility.getFrontmostApplication();
    const tree = await accessibility.getElementTree(4);
    return { available, application, tree };
  });

  ipcMain.handle('agent:choose-directory', async event => {
    trustedUiSender(event);
    const result = await dialog.showOpenDialog(win!, {
      title: '选择本次任务的工作区',
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

/**
 * What the app calls itself.
 *
 * In development this runs out of `node_modules/electron/dist/Electron.app`, and
 * macOS takes the Dock label from that bundle's Info.plist — no line of code can
 * change it. `scripts/rename-dev-bundle.mjs` handles that half; what this line
 * does is everything Electron derives from `app.getName()`: the menu bar, the
 * crash reporter's product name, the user-agent, and — which is why the line
 * below it exists — the data folder.
 *
 * The packaged build already gets this from `build.productName` in package.json.
 */
app.setName('ThinkFusion');

/**
 * Pin the data folder, because `userData` is derived from the app name.
 *
 * Without this, renaming the app would move the folder to `…/ThinkFusion` and
 * every saved channel, every edited URL and the chosen display name would look
 * deleted on the next launch — the exact failure the persistence work was
 * about. The folder keeps the name it has always had: renaming it is a data
 * migration, and a migration that can only be tested on other people's machines
 * is not worth the tidier path.
 */
app.setPath('userData', path.join(app.getPath('appData'), 'thinkfusion-ai'));

function buildCodeIntelligenceExternal(config: CodeIntelligenceConfig): { cgc: CgcAdapter; graphiti: GraphitiAdapter } | undefined {
  const envUrl = process.env.THINKFUSION_NEO4J_HTTP;
  const url = envUrl ?? (config.mode === 'external' ? config.neo4jUrl : '');
  if (!url) return undefined;
  const client = new Neo4jHttpClient({
    baseUrl: url,
    user: process.env.THINKFUSION_NEO4J_USER ?? config.neo4jUser,
    password: process.env.THINKFUSION_NEO4J_PASSWORD ?? apiKeys?.get('code-intelligence') ?? ''
  });
  return { cgc: new CgcAdapter(client), graphiti: new GraphitiAdapter(client) };
}

app.whenReady().then(async () => {
  store = new AgentStore(path.join(app.getPath('userData'), 'agent-store.json'));
  traceStore = new TraceStore(path.join(app.getPath('userData'), 'traces'));
  windowStateFile = path.join(app.getPath('userData'), 'window-state.json');
  selectorStore = new SelectorStore(path.join(app.getPath('userData'), 'selector-profile.json'));
  // Before anything reads `sources`: the window's startup path decides which
  // views to create, and a source the user switched off must not be one of them.
  sourceStore = new SourceStore(path.join(app.getPath('userData'), 'sources.json'));
  apiKeys = new ApiKeyStore({ file: path.join(app.getPath('userData'), 'api-keys.json') });
  cloudConfigs = new CloudConfigStore(path.join(app.getPath('userData'), 'cloud-config.json'));
  applyStored(sourceStore.all());
  activeSourceId = sources.find(source => source.enabled)?.id ?? activeSourceId;
  rebuildChannels();
  // Its own file: renaming yourself is not a property of which pages exist, and a
  // corrupt one must not be able to take the sources down with it.
  profileStore = new ProfileStore(path.join(app.getPath('userData'), 'profile.json'));
  executionDefaults = new ExecutionDefaultsStore(path.join(app.getPath('userData'), 'execution-defaults.json'));
  workspaceStore = new WorkspaceStore(path.join(app.getPath('userData'), 'workspace-state.json'));
  workspaceList = new WorkspaceListStore(path.join(app.getPath('userData'), 'workspaces.json'));
  // 升级迁移：老版本只记了一个项目目录，没有工作区。把它变成第一个工作区，
  // 否则升级后侧栏会突然「未分组」，用户会以为历史丢了。只在列表为空时做一次。
  {
    const state = workspaceStore.get();
    if (workspaceList.all().length === 0 && state.workspaceRoot) {
      try {
        const { workspace } = workspaceList.add({ root: state.workspaceRoot });
        workspaceStore.set({ activeWorkspaceId: workspace.workspaceId });
      } catch {
        /* 目录已经不是绝对路径之类：留空列表，界面上仍可手动添加 */
      }
    } else if (state.activeWorkspaceId && !workspaceList.get(state.activeWorkspaceId)) {
      // 工作区文件被删过/换过机器：指向一个不存在的组会让侧栏一直显示「当前」却找不到。
      workspaceStore.set({ activeWorkspaceId: '' });
    }
  }
  // 开关要在任何能力被调用之前同步给两个宿主：主进程注册表现在就生效，
  // Runtime 在每次 task.run 时随消息收到同一份列表。
  capabilityStore = new CapabilityStore(path.join(app.getPath('userData'), 'capabilities.json'));
  setDisabledCapabilities(capabilityStore.disabledIds());
  // 开发态从项目 resources/ 读；打包后这些 .md 由 extraResources 放到
  // Contents/Resources/expertise/，两个候选都列上，哪个先找到用哪个。
  expertiseUserDir = path.join(app.getPath('userData'), 'expertise');
  expertiseBuiltinDirs = [
    path.join(app.getAppPath(), 'resources', 'expertise'),
    path.join(process.resourcesPath, 'expertise')
  ];
  expertiseStore = new ExpertiseStore(path.join(app.getPath('userData'), 'expertise.json'));

  verdicts = new VerdictStore(path.join(app.getPath('userData'), 'verdicts'));

  debates = new DebateOrchestrator(new DebateStore(path.join(app.getPath('userData'), 'debates')), {
    ask: (agentId, task) => {
      const extra = extraAgents.find(agent => agent.id === agentId);
      return extra ? extra.ask(task) : registry.ask(agentId, task);
    },
    // 谁参与由 debate:start 里的 planLead 按 health() 决定，编排器不再
    // 维护第二套名单。网页成员在计划里被标成 webOnly，只第一轮发言。
  });

  tasks = new TaskManager(store, emit);
  orchestrator = new AgentOrchestrator({
    tasks,
    store,
    adapter: () => planningAdapter(),
    emit,
    dbPath: () => path.join(app.getPath('userData'), 'agent-journal.json'),
    onReport: (task, report) => recordExecutionReport(traceStore, task, report, emitConversation),
    // 独立评审优先用本地/云端模型，不用刚才做规划的那个网页通道。
    // 一个可用模型都没有时 reviewExecution 会退回规则版并明写 backend。
    review: async (report, plan) => {
      let reviewer: (typeof extraAgents)[number] | null = null;
      for (const agent of extraAgents) {
        try {
          if ((await agent.health()).available) { reviewer = agent; break; }
        } catch { /* 这一家没就绪就换下一家 */ }
      }
      return reviewExecution(report, plan, reviewer
        ? {
            reviewer: reviewer.label,
            ask: async material => (await reviewer!.ask({
              question: material,
              stage: 'challenge',
              timeoutMs: 90_000
            })).text
          }
        : {});
    },
    /**
     * V2.1 D-03：方案评审辩论。
     *
     * 只用本地/云端模型，不用网页通道：此刻正有一条网页在当「计划生成器」，
     * 让辩手钻进同一条会话会把计划请求和辩论请求搅在一起。一个 API 成员都
     * 没有时返回 null，编排器会如实记下「未经评审」，而不是假装辩过。
     */
    debatePlan: async ({ plan, topics }) => {
      if (!debates) return null;
      const candidates = await debateCandidates();
      const api = candidates.filter(item => item.type !== 'web' && item.available);
      if (api.length === 0) return null;
      const mode = api.some(item => item.type === 'local') ? 'local' : 'cloud';
      const selected = api.map(item => item.id);
      const leadPlan = planLead({
        mode,
        strategy: 'solution',
        candidates,
        selected,
        leadAgentId: undefined
      });
      const state = debates.start(
        planReviewQuestion(plan),
        {
          // 方案评审只需要「各自判断 → 互相质疑」两轮：再多也不会让计划本身
          // 变得更可行，只会把审批拖长。
          strategy: 'solution',
          maxRounds: 2,
          participants: leadPlan.participants,
          convergenceStop: true,
          leadMode: mode,
          // 方案评审没有「网页先答过」这一层，基准观点为空；辩题直接给。
          seed: { positions: [], topics },
          budget: { stageTimeoutMs: 120_000, totalMs: 180_000, maxConcurrency: 2 }
        },
        undefined,
        leadPlan,
        'plan-review'
      );
      const done = await debates.waitFor(state.debateId, 180_000);
      if (!done) return null;
      // 「跑完了」不等于「辩过了」：模型全部超时/忙碌时，引擎仍会把状态记成
      // completed，但一句话都没说。真机第一轮就遇到两个本地模型一个在忙、
      // 一个 90 秒没出话——那种记录不能显示成「已辩完」，否则审批的人会以为
      // 这份计划被评审过。
      const spoke = done.rounds.some(round => round.messages.length > 0);
      return {
        debateId: done.debateId,
        status: done.status === 'completed' && spoke ? 'completed' as const : 'stopped' as const,
        participants: leadPlan.participants,
        summary: summarizePlanDebate({
          topics,
          rounds: done.rounds.map(round => ({
            index: round.index,
            messages: round.messages.map(message => ({
              author: message.agentId,
              kind: message.kind,
              text: message.text
            })),
            failures: round.failures
          }))
        })
      };
    }
  });

  // The conversation runner gets the workspace hand-off as a function, not an
  // import, so that "does this file depend on the runtime" is answerable by
  // reading its imports.
  conversations = new ConversationRunner({
    store,
    registry,
    emit: emitConversation,
    poolFor: (config, base) => {
      const selection = selectParticipants(config, registry.list(), extraAgents);
      return new ExecutionPool(base, extraAgents, selection.answerIds, selection.executorIds);
    },
    executorIdsFor: config => selectParticipants(config, registry.list(), extraAgents).executorIds,
    /**
     * 专家常驻、技能按场景加载，拼出来的 system 段只给工程空间第一意见。
     * 知识空间、网页通道、汇总与裁决都拿不到它们（buildEngineeringExpertise
     * 在非 engineering 时直接返回空）。
     */
    expertiseFor: ({ workspaceMode, question }) => {
      const { state, disabled } = currentExpertise();
      return buildEngineeringExpertise({ workspaceMode, question, state, disabled });
    },
    /**
     * 「＋ · 添加文件」的正文读取，走能力注册表。
     *
     * 不直接调 `attachFiles`：`file.attach` 在设置里可以停用，停用时要给出
     * 「能力插件已停用」这句明确报错，而不是这条提问悄悄少了几份附件。
     */
    readAttachments: async paths => {
      if (!attachmentReader) throw new Error('附件读取还没初始化，这一问没有发出文件内容。');
      return attachmentReader(paths);
    },
    /**
     * 工程空间的路由判定：模型主导（本地/云端/混合）时由模型判，网页主导按规则。
     * 只回一个标签，不读文件、不执行；判不了就返回 null，让规则兜底。
     */
    routeWithModel: routeEngineeringWithModel,
    /**
     * 工程空间「模型直答」的候选名单（2026-11-08 用户裁决：工程模式不优先问
     * 网页，读取本地由模型做）。这里必须带真实的可用性：没启动的 Ollama 和
     * 没配 Key 的云端模型都在 executorIds 里，直接拿名单去问只会得到一条
     * 报错，用户看到的就是「模型不能用」而不是「网页读不了本地文件」。
     */
    modelMembers: async config => {
      const selection = selectParticipants(config, registry.list(), extraAgents);
      const members = extraAgents.filter(agent => selection.executorIds.has(agent.id));
      return Promise.all(
        members.map(async agent => {
          let available = false;
          let detail: string | undefined;
          try {
            const health = await agent.health();
            available = health.available;
            detail = health.detail;
          } catch (error) {
            detail = error instanceof Error ? error.message : String(error);
          }
          return {
            agentId: agent.id,
            label: agent.label,
            kind: (agent.sourceType === 'cloud' ? 'cloud' : 'local') as 'local' | 'cloud',
            available,
            detail
          };
        })
      );
    },
    /**
     * V2.1 Model Router：把「这一轮用哪些模型、为什么」在提问之前算出来。
     *
     * 只读当前可用成员，不主动探活：探活会给每个页面发一次探测，而这条路
     * 每条消息都会走一遍。降级判断依赖的是「注册表里有没有」，真正的可用性
     * 仍由提问链路自己报错，两件事不能混。
     */
    modelRoute: ({ config, taskKind }) =>
      routeModels({
        taskKind,
        executionMode: config.executionMode,
        available: {
          web: registry.list().map(agent => agent.id),
          local: extraAgents.filter(agent => agent.sourceType === 'local').map(agent => agent.id),
          cloud: extraAgents.filter(agent => agent.sourceType === 'cloud').map(agent => agent.id)
        },
        selectedWebChannels: config.selectedWebChannels,
        selectedCloudModels: config.selectedCloudModels,
        leadAgentId: config.leadAgentId
      }),
    restoreThreads: restoreThreadViews,
    prepareWebViews: ensureEnabledViews,
    channelStatuses: async () => {
      const statuses = await registry.statuses();
      lastChannelStatuses = statuses;
      lastChannelSnapshotAt = Date.now();
      return statuses;
    },
    trace: {
      recorder: conversationId => new TraceRecorder(traceStore, conversationId, emitConversation),
      remove: conversationId => traceStore.remove(conversationId),
      closeOpenTurns: conversationId => traceStore.closeOpenTurns(conversationId)
    },
    isPageChannel: agentId => registry.get(agentId) !== undefined,
    agentSource: agentId => {
      const extra = extraAgents.find(agent => agent.id === agentId);
      if (extra) return extra.sourceType;
      return registry.get(agentId) ? 'web' : undefined;
    },
    fusionEnabled: true,
    // 会话内辩论：归属方式决定用哪一类成员；这里只负责起一场、等它跑完、
    // 把轮次记录交回 runner。混合择一由 runner 的纯规则完成，不再借本地模型。
    runDebate: async input => {
      if (!debates) return null;
      // 执行名单是按配置算的，不代表此刻真的可用：没配 Key 的云端模型也在名单里。
      // 用它去辩会得到一条「辩论跑了 2 轮」但只有一个人说话的假记录，所以先按
      // health() 筛一遍；不足两位就如实不辩。
      const candidates = await debateCandidates();
      const available = new Set(candidates.filter(item => item.available).map(item => item.id));
      const debaters = input.debaters.filter(id => available.has(id));
      // 归属规则：一个人也能主导（自辩），只有真的一个可用成员都没有才不辩。
      if (debaters.length === 0) return null;
      const labelOf = (agentId: string) =>
        extraAgents.find(agent => agent.id === agentId)?.label ?? agentId;
      // 与手动辩论共用同一套计划生成：归属方式决定只用哪一类成员，网页方式
      // 的 webOnly 会让编排器把交锋材料拼进用户消息，而不是拉本地模型补位。
      //
      // 例外：工程空间的多 agent 编排（2026-11-08 裁决）本地 + 云端模型同场，
      // 归属收敛会把其中一类剔掉，所以这里直接组一份「名单即计划」的
      // LeadPlan，跳过 planLead。网页成员不进交锋（webOnly 为空），它们第一
      // 轮的并列意见已经作为 seed 交给模型读了。知识空间仍然走 planLead。
      const plan: LeadPlan = input.orchestration
        ? {
            lead: {
              mode: normalizeLeadMode(input.effectiveMode),
              agentId: input.lead.agentId,
              label: input.lead.label,
              reason: input.orchestration.reason,
              drivenBy: 'orchestrator'
            },
            openingSpeakers: [...debaters],
            debaters: [...debaters],
            participants: [...debaters],
            webOnly: [],
            reason: input.orchestration.reason,
            warnings: input.orchestration.warnings,
            excluded: []
          }
        : planLead({
            mode: input.effectiveMode,
            strategy: normalizeDebateConfig({}).strategy,
            candidates,
            selected: debaters,
            leadAgentId: input.lead.agentId
          });
      // 会话内网页主导：三家网页刚答过用户问题，别把同一句原话再问一遍、
      // 也别让三个页面各写三轮独立文本（每轮都要等最慢的那个）。基准观点
      // 直接注入第一轮，质疑与回应由主导人一个页面完成。
      if (input.effectiveMode === 'web' && input.seeds.length > 0) {
        plan.warnings.push('会话内网页主导：基准观点取本轮全部网页回答（不再重复提问），质疑与回应由主导人一个页面完成');
      }
      const state = debates.start(
        input.question,
        {
          // 会话里这一场用哪种策略，由研究设置里选的来；没选过就是真理发现。
          strategy: input.debateStrategy ?? 'truth',
          // 三步各一轮：独立表态 → 质疑 → 回应修订。两轮的话「回应」那一轮
          // 根本不存在，AC-06 要求的决策就永远记不到。
          maxRounds: 3,
          participants: plan.participants,
          convergenceStop: true,
          leadMode: input.mode,
          seed: {
            positions: input.seeds.map(seed => `【${seed.label}】\n${seed.text}`),
            topics: input.topics,
            ...(input.effectiveMode === 'web'
              ? { entries: input.seeds.map(seed => ({ agentId: seed.agentId, label: seed.label, text: seed.text })) }
              : {})
          },
          // 会话内辩论的预算：单次 60 秒、整场 2.5 分钟、同时问 3 位。
          // 任务书原值是 4 分钟，但会话里前面还有第一轮和汇总；4 分钟辩论再
          // 加 2 分钟最终意见，用户会以为卡死。收敛停止照常生效，真的需要
          // 更多轮的手动辩论仍走 120 秒 / 3 分钟那一档。
          budget: { stageTimeoutMs: 60_000, totalMs: 150_000, maxConcurrency: 3 }
        },
        input.conversationId,
        plan,
        'conversation'
      );
      // 辩论最长 4 分钟。等待期间每 3 秒把轮次报回去，界面上的「汇总中」
      // 才有内容可看——否则一直显示同一句话，用户以为卡死。
      const engine = debates;
      const progressTimer = setInterval(() => {
        const current = engine.get(state.debateId);
        if (!current) return;
        input.onProgress?.({
          rounds: current.rounds.length,
          status: current.status,
          ...(current.stopReason ? { stopReason: current.stopReason } : {}),
          snapshot: [...current.rounds, ...(current.runningRound ? [current.runningRound] : [])].map(round => ({
            index: round.index,
            phase: round.phase ?? '',
            ...(round.pending && round.pending.length > 0 ? { pending: round.pending } : {}),
            messages: round.messages.map(message => ({
              author: message.agentId,
              kind: message.kind,
              text: message.text.length > 1200 ? `${message.text.slice(0, 1200)}…` : message.text,
              ...(message.reasoning ? { reasoning: message.reasoning } : {})
            }))
          }))
        });
      }, 3000);
      let done;
      try {
        done = await debates.waitFor(state.debateId, 240_000);
      } finally {
        clearInterval(progressTimer);
      }
      if (!done) return null;
      return {
        debateId: done.debateId,
        status: done.status,
        rounds: done.rounds.map(round => ({
          index: round.index,
          messages: round.messages.map(message => ({
            author: labelOf(message.agentId),
            kind: message.kind,
            text: message.text,
            ...(message.reasoning ? { reasoning: message.reasoning } : {}),
            agentId: message.agentId,
            createdAt: message.createdAt,
            ...(typeof message.startedAt === 'number' ? { startedAt: message.startedAt } : {}),
            ...(typeof message.endedAt === 'number' ? { endedAt: message.endedAt } : {})
          })),
          failures: round.failures,
          startedAt: round.startedAt,
          ...(round.endedAt !== undefined ? { endedAt: round.endedAt } : {})
        }))
      };
    },
    // 会话里发起的辩论属于这条会话：删会话就一起删，不留孤儿记录。
    deleteDebatesFor: conversationId => {
      if (!debates) return;
      for (const state of debates.list()) {
        if (state.conversationId === conversationId) debates.remove(state.debateId);
      }
    },
    verdictFor: conversationId => verdictByConversation.get(conversationId) ?? null,
    onCollaborationRecord: record => {
      const index = collaborationRecords.findIndex(item => item.taskId === record.taskId);
      if (index >= 0) collaborationRecords[index] = record;
      else collaborationRecords.push(record);
    },
    submitWorkspace: async input => {
      await ensureChannelSnapshot();
      return orchestrator.submit({
        prompt: input.prompt,
        permissionPreset: input.permissionPreset as PermissionPreset,
        workspaceRoot: input.workspaceRoot,
        planDebate: input.planDebate
      });
    }
  });

  // A turn that was running when the last process ended has nobody left to
  // finish it. Marking it interrupted here — before any window can show it — is
  // the difference between "上次没做完" and an eternal 「思考中」.
  conversations.reconcile();

  // Handlers, the agent process and the event sink all have to exist before any
  // renderer does. They used to be registered inside createWindow() *after*
  // `await loadURL('https://chat.deepseek.com/')`, so on a slow network the UI
  // mounted first and its opening calls (platform, permission, history, status)
  // all failed with "No handler registered" — leaving the window permanently
  // blank of state while the webview looked fine.
  registerIpc();
  startAgentProcess();
  setAgentEventSink(event => emit(event));

  /**
   * Runtime 拿不到会话库、设置状态与定时存储。这里的桥只认显式登记的能力，
   * 其余明确报错——不是给 Runtime 开一个任意调用主进程的后门。
   */
  const scheduleStore = new ScheduleStore(path.join(app.getPath('userData'), 'schedules.json'));
  let idSeq = 0;
  const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++idSeq}`;

  const requireConversation = (conversationId: string | undefined) => {
    if (!conversationId) throw new Error('这次执行没有关联会话，无法使用会话级能力');
    const conversation = store.getConversation(conversationId);
    if (!conversation) throw new Error('会话不存在或已删除');
    return conversation;
  };

  lspRegistry = new LspProviderRegistry([
    new TypeScriptProvider([path.join(app.getAppPath(), 'node_modules', 'typescript', 'lib', 'tsserver.js')])
  ]);
  snapshotStore = new SnapshotStore(path.join(app.getPath('userData'), 'snapshots'));
  codeIntelligenceConfigStore = new CodeIntelligenceConfigStore(path.join(app.getPath('userData'), 'code-intelligence.json'));
  codeIntelligenceConfig = codeIntelligenceConfigStore.read(apiKeys?.has('code-intelligence') ?? false);
  const external = buildCodeIntelligenceExternal(codeIntelligenceConfig);
  codeIndexService = new CodeIndexService(path.join(app.getPath('userData'), 'code-index.sqlite'), {
    embedder: {
      embed: async texts => {
        if (!embeddingService) throw new Error('EMBEDDING_UNAVAILABLE：embedding 未初始化');
        return embeddingService.embed({ texts });
      }
    },
    ...(external ? { external } : {})
  });
  embeddingService = new EmbeddingService({
    hasCloudKey: () => (apiKeys?.list().length ?? 0) > 0,
    resolveCloud: providerId => {
      const preset = CLOUD_PRESETS.find(item => item.id === providerId);
      const baseUrl = cloudConfigs?.get(providerId)?.baseUrl ?? preset?.baseUrl;
      const key = apiKeys?.get(providerId);
      return baseUrl && key ? { baseUrl, key } : null;
    }
  });

  /** 把工具传来的相对路径钉在授权根内；越界一律拒绝。 */
  const resolveInsideRoot = (root: string, relative: string): string => {
    const abs = path.resolve(root, relative);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${relative} 不在工作区内`);
    return abs;
  };

  setMainCallHandler(async (id, rawArgs, context) => {
    const conversationId = context.conversationId;

    if (id === 'code.search') {
      const args = (rawArgs ?? {}) as {
        root?: unknown;
        query?: unknown;
        mode?: unknown;
        limit?: unknown;
        context?: unknown;
      };
      if (typeof args.root !== 'string' || !args.root) throw new Error('code.search 缺少工作区根目录');
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('code.search 需要 query');
      if (!codeIndexService) throw new Error('代码索引未初始化');
      const root = args.root;
      const mode = args.mode === 'CODE' || args.mode === 'MEMORY' || args.mode === 'HYBRID' ? args.mode : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const summary = await codeIndexService.summary(root);
      if (summary.generation === null) await codeIndexService.index(root);
      const result = await codeIndexService.retrieve(root, args.query.trim(), { ...(mode ? { mode } : {}), ...(limit ? { limit } : {}) });
      if (args.context === true) {
        const context = await codeIndexService.context(root, args.query.trim(), 6000);
        return { ...result, context: context.text, contextMeta: { used: context.used, omitted: context.omitted, stale: context.stale } };
      }
      return result;
    }

    if (id === 'code.team.run') {
      const args = (rawArgs ?? {}) as {
        task?: unknown;
        files?: unknown;
        members?: unknown;
        maxParallel?: unknown;
        root?: unknown;
      };
      if (typeof args.task !== 'string' || !args.task.trim()) throw new Error('code.team.run 需要 task');
      if (typeof args.root !== 'string' || !args.root) throw new Error('code.team.run 缺少工作区根目录');
      const root = args.root;
      const candidates = await debateCandidates();
      const api = candidates.filter(item => item.type !== 'web' && item.available);
      const requested = Array.isArray(args.members)
        ? args.members.filter((item): item is string => typeof item === 'string')
        : [];
      const members = requested.length > 0
        ? requested
        : api.slice(0, Math.min(Math.max(Number(args.maxParallel) || 4, 1), 4)).map(item => item.id);
      const known = new Set(api.map(item => item.id));
      const unknown = members.filter(item => !known.has(item));
      if (members.length === 0) throw new Error('没有可用的 API 成员；多 Agent 编码需要本地/云端模型');
      if (unknown.length > 0) throw new Error(`不可用或不存在的成员：${unknown.join('、')}`);
      const files = Array.isArray(args.files)
        ? args.files.filter((item): item is string => typeof item === 'string')
        : [];
      return runCodingTeam(
        {
          task: args.task.trim(),
          files,
          members,
          maxParallel: Number(args.maxParallel) || 4,
          root
        },
        {
          ask: (agentId, task) => {
            const extra = extraAgents.find(agent => agent.id === agentId);
            return extra ? extra.ask(task) : registry.ask(agentId, task);
          },
          readFile: async absolute => {
            const relative = path.relative(root, absolute);
            if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
            try {
              const content = await fs.promises.readFile(absolute, 'utf8');
              if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) return null;
              return { content, sha256: createHash('sha256').update(content, 'utf8').digest('hex') };
            } catch {
              return null;
            }
          }
        }
      );
    }

    if (id === 'code.impact') {
      const args = (rawArgs ?? {}) as { root?: unknown; path?: unknown; line?: unknown; character?: unknown };
      if (typeof args.root !== 'string' || typeof args.path !== 'string') throw new Error('code.impact 需要 root 与 path');
      const line = Number(args.line);
      const character = Number(args.character);
      if (!Number.isInteger(line) || line < 1 || !Number.isInteger(character) || character < 1) {
        throw new Error('line/character 必须是 1-based 整数');
      }
      const file = resolveInsideRoot(args.root, args.path);
      const client = lspRegistry?.get(args.root, file);
      if (!client) throw new Error(lspRegistry?.unavailableReason(file, args.root) ?? 'LSP_UNAVAILABLE：没有可用的语言服务');
      return buildImpact(client, args.root, file, { line, character }, path.join(app.getPath('userData'), 'code-index'));
    }

    if (id === 'code.ast') {
      const args = (rawArgs ?? {}) as { root?: unknown; path?: unknown; max?: unknown };
      if (typeof args.root !== 'string' || typeof args.path !== 'string') throw new Error('code.ast 需要 root 与 path');
      const ts = await loadTypeScript();
      if (!ts) throw new Error('AST_UNAVAILABLE：没有找到 typescript 包');
      const file = resolveInsideRoot(args.root, args.path);
      if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(file)) throw new Error('AST_UNAVAILABLE：这个文件不是 TypeScript/JavaScript');
      const text = await fs.promises.readFile(file, 'utf8');
      const max = typeof args.max === 'number' ? Math.min(Math.max(Math.floor(args.max), 1), 500) : 200;
      return summarizeAst(ts, file, text, max);
    }

    if (id === 'code.context') {
      const args = (rawArgs ?? {}) as { root?: unknown; path?: unknown; line?: unknown; character?: unknown; max?: unknown };
      if (typeof args.root !== 'string' || typeof args.path !== 'string') throw new Error('code.context 需要 root 与 path');
      const file = resolveInsideRoot(args.root, args.path);
      const client = lspRegistry?.get(args.root, file);
      if (!client) throw new Error(lspRegistry?.unavailableReason(file, args.root) ?? 'LSP_UNAVAILABLE：没有可用的语言服务');
      const line = Number(args.line);
      const character = Number(args.character);
      const position = Number.isInteger(line) && line > 0 && Number.isInteger(character) && character > 0
        ? { line, character }
        : undefined;
      const max = typeof args.max === 'number' ? Math.min(Math.max(Math.floor(args.max), 1), 500) : 200;
      return buildCodeContext(client, args.root, file, position, max);
    }

    if (id === 'code.definition' || id === 'code.references' || id === 'code.symbols' || id === 'code.hover') {
      const args = (rawArgs ?? {}) as {
        root?: unknown; path?: unknown; line?: unknown; character?: unknown; max?: unknown;
      };
      if (typeof args.root !== 'string' || typeof args.path !== 'string') {
        throw new Error(`${id} 需要 root 与 path`);
      }
      const file = resolveInsideRoot(args.root, args.path);
      const client = lspRegistry?.get(args.root, file);
      if (!client) throw new Error(lspRegistry?.unavailableReason(file, args.root) ?? 'LSP_UNAVAILABLE：没有可用的语言服务');
      if (id === 'code.symbols') {
        const max = typeof args.max === 'number' ? Math.min(Math.max(Math.floor(args.max), 1), 500) : 200;
        return client.symbols(file, max);
      }
      const line = Number(args.line);
      const character = Number(args.character);
      if (!Number.isInteger(line) || line < 1 || !Number.isInteger(character) || character < 1) {
        throw new Error('line/character 必须是 1-based 整数');
      }
      const position = { file, line, character };
      if (id === 'code.definition') return client.definition(position);
      if (id === 'code.references') return client.references(position);
      return client.hover(position);
    }

    if (id === 'snapshot.capture') {
      const args = (rawArgs ?? {}) as { root?: unknown; taskId?: unknown; path?: unknown };
      if (typeof args.root !== 'string' || typeof args.taskId !== 'string' || typeof args.path !== 'string') {
        throw new Error('snapshot.capture 需要 root / taskId / path');
      }
      snapshotStore?.capture(args.root, args.taskId, args.path);
      return { captured: args.path };
    }

    if (id === 'snapshot.revert') {
      const args = (rawArgs ?? {}) as { taskId?: unknown };
      if (typeof args.taskId !== 'string') throw new Error('snapshot.revert 需要 taskId');
      return snapshotStore?.revert(args.taskId) ?? { taskId: args.taskId, restored: [], removed: [], failed: [] };
    }

    if (id === 'code.diagnostics.lsp') {
      const args = (rawArgs ?? {}) as { root?: unknown; path?: unknown; paths?: unknown };
      if (typeof args.root !== 'string') throw new Error('code.diagnostics.lsp 需要 root');
      const relative = [
        ...(typeof args.path === 'string' ? [args.path] : []),
        ...(Array.isArray(args.paths) ? args.paths.filter((item): item is string => typeof item === 'string') : [])
      ].slice(0, 50);
      if (relative.length === 0) throw new Error('LSP_UNAVAILABLE：没有指定要检查的文件');
      const files = relative.map(item => resolveInsideRoot(args.root as string, item));
      for (const file of files) {
        if (!lspRegistry?.get(args.root as string, file)) {
          throw new Error(lspRegistry?.unavailableReason(file, args.root) ?? 'LSP_UNAVAILABLE：没有可用的语言服务');
        }
      }
      const client = lspRegistry?.get(args.root, files[0]);
      if (!client) throw new Error('LSP_UNAVAILABLE：没有可用的语言服务');
      const issues: Awaited<ReturnType<typeof client.diagnostics>> = [];
      for (const file of files) issues.push(...(await client.diagnostics(file)));
      return {
        root: args.root,
        source: 'tsserver',
        files: relative,
        issues,
        counts: {
          errors: issues.filter(item => item.severity === 'error').length,
          warnings: issues.filter(item => item.severity === 'warning').length
        }
      };
    }

    if (id === 'session.search') {
      const args = (rawArgs ?? {}) as { query?: unknown; limit?: unknown; conversationId?: unknown };
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query.trim()) throw new Error('session.search 需要 query');
      const conversationsForSearch = store.listConversations().map(conversation => ({
        conversationId: conversation.conversationId,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        messages: store.listMessages(conversation.conversationId).map(message => ({
          role: String(message.role),
          text: message.text,
          at: message.at
        }))
      }));
      return searchSessions({
        query,
        conversations: conversationsForSearch,
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        ...(typeof args.conversationId === 'string' ? { conversationId: args.conversationId } : {})
      });
    }

    if (id === 'plugin.inspect') {
      const args = (rawArgs ?? {}) as { id?: unknown };
      const views = describeCapabilities(disabledCapabilities(), [
        ...RUNTIME_CAPABILITY_IDS,
        ...mainCapabilities.ids()
      ]);
      if (typeof args.id === 'string' && args.id) {
        const found = views.find(item => item.id === args.id);
        if (!found) throw new Error(`清单里没有这个能力：${args.id}`);
        return found;
      }
      return {
        total: views.length,
        enabled: views.filter(item => item.enabled).length,
        items: views.map(item => ({
          id: item.id,
          host: item.host,
          kind: item.kind,
          permission: item.permission,
          enabled: item.enabled,
          registered: item.registered
        }))
      };
    }

    // --- 目标 -------------------------------------------------------------
    if (id === 'goal.create') {
      const args = (rawArgs ?? {}) as { text?: unknown };
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) throw new Error('目标需要一句说明');
      const conversation = requireConversation(conversationId);
      if (conversation.goal && conversation.goal.status === 'active') {
        throw new Error('这个会话已有进行中的目标，先完成或标记受阻，再建新目标');
      }
      const goal = { text, status: 'active' as const, updatedBy: 'model' as const, updatedAt: Date.now() };
      store.upsertConversation({ ...conversation, goal });
      emitConversation({ type: 'conversation.updated', at: Date.now(), conversation: { ...conversation, goal } });
      return goal;
    }

    if (id === 'goal.get') {
      const conversation = requireConversation(conversationId);
      return conversation.goal ?? null;
    }

    if (id === 'goal.update') {
      const args = (rawArgs ?? {}) as { status?: unknown; note?: unknown };
      if (args.status !== 'active' && args.status !== 'blocked' && args.status !== 'done') {
        throw new Error('goal.update 只接受 active / blocked / done');
      }
      const conversation = requireConversation(conversationId);
      if (!conversation.goal) throw new Error('这个会话还没有目标');
      const goal: NonNullable<typeof conversation.goal> = {
        ...conversation.goal,
        status: args.status,
        updatedBy: 'model',
        updatedAt: Date.now()
      };
      store.upsertConversation({ ...conversation, goal });
      emitConversation({ type: 'conversation.updated', at: Date.now(), conversation: { ...conversation, goal } });
      return { ...goal, note: typeof args.note === 'string' ? args.note : undefined };
    }

    // --- 定时 -------------------------------------------------------------
    if (id === 'schedule.create') {
      const now = Date.now();
      const normalized = normalizeScheduleInput(rawArgs, now);
      if (scheduleStore.list().length >= MAX_SCHEDULES) throw new Error(`定时任务最多 ${MAX_SCHEDULES} 条`);
      return scheduleStore.add({ ...normalized, id: nextId('sch'), createdAt: now });
    }

    if (id === 'schedule.edit') {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const target = scheduleStore.get(String(args.id ?? ''));
      if (!target) throw new Error(`没有这个定时任务：${String(args.id ?? '')}`);
      const patch: Partial<typeof target> = {};
      if (typeof args.text === 'string') {
        if (!args.text.trim()) throw new Error('定时任务的文字不能为空');
        patch.text = args.text.trim();
      }
      if (args.mode === 'local' || args.mode === 'cloud') patch.mode = args.mode;
      if (typeof args.enabled === 'boolean') patch.enabled = args.enabled;
      const at = typeof args.at === 'number' ? args.at : target.at;
      const repeatMinutes = typeof args.repeatMinutes === 'number' ? args.repeatMinutes : target.repeatMinutes;
      if (at !== undefined) patch.at = at;
      if (repeatMinutes !== undefined) patch.repeatMinutes = repeatMinutes;
      if (at !== undefined || repeatMinutes !== undefined) {
        patch.nextRunAt = computeNextRun({ at, repeatMinutes, lastRunAt: target.lastRunAt }, Date.now());
      }
      return scheduleStore.update(target.id, patch);
    }

    if (id === 'schedule.list') return { items: scheduleStore.list() };

    if (id === 'schedule.view') {
      const args = (rawArgs ?? {}) as { id?: unknown };
      const found = scheduleStore.get(String(args.id ?? ''));
      if (!found) throw new Error(`没有这个定时任务：${String(args.id ?? '')}`);
      return found;
    }

    // --- 任务板 -----------------------------------------------------------
    if (id === 'team.spawn') {
      const args = (rawArgs ?? {}) as { members?: unknown; parent?: unknown };
      const members = Array.isArray(args.members) ? args.members.filter((item): item is string => typeof item === 'string') : [];
      if (members.length === 0) throw new Error('team.spawn 需要至少一个成员 id');
      const known = new Set([
        ...registry.list().map(agent => agent.id),
        ...extraAgents.map(agent => agent.id)
      ]);
      const unknown = members.filter(member => !known.has(member));
      if (unknown.length > 0) throw new Error(`不认识的成员：${unknown.join('、')}（只能用现有参与者）`);
      const conversation = requireConversation(conversationId);
      const parent = typeof args.parent === 'string' ? args.parent : undefined;
      const { members: merged, parents } = mergeTeamRoster(
        conversation.teamMembers ?? [],
        conversation.teamParents ?? {},
        members,
        parent
      );
      store.upsertConversation({ ...conversation, teamMembers: merged, teamParents: parents });
      return { members: merged, parents };
    }

    if (id === 'team.task.create') {
      const args = (rawArgs ?? {}) as {
        title?: unknown;
        detail?: unknown;
        assignee?: unknown;
        dependsOn?: unknown;
        mode?: unknown;
        workspace?: unknown;
      };
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) throw new Error('任务需要标题');
      const conversation = requireConversation(conversationId);
      const assignee = typeof args.assignee === 'string' ? args.assignee : undefined;
      if (assignee && !(conversation.teamMembers ?? []).includes(assignee)) {
        throw new Error(`指派对象 ${assignee} 不在这次协作成员里，先 team.spawn`);
      }
      const taskId = nextId('task');
      const dependsOn = Array.isArray(args.dependsOn)
        ? args.dependsOn.filter((item): item is string => typeof item === 'string')
        : undefined;
      const mode = args.mode === 'read' || args.mode === 'write' ? args.mode : undefined;
      const task = createTeamTask(
        conversation.teamTasks ?? [],
        {
          id: taskId,
          title,
          ...(typeof args.detail === 'string' && args.detail.trim() ? { detail: args.detail } : {}),
          ...(assignee ? { assignee } : {}),
          ...(dependsOn ? { dependsOn } : {}),
          ...(mode ? { mode } : {}),
          ...(typeof args.workspace === 'string' && args.workspace.trim() ? { workspace: args.workspace } : {})
        },
        Date.now()
      );
      const teamTasks = [...(conversation.teamTasks ?? []), task];
      store.upsertConversation({ ...conversation, teamTasks });
      return task;
    }

    if (id === 'team.task.get') {
      const args = (rawArgs ?? {}) as { id?: unknown };
      const conversation = requireConversation(conversationId);
      const tasks = conversation.teamTasks ?? [];
      const task = tasks.find(item => item.id === args.id);
      if (!task) throw new Error(`没有这个任务：${String(args.id ?? '')}`);
      const progress = teamProgress(tasks);
      const blocked = progress.blocked.find(item => item.task.id === task.id);
      return {
        ...task,
        revision: taskRevision(task),
        ready: task.status === 'todo' && !blocked,
        blockedBy: blocked?.missing ?? []
      };
    }

    if (id === 'team.task.list') {
      const conversation = requireConversation(conversationId);
      const tasks = conversation.teamTasks ?? [];
      const progress = teamProgress(tasks);
      return {
        tasks: tasks.map(task => ({ ...task, revision: taskRevision(task) })),
        total: progress.total,
        done: progress.done,
        ready: progress.ready.map(task => task.id),
        blocked: progress.blocked.map(item => ({ id: item.task.id, missing: item.missing })),
        members: conversation.teamMembers ?? [],
        parents: conversation.teamParents ?? {}
      };
    }

    if (id === 'team.task.update') {
      const args = (rawArgs ?? {}) as {
        id?: unknown;
        status?: unknown;
        expectedRevision?: unknown;
        note?: unknown;
        evidence?: unknown;
        workspace?: unknown;
      };
      if (args.status !== 'todo' && args.status !== 'doing' && args.status !== 'done' && args.status !== 'blocked') {
        throw new Error('team.task.update 只接受 todo / doing / done / blocked');
      }
      const expectedRevision = Number(args.expectedRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw new Error('team.task.update 需要 expectedRevision（先 team.task.get）');
      }
      const conversation = requireConversation(conversationId);
      const evidence = Array.isArray(args.evidence)
        ? args.evidence.filter((item): item is TeamTaskEvidence => Boolean(
            item && typeof item === 'object' &&
            typeof (item as TeamTaskEvidence).detail === 'string' &&
            ['execution_report', 'test', 'diagnostic', 'commit', 'note'].includes(String((item as TeamTaskEvidence).kind))
          ))
        : undefined;
      const teamTasks = updateTeamTask(
        conversation.teamTasks ?? [],
        {
          id: String(args.id ?? ''),
          status: args.status,
          expectedRevision,
          ...(typeof args.note === 'string' ? { note: args.note } : {}),
          ...(evidence ? { evidence } : {}),
          ...(typeof args.workspace === 'string' ? { workspace: args.workspace } : {})
        },
        { workspaceRoot: conversation.workspaceRoot, now: Date.now() }
      );
      store.upsertConversation({ ...conversation, teamTasks });
      const next = teamTasks.find(item => item.id === args.id);
      return next ? { ...next, revision: taskRevision(next) } : next;
    }

    if (id === 'team.wait') {
      const conversation = requireConversation(conversationId);
      return teamWait(conversation.teamTasks ?? []);
    }

    throw new Error(`未登记的主进程能力：${id}`);
  });

  // 定时任务：只跑本地/云端，绝不发网页。到点创建一条只读会话，失败写回 lastError。
  startScheduler({
    store: scheduleStore,
    run: async schedule => {
      await conversations.start({
        text: schedule.text,
        workspaceMode: 'knowledge',
        permissionPreset: 'read-only',
        executionConfig: { executionMode: schedule.mode }
      });
    }
  });

  await createWindow();
});

app.on('before-quit', () => {
  if (statusTimer) clearInterval(statusTimer);
  lspRegistry?.dispose();
  codeIndexService?.close();
  // Every adapter, not the two that used to exist: a source added in 设置 owns
  // one too, and a pending wait on it would otherwise keep the app alive.
  for (const adapter of adapters.values()) adapter.cancelAllWaits();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
