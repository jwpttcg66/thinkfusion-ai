import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentApi,
  AgentEvent,
  ApprovePlanInput,
  DeepSeekEvent,
  DeepSeekStatus,
  LayoutInfo,
  PageState,
  PermissionPreset,
  SourcesState,
  SubmitPromptInput,
  TraceQuery
} from '../shared/contracts';
import type {
  Conversation,
  ConversationEvent,
  ConversationExecutionConfig,
  ConversationMessage,
  FollowupConversationInput,
  SubmitConversationInput
} from '../shared/conversation';

import type {
  EngineeringTaskKind,
  TaskRouting,
  WorkspaceEntry,
  WorkspaceMode,
  WorkspaceState
} from '../shared/workspace';
import type { SearchSettingsPatch, SearchSettingsView, SearchTestResult } from '../shared/search';
import type { MemoryApi } from '../shared/memory-api';
import type { ExportConversationInput, SavePageDocumentInput } from '../shared/export';
import type {
  CliAgentView,
  CliCapabilityRecordView,
  CliTerminalState,
  CliVerifyResult,
  TerminalAttach,
  TerminalDataEvent,
  TerminalSessionSummary,
  TerminalWindowState
} from '../shared/cli-agents';
import type { CliSoftwareSource } from '../shared/cli-software-source';
import type {
  TaskWorktreeCommitInput,
  TaskWorktreeDiff,
  TaskWorktreeMergeResult,
  TaskWorktreeRemoveInput,
  TaskWorktreeView
} from '../shared/worktree';

/**
 * The renderer gets exactly these calls and nothing else. No generic
 * `invoke(channel, ...)` escape hatch, no ipcRenderer passthrough.
 */
const memoryApi: MemoryApi = {
  status: () => ipcRenderer.invoke('memory:status'),
  getSettings: () => ipcRenderer.invoke('memory:settings:get'),
  setSettings: patch => ipcRenderer.invoke('memory:settings:set', patch),
  listCandidates: status => ipcRenderer.invoke('memory:candidates:list', status),
  confirmCandidate: id => ipcRenderer.invoke('memory:candidates:confirm', id),
  rejectCandidate: id => ipcRenderer.invoke('memory:candidates:reject', id),
  listRecords: query => ipcRenderer.invoke('memory:records:list', query),
  getRecord: id => ipcRenderer.invoke('memory:records:get', id),
  remember: input => ipcRenderer.invoke('memory:records:remember', input),
  patchRecord: (id, patch) => ipcRenderer.invoke('memory:records:patch', id, patch),
  deleteRecord: id => ipcRenderer.invoke('memory:records:delete', id),
  conflicts: () => ipcRenderer.invoke('memory:conflicts'),
  refute: id => ipcRenderer.invoke('memory:governance:refute', id),
  expire: id => ipcRenderer.invoke('memory:governance:expire', id),
  archive: id => ipcRenderer.invoke('memory:governance:archive', id),
  supersede: (oldId, input) => ipcRenderer.invoke('memory:governance:supersede', oldId, input),
  getUsage: requestId => ipcRenderer.invoke('memory:usage:get', requestId),
  listUsage: conversationId => ipcRenderer.invoke('memory:usage:list', conversationId),
  audit: limit => ipcRenderer.invoke('memory:audit', limit),
  exportAll: () => ipcRenderer.invoke('memory:export'),
  exportToFile: () => ipcRenderer.invoke('memory:export-file'),
  importAll: data => ipcRenderer.invoke('memory:import', data),
  links: id => ipcRenderer.invoke('memory:links', id),
  extract: input => ipcRenderer.invoke('memory:extract', input)
};

