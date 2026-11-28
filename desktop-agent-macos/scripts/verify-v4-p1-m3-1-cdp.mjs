/**
 * M3-1 真机验收：一个真实任务连跑两轮，每轮判定的 `cycle.decision.created` 都带全字段，
 * 并且「事件里说的落点」与「编排器实际做的事」出自同一处判定。
 *
 * 默认数据目录（AGENTS.md §10.2），不隔离、不复制用户数据；探针任务收尾删除，
 * 动磁盘前先把 agent-store.json 备进验收目录。
 *
 * 四层判据（少一层都说明双轨没并干净）：
 * 1) 字段完整：decisionType / reason / evidenceRefs / nextAction / requiresUser /
 *    targetStage / diagnosis / progress / goalFit / budget 全在场。reason 不能是标签复述；
 *    evidenceRefs 要能追到这一轮报告——`file:` 在磁盘上真的存在、`cmd:` 的退出码与报告里
 *    那一步一致、`evidence:` 的每一段（任务 / 轮次 / 标准）都能在事件流里对上真实存在的对象，
 *    并且至少一条出自本轮（跨轮引用是目标证据累计，不是复述上一轮结论）。
 *    旧裸枚举手写映射时代只有 decision + reason。
 * 2) 同源不变量：`requiresUser === (nextAction === 'stop_and_wait')`；紧随其后的
 *    `cycle.snapshot` 的 decision 必须等于 `legacyDecisionOf(decisionType)`、非收尾时
 *    nextAction 必须逐字等于事件的 reason。这两条一分叉，就是「事件说 A、代码判 B」回来了。
 * 3) 落点与行为对得上：open_next_round 之后必须真的出现新的 round.started；
 *    finish_completed 之后必须出现 task.completed；stop_and_wait 之后不得有新轮，
 *    且日志那句「GDC 停在待确认」要原样引用事件 reason。
 * 4) 反算一致：progress 用事件里的上一份 + 本轮报告的证据指纹 + 未满足标准集合重算一遍，
 *    必须与事件记录逐字段相同（这条同时证明判定状态确实存进了事件、重启后能接着算）。
 *
 * 枚举成员不写死在脚本里：从 `src/shared/cycle-decision.ts` 现读联合类型成员，
 * 事件里出现源码没有的值才算失败。
 *
 * 事件流 diff 存证：两次判定各自的完整事件序列落盘，`diff -u` 结果一并留在验收目录。
 *
 * Run: node scripts/verify-v4-p1-m3-1-cdp.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, sleep } from './lib/cdp.mjs';
// 判据用产品同一份口径：枚举、旧标签映射、判定句与指纹函数都不在脚本里重抄。
import {
  CYCLE_NEXT_ACTION_TEXT,
  cycleFingerprint,
  detectNoProgress,
  legacyDecisionOf,
  openCriteriaKey
} from '../out-test/shared/cycle-decision.js';
import {
  cycleDecisionText,
  latestCycleDecision,
  projectGoalDrivenWorkbench
} from '../out-test/shared/goal-driven-cycle.js';
import { evidenceFacts } from '../out-test/shared/repair-loop.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '..', 'docs', 'implementation', 'acceptance', 'v4-p1-m3-1-20261128');
const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai');
const STORE = path.join(USER_DATA, 'agent-store.json');
const LOG = path.join(OUT_DIR, 'dev.log');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ENDPOINT = `http://127.0.0.1:${PORT}/json`;
const WORKSPACE = path.join(os.tmpdir(), `tf-m3-1-ws-${String(Date.now())}`);
const PROBE = 'M3-1 两轮判定探针';
/** 这一条完成条件轮次一必然满足不了（固定工作流不写 REPORT.md），用来把任务逼进第二轮。 */
const COMPLETION = '工作区里同时存在 d1/a.txt、d2/b.txt 与 REPORT.md，且 REPORT.md 记录了两次校验输出';
const WAIT_DECISION_1 = 25 * 60 * 1000;
const WAIT_DECISION_2 = 35 * 60 * 1000;

const sources = {
  cycleDecision: fs.readFileSync(path.join(ROOT, 'src/shared/cycle-decision.ts'), 'utf8')
};

/** 从源码里现读联合类型成员：脚本不另列一份枚举，改了源码不会漏改这里。 */
function unionMembers(name) {
  const match = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(sources.cycleDecision);
  if (!match) throw new Error(`cycle-decision.ts 里找不到 export type ${name}`);
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]));
}
const DECISION_TYPES = unionMembers('CycleDecisionType');
const NEXT_ACTIONS = unionMembers('CycleNextAction');
const DIAGNOSES = unionMembers('CycleDiagnosis');
const CYCLE_STAGES = unionMembers('GceCycleStage');

const evidence = {
  startedAt: new Date().toISOString(),
  mode: '默认数据目录 / ThinkFusion Dev / CDP 9333 / 同一进程内连跑两轮',
  workspace: WORKSPACE,
  completionCondition: COMPLETION,
  checks: {},
  shots: [],
  before: null,
  backups: null,
  staleProbes: [],
  probe: null,
  decisions: [],
  behavior: [],
  ui: null,
  diff: null,
  cleanup: [],
  error: null
};
let child = null;
let cdp = null;

