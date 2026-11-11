/**
 * 「本轮到底验没验过」：只陈述执行报告里读得到的事实。
 *
 * 规则来自设计文档：改了文件就必须有一次真的检查跑过——成功的 `test.run`
 * （退出码 0），或 `code.diagnostics` 报 0 个 error。写操作全失败、或写完
 * 什么都没跑，都不能算「已验证」。
 *
 * 纯函数：输入是执行结果，输出一个布尔与理由，不做任何判断之外的推断。
 */

import type { StepResult } from '../shared/contracts';

const WRITE_TOOLS = new Set(['fs.writeFile', 'fs.edit', 'fs.applyPatch', 'fs.remove', 'fs.move', 'fs.copy']);

export interface ExecutionVerification {
  verified: boolean;
  /** 为什么没算过（或为什么算过）；给界面与报告直接用。 */
  reasons: string[];
  changedFiles: number;
}

export function verifyExecution(results: readonly StepResult[]): ExecutionVerification {
  const writes = results.filter(item => WRITE_TOOLS.has(item.tool));
  const completedWrites = writes.filter(item => item.status === 'completed');
  const failedWrites = writes.filter(item => item.status === 'failed');

  const testOk = results.some(item => {
    if (item.tool !== 'test.run' || item.status !== 'completed') return false;
    const result = item.result as { exitCode?: unknown } | null;
    return result?.exitCode === 0;
  });

  const diagnosticsOk = results.some(item => {
    if (item.tool !== 'code.diagnostics' || item.status !== 'completed') return false;
    const result = item.result as { counts?: { errors?: unknown } } | null;
    return result?.counts?.errors === 0;
  });

  const reasons: string[] = [];
  if (failedWrites.length > 0) {
    reasons.push(`${String(failedWrites.length)} 个写操作失败：本轮不能算已验证`);
  }
  if (completedWrites.length > 0 && !testOk && !diagnosticsOk) {
    reasons.push('改了文件但没有成功的测试或诊断：本轮不能算已验证');
  }
  if (completedWrites.length === 0 && failedWrites.length === 0) {
    reasons.push('本轮没有写操作，无需验证');
  }
  return {
    verified: failedWrites.length === 0 && (completedWrites.length === 0 || testOk || diagnosticsOk),
    reasons,
    changedFiles: completedWrites.length
  };
}
