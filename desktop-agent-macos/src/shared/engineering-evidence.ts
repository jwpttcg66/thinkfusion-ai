/**
 * 执行证据账本：把「读到过 / 跑过 / 改过」落成结构化记录。
 *
 * 设计口径见 `docs/spec/GENERAL_ENGINEERING_CAPABILITIES.md` 第 8 节：
 *
 * - **读到过**：`file`，计数类必须带 `lines` 或 `sha256`；
 * - **跑过**：`command`，没有退出码（后台作业 / 超时）记 `null`，不能当成功；
 * - **改过**：`file` + 写前写后哈希，或一条非空 diff。
 *
 * 这一层只做「从步骤结果里抽出可核对的事实」，不判断结论对不对。判定在
 * `engineering/review.ts` 与计划门禁里做，两者读同一份账本。
 */

export type EvidenceRef =
  | { kind: 'file'; path: string; line?: number; sha256?: string; lines?: number }
  | {
      kind: 'command';
      command: string;
      exitCode: number | null;
      at: number;
      timedOut?: boolean;
      /** 后台作业没有退出码是正常的，不能被当成失败。 */
      background?: boolean;
    }
  | { kind: 'url'; url: string; fetchedAt: number };

export interface EvidenceLedger {
  refs: EvidenceRef[];
  /** 由计划反推的主族，用于界面显示「这次在做什么」。 */
  primaryFamily?: string;
}

/** 一个已执行步骤里与证据相关的最小形状。 */
export interface EvidenceStep {
  tool: string;
  args?: unknown;
  result?: unknown;
  status?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const COMMAND_TOOLS = new Set(['test.run', 'shell.run', 'code.run']);

/**
 * 从一步的 `tool / args / result` 里抽一条证据；抽不出来返回 null。
 *
 * 抽不出来不是错误：`fs.list`、`job.list` 这类只是「看了一眼」，没有可核对的
 * 单点事实。宁可少记，也不要把 `{ok:true}` 记成证据。
 */
export function evidenceFromStep(step: EvidenceStep, at = Date.now()): EvidenceRef | null {
  const result = record(step.result);
  const args = record(step.args);
  if (!result) return null;

  if (COMMAND_TOOLS.has(step.tool)) {
    const command =
      str(result.command) ??
      str(args?.command) ??
      (step.tool === 'test.run' ? 'test.run' : step.tool);
    return {
      kind: 'command',
      command,
      exitCode: num(result.exitCode) === undefined && result.exitCode === null ? null : num(result.exitCode) ?? null,
      at,
      ...(result.timedOut === true ? { timedOut: true } : {}),
      ...(str(result.jobId) || result.background === true ? { background: true } : {})
    };
  }

  if (step.tool === 'web.fetch') {
    const url = str(result.url) ?? str(args?.url);
    if (url) return { kind: 'url', url, fetchedAt: at };
    return null;
  }

  if (step.tool.startsWith('fs.')) {
    const path = str(result.path);
    if (!path) return null;
    const lines = num(result.lines) ?? num(result.totalLines);
    const sha256 = str(result.sha256);
    return {
      kind: 'file',
      path,
      ...(lines === undefined ? {} : { lines }),
      ...(sha256 === undefined ? {} : { sha256 })
    };
  }

  return null;
}

function evidenceKey(ref: EvidenceRef): string {
  if (ref.kind === 'file') return `file:${ref.path}`;
  if (ref.kind === 'command') return `command:${ref.command}`;
  return `url:${ref.url}`;
}

/**
 * 把一串步骤收成账本。同一条事实只留一条（同一文件读两次不重复计数），
 * 后出现的覆盖先出现的——后一次带的是更新后的哈希或退出码。
 */
export function buildEvidenceLedger(
  steps: readonly EvidenceStep[],
  primaryFamily?: string,
  at = Date.now()
): EvidenceLedger {
  const byKey = new Map<string, EvidenceRef>();
  for (const step of steps) {
    const ref = evidenceFromStep(step, at);
    if (!ref) continue;
    byKey.set(evidenceKey(ref), ref);
  }
  return {
    refs: [...byKey.values()],
    ...(primaryFamily ? { primaryFamily } : {})
  };
}
