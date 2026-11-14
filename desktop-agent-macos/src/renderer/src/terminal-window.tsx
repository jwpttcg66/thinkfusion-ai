import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import type { TerminalSessionSummary } from '../../shared/cli-agents';
import { TerminalPanel, type TerminalPanelBridge } from './components/TerminalPanel';

/**
 * 独立终端窗口。
 *
 * 它只加载这一个页面，preload 也只暴露 PTY 读写。会话列表每 2 秒重取一次，
 * 因为 PTY 的创建/退出发生在 Runtime，不在这个窗口里。
 */
function TerminalWindow() {
  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [initial, setInitial] = useState<string | null>(
    new URLSearchParams(window.location.search).get('session')
  );

  const refresh = () => {
    void window.tfTerminal
      .list()
      .then(list => setSessions(list))
      .catch(() => undefined);
  };

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 2000);
    const off = window.tfTerminal.onSelect(sessionId => setInitial(sessionId));
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, []);

  const bridge = useMemo<TerminalPanelBridge>(
    () => ({
      attachTerminal: sessionId => window.tfTerminal.attach(sessionId),
      writeTerminal: (sessionId, data) => window.tfTerminal.write(sessionId, data),
      resizeTerminal: (sessionId, cols, rows) => window.tfTerminal.resize(sessionId, cols, rows),
      closeTerminal: sessionId => window.tfTerminal.close(sessionId),
      onTerminalData: listener => window.tfTerminal.onData(listener)
    }),
    []
  );

  return (
    <div className="terminal-window">
      <TerminalPanel
        sessions={sessions}
        bridge={bridge}
        initialSessionId={initial}
        detached
        onReattach={() => void window.tfTerminal.reattach()}
        onSessionsChanged={refresh}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<TerminalWindow />);
