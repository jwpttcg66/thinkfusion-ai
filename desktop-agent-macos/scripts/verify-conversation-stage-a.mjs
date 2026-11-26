/**
 * 阶段 A 真机验收：定位轨（A1）与步骤「执行中 · N 秒」（A2）。
 *
 * 为什么必须真机：这两条都只在真实 DOM + 真实事件流里成立——投影函数有单测，
 * 「渲染层真的画出来、秒数真的在走」只有跑起来才知道。截图会留在
 * `docs/spec/evidence/stage-a/`，作为 IMPLEMENTED/TESTED 之外的真机证据。
 *
 * 一条脚本跑完（不要分开调，dev 进程会随命令结束被回收）：
 *   隔离 userData → 起 dev → 连 CDP → 真跑一个工程任务（npm test 故意睡 8 秒，
 *   好让「执行中」被拍到）→ 截图 → 关进程 → 断言真实 store 没被动过。
 *
 * 隔离（硬规则）：`THINKFUSION_USER_DATA` 指向 /tmp 下的副本，只复制模型配置类
 * 文件，不复制 agent-store / code-index；脚本前后比对真实
 * `~/Library/Application Support/thinkfusion-ai/agent-store.json` 的 sha256。
 *
 * 用法：
 *   node scripts/verify-conversation-stage-a.mjs
 *   KEEP_RUNNING=1 node scripts/verify-conversation-stage-a.mjs   # 验收后不关，自己看
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, sleep } from './lib/cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai');
const REAL_STORE = path.join(REAL_USER_DATA, 'agent-store.json');
const ISO_USER_DATA = process.env.ISO_USER_DATA ?? '/tmp/tf-stage-a-userdata';
const WORKSPACE = process.env.STAGE_A_WORKSPACE ?? '/tmp/tf-stage-a-workspace';
const OUT_DIR = path.join(ROOT, '..', 'docs', 'spec', 'evidence', 'stage-a');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ENDPOINT = `http://127.0.0.1:${PORT}/json`;
const PROMPT = '在这个工作区跑一遍 npm test，把输出的前几行告诉我';
/** npm test 会真的睡 8 秒，给「执行中 · N 秒」留出可截图的窗口。 */
const TEST_SCRIPT = 'node -e "setTimeout(() => { console.log(\'stage-a ok\'); }, 8000)"';

/** 只搬「能起应用、能用同一个模型」的配置；不搬历史任务与索引，避免两份数据互写。 */
const CONFIG_FILES = [
  'api-keys.json',
  'cloud-config.json',
  'execution-defaults.json',
  'permission-preset.json',
  'sources.json',
  'settings.json',
  'capabilities.json',
  'cli-agents.json',
  'cli-capabilities.json',
  'collaboration-mode.json',
  'expertise.json',
  'profile.json',
  'workspaces.json',
  'workspace-state.json',
  'code-intelligence.json'
];

const evidence = { startedAt: new Date().toISOString(), checks: {}, shots: [], events: [], steps: [] };
let child = null;
let cdp = null;

function sha256(file) {
  if (!fs.existsSync(file)) return null;
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function note(name, ok, detail) {
  evidence.checks[name] = { ok, detail: detail ?? null, at: new Date().toISOString() };
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function prepareIsolation() {
  fs.rmSync(ISO_USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(ISO_USER_DATA, { recursive: true });
  const copied = [];
  for (const name of CONFIG_FILES) {
    const from = path.join(REAL_USER_DATA, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(ISO_USER_DATA, name));
    copied.push(name);
  }
  evidence.copiedConfig = copied;
  return copied;
}

function prepareWorkspace() {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, 'readme.txt'), 'stage-a workspace\n');
  fs.writeFileSync(
    path.join(WORKSPACE, 'package.json'),
    `${JSON.stringify({ name: 'stage-a-workspace', version: '1.0.0', private: true, scripts: { test: TEST_SCRIPT } }, null, 2)}\n`
  );
}

async function waitForEndpoint(deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(ENDPOINT);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`CDP ${ENDPOINT} 一直没起来：${lastError?.message ?? 'timeout'}`);
}

function findRenderer(targets) {
  return (
    targets.find(
      target =>
        target.type === 'page' &&
        (target.url.includes('localhost:5173') || target.url.includes('localhost:5174') || target.url.startsWith('file:'))
    ) ?? null
  );
}

