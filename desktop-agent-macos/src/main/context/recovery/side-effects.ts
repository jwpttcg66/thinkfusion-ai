/**
 * 恢复前的工具副作用核对（LT-P5-04，M2-2 收口）。
 *
 * 只从已落库的事实取：
 * - 报告记录过 `changedPaths` 且仍存在 → applied；
 * - 报告记录过但已消失 → missing；
 * - 写工具执行过但没有可核对路径、或起了但报告未落 → needs_reconciliation。
 *
 * 暂停与恢复必须共用 `collectReportedAndInFlightSideEffects`：两侧算出的
 * needs_reconciliation 不一样时，检查点写着「有缺口」、续跑门槛却按「无缺口」放行。
 *
 * 没有记录内容 hash，所以 `applied` 不声称「文件内容与当时一致」。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent, ExecutionReport, StepResult } from '../../../shared/contracts';
import type {
  SideEffectEntry,
  SideEffectLedger
} from '../../../shared/context';

const PATH_KEYS = ['path', 'file', 'filePath', 'target', 'from', 'to', 'source', 'destination'] as const;
const PATH_LIST_KEYS = ['paths', 'files', 'changedPaths'] as const;

const PATH_WRITE_TOOLS = new Set([
  'fs.mkdir', 'fs.writeFile', 'fs.edit', 'fs.remove', 'fs.move', 'fs.copy',
  'fs.applyPatch', 'fs.revert', 'archive.extract', 'archive.create',
  'image.resize', 'screen.capture'
]);

const OPAQUE_WRITE_TOOLS = new Set([
  'test.run', 'shell.run', 'code.run', 'agent.exec', 'term.send',
  'git.stash', 'git.branch', 'git.worktree', 'clipboard.write'
]);

function pathsFromArgs(args: Record<string, unknown> = {}): string[] {
  const found: string[] = [];
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) found.push(value.trim());
  }
  for (const key of PATH_LIST_KEYS) {
    const value = args[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) found.push(item.trim());
      }
    }
  }
  return [...new Set(found)];
}

function pathsOf(result: StepResult): string[] {
  return pathsFromArgs(result.args ?? {});
}

/** 核对项的身份：同一个 stepId 每轮都会重新出现，必须带轮次才唯一。 */
export function sideEffectKey(entry: { roundId?: string; stepId: string }): string {
  return `${entry.roundId ?? ''}:${entry.stepId}`;
}

/**
 * 暂停点可能还没有执行报告：`step.started` 已经落库，Runtime 还没把报告写回来。
 * 即便 `step.failed` 先到了，失败也不等于「没写过文件」。这类没有报告可核对的
 * 写操作必须进 needs_reconciliation，不能因为「报告还没落」就当成没有副作用。
 *
 * `reported` 是已经能从报告核对的步骤（collectSideEffects 的结果）：同一轮同一
 * stepId 报告都落了的步骤不该再被算成「在途」，否则一次正常暂停也会把每个已完成
 * 写步骤重新记成 needs_reconciliation，续跑门槛就永远过不去（M2-2 实测过这条）。
 * 去重必须按 roundId+stepId：模型每轮的步骤 id 都从 step-1 开始，按 stepId+tool
 * 去重会把第二轮真正在途的那一步误删。
 */
export function collectInFlightSideEffects(
  events: readonly AgentEvent[],
  reported?: readonly SideEffectEntry[]
): SideEffectEntry[] {
  const started = new Map<string, { stepId: string; roundId: string; tool: string; paths: string[] }>();
  const keyOf = (event: { roundId?: string; stepId: string }) => `${event.roundId ?? ''}:${event.stepId}`;

  for (const event of events) {
    if (event.type !== 'step.started') continue;
    const tool = String(event.tool);
    if (!PATH_WRITE_TOOLS.has(tool) && !OPAQUE_WRITE_TOOLS.has(tool)) continue;
    started.set(keyOf(event), {
      stepId: event.stepId,
      roundId: event.roundId ?? '',
      tool,
      paths: pathsFromArgs(event.args)
    });
  }

  const reportedKeys = new Set((reported ?? []).map(sideEffectKey));

  return [...started.values()]
    .filter(item => !reportedKeys.has(sideEffectKey(item)))
    .map(item => ({
      stepId: item.stepId,
      ...(item.roundId ? { roundId: item.roundId } : {}),
      tool: item.tool,
      paths: item.paths,
      status: 'needs_reconciliation' as const,
      detail: item.paths.length > 0
        ? '暂停或中断时这一步在途、报告未落；它记录的路径必须人工核对'
        : '暂停或中断时这一步在途、报告未落，也没有可核对路径'
    }));
}

/**
 * 报告 + 事件流合并出一份待核对清单（暂停与恢复共用）。
 *
 * 两侧口径必须一致：暂停时按「报告+在途」写检查点，恢复时只按报告核对，
 * 会让同一件事在写和读两侧算出不同的 needs_reconciliation。
 */
