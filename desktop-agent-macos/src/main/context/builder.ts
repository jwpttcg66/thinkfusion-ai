import { createHash } from 'node:crypto';
import type {
  ContextHistoryItem,
  ContextOwner,
  PrepareContextInput
} from '../../shared/context';
import { contextOwnerKey } from '../../shared/context';

export interface ContextBuildInput extends PrepareContextInput {
  /** 已提交摘要；没有就不拼。 */
  summary?: string;
  /** Memory 召回结果；只进 system，绝不进 question。 */
  memory?: string[];
  /** 最近保留的事件；P1 无压缩时等于 includedEventIds。 */
  retainedEventIds?: string[];
}

export interface BuiltContext {
  contextId: string;
  question: string;
  systemLines: string[];
  contextLines: string[];
  includedEventIds: string[];
  retainedEventIds: string[];
  evidenceRefs: string[];
}

function historyLine(item: ContextHistoryItem): string {
  const who = item.role ? `${item.kind}/${item.role}` : item.kind;
  const where = item.stepId ? ` step=${item.stepId}` : '';
  return `[${who}${where}] ${item.text}`;
}

function stableId(input: ContextBuildInput, systemLines: readonly string[], contextLines: readonly string[]): string {
  const payload = {
    v: 1,
    owner: contextOwnerKey(input.owner),
    runId: input.runId,
    question: input.question,
    systemLines,
    contextLines,
    events: input.history.map(item => item.eventId)
  };
  return `ctx_${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)}`;
}

/**
 * 组装模型输入上下文（纯函数）。
 *
 * 顺序固定：
 * 目标 → 系统/工具契约 → 摘要 → 未压缩历史 → 当前步骤/上下文
 * → Evidence 标记 → Memory（只进 system）→ 当前问题。
 *
 * `question` 原样返回；任何 Memory/摘要都只能出现在 system/contextLines。
 */
export function buildContext(input: ContextBuildInput): BuiltContext {
  const memory = (input.memory ?? []).map(item => item.trim()).filter(Boolean);
  const systemLines = [
    ...input.system,
    ...(memory.length > 0 ? [`[Memory]\n${memory.join('\n')}`] : [])
  ];

  const contextLines = [
    ...(input.summary?.trim() ? [`[摘要]\n${input.summary.trim()}`] : []),
    ...input.history.map(historyLine),
    ...input.context
  ];

  const includedEventIds = input.history.map(item => item.eventId);
  const retainedEventIds = input.retainedEventIds ?? includedEventIds;

  return {
    contextId: stableId(input, systemLines, contextLines),
    question: input.question,
    systemLines,
    contextLines,
    includedEventIds,
    retainedEventIds,
    evidenceRefs: [...input.evidenceRefs]
  };
}

/** 给测试/调用方一个稳定的 owner 身份；不参与安全判断。 */
export function ownerIdentity(owner: ContextOwner): string {
  return contextOwnerKey(owner);
}
