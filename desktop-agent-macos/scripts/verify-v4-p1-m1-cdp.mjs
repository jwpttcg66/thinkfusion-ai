/**
 * V4 P1 M1 真机验收：执行历史（M1-1）、目标聚合视图（M1-2）、目标变更影响面确认（M1-3）。
 *
 * 默认数据目录（AGENTS.md §10.2）：不隔离、不复制用户数据，不传 THINKFUSION_USER_DATA。
 * 探针任务用完删除，用户任务数前后必须一致；中间任何一步抛错都先清场再收证据。
 *
 * 探针口径（按运行时真实行为写的，不是设想的行为）：
 * - 第 1 轮用固定工作流跑一条必定失败的 shell（`exit 3`），确定性地拿到「一轮失败 + 一份带失败记录的报告」；
 * - 之后的轮次由目标契约闭环（GDC）自己续——报告落库后会自动开新一轮并执行，
 *   所以第 2 条执行不需要额外调用 resumeRepair；脚本只负责在循环停住时把它推回去
 *   （等审批就放行、等回答就答复、已暂停就恢复）；
 * - 目标修订先用「补两条标准」（不抬版本）落基线，再删一条 → 触发 requiresUserConfirmation，
 *   验证 goal.revision.pending 事件、确认卡与确认后的版本抬升；
 * - M1-2 目标实体化：走界面「在此目标下新建任务」产生第二条同目标任务，验证新任务沿用目标的
 *   版本与标准、确认卡列出一起生效的同目标名单、确认后两条任务与 `store.goals` 同步抬版本。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, sleep } from './lib/cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '..', 'docs', 'implementation', 'acceptance', 'v4-p1-m1-20261127');
const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai');
const STORE = path.join(USER_DATA, 'agent-store.json');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ENDPOINT = `http://127.0.0.1:${PORT}/json`;
const PROBE_MARK = 'V4M1执行历史探针';
const PROBE_TITLE = `工作流：${PROBE_MARK}`;

const evidence = {
  startedAt: new Date().toISOString(),
  mode: `默认数据目录 / ThinkFusion Dev / CDP ${PORT}`,
  checks: {},
  taskId: null,
  executions: [],
  pendingEvent: null,
  statusSequence: [],
  shots: [],
  notes: [],
  loopActions: []
};
let child = null;
let cdp = null;
let taskId = null;
let probeDeleted = false;

function note(name, ok, detail) {
  evidence.checks[name] = { ok: Boolean(ok), detail: detail ?? null, at: new Date().toISOString() };
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function remark(text) {
  evidence.notes.push(text);
  console.log(`NOTE ${text}`);
}

function listenersOn(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .split('\n').map(item => item.trim()).filter(Boolean);
  } catch { return []; }
}

function storeTasks() {
  if (!fs.existsSync(STORE)) return [];
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')).tasks ?? []; } catch { return []; }
}

function taskIds() {
  return storeTasks().map(task => task.taskId ?? task.id).filter(Boolean).sort();
}

async function waitForEndpoint(deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(ENDPOINT);
      if (response.ok) return await response.json();
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  throw new Error(`CDP ${ENDPOINT} 没有起来`);
}

async function waitFor(read, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(1000);
  }
  throw new Error(`等待超时：${label}`);
}

async function startDev() {
  execFileSync('npm', ['run', 'build:agent'], { cwd: ROOT, stdio: 'inherit' });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const log = fs.openSync(path.join(OUT_DIR, 'dev.log'), 'w');
  const env = { ...process.env };
  delete env.THINKFUSION_USER_DATA;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  child = spawn('npx', ['electron-vite', 'dev', '--noSandbox', '--remoteDebuggingPort', String(PORT)], {
    cwd: ROOT, env, detached: true, stdio: ['ignore', log, log]
  });
  child.unref();
}

async function stopDev() {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 已退出 */ }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { process.kill(-child.pid, 0); } catch { return; }
    await sleep(300);
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
}

