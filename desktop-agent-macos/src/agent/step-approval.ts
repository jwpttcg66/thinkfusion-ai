/**
 * 逐次审批的纯判断（对齐 harness 的 `tools/pre-execute` 语义）。
 *
 * 单独一个文件是为了可测试：`agent/index.ts` 顶层就要求 `process.parentPort`，
 * 在普通 node 进程里 import 会直接抛错，判断逻辑就永远测不到。这里只放
 * 「要不要问」「算不算高危」「参数怎么截」，不碰 IPC。
 */

import { READ_ONLY_TOOLS, type StepApprovalMode } from '../shared/contracts';

/** 参数预览的长度上限。再长用户也不会读，反而把卡片撑满。 */
export const ARGS_PREVIEW_LIMIT = 600;

/**
 * 这一步要不要先问。
 *
 * `mutating`（缺省）只问有副作用的步骤。只读步骤也弹窗看起来更严，实际是把
 * 用户训练成无脑点「执行」——八步里有六次是 `fs.readFile` 的时候，第三次之后
 * 没人再看参数。
 */
export function needsApproval(tool: string, mode: StepApprovalMode): boolean {
  if (mode === 'off') return false;
  if (mode === 'every') return true;
  return !(READ_ONLY_TOOLS as readonly string[]).includes(tool);
}

/** 风险分级只影响界面强调，不改变「问不问」——问不问由 `needsApproval` 决定。 */
export function riskOf(tool: string): 'read' | 'write' | 'danger' {
  if ((READ_ONLY_TOOLS as readonly string[]).includes(tool)) return 'read';
  if (['shell.run', 'code.run', 'test.run', 'process.kill', 'fs.remove', 'fs.move', 'agent.exec'].includes(tool)) {
    return 'danger';
  }
  return 'write';
}

/** 给用户看的参数预览：截断要留痕，不能让人以为看到的是全部。 */
export function previewArgs(args: unknown, limit = ARGS_PREVIEW_LIMIT): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {});
  } catch {
    text = String(args);
  }
  if (text === undefined) text = '{}';
  return text.length > limit ? `${text.slice(0, limit)}…（已截断，共 ${text.length} 字符）` : text;
}
