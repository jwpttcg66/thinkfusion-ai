import { app, BrowserWindow, WebContentsView, session, ipcMain, dialog, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
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
  ApprovePlanSchema,
  ClarificationAnswerSchema,
  RejectPlanSchema,
  SubmitPromptSchema,
  TaskIdSchema
} from '../shared/schemas';
import { AgentStore } from './store';
import { TaskManager } from './task-manager';
import { callPage, ChatPageDriver, createElectronDriver, DISCOVER_SCRIPT, PROBE_SCRIPT, type PageProbe } from './adapters/browser/page-driver';
import { SubAgentRegistry } from './agents/registry';
import { ProviderSubAgent } from './agents/provider-agent';
import { PageBrowserAdapter } from './adapters/browser/page-adapter';
import { isSameThread, navigateToThread } from './adapters/browser/thread-navigation';
import { profileFor, providerFor, reasoningFor, signedOutFor, signedOutTextFor, signedOutPathsFor, guestUsableFor, contextLimitFor, dismissTextFor, blockedPathsFor, challengeTextFor } from './adapters/providers';
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
import { normalizeDebateConfig } from './debate/types';
import { normalizeLeadMode, planLead, type DebateCandidate } from './debate/lead';
import { CLOUD_PRESETS, normalizeModels, presetOf, resolvePreset, type CloudPreset } from './providers/cloud-presets';
import { CloudConfigStore } from './providers/cloud-config';
import { JudgeEngine } from './judge/engine';
import { VerdictStore } from './judge/store';
import type { JudgeVerdict } from './judge/types';
import { classifyIntent } from '../shared/intent';
import type { ChannelStatus, ConversationEvent } from '../shared/conversation';
import { AgentOrchestrator } from './orchestrator';
import { setAgentEventSink, startAgentProcess } from './agent-manager';
import { collapsedSplit, computePageBounds, computeSplit, type PageBounds } from '../shared/layout';
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  restoreWindowPlacement,
  type WindowPlacement
} from '../shared/window-state';
import { writeFileAtomic } from './atomic-write';
import {
  isAllowedSourceUrl,
  makeCustomSource,
  normalizeSourceUrl,
  planningSource,
  resolveSources,
  sourceById,
  type PageSource,
  type SourceOverride,
  type StoredSources
} from '../shared/sources';
import { SourceStore } from './source-store';
import { ProfileStore } from './profile-store';
import { WorkspaceStore } from './workspace-store';
import { runSearchTest, saveSearchSettings, viewSearchSettings } from './search-settings';
import { SEARCH_PROVIDERS, type SearchProvider } from '../shared/search';
import { reviewExecution } from './engineering/review';
import { planReviewQuestion, summarizePlanDebate } from './engineering/plan-review';
import { normalizeWorkspaceState, routeTask, type EngineeringTaskKind as WorkspaceTaskKind } from '../shared/workspace';
import { deviceLabel, initialOf, DEFAULT_DISPLAY_NAME } from '../shared/identity';
import { mergeProfile, SelectorStore } from './selector-profile';
import { confirmRepairs, proposeRepairs } from '../shared/selectors';
import { ICON_DOCK_BACK_PATHS, iconSvg } from '../shared/icons';
import type {
  DiscoveredSelectors,
  LearnSelectorsReport,
  LearnedRole,
  RepairableRole,
  SelectorProfile,
  SelectorRole
} from '../shared/selectors';
import { PlatformAccessibility } from '../platform/accessibility';

