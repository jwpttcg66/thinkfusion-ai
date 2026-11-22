/**
 * `attachMemory()`：四个模型请求入口共用的**唯一**注入点。
 *
 * 硬约束（`docs/spec/GLOBAL_MEMORY.md` §1、§4.3）：
 * - 只改 `SubAgentTask.system`，`question` 一个字节都不动；
 * - 网页与 CLI 一律不注入，但要留下可观测的 `skipped` 记录；
 * - 关闭记忆后四入口的 system 都没有记忆块；
 * - 没有召回结果就宁可空，不为了填满预算塞低相关记忆。
 *
 * 请求身份 `requestId` 在这里生成或沿用 task 上已冻结的值，并同时写回
 * `task.requestId`，使 answer / trace.callId / usage 三处同值。
 */

import {
  MEMORY_DEFAULTS,
  memoryRequestId,
  type MemoryContext,
  type MemoryScope,
  type MemorySettings,
  type MemoryUsageEvent
} from '../../shared/memory';
import type { SubAgentAnswer, SubAgentTask } from '../agents/types';
import { attachSystemText, buildMemoryContext } from './context';
import { recallMemories } from './recall';
import { finalizeUsage, recordUsage, type PendingInjection } from './usage';
import type { RecallResult } from './types';
import type { MemoryStore } from './store';

export type MemorySourceType = 'web' | 'local' | 'cloud' | 'cli';

export interface AttachDeps {
  store: Pick<MemoryStore, 'allForScopes' | 'upsertUsage'>;
  settings: MemorySettings;
  /** 这一问发给哪类来源。网页 / CLI 永远 skipped。 */
  sourceType: MemorySourceType;
  agentId: string;
  providerId?: string;
  modelId?: string;
  now?: () => number;
  /** 单调递增序号，用于 requestId；缺省用模块内计数。 */
  seq?: () => number;
}

export interface AttachResult {
  /** 注入后的任务。`question` 与入参逐字相同。 */
  task: SubAgentTask;
  pending: PendingInjection;
  context?: MemoryContext;
  recall?: RecallResult;
}

let fallbackSeq = 0;

function skipReasonFor(deps: AttachDeps): string | undefined {
  if (!deps.settings.enabled || !deps.settings.inject) return 'memory-disabled';
  if (deps.sourceType === 'web') return 'web-verbatim';
  if (deps.sourceType === 'cli') return 'cli-no-system-turn';
  return undefined;
}

/**
 * 在真正调用 `agent.ask(task)` **之前**调用。
 *
 * 返回值里的 `task` 必须直接用于发问；`pending` 留给
 * `finalizeInjection()` 在回答回来后收口。
 */
