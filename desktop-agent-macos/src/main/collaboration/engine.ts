/**
 * P1-08：shadow 计划入口。
 *
 * 只读：列参与者、跑规则 Planner，不调用模型、不写状态、不执行任务。
 * 供 ConversationRunner 在 shadow 模式下调用；异常由调用方吞掉。
 */
import type { SubAgentPool } from '../agents/types';
import type { Goal, Plan } from './domain/types';
import { ParticipantManager } from './participants/manager';
import { planGoal, type PlannerOptions } from './planner/planner';

export interface ShadowPlanInput {
  conversationId: string;
  workspace: Goal['workspace'];
  question: string;
  pool: SubAgentPool;
  options?: PlannerOptions;
}

export async function buildShadowPlan(input: ShadowPlanInput): Promise<Plan> {
  const participants = await new ParticipantManager(input.pool).list();
  const goal: Goal = {
    goalId: input.conversationId,
    workspace: input.workspace,
    statement: input.question,
    constraints: [],
    acceptance: [],
    createdAt: Date.now()
  };
  return planGoal(goal, participants, input.options);
}