function note(name, ok, detail) {
  evidence.checks[name] = { ok: Boolean(ok), detail: detail ?? null, at: new Date().toISOString() };
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function listenersOn(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .split('\n').map(item => item.trim()).filter(Boolean);
  } catch { return []; }
}

function readStore() {
  if (!fs.existsSync(STORE)) return { tasks: [] };
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}

function storeTask(taskId) {
  try {
    return (readStore().tasks ?? []).find(task => task.taskId === taskId) ?? null;
  } catch { return null; }
}

async function waitForPortFree(deadline) {
  while (Date.now() < deadline) {
    if (listenersOn(PORT).length === 0) return true;
    await sleep(400);
  }
  return false;
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

/** build=true 只在第一次：之后复用同一份编译产物，免得中途重编译把界面刷没。 */
async function startDev(build) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (build) {
    execFileSync('npm', ['run', 'build:agent'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('npm', ['run', 'build:test'], { cwd: ROOT, stdio: 'inherit' });
  }
  const log = fs.openSync(LOG, 'a');
  const env = { ...process.env };
  delete env.THINKFUSION_USER_DATA;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  child = spawn('npx', ['electron-vite', 'dev', '--noSandbox', '--remoteDebuggingPort', String(PORT)], {
    cwd: ROOT, env, detached: true, stdio: ['ignore', log, log]
  });
  child.unref();
}

async function stopDev(signal) {
  if (cdp) { try { cdp.close(); } catch { /* 已断开 */ } cdp = null; }
  if (!child?.pid) { await waitForPortFree(Date.now() + 20000); return; }
  try { process.kill(-child.pid, signal); } catch { /* 已退出 */ }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { process.kill(-child.pid, 0); } catch { child = null; break; }
    await sleep(300);
  }
  if (child) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
    child = null;
  }
  await waitForPortFree(Date.now() + 25000);
}

async function connectRenderer() {
  const deadline = Date.now() + 300000;
  let lastIssue = '没有匹配的 page 目标';
  while (Date.now() < deadline) {
    let targets = [];
    try {
      targets = await (await fetch(ENDPOINT)).json();
    } catch {
      await sleep(1000);
      continue;
    }
    const candidates = targets.filter(item => item.type === 'page'
      && (item.url.includes('localhost:5173') || item.url.includes('localhost:5174') || item.url.startsWith('file:')));
    if (candidates.length === 0) lastIssue = `目标里没有渲染页：${targets.map(item => item.type).join(',') || '空'}`;
    for (const candidate of candidates) {
      const probe = await connect(candidate).catch(error => {
        lastIssue = `连不上 ${candidate.url}：${error.message}`;
        return null;
      });
      if (!probe) continue;
      const ready = await waitFor(async () => {
        try { return await probe.evaluate('typeof window.agentAPI', 8000) === 'object' ? 'ready' : null; }
        catch (error) { lastIssue = `evaluate 失败：${error.message}`; return null; }
      }, `agentAPI 注入 ${candidate.url}`, 90000).catch(() => null);
      if (ready) {
        await probe.send('Page.enable', {}, 10000).catch(() => null);
        return probe;
      }
      probe.close();
    }
    await sleep(2000);
  }
  throw new Error(`没有找到注入 agentAPI 的渲染进程（${lastIssue}）`);
}

const ev = (expression, timeoutMs = 60000) => cdp.evaluate(expression, timeoutMs);

async function shot(name) {
  const buffer = Buffer.from(
    (await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000)).data,
    'base64'
  );
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, buffer);
  evidence.shots.push(path.relative(OUT_DIR, file));
}

async function openTab(label) {
  return ev(`(() => {
    const scope = document.querySelector('.wb-tabs') ?? document;
    const target = [...scope.querySelectorAll('button[role="tab"]')].find(node => (node.textContent ?? '').trim() === ${JSON.stringify(label)});
    if (!target) return false;
    target.click();
    return true;
  })()`);
}

