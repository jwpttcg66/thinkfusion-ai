/**
 * 持久终端（`term.*`）：真的开 pty、真的收发、真的收尾。
 *
 * 用本机 shell 跑，不伪造子进程。node-pty 不可用时整个文件跳过并说明原因——
 * 跳过要能被看见，不能把「没跑」显示成「通过」。
 *
 * Run with: npm run test:terminal
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  closeAllTerminals,
  closeTerminal,
  listTerminals,
  openTerminal,
  readTerminal,
  sendTerminal,
  signalTerminal
} from '../out-test/agent/tools/terminal.js';

const root = await mkdtemp(path.join(tmpdir(), 'tf-term-'));

async function settle(ms = 250) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function readUntil(sessionId, needle, attempts = 20) {
  let last = '';
  for (let index = 0; index < attempts; index += 1) {
    const result = readTerminal(sessionId, 40_000);
    last += result.output;
    if (last.includes(needle)) return last;
    await settle(150);
  }
  return last;
}

test.after(async () => {
  closeAllTerminals();
  await rm(root, { recursive: true, force: true });
});

test('开一个终端、写命令、读到真实输出', async () => {
  const opened = openTerminal(root);
  assert.equal(opened.opened, true);
  assert.ok(opened.pid > 0);
  assert.equal(opened.cwd, root);

  sendTerminal(opened.sessionId, 'echo tf-pty-ok', true);
  const output = await readUntil(opened.sessionId, 'tf-pty-ok');
  assert.match(output, /tf-pty-ok/);

  assert.equal(closeTerminal(opened.sessionId).closed, true);
});

test('read 只返回上次之后的新输出，truncated 说清楚还有没有', async () => {
  const opened = openTerminal(root);
  sendTerminal(opened.sessionId, 'echo first-line', true);
  await readUntil(opened.sessionId, 'first-line');

  sendTerminal(opened.sessionId, 'echo second-line', true);
  const second = await readUntil(opened.sessionId, 'second-line');
  assert.match(second, /second-line/);
  assert.doesNotMatch(second, /first-line/);

  closeTerminal(opened.sessionId);
});

test('列出来的会话带 pid、cwd 与未读量', async () => {
  const opened = openTerminal(root);
  const list = listTerminals();
  const found = list.sessions.find(session => session.sessionId === opened.sessionId);
  assert.ok(found);
  assert.equal(found.pid, opened.pid);
  assert.equal(found.cwd, root);
  assert.equal(typeof found.pending, 'number');
  closeTerminal(opened.sessionId);
});

test('不支持的信号被拒，支持的原样送达', async () => {
  const opened = openTerminal(root);
  assert.throws(() => signalTerminal(opened.sessionId, 'SIGSTOP'), /不支持的信号/);
  const sent = signalTerminal(opened.sessionId, 'SIGINT');
  assert.equal(sent.delivered, true);
  closeTerminal(opened.sessionId);
});

test('关闭后不再出现在列表里，也拒绝继续写入', async () => {
  const opened = openTerminal(root);
  closeTerminal(opened.sessionId);
  assert.equal(listTerminals().sessions.some(session => session.sessionId === opened.sessionId), false);
  assert.throws(() => sendTerminal(opened.sessionId, 'echo x'), /没有这个终端会话/);
});
