/**
 * P0-4：暂停/取消不是只改一个状态字。
 *
 * 覆盖：请求态 → 停止中 → 实际态、检查点带目标版本/任务树 revision/副作用账本，
 * 以及恢复入口确实读到该检查点而不是沿用旧结论。
 * Run: npm run test:pause-checkpoint
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgentStore } from '../out-test/main/store.js';
import { TaskManager } from '../out-test/main/task-manager.js';
import { AgentOrchestrator, hashPlan } from '../out-test/main/orchestrator.js';
import { ContextArchiveStore } from '../out-test/main/context/checkpoint/archive.js';
import { ContextCheckpointStore } from '../out-test/main/context/checkpoint/store.js';
import { commitPauseCheckpoint } from '../out-test/main/context/checkpoint/pause.js';
import { recoverTaskContext, taskContextOwner } from '../out-test/main/context/recovery/task-recovery.js';
import {
  deleteTaskContextArtifacts,
  reclaimOrphanContextArtifacts
} from '../out-test/main/context/checkpoint/gc.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-pause-checkpoint-'));
const workspace = path.join(dir, 'ws');
fs.mkdirSync(workspace, { recursive: true });
const store = new AgentStore(path.join(dir, 'agent-store.json'));
const events = [];
// 与主进程同口径：转发给界面的事件同时进 Journal（index.ts 的 appendEvent）。
// 不落盘的话这里就测不到「任务字段丢了、只能靠事件流重建指针」这条恢复路径。
function emit(event) {
  events.push(event);
  store.appendEvent(event.taskId
    ? { ...event, eventId: `ev_${String(events.length)}`, runId: event.taskId }
    : event);
}
const tasks = new TaskManager(store, emit);
const checkpointBase = path.join(dir, 'checkpoints');
const checkpointStore = new ContextCheckpointStore({ baseDir: checkpointBase });
const archive = new ContextArchiveStore(checkpointBase);

function orchestrator(overrides = {}) {
  return new AgentOrchestrator({
    tasks,
    store,
    adapter: () => ({ cancelWait: () => {} }),
    emit,
    dbPath: () => path.join(dir, 'journal.json'),
    pauseCheckpoint: async input => commitPauseCheckpoint(input, {
      store: checkpointStore, archive, journal: store
    }),
    // 与 index.ts 同口径：回收走 gc 模块本体，测试里不再抄一份判据。
    deleteContextArtifacts: async task =>
      deleteTaskContextArtifacts(checkpointStore, archive, taskContextOwner(task)),
    reclaimOrphanArtifacts: liveTaskIds =>
      reclaimOrphanContextArtifacts(checkpointStore, archive, liveTaskIds),
    ...overrides
  });
}

function reportFor(taskId, stepId, tool, args) {
  return {
    protocol: 'desktop-agent/v1',
    type: 'execution_report',
    taskId,
    roundId: `round:${stepId}`,
    planId: `plan:${stepId}`,
    status: 'completed',
    errors: [],
    nextAction: 'continue',
    createdAt: Date.now(),
    results: [{
      stepId, tool, status: 'completed', verified: true, durationMs: 1, args
    }]
  };
}

function statusSequence(taskId) {
  const statuses = events
    .filter(event => event.type === 'task.updated' && event.task.taskId === taskId)
    .map(event => event.task.status);
  // 检查点事务会顺带发布一次 task.updated；这里只关心状态迁移序列。
  return statuses.filter((status, index) => index === 0 || status !== statuses[index - 1]);
}

function upsertWorkTask(taskId, revision) {
  store.appendEvent({
    type: 'work.task.upserted',
    at: Date.now(),
    taskId,
    task: { workTaskId: `w-${taskId}`, status: 'pending', goalVersion: 1, revision }
  });
}

test('暂停：先到请求态/停止中，检查点记录目标版本、任务树与副作用缺口', async () => {
  const task = tasks.create({ prompt: '暂停检查点', permissionPreset: 'workspace-write', workspaceRoot: workspace });
  tasks.transition(task.taskId, 'planning');
  upsertWorkTask(task.taskId, 3);
  fs.writeFileSync(path.join(workspace, 'done.txt'), 'done', 'utf8');
  store.insertReport(reportFor(task.taskId, 's1', 'fs.writeFile', { path: 'done.txt' }));
  store.insertReport(reportFor(task.taskId, 's2', 'shell.run', { command: 'echo hi' }));

  await orchestrator().pause(task.taskId);

  assert.deepEqual(statusSequence(task.taskId), [
    'created', 'planning', 'pause_requested', 'pausing', 'paused'
  ]);
  const current = tasks.get(task.taskId);
  assert.ok(current.checkpointId);
  assert.ok(current.contextId);
  assert.equal(current.resumeStatus, 'planning');

  const pausedEvent = events.filter(event =>
    event.type === 'context.checkpoint.paused' && event.taskId === task.taskId
  ).at(-1);
  assert.equal(pausedEvent?.reason, 'pause');
  assert.equal(pausedEvent?.goalVersion, 1);
  assert.equal(pausedEvent?.taskRevision, 3);
  assert.equal(pausedEvent?.checkpointId, current.checkpointId);
  assert.ok(pausedEvent?.needsReconciliation >= 1);

  // M2-1：指针三字段只能由 Journal 事务写。事件里也要带全，否则任务字段丢了
  // 就再也重建不出指针；activeRunId 尤其关键——恢复时靠它过 runId 门。
  assert.ok(current.activeRunId, '任务字段缺 activeRunId，Journal 指针写不全');
  assert.equal(pausedEvent?.contextId, current.contextId);
  assert.equal(pausedEvent?.activeRunId, current.activeRunId);

  const checkpoint = await checkpointStore.find(taskContextOwner(current), current.checkpointId);
  assert.ok(checkpoint);
  assert.equal(current.checkpointId, checkpoint.checkpointId);
  assert.equal(current.contextId, checkpoint.contextId);
  assert.equal(current.activeRunId, checkpoint.runId);
  assert.ok(checkpoint.summary.constraints.some(line => line.includes('目标版本 v1')));
  assert.ok(checkpoint.summary.constraints.some(line => line.includes('任务树 revision 3')));
  assert.ok(checkpoint.summary.openIssues.some(line => line.includes('needs_reconciliation')));
  assert.ok(checkpoint.summary.evidence.some(item => item.path === 'done.txt'));
});

test('取消：先到请求态/取消中，再落检查点并结束', async () => {
  const task = tasks.create({ prompt: '取消检查点', permissionPreset: 'workspace-write', workspaceRoot: workspace });
  tasks.transition(task.taskId, 'planning');
  tasks.transition(task.taskId, 'plan_ready');
  upsertWorkTask(task.taskId, 2);

  await orchestrator().cancel(task.taskId);

  assert.deepEqual(statusSequence(task.taskId), [
    'created', 'planning', 'plan_ready', 'cancel_requested', 'cancelling', 'cancelled'
  ]);
  const pausedEvent = events.filter(event =>
    event.type === 'context.checkpoint.paused' && event.taskId === task.taskId
  ).at(-1);
  assert.equal(pausedEvent?.reason, 'cancel');
  assert.equal(pausedEvent?.taskRevision, 2);
  assert.ok(tasks.get(task.taskId).checkpointId);
});

test('未落报告的在途写操作也算副作用缺口，不能因为报告迟到就当没有', async () => {
  const task = tasks.create({ prompt: '在途写入探针', permissionPreset: 'workspace-write', workspaceRoot: workspace });
  tasks.transition(task.taskId, 'planning');
  tasks.transition(task.taskId, 'plan_ready');
  tasks.transition(task.taskId, 'awaiting_approval');
  tasks.transition(task.taskId, 'executing');
  store.appendEvent({
    type: 'step.started', at: Date.now(), taskId: task.taskId,
    roundId: 'round-inflight', stepId: 's4', tool: 'shell.run',
    args: { command: 'echo hi' }
  });

  await orchestrator().pause(task.taskId);

  const pausedEvent = events.filter(event =>
    event.type === 'context.checkpoint.paused' && event.taskId === task.taskId
  ).at(-1);
  assert.ok(pausedEvent?.needsReconciliation >= 1);
  const current = tasks.get(task.taskId);
  const checkpoint = await checkpointStore.find(taskContextOwner(current), current.checkpointId);
  assert.ok(checkpoint.summary.openIssues.some(line => line.includes('在途')));
});

test('恢复入口读暂停检查点：拿到的是落库摘要与副作用账本，不是旧结论', async () => {
  const task = tasks.create({ prompt: '恢复读暂停检查点', permissionPreset: 'workspace-write', workspaceRoot: workspace });
  tasks.transition(task.taskId, 'planning');
  upsertWorkTask(task.taskId, 4);
  store.insertReport(reportFor(task.taskId, 's3', 'shell.run', { command: 'echo hi' }));
  await orchestrator().pause(task.taskId);
  const paused = tasks.get(task.taskId);

  let captured = null;
  const resumeOrchestrator = orchestrator({
    contextRecovery: async (current, reports) => {
      captured = await recoverTaskContext(current, reports, {
        store: checkpointStore,
        archive,
        eventsForTask: id => store.listEvents(id)
      });
      // 停在恢复前，不让 driveRound 真的发模型请求；指针来源照实透传，
      // 用来验证 Orchestrator 把「走的哪条路」写进了事件。
      return {
        status: 'stale',
        reason: '测试中止恢复',
        ...(captured?.pointerSource ? { pointerSource: captured.pointerSource } : {}),
        ...(captured?.contextId ? { contextId: captured.contextId } : {}),
        ...(captured?.checkpointId ? { checkpointId: captured.checkpointId } : {})
      };
    }
  });

  await assert.rejects(() => resumeOrchestrator.resume(task.taskId), /检查点不可用/);
  assert.equal(captured?.status, 'recovered');
  assert.equal(captured?.checkpointId, paused.checkpointId);
  // 恢复路径要打点：正常情况读的就是落库指针。
  assert.equal(captured?.pointerSource, 'task-fields');
  assert.ok(captured?.summary?.constraints.some(line => line.includes('任务树 revision 4')));
  assert.ok((captured?.ledger?.needsReconciliation ?? 0) >= 1);
  const staleEvent = events.filter(event =>
    event.type === 'context.event' && event.taskId === task.taskId &&
    event.event === 'context.compaction.stale'
  ).at(-1);
  assert.equal(staleEvent?.context?.pointerSource, 'task-fields');
});

test('半套指针：任务字段没落全时按事件流重建，不把已落盘的检查点当不存在', async () => {
  const task = tasks.create({ prompt: '指针字段丢失', permissionPreset: 'workspace-write', workspaceRoot: workspace });
  tasks.transition(task.taskId, 'planning');
  upsertWorkTask(task.taskId, 5);
  await orchestrator().pause(task.taskId);
  const paused = tasks.get(task.taskId);
  assert.ok(paused.checkpointId);

  // 模拟中间态：Journal 事件已落库，任务上的指针字段没写进去（旧库 / 半套写入）。
  tasks.patch(task.taskId, { contextId: undefined, checkpointId: undefined, activeRunId: undefined });
  const stripped = tasks.get(task.taskId);
  assert.equal(stripped.checkpointId, undefined);

  let captured = null;
  const resumeOrchestrator = orchestrator({
    contextRecovery: async (current, reports) => {
      captured = await recoverTaskContext(current, reports, {
        store: checkpointStore,
        archive,
        eventsForTask: id => store.listEvents(id)
      });
      // 停在恢复前，同时把重建出的指针来源透传给 Orchestrator，
      // 验证「走的哪条路」确实写进了恢复事件。
      return {
        status: 'stale',
        reason: '测试中止恢复',
        ...(captured?.pointerSource ? { pointerSource: captured.pointerSource } : {}),
        ...(captured?.contextId ? { contextId: captured.contextId } : {}),
        ...(captured?.checkpointId ? { checkpointId: captured.checkpointId } : {})
      };
    }
  });

  await assert.rejects(() => resumeOrchestrator.resume(task.taskId), /检查点不可用/);
  assert.equal(captured?.status, 'recovered');
  assert.equal(captured?.pointerSource, 'events-replay');
  assert.equal(captured?.checkpointId, paused.checkpointId);
  assert.equal(captured?.contextId, paused.contextId);
  // 重建出的指针必须还能过校验：读到的仍是那份暂停检查点。
  assert.ok(captured?.summary?.constraints.some(line => line.includes('任务树 revision 5')));
  const recoveredEvent = events.filter(event =>
    event.type === 'context.event' && event.taskId === task.taskId &&
    event.event === 'context.compaction.stale'
  ).at(-1);
  assert.equal(recoveredEvent?.context?.pointerSource, 'events-replay');
});

test('既没有指针字段也没有检查点事件：判 none，不凭空造指针', async () => {
  const task = tasks.create({ prompt: '无检查点恢复', permissionPreset: 'read-only' });
  tasks.transition(task.taskId, 'planning');
  const orphan = tasks.get(task.taskId);
  assert.equal(orphan.checkpointId, undefined);

  const result = await recoverTaskContext(orphan, [], {
    store: checkpointStore,
    archive,
    eventsForTask: id => store.listEvents(id)
  });
  assert.equal(result.status, 'none');
  assert.ok(result.reason);
});

test('进程重启收敛：暂停中间态转 interrupted，取消中间态转 cancelled', () => {
  const pausing = tasks.create({ prompt: '退出时暂停中', permissionPreset: 'read-only' });
  tasks.transition(pausing.taskId, 'planning');
  tasks.transition(pausing.taskId, 'pause_requested');
  tasks.transition(pausing.taskId, 'pausing');

  const cancelling = tasks.create({ prompt: '退出时取消中', permissionPreset: 'read-only' });
  tasks.transition(cancelling.taskId, 'planning');
  tasks.transition(cancelling.taskId, 'cancel_requested');
  tasks.transition(cancelling.taskId, 'cancelling');

  assert.ok(tasks.reconcileInterrupted() >= 2);
  assert.equal(tasks.get(pausing.taskId).status, 'interrupted');
  assert.equal(tasks.get(cancelling.taskId).status, 'cancelled');
});

/**
 * M2-2 口径对接：暂停侧写进检查点的账本，必须就是恢复侧放行/拦下续跑的那份账本。
 *
 * 上面几例把 `contextRecovery` 换成替身，测的是「恢复读到检查点」；本例用真
 * `recoverTaskContext` + 真归档 + 真文件，把「暂停落账 → 恢复判定 → 续跑/重规划」
 * 整条链跑一遍。写读两侧口径不一致时（比如恢复侧漏了在途步骤），这里就会红。
 */
