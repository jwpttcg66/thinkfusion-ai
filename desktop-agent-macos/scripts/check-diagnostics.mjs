import assert from 'node:assert/strict';
import test from 'node:test';
import { auditActivity, buildDiagnosticBundle } from '../out-test/shared/diagnostics.js';

const ev = (eventId, sequence, category = 'tool') => ({
  eventId, taskId: 't', runId: 't', sequence, occurredAt: sequence,
  actor: { type: 'system', id: 's', label: 's' }, category, phase: 'completed',
  payload: { type: 'step.completed', apiKey: 'secret', result: { exitCode: 0 } }
});

test('事件关联检查能发现重复与乱序', () => {
  const audit = auditActivity([ev('a', 2), ev('a', 2), ev('b', 1)]);
  assert.deepEqual(audit.duplicateEventIds, ['a']);
  assert.equal(audit.outOfOrder, 1);
  assert.equal(audit.total, 3);
});

test('诊断包导出前脱敏并保留原始事件/运行事件', () => {
  const bundle = buildDiagnosticBundle({
    taskId: 't', task: { taskId: 't', title: 'x', apiKey: 'secret' },
    plan: { apiKey: 'secret' }, events: [{ type: 'log', at: 1, taskId: 't', level: 'info', message: 'm', apiKey: 'secret' }],
    runEvents: [], activity: [ev('a', 1)]
  });
  assert.equal(bundle.task.apiKey, '***');
  assert.equal(bundle.plan.apiKey, '***');
  assert.equal(bundle.events[0].apiKey, '***');
  assert.equal(bundle.audit.total, 1);
});
