import type { AgentEvent } from '../../../shared/contracts';

/**
 * 从任务事件里找出真实存在过的 PTY 会话。
 *
 * 这个模块刻意不 import xterm：App 用它在首屏判断「要不要加载终端组件」，
 * 如果把 xterm 一起拖进来，启动时就要付解析 300KB 终端实现的成本。
 */

export interface TerminalSessionInfo {
  sessionId: string;
  label: string;
  stepId: string;
}

export function terminalSessionsFrom(events: readonly AgentEvent[]): TerminalSessionInfo[] {
  const found = new Map<string, TerminalSessionInfo>();
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
