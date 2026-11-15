/**
 * 敏感信息脱敏：**所有要落盘或要给用户看的文本，先过这一层。**
 *
 * 为什么单独一个文件、放在 shared：终端审计（Runtime）、审批卡（主进程 →
 * 渲染层）、CLI 执行报告三处都要用，而且规则必须完全一致。以前一处都不脱敏，
 * `ANTHROPIC_API_KEY` 又能通过 `envAllowlist` 透传给 CLI，一旦把 stdin/stderr
 * 写进 JSONL，Key 就有真实的落盘路径。所以顺序是「脱敏 → 写盘」，不能反过来。
 *
 * 三条边界：
 *
 * 1. **只换内容，不动事件结构。** 回放要靠顺序和 sequence，脱敏不能吞掉事件、
 *    不能合并事件、不能改变相对顺序。
 * 2. **保守替换。** 宁可少遮一点，也不要把 `skill`、`skim` 这类正常词整段毁掉——
 *    因此 token 至少要够长，且必须成词。
 * 3. **留痕。** 遮掉的地方写 `[REDACTED:…]`，看日志的人知道这里原本有东西，
 *    不会误以为输出本来就是空的。
 */

const REDACTED = '[REDACTED]';

/** 私钥块：整段换成一行，避免多行 PEM 把 JSONL 的事件结构搅乱……其实 JSONL 里是转义的，但人读更清楚。 */
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** 已知厂商的 Key 前缀；至少 12 个字符才算，避免误伤 `sk` 这种普通缩写。 */
const KEY_LITERALS = [
  /\boc_sk_[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgsk_[A-Za-z0-9_-]{12,}\b/g,
  /\bxai-[A-Za-z0-9_-]{12,}\b/g,
  /\bhf_[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g
];

/** `NAME=value` / `"name": "value"` / `name: value`，只遮值不遮名。 */
const SECRET_ASSIGNMENTS =
  /((?:ANTHROPIC|OPENAI|OPENCODE|GROQ|QODER|CLAUDE|GEMINI|DEEPSEEK|MOONSHOT|XAI|API|ACCESS|REFRESH|SESSION|TOKEN|AUTH|SECRET|PASSWORD|PRIVATE)[A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET)?\s*["']?\s*[:=]\s*["']?)([^\s"',;}\]\)&\uE000-\uE001]{6,})/gi;

