/**
 * P1-08：shadow 计划入口。
 *
 * 只读：列参与者、跑规则 Planner，不调用模型、不写状态、不执行任务。
 * 供 ConversationRunner 在 shadow 模式下调用；异常由调用方吞掉。
 */
import type { SubAgentPool } from '../agents/types';
import type { Assignment, CollaborationState, Deliverable, Goal, Plan } from './domain/types';
import { ParticipantManager } from './participants/manager';
import { planGoal, type PlannerOptions } from './planner/planner';
import { schedule } from './scheduler/scheduler';
import { runPlan } from './runner/runner';
import { deliver } from './deliver/deliver';
import { reviewPlanRules, type ReviewResult } from './reviewer';
import { needsReplan, type ReplanDecision } from './adapt/replanner';
import { selectDebates, type DebateRequest } from './behaviors/debate';
import type { ParticipantView } from './participants/manager';

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


export interface ActiveRunInput {
  goal: Goal;
  participants: readonly ParticipantView[];
  manager: ParticipantManager;
  options?: PlannerOptions;
  /** 可选：模型审核；不传只走规则。 */
  reviewer?: (plan: Plan) => Promise<ReviewResult>;
}

export interface ActiveRunResult {
  plan: Plan;
  assignments: Assignment[];
  state: CollaborationState;
  deliverable: Deliverable;
  review: ReviewResult;
  replan: ReplanDecision;
  debates: DebateRequest[];
}

/**
 * P1.1 active 管线：Planner → 规则审核 → Scheduler → Runner → Deliver。
 * 不接 ConversationRunner；供 P1-09 active 分支调用。
 */
export async function runCollaboration(input: ActiveRunInput): Promise<ActiveRunResult> {
  const plan = planGoal(input.goal, input.participants, input.options);
  const review = input.reviewer ? await input.reviewer(plan) : reviewPlanRules(plan);
  if (!review.ok) throw new Error(`计划审核未通过：${review.notes.join('；')}`);
  const assignments = schedule(plan, input.participants);
  const state = await runPlan({ goal: input.goal, plan, assignments, manager: input.manager });
  return {
    plan,
    assignments,
    state,
    deliverable: deliver(state),
    review,
    replan: needsReplan(state),
    debates: selectDebates(state)
  };
}
