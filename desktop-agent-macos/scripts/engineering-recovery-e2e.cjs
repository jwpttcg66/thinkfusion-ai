/**
 * 工程任务检查点中断恢复（LT-P5-03 真机级集成）。
 *
 * 真实链路：
 *   Electron UtilityProcess Runtime 执行 30 步 → 真实报告与文件
 *   → AgentStore 落库任务/报告
 *   → ContextManager 摘要并提交真实检查点/归档
 *   → 模拟应用退出（TaskManager.reconcileInterrupted）
 *   → 新 Orchestrator.resume 按 Journal 指针恢复
 *
 * 运行：
 *   npm run build:test
 *   ./node_modules/.bin/electron scripts/engineering-recovery-e2e.cjs
 */
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const here = __dirname;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-eng-recovery-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });

function planOf(taskId, roundId, planId) {
  return {
    protocol: 'desktop-agent/v1',
    type: 'plan',
    taskId,
    roundId,
    planId,
    title: '工程检查点恢复验收',
    description: '真实创建 30 个文件，用于产生工程执行历史。',
    kind: 'implementation',
    steps: Array.from({ length: 30 }, (_, index) => ({
      id: `write-${index + 1}`,
      tool: 'fs.writeFile',
      args: { path: `file-${String(index + 1).padStart(2, '0')}.txt`, content: `file ${index + 1}` },
      description: `创建文件 ${index + 1}`
    })),
    completion: { condition: '30 个文件真实存在' }
  };
}

