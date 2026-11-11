import type {
  AgentApi,
  AgentEvent,
  AgentTask,
  DeepSeekStatus,
  PermissionPreset,
  PlanPreview
} from '../../shared/contracts';
import { BUILTIN_SOURCES } from '../../shared/sources';
import type { SearchSettingsView } from '../../shared/search';
import type { Conversation } from '../../shared/conversation';
import type { WorkspaceEntry } from '../../shared/workspace';

/** The shipped list, as the preview's starting point. */
const PAGE_SOURCES = [...BUILTIN_SOURCES];
import { computeSplit } from '../../shared/layout';
import { describeCapabilities } from '../../shared/capabilities';
import { EXPERTISE_IDS, expertiseFallback, type ExpertiseView } from '../../shared/expertise';
import { OPENCODE_GO_MODELS } from '../../shared/opencode-models';
import { aggregateTotals, foldTrace, type TraceEntry } from '../../shared/trace';

/**
 * Dev-only stand-in for the preload API so the renderer can be opened in a plain
 * browser (`npx vite --root src/renderer`) without Electron.
 *
 * Guarded by `import.meta.env.DEV` in main.tsx and therefore excluded from the
 * production bundle. It never touches the filesystem.
 */

const now = Date.now();

const plan: PlanPreview = {
  planId: 'plan-demo',
  taskId: 'task-demo',
  roundId: 'round-1',
  title: '分析项目结构并生成报告',
  description: '读取工作区目录与 package.json，汇总模块依赖后生成 Markdown 报告。',
  completion: 'reports/project-analysis.md 已生成且内容校验通过',
  steps: [
    { id: 'step-1', tool: 'fs.list', description: '列出项目根目录', args: { path: '.' } },
    { id: 'step-2', tool: 'fs.readFile', description: '读取 package.json', args: { path: 'package.json' } },
    { id: 'step-3', tool: 'fs.mkdir', description: '创建报告目录', args: { path: 'reports' } },
    {
      id: 'step-4',
      tool: 'fs.writeFile',
      description: '写入分析报告',
      args: { path: 'reports/project-analysis.md', content: '# 项目分析\n\n…' }
    }
  ]
};

const tasks: AgentTask[] = [
  {
    taskId: 'task-demo',
    title: '分析项目结构并生成报告',
    userPrompt: '分析当前项目，找出主要模块和依赖关系，生成一份 Markdown 项目分析报告。',
    status: 'awaiting_approval',
    permissionPreset: 'workspace-write',
    workspaceRoot: '/Users/example/workspace',
    currentRoundId: 'round-1',
    currentPlanId: 'plan-demo',
    createdAt: now - 1000 * 60 * 6,
    updatedAt: now - 1000 * 60 * 2,
    maxRounds: 20,
    maxSteps: 30,
    timeoutMs: 180_000
  },
  {
    taskId: 'task-done',
    title: '检查 Netty 堆外内存泄漏',
    userPrompt: '检查当前 Java 项目的 Netty 堆外内存使用情况。',
    status: 'completed',
    permissionPreset: 'read-only',
    workspaceRoot: '/Users/example/workspace',
    createdAt: now - 1000 * 60 * 60 * 26,
    updatedAt: now - 1000 * 60 * 60 * 25,
    maxRounds: 20,
    maxSteps: 30,
    timeoutMs: 180_000
  },
  {
    taskId: 'task-old',
    title: '生成发票获取脚本说明',
    userPrompt: '整理微信读书发票获取步骤。',
    status: 'failed',
    permissionPreset: 'workspace-write',
    workspaceRoot: '/Users/example/workspace',
    createdAt: now - 1000 * 60 * 60 * 24 * 5,
    updatedAt: now - 1000 * 60 * 60 * 24 * 5,
    maxRounds: 20,
    maxSteps: 30,
    timeoutMs: 180_000
  }
];