/**
 * 造一个「执行中暂停」的任务：已批准计划 + 本轮跑过的步骤事件。
 *
 * `executed` 里带 `result` 的是真跑完的一步（started+completed），只带 `args` 的是
 * 起了但没落结局的在途一步——后者就是 SIGKILL 留下的形态。
 */
function pausedMidPlan(name, steps, executed) {
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
    contentHash: hashPlan(plan), approvalStatus: 'approved', createdAt: Date.now()
  });
  tasks.patch(task.taskId, { currentPlanId: plan.planId });
  tasks.transition(task.taskId, 'plan_ready');
  tasks.transition(task.taskId, 'awaiting_approval');
  tasks.transition(task.taskId, 'executing');
  let completedAt = 0;
  for (const item of executed) {
    const startedAt = Date.now();
    emit({
      type: 'step.started', at: startedAt, taskId: task.taskId, roundId: round.roundId,
      stepId: item.stepId, tool: item.tool, args: item.args
    });
    if (item.result === undefined) continue;
    completedAt = startedAt + 12;
    emit({
      type: 'step.completed', at: completedAt, taskId: task.taskId, roundId: round.roundId,
      stepId: item.stepId, tool: item.tool, result: item.result, durationMs: 12
    });
  }
  return { taskId: task.taskId, roundId: round.roundId, planId: plan.planId, completedAt };
}

