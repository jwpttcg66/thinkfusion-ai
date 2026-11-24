import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentEvent,
  AgentTask,
  DeepSeekDiagnostics,
  DeepSeekStatus,
  ExecutionOptions,
  Identity,
  PageState,
  PermissionPreset,
  PlanPreview as PlanPreviewType,
  SourcesState
} from '../../shared/contracts';
import { EMPTY_TASK_VIEW, applyTaskViewEvent, projectTaskView, type TaskView } from '../../shared/task-view';
import { mergeTaskEvent } from '../../shared/task-events';
import { fromAgentEvent, maskSecrets, projectActivity, type ObservabilityEvent } from '../../shared/observability';
import { auditActivity } from '../../shared/diagnostics';
import { TaskSidebar } from './components/TaskSidebar';
import { TaskInput } from './components/TaskInput';
import { SourceRail } from './components/SourceRail';
import { ConversationView } from './components/ConversationView';
import { CollaborationPlanPanel } from './components/CollaborationPlanPanel';
import { ParticipantPanel } from './components/ParticipantPanel';
import { EvidencePanel } from './components/EvidencePanel';
import { WorkspacePanel } from './components/WorkspacePanel';
import { CollaborationDiagnostics } from './components/CollaborationDiagnostics';
import { ProgressPanel } from './components/ProgressPanel';
import { EventInspector } from './components/EventInspector';
import { TrajectoryPanel } from './components/TrajectoryPanel';
import { StatsPanel } from './components/StatsPanel';
import { PlanPreview } from './components/PlanPreview';
import { ExecutionLog, toolLabel } from './components/ExecutionLog';
import { terminalSessionsFrom } from './components/terminal-sessions';
import { TaskWorktree } from './components/TaskWorktree';
import { CodeIndexPanel } from './components/CodeIndexPanel';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { SettingsPanel, type Section as SettingsSection } from './components/SettingsPanel';
import { ResearchPanel } from './components/ResearchPanel';
import { EngineeringWorkbenchBar, type WorkbenchTab } from './components/engineering/EngineeringWorkbenchBar';
import { TaskProgressCard } from './components/engineering/TaskProgressCard';
import { ProtocolArchive, TaskConversation } from './components/engineering/TaskConversation';
import { MemoryTraceCard } from './components/MemoryTraceCard';
import { TaskTrajectory } from './components/engineering/TaskTrajectory';
import { TaskStats } from './components/engineering/TaskStats';
import { PageSaveDialog } from './components/PageSaveDialog';
import { Glyph } from './components/Glyph';
import type { StyleReportData } from './components/StyleReport';
import { computeSplit, PAGE_GUTTER, PAGE_HEADER_HEIGHT, RAIL_WIDTH } from '../../shared/layout';
import { showWebSourceStatusBar } from '../../shared/sources';
import type { TerminalSessionSummary, CliAgentView, CliTerminalState } from '../../shared/cli-agents';
import {
  ICON_DOCK_BACK_PATHS,
  ICON_EXPAND_PATHS,
  ICON_TERMINAL_PATHS,
  ICON_GAUGE_PATHS,
  ICON_REFRESH_PATHS,
  ICON_SAVE_PATHS,
  ICON_SAVE_WORD_PATHS
} from '../../shared/icons';
import type { ChannelStatus, Conversation, ConversationExecutionConfig, ConversationMessage, ExecutionMode } from '../../shared/conversation';
import { DEFAULT_EXECUTION_CONFIG, mergeConversationMessage, normalizeExecutionConfig } from '../../shared/conversation';
import { pruneCloudParticipantsAgainstPool } from '../../shared/cloud-selection';
import { dedupeAttachments, type ConversationAttachment } from '../../shared/attachments';
import { describeEffective } from '../../shared/redact';
import type { ExpertiseId, ExpertiseView } from '../../shared/expertise';
import { classifyIntent } from '../../shared/intent';
import {
  routingLabel,
  routeTask,
  workspaceLabel,
  type EngineeringTaskKind,
  type WorkspaceEntry,
  type WorkspaceMode
} from '../../shared/workspace';

const ACTIVE_STATUSES: AgentTask['status'][] = ['planning', 'executing', 'verifying', 'report_pending'];
type Derived = TaskView;
const EMPTY_DERIVED = EMPTY_TASK_VIEW;

/** 逐次审批里正在等答复的那一步（事件本身带齐了要显示的全部信息）。 */
type PendingStep = Extract<AgentEvent, { type: 'step.approval' }>;

/** 执行中提问：和逐次审批一样是阻塞态，界面上不能被日志淹掉。 */
type PendingQuestion = Extract<AgentEvent, { type: 'step.question' }>;

/** 放大：把这个页面交给一整扇窗。 */
const IconExpand = () => <Glyph paths={ICON_EXPAND_PATHS} />;
/** 吸附回来：放回它原来的位置。 */
const IconDockBack = () => <Glyph paths={ICON_DOCK_BACK_PATHS} />;
/** 终端：任务里真实开过的 PTY 会话。 */
const IconTerminal = () => <Glyph paths={ICON_TERMINAL_PATHS} />;
/** 刷新：把这一页重新加载一次，会话还留在原地。 */
const IconRefresh = () => <Glyph paths={ICON_REFRESH_PATHS} />;
/** 诊断：这一页到底找到了什么。 */
const IconGauge = () => <Glyph paths={ICON_GAUGE_PATHS} />;
/** 保存文档：把这一页里的文档与计划落到本机文件。 */
const IconSave = () => <Glyph paths={ICON_SAVE_PATHS} />;
/** 保存为 Word：同一张纸，里面是横线而不是箭头。 */
const IconSaveWord = () => <Glyph paths={ICON_SAVE_WORD_PATHS} />;

function upsert(list: AgentTask[], task: AgentTask): AgentTask[] {
  const next = list.filter(item => item.taskId !== task.taskId);
  return [task, ...next].sort((a, b) => b.updatedAt - a.updatedAt);
}

