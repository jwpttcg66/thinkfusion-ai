/**
 * 工具历史适配（LT-P2-01）。
 *
 * 把 step.* 事件按 callId/stepId + attemptId 配对，供裁剪器使用。
 * 未完成/失败调用保留；不在这层做摘要。
 */

import type { AgentEvent } from '../../../shared/contracts';

export interface ToolHistoryEntry {
  key: string;
  stepId: string;
  callId?: string;
  attemptId?: string;
  roundId?: string;
  tool: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  startedAt?: number;
  endedAt?: number;
  argsText?: string;
  resultText?: string;
  error?: string;
  /** 原始结果位置；裁剪后仍可回查。 */
  resultRef?: string;
  evidenceRefs: string[];
}

function text(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function keyOf(event: Extract<AgentEvent, { type: 'step.started' | 'step.completed' | 'step.failed' | 'step.preparing' }>): string {
  const base = event.callId ?? event.stepId;
  return (event as { attemptId?: string }).attemptId ? `${base}:${(event as { attemptId?: string }).attemptId}` : base;
}

/**
 * 把事件折成工具历史。同一 key 的 started/completed/failed 合成一条；
 * completed 没有对应 started 时也保留（旧事件可能缺前半段）。
 */
export function toToolHistory(events: readonly AgentEvent[]): ToolHistoryEntry[] {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const map = new Map<string, ToolHistoryEntry>();

  for (const event of ordered) {
    if (event.type !== 'step.preparing' && event.type !== 'step.started'
      && event.type !== 'step.completed' && event.type !== 'step.failed') continue;

    const key = keyOf(event);
    const existing = map.get(key);
    const base: ToolHistoryEntry = existing ?? {
      key,
      stepId: event.stepId,
      ...(event.callId ? { callId: event.callId } : {}),
      ...(event as { attemptId?: string }).attemptId ? { attemptId: (event as { attemptId?: string }).attemptId } : {},
      ...(event.roundId ? { roundId: event.roundId } : {}),
      tool: event.tool,
      status: 'unknown',
      evidenceRefs: []
    };

    if (event.type === 'step.preparing') {
      map.set(key, {
        ...base,
        argsText: text(event.args) ?? base.argsText,
        status: base.status === 'unknown' ? 'running' : base.status
      });
      continue;
    }
    if (event.type === 'step.started') {
      map.set(key, {
        ...base,
        status: 'running',
        startedAt: event.at,
        argsText: text(event.args) ?? base.argsText
      });
      continue;
    }
    if (event.type === 'step.completed') {
      map.set(key, {
        ...base,
        status: 'completed',
        endedAt: event.at,
        resultText: text(event.result) ?? '',
        resultRef: `step:${event.stepId}`
      });
      continue;
    }
    map.set(key, {
      ...base,
      status: 'failed',
      endedAt: event.at,
      error: event.error,
      argsText: text(event.args) ?? base.argsText,
      resultRef: `step:${event.stepId}`
    });
  }

  return [...map.values()];
}
