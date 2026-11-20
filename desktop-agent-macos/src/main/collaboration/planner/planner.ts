/**
 * 规则版 Planner（P1.0）。
 *
 * - 简单问题只选一个参与者；复杂/比较/研究至少两个。
 * - 先守 modelScope/includeWeb，再选人。
 * - 每个参与者一个 analyze 任务，最后一个 synthesize 任务。
 * - 不做自动重规划；P1.1 才加。
 */
import { randomUUID } from 'node:crypto';
import type {
  Budget,
  Goal,
  ModelScope,
  Plan,
  Policy
} from '../domain/types';
import type { ParticipantView } from '../participants/manager';
import { buildBehaviorTasks, chooseBehavior } from '../behaviors/strategy';

export interface PlannerOptions {
  modelScope?: ModelScope;
  includeWeb?: boolean;
  minParticipants?: number;
  budget?: Budget;
}

const COMPLEX = /(比较|对比|区别|为什么|如何|怎么|分析|研究|方案|选型|权衡|影响|原因)/;

function isComplex(statement: string): boolean {
  return statement.trim().length > 80 || COMPLEX.test(statement);
}

function allowedByScope(participant: ParticipantView, scope: ModelScope, includeWeb: boolean): boolean {
  if (participant.kind === 'web') return includeWeb;
  if (scope === 'local') return participant.kind === 'local';
  if (scope === 'remote') return participant.kind === 'cloud' || participant.kind === 'cli';
  return true;
}

function score(participant: ParticipantView): number {
  if (participant.kind === 'cloud') return 4;
  if (participant.kind === 'local') return 3;
  if (participant.kind === 'web') return 2;
  return 1;
}

export function planGoal(goal: Goal, participants: readonly ParticipantView[], options: PlannerOptions = {}): Plan {
  const scope = options.modelScope ?? 'hybrid';
  const includeWeb = options.includeWeb ?? true;
  const complex = isComplex(goal.statement) || goal.workspace === 'engineering';
  const policy: Policy = {
    modelScope: scope,
    includeWeb,
    minParticipants: options.minParticipants ?? (complex ? 2 : 1),
    allowWebQuestioner: goal.workspace !== 'engineering',
    budget: options.budget ?? { maxCalls: 6, maxMs: 120_000, usedCalls: 0, startedAt: Date.now() }
  };
  const inScope = participants.filter(item => item.available && allowedByScope(item, scope, includeWeb));
  const available = [...inScope].sort((left, right) => score(right) - score(left));
  const wanted = Math.max(policy.minParticipants, complex ? 2 : 1);
  const selected = available.slice(0, wanted);
  if (selected.length === 0) throw new Error('没有满足范围的可用参与者');
  if (goal.workspace === 'engineering' && !selected.some(item => item.kind !== 'web')) {
    throw new Error('工程模式至少需要一个本地/云端参与者');
  }
  const skipped = participants
    .filter(item => !selected.includes(item))
    .map(item => ({
      participantId: item.participantId,
      reason: !item.available ? item.reason ?? '不可用' : '未满足范围/数量'
    }));

  const choice = chooseBehavior(goal, selected, complex);
  const tasks = buildBehaviorTasks(goal, selected, choice.behavior);

  return {
    planId: randomUUID(),
    goalId: goal.goalId,
    version: 1,
    policy,
    tasks,
    participants: selected.map(item => ({
      participantId: item.participantId,
      reason: complex ? '复杂问题，需多视角' : '简单问题，单点作答'
    })),
    skipped,
    stopWhen: ['acceptance_satisfied', 'no_new_information', 'budget_exhausted'],
    reason: `规则：${choice.reason}`,
    behavior: choice.behavior,
    behaviorReason: choice.reason,
    createdAt: Date.now()
  };
}
