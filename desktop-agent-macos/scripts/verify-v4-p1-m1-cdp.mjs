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
 *   验证 goal.revision.pending 事件、确认卡与确认后的版本抬升。
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
  await shot('02-sidebar-goal-grouping.png');
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
  const goalOfProbe = await ev(`window.agentAPI.getTask(${JSON.stringify(taskId)}).then(task => ({ goalId: task.goalId ?? null, goalVersion: task.goalVersion ?? null }))`, 30000);
  evidence.probeGoal = goalOfProbe;
  const sharedGoal = await ev(`window.agentAPI.getTaskHistory().then(list => {
    const byGoal = new Map();
    for (const item of list) { const key = item.goalId ?? '(none)'; byGoal.set(key, (byGoal.get(key) ?? 0) + 1); }
    return [...byGoal.entries()].filter(([, count]) => count > 1);
  })`, 30000);
  evidence.tasksSharingGoal = sharedGoal;
  if ((sharedGoal ?? []).length === 0) {
    remark('现网数据里没有任何两条任务共用一个 goalId：代码里没有把新任务绑到既有 goalId 的写入路径（task-manager.create 一律写 goal:<taskId>）。M1-2 的「同一 Goal 下 ≥2 Task」真机条件在当前版本无法由界面产生，只验到分组渲染与退回开关。');
    note('live-two-tasks-one-goal', false, '无写入路径可产生同目标多任务');
  } else {
    note('live-two-tasks-one-goal', true, JSON.stringify(sharedGoal));
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
    '# V4 P1 M1 真机验收：执行历史 / 目标分组 / 目标变更影响面',
    '',
    '- 启动方式：' + evidence.mode,
    '- 数据目录：默认 `~/Library/Application Support/thinkfusion-ai`（未提供 THINKFUSION_USER_DATA，未复制用户数据）',
    `- 探针任务：${evidence.taskId ?? '未创建'}（验收后删除；任务数 ${String(evidence.taskIdsBefore?.length ?? '?')} → ${String(evidence.taskIdsAfter?.length ?? '?')}）`,
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