const events: Record<string, AgentEvent[]> = {
  'task-demo': [
    { type: 'round.started', at: now - 120_000, taskId: 'task-demo', roundId: 'round-1', roundNumber: 1, inputType: 'user_prompt' },
    { type: 'round.answer', at: now - 90_000, taskId: 'task-demo', roundId: 'round-1', text: '（示例回答）' },
    { type: 'plan.ready', at: now - 88_000, taskId: 'task-demo', roundId: 'round-1', plan }
  ],
  'task-done': [
    { type: 'round.started', at: now - 90_000_000, taskId: 'task-done', roundId: 'r1', roundNumber: 1, inputType: 'user_prompt' },
    { type: 'report.ready', at: now - 89_000_000, taskId: 'task-done', roundId: 'r1', report: {
      protocol: 'desktop-agent/v1', type: 'execution_report', taskId: 'task-done', roundId: 'r1', planId: 'p1',
      status: 'completed', results: [], errors: [], nextAction: 'complete', createdAt: now - 89_000_000
    } },
    { type: 'task.completed', at: now - 88_900_000, taskId: 'task-done', summary: '已生成堆外内存排查报告' }
  ]
};

/**
 * 浏览器预览里的轨迹样例：两答一败 + 汇总 + 综合。
 *
 * 和真机要保持同一种“未知”表达：网页通道没有 token，所以 usage 里是 null，
 * 不是 0。
 */
function mockTrace(conversationId: string): TraceEntry[] {
  const t = now;
  const base = { conversationId, at: t, turn: 1 };
  return [
    { ...base, seq: 1, step: 0, kind: 'turn', phase: 'start', status: 'running', startedAt: t, inputPreview: '分析一下这个工程为什么启动慢', meta: { executionMode: 'web', selectedCloudModels: 2 } },
    { ...base, seq: 2, step: 0, kind: 'event', phase: 'instant', stage: 'route', group: 'prepare', status: 'ok', reason: '用户问原因，按研究处理' },
    { ...base, seq: 3, step: 1, kind: 'step', phase: 'start', stage: 'answer', group: 'first', status: 'running', actorId: 'deepseek', actorLabel: 'DeepSeek', sourceType: 'web', startedAt: t + 100, inputPreview: '分析一下这个工程为什么启动慢' },
    { ...base, seq: 4, step: 2, kind: 'step', phase: 'start', stage: 'answer', group: 'first', status: 'running', actorId: 'chatgpt', actorLabel: 'ChatGPT', sourceType: 'web', startedAt: t + 100, inputPreview: '分析一下这个工程为什么启动慢' },
    { ...base, seq: 5, step: 3, kind: 'step', phase: 'start', stage: 'answer', group: 'first', status: 'running', actorId: 'hy4', actorLabel: 'Ollama · hy4', sourceType: 'local', startedAt: t + 100, inputPreview: '分析一下这个工程为什么启动慢' },
    { ...base, seq: 6, step: 1, kind: 'step', phase: 'end', status: 'ok', endedAt: t + 12_400, outputPreview: '先看启动脚本和依赖初始化顺序……', usage: { inputTokens: null, outputTokens: null }, meta: { outputChars: 320 } },
    { ...base, seq: 7, step: 2, kind: 'step', phase: 'end', status: 'failed', endedAt: t + 3_100, error: { code: 'auth', detail: '还没有配置 API Key' } },
    { ...base, seq: 8, step: 3, kind: 'step', phase: 'end', status: 'ok', endedAt: t + 28_700, outputPreview: '本地模型给出的排查顺序……', usage: { inputTokens: 820, outputTokens: 460 }, meta: { outputChars: 460 } },
    { ...base, seq: 9, step: 4, kind: 'step', phase: 'start', stage: 'lead', group: 'lead', status: 'running', actorId: 'deepseek', actorLabel: 'DeepSeek', sourceType: 'web', startedAt: t + 29_000, reason: '汇总' },
    { ...base, seq: 10, step: 4, kind: 'step', phase: 'end', status: 'ok', endedAt: t + 38_800, outputPreview: '【结论】启动慢主要来自……', usage: { inputTokens: null, outputTokens: null }, meta: { claims: 2, disputes: 1, gaps: 1 } },
    { ...base, seq: 11, step: 5, kind: 'step', phase: 'start', stage: 'synthesis', group: 'synthesis', status: 'running', actorId: 'system', actorLabel: '综合', sourceType: 'system', startedAt: t + 39_000 },
    { ...base, seq: 12, step: 5, kind: 'step', phase: 'end', status: 'ok', endedAt: t + 39_200, outputPreview: '3 个通道里 2 个给出了回答……', meta: { claims: 2, disputes: 1, gaps: 1, degraded: false } },
    { ...base, seq: 13, step: 0, kind: 'turn', phase: 'end', status: 'ok', endedAt: t + 39_300 }
  ];
}

