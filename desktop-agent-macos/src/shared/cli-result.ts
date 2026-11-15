/**
 * CLI 结构化结果的解析口径。主进程「重新验证」、Runtime 执行器、真实 CLI E2E
 * 脚本都必须用同一套容错，否则同一个成功的任务会在一处算通过、另一处算失败。
 *
 * 为什么要按行找：Qoder 1.1.89 真机实测会在 JSON 之前先打一行自定义命令
 * 重命名警告（`Custom command '/goal' was renamed ...`）。整段 JSON.parse 会
 * 直接抛错，把 exit 0、result 正常、文件也真的写出来的任务误判为「没有结构化
 * 结果」。Claude 也会往 stdout/stderr 混诊断行。
 *
 * 口径不变：只认对象，且倒序取最后一个完整 JSON 行（CLI 的最终结果行在最后）。
 * 警告、诊断、进度这些非 JSON 行不参与判定，也不会被当成结果。
 */

export type CliResultObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is CliResultObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 从 stdout 里找出 CLI 自己输出的结构化结果；找不到返回 null。 */
export function parseCliResultJson(stdout: string): CliResultObject | null {
  const whole = stdout.trim();
  if (whole) {
    try {
      const parsed = JSON.parse(whole) as unknown;
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // 不是整段 JSON（前面有警告行、后面有诊断行），继续按行找。
    }
  }
  const lines = whole.split('\n').reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isPlainObject(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 是否算「headless 能力实测通过」。
 * 与原有判定逐字一致：能解析、没标 is_error、result 是非空字符串。
 * 只放宽解析，不放宽成功标准——配额/鉴权失败的 JSON 仍然是失败。
 */
export function isStructuredCliSuccess(parsed: CliResultObject | null): boolean {
  if (!parsed) return false;
  if (parsed.is_error === true) return false;
  return typeof parsed.result === 'string' && parsed.result.trim().length > 0;
}