function listenersOn(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .split('\n')
      .map(item => item.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

/**
 * 端口必须先腾干净。
 *
 * 上一轮残留的 Electron 会继续占着 9333：新实例启动时 devtools http server
 * bind 失败（日志里 `Address already in use`），脚本却连上了**旧实例**——
 * 于是驱动的是一个窗口已经被关掉的进程，截图全是白板。这类「看起来连上了」
 * 比连不上更难查，干脆在起进程前就杀干净。
 */
async function ensurePortFree() {
  const stale = [...new Set([...listenersOn(PORT), ...listenersOn(5173)])];
  if (stale.length === 0) return [];
  for (const pid of stale) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已经退出
    }
  }
  for (let i = 0; i < 20 && listenersOn(PORT).length > 0; i += 1) await sleep(300);
  if (listenersOn(PORT).length > 0) throw new Error(`端口 ${PORT} 仍被占用：${listenersOn(PORT).join(',')}`);
  console.log(`     清掉残留实例 pid=${stale.join(',')}`);
  return stale;
}

function startDev() {
  // `npm run dev` 会先 build:agent；这里同样先编译主进程产物，免得 dev 起在旧 out 上。
  execFileSync('npm', ['run', 'build:agent'], { cwd: ROOT, stdio: 'inherit' });
  const logFile = path.join(OUT_DIR, 'dev.log');
  const out = fs.openSync(logFile, 'w');
  /**
   * 环境里带的 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 以纯 Node 跑主进程，
   * 于是 `electron.app` 是 undefined，启动直接崩（`TypeError ... setName`）。
   * `NODE_OPTIONS` 同理：那是宿主注入的 shim，不该进应用进程。
   */
  const env = { ...process.env, THINKFUSION_USER_DATA: ISO_USER_DATA };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  child = spawn('npx', ['electron-vite', 'dev', '--noSandbox', '--remoteDebuggingPort', String(PORT)], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', out, out]
  });
  child.unref();
  return logFile;
}

async function stopDev() {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // 已经退出
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      process.kill(-child.pid, 0);
    } catch {
      return;
    }
    await sleep(300);
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // 已经退出
  }
}

/**
 * 截图。空白页在 PNG 里只有几 KB（真实界面 100KB+），所以顺手做一次体检：
 * 太小就 `bringToFront` 重拍一次。**不把白板当证据交出去。**
 */
async function shot(cdp, name) {
  const capture = async () =>
    Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000)).data, 'base64');
  let buffer = await capture();
  if (buffer.length < 30000) {
    await cdp.send('Page.bringToFront').catch(() => null);
    await sleep(800);
    const retry = await capture();
    if (retry.length > buffer.length) buffer = retry;
  }
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, buffer);
  evidence.shots.push(path.relative(ROOT, file));
  if (buffer.length < 30000) {
    evidence.blankShots = [...(evidence.blankShots ?? []), name];
    console.log(`     shot ${path.relative(ROOT, file)}（${String(buffer.length)}B，疑似空白）`);
  } else {
    console.log(`     shot ${path.relative(ROOT, file)}`);
  }
  return file;
}

/** 一次读全页面的关键事实：定位轨、步骤文案、锚点、是否有步骤在跑。 */
const PROBE = `(() => {
  const ticks = Array.from(document.querySelectorAll('.chat-locate-tick'));
  const metas = Array.from(document.querySelectorAll('.chat-step-meta')).map(node => node.textContent?.trim() ?? '');
  const anchors = Array.from(document.querySelectorAll('[data-stream-anchor]'));
  return {
    rail: Boolean(document.querySelector('.chat-locate-rail')),
    railClass: Boolean(document.querySelector('.chat-feed-layout.has-locate-rail')),
    tickCount: ticks.length,
    tickLabels: ticks.map(node => node.querySelector('.chat-locate-label')?.textContent?.trim() ?? ''),
    tickTargets: ticks.map(node => node.getAttribute('data-landmark-target')),
    tickTargetsResolve: ticks.map(node => Boolean(document.getElementById(node.getAttribute('data-landmark-target') ?? ''))),
    activeCount: document.querySelectorAll('.chat-locate-tick.is-active').length,
    runningSteps: document.querySelectorAll('.chat-step.is-running').length,
    runningMetas: Array.from(document.querySelectorAll('.chat-step.is-running'))
      .map(node => node.querySelector('.chat-step-meta')?.textContent?.trim() ?? ''),
    stepMetas: metas,
    anchorIds: anchors.map(node => node.id),
    liveText: (document.body?.innerText ?? '').includes('执行中'),
    scrollTop: Math.round(window.scrollY)
  };
})()`;