const api: AgentApi = {
  memory: memoryApi,
  submitConversation: (input: SubmitConversationInput) => ipcRenderer.invoke('conversation:submit', input),
  classifyIntent: (text: string) => ipcRenderer.invoke('conversation:classify', text),
  routeConversation: (input: { text: string; workspaceMode: WorkspaceMode; hasProject: boolean; override?: EngineeringTaskKind }): Promise<TaskRouting> =>
    ipcRenderer.invoke('conversation:route', input),
  getWorkspace: (): Promise<WorkspaceState> => ipcRenderer.invoke('workspace:get'),
  setWorkspace: (patch: Partial<WorkspaceState>): Promise<WorkspaceState> => ipcRenderer.invoke('workspace:set', patch),
  getWorkspaces: (): Promise<WorkspaceEntry[]> => ipcRenderer.invoke('workspace:list'),
  addWorkspace: (input: { root: string; name?: string }) => ipcRenderer.invoke('workspace:add', input),
  renameWorkspace: (input: { workspaceId: string; name: string }) => ipcRenderer.invoke('workspace:rename', input),
  removeWorkspace: (workspaceId: string) => ipcRenderer.invoke('workspace:remove', { workspaceId }),
  getSearchSettings: (): Promise<SearchSettingsView> => ipcRenderer.invoke('search:get'),
  saveSearchSettings: (patch: SearchSettingsPatch): Promise<SearchSettingsView> =>
    ipcRenderer.invoke('search:save', patch),
  testSearchSettings: (patch: SearchSettingsPatch): Promise<SearchTestResult> =>
    ipcRenderer.invoke('search:test', patch),
  followupConversation: (input: FollowupConversationInput) => ipcRenderer.invoke('conversation:followup', input),
  updateConversationConfig: (input: { conversationId: string; executionConfig: Partial<ConversationExecutionConfig> }) =>
    ipcRenderer.invoke('conversation:config', input),
  getConversations: () => ipcRenderer.invoke('conversation:list'),
  getConversation: (conversationId: string) => ipcRenderer.invoke('conversation:get', conversationId),
  getConversationMessages: (conversationId: string) => ipcRenderer.invoke('conversation:messages', conversationId),
  getConversationRunEvents: (conversationId: string) => ipcRenderer.invoke('conversation:run-events', conversationId),
  exportTaskDiagnostics: (taskId: string) => ipcRenderer.invoke('task:export-diagnostics', taskId),
  getTrace: (input: TraceQuery) => ipcRenderer.invoke('conversation:trace', input),
  cancelConversation: (conversationId: string) => ipcRenderer.invoke('conversation:cancel', conversationId),
  deleteConversation: (conversationId: string) => ipcRenderer.invoke('conversation:delete', conversationId),
  exportConversation: (input: ExportConversationInput) => ipcRenderer.invoke('document:export', input),
  getCapabilities: () => ipcRenderer.invoke('capabilities:list'),
  setCapabilityEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('capabilities:set', { id, enabled }),
  getExpertise: () => ipcRenderer.invoke('expertise:list'),
  setExpertiseEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('expertise:set', { id, enabled }),
  chooseAttachments: () => ipcRenderer.invoke('attachment:choose'),
  getChannelStatuses: () => ipcRenderer.invoke('channel:statuses'),
  getExecutionOptions: () => ipcRenderer.invoke('app:execution-options'),
  getExecutionDefaults: () => ipcRenderer.invoke('app:execution-defaults'),
  setExecutionDefaults: (config: unknown) => ipcRenderer.invoke('app:set-execution-defaults', config),
  setApiKey: (input: { id: string; key: string }) => ipcRenderer.invoke('app:set-api-key', input),
  removeApiKey: (id: string) => ipcRenderer.invoke('app:remove-api-key', id),
  setCloudConfig: (input: { id: string; baseUrl?: string; models?: string[] }) => ipcRenderer.invoke('app:set-cloud-config', input),
  setCloudModels: (input: { id: string; models: string[] }) => ipcRenderer.invoke('app:set-cloud-models', input),
  addCloudProvider: (input: { catalogId: string; label?: string; baseUrl?: string; models?: string[]; key?: string }) =>
    ipcRenderer.invoke('app:cloud-add', input),
  removeCloudProvider: (id: string) => ipcRenderer.invoke('app:cloud-remove', id),
  discoverCloudModels: (input: { baseUrl: string; key?: string; id?: string }) =>
    ipcRenderer.invoke('app:cloud-discover', input),
  getProviderHealth: () => ipcRenderer.invoke('app:provider-health'),
  getCollaborationRecords: () => ipcRenderer.invoke('app:collaboration'),
  getUsage: () => ipcRenderer.invoke('app:usage'),
  startDebate: (input: { question: string; config: unknown; conversationId?: string }) => ipcRenderer.invoke('debate:start', input),
  getDebate: (debateId: string) => ipcRenderer.invoke('debate:get', debateId),
  listDebates: () => ipcRenderer.invoke('debate:list'),
  relatedDebates: (input: { question: string; exclude?: string }) => ipcRenderer.invoke('debate:related', input),
  stopDebate: (debateId: string) => ipcRenderer.invoke('debate:stop', debateId),
  resumeDebate: (debateId: string) => ipcRenderer.invoke('debate:resume', debateId),
  cleanupDebateWeb: (debateId: string) => ipcRenderer.invoke('debate:cleanup-web', debateId),
  removeDebate: (debateId: string) => ipcRenderer.invoke('debate:remove', debateId),
  adjudicate: (debateId: string) => ipcRenderer.invoke('judge:adjudicate', debateId),
  getVerdict: (debateId: string) => ipcRenderer.invoke('judge:get', debateId),
  submitPrompt: (input: SubmitPromptInput) => ipcRenderer.invoke('task:submit', input),
  getTask: (taskId: string) => ipcRenderer.invoke('task:get', taskId),
  getTaskHistory: () => ipcRenderer.invoke('task:history'),
  getTaskEvents: (taskId: string) => ipcRenderer.invoke('task:events', taskId),
  getTaskExecutions: (taskId: string) => ipcRenderer.invoke('task:executions', taskId),
  getTaskContext: (taskId: string) => ipcRenderer.invoke('task:context', taskId),
  approvePlan: (input: ApprovePlanInput) => ipcRenderer.invoke('task:approve', input),
  rejectPlan: (input: { taskId: string; planId: string; reason?: string }) => ipcRenderer.invoke('task:reject', input),
  approveStep: (input: { taskId: string; stepId: string; remember?: boolean }) =>
    ipcRenderer.invoke('task:approve-step', input),
  rejectStep: (input: { taskId: string; stepId: string; reason?: string }) =>
    ipcRenderer.invoke('task:reject-step', input),
  answerStepQuestion: (input: { taskId: string; stepId: string; answer?: string; cancelled?: boolean }) =>
    ipcRenderer.invoke('task:answer-question', input),
  cancelTask: (taskId: string) => ipcRenderer.invoke('task:cancel', taskId),
  pauseTask: (taskId: string) => ipcRenderer.invoke('task:pause', taskId),
  resumeTask: (taskId: string) => ipcRenderer.invoke('task:resume', taskId),
  reviseTaskGoal: (input: {
    taskId: string;
    nextCriteria: string[];
    userConfirmedChange?: boolean;
    changedTaskIds?: string[];
  }) => ipcRenderer.invoke('task:revise-goal', input),
  listWorkflows: () => ipcRenderer.invoke('workflow:list'),
  runWorkflow: (input: {
    workflowId?: string;
    goal?: string;
    workflow?: import('../shared/workflow').WorkflowDefinition;
    permissionPreset?: import('../shared/contracts').PermissionPreset;
    workspaceRoot?: string;
    argsByNode?: Record<string, Record<string, unknown>>;
    inputs?: Record<string, unknown>;
    completionCondition?: string;
  }) => ipcRenderer.invoke('workflow:run', input),
  recheckVerification: (taskId: string): Promise<{ verified: boolean; reasons: string[] }> =>
    ipcRenderer.invoke('task:recheck-verification', taskId),
  acceptUnverified: (taskId: string) => ipcRenderer.invoke('task:accept-unverified', taskId),
  resumeRepair: (taskId: string) => ipcRenderer.invoke('task:resume-repair', taskId),
  setReviewDisposition: (input: {
    taskId: string;
    issueId: string;
    disposition: 'accepted' | 'rejected' | 'deferred' | 'pending';
    reason: string;
    roundId?: string;
  }) => ipcRenderer.invoke('task:set-review-disposition', input),
  answerClarification: (input: { taskId: string; answer: string }) => ipcRenderer.invoke('task:answer', input),
  deleteTask: (taskId: string) => ipcRenderer.invoke('task:delete', taskId),

  getCliAgents: (): Promise<CliAgentView[]> => ipcRenderer.invoke('cli:list'),
  setCliAgentEnabled: (input: { id: string; enabled: boolean }): Promise<CliAgentView[]> =>
    ipcRenderer.invoke('cli:set-enabled', input),
  getCliCapabilities: (): Promise<CliCapabilityRecordView[]> => ipcRenderer.invoke('cli:capabilities'),
  verifyCliAgent: (id: string): Promise<CliVerifyResult> => ipcRenderer.invoke('cli:verify', id),
  pickCliExecutable: (): Promise<{ canceled: boolean; path?: string }> => ipcRenderer.invoke('cli:pick-executable'),
  setCliSoftwareSource: (input: { id: string; command?: string; softwareSource: CliSoftwareSource }): Promise<CliAgentView[]> =>
    ipcRenderer.invoke('cli:set-software-source', input),

  attachTerminal: (sessionId: string): Promise<TerminalAttach> =>
    ipcRenderer.invoke('terminal:attach', sessionId),
  listTerminals: (): Promise<TerminalSessionSummary[]> => ipcRenderer.invoke('terminal:list'),
  listTerminalWindows: (): Promise<string[]> => ipcRenderer.invoke('terminal:windows'),
  closeTerminalWindow: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('terminal:window-close', sessionId),
  onTerminalWindow: (listener: (event: TerminalWindowState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalWindowState) => listener(payload);
    ipcRenderer.on('terminal:window', handler);
    return () => ipcRenderer.removeListener('terminal:window', handler);
  },
  onTerminalEnded: (listener: (sessionId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string) => listener(sessionId);
    ipcRenderer.on('terminal:ended', handler);
    return () => ipcRenderer.removeListener('terminal:ended', handler);
  },
  setTerminalPane: (open: boolean): Promise<void> => ipcRenderer.invoke('terminal:set-pane', open),
  onTerminalSelect: (listener: (sessionId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string) => listener(sessionId);
    ipcRenderer.on('terminal:select', handler);
    return () => ipcRenderer.removeListener('terminal:select', handler);
  },
  detachTerminal: (sessionId: string): Promise<void> => ipcRenderer.invoke('terminal:detach', sessionId),
  openCliTerminal: (cliId: string): Promise<string> => ipcRenderer.invoke('terminal:open-cli', cliId),
  listCliTerminals: (): Promise<CliTerminalState[]> => ipcRenderer.invoke('terminal:cli-state'),
  writeTerminal: (sessionId: string, data: string): Promise<void> =>
    ipcRenderer.invoke('terminal:write', { sessionId, data }),
  resizeTerminal: (sessionId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('terminal:resize', { sessionId, cols, rows }),
  closeTerminal: (sessionId: string): Promise<void> => ipcRenderer.invoke('terminal:close', sessionId),
  onTerminalData: (listener: (event: TerminalDataEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent) => listener(payload);
    ipcRenderer.on('terminal:data', handler);
    return () => ipcRenderer.removeListener('terminal:data', handler);
  },

  getTaskWorktree: (taskId: string): Promise<TaskWorktreeView | null> =>
    ipcRenderer.invoke('worktree:get', taskId),
  openTaskWorktree: (taskId: string): Promise<{ opened: boolean; error?: string }> =>
    ipcRenderer.invoke('worktree:open', taskId),
  copyTaskWorktreePath: (taskId: string): Promise<void> => ipcRenderer.invoke('worktree:copy-path', taskId),
  getTaskWorktreeDiff: (taskId: string): Promise<TaskWorktreeDiff> =>
    ipcRenderer.invoke('worktree:diff', taskId),
  commitTaskWorktree: (input: TaskWorktreeCommitInput): Promise<TaskWorktreeView> =>
    ipcRenderer.invoke('worktree:commit', input),
  mergeTaskWorktree: (taskId: string): Promise<TaskWorktreeMergeResult> =>
    ipcRenderer.invoke('worktree:merge', taskId),
  removeTaskWorktree: (input: TaskWorktreeRemoveInput): Promise<void> =>
    ipcRenderer.invoke('worktree:remove', input),

  getCollaborationPlanView: (conversationId: string) =>
    ipcRenderer.invoke('collaboration:view:get', conversationId),
  getCollaborationDetails: (conversationId: string) =>
    ipcRenderer.invoke('collaboration:details:get', conversationId),
  getCollaborationSettings: () => ipcRenderer.invoke('collaboration:settings:get'),
  setCollaborationMode: (mode: 'legacy' | 'shadow' | 'active') =>
    ipcRenderer.invoke('collaboration:settings:set', mode),
  getPermissionPreset: () => ipcRenderer.invoke('permission:get'),
  setPermissionPreset: (preset: PermissionPreset) => ipcRenderer.invoke('permission:set', preset),
  chooseDirectory: () => ipcRenderer.invoke('agent:choose-directory'),
  getPlatform: () => ipcRenderer.invoke('app:platform'),
  getDeepSeekStatus: (): Promise<DeepSeekStatus> => ipcRenderer.invoke('deepseek:status'),
  getDeepSeekDiagnostics: (sourceId?: string) => ipcRenderer.invoke('deepseek:diagnose', sourceId),
  getAccessibilitySnapshot: () => ipcRenderer.invoke('ax:snapshot'),
  getLayout: () => ipcRenderer.invoke('app:layout'),
  setSplit: (value: number) => ipcRenderer.invoke('app:set-split', value),
  setPageDragging: (active: boolean) => ipcRenderer.invoke('app:drag-page', active),
  getSources: () => ipcRenderer.invoke('app:sources'),
  setSource: (id: string) => ipcRenderer.invoke('app:set-source', id),
  getViewBounds: () => ipcRenderer.invoke('app:view-bounds'),
  saveSource: (id: string, patch: { url?: string; enabled?: boolean }) => ipcRenderer.invoke('sources:save', { id, ...patch }),
  addSource: (input: { label: string; url: string }) => ipcRenderer.invoke('sources:add', input),
  removeSource: (id: string) => ipcRenderer.invoke('sources:remove', id),
  setSourcesOpenOnLaunch: (open: boolean) => ipcRenderer.invoke('sources:set-open-on-launch', open),
  reloadPage: (id?: string) => ipcRenderer.invoke('page:reload', id),
  getIdentity: () => ipcRenderer.invoke('app:identity'),
  setDisplayName: (name: string) => ipcRenderer.invoke('app:set-name', name),

  getPageState: () => ipcRenderer.invoke('page:state'),
  detachPage: (sourceId?: string) => ipcRenderer.invoke('page:detach', sourceId),
  reattachPage: () => ipcRenderer.invoke('page:reattach'),
  focusDetachedPage: (sourceId: string) => ipcRenderer.invoke('page:focus-detached', sourceId),
  setPageCollapsed: (collapsed: boolean) => ipcRenderer.invoke('page:set-collapsed', collapsed),
  learnSelectors: (sourceId?: string) => ipcRenderer.invoke('page:learn-selectors', sourceId),
  savePageDocument: (input: SavePageDocumentInput) => ipcRenderer.invoke('page:save-document', input),
  extractPage: (input?: { sourceId?: string }) => ipcRenderer.invoke('page:extract', input),
  revertTaskSnapshot: (taskId: string) => ipcRenderer.invoke('snapshot:revert', taskId),
  embeddingStatus: () => ipcRenderer.invoke('embedding:status'),
  embedTexts: (input: unknown) => ipcRenderer.invoke('embedding:embed', input),
  getCodeIndexStatus: (root: string) => ipcRenderer.invoke('code-index:status', root),
  buildCodeIndex: (root: string) => ipcRenderer.invoke('code-index:build', root),
  buildCodeVectors: (root: string) => ipcRenderer.invoke('code-index:vectors', root),
  searchCodeIndex: (input: unknown) => ipcRenderer.invoke('code-index:search', input),
  rememberCodeMemory: (input: unknown) => ipcRenderer.invoke('code-index:remember', input),
  listCodeMemories: (root: string) => ipcRenderer.invoke('code-index:memories', root),
  linkCodeMemory: (input: unknown) => ipcRenderer.invoke('code-index:link', input),
  getCodeIntelligenceConfig: () => ipcRenderer.invoke('code-intelligence:get'),
  setCodeIntelligenceConfig: (patch: unknown) => ipcRenderer.invoke('code-intelligence:set', patch),
  testCodeIntelligence: () => ipcRenderer.invoke('code-intelligence:test'),
  managedCodeIntelligence: (action: string) => ipcRenderer.invoke('code-intelligence:managed', { action }),
  deleteCodeIndex: (root: string, external?: boolean) => ipcRenderer.invoke('code-index:delete-project', { root, external }),
  watchCodeIndex: (root: string) => ipcRenderer.invoke('code-index:watch', root),
  unwatchCodeIndex: (root: string) => ipcRenderer.invoke('code-index:unwatch', root),

  onAgentEvent: (callback: (event: AgentEvent) => void) => {    const listener = (_event: Electron.IpcRendererEvent, data: AgentEvent) => callback(data);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
  onDeepSeekEvent: (callback: (event: DeepSeekEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: DeepSeekEvent) => callback(data);
    ipcRenderer.on('deepseek:event', listener);
    return () => ipcRenderer.removeListener('deepseek:event', listener);
  },
  onLayoutChanged: (callback: (info: LayoutInfo) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: LayoutInfo) => callback(data);
    ipcRenderer.on('layout:changed', listener);
    return () => ipcRenderer.removeListener('layout:changed', listener);
  },
  onSourcesChanged: (callback: (state: SourcesState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: SourcesState) => callback(data);
    ipcRenderer.on('sources:changed', listener);
    return () => ipcRenderer.removeListener('sources:changed', listener);
  },
  onPageChanged: (callback: (state: PageState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: PageState) => callback(data);
    ipcRenderer.on('page:changed', listener);
    return () => ipcRenderer.removeListener('page:changed', listener);
  },
  onPageSaveRequest: (callback: (request: { sourceId: string; format: 'md' | 'docx'; returnToDetached: boolean }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: { sourceId: string; format: 'md' | 'docx'; returnToDetached: boolean }) => callback(request);
    ipcRenderer.on('page:save-request', listener);
    return () => ipcRenderer.removeListener('page:save-request', listener);
  },
  onConversationEvent: (callback: (event: ConversationEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: ConversationEvent) => callback(data);
    ipcRenderer.on('conversation:event', listener);
    return () => ipcRenderer.removeListener('conversation:event', listener);
  }
};

contextBridge.exposeInMainWorld('agentAPI', api);