let win: BrowserWindow | null = null;

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
/** V2.1：上次使用的空间与项目。created in `whenReady`. */
let workspaceStore: WorkspaceStore | null = null;
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
    for (const preset of CLOUD_PRESETS) {
      const resolved = resolvePreset(preset, cloudConfigs?.get(preset.id));
      cloudCatalog.push(resolved);
      const provider = new OpenAICompatibleProvider({
        id: resolved.id,
        label: resolved.label,
        baseUrl: resolved.baseUrl,
        models: resolved.models,
        defaultModel: resolved.models[0],
        keyStore: apiKeys
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
 * While folded the reservation is the rail plus the stub, not zero: the app
 * column has to stop before the rail or the source buttons end up painted over
 * the composer. `collapsed` is what tells the renderer the small number means
 * "no page here" rather than "a 76px page".
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
    loading: sourceLoading
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
 * Make the running app match a new setting for one source.
 *
 * Three things can change and they are independent:
 *
 * - a new address means a real navigation, but **the same view**. The partition
 *   — and therefore the login — belongs to the source id, not to the URL, so
 *   recreating the view would silently sign the user out of the site they just
 *   fixed the address for;
 * - switching on means the view has to exist at all;
 * - switching off the page that is on screen means something else has to be on
 *   screen, or the pane shows a page the rail no longer lists.
 */
function syncSource(before: PageSource | undefined, after: PageSource) {
  const view = views.get(after.id);
  // A view that does not exist yet has to be primed before the layout pass at
  // the end of this function parks it, or it spends its whole life at 0x0.
  const created = after.enabled && !view ? createSourceView(after) : null;

  if (view && before?.url !== after.url && after.url) {
    void view.webContents.loadURL(after.url).catch(() => undefined);
  }
  if (!after.enabled && activeSourceId === after.id) {
    const next = sources.find(source => source.enabled);
    if (next) activeSourceId = next.id;
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
 * fixes to it invisible. Removing a custom one is the only case where the view
 * itself has to go, so this is the only place that closes a `WebContentsView`.
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

  if (detached?.sourceId === id) reattachSource();
  const view = views.get(id);
  if (view && !view.webContents.isDestroyed()) {
    win?.contentView.removeChildView(view);
    view.webContents.close();
  }
  views.delete(id);
  applied.delete(id);
  adapters.delete(id);

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
    display: flex; align-items: center; gap: 10px;
    padding: 0 12px 0 84px; box-sizing: border-box;
    background: #f7f7f5; border-bottom: 1px solid rgba(0, 0, 0, 0.12);
    -webkit-app-region: drag; user-select: none;
  }
  .name { font-weight: 600; letter-spacing: 0.02em; }
  .hint { color: #8a8a86; }
  .spacer { flex: 1; }
  /* Same 24px square as the main window's page bar, and the same glyph: the two
     windows perform the same action, so they must not look different. */
  button {
    -webkit-app-region: no-drag; display: grid; place-items: center;
    width: 24px; height: 24px; padding: 0; border-radius: 6px;
    border: 1px solid rgba(0, 0, 0, 0.16); background: #fff;
    color: #6b6b6b; cursor: pointer;
  }
  button:hover { background: #efefec; color: #1a1a1a; }
  button svg { display: block; }
</style></head><body>
<div class="bar">
  <span class="name">${label}</span>
  <span class="hint">独立窗口 · 关闭即吸附回去</span>
  <span class="spacer"></span>
  <button id="back" type="button" aria-label="吸附回去" title="吸附回去">${iconSvg(ICON_DOCK_BACK_PATHS)}</button>
</div>
<script>document.getElementById('back').addEventListener('click', function () { window.close(); });</script>
</body></html>`;
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
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
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
    reattachSource();
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
    const view = views.get(agentId);
    if (!view || view.webContents.isDestroyed()) {
      failed.push({ agentId, detail: '网页视图不存在' });
      return;
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
  try {
    for (const source of sources.filter(item => item.enabled)) createSourceView(source);
    await primeViewports();
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

function registerIpc() {
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
      taskKindOverride?: unknown;
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
      taskKindOverride:
        input.taskKindOverride === 'analysis' || input.taskKindOverride === 'execution'
          ? (input.taskKindOverride as WorkspaceTaskKind)
          : undefined
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
    const input = raw as { conversationId?: unknown; text?: unknown; executionConfig?: unknown; taskKindOverride?: unknown };
    if (typeof input.conversationId !== 'string') throw new Error('缺少对话 id');
    if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('先写一句你想追问的内容。');
    // 追问也要带上当前的研究设置：执行模式存在会话里，只按创建时那份跑的话，
    // 用户后来改成「本地主导」，追问仍然由网页主导——界面上写着本地，实际照旧。
    return conversations.followup(
      input.conversationId,
      input.text,
      input.executionConfig && typeof input.executionConfig === 'object'
        ? (input.executionConfig as Record<string, unknown>)
        : undefined,
      input.taskKindOverride === 'analysis' || input.taskKindOverride === 'execution'
        ? (input.taskKindOverride as WorkspaceTaskKind)
        : undefined
    );
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
    const input = raw as { workspaceMode?: unknown; workspaceRoot?: unknown };
    return workspaceStore.set({
      ...(input.workspaceMode === 'engineering' || input.workspaceMode === 'knowledge'
        ? { workspaceMode: input.workspaceMode }
        : {}),
      ...(typeof input.workspaceRoot === 'string' ? { workspaceRoot: input.workspaceRoot.slice(0, 2000) } : {})
    });
  });

  ipcMain.handle('conversation:route', (event, raw: unknown) => {
    trustedUiSender(event);
    if (!raw || typeof raw !== 'object') throw new Error('无效输入');
    const input = raw as {
      text?: unknown; workspaceMode?: unknown; hasProject?: unknown; override?: unknown;
    };
    return routeTask({
      text: typeof input.text === 'string' ? input.text : '',
      workspaceMode: normalizeWorkspaceState({ workspaceMode: input.workspaceMode }).workspaceMode,
      hasProject: input.hasProject === true,
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
        note: item.note,
        hasKey: apiKeys?.has(item.id) ?? false
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

  ipcMain.handle('app:set-api-key', (event, raw: unknown) => {
    trustedUiSender(event);
    if (!apiKeys) throw new Error('设置还没有准备好');
    if (!raw || typeof raw !== 'object') throw new Error('无效输入');
    const input = raw as { id?: unknown; key?: unknown };
    if (typeof input.id !== 'string' || !input.id.trim() || typeof input.key !== 'string') {
      throw new Error('无效输入');
    }
    apiKeys.set(input.id, input.key);
    rebuildProviders();
    return { id: input.id, configured: true };
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
    if (typeof input.id !== 'string' || !presetOf(input.id)) throw new Error('未知的云端服务');
    const patch: { baseUrl?: string; models?: string[] } = {};
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
    }
    cloudConfigs.set(input.id, patch);
    rebuildProviders();
    const resolved = cloudCatalog.find(item => item.id === input.id);
    return resolved
      ? { id: resolved.id, baseUrl: resolved.baseUrl, models: resolved.models, hasKey: apiKeys?.has(resolved.id) ?? false }
      : { id: input.id, baseUrl: patch.baseUrl ?? '', models: patch.models ?? [], hasKey: false };
  });

  ipcMain.handle('app:remove-api-key', (event, id: unknown) => {
    trustedUiSender(event);
    if (!apiKeys || typeof id !== 'string') throw new Error('无效输入');
    apiKeys.remove(id);
    rebuildProviders();
    return { id, configured: false };
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
    const input = raw as { question?: unknown; config?: unknown; conversationId?: unknown };
    if (typeof input.question !== 'string' || !input.question.trim()) throw new Error('先写一句要辩论的问题');
    const rawConfig = (input.config ?? {}) as Record<string, unknown>;
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
    return debates.start(input.question, rawConfig,
      typeof input.conversationId === 'string' ? input.conversationId : undefined, plan);
  });

  ipcMain.handle('debate:get', (event, id: unknown) => {
    trustedUiSender(event);
    if (!debates || typeof id !== 'string') throw new Error('无效输入');
    return debates.get(id);
  });

  ipcMain.handle('debate:list', event => {
    trustedUiSender(event);
    return debates?.list() ?? [];
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
    return relatedDebates(debates.list(), input.question, {
      exclude: typeof input.exclude === 'string' ? input.exclude : undefined
    });
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

app.whenReady().then(async () => {
  store = new AgentStore(path.join(app.getPath('userData'), 'agent-store.json'));
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
  workspaceStore = new WorkspaceStore(path.join(app.getPath('userData'), 'workspace-state.json'));

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
        leadPlan
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
        leadAgentId: config.leadAgentId
      }),
    restoreThreads: restoreThreadViews,
    channelStatuses: async () => {
      const statuses = await registry.statuses();
      lastChannelStatuses = statuses;
      lastChannelSnapshotAt = Date.now();
      return statuses;
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
      const plan = planLead({
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
          // 任务书第 10 节的默认预算：单次 90 秒、整场 4 分钟、同时问 3 位。
          budget: { stageTimeoutMs: 90_000, totalMs: 240_000, maxConcurrency: 3 }
        },
        input.conversationId,
        plan
      );
      const done = await debates.waitFor(state.debateId, 240_000);
      if (!done) return null;
      return {
        debateId: done.debateId,
        status: done.status,
        rounds: done.rounds.map(round => ({
          index: round.index,
          messages: round.messages.map(message => ({
            author: labelOf(message.agentId),
            kind: message.kind,
            text: message.text
          })),
          failures: round.failures
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

  await createWindow();
});

app.on('before-quit', () => {
  if (statusTimer) clearInterval(statusTimer);
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