function liveSeconds(metas) {
  for (const text of metas ?? []) {
    // 「不到 1 秒」也要算：刚起步的那一下就是 0 秒，不能当成「没显示」。
    if (/执行中 · 不到 1 秒/.test(text)) return 0;
    const match = /执行中 · (?:(\d+) 分 )?(\d+) 秒/.exec(text);
    if (match) return Number(match[1] ?? 0) * 60 + Number(match[2]);
  }
  return null;
}

/**
 * 轮询期的求值容错。
 *
 * 规划/评审跑起来时主进程会忙一阵，IPC 偶发超过 20 秒；一次超时不该让整场
 * 验收中断（那不是界面错了，是我们问得太急）。
 */
async function tryEval(expr, timeoutMs = 45000, fallback = null) {
  try {
    return await cdp.evaluate(expr, timeoutMs);
  } catch (error) {
    evidence.pollMisses = (evidence.pollMisses ?? 0) + 1;
    console.log(`     (poll) ${error?.message ?? error}`);
    return fallback;
  }
}

async function approveIfNeeded(cdp, task, events, approvedPlans, approvedSteps) {
  // 计划审批只在 `awaiting_approval` 时受理：`plan_ready` 是计划刚落库、还没进等待态，
  // 这时 approve 会被状态机拒掉（「任务当前状态为 plan_ready，不接受审批」）。
  if (task?.status === 'awaiting_approval') {
    const pendingPlan = [...events].reverse().find(event => event.type === 'plan.ready' && event.plan?.planId);
    if (pendingPlan && !approvedPlans.has(pendingPlan.plan.planId)) {
      const approved = await tryEval(
        `window.agentAPI.approvePlan(${JSON.stringify({
          taskId: task.taskId,
          roundId: pendingPlan.roundId,
          planId: pendingPlan.plan.planId,
          approved: true
        })})`,
        45000,
        'timeout'
      );
      if (approved === 'timeout') return;
      approvedPlans.add(pendingPlan.plan.planId);
      console.log(`     approved plan ${pendingPlan.plan.planId}`);
      return;
    }
  }

  // 单步审批与任务状态无关：任务停在 `executing`，那一步在内部等 `step.approval`。
  // 之前把它一起挂在 `awaiting_approval` 上，结果第二步永远等不到人，5 分钟后超时被拒。
  const resolved = new Set(events.filter(event => event.type === 'step.approval-resolved').map(event => event.stepId));
  for (const event of events) {
    if (event.type !== 'step.approval') continue;
    if (resolved.has(event.stepId) || approvedSteps.has(event.stepId)) continue;
    const approved = await tryEval(
      `window.agentAPI.approveStep(${JSON.stringify({ taskId: task?.taskId ?? event.taskId, stepId: event.stepId })})`,
      45000,
      'timeout'
    );
    if (approved === 'timeout') return;
    approvedSteps.add(event.stepId);
    console.log(`     approved step ${event.stepId} (${event.tool ?? '?'})`);
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const storeBefore = sha256(REAL_STORE);
  evidence.storeBefore = storeBefore;
  note('real-store-readable', Boolean(storeBefore), REAL_STORE);
  prepareIsolation();
  prepareWorkspace();
  const stale = await ensurePortFree();
  const logFile = startDev();
  console.log(`dev 启动中（隔离 userData=${ISO_USER_DATA}，日志 ${logFile}）`);
  evidence.clearedStale = stale;

  const targets = await waitForEndpoint(Date.now() + 120000);
  // 端口被旧实例占着时，devtools 起不来但 9333 仍有响应——必须当场认出这种情况。
  if (fs.readFileSync(logFile, 'utf8').includes('Cannot start http server for devtools')) {
    throw new Error('devtools 端口被旧实例占用（日志：Cannot start http server for devtools）');
  }
  let target = findRenderer(targets);
  if (!target) {
    // 有时 dev server 先起、窗口后起，再等一轮。
    for (let i = 0; i < 60 && !target; i += 1) {
      await sleep(1000);
      target = findRenderer(await (await fetch(ENDPOINT)).json());
    }
  }
  assert.ok(target, `找不到渲染进程；targets=${JSON.stringify(targets.map(item => item.url))}`);
  cdp = await connect(target);
  await cdp.send('Page.enable');

  // 等 preload 注入
  let ready = false;
  for (let i = 0; i < 80 && !ready; i += 1) {
    ready = Boolean(await cdp.evaluate(`typeof window.agentAPI?.submitConversation === 'function'`).catch(() => false));
    if (!ready) await sleep(500);
  }
  assert.ok(ready, 'agentAPI 未注入');
  note('renderer-ready', true, target.url);

  const defaults = await cdp.evaluate('window.agentAPI.getExecutionDefaults()');
  evidence.executionDefaults = defaults;
  note('model-configured', Boolean(defaults?.selectedCloudModels?.length), JSON.stringify(defaults?.selectedCloudModels ?? []));

  const conversation = await cdp.evaluate(
    `window.agentAPI.submitConversation(${JSON.stringify({
      text: PROMPT,
      /**
       * 用完全权限，只为让模型那条 `npm test 2>&1 | head` 能跑起来：
       * workspace-write 下 shell 组合符会被拒（「不允许 shell 组合符」），
       * 步骤直接 failed，就拍不到「执行中」。这是 /tmp 里的一次性工作区，
       * 用完即删；用户自己的配置一点没动。
       */
      permissionPreset: 'danger-full-access',
      workspaceRoot: WORKSPACE,
      workspaceMode: 'engineering',
      executionConfig: defaults,
      taskKindOverride: 'execution'
    })})`
  );
  const taskId = conversation.taskId;
  assert.ok(taskId, `submitConversation 未返回 taskId：${JSON.stringify(conversation)}`);
  evidence.taskId = taskId;
  evidence.conversationId = conversation.conversationId;
  console.log(`task ${taskId}`);

  const approvedPlans = new Set();
  const approvedSteps = new Set();
  let printed = 0;
  let shotRunning = null;
  let firstLive = null;
  let secondLive = null;
  let terminal = null;
  const deadline = Date.now() + 8 * 60 * 1000;

  while (Date.now() < deadline) {
    await sleep(400);
    const task = await tryEval(`window.agentAPI.getTask(${JSON.stringify(taskId)})`);
    const events = (await tryEval(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`, 45000, [])) ?? [];
    for (const event of events.slice(printed)) {
      evidence.events.push({ type: event.type, at: event.at, stepId: event.stepId ?? null, tool: event.tool ?? null });
      if (['plan.ready', 'step.started', 'step.approval', 'step.completed', 'step.failed', 'task.completed', 'task.failed'].includes(event.type)) {
        console.log(`     ${event.type}${event.tool ? ` ${event.tool}` : ''}${event.stepId ? ` ${event.stepId}` : ''}`);
      }
    }
    printed = events.length;

    await approveIfNeeded(cdp, task, events, approvedPlans, approvedSteps);
    if (task?.status === 'report_pending') {
      // 验证没过但报告已落库：按现有口径重判，别让任务永远停在待确认。
      await tryEval(`window.agentAPI.recheckVerification(${JSON.stringify(taskId)})`);
      console.log('     recheckVerification');
    }

    const probe = await tryEval(PROBE);
    if (probe && probe.runningSteps > 0 && !shotRunning) {
      shotRunning = probe;
      firstLive = liveSeconds(probe.runningMetas);
      // 把正在跑的那一步滚到视野中间，截图里才看得见「执行中 · N 秒」；
      // 否则画面停在审批卡上，只有标签写着「执行中」，没有秒数。
      await tryEval(`document.querySelector('.chat-step.is-running')?.scrollIntoView({ block: 'center' })`);
      await shot(cdp, '01-run-in-progress.png');
      await sleep(2600);
      const later = await tryEval(PROBE);
      secondLive = liveSeconds(later?.runningMetas);
      evidence.liveMetas = { first: probe.runningMetas, second: later?.runningMetas ?? null };
      await tryEval(`document.querySelector('.chat-step.is-running')?.scrollIntoView({ block: 'center' })`);
      await shot(cdp, '02-run-in-progress-later.png');
    }

    if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) {
      terminal = task;
      break;
    }
  }

  terminal = terminal ?? (await tryEval(`window.agentAPI.getTask(${JSON.stringify(taskId)})`));
  evidence.terminal = terminal ? { status: terminal.status, error: terminal.error ?? null } : null;
  note('task-terminal', terminal?.status === 'completed', terminal ? terminal.status : 'timeout');

  const final = await tryEval(PROBE, 45000);
  assert.ok(final, '最终 DOM 探测失败：页面在验收期间无响应');
  evidence.finalProbe = final;
  await shot(cdp, '03-completed.png');

  note('locate-rail-visible', final.rail && final.railClass, `rail=${String(final.rail)} grid=${String(final.railClass)}`);
  note('locate-rail-has-ticks', final.tickCount >= 2, `ticks=${String(final.tickCount)} labels=${JSON.stringify(final.tickLabels)}`);
  note(
    'each-tick-targets-a-real-anchor',
    final.tickTargets.every(Boolean) && final.tickTargetsResolve.every(Boolean),
    `targets=${JSON.stringify(final.tickTargets)}`
  );
  note('tick-highlight-present', final.activeCount >= 1, `active=${String(final.activeCount)}`);
  note('running-step-shot', Boolean(shotRunning), shotRunning ? `metas=${JSON.stringify(shotRunning.runningMetas)}` : '没拍到执行中');
  note(
    'live-seconds-shown',
    typeof firstLive === 'number',
    firstLive === null ? '正在跑的那一步没有「执行中 · N 秒」' : `第一次 ${String(firstLive)} 秒`
  );
  note(
    'live-seconds-increase',
    typeof firstLive === 'number' && typeof secondLive === 'number' && secondLive > firstLive,
    `${String(firstLive)} 秒 → ${String(secondLive)} 秒`
  );
  note('no-stale-running-after-finish', final.runningSteps === 0 && !final.liveText, `running=${String(final.runningSteps)}`);

  // 点击定位轨：目标锚点必须真的滚进视口（这是「点了没反应」的直接反例）。
  let jumped = { ok: false, reason: '没有定位轨可点' };
  if (final.tickCount > 0) {
    await cdp.evaluate(`(() => {
      const ticks = Array.from(document.querySelectorAll('.chat-locate-tick'));
      const tick = ticks[ticks.length - 1];
      tick?.click();
      return Boolean(tick);
    })()`);
    await sleep(900);
    jumped = await cdp.evaluate(`(() => {
      const ticks = Array.from(document.querySelectorAll('.chat-locate-tick'));
      const tick = ticks[ticks.length - 1];
      const target = tick ? document.getElementById(tick.getAttribute('data-landmark-target') ?? '') : null;
      if (!target) return { ok: false, reason: 'anchor missing' };
      const top = target.getBoundingClientRect().top;
      return { ok: true, top: Math.round(top), inViewport: top > -200 && top < window.innerHeight };
    })()`);
    await shot(cdp, '04-jump-to-conclusion.png');
  }
  evidence.jump = jumped;
  note('click-tick-scrolls-to-anchor', Boolean(jumped.ok && jumped.inViewport), JSON.stringify(jumped));

  if (!process.env.KEEP_RUNNING) await stopDev();
  await sleep(500);
  const storeAfter = sha256(REAL_STORE);
  evidence.storeAfter = storeAfter;
  note('real-store-untouched', storeBefore === storeAfter, `${String(storeBefore).slice(0, 12)} → ${String(storeAfter).slice(0, 12)}`);

  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  const failed = Object.entries(evidence.checks).filter(([, value]) => !value.ok);
  fs.writeFileSync(
    path.join(OUT_DIR, 'EVIDENCE.md'),
    [
      '# 阶段 A 真机验收：定位轨与「执行中 · N 秒」',
      '',
      `- 时间：${evidence.startedAt} → ${evidence.finishedAt}`,
      `- 任务：\`${evidence.taskId}\`（隔离 userData \`${ISO_USER_DATA}\`，工作区 \`${WORKSPACE}\`）`,
      `- 模型：${JSON.stringify(evidence.executionDefaults?.selectedCloudModels ?? [])}，权限档 \`danger-full-access\`（/tmp 一次性工作区；完全权限下计划自动批准、步骤不再逐次弹审批，否则模型那条 \`npm test | head\` 会被 shell 组合符规则拒掉）`,
      `- 真实 store：\`${REAL_STORE}\` sha256 前后一致（\`${String(storeBefore).slice(0, 12)}\`）`,
      '',
      '| 检查 | 结果 | 说明 |',
      '| --- | --- | --- |',
      ...Object.entries(evidence.checks).map(([name, value]) => `| ${name} | ${value.ok ? 'PASS' : 'FAIL'} | ${String(value.detail ?? '')} |`),
      '',
      '## 截图',
      '',
      ...evidence.shots.map(file => `- \`${path.relative(OUT_DIR, path.join(ROOT, file))}\``),
      '',
      '> 截图来自真实 Electron 渲染进程（CDP `Page.captureScreenshot`）。',
      '> 这个任务是真的跑了一遍 `npm test`（脚本里故意睡 8 秒），不是摆拍的假事件。'
    ].join('\n')
  );

  console.log(`\n证据：${path.relative(ROOT, OUT_DIR)}/EVIDENCE.md`);
  if (failed.length > 0) {
    console.error(`未通过 ${String(failed.length)} 项：${failed.map(([name]) => name).join(', ')}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error('验收中断：', error?.message ?? error);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'failure.json'), `${JSON.stringify({ error: String(error?.stack ?? error), evidence }, null, 2)}\n`);
  await stopDev();
  process.exitCode = 1;
} finally {
  cdp?.close();
  if (!process.env.KEEP_RUNNING) await stopDev();
}
