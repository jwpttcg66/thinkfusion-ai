import React, { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import type { TerminalSessionSummary } from '../../shared/cli-agents';
import { TerminalPanel, type TerminalPanelBridge } from './components/TerminalPanel';

/**
 * 独立终端窗口：一个会话一个窗口，不做标签页。
 *
 * 会话 id 只从 URL 读一次；主窗口再点「放大」只会聚焦这个窗口。
 * 窗口只做一件事：显示并接管这一个 PTY。
 */
function TerminalWindow() {
  const sessionId = new URLSearchParams(window.location.search).get('session') ?? '';

  const sessions = useMemo<TerminalSessionSummary[]>(
    () =>
      sessionId
        ? [
            {
              sessionId,
              pid: 0,
              shell: '',
              cwd: '',
              cols: 0,
              rows: 0,
              exited: false,
              pending: 0
            }
          ]
        : [],
    [sessionId]
  );

  const bridge = useMemo<TerminalPanelBridge>(
    () => ({
      attachTerminal: id => window.tfTerminal.attach(id),
      writeTerminal: (id, data) => window.tfTerminal.write(id, data),
      resizeTerminal: (id, cols, rows) => window.tfTerminal.resize(id, cols, rows),
      closeTerminal: id => window.tfTerminal.close(id),
      onTerminalData: listener => window.tfTerminal.onData(listener)
    }),
    []
  );

  if (!sessionId) {
    return (
      <div className="terminal-window">
        <div className="terminal-panel-empty">
          <b>缺少会话 id</b>
          <p className="muted">这个窗口是从主窗口的「放大」打开的；直接打开它没有可显示的终端。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-window">
      <TerminalPanel
        sessions={sessions}
        bridge={bridge}
        initialSessionId={sessionId}
        single
        detached
        onReattach={() => void window.tfTerminal.reattach()}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<TerminalWindow />);
