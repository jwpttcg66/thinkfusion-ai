/** P1-02/P1-03：规则 Planner 与 Scheduler。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planGoal } from '../out-test/main/collaboration/planner/planner.js';
import { schedule } from '../out-test/main/collaboration/scheduler/scheduler.js';

const goal = (statement, workspace = 'general') => ({
  goalId: 'g1', workspace, statement, constraints: [], acceptance: ['给出结论'], createdAt: 1
});
const p = (id, kind, available = true, capabilities = ['reasoning', 'knowledge']) => ({
  participantId: id, label: id, kind, capabilities, available, ...(available ? {} : { reason: '未登录' })
});

test('简单问题：1 个参与者、2 个任务（分析+汇总）', () => {
  const participants = [p('cloud', 'cloud'), p('local', 'local'), p('web', 'web')];
  const plan = planGoal(goal('什么是递归'), participants);
  assert.equal(plan.participants.length, 1);
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[1].kind, 'synthesize');
  assert.equal(plan.policy.minParticipants, 1);
  assert.equal(plan.behavior, 'independent');
});

test('比较问题：crosscheck，2 组分析 + 2 组复核 + 汇总', () => {
  const participants = [p('cloud', 'cloud'), p('local', 'local'), p('web', 'web')];
  const plan = planGoal(goal('比较 Envoy 和 Nginx 的优劣'), participants);
  assert.equal(plan.participants.length, 2);
  assert.equal(plan.behavior, 'crosscheck');
  assert.equal(plan.tasks.filter(t => t.kind === 'analyze').length, 2);
  assert.equal(plan.tasks.filter(t => t.kind === 'review').length, 2);
  assert.equal(plan.tasks.length, 5);
});

test('复杂分析：parallel，2 分析 + 汇总', () => {
  const plan = planGoal(goal('分析 Redis 连接数过高的原因'), [p('cloud', 'cloud'), p('local', 'local')]);
  assert.equal(plan.behavior, 'parallel');
  assert.equal(plan.tasks.length, 3);
});

test('工程只读：progressive，分析→验证→汇总', () => {
  const plan = planGoal(goal('分析这个仓库的分层', 'engineering'), [p('web', 'web'), p('cloud', 'cloud')]);
  assert.equal(plan.behavior, 'progressive');
  assert.deepEqual(plan.tasks.map(t => t.kind), ['analyze', 'analyze', 'verify', 'synthesize']);
});

test('工程写操作：crosscheck', () => {
  const plan = planGoal(goal('修复 a.ts 的 bug', 'engineering'), [p('web', 'web'), p('cloud', 'cloud')]);
  assert.equal(plan.behavior, 'crosscheck');
  assert.equal(plan.tasks.filter(t => t.kind === 'review').length, 2);
});

test('范围过滤：local 不选 cloud；web 由 includeWeb 决定', () => {
  const participants = [p('cloud', 'cloud'), p('local', 'local'), p('web', 'web')];
  const plan = planGoal(goal('什么是递归'), participants, { modelScope: 'local', includeWeb: false });
  assert.deepEqual(plan.participants.map(x => x.participantId), ['local']);
  assert.ok(plan.skipped.some(x => x.participantId === 'cloud'));
});

test('工程模式：只有网页时拒绝；合成者非网页', () => {
  assert.throws(
    () => planGoal(goal('分析这个仓库', 'engineering'), [p('web', 'web')]),
    /至少需要一个本地\/云端/
  );
  const plan = planGoal(goal('分析这个仓库', 'engineering'), [p('web', 'web'), p('cloud', 'cloud')]);
  const synth = plan.tasks.find(t => t.kind === 'synthesize');
  assert.equal(synth.context.participantId, 'cloud');
});

test('Scheduler：按计划分配；不可用/越界/缺能力拒绝', () => {
  const participants = [p('cloud', 'cloud'), p('local', 'local')];
  const plan = planGoal(goal('什么是递归'), participants);
  const assignments = schedule(plan, participants);
  assert.equal(assignments.length, plan.tasks.length);
  assert.deepEqual(assignments.map(a => a.participantId), plan.tasks.map(t => t.context.participantId));
  assert.throws(() => schedule(plan, [p('cloud', 'cloud', false)]), /不可用/);
  const localOnly = planGoal(goal('什么是递归'), [p('local', 'local')], { modelScope: 'local', includeWeb: false });
  assert.throws(() => schedule(localOnly, [p('cloud', 'cloud')]), /未知参与者/);
});
