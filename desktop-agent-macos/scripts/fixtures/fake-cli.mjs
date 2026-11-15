#!/usr/bin/env node
/**
 * 测试用的假 CLI：真的进程、真的 argv、真的退出码。
 *
 * 它不是模块 mock。`agent.exec` 最容易错的地方是参数拼接、超时与取消、
 * 以及「改了哪些文件」的判定；这些都必须在真实子进程上验证，否则测到的
 * 只是我们自己写的 stub。
 *
 * 用法：node fake-cli.mjs <mode> <task> [permission args...]
 */

import { appendFileSync, writeFileSync } from 'node:fs';

const [mode = 'ok', task = ''] = process.argv.slice(2);

function result(payload) {
  process.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'fake-session',
      total_cost_usd: 0.01,
      modelUsage: { 'fake-model': { provider: 'fake-provider' } },
      permission_denials: [],
      ...payload
    })}\n`
  );
}

if (mode === 'ok') {
  writeFileSync('cli-created.txt', `${task}\n`, 'utf8');
  appendFileSync('dirty.txt', 'touched\n', 'utf8');
  result({ result: 'ok' });
  process.exit(0);
}

if (mode === 'fail') {
  process.stderr.write('fake failure\n');
  result({ result: 'failed', is_error: true, subtype: 'error_during_execution' });
  process.exit(3);
}

if (mode === 'sleep') {
  process.stdout.write('sleeping\n');
  // 不注册 SIGTERM：默认行为就是退出，用来验证「取消真的杀到了进程」。
  setTimeout(() => {}, 60_000);
} else if (mode === 'args') {
  writeFileSync('argv.json', `${JSON.stringify(process.argv.slice(2))}\n`, 'utf8');
  result({ result: 'args-recorded' });
  process.exit(0);
} else if (mode === 'stream') {
  process.stdout.write('line-one\n');
  setTimeout(() => {
    process.stdout.write('line-two\n');
  }, 100);
  setTimeout(() => process.exit(0), 600);
} else if (mode === 'model') {
  // Qoder 形状：modelUsage 键是档位，不是模型名。
  process.stdout.write(
    `${JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'no model declared',
      modelUsage: { auto: { credits: 0 }, efficient: { credits: 0 } }
    })}\n`
  );
  process.exit(0);
} else if (mode === 'raw') {
  // 不是 JSON：必须退回 stdout 文本，并标 unverified。
  process.stdout.write('plain text answer\n');
  process.exit(0);
}
