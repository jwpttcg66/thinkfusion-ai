import type { AgentTask } from './contracts';

/**
 * 历史拉取与实时 task.updated 合并：晚到的 getTaskHistory 不得把刚挂上的任务冲掉。
 * 同一 taskId 取 updatedAt 更新的那份。
 */
export function mergeTaskLists(incoming: AgentTask[], existing: AgentTask[]): AgentTask[] {
  const map = new Map<string, AgentTask>();
  for (const task of incoming) map.set(task.taskId, task);
  for (const task of existing) {
    const prev = map.get(task.taskId);
    if (!prev || task.updatedAt >= prev.updatedAt) map.set(task.taskId, task);
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
