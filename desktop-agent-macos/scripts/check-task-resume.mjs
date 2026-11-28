/**
 * 暂停/继续、恢复保护与检查点续跑（LT-P5-02/05 + V4 P1 M2-2）。
 *
 * - 等待态暂停→继续回到原等待状态，不重开一轮；
 * - 检查点 stale 时继续失败，任务留在 interrupted；
 * - 同一任务同时只允许一个恢复流程；
 * - M2-2：检查点 fresh 且副作用账本无未知缺口 → 直达执行（不建新一轮）；
 *   有未知缺口 / 回退开关关闭 → 仍走重规划，两条路都必须留事件。
 *
 * Run with: npm run test:task-resume
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgentStore } from '../out-test/main/store.js';
import { TaskManager } from '../out-test/main/task-manager.js';
import { AgentOrchestrator, hashPlan } from '../out-test/main/orchestrator.js';
import {
  collectCompletedSteps,
  decideContinuation,
  mergeReusedResults
} from '../out-test/main/context/recovery/continuation.js';
import {
  collectReportedAndInFlightSideEffects,
  reconcileSideEffects
} from '../out-test/main/context/recovery/side-effects.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-resume-'));
const workspace = path.join(dir, 'ws');
fs.mkdirSync(workspace, { recursive: true });
const store = new AgentStore(path.join(dir, 'agent-store.json'));
const events = [];
let journalSeq = 0;
// 与主进程同口径：转发给界面的事件同时进 Journal。续跑判定读的是
// `store.listEvents()`（步骤结局、版本链），只留内存数组就测不到真路径。
function emit(event) {
  events.push(event);
  if (event.taskId) {
    store.appendEvent({ ...event, eventId: `ev_${String(++journalSeq)}`, runId: event.taskId });
  }
}
const tasks = new TaskManager(store, emit);

function orchestrator(overrides = {}) {
  return new AgentOrchestrator({
    tasks,
    store,
    adapter: () => ({ cancelWait: () => {} }),
    emit: event => events.push(event),
    dbPath: () => path.join(dir, 'journal.json'),
    ...overrides
  });
}

test('等待态暂停后继续：回到原状态，不重开一轮', async () => {
  const task = tasks.create({ prompt: '等待补充的任务', permissionPreset: 'workspace-write' });
  tasks.transition(task.taskId, 'planning');
  tasks.transition(task.taskId, 'awaiting_clarification');
  const roundsBefore = tasks.listRounds(task.taskId).length;

  const orch = orchestrator();
  await orch.pause(task.taskId);
  assert.equal(tasks.get(task.taskId).status, 'paused');
  assert.equal(tasks.get(task.taskId).resumeStatus, 'awaiting_clarification');

  await orch.resume(task.taskId);
  assert.equal(tasks.get(task.taskId).status, 'awaiting_clarification');
  assert.equal(tasks.listRounds(task.taskId).length, roundsBefore);
});

test('检查点 stale：继续失败，任务保持 interrupted', async () => {
  const task = tasks.create({ prompt: '中断任务', permissionPreset: 'workspace-write' });
  tasks.transition(task.taskId, 'planning');
  tasks.transition(task.taskId, 'interrupted');
  const orch = orchestrator({
    contextRecovery: async () => ({ status: 'stale', reason: '来源归档 hash 不匹配' })
  });

  await assert.rejects(() => orch.resume(task.taskId), /检查点不可用/);
  assert.equal(tasks.get(task.taskId).status, 'interrupted');
  assert.ok(events.some(event =>
    event.type === 'context.event' &&
    event.event === 'context.compaction.stale' &&
    event.taskId === task.taskId
  ));
});

test('恢复时目标版本过期：不进 planning，停在 blocked 且记 actedOnReplan', async () => {
  const task = tasks.create({ prompt: 'P0-2 重规划门禁', permissionPreset: 'workspace-write' });
  tasks.transition(task.taskId, 'planning');
  tasks.transition(task.taskId, 'interrupted');
  // 契约事件把当前目标抬到 v2，任务记录仍是 v1；P0-1 之前两侧同源判不出来。
  store.appendEvent({
    type: 'goal.contract.updated', at: Date.now(), taskId: task.taskId,
    contract: { goalVersion: 2, goalId: task.goalId, criteria: [] }
  });
  const roundsBefore = tasks.listRounds(task.taskId).length;
  const orch = orchestrator();

  await orch.resume(task.taskId);

  assert.equal(tasks.get(task.taskId).status, 'blocked');
  assert.equal(tasks.listRounds(task.taskId).length, roundsBefore);
  const consistency = events.filter(event =>
    event.type === 'version.consistency' && event.taskId === task.taskId
  ).at(-1);
  assert.equal(consistency?.actedOnReplan, true);
  assert.ok(consistency?.requiresReplan);
  // M3-1：恢复门禁也走同一个判定出口。这条路径的结论本来就是「外部阻塞」
  // （任务确实转成了 blocked），以前事件写 WAIT_USER、状态转 blocked，两处各说各话。
  const resumeDecision = events.find(event => event.type === 'cycle.decision.created'
    && event.taskId === task.taskId);
  assert.equal(resumeDecision?.decisionType, 'BLOCKED');
  assert.equal(resumeDecision?.nextAction, 'stop_and_wait');
  assert.equal(resumeDecision?.requiresUser, true);
  assert.match(resumeDecision?.reason ?? '', /旧目标计划未执行/);
  assert.deepEqual(resumeDecision?.evidenceRefs, ['version.consistency']);
  assert.match(tasks.get(task.taskId).error ?? '', /旧目标计划未执行/);
});

test('并发恢复保护：同一任务第二次继续被拒绝', async () => {
  const task = tasks.create({ prompt: '并发恢复', permissionPreset: 'workspace-write' });
  tasks.transition(task.taskId, 'planning');
  tasks.transition(task.taskId, 'interrupted');

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const orch = orchestrator({
    contextRecovery: async () => {
      await gate;
      return { status: 'stale', reason: '测试用 stale' };
    }
  });

  const first = orch.resume(task.taskId);
  await assert.rejects(() => orch.resume(task.taskId), /正在执行或恢复中/);
  release();
  await assert.rejects(() => first, /检查点不可用/);
  assert.equal(tasks.get(task.taskId).status, 'interrupted');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('Engineering Provider 规划：ContextManager 的 system/context 传给适配器', async () => {
  const task = tasks.create({ prompt: '工程规划上下文', permissionPreset: 'workspace-write' });
  const captured = [];
  const adapter = {
    siteLabel: 'cloud',
    concurrent: true,
    contextMeta: { providerId: 'cloud', modelId: 'm' },
    getStatus: async () => ({ pageReady: true }),
    sendMessage: async () => ({ submitted: true, snapshotBefore: {}, method: 'provider', signals: [], waitedMs: 0 }),
    waitForAnswer: async () => 'ok',
    newConversation: async () => ({ ok: true, method: 'provider' }),
    cancelWait: () => {},
    withContext: context => {
      captured.push(context);
      return adapter;
    }
  };
  const orch = orchestrator({
    adapter: () => adapter,
    contextManager: {
      prepare: async input => ({
        context: {
          contextId: 'ctx-test', owner: input.owner, runId: input.runId,
          includedEventIds: [], retainedEventIds: [], evidenceRefs: [],
          estimatedTokens: 1, contextWindow: null, compactionStatus: 'not-needed'
        },
        question: input.question,
        contextLines: ['[摘要] 前序执行'],
        systemLines: ['[Memory] 约束 A']
      }),
      finalize: async () => {},
      recover: async () => null
    }
  });
  const prompt = '用户原话 + 计划契约';
  const wrapped = await orch.adapterWithContext(task.taskId, prompt);
  assert.equal(wrapped, adapter);
  assert.deepEqual(captured[0], {
    system: ['[Memory] 约束 A'],
    context: ['[摘要] 前序执行']
  });
});

test('Web 适配器没有 withContext：不注入任何上下文', async () => {
  const task = tasks.create({ prompt: '网页规划', permissionPreset: 'read-only' });
  const adapter = {
    siteLabel: 'web',
    getStatus: async () => ({ pageReady: true }),
    sendMessage: async () => ({ submitted: true, snapshotBefore: {}, method: 'page', signals: [], waitedMs: 0 }),
    waitForAnswer: async () => 'ok',
    newConversation: async () => ({ ok: true, method: 'page' }),
    cancelWait: () => {}
  };
  let prepared = 0;
  const orch = orchestrator({
    adapter: () => adapter,
    contextManager: {
      prepare: async () => { prepared += 1; throw new Error('不应调用'); },
      finalize: async () => {},
      recover: async () => null
    }
  });
  const wrapped = await orch.adapterWithContext(task.taskId, '原话');
  assert.equal(wrapped, adapter);
  assert.equal(prepared, 0);
});

// --- M2-2 检查点续跑 -------------------------------------------------------

const writeStep = () => ({ id: 'step-1', tool: 'fs.writeFile', args: { path: 'note.txt', content: 'hello' }, description: '写 note.txt' });
const testStep = () => ({ id: 'step-2', tool: 'test.run', args: { command: 'npm test' }, description: '跑测试' });
const shellStep = () => ({ id: 'step-3', tool: 'shell.run', args: { command: 'echo hi' }, description: '没有路径可核对的写' });

/** 走到「已批准计划被中断」这个真机形态：有轮次、有 approved 计划、状态 interrupted。 */
function interruptedWithPlan(name, steps, overrides = {}) {
  const task = tasks.create({ prompt: name, permissionPreset: 'workspace-write', workspaceRoot: workspace });
  tasks.transition(task.taskId, 'planning');
  const round = tasks.createRound({ taskId: task.taskId, inputType: 'user_prompt', requestText: '' });
  const plan = {
    protocol: 'desktop-agent/v1', type: 'plan', taskId: task.taskId, roundId: round.roundId,
    planId: `plan-${round.roundId}`, title: '写文件并验证', description: '两步', kind: 'implementation',
    steps, completion: { condition: '文件存在且测试通过' }
  };
  store.insertPlan({
    planId: plan.planId, taskId: task.taskId, roundId: round.roundId, plan,
    contentHash: hashPlan(plan), approvalStatus: overrides.approvalStatus ?? 'approved',
    createdAt: overrides.createdAt ?? Date.now()
  });
  tasks.patch(task.taskId, { currentPlanId: plan.planId });
  tasks.transition(task.taskId, 'plan_ready');
  tasks.transition(task.taskId, 'awaiting_approval');
  tasks.transition(task.taskId, 'interrupted');
  return { taskId: task.taskId, roundId: round.roundId, stored: store.getPlan(plan.planId) };
}

