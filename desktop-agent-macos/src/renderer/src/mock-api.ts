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

/** The shipped list, as the preview's starting point. */
const PAGE_SOURCES = [...BUILTIN_SOURCES];
import { computeSplit } from '../../shared/layout';
import { describeCapabilities } from '../../shared/capabilities';
import { EXPERTISE_IDS, expertiseFallback, type ExpertiseView } from '../../shared/expertise';

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
      loading: false
    }),
    setSource: async (id: string) => ({
      sources: [...PAGE_SOURCES],
      activeId: id,
      planningId: PAGE_SOURCES[0].id,
      loading: false
    }),
    getViewBounds: async () => ({}),
    // The preview keeps its edits in memory: there is no user-data directory in
    // a browser tab, and the point of the mock is that the panel renders both
    // states, not that it survives a reload.
    saveSource: async (id: string, patch: { url?: string; enabled?: boolean }) => ({
      sources: PAGE_SOURCES.map(source => (source.id === id ? { ...source, ...patch } : source)),
      activeId: PAGE_SOURCES[0].id,
      planningId: PAGE_SOURCES[0].id,
      loading: false
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
      loading: false
    }),
    removeSource: async () => ({
      sources: [...PAGE_SOURCES],
      activeId: PAGE_SOURCES[0].id,
      planningId: PAGE_SOURCES[0].id,
      loading: false
    }),
    // There is no native page to reload in the preview; the button still has to
    // exist and still has to bounce back to "not loading".
    reloadPage: async () => ({
      sources: [...PAGE_SOURCES],
      activeId: PAGE_SOURCES[0].id,
      planningId: PAGE_SOURCES[0].id,
      loading: false
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
    getWorkspace: async () => ({ workspaceMode: 'knowledge' as const, workspaceRoot: '' }),
    setWorkspace: async (patch: { workspaceMode?: 'knowledge' | 'engineering'; workspaceRoot?: string }) => ({
      workspaceMode: patch.workspaceMode ?? ('knowledge' as const),
      workspaceRoot: patch.workspaceRoot ?? ''
    }),
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
    getConversations: async () => [],
    getConversation: async () => null,
    getConversationMessages: async () => [],
    cancelConversation: async () => undefined,
    deleteConversation: async () => ({ cleaned: [], reset: [], failed: [] }),
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
    // 浏览器预览里没有真实的网页视图，也没有文件系统：不假装保存成功。
    savePageDocument: async () => { throw new Error('浏览器预览里不能读取网页或写文件'); },
    getChannelStatuses: async () => [],
    getExecutionOptions: async () => ({
      modes: ['web', 'local', 'cloud', 'hybrid'],
      webChannels: [],
      localModels: ['qwen2.5:7b'],
      cloudMembers: [
        { id: 'openai:gpt-4o-mini', label: 'OpenAI · gpt-4o-mini', hasKey: false },
        { id: 'deepseek:deepseek-v4-flash', label: 'DeepSeek · deepseek-v4-flash', hasKey: false }
      ],
      cloudProviders: [
        { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini'], hasKey: false },
        { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], hasKey: false },
        { id: 'opencode', label: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', models: ['deepseek-v4-flash', 'kimi-k2.6'], hasKey: false, note: '只支持走 Chat Completions 的模型' }
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
    setCloudConfig: async ({ id, baseUrl, models }) => ({ id, label: id, baseUrl: baseUrl ?? '', models: models ?? [], hasKey: false }),
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
