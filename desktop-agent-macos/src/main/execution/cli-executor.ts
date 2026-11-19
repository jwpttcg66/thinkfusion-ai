/** P3-06：CLI 执行/回答的分流；写操作必须审批与 worktree。 */
export type CliIntent = 'answer' | 'execute';

export interface CliExecutionPlan {
  mode: CliIntent;
  ok: boolean;
  reasons: string[];
}

export function planCliExecution(input: {
  intent: CliIntent;
  approved: boolean;
  hasWorktree: boolean;
}): CliExecutionPlan {
  if (input.intent === 'answer') return { mode: 'answer', ok: true, reasons: [] };
  const reasons: string[] = [];
  if (!input.approved) reasons.push('执行需要审批');
  if (!input.hasWorktree) reasons.push('执行需要隔离 worktree');
  return { mode: 'execute', ok: reasons.length === 0, reasons };
}