function journalStep(event) {
  store.appendEvent({ ...event, eventId: `jc_${String(++journalSeq)}`, runId: event.taskId, at: event.at ?? Date.now() });
}

/** 上轮真跑完的一步：`step.started` 带 args，`step.completed` 带结果——没有执行报告。 */
function journalCompletedStep(input) {
  const at = Date.now();
  journalStep({
    type: 'step.started', taskId: input.taskId, roundId: input.roundId,
    stepId: input.stepId, tool: input.tool, args: input.args, at: at - 30
  });
  journalStep({
    type: 'step.completed', taskId: input.taskId, roundId: input.roundId,
    stepId: input.stepId, tool: input.tool, result: input.result, durationMs: 12, at
  });
  return at;
}

function journalStartedStep(input) {
  journalStep({
    type: 'step.started', taskId: input.taskId, roundId: input.roundId,
    stepId: input.stepId, tool: input.tool, args: input.args, at: Date.now()
  });
}

/** 按主进程口径算账本：报告 + 在途事件 → 路径核对。测试不手抄缺口。 */
async function realLedger(taskId) {
  const entries = collectReportedAndInFlightSideEffects({
    reports: store.allReportsFor(taskId),
    events: store.listEvents(taskId)
  });
  return reconcileSideEffects(entries, { workspaceRoot: workspace });
}

