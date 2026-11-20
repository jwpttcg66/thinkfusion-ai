/** 新建/写文件计划强制评审；单模型允许自辩。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldDebatePlan } from '../out-test/main/engineering/plan-review.js';

const plan = steps => ({ title: 't', steps, createdAt: 1 });
const write = { tool: 'fs.writeFile', args: { path: 'a', content: 'x' }, description: '写文件' };
const read = { tool: 'fs.read', args: { path: 'a' }, description: '读文件' };

test('写文件/新建目录：off 也强制辩', () => {
  assert.equal(shouldDebatePlan('off', plan([write])).debate, true);
  assert.equal(shouldDebatePlan('auto', plan([{ tool: 'fs.mkdir', args: { path: 'x' }, description: '建目录' }])).debate, true);
  assert.match(shouldDebatePlan('off', plan([write])).reason, /强制/);
});

test('纯只读短计划仍按 off 关闭', () => {
  assert.equal(shouldDebatePlan('off', plan([read])).debate, false);
  assert.equal(shouldDebatePlan('auto', plan([read])).debate, false);
});