async function scrollIntoView(selector) {
  return ev(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.scrollIntoView({ block: 'center' });
    return true;
  })()`);
}

async function selectTaskRow(...markers) {
  const list = markers.filter(marker => typeof marker === 'string' && marker.trim());
  const hit = await waitFor(async () => ev(`(() => {
    const markers = ${JSON.stringify(list)};
    const row = [...document.querySelectorAll('.task-item')].find(node => markers.some(marker =>
      (node.getAttribute('title') ?? '').includes(marker) ||
      (node.querySelector('.task-title')?.textContent ?? '').includes(marker)));
    if (!row) return null;
    row.click();
    return row.getAttribute('title') ?? row.textContent ?? '';
  })()`), `侧栏出现「${list[0]}」`, 30000).catch(() => null);
  if (!hit) return false;
  await sleep(800);
  return true;
}

/**
 * 读「工程目标」卡上那两行判定说法。
 *
 * 展开与读取必须同一次 evaluate：卡片是 `<details>`，收起时 innerText 取不到正文。
 */
async function goalCard() {
  if (!(await openTab('对话'))) {
    evidence.ui = { tabLabels: await ev(`(() => {
      const scope = document.querySelector('.wb-tabs');
      return scope ? [...scope.querySelectorAll('button[role="tab"]')].map(node => (node.textContent ?? '').trim()).join('|') : '没有 .wb-tabs';
    })()`).catch(() => 'evaluate 失败') };
    return { tabMissing: true };
  }
  return ev(`(() => {
    const card = document.querySelector('.goal-contract-card');
    if (!card) return null;
    card.open = true;
    const lines = [...card.querySelectorAll('p')].map(node => (node.innerText ?? '').replace(/\\s+/g, ' ').trim());
    return {
      decisionLine: lines.find(text => text.includes('最近一次周期判定')) ?? null,
      nextLine: lines.find(text => text.startsWith('当前阶段')) ?? null,
      fitLine: (card.querySelector('summary')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      charLen: card.innerText.length
    };
  })()`);
}

const getTask = id => ev(`window.agentAPI.getTask(${JSON.stringify(id)})`, 30000);
const taskEvents = id => ev(`window.agentAPI.getTaskEvents(${JSON.stringify(id)})`, 60000) ?? [];

/** 轮次一：写两份文件 + 一条通过的命令 + 一条必然失败的检查。 */
function probeNodes() {
  const w = file => path.join(WORKSPACE, file);
  return [
    { id: 'write-1', capabilityId: 'fs.writeFile', title: '写 d1/a.txt', args: { path: w('d1/a.txt'), content: 'M3-1 轮次一证据 A\n' } },
    { id: 'write-2', capabilityId: 'fs.writeFile', title: '写 d2/b.txt', args: { path: w('d2/b.txt'), content: 'M3-1 轮次一证据 B\n' } },
    { id: 'check-1', capabilityId: 'shell.run', title: '确认两份文件已落盘', args: { command: 'test -f d1/a.txt -a -f d2/b.txt && echo both-files-ok', cwd: WORKSPACE, timeoutMs: 30000 } },
    { id: 'check-2', capabilityId: 'shell.run', title: '确认 REPORT.md（本轮故意没有生成）', args: { command: 'test -f REPORT.md || { echo "REPORT.md 未生成"; exit 3; }', cwd: WORKSPACE, timeoutMs: 30000 } }
  ];
}

/** 逐字段审计一条判定事件；返回问题清单与核对到的事实。 */
function auditDecision(event, events, index) {
  const issues = [];
  const facts = { index, roundId: event.roundId, at: event.at };
  /** 判定「看到」的事件集合：只有此刻已落地的报告、契约与轮数才算它的输入。 */
  const upto = events.filter(item => item.at <= event.at);

  if (!DECISION_TYPES.has(event.decisionType)) issues.push(`decisionType 不在源码枚举里：${String(event.decisionType)}`);
  if (!NEXT_ACTIONS.has(event.nextAction)) issues.push(`nextAction 不在源码枚举里：${String(event.nextAction)}`);
  if (!CYCLE_STAGES.has(event.targetStage)) issues.push(`targetStage 不在源码枚举里：${String(event.targetStage)}`);
  if (!DIAGNOSES.has(event.diagnosis)) issues.push(`diagnosis 不在源码枚举里：${String(event.diagnosis)}`);

  // reason：必须是说得出理由的一句话，不能是标签或落点的复述。
  const reason = typeof event.reason === 'string' ? event.reason.trim() : '';
  facts.reason = reason;
  if (reason.length < 8) issues.push(`reason 太短：「${reason}」`);
  if ([event.decisionType, event.nextAction].includes(reason)) issues.push('reason 只是标签复述');

  if (typeof event.requiresUser !== 'boolean') issues.push(`requiresUser 不是布尔：${String(event.requiresUser)}`);
  else if (event.requiresUser !== (event.nextAction === 'stop_and_wait'))
    issues.push(`requiresUser=${String(event.requiresUser)} 与落点 ${event.nextAction} 不同源`);

  if (!Array.isArray(event.evidenceRefs)) issues.push(`evidenceRefs 不是数组：${JSON.stringify(event.evidenceRefs ?? null)}`);
  else if (event.evidenceRefs.length === 0) issues.push('evidenceRefs 是空数组（判定没有指向任何证据）');

  const progress = event.progress ?? null;
  facts.progress = progress;
  if (!progress || typeof progress !== 'object') issues.push(`progress 缺失：${JSON.stringify(progress)}`);
  else {
    if (typeof progress.fingerprint !== 'string' || progress.fingerprint === '') issues.push('progress.fingerprint 不是非空字符串');
    if (typeof progress.repeated !== 'number') issues.push(`progress.repeated 不是数字：${String(progress.repeated)}`);
    if (typeof progress.criterionStalled !== 'boolean') issues.push(`progress.criterionStalled 不是布尔：${String(progress.criterionStalled)}`);
  }

  const fit = event.goalFit === null ? null : event.goalFit;
  facts.goalFit = fit;
  if (fit && (typeof fit.fit !== 'string' || typeof fit.met !== 'number' || !Array.isArray(fit.blockingRisks)))
    issues.push(`goalFit 形状不完整：${JSON.stringify(fit)}`);
  if (!('goalFit' in event)) issues.push('事件里没有 goalFit 这个键');

  const budget = event.budget ?? null;
  facts.budget = budget;
  if (!budget || typeof budget !== 'object') issues.push(`budget 缺失：${JSON.stringify(budget)}`);
  else {
    if (typeof budget.atMaxRounds !== 'boolean') issues.push(`budget.atMaxRounds 不是布尔：${String(budget.atMaxRounds)}`);
    if (typeof budget.roundUsed !== 'number') issues.push(`budget.roundUsed 不是数字：${String(budget.roundUsed)}`);
    if (!('roundLimit' in budget)) issues.push('budget 里没有 roundLimit 键（拿不到要记 null，不能省）');
  }

  if (!event.cycleId || !event.workId || !event.taskId) issues.push('缺 cycleId / workId / taskId');

  // 证据可追性：每条 ref 都要能在本轮报告或磁盘上找到出处。
  const report = [...upto].reverse().find(item =>
    item.type === 'report.ready' && item.roundId === event.roundId)?.report ?? null;
  facts.reportStatus = report?.status ?? null;
  // 跨轮引用是合法的（目标证据按轮累计），但 id 的每一段都必须真实存在：
  // 轮次要能在事件流里找到 round.started，标准要能在目标契约里找到——否则就是拿编出来的串冒充出处。
  const knownRounds = new Set(upto.filter(item => item.type === 'round.started').map(item => item.roundId));
  const contractIds = new Set(
    ([...upto].reverse().find(item => item.type === 'goal.contract.updated')?.contract?.criteria ?? [])
      .map(item => item.criterionId)
  );
  const refs = Array.isArray(event.evidenceRefs) ? event.evidenceRefs : [];
  const traced = { file: 0, cmd: 0, url: 0, evidence: 0 };
  const unmatched = [];
  let ownRoundEvidence = 0;
  let crossRoundEvidence = 0;
  for (const ref of refs) {
    if (typeof ref !== 'string' || ref === '') { unmatched.push(String(ref)); continue; }
    if (ref.startsWith('file:')) {
      const target = ref.slice(5);
      const hit = path.isAbsolute(target) ? fs.existsSync(target)
        : fs.existsSync(path.join(WORKSPACE, target)) || fs.existsSync(target);
      if (hit) traced.file += 1; else unmatched.push(ref);
    } else if (ref.startsWith('cmd:')) {
      const cut = ref.lastIndexOf('#');
      const command = cut > 0 ? ref.slice(4, cut) : ref.slice(4);
      const exit = cut > 0 ? ref.slice(cut + 1) : '';
      const step = (report?.results ?? []).find(item =>
        String(item.args?.command ?? '').includes(command) || command.includes(String(item.args?.command ?? '\u0000')));
      if (!step) unmatched.push(ref);
      else {
        const reported = step.result && typeof step.result === 'object' ? step.result.exitCode : undefined;
        if (typeof reported === 'number' && exit !== String(reported)) unmatched.push(`${ref}（报告退出码 ${String(reported)}）`);
        else traced.cmd += 1;
      }
    } else if (ref.startsWith('url:')) traced.url += 1;
    else if (ref.startsWith('evidence:')) {
      // 形态：evidence:<taskId>:<roundId>:criterion:<taskId>:<plan|goal>:<kind>
      const seg = ref.split(':');
      const refRound = seg[2] ?? '';
      const refCriterion = seg[3] === 'criterion' ? `criterion:${seg[4] ?? ''}:${seg[5] ?? ''}` : '';
      const taskOk = seg[1] === event.taskId;
      const roundOk = knownRounds.has(refRound);
      const criterionOk = contractIds.has(refCriterion);
      if (taskOk && roundOk && criterionOk) {
        traced.evidence += 1;
        if (refRound === event.roundId) ownRoundEvidence += 1;
        else crossRoundEvidence += 1;
      } else {
        unmatched.push(`${ref}（任务对得上 ${String(taskOk)}／轮次真实存在 ${String(roundOk)}／标准真实存在 ${String(criterionOk)}）`);
      }
    } else unmatched.push(ref);
  }
  facts.evidenceTrace = { ...traced, unmatched: unmatched.slice(0, 6) };
  facts.evidenceOwnRound = ownRoundEvidence;
  facts.evidenceCrossRound = crossRoundEvidence;
  if (unmatched.length > 0) issues.push(`有 ${String(unmatched.length)} 条 evidenceRefs 追不到出处：${unmatched.slice(0, 3).join(' , ')}`);

  // 预算记账：roundUsed 要等于判定发生时已存在的轮数。
  const roundsAtDecision = upto.filter(item => item.type === 'round.started').length;
  facts.roundsAtDecision = roundsAtDecision;
  if (budget && typeof budget.roundUsed === 'number' && budget.roundUsed !== roundsAtDecision)
    issues.push(`budget.roundUsed=${String(budget.roundUsed)} 与事件流里的轮数 ${String(roundsAtDecision)} 不符`);
  const stored = storeTask(event.taskId);
  facts.storedMaxRounds = stored?.maxRounds ?? null;
  if (budget && 'roundLimit' in budget && stored && budget.roundLimit !== stored.maxRounds)
    issues.push(`budget.roundLimit=${String(budget.roundLimit)} 与任务 maxRounds=${String(stored.maxRounds)} 不符`);

  // 反算 progress：上一份存在事件里，这一轮的指纹由同一批纯函数现算。
  const previous = index === 0 ? null : [...upto].reverse()
    .find(item => item.type === 'cycle.decision.created' && item.at < event.at)?.progress ?? null;
  const contractEvent = [...upto].reverse().find(item =>
    item.type === 'goal.contract.updated');
  const criterionKey = openCriteriaKey(contractEvent?.contract ?? null);
  const recomputed = report
    ? detectNoProgress({
        previous,
        fingerprint: cycleFingerprint(evidenceFacts(report)),
        criterionKey
      })
    : null;
  facts.recomputedProgress = recomputed;
  facts.recomputedCriterionKey = criterionKey;
  facts.progressDiffs = recomputed && progress
    ? [...new Set([...Object.keys(recomputed), ...Object.keys(progress)])]
      .filter(key => JSON.stringify(recomputed[key]) !== JSON.stringify(progress[key]))
    : [];
  if (facts.progressDiffs.length > 0)
    issues.push(`事件 progress 与反算不一致：${facts.progressDiffs.map(key => `${key} 事件=${String(JSON.stringify(progress[key]))} 反算=${String(JSON.stringify(recomputed[key]))}`).join('，')}`);

  // 快照必须跟着同一条判定走：这是「两处判定」最容易复发的地方。
  // 取「之后最近一条」而不是「最后一条」：第二轮的快照讲的是第二轮的结论。
  const snapshot = events.filter(item => item.type === 'cycle.snapshot' && item.at >= event.at)
    .sort((a, b) => a.at - b.at)[0] ?? null;
  facts.snapshot = snapshot ? {
    decision: snapshot.decision,
    currentStage: snapshot.currentStage,
    nextAction: snapshot.nextAction,
    at: snapshot.at
  } : null;
  if (!snapshot) issues.push('判定之后没有 cycle.snapshot');
  else {
    const expectedLegacy = legacyDecisionOf(event.decisionType);
    if (snapshot.decision !== expectedLegacy)
      issues.push(`snapshot.decision=${String(snapshot.decision)} ≠ legacyDecisionOf(${event.decisionType})=${expectedLegacy}`);
    if (snapshot.currentStage !== 'done' && snapshot.nextAction !== reason)
      issues.push(`snapshot.nextAction 与事件 reason 不逐字相同：${String(snapshot.nextAction).slice(0, 60)}`);
  }

  return { issues, facts };
}

/** 落点是否真的落到了行为上——只看事件流，不看代码。 */
function behaviourMatchesAction(event, laterEvents) {
  const newRound = laterEvents.find(item => item.type === 'round.started' && item.at > event.at) ?? null;
  const completed = laterEvents.find(item => item.type === 'task.completed' && item.at > event.at) ?? null;
  const failed = laterEvents.find(item => item.type === 'task.failed' && item.at > event.at) ?? null;
  const cancelled = laterEvents.find(item => item.type === 'task.cancelled' && item.at > event.at) ?? null;
  const stopLog = laterEvents.find(item => item.type === 'log'
    && String(item.message ?? '').startsWith('GDC 停在待确认：') && item.at > event.at) ?? null;
  const facts = {
    nextAction: event.nextAction,
    newRoundId: newRound?.roundId ?? null,
    completed: Boolean(completed),
    failed: failed ? String(failed.error ?? '').slice(0, 160) : null,
    cancelled: Boolean(cancelled),
    stopLog: stopLog ? String(stopLog.message).slice(0, 200) : null
  };
  const issues = [];
  switch (event.nextAction) {
    case 'open_next_round':
      if (!newRound) issues.push('落点是 open_next_round，但之后没有出现新的 round.started');
      break;
    case 'finish_completed':
      if (!completed) issues.push('落点是 finish_completed，但之后没有 task.completed');
      break;
    case 'stop_and_wait':
      if (newRound) issues.push(`落点是 stop_and_wait，却又开了新轮 ${String(newRound.roundId)}`);
      if (!stopLog) issues.push('落点是 stop_and_wait，但日志里没有「GDC 停在待确认」');
      else if (stopLog.message.slice('GDC 停在待确认：'.length) !== event.reason)
        issues.push('日志那句理由与事件 reason 不逐字相同');
      break;
    case 'fail_budget':
    case 'fail_delivery':
      if (!failed) issues.push(`落点是 ${event.nextAction}，但之后没有 task.failed`);
      else if (!String(failed.error ?? '').includes(event.reason))
        issues.push('失败原因里没有引用事件 reason');
      break;
    case 'abort':
      if (!cancelled) issues.push('落点是 abort，但之后没有 task.cancelled');
      break;
    default:
      issues.push(`未知落点 ${String(event.nextAction)}`);
  }
  return { issues, facts };
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(OUT_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
  return name;
}

async function main() {
  note('default-store-readable', fs.existsSync(STORE), STORE);
  if (listenersOn(PORT).length > 0) throw new Error(`CDP 端口 ${PORT} 已被占用：先停掉现有实例`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(LOG, { force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  evidence.before = { tasks: (readStore().tasks ?? []).length };
  const storeBackup = path.join(OUT_DIR, 'agent-store.before.json');
  fs.copyFileSync(STORE, storeBackup);
  evidence.backups = { store: path.relative(OUT_DIR, storeBackup) };

  evidence.staleProbes = (readStore().tasks ?? [])
    .filter(task => [task.title, task.prompt, task.userPrompt].some(text => String(text ?? '').includes('M3-1 ')))
    .map(task => task.taskId);

  await startDev(true);
  cdp = await connectRenderer();
  note('renderer-ready', true, 'CDP 已连接');

  for (const stale of evidence.staleProbes) {
    await ev(`window.agentAPI.deleteTask(${JSON.stringify(stale)})`, 30000).catch(() => null);
  }

  const created = await ev(`window.agentAPI.runWorkflow(${JSON.stringify({
    workflow: { id: 'm3-1-two-round-decision-probe', title: PROBE, nodes: probeNodes() },
    permissionPreset: 'danger-full-access',
    workspaceRoot: WORKSPACE,
    goal: 'M3-1 决策出口收敛的真机探针：连跑两轮并逐轮留下完整周期判定',
    completionCondition: COMPLETION
  })})`, 90000);
  const taskId = created?.taskId ?? created?.task?.taskId;
  assert.ok(taskId, `探针任务没创建出来：${JSON.stringify(created)}`);
  const info = await getTask(taskId);
  evidence.probe = { taskId, title: info?.title ?? null, maxRounds: storeTask(taskId)?.maxRounds ?? null };

  // 等第一轮判定落地（期间可能在 planning / awaiting_approval）。
  const first = await waitFor(async () => (await taskEvents(taskId))
    .find(event => event.type === 'cycle.decision.created') ?? null, '第一轮 cycle.decision.created', WAIT_DECISION_1);
  // 判定与紧随其后的快照是两次 emit：先等一下再取，否则会把「快照没落地」当成缺字段。
  await sleep(6000);
  const events1 = await taskEvents(taskId);
  writeJson('events.after-decision-1.json', events1);
  writeJson('decision-1.json', first);

  const audit1 = auditDecision(first, events1, 0);
  evidence.decisions.push({ phase: 'round-1', ...audit1.facts, issues: audit1.issues });
  note('d1-full-fields', audit1.issues.length === 0,
    `${first.decisionType} → ${first.nextAction}｜证据 ${JSON.stringify(audit1.facts.evidenceTrace)}` +
    (audit1.issues.length ? `｜${audit1.issues.join(' ｜ ')}` : ''));
  // 判定不能只把上一轮的结论再记一遍：至少得有一条证据出自本轮。
  note('d1-cites-own-round-evidence', (audit1.facts.evidenceOwnRound ?? 0) >= 1,
    `本轮 ${String(audit1.facts.evidenceOwnRound ?? 0)} 条｜跨轮 ${String(audit1.facts.evidenceCrossRound ?? 0)} 条`);
  note('d1-evidence-refs-nonempty', (first.evidenceRefs ?? []).length > 0,
    `${String((first.evidenceRefs ?? []).length)} 条：${JSON.stringify((first.evidenceRefs ?? []).slice(0, 3))}`);
  note('d1-progress-recomputed', (audit1.facts.progressDiffs ?? ['?']).length === 0,
    `事件 ${JSON.stringify(audit1.facts.progress)}｜反算 ${JSON.stringify(audit1.facts.recomputedProgress)}｜标准集合键 ${String(audit1.facts.recomputedCriterionKey || '空')}`);

  // 落点→行为：给第二轮留出时间（模型规划 + 执行 + 评审）。
  const wantSecond = first.nextAction === 'open_next_round';
  let second = null;
  if (wantSecond) {
    second = await waitFor(async () => {
      const list = await taskEvents(taskId);
      return list.filter(event => event.type === 'cycle.decision.created')[1] ?? null;
    }, '第二轮 cycle.decision.created', WAIT_DECISION_2).catch(() => null);
  } else {
    // 判定不是「开下一轮」：那就要在事件流里看到对应的收口，否则标签又在骗人。
    await sleep(20000);
  }
  const eventsNow = await taskEvents(taskId);
  const behaviourEvents = eventsNow.filter(event => event.at > first.at && event.type !== 'cycle.stage.started');
  const beh1 = behaviourMatchesAction(first, behaviourEvents);
  evidence.behavior.push({ phase: 'round-1', ...beh1.facts, issues: beh1.issues });
  note('d1-behaviour-matches-nextaction', beh1.issues.length === 0,
    beh1.issues.length ? beh1.issues.join(' ｜ ') : `落点 ${first.nextAction}｜新轮 ${String(beh1.facts.newRoundId ?? '无')}｜完成 ${String(beh1.facts.completed)}`);
  note('probe-ran-two-rounds', Boolean(second), second
    ? `第二轮判定 ${second.decisionType} → ${second.nextAction}`
    : `只有 1 条判定事件；落点 ${first.nextAction}，任务状态 ${String((await getTask(taskId))?.status)}`);

  if (second) {
    // 判定事件与紧随其后的快照/收口要一起落盘，取事件时先让编排器把这轮写完。
    await sleep(15000);
    const events2 = await taskEvents(taskId);
    writeJson('events.after-decision-2.json', events2);
    writeJson('decision-2.json', second);
    const audit2 = auditDecision(second, events2, 1);
    evidence.decisions.push({ phase: 'round-2', ...audit2.facts, issues: audit2.issues });
    note('d2-full-fields', audit2.issues.length === 0,
      `${second.decisionType} → ${second.nextAction}｜证据 ${JSON.stringify(audit2.facts.evidenceTrace)}` +
      (audit2.issues.length ? `｜${audit2.issues.join(' ｜ ')}` : ''));
    note('d2-cites-own-round-evidence', (audit2.facts.evidenceOwnRound ?? 0) >= 1,
      `本轮 ${String(audit2.facts.evidenceOwnRound ?? 0)} 条｜跨轮 ${String(audit2.facts.evidenceCrossRound ?? 0)} 条（目标证据按轮累计，跨轮引用要求轮次与标准都能在事件流里对上）`);
    note('d2-rounds-distinct', second.roundId !== first.roundId,
      `轮次 ${String(first.roundId)} → ${String(second.roundId)}`);
    // 第二条判定必须挂在上一条判定之后新开的轮次上，而不是把第一轮结论再记一遍。
    // 这里不能写死「就是紧跟其后的那一轮」：真机 2026-11-28 第 2 轮计划未通过校验
    // （plan.invalid），没有产生执行报告，判定因此落在第 3 轮——轮次被计划重试消耗是事实，
    // 断言核对的是「归属新轮 + 记账与事件流一致 + 该轮真的跑过」。
    const openedAfter = [...new Set(events2
      .filter(item => item.type === 'round.started' && item.at > first.at)
      .map(item => item.roundId))];
    const reportedRounds = new Set(events2
      .filter(item => item.type === 'report.ready').map(item => item.roundId));
    const consumedWithoutReport = openedAfter.filter(id => !reportedRounds.has(id));
    note('d2-belongs-to-new-round', openedAfter.includes(second.roundId)
      && reportedRounds.has(second.roundId)
      && audit2.facts.roundsAtDecision >= 2
      && second.budget?.roundUsed === audit2.facts.roundsAtDecision,
      `新轮 ${openedAfter.join(',') || '无'}｜判定轮 ${String(second.roundId)}（有报告 ${String(reportedRounds.has(second.roundId))}）` +
      `｜事件流轮数 ${String(audit2.facts.roundsAtDecision)}｜budget.roundUsed ${String(second.budget?.roundUsed ?? '无')}` +
      (consumedWithoutReport.length ? `｜其中 ${consumedWithoutReport.length} 轮只开了轮没出报告（${consumedWithoutReport.map(id => id.slice(0, 8)).join(',')}）` : ''));
    const beh2 = behaviourMatchesAction(second, events2.filter(event => event.at > second.at));
    evidence.behavior.push({ phase: 'round-2', ...beh2.facts, issues: beh2.issues });
    note('d2-behaviour-matches-nextaction', beh2.issues.length === 0,
      beh2.issues.length ? beh2.issues.join(' ｜ ') : `落点 ${second.nextAction}｜完成 ${String(beh2.facts.completed)}｜失败 ${String(beh2.facts.failed ?? '无')}`);

    // 事件流 diff：两轮之间到底多出了哪些事件，全部落盘。
    const streamA = events1.map(event => `${String(event.at)} ${event.type}${event.roundId ? `#${String(event.roundId)}` : ''}`).join('\n');
    const streamB = events2.map(event => `${String(event.at)} ${event.type}${event.roundId ? `#${String(event.roundId)}` : ''}`).join('\n');
    writeJson('events.stream-1.json', streamA.split('\n'));
    writeJson('events.stream-2.json', streamB.split('\n'));
    let diff = '';
    try {
      diff = execFileSync('diff', ['-u', 'events.stream-1.json', 'events.stream-2.json'], { cwd: OUT_DIR, encoding: 'utf8' });
    } catch (error) {
      diff = String(error.stdout ?? error.message);
    }
    fs.writeFileSync(path.join(OUT_DIR, 'event-stream.diff'), diff);
    const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
    const removed = diff.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).length;
    evidence.diff = { added, removed, bytes: diff.length, file: 'event-stream.diff' };
    note('event-stream-diff-stored', added > 0 && fs.existsSync(path.join(OUT_DIR, 'event-stream.diff')),
      `第二轮新增 ${String(added)} 行、移除 ${String(removed)} 行，落在 event-stream.diff（${String(diff.length)} 字节）`);
  }

  // ── 界面：判定要能在「工程目标」卡上读到，且那句说法来自投影而不是组件自造 ──
  note('ui-shows-probe', await selectTaskRow(PROBE, evidence.probe.title, taskId), '侧栏选中探针');
  const newest = second ?? first;
  const finalEvents = await taskEvents(taskId);
  const finalTask = await getTask(taskId);
  const projection = projectGoalDrivenWorkbench({
    workId: taskId,
    originalRequest: finalTask?.userPrompt ?? PROBE,
    events: finalEvents,
    summary: finalTask?.summary,
    status: finalTask?.status
  });
  const expectedLine = cycleDecisionText(latestCycleDecision(projection.decisions));
  let card = null;
  try {
    card = await waitFor(async () => {
      const next = await goalCard();
      return next?.decisionLine ? next : null;
    }, '界面上出现「最近一次周期判定」', 60000);
  } catch { card = await goalCard().catch(() => null); }
  evidence.ui = {
    ...(evidence.ui ?? {}),
    card,
    projectionDecisionCount: projection.decisions.length,
    projectionCycleDecision: projection.cycle.decision ?? null,
    expectedLine
  };
  note('ui-cycle-decision-visible', Boolean(card?.decisionLine),
    `界面「${String(card?.decisionLine ?? '没有这一行').slice(0, 160)}」`);
  note('ui-cycle-decision-matches-newest-event',
    Boolean(card?.decisionLine)
      && card.decisionLine.includes(newest.decisionType)
      && card.decisionLine.includes(CYCLE_NEXT_ACTION_TEXT[newest.nextAction] ?? String(newest.nextAction))
      && card.decisionLine.includes(String(newest.reason).replace(/\s+/g, ' ')),
    `应为「${expectedLine.slice(0, 200)}」｜最新事件 ${newest.decisionType}/${newest.nextAction}`);
  note('ui-next-step-line-quotes-decision-reason',
    Boolean(card?.nextLine) && (newest.nextAction === 'finish_completed'
      ? card.nextLine.includes('无需下一轮')
      : card.nextLine.includes(String(newest.reason).replace(/\s+/g, ' ').slice(0, 40))),
    `界面「${String(card?.nextLine ?? '').slice(0, 200)}」`);
  note('ui-projection-single-source', expectedLine !== ''
    && (card?.decisionLine ?? '').replace(/\s+/g, ' ') === expectedLine.replace(/\s+/g, ' '),
    `投影句 ${String(expectedLine).slice(0, 120)}`);
  note('ui-card-scrolled', await scrollIntoView('.goal-contract-card') === true, '截图前把「工程目标」卡滚进视口');
  await shot('01-goal-card-cycle-decision.png');
  writeJson('projection-digest.json', {
    cycle: projection.cycle,
    decisions: projection.decisions,
    artifacts: projection.artifacts.map(item => ({ type: item.artifactType, status: item.status, id: item.artifactId }))
  });

  // ── 收尾 ──
  await ev(`window.agentAPI.cancelTask(${JSON.stringify(taskId)})`, 30000).catch(() => null);
  await sleep(2500);
  const cleanup = await ev(`window.agentAPI.deleteTask(${JSON.stringify(taskId)})`, 30000);
  evidence.cleanup.push({ taskId, cleanup });
  const stillThere = (readStore().tasks ?? []).filter(task => task.taskId === taskId);
  note('probe-task-cleaned-up', stillThere.length === 0,
    `任务数 ${String(evidence.before.tasks)} → ${String((readStore().tasks ?? []).length)}；删除回包 ${JSON.stringify(cleanup ?? null)}`);
}

try {
  await main();
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(`FAIL ${evidence.error}`);
} finally {
  evidence.finishedAt = new Date().toISOString();
  await stopDev('SIGTERM');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  const checks = Object.entries(evidence.checks);
  const failed = checks.filter(([, item]) => item.ok !== true);
  const lines = [
    '# V4 P1 M3-1 真机验收：周期判定只有一个出口',
    '',
    `- 时间：${evidence.startedAt} ~ ${evidence.finishedAt}`,
    `- 环境：${evidence.mode}`,
    `- 工作区：\`${WORKSPACE}\`（探针只在这里写文件）`,
    `- 探针任务：\`${evidence.probe?.taskId ?? '未创建'}\`（${PROBE}，maxRounds=${String(evidence.probe?.maxRounds ?? '?')}，收尾已删除）`,
    `- 完成条件：${COMPLETION}（轮次一故意不生成 REPORT.md，逼出第二轮）`,
    `- 备份：${evidence.backups?.store ?? '未生成'}`,
    '',
    '## 两轮判定（事件原文的核对结果）',
    '',
    '```json',
    JSON.stringify(evidence.decisions, null, 2),
    '```',
    '',
    '## 落点 → 实际行为',
    '',
    '```json',
    JSON.stringify(evidence.behavior, null, 2),
    '```',
    '',
    '## 界面读数（工程目标卡）',
    '',
    '```json',
    JSON.stringify(evidence.ui, null, 2),
    '```',
    '',
    '## 事件流 diff',
    '',
    '```json',
    JSON.stringify(evidence.diff, null, 2),
    '```',
    '',
    '完整序列见 `events.after-decision-1.json` / `events.after-decision-2.json`，',
    '逐行 diff 见 `event-stream.diff`，投影见 `projection-digest.json`。',
    '',
    '## 断言结果',
    '',
    '| 断言 | 结果 | 实测 |',
    '| --- | --- | --- |',
    ...checks.map(([name, item]) => `| ${name} | ${item.ok ? '通过' : '**未通过**'} | ${item.detail ?? ''} |`),
    '',
    `合计 ${String(checks.length)} 项，未通过 ${String(failed.length)} 项${failed.length ? `：${failed.map(([name]) => name).join('、')}` : ''}。`,
    '',
    '## 截图',
    '',
    ...(evidence.shots.length ? evidence.shots.map(item => `- \`${item}\``) : ['- 无']),
    '',
    evidence.error ? `## 中断原因\n\n${evidence.error}\n` : '## 中断原因\n\n无。'
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'EVIDENCE.md'), `${lines.join('\n')}\n`);
  console.log(`EVIDENCE ${path.relative(ROOT, path.join(OUT_DIR, 'EVIDENCE.md'))}`);
  process.exitCode = failed.length > 0 || evidence.error ? 1 : 0;
}