function grantOf(taskId) {
  return {
    taskId,
    permissionPreset: 'workspace-write',
    approvalPolicy: 'ask',
    rootDir: workspace,
    allowedTools: ['fs.writeFile'],
    expiresAt: Date.now() + 10 * 60 * 1000,
    maxSteps: 30,
    stepApproval: 'off'
  };
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const { runPlan } = require(path.join(here, '../out-test/main/agent-manager.js'));
    const { AgentStore } = require(path.join(here, '../out-test/main/store.js'));
    const { TaskManager } = require(path.join(here, '../out-test/main/task-manager.js'));
    const { DefaultContextManager } = require(path.join(here, '../out-test/main/context/manager.js'));
    const { ContextCheckpointStore } = require(path.join(here, '../out-test/main/context/checkpoint/store.js'));
    const { ContextArchiveStore } = require(path.join(here, '../out-test/main/context/checkpoint/archive.js'));
    const { commitContextCheckpoint } = require(path.join(here, '../out-test/main/context/checkpoint/commit.js'));
    const { hashContextSummary } = require(path.join(here, '../out-test/main/context/compaction/summary.js'));
    const { recoverTaskContext } = require(path.join(here, '../out-test/main/context/recovery/task-recovery.js'));
    const { AgentOrchestrator } = require(path.join(here, '../out-test/main/orchestrator.js'));

    const runtimeTaskId = 'eng-recovery-runtime';
    const report = await runPlan(
      planOf(runtimeTaskId, 'round-eng', 'plan-eng'),
      grantOf(runtimeTaskId),
      path.join(root, 'journal.db'),
      5 * 60 * 1000,
      { roundId: 'round-eng', planId: 'plan-eng' }
    );
    if (report.status !== 'completed') throw new Error(`Runtime 未完成：${report.status}`);

    const agentStore = new AgentStore(path.join(root, 'agent-store.json'));
    const events = [];
    const tasks = new TaskManager(agentStore, event => events.push(event));
    const task = tasks.create({
      prompt: '创建 30 个文件并用于检查点恢复',
      permissionPreset: 'workspace-write',
      workspaceRoot: workspace
    });
    tasks.transition(task.taskId, 'planning');
    tasks.transition(task.taskId, 'plan_ready');
    tasks.transition(task.taskId, 'awaiting_approval');
    tasks.transition(task.taskId, 'executing');
    agentStore.insertReport({ ...report, taskId: task.taskId, roundId: 'round-eng', planId: 'plan-eng' });

    const checkpointStore = new ContextCheckpointStore({ baseDir: path.join(root, 'checkpoints') });
    const archive = new ContextArchiveStore(path.join(root, 'checkpoints'));
    const owner = { ownerType: 'agent-task', ownerId: task.taskId, taskId: task.taskId, runId: task.taskId };
    const history = [{
      eventId: `task:${task.taskId}`,
      kind: 'message',
      role: 'user',
      text: task.userPrompt,
      at: task.createdAt
    }];
    for (const [index, result] of report.results.entries()) {
      history.push({
        eventId: `step:round-eng:${result.stepId}`,
        kind: 'tool',
        text: `${result.tool} ${result.status} ${result.args?.path ?? ''}`,
        at: report.createdAt + index,
        roundId: 'round-eng',
        stepId: result.stepId,
        toolCallId: result.stepId
      });
    }
    const summary = {
      goal: '创建 30 个文件',
      constraints: [],
      completed: [{ text: '30 个文件已写入', certainty: 'verified', eventIds: ['step:round-eng:write-30'] }],
      decisions: [],
      evidence: [],
      openIssues: [],
      currentStep: null,
      nextActions: [],
      risks: [],
      stopConditions: []
    };
    const manager = new DefaultContextManager({
      compaction: {
        triggerAfter: 10,
        retainRecent: 5,
        summarize: async input => ({
          summary,
          summaryHash: hashContextSummary(summary),
          sourceEventIds: input.history.map(item => item.eventId),
          modelId: 'acceptance'
        }),
        commit: async input => {
          const checkpointId = 'cp-eng-recovery';
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
          }, { store: checkpointStore, archive, journal: agentStore });
          return { checkpointId, retainedEventIds: input.retainedEventIds, eventPersisted: true };
        }
      }
    });
    await manager.prepare({
      owner,
      taskId: task.taskId,
      runId: owner.runId,
      question: '创建 30 个文件并用于检查点恢复',
      context: [],
      system: [],
      history,
      evidenceRefs: [],
      providerId: 'cloud',
      modelId: 'm'
    });
    const committed = tasks.get(task.taskId);
    if (!committed.checkpointId) throw new Error('压缩后没有提交检查点');

    // 模拟应用退出后重启：在途任务标中断；检查点仍在磁盘。
    tasks.reconcileInterrupted();
    const interrupted = tasks.get(task.taskId);
    if (interrupted.status !== 'interrupted') throw new Error(`重启后状态不是 interrupted：${interrupted.status}`);

    let recovery = null;
    const newEvents = [];
    let sentPrompt = '';
    const adapter = {
      siteLabel: 'acceptance-stub',
      concurrent: true,
      getStatus: async () => ({ pageReady: true }),
      sendMessage: async text => {
        sentPrompt = text;
        return {
          submitted: true,
          snapshotBefore: { messageCount: 0, lastText: '', url: 'stub://', capturedAt: Date.now(), conversationText: '', composerText: '' },
          method: 'stub',
          signals: [],
          waitedMs: 0
        };
      },
      waitForAnswer: () => new Promise(() => {}),
      newConversation: async () => ({ ok: true, method: 'stub' }),
      cancelWait: () => {}
    };
    const orchestrator = new AgentOrchestrator({
      tasks,
      store: agentStore,
      adapter: () => adapter,
      emit: event => { newEvents.push(event); events.push(event); },
      dbPath: () => path.join(root, 'journal.db'),
      contextRecovery: async (current, reports) => recoverTaskContext(current, reports, {
        store: checkpointStore,
        archive
      }),
      onRecovery: (_task, result) => { recovery = result; }
    });

    await orchestrator.resume(task.taskId);
    for (let index = 0; index < 100 && !sentPrompt; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const resumed = tasks.get(task.taskId);
    const round = tasks.listRounds(task.taskId).at(-1);
    await orchestrator.cancel(task.taskId);

    const recoveredEvent = newEvents.find(event =>
      event.type === 'context.event' && event.event === 'context.recovered'
    );
    const result = {
      checkpointId: committed.checkpointId,
      interruptedStatus: interrupted.status,
      resumedStatus: resumed.status,
      recoveredStatus: recovery?.status,
      sideEffects: recovery?.ledger ? {
        applied: recovery.ledger.applied,
        missing: recovery.ledger.missing,
        needsReconciliation: recovery.ledger.needsReconciliation
      } : null,
      recoveredEvent: Boolean(recoveredEvent),
      promptHasCheckpoint: sentPrompt.includes('上次上下文检查点'),
      promptHasSummary: sentPrompt.includes('创建 30 个文件'),
      roundRequestHasCheckpoint: Boolean(round?.requestText?.includes('上次上下文检查点')),
      checkpointFile: fs.existsSync(path.join(root, 'checkpoints')),
      files: fs.readdirSync(workspace).filter(name => name.endsWith('.txt')).length
    };
    console.log(`ENGINEERING_RECOVERY_RESULT=${JSON.stringify(result)}`);
    const pass = result.checkpointId
      && result.interruptedStatus === 'interrupted'
      && result.resumedStatus === 'planning'
      && result.recoveredStatus === 'recovered'
      && result.sideEffects?.applied >= 30
      && result.sideEffects?.missing === 0
      && result.recoveredEvent
      && result.promptHasCheckpoint
      && result.promptHasSummary
      && result.roundRequestHasCheckpoint
      && result.files === 30;
    app.exit(pass ? 0 : 1);
  } catch (error) {
    console.error('ENGINEERING_RECOVERY_ERROR', error && error.stack ? error.stack : error);
    app.exit(2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
