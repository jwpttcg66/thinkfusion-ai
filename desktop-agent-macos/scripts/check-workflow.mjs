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
