/**
 * M3-2 真机验收：反空转真的在跑，并且拦得下、说得清、关得掉。
 *
 * 默认数据目录（AGENTS.md §10.2），不隔离、不复制用户数据；阈值配置文件
 * `~/Library/Application Support/thinkfusion-ai/no-progress.json` 用完恢复原状，
 * 探针任务收尾删除，动磁盘前先把 agent-store.json 备进验收目录。
 *
 * 一具探针、四次判定（约 30 分钟）。上一版按默认阈值 2/2 要跑到第 4 轮才停下，再另建一具
 * 探针做阈值回退，实测 70 分钟以上，模型通道一抖就得整段重来：
 * 1) 真机这段先把阈值下调为「重复 1 轮 / 标准停滞 1 轮」，写进产品自己的配置文件。
 *    默认 2/2 的触发轮数由离线用例 `scripts/check-cycle-decision.mjs` 覆盖；真机要证明的是
 *    「每轮报告后真的调了判定、拦得下、说得清、关得掉」，不是「第几轮触发」。
 * 2) 第 1 条判定：证据与标准都在变化，不得判为空转（正常波动不误伤）。
 * 3) 第 2 条判定：未满足的标准集合连续不变 → 必须带原因分类，落点只能是 REPLAN/WAIT_USER，
 *    且下一轮的计划请求原文里要真的出现「系统判定」那段指令与重复命令清单。
 * 4) 第 3 条判定：连续第二次空转 → 改口 WAIT_USER，真的不再开新轮，任务停在 `report_pending`
 *    等人接手（不是标成失败）。
 * 5) 界面：这条判定要能在「工程目标」卡上逐字读到，截图留证。
 * 6) 阈值回退：不重启、同一具探针，把配置改成 `99,99` 后由用户入口把停下的任务接回去再跑一轮
 *    → 新增判定不得判为空转、事件里记的阈值就是 99、下一轮指令里不得再出现那段指令。
 *    2026-11-28 现网走到这里被产品缺口拦住：任务被 WAIT_USER 停在 `report_pending` 时，
 *    「继续修复」在「本轮三项检查都已跑（哪怕全 skipped）」的前提下直接拒绝，界面上只剩
 *    「接受未验证并结束」——**停下等人的判定没有「再来一轮」的用户入口**。脚本据此当场记下
 *    `b-hot-threshold-pending-m3-4` 并交跳过，不再干等；「判定当下现读配置」由 A 段
 *    `a-threshold-applies-without-restart` 正面证到（进程在无配置文件时启动，运行中写 1/1，
 *    后续判定事件里就是 1/1），「调大后不再拦」暂由离线用例覆盖，现场补证归 M3-4。
 *
 * 现网的模型通道与计划校验都会把整轮吃掉（2026-11-28 实测两种：第 2 轮「模型连续 120 秒没有
 * 输出，已停止」→ `task.failed`；模型出的计划步骤带 `mapsTo`/`expect` 多余键被 strict 校验整份
 * 拒绝，走 `repairPlan` 自纠，最多 2 次否则判死），所以 A 段最多建 2 次探针，
 * 每次失败的状态、任务错误原文与轮数都留在 `evidence.phases[].attempts` 里，不用
 * 「重试到成功」把这条脆弱路径抹掉。
 *
 * 每一轮还核对三件容易各说各话的事：
 * 1) progress 用「上一条判定 + 本轮报告 + 当时的契约」重算一遍，逐字段必须与事件相同
 *    （顺带证明空转计数存在事件里、重启或续跑后能接着算）；
 * 2) 判定落点与后续事件对得上（open_next_round 必有新轮、stop_and_wait 必无新轮）；
 * 3) 判为空转的那一轮，下一轮的计划请求里必须真的带上「系统判定」那段指令与重复命令清单；
 *    判为非空转的那一段则不得出现这段指令。
 *
 * 枚举成员不写死在脚本里：从 `src/shared/cycle-decision.ts` 现读联合类型成员。
 *
 * Run: node scripts/verify-v4-p1-m3-2-cdp.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, sleep } from './lib/cdp.mjs';
// 判据用产品同一份口径：枚举、阈值解析、判定句、指纹与命令清单函数都不在脚本里重抄。
import {
  CYCLE_NEXT_ACTION_TEXT,
  CYCLE_NO_PROGRESS_CAUSE_TEXT,
  cycleFingerprint,
  cycleNoProgressLimits,
  detectNoProgress,
  isNoProgress,
  openCriteriaKey,
  resolveNoProgressLimits
} from '../out-test/shared/cycle-decision.js';
import { cycleDecisionText, latestCycleDecision, projectGoalDrivenWorkbench } from '../out-test/shared/goal-driven-cycle.js';
import { evidenceFacts, repeatedCommands } from '../out-test/shared/repair-loop.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '..', 'docs', 'implementation', 'acceptance', 'v4-p1-m3-2-20261128');
const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai');
const STORE = path.join(USER_DATA, 'agent-store.json');
const CONFIG = path.join(USER_DATA, 'no-progress.json');
const LOG = path.join(OUT_DIR, 'dev.log');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ENDPOINT = `http://127.0.0.1:${PORT}/json`;
const WORKSPACE = path.join(os.tmpdir(), `tf-m3-2-ws-${String(Date.now())}`);
/**
 * 探针目标：让每个文件的内容等于「该文件自己的 sha256」。
 *
 * 这条要求结构上做不到（哈希不动点找不到），但目标本身说得很清楚，没有互相矛盾，也没有
 * 缺权限/缺环境，因此模型既没有理由问人，也不会改目标——它只会每轮把同一条校验命令再跑一遍、
 * 拿到同一个退出码。这正是「连续几轮同证据」的来源。上一版用「写 60 个文件」做量，模型一条
 * for 循环就能补齐，第 2 轮直接 COMPLETE，反空转根本轮不到出场。
 *
 * 校验由编排器自己重跑（verification 不是模型自述），所以模型也编不出「已通过」来收尾。
 */
const ITEM_COUNT = 6;
const SWEEP = `for i in $(seq -w 1 ${String(ITEM_COUNT)}); do want=$(sha256sum f$i.txt | cut -d' ' -f1); `
  + `got=$(tr -d '\\n' < f$i.txt); [ -n "$want" ] && [ "$want" = "$got" ] `
  + `|| { echo "f$i.txt 的内容不是它自身的 sha256"; exit 3; }; done && echo all-fixed`;
