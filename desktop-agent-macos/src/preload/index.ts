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
import type { ExportConversationInput, SavePageDocumentInput } from '../shared/export';

/**
 * The renderer gets exactly these calls and nothing else. No generic
 * `invoke(channel, ...)` escape hatch, no ipcRenderer passthrough.
 */
const api: AgentApi = {
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
  approvePlan: (input: ApprovePlanInput) => ipcRenderer.invoke('task:approve', input),
  rejectPlan: (input: { taskId: string; planId: string; reason?: string }) => ipcRenderer.invoke('task:reject', input),
  approveStep: (input: { taskId: string; stepId: string; remember?: boolean }) =>
    ipcRenderer.invoke('task:approve-step', input),
  rejectStep: (input: { taskId: string; stepId: string; reason?: string }) =>
    ipcRenderer.invoke('task:reject-step', input),
  answerStepQuestion: (input: { taskId: string; stepId: string; answer?: string; cancelled?: boolean }) =>
    ipcRenderer.invoke('task:answer-question', input),
  cancelTask: (taskId: string) => ipcRenderer.invoke('task:cancel', taskId),
  answerClarification: (input: { taskId: string; answer: string }) => ipcRenderer.invoke('task:answer', input),
  deleteTask: (taskId: string) => ipcRenderer.invoke('task:delete', taskId),

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
  setPageCollapsed: (collapsed: boolean) => ipcRenderer.invoke('page:set-collapsed', collapsed),
  learnSelectors: (sourceId?: string) => ipcRenderer.invoke('page:learn-selectors', sourceId),
  savePageDocument: (input: SavePageDocumentInput) => ipcRenderer.invoke('page:save-document', input),
  extractPage: (input?: { sourceId?: string }) => ipcRenderer.invoke('page:extract', input),
  revertTaskSnapshot: (taskId: string) => ipcRenderer.invoke('snapshot:revert', taskId),
  embeddingStatus: () => ipcRenderer.invoke('embedding:status'),
  embedTexts: (input: unknown) => ipcRenderer.invoke('embedding:embed', input),
  getCodeIndexStatus: (root: string) => ipcRenderer.invoke('code-index:status', root),
  buildCodeIndex: (root: string) => ipcRenderer.invoke('code-index:build', root),
  searchCodeIndex: (input: unknown) => ipcRenderer.invoke('code-index:search', input),

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
  onConversationEvent: (callback: (event: ConversationEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: ConversationEvent) => callback(data);
    ipcRenderer.on('conversation:event', listener);
    return () => ipcRenderer.removeListener('conversation:event', listener);
  }
};

contextBridge.exposeInMainWorld('agentAPI', api);
