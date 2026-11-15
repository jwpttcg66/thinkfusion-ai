#!/usr/bin/env node
/**
 * 真实 CLI 端到端验证（opt-in）。
 *
 * 用法：
 *   node scripts/spikes/cli-real-e2e.mjs                 # dry-run：只检测可执行文件与版本
 *   node scripts/spikes/cli-real-e2e.mjs --run --all    # 真的跑两组 CLI（消耗云端额度）
 *   node scripts/spikes/cli-real-e2e.mjs --run --qoder  # 只跑 Qoder
 *
 * 不传 --run 绝不联网。这是刻意设计：普通 CI / 全量 npm test 不能因为开发机
 * 没装 CLI 或没登录就失败。Fake CLI 的高频测试仍然是 scripts/check-cli-agent.mjs。
 *
 * 验证项（对应 CLI_AGENTS.md §5 与审核报告 P1）：
 *   1. detect      可执行文件 + --version
 *   2. headless    最小任务返回结构化成功结果
 *   3. write-file  权限模式下能真的改文件（临时 git 仓库）
 *   4. cancel      长任务被进程组终止后没有残留子进程
 *   5. concurrent  两个 CLI 同时跑都能完成
 *   6. audit       本轮结果写成 JSON 报告，可贴进 Spike Report
 *
 * 结果有三种状态，不许互相伪装：
 *   PASS    真的跑过、真的满足判定；
 *   FAIL    真的跑过、真的不满足；
 *   BLOCKED 前置条件不具备（额度/鉴权/CLI 提前退出），本轮**没验证到**。
 * BLOCKED 不算通过，退出码依然非 0，但也不写成产品缺陷。
 *
 * 报告写到系统临时目录，不往仓库里塞产物。
 */

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const AGENTS = [
  {
    id: 'qoder',
    label: 'Qoder CLI',
    command: process.env.QODER_BIN ?? path.join(HOME, '.qoder', 'entry', 'qoder'),
    args: ['-p', '{task}', '--output-format', 'json'],
    permissionArgs: ['--permission-mode', 'accept_edits']
  },
  {
    id: 'claude',
    label: 'Claude Code',
    command: process.env.CLAUDE_BIN ?? '/opt/homebrew/bin/claude',
    args: ['-p', '{task}', '--output-format', 'json'],
    permissionArgs: ['--permission-mode', 'acceptEdits']
  }
];

const argv = new Set(process.argv.slice(2));
const RUN = argv.has('--run');
const ALL = argv.has('--all') || (!argv.has('--qoder') && !argv.has('--claude'));
const SELECTED = AGENTS.filter(agent => ALL || argv.has(`--${agent.id}`));
const TASK_TIMEOUT_MS = 120_000;
const TAIL_LIMIT = 2 * 1024 * 1024;

/**
 * 与 src/shared/cli-result.ts 同口径：先试整段，再倒序找最后一个完整 JSON 行。
 * Qoder 1.1.89 会在 JSON 前打一行自定义命令重命名警告，整段 JSON.parse 会把
 * exit 0 / result 正常的成功任务误判为失败（2026-11-15 真机抓到）。
 * 这里是 .mjs 脚本，不依赖 tsc 产物，所以保留一份同口径实现。
 */
function parseStructured(stdout) {
  const whole = stdout.trim();
  const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (whole) {
    try {
      const value = JSON.parse(whole);
      if (isObject(value)) return value;
    } catch {
      /* 前面有警告行 / 后面有诊断行，按行找。 */
    }
  }
  for (const line of whole.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const value = JSON.parse(trimmed);
      if (isObject(value)) return value;
    } catch {
      continue;
    }
  }
  return null;
}

function isStructuredSuccess(parsed) {
  if (!parsed || parsed.is_error === true) return false;
  return typeof parsed.result === 'string' && parsed.result.trim().length > 0;
}

// 供自动化测试做口径对齐检查：脚本被 import 时不跑 main，也不会联网。
export { parseStructured, isStructuredSuccess, environmentalBlocker };

/** 环境性阻断：额度、鉴权、网络。是「本轮测不了」，不是「代码错了」。 */
function environmentalBlocker(text) {
  const sample = String(text ?? '').slice(0, 8000);
  const rules = [
    // 不写裸 429 / 401：CLI 的 JSON 里到处是数字，会被 duration_ms 之类误命中。
    [/usage limit reached|quota exceeded|Request rejected \(429\)|HTTP 429|rate.?limit/i, '云端额度/限流已耗尽或触发限流'],
    [/unauthorized|authentication failed|invalid api key|HTTP 401|HTTP 403/i, '凭据未配置或鉴权失败'],
    [/network error|ECONNRESET|ENOTFOUND|ETIMEDOUT/i, '网络不可达']
  ];
  for (const [pattern, reason] of rules) {
    if (pattern.test(sample)) return reason;
  }
  return null;
}

