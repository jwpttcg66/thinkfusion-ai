/**
 * P0-3：在途 shell.run 必须真中断，不是把下一步 skip 掉。
 *
 * 覆盖：启动前已取消、执行中取消（进程组 SIGTERM → SIGKILL）、超时仍保留原语义，
 * 以及生产插件把 Runtime 的取消集合透传给 shell.run。
 * Run: npm run test:shell-interrupt
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runShell } from '../out-test/agent/tools/shell.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-shell-interrupt-'));
const grant = {
  taskId: 'shell-interrupt-test',
  permissionPreset: 'danger-full-access',
  approvalPolicy: 'ask',
  rootDir: dir,
  allowedTools: ['shell.run'],
  expiresAt: Date.now() + 10 * 60 * 1000,
  maxSteps: 10
};

test('启动前已取消：不 spawn，直接给 interrupted 结果', async () => {
  const result = await runShell(grant, {
    command: 'echo should-not-run',
    isCancelled: () => true
  });
  assert.equal(result.interrupted, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.stdout, '');
  assert.equal(result.durationMs, 0);
});

test('执行中取消：进程组被终止，结果如实记 interrupted 与信号', async () => {
  const marker = path.join(dir, 'should-not-exist.txt');
  fs.rmSync(marker, { force: true });
  let cancelled = false;
  const started = Date.now();
  const cancelTimer = setTimeout(() => { cancelled = true; }, 400);
  const result = await runShell(grant, {
    command: `echo began; sleep 5; echo end > ${JSON.stringify(marker)}`,
    timeoutMs: 12000,
    isCancelled: () => cancelled
  });
  clearTimeout(cancelTimer);

  assert.equal(result.interrupted, true);
  assert.equal(result.timedOut, false);
  assert.ok(result.signal, '应当记录发给进程组的信号');
  assert.match(result.stdout, /began/);
  assert.ok(Date.now() - started < 4000, `取消后没有及时返回：${String(Date.now() - started)}ms`);
  // 给 SIGTERM 的宽限期留一点时间：marker 绝不该在中断后继续写出来。
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(fs.existsSync(marker), false, '在途进程没有被真正终止');
});

test('超时语义仍在：没有取消时按原路径 SIGKILL，不误标 interrupted', async () => {
  const result = await runShell(grant, { command: 'sleep 2', timeoutMs: 1000 });
  assert.equal(result.timedOut, true);
  assert.equal(result.interrupted, false);
});

test('生产链路：取消集合透传、Runtime 发回执、主进程等待确认', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
  const plugin = read('src/agent/local-plugins.ts');
  assert.match(plugin, /runShell\(ctx\.grant,\s*\{\s*\.\.\.args,\s*isCancelled:\s*ctx\.isCancelled\s*\}\)/);
  assert.match(plugin, /COMMAND_INTERRUPTED/);

  const runtime = read('src/agent/index.ts');
  assert.match(runtime, /type:\s*'task\.cancel\.ack'/);

  const manager = read('src/main/agent-manager.ts');
  assert.match(manager, /typed\.type === 'task\.cancel\.ack'/);
  assert.match(manager, /export async function cancelPlan/);

  const orchestrator = read('src/main/orchestrator.ts');
  assert.match(orchestrator, /const cancel = await cancelPlan\(taskId\)/);
  assert.match(orchestrator, /未能确认在途工具终止/);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
