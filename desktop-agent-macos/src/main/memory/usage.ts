/**
 * 送达证据：L2 计算、状态判定、落库。
 *
 * 为什么 L2 必须在调用点算、L3 必须在适配器算：
 * - L2 证明"应用把这段内容交给了 Provider 调用层"；
 * - L3 证明"适配器自己拼装的 messages 里确实有这段"；
 * - 把 L3 做成"把入参哈希回传"很容易，而且看不出区别——所以判据里
 *   专门有一条守门测试：声明支持却丢掉 system 的 Provider 必须判 failed。
 *
 * 三者相等只是"拼装并提交"的证据，不是"模型用了记忆"（§1.3）。
 */

import { judgeInjection, memoryBlockFromSystem, type InjectionStatus, type MemoryUsageEvent } from '../../shared/memory';
import { sha256Hex } from '../../shared/sha256';
import type { MemoryStore } from './store';

export interface PendingInjection {
  requestId: string;
  conversationId: string;
  taskId?: string;
  participantId?: string;
  providerId?: string;
  modelId?: string;
  memoryIds: string[];
  contextHash: string;
  injectionPoint: string;
  /** skipped 时直接给出；注入时先记 injected，等 Provider 回来再判级。 */
  status: InjectionStatus;
  skipReason?: string;
  charCount: number;
  timestamp: number;
  /** attach 之后即将发送的 system；用于 L2。 */
  system: string[];
}

/**
 * L2：从即将发送的 `task.system` 里**重新抽出记忆块**再算哈希。
 *
 * 不是 `sha256(整个 system)`，也不是把 L1 回显：L1 是 `sha256(renderedText)`，
 * 只有抽出同一个块，三处哈希才可能相等；而「抽不出来」正是 Provider 丢了
 * system 的信号，判据会据此给 `failed/provider-capability`。
 */
export function submittedSystemHash(system: readonly string[] | undefined): string | undefined {
  const block = memoryBlockFromSystem(system);
  return block === undefined ? undefined : sha256Hex(block);
}

export interface FinalizeInput {
  pending: PendingInjection;
  /** Provider 适配器从 assembled messages 反抽出的 L3。 */
  providerSystemHash?: string;
  supportsSystemHash?: boolean;
  providerId?: string;
  modelId?: string;
  error?: string;
}

/** 判定 + 组装落库事件。不写库，纯函数，方便守门测试直接断言。 */
export function finalizeUsage(input: FinalizeInput): MemoryUsageEvent {
  const { pending } = input;
  if (pending.status === 'skipped') {
    return {
      requestId: pending.requestId,
      conversationId: pending.conversationId,
      ...(pending.taskId ? { taskId: pending.taskId } : {}),
      ...(pending.participantId ? { participantId: pending.participantId } : {}),
      memoryIds: [],
      contextHash: pending.contextHash,
      injectionPoint: pending.injectionPoint,
      status: 'skipped',
      providerConfirmed: false,
      ...(pending.skipReason ? { skipReason: pending.skipReason } : {}),
      charCount: 0,
      timestamp: pending.timestamp
    };
  }

  const submitted = submittedSystemHash(pending.system);
  const judgement = judgeInjection({
    ...(submitted ? { submittedSystemHash: submitted } : {}),
    ...(input.providerSystemHash ? { providerSystemHash: input.providerSystemHash } : {}),
    contextHash: pending.contextHash,
    ...(input.supportsSystemHash === undefined ? {} : { supportsSystemHash: input.supportsSystemHash }),
    ...(input.error ? { error: input.error } : {})
  });

  return {
    requestId: pending.requestId,
    conversationId: pending.conversationId,
    ...(pending.taskId ? { taskId: pending.taskId } : {}),
    ...(pending.participantId ? { participantId: pending.participantId } : {}),
    ...(input.providerId ?? pending.providerId ? { providerId: input.providerId ?? pending.providerId } : {}),
    ...(input.modelId ?? pending.modelId ? { modelId: input.modelId ?? pending.modelId } : {}),
    memoryIds: pending.memoryIds,
    contextHash: pending.contextHash,
    ...(submitted ? { submittedSystemHash: submitted } : {}),
    ...(input.providerSystemHash ? { providerSystemHash: input.providerSystemHash } : {}),
    injectionPoint: pending.injectionPoint,
    status: judgement.status,
    providerConfirmed: judgement.providerConfirmed,
    charCount: pending.charCount,
    timestamp: pending.timestamp
  };
}

/** 落库失败不影响回答：记忆是旁路，不能把主链路带下去。 */
export function recordUsage(
  store: Pick<MemoryStore, 'upsertUsage'>,
  event: MemoryUsageEvent,
  contextId?: string
): void {
  try {
    store.upsertUsage(event, contextId);
  } catch {
    // 审计本身失败没有第二处可报；调用方（service）会在 status 里体现 degraded。
  }
}
