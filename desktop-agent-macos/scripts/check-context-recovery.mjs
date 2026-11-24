/**
 * 任务恢复与副作用核对（LT-P5-03/04）。
 *
 * 只验证已实现的语义：
 * - 报告记录的改动路径存在 → applied；
 * - 缺失 → missing；
 * - 没有路径的写操作 → needs_reconciliation；
 * - Journal/归档有效 → recovered；归档被篡改 → stale，不返回半可用摘要。
 *
 * Run with: npm run test:context-recovery
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectSideEffects,
  reconcileSideEffects
} from '../out-test/main/context/recovery/side-effects.js';
import {
  recoverTaskContext,
  recoveryPromptData
} from '../out-test/main/context/recovery/task-recovery.js';
import { ContextCheckpointStore } from '../out-test/main/context/checkpoint/store.js';
import { ContextArchiveStore } from '../out-test/main/context/checkpoint/archive.js';
import { commitContextCheckpoint } from '../out-test/main/context/checkpoint/commit.js';
import { hashContextSummary } from '../out-test/main/context/compaction/summary.js';

const owner = { ownerType: 'agent-task', ownerId: 't1', taskId: 't1', runId: 'r1' };

function report(overrides = {}) {
  return {
    protocol: 'desktop-agent/v1',
    type: 'execution_report',
    taskId: 't1',
    roundId: 'round-1',
    planId: 'plan-1',
    status: 'completed',
    errors: [],
    nextAction: 'complete',
    createdAt: 1,
    results: [
      {
        stepId: 's1',
        tool: 'fs.writeFile',
        status: 'completed',
        verified: true,
        durationMs: 1,
        args: { path: 'src/a.ts' }
      },
      {
        stepId: 's2',
        tool: 'shell.run',
        status: 'completed',
        verified: true,
        durationMs: 1,
        args: { command: 'mvn test' }
      }
    ],
    verification: {
      verified: true,
      reasons: [],
      changedFiles: 1,
      changedPaths: ['src/a.ts', 'src/gone.ts']
    },
    ...overrides
  };
}

test('副作用核对：存在=applied，缺失=missing，无路径=needs_reconciliation', async () => {
  const entries = collectSideEffects([report()]);
  assert.ok(entries.some(item => item.tool === 'fs.writeFile' && item.paths.includes('src/a.ts')));
  assert.ok(entries.some(item => item.tool === 'shell.run' && item.paths.length === 0));

  const ledger = await reconcileSideEffects(entries, {
    workspaceRoot: '/workspace',
    exists: async absolute => absolute === '/workspace/src/a.ts'
  });
  assert.equal(ledger.applied, 1);
  assert.equal(ledger.missing, 1);
  assert.ok(ledger.needsReconciliation >= 1);
  assert.equal(ledger.applied + ledger.missing + ledger.needsReconciliation, ledger.entries.length);
});

async function writeCheckpoint(dir, sourceEvents, summary) {
  const store = new ContextCheckpointStore({ baseDir: dir, now: () => 3 });
  const archive = new ContextArchiveStore(dir);
  const checkpoint = {
    contractVersion: 1,
    checkpointId: 'cp-1',
    owner,
    taskId: 't1',
    runId: 'r1',
    contextId: 'ctx-1',
    sourceStartSeq: 0,
    sourceEndSeq: sourceEvents.length,
    sourceEventIds: sourceEvents.map(item => item.eventId),
    summary,
    summaryHash: hashContextSummary(summary),
    retainedEventIds: ['e3'],
    evidenceRefs: [],
    modelId: 'm',
    inputTokensBefore: 100,
    inputTokensAfter: 20,
    status: 'prepared',
    createdAt: 3
  };
  await commitContextCheckpoint({
    owner,
    runId: 'r1',
    contextId: 'ctx-1',
    checkpoint,
    sourceEvents
  }, { store, archive, journal: { commitContextCheckpoint: () => {} } });
  return { store, archive, checkpoint };
}

const summary = {
  goal: '完成任务',
  constraints: [],
  completed: [{ text: '写入 a.ts', certainty: 'verified', eventIds: ['e1'] }],
  decisions: [],
  evidence: [],
  openIssues: [],
  currentStep: null,
  nextActions: [],
  risks: [],
  stopConditions: []
};

test('检查点恢复：有效指针返回 recovered，摘要只作为数据', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-recovery-'));
  try {
    const events = [{ eventId: 'e1' }, { eventId: 'e2' }, { eventId: 'e3' }];
    const { store, archive } = await writeCheckpoint(dir, events, summary);
    const task = {
      taskId: 't1',
      runId: 'r1',
      contextId: 'ctx-1',
      checkpointId: 'cp-1',
      activeRunId: 'r1',
      workspaceRoot: '/workspace',
      title: 't',
      userPrompt: 'p',
      status: 'interrupted',
      permissionPreset: 'workspace-write',
      createdAt: 1,
      updatedAt: 1,
      maxRounds: 20,
      maxSteps: 30,
      timeoutMs: 1000
    };
    const result = await recoverTaskContext(task, [report()], { store, archive });
    assert.equal(result.status, 'recovered');
    assert.equal(result.checkpointId, 'cp-1');
    assert.equal(result.summary.goal, '完成任务');
    assert.ok(result.ledger);

    const text = recoveryPromptData(result);
    assert.match(text, /模型生成的摘要，不是执行事实/);
    assert.match(text, /副作用核对/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('归档被篡改：stale，不返回半可用摘要', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-recovery-stale-'));
  try {
    const events = [{ eventId: 'e1' }, { eventId: 'e2' }];
    const { store, archive } = await writeCheckpoint(dir, events, summary);
    const stored = await store.find(owner, 'cp-1');
    fs.appendFileSync(path.join(dir, stored.archiveRef), '\n{"tampered":true}', 'utf8');
    const task = {
      taskId: 't1',
      runId: 'r1',
      contextId: 'ctx-1',
      checkpointId: 'cp-1',
      activeRunId: 'r1',
      title: 't',
      userPrompt: 'p',
      status: 'interrupted',
      permissionPreset: 'workspace-write',
      createdAt: 1,
      updatedAt: 1,
      maxRounds: 20,
      maxSteps: 30,
      timeoutMs: 1000
    };
    const result = await recoverTaskContext(task, [], { store, archive });
    assert.equal(result.status, 'stale');
    assert.equal(result.summary, undefined);
    assert.ok(result.reason);
    assert.equal(recoveryPromptData(result), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