export function collectReportedAndInFlightSideEffects(input: {
  reports: readonly ExecutionReport[];
  events: readonly AgentEvent[];
}): SideEffectEntry[] {
  const entries = collectSideEffects(input.reports);
  return [...entries, ...collectInFlightSideEffects(input.events, entries)];
}

/** 从全部轮次报告提取待核对项；同一 step 只保留一条。 */
export function collectSideEffects(reports: readonly ExecutionReport[]): SideEffectEntry[] {
  const entries = new Map<string, SideEffectEntry>();
  const reportPaths = new Set<string>();

  for (const report of reports) {
    for (const result of report.results) {
      const tool = String(result.tool);
      const paths = pathsOf(result);
      const writes = PATH_WRITE_TOOLS.has(tool);
      const opaque = OPAQUE_WRITE_TOOLS.has(tool);
      for (const file of paths) reportPaths.add(file);
      // 只读工具即使带 path 也不是副作用；把 fs.readFile 当写操作会让
      // 恢复报告凭空多出 missing。
      if (!writes && !opaque) continue;
      // 暂停/取消时没轮到的步骤会以 skipped + 原参数落进报告（见 agent 主循环）。
      // 这一步本轮没动过手，把它的目标路径当成「记录过的改动已消失」判成 missing，
      // 等于用一份根本没执行的清单挡住续跑——M2-2 真机上「暂停→重启」必然重规划。
      // 带 reusedFrom 的 skipped 是「上一轮真写过、本轮不再重跑」，路径要照常核对。
      if (result.status === 'skipped' && !result.reusedFrom) continue;

      const key = `${report.roundId}:${result.stepId}`;
      entries.set(key, {
        stepId: result.stepId,
        roundId: report.roundId,
        tool,
        paths,
        // 报告只能说明「这一步写过这些路径」，内容是否仍是当时的版本没有 hash 可证，
        // 所以初始一律 needs_reconciliation，由 reconcileSideEffects 按路径是否还在
        // 落成 applied / missing。
        status: 'needs_reconciliation' as const,
        detail: paths.length > 0
          ? (result.status === 'completed'
              ? '报告记录了写入路径，恢复时核对文件是否仍在'
              : `写操作状态为 ${result.status}，恢复前必须人工核对`)
          : (result.status === 'completed'
              ? '这一步可能产生副作用，但报告没有记录具体路径'
              : `写操作状态为 ${result.status}，且没有路径可核对`)
      });
    }

    const changed = report.verification?.changedPaths ?? [];
    for (const file of changed) reportPaths.add(file);
    if (changed.length > 0) {
      const key = `${report.roundId}:report:${report.planId}`;
      entries.set(key, {
        stepId: report.roundId,
        roundId: report.roundId,
        tool: 'report',
        paths: [...new Set(changed)],
        status: 'needs_reconciliation',
        detail: '执行报告记录的改动文件，恢复时核对是否仍存在'
      });
    }
  }

  // 报告只给了 changedPaths、没有逐步路径时，上面的 report 条目负责兜底；
  // reportPaths 保留是为了将来按路径去重，当前不改写逐步条目。
  void reportPaths;
  return [...entries.values()];
}

export interface ReconcileSideEffectsOptions {
  workspaceRoot?: string;
  /** 测试注入；默认读取文件系统。 */
  exists?: (absolutePath: string) => Promise<boolean>;
}

function resolvePath(workspaceRoot: string | undefined, file: string): string {
  return path.isAbsolute(file) || !workspaceRoot ? file : path.join(workspaceRoot, file);
}

async function defaultExists(absolutePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(absolutePath);
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 按报告核对副作用。不改文件、不重做写操作；失败也不抛给调用方，
 * 返回 `needs_reconciliation` 让恢复流程要求人工确认。
 */
export async function reconcileSideEffects(
  entries: readonly SideEffectEntry[],
  options: ReconcileSideEffectsOptions = {}
): Promise<SideEffectLedger> {
  const exists = options.exists ?? defaultExists;
  const checked: SideEffectEntry[] = [];
  for (const entry of entries) {
    if (entry.paths.length === 0) {
      checked.push({ ...entry, status: 'needs_reconciliation' });
      continue;
    }
    let allPresent = true;
    for (const file of entry.paths) {
      if (!(await exists(resolvePath(options.workspaceRoot, file)))) {
        allPresent = false;
        break;
      }
    }
    checked.push({
      ...entry,
      status: allPresent ? 'applied' : 'missing',
      detail: allPresent
        ? '报告记录的路径在恢复时仍然存在；未校验内容 hash'
        : '报告记录的路径在恢复时不存在；不能视为已完成写入'
    });
  }

  return {
    entries: checked,
    applied: checked.filter(item => item.status === 'applied').length,
    missing: checked.filter(item => item.status === 'missing').length,
    needsReconciliation: checked.filter(item => item.status === 'needs_reconciliation').length,
    checkedAt: Date.now()
  };
}
