/**
 * V4 P1 M1-1：执行历史投影。
 * Run: npm run test:execution-history
 *
 * 核心断言只有一个方向：同一 Task 的每次执行必须各自成条、互不覆盖，
 * 且「没记录到」不能被投影成「没有问题」。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExecutionHistory } from '../out-test/shared/execution-history.js';
import { PROTOCOL } from '../out-test/shared/contracts.js';

function round(overrides = {}) {
  return {
    roundId: 'r1',
    taskId: 't1',
    roundNumber: 1,
    requestId: 'q1',
    inputType: 'user_prompt',
    requestText: '做个 demo',
    status: 'completed',
    createdAt: 1_000,
    ...overrides
  };
}

function report(overrides = {}) {
  return {
    protocol: PROTOCOL,
    type: 'execution_report',
    taskId: 't1',
    roundId: 'r1',
    planId: 'p1',
    status: 'completed',
    results: [],
    errors: [],
    nextAction: 'continue',
    createdAt: 2_000,
    ...overrides
  };
}

function evidence(path) {
  return { kind: 'file', path, sha256: `sha-${path}` };
}

test('两轮 → 两条执行，结果与证据各自独立不覆盖', () => {
  const records = buildExecutionHistory({
    task: { taskId: 't1', runId: 'run-a' },
    rounds: [round({ roundId: 'r1', roundNumber: 1 }), round({ roundId: 'r2', roundNumber: 2, createdAt: 5_000 })],
    reports: [
      report({ roundId: 'r1', planId: 'p1', status: 'failed', evidence: { refs: [evidence('a.ts')] } }),
      report({ roundId: 'r2', planId: 'p2', status: 'completed', evidence: { refs: [evidence('b.ts')] } })
    ],
    events: []
  });

  assert.equal(records.length, 2);
  assert.deepEqual(records.map(item => item.roundId), ['r1', 'r2']);
  assert.equal(records[0].outcome, 'failed');
  assert.equal(records[1].outcome, 'completed');
  assert.deepEqual(records[0].evidenceRefs.map(item => item.path), ['a.ts']);
  assert.deepEqual(records[1].evidenceRefs.map(item => item.path), ['b.ts']);
  // 每次执行可独立寻址
  assert.notEqual(records[0].executionId, records[1].executionId);
});

test('同一轮两份报告（口径重判）→ 仍是一条执行，结论取最新、证据取并集', () => {
  const records = buildExecutionHistory({
    task: { taskId: 't1' },
    rounds: [round()],
    reports: [
      report({ createdAt: 2_000, status: 'failed', errors: [{ code: 'E1', message: '测试没跑' }], evidence: { refs: [evidence('a.ts')] } }),
      report({ createdAt: 3_000, status: 'completed', evidence: { refs: [evidence('a.ts'), evidence('b.ts')] } })
    ],
    events: []
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'completed');
  assert.equal(records[0].evidenceRefs.length, 2, '重复证据按身份去重，不同证据并集保留');
  assert.deepEqual(records[0].failureReasons, ['E1: 测试没跑'], '早先报告的失败原因不因重判而消失');
});

test('runId：优先本轮事件，其次任务字段，都没有就如实为 null', () => {
  const withEventRun = buildExecutionHistory({
    task: { taskId: 't1', runId: 'run-task' },
    rounds: [round()],
    reports: [],
    events: [{ type: 'round.started', at: 1_100, taskId: 't1', roundId: 'r1', roundNumber: 1, inputType: 'user_prompt', runId: 'run-event' }]
  });
  assert.equal(withEventRun[0].runId, 'run-event');

  const withTaskRun = buildExecutionHistory({ task: { taskId: 't1', runId: 'run-task' }, rounds: [round()], reports: [], events: [] });
  assert.equal(withTaskRun[0].runId, 'run-task');

  // 老任务：runId 字段是后加的，缺失时不得伪造
  const legacy = buildExecutionHistory({ task: { taskId: 't1' }, rounds: [round()], reports: [], events: [] });
  assert.equal(legacy[0].runId, null);
});

test('成员按身份去重合并，未记录身份的成员如实标注而不是冒充模型', () => {
  const records = buildExecutionHistory({
    task: { taskId: 't1' },
    rounds: [round()],
    reports: [],
    events: [
      { type: 'round.peer', at: 1_100, taskId: 't1', roundId: 'r1', memberId: 'm1', label: 'DeepSeek', status: 'answered', providerId: 'deepseek', modelId: 'chat' },
      { type: 'round.delta', at: 1_200, taskId: 't1', roundId: 'r1', participantId: 'm1', text: 'hi' },
      { type: 'step.started', at: 1_300, taskId: 't1', roundId: 'r1', stepId: 's1', tool: 'fs.writeFile', participantId: 'm2' },
      { type: 'round.answer', at: 1_400, taskId: 't1', roundId: 'r1', text: '计划正文' }
    ]
  });

  const participants = records[0].participants;
  assert.equal(participants.length, 3, 'm1 / m2 / 一个未记录身份的答话者');
  const m1 = participants.find(item => item.id === 'm1');
  assert.equal(m1.status, 'answered');
  assert.equal(m1.modelId, 'chat');
  assert.equal(m1.answered, true);
  const anonymous = participants.find(item => item.id === null);
  assert.equal(anonymous.label, '未记录成员');
  // 没有 participantId 的步骤事件不得被并入某个具名成员
  assert.equal(participants.filter(item => item.id !== null).length, 2);
});

test('无报告轮：如实标「没有执行报告」，步骤从事件推导，不把缺失误报为通过', () => {
  const records = buildExecutionHistory({
    task: { taskId: 't1' },
    rounds: [round({ status: 'executing' })],
    reports: [],
    events: [
      { type: 'step.started', at: 1_500, taskId: 't1', roundId: 'r1', stepId: 's1', tool: 'test.run' },
      { type: 'step.failed', at: 1_600, taskId: 't1', roundId: 'r1', stepId: 's1', tool: 'test.run', error: '编译不过' }
    ]
  });

  const record = records[0];
  assert.equal(record.sources.report, false);
  assert.equal(record.outcome, null, '没有报告就没有执行结论');
  assert.equal(record.verified, null, '「未记录验证」不等于未通过');
  assert.equal(record.changedFiles, null);
  assert.deepEqual(record.deliverables, []);
  assert.equal(record.steps.total, 1);
  assert.equal(record.steps.failed, 1);
  assert.deepEqual(record.failureReasons, ['test.run: 编译不过']);
  assert.equal(record.durationMs, null, '还在跑的执行不能拿最后一条事件的时间当成已收口时长');
});

test('没有轮次记录但有报告 → 仍列出这条执行，并标出缺轮次记录', () => {
  const records = buildExecutionHistory({
    task: { taskId: 't1' },
    rounds: [],
    reports: [report({ roundId: 'r9' })],
    events: []
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].roundId, 'r9');
  assert.equal(records[0].sources.round, false);
  assert.equal(records[0].roundNumber, null);
});

test('排序按轮次号，不按落库先后', () => {
  const records = buildExecutionHistory({
    task: { taskId: 't1' },
    rounds: [round({ roundId: 'r2', roundNumber: 2 }), round({ roundId: 'r1', roundNumber: 1 })],
    reports: [report({ roundId: 'r1', createdAt: 9_000 }), report({ roundId: 'r2', createdAt: 8_000 })],
    events: []
  });
  assert.deepEqual(records.map(item => item.roundNumber), [1, 2]);
});

test('交付与改动只认报告记录，changedPaths 优先于 checks.changedFiles', () => {
  const [withPaths] = buildExecutionHistory({
    task: { taskId: 't1' },
    rounds: [round()],
    reports: [report({ verification: { verified: true, reasons: [], changedFiles: 2, changedPaths: ['a.ts', 'b.ts'] } })],
    events: []
  });
  assert.deepEqual(withPaths.deliverables, ['a.ts', 'b.ts']);
  assert.equal(withPaths.changedFiles, 2);
  assert.equal(withPaths.fullyVerified, null, '老报告没有 fullyVerified，不得默认算全过');

  const [onlyChecks] = buildExecutionHistory({
    task: { taskId: 't1' },
    rounds: [round()],
    reports: [
      report({
        verification: {
          verified: false,
          reasons: ['改了文件但没有成功的测试'],
          changedFiles: 1,
          checks: { changedFiles: ['c.ts'] }
        }
      })
    ],
    events: []
  });
  assert.deepEqual(onlyChecks.deliverables, ['c.ts']);
  assert.deepEqual(onlyChecks.failureReasons, ['改了文件但没有成功的测试']);
});

test('别的任务的报告不混进来；没有 roundId 的事件不污染任何一条执行', () => {
  const records = buildExecutionHistory({
    task: { taskId: 't1' },
    rounds: [round()],
    reports: [report({ taskId: 't2', roundId: 'r-other', evidence: { refs: [evidence('other.ts')] } })],
    events: [{ type: 'step.started', at: 1_000, taskId: 't1', stepId: 's1', tool: 'fs.list' }]
  });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].evidenceRefs, []);
  assert.equal(records[0].sources.events, 0);
});
