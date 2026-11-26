/**
 * 修复轮闸门：没有新证据不得再开一轮。
 *
 * 真机 2026-11-26：一个 134 秒该结束的任务跑了 421 秒，多出来的两轮里
 * 同一个命令、同一份输出、同一组评审问题被原样重复。这里把「什么算新证据」
 * 钉成可核对的事实，不让模型自述或规则猜测定这件事。
 *
 * Run with: npm run test:repair-loop
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceFacts, shouldOpenRepairRound } from '../out-test/shared/repair-loop.js';

function report(overrides = {}) {
  return {
    protocol: 'desktop-agent/v1',
    type: 'execution_report',
    taskId: 'task-1',
    roundId: 'round-1',
    planId: 'plan-1',
    status: 'completed',
    createdAt: 1,
    nextAction: 'continue',
    errors: [],
    results: [
      {
        stepId: 'step-1',
        tool: 'shell.run',
        status: 'completed',
        args: { command: 'npm test' },
        result: { command: 'npm test', exitCode: 1, stdout: '1 test failed\n', stderr: '' }
      }
    ],
    evidence: {
      refs: [{ kind: 'command', command: 'npm test', exitCode: 1, at: 1 }]
    },
    verification: {
      verified: false,
      reasons: ['测试未通过'],
      changedFiles: 0
    },
    ...overrides
  };
}

const ISSUES = ['测试未覆盖校验失败分支'];

test('事实指纹包含命令、退出码、输出、参数与验证结论', () => {
  const facts = evidenceFacts(report());
  assert.ok(facts.some(fact => fact.startsWith('step:step-1:shell.run:completed:1')));
  assert.ok(facts.some(fact => fact.startsWith('args:step-1:')));
  assert.ok(facts.some(fact => fact.startsWith('out:step-1:')));
  assert.ok(facts.some(fact => fact.includes('command:npm test:1')));
  assert.ok(facts.includes('verified:no'));
  assert.ok(facts.includes('reason:测试未通过'));
});

test('第一次修复没有上一轮可比较，照常开', () => {
  const gate = shouldOpenRepairRound({
    previous: null,
    current: { facts: evidenceFacts(report()), issues: ISSUES }
  });
  assert.equal(gate.open, true);
});

test('同一份报告 + 同一组评审问题：不再开一轮', () => {
  const first = report();
  const second = report({ roundId: 'round-2' });
  const gate = shouldOpenRepairRound({
    previous: { facts: evidenceFacts(first), issues: ISSUES },
    current: { facts: evidenceFacts(second), issues: [...ISSUES] }
  });
  assert.equal(gate.open, false);
  assert.equal(gate.newFacts, 0);
  assert.deepEqual(gate.newIssues, []);
  assert.match(gate.reason, /没有任何新证据/);
});

test('输出变了就算新证据（真跑出了不同结果）', () => {
  const next = report({
    roundId: 'round-2',
    results: [
      {
        stepId: 'step-1',
        tool: 'shell.run',
        status: 'completed',
        args: { command: 'npm test' },
        result: { command: 'npm test', exitCode: 1, stdout: '2 tests failed\n', stderr: '' }
      }
    ]
  });
  const gate = shouldOpenRepairRound({
    previous: { facts: evidenceFacts(report()), issues: ISSUES },
    current: { facts: evidenceFacts(next), issues: ISSUES }
  });
  assert.equal(gate.open, true);
  assert.equal(gate.newFacts, 1);
});

test('退出码从 1 变 0 算新证据', () => {
  const next = report({
    roundId: 'round-2',
    results: [
      {
        stepId: 'step-1',
        tool: 'shell.run',
        status: 'completed',
        args: { command: 'npm test' },
        result: { command: 'npm test', exitCode: 0, stdout: 'ok\n', stderr: '' }
      }
    ],
    verification: { verified: true, reasons: [], changedFiles: 0 }
  });
  const gate = shouldOpenRepairRound({
    previous: { facts: evidenceFacts(report()), issues: ISSUES },
    current: { facts: evidenceFacts(next), issues: ISSUES }
  });
  assert.equal(gate.open, true);
});

test('同一条命令但参数改了也算新证据（改了文件内容）', () => {
  const next = report({
    roundId: 'round-2',
    results: [
      {
        stepId: 'step-1',
        tool: 'fs.writeFile',
        status: 'completed',
        args: { path: 'a.ts', content: '新的内容' },
        result: { created: true, path: 'a.ts' }
      }
    ]
  });
  const gate = shouldOpenRepairRound({
    previous: { facts: evidenceFacts(report()), issues: ISSUES },
    current: { facts: evidenceFacts(next), issues: ISSUES }
  });
  assert.equal(gate.open, true);
});

test('评审提出上一轮没有的问题：即使证据没变也开一轮', () => {
  const gate = shouldOpenRepairRound({
    previous: { facts: evidenceFacts(report()), issues: ISSUES },
    current: { facts: evidenceFacts(report()), issues: ['测试未覆盖校验失败分支', '新增的边界条件没有断言'] }
  });
  assert.equal(gate.open, true);
  assert.deepEqual(gate.newIssues, ['新增的边界条件没有断言']);
});

test('问题只是空白不同，不算新问题', () => {
  const gate = shouldOpenRepairRound({
    previous: { facts: evidenceFacts(report()), issues: ISSUES },
    current: { facts: evidenceFacts(report()), issues: ['  测试未覆盖  校验失败分支  '] }
  });
  assert.equal(gate.open, false);
});
