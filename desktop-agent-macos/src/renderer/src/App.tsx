import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentEvent,
  AgentTask,
  DeepSeekDiagnostics,
  DeepSeekStatus,
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
import { computeSplit, PAGE_GUTTER, RAIL_WIDTH } from '../../shared/layout';
import type { ChannelStatus, Conversation, ConversationMessage } from '../../shared/conversation';
import { classifyIntent } from '../../shared/intent';

const ACTIVE_STATUSES: AgentTask['status'][] = ['planning', 'executing', 'verifying', 'report_pending'];
interface Derived {
  plan: PlanPreviewType | null;
  questions: string[];
  answer: string;
}

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
  const [sources, setSources] = useState<SourcesState>({ sources: [], activeId: '', loading: false });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [channelStatuses, setChannelStatuses] = useState<ChannelStatus[]>([]);
  const [phases, setPhases] = useState<Record<string, { phase: string; detail?: string; at?: number }>>({});

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

  async function openDiagnostics() {
    setDiagOpen(true);
    await refreshDiagnostics();
  }

  async function refreshDiagnostics() {
    setDiagLoading(true);
    try {
      setDiagReport(await window.agentAPI.getDeepSeekDiagnostics());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDiagLoading(false);
    }
  }

  async function reloadPage() {
    setDiagLoading(true);
    try {
      await window.agentAPI.reloadDeepSeek();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDiagLoading(false);
    }
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
        permissionPreset: permission
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
      await window.agentAPI.deleteConversation(conversationId);
      setConversations(prev => prev.filter(item => item.conversationId !== conversationId));
      if (activeConversationId === conversationId) {
        setActiveConversationId(null);
        setMessages([]);
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

  async function selectSource(id: string) {
    if (id === sources.activeId) return;
    setError('');
    try {
      // The reply comes back before the page has loaded — the view is built in
      // the background, and the rail has to switch immediately or it feels
      // broken for exactly as long as the network is slow.
      setSources(await window.agentAPI.setSource(id));
    } catch (e) {
      setError(errorText(e));
    }
  }

  const showPlan = derived.plan !== null && activeTask?.status === 'awaiting_approval';

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
                  {channelStatuses.length === 0 ? '连接中…' : `${ready}/${channelStatuses.length} 通道就绪`}
                </span>
              );
            })()}
            {channelStatuses.some(channel => !channel.available && channel.detail) && (
              <span className="status-detail" title={channelStatuses.map(channel => channel.detail).filter(Boolean).join('；')}>
                {channelStatuses.find(channel => !channel.available && channel.detail)?.detail}
              </span>
            )}
            <button className="btn ghost" type="button" onClick={openDiagnostics}>
              诊断
            </button>
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
              onSubmit={submit}
            />
          </div>
        </div>
      </main>

      {/* The native page view is not part of this document, so the boundary
          needs to be drawn here or the two panes look like one broken one.
          It is also the only place the drag can start, and the ghost is what
          stands in for the page while the real view is parked offscreen. */}
      {split > 0 && (
        <>
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
        </>
      )}

      <SourceRail
        sources={sources.sources}
        activeId={sources.activeId}
        loading={sources.loading}
        onSelect={selectSource}
      />

      {diagOpen && (
        <DiagnosticsPanel
          report={diagReport}
          loading={diagLoading}
          onClose={() => setDiagOpen(false)}
          onRefresh={refreshDiagnostics}
          onReload={reloadPage}
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