function recoveredRecovery(ledger) {
  return {
    status: 'recovered', pointerSource: 'task-fields', checkpointId: 'cp-1', contextId: 'ctx-1',
    ledger, summary: { constraints: [], openIssues: [], evidence: [] }
  };
}

/** Runtime 替身：记录下发内容，返回「复用步 skipped + 待执行步 completed」的报告。 */
function runPlanSpy(build) {
  const calls = [];
  const fn = async (plan, grant, dbPath, timeoutMs, meta, options) => {
    calls.push({ plan, grant, meta, options });
    return build(plan, meta, options);
  };
  return { calls, fn };
}

function continuedReport(plan, meta, options) {
  const reused = options?.reusedSteps ?? [];
  return {
    protocol: 'desktop-agent/v1', type: 'execution_report', taskId: plan.taskId,
    roundId: meta.roundId, planId: meta.planId, status: 'completed', nextAction: 'complete',
    errors: [], createdAt: Date.now(),
    results: [
      ...reused.map(item => ({
        stepId: item.stepId, tool: 'fs.writeFile', status: 'skipped', verified: false, durationMs: 0,
        args: { path: 'note.txt' },
        reusedFrom: { checkpointId: item.checkpointId ?? '', executedAt: item.executedAt }
      })),
      {
        stepId: 'step-2', tool: 'test.run', status: 'completed', verified: true, durationMs: 5,
        args: { command: 'npm test' }, result: { command: 'npm test', exitCode: 0, stdout: 'ok' }
      }
    ]
  };
}

