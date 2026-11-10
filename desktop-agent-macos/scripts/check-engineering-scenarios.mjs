/**
 * 工程场景离线回放：把真实发生过的五类任务固化成计划，跑门禁与族判定。
 *
 * 它不调用模型、不发网页请求、不执行任何工具——断言的是「这类计划该被判成
 * 什么、缺什么判据」。模型输出会漂，判据不该漂。
 *
 * Run with: npm run test:engineering-scenarios
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { checkPlanCapabilities } from '../out-test/main/engineering/plan-review.js';

const dir = path.join(import.meta.dirname, 'scenarios', 'engineering');
const files = readdirSync(dir).filter(file => file.endsWith('.json')).sort();

test('场景目录里有 5 个场景', () => {
  assert.equal(files.length, 5);
});

for (const file of files) {
  test(`场景 ${file}`, () => {
    const scenario = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    const gate = checkPlanCapabilities({ steps: scenario.plan.steps });
    assert.equal(gate.family, scenario.expect.family, `${file}: 主族不对`);
    for (const needle of scenario.expect.missing) {
      assert.ok(
        gate.missing.some(item => item.includes(needle)),
        `${file}: 缺少包含「${needle}」的提醒，实际 ${JSON.stringify(gate.missing)}`
      );
    }
    if (scenario.expect.missing.length === 0) {
      assert.deepEqual(gate.missing, [], `${file}: 不该有提醒`);
    }
  });
}