function baseName(path?: string): string {
  if (!path) return '未指定工作区';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 终端组件按需加载：xterm 及其 CSS 只在真的有 PTY 会话时下载/解析。
 * 首屏因此回到「不碰终端实现」的体积。
 */
const AgentTerminal = React.lazy(() =>
  import('./components/AgentTerminal').then(module => ({ default: module.AgentTerminal }))
);

/** 右侧面板与独立窗口共用；xterm 只在打开终端时加载。 */
const TerminalPanel = React.lazy(() =>
  import('./components/TerminalPanel').then(module => ({ default: module.TerminalPanel }))
);

function terminalLabelOf(session: TerminalSessionSummary): string {
  const base = session.cwd.split('/').filter(Boolean).slice(-1)[0];
  return base || session.sessionId.slice(-6);
}

/** 从规划回答里取出模型的思考说明；原始 JSON 不再直接铺在任务页。 */
function planThinking(text: string): string {
  if (!text) return '';
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = block ? block[1] : text;
  try {
    const value = JSON.parse(raw) as { description?: unknown; title?: unknown };
    if (typeof value.description === 'string' && value.description.trim()) return value.description.trim();
    if (typeof value.title === 'string' && value.title.trim()) return value.title.trim();
  } catch { /* 不是 JSON 就按普通回答处理 */ }
  return '';
}

export default function App() {
  const [platform, setPlatform] = useState('');
  const [permission, setPermission] = useState<PermissionPreset>('workspace-write');
  const [workspace, setWorkspace] = useState('');
  /** V2.1：本次新会话属于哪个空间。启动时从 workspace-state.json 读回。 */
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('knowledge');
  /** 用户维护的工作区清单；侧栏按它分组，新会话归到当前工作区。 */
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('');
  /** 用户在输入框里手动指定的「本次按分析 / 本次按实施」。 */
  const [taskKindOverride, setTaskKindOverride] = useState<EngineeringTaskKind | null>(null);
  const [prompt, setPrompt] = useState('');
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [activityQuery, setActivityQuery] = useState('');
  const [activityCategory, setActivityCategory] = useState('all');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  /**
   * 正在等用户点头的那一步。
   *
   * 单独存一份而不是从事件列表里筛，因为它是**阻塞态**：Runtime 就停在这里，
   * 用户不答复整条执行链不会前进。这种状态要能一眼看见，不能被日志淹掉。
   */
  const [pendingStep, setPendingStep] = useState<PendingStep | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [questionText, setQuestionText] = useState('');
  const [derived, setDerived] = useState<Derived>(EMPTY_DERIVED);
  const [status, setStatus] = useState<DeepSeekStatus | null>(null);
  const [clarifyText, setClarifyText] = useState('');
  const [error, setError] = useState('');
  /** Neither an error nor progress: "you clicked, nothing was submitted, here's why". */
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [split, setSplit] = useState(0);
  const [draggingPage, setDraggingPage] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagReport, setDiagReport] = useState<DeepSeekDiagnostics | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  /**
   * The channel the diagnostics panel is about.
   *
   * Not the same thing as the channel in the pane: the panel can be pointed at
   * any page while you keep looking at one. Opened from the bar it starts on
   * that bar's channel, which is the only one the button can mean.
   */
  const [diagChannelId, setDiagChannelId] = useState('');
  const [sources, setSources] = useState<SourcesState>({
    sources: [],
    activeId: '',
    planningId: null,
    loading: false,
    openOnLaunch: true,
    webViewsOpen: false
  });
  const [page, setPage] = useState<PageState>({ detachedId: null, collapsed: false });
  /** 终端：一个会话一个独立窗口；侧栏按钮是开关，可同时开多个。 */
  /** 终端：默认显示在右侧面板；「放大」才开独立窗口。 */
  const [terminalPaneSession, setTerminalPaneSession] = useState<string | null>(null);
  const [terminalPaneOpen, setTerminalPaneOpen] = useState(false);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionSummary[]>([]);
  const [openTerminalWindows, setOpenTerminalWindows] = useState<string[]>([]);
  /** 放大窗口「吸附回来」：主进程告诉我们把哪个会话放回面板。 */
  useEffect(() => {
    return window.agentAPI.onTerminalSelect(sessionId => {
      setTerminalPaneSession(sessionId);
      setTerminalPaneOpen(true);
      void window.agentAPI.setTerminalPane(true).catch(() => undefined);
    });
  }, []);

  const terminalPanelSessions = useMemo<TerminalSessionSummary[]>(() => {
    if (!terminalPaneSession) return [];
    const found = terminalSessions.find(item => item.sessionId === terminalPaneSession);
    return found
      ? [found]
      : [
          {
            sessionId: terminalPaneSession,
            pid: 0,
            shell: '',
            cwd: '',
            cols: 0,
            rows: 0,
            exited: true,
            pending: 0
          }
        ];
  }, [terminalPaneSession, terminalSessions]);
  /** 已启用的 CLI 与它们当前的交互终端会话。 */
  const [cliAgents, setCliAgents] = useState<CliAgentView[]>([]);
  /** 全部 CLI（含关着的）：输入框「模型」弹层里 CLI 来源区块要照列并写明原因。 */
  const [cliAll, setCliAll] = useState<CliAgentView[]>([]);
  const [cliTerminals, setCliTerminals] = useState<CliTerminalState[]>([]);
  /** CLI 的交互终端已经有自己的 Q/C 按钮，不能再画成普通终端按钮。 */
  const cliTerminalSessionIds = useMemo(
    () => new Set(cliTerminals.map(item => item.sessionId)),
    [cliTerminals]
  );

  /** 主进程通知会话已结束：面板立刻退出，不等轮询。 */
  useEffect(() => {
    return window.agentAPI.onTerminalEnded(sessionId => {
      setTerminalSessions(previous => previous.filter(item => item.sessionId !== sessionId));
      setCliTerminals(previous => previous.filter(item => item.sessionId !== sessionId));
      if (terminalPaneSession === sessionId) {
        setTerminalPaneOpen(false);
        setTerminalPaneSession(null);
        void window.agentAPI.setTerminalPane(false).catch(() => undefined);
      }
    });
  }, [terminalPaneSession]);

  /** 面板里的会话结束（或设置里关掉 CLI）后，面板不能停在空白上。 */
  useEffect(() => {
    if (!terminalPaneOpen || !terminalPaneSession) return;
    // 刚起的新会话还没进 terminals 列表，但 cliTerminals 已经有乐观状态；
    // 只拿 terminals 判断会把刚打开的面板立刻关掉。
    const alive =
      terminalSessions.some(item => item.sessionId === terminalPaneSession) ||
      cliTerminals.some(item => item.sessionId === terminalPaneSession && item.running) ||
      openTerminalWindows.includes(terminalPaneSession);
    if (!alive) {
      setTerminalPaneOpen(false);
      setTerminalPaneSession(null);
      void window.agentAPI.setTerminalPane(false).catch(() => undefined);
    }
  }, [terminalPaneOpen, terminalPaneSession, terminalSessions, cliTerminals, openTerminalWindows]);


  // 会话列表：2 秒一次；终端默认只在侧栏出现，点按钮才进右侧面板。
  useEffect(() => {
    let alive = true;
    const load = () => {
      void window.agentAPI
        .listTerminals()
        .then(list => {
          if (!alive) return;
          setTerminalSessions(list);
          // CLI 的交互终端由主进程记账；设置开关只决定它存不存在。
          void window.agentAPI
            .listCliTerminals()
            .then(state => {
              if (alive) setCliTerminals(state);
            })
            .catch(() => undefined);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // 窗口的开/关状态由主进程推：用户直接点窗口的关闭按钮也能同步到侧栏。
  useEffect(() => {
    void window.agentAPI
      .listTerminalWindows()
      // 与自动开窗的推送合并，不能用初始列表覆盖：两个请求几乎同时回来，
      // 后到的空列表会把刚刚自动打开的那一个抹掉。
      .then(ids => setOpenTerminalWindows(previous => [...new Set([...previous, ...ids])]))
      .catch(() => undefined);
    return window.agentAPI.onTerminalWindow(event => {
      setOpenTerminalWindows(previous =>
        event.open
          ? [...new Set([...previous, event.sessionId])]
          : previous.filter(id => id !== event.sessionId)
      );
    });
  }, []);

  /** True while 「更新样式」 is running its three passes over the page. */
  const [learning, setLearning] = useState(false);
  /** True from the press of 「刷新」 until the reload settles or its budget ends. */
  const [refreshing, setRefreshing] = useState(false);
  /** True while 「保存文档」 is reading the page and writing the file. */
  const [savingPage, setSavingPage] = useState<'md' | 'docx' | null>(null);
  /** 保存前先勾选：页面上读到哪些对话可保存。 */
  const [pageSave, setPageSave] = useState<{
    preview: import('../../shared/export').PageExtractPreview;
    format: 'md' | 'docx';
    sourceId: string;
    returnToDetached: boolean;
  } | null>(null);
  /**
   * The last repair result, shown inside the diagnostics panel.
   *
   * Not a dialog of its own any more: the only button that starts a repair is
   * the one next to the problem, so the answer belongs under that problem.
   */
  const [repairReport, setRepairReport] = useState<StyleReportData | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [channelStatuses, setChannelStatuses] = useState<ChannelStatus[]>([]);
  const [phases, setPhases] = useState<Record<string, { phase: string; detail?: string; at?: number }>>({});
  /** 流式增量：按 channelId 累积，落盘消息一到就清掉。 */
  const [answerDeltas, setAnswerDeltas] = useState<Record<string, { text: string; reasoning: string; done: boolean }>>({});
  /** 辩论进行中的轮次快照；落盘后由 synthesis 消息里的 debate 接替。 */
  const [debateLive, setDebateLive] = useState<import('../../shared/conversation').DebateSnapshot | null>(null);
  /** The local user name for the row at the bottom of the sidebar. */
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // CLI 开关在设置里改；关掉设置面板时重新取一次，右侧栏立即反映。
  //
  // 只按「开着」筛，不按「可用」筛：跟网页源一样，开着的来源就该出现在栏里，
  // 不可用时用灭掉的点表示——把整条藏起来，用户会以为自己的开关没生效。
  useEffect(() => {
    if (settingsOpen) return;
    let alive = true;
    void window.agentAPI
      .getCliAgents()
      .then(list => {
        if (!alive) return;
        setCliAll(list);
        setCliAgents(list.filter(item => item.enabled));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [settingsOpen]);

  /** 从「＋ · 连接器」打开插件页时，面板要直接落在那一页。 */
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('models');
  /**
   * 「＋ · 添加文件」挑中的文件。
   *
   * 只存引用（名字、路径、体积），正文在主进程按发送那一刻读——界面里
   * 不该出现一份可能是旧的副本。发送成功就清空：附件是这一问的，不是设置。
   */
  const [attachments, setAttachments] = useState<ConversationAttachment[]>([]);
  /** 「＋ · 专家 / 技能」要显示的开关状态；与「设置 · 专家与技能」同一份。 */
  const [expertise, setExpertise] = useState<ExpertiseView[]>([]);
  const [researchOpen, setResearchOpen] = useState(false);
  const [researchTab, setResearchTab] = useState<'mode' | 'collab' | 'debate' | 'report'>('mode');
  /** 对话 / 轨迹 / 统计。页签在 topbar 下、滚动区外，切会话时回到对话。 */
  const [conversationTab, setConversationTab] = useState<'chat' | 'trajectory' | 'stats'>('chat');
  /**
   * 工程工作台的当前页。切页只切渲染：事件订阅在 App 顶层，不随页签卸载，
   * 所以切到「统计」再切回来，流仍是连着的（V2.1 §16.7-19）。
   */
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>('conversation');
  const [executionConfig, setExecutionConfig] = useState<ConversationExecutionConfig>(DEFAULT_EXECUTION_CONFIG);
  /**
   * 跨会话默认值（主导人、参与的云端模型）。
   *
   * 「新对话」和启动时用这份，不沿用上一条会话临走时的勾选——那是那条线程的
   * 事。用户改研究设置时同步写进磁盘，重启还在。
   */
  const executionDefaultsRef = useRef<ConversationExecutionConfig>(DEFAULT_EXECUTION_CONFIG);
  /**
   * 面板上这份设置的即时副本。
   *
   * 改一下要立刻存到会话上，但存的动作是延迟的（连点四个档位不该写四次盘），
   * 而延迟回调里读 `executionConfig` 拿到的是它闭包创建时那一份。用 ref 读最新值，
   * 不靠 setState 的函数式更新去取巧。
   */
  const executionConfigRef = useRef<ConversationExecutionConfig>(DEFAULT_EXECUTION_CONFIG);
  executionConfigRef.current = executionConfig;
  const configSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 当前可见会话；事件回调里只靠它判断要不要改面板。 */
  const activeConversationRef = useRef<string | null>(null);
  activeConversationRef.current = activeConversationId;

  // 换一条会话时回到「对话」：接着看轨迹/统计是上一次的上下文，不是这条的。
  useEffect(() => {
    setConversationTab('chat');
  }, [activeConversationId]);
  /**
   * 输入框旁边那个「模型」胶囊要的云端成员清单。
   *
   * 清单来自主进程（预设 + 用户配置 + 网关 `/models`），界面自己不抄一份
   * 模型名。设置面板关掉时重新取一次：刚贴完 Key、刚补完模型清单的那一行，
   * 回到输入框就该能选。
   */
  const [executionOptions, setExecutionOptions] = useState<ExecutionOptions | null>(null);
  useEffect(() => {
    if (settingsOpen) return;
    let alive = true;
    void window.agentAPI
      .getExecutionOptions()
      .then(options => {
        if (!alive) return;
        setExecutionOptions(options);
        // 设置里「更新列表」会改可选池；关掉面板时把勾选里已经不存在的模型裁掉，
        // 否则保存后提问条 / 参与名单还会挂着旧 id。
        const available = new Set(options.cloudMembers.map(item => item.id));
        const providers = new Set(options.cloudProviders.map(item => item.id));
        const current = executionConfigRef.current;
        const pruned = pruneCloudParticipantsAgainstPool(
          current.selectedCloudModels,
          current.leadAgentId,
          available,
          providers
        );
        if (!pruned.changed) return;
        const next = normalizeExecutionConfig({
          ...current,
          ...(pruned.selectedCloudModels ? { selectedCloudModels: pruned.selectedCloudModels } : {}),
          ...(pruned.clearLead ? { leadAgentId: undefined } : {})
        });
        if (pruned.clearLead) delete next.leadAgentId;
        executionConfigRef.current = next;
        executionDefaultsRef.current = next;
        setExecutionConfig(next);
        void window.agentAPI.setExecutionDefaults(next).catch(() => undefined);
        const conversationId = activeConversationRef.current;
        if (conversationId) {
          void window.agentAPI
            .updateConversationConfig({ conversationId, executionConfig: next })
            .catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [settingsOpen]);
  /**
   * 启动时把盘上的默认研究设置读进来。
   *
   * 只在还没有打开某条会话时覆盖面板：已经点进旧会话的话，应以那条会话自己的
   * 存档为准，不能被异步返回的默认值冲掉。
   */
  useEffect(() => {
    let alive = true;
    void window.agentAPI
      .getExecutionDefaults()
      .then(defaults => {
        if (!alive) return;
        const stored = normalizeExecutionConfig(defaults);
        executionDefaultsRef.current = stored;
        if (!activeConversationRef.current) {
          executionConfigRef.current = stored;
          setExecutionConfig(stored);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => () => {
    if (configSaveTimer.current) clearTimeout(configSaveTimer.current);
  }, []);

  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;
  /**
   * Conversations that have been deleted.
   *
   * A delete races the conversation's own event stream: the runner keeps
   * emitting `conversation.updated` while it settles, and any of those arriving
   * after the delete put the row straight back into the list. Ids are UUIDs, so
   * remembering them is exact — no guessing at titles.
   */
  const deletedConversations = useRef<Set<string>>(new Set());
  /**
   * 已发送、但主进程还没建出真会话的那一条。
   *
   * 工程提交要探活、路由、转交 Planner，IPC 几十秒不返回是常事。这期间停在
   * 首页和死机没有区别：先在本地把「你问的这句」放出来，主进程建好会话
   * （或 IPC 返回）后再按标题对齐真实 id；失败则整条撤回、原话还给输入框。
   */
  const pendingSubmit = useRef<{ id: string; title: string; previousId: string | null } | null>(null);
  const dragRef = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * A counter, not a boolean: "focus the composer" has to fire on every click,
   * and an effect keyed on state only runs when that state changes. The focus
   * call also has to happen *after* the commit — at `requestAnimationFrame`
   * time the textarea can still be `disabled` from the task that was just
   * closed, and a disabled element silently refuses focus.
   */
  const [focusRequest, setFocusRequest] = useState(0);

  const activeTask = useMemo(() => tasks.find(task => task.taskId === activeId) ?? null, [tasks, activeId]);
  const activeConversation = useMemo(
    () => conversations.find(item => item.conversationId === activeConversationId) ?? null,
    [conversations, activeConversationId]
  );
  const activity = useMemo<ObservabilityEvent[]>(
    () => projectActivity(events.map(fromAgentEvent).filter((item): item is ObservabilityEvent => item !== null)),
    [events]
  );
  const selectedActivity = activity.find(item => item.eventId === selectedActivityId) ?? null;
  const stepActivity = useMemo(() => {
    const map = new Map<string, ObservabilityEvent>();
    for (const event of activity) if (event.stepId) map.set(event.stepId, event);
    return map;
  }, [activity]);
  const audit = useMemo(() => auditActivity(activity), [activity]);
  const filteredActivity = useMemo(() => {
    const query = activityQuery.trim().toLowerCase();
    return activity.filter(event => {
      if (activityCategory !== 'all' && event.category !== activityCategory) return false;
      if (!query) return true;
      return `${event.category} ${event.phase} ${event.actor.label} ${String(event.payload.type ?? '')} ${JSON.stringify(event.payload)}`
        .toLowerCase()
        .includes(query);
    });
  }, [activity, activityQuery, activityCategory]);
  /** 任务对应的原会话：任务视图不能把“对话/轨迹/思考过程”弄丢。 */
  const taskConversation = useMemo(
    () => (activeTask ? conversations.find(item => item.taskId === activeTask.taskId) ?? null : null),
    [conversations, activeTask]
  );
  /**
   * A conversation whose intent turned out to be `workspace` hands off to a
   * task. From then on the task view owns the screen — showing a conversation
   * pane with one system line next to a plan would be two half-answers.
   */
  const showingConversation = activeConversation !== null && !activeConversation.taskId;
  /**
   * 路由预览：纯函数算出来，不产生任何副作用（不发问、不建会话）。
   * 输入框里显示「这句话会怎么走」，用户就能在发送前改判。
   */
  const routingPreview = useMemo(() => {
    if (!prompt.trim()) return null;
    return routeTask({
      text: prompt,
      workspaceMode,
      hasProject: !!workspace,
      override: taskKindOverride,
      // 预览要和发送后同一套判据：带了文件时「没说做什么」不再是待确认。
      attachmentCount: attachments.length
    });
  }, [prompt, workspaceMode, workspace, taskKindOverride, attachments.length]);
  const conversationBusy =
    activeConversation !== null &&
    ['thinking', 'collecting', 'comparing', 'synthesizing'].includes(activeConversation.status);
  const busy = activeTask ? ACTIVE_STATUSES.includes(activeTask.status) : false;
  /**
   * The task is blocked on a person, not on the page.
   *
   * It has to be its own flag: while this was folded into `busy`, the window
   * said 正在规划 and disabled the composer while actually waiting for an answer
   * — which is indistinguishable from a hang.
   */
  const awaitingAnswer = activeTask?.status === 'awaiting_clarification';
  const roundCount = events.filter(event => event.type === 'round.started').length;

  useEffect(() => {
    if (focusRequest === 0) return;
    composerRef.current?.focus();
  }, [focusRequest]);

  useEffect(() => {
    window.agentAPI.getPlatform().then(setPlatform).catch(() => undefined);
    window.agentAPI.getPermissionPreset().then(setPermission).catch(() => undefined);
    Promise.all([window.agentAPI.getWorkspace(), window.agentAPI.getWorkspaces()])
      .then(([state, list]) => {
        setWorkspaceMode(state.workspaceMode);
        setWorkspaces(list);
        // 当前工作区的根目录才是「这次工程分析读哪里」。两个字段分开存，但
        // 界面上必须同源：读回一个指向别处的旧 workspaceRoot，会让第一问
        // 在读 A 目录、侧栏却显示 B 工作区。
        const active = list.find(item => item.workspaceId === state.activeWorkspaceId) ?? null;
        setActiveWorkspaceId(active?.workspaceId ?? '');
        setWorkspace(active?.root ?? state.workspaceRoot);
      })
      .catch(() => undefined);
    window.agentAPI.getTaskHistory().then(setTasks).catch(() => undefined);
    window.agentAPI.getDeepSeekStatus().then(setStatus).catch(() => undefined);

    // The embedded page is a native view laid over the window, not an iframe:
    // it cannot be positioned by CSS, so the renderer has to leave room for it.
    // Both sides derive the boundary from the same number instead of each
    // guessing, which is what let the page sit on top of the app's own column.
    window.agentAPI.getLayout().then(info => setSplit(info.split)).catch(() => undefined);
    const stopLayout = window.agentAPI.onLayoutChanged(info => setSplit(info.split));

    window.agentAPI.getSources().then(setSources).catch(() => undefined);
    const stopSources = window.agentAPI.onSourcesChanged(setSources);

    // The account row. Read once: it is this machine's user name and cannot
    // change while the app is running.
    window.agentAPI.getIdentity().then(setIdentity).catch(() => undefined);

    // Whether a page is in its own window. The pane is a native view, so an
    // empty pane and a detached page are the same pixels — this is the only
    // thing that tells them apart.
    window.agentAPI.getPageState().then(setPage).catch(() => undefined);
    const stopPage = window.agentAPI.onPageChanged(setPage);
    const stopPageSaveRequest = window.agentAPI.onPageSaveRequest(({ sourceId, format, returnToDetached }) => {
      void openPageSave(format, sourceId, returnToDetached);
    });

    const stopEvents = window.agentAPI.onAgentEvent(event => {
      if (event.type === 'task.updated') {
        setTasks(prev => upsert(prev, event.task));
        return;
      }
      if (event.type === 'task.deleted') {
        setTasks(prev => prev.filter(item => item.taskId !== event.taskId));
        if (activeRef.current === event.taskId) setActiveId(null);
        return;
      }
      if (!('taskId' in event) || event.taskId !== activeRef.current) return;

      setEvents(prev => mergeTaskEvent(prev, event));
      setDerived(prev => applyTaskViewEvent(prev, event));
      if (event.type === 'task.failed') setError(event.error);

      // 逐次审批：请求进来就占据「阻塞态」位置，回执到了再撤掉。
      if (event.type === 'step.approval') setPendingStep(event);
      if (event.type === 'step.approval-resolved') {
        setPendingStep(prev => (prev && prev.taskId === event.taskId && prev.stepId === event.stepId ? null : prev));
      }
      if (event.type === 'step.question') setPendingQuestion(event);
      if (event.type === 'step.question-resolved') {
        setPendingQuestion(prev => (prev && prev.taskId === event.taskId && prev.stepId === event.stepId ? null : prev));
      }
      if (event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.cancelled') {
        setPendingStep(null);
        setPendingQuestion(null);
      }
    });

    const stopDeepSeek = window.agentAPI.onDeepSeekEvent(event => {
      if (event.type === 'status') setStatus(event.status);
    });

    window.agentAPI.getConversations().then(setConversations).catch(() => undefined);
    window.agentAPI.getChannelStatuses().then(setChannelStatuses).catch(() => undefined);
    // 「＋ · 专家 / 技能」要显示真实开关，清单只能从主进程读（它是两份 .md）。
    window.agentAPI.getExpertise().then(setExpertise).catch(() => undefined);

    const stopConversation = window.agentAPI.onConversationEvent(event => {
      if (event.type === 'conversation.created' || event.type === 'conversation.updated') {
        if (deletedConversations.current.has(event.conversation.conversationId)) return;
        // 主进程建好会话就对齐本地占位：这发生在 Planner 转交之前，比等 IPC
        // 整条返回早得多。标题截取按主进程的 TITLE_CHARS=42，两个进程同源。
        const pending = pendingSubmit.current;
        const pendingId = pending && event.conversation.title === pending.title ? pending.id : null;
        if (pendingId) {
          pendingSubmit.current = null;
          setActiveConversationId(event.conversation.conversationId);
          setMessages(prev => prev.map(item =>
            item.conversationId === pendingId ? { ...item, conversationId: event.conversation.conversationId } : item
          ));
        }
        setConversations(prev => [
          event.conversation,
          ...prev.filter(item => item.conversationId !== event.conversation.conversationId && item.conversationId !== pendingId)
        ]);
        // 任务号是 Planner 转交后才写回会话的，IPC 返回时往往还是 null。
        // 不等用户手点侧栏：会话一挂上任务就选中并补读历史事件，否则
        // activeRef 还是 null，后续报告/评审/完成事件全被过滤掉，交付卡永远不出现。
        const attachedTaskId = event.conversation.taskId;
        if (
          attachedTaskId &&
          activeConversationRef.current === event.conversation.conversationId &&
          activeRef.current !== attachedTaskId
        ) {
          setActiveId(attachedTaskId);
          void window.agentAPI.getTaskEvents(attachedTaskId).then(history => {
            setEvents(history.reduce((list, item) => mergeTaskEvent(list, item), [] as AgentEvent[]));
            setDerived(projectTaskView(history));
          }).catch(() => undefined);
        }
        return;
      }
      if (event.type === 'conversation.deleted') {
        deletedConversations.current.add(event.conversationId);
        setConversations(prev => prev.filter(item => item.conversationId !== event.conversationId));
        if (activeConversationRef.current === event.conversationId) {
          setActiveConversationId(null);
          setMessages([]);
          setPhases({});
          setAnswerDeltas({});
          setDebateLive(null);
        }
        return;
      }
      if (event.type === 'message.added') {
        // Only the conversation on screen. A message for any other one belongs
        // to its own pane, and appending it here mixed two threads together.
        if (event.message.conversationId !== activeConversationRef.current) return;
        // Messages are appended live, so the pane fills in as channels answer
        // instead of appearing all at once when the slowest page finishes.
        setMessages(prev => mergeConversationMessage(prev, event.message));
        // 综合结论落盘时，主导人的流式预览必须让位：它的最终文本变成了
        // synthesis 消息，不会再有一条 channel 消息来清掉它。
        if (event.message.synthesis) setAnswerDeltas({});
        // 直接辩论结束时同理：快照已经落成消息，实时面板要让位给那张卡片。
        if (event.message.synthesis || event.message.debate) setDebateLive(null);
        if (event.message.role === 'channel' && event.message.channelId) {
          const channelId = event.message.channelId;
          setAnswerDeltas(prev => {
            if (!(channelId in prev)) return prev;
            const next = { ...prev };
            delete next[channelId];
            return next;
          });
        }
        return;
      }
      if (event.type === 'debate.progress') {
        if (event.conversationId !== activeConversationRef.current) return;
        setDebateLive({
          status: event.status,
          ...(event.stopReason ? { stopReason: event.stopReason } : {}),
          rounds: event.rounds
        });
        return;
      }
      if (event.type === 'answer.delta') {
        if (event.conversationId !== activeConversationRef.current) return;
        setAnswerDeltas(prev => {
          const current = prev[event.channelId] ?? { text: '', reasoning: '', done: false };
          return {
            ...prev,
            [event.channelId]: {
              text: event.reset === true ? (event.text ?? '') : current.text + (event.text ?? ''),
              reasoning: event.reset === true ? (event.reasoning ?? '') : current.reasoning + (event.reasoning ?? ''),
              done: event.done === true
            }
          };
        });
        return;
      }
      if (event.type === 'channel.phase') {
        // Same reason: a phase belongs to the conversation it was emitted for.
        if (event.conversationId !== activeConversationRef.current) return;
        // `at` is kept so the strip can show how long a channel has been asking.
        // Without it "提问中" is the same word at second two and second ninety,
        // which is exactly what a frozen app looks like.
        setPhases(prev => ({
          ...prev,
          [event.channelId]: { phase: event.phase, detail: event.detail, at: event.at }
        }));
        if (event.phase === 'failed') {
          const channelId = event.channelId;
          setAnswerDeltas(prev => {
            if (!(channelId in prev)) return prev;
            const next = { ...prev };
            delete next[channelId];
            return next;
          });
        }
        return;
      }
      if (event.type === 'conversation.failed') {
        setError(event.error);
      }
    });

    return () => {
      stopEvents();
      stopDeepSeek();
      stopConversation();
      stopLayout();
      stopSources();
      stopPage();
      stopPageSaveRequest();
    };
  }, []);

  // Channel availability, refreshed while a conversation is running too.
  //
  // Refreshing only when idle was the reason the top bar could say "0/2 通道就绪
  // · 页面尚未加载" during a run in which both pages were in fact answering: the
  // statuses were read once at startup, before the views had loaded, and never
  // again while `conversationBusy` held. A stale availability pill is worse than
  // none — it is the one place the user looks to decide whether to wait.
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      window.agentAPI
        .getChannelStatuses()
        .then(list => {
          if (!cancelled) setChannelStatuses(list);
        })
        .catch(() => undefined);
    };
    read();
    // Idle polling is not redundant. The pages load asynchronously and any page
    // can go away later (logout, a navigation out of the allow-list), so reading
    // once at mount is how the pill sat on "0/2 · 页面尚未加载" while both pages
    // were in fact loading behind it. Slower when nothing is running, because a
    // wrong number is only urgent while the user is waiting on it.
    const timer = setInterval(read, conversationBusy ? 4000 : 6000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [conversationBusy, activeConversationId]);

  useEffect(() => {
    document.documentElement.style.setProperty('--split', `${String(split)}px`);
  }, [split]);

  // 设置面板里的「专家与技能」改完关掉它，输入框里那份开关要跟上——两处
  // 显示的是同一份 .md，允许它们各说一套就是「设了不生效」的来源。
  useEffect(() => {
    if (settingsOpen) return;
    window.agentAPI.getExpertise().then(setExpertise).catch(() => undefined);
  }, [settingsOpen]);

  useEffect(() => {
    // Published for the ghost only; the rail sizes itself from the constant.
    document.documentElement.style.setProperty('--rail', `${String(RAIL_WIDTH)}px`);
  }, []);

  // -------------------------------------------------------------------------
  // Divider drag
  //
  // Two things make this less obvious than it looks. First, the page pane is a
  // native view, so CSS cannot move it — every move has to go through IPC, and
  // the width the main process applied is the one that counts. Second, a native
  // view swallows mouse events by native hit test, so a drag that follows the
  // boundary dies the moment the pointer enters the page. Hence `setPageDragging`:
  // while the gesture is live the view steps outside the window and a ghost
  // stands in for it.
  // -------------------------------------------------------------------------

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = true;
    setDraggingPage(true);
    // Capture is what keeps the moves coming once the pointer leaves this
    // element. It is best-effort: an inactive pointer id makes it throw, and a
    // throw here would leave the drag half-started.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* no capture; window-level moves still land while over the app column */
    }
    void window.agentAPI.setPageDragging(true).catch(() => undefined);
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    // Clamped with the same function the main process uses, so the handle
    // tracks the cursor instead of snapping when the reply lands.
    const next = computeSplit(window.innerWidth, Math.round(window.innerWidth - event.clientX));
    setSplit(next);
    void window.agentAPI.setSplit(next).catch(() => undefined);
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      /* already released */
    }
    stopDrag();
  }

  /** Idempotent: the pointer-up path and the safety net below both land here. */
  function stopDrag() {
    if (!dragRef.current) return;
    dragRef.current = false;
    setDraggingPage(false);
    void window.agentAPI.setPageDragging(false).catch(() => undefined);
  }

  // The page view only comes back when the main process is told the drag is
  // over. If that message is ever missed the page stays parked offscreen and
  // the app looks like it lost its right half — so any way the gesture can end
  // has to release it, not just the tidy pointer-up on the divider.
  useEffect(() => {
    if (!draggingPage) return;
    const release = () => stopDrag();
    /**
     * A pointermove with no button held means the gesture is already over and we
     * never saw the pointerup — which is how the page ended up parked offscreen
     * with a white strip where it used to be. The pointerup below cannot catch
     * that case; this can.
     */
    const releaseIfButtonless = (event: PointerEvent) => {
      if (event.buttons === 0) stopDrag();
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    window.addEventListener('pointermove', releaseIfButtonless);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
      window.removeEventListener('pointermove', releaseIfButtonless);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingPage]);

  function resetSplit() {
    void window.agentAPI
      .setSplit(0)
      .then(info => setSplit(info.split))
      .catch(() => undefined);
  }

  /**
   * Open the channel report for the page in the pane.
   *
   * A repair result from a previous visit is dropped on purpose: it describes a
   * read that no longer exists, and leaving it above fresh numbers is how a
   * stale "已重新提取" ends up looking like the state of a broken page.
   */
  async function openDiagnostics() {
    const id = sources.activeId;
    setDiagChannelId(id);
    setRepairReport(null);
    setDiagOpen(true);
    await refreshDiagnostics(id);
  }

  async function refreshDiagnostics(sourceId = diagChannelId) {
    setDiagLoading(true);
    try {
      setDiagReport(await window.agentAPI.getDeepSeekDiagnostics(sourceId || undefined));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDiagLoading(false);
    }
  }

  function selectDiagChannel(id: string) {
    setDiagChannelId(id);
    setRepairReport(null);
    void refreshDiagnostics(id);
  }

  async function selectTask(taskId: string) {
    setActiveId(taskId);
    setError('');
    setClarifyText('');
    try {
      const history = await window.agentAPI.getTaskEvents(taskId);
      setEvents(history.reduce((list, item) => mergeTaskEvent(list, item), [] as AgentEvent[]));
      setDerived(projectTaskView(history));
    } catch (e) {
      setError(errorText(e));
    }
  }

  /**
   * 把一个目录变成工作区并切过去。
   *
   * 添加和切换是一步：用户点「＋」挑完目录，期待的就是下一句话落在这个组里。
   * 主进程同时写 `activeWorkspaceId` 与 `workspaceRoot`，界面这里只镜像结果。
   */
  async function useDirectoryAsWorkspace(dir: string) {
    const result = await window.agentAPI.addWorkspace({ root: dir });
    setWorkspaces(result.workspaces);
    setActiveWorkspaceId(result.workspace.workspaceId);
    setWorkspace(result.workspace.root);
    if (!result.created) setNotice(`这个目录已经是工作区「${result.workspace.name}」，已切换过去。`);
  }

  async function chooseWorkspace() {
    try {
      const dir = await window.agentAPI.chooseDirectory();
      if (dir) {
        setNotice('');
        await useDirectoryAsWorkspace(dir);
      }
    } catch (e) {
      setError(errorText(e));
    }
  }

  function selectWorkspace(workspaceId: string) {
    const entry = workspaces.find(item => item.workspaceId === workspaceId);
    if (!entry) return;
    setActiveWorkspaceId(workspaceId);
    setWorkspace(entry.root);
    void window.agentAPI
      .setWorkspace({ activeWorkspaceId: workspaceId, workspaceRoot: entry.root })
      .catch(error => setError(errorText(error)));
  }

  /** 返回空串表示成功；组件把失败原因显示在输入框下面，不丢到应用底栏。 */
  async function renameWorkspace(workspaceId: string, name: string): Promise<string> {
    try {
      const result = await window.agentAPI.renameWorkspace({ workspaceId, name });
      setWorkspaces(result.workspaces);
      return '';
    } catch (e) {
      return ipcErrorText(e);
    }
  }

  async function removeWorkspace(workspaceId: string): Promise<string> {
    try {
      const result = await window.agentAPI.removeWorkspace(workspaceId);
      setWorkspaces(result.workspaces);
      if (activeWorkspaceId === workspaceId) {
        setActiveWorkspaceId('');
        setWorkspace('');
      }
      setNotice(
        result.clearedConversations > 0
          ? `已移除工作区「${result.removed.name}」，${String(result.clearedConversations)} 条会话移到「未分组」；工作区里的文件没有改动。`
          : `已移除工作区「${result.removed.name}」；没有会话挂在它下面，工作区里的文件没有改动。`
      );
      return '';
    } catch (e) {
      return ipcErrorText(e);
    }
  }

  /**
   * 切换顶层入口。
   *
   * 只做三件事：记住选择、写盘、退出当前会话（历史会话仍在侧栏，不删数据）。
   * 「退出当前会话」是必要的：否则在一条知识会话里切到工程空间，下一句追问
   * 会带着工程空间的配置落回原来的知识会话，用户看到的就是串台。
   */
  function changeWorkspaceMode(mode: WorkspaceMode) {
    setWorkspaceMode(mode);
    setTaskKindOverride(null);
    setActiveConversationId(null);
    setActiveId(null);
    setMessages([]);
    setPhases({});
    setAnswerDeltas({});
    setDebateLive(null);
    // 附件是绑在「这一问」上的：换了空间还留着上一段的文件，下一问会莫名
    // 带着一份和它无关的资料发出去。
    setAttachments([]);
    setError('');
    setNotice('');
    void window.agentAPI.setWorkspace({ workspaceMode: mode }).catch(error => setError(errorText(error)));
  }

  /**
   * 改研究设置。
   *
   * 三件事一起做：
   * 1. 面板立刻显示新值；
   * 2. 写成跨会话默认值（主导人、参与的云端模型等）——新对话与重启都用这份；
   * 3. 开着会话时同步写到这个会话上，追问沿用刚改的那份。
   *
   * 少了第 2 步，关掉应用或点「新对话」就会退回「云端全关 / 没点名主导」，
   * 看起来正是「设了不生效」。
   */
  function changeExecutionConfig(patch: Partial<ConversationExecutionConfig>) {
    const next = normalizeExecutionConfig({ ...executionConfigRef.current, ...patch });
    executionConfigRef.current = next;
    executionDefaultsRef.current = next;
    setExecutionConfig(next);

    if (configSaveTimer.current) clearTimeout(configSaveTimer.current);
    // 稍等一下只是为了让连点几个档位只写一次盘；不攒成一批，最后那一下必须落盘。
    configSaveTimer.current = setTimeout(() => {
      configSaveTimer.current = null;
      const conversationId = activeConversationRef.current;
      void window.agentAPI.setExecutionDefaults(next).catch(error => setError(errorText(error)));
      if (!conversationId) return;
      void window.agentAPI
        .updateConversationConfig({ conversationId, executionConfig: next })
        .catch(error => setError(errorText(error)));
    }, 400);
  }

  /**
   * 「＋ · 添加文件」。
   *
   * 对话框在主进程里弹，回来的是引用（名字、路径、体积）；正文按发送那一刻
   * 的磁盘内容读。用户取消就是空数组，什么都不改。
   */
  async function addAttachments() {
    setError('');
    try {
      const picked = await window.agentAPI.chooseAttachments();
      if (picked.length === 0) return;
      if (notice) setNotice('');
      setAttachments(prev => dedupeAttachments([...prev, ...picked]));
    } catch (e) {
      setError(errorText(e));
    }
  }

  /** 「＋ · 引用对话中的文件」：把这条会话里带过的文件重新挂到这一问上。 */
  function referenceAttachment(file: ConversationAttachment) {
    setAttachments(prev => dedupeAttachments([...prev, file]));
  }

  function removeAttachment(id: string) {
    setAttachments(prev => prev.filter(item => item.id !== id));
  }

  /**
   * 「＋ · 专家 / 技能」。
   *
   * 写的是与设置面板同一份开关（`userData/expertise.json`），不是一个只活
   * 在输入框里的第二套状态——「设了生效」和「设了不生效」的差别全在这一处。
   */
  async function toggleExpertise(id: ExpertiseId, enabled: boolean) {
    setError('');
    try {
      setExpertise(await window.agentAPI.setExpertiseEnabled(id, enabled));
    } catch (e) {
      setError(errorText(e));
    }
  }

  /** 「＋ · 模式 → 主导」：和研究设置里那一项是同一个值。 */
  function changeExecutionMode(mode: ExecutionMode) {
    changeExecutionConfig({ executionMode: mode });
  }

  /**
   * 从输入框上方那个「新对话」开始一条新的。
   *
   * 侧栏的「新任务」连输入框一起清空；这里不清——用户往往是先把问题写好、看到
   * 上面写着「追问《…》」才点的它，把他刚写的那句删掉是最糟的回应。
   *
   * 研究设置回到跨会话默认值：上一条会话临时改过的主导人 / 参与模型不该
   * 偷偷跟着新对话走，也不该退回代码里的出厂默认——用的是用户自己保存的那份。
   */
  function startNewConversation() {
    setActiveConversationId(null);
    /**
     * 也要把任务工作台一起放下。
     *
     * 只清 `activeConversationId` 的话，主区域还在渲染上一条任务的进度卡，
     * 而输入框的 disabled 是按 `activeTask` 算的——只要那条任务还在跑（或还在
     * 等审批），用户就永远点不下去。「新对话」在用户眼里就是「我要问下一件
     * 事」，它必须是可用的：旧任务继续在后台跑，在「同时在跑」里看着。
     */
    setActiveId(null);
    setEvents([]);
    setDerived(EMPTY_TASK_VIEW);
    setClarifyText('');
    setMessages([]);
    setPhases({});
    setAnswerDeltas({});
    setDebateLive(null);
    setError('');
    setNotice('');
    const defaults = normalizeExecutionConfig(executionDefaultsRef.current);
    executionConfigRef.current = defaults;
    setExecutionConfig(defaults);
    setFocusRequest(n => n + 1);
  }

  async function submit() {
    const text = prompt.trim();
    if (!text) {
      // The send button is disabled in this state, but Enter gets here too, and
      // a keystroke that does nothing at all is indistinguishable from a hang.
      setNotice('先写一句目标，再发送。');
      composerRef.current?.focus();
      return;
    }

    // 界面只传路径：正文在发送那一刻由主进程读盘，这里不留副本。
    const attachmentPaths = attachments.map(item => item.path);

    // An open conversation that already answered takes the message as a
    // follow-up. The page keeps its own context, so the question goes out as
    // written — no re-statement of the framing.
    if (activeConversation && !activeConversation.taskId && !conversationBusy) {
      setSubmitting(true);
      setError('');
      setNotice('');
      // 新一轮自己的阶段：上一轮失败的模型不能带着「失败」徽章再出现在条上。
      setPhases({});
    setAnswerDeltas({});
    setDebateLive(null);
      try {
        const updated = await window.agentAPI.followupConversation({
          conversationId: activeConversation.conversationId,
          text,
          // 追问沿用会话里那份配置，只有把当前设置带上，用户刚改成「本地主导」
          // 的下一条提问才会真的按本地主导跑。
          executionConfig,
          // 「先分析再修改」的第二阶段：用户明确选了「本次按实施」才交去出计划。
          ...(taskKindOverride ? { taskKindOverride } : {}),
          // 附件是这一问的：发送成功就清空，不带进下一句。
          ...(attachmentPaths.length > 0 ? { attachments: attachmentPaths } : {})
        });
        setConversations(prev => [updated, ...prev.filter(item => item.conversationId !== updated.conversationId)]);
        setPrompt('');
        setAttachments([]);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // A workspace is only needed when the router is actually going to execute
    // something. Asking for one up front — which is what this used to do for
    // every message — is the exact behaviour this rebuild removes.
    const intent = classifyIntent(text);
    let root = workspace;
    // 工程空间没有项目就没有工程上下文，先让用户选，而不是发出一条注定
    // 要被判成 clarify 的问题。知识空间仍只对 workspace 意图要目录。
    const needsDirectory = workspaceMode === 'engineering' || intent.kind === 'workspace';
    if (needsDirectory && !root) {
      try {
        const dir = await window.agentAPI.chooseDirectory();
        if (!dir) {
          setNotice(workspaceMode === 'engineering'
            ? '工程工作空间还没有选择项目，任务没有提交。'
            : '这是一次工作区操作，但还没有选择目录，任务没有提交。');
          return;
        }
        root = dir;
        // 这次新挑的目录也成为一个工作区：不然会话有了 root 却没有分组，
        // 侧栏会把它放进「未分组」，用户刚做的选择当场就不见了。
        try {
          await useDirectoryAsWorkspace(dir);
        } catch (error) {
          // 建组失败不该拦住这次提问：目录已经选好，工程证据照样读得到。
          setError(errorText(error));
        }
      } catch (e) {
        setError(errorText(e));
        return;
      }
    }

    setNotice('');
    setSubmitting(true);
    setError('');
    setPhases({});
    setAnswerDeltas({});
    setDebateLive(null);

    // 先切视图，再等主进程。工程提交在 main 里要探活/路由/转交，整条 IPC
    // 可能几十秒不返回；以前这几十秒界面一直停在首页，跟卡死没有区别。
    const optimisticId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const optimistic: Conversation = {
      conversationId: optimisticId,
      title: text.slice(0, 42),
      intent: intent.kind,
      intentReason: intent.reason,
      status: 'thinking',
      channels: [],
      createdAt: now,
      updatedAt: now,
      executionConfig,
      ...(root ? { workspaceRoot: root } : {}),
      ...(workspaceMode === 'engineering' ? { workspaceMode } : {})
    };
    pendingSubmit.current = { id: optimisticId, title: optimistic.title, previousId: activeConversationId };
    setConversations(prev => [optimistic, ...prev]);
    setActiveConversationId(optimisticId);
    setMessages([{ messageId: `pending-${optimisticId}`, conversationId: optimisticId, role: 'user', text, at: now }]);
    setPrompt('');
    setAttachments([]);

    try {
      const conversation = await window.agentAPI.submitConversation({
        text,
        workspaceRoot: root || undefined,
        permissionPreset: permission,
        executionConfig,
        workspaceMode,
        // 会话归到当前工作区。没有工作区时不传，侧栏会把它放进「未分组」。
        ...(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}),
        ...(taskKindOverride ? { taskKindOverride } : {}),
        ...(attachmentPaths.length > 0 ? { attachments: attachmentPaths } : {})
      });
      // 事件可能已经把占位换成真会话；这里再做一次兜底对齐，幂等。
      const pending = pendingSubmit.current;
      pendingSubmit.current = null;
      const pendingId = pending?.id ?? '';
      setConversations(prev => [
        conversation,
        ...prev.filter(item => item.conversationId !== conversation.conversationId && item.conversationId !== pendingId)
      ]);
      setActiveConversationId(conversation.conversationId);
      setMessages(prev => prev.map(item =>
        item.conversationId === pendingId || item.conversationId === optimisticId
          ? { ...item, conversationId: conversation.conversationId }
          : item
      ));
      setPhases({});
      setAnswerDeltas({});
      setDebateLive(null);
      setPrompt('');
      setAttachments([]);
      setActiveId(conversation.taskId ?? null);
      // 读一遍已经落库的消息，而不是只等事件。
      //
      // 主进程是先写「你问的这句」再返回的，那一条的 message.added 往往在
      // 这个窗口挂上监听之前就发完了；只靠事件的话，第一轮的提问气泡永远
      // 不会出现，而第二轮的会出现——界面上看起来就像「第一问没问过」。
      // 事件里按 messageId 去重，随后到的同一批消息不会重复渲染。
      const seeded = await window.agentAPI.getConversationMessages(conversation.conversationId).catch(() => []);
      setMessages(seeded);
      if (conversation.taskId) await selectTask(conversation.taskId);
    } catch (e) {
      // 没发出去就当没发过：撤掉占位、回到原来的会话，原话留给用户输入。
      const pending = pendingSubmit.current;
      pendingSubmit.current = null;
      if (pending) {
        setConversations(prev => prev.filter(item => item.conversationId !== pending.id));
        setActiveConversationId(pending.previousId);
        setMessages([]);
        setPrompt(prev => prev || text);
      }
      setError(errorText(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function selectConversation(conversationId: string) {
    setActiveConversationId(conversationId);
    setActiveId(null);
    setError('');
    setPhases({});
    setAnswerDeltas({});
    setDebateLive(null);
    // 换一条会话就是换一段上下文，上一段挑的附件不该跟过来。
    setAttachments([]);
    try {
      const [list, conversation] = await Promise.all([
        window.agentAPI.getConversationMessages(conversationId),
        window.agentAPI.getConversation(conversationId)
      ]);
      setMessages(list);
      // 面板跟着会话走。这个会话上次存的是「本地主导」，打开它就该显示本地主导，
      // 下一条追问也按它跑——而不是停在另一个会话留下的那一份设置上。
      if (conversation?.executionConfig) {
        const stored = normalizeExecutionConfig(conversation.executionConfig);
        executionConfigRef.current = stored;
        setExecutionConfig(stored);
      }
      // V2.1：老会话没有 workspaceMode，一律按知识空间打开；新会话则把当时
      // 绑定的项目一起带回来，否则追问会读到另一个工程的上下文。
      if (conversation?.workspaceMode) {
        setWorkspaceMode(conversation.workspaceMode);
        if (conversation.workspaceRoot) setWorkspace(conversation.workspaceRoot);
      }
      // 打开一条会话时，侧栏的当前工作区跟着它走：下一次追问落在同一条线程，
      // 而下一句「新对话」应该默认留在用户正在看的这个组里。
      if (conversation?.workspaceId && workspaces.some(item => item.workspaceId === conversation.workspaceId)) {
        setActiveWorkspaceId(conversation.workspaceId);
      }
      if (conversation?.taskId) {
        setActiveId(conversation.taskId);
        await selectTask(conversation.taskId);
      }
    } catch (e) {
      setError(errorText(e));
    }
  }

  /**
   * 「直接辩论」的输出落在回答界面：切到它挂的那条会话，接上实时辩论面板。
   * 进度事件大约每 1.5 秒来一次；在第一条到达之前先放一个空快照，页面上
   * 不会出现「只有问题、什么都没有」的空白等待。
   */
  async function showDebateAnswer(info: { debateId: string; conversationId?: string }) {
    setResearchOpen(false);
    if (!info.conversationId) return;
    await selectConversation(info.conversationId);
    setConversationTab('chat');
    // 很短的辩论可能在切过来之前就跑完了：那就只显示落盘卡片，不再放一个
    // 「running 0 轮」的实时壳子——它收不到后续事件，会一直停在那里。
    const state = await window.agentAPI.getDebate(info.debateId).catch(() => null);
    if (state?.status === 'running') {
      setDebateLive(previous => previous ?? { status: 'running', rounds: [] });
    }
  }

  /**
   * 「直接辩论」按钮：不打开任何设置页，直接用输入框里的这句话开一场正式辩论。
   *
   * 成员、主导人、策略都按研究设置里的同一份配置（和执行模式共用），
   * 输出落在回答界面。这是「白名单式」的入口：这一句被直接放行到正式辩论，
   * 不再跑第一轮回答与汇总。
   */
  async function startDirectDebate() {
    const question = prompt.trim();
    if (!question) {
      setNotice('先写一句要辩论的问题。');
      composerRef.current?.focus();
      return;
    }
    if (submitting || conversationBusy) return;
    const candidates = executionOptions?.debateCandidates ?? [];
    const mode = executionConfig.executionMode;
    // 归属规则与研究设置一致：一种主导方式只用一类成员；混合先择一。
    const owner: 'web' | 'local' | 'cloud' | null = mode === 'hybrid' ? null : mode;
    const poolOf = (type: 'web' | 'local' | 'cloud'): string[] | undefined =>
      type === 'web' ? executionConfig.selectedWebChannels
        : type === 'cloud' ? executionConfig.selectedCloudModels
          : executionConfig.selectedLocalModels;
    const participants = candidates
      .filter(item => item.available && (owner === null || item.type === owner))
      .filter(item => {
        const pool = poolOf(item.type);
        return pool === undefined || pool.includes(item.id);
      })
      .map(item => item.id);
    // 候选还没读到、或按统一配置一个可用成员都没有：如实拦下。
    // 不能把空名单交给主进程「按归属规则随便挑」——云端主导下那会把所有
    // 可用模型都拉进来，用户完全没同意这场调用。
    if (participants.length === 0) {
      setNotice(candidates.length === 0
        ? '正在读取可用成员，稍等一秒再点「直接辩论」。'
        : '当前主导方式下没有可用的参辩成员：去「研究设置 → 辩论」勾选成员，或换一种主导方式。');
      return;
    }
    setSubmitting(true);
    setError('');
    setNotice('');
    try {
      const started = await window.agentAPI.startDebate({
        question,
        conversationId: activeConversation?.conversationId ?? undefined,
        ...(workspaceMode === 'engineering' ? { workspaceMode } : {}),
        ...(workspaceMode === 'engineering' && activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}),
        ...(workspaceMode === 'engineering' && workspace ? { workspaceRoot: workspace } : {}),
        config: {
          // 直接辩论默认只跑一轮：它跳过了第一轮回答与汇总，用户要的是
          // 一场能立刻看到交锋的正式辩论，不是再等三轮。
          strategy: executionConfig.debateStrategy ?? 'truth',
          maxRounds: 1,
          leadMode: mode,
          leadAgentId: executionConfig.leadAgentId,
          participants
        }
      });
      setPrompt('');
      await showDebateAnswer({ debateId: started.debateId, conversationId: started.conversationId });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteConversation(conversationId: string) {
    try {
      deletedConversations.current.add(conversationId);
      const outcome = await window.agentAPI.deleteConversation(conversationId);
      setConversations(prev => prev.filter(item => item.conversationId !== conversationId));
      if (activeConversationId === conversationId) {
        setActiveConversationId(null);
        setMessages([]);
      }
      // The row is gone either way; what can still be wrong is the sites. Saying
      // it here is the only moment the user can act on it — the conversation is
      // no longer there to carry the note.
      if (outcome?.failed?.length) {
        setNotice(
          `对话已删除，但网页里的会话没删掉：${outcome.failed
            .map(item => `${item.label}（${item.detail}）`)
            .join('；')}`
        );
      } else if (outcome?.cleaned?.length) {
        // Silence after a delete is indistinguishable from a delete that did
        // nothing, and the web-side part is exactly what the user asked for.
        setNotice(`对话已删除，网页里的 ${String(outcome.cleaned.length)} 条会话也一起删掉了。`);
      }
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function approve() {
    if (!activeTask || !derived.plan) return;
    setApproving(true);
    setError('');
    try {
      await window.agentAPI.approvePlan({
        taskId: activeTask.taskId,
        roundId: derived.plan.roundId,
        planId: derived.plan.planId,
        approved: true
      });
      setDerived(prev => ({ ...prev, plan: null }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setApproving(false);
    }
  }

  /**
   * 逐次审批的两个动作。
   *
   * 不复用 `approve()`：那是「批准整份计划」，回包之后计划卡片就该消失；这里
   * 批准的是**一步**，后面还有步骤要跑，卡片要等回执事件到达才撤（否则界面
   * 会短暂显示「没有待办」，用户以为整件事结束了）。
   */
  async function decideStep(approved: boolean, remember = false) {
    if (!pendingStep) return;
    setError('');
    try {
      if (approved) {
        await window.agentAPI.approveStep({
          taskId: pendingStep.taskId,
          stepId: pendingStep.stepId,
          remember
        });
      } else {
        await window.agentAPI.rejectStep({ taskId: pendingStep.taskId, stepId: pendingStep.stepId });
      }
    } catch (e) {
      setError(errorText(e));
      setPendingStep(null);
    }
  }

  /**
   * 回答执行中的提问。`cancelled` 是明确说「我不回答」——模型必须按未回答处理，
   * 不能替用户选默认值。
   */
  async function answerQuestion(answer: string, cancelled = false) {
    if (!pendingQuestion) return;
    setError('');
    try {
      await window.agentAPI.answerStepQuestion({
        taskId: pendingQuestion.taskId,
        stepId: pendingQuestion.stepId,
        ...(cancelled ? { cancelled: true } : { answer })
      });
      setQuestionText('');
    } catch (e) {
      setError(errorText(e));
      setPendingQuestion(null);
    }
  }

  async function reject() {
    if (!activeTask || !derived.plan) return;
    setError('');
    try {
      await window.agentAPI.rejectPlan({ taskId: activeTask.taskId, planId: derived.plan.planId });
      setDerived(prev => ({ ...prev, plan: null }));
    } catch (e) {
      setError(errorText(e));
    }
  }

  /**
   * One button for both kinds of work.
   *
   * A conversation used to have no way out: the only control was the task's,
   * so a page that never answered left the pane at 收集中 with the composer
   * disabled and nothing to press. Waiting is fine; waiting without an exit is
   * what reads as a hang.
   */
  async function cancel() {
    try {
      if (activeConversation && conversationBusy) {
        await window.agentAPI.cancelConversation(activeConversation.conversationId);
        return;
      }
      if (activeTask) await window.agentAPI.cancelTask(activeTask.taskId);
    } catch (e) {
      setError(errorText(e));
    }
  }

  /**
   * 验证闸门停在 report_pending 时的两个出口。
   *
   * 「重新判定」只重算结论（执行事实不变），「接受未验证」是明确收尾。没有这
   * 两个按钮时，任务在界面上像结束了：没有交付、没有下一步，只能干等。
   */
  async function recheckVerification() {
    if (!activeTask) return;
    setError('');
    try {
      const result = await window.agentAPI.recheckVerification(activeTask.taskId);
      setNotice(
        result.verified
          ? '重新判定通过：这一轮已有成功的构建 / 测试 / 运行断言，任务按完成收尾'
          : `重新判定仍未通过：${result.reasons.join('；') || '没有可用的检查证据'}`
      );
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function acceptUnverified() {
    if (!activeTask) return;
    setError('');
    try {
      await window.agentAPI.acceptUnverified(activeTask.taskId);
      setNotice('已按完成收尾：这一轮保持「未验证」，缺口记在报告里');
    } catch (e) {
      setError(errorText(e));
    }
  }

  /** 环境修好后继续跑：会重新规划并执行，不只是重算结论。 */
  async function resumeRepair() {
    if (!activeTask) return;
    setError('');
    try {
      await window.agentAPI.resumeRepair(activeTask.taskId);
      setNotice('已按当前环境重新开始修复：会重新规划并执行未通过的验证');
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function answerClarification() {
    if (!activeTask || !clarifyText.trim()) return;
    setError('');
    try {
      await window.agentAPI.answerClarification({ taskId: activeTask.taskId, answer: clarifyText.trim() });
      setClarifyText('');
      setDerived(prev => ({ ...prev, questions: [] }));
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function deleteTask(taskId: string) {
    try {
      await window.agentAPI.deleteTask(taskId);
      setTasks(prev => prev.filter(task => task.taskId !== taskId));
      if (activeId === taskId) {
        setActiveId(null);
        setEvents([]);
        setDerived(EMPTY_DERIVED);
      }
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function changePermission(next: PermissionPreset) {
    setError('');
    try {
      const result = await window.agentAPI.setPermissionPreset(next);
      setPermission(result.preset);
    } catch (e) {
      setError(errorText(e));
    }
  }

  /**
   * 设置 · 模型.
   *
   * All three return an empty string on success and a sentence to show on
   * failure. They are not `void` on purpose: the panel's job is to say *why* an
   * address was refused, and throwing past it into the app-level error bar puts
   * the reason somewhere the person is not looking.
   *
   * Every rule lives in the main process — https only, and the planning channel
   * cannot be switched off. Nothing here re-implements them; a second copy
   * would be a weaker one.
   */
  async function saveSource(id: string, patch: { url?: string; enabled?: boolean }): Promise<string> {
    try {
      setSources(await window.agentAPI.saveSource(id, patch));
      // A new address or a flipped switch changes whether a channel can answer.
      setChannelStatuses(await window.agentAPI.getChannelStatuses());
      // Switching off the source that is on screen moves the pane somewhere
      // else, so the page bar has to re-read rather than assume.
      setPage(await window.agentAPI.getPageState());
      return '';
    } catch (e) {
      return ipcErrorText(e);
    }
  }

  async function addSource(input: { label: string; url: string }): Promise<string> {
    try {
      setSources(await window.agentAPI.addSource(input));
      setChannelStatuses(await window.agentAPI.getChannelStatuses());
      return '';
    } catch (e) {
      return ipcErrorText(e);
    }
  }

  async function removeSource(id: string): Promise<string> {
    try {
      setSources(await window.agentAPI.removeSource(id));
      setChannelStatuses(await window.agentAPI.getChannelStatuses());
      setPage(await window.agentAPI.getPageState());
      return '';
    } catch (e) {
      return ipcErrorText(e);
    }
  }

  async function setSourcesOpenOnLaunch(open: boolean): Promise<string> {
    try {
      setSources(await window.agentAPI.setSourcesOpenOnLaunch(open));
      setChannelStatuses(await window.agentAPI.getChannelStatuses());
      setPage(await window.agentAPI.getPageState());
      return '';
    } catch (e) {
      return ipcErrorText(e);
    }
  }

  /**
   * Rename the sidebar row.
   *
   * The reply is the stored identity, so the panel and the sidebar cannot drift
   * apart: trimming and the default name are decided in the main process, and
   * this only mirrors the result.
   */
  async function renameIdentity(name: string): Promise<string> {
    try {
      setIdentity(await window.agentAPI.setDisplayName(name));
      return '';
    } catch (e) {
      return ipcErrorText(e);
    }
  }

  async function selectSource(id: string) {
    // 点网页就离开终端面板：右侧区域同一时刻只显示一个视图。
    if (terminalPaneOpen) closeTerminalPane();
    if (id === sources.activeId) return;
    setError('');
    try {
      // The reply comes back before the page has loaded — the view is built in
      // the background, and the rail has to switch immediately or it feels
      // broken for exactly as long as the network is slow.
      setSources(await window.agentAPI.setSource(id));
      // Bringing a detached page to the front brings it home (the main process
      // does that), so the pane's state has to be re-read or the bar keeps
      // offering 吸附回来 for a page that is already back.
      setPage(await window.agentAPI.getPageState());
    } catch (e) {
      setError(errorText(e));
    }
  }

  /**
   * 「放大」 / 「吸附回来」.
   *
   * Detaching moves the live view into its own window, so the only feedback the
   * main window can give is this bar — the page itself is simply gone from the
   * pane. The state comes back in the reply rather than only through the event,
   * so a click flips the button even if the event is missed.
   */
  async function toggleDetach() {
    // A repair result describes the page that was in the pane when it was
    // produced. Moving that page elsewhere makes it stale, so it goes away
    // rather than sitting in a report about a pane that no longer holds it.
    setRepairReport(null);
    try {
      const next = page.detachedId === sources.activeId
        ? await window.agentAPI.reattachPage()
        : await window.agentAPI.detachPage(sources.activeId);
      setPage(next);
    } catch (e) {
      setError(errorText(e));
    }
  }

  /**
   * 「收起」 / 「展开」.
   *
   * The bar is *inside* the pane, so collapsing removes the very control that
   * was pressed. The state therefore comes back in the reply and the bar is
   * replaced on the same tick — waiting for the event would leave a bar floating
   * over a pane that is already gone. The width follows from `layout:changed`,
   * which reports the rail plus the stub rather than zero, so the app column
   * still stops short of the source buttons.
   */
  /** 侧栏点某个终端：开/关它自己的窗口，会话本身不受影响。 */
  /** 侧栏点终端：默认放进右侧面板，不弹窗。 */
  function openTerminalPane(sessionId: string) {
    setTerminalPaneSession(sessionId);
    setTerminalPaneOpen(true);
    void window.agentAPI.setTerminalPane(true).catch(e => setError(errorText(e)));
  }

  function closeTerminalPane() {
    setTerminalPaneOpen(false);
    setTerminalPaneSession(null);
    void window.agentAPI.setTerminalPane(false).catch(() => undefined);
  }

  async function selectCliAgent(cliId: string) {
    const state = cliTerminals.find(item => item.id === cliId);
    // 侧栏状态可能比 Runtime 慢一拍：结束会话后旧 sessionId 还在。只认
    // 列表里确实活着、且未退出的那个，否则直接起新的，不拿死会话去 attach。
    const alive =
      state && terminalSessions.some(item => item.sessionId === state.sessionId && !item.exited);
    if (state && alive) {
      openTerminalPane(state.sessionId);
      return;
    }
    if (state) {
      setCliTerminals(previous => previous.filter(item => item.id !== cliId));
    }
    try {
      const sessionId = await window.agentAPI.openCliTerminal(cliId);
      setCliTerminals(previous => [
        ...previous.filter(item => item.id !== cliId),
        { id: cliId, sessionId, running: true, open: false }
      ]);
      openTerminalPane(sessionId);
    } catch (e) {
      setError(errorText(e));
    }
  }

  /** 页面工具栏的终端按钮：有面板就收起，没有就打开第一个 CLI / 终端。 */
  function toggleTerminal() {
    if (terminalPaneOpen) {
      closeTerminalPane();
      return;
    }
    // 优先挑能被问的那一个：栏里也可能有「开着但不可用」的 CLI。
    const agent = cliAgents.find(item => item.available) ?? cliAgents[0];
    if (agent) {
      void selectCliAgent(agent.id);
      return;
    }
    const session = terminalSessions.find(item => !item.exited);
    if (session) openTerminalPane(session.sessionId);
  }

  async function toggleCollapse() {
    if (terminalPaneOpen) closeTerminalPane();
    try {
      setPage(await window.agentAPI.setPageCollapsed(!page.collapsed));
    } catch (e) {
      setError(errorText(e));
    }
  }

  /**
   * 「刷新」: load the page again, keeping the thread it has open.
   *
   * A page can stop responding — its own script wedges, or it sits on a login
   * wall that never resolves — and every control the app has goes *through*
   * that page. Reloading is the one action that still works when the page is the
   * problem, so it is a button rather than something to find in a menu.
   *
   * The wait is bounded in the main process, so this can never leave the button
   * showing 「刷新中」 for a document that will never announce itself.
   */
  async function refreshPage() {
    if (refreshing) return;
    setRefreshing(true);
    if (notice) setNotice('');
    try {
      setSources(await window.agentAPI.reloadPage(sources.activeId));
      // A reload interrupts whatever the page was in the middle of, so saying so
      // is the difference between "the button worked" and "the answer vanished".
      if (conversationBusy) setNotice('页面已刷新。正在进行的问答被打断，需要重新提问。');
      // The pill follows the page, not the press: this is what turns 「未就绪」
      // back into 「就绪」 without waiting for the next poll.
      void window.agentAPI
        .getChannelStatuses()
        .then(setChannelStatuses)
        .catch(() => undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRefreshing(false);
    }
  }

  /**
   * 「更新样式」: re-read the page and repair what stopped matching.
   *
   * Runs against the channel the diagnostics panel is pointed at, which is the
   * page the problem was seen on — not necessarily the one in the pane. The
   * outcome goes straight back into the panel: the numbers below it are re-read
   * immediately, so "修好了没有" is answered by the same hit counts that raised
   * the alarm.
   */
  async function refreshSelectors() {
    if (learning) return;
    setLearning(true);
    const id = diagChannelId || sources.activeId;
    const label = sources.sources.find(source => source.id === id)?.label ?? '内嵌页面';
    try {
      const report = await window.agentAPI.learnSelectors(id);
      setRepairReport({
        sourceLabel: label,
        message: report.message,
        learned: report.learned,
        intact: report.intact,
        failed: report.failed,
        probe: report.probe
      });
      // A repair changes whether the channel is usable, so the pill above has to
      // stop saying "未就绪" the moment the page works again.
      setChannelStatuses(await window.agentAPI.getChannelStatuses());
      if (diagOpen) await refreshDiagnostics(id);
    } catch (e) {
      setRepairReport({
        sourceLabel: label,
        message: errorText(e),
        learned: [],
        intact: [],
        failed: [],
        probe: null
      });
    } finally {
      setLearning(false);
    }
  }

  /**
   * 「保存文档」：先读一次页面，把能保存的对话列出来让用户勾选。
   *
   * 正文一律由主进程去页面里读，界面只拿预览；保存时只回传下标，避免
   * 列表和落盘内容来自两个时刻。
   *
   * 默认 Markdown；旁边那个 Word 是「单独指定」的分支，不点不会生成。
   */
  async function revertSnapshot(taskId: string) {
    try {
      const outcome = await window.agentAPI.revertTaskSnapshot(taskId);
      const failed = outcome.failed.length > 0 ? `；失败 ${String(outcome.failed.length)} 个：${outcome.failed.map(item => `${item.path}（${item.detail}）`).join('、')}` : '';
      setNotice(`已还原本轮：恢复 ${String(outcome.restored.length)} 个文件，删除 ${String(outcome.removed.length)} 个新建文件${failed}`);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function openPageSave(
    format: 'md' | 'docx',
    sourceId = sources.activeId,
    returnToDetached = false
  ) {
    if (savingPage) return;
    setSavingPage(format);
    if (notice) setNotice('');
    try {
      const preview = await window.agentAPI.extractPage({ sourceId });
      if (preview.items.length === 0) {
        setNotice('这一页没有可保存的对话（可能停在登录页或空会话）。');
        return;
      }
      setPageSave({ preview, format, sourceId, returnToDetached });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSavingPage(null);
    }
  }

  /** Closing a save panel opened from the detached window should return focus
   * to that still-open page, not make the user think saving closed it. */
  function closePageSave() {
    if (!pageSave) return;
    const { sourceId, returnToDetached } = pageSave;
    setPageSave(null);
    if (returnToDetached) {
      void window.agentAPI.focusDetachedPage(sourceId).catch(() => undefined);
    }
  }

  /** 真正落盘：合并一个文件，或按勾选逐条各存一个文件。 */
  async function runPageSave(input: {
    documents: number[];
    mode: 'merge' | 'per-item';
    includeTranscript: boolean;
  }) {
    if (!pageSave || savingPage) return;
    const { format, sourceId } = pageSave;
    setSavingPage(format);
    if (notice) setNotice('');
    try {
      const result = await window.agentAPI.savePageDocument({
        sourceId,
        format,
        documents: input.documents,
        mode: input.mode,
        includeTranscript: input.includeTranscript
      });
      if (!result) {
        setNotice('已取消保存');
        return;
      }
      const label = sources.sources.find(source => source.id === sourceId)?.label ?? '这个网页源';
      const kind = format === 'docx' ? '（Word）' : '（Markdown）';
      if (result.files && result.files.length > 0) {
        setNotice(
          `已把「${label}」的 ${result.files.length} 条对话逐条存到 ${result.path}：` +
            `${result.chars} 字，每条一个文件${kind}`
        );
      } else {
        setNotice(
          `已把「${label}」的文档存到 ${result.path}：` +
            `${result.documents} 份对话 / ${result.planItems} 条计划条目 / ${result.chars} 字${kind}`
        );
      }
      closePageSave();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSavingPage(null);
    }
  }

  const showPlan = derived.plan !== null && activeTask?.status === 'awaiting_approval';

  /** 当前工作区。名字由用户起，界面优先显示它；路径只作为兜底。 */
  const activeWorkspace = workspaces.find(item => item.workspaceId === activeWorkspaceId) ?? null;
  const activeSource = sources.sources.find(source => source.id === sources.activeId) ?? null;
  const activeChannel = channelStatuses.find(channel => channel.id === sources.activeId) ?? null;
  /** The page in the pane is the one living in its own window. */
  const isDetached = page.detachedId !== null && page.detachedId === sources.activeId;
  /** The pane is folded shut; the page is still running, just not painted. */
  const isCollapsed = page.collapsed;
  const pageStatusText = sources.loading
    ? '加载中'
    : activeChannel?.available
      ? '就绪'
      : (activeChannel?.detail ?? '未就绪');

  return (
    <div className="app">
      <TaskSidebar
        workspaceMode={workspaceMode}
        onWorkspaceModeChange={changeWorkspaceMode}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={selectWorkspace}
        onAddWorkspace={() => void chooseWorkspace()}
        onRenameWorkspace={renameWorkspace}
        onRemoveWorkspace={removeWorkspace}
        tasks={tasks}
        activeId={activeId}
        onSelect={selectTask}
        onDelete={deleteTask}
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelectConversation={selectConversation}
        onDeleteConversation={deleteConversation}
        identity={identity}
        onOpenSettings={() => {
          // 侧栏的设置每次从默认页打开；「＋ · 连接器」那条路才指定插件页。
          setSettingsSection('models');
          setSettingsOpen(true);
        }}
        onOpenDiagnostics={() => {
          setDiagOpen(true);
          void refreshDiagnostics();
        }}
        onNew={() => {
          setActiveId(null);
          setActiveConversationId(null);
          setMessages([]);
          setPhases({});
    setAnswerDeltas({});
    setDebateLive(null);
          setEvents([]);
          setDerived(EMPTY_DERIVED);
          setError('');
          setNotice('');
          setPrompt('');
          setClarifyText('');
          setAttachments([]);
          // On an already-empty screen the click changes nothing you can see,
          // which reads as "the button is dead". The caret is the feedback: it
          // moves to where the next action happens.
          setFocusRequest(n => n + 1);
        }}
      />

      <main className="center">
        <header className="topbar">
          <div className="crumb">
            <span>▤</span>
            <b>{activeTask ? baseName(activeTask.workspaceRoot) : activeWorkspace?.name ?? baseName(workspace)}</b>
            {activeTask && (
              <>
                <span className="sep">/</span>
                <b style={{ fontWeight: 400, color: 'var(--text-2)' }}>{activeTask.title}</b>
                <span className="sep">·</span>
                <span>第 {Math.max(1, roundCount)} 轮</span>
              </>
            )}
          </div>
          <div className="topbar-right">
            {/* 跟设置里「启动时打开网页源」同一开关：打开就显示就绪条，关闭就不显示。 */}
            {showWebSourceStatusBar(sources.openOnLaunch) && (() => {
              // 只数网页：`channel:statuses` 现在也带 CLI 软件源（它跟网页同一
              // 层级，转录要显示它的名字与失败原因），但这一句写的是「页面就绪」。
              const pages = channelStatuses.filter(channel => (channel.sourceType ?? 'web') === 'web');
              const ready = pages.filter(channel => channel.available).length;
              const blocked = pages.filter(channel => !channel.available);
              const detail = blocked.map(channel => `${channel.label}: ${channel.detail ?? '不可用'}`).join('；');
              return (
                <span className={`pill ${ready > 0 ? 'ok' : 'warn'}`} title={detail || status?.detail || undefined}>
                  {pages.length === 0 ? '连接中…' : `${ready}/${pages.length} 页面就绪`}
                </span>
              );
            })()}
            {showWebSourceStatusBar(sources.openOnLaunch) && (() => {
              // Two different sentences share this slot. A blocked channel is a
              // failure and says why; a signed-out-but-working one is a hint.
              //
              // The text is short and names its channel on purpose. It used to be
              // the raw detail — 「未登录：仍可使用，登录后可保存记录并解锁更高模型」 —
              // which is 24 characters in a slot that fits about sixteen, so it
              // was cut mid-sentence, and next to a green 「3/3 页面就绪」 it read
              // as "not connected" no matter what it said. The full sentence is
              // still there, as the tooltip.
              const pages = channelStatuses.filter(channel => (channel.sourceType ?? 'web') === 'web');
              const blocked = pages.find(channel => !channel.available && channel.detail);
              const hint = blocked ?? pages.find(channel => channel.available && !channel.loggedIn && channel.detail);
              if (!hint?.detail) return null;
              return (
                <span
                  className="status-detail"
                  title={
                    blocked
                      ? pages.map(channel => channel.detail).filter(Boolean).join('；')
                      : `${hint.label}：${hint.detail}`
                  }
                >
                  {blocked ? hint.detail : `${hint.label} 未登录 · 可用`}
                </span>
              );
            })()}
            {/* Only while the pane is folded. The page bar carries 诊断 when it
                is there, and the bar is the honest place for it — it is about
                the page next to it. Folded, that bar is gone, and diagnostics
                is exactly the thing you want when a page looks wrong but is
                not being shown. 网页源关闭时顶栏也不放诊断。 */}
            {showWebSourceStatusBar(sources.openOnLaunch) && isCollapsed && (
              <button className="btn ghost" type="button" onClick={() => void openDiagnostics()}>
                诊断
              </button>
            )}
            {/* 工程任务视图里「取消任务」在任务头，这里不再重复画一遍；
                知识空间没有任务头，仍由这里提供停止/取消。 */}
            {(busy || awaitingAnswer || conversationBusy) && !activeTask && (
              <button className="btn ghost" type="button" onClick={cancel}>
                {conversationBusy ? '停止等待' : '取消任务'}
              </button>
            )}
          </div>
        </header>

        {showingConversation && (
          <nav className="conversation-tabs" role="tablist" aria-label="对话视图">
            <button
              role="tab"
              aria-selected={conversationTab === 'chat'}
              className={conversationTab === 'chat' ? 'is-active' : undefined}
              onClick={() => setConversationTab('chat')}
            >
              对话
            </button>
            <button
              role="tab"
              aria-selected={conversationTab === 'trajectory'}
              className={conversationTab === 'trajectory' ? 'is-active' : undefined}
              onClick={() => setConversationTab('trajectory')}
            >
              轨迹
            </button>
            <button
              role="tab"
              aria-selected={conversationTab === 'stats'}
              className={conversationTab === 'stats' ? 'is-active' : undefined}
              onClick={() => setConversationTab('stats')}
            >
              统计
            </button>
          </nav>
        )}

        {activeTask && (
          <EngineeringWorkbenchBar
            task={activeTask}
            tab={workbenchTab}
            onTab={setWorkbenchTab}
            activeTasks={tasks}
            onSelectTask={taskId => void selectTask(taskId)}
            onExport={async () => {
              try {
                const file = await window.agentAPI.exportTaskDiagnostics(activeTask.taskId);
                setNotice(`诊断包：${file}`);
              } catch (e) {
                setError(errorText(e));
              }
            }}
            onCancel={() => void cancel()}
          />
        )}

        <div className={`scroll${activeTask || showingConversation ? '' : ' is-empty'}`}>
          <div className="inner">
            {showingConversation && activeConversation && conversationTab === 'chat' && !activeConversation.debateOnly && (
              <CollaborationPlanPanel conversationId={activeConversation.conversationId} />
            )}

            {showingConversation && activeConversation && conversationTab === 'chat' && (
              <>
                <ParticipantPanel conversationId={activeConversation.conversationId} />
                <EvidencePanel conversationId={activeConversation.conversationId} />
                <WorkspacePanel
                  conversationId={activeConversation.conversationId}
                  workspaceMode={activeConversation.workspaceMode}
                  workspaceRoot={activeConversation.workspaceRoot}
                />
                <CollaborationDiagnostics conversationId={activeConversation.conversationId} />
              </>
            )}

            {showingConversation && activeConversation && conversationTab === 'chat' && !activeConversation.debateOnly && (
              <ProgressPanel
                conversationStatus={activeConversation.status}
                taskStatus={activeTask?.status ?? null}
                events={events}
                startedAt={activeConversation.createdAt}
              />
            )}

            {showingConversation && activeConversation && conversationTab === 'chat' && (
              <ConversationView
                conversation={activeConversation}
                messages={messages}
                channelStatuses={channelStatuses}
                // 综合里的「观点A/B/C」要配上来源图标，读者才知道是哪一家。
                // CLI 软件源跟网页源并列，所以它的 id（`cli:<id>`）也要有图标。
                glyphs={new Map([
                  ...sources.sources.map(source => [source.id, source.glyph] as const),
                  ...cliAgents.map(
                    agent => [`cli:${agent.id}`, agent.glyph ?? agent.label.slice(0, 1)] as const
                  )
                ])}
                phases={phases}
                deltas={answerDeltas}
                debate={debateLive}
                busy={conversationBusy}
              />
            )}
            {showingConversation && activeConversation && conversationTab === 'chat' && (
              <MemoryTraceCard
                conversationId={activeConversation.conversationId}
                refreshKey={messages.length}
              />
            )}
            {showingConversation && activeConversation && conversationTab === 'trajectory' && (
              <TrajectoryPanel conversationId={activeConversation.conversationId} />
            )}
            {showingConversation && activeConversation && conversationTab === 'stats' && (
              <StatsPanel
                conversationId={activeConversation.conversationId}
                conversation={activeConversation}
              />
            )}

            {!activeTask && !showingConversation && (
              <section className="hero">
                <div className="hero-logo">◈</div>
                <div className="hero-title">
                  探索未至之境
                  <span className="badge">预览版</span>
                </div>
                <p className="hero-sub">
                  直接提问，问题会发给 AI 并交叉比较；只有当你需要改动本地文件时，才会生成计划、请求授权、在目录内执行。
                </p>
              </section>
            )}

            {activeTask && workbenchTab === 'conversation' && (
              <>
                <TaskProgressCard
                  task={activeTask}
                  plan={derived.plan}
                  events={events}
                  members={derived.members}
                  pendingStep={pendingStep}
                  pendingQuestion={pendingQuestion}
                  awaitingAnswer={awaitingAnswer}
                  // 和下面「最终交付」卡的渲染条件是同一个表达式：进度卡不能承诺
                  // 一块没渲染出来的区域。
                  hasDelivery={Boolean(derived.verification || derived.review || derived.changes.length > 0 || derived.artifacts.length > 0)}
                />
                {/* 主界面是这条对话流：提问、每一轮成员回答（不覆盖）、中间执行、
                    每轮评审与最后结论。状态卡说「现在到哪」，它说「发生过什么」。 */}
                <TaskConversation task={activeTask} events={events} live={derived.live} />
                {/* 多列并排只保留在输出页：对话里一轮一列会把下一条消息挤到屏幕外，
                    而主界面读的是顺序。 */}
              </>
            )}

            {activeTask && workbenchTab === 'output' && (
              <div className="wb-grid">
                <aside className="card wb-plan">
                  <div className="card-head">
                    <h2>计划树</h2>
                    <span className="muted">{derived.plan ? `${String(derived.plan.steps.length)} 步` : '等待计划'}</span>
                  </div>
                  {derived.plan ? (
                    <ol className="wb-plan-list">
                      {derived.plan.steps.map((step, index) => {
                        const event = stepActivity.get(step.id);
                        return (
                          <li key={step.id}>
                            <button
                              type="button"
                              className={`wb-plan-step ${selectedActivity?.stepId === step.id ? 'is-selected' : ''}`}
                              onClick={() => { if (event) setSelectedActivityId(event.eventId); }}
                            >
                              <span className="wb-plan-index">{index + 1}</span>
                              <span className="wb-plan-tool">{step.tool}</span>
                              <span className="wb-plan-desc">{step.description ?? ''}</span>
                              {event && <span className={`wb-plan-phase is-${event.phase}`}>{event.phase}</span>}
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  ) : <p className="muted">计划生成后显示步骤。</p>}
                </aside>

                <section className="card wb-feed">
                  <div className="card-head">
                    <h2>活动流</h2>
                    <span className="muted">
                      {filteredActivity.length} / {activity.length} 条
                      {audit.duplicateEventIds.length + audit.outOfOrder > 0
                        ? ` · 关联异常 ${String(audit.duplicateEventIds.length + audit.outOfOrder)}`
                        : ''}
                    </span>
                  </div>
                  <div className="wb-filters">
                    <input
                      value={activityQuery}
                      onChange={event => setActivityQuery(event.target.value)}
                      placeholder="搜索事件、参数、结果"
                      aria-label="搜索活动流"
                    />
                    <select value={activityCategory} onChange={event => setActivityCategory(event.target.value)} aria-label="按分类筛选">
                      <option value="all">全部</option>
                      <option value="reasoning">reasoning</option>
                      <option value="assistant">assistant</option>
                      <option value="tool">tool</option>
                      <option value="planning">planning</option>
                      <option value="test">test</option>
                      <option value="review">review</option>
                      <option value="delivery">delivery</option>
                      <option value="lifecycle">lifecycle</option>
                    </select>
                  </div>
                  {activity.length === 0 ? (
                    <p className="muted">还没有可展示的事件。</p>
                  ) : (
                    <div className="wb-feed-list">
                      {filteredActivity.map(event => (
                        <button
                          key={event.eventId}
                          type="button"
                          className={`wb-event ${selectedActivityId === event.eventId ? 'is-selected' : ''}`}
                          onClick={() => setSelectedActivityId(event.eventId)}
                        >
                          <span className="wb-event-time">{new Date(event.occurredAt).toLocaleTimeString()}</span>
                          <span className="wb-event-category">{event.category}</span>
                          <span className="wb-event-phase">{event.phase}</span>
                          <span className="wb-event-actor">{event.actor.label}</span>
                          <span className="wb-event-type">{String(event.payload.type ?? '')}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                <aside className="card wb-inspector">
                  <div className="card-head">
                    <h2>事件详情</h2>
                    {selectedActivity && (
                      <button className="btn ghost" type="button" onClick={() => setSelectedActivityId(null)}>关闭</button>
                    )}
                  </div>
                  {selectedActivity ? (
                    <>
                      <EventInspector event={selectedActivity} />
                    </>
                  ) : <p className="muted">点击活动流中的事件查看完整参数与返回。</p>}
                </aside>
              </div>
            )}

            {/* 审批动作只在各自卡片上出现一次（计划卡 / 步骤卡），取消在任务头。
                这里曾经还有一条悬浮操作栏，会把同一个「确认并执行」画出两遍。 */}

            {activeTask && workbenchTab === 'output' && (
              <div className="status-row">
                <span className={`pill s-${activeTask.status}`}>{statusLabel(activeTask.status)}</span>
                <span className="muted">{platform === 'darwin' ? 'macOS' : platform || 'macOS'}</span>
                {activeTask.workspaceRoot && <span className="muted">· {activeTask.workspaceRoot}</span>}
                {taskConversation && (
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() => void selectConversation(taskConversation.conversationId)}
                    title="回到这条任务的原会话，查看思考过程与轨迹"
                  >
                    对话 / 轨迹
                  </button>
                )}
              </div>
            )}

            {workspaceMode === 'engineering' && !showingConversation && workbenchTab === 'output' && (activeTask?.workspaceRoot || workspace) && (
              <CodeIndexPanel root={activeTask?.workspaceRoot ?? workspace} />
            )}

            {activeTask && workbenchTab === 'conversation' && (derived.questions.length > 0 || awaitingAnswer) && (
              <section className="card clarify">
                <h2>DeepSeek 需要澄清</h2>
                {derived.questions.length > 0 ? (
                  <ol>
                    {derived.questions.map((question, index) => (
                      <li key={index}>{question}</li>
                    ))}
                  </ol>
                ) : (
                  <p className="muted">这一轮的问题没有随事件保留下来；直接写出你的补充说明即可。</p>
                )}
                <textarea
                  rows={2}
                  value={clarifyText}
                  onChange={event => setClarifyText(event.target.value)}
                  placeholder="回答后继续规划"
                  disabled={!awaitingAnswer}
                  autoFocus={awaitingAnswer}
                />
                <button
                  className="btn"
                  type="button"
                  disabled={!awaitingAnswer || !clarifyText.trim()}
                  onClick={answerClarification}
                >
                  {awaitingAnswer ? '提交回答' : '已回答'}
                </button>
              </section>
            )}

            {activeTask && workbenchTab === 'conversation' && showPlan && derived.plan && (
              <PlanPreview
                plan={derived.plan}
                permission={activeTask?.permissionPreset ?? permission}
                busy={approving || busy}
                onApprove={approve}
                onReject={reject}
              />
            )}

            {activeTask && workbenchTab === 'conversation' && pendingStep && (
              <section className={`card step-approval risk-${pendingStep.risk}`}>
                <div className="row">
                  <b>
                    需要确认：第 {pendingStep.index}/{pendingStep.total} 步 · {toolLabel(pendingStep.tool)}
                  </b>
                  <span className="muted">
                    {pendingStep.risk === 'danger' ? '高危操作' : pendingStep.risk === 'write' ? '写操作' : '只读'}
                  </span>
                </div>
                <pre className="step-args">{pendingStep.argsPreview}</pre>
                {/* 用户点头的是实际会启动的参数，不是计划里的配置名。
                    老事件没有 effective：照旧只显示原始参数，不假装有。 */}
                {pendingStep.effective && describeEffective(pendingStep.effective).length > 0 && (
                  <div className="step-effective">
                    <b>最终有效参数</b>
                    {describeEffective(pendingStep.effective).map((line, index) => (
                      <p key={index} className="muted">{line}</p>
                    ))}
                  </div>
                )}
                <p className="muted">这一步还没有执行。拒绝会让整份计划停在这里，不会继续后面的步骤。</p>
                <div className="row">
                  <button className="btn" type="button" onClick={() => void decideStep(true)}>
                    执行这一步
                  </button>
                  <button className="btn" type="button" onClick={() => void decideStep(true, true)}>
                    同类不再问
                  </button>
                  <button className="btn" type="button" onClick={() => void decideStep(false)}>
                    拒绝
                  </button>
                </div>
              </section>
            )}

            {activeTask && workbenchTab === 'conversation' && pendingQuestion && (
              <section className="card step-approval">
                <div className="row">
                  <b>模型需要你决定</b>
                  <span className="muted">计划暂停在这一步</span>
                </div>
                <p>{pendingQuestion.question}</p>
                {pendingQuestion.options && pendingQuestion.options.length > 0 && (
                  <div className="row">
                    {pendingQuestion.options.map((option, index) => (
                      <button key={option} className="btn" type="button" onClick={() => void answerQuestion(option)}>
                        {index + 1}. {option}
                      </button>
                    ))}
                  </div>
                )}
                {(!pendingQuestion.options || pendingQuestion.allowFreeText) && (
                  <textarea
                    rows={2}
                    value={questionText}
                    onChange={event => setQuestionText(event.target.value)}
                    placeholder="写出你的决定"
                  />
                )}
                <div className="row">
                  {(!pendingQuestion.options || pendingQuestion.allowFreeText) && (
                    <button
                      className="btn"
                      type="button"
                      disabled={!questionText.trim()}
                      onClick={() => void answerQuestion(questionText.trim())}
                    >
                      提交回答
                    </button>
                  )}
                  <button className="btn ghost" type="button" onClick={() => void answerQuestion('', true)}>
                    放弃回答
                  </button>
                </div>
                <p className="muted">不回答不会让计划自己选默认值；放弃或超时，这一步会记为 answered:false。</p>
              </section>
            )}

            {/* 验证过程已在对话时间线里逐条展示；这里只保留当前状态需要的动作，
                不再把「最近一次验证」复用成一张随时变的卡。 */}
            {activeTask && (workbenchTab === 'conversation' || workbenchTab === 'output')
              && (activeTask.status === 'report_pending' || Boolean(derived.verification && derived.verification.changedFiles > 0)) && (
              <section className="card verify-actions">
                <div className="review-head">
                  <b>{activeTask.status === 'report_pending' ? '验证待你决定' : '验证后续动作'}</b>
                  <span className="muted">每次验证的结论见对话时间线</span>
                </div>
                {activeTask.status === 'report_pending' && (
                  <>
                    <p className="muted">
                      「未通过」是事实，不是失败提示：要么补一次测试或诊断，要么明确接受未验证。
                    </p>
                    <div className="row">
                      <button className="btn" type="button" onClick={() => void resumeRepair()}>
                        继续修复（重新执行验证）
                      </button>
                      <button className="btn ghost" type="button" onClick={() => void recheckVerification()}>
                        按当前口径重新判定
                      </button>
                      <button className="btn ghost" type="button" onClick={() => void acceptUnverified()}>
                        接受未验证并结束
                      </button>
                    </div>
                    <p className="muted">
                      任务停在「等待确认交付」：执行结果都在，但没有通过验证闸门，所以没有自动收尾。
                      「继续修复」会重新规划并真的再跑命令；「重新判定」只重算已落库的报告；
                      「接受未验证」直接收尾并保留缺口。完全权限下的新任务会自动走修复，不会停在这里。
                    </p>
                  </>
                )}
                {derived.verification && derived.verification.changedFiles > 0 && (
                  <button className="btn ghost" type="button" onClick={() => void revertSnapshot(activeTask.taskId)}>
                    还原本轮
                  </button>
                )}
              </section>
            )}

            {derived.changes.length > 0 && workbenchTab === 'output' && (
              <section className="card review-card">
                <div className="review-head">
                  <b>本轮改动 · {derived.changes.length} 个文件</b>
                  <span className="muted">before / after 原文，未经改写</span>
                </div>
                {derived.changes.map(item => (
                  <details key={item.path} className="synthesis-block">
                    <summary>{item.path}</summary>
                    {item.patch ? (
                      <pre className="md-code">{item.patch}</pre>
                    ) : item.before !== undefined && item.after !== undefined ? (
                      <>
                        <p className="muted">改之前</p>
                        <pre className="md-code">{item.before}</pre>
                        <p className="muted">改之后</p>
                        <pre className="md-code">{item.after}</pre>
                      </>
                    ) : (
                      // fs.writeFile 只回路径和字节，没有 before/after 原文：照实写，
                      // 不能因为拿不到 diff 就把这次真实改动整个丢掉。
                      <p className="muted">
                        {item.created ? '新建' : item.replaced ? '覆盖' : '改动'} · {typeof item.bytes === 'number' ? `${String(item.bytes)} 字节` : '大小未记录'}
                      </p>
                    )}
                  </details>
                ))}
              </section>
            )}

            {activeTask && (workbenchTab === 'conversation' || workbenchTab === 'output') && (derived.verification || derived.review || derived.changes.length > 0 || derived.artifacts.length > 0) && (
              <section className="card delivery">
                <div className="card-head">
                  <h2>最终交付</h2>
                  <span className={`pill s-${activeTask.status}`}>{statusLabel(activeTask.status)}</span>
                </div>
                <p className="muted">只汇总真实执行报告与评审，不把模型回答直接当完成。</p>
                {derived.changes.length > 0 && (
                  <>
                    <h5>改动文件（{derived.changes.length}）</h5>
                    <ul>
                      {derived.changes.slice(0, 40).map(change => (
                        <li key={change.path}>
                          <code>{change.path}</code>
                          {change.created ? ' · 新建' : change.replaced ? ' · 覆盖' : ''}
                          {typeof change.bytes === 'number' ? ` · ${String(change.bytes)} 字节` : ''}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {derived.artifacts.length > 0 && (
                  <>
                    <h5>工程产物（{derived.artifacts.length}）</h5>
                    <ul>
                      {derived.artifacts.slice(0, 40).map(artifact => (
                        <li key={artifact.path}>
                          <code>{artifact.path}</code>
                          <span className="muted"> · {artifact.source}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {derived.verification && (() => {
                  /**
                   * 「一项都没跑」不能写成「未通过」。
                   *
                   * 只新建了一个文件、计划里没有任何检查时，各项全是 skipped，而
                   * `verified` 按规则是 false；交付卡直接写「验证：未通过」，读起来
                   * 像产物不合格。用户看到的第一句必须是事实：没验证，还是验证没过。
                   *
                   * 运行单独列一行：`javac X && java X` 跑通了、屏幕上是 hello
                   * everybody，这是这个任务最直接的验收，不能只写「测试 未执行」。
                   */
                  const checks = derived.verification!.checks;
                  const label = (value: 'passed' | 'failed' | 'skipped') =>
                    value === 'passed' ? '通过' : value === 'failed' ? '未通过' : '未执行';
                  const rows = [
                    { key: '编译', status: checks?.compile.status ?? 'skipped', output: undefined },
                    { key: '运行', status: checks?.run?.status ?? 'skipped', output: checks?.run?.output },
                    { key: '测试', status: checks?.tests.status ?? 'skipped', output: undefined },
                    { key: '诊断', status: checks?.diagnostics.status ?? 'skipped', output: undefined }
                  ];
                  const ran = rows.some(row => row.status !== 'skipped');
                  return (
                    <p>
                      <b>最近一次验证：</b>{derived.verification!.verified ? '通过' : ran ? '未通过' : '未执行'}
                      {rows.map(row => ` · ${row.key} ${label(row.status)}${row.output ? `（${row.output}）` : ''}`).join('')}
                    </p>
                  );
                })()}
                {derived.review && (
                  <p>
                    <b>最近一次独立评审：</b>{derived.review.needsFix ? '需修复' : '通过'}
                    {derived.review.issues.length > 0
                      ? ` · ${String(derived.review.issues.length)} 处问题（见时间线中的评审记录）`
                      : ''}
                  </p>
                )}
              </section>
            )}

            {activeTask && workbenchTab === 'output' && derived.modelTrace.some(item => item.reasoning.trim()) && (
              <details className="card reasoning-history">
                <summary>模型思考记录（{derived.modelTrace.filter(item => item.reasoning.trim()).length} 轮）</summary>
                {derived.modelTrace.filter(item => item.reasoning.trim()).map(item => (
                  <section key={item.roundId}>
                    <h5>{item.roundId.slice(0, 8)}</h5>
                    <pre>{item.reasoning}</pre>
                  </section>
                ))}
              </details>
            )}

            {activeTask && workbenchTab === 'output' && planThinking(derived.answer) && (
              <details className="card thinking">
                <summary>思考过程</summary>
                <p>{planThinking(derived.answer)}</p>
              </details>
            )}

            {activeTask && workbenchTab === 'conversation' && derived.members.length === 0 && busy && !showPlan && (
              <section className="card running">
                <span className="spinner" />
                <div>
                  <b>{statusLabel(activeTask?.status ?? 'planning')}</b>
                  <p className="muted">正在规划/执行；无需手动复制粘贴，等待本轮结束即可。</p>
                </div>
              </section>
            )}

            {/* The opposite of the spinner: nothing is happening, and nothing
                will until someone types. Saying so is the whole point. */}
            {activeTask && workbenchTab === 'conversation' && awaitingAnswer && (
              <section className="card waiting">
                <b>等待你回答上面的问题</b>
                <p className="muted">回答之后才会开始下一轮规划；在这之前不会执行任何本地操作。</p>
              </section>
            )}

            {activeTask && workbenchTab === 'output' && derived.answer && !/"type"\s*:\s*"plan"/.test(derived.answer) && (
              <details className="card answer">
                <summary>最近一轮模型回答（{derived.answer.length} 字符）</summary>
                <pre>{derived.answer}</pre>
              </details>
            )}

            {/* 主界面不展开协议 JSON；完整原文统一收在这里，按轮次可查。 */}
            {activeTask && workbenchTab === 'output' && (
              <ProtocolArchive task={activeTask} events={events} />
            )}

            {error && <div className="error">{error}</div>}

            {notice && <div className="notice">{notice}</div>}

            {activeTask && workbenchTab === 'output' && <TaskWorktree taskId={activeTask.taskId} refreshKey={events.length} />}
            {activeTask && workbenchTab === 'output' && events.length > 0 && <ExecutionLog events={events} />}

            {/* 只对任务里真实开过的 term.* 会话出现；headless CLI 没有 PTY，
                它的输出在上一块执行日志里，不会被伪装成终端。 */}
            {/* xterm 只在真的有 PTY 会话时才加载；首屏不解析终端实现。 */}
            {activeTask && workbenchTab === 'output' && terminalSessionsFrom(events).length > 0 && (
              <React.Suspense fallback={null}>
                <AgentTerminal events={events} />
              </React.Suspense>
            )}

            {activeTask && workbenchTab === 'trajectory' && (
              <TaskTrajectory
                activity={activity}
                onLocate={eventId => {
                  // 「定位」把输出页打开并选中同一条事件：两页读的是同一份投影，
                  // 所以这里只是切页 + 设选中，不需要再查一次数据。
                  setSelectedActivityId(eventId);
                  setWorkbenchTab('output');
                }}
              />
            )}

            {activeTask && workbenchTab === 'stats' && (
              <TaskStats
                task={activeTask}
                members={derived.members}
                activity={activity}
                verification={derived.verification}
              />
            )}
          </div>
        </div>

        {/* Docked, not scrolled: the prompt box is the one control always worth
            reaching, and a composer that scrolls away is the difference between
            this and the page it talks to. Everything above it scrolls; this
            does not. */}
        <div className="dock">
          <div className="inner">
            <TaskInput
              value={prompt}
              permission={permission}
              workspaceMode={workspaceMode}
              routing={routingPreview ? {
                label: routingLabel(routingPreview),
                reason: routingPreview.reason,
                source: routingPreview.source
              } : null}
              // 模型主导时，这一份只是规则预估：真正判定在发送时由模型给出。
              routingByModel={workspaceMode === 'engineering' && executionConfig.executionMode !== 'web'}
              taskKindOverride={taskKindOverride}
              onTaskKindChange={setTaskKindOverride}
              // 研究设置的入口在输入框里（第三个胶囊），这里只把「下一条用什么」传下去。
              researchLabel={({ web: '网页主导', local: '本地主导', cloud: '云端主导', hybrid: '混合主导' } as const)[executionConfig.executionMode]}
              researchDetail={executionConfig.strategy ?? '默认并行'}
              // 这一问由哪些云端模型做推导：清单来自主进程，勾选写回会话配置，
              // 和研究设置里的「参与成员」是同一份值。
              models={{
                cloud: executionOptions?.cloudMembers ?? [],
                selected: executionConfig.selectedCloudModels,
                onChange: next => changeExecutionConfig({ selectedCloudModels: next })
              }}
              // CLI 来源跟在模型清单下面选：同一份三态语义（undefined = 开着的
              // 全部），写回会话配置，主进程选人按它筛第一轮的 CLI 成员。
              // 注意 id 形态：注册表 id 是 qoder，回答成员 id 是 cli:qoder——
              // 选人名单（selectedCliAgents）按后者对齐，差一个前缀就全部落空。
              cliSources={{
                all: cliAll.map(item => ({
                  id: `cli:${item.id}`,
                  label: item.label,
                  enabled: item.enabled,
                  available: item.available,
                  reason: item.reason
                })),
                selected: executionConfig.selectedCliAgents,
                onChange: next => changeExecutionConfig({ selectedCliAgents: next })
              }}
              // 写着「追问《…》」的时候，这一句会进那条会话；点「新对话」就换一条。
              followupTitle={showingConversation && activeConversation ? activeConversation.title : null}
              inputRef={composerRef}
              onNewConversation={startNewConversation}
              attachments={attachments}
              onRemoveAttachment={removeAttachment}
              plus={{
                workspaceMode,
                executionMode: executionConfig.executionMode,
                expertise,
                // 「引用对话中的文件」只认真实带过的那几张：没有会话就没有可引用的。
                conversationFiles: activeConversation?.attachments ?? [],
                sources: sources.sources
                  .filter(source => source.enabled)
                  .map(source => ({
                    id: source.id,
                    label: source.label,
                    available: channelStatuses.find(channel => channel.id === source.id)?.available ?? false,
                    active: source.id === sources.activeId
                  })),
                onAddFiles: () => void addAttachments(),
                onReferenceFile: referenceAttachment,
                onWorkspaceMode: changeWorkspaceMode,
                onExecutionMode: changeExecutionMode,
                onToggleExpertise: (id, enabled) => void toggleExpertise(id, enabled),
                onSelectSource: id => void selectSource(id),
                onOpenPlugins: () => {
                  setSettingsSection('plugins');
                  setSettingsOpen(true);
                }
              }}
              // Disabled while a channel is answering and while the task waits
              // for an answer: in both cases a second prompt would race the
              // first against the same page and lose the question on screen.
              disabled={submitting || busy || awaitingAnswer || conversationBusy}
              busy={submitting || conversationBusy}
              onChange={value => {
                setPrompt(value);
                if (notice) setNotice('');
              }}
              onPermissionChange={changePermission}
              onOpenResearch={() => {
                setResearchTab('mode');
                setResearchOpen(true);
              }}
              onStartDebate={() => { void startDirectDebate(); }}
              onSubmit={submit}
            />
          </div>
        </div>
      </main>

      {/* The native page view is not part of this document, so the boundary
          needs to be drawn here or the two panes look like one broken one.
          It is also the only place the drag can start, and the ghost is what
          stands in for the page while the real view is parked offscreen.

          Folded, none of it exists: `split` is then the stub width, and drawing
          a bar over that 30px strip would put two buttons where there is no
          page. */}
      {split > 0 && !isCollapsed && (
        <>
          {/* The strip above the page. It has to be DOM: the page is a native
              view painted over this document, so anything drawn on top of it is
              invisible. The main process pushes the view down by exactly this
              height, and the two numbers come from the same constant. */}
          <div
            className="page-bar"
            style={{ right: RAIL_WIDTH, width: Math.max(0, split - PAGE_GUTTER - RAIL_WIDTH), height: PAGE_HEADER_HEIGHT }}
          >
            {/* The bar reads left to right: which page, how it is doing, what
                you can do to it. 诊断 belongs to the last group — it is an
                action on this page, not a label for it. It used to sit at the
                far left as a bordered text button, which put a box in front of
                the channel name and made the identity look like it started
                after the button.

                放大 stays right-most: it is the one action that moves the page
                somewhere else, and the edge is where people reach for that. */}
            <span
              className={`page-dot${activeChannel?.available ? ' ok' : sources.loading ? ' pending' : ' warn'}`}
              aria-hidden="true"
            />
            <span className="page-name">{terminalPaneOpen ? '终端' : (activeSource?.label ?? '内嵌页面')}</span>
            <span className="page-status" title={activeChannel?.detail ?? ''}>
              {terminalPaneOpen ? '右侧终端面板' : pageStatusText}
            </span>
            <span className="page-actions">
              {!terminalPaneOpen && (
                <>
                  <button
                    className={`page-btn icon${savingPage === 'md' ? ' spinning' : ''}`}
                    type="button"
                    onClick={() => void openPageSave('md')}
                    disabled={savingPage !== null}
                    data-action="save-document"
                    aria-label="保存文档"
                    title="保存文档：提取这一页里的文档和计划，默认存成 Markdown"
                  >
                    <IconSave />
                  </button>
                  <button
                    className={`page-btn icon${savingPage === 'docx' ? ' spinning' : ''}`}
                    type="button"
                    onClick={() => void openPageSave('docx')}
                    disabled={savingPage !== null}
                    data-action="save-document-word"
                    aria-label="保存为 Word"
                    title="单独指定才生成 Word 文档（版式沿用导出模板）"
                  >
                    <IconSaveWord />
                  </button>
                  <button
                    className={`page-btn icon${refreshing ? ' spinning' : ''}`}
                    type="button"
                    onClick={() => void refreshPage()}
                    disabled={refreshing}
                    data-action="reload"
                    aria-label="刷新"
                    title="刷新：重新加载这一页。当前会话不变，登录状态也不会丢"
                  >
                    <IconRefresh />
                  </button>
                  <button
                    className="page-btn icon"
                    type="button"
                    onClick={() => void openDiagnostics()}
                    data-action="diagnose"
                    aria-label="诊断"
                    title="诊断：看这一页真实找到了什么；更新样式也在里面"
                  >
                    <IconGauge />
                  </button>
                  <button
                    className="page-btn icon"
                    type="button"
                    onClick={toggleDetach}
                    disabled={sources.loading && !isDetached}
                    data-action="detach"
                    aria-label={isDetached ? '吸附回来' : '放大'}
                    title={isDetached ? '吸附回来：把页面放回窗口' : '放大：把页面移到独立窗口'}
                  >
                    {isDetached ? <IconDockBack /> : <IconExpand />}
                  </button>
                </>
              )}
              <button
                className={`page-btn icon${terminalPaneOpen ? ' is-active' : ''}`}
                type="button"
                onClick={toggleTerminal}
                data-action="terminal"
                aria-label="终端"
                title={terminalPaneOpen ? '收起终端面板' : '打开终端面板'}
              >
                <IconTerminal />
              </button>
            </span>
          </div>
          {terminalPaneOpen && (
            <div
              className="terminal-pane"
              style={{
                right: RAIL_WIDTH,
                width: Math.max(0, split - PAGE_GUTTER - RAIL_WIDTH),
                top: PAGE_HEADER_HEIGHT
              }}
            >
              {terminalPaneSession && openTerminalWindows.includes(terminalPaneSession) ? (
                <div className="page-detached-card">
                  <p className="page-detached-title">这个终端在独立窗口里</p>
                  <p className="page-detached-hint">关掉那个窗口，或者点下面把它放回右侧面板。</p>
                  <button
                    className="btn"
                    type="button"
                    onClick={() =>
                      void window.agentAPI.closeTerminalWindow(terminalPaneSession).catch(() => undefined)
                    }
                  >
                    吸附回来
                  </button>
                </div>
              ) : (
                <React.Suspense fallback={null}>
                  <TerminalPanel
                    sessions={terminalPanelSessions}
                    bridge={window.agentAPI}
                    initialSessionId={terminalPaneSession}
                    single
                    onClosePane={closeTerminalPane}
                    onDetach={sessionId => {
                      void window.agentAPI
                        .detachTerminal(sessionId)
                        .catch(cause => setError(errorText(cause)));
                    }}
                    onSessionsChanged={() => {
                      // 结束会话后两份状态都要立刻刷新：只刷 terminals 的话，
                      // 侧栏还会拿着旧 sessionId，下一次点击会 attach 到死会话。
                      void window.agentAPI
                        .listTerminals()
                        .then(setTerminalSessions)
                        .catch(() => undefined);
                      void window.agentAPI
                        .listCliTerminals()
                        .then(setCliTerminals)
                        .catch(() => undefined);
                    }}
                  />
                </React.Suspense>
              )}
            </div>
          )}
          <div
            className={`page-divider${draggingPage ? ' dragging' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整内嵌页面宽度"
            title="拖动调整页面宽度，双击恢复默认"
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={resetSplit}
          />
          {draggingPage && (
            <div className="page-ghost" style={{ width: Math.max(0, split - PAGE_GUTTER - RAIL_WIDTH) }}>
              <span>松开以应用 · {Math.round(split)} px</span>
            </div>
          )}
          {/* A detached page leaves the pane empty, and an empty pane is
              indistinguishable from a broken one. This says which it is, and
              carries the way back for anyone who closed the other window's bar. */}
          {isDetached && !draggingPage && (
            <div
              className="page-detached"
              style={{ right: RAIL_WIDTH, width: Math.max(0, split - PAGE_GUTTER - RAIL_WIDTH), top: PAGE_HEADER_HEIGHT }}
            >
              <div className="page-detached-card">
                <p className="page-detached-title">{activeSource?.label ?? '这个页面'}在独立窗口里</p>
                <p className="page-detached-hint">页面还在运行，同一个登录、同一段回答。关掉那个窗口就会回到这里。</p>
                <button className="btn" type="button" onClick={toggleDetach}>
                  吸附回来
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* 折叠时不再画旁边那条竖排站名框（「Gemini」单独一列）。
          展开仍靠轨道顶上的开关；来源按钮照常保留。 */}

      {/* Only the enabled ones. A disabled source still exists — its address is
          kept — but a rail button for a page that is switched off would be a
          button that does nothing. */}
      <SourceRail
        sources={sources.sources.filter(source => source.enabled)}
        activeId={sources.activeId}
        planningId={sources.planningId}
        loading={sources.loading}
        collapsed={isCollapsed}
        onSelect={selectSource}
        onToggleCollapse={toggleCollapse}
        cliAgents={cliAgents.map(agent => {
          const state = cliTerminals.find(item => item.id === agent.id);
          return {
            id: agent.id,
            label: agent.label,
            glyph: agent.glyph ?? agent.label.slice(0, 1),
            running: Boolean(state?.running),
            viewing: Boolean(state && state.sessionId === terminalPaneSession),
            available: agent.available
          };
        })}
        onSelectCli={id => void selectCliAgent(id)}
        terminals={terminalSessions
          .filter(session => !cliTerminalSessionIds.has(session.sessionId))
          .map(session => ({
            sessionId: session.sessionId,
            label: terminalLabelOf(session),
            exited: session.exited
          }))}
        viewingTerminalId={terminalPaneSession}
        onSelectTerminal={openTerminalPane}
      />

      {researchOpen && (
        <ResearchPanel
          config={executionConfig}
          onConfigChange={changeExecutionConfig}
          latestSynthesis={messages.find(item => item.role === 'synthesis' && item.synthesis)?.synthesis ?? null}
          initialTab={researchTab}
          activeConversationId={activeConversation?.conversationId ?? null}
          workspaceMode={workspaceMode}
          workspaceId={activeWorkspaceId}
          workspaceRoot={workspace}
          onDebateStarted={info => { void showDebateAnswer(info); }}
          onClose={() => setResearchOpen(false)}
        />
      )}

      {pageSave && (
        <PageSaveDialog
          preview={pageSave.preview}
          format={pageSave.format}
          busy={savingPage !== null}
          onClose={closePageSave}
          onSave={input => void runPageSave(input)}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          sources={sources}
          channelStatuses={channelStatuses}
          identity={identity}
          permission={permission}
          initialSection={settingsSection}
          onClose={() => setSettingsOpen(false)}
          onSaveSource={saveSource}
          onAddSource={addSource}
          onRemoveSource={removeSource}
          onSetSourcesOpenOnLaunch={setSourcesOpenOnLaunch}
          onRename={renameIdentity}
          onPermissionChange={changePermission}
        />
      )}

      {diagOpen && (
        <DiagnosticsPanel
          report={diagReport}
          loading={diagLoading}
          repairing={learning}
          channelId={diagChannelId}
          channels={sources.sources
            .filter(source => source.enabled)
            .map(source => ({
              id: source.id,
              label: source.label,
              available: channelStatuses.find(channel => channel.id === source.id)?.available ?? false
            }))}
          repair={repairReport}
          onSelectChannel={selectDiagChannel}
          onClose={() => setDiagOpen(false)}
          onRefresh={() => void refreshDiagnostics()}
          onRepair={() => void refreshSelectors()}
        />
      )}
    </div>
  );
}

function statusLabel(status: AgentTask['status']): string {
  const map: Record<AgentTask['status'], string> = {
    created: '已创建',
    planning: '正在规划',
    awaiting_clarification: '等待你回答',
    plan_ready: '计划就绪',
    awaiting_approval: '等待你确认',
    executing: '正在执行',
    verifying: '正在校验结果',
    report_pending: '已完成待确认',
    awaiting_next_round: '等待下一轮',
    completed: '已完成',
    failed: '已失败',
    cancelled: '已取消'
  };
  return map[status];
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The message without Electron's envelope.
 *
 * A rejected IPC handler arrives as "Error invoking remote method 'sources:save':
 * Error: 只支持 https:// 开头的网址". The sentence after the colon is the whole
 * useful part; the rest is plumbing the user never asked about.
 */
function ipcErrorText(error: unknown) {
  return errorText(error).replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}
