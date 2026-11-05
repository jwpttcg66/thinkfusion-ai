import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentEvent,
  AgentTask,
  DeepSeekDiagnostics,
  DeepSeekStatus,
  Identity,
  PageState,
  PermissionPreset,
  PlanPreview as PlanPreviewType,
  SourcesState
} from '../../shared/contracts';
import { TaskSidebar } from './components/TaskSidebar';
import { TaskInput } from './components/TaskInput';
import { SourceRail } from './components/SourceRail';
import { ConversationView } from './components/ConversationView';
import { PlanPreview } from './components/PlanPreview';
import { ExecutionLog } from './components/ExecutionLog';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { ResearchPanel } from './components/ResearchPanel';
import { Glyph } from './components/Glyph';
import type { StyleReportData } from './components/StyleReport';
import { computeSplit, PAGE_GUTTER, PAGE_HEADER_HEIGHT, PAGE_STUB_WIDTH, RAIL_WIDTH } from '../../shared/layout';
import { ICON_DOCK_BACK_PATHS, ICON_EXPAND_PATHS, ICON_GAUGE_PATHS, ICON_REFRESH_PATHS } from '../../shared/icons';
import type { ChannelStatus, Conversation, ConversationExecutionConfig, ConversationMessage } from '../../shared/conversation';
import { DEFAULT_EXECUTION_CONFIG, normalizeExecutionConfig } from '../../shared/conversation';
import { classifyIntent } from '../../shared/intent';

const ACTIVE_STATUSES: AgentTask['status'][] = ['planning', 'executing', 'verifying', 'report_pending'];
interface Derived {
  plan: PlanPreviewType | null;
  questions: string[];
  answer: string;
}

/**
 * The page-pane actions, as icons.
 *
 * Text was wrong here for a structural reason: this bar lives inside the page
 * pane, and the pane can be dragged down to 380px. Two four-character labels ate
 * most of that width and pushed the status out of sight — the one thing the bar
 * exists to show. An icon is a fixed 24px whatever the language.
 *
 * The drawing itself is `components/Glyph`, shared with the sidebar and the
 * settings panel; the paths come from `shared/icons.ts` so the detached
 * window's toolbar can draw byte-identical glyphs.
 */
/** 放大：把这个页面交给一整扇窗。 */
const IconExpand = () => <Glyph paths={ICON_EXPAND_PATHS} />;
/** 吸附回来：放回它原来的位置。 */
const IconDockBack = () => <Glyph paths={ICON_DOCK_BACK_PATHS} />;
/** 刷新：把这一页重新加载一次，会话还留在原地。 */
const IconRefresh = () => <Glyph paths={ICON_REFRESH_PATHS} />;
/** 诊断：这一页到底找到了什么。 */
const IconGauge = () => <Glyph paths={ICON_GAUGE_PATHS} />;
function derive(events: AgentEvent[]): Derived {
  let plan: PlanPreviewType | null = null;
  let questions: string[] = [];
  let answer = '';

  for (const event of events) {
    // A new round supersedes whatever the previous one asked. Without this a
    // replayed task keeps showing a question that has already been answered —
    // the card stays on screen with a disabled box, which reads as stuck.
    if (event.type === 'round.started') questions = [];
    if (event.type === 'plan.ready') plan = event.plan;
    if (event.type === 'clarification.required') questions = event.questions;
    if (event.type === 'round.answer') answer = event.text;
    if (event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.cancelled') {
      questions = [];
    }
  }
  return { plan, questions, answer };
}

function upsert(list: AgentTask[], task: AgentTask): AgentTask[] {
  const next = list.filter(item => item.taskId !== task.taskId);
  return [task, ...next].sort((a, b) => b.updatedAt - a.updatedAt);
}

