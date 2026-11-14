import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalDataEvent } from '../../../shared/cli-agents';

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
    exitCode?: number;
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
  onDetach,
  onClosePane,
  onReattach,
  onSessionsChanged
}: {
  sessions: TerminalPanelSession[];
  bridge: TerminalPanelBridge;
  initialSessionId?: string | null;
  detached?: boolean;
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
  const hostRef = useRef<HTMLDivElement | null>(null);

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

    const apply = (event: TerminalDataEvent) => {
      if (event.sessionId !== active) return;
      if (event.data) terminal.write(event.data);
      if (event.dropped > 0) setDropped(previous => previous + event.dropped);
      if (event.exited) setExitCode(event.exitCode ?? null);
    };

    const start = async () => {
      try {
        const attached = await bridge.attachTerminal(active);
        if (disposed) return;
        if (attached.backlog) terminal.write(attached.backlog);
        if (attached.dropped > 0) setDropped(attached.dropped);
        if (attached.exited) setExitCode(attached.exitCode ?? null);
        unsubscribe = bridge.onTerminalData(apply);
        fit.fit();
        await bridge.resizeTerminal(active, terminal.cols, terminal.rows);
      } catch (cause) {
        if (!disposed) {
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
  const status = exitCode !== null ? `已退出（exit ${String(exitCode)}）` : '运行中';

  return (
    <div className="terminal-panel">
      <header className="terminal-panel-head">
        <div className="terminal-panel-tabs">
          {sessions.map(session => (
            <button
              key={session.sessionId}
              type="button"
              className={session.sessionId === active ? 'is-active' : undefined}
              onClick={() => setActive(session.sessionId)}
              title={session.cwd ?? session.sessionId}
            >
              {labelOf(session)}
            </button>
          ))}
          {sessions.length === 0 && <span className="muted">还没有终端会话</span>}
        </div>
        <span className="terminal-panel-status">
          {current ? status : ''}
          {dropped > 0 ? ` · 已丢弃 ${String(dropped)} 字符` : ''}
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
          {active && sessions.length > 0 && (
            <button
              type="button"
              className="btn ghost"
              title="结束这个终端会话（进程组会被终止）"
              onClick={() => {
                const target = active;
                void bridge
                  .closeTerminal(target)
                  .then(() => {
                    setActive(null);
                    onSessionsChanged?.();
                  })
                  .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
              }}
            >
              结束会话
            </button>
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
