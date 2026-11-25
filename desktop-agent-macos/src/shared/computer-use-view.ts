/**
 * 从真实的活动事件投影桌面操作状态。
 * 没有 computer.* 事件就返回 null，不补一段「准备观察」。
 */

export interface ComputerUseView {
  appName?: string;
  bundleId?: string;
  windowId?: string;
  permission?: string;
  action?: string;
  verified?: boolean;
  verification?: string;
  snapshotId?: string;
  screenshotRef?: string;
  stopped: boolean;
  events: Array<{ type: string; timestamp?: number; summary?: string }>;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function projectComputerUse(
  events: readonly { occurredAt?: number; payload: Record<string, unknown> }[]
): ComputerUseView | null {
  const related = events.filter(event => {
    const tool = event.payload.tool;
    return typeof tool === 'string' && tool.startsWith('computer.');
  });
  if (related.length === 0) return null;
  let latest: Record<string, unknown> | null = null;
  for (const event of related) {
    const result = event.payload.result;
    if (result && typeof result === 'object') latest = result as Record<string, unknown>;
  }
  const nested = Array.isArray(latest?.events) ? latest.events : [];
  const verification = latest?.verification;
  const verificationReason = verification && typeof verification === 'object'
    ? text((verification as { reason?: unknown }).reason)
    : undefined;
  return {
    appName: text(latest?.appName),
    bundleId: text(latest?.bundleId),
    windowId: text(latest?.windowId),
    permission: text(latest?.permissionDecision),
    action: text(latest?.summary),
    verified: typeof latest?.verified === 'boolean' ? latest.verified : undefined,
    verification: verificationReason,
    snapshotId: text(latest?.snapshotId),
    screenshotRef: text(latest?.screenshotRef),
    stopped: related.some(event => event.payload.tool === 'computer.stop' && event.payload.type === 'step.completed'),
    events: nested.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const record = item as { type?: unknown; timestamp?: unknown };
      if (typeof record.type !== 'string') return [];
      return [{
        type: record.type,
        ...(typeof record.timestamp === 'number' ? { timestamp: record.timestamp } : {})
      }];
    })
  };
}

const DESKTOP_MUTATIONS = new Set([
  'computer.click',
  'computer.type',
  'computer.keypress',
  'computer.scroll',
  'computer.drag'
]);

/** 用户要求改桌面，这一轮却只观察。这种报告不能当成任务已经做完。 */
export function desktopActionStillOpen(
  userPrompt: string,
  results: readonly { tool: string; status: string }[]
): boolean {
  if (!/(输入|点击|按键|滚动|拖动|拖拽|清空)/.test(userPrompt)) return false;
  const sawDesktop = results.some(item => item.tool.startsWith('computer.') && item.status === 'completed');
  if (!sawDesktop) return false;
  return !results.some(item => DESKTOP_MUTATIONS.has(item.tool) && item.status === 'completed');
}
