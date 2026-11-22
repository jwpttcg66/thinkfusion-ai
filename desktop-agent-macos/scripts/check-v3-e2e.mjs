/** E-01/E-03：三空间端到端与产品一致性。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCollaboration } from '../out-test/main/collaboration/engine.js';
import { routeParticipants } from '../out-test/main/collaboration/routing.js';
import { MemoryService } from '../out-test/main/memory/service.js';
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

test('Knowledge：记忆写入 → 重启 → 新会话可召回', () => {
  // 旧的 KnowledgeStore/Index 是生产零调用的死代码，已退役。这条回归改为
  // 验收真正接线的全局记忆，避免「测试给死代码作证」。
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-e2e-k-'));
  const file = path.join(d, 'memory.sqlite');
  const a = new MemoryService({ file });
  const r = a.remember({
    kind: 'fact', scope: 'PROJECT', scopeId: 'p_a',
    title: 'SETNX 可做锁', content: 'SETNX 可做分布式锁', status: 'active'
  });
  a.close();
  const b = new MemoryService({ file });
  assert.ok(b.getRecord(r.memoryId), '重启后记录仍在');
  assert.ok(b.recall({ question: 'SETNX', conversationId: 'c1', projectId: 'p_a' })
    .included.some(x => x.memoryId === r.memoryId), '新会话能召回');
  b.close();
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