function resumeWithRealRecovery(runPlan) {
  const spy = { calls: [] };
  const orch = orchestrator({
    contextRecovery: async (current, reports) => recoverTaskContext(current, reports, {
      store: checkpointStore, archive, eventsForTask: id => store.listEvents(id)
    }),
    runPlan: async (plan, grant, dbPath, timeoutMs, meta, options) => {
      spy.calls.push({ plan, meta, options });
      return runPlan(plan, meta, options);
    }
  });
  return { orch, spy };
}

test('真检查点续跑：暂停账本无未知缺口 → 复用已跑完的一步，不建新一轮', async () => {
  fs.writeFileSync(path.join(workspace, 'resume-note.txt'), 'hello', 'utf8');
  const scenario = pausedMidPlan(
    '真检查点续跑',
    [{ id: 'step-1', tool: 'fs.writeFile', args: { path: 'resume-note.txt', content: 'hello' }, description: '写文件' },
      { id: 'step-2', tool: 'test.run', args: { command: 'npm test' }, description: '跑测试' }],
    [
      { stepId: 'step-1', tool: 'fs.writeFile', args: { path: 'resume-note.txt', content: 'hello' }, result: { path: 'resume-note.txt', bytes: 5 } }
    ]
  );

  await orchestrator().pause(scenario.taskId);
  const paused = tasks.get(scenario.taskId);
  assert.equal(paused.resumeStatus, 'executing', '暂停自执行中，继续时才轮得到续跑判定');
  const roundsBefore = tasks.listRounds(scenario.taskId).length;

  const { orch, spy } = resumeWithRealRecovery((plan, meta, options) => ({
    protocol: 'desktop-agent/v1', type: 'execution_report', taskId: plan.taskId,
    roundId: meta.roundId, planId: meta.planId, status: 'completed', nextAction: 'complete',
    errors: [], createdAt: Date.now(),
    results: [
      ...(options?.reusedSteps ?? []).map(item => ({
        stepId: item.stepId, tool: 'fs.writeFile', status: 'skipped', verified: false, durationMs: 0,
        args: { path: 'resume-note.txt' },
        reusedFrom: { checkpointId: item.checkpointId ?? '', executedAt: item.executedAt }
      })),
      { stepId: 'step-2', tool: 'test.run', status: 'completed', verified: true, durationMs: 4, args: { command: 'npm test' }, result: { command: 'npm test', exitCode: 0 } }
    ]
  }));
  await orch.resume(scenario.taskId);

  assert.equal(spy.calls.length, 1);
  assert.deepEqual(spy.calls[0].options?.reusedSteps, [
    { stepId: 'step-1', checkpointId: paused.checkpointId, executedAt: scenario.completedAt }
  ]);
  assert.equal(tasks.listRounds(scenario.taskId).length, roundsBefore);
  const final = store.allReportsFor(scenario.taskId).at(-1);
  assert.equal(final.results.find(item => item.stepId === 'step-1').status, 'completed');
  assert.ok((final.verification?.changedPaths ?? []).includes('resume-note.txt'));
});

