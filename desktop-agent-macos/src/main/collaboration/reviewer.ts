/**
 * P1-13 模型审核：默认关闭；只在规则审核之后，用数据 + schema 问一次。
 * 输出不合法就回退规则，不阻塞主流程。
 */
import type { Plan } from './domain/types';

export type ReviewKind = 'plan' | 'replan' | 'debate';

export interface ReviewResult {
  ok: boolean;
  source: 'rule' | 'model';
  notes: string[];
  fallback?: boolean;
}

export function reviewPlanRules(plan: Plan): ReviewResult {
  const notes: string[] = [];
  if (plan.tasks.length === 0) notes.push('计划没有任务');
  if (new Set(plan.tasks.map(task => task.taskId)).size !== plan.tasks.length) notes.push('任务 id 重复');
  if (plan.participants.length < plan.policy.minParticipants) notes.push('参与者少于下限');
  for (const task of plan.tasks) {
    if (task.kind === 'execute' && task.envelope.acceptance.length === 0) {
      notes.push(`执行任务缺少验收：${task.taskId}`);
    }
  }
  return { ok: notes.length === 0, source: 'rule', notes };
}

export interface ModelReviewOptions {
  enabled: boolean;
  maxCalls?: number;
}

/**
 * ask 由调用方注入：接收 schema 与 data，返回模型输出。
 * 只做一次；任何异常/不合 schema 都回退 rule。
 */
export async function reviewWithModel(
  plan: Plan,
  ask: (input: { schema: Record<string, unknown>; data: unknown }) => Promise<unknown>,
  options: ModelReviewOptions
): Promise<ReviewResult> {
  const base = reviewPlanRules(plan);
  if (!options.enabled || (options.maxCalls ?? 1) <= 0) return base;
  const schema = {
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'boolean' }, notes: { type: 'array', items: { type: 'string' } } }
  };
  try {
    const raw = await ask({ schema, data: plan });
    if (!raw || typeof raw !== 'object' || typeof (raw as { ok?: unknown }).ok !== 'boolean') {
      return { ...base, fallback: true };
    }
    const notes = Array.isArray((raw as { notes?: unknown }).notes)
      ? (raw as { notes: unknown[] }).notes.filter((item): item is string => typeof item === 'string')
      : [];
    return { ok: (raw as { ok: boolean }).ok, source: 'model', notes };
  } catch {
    return { ...base, fallback: true };
  }
}
