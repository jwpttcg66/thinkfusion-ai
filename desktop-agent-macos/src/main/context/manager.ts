/**
 * Context Manager 基础实现（LT-P1-01）。
 *
 * P1 只做“请求前组装 + 预算估算 + Usage 校准”；不裁剪、不摘要、不写检查点。
 * 开关关闭时，调用方不应使用它。
 */

import type {
  BudgetDecision,
  ContextEventPayload,
  ContextEventType,
  ContextManager,
  FinalizeContextInput,
  PrepareContextInput,
  PreparedContext
} from '../../shared/context';
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
}

interface LastContext {
  built: BuiltContext;
  budget: ContextBudgetInput;
  decision: BudgetDecision;
}

export class DefaultContextManager implements ContextManager {
  private readonly estimator: TokenEstimator;
  private readonly last = new Map<string, LastContext>();

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
    const built = buildContext(buildInput);

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

    const estimated = this.estimator.estimateLines(
      [...built.systemLines, ...built.contextLines, built.question],
      input.modelId
    );
    const configLimit = normalized.source === 'config' ? normalized.contextWindow : null;
    const budget = computeContextBudget({
      providerId: input.providerId,
      modelId: input.modelId,
      contextWindow: normalized.source === 'config' ? null : normalized.contextWindow,
      maxOutputTokens: normalized.maxOutputTokens,
      estimatedInputTokens: estimated,
      ...(configLimit !== null ? { configuredInputLimit: configLimit } : {})
    });
    const decision = decideBudget(budget);
    this.last.set(built.contextId, { built, budget, decision });

    if (this.options.onEvent) {
      const owner = input.owner;
      const common: ContextEventPayload = {
        contextId: built.contextId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
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
      includedEventIds: built.includedEventIds,
      retainedEventIds: built.retainedEventIds,
      evidenceRefs: built.evidenceRefs,
      estimatedTokens: estimated,
      contextWindow: normalized.contextWindow,
      compactionStatus: 'not-needed'
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

  async recover(): Promise<PreparedContext | null> {
    return null;
  }

  /** 供调用方/测试读取预算决策；不持久化。 */
  lastBudget(contextId: string): BudgetDecision | null {
    return this.last.get(contextId)?.decision ?? null;
  }
}
