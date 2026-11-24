/**
 * 恢复前的工具副作用核对（LT-P5-04）。
 *
 * 只从已落库的执行报告取事实：
 * - 报告记录过 `changedPaths` 且仍存在 → applied；
 * - 报告记录过但已消失 → missing；
 * - 写工具执行过但没有可核对路径 → needs_reconciliation。
 *
 * 没有记录内容 hash，所以 `applied` 不声称「文件内容与当时一致」。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionReport, StepResult } from '../../../shared/contracts';
import type {
  SideEffectEntry,
  SideEffectLedger,
  SideEffectStatus
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

function pathsOf(result: StepResult): string[] {
  const args = result.args ?? {};
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

      const key = `${report.roundId}:${result.stepId}`;
      const status: SideEffectStatus = paths.length > 0
        ? (result.status === 'completed' ? 'needs_reconciliation' : 'needs_reconciliation')
        : 'needs_reconciliation';
      entries.set(key, {
        stepId: result.stepId,
        tool,
        paths,
        status,
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