/** 这一条完成条件每轮都满足不了，未满足的标准集合因此连续不变。 */
const COMPLETION = `工作区里 f01.txt 到 f${String(ITEM_COUNT)}.txt 共 ${String(ITEM_COUNT)} 个文件，`
  + `每个文件的内容必须恰好等于该文件自身的 sha256（64 位十六进制、不含空白），`
  + `且 REPORT.md 逐条记录这 ${String(ITEM_COUNT)} 次校验命令与退出码`;
/**
 * 一轮约 8 分钟（规划 + 执行 + 报告），判定隔轮出现，三条判定实测 25~30 分钟。
 *
 * 上一版给 22 分钟，两次探针都在「已有 2 条、正奔第 3 条」时到点——然后删掉重建，
 * 前面花掉的模型轮次全部作废，实际耗时反而翻倍。窗口要按「一次跑完」设，
 * 快速退出的责任交给状态判定：落到终态当场抛错，不会干等满窗口。
 */
const WAIT_DECISION = 40 * 60 * 1000;
/** 第 3 轮报告之后编排器还会写快照 / 开下一轮，取事件前留出的静默时间。 */
const SETTLE = 15_000;
/** 落到这些状态就不会再自己产生新判定（终态，或在等人回答），直接失败退出而不是把窗口等满。 */
const DEAD_STATUSES = ['completed', 'failed', 'cancelled', 'budget_exhausted', 'blocked',
  'awaiting_approval'];
/**
 * 探针最常死的地方：模型在报告轮不交计划、改口提问 → 任务停在 `awaiting_clarification`，
 * 之后不会自己产生判定。这里代用户答一次（内容就是「别问，照原样再跑一遍并如实记失败」），
 * 并把每次问答原样记进 evidence——答澄清本身就是要留证的用户介入。
 * 最多答 2 次：还继续问说明探针确实推不动，应当失败而不是无限喂答案。
 */
const MAX_CLARIFY_ANSWERS = 2;
const CLARIFY_ANSWER = '不必澄清，按原目标继续：每轮都用同一条校验命令复核这些文件，把命令、输出与退出码如实写进 REPORT.md；'
  + '做不到就写失败原因，不要提问，也不要改目标。';

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
const CAUSES = unionMembers('CycleNoProgressCause');
/** 「不许继续执行」在这套枚举里的具体含义：这三条都是把同一批调用再交一遍或直接收尾。 */
const MUST_NOT_PICK = new Set(['CONTINUE', 'REPAIR', 'COMPLETE']);

const evidence = {
  startedAt: new Date().toISOString(),
  mode: '默认数据目录 / ThinkFusion Dev / CDP 9333 / 同一进程同一探针连跑四轮判定，中途只改配置文件不重启',
  workspace: WORKSPACE,
  completionCondition: COMPLETION,
  sweepCommand: SWEEP,
  defaults: cycleNoProgressLimits(null),
  checks: {},
  currentConfig: null,
  shots: [],
  before: null,
  backups: null,
  configBackup: null,
  staleProbes: [],
  phases: [],
  ui: null,
  clarifications: [],
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
  if (!fs.existsSync(STORE)) return { tasks: [], rounds: [] };
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}

function storeTask(taskId) {
  try {
    return (readStore().tasks ?? []).find(task => task.taskId === taskId) ?? null;
  } catch { return null; }
}

