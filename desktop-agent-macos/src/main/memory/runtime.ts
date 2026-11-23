/**
 * 主进程记忆运行时：单例 + 四入口共用的 hook。
 *
 * 为什么要集中到这里：四个入口（Master / Collaboration / Engineering / Debate）
 * 各自构造 `SubAgentTask`，如果每处都自己写召回、requestId、落库，很快就会漂移。
 * 这里只暴露 `attachTaskMemory()`：没装记忆服务、或这一问没带 scope 时返回
 * 原任务 + 空 finalize，老调用方零影响。
 *
 * 注意：**不改 `question`**。网页通道拿到的仍是逐字原话；记忆只加在 system 上，
 * 且网页/CLI 一律走 `skipped`（`attachMemory` 内判定）。
 */

import type { MemoryTaskScope, SubAgentAnswer, SubAgentTask } from '../agents/types';
import type { AttachExtra, MemoryService } from './service';
import type { PendingInjection } from './usage';

let current: MemoryService | null = null;

export function setMemoryService(service: MemoryService | null): void {
  current = service;
}

export function getMemoryService(): MemoryService | null {
  return current;
}

export interface MemoryScopeContext {
  conversationId: string;
  /** 落库用：master-agent / collaboration / engineering / debate。 */
  injectionPoint: string;
  workspaceId?: string;
  projectId?: string;
  turn?: number;
  taskId?: string;
  headCommit?: string;
  /** 工程/辩论：追加「记忆不是证据」覆盖句。 */
  overrideLine?: boolean;
}

export function buildMemoryScope(ctx: MemoryScopeContext): MemoryTaskScope {
  return {
    conversationId: ctx.conversationId,
    injectionPoint: ctx.injectionPoint,
    ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    ...(ctx.turn === undefined ? {} : { turn: ctx.turn }),
    ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
    ...(ctx.headCommit ? { headCommit: ctx.headCommit } : {}),
    ...(ctx.overrideLine ? { overrideLine: true } : {})
  };
}

export interface MemoryHook {
  /** 直接用于发问的任务；question 与入参逐字相同。 */
  task: SubAgentTask;
  pending: PendingInjection | null;
  /** 回答回来后调用；传 error 表示 Provider 抛错。 */
  finalize(answer?: SubAgentAnswer, error?: string): void;
}

const NOOP_HOOK = (task: SubAgentTask): MemoryHook => ({ task, pending: null, finalize: () => undefined });

/**
 * 在 `agent.ask(task)` / `askStreaming(...)` **之前**调用。
 *
 * `extra.sourceType` 必须由入口按 agent 真实来源填：网页 `web`、本地 `local`、
 * 云端 `cloud`、CLI `cli`。写错会让网页被隐式注入——这是不能让步的边界。
 */
/**
 * 池层兜底：入口只把 `memory` 挂在 task 上，由 pool 统一 attach / finalize。
 *
 * 这样 `SubAgentPool.ask / askStream` 一处收口就能覆盖 Collaboration、
 * Engineering、Debate 三条链路（它们都经过 pool），不用每个入口各写一遍。
 * 网页 / CLI 的判定仍在 `attachMemory` 内按 `sourceType` 做，池层不猜。
 */
export function attachFromTask(task: SubAgentTask, extra: AttachExtra): MemoryHook {
  const scope = task.memory;
  if (process.env.TF_MEM_DEBUG) {
    console.log('[mem] attachFromTask', extra.agentId, extra.sourceType, scope?.conversationId ?? 'NO-SCOPE', current ? 'svc' : 'NO-SVC');
  }
  if (!scope || !scope.conversationId) return NOOP_HOOK(task);
  return attachTaskMemory(task, extra, {
    conversationId: scope.conversationId,
    injectionPoint: scope.injectionPoint ?? 'unknown',
    ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
    ...(scope.turn === undefined ? {} : { turn: scope.turn }),
    ...(scope.taskId ? { taskId: scope.taskId } : {}),
    ...(scope.headCommit ? { headCommit: scope.headCommit } : {}),
    ...(scope.overrideLine ? { overrideLine: true } : {})
  });
}

export function attachTaskMemory(
  task: SubAgentTask,
  extra: AttachExtra,
  scope: MemoryScopeContext
): MemoryHook {
  const service = current;
  if (!service || !scope.conversationId) return NOOP_HOOK(task);

  const withScope: SubAgentTask = { ...task, memory: buildMemoryScope(scope) };
  const result = service.attach(withScope, extra);
  return {
    task: result.task,
    pending: result.pending,
    finalize: (answer, error) => {
      service.finalize(result.pending, answer, {
        ...(answer?.providerId ? { providerId: answer.providerId } : {}),
        ...(answer?.modelId ? { modelId: answer.modelId } : {}),
        ...(error ? { error } : {})
      });
    }
  };
}