function exists(command) {
  if (command.includes('/')) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const found = spawnSync('which', [command], { encoding: 'utf8' });
  return found.status === 0;
}

function versionOf(command) {
  try {
    const out = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
    return text.split('\n').map(line => line.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

/** 跑一次 headless 任务；返回结构化结果，不把失败伪装成成功。 */
function runTask(agent, task, options = {}) {
  const argv = agent.args.map(item => (item === '{task}' ? task : item));
  argv.push(...(options.withPermission === false ? [] : agent.permissionArgs));
  return new Promise(resolve => {
    let out = '';
    let err = '';
    let child;
    let settled = false;
    const started = Date.now();
    try {
      child = spawn(agent.command, argv, {
        cwd: options.cwd ?? os.tmpdir(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      });
    } catch (error) {
      resolve({ ok: false, error: `spawn 失败：${error.message}`, argv });
      return;
    }
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...payload, durationMs: Date.now() - started, argv, pid: child.pid });
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
      finish({ ok: false, error: `任务超时（${TASK_TIMEOUT_MS}ms）`, timedOut: true });
    }, options.timeoutMs ?? TASK_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on('data', chunk => {
      if (out.length < TAIL_LIMIT) out += chunk.toString();
    });
    child.stderr?.on('data', chunk => {
      if (err.length < TAIL_LIMIT) err += chunk.toString();
    });
    child.on('error', error => finish({ ok: false, error: error.message }));
    child.on('exit', (code, signal) => {
      const parsed = parseStructured(out);
      const structuredOk = isStructuredSuccess(parsed);
      const blocker = environmentalBlocker(`${err}\n${parsed?.result ?? ''}\n${out.slice(-2000)}`);
      finish({
        ok: code === 0 && Boolean(structuredOk),
        exitCode: code,
        signal,
        structuredOk: Boolean(structuredOk),
        result: parsed?.result ?? null,
        ...(blocker && !structuredOk ? { blocked: blocker } : {}),
        stdoutTail: out.slice(-1200),
        stderrTail: err.slice(-1200),
        ...(code === 0 && !structuredOk ? { error: '退出码 0，但没有可识别的结构化结果' } : {}),
        ...(code !== 0 ? { error: `退出码 ${String(code)}：${err.slice(-400) || String(parsed?.result ?? '').slice(0, 200)}` } : {})
      });
    });
  });
}

/**
 * 进程组存活探测用 kill(-pgid, 0)，不依赖 ps。
 * 之前用 `ps -eo pid,pgid` 统计成员数，在受限环境里 ps 直接 EPERM 返回空列表，
 * 「进程组已清空」是空集上的假阳性；这里改成真发信号探测。
 * 返回 true / false / null（探测本身不可用，不许据此下结论）。
 */
function pgidAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return null;
  }
}

async function cancelCheck(agent) {
  const argv = agent.args.map(item =>
    item === '{task}'
      ? 'Write a very long explanation of software architecture, at least 3000 words, one paragraph at a time.'
      : item
  );
  argv.push(...agent.permissionArgs);
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(agent.command, argv, {
        cwd: os.tmpdir(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      });
    } catch (error) {
      resolve({ ok: false, error: `spawn 失败：${error.message}` });
      return;
    }
    child.stdout?.resume();
    child.stderr?.resume();
    const aliveBefore = pgidAlive(child.pid);
    let sent = false;
    const start = setTimeout(() => {
      sent = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        resolve({ ok: false, error: `SIGTERM 发送失败：${error.message}` });
      }
    }, 4000);
    const guard = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* 已经没了 */
      }
    }, 14_000);
    child.on('exit', (code, signal) => {
      clearTimeout(start);
      clearTimeout(guard);
      setTimeout(() => {
        const aliveAfter = pgidAlive(child.pid);
        // 没发出取消信号 / 探测不可用 / 取消前进程组就不在 —— 都是「本轮没验证到」，
        // 绝不能因为进程组此刻为空就写成 PASS。
        if (!sent) {
          resolve({
            ok: false,
            blocked: `CLI 在取消信号发出前已退出（exit ${String(code)}），无法验证取消清理`,
            sent, exitCode: code, signal, aliveBefore, aliveAfter,
            note: '本轮未验证：任务没有跑起来'
          });
          return;
        }
        if (aliveBefore !== true || aliveAfter === null || aliveBefore === null) {
          resolve({
            ok: false,
            blocked: `进程组存活探测不可用或取消前已不存在（before=${String(aliveBefore)}, after=${String(aliveAfter)}）`,
            sent, exitCode: code, signal, aliveBefore, aliveAfter,
            note: '本轮未验证：无法证明是取消动作清掉了进程组'
          });
          return;
        }
        resolve({
          ok: aliveAfter === false,
          sent,
          exitCode: code,
          signal,
          aliveBefore,
          aliveAfter,
          note: aliveAfter === false ? '取消后进程组已清空（真实信号探测）' : '进程组仍有残留，取消清理不完整'
        });
      }, 800);
    });
    child.on('error', error => {
      clearTimeout(start);
      clearTimeout(guard);
      resolve({ ok: false, error: error.message });
    });
  });
}

function tempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cli-e2e-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

async function checkOne(agent) {
  const result = { id: agent.id, label: agent.label, cases: [] };
  const detected = exists(agent.command);
  const version = detected ? versionOf(agent.command) : null;
  result.detect = { ok: detected, command: agent.command, version };
  result.cases.push({ name: 'detect', ok: detected, detail: version ?? '找不到可执行文件' });
  if (!RUN) return result;
  if (!detected) {
    result.cases.push({ name: 'skip', ok: false, detail: '未安装，跳过真实任务（不算通过）' });
    return result;
  }

  const minimal = await runTask(agent, 'Reply with exactly: OK');
  result.cases.push({ name: 'headless-minimal', ok: minimal.ok, detail: minimal.blocked ?? minimal.error ?? minimal.result, ...minimal });

  const repo = tempGitRepo();
  try {
    const write = await runTask(agent, 'Create a file named hello.txt containing exactly the word OK.', { cwd: repo });
    const file = fs.existsSync(path.join(repo, 'hello.txt'));
    result.cases.push({
      name: 'write-file',
      ok: write.ok && file,
      detail: file ? `hello.txt 已创建（${fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8').trim()}）` : write.blocked ?? write.error ?? '文件没创建',
      ...(write.blocked && !(write.ok && file) ? { blocked: write.blocked } : {}),
      ...write
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }

  const cancel = await cancelCheck(agent);
  result.cases.push({ name: 'cancel-process-group', ok: cancel.ok, detail: cancel.note ?? cancel.error, ...cancel });
  return result;
}

function statusOf(item) {
  if (item.ok) return 'PASS';
  return item.blocked ? 'BLOCK' : 'FAIL';
}

async function main() {
  console.log(`真实 CLI E2E：${RUN ? '执行模式（会联网、消耗额度）' : 'dry-run（只检测版本）'}`);
  console.log(`目标：${SELECTED.map(agent => agent.id).join(', ') || '无'}\n`);
  const results = [];
  for (const agent of SELECTED) results.push(await checkOne(agent));

  if (RUN && SELECTED.length > 1) {
    // 并发：两个 CLI 同时各跑一个最小任务，验证互不抢资源/额度不互相阻塞。
    const both = await Promise.all(SELECTED.map(agent => runTask(agent, 'Reply with exactly: OK')));
    const blockers = both.map(item => item.blocked).filter(Boolean);
    const realFailures = both.filter(item => !item.ok && !item.blocked);
    results.push({
      id: 'concurrent',
      label: '多 CLI 并发',
      cases: [
        {
          name: 'concurrent-minimal',
          ok: both.every(item => item.ok),
          // 有一家因额度/鉴权跑不起来时，并发是「本轮没验证到」，不是并发逻辑错了。
          ...(blockers.length > 0 && realFailures.length === 0 ? { blocked: blockers.join(' / ') } : {}),
          detail: both.map((item, index) => `${SELECTED[index].id}: ${item.ok ? 'ok' : item.blocked ?? item.error}`).join(' / '),
          both
        }
      ]
    });
  }

  for (const group of results) {
    console.log(`\n=== ${group.label} ===`);
    if (group.detect) console.log(`  detect: ${group.detect.ok ? 'ok' : 'FAIL'} ${group.detect.version ?? ''}`);
    for (const item of group.cases) {
      console.log(`  ${statusOf(item)}  ${item.name} — ${String(item.detail ?? '').slice(0, 160)}`);
    }
  }

  const report = {
    at: new Date().toISOString(),
    mode: RUN ? 'real' : 'dry-run',
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    results
  };
  const file = path.join(os.tmpdir(), `tf-cli-real-e2e-${Date.now()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n报告：${file}`);

  if (!RUN) {
    console.log('dry-run 完成。要真的验证，加 --run（需要两个 CLI 都有登录态与额度）。');
    return;
  }
  const cases = results.flatMap(group => group.cases.map(item => ({ group: group.id, item })));
  const failures = cases.filter(({ item }) => !item.ok && !item.blocked).map(({ group, item }) => `${group}/${item.name}`);
  const blocked = cases.filter(({ item }) => !item.ok && item.blocked).map(({ group, item }) => `${group}/${item.name}（${item.blocked}）`);
  console.log(`\n通过 ${cases.filter(({ item }) => item.ok).length} / ${cases.length}`);
  if (failures.length > 0) console.log(`未通过：${failures.join(', ')}`);
  if (blocked.length > 0) console.log(`本轮无法验证：\n  - ${blocked.join('\n  - ')}`);
  if (failures.length === 0 && blocked.length === 0) console.log('全部通过');
  if (failures.length > 0 || blocked.length > 0) process.exitCode = 1;
}

// 直接执行才跑；被测试 import 时只导出纯函数。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