function statusesOf(taskId) {
  return events
    .filter(event => event.type === 'task.updated' && event.task.taskId === taskId)
    .map(event => event.task.status);
}

// 重规划这条路会异步开一轮规划（适配器是替身，很快失败）；等它落地再收测试，
// 免得临时目录已删除、后台还在写库。
async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve));
}

test('续跑（fresh 检查点 + 无未知缺口）：直达执行、不建新一轮、复用清单下发 Runtime', async () => {
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'hello', 'utf8');
  const scenario = interruptedWithPlan('续跑直达执行', [writeStep(), testStep()]);
  const executedAt = journalCompletedStep({
    taskId: scenario.taskId, roundId: scenario.roundId, stepId: 'step-1',
    tool: 'fs.writeFile', args: { path: 'note.txt', content: 'hello' },
    result: { path: 'note.txt', bytes: 5 }
  });
  const ledger = await realLedger(scenario.taskId);
  assert.equal(ledger.missing, 0);
  const spy = runPlanSpy((plan, meta, options) => continuedReport(plan, meta, options));
  const orch = orchestrator({ contextRecovery: async () => recoveredRecovery(ledger), runPlan: spy.fn });
  const roundsBefore = tasks.listRounds(scenario.taskId).length;
  const statusCountBefore = statusesOf(scenario.taskId).length;

  await orch.resume(scenario.taskId);

  assert.equal(spy.calls.length, 1, '续跑必须把计划交给 Runtime');
  assert.deepEqual(spy.calls[0].options?.reusedSteps, [
    { stepId: 'step-1', checkpointId: 'cp-1', executedAt }
  ]);
  // planId / roundId 沿用被中断那份计划：报告归属不能挂到新轮次上。
  assert.equal(spy.calls[0].meta.planId, scenario.stored.planId);
  assert.equal(spy.calls[0].meta.roundId, scenario.roundId);

  assert.equal(tasks.listRounds(scenario.taskId).length, roundsBefore, '续跑不该建新一轮');
  // 建轮前的 planning 是测试夹具自己走的；这里只看「点继续之后」有没有再进规划。
  assert.equal(statusesOf(scenario.taskId).slice(statusCountBefore).includes('planning'), false);

  const continued = events.filter(event =>
    event.type === 'context.event' && event.taskId === scenario.taskId &&
    event.event === 'context.resume.continued'
  ).at(-1);
  assert.ok(continued, '续跑必须留下可核对的事件');
  assert.equal(continued.context.resume.mode, 'continue');
  assert.deepEqual(continued.context.resume.reusedStepIds, ['step-1']);
  assert.deepEqual(continued.context.resume.pendingStepIds, ['step-2']);
  assert.equal(continued.context.pointerSource, 'task-fields');
  assert.equal(continued.context.checkpointId, 'cp-1');

  // 界面桥只画本轮真要跑的步骤，已复用的不该再显示成待办。
  const bridge = events.filter(event =>
    event.type === 'execution.bridge' && event.taskId === scenario.taskId
  ).at(-1);
  assert.deepEqual(bridge.steps.map(step => step.tool), ['test.run']);

  const final = store.allReportsFor(scenario.taskId).at(-1);
  const reused = final.results.find(item => item.stepId === 'step-1');
  assert.equal(reused.status, 'completed', '复用步骤要还原成上轮真实结果');
  assert.deepEqual(reused.result, { path: 'note.txt', bytes: 5 });
  assert.equal(reused.reusedFrom?.checkpointId, 'cp-1');
  assert.ok(
    (final.verification?.changedPaths ?? []).includes('note.txt'),
    '不还原就等于本轮没写文件，交付清单会凭空少一项'
  );
  assert.equal(final.verification?.verified, true);
});

