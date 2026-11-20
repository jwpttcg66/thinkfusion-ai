/**
 * A-03：四种协作行为的任务图。
 * 行为只决定 Plan.tasks；Runner 仍用依赖/并发执行。
 */
import type { CollaborationBehavior, Goal, TaskSpec } from '../domain/types';
import type { ParticipantView } from '../participants/manager';

export interface BehaviorChoice {
  behavior: CollaborationBehavior;
  reason: string;
}

const HIGH_RISK = /(修改|实现|修复|删除|执行|写入|部署|重构)/;
const CONTESTED = /(比较|对比|争议|冲突|风险|评估)/;
const SEQUENTIAL = /(先.+(再|然后)|逐步|依次|依赖)/;

export function chooseBehavior(
  goal: Goal,
  participants: readonly ParticipantView[],
  complex: boolean
): BehaviorChoice {
  const text = goal.statement;
  const highRisk = HIGH_RISK.test(text);
  const contested = CONTESTED.test(text);
  if (participants.length < 2) {
    return { behavior: 'independent', reason: '只有一个可用参与者' };
  }
  if (goal.workspace === 'engineering') {
    return highRisk
      ? { behavior: 'crosscheck', reason: '工程写操作，需要交叉复核' }
      : { behavior: 'progressive', reason: '工程只读任务，先分析再验证' };
  }
  if (highRisk) return { behavior: 'crosscheck', reason: '高风险任务，需要交叉复核' };
  if (contested) return { behavior: 'crosscheck', reason: '存在比较/争议，需要交叉复核' };
  if (SEQUENTIAL.test(text)) return { behavior: 'progressive', reason: '问题要求按步骤推进' };
  if (complex) return { behavior: 'parallel', reason: '复杂问题，多参与者独立分析' };
  return { behavior: 'independent', reason: '简单问题，单点作答' };
}

function analyzeTask(goal: Goal, participant: ParticipantView, index: number): TaskSpec {
  return {
    taskId: `t-analyze-${String(index)}`,
    goalId: goal.goalId,
    kind: 'analyze',
    envelope: { question: goal.statement, acceptance: goal.acceptance, evidenceRequired: false },
    dependsOn: [],
    requiredCapabilities: [],
    context: { participantId: participant.participantId }
  };
}

function synthTask(goal: Goal, participant: ParticipantView, dependsOn: string[]): TaskSpec {
  return {
    taskId: 't-synthesize',
    goalId: goal.goalId,
    kind: 'synthesize',
    envelope: { question: goal.statement, acceptance: goal.acceptance, evidenceRequired: false },
    dependsOn,
    requiredCapabilities: ['reasoning'],
    context: { participantId: participant.participantId }
  };
}

export function buildBehaviorTasks(
  goal: Goal,
  participants: readonly ParticipantView[],
  behavior: CollaborationBehavior
): TaskSpec[] {
  const lead = participants.find(item => item.kind !== 'web') ?? participants[0];
  const analyze = participants.map((participant, index) => analyzeTask(goal, participant, index));
  const analyzeIds = analyze.map(task => task.taskId);

  if (behavior === 'independent' || participants.length < 2) {
    return [analyze[0], synthTask(goal, lead, [analyze[0].taskId])];
  }
  if (behavior === 'parallel') {
    return [...analyze, synthTask(goal, lead, analyzeIds)];
  }
  if (behavior === 'progressive') {
    const verify: TaskSpec = {
      taskId: 't-verify',
      goalId: goal.goalId,
      kind: 'verify',
      envelope: { question: `验证：${goal.statement}`, acceptance: goal.acceptance, evidenceRequired: true },
      dependsOn: analyzeIds,
      requiredCapabilities: [],
      context: { participantId: (participants[1] ?? lead).participantId }
    };
    return [...analyze, verify, synthTask(goal, lead, [verify.taskId])];
  }
  const reviews = participants.map((participant, index) => ({
    taskId: `t-review-${String(index)}`,
    goalId: goal.goalId,
    kind: 'review' as const,
    envelope: { question: `交叉复核：${goal.statement}`, acceptance: goal.acceptance, evidenceRequired: true },
    dependsOn: analyzeIds,
    requiredCapabilities: [],
    context: { participantId: participant.participantId }
  }));
  return [...analyze, ...reviews, synthTask(goal, lead, reviews.map(task => task.taskId))];
}
