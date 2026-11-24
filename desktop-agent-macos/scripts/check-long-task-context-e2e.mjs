/**
 * 长任务上下文回归（组件级 E2E）。
 *
 * 30 条历史 + 工具裁剪 + 摘要 + 检查点提交/恢复/stale。
 * 不调用真实模型；真实应用验证由 context.prepared 真机会话承担。
 *
 * Run with: npm run test:long-task-context-e2e
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildContext } from '../out-test/main/context/builder.js';
import { pruneToolHistory } from '../out-test/main/context/compaction/pruner.js';
import { toToolHistory } from '../out-test/main/context/adapters/tool-history.js';
import { validateContextSummary, hashContextSummary } from '../out-test/main/context/compaction/summary.js';
import { ContextCheckpointStore } from '../out-test/main/context/checkpoint/store.js';
import { ContextArchiveStore } from '../out-test/main/context/checkpoint/archive.js';
import { commitContextCheckpoint, recoverContext } from '../out-test/main/context/checkpoint/commit.js';

const owner = { ownerType: 'agent-task', ownerId: 't1', taskId: 't1', runId: 'r1' };

test('30 条历史：裁剪、摘要、检查点、恢复、stale 全链路', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-long-context-'));
  try {
    const history = Array.from({ length: 30 }, (_, index) => ({
      eventId: `e${index + 1}`,
      kind: index % 5 === 0 ? 'tool' : 'message',
      role: index % 5 === 0 ? undefined : (index % 2 === 0 ? 'user' : 'assistant'),
      text: index === 4 ? 'x'.repeat(8_000) : `历史 ${index + 1}`,
      at: index
    }));
    const built = buildContext({
      owner, runId: 'r1', question: '原话', context: [], system: ['S'], history,
      evidenceRefs: ['ev-1'], providerId: 'p', modelId: 'm'
    });
    assert.equal(built.question, '原话');
    assert.equal(built.includedEventIds.length, 30);

    const toolEntries = toToolHistory([
      { type: 'step.started', at: 1, taskId: 't1', stepId: 's1', tool: 'shell.run', args: { command: 'mvn test' } },
      { type: 'step.completed', at: 2, taskId: 't1', stepId: 's1', tool: 'shell.run', result: { stdout: 'y'.repeat(20_000) } }
    ]);
    const pruned = pruneToolHistory(toolEntries, { maxResultChars: 500 });
    assert.equal(pruned[0].pruned, true);

    const summary = {
      goal: '原话',
      constraints: [],
      completed: [{ text: '完成 30 条历史', certainty: 'verified', eventIds: ['e1', 'e30'] }],
      decisions: [{ text: '保留检查点', status: 'active', eventIds: ['e2'] }],
      evidence: [{ ref: 'ev-1', kind: 'test', eventIds: ['e3'] }],
      openIssues: [],
      currentStep: null,
      nextActions: [],
      risks: [],
      stopConditions: []
    };
    const validation = validateContextSummary(summary, {
      eventIds: new Set(history.map(item => item.eventId)),
      evidenceRefs: new Set(['ev-1'])
    });
    assert.equal(validation.ok, true);

    const store = new ContextCheckpointStore({ baseDir: dir, now: () => 3 });
    const archive = new ContextArchiveStore(dir);
    const calls = [];
    const journal = { commitContextCheckpoint: input => calls.push(input) };
    const checkpoint = {
      contractVersion: 1,
      checkpointId: 'cp-long',
      owner,
      taskId: 't1',
      runId: 'r1',
      contextId: built.contextId,
      sourceStartSeq: 1,
      sourceEndSeq: 30,
      sourceEventIds: history.map(item => item.eventId),
      summary,
      summaryHash: hashContextSummary(summary),
      retainedEventIds: history.slice(-6).map(item => item.eventId),
      evidenceRefs: ['ev-1'],
      modelId: 'm',
      inputTokensBefore: 20_000,
      inputTokensAfter: 4_000,
      status: 'prepared',
      createdAt: 3
    };
    await commitContextCheckpoint({
      owner, runId: 'r1', contextId: built.contextId, checkpoint,
      sourceEvents: history
    }, { store, archive, journal });
    assert.equal(calls.length, 1);

    const recovered = await recoverContext({
      owner, runId: 'r1',
      pointer: { contextId: built.contextId, checkpointId: 'cp-long', activeRunId: 'r1' }
    }, { store, archive });
    assert.ok(recovered);
    assert.equal(recovered.compactionStatus, 'committed');
    assert.equal(recovered.retainedEventIds.length, 6);

    const archiveRef = calls[0] ? (await store.find(owner, 'cp-long'))?.archiveRef : null;
    assert.ok(archiveRef);
    fs.appendFileSync(path.join(dir, archiveRef), '\n{"tampered":true}', 'utf8');
    await assert.rejects(
      () => recoverContext({
        owner, runId: 'r1',
        pointer: { contextId: built.contextId, checkpointId: 'cp-long', activeRunId: 'r1' }
      }, { store, archive })
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