export function attachMemory(task: SubAgentTask, deps: AttachDeps): AttachResult {
  const now = deps.now ?? Date.now;
  const scope = task.memory;
  const injectionPoint = scope?.injectionPoint ?? 'unknown';
  const conversationId = scope?.conversationId ?? '';
  const requestId =
    scope?.requestId ??
    task.requestId ??
    memoryRequestId(scope?.turn ?? 0, deps.agentId, deps.seq ? deps.seq() : ++fallbackSeq);

  const skipReason = skipReasonFor(deps);
  const pendingBase = {
    requestId,
    conversationId,
    ...(scope?.taskId ? { taskId: scope.taskId } : {}),
    ...(deps.providerId ? { providerId: deps.providerId } : {}),
    ...(deps.modelId ? { modelId: deps.modelId } : {}),
    injectionPoint,
    charCount: 0,
    timestamp: now()
  };

  // 没有 memory scope 的老调用方零影响：不召回、不注入，也不写使用记录。
  if (!scope) {
    const pending: PendingInjection = {
      ...pendingBase,
      memoryIds: [],
      contextHash: '',
      status: 'skipped',
      skipReason: 'no-memory-scope',
      system: [...(task.system ?? [])]
    };
    return { task, pending };
  }

  const skipped = (reason: string): AttachResult => {
    const pending: PendingInjection = {
      ...pendingBase,
      memoryIds: [],
      contextHash: '',
      status: 'skipped',
      skipReason: reason,
      system: [...(task.system ?? [])]
    };
    // skipped 没有"Provider 回来再判级"这一步，这里直接落库，保证 Web/CLI/关闭
    // 三种边界都能在轨迹里被看到（MEM-07 / MEM-12）。
    recordUsage(deps.store, finalizeUsage({ pending }));
    return { task: { ...task, requestId }, pending };
  };

  if (skipReason) return skipped(skipReason);

  const projectId = scope.projectId;
  const workspaceId = scope.workspaceId;
  const scopes: Array<{ scope: MemoryScope; scopeId: string }> = [{ scope: 'GLOBAL', scopeId: '' }];
  if (projectId) scopes.push({ scope: 'PROJECT', scopeId: projectId });
  if (workspaceId) scopes.push({ scope: 'WORKSPACE', scopeId: workspaceId });

  let candidates: ReturnType<MemoryStore['allForScopes']>;
  try {
    candidates = deps.store.allForScopes(scopes, 2000);
  } catch {
    // 记忆库打不开是 degraded：回答照常，不注入，也不把主链路带下去。
    return skipped('memory-store-degraded');
  }

  const settings = { ...MEMORY_DEFAULTS, ...deps.settings };
  const recall = recallMemories(
    candidates,
    {
      question: task.question,
      conversationId,
      ...(projectId ? { projectId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(scope.headCommit ? { headCommit: scope.headCommit } : {}),
      now: now()
    },
    {
      threshold: settings.minScore,
      maxRecords: settings.maxRecords,
      now: now()
    }
  );

  const context = buildMemoryContext({
    requestId,
    conversationId,
    ...(workspaceId ? { workspaceId } : {}),
    ...(projectId ? { projectId } : {}),
    records: recall.included,
    omitted: recall.omitted,
    budgetChars: settings.budgetChars,
    maxRecords: settings.maxRecords,
    injectionPoint
  });

  if (!context.renderedText.trim() || context.includedMemoryIds.length === 0) {
    return skipped('no-recall');
  }

  const system = attachSystemText(task.system, context.renderedText, {
    overrideLine: scope.overrideLine
  });
  const pending: PendingInjection = {
    ...pendingBase,
    memoryIds: context.includedMemoryIds,
    contextHash: context.contextHash,
    status: 'injected',
    charCount: context.renderedText.length,
    system
  };

  return {
    task: { ...task, requestId, system },
    pending,
    context,
    recall
  };
}

export interface FinalizeDeps {
  store: Pick<MemoryStore, 'upsertUsage'>;
  providerId?: string;
  modelId?: string;
  /** Provider 抛错时由调用方传进来。 */
  error?: string;
}

/**
 * 回答回来后收口：从 `answer.systemHash`（L3）+ `supportsSystemHash` 判级并落库。
 *
 * L3 由 Provider 适配器从它自己拼好的 messages 反抽算出，不是把 L1 回显；
 * `judgeInjection` 是唯一判据，这里不重复判定逻辑。
 */
export function finalizeInjection(
  pending: PendingInjection,
  answer: Pick<SubAgentAnswer, 'systemHash' | 'supportsSystemHash'> | undefined,
  deps: FinalizeDeps
): MemoryUsageEvent {
  if (pending.status === 'skipped') {
    // attachMemory 里已经落过库，不重复写。
    return finalizeUsage({ pending });
  }
  const event = finalizeUsage({
    pending,
    ...(answer?.systemHash ? { providerSystemHash: answer.systemHash } : {}),
    supportsSystemHash: answer?.supportsSystemHash ?? false,
    ...(deps.providerId ?? pending.providerId ? { providerId: deps.providerId ?? pending.providerId } : {}),
    ...(deps.modelId ?? pending.modelId ? { modelId: deps.modelId ?? pending.modelId } : {}),
    ...(deps.error ? { error: deps.error } : {})
  });
  recordUsage(deps.store, event, event.requestId);
  return event;
}
