/**
 * 30 步长任务：压缩、检查点、故障注入、恢复（LT-P6-04）。
 *
 * 这是组件/集成级 E2E：使用真实 AgentStore、检查点文件、归档与恢复模块，
 * 但执行步骤是落库报告，不启动 Runtime。真实工程任务由真机验收单独记录。
 *
 * 故障注入：
 * - 30 步中 3 步是没有路径的 shell（必须 needs_reconciliation）；
 * - 1 个改动文件在恢复前被删除（必须 missing）；
 * - 摘要首次失败（必须保留旧上下文、标记 failed）；
 * - 归档被篡改（必须 stale，不返回半可用摘要）。
 *
 * Run with: npm run test:long-task-e2e
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgentStore } from '../out-test/main/store.js';
import { TaskManager } from '../out-test/main/task-manager.js';
import { DefaultContextManager } from '../out-test/main/context/manager.js';
import { ContextCheckpointStore } from '../out-test/main/context/checkpoint/store.js';
import { ContextArchiveStore } from '../out-test/main/context/checkpoint/archive.js';
import { commitContextCheckpoint } from '../out-test/main/context/checkpoint/commit.js';
import { hashContextSummary } from '../out-test/main/context/compaction/summary.js';
import { recoverTaskContext, taskContextOwner } from '../out-test/main/context/recovery/task-recovery.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-30-e2e-'));
const workspace = path.join(dir, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const store = new AgentStore(path.join(dir, 'agent-store.json'));
const tasks = new TaskManager(store, () => {});

const summary = {
  goal: '30 步任务',
  constraints: [],
  completed: [{ text: '前 25 步已记录', certainty: 'claim', eventIds: ['e1'] }],
  decisions: [],
  evidence: [],
  openIssues: [],
  currentStep: null,
  nextActions: [],
  risks: [],
  stopConditions: []
};

function historyOf(count) {
  return Array.from({ length: count }, (_, index) => ({
    eventId: `e${index + 1}`,
    kind: 'message',
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `第 ${index + 1} 步历史`,
    at: index + 1
  }));
}

function reportFor(taskId, step) {
  const tool = step % 10 === 0 ? 'shell.run' : 'fs.writeFile';
  const file = `step-${step}.txt`;
  if (tool === 'fs.writeFile' && step !== 16) {
    fs.writeFileSync(path.join(workspace, file), `step ${step}`, 'utf8');
  }
  return {
    protocol: 'desktop-agent/v1',
    type: 'execution_report',
    taskId,
    roundId: 'round-1',
    planId: 'plan-1',
    status: 'completed',
    errors: [],
    nextAction: 'complete',
    createdAt: step,
    results: [{
      stepId: `s${step}`,
      tool,
      status: 'completed',
      verified: true,
      durationMs: 1,
      args: tool === 'shell.run' ? { command: `echo ${step}` } : { path: file }
    }],
    verification: {
      verified: true,
      reasons: [],
      changedFiles: tool === 'fs.writeFile' ? 1 : 0,
      changedPaths: tool === 'fs.writeFile' ? [file] : []
    }
  };
}

test('30 步：摘要提交、检查点恢复、缺失文件与无路径写操作都可核对', async () => {
  const task = tasks.create({ prompt: '30 步任务', permissionPreset: 'workspace-write', workspaceRoot: workspace });
  tasks.transition(task.taskId, 'planning');
  tasks.transition(task.taskId, 'plan_ready');
  tasks.transition(task.taskId, 'awaiting_approval');
  tasks.transition(task.taskId, 'executing');
  const owner = taskContextOwner(tasks.get(task.taskId));

  const cpStore = new ContextCheckpointStore({ baseDir: path.join(dir, 'checkpoints') });
  const archive = new ContextArchiveStore(path.join(dir, 'checkpoints'));
  const history = historyOf(30);

  const manager = new DefaultContextManager({
    compaction: {
      triggerAfter: 10,
      retainRecent: 5,
      summarize: async input => ({
        summary,
        summaryHash: hashContextSummary(summary),
        sourceEventIds: input.history.map(item => item.eventId),
        modelId: 'm'
      }),
      commit: async input => {
        const checkpointId = 'cp-30';
        await commitContextCheckpoint({
          owner,
          runId: owner.runId,
          contextId: input.contextId,
          checkpoint: {
            contractVersion: 1,
            checkpointId,
            owner,
            taskId: task.taskId,
            runId: owner.runId,
            contextId: input.contextId,
            sourceStartSeq: 0,
            sourceEndSeq: input.history.length,
            sourceEventIds: input.history.map(item => item.eventId),
            summary: input.summary,
            summaryHash: input.summaryHash,
            retainedEventIds: input.retainedEventIds,
            evidenceRefs: [],
            modelId: input.modelId,
            inputTokensBefore: input.inputTokensBefore,
            inputTokensAfter: null,
            status: 'prepared',
            createdAt: Date.now()
          },
          sourceEvents: input.history
        }, { store: cpStore, archive, journal: store });
        return { checkpointId };
      }
    }
  });

  const prepared = await manager.prepare({
    owner,
    runId: owner.runId,
    question: '完成 30 步',
    context: [],
    system: [],
    history,
    evidenceRefs: [],
    providerId: 'cloud',
    modelId: 'm'
  });
  assert.equal(prepared.context.compactionStatus, 'committed');
  assert.equal(prepared.context.checkpointId, 'cp-30');
  assert.ok(prepared.contextLines.some(line => line.includes('[摘要]')));

  for (let step = 1; step <= 30; step += 1) store.insertReport(reportFor(task.taskId, step));

  const current = tasks.get(task.taskId);
  assert.equal(current.checkpointId, 'cp-30');
  assert.ok(current.contextId);
  assert.equal(current.activeRunId, owner.runId);

  const recovered = await recoverTaskContext(current, store.allReportsFor(task.taskId), {
    store: cpStore,
    archive
  });
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.summary.goal, '30 步任务');
  assert.ok(recovered.ledger.applied >= 20);
  assert.ok(recovered.ledger.missing >= 1);
  assert.ok(recovered.ledger.needsReconciliation >= 3);

  // 暂停/继续状态机：执行中暂停，继续回规划；中断不自动变失败。
  tasks.transition(task.taskId, 'paused', { resumeStatus: 'executing' });
  tasks.transition(task.taskId, 'planning', { resumeStatus: undefined });
  tasks.transition(task.taskId, 'interrupted');
  assert.equal(tasks.get(task.taskId).status, 'interrupted');
});

test('摘要失败不阻塞；归档篡改恢复 stale', async () => {
  const task = tasks.create({ prompt: '故障注入', permissionPreset: 'workspace-write' });
  tasks.transition(task.taskId, 'planning');
  tasks.transition(task.taskId, 'plan_ready');
  tasks.transition(task.taskId, 'awaiting_approval');
  tasks.transition(task.taskId, 'executing');
  const owner = taskContextOwner(tasks.get(task.taskId));

  const failing = new DefaultContextManager({
    compaction: {
      triggerAfter: 5,
      retainRecent: 2,
      summarize: async () => { throw new Error('摘要模型不可用'); },
      commit: async () => { throw new Error('不应提交'); }
    }
  });
  const failed = await failing.prepare({
    owner,
    runId: owner.runId,
    question: '故障',
    context: [],
    system: [],
    history: historyOf(12),
    evidenceRefs: [],
    providerId: 'cloud',
    modelId: 'm'
  });
  assert.equal(failed.context.compactionStatus, 'failed');
  assert.equal(failed.contextLines.filter(line => line.includes('历史')).length, 12);

  // 重新提交一个有效检查点，然后篡改归档。
  const cpStore = new ContextCheckpointStore({ baseDir: path.join(dir, 'checkpoints-2') });
  const archive = new ContextArchiveStore(path.join(dir, 'checkpoints-2'));
  const sourceEvents = historyOf(6);
  const checkpoint = {
    contractVersion: 1,
    checkpointId: 'cp-tamper',
    owner,
    taskId: task.taskId,
    runId: owner.runId,
    contextId: 'ctx-tamper',
    sourceStartSeq: 0,
    sourceEndSeq: sourceEvents.length,
    sourceEventIds: sourceEvents.map(item => item.eventId),
    summary,
    summaryHash: hashContextSummary(summary),
    retainedEventIds: [],
    evidenceRefs: [],
    modelId: 'm',
    inputTokensBefore: 10,
    inputTokensAfter: 2,
    status: 'prepared',
    createdAt: Date.now()
  };
  await commitContextCheckpoint({
    owner,
    runId: owner.runId,
    contextId: 'ctx-tamper',
    checkpoint,
    sourceEvents
  }, { store: cpStore, archive, journal: store });

  const stored = await cpStore.find(owner, 'cp-tamper');
  fs.appendFileSync(path.join(dir, 'checkpoints-2', stored.archiveRef), '\n{"tampered":true}', 'utf8');
  const stale = await recoverTaskContext(tasks.get(task.taskId), [], { store: cpStore, archive });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.summary, undefined);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
