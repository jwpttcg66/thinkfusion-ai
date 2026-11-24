/**
 * SubAgentTask 上下文准备（LT-P4-01）。
 *
 * 只在 task.contextState 存在时工作；没有时返回 null，调用方保持原行为。
 * 不修改原始 question；Memory/摘要只进 system/context。
 */

import type { SubAgentAnswer, SubAgentTask } from '../../agents/types';
import type { ContextManager, PreparedContext } from '../../../shared/context';

export interface PreparedSubAgentTask {
  task: SubAgentTask;
  contextId: string;
  context: PreparedContext;
  manager: ContextManager;
}

export async function prepareSubAgentTask(
  task: SubAgentTask,
  meta: { providerId: string; modelId: string }
): Promise<PreparedSubAgentTask | null> {
  const state = task.contextState;
  if (!state) return null;
  const prepared = await state.manager.prepare({
    owner: state.owner,
    ...(state.owner.ownerType === 'agent-task'
      ? { taskId: state.owner.taskId }
      : { conversationId: state.owner.conversationId }),
    runId: state.runId,
    question: task.question,
    context: task.context ?? [],
    system: task.system ?? [],
    history: state.history ?? [],
    evidenceRefs: state.evidenceRefs ?? [],
    providerId: meta.providerId,
    modelId: meta.modelId
  });
  return {
    task: {
      ...task,
      question: prepared.question,
      context: prepared.contextLines,
      system: prepared.systemLines,
      contextState: undefined
    },
    contextId: prepared.context.contextId,
    context: prepared.context,
    manager: state.manager
  };
}

/** 用真实 usage 校准；answer 没有 usage 时传 null，不写 0。 */
export async function finalizeSubAgentTask(
  prepared: PreparedSubAgentTask,
  answer: SubAgentAnswer,
  meta: { providerId: string; modelId: string }
): Promise<void> {
  const owner = prepared.context.owner;
  const runId = prepared.context.runId;
  await prepared.manager.finalize({
    contextId: prepared.contextId,
    owner,
    runId,
    usage: answer.usage ?? null,
    providerId: meta.providerId,
    modelId: meta.modelId
  });
}
