import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewExecution } from '../out-test/main/engineering/review.js';

const report = {
  protocol: 'desktop-agent/v1', type: 'execution_report', taskId: 't', roundId: 'r', planId: 'p',
  status: 'completed', results: [], errors: [], nextAction: 'complete', createdAt: 1,
  verification: { verified: true, reasons: [], changedFiles: 0 }
};
const plan = { steps: [] };

test('评审只有“需修复”结论、没有问题项时不阻塞交付', async () => {
  const verdict = await reviewExecution(report, plan, {
    reviewer: 'model', ask: async () => '【结论】需修复'
  });
  assert.equal(verdict.needsFix, false);
  assert.deepEqual(verdict.issues, []);
});

test('评审给出具体问题时仍阻塞', async () => {
  const verdict = await reviewExecution(report, plan, {
    reviewer: 'model', ask: async () => '【结论】需修复\n- 测试未覆盖用户校验失败分支'
  });
  assert.equal(verdict.needsFix, true);
  assert.match(verdict.issues.join('\n'), /未覆盖/);
});
