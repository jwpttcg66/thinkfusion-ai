/** B-02/B-03/B-07 数据层：参与者/证据/交付 View。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { runCollaboration } from '../out-test/main/collaboration/engine.js';
import { buildCollaborationDetails } from '../out-test/main/collaboration/details.js';
import { deliver } from '../out-test/main/collaboration/deliver/deliver.js';

const goal = { goalId: 'g1', workspace: 'general', statement: '什么是递归', constraints: [], acceptance: ['结论'], createdAt: 1 };
const participants = [{ participantId: 'm1', label: 'm1', kind: 'cloud', capabilities: ['reasoning', 'knowledge'], available: true }];

test('参与者状态/输出、证据、交付映射', async () => {
  const manager = { ask: async () => [{ participantId: 'm1', status: 'done', text: '递归是函数调用自身' }] };
  const result = await runCollaboration({ goal, participants, manager });
  let state = result.state;
  state = {
    ...state,
    evidence: [{
      evidenceId: 'e1', kind: 'code', scope: { goalId: 'g1', taskId: 't-analyze-0' },
      source: { commit: 'abc', capturedAt: 1 }, hash: 'h', trust: 'verified', summary: '文件证据'
    }]
  };
  state = { ...state, deliverable: deliver(state) };
  const details = buildCollaborationDetails(state);
  assert.equal(details.participants[0].status, 'done');
  assert.match(details.participants[0].outputPreview, /递归/);
  assert.equal(details.evidence[0].trust, 'verified');
  assert.equal(details.deliverable.stopReason, 'acceptance_satisfied');
});

test('工程/知识 View 映射', async () => {
  const manager = { ask: async () => [{ participantId: 'm1', status: 'done', text: 'ok' }] };
  const base = (await runCollaboration({ goal, participants, manager })).state;
  const engineering = buildCollaborationDetails({
    ...base,
    engineering: { taskId: 't', context: { repoRoot: '/r', branch: 'b' }, testReports: [{ command: 'npm test', status: 'passed' }] }
  });
  assert.equal(engineering.engineering.repoRoot, '/r');
  assert.equal(engineering.engineering.tests[0].status, 'passed');
  assert.ok(engineering.engineering.progress.total > 0);

  const knowledge = buildCollaborationDetails({
    ...base,
    goal: { ...base.goal, workspace: 'knowledge' },
    claims: [{ claimId: 'c1', goalId: 'g1', text: '结论', kind: 'fact', source: { evidenceId: 'e1' }, createdAt: 1 }]
  });
  assert.equal(knowledge.knowledge.unanswered.length, 1);
  assert.equal(knowledge.knowledge.unanswered[0].evidenceRefs[0], 'e1');
});
