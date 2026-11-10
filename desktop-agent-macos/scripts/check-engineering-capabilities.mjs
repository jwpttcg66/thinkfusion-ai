/**
 * 本机能力归族检查：每个工具都有族，没有孤儿。
 *
 * 工具表还是 `contracts.ts` / `capabilities.ts` 那一份，这里只验证 13 族的
 * 能力项是否把它们全部登记了。缺一条就失败，不允许「工具在、没人知道它算哪类」。
 *
 * Run with: npm run test:engineering-capabilities
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENGINEERING_CAPABILITIES,
  GOVERN_FAMILIES,
  WORK_FAMILIES,
  familiesOfTool,
  isFamilyId
} from '../out-test/shared/engineering-capabilities.js';
import { MAIN_CAPABILITY_IDS } from '../out-test/shared/capabilities.js';
import { TOOL_NAMES } from '../out-test/shared/contracts.js';

test('13 族：8 个工作族 + 5 个治理族', () => {
  assert.equal(WORK_FAMILIES.length, 8);
  assert.equal(GOVERN_FAMILIES.length, 5);
  assert.equal(new Set([...WORK_FAMILIES, ...GOVERN_FAMILIES]).size, 13);
});

test('13 个族每个至少一条能力项', () => {
  const covered = new Set(ENGINEERING_CAPABILITIES.map(item => item.family));
  for (const family of [...WORK_FAMILIES, ...GOVERN_FAMILIES]) {
    assert.ok(covered.has(family), `族 ${family} 没有任何能力项`);
  }
});

test('能力项字段完整、id 唯一、族合法', () => {
  const ids = new Set();
  for (const item of ENGINEERING_CAPABILITIES) {
    assert.ok(!ids.has(item.id), `重复能力 id：${item.id}`);
    ids.add(item.id);
    assert.ok(isFamilyId(item.family), `${item.id}: 未知族 ${item.family}`);
    assert.ok(item.goal.trim().length > 0, `${item.id}: goal 不能为空`);
    assert.ok(item.tools.length > 0, `${item.id}: tools 不能为空`);
    assert.ok(item.acceptance.length > 0, `${item.id}: acceptance 不能为空`);
  }
});

test('每个本机工具至少归一族（孤儿 0）', () => {
  const registered = new Set(ENGINEERING_CAPABILITIES.flatMap(item => item.tools));
  for (const tool of TOOL_NAMES) {
    assert.ok(registered.has(tool), `工具 ${tool} 没有归族`);
  }
});

test('每个主进程能力也至少归一族', () => {
  const registered = new Set(ENGINEERING_CAPABILITIES.flatMap(item => item.tools));
  for (const id of MAIN_CAPABILITY_IDS) {
    assert.ok(registered.has(id), `主进程能力 ${id} 没有归族`);
  }
});

test('familiesOfTool 返回全部命中；未登记返回空', () => {
  assert.ok(familiesOfTool('fs.search').includes('code.read'));
  assert.ok(familiesOfTool('fs.search').includes('debug'));
  assert.deepEqual(familiesOfTool('no.such.tool'), []);
});