test('续跑负例：在途 shell.run 无路径可核对 → 仍走重规划，不开 Runtime', async () => {
  const scenario = interruptedWithPlan('账本缺口挡住续跑', [writeStep(), shellStep()]);
  journalCompletedStep({
    taskId: scenario.taskId, roundId: scenario.roundId, stepId: 'step-1',
    tool: 'fs.writeFile', args: { path: 'note.txt', content: 'hello' },
    result: { path: 'note.txt', bytes: 5 }
  });
  journalStartedStep({
    taskId: scenario.taskId, roundId: scenario.roundId, stepId: 'step-3',
    tool: 'shell.run', args: { command: 'echo hi' }
  });
  const ledger = await realLedger(scenario.taskId);
  assert.ok(ledger.needsReconciliation >= 1);
  const spy = runPlanSpy((plan, meta, options) => continuedReport(plan, meta, options));
  const orch = orchestrator({ contextRecovery: async () => recoveredRecovery(ledger), runPlan: spy.fn });
  const roundsBefore = tasks.listRounds(scenario.taskId).length;

  await orch.resume(scenario.taskId);

  assert.equal(spy.calls.length, 0, '有未知缺口就不能直接续跑');
  assert.equal(tasks.listRounds(scenario.taskId).length, roundsBefore + 1);
  const replanned = events.filter(event =>
    event.type === 'context.event' && event.taskId === scenario.taskId &&
    event.event === 'context.resume.replanned'
  ).at(-1);
  assert.ok(replanned, '重规划这条路同样要留事件');
  assert.equal(replanned.context.resume.mode, 'replan');
  assert.match(replanned.context.reason, /结局未知且无路径可核对/);
  assert.ok(replanned.context.resume.reasons.length >= 1);
  await settle();
});

test('暂停报告后到：本轮没跑过的 skipped 步骤不算副作用缺口', async () => {
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'hello', 'utf8');
  const later = { id: 'step-2', tool: 'fs.writeFile', args: { path: 'later.txt', content: 'x' }, description: '还没轮到就停了' };
  const scenario = interruptedWithPlan('取消报告里的 skipped', [writeStep(), later]);
  // Runtime 收到停止请求后的收场报告：没轮到的步骤带**原参数**记成 skipped
  // （见 src/agent/index.ts 主循环）。按写操作核对会把这份「计划」当成已改过的文件，
  // 判成 missing，于是暂停后再也续不上——真机 M2-2 就是死在这里。
  store.insertReport({
    protocol: 'desktop-agent/v1', type: 'execution_report', taskId: scenario.taskId,
    roundId: scenario.roundId, planId: scenario.stored.planId, status: 'cancelled',
    nextAction: 'stop', errors: [], createdAt: Date.now(),
    results: [
      { stepId: 'step-1', tool: 'fs.writeFile', status: 'completed', verified: true, durationMs: 5, args: { path: 'note.txt', content: 'hello' }, result: { path: 'note.txt', bytes: 5 } },
      { stepId: 'step-2', tool: 'fs.writeFile', status: 'skipped', verified: false, durationMs: 0, error: '任务已取消', args: later.args }
    ]
  });

  const ledger = await realLedger(scenario.taskId);
  assert.equal(ledger.entries.some(item => item.stepId === 'step-2'), false, '这一步没动过手，不该进账本');
  assert.deepEqual(ledger.entries.map(item => item.stepId), ['step-1']);
  assert.equal(ledger.missing, 0);
  assert.equal(ledger.applied, 1);
});

