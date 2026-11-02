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
  SubmitPromptInput
} from '../shared/contracts';
import type { Conversation, ConversationEvent, ConversationMessage, SubmitConversationInput } from '../shared/conversation';

/**
 * The renderer gets exactly these calls and nothing else. No generic
 * `invoke(channel, ...)` escape hatch, no ipcRenderer passthrough.
 */
const api: AgentApi = {
  submitConversation: (input: SubmitConversationInput) => ipcRenderer.invoke('conversation:submit', input),
  classifyIntent: (text: string) => ipcRenderer.invoke('conversation:classify', text),
  followupConversation: (input: { conversationId: string; text: string }) => ipcRenderer.invoke('conversation:followup', input),
  getConversations: () => ipcRenderer.invoke('conversation:list'),
  getConversation: (conversationId: string) => ipcRenderer.invoke('conversation:get', conversationId),
  getConversationMessages: (conversationId: string) => ipcRenderer.invoke('conversation:messages', conversationId),
  cancelConversation: (conversationId: string) => ipcRenderer.invoke('conversation:cancel', conversationId),
  deleteConversation: (conversationId: string) => ipcRenderer.invoke('conversation:delete', conversationId),
  getChannelStatuses: () => ipcRenderer.invoke('channel:statuses'),
  submitPrompt: (input: SubmitPromptInput) => ipcRenderer.invoke('task:submit', input),
  getTask: (taskId: string) => ipcRenderer.invoke('task:get', taskId),
  getTaskHistory: () => ipcRenderer.invoke('task:history'),
  getTaskEvents: (taskId: string) => ipcRenderer.invoke('task:events', taskId),
  approvePlan: (input: ApprovePlanInput) => ipcRenderer.invoke('task:approve', input),
  rejectPlan: (input: { taskId: string; planId: string; reason?: string }) => ipcRenderer.invoke('task:reject', input),
  cancelTask: (taskId: string) => ipcRenderer.invoke('task:cancel', taskId),
  answerClarification: (input: { taskId: string; answer: string }) => ipcRenderer.invoke('task:answer', input),
  deleteTask: (taskId: string) => ipcRenderer.invoke('task:delete', taskId),

  getPermissionPreset: () => ipcRenderer.invoke('permission:get'),
  setPermissionPreset: (preset: PermissionPreset) => ipcRenderer.invoke('permission:set', preset),
  chooseDirectory: () => ipcRenderer.invoke('agent:choose-directory'),
  getPlatform: () => ipcRenderer.invoke('app:platform'),
  getDeepSeekStatus: (): Promise<DeepSeekStatus> => ipcRenderer.invoke('deepseek:status'),
  getDeepSeekDiagnostics: () => ipcRenderer.invoke('deepseek:diagnose'),
  reloadDeepSeek: () => ipcRenderer.invoke('deepseek:reload'),
  getAccessibilitySnapshot: () => ipcRenderer.invoke('ax:snapshot'),
  getLayout: () => ipcRenderer.invoke('app:layout'),
  setSplit: (value: number) => ipcRenderer.invoke('app:set-split', value),
  setPageDragging: (active: boolean) => ipcRenderer.invoke('app:drag-page', active),
  getSources: () => ipcRenderer.invoke('app:sources'),
  setSource: (id: string) => ipcRenderer.invoke('app:set-source', id),
  getViewBounds: () => ipcRenderer.invoke('app:view-bounds'),

  getPageState: () => ipcRenderer.invoke('page:state'),
  detachPage: (sourceId?: string) => ipcRenderer.invoke('page:detach', sourceId),
  reattachPage: () => ipcRenderer.invoke('page:reattach'),
  setPageCollapsed: (collapsed: boolean) => ipcRenderer.invoke('page:set-collapsed', collapsed),
  learnSelectors: (sourceId?: string) => ipcRenderer.invoke('page:learn-selectors', sourceId),

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