export function createMockApi(): AgentApi {
  let capabilityDisabled: string[] = [];
  let expertiseDisabled: string[] = [];
  /** 浏览器预览读不到 .md：给一份静态清单让设置页能看，不假装有文件内容。 */
  const previewExpertise = (): ExpertiseView[] =>
    EXPERTISE_IDS.map(id => ({
      ...expertiseFallback(id),
      enabled: !expertiseDisabled.includes(id),
      source: 'builtin' as const,
      filePath: '（浏览器预览不读磁盘）',
      userPath: '（浏览器预览不读磁盘）',
      chars: 0
    }));
  let preset: PermissionPreset = 'workspace-write';
  // 预览里的工作区：一个真实目录名，让侧栏的分组标题不是占位符。第二个空
  // 工作区是为了能看到「还没有会话」那一行——只放一个有内容的组，折叠与空
  // 状态在预览里就永远走不到。
  let workspaces: WorkspaceEntry[] = [
    {
      workspaceId: 'ws-example',
      name: 'workspace',
      root: '/Users/example/workspace',
      createdAt: now - 1000 * 60 * 60 * 24 * 30,
      updatedAt: now - 1000 * 60 * 60 * 2
    },
    {
      workspaceId: 'ws-notes',
      name: '笔记整理',
      root: '/Users/example/notes',
      createdAt: now - 1000 * 60 * 60 * 24 * 7,
      updatedAt: now - 1000 * 60 * 60 * 24 * 7
    }
  ];
  let activeWorkspaceId = 'ws-example';
  let workspaceMode: 'knowledge' | 'engineering' = 'knowledge';
  let workspaceRoot = '/Users/example/workspace';
  // 侧栏分组在预览里也要有东西可分：三问落在第一个工作区，一问故意不给归属，
  // 这样「未分组」那条回退路径也能看见，而不是只存在于单元测试里。
  let conversations: Conversation[] = [
    {
      conversationId: 'conv-1',
      title: 'Java 和 Go 谁更适合做网关',
      intent: 'answer',
      intentReason: '默认按问答处理',
      status: 'answered',
      channels: ['deepseek', 'chatgpt', 'gemini'],
      workspaceId: 'ws-example',
      workspaceMode: 'knowledge',
      createdAt: now - 1000 * 60 * 12,
      updatedAt: now - 1000 * 60 * 4
    },
    {
      conversationId: 'conv-2',
      title: '整理这周的阅读笔记',
      intent: 'answer',
      intentReason: '默认按问答处理',
      status: 'answered',
      channels: ['deepseek'],
      workspaceId: 'ws-example',
      workspaceMode: 'knowledge',
      createdAt: now - 1000 * 60 * 60 * 26,
      updatedAt: now - 1000 * 60 * 60 * 25
    },
    {
      conversationId: 'conv-3',
      title: '向量数据库的索引怎么选',
      intent: 'answer',
      intentReason: '默认按问答处理',
      status: 'answered',
      channels: ['deepseek', 'kimi'],
      workspaceId: 'ws-example',
      workspaceMode: 'knowledge',
      createdAt: now - 1000 * 60 * 60 * 24 * 3,
      updatedAt: now - 1000 * 60 * 60 * 24 * 3
    },
    {
      conversationId: 'conv-loose',
      title: '一个还没归类的问题',
      intent: 'answer',
      intentReason: '默认按问答处理',
      status: 'answered',
      channels: ['deepseek'],
      createdAt: now - 1000 * 60 * 60 * 24 * 5,
      updatedAt: now - 1000 * 60 * 60 * 24 * 5
    }
  ];
  // 预览环境不读盘：这里给的是「没配凭据」的真实形态，不是假的可搜状态。
  let searchSettings: SearchSettingsView = {
    hasKey: false,
    fromEnv: false,
    configPath: '/Users/example/Library/Application Support/ThinkFusion/search-config.json',
    fallbackOnly: true
  };

  return {
    getSearchSettings: async () => searchSettings,
    saveSearchSettings: async patch => {
      searchSettings = {
        ...searchSettings,
        provider: patch.provider ?? undefined,
        hasKey: !!patch.apiKey,
        fromEnv: false,
        fallbackOnly: !patch.provider
      };
      return searchSettings;
    },
    testSearchSettings: async () => ({ ok: false, note: '预览环境不发真实请求' }),
    submitPrompt: async () => tasks[0],
    getTask: async taskId => tasks.find(task => task.taskId === taskId) ?? null,
    getTaskHistory: async () => tasks,
    getTaskEvents: async taskId => events[taskId] ?? [],
    approvePlan: async () => undefined,
    rejectPlan: async () => undefined,
    approveStep: async () => undefined,
    rejectStep: async () => undefined,
    answerStepQuestion: async () => undefined,
    cancelTask: async () => undefined,
    answerClarification: async () => undefined,
    deleteTask: async () => undefined,
    getPermissionPreset: async () => preset,
    setPermissionPreset: async (next: PermissionPreset) => {
      preset = next;
      return { preset, approvalPolicy: 'ask' as const };
    },
    chooseDirectory: async () => '/Users/example/workspace',
    getPlatform: async () => 'darwin',
    getDeepSeekStatus: async (): Promise<DeepSeekStatus> => ({
      url: 'https://chat.deepseek.com/',
      pageReady: true,
      loggedIn: true,
      hasInput: true,
      hasSendButton: true,
      generating: false,
      messageCount: 3
    }),
    getDeepSeekDiagnostics: async () => ({
      probeVersion: 'mock',
      url: 'https://chat.deepseek.com/',
      title: 'DeepSeek',
      status: {
        url: 'https://chat.deepseek.com/',
        pageReady: true,
        loggedIn: true,
        hasInput: true,
        hasSendButton: true,
        generating: false,
        messageCount: 3
      },
      selectors: {},
      view: { x: Math.round(window.innerWidth * 0.58), y: 0, width: computeSplit(window.innerWidth, null) - 10, height: window.innerHeight },
      dragging: false,
      probe: {
        hasInput: true,
        inputKind: 'contenteditable',
        hasSendButton: true,
        generating: false,
        messageCount: 3,
        composerChars: 0,
        lastTextPreview: '（mock 诊断数据）',
        selectorHits: { 'input:#chat-input': 1, 'input:div[contenteditable="true"]': 1 },
        chosen: { input: '#chat-input' }
      }
    }),
    // Mirrors the main process's split so the browser preview reserves the same
    // column the native page view would occupy. There is no native view here,
    // so a drag just reports the clamped width straight back.
    getLayout: async () => ({ split: computeSplit(window.innerWidth, null), collapsed: false }),
    setSplit: async (value: number) => ({ split: computeSplit(window.innerWidth, value), collapsed: false }),
    setPageDragging: async () => undefined,
    getSources: async () => ({
      sources: [...PAGE_SOURCES],
      activeId: PAGE_SOURCES[0].id,
      planningId: PAGE_SOURCES[0].id,
      loading: false,
      openOnLaunch: true,
      webViewsOpen: true
    }),
    setSource: async (id: string) => ({
      sources: [...PAGE_SOURCES],
      activeId: id,
      planningId: PAGE_SOURCES[0].id,
      loading: false,
      openOnLaunch: true,
      webViewsOpen: true
    }),
    getViewBounds: async () => ({}),
    // The preview keeps its edits in memory: there is no user-data directory in
    // a browser tab, and the point of the mock is that the panel renders both
    // states, not that it survives a reload.
    saveSource: async (id: string, patch: { url?: string; enabled?: boolean }) => ({
      sources: PAGE_SOURCES.map(source => (source.id === id ? { ...source, ...patch } : source)),
      activeId: PAGE_SOURCES[0].id,
      planningId: PAGE_SOURCES[0].id,
      loading: false,
      openOnLaunch: true,
      webViewsOpen: true
    }),
    addSource: async (input: { label: string; url: string }) => ({
      sources: [
        ...PAGE_SOURCES,
        {
          id: `custom-${input.label}`,
          label: input.label,
          glyph: input.label[0] ?? '?',
          url: input.url,
          hosts: [],
          planning: false,
          enabled: true,
          custom: true
        }
      ],
      activeId: PAGE_SOURCES[0].id,
      planningId: PAGE_SOURCES[0].id,
      loading: false,
      openOnLaunch: true,
      webViewsOpen: true
    }),
    removeSource: async () => ({
      sources: [...PAGE_SOURCES],
      activeId: PAGE_SOURCES[0].id,
      planningId: PAGE_SOURCES[0].id,
      loading: false,
      openOnLaunch: true,
      webViewsOpen: true
    }),
    setSourcesOpenOnLaunch: async (open: boolean) => ({
      sources: [...PAGE_SOURCES],
      activeId: PAGE_SOURCES[0].id,
      planningId: PAGE_SOURCES[0].id,
      loading: false,
      openOnLaunch: open,
      webViewsOpen: open
    }),
    // There is no native page to reload in the preview; the button still has to
    // exist and still has to bounce back to "not loading".
    reloadPage: async () => ({
      sources: [...PAGE_SOURCES],
      activeId: PAGE_SOURCES[0].id,
      planningId: PAGE_SOURCES[0].id,
      loading: false,
      openOnLaunch: true,
      webViewsOpen: true
    }),
    getIdentity: async () => ({ name: '本机用户', initial: '本', device: '这台 Mac' }),
    setDisplayName: async (name: string) => ({
      name: name || '本机用户',
      initial: (name || '本机用户').slice(0, 1),
      device: '这台 Mac'
    }),
    // No native views in the browser preview, so a detach is just a flag: the
    // page header still has to render both states.
    getPageState: async () => ({ detachedId: null, collapsed: false }),
    detachPage: async (sourceId?: string) => ({ detachedId: sourceId ?? PAGE_SOURCES[0].id, collapsed: false }),
    reattachPage: async () => ({ detachedId: null, collapsed: false }),
    setPageCollapsed: async (collapsed: boolean) => ({ detachedId: null, collapsed }),
    learnSelectors: async (sourceId?: string) => ({
      sourceId: sourceId ?? PAGE_SOURCES[0].id,
      learned: [],
      intact: ['input', 'sendButton', 'assistant'],
      failed: [],
      probe: { hasInput: true, hasSendButton: true, messageCount: 3, viewportWidth: window.innerWidth },
      message: '（mock）现有选择器都还命中，不需要更新'
    }),
    submitConversation: async (input: { text: string }) => ({
      conversationId: 'mock-conversation',
      title: input.text.slice(0, 42),
      intent: 'answer' as const,
      intentReason: '默认按问答处理',
      status: 'answered' as const,
      channels: ['deepseek'],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }),
    classifyIntent: async () => ({ intent: 'answer' as const, reason: '默认按问答处理' }),
    routeConversation: async (input: { text: string; workspaceMode: 'knowledge' | 'engineering'; hasProject: boolean }) => ({
      workspaceMode: input.workspaceMode,
      taskKind: input.workspaceMode === 'knowledge' ? ('answer' as const) : input.hasProject ? ('engineering_analysis' as const) : ('clarify' as const),
      reason: '（mock）预览',
      source: 'rule' as const
    }),
    getWorkspace: async () => ({ workspaceMode, workspaceRoot, activeWorkspaceId }),
    setWorkspace: async (patch: { workspaceMode?: 'knowledge' | 'engineering'; workspaceRoot?: string; activeWorkspaceId?: string }) => {
      if (patch.workspaceMode) workspaceMode = patch.workspaceMode;
      if (typeof patch.workspaceRoot === 'string') workspaceRoot = patch.workspaceRoot;
      if (typeof patch.activeWorkspaceId === 'string') activeWorkspaceId = patch.activeWorkspaceId;
      return { workspaceMode, workspaceRoot, activeWorkspaceId };
    },
    getWorkspaces: async () => [...workspaces],
    addWorkspace: async (input: { root: string; name?: string }) => {
      const existing = workspaces.find(item => item.root === input.root);
      if (existing) {
        activeWorkspaceId = existing.workspaceId;
        workspaceRoot = existing.root;
        return { workspace: existing, created: false, workspaces: [...workspaces] };
      }
      const entry: WorkspaceEntry = {
        workspaceId: `ws-${String(Date.now())}`,
        name: input.name ?? input.root.split('/').filter(Boolean).pop() ?? input.root,
        root: input.root,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      workspaces = [...workspaces, entry];
      activeWorkspaceId = entry.workspaceId;
      workspaceRoot = entry.root;
      return { workspace: entry, created: true, workspaces: [...workspaces] };
    },
    renameWorkspace: async (input: { workspaceId: string; name: string }) => {
      // 和主进程保持同一条规则：空名字拒绝。预览若默默接受，界面上就看不出
      // 「重命名失败要就地报错」这条路径。
      const name = input.name.trim();
      if (!name) throw new Error('工作区名字不能是空的。');
      const existing = workspaces.find(item => item.workspaceId === input.workspaceId);
      if (!existing) throw new Error('这个工作区已经不在了。');
      workspaces = workspaces.map(item =>
        item.workspaceId === input.workspaceId ? { ...item, name, updatedAt: Date.now() } : item
      );
      return { workspace: workspaces.find(item => item.workspaceId === input.workspaceId)!, workspaces: [...workspaces] };
    },
    removeWorkspace: async (workspaceId: string) => {
      const removed = workspaces.find(item => item.workspaceId === workspaceId);
      if (!removed) throw new Error('这个工作区已经不在了。');
      workspaces = workspaces.filter(item => item.workspaceId !== workspaceId);
      // 会话不删，只掉出分组：和主进程一样返回被清掉归属的条数。
      let clearedConversations = 0;
      conversations = conversations.map(item => {
        if (item.workspaceId !== workspaceId) return item;
        clearedConversations += 1;
        const next = { ...item };
        delete next.workspaceId;
        return next;
      });
      if (activeWorkspaceId === workspaceId) {
        activeWorkspaceId = '';
        workspaceRoot = '';
      }
      return { workspaces: [...workspaces], removed, clearedConversations };
    },
    updateConversationConfig: async (input: { conversationId: string; executionConfig?: unknown }) => ({
      conversationId: input.conversationId,
      title: '',
      intent: 'answer' as const,
      intentReason: '默认按问答处理',
      status: 'answered' as const,
      channels: [],
      executionConfig: input.executionConfig as never,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }),
    followupConversation: async (input: { conversationId: string; text: string; executionConfig?: unknown }) => ({
      conversationId: input.conversationId,
      title: input.text.slice(0, 42),
      intent: 'answer' as const,
      intentReason: '默认按问答处理',
      status: 'answered' as const,
      channels: ['deepseek'],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }),
    getConversations: async () => conversations,
    getConversation: async conversationId => conversations.find(item => item.conversationId === conversationId) ?? null,
    getConversationMessages: async () => [],
    getTrace: async ({ conversationId }: { conversationId: string }) => {
      const entries = mockTrace(conversationId);
      return {
        entries,
        hasMore: false,
        source: 'trace' as const,
        totals: aggregateTotals(foldTrace(entries))
      };
    },
    cancelConversation: async () => undefined,
    deleteConversation: async (conversationId: string) => {
      conversations = conversations.filter(item => item.conversationId !== conversationId);
      return { cleaned: [], reset: [], failed: [] };
    },
    exportConversation: async () => null,
    getCapabilities: async () => describeCapabilities(capabilityDisabled),
    setCapabilityEnabled: async (id: string, enabled: boolean) => {
      capabilityDisabled = enabled
        ? capabilityDisabled.filter(item => item !== id)
        : [...new Set([...capabilityDisabled, id])];
      return describeCapabilities(capabilityDisabled);
    },
    getExpertise: async () => previewExpertise(),
    setExpertiseEnabled: async (id: string, enabled: boolean) => {
      expertiseDisabled = enabled
        ? expertiseDisabled.filter(item => item !== id)
        : [...new Set([...expertiseDisabled, id])];
      return previewExpertise();
    },
    // 预览环境没有系统对话框：返回空数组等价于「用户取消了」，界面行为一致。
    chooseAttachments: async () => [],
    // 浏览器预览里没有真实的网页视图，也没有文件系统：不假装保存成功。
    savePageDocument: async () => { throw new Error('浏览器预览里不能读取网页或写文件'); },
    // 预览里没有真实页面：给一份示例列表，好检查「保存网页对话」的多选面板。
    extractPage: async () => ({
      sourceLabel: 'ChatGPT',
      pageTitle: '消防安全通知',
      url: 'https://chatgpt.com/c/demo',
      items: [
        { index: 0, title: '校园消防安全指南', excerpt: '@师生家长，这份校园消防安全指南请收藏。来源 | 中国消防微博', chars: 42 },
        { index: 1, title: '鄂邑反诈日报', excerpt: '警方提醒：近期出现冒充快递客服的诈骗电话，请勿向任何人透露验证码。', chars: 68 },
        { index: 2, title: '假召回 真骗局', excerpt: '国家反诈中心提醒：接到自称商家的召回电话，先挂断再通过官方渠道核实。', chars: 55 }
      ],
      totalChars: 165,
      transcriptChars: 900
    }),
    getChannelStatuses: async () => [],
    getExecutionDefaults: async () => ({
      executionMode: 'web' as const,
      selectedCloudModels: [],
      fallbackEnabled: false,
      privacyMode: 'allow-cloud' as const
    }),
    setExecutionDefaults: async config => ({
      executionMode: 'web' as const,
      selectedCloudModels: [],
      fallbackEnabled: false,
      privacyMode: 'allow-cloud' as const,
      ...config
    }),
    getExecutionOptions: async () => ({
      modes: ['web', 'local', 'cloud', 'hybrid'],
      webChannels: [],
      localModels: ['qwen2.5:7b'],
      cloudMembers: [
        { id: 'openai:gpt-4o-mini', label: 'OpenAI · gpt-4o-mini', hasKey: false },
        { id: 'deepseek:deepseek-v4-flash', label: 'DeepSeek · deepseek-v4-flash', hasKey: false },
        ...OPENCODE_GO_MODELS.map(model => ({
          id: `opencode-go:${model}`,
          label: `OpenCode Go · ${model}`,
          hasKey: false
        }))
      ],
      cloudProviders: [
        { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini'], catalog: ['gpt-4o-mini'], hasKey: false },
        { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], catalog: ['deepseek-v4-flash', 'deepseek-v4-pro'], hasKey: false },
        {
          id: 'opencode-go',
          label: 'OpenCode Go',
          baseUrl: 'https://opencode.ai/inference/go/openai/v1',
          models: [...OPENCODE_GO_MODELS],
          catalog: [...OPENCODE_GO_MODELS],
          hasKey: false,
          note: '订阅制：额度按模型月度上限算，本界面不估算单价'
        }
      ],
      providers: [],
      debateCandidates: [
        { id: 'chatgpt', label: 'ChatGPT', type: 'web', available: true },
        { id: 'kimi', label: 'Kimi', type: 'web', available: true },
        { id: 'ollama:qwen2.5:7b', label: 'Ollama · qwen2.5:7b', type: 'local', available: true },
        { id: 'openai:gpt-4o-mini', label: 'OpenAI · gpt-4o-mini', type: 'cloud', available: false, detail: '浏览器预览里没有 API Key' }
      ]
    }),
    setApiKey: async ({ id }) => ({ id, configured: true }),
    removeApiKey: async id => ({ id, configured: false }),
    setCloudConfig: async ({ id, baseUrl, models }) => ({
      id, label: id, baseUrl: baseUrl ?? '', models: models ?? [], catalog: models ?? [], hasKey: false
    }),
    setCloudModels: async ({ id, models }) => ({
      id, label: id, baseUrl: '', models, catalog: models, hasKey: false
    }),
    addCloudProvider: async ({ catalogId, label, baseUrl, models }) => ({
      id: `user:${catalogId}`,
      label: label ?? catalogId,
      baseUrl: baseUrl ?? '',
      models: models ?? [],
      hasKey: false,
      custom: true
    }),
    removeCloudProvider: async id => ({ id, removed: true }),
    discoverCloudModels: async () => { throw new Error('浏览器预览里不能访问云端接口'); },
    getProviderHealth: async () => ({}),
    getCollaborationRecords: async () => [],
    getUsage: async () => null,
    startDebate: async () => { throw new Error('浏览器预览里不能发起辩论'); },
    getDebate: async () => null,
    listDebates: async () => [],
    relatedDebates: async () => [],
    stopDebate: async () => null,
    resumeDebate: async () => null,
    cleanupDebateWeb: async () => ({ cleaned: [], reset: [], failed: [], noAddress: [] }),
    removeDebate: async id => ({ id, removed: false }),
    adjudicate: async () => { throw new Error('浏览器预览里不能裁决'); },
    getVerdict: async () => null,
    onConversationEvent: () => () => undefined,
    getAccessibilitySnapshot: async () => ({ available: false, application: null, tree: [] }),
    onAgentEvent: () => () => undefined,
    onDeepSeekEvent: () => () => undefined,
    onLayoutChanged: () => () => undefined,
    onSourcesChanged: () => () => undefined,
    onPageChanged: () => () => undefined
  };
}