test('真检查点拦下续跑：暂停时留了无路径的在途写 → 走重规划，不开 Runtime', async () => {
  const scenario = pausedMidPlan(
    '真检查点缺口',
    [{ id: 'step-1', tool: 'fs.writeFile', args: { path: 'resume-note.txt', content: 'hello' }, description: '写文件' },
      { id: 'step-2', tool: 'shell.run', args: { command: 'echo hi' }, description: '无路径可核对' }],
    [
      { stepId: 'step-1', tool: 'fs.writeFile', args: { path: 'resume-note.txt', content: 'hello' }, result: { path: 'resume-note.txt', bytes: 5 } },
      { stepId: 'step-2', tool: 'shell.run', args: { command: 'echo hi' } }
    ]
  );

  await orchestrator().pause(scenario.taskId);
  const paused = tasks.get(scenario.taskId);
  const roundsBefore = tasks.listRounds(scenario.taskId).length;
  const { orch, spy } = resumeWithRealRecovery(() => { throw new Error('不该执行'); });

  await orch.resume(scenario.taskId);

  assert.equal(spy.calls.length, 0);
  assert.equal(tasks.listRounds(scenario.taskId).length, roundsBefore + 1);
  const replanned = events.filter(event =>
    event.type === 'context.event' && event.taskId === scenario.taskId &&
    event.event === 'context.resume.replanned'
  ).at(-1);
  assert.match(replanned.context.reason, /结局未知且无路径可核对/);
  assert.equal(replanned.context.checkpointId, paused.checkpointId);
  // 重规划这条路会异步开一轮规划（适配器替身会失败）：等它落地，别在目录删掉后还写库。
  for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve));
});

