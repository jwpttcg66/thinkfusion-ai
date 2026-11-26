import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorkflow, topologicalOrder } from '../out-test/shared/workflow.js';

const known = ['fs.readFile', 'code.run', 'fs.writeFile'];

test('工作流校验：未知能力、重复 id、悬空依赖、环都要拒绝', () => {
  assert.equal(validateWorkflow({ id: 'w', title: 'x', nodes: [] }, known).ok, false);
  const unknown = validateWorkflow({ id: 'w', title: 'x', nodes: [{ id: 'a', capabilityId: 'nope' }] }, known);
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(), /未知能力/);
  const dup = validateWorkflow({
    id: 'w', title: 'x',
    nodes: [{ id: 'a', capabilityId: 'code.run' }, { id: 'a', capabilityId: 'code.run' }]
  }, known);
  assert.match(dup.errors.join(), /重复/);
  const dangling = validateWorkflow({ id: 'w', title: 'x', nodes: [{ id: 'a', capabilityId: 'code.run', dependsOn: ['z'] }] }, known);
  assert.match(dangling.errors.join(), /不存在的节点/);
  const cycle = validateWorkflow({
    id: 'w', title: 'x',
    nodes: [
      { id: 'a', capabilityId: 'code.run', dependsOn: ['b'] },
      { id: 'b', capabilityId: 'code.run', dependsOn: ['a'] }
    ]
  }, known);
  assert.match(cycle.errors.join(), /环/);
});

test('拓扑序：依赖在前，同层保持定义顺序', () => {
  const def = {
    id: 'w', title: 'x',
    nodes: [
      { id: 'b', capabilityId: 'code.run', dependsOn: ['a'] },
      { id: 'a', capabilityId: 'fs.readFile' },
      { id: 'c', capabilityId: 'code.run' }
    ]
  };
  assert.deepEqual(topologicalOrder(def).order, ['a', 'c', 'b']);
  assert.equal(validateWorkflow(def, known).ok, true);
});

test('定义 → 步骤骨架：按拓扑序，依赖保留；非法定义不给半套步骤', async () => {
  const { workflowToSteps } = await import('../out-test/shared/workflow.js');
  const out = workflowToSteps({
    id: 'w', title: 'x',
    nodes: [
      { id: 'b', capabilityId: 'code.run', dependsOn: ['a'], title: '跑测试' },
      { id: 'a', capabilityId: 'fs.readFile' }
    ]
  }, known);
  assert.equal(out.error, undefined);
  assert.deepEqual(out.steps.map(step => step.nodeId), ['a', 'b']);
  assert.equal(out.steps[1].index, 1);
  assert.deepEqual(out.steps[1].dependsOn, ['a']);

  const bad = workflowToSteps({ id: 'w', title: 'x', nodes: [{ id: 'a', capabilityId: 'nope' }] }, known);
  assert.ok(bad.error);
  assert.equal(bad.steps.length, 0);
});

test('定义 → 可提交计划：合法参数通过 schema，非法参数整份拒绝', async () => {
  const { workflowToPlan } = await import('../out-test/shared/workflow.js');
  const definition = {
    id: 'w-plan', title: '读文件再跑测试',
    nodes: [
      { id: 'read', capabilityId: 'fs.readFile' },
      { id: 'run', capabilityId: 'code.run', dependsOn: ['read'] }
    ]
  };
  const ok = workflowToPlan({
    definition,
    knownCapabilities: [...known, 'code.run'],
    taskId: 't1',
    roundId: 'r1',
    argsByNode: { read: { path: 'src/a.ts' }, run: { code: 'print(1)', language: 'python3' } }
  });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.plan.steps.map(step => step.tool), ['fs.readFile', 'code.run']);

  const bad = workflowToPlan({
    definition,
    knownCapabilities: [...known, 'code.run'],
    taskId: 't1',
    roundId: 'r1',
    argsByNode: { read: { path: 'src/a.ts' } }
  });
  assert.ok(bad.error);
  assert.equal(bad.plan, undefined);
});

// ---------------------------------------------------------------------------
// P1-04：条件 / 循环 / 并行 / 审批节点的真实语义 + 生产注册表
// ---------------------------------------------------------------------------

const engine = await import('../out-test/shared/workflow.js');
const knownAll = [...known, 'test.run'];
const registry = await import('../out-test/shared/workflow-registry.js');
const { TOOL_NAMES } = await import('../out-test/shared/contracts.js');

