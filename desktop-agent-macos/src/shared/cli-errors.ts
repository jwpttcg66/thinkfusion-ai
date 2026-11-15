/**
 * 外部 CLI 的错误分类。
 *
 * 审核要求至少区分限流 / 额度 / 认证 / 网络 / 超时 / 未知六类，且**不能只靠
 * stderr 文本**。这里按可信度分三层：
 *
 * 1. structured —— CLI 的 JSON 输出（`is_error` / `subtype` / `error.code`），high；
 * 2. structured —— 错误 JSON 的 `result` / `error_message` 正文（Claude Code 真机
 *    429 就把原因写在这里，`subtype` 只有笼统的 error），文本匹配所以是 medium；
 * 3. process    —— 进程自身事实（超时、信号、退出码、spawn 的 errno），high/medium；
 * 4. text       —— stderr 文本匹配，只作兜底，明确标 low 置信度并附命中的片段。
 *
 * `unknown` 不等于「没有错误」：分类不出来就如实写 UNKNOWN_ERROR，不猜一个
 * 好看的名字。成功时返回 null。
 */

export type CliErrorKind =
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'AUTH_FAILED'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'UNKNOWN_ERROR';

export type CliErrorSource = 'structured' | 'process' | 'text';
export type CliErrorConfidence = 'high' | 'medium' | 'low';

export interface CliErrorClassification {
  kind: CliErrorKind;
  source: CliErrorSource;
  confidence: CliErrorConfidence;
  /** 判据原文（已截断）；让人能复核这个类是怎么来的。 */
  evidence: string;
}

export interface CliErrorInput {
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  cancelled?: boolean;
  /** headless 的结构化结果；解析失败时为 null。 */
  parsed?: Record<string, unknown> | null;
  /** stderr 尾部，兜底用。 */
  stderrTail?: string;
  /** spawn 失败时的 errno，例如 ENOENT。 */
  spawnError?: string;
}

function clip(text: string, limit = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/** 把结构化输出里可能藏错误码的字段摊平成一段文本，再看它像哪一类。 */
function structuredEvidence(parsed: Record<string, unknown>): {
  text: string;
  isError: boolean;
  /** CLI 把错误原因写在 result / message 正文里；只在确认是错误时才纳入匹配。 */
  message: string;
} {
  const parts: string[] = [];
  for (const key of ['subtype', 'type', 'error', 'error_message', 'message', 'code', 'status', 'status_code']) {
    const value = parsed[key];
    if (typeof value === 'string' || typeof value === 'number') parts.push(`${key}=${String(value)}`);
  }
  const nested = parsed.error;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    for (const [key, value] of Object.entries(nested)) {
      if (typeof value === 'string' || typeof value === 'number') parts.push(`error.${key}=${String(value)}`);
    }
  }
  const isError =
    parsed.is_error === true ||
    (typeof parsed.subtype === 'string' && /error|fail|denied/i.test(parsed.subtype)) ||
    (typeof parsed.type === 'string' && /error/i.test(parsed.type));
  // 成功结果的正文可能随意提到「rate limit / 429」，绝不能拿去做错误分类。
  const message =
    isError && typeof parsed.result === 'string'
      ? parsed.result
      : isError && typeof parsed.error_message === 'string'
        ? parsed.error_message
        : '';
  return { text: parts.join(' '), isError, message };
}

const RULES: Array<{ kind: CliErrorKind; pattern: RegExp }> = [
  { kind: 'RATE_LIMITED', pattern: /rate.?limit|too many requests|429|throttl/i },
  { kind: 'QUOTA_EXCEEDED', pattern: /quota|insufficient.?credit|billing|out of credits|402|budget.?exceed|额度/i },
  { kind: 'AUTH_FAILED', pattern: /auth|unauthori[sz]ed|invalid.?api.?key|forbidden|401|403|login|not.?logged.?in|token.?invalid|认证|登录/i },
  { kind: 'NETWORK_ERROR', pattern: /network|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket|fetch failed|dns|offline|connection.?refused/i },
  { kind: 'TIMEOUT', pattern: /timed?.?out|ETIMEDOUT|deadline|超时/i }
];

function fromEvidence(text: string, source: CliErrorSource, confidence: CliErrorConfidence): CliErrorClassification | null {
  if (!text) return null;
  for (const rule of RULES) {
    const match = text.match(rule.pattern);
    if (match) return { kind: rule.kind, source, confidence, evidence: clip(`${text} ⟵ ${match[0]}`) };
  }
  return null;
}

export function classifyCliError(input: CliErrorInput): CliErrorClassification | null {
  // 1) 结构化字段优先：CLI 自己说是什么错，比 stderr 文本可靠。
  if (input.parsed) {
    const { text, isError, message } = structuredEvidence(input.parsed);
    const hit = fromEvidence(text, 'structured', 'high');
    if (hit) return hit;
    // Claude Code 真机 429：`subtype` 只有笼统的 error，真正的「usage limit
    // reached / 429」在结构化 result 正文里。它比 stderr 可靠，但靠文本匹配，
    // 所以标 medium，不能冒充 high 的结构化错误码。
    const messageHit = fromEvidence(message, 'structured', 'medium');
    if (messageHit) return messageHit;
    if (isError) {
      // 结构化字段没给出类别时，别急着写死 UNKNOWN_ERROR；stderr 可能还有判据。
      const stderrHit = fromEvidence(input.stderrTail ?? '', 'text', 'low');
      if (stderrHit) return stderrHit;
      return { kind: 'UNKNOWN_ERROR', source: 'structured', confidence: 'high', evidence: clip(text || '结构化输出标记了错误但没有错误码') };
    }
  }

  // 2) 进程事实：超时、被信号终止、spawn 失败都是硬证据。
  if (input.timedOut) return { kind: 'TIMEOUT', source: 'process', confidence: 'high', evidence: '进程执行超过 timeoutMs 被终止' };
  if (input.spawnError) {
    const hit = fromEvidence(input.spawnError, 'process', 'high');
    return hit ?? { kind: 'UNKNOWN_ERROR', source: 'process', confidence: 'high', evidence: clip(input.spawnError) };
  }
  if (input.cancelled) {
    // 用户取消不是错误分类，不占用六类里的任何一类。
    return null;
  }
  if (input.exitCode === null || input.exitCode === 0) {
    if (!input.stderrTail?.trim()) return null;
  }
  if (input.signal) {
    return { kind: 'UNKNOWN_ERROR', source: 'process', confidence: 'high', evidence: clip(`被信号终止：${input.signal}`) };
  }

  // 3) 文本兜底：低置信度、附命中片段，界面/报告要标出来。
  const textHit = fromEvidence(input.stderrTail ?? '', 'text', 'low');
  if (textHit) return textHit;
  if (input.exitCode !== null && input.exitCode !== 0) {
    return { kind: 'UNKNOWN_ERROR', source: 'process', confidence: 'medium', evidence: clip(`非零退出码 ${input.exitCode}，stderr 未给出可识别原因`) };
  }
  return null;
}
