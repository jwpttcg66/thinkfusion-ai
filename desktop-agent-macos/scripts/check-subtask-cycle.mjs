/**
 * P1-02：子任务独立 Cycle。
 *
 * 覆盖：每个 L2 有独立 cycleId、步骤归属、阶段推进、失败只阻塞依赖者、
 * 跨子任务写冲突、主任务集成的结论汇总、以及从事件重放。
 * Run: npm run test:subtask-cycle
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { seedWorkEventsFromPlan } from '../out-test/shared/task-decomposition.js';
import {
  advanceSubtaskCycle,
  buildSubtaskCycles,
  dependentSubtasksToBlock,
  detectSubtaskConflicts,
  integrateSubtaskCycles,
  projectSubtaskCyclesFromEvents
} from '../out-test/shared/subtask-cycle.js';

const plan = {
  planId: 'p1',
  taskId: 'work-1',
  roundId: 'r1',
  title: '两段改造',
  description: '两个子任务',
  completion: '都通过',
  steps: [
    { id: 's1', tool: 'fs.writeFile', description: '写 a', args: { path: 'src/a.ts', content: 'a' } },
    { id: 's2', tool: 'code.run', description: '跑测试', args: { command: 'npm test' } },
    { id: 's3', tool: 'fs.writeFile', description: '写 b', args: { path: 'src/b.ts', content: 'b' } }
  ],
  decomposition: [
    { id: 't1', title: '改 A', acceptanceCriteria: ['a 写入'], stepIds: ['s1', 's2'] },
    { id: 't2', title: '改 B', acceptanceCriteria: ['b 写入'], stepIds: ['s3'] }
  ]
};

function tasksOf() {
  const events = seedWorkEventsFromPlan({ workId: 'work-1', title: plan.title, plan, at: 1 });
  return events;
}

function project(tasks, events) {
  return buildSubtaskCycles({ workId: 'work-1', tasks, at: 1 });
}

test('每个 L2 有独立 cycleId，步骤跟随所属子任务', () => {
  const events = tasksOf();
  const l2 = events.filter(event => event.type === 'work.task.upserted' && event.task.level === 2).map(e => e.task);
  assert.equal(l2.length, 2);
  assert.equal(l2[0].cycleId, 'cycle:work-1:wt-task-t1');
  assert.equal(l2[1].cycleId, 'cycle:work-1:wt-task-t2');
  assert.notEqual(l2[0].cycleId, l2[1].cycleId);

  const steps = events.filter(event => event.type === 'work.task.upserted' && event.task.level === 3).map(e => e.task);
  assert.equal(steps.find(step => step.workTaskId === 'wt-s1').cycleId, 'cycle:work-1:wt-task-t1');
  assert.equal(steps.find(step => step.workTaskId === 'wt-s3').cycleId, 'cycle:work-1:wt-task-t2');
});

test('循环视图：分析/设计随计划定稿，依赖未满足的子任务标 blocked', () => {
  const events = tasksOf();
  const tasks = events.filter(e => e.type === 'work.task.upserted').map(e => e.task);
  const planView = project(tasks, events);
  assert.deepEqual(planView.order, ['wt-task-t1', 'wt-task-t2']);
  const [first, second] = planView.cycles;
  assert.deepEqual(first.stepIds, ['s1', 's2']);
  assert.deepEqual(first.stagesCompleted, ['analysis', 'design']);
  assert.equal(first.stage, 'implementation');
  assert.equal(second.verdict, 'pending');
  assert.deepEqual(planView.blocked.map(item => item.workTaskId), ['wt-task-t2']);
  assert.deepEqual(planView.blocked[0].blockedBy, ['wt-task-t1']);
  assert.match(second.notes.join(), /分析\/设计随计划定稿/);
});

test('阶段推进：开始→实现，全部完成→审核，失败→只这一条失败', () => {
  const events = tasksOf();
  const tasks = events.filter(e => e.type === 'work.task.upserted').map(e => e.task);
  const view = project(tasks, events).cycles[0];

  const started = advanceSubtaskCycle(view, { kind: 'step.started', stepId: 's1', at: 2 }).view;
  assert.equal(started.stage, 'implementation');
  const half = advanceSubtaskCycle(started, { kind: 'step.completed', stepId: 's1', at: 3 }).view;
  assert.equal(half.stage, 'implementation');
  assert.deepEqual(half.completedStepIds, ['s1']);
  const done = advanceSubtaskCycle(half, { kind: 'step.completed', stepId: 's2', at: 4 }).view;
  assert.equal(done.stage, 'review');
  assert.deepEqual(done.stagesCompleted, ['analysis', 'design', 'implementation']);

  const failed = advanceSubtaskCycle(started, { kind: 'step.failed', stepId: 's1', at: 5, error: '编译失败' }).view;
  assert.equal(failed.verdict, 'failed');
  assert.deepEqual(failed.failedStepIds, ['s1']);
  assert.match(failed.notes.join(), /编译失败/);

  // 别家步骤不影响这一条。
  assert.equal(advanceSubtaskCycle(view, { kind: 'step.failed', stepId: 's3', at: 6 }).changed, false);
});

test('失败只阻塞依赖者（含传递依赖），不判它们失败', () => {
  const events = tasksOf();
  const tasks = events.filter(e => e.type === 'work.task.upserted').map(e => e.task);
  assert.deepEqual(dependentSubtasksToBlock(tasks, 'wt-task-t1'), ['wt-task-t2']);
  assert.deepEqual(dependentSubtasksToBlock(tasks, 'wt-task-t2'), []);
});

test('跨子任务写同一文件才算冲突；同一子任务多次写不算', () => {
  const events = tasksOf();
  const tasks = events.filter(e => e.type === 'work.task.upserted').map(e => e.task);
  const cycles = project(tasks, events).cycles;
  const sameSubtask = detectSubtaskConflicts({
    cycles,
    results: [
      { stepId: 's1', tool: 'fs.writeFile', args: { path: 'src/a.ts' } },
      { stepId: 's2', tool: 'fs.writeFile', args: { path: 'src/a.ts' } }
    ]
  });
  assert.deepEqual(sameSubtask, []);

  const conflict = detectSubtaskConflicts({
    cycles,
    results: [
      { stepId: 's1', tool: 'fs.writeFile', args: { path: 'src/shared.ts' } },
      { stepId: 's3', tool: 'fs.writeFile', args: { path: './src/shared.ts' } }
    ]
  });
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0].path, 'src/shared.ts');
  assert.deepEqual(conflict[0].workTaskIds, ['wt-task-t1', 'wt-task-t2']);
  assert.match(conflict[0].reason, /2 个子任务都写入/);
});

test('主任务集成：结论按子任务计数，不写「大体完成」', () => {
  const events = tasksOf();
  const tasks = events.filter(e => e.type === 'work.task.upserted').map(e => e.task);
  const cycles = project(tasks, events).cycles;
  const partial = integrateSubtaskCycles([{ ...cycles[0], verdict: 'accepted' }, cycles[1]]);
  assert.equal(partial.allAccepted, false);
  assert.equal(partial.accepted, 1);
  assert.equal(partial.pending, 1);
  assert.match(partial.summary, /共 2 个子任务 · 通过 1 · 未完成 1/);

  const all = integrateSubtaskCycles(cycles.map(item => ({ ...item, verdict: 'accepted' })));
  assert.equal(all.allAccepted, true);
  assert.deepEqual(integrateSubtaskCycles([]).allAccepted, false);
});

test('从事件重放：步骤失败 + 子任务状态事件都能落到循环上', () => {
  const seed = tasksOf();
  const tasks = seed.filter(e => e.type === 'work.task.upserted').map(e => e.task);
  const events = [
    ...seed,
    { type: 'step.started', at: 10, taskId: 'work-1', roundId: 'r1', stepId: 's1', callId: 's1', tool: 'fs.writeFile', args: {} },
    { type: 'step.failed', at: 11, taskId: 'work-1', roundId: 'r1', stepId: 's1', callId: 's1', tool: 'fs.writeFile', args: {}, error: '写失败' },
    { type: 'work.task.status', at: 12, taskId: 'work-1', workId: 'work-1', workTaskId: 'wt-task-t1', status: 'failed', expectedRevision: 1 },
    { type: 'work.task.status', at: 13, taskId: 'work-1', workId: 'work-1', workTaskId: 'wt-task-t2', status: 'blocked', expectedRevision: 1 }
  ];
  const replay = projectSubtaskCyclesFromEvents({ workId: 'work-1', tasks, events });
  const first = replay.cycles.find(item => item.workTaskId === 'wt-task-t1');
  const second = replay.cycles.find(item => item.workTaskId === 'wt-task-t2');
  assert.equal(first.verdict, 'failed');
  assert.deepEqual(first.failedStepIds, ['s1']);
  assert.equal(second.verdict, 'blocked');
});

test('步骤全部完成而 L2 没有终态事件时，按步骤事实判为通过（不永远停在 pending）', () => {
  const seed = tasksOf();
  const tasks = seed.filter(e => e.type === 'work.task.upserted').map(e => e.task);
  const events = [
    ...seed,
    { type: 'step.started', at: 10, taskId: 'work-1', roundId: 'r1', stepId: 's1', callId: 's1', tool: 'fs.writeFile', args: {} },
    { type: 'step.completed', at: 11, taskId: 'work-1', roundId: 'r1', stepId: 's1', callId: 's1', tool: 'fs.writeFile', args: {} },
    { type: 'step.started', at: 12, taskId: 'work-1', roundId: 'r1', stepId: 's2', callId: 's2', tool: 'code.run', args: {} },
    { type: 'step.completed', at: 13, taskId: 'work-1', roundId: 'r1', stepId: 's2', callId: 's2', tool: 'code.run', args: {} }
  ];
  const replay = projectSubtaskCyclesFromEvents({ workId: 'work-1', tasks, events });
  const first = replay.cycles.find(item => item.workTaskId === 'wt-task-t1');
  assert.equal(first.verdict, 'accepted');
  assert.equal(first.stage, 'done');
  assert.deepEqual(first.completedStepIds.sort(), ['s1', 's2']);
});