const ev = (expression, timeoutMs = 60000) => cdp.evaluate(expression, timeoutMs);
const state = () => taskId ? ev(`window.agentAPI.getTask(${JSON.stringify(taskId)})`, 30000) : null;
const events = () => taskId ? ev(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`, 30000) ?? [] : [];
const executions = () => taskId ? ev(`window.agentAPI.getTaskExecutions(${JSON.stringify(taskId)})`, 30000) ?? [] : [];

async function shot(name) {
  const buffer = Buffer.from(
    (await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000)).data,
    'base64'
  );
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, buffer);
  evidence.shots.push(path.relative(ROOT, file));
}

/** 点侧栏里的探针任务，保证截图拍到的是探针而不是首页。 */
async function selectProbe() {
  return ev(`(() => {
    const mark = ${JSON.stringify(PROBE_MARK)};
    const nodes = [...document.querySelectorAll('.task-item')];
    const target = nodes.find(node => (node.textContent ?? '').includes(mark));
    if (!target) return false;
    target.click();
    return true;
  })()`);
}

/**
 * 打开工程工作台页签。
 *
 * 页签文案在会话页与工作台里重复出现（都有「统计」），只按文案找会点到会话页那一排，
 * 于是工作台根本没切过去，界面断言就变成「投影有 2 条、界面 0 条」这种假失败。
 */
async function openTab(label) {
  return ev(`(() => {
    const scope = document.querySelector('.wb-tabs') ?? document;
    const target = [...scope.querySelectorAll('button[role="tab"]')].find(node => (node.textContent ?? '').trim() === ${JSON.stringify(label)});
    if (!target) return false;
    target.click();
    return true;
  })()`);
}

/**
 * 循环停住时把它推回去。
 *
 * 每一轮该不该自动执行由权限档决定，探针跑的是 danger-full-access，但闭环仍可能
 * 因为模型追问而停在 awaiting_answer。这里只补最小的一步动作，并在证据里记下
 * 「这一轮是脚本推的」，不把被推动的行为说成运行时的自发行为。
 */
async function pushLoop(forward) {
  const task = await state().catch(() => null);
  const status = task?.status ?? null;
  if (!status) return null;
  if (status === 'plan_ready' || status === 'awaiting_approval') {
    const all = await events().catch(() => []);
    const ready = [...all].reverse().find(event => event.type === 'plan.ready' && event.roundId === task.currentRoundId)
      ?? [...all].reverse().find(event => event.type === 'plan.ready');
    if (ready) {
      await ev(`window.agentAPI.approvePlan(${JSON.stringify({
        taskId, roundId: ready.roundId ?? task.currentRoundId, planId: ready.planId, approved: true
      })})`, 60000).catch(() => null);
      evidence.loopActions.push({ at: new Date().toISOString(), status, action: 'approvePlan', planId: ready.planId ?? null });
    }
  } else if (status === 'awaiting_clarification' || status === 'awaiting_answer') {
    await ev(`window.agentAPI.answerClarification(${JSON.stringify({
      taskId, answer: '继续。本轮只需说明执行历史是否已被记录，不要修改任何文件。'
    })})`, 60000).catch(() => null);
    evidence.loopActions.push({ at: new Date().toISOString(), status, action: 'answerClarification' });
  } else if (status === 'paused' || status === 'interrupted' || status === 'budget_exhausted') {
    await ev(`window.agentAPI.resumeTask(${JSON.stringify(taskId)})`, 60000).catch(() => null);
    evidence.loopActions.push({ at: new Date().toISOString(), status, action: 'resumeTask' });
  } else if (forward && status === 'report_pending') {
    await ev(`window.agentAPI.resumeTask(${JSON.stringify(taskId)})`, 60000).catch(() => null);
    evidence.loopActions.push({ at: new Date().toISOString(), status, action: 'resumeTask(report_pending)' });
  }
  return status;
}

async function collectExecutions() {
  const execList = await executions();
  return execList.map(item => ({
    executionId: item.executionId,
    roundId: item.roundId,
    roundNumber: item.roundNumber ?? null,
    inputType: item.inputType ?? null,
    runId: item.runId ?? null,
    planId: item.planId ?? null,
    roundStatus: item.roundStatus ?? null,
    outcome: item.outcome ?? null,
    nextAction: item.nextAction ?? null,
    verified: item.verified ?? null,
    fullyVerified: item.fullyVerified ?? null,
    changedFiles: item.changedFiles ?? null,
    steps: item.steps ?? null,
    failureReasons: (item.failureReasons ?? []).slice(0, 3),
    deliverables: (item.deliverables ?? []).slice(0, 5),
    evidenceCount: (item.evidenceRefs ?? []).length,
    participants: (item.participants ?? []).map(p => ({ label: p.label, modelId: p.modelId ?? null, status: p.status ?? null })),
    sources: item.sources ?? null,
    startedAt: item.startedAt ?? null,
    endedAt: item.endedAt ?? null,
    durationMs: item.durationMs ?? null
  }));
}

async function phases() {
  note('default-store-readable', fs.existsSync(STORE), STORE);
  if (listenersOn(PORT).length > 0) throw new Error(`CDP 端口 ${PORT} 已被占用`);
  await startDev();
  const targets = await waitForEndpoint(Date.now() + 150000);
  const candidates = targets.filter(item => item.type === 'page'
    && (item.url.includes('localhost:5173') || item.url.includes('localhost:5174') || item.url.startsWith('file:')));
  for (const candidate of candidates) {
    const probe = await connect(candidate);
    const ready = await waitFor(async () => {
      try { return await probe.evaluate('typeof window.agentAPI', 5000) === 'object' ? 'ready' : null; }
      catch { return null; }
    }, `agentAPI 注入 ${candidate.url}`, 40000).catch(() => null);
    if (ready) { cdp = probe; break; }
    probe.close();
  }
  if (!cdp) throw new Error('没有找到注入 agentAPI 的渲染进程');
  note('renderer-ready', true, 'CDP 已连接');

  // 只清自己的旧探针（上一次超时留下的也算）。
  for (const old of storeTasks().filter(item => String(item.title ?? '').includes(PROBE_MARK))) {
    await ev(`window.agentAPI.deleteTask(${JSON.stringify(old.taskId)})`, 30000).catch(() => null);
  }
  const before = taskIds();
  evidence.taskIdsBefore = before;

  // 切到工程工作区，侧栏才列任务。
  await ev(`(() => {
    const tab = [...document.querySelectorAll('.workspace-tab')].find(node => (node.textContent ?? '').includes('工程工作'));
    if (tab) tab.click();
    return Boolean(tab);
  })()`);
  await sleep(600);

  /* ---------------- M1-1：等 GDC 自己续出第二条带报告的执行 ---------------- */
  const created = await ev(`window.agentAPI.runWorkflow(${JSON.stringify({
    workflow: {
      id: 'v4-p1-m1-execution-probe',
      title: PROBE_MARK,
      nodes: [{
        id: 'must-fail',
        capabilityId: 'shell.run',
        title: '必定失败的命令，用来留下第一条失败执行',
        args: { command: 'echo v4m1-round1-begins; exit 3', timeoutMs: 20000 }
      }]
    },
    permissionPreset: 'danger-full-access',
    workspaceRoot: '/tmp',
    goal: 'V4 P1 M1 执行历史真机探针：第 1 轮必须失败'
  })})`, 60000);
  taskId = created?.taskId;
  evidence.taskId = taskId;
  note('probe-task-created', Boolean(taskId), taskId);
  assert.ok(taskId, '探针任务没创建出来');

  const reported = key => executions().then(list => list.find(item =>
    item.roundNumber === key && item.sources?.report === true && item.outcome));
  const first = await waitFor(() => reported(1), '第 1 轮执行带报告收口', 300000);
  evidence.executionsRound1 = first;
  note('execution-1-recorded', Boolean(first?.roundId), JSON.stringify({
    outcome: first?.outcome ?? null,
    hasReport: Boolean(first?.sources?.report),
    steps: first?.steps ?? null,
    failures: (first?.failureReasons ?? []).length
  }));
  note('execution-1-carries-failure',
    first?.outcome === 'failed' && (first?.steps?.failed ?? 0) >= 1 && (first?.failureReasons?.length ?? 0) >= 1,
    `outcome=${String(first?.outcome)} 失败步骤 ${String(first?.steps?.failed ?? 0)} 条 失败原因 ${JSON.stringify(first?.failureReasons ?? [])}`);
  note('execution-1-no-phantom-zero',
    first?.steps?.unknown !== true && first?.sources?.report === true,
    `sources=${JSON.stringify(first?.sources ?? null)}`);

  const secondReady = await waitFor(async () => {
    const list = await executions().catch(() => []);
    const done = list.filter(item => item.sources?.report === true && item.outcome && item.roundNumber !== 1);
    if (done.length >= 1) return done;
    await pushLoop(true).catch(() => null);
    return null;
  }, 'GDC 续出第 2 条带报告的执行', 600000);

  const execList = await collectExecutions();
  evidence.executions = execList;
  evidence.round2Sample = secondReady?.[0] ?? null;

  const distinctRounds = new Set(execList.map(item => item.roundId).filter(Boolean));
  note('two-executions-distinct-rounds', distinctRounds.size >= 2, `roundId 去重后 ${String(distinctRounds.size)} 条`);
  note('executions-not-overwritten', execList.length >= 2 && execList[0].roundId !== execList[1].roundId,
    `第 1 条 ${String(execList[0]?.roundId ?? '-')} / 第 2 条 ${String(execList[1]?.roundId ?? '-')}`);
  note('later-execution-not-overwrite-first',
    execList.length >= 2 && execList[0].roundNumber === 1 && Boolean(execList[0].outcome),
    `第 1 条仍为 round ${String(execList[0]?.roundNumber ?? '-')}，outcome=${String(execList[0]?.outcome ?? 'null')}`);
  note('run-id-linkage-recorded', execList.every(item => item.runId === null || typeof item.runId === 'string'),
    execList.map(item => `${String(item.roundNumber ?? '?')}:${String(item.runId ?? '未记录')}`).join(' '));
  if (execList[0]?.runId && execList[1]?.runId && execList[0].runId === execList[1].runId) {
    remark('两轮共用同一个 runId：本次是同一次连续执行的续跑，不是两次独立运行。');
  }
  const withReport = execList.filter(item => item.sources?.report === true).length;
  const withoutReport = execList.filter(item => item.sources?.report !== true);
  note('report-less-round-marked-unknown',
    withoutReport.every(item => item.outcome === null && item.steps?.unknown === true),
    withoutReport.length > 0 ? `无报告轮 ${withoutReport.map(item => `r${String(item.roundNumber)}`).join(',')}` : '本次每轮都有报告');
  if (evidence.loopActions.length > 0) {
    remark(`执行历史里有 ${String(evidence.loopActions.length)} 次是脚本推动循环的：${evidence.loopActions.map(item => `${item.status}→${item.action}`).join('、')}。`);
  }

  const allEvents = await events().catch(() => []);
  const rawStatuses = allEvents
    .filter(event => event.type === 'task.updated' && (event.task?.taskId ?? event.taskId) === taskId)
    .map(event => event.task?.status)
    .filter(Boolean);
  evidence.statusSequence = rawStatuses.filter((status, index) => index === 0 || status !== rawStatuses[index - 1]);
  note('round-input-types-recorded', execList.some(item => item.inputType === 'user_prompt') && execList.some(item => item.inputType === 'execution_report'),
    execList.map(item => `${String(item.roundNumber)}:${String(item.inputType ?? 'null')}`).join(' '));

  // 界面投影：统计页的执行历史卡。
  const tabSwitched = await openTab('统计');
  await selectProbe();
  await sleep(800);
  await openTab('统计');
  const readExecCard = `(() => {
    const cards = [...document.querySelectorAll('.card')];
    const card = cards.find(node => (node.querySelector(':scope > .card-head > h2')?.textContent ?? '').trim() === '执行历史');
    if (!card) return { found: false, heads: cards.map(node => (node.querySelector('.card-head')?.textContent ?? '').trim().slice(0, 30)) };
    const items = [...card.querySelectorAll('.exec-item')];
    return {
      found: true,
      headText: (card.querySelector('.card-head')?.textContent ?? '').trim(),
      itemCount: items.length,
      itemHeads: items.map(item => (item.querySelector('.exec-item-head')?.textContent ?? '').trim().slice(0, 120)),
      hasEvidence: items.some(item => (item.textContent ?? '').includes('证据')),
      showsMissing: items.some(item => (item.textContent ?? '').includes('没有记录到交付文件') || (item.textContent ?? '').includes('没有执行报告') || (item.textContent ?? '').includes('未记录'))
    };
  })()`;
  // 卡片自己发 IPC 取数，切页瞬间还是「读取中…」；等到真有行再断言，否则是把
  // 一次正常的异步渲染说成界面漏了数据。
  const statsView = await waitFor(async () => {
    const view = await ev(readExecCard);
    return view?.found === true && view.itemCount > 0 ? view : null;
  }, '统计页执行历史渲染出来', 30000).catch(async () => await ev(readExecCard));
  evidence.tabSwitched = tabSwitched;
  evidence.statsProjection = statsView;
  // 循环还在推进，比对基准必须是渲染那一刻的投影，而不是几分钟前采的快照。
  const projectionAtRender = await collectExecutions();
  evidence.executionsAtRender = projectionAtRender.map(item => ({
    roundNumber: item.roundNumber, roundId: item.roundId, outcome: item.outcome, sources: item.sources
  }));
  note('ui-execution-card-found', statsView?.found === true, JSON.stringify(statsView?.headText ?? statsView?.heads ?? null));
  note('ui-execution-rows-match-projection', statsView?.itemCount === projectionAtRender.length,
    `界面 ${String(statsView?.itemCount ?? 0)} 条 / 同时刻投影 ${String(projectionAtRender.length)} 条（快照时 ${String(execList.length)} 条）`);
  note('ui-execution-rows-show-outcome', (statsView?.itemHeads ?? []).some(text => /失败|部分|完成/.test(String(text))),
    JSON.stringify((statsView?.itemHeads ?? []).slice(0, 3)));
  note('ui-execution-rows-honest-about-missing', statsView?.found !== true || statsView.showsMissing === true || projectionAtRender.every(item => item.sources?.report),
    `界面缺报告文案=${String(statsView?.showsMissing ?? '-')}`);
  await shot('01-execution-history.png');

  /* ---------------- M1-2：侧栏按目标分组 ---------------- */
  const sidebarView = await ev(`(() => {
    const toggle = [...document.querySelectorAll('.side-icon')].find(node => (node.getAttribute('title') ?? '').includes('目标'));
    const groups = [...document.querySelectorAll('.goal-group')];
    return {
      toggleFound: Boolean(toggle),
      togglePressed: toggle?.getAttribute('aria-pressed') ?? null,
      groupCount: groups.length,
      groupHeads: groups.map(group => (group.querySelector('.goal-head')?.textContent ?? '').trim().slice(0, 90)),
      unboundShown: groups.some(group => (group.textContent ?? '').includes('未绑定目标'))
    };
  })()`);
  evidence.sidebarProjection = sidebarView;
  note('ui-goal-toggle-present', sidebarView.toggleFound === true, `aria-pressed=${String(sidebarView.togglePressed)}`);
  note('ui-goal-groups-rendered', sidebarView.groupCount >= 1, `分组 ${String(sidebarView.groupCount)} 个`);
  // 退回开关：关掉分组必须回到平铺。
  const flatView = await ev(`(() => {
    const toggle = [...document.querySelectorAll('.side-icon')].find(node => (node.getAttribute('title') ?? '').includes('目标'));
    if (!toggle) return { clicked: false };
    toggle.click();
    return { clicked: true };
  })()`);
  await sleep(700);
  const afterToggle = await ev(`(() => ({
    groupCount: document.querySelectorAll('.goal-group').length,
    items: document.querySelectorAll('.task-item').length
  }))()`);
  note('ui-goal-grouping-toggle-back', flatView.clicked === true && afterToggle.groupCount === 0 && afterToggle.items >= 1,
    `关分组后 goal-group=${String(afterToggle.groupCount)} task-item=${String(afterToggle.items)}`);
  await ev(`(() => {
    const toggle = [...document.querySelectorAll('.side-icon')].find(node => (node.getAttribute('title') ?? '').includes('目标'));
    if (toggle) toggle.click();
    return true;
  })()`);
  await sleep(500);
  const goalOfProbe = await ev(`window.agentAPI.getTask(${JSON.stringify(taskId)}).then(task => ({ goalId: task.goalId ?? null, goalVersion: task.goalVersion ?? null, title: task.title ?? '' }))`, 30000);
  evidence.probeGoal = goalOfProbe;

  /* ---------------- M1-2 目标实体化：在同一个目标下再建一条任务 ---------------- */
  await openTab('对话');
  await sleep(900);
  /**
   * 「在此目标下新建任务」要求这一轮真的有一个可用的规划源，探法按设置里的执行档：
   * 网页 / 混合档探内嵌页面（没就绪就 reload 一次再等它加载完），云端 / 本地档探
   * 执行档点名的模型 / CLI 通道。网页源不能被别的档借用（AGENTS.md §9.1）——
   * 上一轮真机就是在这里吃到「ChatGPT 未登录：页面尚未加载」，而执行档其实是云端档，
   * 那条链根本没资格去问网页。webview 从没创建过也不等于没登录，所以要探一次。
   */
  const defaults = await ev(`window.agentAPI.getExecutionDefaults().catch(() => null)`, 20000).catch(() => null);
  const plannerMode = defaults?.executionMode ?? 'web';
  const plannerSelected = [
    ...(defaults?.selectedCloudModels ?? []),
    ...(defaults?.selectedLocalModels ?? []),
    ...(defaults?.selectedCliAgents ?? [])
  ];
  const plannerWebLed = plannerMode === 'web' || plannerMode === 'hybrid';
  note('planner-mode', true, `${plannerMode}（点名 ${plannerSelected.length > 0 ? plannerSelected.join('、') : '未点名，按该类可用源'}）`);
  const plannerReady = async () => plannerWebLed
    ? ev(`window.agentAPI.getDeepSeekStatus().catch(err => ({ detail: String(err) }))`, 30000)
      .then(status => (status?.pageReady && status?.loggedIn ? status : null))
      .catch(() => null)
    // 模型源不在「通道状态」里（那份名单只有网页通道 + CLI），云端 / 本地档要探的是
    // 辩论候选：它把网页、Provider、CLI 都按 id 真探一次 available，正对应「这一轮能不能真的问它」。
    : ev(`window.agentAPI.getExecutionOptions().then(o => (o.debateCandidates ?? []).filter(c => c.available).map(c => ({ id: c.id, label: c.label, type: c.type })))`, 90000)
      .then(list => (list ?? []).find(c => plannerSelected.length === 0
        || plannerSelected.includes(c.id)
        || plannerSelected.includes(c.id.replace(/^cli:/, ''))) ?? null)
      .catch(() => null);
  let plannerStatus = await plannerReady();
  const plannerReloaded = plannerWebLed && !plannerStatus;
  if (plannerWebLed && !plannerStatus) {
    await ev(`window.agentAPI.reloadPage()`, 90000).catch(() => null);
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !plannerStatus) {
      await sleep(2000);
      plannerStatus = await plannerReady();
    }
  }
  const plannerRaw = plannerWebLed
    ? await ev(`window.agentAPI.getDeepSeekStatus().catch(err => ({ detail: String(err) }))`, 30000).catch(() => null)
    : plannerStatus;
  evidence.plannerStatus = plannerRaw;
  evidence.plannerMode = { mode: plannerMode, selected: plannerSelected, webLed: plannerWebLed };
  evidence.plannerReloaded = plannerReloaded;
  const canBind = Boolean(plannerStatus);
  note('planner-page-ready-for-binding', canBind,
    canBind
      ? `${plannerWebLed ? '网页通道' : '执行档源'}就绪：${plannerRaw?.label ?? plannerRaw?.url ?? 'ok'}（reload=${String(plannerReloaded)}）`
      : `未就绪：${JSON.stringify(plannerRaw ?? { mode: plannerMode, selected: plannerSelected })?.slice(0, 160)}`);
  const SECOND_MARK = `${PROBE_MARK} 同目标`;
  const entryView = canBind ? await ev(`(() => {
    const card = document.querySelector('.goal-contract-card');
    const button = card ? [...card.querySelectorAll('button')].find(node => (node.textContent ?? '').includes('在此目标下新建任务')) : null;
    if (!button) return { found: false, buttons: card ? [...card.querySelectorAll('button')].map(node => (node.textContent ?? '').trim()) : null };
    button.click();
    return { found: true };
  })()`) : { found: false, skipped: '规划页面未就绪' };
  // React 的展开与受控值都是异步的：点完当场查 DOM 只会拍到旧的那颗按钮，
  // 按钮在文本落进 state 之前还是 disabled，立刻 click 等于没提交。
  const formView = canBind ? await waitFor(async () => {
    const view = await ev(`(() => {
      const node = document.querySelector('.goal-contract-card textarea[aria-label="这条新任务要做什么"]');
      if (!node) return { hasTextarea: false };
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(node, ${JSON.stringify(`${SECOND_MARK}：只回答上一轮执行历史是否已记录，不要修改任何文件。`)});
      node.dispatchEvent(new Event('input', { bubbles: true }));
      const submit = [...(document.querySelector('.goal-contract-card')?.querySelectorAll('button') ?? [])]
        .find(item => (item.textContent ?? '').trim() === '在目标下新建任务');
      return { hasTextarea: true, submitFound: Boolean(submit), submitDisabled: submit?.disabled ?? null };
    })()`);
    return view?.hasTextarea === true && view?.submitDisabled === false ? view : null;
  }, '新建任务表单展开且提交按钮可用', 20000).catch(() => null) : null;
  note('ui-create-in-goal-entry', entryView?.found === true && formView?.hasTextarea === true,
    JSON.stringify({ entry: entryView, form: formView }).slice(0, 200));
  // 取图取在表单展开这一刻：提交后卡片会收起，再截就拍不到「在此目标下新建任务」的入口了。
  if (canBind && formView?.hasTextarea === true) await shot('05-create-in-goal.png');
  const submitted = canBind ? await ev(`(() => {
    const card = document.querySelector('.goal-contract-card');
    const button = card ? [...card.querySelectorAll('button')].find(node => (node.textContent ?? '').trim() === '在目标下新建任务') : null;
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`) : false;
  note('ui-create-in-goal-submitted', submitted === true, String(submitted));
  const second = canBind ? await waitFor(async () => {
    const list = await ev(`window.agentAPI.getTaskHistory()`, 30000).catch(() => []);
    return (list ?? []).find(item => item.taskId !== taskId && String(item.title ?? '').includes(SECOND_MARK)) ?? null;
  }, '目标下新建的任务出现在历史里', 90000).catch(() => null) : null;
  const createError = await ev(`(() => {
    const el = document.querySelector('.goal-contract-card .collab-result-open');
    return el ? (el.textContent ?? '').trim() : '';
  })()`);
  const secondTaskId = second?.taskId ?? null;
  evidence.secondTaskId = secondTaskId;
  if (!secondTaskId) {
    note('live-two-tasks-one-goal', false,
      canBind ? `界面新建任务没成功：${createError || '历史里没出现新任务'}` : `执行档点名的规划源未就绪，未尝试提交：${JSON.stringify(plannerRaw ?? { mode: plannerMode, selected: plannerSelected }).slice(0, 140)}`);
    remark('「在此目标下新建任务」这条路在真机上没走通，M1-2 的「同一 Goal 下 ≥2 Task」仍未取得现场证据。');
  } else {
    // 两条任务在同一刻各读一份，基准取目标实体（读不到再退到第一条的契约）：
    // 上一轮拿「第一条的 goalCriteria」当基准，判成 0 条不一致，其实是基准选错了。
    const readGoal = id => ev(`window.agentAPI.getTask(${JSON.stringify(id)}).then(task => ({
      goalId: task.goalId ?? null,
      goalVersion: task.goalVersion ?? null,
      goalCriteria: task.goalCriteria ?? null,
      contractCriteria: (task.goalContract?.criteria ?? []).map(item => item.description),
      status: String(task.status)
    }))`, 30000);
    const [bound, firstNow] = await Promise.all([readGoal(secondTaskId), readGoal(taskId)]);
    evidence.secondTaskBinding = bound;
    evidence.firstTaskAtBind = firstNow;
    note('live-two-tasks-one-goal', true, `第二条 ${secondTaskId} 挂在 ${String(bound?.goalId ?? '-')} 下`);
    note('second-task-inherits-goal', bound?.goalId === goalOfProbe.goalId,
      `${String(bound?.goalId ?? '-')} vs 第一条 ${String(goalOfProbe.goalId ?? '-')}`);
    note('second-task-inherits-version', (bound?.goalVersion ?? 0) >= (goalOfProbe.goalVersion ?? 1),
      `第二条 v${String(bound?.goalVersion ?? '-')} / 目标 v${String(goalOfProbe.goalVersion ?? '-')}`);
    // M1-2 的口径是「新任务沿用目标当时的标准」，基准得是目标本身：第一条是目标的来源，
    // 它的标准存在契约里（`task.goalCriteria` 只在「绑定到既有目标」时才写，见 orchestrator.ts:412），
    // 拿第一条那个空字段当基准是在验设想而不是验行为。「两条不能各留一套标准」留到确认扇出后验
    // （`fan-out-shares-criteria`），那才是必须相同的地方。
    const goalEntityAtBind = (() => {
      try {
        const goals = JSON.parse(fs.readFileSync(STORE, 'utf8')).goals ?? [];
        return goals.find(item => item.goalId === goalOfProbe.goalId) ?? null;
      } catch { return null; }
    })();
    const inheritBaseline = goalEntityAtBind?.criteria ?? firstNow?.contractCriteria ?? [];
    evidence.goalEntityAtBind = goalEntityAtBind;
    note('second-task-inherits-criteria',
      JSON.stringify(bound?.goalCriteria ?? []) === JSON.stringify(inheritBaseline),
      `第二条 ${JSON.stringify(bound?.goalCriteria ?? [])} / 目标当时 ${JSON.stringify(inheritBaseline)}（第一条快照字段 ${JSON.stringify(firstNow?.goalCriteria ?? null)}，标准在它的契约里 ${String(firstNow?.contractCriteria?.length ?? 0)} 条）`);
    // 绑定证据已到手，立刻停掉第二条的规划：两个任务抢同一个页面没有意义。
    await ev(`window.agentAPI.cancelTask(${JSON.stringify(secondTaskId)})`, 30000).catch(() => null);
  }
  const groupView = await ev(`(() => {
    const mark = ${JSON.stringify(PROBE_MARK)};
    const groups = [...document.querySelectorAll('.goal-group')];
    const hit = groups.find(group => (group.textContent ?? '').includes(mark));
    return {
      groupCount: groups.length,
      items: hit ? [...hit.querySelectorAll('.task-item')].map(node => (node.textContent ?? '').trim().slice(0, 40)) : []
    };
  })()`);
  evidence.goalGroupAfterBind = groupView;
  note('ui-goal-group-has-two-tasks', (groupView.items ?? []).length >= 2,
    `分组里 ${String(groupView.items?.length ?? 0)} 条：${JSON.stringify(groupView.items ?? [])}`);
  // 分组证据要拍「同一目标下真有两条任务」这一刻；上一轮这张拍在只有一条任务的时刻，
  // 结果和统计页那张字节完全相同，等于没有独立证据。
  await shot('02-sidebar-goal-grouping.png');
  // 新建任务把活动任务切到了第二条，后面的 M1-3 断言全部针对第一条，必须切回去。
  const reselected = await ev(`(() => {
    const title = ${JSON.stringify(goalOfProbe.title)};
    const nodes = [...document.querySelectorAll('.task-item')];
    const target = nodes.find(node => {
      const text = node.textContent ?? '';
      return text.includes(title) && !text.includes(${JSON.stringify(SECOND_MARK)});
    });
    if (!target) return false;
    target.click();
    return true;
  })()`);
  note('ui-reselected-first-probe', reselected === true, `按标题「${goalOfProbe.title}」回选`);
  await sleep(800);
  const sharedGoal = await ev(`window.agentAPI.getTaskHistory().then(list => {
    const byGoal = new Map();
    for (const item of list) { const key = item.goalId ?? '(none)'; byGoal.set(key, (byGoal.get(key) ?? 0) + 1); }
    return [...byGoal.entries()].filter(([, count]) => count > 1);
  })`, 30000);
  evidence.tasksSharingGoal = sharedGoal;
  if ((sharedGoal ?? []).length === 0) {
    remark('历史里没有任何两条任务共用一个 goalId：目标实体化后的绑定链路没在真机上产生分组，M1-2 的同目标条件未达成。');
    note('live-goal-grouping-has-binding', false, '无同目标多任务');
  } else {
    note('live-goal-grouping-has-binding', true, JSON.stringify(sharedGoal));
  }

  /* ---------------- M1-3：目标变更影响面确认 ---------------- */
  await openTab('对话');
  await sleep(600);
  // 基线口径以契约里的 Criterion 为准（orchestrator 也这么比）：直接交两份自拟标准
  // 会被判成「删掉了契约已有标准」= change，验的就不是「补充不抬版本」这条路了。
  const contractCriteria = await ev(`window.agentAPI.getTask(${JSON.stringify(taskId)}).then(task => (task?.goalContract?.criteria ?? []).map(item => item.description))`, 30000);
  evidence.contractCriteriaBeforeBaseline = contractCriteria;
  note('contract-criteria-read', Array.isArray(contractCriteria) && contractCriteria.length >= 1,
    `${String(contractCriteria?.length ?? 0)} 条：${JSON.stringify(contractCriteria?.slice(0, 2))}`);

  const baseline = await ev(`window.agentAPI.reviseTaskGoal(${JSON.stringify({
    taskId,
    nextCriteria: [...contractCriteria, '第 2 次执行的事实不被第 1 次覆盖'],
    userConfirmedChange: false
  })})`, 60000);
  evidence.baselineRevision = baseline;
  note('append-criteria-is-clarify', baseline?.kind === 'clarify' && baseline?.requiresUserConfirmation === false,
    `kind=${String(baseline?.kind ?? '-')} requires=${String(baseline?.requiresUserConfirmation ?? '-')} version=${String(baseline?.nextVersion ?? '-')}`);
  const taskAfterBaseline = await state();
  evidence.goalVersionAfterBaseline = taskAfterBaseline?.goalVersion ?? null;
  note('version-not-bumped-on-clarify', taskAfterBaseline?.goalVersion === goalOfProbe.goalVersion,
    `补充后 v${String(taskAfterBaseline?.goalVersion ?? '-')} / 原来 v${String(goalOfProbe.goalVersion ?? '-')}`);

  const pendingPlan = await ev(`window.agentAPI.reviseTaskGoal(${JSON.stringify({
    taskId, nextCriteria: contractCriteria.slice(0, 1), userConfirmedChange: false
  })})`, 60000);
  evidence.pendingPlan = pendingPlan;
  note('removal-requires-confirmation', pendingPlan?.requiresUserConfirmation === true,
    `kind=${String(pendingPlan?.kind ?? '-')} impacted=${String((pendingPlan?.impactedTaskIds ?? []).length)}`);
  const taskAfterPending = await state();
  note('version-unchanged-before-confirm', taskAfterPending?.goalVersion === goalOfProbe.goalVersion,
    `确认前 v${String(taskAfterPending?.goalVersion ?? '-')} / 基线 v${String(goalOfProbe.goalVersion ?? '-')}`);

  const pendingEvents = (await events()).filter(event => event.type === 'goal.revision.pending');
  const lastPending = pendingEvents[pendingEvents.length - 1] ?? null;
  evidence.pendingEvent = lastPending;
  note('structured-event-emitted', Boolean(lastPending),
    lastPending ? `reason=${lastPending.reason} impacted=${String((lastPending.impactedTaskIds ?? []).length)} next=v${String(lastPending.nextVersion)}` : '没有 goal.revision.pending 事件');
  assert.ok(lastPending, '没有发出 goal.revision.pending');

  const cardView = await ev(`(() => {
    const card = document.querySelector('.goal-revision-confirm');
    if (!card) return { found: false };
    const list = card.querySelector('.grc-impacted');
    const stepRows = list ? [...list.querySelectorAll('li:not(.grc-structural)')] : [];
    return {
      found: true,
      head: (card.querySelector('.card-head')?.textContent ?? '').trim(),
      reason: (card.querySelector('.grc-reason')?.textContent ?? '').trim(),
      summary: (card.querySelector('.grc-impact-summary')?.textContent ?? '').trim(),
      criteria: [...card.querySelectorAll('.grc-criteria li')].map(node => node.textContent ?? ''),
      impacted: stepRows.map(node => (node.querySelector('.grc-impacted-title')?.textContent ?? '').trim()),
      structural: (card.querySelector('.grc-structural')?.textContent ?? '').trim(),
      goalTasks: (card.querySelector('.grc-goal-tasks')?.textContent ?? '').trim(),
      buttons: [...card.querySelectorAll('button')].map(node => (node.textContent ?? '').trim())
    };
  })()`);
  evidence.confirmCard = cardView;
  note('ui-confirm-card-visible', cardView.found === true, JSON.stringify(cardView.head ?? null));
  note('ui-card-lists-criteria-and-impact', cardView.found === true && cardView.criteria.length >= 1,
    `标准 ${String(cardView.criteria?.length ?? 0)} 条 / 步骤 ${String(cardView.impacted?.length ?? 0)} 条`);
  // 折叠后的口径必须还能对上账：汇总数字是事件原文，步骤 + 任务级节点 = 它。
  const structuralFromEvent = (lastPending.impactedTasks ?? []).filter(item => /^wt-(work|group)-/.test(item.workTaskId));
  const stepsFromEvent = (lastPending.impactedTasks ?? []).length - structuralFromEvent.length;
  const summaryNumbers = /受影响 (\d+) 条：\s*可执行步骤 (\d+) 条，任务级节点 (\d+) 条/.exec(cardView.summary ?? '');
  const reconciles = summaryNumbers !== null
    && Number(summaryNumbers[1]) === (lastPending.impactedTaskIds ?? []).length
    && Number(summaryNumbers[2]) === stepsFromEvent
    && Number(summaryNumbers[3]) === structuralFromEvent.length;
  note('ui-card-impact-count-reconciles', reconciles, `${cardView.summary ?? '没有分账行'} / 事件 impacted=${String((lastPending.impactedTaskIds ?? []).length)}`);
  note('ui-card-folds-structural-nodes', (cardView.structural ?? '').includes('任务级节点') && structuralFromEvent.length > 0,
    `${cardView.structural || '没有折叠行'}｜步骤行 ${JSON.stringify(cardView.impacted ?? [])}`);
  // 汇总节点不该再顶着一行「执行计划」混在步骤里。
  note('ui-card-steps-free-of-aggregate-rows', (cardView.impacted ?? []).every(title => title !== '执行计划'),
    JSON.stringify(cardView.impacted ?? []));
  // M1-2：确认卡必须说出「确认后同目标哪些任务一起生效」，否则用户以为只改了自己这一条。
  const eventGoalTasks = (lastPending.goalTasks ?? []).map(item => item.taskId);
  note('event-carries-goal-tasks', eventGoalTasks.length >= (secondTaskId ? 2 : 1),
    `${String(eventGoalTasks.length)} 条：${JSON.stringify(lastPending.goalTasks ?? null)}`);
  note('ui-card-lists-goal-tasks', secondTaskId
    ? (cardView.goalTasks ?? '').includes('条任务一起生效') && (cardView.goalTasks ?? '').includes(SECOND_MARK)
    : (cardView.goalTasks ?? '').includes('条任务一起生效'),
    cardView.goalTasks || '确认卡没有同目标一行');
  await shot('03-goal-revision-pending.png');

  const confirmed = await ev(`(() => {
    const card = document.querySelector('.goal-revision-confirm');
    const button = card ? [...card.querySelectorAll('button')].find(node => (node.textContent ?? '').includes('确认变更')) : null;
    if (!button) return false;
    button.click();
    return true;
  })()`);
  note('ui-confirm-clicked', confirmed === true, String(confirmed));
  const bumped = await waitFor(async () => {
    const task = await state();
    return (task?.goalVersion ?? 0) >= lastPending.nextVersion ? task : null;
  }, '确认后目标版本抬起', 120000);
  evidence.goalVersionAfterConfirm = bumped?.goalVersion ?? null;
  note('version-bumped-after-confirm', Boolean(bumped), `v${String(bumped?.goalVersion ?? '-')}`);
  // 目标实体化：确认后同目标的任务要一起抬版本并共用同一份标准，只动被点的那条不算生效。
  const sibling = secondTaskId
    ? await waitFor(async () => {
        const view = await ev(`window.agentAPI.getTask(${JSON.stringify(secondTaskId)}).then(task => ({
          goalVersion: task.goalVersion ?? null,
          goalCriteria: task.goalCriteria ?? null
        }))`, 30000).catch(() => null);
        return Number(view?.goalVersion ?? 0) >= lastPending.nextVersion ? view : null;
      }, '同目标第二条任务一起抬版本', 60000).catch(() => null)
    : null;
  evidence.siblingVersionAfterConfirm = sibling?.goalVersion ?? null;
  evidence.siblingCriteriaAfterConfirm = sibling?.goalCriteria ?? null;
  note('fan-out-bumps-sibling-task', secondTaskId ? Number(sibling?.goalVersion ?? 0) >= lastPending.nextVersion : false,
    secondTaskId
      ? `第二条 v${String(sibling?.goalVersion ?? '-')} / 应为 v${String(lastPending.nextVersion)}`
      : '没有第二条同目标任务，扇出无从验证');
  // 扇出抬版本之外，成功标准也必须是同一份：只改版本号、两条各留一套标准，
  // 目标聚合视图就成了假的。
  note('fan-out-shares-criteria', secondTaskId
    ? JSON.stringify(sibling?.goalCriteria ?? null) === JSON.stringify(bumped?.goalCriteria ?? null)
      && (bumped?.goalCriteria ?? []).length >= 1
    : false,
  `第二条 ${JSON.stringify(sibling?.goalCriteria ?? [])} / 第一条 ${JSON.stringify(bumped?.goalCriteria ?? [])}`);
  const storedGoal = (() => {
    try {
      const goals = JSON.parse(fs.readFileSync(STORE, 'utf8')).goals ?? [];
      return goals.find(item => item.goalId === goalOfProbe.goalId) ?? null;
    } catch { return null; }
  })();
  evidence.storedGoal = storedGoal;
  note('goal-entity-persisted', Boolean(storedGoal) && Number(storedGoal?.version ?? 0) >= lastPending.nextVersion && (storedGoal?.criteria?.length ?? 0) >= 1,
    JSON.stringify(storedGoal ?? null).slice(0, 220));
  const afterEvents = await events();
  evidence.contractUpdatedAfterConfirm = afterEvents.some(event => event.type === 'goal.contract.updated');
  evidence.reupsertedAfterConfirm = afterEvents.filter(event => event.type === 'work.task.upserted').length;
  await sleep(1200);
  const cardGone = await ev(`(() => document.querySelector('.goal-revision-confirm') === null)()`);
  note('card-dismissed-after-confirm', cardGone === true, `刷新后仍在=${String(!cardGone)}`);
  await openTab('对话');
  await sleep(500);
  await shot('04-goal-revision-confirmed.png');
}

/** 不管前面走到哪一步，探针都得从用户的数据目录里消失。 */
async function cleanup() {
  const ids = [...new Set([taskId, ...storeTasks().filter(item => String(item.title ?? '').includes(PROBE_MARK)).map(item => item.taskId)].filter(Boolean))];
  for (const id of ids) {
    if (cdp) {
      await ev(`window.agentAPI.cancelTask(${JSON.stringify(id)})`, 30000).catch(() => null);
      await ev(`window.agentAPI.deleteTask(${JSON.stringify(id)})`, 30000).catch(() => null);
    }
  }
  await sleep(1200);
  const remaining = taskIds();
  evidence.taskIdsAfter = remaining;
  const leftover = ids.filter(id => remaining.includes(id));
  if (leftover.length === 0 && (evidence.taskIdsBefore?.length ?? 0) === remaining.length) {
    probeDeleted = true;
    note('probe-task-deleted', true, `before=${String(evidence.taskIdsBefore?.length ?? '?')} after=${String(remaining.length)}`);
  } else {
    note('probe-task-deleted', false, `残留 ${leftover.join(',') || '无'}；任务数 before=${String(evidence.taskIdsBefore?.length ?? '?')} after=${String(remaining.length)}`);
    if (leftover.length > 0) {
      evidence.diskLeftover = leftover;
      remark(`探针任务未能经界面删除（残留 ${leftover.join(', ')}）：需手工从默认数据目录清掉，本次验收对用户数据目录有遗留影响。`);
    }
  }
}

try {
  await phases();
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(`FAIL ${evidence.error}`);
} finally {
  try { await cleanup(); } catch (error) { evidence.cleanupError = error instanceof Error ? error.message : String(error); }
  evidence.finishedAt = new Date().toISOString();
  if (cdp) { try { await cdp.send('Browser.close', {}, 5000); } catch { /* 已断开 */ } }
  await stopDev();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  const lines = [
    '# V4 P1 M1 真机验收：执行历史 / 目标实体化与分组 / 目标变更影响面',
    '',
    '- 启动方式：' + evidence.mode,
    '- 数据目录：默认 `~/Library/Application Support/thinkfusion-ai`（未提供 THINKFUSION_USER_DATA，未复制用户数据）',
    `- 探针任务：${evidence.taskId ?? '未创建'}${evidence.secondTaskId ? ` + 目标下新建 ${evidence.secondTaskId}` : ''}（验收后删除；任务数 ${String(evidence.taskIdsBefore?.length ?? '?')} → ${String(evidence.taskIdsAfter?.length ?? '?')}）`,
    '',
    '## 结果',
    '',
    ...Object.entries(evidence.checks).map(([key, value]) => `- ${key}：${value.ok ? '通过' : '失败'} — ${value.detail ?? '无'}`),
    '',
    '## 执行台账（界面所见 = 投影所得）',
    '',
    '```json',
    JSON.stringify(evidence.executions, null, 2),
    '```',
    '',
    '## 状态序列',
    '',
    evidence.statusSequence.join(' → ') || '未采集',
    '',
    '## 脚本推动循环的记录',
    '',
    '```json',
    JSON.stringify(evidence.loopActions, null, 2),
    '```',
    '',
    '## 待确认事件原文',
    '',
    '```json',
    JSON.stringify(evidence.pendingEvent, null, 2),
    '```',
    '',
    '## 目标实体化（M1-2：同目标多任务）',
    '',
    // 新建任务这条必须按执行档挑源，不能悄悄退回网页（AGENTS.md §9.1）。
    `- 这一轮的执行档：${JSON.stringify(evidence.plannerMode ?? null)}；就绪的规划源：${JSON.stringify(evidence.plannerStatus ?? null).slice(0, 220)}`,
    `- 第一条任务的目标：${JSON.stringify(evidence.probeGoal ?? null)}`,
    `- 界面「在此目标下新建任务」产生：${evidence.secondTaskId ?? '未产生'}，绑定 ${JSON.stringify(evidence.secondTaskBinding ?? null)}`,
    `- 侧栏分组内容：${JSON.stringify(evidence.goalGroupAfterBind ?? null)}`,
    `- 绑定时两条的快照：第一条 ${JSON.stringify(evidence.firstTaskAtBind ?? null).slice(0, 200)} / 第二条 ${JSON.stringify(evidence.secondTaskBinding ?? null).slice(0, 200)}`,
    `- 绑定时目标实体（继承基准）：${JSON.stringify(evidence.goalEntityAtBind ?? 'store 里还没落盘，改用第一条契约标准')}`,
    `- 确认后第二条：v${String(evidence.siblingVersionAfterConfirm ?? '未同步')}，标准 ${JSON.stringify(evidence.siblingCriteriaAfterConfirm ?? null)}`,
    `- 落库目标实体 \`store.goals\`：${JSON.stringify(evidence.storedGoal ?? null)}`,
    '',
    '## 说明与未覆盖项',
    '',
    ...(evidence.notes.length > 0 ? evidence.notes.map(item => `- ${item}`) : ['- 无']),
    '',
    ...(evidence.error ? ['## 错误', '', evidence.error, ''] : [])
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'EVIDENCE.md'), lines.join('\n'));
  const failed = Object.values(evidence.checks).filter(item => !item.ok);
  process.exitCode = evidence.error || failed.length > 0 ? 1 : 0;
}