/** URL query 里的凭据参数；`&` 之后的其他参数必须原样保留。 */
const SECRET_QUERY = /([?&](?:api_key|access_token|refresh_token|token|key|secret)=)([^&\s"'\uE000-\uE001]{4,})/gi;

/** `Authorization: Bearer xxx` / `x-api-key: xxx` 这类头。 */
const AUTH_HEADERS = /\b(Bearer\s+)([A-Za-z0-9._-]{8,})/g;
const HEADER_VALUES = /((?:authorization|x-api-key|api-key|proxy-authorization)\s*:\s*)([^\r\n\uE000-\uE001]{4,})/gi;

/**
 * 脱敏一段文本。纯函数、无 IO、不依赖 Electron，三端共用。
 *
 * 多轮规则会互相看见对方的产物：最早直接写 `[REDACTED]:KEY`，结果
 * `ANTHROPIC_API_KEY=[REDACTED]:KEY` 里的 `[REDACTED` 又被赋值规则当成新的
 * 敏感值吃掉，写成 `[REDACTED]]:KEY`。所以每轮先放私有区占位符，最后一次性
 * 换成标记——后续规则永远看不到已脱敏的内容。
 *
 * 返回值长度可能与入参不同——调用方若依赖字节数，应同时记录原始长度。
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  const marks: string[] = [];
  const mark = (kind: string): string => {
    const token = `\uE000${marks.length}\uE001`;
    marks.push(`[REDACTED:${kind}]`);
    return token;
  };
  let out = text.replace(PRIVATE_KEY_BLOCK, () => mark('PRIVATE_KEY'));
  for (const pattern of KEY_LITERALS) out = out.replace(pattern, () => mark('KEY'));
  out = out.replace(AUTH_HEADERS, (_all, prefix: string) => `${prefix}${mark('TOKEN')}`);
  out = out.replace(HEADER_VALUES, (_all, prefix: string) => `${prefix}${mark('HEADER')}`);
  out = out.replace(SECRET_ASSIGNMENTS, (_all, prefix: string) => `${prefix}${mark('SECRET')}`);
  out = out.replace(SECRET_QUERY, (_all, prefix: string) => `${prefix}${mark('QUERY')}`);
  if (marks.length === 0) return out;
  return out.replace(/\uE000(\d+)\uE001/g, (_all, index: string) => marks[Number(index)] ?? REDACTED);
}

/** argv 摘要：逐项脱敏，另外把「看起来像 Key 的整项」整个换掉，不留下首尾字符。 */
export function redactArgv(argv: readonly string[]): string[] {
  return argv.map(item => {
    const redacted = redactSecrets(item);
    return redacted === item && /^(?:oc_sk_|sk-|gsk_|xai-|hf_)/i.test(item)
      ? '[REDACTED:KEY]'
      : redacted;
  });
}

/** 文本里是否含有命中规则的凭据——用于测试与「审计写入前的自检」。 */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}

/**
 * 给审批卡用的最终参数。
 *
 * 用户点「执行这一步」时确认的必须是**实际会启动的东西**：展开后的 argv、
 * 真实 cwd、有效权限模式。这里只做形状整理与脱敏，不负责判断该不该跑。
 */
export interface EffectiveExecution {
  /** CLI 类型（qoder / claude / 自定义 id）。 */
  cli?: string;
  /** 最终 argv，已脱敏。 */
  argv?: string[];
  /** 实际执行目录（worktree 的真实路径，不是配置的相对路径）。 */
  cwd?: string;
  /** 有效权限模式，例如 accept_edits / acceptEdits。 */
  permissionMode?: string;
  /** 是否允许改文件。 */
  allowsWrites?: boolean;
  /** 是否属于高危权限（绕过全部检查的模式）。 */
  highRisk?: boolean;
  /** 额外说明，例如「参数已被授权剩余时间截断」。 */
  note?: string;
}

/** 权限模式里哪些是「绕过全部检查」——只用于界面如实标注，不改变授权判断。 */
const HIGH_RISK_MODES = new Set([
  'bypasspermissions',
  'danger-full-access',
  'dangerously-skip-permissions',
  'yolo',
  'full-access'
]);

export function effectivePermissionMode(permissionArgs: readonly string[] | undefined): {
  mode: string | undefined;
  allowsWrites: boolean;
  highRisk: boolean;
} {
  const args = permissionArgs ?? [];
  const index = args.findIndex(item => item === '--permission-mode' || item === '--permission');
  const mode = index >= 0 ? args[index + 1] : undefined;
  const normalized = (mode ?? '').toLowerCase().replace(/[-_]/g, '');
  return {
    mode,
    allowsWrites: normalized.includes('edit') || normalized.includes('write') || HIGH_RISK_MODES.has(normalized),
    highRisk: HIGH_RISK_MODES.has(normalized)
  };
}

/** 把有效参数渲染成审批卡上的短行；脱敏后仍可能很长，交给调用方截断。 */
export function describeEffective(input: EffectiveExecution): string[] {
  const lines: string[] = [];
  if (input.cli) lines.push(`CLI：${input.cli}`);
  if (input.permissionMode) lines.push(`权限模式：${input.permissionMode}`);
  if (input.allowsWrites !== undefined) lines.push(`允许修改文件：${input.allowsWrites ? '是' : '否'}`);
  if (input.highRisk !== undefined) lines.push(`高风险权限：${input.highRisk ? '是' : '否'}`);
  if (input.cwd) lines.push(`工作目录：${input.cwd}`);
  if (input.argv && input.argv.length > 0) lines.push(`启动参数：${input.argv.join(' ')}`);
  if (input.note) lines.push(`说明：${input.note}`);
  return lines;
}
