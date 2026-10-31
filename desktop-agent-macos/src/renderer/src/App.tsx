import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentEvent,
  AgentTask,
  DeepSeekDiagnostics,
  DeepSeekStatus,
  PermissionPreset,
  PlanPreview as PlanPreviewType
} from '../../shared/contracts';
import { TaskSidebar } from './components/TaskSidebar';
import { TaskInput } from './components/TaskInput';
import { PlanPreview } from './components/PlanPreview';
import { ExecutionLog } from './components/ExecutionLog';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { computeSplit, PAGE_GUTTER } from '../../shared/layout';

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
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [split, setSplit] = useState(0);
  const [draggingPage, setDraggingPage] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagReport, setDiagReport] = useState<DeepSeekDiagnostics | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);

  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;
  const dragRef = useRef(false);

  const activeTask = useMemo(() => tasks.find(task => task.taskId === activeId) ?? null, [tasks, activeId]);
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

    const stopEvents = window.agentAPI.onAgentEvent(event => {
      if (event.type === 'task.updated') {
        setTasks(prev => upsert(prev, event.task));
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

    return () => {
      stopEvents();
      stopDeepSeek();
      stopLayout();
    };
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty('--split', `${String(split)}px`);
  }, [split]);

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
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
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
    const dir = await window.agentAPI.chooseDirectory();
    if (dir) setWorkspace(dir);
  }

  async function submit() {
    const text = prompt.trim();
    if (!text) return;

    let root = workspace;
    if (!root) {
      const dir = await window.agentAPI.chooseDirectory();
      if (!dir) return;
      root = dir;
      setWorkspace(dir);
    }

    setSubmitting(true);
    setError('');
    try {
      const task = await window.agentAPI.submitPrompt({ prompt: text, permissionPreset: permission, workspaceRoot: root });
      setTasks(prev => upsert(prev, task));
      setActiveId(task.taskId);
      setEvents([]);
      setDerived({ plan: null, questions: [], answer: '' });
      setPrompt('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSubmitting(false);
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

  async function cancel() {
    if (!activeTask) return;
    try {
      await window.agentAPI.cancelTask(activeTask.taskId);
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

  const showPlan = derived.plan !== null && activeTask?.status === 'awaiting_approval';

  return (
    <div className="app">
      <TaskSidebar
        tasks={tasks}
        activeId={activeId}
        onSelect={selectTask}
        onDelete={deleteTask}
        onNew={() => {
          setActiveId(null);
          setEvents([]);
          setDerived({ plan: null, questions: [], answer: '' });
          setError('');
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
            {/* The pill is a summary; `detail` is the diagnosis. Showing only the
                pill turns "selectors no longer match the page" into a silent
                "页面异常", which is the one case a user cannot act on. */}
            <span
              className={`pill ${status?.loggedIn && status?.pageReady ? 'ok' : 'warn'}`}
              title={status?.detail ?? undefined}
            >
              {status ? (status.loggedIn ? (status.pageReady ? 'DeepSeek 就绪' : '页面异常') : '未登录') : '连接中…'}
            </span>
            {status?.detail && (
              <span className="status-detail" title={status.detail}>
                {status.detail}
              </span>
            )}
            <button className="btn ghost" type="button" onClick={openDiagnostics}>
              诊断
            </button>
            {(busy || awaitingAnswer) && (
              <button className="btn ghost" type="button" onClick={cancel}>
                取消任务
              </button>
            )}
          </div>
        </header>

        <div className={`scroll${activeTask ? '' : ' is-empty'}`}>
          <div className="inner">
            {!activeTask && (
              <section className="hero">
                <div className="hero-logo">◈</div>
                <div className="hero-title">
                  探索未至之境
                  <span className="badge">预览版</span>
                </div>
                <p className="hero-sub">
                  提出目标，Agent 自动交给 DeepSeek 规划；计划经本地校验并由你确认后，才在授权目录内执行。
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
              // Disabled while the agent works and while it waits for an answer:
              // in both cases a new prompt would start a second task and lose
              // the question on screen.
              disabled={submitting || busy || awaitingAnswer}
              busy={submitting}
              onChange={setPrompt}
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
            <div className="page-ghost" style={{ width: Math.max(0, split - PAGE_GUTTER) }}>
              <span>松开以应用 · {Math.round(split)} px</span>
            </div>
          )}
        </>
      )}

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