test('暂停后取消报告才到：状态留在 paused，之后仍能从检查点续跑', async () => {
  fs.writeFileSync(path.join(workspace, 'late-note.txt'), 'hello', 'utf8');
  const scenario = pausedMidPlan(
    '暂停后报告迟到',
    [
      { id: 'step-1', tool: 'fs.writeFile', args: { path: 'late-note.txt', content: 'hello' }, description: '写文件' },
      { id: 'step-2', tool: 'fs.writeFile', args: { path: 'never-run.txt', content: 'x' }, description: '没轮到的写' }
    ],
    [{ stepId: 'step-1', tool: 'fs.writeFile', args: { path: 'late-note.txt', content: 'hello' }, result: { path: 'late-note.txt', bytes: 5 } }]
  );
  await orchestrator().pause(scenario.taskId);
  const paused = tasks.get(scenario.taskId);
  assert.equal(paused.status, 'paused');

  // Runtime 的停止回执先到（pause 据此写完检查点），执行报告随后才落地。
  // 这份报告的 status 是 cancelled——暂停与取消在 Runtime 侧是同一次停止。
  const closing = orchestrator();
  await closing.finishPlanExecution(paused, store.getPlan(scenario.planId), {
    protocol: 'desktop-agent/v1', type: 'execution_report', taskId: scenario.taskId,
    roundId: scenario.roundId, planId: scenario.planId, status: 'cancelled',
    nextAction: 'stop', errors: [], createdAt: Date.now(),
    results: [
      { stepId: 'step-1', tool: 'fs.writeFile', status: 'completed', verified: true, durationMs: 5, args: { path: 'late-note.txt' }, result: { path: 'late-note.txt', bytes: 5 } },
      { stepId: 'step-2', tool: 'fs.writeFile', status: 'skipped', verified: false, durationMs: 0, error: '任务已取消', args: { path: 'never-run.txt' } }
    ]
  });

  assert.equal(tasks.get(scenario.taskId).status, 'paused', '暂停点不能被收尾流程带走：resume 只认 paused/interrupted/budget_exhausted/blocked');
  assert.equal(events.some(event => event.type === 'task.cancelled' && event.taskId === scenario.taskId), false);
  assert.equal(store.allReportsFor(scenario.taskId).length, 1, '报告要落库，已完成步骤的证据不能丢');
  assert.ok(events.some(event => event.type === 'report.ready' && event.taskId === scenario.taskId));
  assert.ok(events.some(event => event.type === 'log' && event.taskId === scenario.taskId && /暂停/.test(event.message ?? '')));

  const { orch, spy } = resumeWithRealRecovery((plan, meta, options) => ({
    protocol: 'desktop-agent/v1', type: 'execution_report', taskId: plan.taskId,
    roundId: meta.roundId, planId: meta.planId, status: 'completed', nextAction: 'complete',
    errors: [], createdAt: Date.now(),
    results: [
      ...(options?.reusedSteps ?? []).map(item => ({
        stepId: item.stepId, tool: 'fs.writeFile', status: 'skipped', verified: false, durationMs: 0,
        args: { path: 'late-note.txt' },
        reusedFrom: { checkpointId: item.checkpointId ?? '', executedAt: item.executedAt }
      })),
      { stepId: 'step-2', tool: 'fs.writeFile', status: 'completed', verified: true, durationMs: 3, args: { path: 'never-run.txt' }, result: { path: 'never-run.txt', bytes: 1 } }
    ]
  }));
  await orch.resume(scenario.taskId);

  const reused = spy.calls[0]?.options?.reusedSteps ?? [];
  assert.deepEqual(reused.map(item => item.stepId), ['step-1'], '迟到的取消报告不该把续跑门槛弄成过不去');
  assert.equal(reused[0]?.checkpointId, paused.checkpointId);
  // executedAt 取的是「这条完成证据来自哪里」的时间：报告落了就以报告为准。
  assert.ok(Number.isFinite(reused[0]?.executedAt) && reused[0].executedAt > 0);
  assert.equal(spy.calls.length, 1, '续跑必须把计划交给 Runtime');
  // 只断言「恢复这一步」没有另起一轮：续跑沿用被中断那份计划所在的轮次。
  // 报告落地后是否再开一轮由 continueAfterReport 判（没有通过测试就补一轮修复），
  // 与暂停检查点无关，那条路由上面「真检查点续跑」的用例覆盖。
  assert.equal(spy.calls[0].meta.roundId, scenario.roundId, '续跑应沿用被中断那轮的 roundId');
  const continued = events.filter(event =>
    event.type === 'context.event' && event.taskId === scenario.taskId &&
    event.event === 'context.resume.continued'
  ).at(-1);
  assert.equal(continued?.context?.checkpointId, paused.checkpointId);
});

