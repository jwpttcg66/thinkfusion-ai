/**
 * 工程分析里「模型自己读文件」的测试（2026-11-09 用户裁决）。
 *
 * 用户原话：「读取文件，模型不是应该调用本地能力，没看到调用本地能力，输出也是
 * 糟糕的。」真机现场：附一份 md 问「这个文件有多少行」，两个本地模型都答
 * 「无法确定」，依据还是一段无关的 index.html:8——第一手只是 `generate()`，
 * 模型没有读整份文件的能力。
 *
 * 这里钉四件事：
 *
 * 1. 认请求要准——正常回答里的花括号不能被当成读文件请求；
 * 2. 真读——行数/字节按整份文件算，读出来的正文带行号；
 * 3. 范围硬——工程目录与这一问的附件之外读不到（模型不能读 ~/.ssh）；
 * 4. 链路闭合——模型请求了，宿主真读，结果被递回去，模型接着回答，且转录里
 *    看得到「调用了本机能力」。预算用完不再循环。
 *
 * Run with: npm run test:engineering-tools
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationRunner } from '../out-test/main/conversation-runner.js';
import {
  buildToolFollowupQuestion,
  engineeringAnswerSystem,
  engineeringToolSystem
} from '../out-test/main/research/engineering-round.js';
import {
  executeReadTool,
  MAX_TOOL_ROUNDS,
  parseToolRequest
} from '../out-test/main/research/project-tools.js';
import { CAPABILITY_CATALOG } from '../out/shared/capabilities.js';

const root = mkdtempSync(join(tmpdir(), 'tf-tools-'));
const outside = mkdtempSync(join(tmpdir(), 'tf-outside-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

mkdirSync(join(root, 'src'), { recursive: true });
writeFileSync(join(root, 'log.txt'), 'record-1\nrecord-2\nrecord-3\n');
writeFileSync(join(root, 'src', 'app.ts'), 'export const a = 1;\nexport const b = 2;\n');
writeFileSync(join(outside, 'attached.md'), '# 方案\n第一行\n第二行\n');

// ---------------------------------------------------------------------------
// 1. 认请求
// ---------------------------------------------------------------------------

test('只认白名单里的读文件请求，正常回答不被误判', () => {
  assert.deepEqual(
    parseToolRequest('{"tool":"fs.stat","args":{"path":"log.txt"}}'),
    { tool: 'fs.stat', args: { path: 'log.txt' } }
  );
  // 模型爱套代码块，也要认
  assert.equal(
    parseToolRequest('```json\n{"tool":"fs.readFile","args":{"path":"log.txt","limit":10}}\n```')?.tool,
    'fs.readFile'
  );
  // 正常回答里出现的花括号不是请求（认错就会白跑一次工具、白等一轮推理）
  assert.equal(parseToolRequest('【结论】共 {3} 行，见 log.txt:1'), null);
  assert.equal(parseToolRequest('{"结论":"3 行"}'), null);
  // 不在白名单里的能力一律不认，尤其是写操作
  assert.equal(parseToolRequest('{"tool":"fs.writeFile","args":{"path":"x"}}'), null);
  assert.equal(parseToolRequest('{"tool":"shell.run","args":{"command":"rm -rf /"}}'), null);
});

// ---------------------------------------------------------------------------
// 2. 真读
// ---------------------------------------------------------------------------

test('fs.stat 报整份文件的行数与字节数', async () => {
  const result = await executeReadTool({ tool: 'fs.stat', args: { path: 'log.txt' } }, {
    root,
    extraFiles: []
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /3 行/);
  assert.match(result.text, /字节/);
  assert.match(result.text, /sha256/);
});

test('fs.readFile 带行号，且永远先报总行数', async () => {
  const result = await executeReadTool(
    { tool: 'fs.readFile', args: { path: 'log.txt', offset: 2, limit: 1 } },
    { root, extraFiles: [] }
  );
  assert.equal(result.ok, true);
  assert.match(result.text, /共 3 行/);
  assert.match(result.text, /2\trecord-2/);
  assert.doesNotMatch(result.text, /record-1/);
});

test('fs.search 与 fs.list 能用', async () => {
  const found = await executeReadTool(
    { tool: 'fs.search', args: { pattern: 'record-2' } },
    { root, extraFiles: [] }
  );
  assert.equal(found.ok, true);
  assert.match(found.text, /log\.txt:2/);

  const listed = await executeReadTool({ tool: 'fs.list', args: { path: 'src' } }, {
    root,
    extraFiles: []
  });
  assert.equal(listed.ok, true);
  assert.match(listed.text, /app\.ts/);
});

// ---------------------------------------------------------------------------
// 3. 范围
// ---------------------------------------------------------------------------

test('工程目录之外读不到，失败如实递回去而不是抛错', async () => {
  const denied = await executeReadTool(
    { tool: 'fs.readFile', args: { path: '/etc/hosts' } },
    { root, extraFiles: [] }
  );
  assert.equal(denied.ok, false);
  assert.match(denied.text, /不在工程目录/);

  // 这一问的附件可以读，哪怕它不在工程目录里
  const allowed = await executeReadTool(
    { tool: 'fs.readFile', args: { path: join(outside, 'attached.md') } },
    { root, extraFiles: [join(outside, 'attached.md')] }
  );
  assert.equal(allowed.ok, true);
  assert.match(allowed.text, /共 3 行/);
});

// ---------------------------------------------------------------------------
