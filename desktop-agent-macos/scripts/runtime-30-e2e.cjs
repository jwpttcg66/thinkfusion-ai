/**
 * 30 步真实 Runtime 故障注入（LT-P6-04 真机部分）。
 *
 * 用 Electron 主进程启动真实 UtilityProcess Runtime：
 * - 计划 1：28 次真实写文件 + 1 次真实读文件 + 1 次读不存在文件；
 * - 计划 2：30 次真实写文件，全部成功；
 * - 再用真实执行报告跑一次副作用核对。
 *
 * 运行：
 *   npm run build:test
 *   ./node_modules/.bin/electron scripts/runtime-30-e2e.cjs
 */
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const here = __dirname;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-runtime-30-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });

function planOf(taskId, roundId, planId, steps) {
  return {
    protocol: 'desktop-agent/v1',
    type: 'plan',
    taskId,
    roundId,
    planId,
    title: '30 步真实 Runtime 验收',
    description: '按步骤创建文件并读回；最后一步故意失败，用于验证报告与副作用核对。',
    kind: 'implementation',
    steps,
    completion: { condition: '报告能逐步骤归属，真实文件与失败步骤都能核对' }
  };
}

function grantOf(taskId) {
  return {
    taskId,
    permissionPreset: 'workspace-write',
    approvalPolicy: 'ask',
    rootDir: workspace,
    allowedTools: ['fs.writeFile', 'fs.readFile'],
    expiresAt: Date.now() + 10 * 60 * 1000,
    maxSteps: 30,
    stepApproval: 'off'
  };
}

const failureSteps = [];
for (let index = 1; index <= 28; index += 1) {
  failureSteps.push({
    id: `write-${index}`,
    tool: 'fs.writeFile',
    args: { path: `step-${String(index).padStart(2, '0')}.txt`, content: `step ${index}` },
    description: `创建第 ${index} 个文件`
  });
}
failureSteps.push({
  id: 'read-back',
  tool: 'fs.readFile',
  args: { path: 'step-28.txt' },
  description: '读回最后一个成功写入的文件'
});
failureSteps.push({
  id: 'missing-read',
  tool: 'fs.readFile',
  args: { path: 'does-not-exist.txt' },
  description: '读取不存在的文件，注入失败'
});

const successSteps = Array.from({ length: 30 }, (_, index) => ({
  id: `ok-${index + 1}`,
  tool: 'fs.writeFile',
  args: { path: `ok-${String(index + 1).padStart(2, '0')}.txt`, content: `ok ${index + 1}` },
  description: `创建成功文件 ${index + 1}`
}));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const { runPlan } = require(path.join(here, '../out-test/main/agent-manager.js'));
    const { recoverTaskContext } = require(path.join(here, '../out-test/main/context/recovery/task-recovery.js'));

    const failureTaskId = 'runtime-30-failure';
    const failure = await runPlan(
      planOf(failureTaskId, 'round-failure', 'plan-failure', failureSteps),
      grantOf(failureTaskId),
      path.join(root, 'failure-journal.db'),
      5 * 60 * 1000,
      { roundId: 'round-failure', planId: 'plan-failure' }
    );

    const successTaskId = 'runtime-30-success';
    const success = await runPlan(
      planOf(successTaskId, 'round-success', 'plan-success', successSteps),
      grantOf(successTaskId),
      path.join(root, 'success-journal.db'),
      5 * 60 * 1000,
      { roundId: 'round-success', planId: 'plan-success' }
    );

    const written = fs.readdirSync(workspace).filter(name => name.endsWith('.txt')).length;
    const sample = fs.readFileSync(path.join(workspace, 'step-28.txt'), 'utf8');
    const okSample = fs.readFileSync(path.join(workspace, 'ok-30.txt'), 'utf8');

    const recovered = await recoverTaskContext({
      taskId: failureTaskId,
      title: '30 步真实 Runtime 验收',
      userPrompt: '30 步',
      status: 'interrupted',
      permissionPreset: 'workspace-write',
      workspaceRoot: workspace,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxRounds: 20,
      maxSteps: 30,
      timeoutMs: 1000
    }, [failure, success], {
      store: { find: async () => null },
      archive: { verify: async () => false }
    });

    const result = {
      failure: {
        status: failure.status,
        results: failure.results.length,
        completed: failure.results.filter(item => item.status === 'completed').length,
        failed: failure.results.filter(item => item.status === 'failed').length,
        errorCode: failure.errors[0]?.code,
        failedStep: failure.errors[0]?.stepId
      },
      success: {
        status: success.status,
        results: success.results.length,
        completed: success.results.filter(item => item.status === 'completed').length,
        failed: success.results.filter(item => item.status === 'failed').length
      },
      files: { written, sample, okSample },
      recovery: {
        status: recovered.status,
        applied: recovered.ledger.applied,
        missing: recovered.ledger.missing,
        needsReconciliation: recovered.ledger.needsReconciliation
      }
    };
    console.log(`RUNTIME_30_RESULT=${JSON.stringify(result)}`);
    const pass = failure.status === 'partial'
      && failure.results.length === 30
      && failure.results.filter(item => item.status === 'completed').length === 29
      && failure.results.filter(item => item.status === 'failed').length === 1
      && success.status === 'completed'
      && success.results.filter(item => item.status === 'completed').length === 30
      && written === 58
      && sample === 'step 28'
      && okSample === 'ok 30'
      && recovered.ledger.applied >= 50;
    app.exit(pass ? 0 : 1);
  } catch (error) {
    console.error('RUNTIME_30_ERROR', error && error.stack ? error.stack : error);
    app.exit(2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
