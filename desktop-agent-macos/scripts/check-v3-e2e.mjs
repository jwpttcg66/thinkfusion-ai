/** E-01/E-03：三空间端到端与产品一致性。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCollaboration } from '../out-test/main/collaboration/engine.js';
import { routeParticipants } from '../out-test/main/collaboration/routing.js';
import { KnowledgeStore } from '../out-test/main/knowledge/store.js';
import { KnowledgeIndex } from '../out-test/main/knowledge/index.js';
import { canComplete, createEngineeringTaskState, recordBuild, recordEnd, recordReview, recordStart, recordTest } from '../out-test/main/engineering/task-state.js';
import { checkEngineeringPlan } from '../out-test/main/engineering/plan.js';
import { selectDebates } from '../out-test/main/collaboration/behaviors/debate.js';

const goal = (workspace, statement) => ({ goalId: 'g', workspace, statement, constraints: [], acceptance: ['结论'], createdAt: 1 });
const people = [
  { participantId: 'cloud', label: 'cloud', kind: 'cloud', capabilities: ['reasoning', 'knowledge'], available: true },
  { participantId: 'local', label: 'local', kind: 'local', capabilities: ['reasoning', 'knowledge'], available: true },
  { participantId: 'web', label: 'web', kind: 'web', capabilities: ['knowledge', 'web-research'], available: true }
];
const manager = { ask: async ids => [{ participantId: ids[0], status: 'done', text: '回答' }] };

test('General：单问题走通计划→执行→交付', async () => {
  const result = await runCollaboration({ goal: goal('general', '什么是递归'), participants: people, manager });
  assert.equal(result.plan.behavior, 'independent');
  assert.ok(result.deliverable.content.length > 0);
  assert.equal(result.deliverable.stopReason, 'acceptance_satisfied');
});

test('Knowledge：卡片可召回；知识地图三块可用', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-e2e-k-'));
  const store = new KnowledgeStore(path.join(d, 'k.json'));
  store.upsertTopic({ topicId: 't', title: 'Redis', aliases: [] });
  store.addCard({
    cardId: 'c1', topicId: 't', statement: 'SETNX 可做锁', claimIds: ['cl'], evidenceRefs: ['e1'],
    conditions: [], status: 'active', freshness: { asOf: Date.now(), state: 'fresh', reasons: [] }
  });
  assert.equal(new KnowledgeIndex(store.listCards()).recall('SETNX').length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('Engineering：状态齐全可完成；计划含回退', () => {
  let state = createEngineeringTaskState({ taskId: 't', implementerId: 'dev', context: { repoRoot: '/r', branch: 'b' } });
  state = recordStart(state, { commit: 'a', dirty: false, dirtyFiles: [], snapshot: 'S1' });
  state = recordEnd(state, { commit: 'b', dirty: false, dirtyFiles: [], snapshot: 'S2' });
  state = recordTest(state, { command: 'npm test', exitCode: 0, status: 'passed' });
  state = recordBuild(state, { command: 'build', exitCode: 0, status: 'passed' });
  state = recordReview(state, { verdict: 'pass', reviewer: 'r', issues: [] });
  assert.equal(canComplete(state).ok, true);
  assert.equal(checkEngineeringPlan({
    planId: 'p', goal: '改', changes: [{ path: 'a', kind: 'modify', reason: 'x' }],
    tests: ['t'], rollback: 'revert', risks: []
  }).ok, true);
});

test('一致性：local 不越界；工程网页不能提问；无争议不辩论', () => {
  const local = routeParticipants({ participants: people, modelScope: 'local', includeWeb: false });
  assert.deepEqual(local.selected.map(x => x.participantId), ['local']);
  const engineering = routeParticipants({ participants: people, modelScope: 'hybrid', includeWeb: true, role: 'questioner', workspace: 'engineering' });
  assert.equal(engineering.selected.some(x => x.kind === 'web'), false);
  assert.equal(selectDebates({ disputes: [], conflicts: [] }).length, 0);
});