test('复用步骤照旧算副作用：reusedFrom 的 skipped 路径消失要报 missing', async () => {
  const scenario = interruptedWithPlan('复用步的旧路径没了', [writeStep()]);
  store.insertReport({
    protocol: 'desktop-agent/v1', type: 'execution_report', taskId: scenario.taskId,
    roundId: scenario.roundId, planId: scenario.stored.planId, status: 'completed',
    nextAction: 'complete', errors: [], createdAt: Date.now(),
    results: [{
      stepId: 'step-1', tool: 'fs.writeFile', status: 'skipped', verified: false, durationMs: 0,
      args: { path: 'gone-after-reuse.txt' }, reusedFrom: { checkpointId: 'cp-1', executedAt: 1 }
    }]
  });

  const ledger = await realLedger(scenario.taskId);
  assert.equal(ledger.entries.length, 1, '带 reusedFrom 的 skipped 是上一轮真写过的路径，必须留在账本里');
  assert.equal(ledger.missing, 1);
});

test('回退开关关闭：恒定走重规划（M2-2 灰度口径）', async () => {
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'hello', 'utf8');
  const scenario = interruptedWithPlan('关掉续跑开关', [writeStep(), testStep()]);
  journalCompletedStep({
    taskId: scenario.taskId, roundId: scenario.roundId, stepId: 'step-1',
    tool: 'fs.writeFile', args: { path: 'note.txt', content: 'hello' },
    result: { path: 'note.txt', bytes: 5 }
  });
  const ledger = await realLedger(scenario.taskId);
  const spy = runPlanSpy((plan, meta, options) => continuedReport(plan, meta, options));
  const orch = orchestrator({
    contextRecovery: async () => recoveredRecovery(ledger),
    runPlan: spy.fn,
    resumeContinue: () => false
  });

  await orch.resume(scenario.taskId);

  assert.equal(spy.calls.length, 0);
  const replanned = events.filter(event =>
    event.type === 'context.event' && event.taskId === scenario.taskId &&
    event.event === 'context.resume.replanned'
  ).at(-1);
  assert.match(replanned.context.reason, /续跑开关已关闭/);
  await settle();
});

test('判定函数：理由逐条列全，缺指针/未批准/hash 不符同时出现', () => {
  const scenario = interruptedWithPlan('多条拦路理由', [writeStep()]);
  const ledger = { entries: [], applied: 0, missing: 0, needsReconciliation: 0, checkedAt: Date.now() };
  const verdict = decideContinuation({
    taskId: scenario.taskId,
    recovery: { status: 'recovered', ledger },
    enabled: true,
    plan: { ...scenario.stored, approvalStatus: 'pending' },
    planHashMatches: false,
    reports: [],
    events: [],
    gateBlocks: true,
    requiresReplan: true
  });
  assert.equal(verdict.mode, 'replan');
  assert.ok(verdict.reasons.some(line => line.includes('未批准')));
  assert.ok(verdict.reasons.some(line => line.includes('hash 不一致')));
  assert.ok(verdict.reasons.some(line => line.includes('门禁未确认')));
  assert.ok(verdict.reasons.some(line => line.includes('版本链')));
  assert.equal(verdict.reasons.length, 4, '要一次列全部理由，界面才答得出「为什么没给我续跑」');
});

test('判定函数：无指针判 none、缺文件判 missing，都不放行续跑', () => {
  const scenario = interruptedWithPlan('无指针与缺文件', [writeStep()]);
  const noPointer = decideContinuation({
    taskId: scenario.taskId, recovery: null, enabled: true, plan: scenario.stored,
    planHashMatches: true, reports: [], events: [], gateBlocks: false, requiresReplan: false
  });
  assert.equal(noPointer.mode, 'replan');
  assert.match(noPointer.reasons[0], /未注入上下文恢复能力/);

  const staleLedger = {
    entries: [{ stepId: 'step-1', roundId: scenario.roundId, tool: 'fs.writeFile', paths: ['gone.txt'], status: 'missing', detail: '' }],
    applied: 0, missing: 1, needsReconciliation: 0, checkedAt: Date.now()
  };
  const fileGone = decideContinuation({
    taskId: scenario.taskId, recovery: recoveredRecovery(staleLedger), enabled: true,
    plan: scenario.stored, planHashMatches: true, reports: [], events: [], gateBlocks: false, requiresReplan: false
  });
  assert.equal(fileGone.mode, 'replan');
  assert.match(fileGone.reasons[0], /已不存在/);
});

