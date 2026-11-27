/**
 * TDL L2 自动分解（P0-02）：需要 L2 时能归纳；不需要时不硬拆；归纳不出来要报 NEEDS_ANALYSIS。
 * Run: npm run test:tdl-decomposition
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decompositionWarnings,
  deriveDecompositionFromSteps,
  ensurePlanDecomposition,
  needsL2Decomposition,
  rebuildWorkTasksFromEvents,
  seedWorkEventsFromPlan
} from '../out-test/shared/task-decomposition.js';

const write = (id, path) => ({ id, tool: 'fs.writeFile', args: { path, content: 'x' } });
const read = id => ({ id, tool: 'fs.readFile', args: { path: 'README.md' } });

test('单一交付目标不硬拆：只读计划没有 L2，也不算 NEEDS_ANALYSIS', () => {
  const plan = { steps: [read('s1'), read('s2')] };
  assert.equal(needsL2Decomposition(plan), false);
  const result = ensurePlanDecomposition(plan);
  assert.equal(result.items.length, 0);
  assert.equal(result.needsAnalysis, false);
  assert.equal(result.source, 'none');
  assert.deepEqual(decompositionWarnings(result), []);
});

test('同一目录多份文件属于同一交付单元：不按文件数凑层级', () => {
  const plan = { steps: [write('s1', 'src/a.js'), write('s2', 'src/b.js'), write('s3', 'src/c.js')] };
  assert.equal(needsL2Decomposition(plan), true);
  assert.deepEqual(deriveDecompositionFromSteps(plan), []);
  const result = ensurePlanDecomposition(plan);
  assert.equal(result.items.length, 0);
  assert.equal(result.needsAnalysis, true);
  const warnings = decompositionWarnings(result);
  assert.match(warnings.join('\n'), /NEEDS_ANALYSIS/);
  assert.match(warnings.join('\n'), /没有 decomposition/);
});

test('两个独立写入目录：按目标归纳出 L2，且每个步骤都有归属', () => {
  const plan = {
    steps: [
      read('s1'),
      write('s2', 'src/main/a.ts'),
      { id: 's3', tool: 'test.run', args: { command: 'npm test' } },
      write('s4', 'src/renderer/b.tsx'),
      { id: 's5', tool: 'screen.capture', args: {} }
    ]
  };
  const result = ensurePlanDecomposition(plan);
  assert.equal(result.source, 'derived');
  assert.equal(result.needsAnalysis, false);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.flatMap(item => item.stepIds).sort(), ['s1', 's2', 's3', 's4', 's5']);
  // 前面的只读步骤跟随它后面第一个写入组，不会被单独拆成一个假子任务
  assert.deepEqual(result.items[0].stepIds, ['s1', 's2', 's3']);
  assert.deepEqual(result.items[1].stepIds, ['s4', 's5']);
  for (const item of result.items) {
    assert.ok(item.title.trim().length > 0);
    assert.ok((item.acceptanceCriteria ?? []).length > 0, '每个 L2 必须有独立验收标准');
  }
});

test('模型给了 decomposition：以模型为准，未覆盖步骤如实标出', () => {
  const plan = {
    steps: [write('s1', 'src/a.ts'), write('s2', 'src/b.ts'), write('s3', 'src/c.ts')],
    decomposition: [{ id: 't1', title: '只做 a', stepIds: ['s1'] }]
  };
  const result = ensurePlanDecomposition(plan);
  assert.equal(result.source, 'model');
  assert.deepEqual(result.uncoveredStepIds, ['s2', 's3']);
  assert.match(decompositionWarnings(result).join('\n'), /2 个步骤没有归属任何 L2/);
});

test('种树：L2 挂在 L1 下、L3 挂到对应 L2，并携带 goal 版本', () => {
  const plan = {
    planId: 'p1',
    taskId: 'w1',
    roundId: 'r1',
    title: '两处改动',
    description: '',
    completion: 'done',
    steps: [write('s1', 'src/main/a.ts'), write('s2', 'src/renderer/b.tsx')]
  };
  const events = seedWorkEventsFromPlan({
    workId: 'w1',
    title: '两处改动',
    plan,
    at: 1,
    goalId: 'goal:w1',
    goalVersion: 4
  });
  const tasks = [...rebuildWorkTasksFromEvents('w1', events).values()];
  const l2 = tasks.filter(task => task.level === 2);
  assert.equal(l2.length, 2);
  assert.deepEqual(l2.map(task => task.acceptanceCriteria.length > 0), [true, true]);
  const group = tasks.find(task => task.level === 1);
  assert.ok(l2.every(task => task.parentTaskId === group.workTaskId));
  for (const task of tasks) {
    assert.equal(task.goalId, 'goal:w1');
    assert.equal(task.goalVersion, 4);
  }
  const stepTasks = tasks.filter(task => task.level === 3);
  assert.equal(stepTasks.length, 2);
  assert.ok(stepTasks.every(task => l2.some(parent => parent.workTaskId === task.parentTaskId)));
});

test('种树：简单计划仍然只有 L1→L3，不凭空多一层', () => {
  const events = seedWorkEventsFromPlan({
    workId: 'w2',
    title: '读文件',
    plan: {
      planId: 'p2',
      taskId: 'w2',
      roundId: 'r2',
      title: '读文件',
      description: '',
      completion: 'done',
      steps: [read('s1')]
    },
    at: 1
  });
  const tasks = [...rebuildWorkTasksFromEvents('w2', events).values()];
  assert.equal(tasks.filter(task => task.level === 2).length, 0);
  assert.equal(tasks.filter(task => task.level === 3).length, 1);
});

test('GCE：单一 MUST Criterion 覆盖所有 L2，L3 继承父任务绑定', () => {
  const plan = {
    planId: 'p3', taskId: 'w3', roundId: 'r3', title: '两处改动', description: '',
    completion: 'done',
    steps: [write('s1', 'src/main/a.ts'), write('s2', 'src/renderer/b.tsx')]
  };
  const events = seedWorkEventsFromPlan({
    workId: 'w3', title: '两处改动', plan, at: 1,
    criteria: [{ criterionId: 'c1', description: '两处都改完并测试通过', priority: 'MUST' }]
  });
  const tasks = [...rebuildWorkTasksFromEvents('w3', events).values()];
  const l2 = tasks.filter(task => task.level === 2);
  const l3 = tasks.filter(task => task.level === 3);
  assert.ok(l2.length > 0);
  assert.ok(l2.every(task => task.criterionIds?.includes('c1')));
  assert.ok(l3.every(task => task.criterionIds?.includes('c1')));
});

test('GCE：多 Criterion 按关键词保守映射，未匹配保持未覆盖', () => {
  const plan = {
    planId: 'p4', taskId: 'w4', roundId: 'r4', title: '两件事', description: '',
    completion: 'done',
    steps: [write('s1', 'src/login.ts'), write('s2', 'docs/login.md')],
    decomposition: [
      { id: 'auth', title: '实现登录 token 校验', stepIds: ['s1'] },
      { id: 'docs', title: '更新登录文档', stepIds: ['s2'] }
    ]
  };
  const events = seedWorkEventsFromPlan({
    workId: 'w4', title: '两件事', plan, at: 1,
    criteria: [
      { criterionId: 'token', description: '登录 token 校验通过', priority: 'MUST' },
      { criterionId: 'docs', description: '登录文档更新并回读', priority: 'MUST' }
    ]
  });
  const tasks = [...rebuildWorkTasksFromEvents('w4', events).values()];
  const l2 = tasks.filter(task => task.level === 2);
  const auth = l2.find(task => task.title.includes('token'));
  const docs = l2.find(task => task.title.includes('文档'));
  assert.ok(auth?.criterionIds?.includes('token'));
  assert.ok(docs?.criterionIds?.includes('docs'));
});

test('GCE：没有 L2 的简单计划由 L3 步骤承接 Criterion', () => {
  const events = seedWorkEventsFromPlan({
    workId: 'w5', title: '简单写文件', at: 1,
    plan: {
      planId: 'p5', taskId: 'w5', roundId: 'r5', title: '简单写文件', description: '',
      completion: 'done', steps: [write('s1', 'src/a.ts')]
    },
    criteria: [{ criterionId: 'c1', description: '写入 src/a.ts 并回读', priority: 'MUST' }]
  });
  const tasks = [...rebuildWorkTasksFromEvents('w5', events).values()];
  const step = tasks.find(task => task.level === 3);
  assert.ok(step?.criterionIds?.includes('c1'));
});
