/**
 * 外部 CLI Agent：参数、退出码、超时、取消、改动路径、模型身份、权限门。
 *
 * 用真实子进程（scripts/fixtures/fake-cli.mjs）跑，不 mock spawn；否则最
 * 容易错的地方（argv 拼接、进程组取消、git status 差集）恰好都测不到。
 *
 * Run with: npm run test:cli
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cancelAllCliRuns,
  cancelCliRuns,
  cliAgentConfigError,
  runCliAgent
} from '../out-test/agent/tools/cli-agent.js';
import { assertGrant } from '../out-test/agent/policy.js';
import { riskOf } from '../out-test/agent/step-approval.js';
import { verifyExecution } from '../out-test/agent/verification.js';
import { allowedToolsForPreset } from '../out-test/shared/protocol.js';
import { buildEvidenceLedger } from '../out-test/shared/engineering-evidence.js';
import { ExecutionReportSchema } from '../out-test/shared/schemas.js';
import {
  attachTerminal,
  closeAllTerminals,
  closeTerminal,
  openProgram,
  readSince,
  readTerminal
} from '../out-test/agent/tools/terminal.js';
import {
  cliAgentSnapshot,
  configureCliAgents,
  listCliAgents,
  setCliAgentEnabled
} from '../out-test/main/cli-agents.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'fake-cli.mjs');

const work = mkdtempSync(path.join(tmpdir(), 'tf-cli-'));
const repo = path.join(work, 'repo');
mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: repo });
writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: repo });

let seq = 0;
function config(overrides = {}) {
  return {
    id: 'fake',
    label: 'Fake CLI',
    command: process.execPath,
    args: [FIXTURE, 'ok', '{task}'],
    headless: 'verified',
    enabled: true,
    envAllowlist: [],
    ...overrides
  };
}

function taskId(name) {
  seq += 1;
  return `${name}-${seq}`;
}

function grant(overrides = {}) {
  return {
    taskId: 'task-cli',
    permissionPreset: 'danger-full-access',
    approvalPolicy: 'ask',
    rootDir: repo,
    allowedTools: ['agent.exec'],
    expiresAt: Date.now() + 60_000,
    maxSteps: 10,
    grantVersion: 1,
    ...overrides
  };
}

test.after(() => {
  cancelAllCliRuns();
  closeAllTerminals();
  rmSync(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. 配置门
// ---------------------------------------------------------------------------

test('未实测 / 未启用 / 缺占位符的配置不会被启动', () => {
  assert.match(cliAgentConfigError(undefined), /没有这个 CLI Agent/);
  assert.match(cliAgentConfigError(config({ enabled: false })), /关闭/);
  assert.match(cliAgentConfigError(config({ headless: 'unverified' })), /尚未实测/);
  assert.match(cliAgentConfigError(config({ headless: 'unsupported' })), /不支持非交互/);
  assert.match(cliAgentConfigError(config({ args: ['-p', 'no-placeholder'] })), /\{task\}/);
  assert.equal(cliAgentConfigError(config()), null);
});

// ---------------------------------------------------------------------------
// 2. 真实执行
// ---------------------------------------------------------------------------

test('argv 原样传入：{task} 被替换，任务文本不经过 shell', async () => {
  writeFileSync(path.join(repo, 'argv.json'), '[]');
  const dangerous = 'hello "$(touch should-not-exist)" `echo no`';
  const run = await runCliAgent(
    config({ args: [FIXTURE, 'args', '{task}'], permissionArgs: ['--permission-mode', 'accept_edits'] }),
    { taskId: taskId('argv'), cwd: repo, task: dangerous, timeoutMs: 10_000 }
  );
  assert.equal(run.exitCode, 0);
  const argv = JSON.parse(readFileSync(path.join(repo, 'argv.json'), 'utf8'));
  assert.deepEqual(argv, ['args', dangerous, '--permission-mode', 'accept_edits']);
  // 没有 shell 解释：命令替换没有被执行。
  assert.throws(() => readFileSync(path.join(repo, 'should-not-exist')));
});

test('成功执行：退出码、改动路径、模型身份都来自真实结果', async () => {
  writeFileSync(path.join(repo, 'dirty.txt'), 'before\n');
  const run = await runCliAgent(config(), {
    taskId: taskId('ok'),
    cwd: repo,
    task: 'create a file',
    timeoutMs: 10_000
  });
  assert.equal(run.exitCode, 0);
  assert.equal(run.timedOut, false);
  assert.equal(run.cancelled, false);
  assert.equal(run.text, 'ok');
  assert.equal(run.model.declaredModel, 'fake-model');
  assert.equal(run.model.provider, 'fake-provider');
  assert.deepEqual(run.changedPaths.sort(), ['cli-created.txt', 'dirty.txt']);
  assert.equal(run.sessionId, 'fake-session');
});

test('非零退出码是事实，不是异常', async () => {
  const run = await runCliAgent(config({ args: [FIXTURE, 'fail', '{task}'] }), {
    taskId: taskId('fail'),
    cwd: repo,
    task: 'fail',
    timeoutMs: 10_000
  });
  assert.equal(run.exitCode, 3);
  assert.match(run.stderrTail, /fake failure/);
});

test('超时：进程被终止，timedOut 与 exitCode 分开记录', async () => {
  const started = Date.now();
  const run = await runCliAgent(config({ args: [FIXTURE, 'sleep', '{task}'] }), {
    taskId: taskId('timeout'),
    cwd: repo,
    task: 'sleep',
    timeoutMs: 1200
  });
  assert.equal(run.timedOut, true);
  assert.equal(run.exitCode, null);
  assert.ok(Date.now() - started < 10_000, '超时后不应等满子进程的自然寿命');
});

test('取消：cancelCliRuns 终止正在跑的任务，并标记 cancelled', async () => {
  const id = taskId('cancel');
  const pending = runCliAgent(config({ args: [FIXTURE, 'sleep', '{task}'] }), {
    taskId: id,
    cwd: repo,
    task: 'sleep',
    timeoutMs: 30_000
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(cancelCliRuns(id), true);
  const run = await pending;
  assert.equal(run.cancelled, true);
  assert.equal(run.exitCode, null);
});

test('Qoder 形状的 modelUsage 不被当成模型名；非 JSON 输出退回文本', async () => {
  const noModel = await runCliAgent(config({ args: [FIXTURE, 'model', '{task}'] }), {
    taskId: taskId('model'),
    cwd: repo,
    task: 'x',
    timeoutMs: 10_000
  });
  assert.equal(noModel.model.declaredModel, null);
  assert.equal(noModel.model.provenance, 'unverified');

  const raw = await runCliAgent(config({ args: [FIXTURE, 'raw', '{task}'] }), {
    taskId: taskId('raw'),
    cwd: repo,
    task: 'x',
    timeoutMs: 10_000
  });
  assert.match(raw.text, /plain text answer/);
  assert.equal(raw.model.provenance, 'unverified');
});

// ---------------------------------------------------------------------------
// 3. 权限与验证
// ---------------------------------------------------------------------------

test('workspace-write 不提供 agent.exec，执行前也会被 assertGrant 拒绝', () => {
  assert.equal(allowedToolsForPreset('workspace-write').includes('agent.exec'), false);
  assert.equal(allowedToolsForPreset('danger-full-access').includes('agent.exec'), true);
  assert.equal(allowedToolsForPreset('read-only').includes('agent.exec'), false);
  assert.equal(riskOf('agent.exec'), 'danger');
  assert.throws(() => assertGrant(grant({ permissionPreset: 'workspace-write' }), 'agent.exec', 1), /完全访问/);
  assert.doesNotThrow(() => assertGrant(grant(), 'agent.exec', 1));
});

test('CLI 改了文件但没跑测试：不能算已验证', () => {
  const outcome = verifyExecution([
    {
      stepId: 's1',
      tool: 'agent.exec',
      status: 'completed',
      verified: true,
      result: { exitCode: 0, changedPaths: ['a.ts', 'b.ts'] },
      durationMs: 10
    }
  ]);
  assert.equal(outcome.verified, false);
  assert.equal(outcome.changedFiles, 2);
  assert.deepEqual(outcome.changedPaths, ['a.ts', 'b.ts']);
  assert.ok(outcome.reasons.some(reason => reason.includes('没有独立的测试或诊断')));
});

test('CLI 改了文件 + 独立测试通过：算已验证，且账本里同时有命令与文件', () => {  const steps = [
    {
      stepId: 's1',
      tool: 'agent.exec',
      status: 'completed',
      verified: true,
      result: { exitCode: 0, changedPaths: ['a.ts'] },
      durationMs: 10
    },
    {
      stepId: 's2',
      tool: 'test.run',
      status: 'completed',
      verified: true,
      result: { exitCode: 0, stdout: '' },
      args: { command: 'npm test' },
      durationMs: 10
    }
  ];
  const outcome = verifyExecution(steps);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.checks.tests.status, 'passed');

  const ledger = buildEvidenceLedger(
    steps.map(step => ({ tool: step.tool, status: step.status, result: step.result, args: step.args }))
  );
  assert.ok(ledger.refs.some(ref => ref.kind === 'command' && ref.command === 'agent.exec'));
  assert.ok(ledger.refs.some(ref => ref.kind === 'file' && ref.path === 'a.ts'));
});

test('执行报告带 agent.exec 的结构化结果与 args 时，仍能通过 schema 校验', () => {  const parsed = ExecutionReportSchema.safeParse({
    protocol: 'desktop-agent/v1',
    type: 'execution_report',
    taskId: 'task-1',
    roundId: 'round-1',
    planId: 'plan-1',
    status: 'completed',
    results: [
      {
        stepId: 's1',
        tool: 'agent.exec',
        status: 'completed',
        verified: true,
        args: { cli: 'qoder', task: 'do it' },
        result: { exitCode: 0, changedPaths: ['a.ts'], model: { declaredModel: null } },
        durationMs: 12
      }
    ],
    errors: [],
    nextAction: 'continue',
    createdAt: Date.now()
  });
  assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
});

// ---------------------------------------------------------------------------
// 4. 注册表
// ---------------------------------------------------------------------------

test('注册表：两个默认 CLI、开关落盘、版本随能力一起给出', () => {
  const userData = path.join(work, 'userdata');
  configureCliAgents({ userDataDir: userData });
  const initial = listCliAgents();
  assert.deepEqual(initial.map(item => item.id), ['qoder', 'claude']);
  for (const item of initial) {
    assert.equal(item.headless, 'verified');
    assert.ok(item.version === null || typeof item.version === 'string');
  }
  const off = setCliAgentEnabled({ id: 'qoder', enabled: false });
  const qoder = off.find(item => item.id === 'qoder');
  assert.equal(qoder.enabled, false);
  assert.equal(qoder.available, false);
  assert.match(qoder.reason, /关闭/);

  // 重新加载：开关必须落盘，而不是只活在内存里。
  configureCliAgents({ userDataDir: userData });
  assert.equal(listCliAgents().find(item => item.id === 'qoder').enabled, false);
  const snapshot = cliAgentSnapshot().find(item => item.id === 'qoder');
  assert.equal(snapshot.enabled, false);
});

// ---------------------------------------------------------------------------
// 5. TerminalHost：多读者与程序直启
// ---------------------------------------------------------------------------

test('TerminalHost：模型与界面各读各的，互不偷输出', async t => {
  let view;
  try {
    view = openProgram({
      file: process.execPath,
      args: [FIXTURE, 'stream'],
      cwd: repo
    });
  } catch (error) {
    t.skip(`node-pty 不可用：${error.message}`);
    return;
  }
  await new Promise(resolve => setTimeout(resolve, 350));

  const attached = attachTerminal(view.sessionId);
  assert.match(attached.backlog, /line-one/);
  assert.ok(attached.cursor > 0);

  // 模型读走它看到的部分……
  const model = readTerminal(view.sessionId, 1000);
  assert.match(model.output, /line-one/);

  // ……界面从 0 开始仍然能读到，多读者不是共享一个 cursor。
  const ui = readSince(view.sessionId, 0, 1000);
  assert.match(ui.chunk, /line-one/);

  closeTerminal(view.sessionId);
  assert.throws(() => attachTerminal(view.sessionId), /没有这个终端会话/);
});

// ---------------------------------------------------------------------------
// 6. 插件接线：agent.exec 走的是 localCapabilities，不是旁路
// ---------------------------------------------------------------------------

test('agent.exec 插件：按配置启动、返回结构化结果、缺配置时明确拒绝', async () => {
  const { localCapabilities } = await import('../out-test/agent/local-plugins.js');
  const outcome = await localCapabilities.execute(
    'agent.exec',
    { cli: 'fake', task: 'from-plugin' },
    { grant: grant(), cliAgents: [config()] }
  );
  assert.equal(outcome.failure, null);
  assert.equal(outcome.result.exitCode, 0);
  assert.ok(outcome.result.changedPaths.includes('cli-created.txt'));

  await assert.rejects(
    () =>
      localCapabilities.execute(
        'agent.exec',
        { cli: 'missing', task: 'x' },
        { grant: grant(), cliAgents: [config()] }
      ),
    /没有这个 CLI Agent 配置/
  );
});

// ---------------------------------------------------------------------------
// 7. 独立工作树：CLI 只在授权的那棵树里跑
// ---------------------------------------------------------------------------

test('有独立工作树时，agent.exec 在树内执行；cwd 越界被拒绝', async () => {
  const { localCapabilities } = await import('../out-test/agent/local-plugins.js');
  const { configureTaskWorktrees, ensureTaskWorktree } = await import('../out-test/main/task-worktree.js');

  const fresh = path.join(work, 'repo-wt');
  mkdirSync(fresh, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: fresh });
  writeFileSync(path.join(fresh, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '.'], { cwd: fresh });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: fresh });

  configureTaskWorktrees({ root: path.join(work, 'worktrees-test') });
  const tree = await ensureTaskWorktree({ rootDir: fresh, taskId: 'plugin-wt' });

  const outcome = await localCapabilities.execute(
    'agent.exec',
    { cli: 'fake', task: 'in-worktree' },
    { grant: grant({ rootDir: fresh, worktreeDir: tree.dir }), cliAgents: [config()] }
  );
  assert.equal(outcome.failure, null);
  assert.equal(outcome.result.cwd, tree.dir);
  assert.ok(outcome.result.changedPaths.includes('cli-created.txt'));
  assert.equal(existsSync(path.join(fresh, 'cli-created.txt')), false, '主工作区不应被直接修改');

  await assert.rejects(
    () =>
      localCapabilities.execute(
        'agent.exec',
        { cli: 'fake', task: 'escape', cwd: '..' },
        { grant: grant({ rootDir: fresh, worktreeDir: tree.dir }), cliAgents: [config()] }
      ),
    /越过外部 Agent 的独立工作树/
  );
});
