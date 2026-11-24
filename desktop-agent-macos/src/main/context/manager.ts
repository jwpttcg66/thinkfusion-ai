/**
 * Context Manager 基础实现（LT-P1-01）。
 *
 * P1 只做“请求前组装 + 预算估算 + Usage 校准”；不裁剪、不摘要、不写检查点。
 * 开关关闭时，调用方不应使用它。
 */

import type {
  BudgetDecision,
  ContextBudget,
  ContextEventPayload,
  ContextEventType,
  ContextHistoryItem,
  ContextManager,
  ContextSummary,
  FinalizeContextInput,
  PrepareContextInput,
  PreparedContext
} from '../../shared/context';
import { contextOwnerKey } from '../../shared/context';
import { buildContext, type BuiltContext, type ContextBuildInput } from './builder';
import { decideBudget, computeContextBudget, type ContextBudgetInput } from './budget';
import { TokenEstimator } from './estimator';
import {
  providerContextCapability,
  type ProviderContextInput
} from './adapters/provider-context';

export interface ContextManagerOptions {
  estimator?: TokenEstimator;
  /**
   * Provider 能力来源。P1 由调用方注入；P1-05 只归一化，不探测 Provider。
   */
  capabilityOf?: (input: PrepareContextInput) => ProviderContextInput | null;
  /** 额外上下文（摘要/记忆）由调用方提供；Memory 只进 system。 */
  extrasOf?: (input: PrepareContextInput) => {
    summary?: string;
    memory?: string[];
    retainedEventIds?: string[];
  };
  /** 上下文事件回调；由主进程转成持久化 AgentEvent。 */
  onEvent?: (input: {
    type: ContextEventType;
    owner: PrepareContextInput['owner'];
    runId: string;
    payload: ContextEventPayload;
  }) => void;
  /**
   * LT-P3/P5：摘要与检查点提交。
   *
   * 不注入时只组装不压缩（P1 行为）。摘要失败/校验失败/提交失败都保留
   * 未压缩上下文，不把半成品摘要送进模型。
   */
  compaction?: {
    /** 历史超过这个条数就尝试压缩；默认 24。 */
    triggerAfter?: number;
    /** 最近多少条不压缩；默认 8。 */
    retainRecent?: number;
    summarize: (input: {
      owner: PrepareContextInput['owner'];
      runId: string;
      history: ContextHistoryItem[];
      evidenceRefs: string[];
      modelId: string;
    }) => Promise<{
      summary: ContextSummary;
      summaryHash: string;
      sourceEventIds: string[];
      modelId: string;
    }>;
    commit: (input: {
      owner: PrepareContextInput['owner'];
      runId: string;
      contextId: string;
      history: readonly ContextHistoryItem[];
      /** 压缩后保留在模型输入里的最近事件；检查点按它记录。 */
      retainedEventIds: string[];
      summary: ContextSummary;
      summaryHash: string;
      modelId: string;
      inputTokensBefore: number;
    }) => Promise<{
      checkpointId: string;
      retainedEventIds?: string[];
      /** true 表示提交方已把 committed 事件与指针一起持久化，Manager 不再重复发。 */
      eventPersisted?: boolean;
    } | null>;
  };
  /** LT-P5-03：按 Journal 活动指针恢复；未注入时返回 null。 */
  recover?: (input: { owner: PrepareContextInput['owner']; runId: string }) => Promise<PreparedContext | null>;
}

interface LastContext {
  built: BuiltContext;
  budget: ContextBudgetInput;
  decision: BudgetDecision;
}

export class DefaultContextManager implements ContextManager {
  private readonly estimator: TokenEstimator;
  private readonly last = new Map<string, LastContext>();
  /** 上次成功压缩时的历史条数；避免每个请求都重复摘要旧历史。 */
  private readonly compactedAt = new Map<string, number>();

  constructor(private readonly options: ContextManagerOptions = {}) {
    this.estimator = options.estimator ?? new TokenEstimator();
  }