test('删除任务：按 owner 回收检查点文件与归档段，磁盘上不残留孤儿', async () => {
  const doomed = tasks.create({ prompt: '删除回收检查点', permissionPreset: 'workspace-write', workspaceRoot: workspace });
  tasks.transition(doomed.taskId, 'planning');
  await orchestrator().pause(doomed.taskId);
  const paused = tasks.get(doomed.taskId);
  const owner = taskContextOwner(paused);

  // 另建一个同基路径下的任务：回收只认 owner，不能顺手清整个目录。
  const keeper = tasks.create({ prompt: '保留的检查点', permissionPreset: 'workspace-write', workspaceRoot: workspace });
  tasks.transition(keeper.taskId, 'planning');
  await orchestrator().pause(keeper.taskId);
  const keeperOwner = taskContextOwner(tasks.get(keeper.taskId));

  // 归档段由上下文压缩路径写；这里直接造一段，测的是回收不是写入。
  const segment = await archive.write({
    owner, checkpointId: paused.checkpointId, sourceStream: 'events', events: [{ type: 'log', at: 1 }]
  });
  assert.ok(await checkpointStore.read(owner), '前置条件：检查点确实落了盘');
  assert.ok(await archive.read(segment.archiveRef), '前置条件：归档段确实落了盘');

  const cleanup = await orchestrator().deleteTask(doomed.taskId);

  assert.equal(cleanup.taskId, doomed.taskId);
  assert.equal(cleanup.checkpointsRemoved, true);
  assert.equal(cleanup.archiveSegments, 1);
  assert.equal(store.getTask(doomed.taskId), null);
  assert.equal(await checkpointStore.read(owner), null, '任务删了，检查点必须跟着走');
  assert.equal(await archive.read(segment.archiveRef), null, '没有指针寻得到的归档段就是孤儿');
  assert.ok(await checkpointStore.read(keeperOwner), '别的任务的检查点不能被顺带清掉');
});

