/**
 * 应用退出时，给「没来得及自己收尾」的终端审计文件补尾。
 *
 * 真机观察（2026-11-15）：Electron 退出会直接终止 UtilityProcess，Runtime 的
 * `process.on('exit') → closeAllTerminals() → endAllTerminalAudit()` **根本不会执行**。
 * 结果是一个仍在运行的 PTY 会话，它的 JSONL 永远停在最后一条 stdout，
 * `replay-terminal --verify` 会一直报「缺少 session-end（进程可能还在跑，或崩溃过）」。
 * 这不是理论风险：本轮应用正常退出后，`app-exit.jsonl` 写出来了，Claude 会话
 * 的 JSONL 却只有 session-start / resize / 9 条 stdout。
 *
 * 所以主进程在 `before-quit` 里**同步**扫一遍目录：只处理「有 session-start、
 * 没有 session-end」的会话文件，补 `exit` + `session-end` 两条结构事件。
 *
 * 三条诚实约束：
 * 1. 不伪造退出码、信号或 CANCELLED；明确写「退出码未知、记录不完整」。
 * 2. 不改动已经有 session-end 的文件，也不修改已有事件，只 append。
 * 3. 补记带 `recoveredBy: 'main-process'`，谁补的一眼能看出来。
 *
 * 放在 main 是因为它只服务主进程的 `before-quit`，且依赖 node:fs；
 * `src/shared/**` 会被 renderer 的 tsconfig 一起编译（只有 vite/client 类型），
 * 放那儿会直接报 `Cannot find module 'node:fs'`。测试通过
 * `tsconfig.test.json` 显式 include 这一个文件来引。
 */

import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../shared/redact';

const APP_EXIT_FILE = 'app-exit.jsonl';

export interface TerminalAuditReconcileResult {
  /** 扫到的会话文件数（不含 app-exit.jsonl）。 */
  scanned: number;
  /** 本次补了尾的 sessionId。 */
  reconciled: string[];
  /** 已完整 / 不是会话文件，没动。 */
  skipped: number;
  /** 读或写失败、明确放弃的文件名。 */
  failed: string[];
}

/**
 * 同步补尾。失败不外抛：审计是旁路，绝不能挡住应用退出。
 * `now` 可注入，方便测试断言时间戳。
 */
export function reconcileTerminalAuditFiles(
  dir: string,
  reason: string,
  now: number = Date.now()
): TerminalAuditReconcileResult {
  const result: TerminalAuditReconcileResult = { scanned: 0, reconciled: [], skipped: 0, failed: [] };
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl') && name !== APP_EXIT_FILE);
  } catch {
    return result;
  }

  for (const name of files) {
    const file = path.join(dir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      result.failed.push(name);
      continue;
    }
    result.scanned += 1;

    let lastSequence = 0;
    let hasStart = false;
    let hasEnd = false;
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (!text) continue;
      try {
        const event = JSON.parse(text) as { sequence?: unknown; type?: unknown };
        if (typeof event.sequence === 'number' && event.sequence > lastSequence) lastSequence = event.sequence;
        if (event.type === 'session-start') hasStart = true;
        if (event.type === 'session-end') hasEnd = true;
      } catch {
        // 崩溃留下的半行：保留原样，回放校验会如实报出来，不在这里偷偷抹掉。
      }
    }
    if (!hasStart || hasEnd) {
      result.skipped += 1;
      continue;
    }

    const sessionId = name.slice(0, -'.jsonl'.length);
    const why = redactSecrets(`${reason}；Runtime 未及自行写出退出码，这里只补结构事件`);
    const exit = {
      sessionId,
      sequence: lastSequence + 1,
      timestamp: now,
      type: 'exit',
      state: 'EXITED' as const,
      reason: why
    };
    const end = {
      sessionId,
      sequence: lastSequence + 2,
      timestamp: now,
      type: 'session-end',
      state: 'EXITED' as const,
      data: JSON.stringify({
        endedAt: now,
        cancelReason: null,
        finalState: 'EXITED',
        // 退出码/信号确实没观测到，不能当成一份完整审计。
        auditIncomplete: true,
        truncated: false,
        recoveredBy: 'main-process',
        note: '应用退出时 Runtime 已被终止，退出码与信号未知；本条由主进程按文件事实补记'
      })
    };
    try {
      // 最后一行没换行（崩溃半行）时先换行，避免把两个 JSON 对象粘成一行。
      const prefix = raw.length > 0 && !raw.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(file, `${prefix}${JSON.stringify(exit)}\n${JSON.stringify(end)}\n`, { mode: 0o600 });
      result.reconciled.push(sessionId);
    } catch {
      result.failed.push(name);
    }
  }
  return result;
}