function baseName(path?: string): string {
  if (!path) return '未指定工作区';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export default function App() {
  const [platform, setPlatform] = useState('');
  const [permission, setPermission] = useState<PermissionPreset>('workspace-write');
  const [workspace, setWorkspace] = useState('');
  const [prompt, setPrompt] = useState('');
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [derived, setDerived] = useState<Derived>({ plan: null, questions: [], answer: '' });
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
  const [sources, setSources] = useState<SourcesState>({ sources: [], activeId: '', planningId: null, loading: false });
  const [page, setPage] = useState<PageState>({ detachedId: null, collapsed: false });
  /** True while 「更新样式」 is running its three passes over the page. */
  const [learning, setLearning] = useState(false);
  /** True from the press of 「刷新」 until the reload settles or its budget ends. */
  const [refreshing, setRefreshing] = useState(false);
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
  /** The local user name for the row at the bottom of the sidebar. */
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [executionConfig, setExecutionConfig] = useState<ConversationExecutionConfig>(DEFAULT_EXECUTION_CONFIG);

  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;
  /**
   * The visible conversation, readable from an event listener that was
   * registered once. Messages arrive for *every* conversation, so without this
   * a background conversation's replies get appended to the pane on screen —
   * which reads as one conversation containing two unrelated threads.
   */
  const activeConversationRef = useRef<string | null>(null);
  activeConversationRef.current = activeConversationId;
  /**
   * Conversations that have been deleted.
   *
   * A delete races the conversation's own event stream: the runner keeps
   * emitting `conversation.updated` while it settles, and any of those arriving
   * after the delete put the row straight back into the list. Ids are UUIDs, so
   * remembering them is exact — no guessing at titles.
   */
  const deletedConversations = useRef<Set<string>>(new Set());
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
  /**
   * A conversation whose intent turned out to be `workspace` hands off to a
   * task. From then on the task view owns the screen — showing a conversation
   * pane with one system line next to a plan would be two half-answers.
   */
  const showingConversation = activeConversation !== null && !activeConversation.taskId;
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

      setEvents(prev => [...prev, event]);
      setDerived(prev => {
        if (event.type === 'round.started') return { ...prev, questions: [] };
        if (event.type === 'plan.ready') return { ...prev, plan: event.plan };
        if (event.type === 'clarification.required') return { ...prev, questions: event.questions };
        if (event.type === 'round.answer') return { ...prev, answer: event.text };
        if (event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.cancelled') {
          return { ...prev, questions: [] };
        }
        return prev;
      });
      if (event.type === 'task.failed') setError(event.error);
    });

    const stopDeepSeek = window.agentAPI.onDeepSeekEvent(event => {
      if (event.type === 'status') setStatus(event.status);
    });

    window.agentAPI.getConversations().then(setConversations).catch(() => undefined);
    window.agentAPI.getChannelStatuses().then(setChannelStatuses).catch(() => undefined);

    const stopConversation = window.agentAPI.onConversationEvent(event => {
      if (event.type === 'conversation.created' || event.type === 'conversation.updated') {
        if (deletedConversations.current.has(event.conversation.conversationId)) return;
        setConversations(prev => [event.conversation, ...prev.filter(item => item.conversationId !== event.conversation.conversationId)]);
        return;
      }
      if (event.type === 'conversation.deleted') {
        deletedConversations.current.add(event.conversationId);
        setConversations(prev => prev.filter(item => item.conversationId !== event.conversationId));
        if (activeConversationRef.current === event.conversationId) {
          setActiveConversationId(null);
          setMessages([]);
          setPhases({});
        }
        return;
      }
      if (event.type === 'message.added') {
        // Only the conversation on screen. A message for any other one belongs
        // to its own pane, and appending it here mixed two threads together.
        if (event.message.conversationId !== activeConversationRef.current) return;
        // Messages are appended live, so the pane fills in as channels answer
        // instead of appearing all at once when the slowest page finishes.
        setMessages(prev =>
          prev.some(item => item.messageId === event.message.messageId) ? prev : [...prev, event.message]
        );
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
      setEvents(history);
      setDerived(derive(history));
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function chooseWorkspace() {
    try {
      const dir = await window.agentAPI.chooseDirectory();
      if (dir) {
        setWorkspace(dir);
        setNotice('');
      }
    } catch (e) {
      setError(errorText(e));
    }
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

    // An open conversation that already answered takes the message as a
    // follow-up. The page keeps its own context, so the question goes out as
    // written — no re-statement of the framing.
    if (activeConversation && !activeConversation.taskId && !conversationBusy) {
      setSubmitting(true);
      setError('');
      setNotice('');
      try {
        const updated = await window.agentAPI.followupConversation({
          conversationId: activeConversation.conversationId,
          text
        });
        setConversations(prev => [updated, ...prev.filter(item => item.conversationId !== updated.conversationId)]);
        setPrompt('');
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
    if (intent.kind === 'workspace' && !root) {
      try {
        const dir = await window.agentAPI.chooseDirectory();
        if (!dir) {
          setNotice('这是一次工作区操作，但还没有选择目录，任务没有提交。');
          return;
        }
        root = dir;
        setWorkspace(dir);
      } catch (e) {
        setError(errorText(e));
        return;
      }
    }

    setNotice('');
    setSubmitting(true);
    setError('');
    try {
      const conversation = await window.agentAPI.submitConversation({
        text,
        workspaceRoot: root || undefined,
        permissionPreset: permission,
        executionConfig
      });
      setConversations(prev => [
        conversation,
        ...prev.filter(item => item.conversationId !== conversation.conversationId)
      ]);
      setActiveConversationId(conversation.conversationId);
      setMessages([]);
      setPhases({});
      setPrompt('');
      setActiveId(conversation.taskId ?? null);
      if (conversation.taskId) await selectTask(conversation.taskId);
    } catch (e) {
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
    try {
      const [list, conversation] = await Promise.all([
        window.agentAPI.getConversationMessages(conversationId),
        window.agentAPI.getConversation(conversationId)
      ]);
      setMessages(list);
      if (conversation?.taskId) {
        setActiveId(conversation.taskId);
        await selectTask(conversation.taskId);
      }
    } catch (e) {
      setError(errorText(e));
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
        setDerived({ plan: null, questions: [], answer: '' });
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
  async function toggleCollapse() {
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

  const showPlan = derived.plan !== null && activeTask?.status === 'awaiting_approval';

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
        tasks={tasks}
        activeId={activeId}
        onSelect={selectTask}
        onDelete={deleteTask}
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelectConversation={selectConversation}
        onDeleteConversation={deleteConversation}
        identity={identity}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenDiagnostics={() => {
          setDiagOpen(true);
          void refreshDiagnostics();
        }}
        onNew={() => {
          setActiveId(null);
          setActiveConversationId(null);
          setMessages([]);
          setPhases({});
          setEvents([]);
          setDerived({ plan: null, questions: [], answer: '' });
          setError('');
          setNotice('');
          setPrompt('');
          setClarifyText('');
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
            <b>{activeTask ? baseName(activeTask.workspaceRoot) : baseName(workspace)}</b>
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
            {/* One pill per state used to be enough when there was one page.
                With several, the useful summary is "how many can answer right
                now", and the tooltip carries which one cannot and why. */}
            {(() => {
              const ready = channelStatuses.filter(channel => channel.available).length;
              const blocked = channelStatuses.filter(channel => !channel.available);
              const detail = blocked.map(channel => `${channel.label}: ${channel.detail ?? '不可用'}`).join('；');
              return (
                <span className={`pill ${ready > 0 ? 'ok' : 'warn'}`} title={detail || status?.detail || undefined}>
                  {channelStatuses.length === 0 ? '连接中…' : `${ready}/${channelStatuses.length} 页面就绪`}
                </span>
              );
            })()}
            {(() => {
              // Two different sentences share this slot. A blocked channel is a
              // failure and says why; a signed-out-but-working one is a hint.
              //
              // The text is short and names its channel on purpose. It used to be
              // the raw detail — 「未登录：仍可使用，登录后可保存记录并解锁更高模型」 —
              // which is 24 characters in a slot that fits about sixteen, so it
              // was cut mid-sentence, and next to a green 「3/3 页面就绪」 it read
              // as "not connected" no matter what it said. The full sentence is
              // still there, as the tooltip.
              const blocked = channelStatuses.find(channel => !channel.available && channel.detail);
              const hint = blocked ?? channelStatuses.find(channel => channel.available && !channel.loggedIn && channel.detail);
              if (!hint?.detail) return null;
              return (
                <span
                  className="status-detail"
                  title={
                    blocked
                      ? channelStatuses.map(channel => channel.detail).filter(Boolean).join('；')
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
                not being shown. */}
            {isCollapsed && (
              <button className="btn ghost" type="button" onClick={() => void openDiagnostics()}>
                诊断
              </button>
            )}
            {(busy || awaitingAnswer || conversationBusy) && (
              <button className="btn ghost" type="button" onClick={cancel}>
                {conversationBusy ? '停止等待' : '取消任务'}
              </button>
            )}
          </div>
        </header>

        <div className={`scroll${activeTask || showingConversation ? '' : ' is-empty'}`}>
          <div className="inner">
            {showingConversation && activeConversation && (
              <ConversationView
                conversation={activeConversation}
                messages={messages}
                channelStatuses={channelStatuses}
                phases={phases}
                busy={conversationBusy}
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

            {activeTask && (
              <div className="status-row">
                <span className={`pill s-${activeTask.status}`}>{statusLabel(activeTask.status)}</span>
                <span className="muted">{platform === 'darwin' ? 'macOS' : platform || 'macOS'}</span>
                {activeTask.workspaceRoot && <span className="muted">· {activeTask.workspaceRoot}</span>}
              </div>
            )}

            {(derived.questions.length > 0 || awaitingAnswer) && (
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

            {showPlan && derived.plan && (
              <PlanPreview
                plan={derived.plan}
                permission={activeTask?.permissionPreset ?? permission}
                busy={approving || busy}
                onApprove={approve}
                onReject={reject}
              />
            )}

            {busy && !showPlan && (
              <section className="card running">
                <span className="spinner" />
                <div>
                  <b>{statusLabel(activeTask?.status ?? 'planning')}</b>
                  <p className="muted">正在与 DeepSeek 同步；无需手动复制粘贴，等待本轮结束即可。</p>
                </div>
              </section>
            )}

            {/* The opposite of the spinner: nothing is happening, and nothing
                will until someone types. Saying so is the whole point. */}
            {awaitingAnswer && (
              <section className="card waiting">
                <b>等待你回答上面的问题</b>
                <p className="muted">回答之后才会开始下一轮规划；在这之前不会执行任何本地操作。</p>
              </section>
            )}

            {derived.answer && (
              <details className="card answer">
                <summary>最近一轮 DeepSeek 回答（{derived.answer.length} 字符）</summary>
                <pre>{derived.answer}</pre>
              </details>
            )}

            {error && <div className="error">{error}</div>}

            {notice && <div className="notice">{notice}</div>}

            {events.length > 0 && <ExecutionLog events={events} />}
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
              workspace={workspace}
              permission={permission}
              // 研究设置的入口在输入框里（第三个胶囊），这里只把「下一条用什么」传下去。
              researchLabel={({ web: '网页主导', local: '本地主导', cloud: '云端主导', hybrid: '混合主导' } as const)[executionConfig.executionMode]}
              researchDetail={executionConfig.strategy ?? '默认并行'}
              inputRef={composerRef}
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
              onChooseWorkspace={chooseWorkspace}
              onOpenResearch={() => setResearchOpen(true)}
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
            <span className="page-name">{activeSource?.label ?? '内嵌页面'}</span>
            <span className="page-status" title={activeChannel?.detail ?? ''}>{pageStatusText}</span>
            <span className="page-actions">
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
            </span>
          </div>
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

      {/* Folded. Not `display: none`: a pane that vanishes leaves nothing to
          click and no sign that the page is still there — and it is, with the
          same login and the same half-written answer. The whole strip is the
          button, because a 24px glyph inside a 30px column was a small target
          for the action that undoes the one you just took; the rail's toggle at
          the top of the next column does the same thing from a fixed place. */}
      {isCollapsed && (
        <button
          className="page-stub"
          type="button"
          onClick={toggleCollapse}
          data-action="expand"
          aria-label="展开网页"
          title="展开：把网页放回来"
          style={{ right: RAIL_WIDTH, width: PAGE_STUB_WIDTH }}
        >
          {/* Turned on its side: a 30px column can still say which page it is
              hiding, and the name is the thing worth keeping. */}
          <span className="page-stub-label">{activeSource?.label ?? '内嵌页面'}</span>
          <span
            className={`page-dot${activeChannel?.available ? ' ok' : sources.loading ? ' pending' : ' warn'}`}
            aria-hidden="true"
          />
        </button>
      )}

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
      />

      {researchOpen && (
        <ResearchPanel
          config={executionConfig}
          onConfigChange={patch => setExecutionConfig(prev => normalizeExecutionConfig({ ...prev, ...patch }))}
          latestSynthesis={messages.find(item => item.role === 'synthesis' && item.synthesis)?.synthesis ?? null}
          onClose={() => setResearchOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          sources={sources}
          channelStatuses={channelStatuses}
          identity={identity}
          permission={permission}
          onClose={() => setSettingsOpen(false)}
          onSaveSource={saveSource}
          onAddSource={addSource}
          onRemoveSource={removeSource}
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
    report_pending: '准备回传结果',
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
