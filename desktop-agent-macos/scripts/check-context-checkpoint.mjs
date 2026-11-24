/**
 * LT-P3 检查点存储/提交/恢复。
 *
 * Run with: npm run test:context-checkpoint
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ContextCheckpointStore } from '../out-test/main/context/checkpoint/store.js';
import { ContextArchiveStore } from '../out-test/main/context/checkpoint/archive.js';
import {
  commitContextCheckpoint,
  recoverContext,
  ContextCheckpointStaleError
} from '../out-test/main/context/checkpoint/commit.js';
import { hashContextSummary } from '../out-test/main/context/compaction/summary.js';
import { AgentStore } from '../out-test/main/store.js';

const owner = { ownerType: 'agent-task', ownerId: 't1', taskId: 't1', runId: 'r1' };
const summary = {
  goal: '完成目标',
  constraints: [],
  completed: [{ text: '完成', certainty: 'verified', eventIds: ['e1'] }],
  decisions: [],
  evidence: [{ ref: 'ev-1', kind: 'test', eventIds: ['e2'] }],
  openIssues: [],
  currentStep: null,
  nextActions: [],
  risks: [],
  stopConditions: []
};

const checkpoint = {
  contractVersion: 1,
  checkpointId: 'cp1',
  owner,
  taskId: 't1',
  runId: 'r1',
  contextId: 'ctx1',
  sourceStartSeq: 1,
  sourceEndSeq: 2,
  sourceEventIds: ['e1', 'e2'],
  summary,
  summaryHash: hashContextSummary(summary),
  retainedEventIds: ['e2'],
  evidenceRefs: ['ev-1'],
  modelId: 'm',
  inputTokensBefore: 100,
  inputTokensAfter: 50,
  status: 'prepared',
  createdAt: 1
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tf-context-cp-'));
}

test('检查点：写文件、归档、Journal 指针一次提交，恢复一致', async () => {
  const dir = tempDir();
  try {
    const store = new ContextCheckpointStore({ baseDir: dir, now: () => 2 });
    const archive = new ContextArchiveStore(dir);
    const calls = [];
    const journal = { commitContextCheckpoint: input => calls.push(input) };
    const committed = await commitContextCheckpoint({
      owner,
      runId: 'r1',
      contextId: 'ctx1',
      checkpoint,
      sourceEvents: [{ eventId: 'e1' }, { eventId: 'e2' }],
      event: { type: 'log', at: 3, taskId: 't1', level: 'info', message: 'committed' }
    }, { store, archive, journal });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].checkpointId, 'cp1');
    assert.equal(calls[0].activeRunId, 'r1');
    assert.ok(committed.archiveRef);
    const recovered = await recoverContext({
      owner,
      runId: 'r1',
      pointer: { contextId: 'ctx1', checkpointId: 'cp1', activeRunId: 'r1' }
    }, { store, archive });
    assert.ok(recovered);
    assert.equal(recovered.checkpointId, 'cp1');
    assert.equal(recovered.compactionStatus, 'committed');
    assert.deepEqual(recovered.includedEventIds, ['e1', 'e2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('检查点：runId 不匹配不恢复；归档被篡改标 stale', async () => {
  const dir = tempDir();
  try {
    const store = new ContextCheckpointStore({ baseDir: dir, now: () => 2 });
    const archive = new ContextArchiveStore(dir);
    const journal = { commitContextCheckpoint: () => undefined };
    const committed = await commitContextCheckpoint({
      owner, runId: 'r1', contextId: 'ctx1', checkpoint, sourceEvents: [{ eventId: 'e1' }]
    }, { store, archive, journal });

    const otherRun = await recoverContext({
      owner, runId: 'r2',
      pointer: { contextId: 'ctx1', checkpointId: 'cp1', activeRunId: 'r1' }
    }, { store, archive });
    assert.equal(otherRun, null);

    const file = path.join(dir, committed.archiveRef);
    fs.appendFileSync(file, '\n{"tampered":true}', 'utf8');
    await assert.rejects(
      () => recoverContext({
        owner, runId: 'r1',
        pointer: { contextId: 'ctx1', checkpointId: 'cp1', activeRunId: 'r1' }
      }, { store, archive }),
      error => error instanceof ContextCheckpointStaleError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AgentStore.commitContextCheckpoint 一次持久化更新指针与事件', () => {
  const dir = tempDir();
  try {
    const store = new AgentStore(path.join(dir, 'agent-store.json'));
    store.upsertTask({
      taskId: 't1', title: 't', userPrompt: 'u', status: 'planning',
      permissionPreset: 'workspace-write', createdAt: 1, updatedAt: 1,
      maxRounds: 20, maxSteps: 30, timeoutMs: 1_000
    });
    store.commitContextCheckpoint({
      owner,
      contextId: 'ctx1',
      checkpointId: 'cp1',
      activeRunId: 'r1',
      event: {
        type: 'context.event', at: 3, taskId: 't1',
        event: 'context.compaction.committed',
        context: { contextId: 'ctx1', checkpointId: 'cp1' }
      }
    });
    const task = store.getTask('t1');
    assert.equal(task?.contextId, 'ctx1');
    assert.equal(task?.checkpointId, 'cp1');
    assert.equal(task?.activeRunId, 'r1');
    assert.equal(store.listEvents('t1').filter(item => item.type === 'context.event').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