test('目标回收只认「最后一条绑定任务被删」，不把活动很旧当成删除理由', async () => {
  const goalId = 'goal-shared-cleanup';
  // 故意写得很旧：按时间猜的话这里会被误删，剩下那条任务的分组标题就凭空换了。
  store.upsertGoal({ goalId, title: '同一个目标', version: 3, criteria: ['口径一致'], updatedAt: Date.now() - 400 * 86_400_000 });
  const first = tasks.create({ prompt: '同目标 A', permissionPreset: 'read-only', goalId });
  const second = tasks.create({ prompt: '同目标 B', permissionPreset: 'read-only', goalId });

  const oneDeleted = await orchestrator().deleteTask(first.taskId);
  assert.equal(oneDeleted.goalId, goalId);
  assert.equal(oneDeleted.goalReclaimed, false, '还有一条任务绑着目标，删不得');
  assert.ok(store.getGoal(goalId));
  assert.ok(store.getTask(second.taskId));

  const lastDeleted = await orchestrator().deleteTask(second.taskId);
  assert.equal(lastDeleted.goalReclaimed, true);
  assert.equal(store.getGoal(goalId), null);

  // 没落过目标实体的任务（默认 goal:<taskId>）：回收如实报 false，不假装清掉了什么。
  const lone = tasks.create({ prompt: '没有目标实体', permissionPreset: 'read-only' });
  const loneCleanup = await orchestrator().deleteTask(lone.taskId);
  assert.equal(loneCleanup.goalReclaimed, false);
  assert.equal(loneCleanup.checkpointsRemoved, false);
});

