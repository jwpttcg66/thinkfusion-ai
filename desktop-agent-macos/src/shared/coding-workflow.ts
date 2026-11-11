/**
 * 编码工作流的状态与预算。
 *
 * 这是业务状态，不是第二套 Runtime 状态：工具执行仍然由 AgentOrchestrator
 * 与 Runtime 完成，这里只决定「现在处于哪一步」和「这份计划超没超预算」。
 */

import type { AgentPlan, TaskStatus } from './contracts';

export type CodingState =
  | 'ANALYZING'
  | 'PLANNING'
  | 'WAITING_APPROVAL'
  | 'EDITING'
  | 'VERIFYING'
  | 'FIXING'
  | 'REVIEWING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED';

export const CODING_BUDGET = {
  /** 改 → 验 → 修 的轮数上限（任务级 maxRounds 仍是外层硬上限）。 */
  maxIterations: 8,
  /** 单份计划的工具调用上限。 */
  maxToolCalls: 80,
  /** 单任务墙钟上限；连续无进展另有 5 分钟看门狗。 */
  maxDurationMs: 15 * 60_000,
  /** 一份计划最多改多少个文件；超过要求拆任务。 */
  maxChangedFiles: 20,
  /** 并行只读探索/测试的上限；写同一文件必须串行或 worktree 隔离。 */
  maxParallelAgents: 3
} as const;

const WRITE_TOOLS = new Set(['fs.writeFile', 'fs.edit', 'fs.applyPatch', 'fs.remove', 'fs.move', 'fs.copy']);

/** 计划审批前的预算检查；返回空数组表示放行。 */
export function checkCodingBudget(plan: AgentPlan): string[] {
  const steps = plan.steps ?? [];
  const violations: string[] = [];
  if (steps.length > CODING_BUDGET.maxToolCalls) {
    violations.push(`计划有 ${String(steps.length)} 步，超过单次上限 ${String(CODING_BUDGET.maxToolCalls)} 步`);
  }
  const paths = new Set<string>();
  for (const step of steps) {
    if (!WRITE_TOOLS.has(step.tool)) continue;
    const file = (step.args as { path?: unknown }).path;
    if (typeof file === 'string') paths.add(file);
  }
  if (paths.size > CODING_BUDGET.maxChangedFiles) {
    violations.push(`这一份计划会改 ${String(paths.size)} 个文件，超过上限 ${String(CODING_BUDGET.maxChangedFiles)}；请拆成多次`);
  }
  return violations;
}

/** 任务状态 → 编码工作流状态；历史状态没有对应就按最接近的阶段显示。 */
export function codingStateFor(status: TaskStatus): CodingState {
  switch (status) {
    case 'created':
    case 'planning':
    case 'awaiting_clarification':
      return 'ANALYZING';
    case 'plan_ready':
      return 'PLANNING';
    case 'awaiting_approval':
      return 'WAITING_APPROVAL';
    case 'executing':
      return 'EDITING';
    case 'verifying':
      return 'VERIFYING';
    case 'report_pending':
      return 'REVIEWING';
    case 'awaiting_next_round':
      return 'FIXING';
    case 'completed':
      return 'COMPLETED';
    case 'failed':
      return 'FAILED';
    case 'cancelled':
      return 'CANCELLED';
  }
}
