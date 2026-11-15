import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalDataEvent, TerminalProcessState } from '../../../shared/cli-agents';
import { describeDuration, describeTerminalState } from '../../../shared/terminal-state';

/**
 * 一个可切换多个 PTY 会话的终端面板。
 *
 * 主窗口右侧和独立终端窗口共用它，差别只在 bridge：主窗口用完整 agentAPI，
 * 独立窗口用只能读写 PTY 的 tfTerminal。因此这里不碰任务、文件或设置。
 */

export interface TerminalPanelSession {
  sessionId: string;
  label?: string;
  cwd?: string;
  exited?: boolean;
  exitCode?: number;
}

export interface TerminalPanelBridge {
  attachTerminal(sessionId: string): Promise<{
    backlog: string;
    cursor: number;
    cols: number;
    rows: number;
    dropped: number;
    exited: boolean;
    missing?: boolean;
    exitCode?: number;
    /** 进程状态由后端给；面板连接状态由本组件自己维护。 */
    state?: TerminalProcessState;
    startedAt?: number;
    durationMs?: number;
    auditIncomplete?: boolean;
    auditTruncated?: boolean;
    terminateError?: string;
  }>;
  writeTerminal(sessionId: string, data: string): Promise<void>;
  resizeTerminal(sessionId: string, cols: number, rows: number): Promise<void>;
  closeTerminal(sessionId: string): Promise<void>;
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void;
}

function labelOf(session: TerminalPanelSession): string {
  if (session.label) return session.label;
  if (session.cwd) return session.cwd.split('/').filter(Boolean).slice(-1)[0] ?? session.sessionId;
  return session.sessionId.slice(-6);
}