test('启动扫描：任务表里查不到的残留被回收，活任务与会话上下文一份不动', async () => {
  // 一台「回收逻辑上线前就删过任务」的机器：没有删除动作可依，只能按任务表判孤儿。
  const orphan = tasks.create({ prompt: '回收前删掉的任务', permissionPreset: 'workspace-write', workspaceRoot: workspace });
  tasks.transition(orphan.taskId, 'planning');
  await orchestrator().pause(orphan.taskId);
  const orphanOwner = taskContextOwner(tasks.get(orphan.taskId));
  const orphanSegment = await archive.write({
    owner: orphanOwner,
    checkpointId: tasks.get(orphan.taskId).checkpointId,
    sourceStream: 'events',
    events: [{ type: 'log', at: 1 }]
  });
  // 绕过 orchestrator.deleteTask：模拟旧版本「只删任务记录、不碰磁盘」的删除。
  store.deleteTask(orphan.taskId);

  const alive = tasks.create({ prompt: '还在列表里的任务', permissionPreset: 'workspace-write', workspaceRoot: workspace });
  tasks.transition(alive.taskId, 'planning');
  await orchestrator().pause(alive.taskId);
  const aliveOwner = taskContextOwner(tasks.get(alive.taskId));

  const conversationOwner = {
    ownerType: 'conversation',
    ownerId: 'conv-keep-me',
    conversationId: 'conv-keep-me',
    runId: 'conv-keep-me'
  };
  await checkpointStore.write(conversationOwner, {
    contractVersion: 1,
    checkpointId: 'cp_conv_keep',
    owner: conversationOwner,
    taskId: '',
    runId: 'conv-keep-me',
    contextId: 'ctx_conv',
    sourceStartSeq: 0,
    sourceEndSeq: 0,
    sourceEventIds: [],
    summary: { goal: '会话', constraints: [], completed: [], decisions: [], evidence: [], openIssues: [], currentStep: null, nextActions: [], risks: [], stopConditions: [] },
    summaryHash: 'sha256:whatever',
    retainedEventIds: [],
    evidenceRefs: [],
    modelId: 'test',
    inputTokensBefore: null,
    inputTokensAfter: null,
    status: 'committed',
    createdAt: Date.now()
  });
  const conversationSegment = await archive.write({
    owner: conversationOwner,
    checkpointId: 'cp_conv_keep',
    sourceStream: 'events',
    events: [{ type: 'log', at: 2 }]
  });

  // 孤儿目标：任务表里没有任何任务绑它。
  store.upsertGoal({ goalId: 'goal-orphan', title: '没人绑的目标', version: 1, criteria: [], updatedAt: Date.now() });

  const counts = await orchestrator().reclaimOrphanArtifacts();

  assert.equal(counts.checkpointsRemoved, 1, `实际 ${JSON.stringify(counts)}`);
  assert.equal(counts.archiveSegments, 1, `实际 ${JSON.stringify(counts)}`);
  assert.equal(counts.goalsRemoved, 1);
  assert.equal(await checkpointStore.read(orphanOwner), null, '没有任务认领的检查点必须收掉');
  assert.equal(await archive.read(orphanSegment.archiveRef), null, '归档段跟着 owner 一起收');
  assert.ok(await checkpointStore.read(aliveOwner), '任务还在表里，检查点就得留着');
  assert.ok(await archive.read(conversationSegment.archiveRef), '会话归档不按任务表判孤儿');
  assert.ok(await checkpointStore.read(conversationOwner), '会话检查点同上');
  assert.equal(store.getGoal('goal-orphan'), null);

  const sweepLog = events.filter(event =>
    event.type === 'log' && /已清理无人认领的上下文残留/.test(event.message)
  ).at(-1);
  assert.ok(sweepLog, '回收了东西必须在事件流里留下可对账的一句话');
  assert.match(sweepLog.message, /检查点 1 份/);
});

test('启动扫描没有残留时不报数、不误删：计数为 0 也不发清理日志', async () => {
  // 事件数组是跨用例共用的：只认这次调用之后新增的那几条。
  const seenBefore = events.length;
  const counts = await orchestrator().reclaimOrphanArtifacts();
  assert.equal(counts.checkpointsRemoved, 0);
  assert.equal(counts.archiveSegments, 0);
  assert.equal(counts.goalsRemoved, 0);
  assert.equal(events.slice(seenBefore).some(event =>
    event.type === 'log' && /已清理无人认领的上下文残留/.test(event.message)
  ), false, '没删任何东西就不该报「已清理」');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