/** 某一轮的计划请求原文（判定指令是否真的下发了，只有这份能证明）。 */
function storeRound(roundId) {
  try {
    return (readStore().rounds ?? []).find(round => round.roundId === roundId) ?? null;
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
  // 阈值只走配置文件：环境变量要改就得重启 App，配置文件是判定当下现读的，
  // 这样才能在同一进程里跑出「关掉反空转」那一段。
  delete env.THINKFUSION_NO_PROGRESS_LIMITS;
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
  if (!(await openTab('对话'))) return { tabMissing: true };
  return ev(`(() => {
    const card = document.querySelector('.goal-contract-card');
    if (!card) return null;
    card.open = true;
    const lines = [...card.querySelectorAll('p')].map(node => (node.innerText ?? '').replace(/\\s+/g, ' ').trim());
    return {
      decisionLine: lines.find(text => text.includes('最近一次周期判定')) ?? null,
      nextLine: lines.find(text => text.startsWith('当前阶段')) ?? null,
      charLen: card.innerText.length
    };
  })()`);
}

const getTask = id => ev(`window.agentAPI.getTask(${JSON.stringify(id)})`, 30000);
const taskEvents = id => ev(`window.agentAPI.getTaskEvents(${JSON.stringify(id)})`, 90000) ?? [];

/**
 * 代用户回答澄清。
 *
 * 这个用例要测的是「同一个证据重复交上来之后机器会不会自己停」，不是「模型会不会提问」。
 * 但模型实测就爱提问：一旦落到 awaiting_clarification，任务不再自转，判定永远等不齐，
 * 整个用例会以「探针目标太容易」这种假原因失败。所以这里以用户身份把问题挡回去，
 * 并把问题原文、答复和返回值全部留证——留证是因为「模型爱提问」本身也是本轮要报的实情。
 */
async function answerPendingClarification(taskId) {
  const rounds = (readStore().rounds ?? []).filter(round => round.taskId === taskId);
  const last = rounds.slice().sort((a, b) => Number(a.roundNumber ?? 0) - Number(b.roundNumber ?? 0)).pop() ?? null;
  const questions = last?.pendingQuestions ?? [];
  const reply = await ev(
    `window.agentAPI.answerClarification(${JSON.stringify({ taskId, answer: CLARIFY_ANSWER })})`, 60000
  ).catch(error => ({ error: String(error && error.message ? error.message : error) }));
  evidence.clarifications.push({
    taskId, at: new Date().toISOString(), round: last?.roundNumber ?? null,
    questions, answer: CLARIFY_ANSWER, reply: reply ?? null
  });
  console.log(`..   第 ${String(last?.roundNumber ?? '?')} 轮在等人澄清，已代答：`
    + `${JSON.stringify(questions).slice(0, 160)}`);
  return !reply?.error;
}

/** 轮次一：把 12 个文件都写出来（内容是普通占位文本），再跑一次覆盖全项的哈希校验——它必然失败。 */
function probeNodes() {
  const nodes = Array.from({ length: ITEM_COUNT }, (_, index) => {
    const name = `f${String(index + 1).padStart(2, '0')}.txt`;
    return {
      id: `write-${String(index + 1)}`,
      capabilityId: 'fs.writeFile',
      title: `写 ${name}`,
      args: { path: path.join(WORKSPACE, name), content: `M3-2 占位内容 ${String(index + 1)}\n` }
    };
  });
  return [
    ...nodes,
    {
      id: 'check-hash-fixed',
      capabilityId: 'shell.run',
      title: `逐条校验 ${String(ITEM_COUNT)} 个文件的内容是否等于自身 sha256`,
      args: { command: SWEEP, cwd: WORKSPACE, timeoutMs: 30000 }
    }
  ];
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(OUT_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
  return name;
}

/** 判定当时能看到的输入：本轮报告、上一轮报告、之前的判定、当时的契约与轮数。 */
function viewAt(events, event) {
  const upto = events.filter(item => item.at <= event.at);
  const reports = upto.filter(item => item.type === 'report.ready');
  const own = [...reports].reverse().find(item => item.roundId === event.roundId) ?? null;
  const ownIndex = reports.findIndex(item => item === own);
  return {
    upto,
    report: own?.report ?? null,
    // 「哪些命令被重复交了」要拿上一轮的报告比，不能只比本轮自己。
    previousRoundReport: ownIndex > 0 ? reports[ownIndex - 1]?.report ?? null : null,
    previousDecision: [...upto].reverse().find(item =>
      item.type === 'cycle.decision.created' && item.at < event.at)?.progress ?? null,
    contract: [...upto].reverse().find(item => item.type === 'goal.contract.updated')?.contract ?? null,
    rounds: upto.filter(item => item.type === 'round.started').length,
    knownRounds: new Set(upto.filter(item => item.type === 'round.started').map(item => item.roundId))
  };
}

/**
 * 逐条审计判定事件里与「反空转」有关的部分。
 *
 * 期望值来自脚本自己按同一批纯函数重算的结果，不是写死的常量：阈值改了、指纹算法改了，
 * 这里的期望会跟着变，才拦得住「事件自说自话」。
 */
function auditIdle(event, events, expectIdle) {
  const issues = [];
  const facts = { roundId: event.roundId, at: event.at, decisionType: event.decisionType, nextAction: event.nextAction };
  const view = viewAt(events, event);
  const limits = resolveNoProgressLimits({ config: evidence.currentConfig });

  if (!DECISION_TYPES.has(event.decisionType)) issues.push(`decisionType 不在源码枚举里：${String(event.decisionType)}`);
  if (!NEXT_ACTIONS.has(event.nextAction)) issues.push(`nextAction 不在源码枚举里：${String(event.nextAction)}`);
  if (!('noProgressCause' in event)) issues.push('事件里没有 noProgressCause 这个键（没有分类要记 null，不能省）');
  const cause = event.noProgressCause ?? null;
  facts.noProgressCause = cause;
  if (cause !== null && !CAUSES.has(cause)) issues.push(`noProgressCause 不在源码枚举里：${String(cause)}`);

  // progress 重算：上一条 + 本轮报告 + 当时契约，逐字段比对（阈值也一起比，配置有没有生效就在这条上）。
  const progress = event.progress ?? null;
  facts.progress = progress;
  const criterionKey = openCriteriaKey(view.contract);
  const recomputed = view.report
    ? detectNoProgress({
        previous: view.previousDecision,
        fingerprint: cycleFingerprint(evidenceFacts(view.report)),
        criterionKey,
        repeatLimit: limits.repeatLimit,
        criteriaLimit: limits.criteriaLimit
      })
    : null;
  facts.recomputedProgress = recomputed;
  facts.progressDiffs = recomputed && progress
    ? [...new Set([...Object.keys(recomputed), ...Object.keys(progress)])]
      .filter(key => JSON.stringify(recomputed[key]) !== JSON.stringify(progress[key]))
    : ['本轮没有可反算的执行报告'];
  if (facts.progressDiffs.length > 0)
    issues.push(`事件 progress 与反算不一致：${facts.progressDiffs.map(key => `${key} 事件=${String(JSON.stringify(progress?.[key]))} 反算=${String(JSON.stringify(recomputed?.[key]))}`).join('，')}`);

  const idle = Boolean(recomputed) && isNoProgress(recomputed);
  facts.idleRecomputed = idle;
  facts.repeatedCommands = view.previousRoundReport
    ? repeatedCommands(view.previousRoundReport, view.report)
    : [];

  if (idle && !expectIdle) issues.push('阈值调大后仍判为空转：回退开关没有生效');
  if (!idle && expectIdle) issues.push('这一段本该出现空转判定，实际没有（探针没有按计划复现证据形态）');

  if (idle) {
    // 任务书 M3-2：无进展时只许 WAIT_USER 或 REPLAN，且必须带上分类。
    if (MUST_NOT_PICK.has(event.decisionType))
      issues.push(`无进展却判成 ${event.decisionType}：等于明知没前进还继续执行`);
    if (event.decisionType !== 'REPLAN' && event.decisionType !== 'WAIT_USER')
      issues.push(`无进展的落点标签不是 REPLAN/WAIT_USER：${event.decisionType}`);
    if (cause === null) issues.push('判为空转却没有原因分类');
    const reason = String(event.reason ?? '');
    facts.reason = reason;
    if (!reason.includes('连续无进展（原因分类：')) issues.push(`理由没有点名「连续无进展（原因分类：…）」：${reason.slice(0, 80)}`);
    if (cause && !reason.includes(CYCLE_NO_PROGRESS_CAUSE_TEXT[cause]))
      issues.push(`理由没有写出分类的中文说法「${CYCLE_NO_PROGRESS_CAUSE_TEXT[cause]}」`);
    if (!/这是连续第 \d+ 轮/.test(reason)) issues.push('理由没有点名「这是连续第 N 轮」（第二次就要停下等人，靠的是这个数）');
    if (event.requiresUser !== (event.nextAction === 'stop_and_wait'))
      issues.push(`requiresUser=${String(event.requiresUser)} 与落点 ${event.nextAction} 不同源`);
    // 连续第二次空转必须改口等人：这条是「自动重规划只给一次机会」的唯一证据。
    const streak = Number(progress?.noProgressStreak ?? 0);
    if (streak >= 2 && event.decisionType !== 'WAIT_USER')
      issues.push(`连续第 ${String(streak)} 轮空转仍判 ${event.decisionType}，没有停下等人`);
    if (streak === 1 && event.decisionType === 'WAIT_USER' && cause !== 'missing_permission')
      issues.push('第一次空转就停下等人，却没有给重规划机会（缺权限除外）');
  } else if (cause !== null) {
    issues.push(`没有命中空转判定却写了分类 ${String(cause)}`);
  }

  // 落点 → 行为 + 指令下发
  const later = events.filter(item => item.at > event.at);
  const newRound = later.find(item => item.type === 'round.started') ?? null;
  facts.newRoundId = newRound?.roundId ?? null;
  if (event.nextAction === 'open_next_round' && !newRound) issues.push('落点是 open_next_round，但之后没有新的 round.started');
  if (event.nextAction === 'stop_and_wait' && newRound) issues.push(`落点是 stop_and_wait，却又开了新轮 ${String(newRound.roundId)}`);
  if (event.nextAction === 'stop_and_wait') {
    const stopLog = later.find(item => item.type === 'log' && String(item.message ?? '').startsWith('GDC 停在待确认：'));
    if (!stopLog) issues.push('落点是 stop_and_wait，但日志里没有「GDC 停在待确认」');
    else if (String(stopLog.message).slice('GDC 停在待确认：'.length) !== String(event.reason))
      issues.push('日志那句理由与事件 reason 不逐字相同');
  }
  if (newRound) {
    const next = storeRound(newRound.roundId);
    const text = String(next?.requestText ?? '');
    facts.nextRoundPromptBytes = text.length;
    facts.nextRoundHasIdleDirective = text.includes('系统判定：');
    if (cause) {
      if (!facts.nextRoundHasIdleDirective)
        issues.push('判为空转却没有把「系统判定」那段指令下发给下一轮：REPLAN 只剩一个标签');
      else if (!text.includes(String(event.reason).slice(0, 40)))
        issues.push('下一轮指令里的判定原话与事件 reason 对不上');
      // 清单是硬证据：上一轮真跑过的「命令#退出码」必须逐字出现在禁止重复的那段里。
      const listedAt = text.indexOf('这些命令已经带着同样的退出码跑过一遍');
      const overlap = repeatedCommands(view.previousRoundReport, view.report);
      facts.commandOverlap = overlap;
      if (listedAt >= 0) {
        const listed = text.slice(listedAt, listedAt + 600);
        facts.directiveCommandSection = listed;
        if (overlap.length > 0 && !overlap.some(command => listed.includes(command)))
          issues.push(`重复命令清单没有点名实际跑过的那几条：${overlap.slice(0, 3).join(' , ')}`);
      } else {
        facts.directiveCommandSection = null;
        // 没有清单只有一种合法情况：这一轮确实没有和上一轮同命令同退出码的东西。
        if (overlap.length > 0) issues.push(`有 ${String(overlap.length)} 条命令与上一轮完全重复，指令里却没点名`);
      }
    } else if (facts.nextRoundHasIdleDirective) {
      issues.push('没有判为空转，却给下一轮下发了「不得重复」指令');
    }
  }
  return { issues, facts, view };
}

/**
 * 等第 count 条周期判定出现（这个探针不恢复、不插话，每条判定都跟在某一份执行报告之后）。
 *
 * 任务一旦落到终态就立刻失败退出：上一版探针在这里干等 40 分钟，而实际第 2 轮就 COMPLETE 了，
 * 白等一场什么证据也没多拿到。轮数、状态与已出现的判定都要打出来，卡在哪一轮当场能看出来。
 */
async function waitDecisions(taskId, count, label, baseline = 0) {
  const deadline = Date.now() + WAIT_DECISION;
  let lastMark = 0;
  let clarifies = 0;
  while (Date.now() < deadline) {
    const list = await taskEvents(taskId);
    const decisions = list.filter(event => event.type === 'cycle.decision.created');
    if (decisions.length >= count) return decisions;
    // 已经停手等人就不会再自己长出判定：继续等满窗口等于白等。只在「比基线新的判定」上成立，
    // 否则 B 段一进来就会被 A 段留下的那条 stop_and_wait 提前放行。
    const last = decisions[decisions.length - 1];
    if (decisions.length > baseline && last?.nextAction === 'stop_and_wait') {
      console.log(`..   ${label}：已停在待确认，不再等第 ${String(count)} 条`);
      return decisions;
    }
    const status = storeTask(taskId)?.status ?? null;
    if (String(status) === 'awaiting_clarification' && clarifies < MAX_CLARIFY_ANSWERS) {
      clarifies += 1;
      if (await answerPendingClarification(taskId)) continue;
    }
    if (DEAD_STATUSES.includes(String(status)) || String(status) === 'awaiting_clarification') {
      throw new Error(`${label} 只拿到 ${String(decisions.length)} 条判定就落到不再自转的状态 ${String(status)}`
        + `（轮数 ${String(list.filter(event => event.type === 'round.started').length)}`
        + `，已代答澄清 ${String(clarifies)} 次）——探针目标太容易满足，或模型一直想问人`);
    }
    if (Date.now() - lastMark > 120000) {
      lastMark = Date.now();
      console.log(`..   ${label} 判定 ${String(decisions.length)}/${String(count)}｜状态 ${String(status)}`
        + `｜轮数 ${String(list.filter(event => event.type === 'round.started').length)}`
        + `｜剩余 ${String(Math.round((deadline - Date.now()) / 60000))} 分钟`);
    }
    await sleep(5000);
  }
  throw new Error(`等待超时：${label} 出现第 ${String(count)} 条周期判定`);
}

async function submitProbe(label, prompt) {
  const created = await ev(`window.agentAPI.runWorkflow(${JSON.stringify({
    workflow: { id: `m3-2-${label}-probe`, title: prompt, nodes: probeNodes() },
    permissionPreset: 'danger-full-access',
    workspaceRoot: WORKSPACE,
    goal: `M3-2 反空转探针（${label}）：连续几轮采同一批证据，看判定会不会拦下来`,
    completionCondition: COMPLETION
  })})`, 90000);
  const taskId = created?.taskId ?? created?.task?.taskId;
  assert.ok(taskId, `${label} 探针任务没创建出来：${JSON.stringify(created)}`);
  return taskId;
}

async function cleanupProbe(taskId) {
  await ev(`window.agentAPI.cancelTask(${JSON.stringify(taskId)})`, 30000).catch(() => null);
  await sleep(2500);
  const cleanup = await ev(`window.agentAPI.deleteTask(${JSON.stringify(taskId)})`, 30000).catch(() => null);
  await sleep(1500);
  // 删除回执只说明主进程应答了，任务还在不在要看 store：留一份「removed」给汇总行用。
  const stillThere = (readStore().tasks ?? []).some(task => task.taskId === taskId);
  evidence.cleanup.push({ taskId, cleanup, removed: !stillThere });
  return stillThere;
}

/**
 * 建探针任务并等它跑到第 count 条判定，跑不通就删掉重建，最多 attempts 次。
 *
 * 为什么要重试：真机现网的模型通道会整轮卡住——2026-11-28 第一次跑就在第 2 轮收到
 * 「模型连续 120 秒没有输出，已停止」并直接 `task.failed`（终态，恢复门禁不认），
 * 探针因此拿不到第 3 条判定。这不是判定逻辑的问题，但会让验收随机失败，所以留够尝试次数，
 * 并把每次失败的原因原样记进 evidence，不用「重试到成功」掩盖这条脆弱路径。
 */
async function probeUntilDecisions(input) {
  const { phaseLabel, probeLabel, prompt, count, attempts } = input;
  const failures = [];
  for (let index = 1; index <= attempts; index += 1) {
    // 每次尝试都从空工作区开始：上一具尸体留下的 REPORT.md / 证据文件会让这一具的
    // 「未满足标准集合」起点不同，反空转的轮数就不好对齐了。
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
    fs.mkdirSync(WORKSPACE, { recursive: true });
    const taskId = await submitProbe(probeLabel, prompt);
    try {
      await waitDecisions(taskId, count, `${phaseLabel}（第 ${String(index)}/${String(attempts)} 次探针）`);
      return { taskId, failures };
    } catch (error) {
      const stored = storeTask(taskId);
      failures.push({
        attempt: index,
        taskId,
        status: stored?.status ?? null,
        taskError: stored?.error ?? null,
        rounds: (readStore().rounds ?? []).filter(round => round.taskId === taskId).length,
        error: error instanceof Error ? error.message : String(error)
      });
      await cleanupProbe(taskId);
    }
  }
  throw new Error(`${phaseLabel} 连试 ${String(attempts)} 次都没能跑到第 ${String(count)} 条判定：`
    + failures.map(item => `第 ${String(item.attempt)} 次 ${item.status}「${String(item.taskError ?? item.error).slice(0, 120)}」`).join(' ｜ '));
}

async function main() {
  note('default-store-readable', fs.existsSync(STORE), STORE);
  if (listenersOn(PORT).length > 0) throw new Error(`CDP 端口 ${PORT} 已被占用：先停掉现有实例`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(LOG, { force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  const storeBackup = path.join(OUT_DIR, 'agent-store.before.json');
  if (fs.existsSync(STORE)) fs.copyFileSync(STORE, storeBackup);
  const configBackup = path.join(OUT_DIR, 'no-progress.before.json');
  const hadConfig = fs.existsSync(CONFIG);
  if (hadConfig) fs.copyFileSync(CONFIG, configBackup);
  evidence.backups = {
    store: fs.existsSync(storeBackup) ? path.relative(OUT_DIR, storeBackup) : 'store 还不存在，无需备份',
    config: hadConfig ? path.relative(OUT_DIR, configBackup) : '原本没有 no-progress.json（跑完删掉我写的这份）'
  };

  evidence.staleProbes = (readStore().tasks ?? [])
    .filter(task => [task.title, task.prompt, task.userPrompt].some(text => String(text ?? '').includes('M3-2 ')))
    .map(task => task.taskId);
  evidence.before = { tasks: (readStore().tasks ?? []).length - evidence.staleProbes.length };

  await startDev(true);
  cdp = await connectRenderer();
  note('renderer-ready', true, 'CDP 已连接');
  evidence.rendererReadyAt = new Date().toISOString();
  for (const stale of evidence.staleProbes) {
    await ev(`window.agentAPI.deleteTask(${JSON.stringify(stale)})`, 30000).catch(() => null);
  }

  // A 段把阈值压到 1/1：空转在第 2 条判定就应当出场，省掉两轮模型规划（约 15 分钟）。
  // 必须写在「渲染进程已连上」之后：进程是在没有这份配置的目录里起来的（默认 2/2），
  // 运行中才把配置放进去，后续判定事件里的阈值跟着变成 1/1，才证得了「判定当下现读」。
  // 写在 startDev 之前就只能证明文件读取，证明不了不用重启。
  const lowered = { repeatLimit: 1, criteriaLimit: 1 };
  fs.writeFileSync(CONFIG, `${JSON.stringify(lowered)}\n`);
  evidence.currentConfig = lowered;
  evidence.configWrittenAt = new Date().toISOString();
  const readLow = resolveNoProgressLimits({ config: JSON.parse(fs.readFileSync(CONFIG, 'utf8')) });
  note('config-lowered-for-phase-a',
    !hadConfig && readLow.repeatLimit === 1 && readLow.criteriaLimit === 1,
    `进程已启动（启动时 ${hadConfig ? `已有用户配置 ${fs.readFileSync(path.join(OUT_DIR, 'no-progress.before.json'), 'utf8').trim()}，本轮证不到「运行中改配置」` : `没有 no-progress.json，用默认 ${JSON.stringify(evidence.defaults)}`}），`
    + `随后写入 ${CONFIG}=${JSON.stringify(lowered)}，解析结果 ${JSON.stringify(readLow)}`);

  // ── A 段：阈值 1/1，跑到空转判定并停下等人 ────────────────────────────────
  const phaseA = { label: '阈值 1/1（触发轮数由离线用例按默认 2/2 覆盖）', attempts: [], decisions: [] };
  evidence.phases.push(phaseA);
  const runA = await probeUntilDecisions({
    phaseLabel: 'A 段', probeLabel: 'short', count: 3, attempts: 2,
    prompt: 'M3-2 反空转探针（阈值 1/1）'
  });
  const taskA = runA.taskId;
  phaseA.taskId = taskA;
  phaseA.attempts = runA.failures;
  phaseA.maxRounds = storeTask(taskA)?.maxRounds ?? null;

  await sleep(SETTLE);
  const eventsA = await taskEvents(taskA);
  writeJson('events.after-idle.json', eventsA);
  const allA = eventsA.filter(item => item.type === 'cycle.decision.created');
  const baselineEvent = allA[0] ?? null;
  const idleEvent = allA[1] ?? null;
  assert.ok(baselineEvent && idleEvent, 'A 段前两条判定在静默期内消失了');
  writeJson('decision-baseline.json', baselineEvent);
  writeJson('decision-idle.json', idleEvent);

  // 第 1 条判定：只跑过一轮，标准集合没有「连续不变」的前序可比 → 不得判空转。
  const auditBase = auditIdle(baselineEvent, eventsA, false);
  phaseA.decisions.push({ round: 1, ...auditBase.facts, issues: auditBase.issues });
  note('a-first-round-not-idle',
    auditBase.facts.idleRecomputed === false && auditBase.facts.noProgressCause === null,
    `${baselineEvent.decisionType} → ${baselineEvent.nextAction}｜streak ${String(baselineEvent.progress?.criteriaStreak)}`
    + `｜理由「${String(baselineEvent.reason).slice(0, 90)}」｜${auditBase.issues.join(' ｜ ') || '无误伤'}`);

  const auditA = auditIdle(idleEvent, eventsA, true);
  phaseA.decisions.push({ round: 2, ...auditA.facts, issues: auditA.issues });
  note('a-idle-detected', auditA.facts.idleRecomputed === true,
    `第 2 份报告：进展 ${JSON.stringify(auditA.facts.progress)}｜反算 ${JSON.stringify(auditA.facts.recomputedProgress)}`);
  note('a-idle-decision-not-execute',
    auditA.facts.idleRecomputed !== true
      ? false
      : auditA.facts.decisionType === 'REPLAN' || auditA.facts.decisionType === 'WAIT_USER',
    `${auditA.facts.decisionType} → ${auditA.facts.nextAction}｜分类 ${String(auditA.facts.noProgressCause)}`);
  note('a-idle-cause-classified', auditA.facts.noProgressCause !== null,
    `分类 ${String(auditA.facts.noProgressCause)}（${auditA.facts.noProgressCause
      ? CYCLE_NO_PROGRESS_CAUSE_TEXT[auditA.facts.noProgressCause] : '无'}）｜理由「${String(auditA.facts.reason ?? '').slice(0, 140)}」`);
  note('a-idle-progress-recomputed', (auditA.facts.progressDiffs ?? ['?']).length === 0,
    `事件阈值 ${JSON.stringify({ repeatLimit: auditA.facts.progress?.repeatLimit, criteriaLimit: auditA.facts.progress?.criteriaLimit })}` +
    `｜反算 ${JSON.stringify({ repeatLimit: auditA.facts.recomputedProgress?.repeatLimit, criteriaLimit: auditA.facts.recomputedProgress?.criteriaLimit })}`);
  note('a-idle-full-audit', auditA.issues.length === 0, auditA.issues.join(' ｜ ') || '字段、落点、指令下发全部对得上');

  /**
   * 阈值不用重启就生效——这条是「配置化」的正身证据，而且完全不需要额外跑轮：
   * App 在没有 `no-progress.json` 的目录里起来（默认 2/2），渲染进程连上之后配置文件才写，
   * 紧接着的判定事件里记的就是 1/1。判定当下现读配置，不是启动时快照。
   * 只在「启动时确实没有配置文件」时才有意义，否则阈值本来就带着跑，证不出热生效。
   */
  note('a-threshold-applies-without-restart',
    !hadConfig
    && Date.parse(evidence.configWrittenAt) > Date.parse(evidence.rendererReadyAt)
    && auditA.facts.progress?.repeatLimit === 1 && auditA.facts.recomputedProgress?.repeatLimit === 1,
    `进程启动时 ${hadConfig ? '已有用户配置（这条在本轮证不到，需要空配置目录起进程）' : `没有 no-progress.json（默认 ${JSON.stringify(evidence.defaults)}）`}`
    + `｜渲染进程 ${evidence.rendererReadyAt} 连上，${evidence.configWrittenAt} 才写入 ${JSON.stringify({ repeatLimit: 1, criteriaLimit: 1 })}`
    + `｜同进程后续判定事件里的阈值 ${JSON.stringify({ repeatLimit: auditA.facts.progress?.repeatLimit, criteriaLimit: auditA.facts.progress?.criteriaLimit })}`);

  // 第 3 条判定：重规划之后仍然空转 → 必须改口停下等人，且不再开新轮。
  // 索引不写死：万一第 2 条就直接停手（缺权限类不给重规划机会），B 段取的是「接回去之后新增的那条」。
  const stopIdx = allA.findIndex((item, index) => index >= 1 && item.nextAction === 'stop_and_wait');
  const stopEvent = stopIdx >= 0 ? allA[stopIdx] : null;
  const eventsStop = eventsA;
  if (stopEvent) {
    writeJson('events.after-stop.json', eventsStop);
    writeJson('decision-stop.json', stopEvent);
    const auditStop = auditIdle(stopEvent, eventsStop, true);
    if (stopIdx !== 1) phaseA.decisions.push({ round: stopIdx + 1, ...auditStop.facts, issues: auditStop.issues });
    note('a-second-idle-stops-for-user',
      auditStop.facts.decisionType === 'WAIT_USER' && auditStop.facts.nextAction === 'stop_and_wait'
      && Number(auditStop.facts.progress?.noProgressStreak ?? 0) >= 2,
      `第 ${String(stopIdx + 1)} 条判定 ${auditStop.facts.decisionType} → ${auditStop.facts.nextAction}` +
      `｜连续第 ${String(auditStop.facts.progress?.noProgressStreak ?? '?')} 轮空转` +
      `｜新轮 ${String(auditStop.facts.newRoundId ?? '无')}｜${auditStop.issues.join(' ｜ ') || '无遗留问题'}`);
    // 停下之后任务必须还活着（等用户点继续），不能被标成失败。
    const stillRunning = storeTask(taskA);
    note('a-stop-waits-for-user-not-failed',
      auditStop.facts.newRoundId === null && String(stillRunning?.status) === 'report_pending',
      `任务状态 ${String(stillRunning?.status)}｜判定 ${stopEvent.decisionType}`
      + `｜界面入口「继续修复（重新执行验证）」/「接受未验证并结束」`);
  } else {
    const latest = allA.slice(-1)[0];
    phaseA.decisions.push({ round: allA.length + 1, skipped: true, lastDecision: latest?.decisionType ?? null });
    note('a-second-idle-stops-for-user', false,
      `三条判定里没有一条落在 stop_and_wait（静默期后共 ${String(allA.length)} 条）`
      + `；最后一条判定 ${String(latest?.decisionType)} → ${String(latest?.nextAction)}`);
  }

  // ── 界面：分类要能在「工程目标」卡上读到 ──
  const newest = stopEvent ?? idleEvent;
  note('ui-shows-probe', await selectTaskRow('M3-2 反空转探针（阈值 1/1）', taskA), '侧栏选中探针');
  const finalEvents = await taskEvents(taskA);
  const finalTask = await getTask(taskA);
  const projection = projectGoalDrivenWorkbench({
    workId: taskA,
    originalRequest: finalTask?.userPrompt ?? 'M3-2 反空转探针',
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
    card,
    expectedLine,
    projectionCycleDecision: projection.cycle.decision ?? null,
    causeText: newest.noProgressCause ? CYCLE_NO_PROGRESS_CAUSE_TEXT[newest.noProgressCause] : null
  };
  note('ui-idle-cause-readable',
    Boolean(card?.decisionLine) && card.decisionLine.includes('原因分类'),
    `界面「${String(card?.decisionLine ?? '没有这一行').slice(0, 200)}」`);
  note('ui-cycle-decision-matches-newest-event',
    Boolean(card?.decisionLine)
      && card.decisionLine.includes(newest.decisionType)
      && card.decisionLine.includes(CYCLE_NEXT_ACTION_TEXT[newest.nextAction] ?? String(newest.nextAction))
      && card.decisionLine.includes(String(newest.reason).replace(/\s+/g, ' ')),
    `应为「${expectedLine.slice(0, 200)}」｜最新事件 ${newest.decisionType}/${newest.nextAction}`);
  note('ui-projection-single-source', expectedLine !== ''
    && (card?.decisionLine ?? '').replace(/\s+/g, ' ') === expectedLine.replace(/\s+/g, ' '),
    `投影句 ${String(expectedLine).slice(0, 140)}`);
  note('ui-card-scrolled', await scrollIntoView('.goal-contract-card') === true, '截图前把「工程目标」卡滚进视口');
  await shot('01-idle-decision-goal-card.png');

  // ── B 段：不重启，把阈值改成 99/99，由用户入口「继续修复」把停下的任务接回去 ──
  // 判定当下现读配置（`resolveNoProgressLimits` 在每次决策里重新读文件），所以这一段不需要
  // 再建一具探针：同一份未满足标准 + 同一份报告，只把阈值换掉，看判定改不改口。
  const raised = { repeatLimit: 99, criteriaLimit: 99 };
  fs.writeFileSync(CONFIG, `${JSON.stringify(raised)}\n`);
  evidence.currentConfig = raised;
  const readBack = resolveNoProgressLimits({ config: JSON.parse(fs.readFileSync(CONFIG, 'utf8')) });
  note('config-raised-read-back',
    readBack.repeatLimit === 99 && readBack.criteriaLimit === 99,
    `${CONFIG} 写入 ${JSON.stringify(raised)}，解析结果 ${JSON.stringify(readBack)}`);

  const phaseB = { label: '阈值热切 99/99（同一探针、同一进程，经「继续修复」由用户接回去）', taskId: taskA, decisions: [] };
  evidence.phases.push(phaseB);

  // resumeRepair 在主进程里会把下一轮整个跑完，`awaitPromise` 会挂在 CDP 上直到超时，
  // 所以这里只点火、把结果收进页面变量，判定到没到用事件流说话。
  const fired = await ev(`(() => {
    window.__m32Resume = 'pending';
    window.agentAPI.resumeRepair(${JSON.stringify(taskA)})
      .then(() => { window.__m32Resume = 'ok'; })
      .catch(error => { window.__m32Resume = String(error && error.message ? error.message : error); });
    return 'fired';
  })()`, 30000);
  await sleep(8000);
  const resumeState = await ev('window.__m32Resume', 10000);
  const blocked = fired !== 'fired'
    || (typeof resumeState === 'string' && resumeState !== 'pending' && resumeState !== 'ok');
  note('b-resume-fired', !blocked,
    `点火返回 ${JSON.stringify(fired)}｜8 秒后页面记录 ${JSON.stringify(resumeState)}`
    + '（pending 表示主进程还在跑下一轮，ok 表示已返回）');
  if (blocked) {
    /**
     * 2026-11-28 真机现网就停在这里：任务被 WAIT_USER 停在 `report_pending`，而这一轮的
     * 三项检查都跑了（compile/run/tests 全 skipped 也算跑过，`verified: yes`），
     * `resumeRepair` 于是判定「这一轮已经完成全部检查，不需要继续修复」直接拒了。
     * 界面上剩下的只有「接受未验证并结束」和取消——**停下等人的那条判定，用户没有「再来一轮」的入口**。
     * 这条不是探针没造出证据，是产品缺口，归 M3-4「用户介入后继续」补；
     * 因此这里不再干等 22 分钟，只把拒绝原文留证并说明哪一半没证到。
     */
    evidence.bBlocked = { refusal: String(resumeState), at: new Date().toISOString() };
    note('b-hot-threshold-pending-m3-4', false,
      `「调大即等效关闭」的判定侧没能在现场证到：接回去被拒「${String(resumeState).slice(0, 90)}」。`
      + '阈值即时生效的正面证据在 a-threshold-applies-without-restart（启动时无配置=默认 2/2，运行中写 1/1，紧接着的判定事件里就是 1/1）；'
      + '「阈值调大不再拦」由离线用例 scripts/check-cycle-decision.mjs 覆盖，现场补证放到 M3-4 的用户介入用例');
  } else {
    await waitDecisions(taskA, allA.length + 1, 'B 段新增判定', allA.length);
    await sleep(SETTLE);
    const eventsB = await taskEvents(taskA);
    writeJson('events.raised-threshold.json', eventsB);
    const decisionsB = eventsB.filter(item => item.type === 'cycle.decision.created');
    const probeEvent = decisionsB[allA.length] ?? decisionsB.slice(-1)[0];
    assert.ok(probeEvent, '接回去之后没有出现新的判定');
    writeJson('decision-raised.json', probeEvent);

    // 「用户接回去」这条要在日志里留痕：编排器收到 resumeRepair 会先写一句固定话术。
    const resumeLog = eventsB.find(item => item.type === 'log'
      && String(item.message ?? '').includes('按当前环境继续修复'));
    const stopAt = stopEvent?.at ?? 0;
    note('b-resumed-from-user-entry',
      Boolean(resumeLog) && Number(resumeLog?.at) >= stopAt,
      `日志「${String(resumeLog?.message ?? '没有这条日志').slice(0, 60)}」｜停在待确认 ${(new Date(stopAt)).toLocaleTimeString('zh-CN')}`);

    const auditB = auditIdle(probeEvent, eventsB, false);
    phaseB.decisions.push({ round: allA.length + 1, ...auditB.facts, issues: auditB.issues });
    note('b-threshold-recorded-in-event',
      auditB.facts.progress?.repeatLimit === 99 && auditB.facts.progress?.criteriaLimit === 99,
      `事件里的阈值 ${JSON.stringify({ repeatLimit: auditB.facts.progress?.repeatLimit, criteriaLimit: auditB.facts.progress?.criteriaLimit })}｜streak ${String(auditB.facts.progress?.noProgressStreak)}`
      + `｜标准停滞计数 ${String(auditB.facts.progress?.criteriaStreak)}`);
    note('b-no-idle-when-raised',
      auditB.facts.idleRecomputed === false && auditB.facts.noProgressCause === null,
      `${probeEvent.decisionType} → ${probeEvent.nextAction}｜分类 ${String(auditB.facts.noProgressCause)}｜理由「${String(probeEvent.reason).slice(0, 120)}」`);
    note('b-idle-directive-absent',
      auditB.facts.nextRoundHasIdleDirective !== true,
      `下一轮计划请求 ${String(auditB.facts.nextRoundPromptBytes ?? 0)} 字节，含「系统判定」${String(auditB.facts.nextRoundHasIdleDirective)}`);
    note('b-full-audit', auditB.issues.length === 0, auditB.issues.join(' ｜ ') || '阈值调大后没有再拦，字段仍完整');
  }

  const aStill = await cleanupProbe(taskA);
  note('probe-a-cleaned-up', aStill === false, `删除后仍存在 ${String(aStill)}`);

  // ── 恢复用户数据目录原状 ──
  if (hadConfig) fs.copyFileSync(configBackup, CONFIG);
  else fs.rmSync(CONFIG, { force: true });
  note('config-restored',
    hadConfig ? fs.readFileSync(CONFIG, 'utf8') === fs.readFileSync(configBackup, 'utf8') : !fs.existsSync(CONFIG),
    hadConfig ? '恢复成用户原有的 no-progress.json' : `删除本次写入的配置，${CONFIG} 现在存在 ${String(fs.existsSync(CONFIG))}`);
  note('tasks-back-to-baseline',
    (readStore().tasks ?? []).length === evidence.before.tasks,
    `任务数 ${String(evidence.before.tasks)} → ${String((readStore().tasks ?? []).length)}`);

  // 探针工作区是本次新建的临时目录（只有 d1/a.txt、d2/b.txt 这类产物），验收完删掉；
  // 用户数据目录只动过 no-progress.json，已按原状恢复。
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  note('probe-workspace-removed', !fs.existsSync(WORKSPACE), WORKSPACE);
}

try {
  await main();
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(`FAIL ${evidence.error}`);
} finally {
  evidence.finishedAt = new Date().toISOString();
  await stopDev('SIGTERM');
  // 中断时也要把配置恢复掉：留下 99/99 会让用户的反空转静默失效。
  try {
    if (evidence.backups?.config?.endsWith('no-progress.before.json') && fs.existsSync(path.join(OUT_DIR, 'no-progress.before.json'))) {
      fs.copyFileSync(path.join(OUT_DIR, 'no-progress.before.json'), CONFIG);
    } else if (fs.existsSync(CONFIG) && String(evidence.backups?.config ?? '').startsWith('原本没有')) {
      fs.rmSync(CONFIG, { force: true });
    }
  } catch { /* 恢复失败在下面如实记录 */ }
  evidence.configRestoredAfterError = {
    exists: fs.existsSync(CONFIG),
    content: fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8').slice(0, 200) : null
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  const checks = Object.entries(evidence.checks);
  const failed = checks.filter(([, item]) => item.ok !== true);
  // 「已删除」只能由删除回执来说：中途抛错时 cleanupProbe 根本不会执行，写死一句
  // 「收尾已删除」会把留在用户数据目录里的探针任务藏掉（2026-11-28 第 5 次真机就是这样漏的）。
  const receipts = evidence.cleanup ?? [];
  const removedCount = receipts.filter(item => item.removed === true).length;
  const noReceipt = (evidence.phases ?? [])
    .map(phase => phase.taskId)
    .filter(id => id && !receipts.some(item => item.taskId === id));
  const probeLine = [
    (evidence.phases ?? []).map(phase => '`' + String(phase.taskId) + '`（' + phase.label + '，maxRounds=' + String(phase.maxRounds ?? '同 A 段') + '）').join(' → ') || '未创建',
    '，' + String(removedCount) + '/' + String((evidence.phases ?? []).length) + ' 具已删除',
    noReceipt.length > 0 ? '｜另有 ' + noReceipt.map(id => '`' + id + '`').join('、') + ' 没有删除回执，需手工核对默认数据目录' : ''
  ].join('');
  const lines = [
    '# V4 P1 M3-2 真机验收：反空转拦得下、说得清、关得掉',
    '',
    `- 时间：${evidence.startedAt} ~ ${evidence.finishedAt}`,
    `- 环境：${evidence.mode}`,
    `- 工作区：\`${WORKSPACE}\`（探针只在这里写文件）`,
    `- 阈值：产品默认 ${JSON.stringify(evidence.defaults)}；真机 A 段把 \`no-progress.json\` 下调为 ${JSON.stringify({ repeatLimit: 1, criteriaLimit: 1 })}（只为把用例压到三轮判定，触发轮数由离线用例 \`npm run test:cycle-decision\` 按默认值覆盖），B 段热切为 ${JSON.stringify({ repeatLimit: 99, criteriaLimit: 99 })} 证明回退开关`,
    `- 探针任务：${probeLine}`,
    `- 探针目标：${COMPLETION}`,
    '  （要求「文件内容等于自身的 sha256」：做不到但没有矛盾，模型既无从澄清也无从伪造，只会连续几轮把同一条校验再跑一遍）',
    `- 备份：${evidence.backups?.store ?? '未生成'}；配置：${evidence.backups?.config ?? '未处理'}`,
    '',
    '## 一具探针、四次判定的原文与逐条审计',
    '',
    '```json',
    JSON.stringify(evidence.phases, null, 2),
    '```',
    '',
    '## 界面读数（工程目标卡）',
    '',
    '```json',
    JSON.stringify(evidence.ui, null, 2),
    '```',
    '',
    '## 代答的澄清（模型每提一次问就记一条，用例本身不测澄清）',
    '',
    evidence.clarifications.length > 0
      ? `共 ${String(evidence.clarifications.length)} 次。模型在这一串探针上倾向于提问而不是干重跑，本轮为缩短用例以用户身份一次性挡回，答复固定为同一段话。`
      : '无：模型全程没有落到待澄清。',
    '',
    '```json',
    JSON.stringify(evidence.clarifications, null, 2),
    '```',
    '',
    '## 中断原因',
    '',
    evidence.error ? evidence.error : '无。',
    '',
    `## 配置目录终态`,
    '',
    '```json',
    JSON.stringify(evidence.configRestoredAfterError, null, 2),
    '```',
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
    '事件原文：`events.after-idle.json`（A 段三条判定到手后）、`events.after-stop.json`（停下等人的那条）、',
    '`events.raised-threshold.json`（B 段阈值热切后的第 4 条）；判定单条原文见 `decision-*.json`。'
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'EVIDENCE.md'), `${lines.join('\n')}\n`);
  console.log(`EVIDENCE ${path.relative(ROOT, path.join(OUT_DIR, 'EVIDENCE.md'))}`);
  process.exitCode = failed.length > 0 || evidence.error ? 1 : 0;
}
