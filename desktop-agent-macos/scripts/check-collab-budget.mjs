/**
 * CB：辩论/审核按需门禁 + 核心意见去重。
 * Run: npm run test:collab-budget
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessCollaborationRisk,
  shouldDebatePlan
} from '../out-test/main/engineering/plan-review.js';
import {
  shouldModelReviewExecution,
  reviewExecution
} from '../out-test/main/engineering/review.js';
import {
  dedupeOpinions,
  selectKeyOpinions
} from '../out-test/shared/collaboration-result.js';

const plan = (steps, extra = {}) => ({
  id: 'p',
  title: 't',
  description: 'd',
  steps,
  completion: { condition: 'ok' },
  ...extra
});

test('风险定级：只读 L0；带测试的单文件写入 L1；裸写入缺判据 L2；设计 L3', () => {
  assert.equal(
    assessCollaborationRisk(plan([
      { id: '1', tool: 'fs.list', args: { path: '.' } }
    ])).level,
    'L0'
  );
  assert.equal(
    assessCollaborationRisk(plan([
      { id: '1', tool: 'fs.writeFile', args: { path: 'a.ts', content: 'x' } },
      { id: '2', tool: 'test.run', args: { command: 'npm test' } }
    ])).level,
    'L1'
  );
  assert.equal(
    assessCollaborationRisk(plan([
      { id: '1', tool: 'fs.writeFile', args: { path: 'a.ts', content: 'x' } }
    ])).level,
    'L2'
  );
  assert.equal(
    assessCollaborationRisk(plan([], {
      kind: 'design',
      design: { document: 'doc', viewpoints: ['a'] }
    })).level,
    'L3'
  );
});

test('auto/on：L0 也进五段，由模型定辩题；off 才整段关', () => {
  const read = plan([{ id: '1', tool: 'fs.readFile', args: { path: 'a' } }]);
  assert.equal(shouldDebatePlan('auto', read).debate, true);
  assert.equal(shouldDebatePlan('on', read).debate, true);
  assert.equal(shouldDebatePlan('off', read).debate, false);
});

test('模型审核：验证通过也一定问模型；规则待修项不替代模型结论', async () => {
  const readPlan = plan([{ id: '1', tool: 'fs.list', args: { path: '.' } }]);
  const reportOk = {
    status: 'completed',
    results: [{ tool: 'fs.list', status: 'completed', args: { path: '.' }, result: { entries: [] } }],
    errors: [],
    verification: {
      verified: true,
      reasons: [],
      changedFiles: 0,
      checks: {
        compile: { status: 'skipped' },
        run: { status: 'skipped' },
        tests: { status: 'skipped' },
        diagnostics: { status: 'skipped', errors: 0, warnings: 0 },
        changedFiles: []
      }
    }
  };
  const gate = shouldModelReviewExecution(reportOk, readPlan, []);
  assert.equal(gate.model, true);

  let asked = 0;
  const verdict = await reviewExecution(reportOk, readPlan, {
    ask: async () => {
      asked += 1;
      return '【结论】通过';
    }
  });
  assert.equal(asked, 1);
  assert.equal(verdict.backend, 'model');
  assert.match(verdict.verdict, /通过/);
});

test('意见去重：同文案只留一条；补充摘要有上限', () => {
  const core = [
    { opinionId: '1', author: 'A', position: 'support', statement: '应写测试', sourceRefs: [], evidenceRefs: [], targetRefs: [] },
    { opinionId: '2', author: 'B', position: 'support', statement: '应写测试', sourceRefs: [], evidenceRefs: [], targetRefs: [] }
  ];
  const supplements = Array.from({ length: 20 }, (_, i) => ({
    opinionId: `s${String(i)}`,
    author: `M${String(i)}`,
    position: 'supplement',
    statement: `补充看法 ${String(i)} 关于目录列表`,
    sourceRefs: [],
    evidenceRefs: [],
    targetRefs: []
  }));
  assert.equal(dedupeOpinions(core).length, 1);
  const selected = selectKeyOpinions({ core, supplements });
  assert.ok(selected.rawCount >= 21);
  assert.ok(selected.supplementCount <= 6);
  assert.ok(selected.opinions.length <= 12 + 6);
});
