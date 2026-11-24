/**
 * 入口上下文策略（LT-P4-02）。
 *
 * 不同入口拿到的历史范围不同；策略本身可解释、可测试。
 * Web/CLI 不在 Context Manager 路径上：它们没有 system，也不能被注入。
 */

import type { ContextHistoryItem } from '../../shared/context';

export type ContextEntry = 'master' | 'collaboration' | 'engineering' | 'debate' | 'web' | 'cli';

export interface ContextScope {
  /** 最多取最近多少条历史；0 表示完全不注入。 */
  maxHistory: number;
  /** 是否允许工具结果进入历史。 */
  includeToolResults: boolean;
  /** 是否允许内部思考进入历史；默认一律不允许。 */
  includeInternalReasoning: boolean;
  /** 是否可以注入 system；Web/CLI 为 false。 */
  systemAllowed: boolean;
  /** Reviewer/Debate 只给目标、证据与待审问题。 */
  evidenceOnly: boolean;
  reason: string;
}

const SCOPES: Record<ContextEntry, ContextScope> = {
  master: {
    maxHistory: 40,
    includeToolResults: true,
    includeInternalReasoning: false,
    systemAllowed: true,
    evidenceOnly: false,
    reason: 'Master 需要目标、参与者、前序回答与必要记忆'
  },
  collaboration: {
    maxHistory: 40,
    includeToolResults: true,
    includeInternalReasoning: false,
    systemAllowed: true,
    evidenceOnly: false,
    reason: 'Collaboration 需要任务目标、依赖、已完成子任务与证据'
  },
  engineering: {
    maxHistory: 60,
    includeToolResults: true,
    includeInternalReasoning: false,
    systemAllowed: true,
    evidenceOnly: false,
    reason: 'Engineering 需要计划、步骤、工具结果、Diff 与验证'
  },
  debate: {
    maxHistory: 20,
    includeToolResults: true,
    includeInternalReasoning: false,
    systemAllowed: true,
    evidenceOnly: true,
    reason: 'Debate/Reviewer 只给目标、证据与待审问题，不给全部内部讨论'
  },
  web: {
    maxHistory: 0,
    includeToolResults: false,
    includeInternalReasoning: false,
    systemAllowed: false,
    evidenceOnly: false,
    reason: 'Web 只收用户原话，不注入 system 或历史'
  },
  cli: {
    maxHistory: 0,
    includeToolResults: false,
    includeInternalReasoning: false,
    systemAllowed: false,
    evidenceOnly: false,
    reason: 'CLI 不伪造 system，不注入历史'
  }
};

export function contextScopeFor(entry: ContextEntry): ContextScope {
  return SCOPES[entry];
}

/**
 * 按策略裁剪历史。只做选择，不改写文本；未配对工具调用始终保留，
 * 由压缩器决定是否跳过。
 */
export function scopeHistory(
  entry: ContextEntry,
  history: readonly ContextHistoryItem[]
): ContextHistoryItem[] {
  const scope = contextScopeFor(entry);
  if (scope.maxHistory === 0) return [];
  const usable = history.filter(item => {
    if (scope.includeInternalReasoning) return true;
    // 历史条目没有 reasoning 字段；这里拦的是调用方误塞的 model/推理文本。
    return !(item.kind === 'model' && /reasoning|思考/i.test(item.text));
  });
  return usable.slice(-scope.maxHistory);
}
