/**
 * 确定性工具结果裁剪（LT-P2-02）。
 *
 * 不调用模型，不删除原始存储；只生成用于模型输入的精简文本，
 * 原文位置放在 resultRef。
 */

import type { ToolHistoryEntry } from '../adapters/tool-history';

export interface PruneOptions {
  /** 单条结果最大字符数；超过保留头尾。 */
  maxResultChars?: number;
  /** 失败/未完成调用至少保留错误信息。 */
  keepErrors?: boolean;
}

export interface PrunedToolHistoryEntry extends ToolHistoryEntry {
  /** 这条是否被裁剪过；原始 resultRef 仍在。 */
  pruned?: boolean;
  /** 裁剪说明，给 UI/跟踪用。 */
  pruneReason?: string;
}

const DEFAULT_MAX_RESULT_CHARS = 4_000;

function headTail(value: string, max: number, ref: string): { text: string; reason: string } {
  if (value.length <= max) return { text: value, reason: '' };
  const half = Math.max(120, Math.floor(max / 2));
  const head = value.slice(0, half);
  const tail = value.slice(Math.max(0, value.length - half));
  return {
    text: `${head}\n…（原始 ${String(value.length)} 字符已裁剪，完整内容见 ${ref}）…\n${tail}`,
    reason: `原始 ${String(value.length)} 字符，裁剪到 ${String(max)}`
  };
}

/**
 * 裁剪规则：
 * - running/unknown 不裁（调用还没结束，避免破坏配对）；
 * - failed 保留错误，结果文本可裁；
 * - completed 大结果保留头尾，原文由 resultRef 指向；
 * - evidenceRefs 永远保留。
 */
export function pruneToolHistory(
  entries: readonly ToolHistoryEntry[],
  options: PruneOptions = {}
): PrunedToolHistoryEntry[] {
  const max = Math.max(200, options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS);
  return entries.map(entry => {
    if (entry.status === 'running' || entry.status === 'unknown') {
      return { ...entry, evidenceRefs: [...entry.evidenceRefs] };
    }
    const result = entry.resultText ?? '';
    if (!result || result.length <= max) {
      return { ...entry, evidenceRefs: [...entry.evidenceRefs] };
    }
    const clipped = headTail(result, max, entry.resultRef ?? entry.key);
    return {
      ...entry,
      resultText: clipped.text,
      evidenceRefs: [...entry.evidenceRefs],
      pruned: true,
      pruneReason: clipped.reason
    };
  });
}

/** 给测试/调用方的稳定 key；不参与安全判断。 */
export function toolHistoryKey(entry: ToolHistoryEntry): string {
  return entry.key;
}
