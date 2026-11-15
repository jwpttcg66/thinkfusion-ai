import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { AgentEvent } from '../../../shared/contracts';
import type { TerminalDataEvent } from '../../../shared/cli-agents';

interface SessionInfo {
  sessionId: string;
  label: string;
  stepId: string;
}

/**
 * 已存在的 PTY 会话的只读/可交互面板。
 *
 * 三条边界：
 *
 * - **只 attach，不 spawn。** sessionId 来自任务事件里的 term.open 结果；
 *   渲染层没有「打开任意路径终端」的能力，preload 也只暴露枚举调用。
 * - **关闭面板不等于杀进程。** 卸载时只 dispose xterm 与取消订阅；要结束
 *   CLI 必须点「结束会话」，那会显式调用 terminal:close。
 * - **不进隐藏层的输出不丢。** 输出由 Runtime 按 sessionId 推送，这里只是
 *   往 xterm 里写；丢字节时 Runtime 会带 dropped，由状态行如实显示。
 */

function sessionsFrom(events: readonly AgentEvent[]): SessionInfo[] {
  const found = new Map<string, SessionInfo>();
  for (const event of events) {
    if (event.type !== 'step.completed') continue;
    if (!event.tool.startsWith('term.')) continue;
    const result = event.result as { sessionId?: unknown } | null;
    const sessionId = typeof result?.sessionId === 'string' ? result.sessionId : '';
    if (!sessionId || found.has(sessionId)) continue;
    found.set(sessionId, {
      sessionId,
      label: event.tool === 'term.open' ? '终端' : event.tool,
      stepId: event.stepId
    });
  }
  return [...found.values()];
}

export function AgentTerminal({ events }: { events: readonly AgentEvent[] }) {
  const sessions = useMemo(() => sessionsFrom(events), [events]);
  const [active, setActive] = useState<string | null>(sessions[0]?.sessionId ?? null);
  const [dropped, setDropped] = useState(0);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active && sessions[0]) setActive(sessions[0].sessionId);
  }, [active, sessions]);

  useEffect(() => {
    if (!active || !hostRef.current) return;
    const element = hostRef.current;
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      scrollback: 2000,
      allowProposedApi: false,
      // 不注册 OSC 52 / OSC 8 处理器：第三方 CLI 输出不能改剪贴板，
      // 超链接也不会被应用当成可执行动作。
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

    const apply = (event: TerminalDataEvent) => {
      if (event.sessionId !== active) return;
      if (event.data) terminal.write(event.data);
      if (event.dropped > 0) setDropped(previous => previous + event.dropped);
      if (event.exited) setExitCode(event.exitCode ?? null);
    };

    const start = async () => {
      try {
        const attached = await window.agentAPI.attachTerminal(active);
        if (disposed) return;
        if (attached.backlog) terminal.write(attached.backlog);
        if (attached.dropped > 0) setDropped(attached.dropped);
        if (attached.exited) setExitCode(attached.exitCode ?? null);
        unsubscribe = window.agentAPI.onTerminalData(apply);
      } catch (error) {
        terminal.write(`\r\n[无法附加到会话：${error instanceof Error ? error.message : String(error)}]\r\n`);
        return;
      }
      try {
        fit.fit();
        await window.agentAPI.resizeTerminal(active, terminal.cols, terminal.rows);
      } catch {
        // 尺寸不是必需能力；失败时保留默认 120×30。
      }
    };
    void start();

    const input = terminal.onData(data => {
      void window.agentAPI.writeTerminal(active, data).catch(() => undefined);
    });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      void window.agentAPI.resizeTerminal(active, terminal.cols, terminal.rows).catch(() => undefined);
    });
    observer.observe(element);

    return () => {
      disposed = true;
      unsubscribe?.();
      observer.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [active]);

  if (sessions.length === 0) return null;

  return (
    <section className="card agent-terminal">
      <header className="agent-terminal-head">
        <b>外部终端</b>
        <div className="agent-terminal-tabs">
          {sessions.map(session => (
            <button
              key={session.sessionId}
              type="button"
              className={session.sessionId === active ? 'is-active' : undefined}
              onClick={() => setActive(session.sessionId)}
            >
              {session.label}
            </button>
          ))}
        </div>
        <span className="muted">
          {exitCode === null ? '运行中' : `已退出（exit ${String(exitCode)}）`}
          {dropped > 0 ? ` · 已丢弃 ${String(dropped)} 字符` : ''}
        </span>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            if (!active) return;
            void window.agentAPI.closeTerminal(active).catch(() => undefined);
          }}
        >
          结束会话
        </button>
      </header>
      <div className="agent-terminal-host" ref={hostRef} />
      <p className="muted">
        关闭这个面板不会结束会话；要终止请点「结束会话」。这里的输出是原始终端流，不是任务成功依据。
      </p>
    </section>
  );
}
