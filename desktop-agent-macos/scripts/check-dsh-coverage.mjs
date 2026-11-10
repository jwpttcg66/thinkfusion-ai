/**
 * dsh 76 条工具 schema 的覆盖率检查。
 *
 * 这不是「我们实现了多少」的进度条，而是防止「没有登记的缺口」：每条都必须
 * 有族、有对应物、有层级；L1 写承担者，L2 写期号或裁决，L3 写平台原因。
 *
 * Run with: npm run test:dsh-coverage
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DSH_DUPLICATE_NAMES,
  DSH_TOOLS,
  DSH_UNIQUE_NAMES
} from '../out-test/shared/dsh-tools.js';
import { GOVERN_FAMILIES, WORK_FAMILIES } from '../out-test/shared/engineering-capabilities.js';
import { MAIN_CAPABILITY_IDS } from '../out-test/shared/capabilities.js';
import { TOOL_NAMES } from '../out-test/shared/contracts.js';

const FAMILIES = new Set([...WORK_FAMILIES, ...GOVERN_FAMILIES]);
const LAYERS = new Set(['L0', 'L1', 'L2', 'L3']);

test('76 条 schema：数量、序号连续且唯一', () => {
  assert.equal(DSH_TOOLS.length, 76);
  assert.deepEqual(
    DSH_TOOLS.map(item => item.index),
    Array.from({ length: 76 }, (_, index) => index + 1)
  );
});

test('每条都有合法族、层级和说明', () => {
  for (const item of DSH_TOOLS) {
    assert.ok(FAMILIES.has(item.family), `${item.tool}: 未知族 ${item.family}`);
    assert.ok(LAYERS.has(item.layer), `${item.tool}: 未知层级 ${item.layer}`);
    assert.ok(item.ours.trim().length > 0, `${item.tool}: 对应物不能为空`);
    assert.ok(item.note.trim().length > 0, `${item.tool}: 说明不能为空`);
  }
});

test('L0 的对应物必须真的存在；L1 写承担者；L2 写期号/裁决', () => {
  const known = new Set([...TOOL_NAMES, ...MAIN_CAPABILITY_IDS]);
  for (const item of DSH_TOOLS) {
    if (item.layer === 'L0') {
      assert.ok(known.has(item.ours), `${item.tool}: L0 对应物 ${item.ours} 不在能力清单里`);
    }
    if (item.layer === 'L1') {
      assert.ok(item.ours.trim().length > 0, `${item.tool}: L1 要写由谁承担`);
    }
    if (item.layer === 'L2') {
      assert.match(item.note, /P5|P6|裁决/, `${item.tool}: L2 要写期号或裁决状态`);
    }
  }
});

test('71 个唯一工具名；五组同名不同包登记一致', () => {
  assert.equal(DSH_UNIQUE_NAMES.length, 71);
  assert.equal(DSH_TOOLS.length - DSH_UNIQUE_NAMES.length, 5);
  for (const [name, packages] of Object.entries(DSH_DUPLICATE_NAMES)) {
    assert.equal(DSH_TOOLS.filter(item => item.tool === name).length, 2, `${name} 应有两条 schema`);
    assert.deepEqual(
      DSH_TOOLS.filter(item => item.tool === name).map(item => item.packageName).sort(),
      [...packages].sort(),
      `${name} 的包名不一致`
    );
  }
});

test('层级统计：L0 17 / L1 29 / L2 28 / L3 2', () => {
  const count = layer => DSH_TOOLS.filter(item => item.layer === layer).length;
  assert.equal(count('L0'), 17);
  assert.equal(count('L1'), 29);
  assert.equal(count('L2'), 28);
  assert.equal(count('L3'), 2);
});