test('判定函数：步骤全部跑完时不续跑，转重规划做校验收尾', () => {
  const scenario = interruptedWithPlan('都跑完了', [writeStep()]);
  journalCompletedStep({
    taskId: scenario.taskId, roundId: scenario.roundId, stepId: 'step-1',
    tool: 'fs.writeFile', args: { path: 'note.txt', content: 'hello' },
    result: { path: 'note.txt', bytes: 5 }
  });
  const ledger = {
    entries: [{ stepId: 'step-1', roundId: scenario.roundId, tool: 'fs.writeFile', paths: ['note.txt'], status: 'applied', detail: '' }],
    applied: 1, missing: 0, needsReconciliation: 0, checkedAt: Date.now()
  };
  const verdict = decideContinuation({
    taskId: scenario.taskId, recovery: recoveredRecovery(ledger), enabled: true,
    plan: scenario.stored, planHashMatches: true, reports: [],
    events: store.listEvents(scenario.taskId), gateBlocks: false, requiresReplan: false
  });
  assert.equal(verdict.mode, 'replan');
  assert.match(verdict.reasons[0], /都已执行完/);
});

test('步骤结局认定：只看同一轮的 started+completed，同名步骤不跨轮误认', () => {
  const scenario = interruptedWithPlan('跨轮同名步骤', [writeStep()]);
  // 上一轮跑过 step-1（计划已换到当前轮），本轮没跑——不能当成本轮已完成。
  journalCompletedStep({
    taskId: scenario.taskId, roundId: 'round-old', stepId: 'step-1',
    tool: 'fs.writeFile', args: { path: 'note.txt', content: 'hello' }, result: { path: 'note.txt', bytes: 5 }
  });
  const byEvents = collectCompletedSteps({
    plan: scenario.stored, reports: [], events: store.listEvents(scenario.taskId)
  });
  assert.equal(byEvents.size, 0);

  // started 之后没有 completed/failed：结局未知，同样不算完成。
  journalStep({
    type: 'step.started', taskId: scenario.taskId, roundId: scenario.roundId,
    stepId: 'step-1', tool: 'fs.writeFile', args: { path: 'note.txt' }
  });
  assert.equal(collectCompletedSteps({
    plan: scenario.stored, reports: [], events: store.listEvents(scenario.taskId)
  }).size, 0);

  // 完成事件之后又失败：不能只取 completed 那一条。
  journalStep({
    type: 'step.completed', taskId: scenario.taskId, roundId: scenario.roundId,
    stepId: 'step-1', tool: 'fs.writeFile', result: { path: 'note.txt', bytes: 5 }, durationMs: 3
  });
  journalStep({
    type: 'step.failed', taskId: scenario.taskId, roundId: scenario.roundId,
    stepId: 'step-1', tool: 'fs.writeFile', error: '写坏了'
  });
  assert.equal(collectCompletedSteps({
    plan: scenario.stored, reports: [], events: store.listEvents(scenario.taskId)
  }).size, 0);
});

test('收尾还原：没有证据的复用条目保留 skipped，缺口不能被判成已完成', () => {
  const report = {
    protocol: 'desktop-agent/v1', type: 'execution_report', taskId: 't1', roundId: 'r1', planId: 'p1',
    status: 'completed', nextAction: 'complete', errors: [], createdAt: Date.now(),
    results: [{ stepId: 'step-1', tool: 'fs.writeFile', status: 'skipped', verified: false, durationMs: 0, reusedFrom: { checkpointId: 'cp-1', executedAt: 1 } }]
  };
  const merged = mergeReusedResults(report, new Map());
  assert.equal(merged.results[0].status, 'skipped');
  assert.equal(mergeReusedResults(report, null).results[0].status, 'skipped');
});

