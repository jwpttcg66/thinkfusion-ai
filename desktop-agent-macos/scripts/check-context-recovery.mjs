/**
 * 任务恢复与副作用核对（LT-P5-03/04）。
 *
 * 只验证已实现的语义：
 * - 报告记录的改动路径存在 → applied；
 * - 缺失 → missing；
 * - 没有路径的写操作 → needs_reconciliation；
 * - Journal/归档有效 → recovered；归档被篡改 → stale，不返回半可用摘要；
 * - 指针来源分两档（M2-1）：任务字段（Journal 事务写的权威指针）优先，
 *   字段缺时才按事件流最后一条检查点事件重建，且重建结果同样要过校验。
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
        stepId: 's-read',
        tool: 'fs.readFile',
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
  assert.ok(!entries.some(item => item.tool === 'fs.readFile'), '只读工具不进入副作用账本');
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

async function writeCheckpoint(dir, sourceEvents, summary, evidenceRefs = []) {
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
    evidenceRefs,
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
    // 指针落在任务字段上时优先读字段，不走重放。
    assert.equal(result.pointerSource, 'task-fields');
    assert.equal(result.summary.goal, '完成任务');
    assert.ok(result.ledger);

    const text = recoveryPromptData(result);
    assert.match(text, /模型生成的摘要，不是执行事实/);
    assert.match(text, /副作用核对/);
    assert.doesNotMatch(text, /指针来源/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M2-1：任务字段没落全时按事件流重建指针，重建后仍要过同一套校验', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-recovery-replay-'));
  try {
    const events = [{ eventId: 'e1' }, { eventId: 'e2' }, { eventId: 'e3' }];
    const { store, archive } = await writeCheckpoint(dir, events, summary);
    const task = {
      taskId: 't1',
      runId: 'r1',
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
    const journal = [{
      type: 'context.checkpoint.paused', at: 2, taskId: 't1', reason: 'pause',
      goalVersion: 1, taskRevision: 1, needsReconciliation: 0,
      contextId: 'ctx-1', checkpointId: 'cp-1', activeRunId: 'r1'
    }];
    const result = await recoverTaskContext(task, [report()], {
      store, archive, eventsForTask: () => journal
    });
    assert.equal(result.status, 'recovered');
    assert.equal(result.pointerSource, 'events-replay');
    assert.equal(result.checkpointId, 'cp-1');
    assert.equal(result.contextId, 'ctx-1');
    // 来源要能写进提示：重放出来的指针可信度低于落库指针。
    assert.match(recoveryPromptData(result), /指针来源/);

    // 事件里的指针指向不存在的检查点：仍然要判 stale，不能因为「重建出来了」就放行。
    const ghost = await recoverTaskContext(task, [], {
      store, archive,
      eventsForTask: () => [{ ...journal[0], checkpointId: 'cp-missing' }]
    });
    assert.equal(ghost.status, 'stale');
    assert.equal(ghost.pointerSource, 'events-replay');
    assert.equal(ghost.summary, undefined);

    // 没有事件可重放：如实 none，不去猜一个 checkpointId。
    const blind = await recoverTaskContext(task, [], { store, archive });
    assert.equal(blind.status, 'none');
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

test('长任务开关：环境变量 > 配置文件 > 默认关闭', async () => {
  const { resolveContextManagerSwitch } = await import('../out-test/shared/context-manager-setting.js');
  assert.equal(resolveContextManagerSwitch({}).enabled, false);
  assert.equal(resolveContextManagerSwitch({ env: 'active' }).enabled, true);
  assert.equal(resolveContextManagerSwitch({ env: 'off', config: { enabled: true } }).enabled, false);
  assert.equal(resolveContextManagerSwitch({ config: { enabled: true } }).source, 'config');
  assert.equal(resolveContextManagerSwitch({ config: { enabled: 'yes' } }).enabled, false);
});

test('检查点有效但 ECO 过期：标 needs_context_refresh，摘要可读但不许沿用旧上下文', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-recovery-eco-'));
  try {
    const events = [{ eventId: 'e1' }, { eventId: 'e2' }, { eventId: 'e3' }];
    const { store, archive } = await writeCheckpoint(
      dir,
      events,
      summary,
      ['eco-context:eco:t1:planning:1:v2:sufficient']
    );
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
    // 事件流里没有可用的 eco.context.prepared → 上下文无法兼容
    const result = await recoverTaskContext(task, [], {
      store,
      archive,
      eventsForTask: () => []
    });
    assert.equal(result.status, 'needs_context_refresh');
    assert.equal(result.eco?.ok, false);
    assert.equal(result.summary.goal, '完成任务');
    assert.match(recoveryPromptData(result), /工程上下文已过期/);
    assert.match(recoveryPromptData(result), /不得沿用旧上下文/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ECO 版本兼容：仍是 recovered，并记下核对结论', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-recovery-eco-ok-'));
  try {
    const events = [{ eventId: 'e1' }, { eventId: 'e2' }, { eventId: 'e3' }];
    const { store, archive } = await writeCheckpoint(
      dir,
      events,
      summary,
      ['eco-context:eco:t1:planning:1:v1:sufficient']
    );
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
    const result = await recoverTaskContext(task, [], {
      store,
      archive,
      eventsForTask: () => [{
        type: 'eco.context.prepared',
        at: 5,
        taskId: 't1',
        package: {
          contextPackageId: 'eco:t1:planning:1',
          contextVersion: 2,
          workId: 't1',
          stage: 'planning',
          role: 'architect',
          architectureSummary: 'x',
          resources: [],
          constraints: [],
          decisions: [],
          verifiedFacts: [],
          inferences: [],
          unknowns: [],
          missingCritical: [],
          sufficiency: 'sufficient',
          createdAt: 5
        }
      }]
    });
    assert.equal(result.status, 'recovered');
    assert.equal(result.eco?.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-05：检查点基于旧目标 → needs_replan，并返回钉住的 ECO 引用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-recovery-goal-'));
  try {
    const events = [{ eventId: 'e1' }, { eventId: 'e2' }, { eventId: 'e3' }];
    const { store, archive } = await writeCheckpoint(
      dir,
      events,
      summary,
      ['eco-context:eco:t1:planning:1:v2:sufficient:g1']
    );
    const task = {
      taskId: 't1',
      runId: 'r1',
      contextId: 'ctx-1',
      checkpointId: 'cp-1',
      activeRunId: 'r1',
      workspaceRoot: '/workspace',
      goalId: 'goal:t1',
      goalVersion: 2,
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
    const result = await recoverTaskContext(task, [], { store, archive, eventsForTask: () => [] });
    assert.equal(result.status, 'needs_replan');
    assert.equal(result.goal?.ok, false);
    assert.match(result.goal.reason, /v1.*v2/);
    assert.equal(result.ecoRef.goalVersion, 1);
    assert.equal(result.ecoRef.contextVersion, 2);
    const text = recoveryPromptData(result);
    assert.match(text, /目标已变化/);
    assert.match(text, /不得沿用旧分解/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-05：目标版本一致时仍按 ECO 兼容性判定，不被误判成重规划', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-recovery-same-goal-'));
  try {
    const events = [{ eventId: 'e1' }, { eventId: 'e2' }, { eventId: 'e3' }];
    const { store, archive } = await writeCheckpoint(
      dir,
      events,
      summary,
      ['eco-context:eco:t1:planning:1:v2:sufficient:g2']
    );
    const task = {
      taskId: 't1',
      runId: 'r1',
      contextId: 'ctx-1',
      checkpointId: 'cp-1',
      activeRunId: 'r1',
      workspaceRoot: '/workspace',
      goalId: 'goal:t1',
      goalVersion: 2,
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
    const result = await recoverTaskContext(task, [], { store, archive, eventsForTask: () => [] });
    // 目标没变，但事件流里没有可用上下文包 → 仍是 needs_context_refresh，而不是 replan。
    assert.equal(result.status, 'needs_context_refresh');
    assert.equal(result.ecoRef.goalVersion, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
