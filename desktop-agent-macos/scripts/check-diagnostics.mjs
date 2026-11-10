/**
 * 语言诊断：只做输出归一，不假装检查过。
 *
 * Run with: npm run test:diagnostics
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseEslintOutput, parseTscOutput } from '../out-test/agent/tools/diagnostics.js';
import { PlanSchema, READ_ONLY_TOOLS } from '../out-test/shared/contracts.js';
import { CAPABILITY_CATALOG } from '../out-test/shared/capabilities.js';

test('tsc 输出按行解析：路径、行列、严重级、错误码', () => {
  const issues = parseTscOutput(
    [
      "src/a.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
      'src/b.ts(1,1): warning TS6133: 未使用的变量。',
      'some unrelated line'
    ].join('\n'),
    '/proj'
  );
  assert.equal(issues.length, 2);
  assert.deepEqual(issues[0], {
    path: '/proj/src/a.ts',
    line: 12,
    column: 3,
    severity: 'error',
    message: "Type 'string' is not assignable to type 'number'.",
    source: 'tsc',
    code: 'TS2322'
  });
  assert.equal(issues[1].severity, 'warning');
});

test('绝对路径不重复拼 root', () => {
  const issues = parseTscOutput('/abs/a.ts(1,1): error TS1000: x', '/proj');
  assert.equal(issues[0].path, '/abs/a.ts');
});

test('eslint JSON 解析：severity 1 是 warning，ruleId 进 code', () => {
  const issues = parseEslintOutput(
    JSON.stringify([
      {
        filePath: '/proj/src/a.ts',
        messages: [
          { line: 2, column: 5, severity: 2, message: 'Unexpected any.', ruleId: '@typescript-eslint/no-explicit-any' },
          { line: 3, severity: 1, message: 'Prefer const.', ruleId: 'prefer-const' }
        ]
      }
    ])
  );
  assert.equal(issues.length, 2);
  assert.equal(issues[0].severity, 'error');
  assert.equal(issues[0].code, '@typescript-eslint/no-explicit-any');
  assert.equal(issues[1].severity, 'warning');
});

test('坏 JSON 不崩，返回空列表', () => {
  assert.deepEqual(parseEslintOutput('not json'), []);
  assert.deepEqual(parseEslintOutput('{}'), []);
});

test('计划接受 code.diagnostics，且它是只读能力', () => {
  const parsed = PlanSchema.safeParse({
    protocol: 'desktop-agent/v1',
    type: 'plan',
    taskId: 't1',
    roundId: 'r1',
    title: '看诊断',
    description: '',
    steps: [{ id: 's1', tool: 'code.diagnostics', args: { maxItems: 20 } }],
    completion: { condition: '拿到问题列表' }
  });
  assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
  assert.ok(READ_ONLY_TOOLS.includes('code.diagnostics'));
  assert.equal(CAPABILITY_CATALOG.find(item => item.id === 'code.diagnostics')?.permission, 'read-only');
});
