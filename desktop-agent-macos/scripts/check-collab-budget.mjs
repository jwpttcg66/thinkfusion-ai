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

test('auto：L0 不进五段；on 仍进', () => {
  const read = plan([{ id: '1', tool: 'fs.readFile', args: { path: 'a' } }]);
  assert.equal(shouldDebatePlan('auto', read).debate, false);
  assert.equal(shouldDebatePlan('on', read).debate, true);
});

test('模型审核门禁：规则已有问题或 L0 验证通过 → 不调模型', async () => {
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
  assert.equal(gate.model, false);

  let asked = 0;
  const verdict = await reviewExecution(reportOk, readPlan, {
    ask: async () => {
      asked += 1;
      return '【结论】通过';
    }
  });
  assert.equal(asked, 0);
  assert.equal(verdict.backend, 'rules');
  assert.match(verdict.verdict, /未调用模型|没有发现可核查/);
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
