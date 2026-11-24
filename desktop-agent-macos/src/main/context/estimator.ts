/**
 * Token 估算与校准（LT-P1-03）。
 *
 * 这里不联网、不调用 Provider；估算值只用于预警。真实 usage 由 finalize
 * 回报，校准后也只影响估算，不伪装成 Provider 实际值。
 */

export interface TokenEstimate {
  tokens: number;
  /** 本地估算永远是 estimated；真实 usage 由调用方单独保存。 */
  confidence: 'estimated';
}

/**
 * 粗粒度估算：ASCII 约 4 字符/token，非 ASCII（中日韩等）约 1 字符/token。
 * 不做 tokenizer 依赖，误差由真实 usage 校准。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

export function estimateLinesTokens(lines: readonly string[]): number {
  let total = 0;
  for (const line of lines) total += estimateTextTokens(line);
  return total;
}

export class TokenEstimator {
  /** 每个模型的估算系数；actual / estimated，限制在 0.25–4。 */
  private readonly factors = new Map<string, number>();

  estimate(text: string, modelId?: string): TokenEstimate {
    const base = estimateTextTokens(text);
    const factor = modelId ? this.factors.get(modelId) ?? 1 : 1;
    return { tokens: Math.ceil(base * factor), confidence: 'estimated' };
  }

  estimateLines(lines: readonly string[], modelId?: string): number {
    const base = estimateLinesTokens(lines);
    const factor = modelId ? this.factors.get(modelId) ?? 1 : 1;
    return Math.ceil(base * factor);
  }

  /**
   * 用真实 usage 校准；未知 actual 不更新，避免把 null 当成 0。
   * 返回更新后的系数（没有更新时返回当前值）。
   */
  recordUsage(modelId: string, estimated: number, actual: number | null): number {
    const current = this.factors.get(modelId) ?? 1;
    if (actual === null || actual <= 0 || estimated <= 0) return current;
    const sample = actual / estimated;
    const next = Math.min(4, Math.max(0.25, current * 0.5 + sample * 0.5));
    this.factors.set(modelId, next);
    return next;
  }

  factorOf(modelId: string): number {
    return this.factors.get(modelId) ?? 1;
  }
}
