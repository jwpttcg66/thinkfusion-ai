/**
 * P1-05：长任务版本一致性。
 *
 * 覆盖：四层一致、目标变更导致整链作废、上下文过期只要求刷新、决策钉错快照、
 * 缺字段不误判、以及给模型的提示词只讲能继承/不能继承什么。
 * Run: npm run test:version-consistency
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  VERSION_LAYERS,
  buildResumeVersionChainInput,
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

// P0-1：用恢复时真实存在的事件形态取源，不再人工拼一个「当前版本」进去。
const resumeTask = { taskId: 't1', goalId: 'goal:t1' };
const resumeEvent = (at, type, extra = {}) => ({ at, type, taskId: 't1', ...extra });
const contractEvent = (version, at) => resumeEvent(at, 'goal.contract.updated', { contract: { goalVersion: version } });
const workEvent = version => resumeEvent(200, 'work.task.upserted', { task: { workTaskId: 'w1', goalVersion: version } });
const debateEvent = (snapshotId, createdAt) => resumeEvent(createdAt, 'plan.debated', {
  debate: { contributionSnapshot: { snapshotId, createdAt } }
});
const decisionEvent = (snapshotId, at) => resumeEvent(at, 'model.decision.snapshot', {
  snapshot: { decisionId: 'ds:1', contributionSnapshotId: snapshotId }
});

test('恢复取源：当前目标版本来自契约更新事件，过期目标是真的能判出', () => {
  const { chain, sources } = buildResumeVersionChainInput({
    task: { ...resumeTask, goalVersion: 1 },
    events: [contractEvent(1, 100), workEvent(1), contractEvent(2, 400)],
    workTasks: [{ workTaskId: 'w1', goalVersion: 1 }]
  });
  assert.equal(sources.currentGoalVersion, 'goal.contract.updated');
  assert.equal(chain.current.goalVersion, 2);
  assert.equal(chain.goal.version, 1);
  const result = checkVersionChain(chain);
  assert.ok(result.issues.some(issue => issue.layer === 'goal'));
  assert.equal(result.requiresReplan, true);
});

test('恢复取源：贡献快照的 goalVersion 取快照生成时生效的契约版本', () => {
  const { chain, sources } = buildResumeVersionChainInput({
    task: { ...resumeTask, goalVersion: 2 },
    events: [contractEvent(1, 100), workEvent(2), debateEvent('cs:1', 300), contractEvent(2, 400)],
    workTasks: [{ workTaskId: 'w1', goalVersion: 2 }]
  });
  assert.equal(sources.contributionGoalVersion, 'goal.contract.updated');
  assert.equal(chain.contribution.goalVersion, 1);
  const result = checkVersionChain(chain);
  assert.ok(result.issues.some(issue => issue.layer === 'contribution'));
});

test('恢复取源：决策钉版来自决策事件，不是贡献快照自己', () => {
  const { chain, sources } = buildResumeVersionChainInput({
    task: { ...resumeTask, goalVersion: 2 },
    events: [contractEvent(2, 100), workEvent(2), debateEvent('cs:new', 300), decisionEvent('cs:old', 310)],
    workTasks: [{ workTaskId: 'w1', goalVersion: 2 }]
  });
  assert.equal(sources.decisionContributionSnapshotId, 'model.decision.snapshot');
  assert.equal(chain.contribution.snapshotId, 'cs:new');
  assert.equal(chain.decision.contributionSnapshotId, 'cs:old');
  const result = checkVersionChain(chain);
  assert.ok(result.issues.some(issue => issue.layer === 'decision'));
});

test('恢复取源：契约已被标 stale 时不冒充当前目标，退回任务记录', () => {
  const { chain, sources } = buildResumeVersionChainInput({
    task: { ...resumeTask, goalVersion: 1 },
    events: [
      contractEvent(2, 100),
      resumeEvent(200, 'goal.contract.stale', { goalId: 'goal:t1', goalVersion: 2, reasons: ['旧契约作废'] })
    ],
    workTasks: []
  });
  assert.equal(sources.currentGoalVersion, 'task.goalVersion');
  assert.equal(chain.current.goalVersion, 1);
});

test('源码守卫：生产恢复不得再让两侧取同一个目标字段/同一个快照', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const orchestrator = fs.readFileSync(path.join(root, 'src/main/orchestrator.ts'), 'utf8');
  assert.match(orchestrator, /buildResumeVersionChainInput\(\{/);
  assert.doesNotMatch(orchestrator, /current:\s*\{\s*goalVersion:\s*task\.goalVersion/);
  assert.doesNotMatch(orchestrator, /snapshotId:\s*lastDecisionEvent\.snapshot\.contributionSnapshotId/);
  assert.doesNotMatch(orchestrator, /version:\s*task\.goalVersion\s*\?\?\s*1/);
});