  async prepare(input: PrepareContextInput): Promise<{
    context: PreparedContext;
    question: string;
    contextLines: string[];
    systemLines: string[];
  }> {
    const extras = this.options.extrasOf?.(input) ?? {};
    const buildInput: ContextBuildInput = {
      ...input,
      ...(extras.summary ? { summary: extras.summary } : {}),
      ...(extras.memory && extras.memory.length > 0 ? { memory: extras.memory } : {}),
      ...(extras.retainedEventIds ? { retainedEventIds: extras.retainedEventIds } : {})
    };
    let built = buildContext(buildInput);

    const capability = this.options.capabilityOf
      ? this.options.capabilityOf(input)
      : null;
    const normalized = capability
      ? providerContextCapability(capability)
      : providerContextCapability({
          providerId: input.providerId,
          modelId: input.modelId,
          source: 'unknown'
        });

    const configLimit = normalized.source === 'config' ? normalized.contextWindow : null;
    const budgetFor = (tokens: number): ContextBudget => computeContextBudget({
      providerId: input.providerId,
      modelId: input.modelId,
      contextWindow: normalized.source === 'config' ? null : normalized.contextWindow,
      maxOutputTokens: normalized.maxOutputTokens,
      estimatedInputTokens: tokens,
      ...(configLimit !== null ? { configuredInputLimit: configLimit } : {})
    });

    let estimated = this.estimator.estimateLines(
      [...built.systemLines, ...built.contextLines, built.question],
      input.modelId
    );
    let budget = budgetFor(estimated);
    let decision = decideBudget(budget);
    let compactionStatus: PreparedContext['compactionStatus'] = 'not-needed';
    let checkpointId: string | undefined;

    const compaction = this.options.compaction;
    const compactionKey = `${contextOwnerKey(input.owner)}:${input.runId}`;
    const grownSinceCompaction = input.history.length - (this.compactedAt.get(compactionKey) ?? 0);
    const wantsCompaction = Boolean(compaction) && (
      (input.history.length > (compaction?.triggerAfter ?? 24)
        && grownSinceCompaction >= (compaction?.retainRecent ?? 8))
      || decision.level === 'compaction'
      || decision.level === 'overflow'
    );
    if (compaction && wantsCompaction) {
      const retainRecent = Math.max(1, compaction.retainRecent ?? 8);
      const head = input.history.slice(0, Math.max(0, input.history.length - retainRecent));
      const tail = input.history.slice(Math.max(0, input.history.length - retainRecent));
      // 未配对工具调用不压缩：它们的调用/结果还没成对，压掉就查不回去了。
      const paired = (item: ContextHistoryItem) => item.kind !== 'tool' || Boolean(item.toolCallId);
      const compressible = head.filter(paired);
      const unpaired = head.filter(item => !paired(item));
      if (compressible.length >= 4) {
        const owner = input.owner;
        this.options.onEvent?.({
          type: 'context.compaction.started',
          owner,
          runId: input.runId,
          payload: {
            contextId: built.contextId,
            ownerType: owner.ownerType,
            ownerId: owner.ownerId,
            estimatedTokens: estimated,
            sourceEventIdsPreview: compressible.slice(0, 20).map(item => item.eventId)
          }
        });
        try {
          const summarized = await compaction.summarize({
            owner,
            runId: input.runId,
            history: compressible,
            evidenceRefs: input.evidenceRefs,
            modelId: input.modelId
          });
          this.options.onEvent?.({
            type: 'context.compaction.summary.ready',
            owner,
            runId: input.runId,
            payload: {
              contextId: built.contextId,
              ownerType: owner.ownerType,
              ownerId: owner.ownerId,
              modelId: summarized.modelId,
              reason: summarized.summaryHash,
              sourceEventIdsPreview: summarized.sourceEventIds.slice(0, 20)
            }
          });
          const committed = await compaction.commit({
            owner,
            runId: input.runId,
            contextId: built.contextId,
            history: compressible,
            retainedEventIds: [...unpaired, ...tail].map(item => item.eventId),
            summary: summarized.summary,
            summaryHash: summarized.summaryHash,
            modelId: summarized.modelId,
            inputTokensBefore: estimated
          });
          if (!committed) throw new Error('检查点未提交');
          checkpointId = committed.checkpointId;
          const kept = [...unpaired, ...tail];
          const tokensBefore = estimated;
          built = buildContext({
            ...buildInput,
            history: kept,
            summary: JSON.stringify(summarized.summary, null, 2),
            retainedEventIds: kept.map(item => item.eventId)
          });
          estimated = this.estimator.estimateLines(
            [...built.systemLines, ...built.contextLines, built.question],
            input.modelId
          );
          budget = budgetFor(estimated);
          decision = decideBudget(budget);
          compactionStatus = 'committed';
          this.compactedAt.set(compactionKey, input.history.length);
          if (!committed.eventPersisted) {
            this.options.onEvent?.({
              type: 'context.compaction.committed',
              owner,
              runId: input.runId,
              payload: {
                contextId: built.contextId,
                checkpointId,
                ownerType: owner.ownerType,
                ownerId: owner.ownerId,
                modelId: summarized.modelId,
                inputTokensBefore: tokensBefore,
                inputTokensAfter: estimated,
                sourceEventIdsPreview: summarized.sourceEventIds.slice(0, 20)
              }
            });
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.options.onEvent?.({
            type: 'context.compaction.failed',
            owner,
            runId: input.runId,
            payload: {
              contextId: built.contextId,
              ownerType: owner.ownerType,
              ownerId: owner.ownerId,
              reason
            }
          });
          // 摘要失败/校验失败/提交失败：保留未压缩上下文，不阻塞请求。
          compactionStatus = 'failed';
        }
      }
    }

    this.last.set(built.contextId, { built, budget, decision });

    if (this.options.onEvent) {
      const owner = input.owner;
      const common: ContextEventPayload = {
        contextId: built.contextId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        ...(checkpointId ? { checkpointId } : {}),
        estimatedTokens: estimated,
        contextWindow: normalized.contextWindow,
        usageRatio: decision.usageRatio,
        level: decision.level
      };
      this.options.onEvent({
        type: 'context.prepared',
        owner,
        runId: input.runId,
        payload: common
      });
      if (decision.level !== 'normal') {
        this.options.onEvent({
          type: 'context.budget.warning',
          owner,
          runId: input.runId,
          payload: common
        });
      }
    }

    const context: PreparedContext = {
      contextId: built.contextId,
      owner: input.owner,
      ...(input.owner.ownerType === 'agent-task'
        ? { taskId: input.owner.taskId }
        : { conversationId: input.owner.conversationId }),
      runId: input.runId,
      ...(checkpointId ? { checkpointId } : {}),
      includedEventIds: built.includedEventIds,
      retainedEventIds: built.retainedEventIds,
      evidenceRefs: built.evidenceRefs,
      estimatedTokens: estimated,
      contextWindow: normalized.contextWindow,
      compactionStatus
    };

    return {
      context,
      question: built.question,
      contextLines: built.contextLines,
      systemLines: built.systemLines
    };
  }

  async finalize(input: FinalizeContextInput): Promise<void> {
    const record = this.last.get(input.contextId);
    if (!record) return;
    const actual = input.usage?.inputTokens ?? null;
    record.budget.actualInputTokens = actual;
    if (actual !== null && actual > 0) {
      this.estimator.recordUsage(input.modelId, record.budget.estimatedInputTokens, actual);
    }
  }

  async recover(input: { owner: PrepareContextInput['owner']; runId: string }): Promise<PreparedContext | null> {
    if (!this.options.recover) return null;
    return this.options.recover(input);
  }

  /** 供调用方/测试读取预算决策；不持久化。 */
  lastBudget(contextId: string): BudgetDecision | null {
    return this.last.get(contextId)?.decision ?? null;
  }
}
