/** 新建/写文件计划强制评审；单模型允许自辩。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planDebateTopics, planReviewQuestion, shouldDebatePlan } from '../out-test/main/engineering/plan-review.js';

const plan = steps => ({ title: 't', steps, createdAt: 1 });
const write = { tool: 'fs.writeFile', args: { path: 'a', content: 'x' }, description: '写文件' };
const read = { tool: 'fs.read', args: { path: 'a' }, description: '读文件' };

test('写文件不再单独触发强制辩', () => {
  assert.equal(shouldDebatePlan('off', plan([write])).debate, false);
});

test('纯只读短计划仍按 off 关闭', () => {
  assert.equal(shouldDebatePlan('off', plan([read])).debate, false);
  assert.equal(shouldDebatePlan('auto', plan([read])).debate, false);
});


test('design 计划：off 也强制辩，辩论对象是文档/观点', () => {
  const design = {
    title: '缓存方案设计',
    description: '设计文档',
    kind: 'design',
    design: { document: '采用两级缓存...', viewpoints: ['一致性问题', '成本问题'] },
    steps: [read],
    completion: { condition: '评审通过' }
  };
  assert.equal(shouldDebatePlan('off', design).debate, true);
  assert.match(shouldDebatePlan('auto', design).reason, /设计文档/);
  assert.deepEqual(planDebateTopics(design), ['一致性问题', '成本问题']);
  const question = planReviewQuestion(design);
  assert.match(question, /采用两级缓存/);
  assert.match(question, /一致性问题/);
  assert.doesNotMatch(question, /fs.read/);
});
