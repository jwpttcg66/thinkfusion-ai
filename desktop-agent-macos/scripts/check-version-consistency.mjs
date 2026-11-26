/**
 * P1-05：长任务版本一致性。
 *
 * 覆盖：四层一致、目标变更导致整链作废、上下文过期只要求刷新、决策钉错快照、
 * 缺字段不误判、以及给模型的提示词只讲能继承/不能继承什么。
 * Run: npm run test:version-consistency
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VERSION_LAYERS,
  checkVersionChain,
  versionConsistencyPrompt
} from '../out-test/shared/version-consistency.js';

const base = {
  goal: { goalId: 'goal:1', version: 2 },
  workTask: { workId: 't1', goalVersion: 2 },
  eco: { contextVersion: 3, goalVersion: 2, sufficiency: 'sufficient' },
  contribution: { snapshotId: 'cs:1', goalVersion: 2 },
  decision: { decisionId: 'ds:1', contributionSnapshotId: 'cs:1' },
  current: { goalVersion: 2 }
};

test('四层一致：可以按检查点继续，没有过期层', () => {
  const result = checkVersionChain(base);
  assert.equal(result.consistent, true);
  assert.deepEqual(result.expired, []);
  assert.deepEqual(result.inheritable, VERSION_LAYERS);
  assert.equal(result.requiresReplan, false);
  assert.equal(result.requiresContextRefresh, false);
  assert.match(result.notes.join(), /四层版本一致/);
  assert.equal(versionConsistencyPrompt(result), '');
});

test('目标版本变更：任务树与下游全部作废，要求重规划', () => {
  const result = checkVersionChain({ ...base, current: { goalVersion: 3 } });
  assert.equal(result.consistent, false);
  assert.deepEqual(result.expired, ['goal', 'worktask', 'eco', 'contribution', 'decision']);
  assert.equal(result.requiresReplan, true);
  assert.equal(result.requiresContextRefresh, false);
  assert.match(result.issues[0].reason, /当前目标版本 v3/);
  const text = versionConsistencyPrompt(result);
  assert.match(text, /已作废/);
  assert.match(text, /重新规划/);
});

test('任务树绑定旧目标：即使目标本身没变，也要重规划', () => {
  const result = checkVersionChain({
    ...base,
    workTask: { workId: 't1', goalVersion: 1 }
  });
  assert.equal(result.requiresReplan, true);
  assert.ok(result.expired.includes('worktask'));
  assert.ok(result.expired.includes('decision'));
  assert.deepEqual(result.inheritable, ['goal']);
});

test('上下文过期（目标没变）：只要求刷新，已通过的子任务结论仍可继承', () => {
  const result = checkVersionChain({
    ...base,
    eco: { contextVersion: 4, goalVersion: 2, sufficiency: 'stale' }
  });
  assert.equal(result.requiresReplan, false);
  assert.equal(result.requiresContextRefresh, true);
  assert.deepEqual(result.expired, ['eco', 'contribution', 'decision']);
  assert.deepEqual(result.inheritable, ['goal', 'worktask']);
  assert.match(versionConsistencyPrompt(result), /先重新读取/);
});

test('决策钉到别的快照：只作废决策，不牵连上下文', () => {
  const result = checkVersionChain({
    ...base,
    decision: { decisionId: 'ds:2', contributionSnapshotId: 'cs:old' }
  });
  assert.equal(result.consistent, false);
  assert.deepEqual(result.expired, ['decision']);
  assert.equal(result.requiresReplan, false);
});

test('缺字段不误判：没有 ECO/贡献/决策记录时只写笔记，不制造过期', () => {
  const result = checkVersionChain({
    goal: { goalId: 'goal:1', version: 1 },
    current: { goalVersion: 1 }
  });
  assert.equal(result.consistent, true);
  assert.deepEqual(result.expired, []);
  assert.match(result.notes.join(), /目标版本一致|四层版本一致/);
});

test('提示词不会把「未知」写成「没问题」：有过期层就逐条列出', () => {
  const result = checkVersionChain({
    ...base,
    eco: { contextVersion: 1, goalVersion: 1, sufficiency: 'partial' }
  });
  const text = versionConsistencyPrompt(result);
  assert.match(text, /\[eco\]/);
  assert.match(text, /仍可继承：goal/);
});