export function TerminalPanel({
  sessions,
  bridge,
  initialSessionId,
  detached = false,
  single = false,
  onDetach,
  onClosePane,
  onReattach,
  onSessionsChanged
}: {
  sessions: TerminalPanelSession[];
  bridge: TerminalPanelBridge;
  initialSessionId?: string | null;
  detached?: boolean;
  /** 独立窗口：一个会话一个窗口，不显示标签栏。 */
  single?: boolean;
  onDetach?: (sessionId: string) => void;
  onClosePane?: () => void;
  onReattach?: () => void;
  /** 会话被结束或退出后，让父组件重新拉一次列表。 */
  onSessionsChanged?: () => void;
}) {
  const [active, setActive] = useState<string | null>(initialSessionId ?? sessions[0]?.sessionId ?? null);
  const [dropped, setDropped] = useState(0);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [processState, setProcessState] = useState<TerminalProcessState>('STARTING');
  const [connection, setConnection] = useState<'ATTACHED' | 'DETACHED'>('DETACHED');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [auditIncomplete, setAuditIncomplete] = useState(false);
  const [auditTruncated, setAuditTruncated] = useState(false);
  const [terminateError, setTerminateError] = useState('');
  const [now, setNow] = useState(Date.now());
  /** 「结束会话」分两步：进程会被终止，不能一键误点。 */
  const [confirmClose, setConfirmClose] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  // 状态栏的运行时长每秒走一次；进程退出后不再刷新。
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 二次确认 5 秒后自动收起，避免按钮一直停在危险态。
  useEffect(() => {
    if (!confirmClose) return;
    const timer = setTimeout(() => setConfirmClose(false), 5000);
    return () => clearTimeout(timer);
  }, [confirmClose, active]);

  // 会话列表变化时：原来选中的没了就退到第一个，一个都没有就保持空状态。
  useEffect(() => {
    if (active && sessions.some(item => item.sessionId === active)) return;
    setActive(initialSessionId ?? sessions[0]?.sessionId ?? null);
  }, [active, initialSessionId, sessions]);

  useEffect(() => {
    if (!active || !hostRef.current) return;
    const element = hostRef.current;
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      scrollback: 4000,
      allowProposedApi: false,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      theme: { background: '#0f1115', foreground: '#d7dae0' }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);

    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    setDropped(0);
    setExitCode(null);
    setError('');
    setProcessState('STARTING');
    setConnection('DETACHED');
    setStartedAt(null);
    setEndedAt(null);
    setAuditIncomplete(false);
    setAuditTruncated(false);
    setTerminateError('');
    setConfirmClose(false);

    const apply = (event: TerminalDataEvent) => {
      if (event.sessionId !== active) return;
      if (event.data) terminal.write(event.data);
      if (event.dropped > 0) setDropped(previous => previous + event.dropped);
      if (event.exited) {
        setExitCode(event.exitCode ?? null);
        setEndedAt(previous => previous ?? Date.now());
        // 被信号/非零退出码终止的不能写成「正常退出」。
        setProcessState(event.exitCode === undefined || event.exitCode === 0 ? 'EXITED' : 'FAILED');
        setConnection('DETACHED');
      }
    };

    const start = async () => {
      try {
        const attached = await bridge.attachTerminal(active);
        if (disposed) return;
        if (attached.missing) {
          // 会话已经被结束：显示明确状态，不订阅、不再缩放。
          setExitCode(attached.exitCode ?? null);
          setProcessState('EXITED');
          setEndedAt(Date.now());
          setError('这个终端会话已经结束');
          return;
        }
        if (attached.backlog) terminal.write(attached.backlog);
        if (attached.dropped > 0) setDropped(attached.dropped);
        if (attached.exited) {
          setExitCode(attached.exitCode ?? null);
          setEndedAt(Date.now());
        }
        setProcessState(attached.state ?? (attached.exited ? 'EXITED' : 'RUNNING'));
        setStartedAt(attached.startedAt ?? null);
        setAuditIncomplete(attached.auditIncomplete === true);
        setAuditTruncated(attached.auditTruncated === true);
        setTerminateError(attached.terminateError ?? '');
        setConnection('ATTACHED');
        unsubscribe = bridge.onTerminalData(apply);
        fit.fit();
        await bridge.resizeTerminal(active, terminal.cols, terminal.rows);
      } catch (cause) {
        if (!disposed) {
          setConnection('DETACHED');
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };
    void start();

    const input = terminal.onData(data => {
      void bridge.writeTerminal(active, data).catch(() => undefined);
    });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      void bridge.resizeTerminal(active, terminal.cols, terminal.rows).catch(() => undefined);
    });
    observer.observe(element);

    return () => {
      disposed = true;
      unsubscribe?.();
      observer.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [active, bridge]);

  const current = useMemo(
    () => sessions.find(item => item.sessionId === active) ?? null,
    [active, sessions]
  );
  // 进程状态、连接状态、运行时长三件事分开显示：关掉面板不等于进程退出。
  const status = describeTerminalState({
    exited: exitCode !== null,
    ...(exitCode === null ? {} : { exitCode }),
    state: processState
  });
  const duration = startedAt ? describeDuration((endedAt ?? now) - startedAt) : '—';

  return (
    <div className="terminal-panel">
      <header className="terminal-panel-head">
        <div className="terminal-panel-tabs">
          {single ? (
            <span className="terminal-panel-title">
              {current ? labelOf(current) : '终端会话'}
            </span>
          ) : (
            sessions.map(session => (
              <button
                key={session.sessionId}
                type="button"
                className={session.sessionId === active ? 'is-active' : undefined}
                onClick={() => setActive(session.sessionId)}
                title={session.cwd ?? session.sessionId}
              >
                {labelOf(session)}
              </button>
            ))
          )}
          {!single && sessions.length === 0 && <span className="muted">还没有终端会话</span>}
        </div>
        <span className="terminal-panel-status" title={terminateError || undefined}>
          {current ? status : ''}
          {current ? ` · 连接：${connection === 'ATTACHED' ? '已连接' : '已断开'}` : ''}
          {current ? ` · 运行 ${duration}` : ''}
          {dropped > 0 ? ` · 已丢弃 ${String(dropped)} 字符` : ''}
          {auditIncomplete ? ' · 审计不完整' : ''}
          {auditTruncated ? ' · 审计已截断' : ''}
          {terminateError ? ' · 终止有错误' : ''}
        </span>
        <span className="terminal-panel-actions">
          {!detached && active && onDetach && (
            <button
              type="button"
              className="btn ghost"
              title="放大：把这个会话移到独立窗口"
              onClick={() => onDetach(active)}
            >
              放大
            </button>
          )}
          {detached && onReattach && (
            <button type="button" className="btn ghost" onClick={() => onReattach()}>
              吸附回来
            </button>
          )}
          {active && sessions.length > 0 && !confirmClose && (
            <button
              type="button"
              className="btn ghost"
              title="结束这个终端会话（进程组会被终止）"
              onClick={() => setConfirmClose(true)}
            >
              结束会话
            </button>
          )}
          {active && confirmClose && (
            <>
              <span className="terminal-confirm-text">将终止进程组，确认？</span>
              <button
                type="button"
                className="btn danger"
                aria-label="确认终止终端进程"
                onClick={() => {
                  const target = active;
                  setConfirmClose(false);
                  void bridge
                    .closeTerminal(target)
                    .then(() => {
                      setActive(null);
                      onSessionsChanged?.();
                    })
                    .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
                }}
              >
                确认终止
              </button>
              <button type="button" className="btn ghost" onClick={() => setConfirmClose(false)}>
                取消
              </button>
            </>
          )}
          {!detached && onClosePane && (
            <button type="button" className="btn ghost" onClick={() => onClosePane()}>
              收起
            </button>
          )}
        </span>
      </header>

      {active ? (
        <div className="terminal-panel-host" ref={hostRef} />
      ) : (
        <div className="terminal-panel-empty">
          <b>还没有终端会话</b>
          <p className="muted">
            任务里的 <code>term.open</code> 会创建持久终端；不关掉它，这里就能重新接上。
            外部 CLI 走 headless，不存在 PTY，因此不会出现在这里。
          </p>
        </div>
      )}

      {error && <p className="settings-error">{error}</p>}
      <p className="terminal-panel-hint muted">
        关闭面板不会结束会话；要终止请点「结束会话」。这里的输出是原始终端流，不是任务成功依据。
      </p>
    </div>
  );
}
