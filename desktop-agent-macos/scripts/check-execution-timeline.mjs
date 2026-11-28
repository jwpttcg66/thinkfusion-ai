/**
 * 工程执行过程模型：同一个 stepId 的事件合成一张卡，跨轮不串。
 *
 * Run with: npm run test:execution-timeline
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTimeline, duration, target, toolLabel } from '../out-test/shared/execution-timeline.js';

const base = { at: 1000, taskId: 't1', stepId: 's1', tool: 'fs.edit' };

test('approval → started → completed 合成一张卡，参数与耗时都保留', () => {
  const items = buildTimeline([
    { type: 'round.started', at: 900, taskId: 't1', roundId: 'r1', roundNumber: 1, inputType: 'user_prompt' },
    { type: 'step.approval', ...base, index: 1, total: 2, argsPreview: '{"path":"a.ts"}', risk: 'write', expiresAt: 2000 },
    { type: 'step.started', ...base, at: 1100, args: { path: 'a.ts', oldString: 'a', newString: 'b' } },
    { type: 'step.completed', ...base, at: 1300, durationMs: 200, result: { path: 'a.ts', replaced: 1 } }
  ]);
  const steps = items.filter(item => item.kind === 'step');
  assert.equal(steps.length, 1);
  const card = steps[0].card;
  assert.equal(card.status, 'completed');
  assert.equal(card.approval, 'pending');
  assert.equal(card.args.path, 'a.ts');
  assert.equal(card.durationMs, 200);
  assert.equal(card.result.replaced, 1);
  assert.equal(target(card.tool, card.args), 'a.ts');
});

test('审批被拒：卡是 failed，并保留拒绝理由', () => {
  const items = buildTimeline([
    { type: 'step.approval', ...base, index: 1, total: 1, argsPreview: '{}', risk: 'write', expiresAt: 2000 },
    { type: 'step.approval-resolved', ...base, at: 1200, approved: false, reason: '用户拒绝执行这一步' }
  ]);
  const card = items.find(item => item.kind === 'step').card;
  assert.equal(card.status, 'failed');
  assert.equal(card.approval, 'rejected');
  assert.match(card.error, /用户拒绝/);
});

test('新的一轮复用 step-1 时，不覆盖上一轮的卡', () => {
  const items = buildTimeline([
    { type: 'round.started', at: 100, taskId: 't1', roundId: 'r1', roundNumber: 1, inputType: 'user_prompt' },
    { type: 'step.completed', ...base, at: 200, durationMs: 10, result: { path: 'old.ts' } },
    { type: 'round.started', at: 300, taskId: 't1', roundId: 'r2', roundNumber: 2, inputType: 'execution_report' },
    { type: 'step.completed', ...base, at: 400, durationMs: 20, result: { path: 'new.ts' } }
  ]);
  const steps = items.filter(item => item.kind === 'step');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].card.result.path, 'old.ts');
  assert.equal(steps[1].card.result.path, 'new.ts');
});

test('没有 durationMs 的老事件用起止时间补；补不出来就留空', () => {
  const items = buildTimeline([
    { type: 'step.started', ...base, at: 1000, args: { path: 'a.ts' } },
    { type: 'step.completed', ...base, at: 1500, result: { path: 'a.ts' } }
  ]);
  assert.equal(items[0].card.durationMs, 500);
  assert.equal(duration(500), '500ms');
  assert.equal(duration(1500), '1.5s');
  assert.equal(duration(undefined), '');
});

test('工具名与目标：命令、搜索词、代码位置各有可读形式', () => {
  assert.equal(toolLabel('code.impact'), '看影响面');
  assert.equal(toolLabel('unknown.tool'), 'unknown.tool');
  assert.equal(target('shell.run', { command: 'npm test' }), 'npm test');
  assert.equal(target('fs.search', { query: 'TODO', path: 'src' }), 'TODO · src');
  assert.equal(target('code.definition', { path: 'a.ts', line: 12 }), 'a.ts:12');
});

/**
 * M2-2 验收要求「UI 可核对上下文状态」：续跑与重规划都只落成 context.event，
 * 标签缺一项就退化成「上下文事件」四个字，用户分不出系统在等还是在重做。
 */
test('恢复的两条路径在时间线上各有说法，被迫重规划按提醒配色', () => {
  const items = buildTimeline([
    {
      type: 'context.checkpoint.paused', at: 100, taskId: 't1', reason: 'pause',
      goalVersion: 1, taskRevision: 3, needsReconciliation: 0,
      contextId: 'pause:r1:100', checkpointId: 'cp_1', activeRunId: 'r1'
    },
    {
      type: 'context.event', at: 200, taskId: 't1', event: 'context.resume.continued',
      context: { contextId: 'pause:r1:100', checkpointId: 'cp_1', resume: { mode: 'continue', planId: 'p1', reusedStepIds: ['s1'], pendingStepIds: ['s2'] } }
    },
    {
      type: 'context.event', at: 300, taskId: 't1', event: 'context.resume.replanned',
      context: { contextId: 'pause:r1:100', reason: '结局未知且无路径可核对：/tmp/late.txt' }
    }
  ]);
  const milestones = items.filter(item => item.kind === 'milestone');
  assert.equal(milestones.length, 3);
  assert.match(milestones[0].text, /暂停已提交检查点 cp_1/);
  assert.match(milestones[0].detail, /"checkpointId": "cp_1"/);
  assert.match(milestones[1].text, /已从检查点续跑/);
  assert.equal(milestones[1].tone, 'muted');
  assert.match(milestones[2].text, /已重新规划/);
  assert.equal(milestones[2].tone, 'warn', '重规划意味着有一轮要重做，不能和续跑同色');
  assert.match(milestones[2].detail, /结局未知且无路径可核对/);
});

test('暂停没留下检查点时如实写明，不画成已存档', () => {
  const items = buildTimeline([
    { type: 'context.checkpoint.paused', at: 100, taskId: 't1', reason: 'cancel', goalVersion: 1, taskRevision: 2, needsReconciliation: 1, unavailableReason: '当前宿主未注入检查点能力' }
  ]);
  const milestone = items.find(item => item.kind === 'milestone');
  assert.match(milestone.text, /取消未提交检查点：当前宿主未注入检查点能力/);
  assert.equal(milestone.tone, 'warn');
});

/** 续跑报告里复用的那一步状态是 completed（主进程还原过），本轮真跑的也一样——只能靠标注区分。 */
test('续跑报告的复用步骤带「复用自上次执行」', () => {
  const report = {
    protocol: 'desktop-agent/v1',
    type: 'execution_report',
    taskId: 't1',
    roundId: 'r2',
    planId: 'p1',
    status: 'completed',
    errors: [],
    nextAction: 'complete',
    createdAt: 500,
    results: [
      { stepId: 's1', tool: 'fs.writeFile', status: 'completed', verified: true, durationMs: 12, args: { path: '/tmp/f1.txt' }, reusedFrom: { checkpointId: 'cp_1', executedAt: 111 } },
      { stepId: 's2', tool: 'shell.run', status: 'completed', verified: true, durationMs: 40, args: { command: 'node --test .' } }
    ]
  };
  const items = buildTimeline([{ type: 'report.ready', at: 500, taskId: 't1', roundId: 'r2', report }]);
  const detail = items.find(item => item.kind === 'milestone').detail;
  assert.match(detail, /1\. \[fs\.writeFile\] completed（复用自上次执行） · \/tmp\/f1\.txt/);
  assert.match(detail, /2\. \[shell\.run\] completed · node --test \./);
});
