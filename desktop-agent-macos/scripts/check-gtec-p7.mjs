/**
 * GTEC P7：UI 投影契约（无 Electron）。
 * Run: npm run test:gtec-p7
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyEcoGateToDecision, decideParticipation, projectDmocaFromEvents } from '../out-test/shared/dmoca.js';
import { buildEngineeringContextPackage, projectEcoFromEvents } from '../out-test/shared/eco.js';
import {
  computeWorkProgress,
  projectWorkBreakdownFromEvents,
  seedWorkEventsFromPlan
} from '../out-test/shared/task-decomposition.js';

test('P7：任务树投影含 L0/L1/L3 与 depth', () => {
  const events = seedWorkEventsFromPlan({
    workId: 'ui-w',
    title: 'ui',
    plan: {
      planId: 'p', taskId: 'ui-w', roundId: 'r', title: 'ui', description: 'd', completion: 'c',
      steps: [{ id: 's1', tool: 'fs.list', args: {} }]
    },
    at: 1
  });
  const view = projectWorkBreakdownFromEvents({ workId: 'ui-w', events, title: 'ui' });
  const levels = new Set(view.tasks.map(t => t.level));
  assert.ok(levels.has(0) && levels.has(1) && levels.has(3));
  assert.ok(view.tasks.every(t => typeof t.depth === 'number'));
});

test('P7：ECO 投影含充分度与门禁文案', () => {
  const pkg = buildEngineeringContextPackage({
    workId: 'ui-w', stage: 'design', role: 'architect',
    architectureSummary: '摘要',
    resources: [],
    now: 1
  });
  const eco = projectEcoFromEvents({
    workId: 'ui-w',
    events: [{ type: 'eco.context.prepared', taskId: 'ui-w', at: 1, package: pkg }]
  });
  assert.equal(eco.package?.sufficiency, 'insufficient');
  assert.equal(eco.canAssumeFormalRole, false);
  assert.ok(eco.gateReason.length > 0);
});

test('P7：DMOCA reasons 经 ECO gate 后可展示', () => {
  const decision = applyEcoGateToDecision(decideParticipation({
    workId: 'ui-w', stage: 'design', risk: 'L2',
    candidates: [{ id: 'a', available: true }, { id: 'b', available: true }],
    now: 1
  }), 'insufficient');
  assert.ok(decision.reasons.some(r => /ECO|insufficient|阻断/.test(r)));
  const dmoca = projectDmocaFromEvents({
    workId: 'ui-w',
    events: [{
      type: 'model.participation.selected',
      at: 1,
      taskId: 'ui-w',
      stage: decision.stage,
      risk: decision.risk,
      debate: decision.debate,
      modelReview: decision.modelReview,
      participants: decision.participants,
      excluded: decision.excluded,
      reasons: decision.reasons,
      userPinned: decision.userPinned
    }]
  });
  assert.ok(dmoca.decision?.reasons.some(r => /ECO|insufficient|阻断/.test(r)));
});

test('P7：进度 ratio 与叶子完成一致可展示', () => {
  const events = seedWorkEventsFromPlan({
    workId: 'ui-p',
    title: 'p',
    plan: {
      planId: 'p', taskId: 'ui-p', roundId: 'r', title: 'p', description: 'd', completion: 'c',
      steps: [
        { id: 's1', tool: 'fs.list', args: {} },
        { id: 's2', tool: 'fs.readFile', args: {} }
      ]
    },
    at: 1
  });
  const upserts = events.filter(e => e.type === 'work.task.upserted').map(e => e.task);
  const progress = computeWorkProgress(upserts);
  assert.equal(progress.ratio, 0);
  const view = projectWorkBreakdownFromEvents({ workId: 'ui-p', events, title: 'p' });
  assert.equal(view.summary.ratio, 0);
  assert.equal(view.summary.total, progress.total);
});