test('条件节点：不成立时本节点与依赖者都跳过，并写明原因', () => {
  const definition = {
    id: 'w-cond', title: '条件流程',
    nodes: [
      { id: 'need-tests', capabilityId: '', kind: 'condition', condition: { field: 'runTests', op: 'equals', value: true } },
      { id: 'test', capabilityId: 'test.run', dependsOn: ['need-tests'] },
      { id: 'read', capabilityId: 'fs.readFile' }
    ]
  };
  const off = engine.resolveWorkflow({ definition, knownCapabilities: knownAll, inputs: { runTests: false } });
  assert.equal(off.ok, true);
  assert.deepEqual(off.steps.map(step => step.nodeId), ['read']);
  assert.deepEqual(off.skipped.map(item => item.nodeId), ['need-tests', 'test']);
  assert.match(off.skipped[1].reason, /依赖节点未执行/);

  const on = engine.resolveWorkflow({ definition, knownCapabilities: knownAll, inputs: { runTests: true } });
  assert.deepEqual(on.steps.map(step => step.nodeId), ['read', 'test']);
});

test('循环节点：按 count 展开成真实步骤；until 明确拒绝而不是假装支持', () => {
  const loop = {
    id: 'w-loop', title: '重复跑',
    nodes: [{ id: 'run', capabilityId: 'code.run', kind: 'loop', loop: { count: 3 }, args: { command: 'node x.js' } }]
  };
  const out = engine.resolveWorkflow({ definition: loop, knownCapabilities: knownAll });
  assert.equal(out.steps.length, 3);
  assert.deepEqual(out.steps.map(step => step.nodeId), ['run#1', 'run#2', 'run#3']);
  assert.deepEqual(out.steps.map(step => step.iteration), [1, 2, 3]);
  assert.match(out.notes.join(), /展开为 3 轮/);

  const until = engine.validateWorkflow({
    id: 'w-until', title: 'x',
    nodes: [{ id: 'run', capabilityId: 'code.run', kind: 'loop', loop: { until: { field: 'ok', op: 'truthy' } } }]
  }, known);
  assert.equal(until.ok, false);
  assert.match(until.errors.join(), /until/);
});

test('并行节点：同一任务不允许并发计划，按定义顺序串行并如实写 note', () => {
  const definition = {
    id: 'w-par', title: '并行组',
    nodes: [
      { id: 'group', capabilityId: 'code.run', kind: 'parallel', children: ['a', 'b'] },
      { id: 'a', capabilityId: 'fs.readFile' },
      { id: 'b', capabilityId: 'test.run' },
      { id: 'after', capabilityId: 'code.run', dependsOn: ['group'] }
    ]
  };
  const out = engine.resolveWorkflow({ definition, knownCapabilities: knownAll });
  assert.deepEqual(out.steps.map(step => step.nodeId), ['a', 'b', 'after']);
  assert.match(out.notes.join(), /串行执行/);
});

test('审批节点：不产生步骤，但必须抬成人工批准', () => {
  const definition = {
    id: 'w-approve', title: '批准后写',
    nodes: [
      { id: 'ok', capabilityId: '', kind: 'approval' },
      { id: 'write', capabilityId: 'fs.writeFile', dependsOn: ['ok'] }
    ]
  };
  const out = engine.resolveWorkflow({ definition, knownCapabilities: knownAll });
  assert.equal(out.requiresApproval, true);
  assert.deepEqual(out.steps.map(step => step.nodeId), ['write']);
});

test('注册表：能力都真实存在；按目标能选中，同分则不硬选', () => {
  const entries = registry.listWorkflows();
  assert.ok(entries.length >= 3);
  for (const entry of entries) {
    for (const capability of entry.capabilities) {
      assert.ok(TOOL_NAMES.includes(capability), `${entry.id} 引用了不存在的工具 ${capability}`);
    }
    assert.equal(registry.findWorkflow(entry.id).id, entry.id);
  }
  const picked = registry.selectWorkflow('帮我跑一下测试', TOOL_NAMES);
  assert.equal(picked.entry.id, 'inspect-and-test');
  const none = registry.selectWorkflow('写一篇产品介绍', TOOL_NAMES);
  assert.equal(none.entry, null);
  assert.match(none.reason, /没有可识别/);
});

test('工作流 → 计划：读文件 → 跑测试两节点，参数进 PlanSchema，跳过项一并返回', () => {
  const entry = registry.findWorkflow('inspect-and-test');
  const built = engine.workflowToPlan({
    definition: entry.definition,
    knownCapabilities: knownAll,
    taskId: 't1',
    roundId: 'r1',
    argsByNode: {
      read: { path: 'src/index.ts' },
      test: { command: 'npm test' }
    }
  });
  assert.ok(built.plan);
  assert.equal(built.plan.steps.length, 2);
  assert.deepEqual(built.plan.steps.map(step => step.tool), ['fs.readFile', 'test.run']);
  assert.deepEqual(built.plan.steps.map(step => step.id), ['read', 'test']);
  assert.equal(built.requiresApproval, false);
  assert.deepEqual(built.skipped, []);

  const missingArgs = engine.workflowToPlan({
    definition: entry.definition,
    knownCapabilities: knownAll,
    taskId: 't1',
    roundId: 'r1'
  });
  // 缺参数必须整份拒绝，不能带着空 args 进审批。
  assert.equal(missingArgs.plan, undefined);
  assert.ok(missingArgs.error);
});
