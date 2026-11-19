/**
 * P1-14 Active 门禁：shadow 达标才允许切 active。
 */
export interface ShadowMetrics {
  questions: number;
  planned: number;
  covered: number;
  maxTasksSimple: number;
}

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

export function evaluateActiveGate(metrics: ShadowMetrics): GateResult {
  const reasons: string[] = [];
  if (metrics.questions < 20) reasons.push('真实问题少于 20');
  if (metrics.questions === 0 || metrics.covered / metrics.questions < 0.9) {
    reasons.push('计划覆盖率低于 90%');
  }
  if (metrics.maxTasksSimple > 2) reasons.push('简单问题超过 2 个任务');
  return { ok: reasons.length === 0, reasons };
}


/** 设置 active 前必须先过门禁；legacy/shadow 不受限。 */
export function canRequestMode(
  mode: 'legacy' | 'shadow' | 'active',
  metrics: ShadowMetrics
): { ok: boolean; reasons: string[] } {
  if (mode !== 'active') return { ok: true, reasons: [] };
  return evaluateActiveGate(metrics);
}
