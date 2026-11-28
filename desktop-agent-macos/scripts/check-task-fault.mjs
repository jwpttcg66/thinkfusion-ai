/**
 * V4 P1 M3-4d：两条把任务推向终态的放大器。
 *
 * 原来错在哪：
 * 1. `driveRound` 的六条 `.catch(error => this.fail(taskId, error))` 把所有异常一律写成
 *    终态 `failed`。「模型连续 120 秒没有输出」是通道停住，「请求超时」是没接上——任务本身
 *    没错，可 `failed` 没有出边，用户换好网络只能重新提问，前几轮的产物和检查点就此作废。
 *    真机留证：`acceptance/v4-p1-m3-3-20261128/events.after-budget-exhausted.json` 里
 *    任务正在 `cancelling`，一条「请求超时」把它判成了失败（用户做的是取消，看到的却是失败）。
 * 2. `plan.invalid` 白烧整轮：模型在步骤上多写 `dependsOn`/`expect`/`checksCategory`
 *    （真机样本 8 个步骤全带），`StepSchema` 每个分支 `.strict()` 于是整份计划判废，
 *    代价是一轮真实模型调用；而自纠次数算的是**整条任务的历史总量**，长任务早段撞过一次之后
 *    后面每次撞上都不再给自纠机会，下场仍是终态失败。
 *
 * 用例分工：
 * - 分类纯函数：真机原文逐条对上落点，无关异常仍判失败（行为不默认变化）；
 * - 用户在按暂停/取消时不被超时报「失败」顶掉结局；
 * - schema：只接住说明字段，执行参数一格都不放宽（放宽那里等于把「模型写错」变成「机器做错事」）；
 * - 忽略要说出来：`dependsOn` 接住 ≠ 生效，文案必须点明依赖不会被强制；
 * - 活动流投影与源码守卫：证明落点、事件、界面三件齐，且没被后来的改动摘掉；
 * - 真跑一遍：`TaskManager` 的状态表与 `fail()` 的落点各起一个内存实例测。源码字符串只能证明
 *   那行字还在，证明不了 `blocked → interrupted` 这条边存不存在——缺边时 transition 抛错、
 *   兜底照发 `task.failed`，任务停在非终态而事件流说它死了（审查发现的第四个判死口）。
 *
 * Run: npm run test:task-fault
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PlanUnusableError, classifyFault, describeIgnoredAnnotations, stopIntent } from '../out-test/shared/task-fault.js';
import { parseAnswer } from '../out-test/shared/protocol.js';
import { buildTaskConversation } from '../out-test/shared/task-conversation.js';
// 落点这件事光看源码字符串是证不了的：状态表缺边要到 transition 真抛错那一刻才暴露。
import { AgentStore } from '../out-test/main/store.js';
import { TaskManager } from '../out-test/main/task-manager.js';
import { AgentOrchestrator } from '../out-test/main/orchestrator.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');

const TASK = 'task-fault';
const ROUND = 'round-1';

function plan(steps, over = {}) {
  return {
    protocol: 'desktop-agent/v1',
    type: 'plan',
    taskId: TASK,
    roundId: ROUND,
    title: '补齐 REPORT.md 并复验',
    description: '写文件、复跑探针、跑四类检查',
    steps,
    completion: { condition: '四类检查都有真实命令' },
    ...over
  };
}

const fenced = value => '这是计划：\n```json\n' + JSON.stringify(value, null, 2) + '\n```\n请确认。';

test('通道停住不落终态：真机原文「模型连续 120 秒没有输出」停在可恢复那侧', () => {
  const verdict = classifyFault(new Error('模型连续 120 秒没有输出，已停止。请重试或换模型。'));
  assert.equal(verdict.kind, 'channel_stall');
  assert.equal(verdict.status, 'interrupted', '终态 failed 没有出边，加完网络也接不回去');
  assert.ok(verdict.headline && !verdict.headline.includes('任务失败'), `说法要诚实但别判死：${verdict.headline}`);
  assert.match(verdict.howBack, /继续任务/, '停而没说怎么回来，等于让人猜哪颗按钮有效');
});

test('通道超时与网络断同样停在「已中断」（真机 M3-3 那条「请求超时」）', () => {
  for (const message of ['请求超时', 'fetch failed', 'socket hang up', 'read ECONNRESET']) {
    const verdict = classifyFault(new Error(message));
    assert.equal(verdict.kind, 'channel_timeout', message);
    assert.equal(verdict.status, 'interrupted', message);
  }
});

test('「连不上」是通道没接上，不是任务失败（真机第 8 次：超算网关断了被判死）', () => {
  // 逐字取自 2026-11-28 真机现场：acceptance/v4-p1-m3-4-20261128/fault.cloud-unreachable.json
  // （task 58aac0cd，status=failed，error 原文见该文件）。原来 NETWORK 只有英文关键词，
  // provider 自己包成的中文一句都不命中，于是评审阶段的连接失败也走终态。
  const live = [
    '主导模型五段汇总失败：连不上 https://api.scnet.cn/api/llm/v1',
    '连不上 Ollama（http://127.0.0.1:11434）。确认 ollama serve 在运行'
  ];
  for (const message of live) {
    const verdict = classifyFault(new Error(message));
    assert.equal(verdict.kind, 'channel_timeout', message);
    assert.equal(verdict.status, 'interrupted', `${message} 落终态之后用户换好网络只能重新提问`);
    assert.match(verdict.headline, /通道/, message);
    assert.match(verdict.howBack, /继续任务/, '停而没说怎么回来，等于让人猜哪颗按钮有效');
  }
  // 生产方改文案（把「连不上」换成别的说法）会让这条静默失效，所以同时钉住原文。
  const openai = read('src/main/providers/openai-compatible.ts');
  const ollama = read('src/main/providers/ollama.ts');
  assert.match(openai, /连不上 \$\{this\.baseUrl\}/, 'openai-compatible 的连接失败说法变了');
  assert.match(ollama, /连不上 Ollama（\$\{this\.baseUrl\}）/, 'ollama 的连接失败说法变了');
});

test('会话上下文已满也不是任务失败：它要的是一条新会话', () => {
  const verdict = classifyFault(new Error('ChatGPT 这条会话的上下文已满，自动开新会话也没成功（站点拒绝新建）。'));
  assert.equal(verdict.kind, 'channel_context_full');
  assert.equal(verdict.status, 'interrupted');
  assert.match(verdict.howBack, /检查点/);
});

test('网页源没打开停在「受阻」：要的是拨一下开关，不是重新提问', () => {
  // 真机 2026-11-28：默认网页源全关，探针第一轮直接判死，界面只说「任务失败」。
  for (const message of ['ChatGPT 还没启用，先在设置里打开', '网页源已关闭，这条追问接不回原会话。']) {
    const verdict = classifyFault(new Error(message));
    assert.equal(verdict.kind, 'source_disabled', message);
    assert.equal(verdict.status, 'blocked', 'failed 没有出边，用户拨完开关也只能重新提问');
    assert.match(verdict.headline, /网页源/, message);
    assert.match(verdict.howBack, /设置/, '得说清去哪儿打开，否则提示没法照做');
    assert.match(verdict.howBack, /继续任务/, '还要说清打开之后怎么接回去');
  }
});

test('主进程那两句原文仍命中分类，提问路径也说同一句话', () => {
  const main = read('src/main/index.ts');
  assert.match(main, /throw new Error\(`\$\{source\.label\} 还没启用，先在设置里打开`\)/, 'activateSource/reloadPage 的原文变了');
  assert.match(main, /detail: '网页源已关闭'/, '追问恢复路径的原文变了');
  // 光有分类不够：提问路径原来只会说「X 页面尚未就绪」，用户看不出是开关的问题。
  assert.match(main, /closedReason: \(\) => \{/, 'adapterFor 没把「源关着」这句话递给驱动');
  const driver = read('src/main/adapters/browser/page-driver.ts');
  assert.match(driver, /const closed = this\.closedReasonOf\(\);/, '视图缺失时先看是不是源关着');
  assert.match(driver, /if \(closed\) throw new Error\(closed\);/, '源关着要说那句能照做的提示');
  assert.match(driver, /throw new Error\(`\$\{this\.siteLabel\} 页面尚未就绪`\);/, '开着的源还没建视图，仍说原来的话');
  assert.equal(classifyFault(new Error('DeepSeek 还没启用，先在设置里打开')).kind, 'source_disabled');
  assert.equal(classifyFault(new Error('网页源已关闭')).kind, 'source_disabled');
});

test('计划不能用停在「受阻」，不是判死', () => {
  const verdict = classifyFault(new PlanUnusableError('计划校验失败：steps.0：Unrecognized key(s) in object'));
  assert.equal(verdict.kind, 'plan_unusable');
  assert.equal(verdict.status, 'blocked');
  assert.match(verdict.howBack, /换手段再来一轮/);
});

test('与通道无关的异常照旧判失败（行为不默认变化）', () => {
  const verdict = classifyFault(new Error('工作区目录不存在，无法授权执行'));
  assert.equal(verdict.kind, 'task_fault');
  assert.equal(verdict.status, 'failed');
});

test('用户在按暂停/取消时，通道故障不许顶掉用户选的结局', () => {
  assert.equal(stopIntent('cancelling'), 'cancelled');
  assert.equal(stopIntent('cancel_requested'), 'cancelled');
  assert.equal(stopIntent('pausing'), 'paused');
  assert.equal(stopIntent('pause_requested'), 'paused');
  // 没在停的过程中就交回分类结论，别把普通失败也改成取消。
  assert.equal(stopIntent('executing'), null);
  assert.equal(stopIntent('report_pending'), null);
});

test('真机样本那份计划（8 步全带 dependsOn/expect）不再被判废', () => {
  const steps = Array.from({ length: 8 }, (_, index) => ({
    id: `step-${String(index + 1)}`,
    tool: index % 2 === 0 ? 'fs.writeFile' : 'shell.run',
    args: index % 2 === 0
      ? { path: `out/${String(index)}.md`, content: '# x' }
      : { command: `sh /tmp/probe-${String(index)}.sh`, cwd: '/tmp' },
    dependsOn: index === 0 ? [] : [`step-${String(index)}`],
    purpose: '模型自述的意图，早就能接住',
    ...(index < 5 ? { checksCategory: ['tests', 'compile', 'run'][index % 3] } : {}),
    expect: index % 2 === 0 ? { created: true } : { exitCode: 0, stdout: '' }
  }));
  const result = parseAnswer(fenced(plan(steps)), { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'plan', result.kind === 'invalid' ? result.error : result.kind);
  // 接住 ≠ 丢掉：这些字段要留在计划里给评审看。
  assert.deepEqual(result.plan.steps[1].dependsOn, ['step-1']);
  assert.equal(result.plan.steps[2].checksCategory, 'run');
  assert.equal(result.plan.steps[4].checksCategory, 'compile');
  assert.deepEqual(result.plan.steps[1].expect, { exitCode: 0, stdout: '' });
  assert.equal(result.plan.steps.filter(step => step.checksCategory !== undefined).length, 5, '真机样本就是 8 步带依赖、5 步带检查类别');
});

test('执行参数一格都不放宽：args 多写键仍判非法', () => {
  const result = parseAnswer(fenced(plan([
    { id: 'step-1', tool: 'fs.list', args: { path: '.', recurse: true } }
  ])), { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'invalid', '把「模型写错参数」变成「机器多做一件事」比烧一轮危险得多');
  assert.match(result.error, /recurse/);
});

test('接住的说明字段仍有形状约束：dependsOn 不是万能口袋', () => {
  const asString = parseAnswer(fenced(plan([
    { id: 'step-1', tool: 'fs.list', args: { path: '.' }, dependsOn: 'step-0' }
  ])), { taskId: TASK, roundId: ROUND });
  assert.equal(asString.kind, 'invalid');
  const tooLong = parseAnswer(fenced(plan([
    { id: 'step-1', tool: 'fs.list', args: { path: '.' }, expect: 'x'.repeat(1001) }
  ])), { taskId: TASK, roundId: ROUND });
  assert.equal(tooLong.kind, 'invalid');
});

test('忽略要说出来：dependsOn 接住不等于依赖生效', () => {
  const text = describeIgnoredAnnotations([
    { id: 'a', tool: 'fs.list', args: { path: '.' }, dependsOn: [], expect: { exitCode: 0 } },
    { id: 'b', tool: 'fs.list', args: { path: '.' }, dependsOn: ['a'] }
  ]);
  assert.ok(text, '有被忽略的字段就必须留下一句');
  assert.match(text, /dependsOn ×2/);
  assert.match(text, /不会被强制/, '否则「依赖已声明」会被读成「依赖被执行器保证了」');
});

test('没有 dependsOn 时不提它，只说明字段被保留', () => {
  const text = describeIgnoredAnnotations([
    { id: 'a', tool: 'fs.list', args: { path: '.' }, acceptance: '列出根目录' }
  ]);
  assert.ok(text);
  assert.doesNotMatch(text, /不会被强制/);
  assert.match(text, /acceptance ×1/);
  assert.equal(describeIgnoredAnnotations([{ id: 'a', tool: 'fs.list', args: { path: '.' } }]), null);
});

test('活动流：异常停住要留下一行「停在哪、怎么回来」', () => {
  const entries = buildTaskConversation([
    { type: 'round.started', at: 10, taskId: TASK, roundId: ROUND, roundNumber: 1, inputType: 'execution_report' },
    {
      type: 'task.fault.stopped',
      at: 11,
      taskId: TASK,
      roundId: ROUND,
      kind: 'channel_stall',
      error: '模型连续 120 秒没有输出，已停止。请重试或换模型。',
      landedStatus: 'interrupted',
      headline: '这一轮模型不再输出，是通道停住了',
      howBack: '不是任务做错了：换模型或等通道恢复后点「继续任务」，会按上一轮检查点重开一轮。'
    }
  ]);
  const note = entries.find(entry => entry.subtype === 'fault');
  assert.ok(note, `停必须留下可读的痕迹：${JSON.stringify(entries.map(entry => entry.text))}`);
  assert.match(note.text, /通道停住了/);
  assert.match(note.text, /停在「interrupted」/);
  assert.match(note.detail, /模型连续 120 秒没有输出/, '分类名之外还要有原文，否则分不清是网络还是模型');
  assert.match(note.detail, /继续任务/);
});

test('活动流：没有这条事件时不凭空生成异常旁注', () => {
  const entries = buildTaskConversation([
    { type: 'round.started', at: 1, taskId: TASK, roundId: ROUND, roundNumber: 1, inputType: 'user_prompt' }
  ]);
  assert.equal(entries.filter(entry => entry.subtype === 'fault').length, 0);
});

test('主进程：异常收敛按分类落点，不再一律判死', () => {
  const main = read('src/main/orchestrator.ts');
  const body = main.slice(main.indexOf('  private fail(taskId: string, error: unknown) {'));
  assert.ok(body.length > 200, '找不到 fail()');
  assert.match(body, /classifyFault\(/, '落点要由分类给出，不在这里再猜一遍关键词');
  assert.match(body, /stopIntent\(task\.status\)/, '用户在按暂停/取消时不能被超时顶掉结局');
  assert.match(body, /this\.tasks\.transition\(taskId, landed/, '要落到分类给的那一侧');
  assert.match(body, /type: 'task\.fault\.stopped'/, '可恢复的停要留事件');
  assert.match(body, /if \(landed === 'failed'\)/, '终态仍留给真正的任务问题');
  // 只有 failed 那一支发 task.failed；可恢复支发 fault。
  const failedIdx = body.indexOf("type: 'task.failed'");
  const faultIdx = body.indexOf("type: 'task.fault.stopped'");
  assert.ok(failedIdx > 0 && faultIdx > 0 && faultIdx > failedIdx, '两条出口各发各的事件');
});

test('主进程：批准执行/续跑那条 catch 也走分类落点，不留第二个判死的门', () => {
  const main = read('src/main/orchestrator.ts');
  const start = main.indexOf('  private async executeApprovedPlan(');
  assert.ok(start > 0, '找不到 executeApprovedPlan()');
  const body = main.slice(start, main.indexOf('\n  /**', start + 40) > 0 ? main.indexOf('\n  /**', start + 40) : start + 6000);
  assert.ok(body.includes('dispatchPlan'), '切片没盖到执行段，后面的断言会变成空断言');
  assert.match(body, /this\.fail\(task\.taskId, error\)/, '异常要交给 fail() 分类，不在这里自己写落点');
  assert.equal(body.includes("transition(task.taskId, 'failed'"), false,
    '这条 catch 直接写终态就等于绕开分类：批准之后断通道仍然判死');
  // 用户取消之后 Runtime 的拒绝是预期结果，这条分支不能被 fail() 之外的路径悄悄改掉。
  assert.match(body, /if \(this\.tasks\.get\(task\.taskId\)\.status === 'cancelled'\)/, '取消态仍走静默返回，不从 cancelled 迁走');
  // 整份 orchestrator 里「自己写终态」的地方必须数得过来，否则新的通道故障入口又会从缝里漏出去。
  // 允许的四处：工作流定义生成不出计划（静态配置错，不是通道）、两处「未确认交付」的收口、
  // fail() 自己的兜底那一条（它只在分类落点写不进去时才执行，见下面 catch 的守卫）。
  const direct = [...main.matchAll(/this\.tasks\.transition\((?:task\.taskId|taskId), 'failed'/g)];
  assert.equal(direct.length, 4, `直接写 failed 的地方变成 ${String(direct.length)} 处，逐条核对是否绕开了 classifyFault`);
  // 兜底不许只发事件不改状态：行还在非终态时发 `task.failed`，等于在堵误判的地方再开一个误判。
  const fallbackAt = main.indexOf("if (TERMINAL.includes(now.status)) return;");
  assert.ok(fallbackAt > 0, '找不到 fail() 的兜底段，后面的断言会是空断言');
  const fallback = main.slice(fallbackAt, fallbackAt + 600);
  assert.match(fallback, /this\.tasks\.transition\(taskId, 'failed', \{ error: message \}\)/, '兜底要先把状态真写成终态');
  assert.match(fallback, /连失败落点也没写进去/, '写不进状态时只留日志，不许让事件与状态对不上');
  // 「一个步骤都没跑成」那一支原来也直接判死：它最常见的成因就是通道（CLI 起不来 / provider 连不上）。
  const zeroStep = main.slice(main.indexOf("if (report.results.length === 0) {"), main.indexOf("if (report.results.length === 0) {") + 700);
  assert.match(zeroStep, /this\.fail\(task\.taskId, new Error\(message\)\)/, '零步骤那支要交给同一个分类器，不再自己写终态');
});

test('主进程：计划判废的三处抛错都带上「可恢复」标记', () => {
  const main = read('src/main/orchestrator.ts');
  // 切的是 `kind === 'none'` 到 `kind === 'clarification'` 之间那三段（缺块、不合规、冲突）；
  // 后面还有「本地状态与完成声明不一致」那种真·任务问题，它该继续走失败，不许一并改成受阻。
  const region = main.slice(main.indexOf("if (result.kind === 'none')"), main.indexOf("if (result.kind === 'clarification')"));
  assert.ok(region.length > 200, '找不到计划判废那三段');
  assert.equal(region.match(/throw new Error\(/g)?.length ?? 0, 0, '裸 Error 会被 classifyFault 判成任务失败');
  assert.equal(region.match(/new PlanUnusableError\(/g)?.length, 3, '三处都要走同一个可恢复落点');
  assert.ok(main.indexOf("throw new Error('本地状态与完成声明不一致") > main.indexOf("if (result.kind === 'complete')"), '状态不一致仍走失败这条');
});

test('主进程：自纠次数数的是连着几次，不是整条任务的历史总量', () => {
  const main = read('src/main/orchestrator.ts');
  const repair = main.slice(main.indexOf('private repairPlan('), main.indexOf('async setReviewDisposition('));
  assert.match(repair, /rounds\[rounds\.length - 1 - attempts\]\.inputType === 'plan_repair'/);
  assert.doesNotMatch(repair, /filter\(round => round\.inputType === 'plan_repair'\)\.length/, '生命周期总量等于长任务后来一次都不给自纠');
  assert.match(repair, /if \(attempts >= 2\) return false/);
  // 门禁仍是 M3-3 那个唯一读点，没有为自纠开后门。
  assert.match(repair, /this\.tasks\.budgetView\(taskId\)\.gate\.ok/);
});

test('主进程：接住的说明字段挂进计划警告，审批的人看得见', () => {
  const main = read('src/main/orchestrator.ts');
  const ignoredStart = main.indexOf('const ignoredText = describeIgnoredAnnotations');
  assert.ok(ignoredStart > 0, '找不到这段');
  // 往后找 plan.ready：从文件头找会命中 `submit` 那一条（682 行），切出来是空串。
  const region = main.slice(ignoredStart, main.indexOf("type: 'plan.ready'", ignoredStart));
  assert.ok(region.length > 40, 'plan.ready 之前没有留下这段');
  assert.match(region, /planPreview\.warnings = \[\.\.\./);
});

test('契约与界面：事件进了联合类型、停法改了说法、修正轮单列', () => {
  const contracts = read('src/shared/contracts.ts');
  assert.match(contracts, /type: 'task\.fault\.stopped'/);
  assert.match(contracts, /kind: import\('\.\/task-fault'\)\.FaultKind/);
  // 活动流旁注才是现网真挂上去的面（`TaskProgressCard` 自 M3-3 起就没有引用点，M3-4 真机
  // 第三次就是按它取的数、恒为 null）。断言先落在活的这一侧，卡片那段只作措辞一致的备份。
  const stream = read('src/shared/task-conversation.ts');
  assert.match(stream, /subtype: 'fault'/, '故障停在可恢复那侧要在活动流留一条旁注');
  assert.match(stream, /\$\{event\.headline\} · 停在「\$\{event\.landedStatus\}」/, '旁注要点名落在哪个状态，不能只说停住了');
  assert.match(stream, /event\.howBack/, '旁注详情要带「怎么回来」');
  const card = read('src/renderer/src/components/engineering/TaskProgressCard.tsx');
  assert.match(card, /停下的原因：\{faultHere\.headline\}｜\{task\.error\}/, '可恢复的停不能写成「失败原因」');
  assert.match(card, /event\.landedStatus === task\.status/, '后来真的失败了不能拿旧的那条故障解释');
  assert.match(card, /怎么回来/);
  const stats = read('src/renderer/src/components/engineering/TaskStats.tsx');
  assert.match(stats, /payload\.inputType === 'plan_repair'/, '修正轮一样占预算轮数，得让人看出那轮没做事');
  assert.match(stats, /含 \$\{repairRounds\} 次计划修正/);
});

test('状态表（真跑）：本里程碑新加的落点都到得了、也接得回去', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tf-fault-landing-'));
  const store = new AgentStore(path.join(dir, 'agent-store.json'));
  const tasks = new TaskManager(store, () => {});
  const open = status => {
    const task = tasks.create({ prompt: '落点', permissionPreset: 'read-only', workspaceRoot: dir });
    tasks.transition(task.taskId, 'planning');
    tasks.transition(task.taskId, status);
    return task.taskId;
  };
  // 通道故障落在「等用户」的两个停点上：这两个状态原来是死路——transition 抛错之后
  // fail() 的兜底会把还能接回去的故障写成终态，正是 M3-4d 要堵的那个口。
  for (const from of ['blocked', 'budget_exhausted']) {
    const taskId = open(from);
    assert.doesNotThrow(() => tasks.transition(taskId, 'interrupted'), `${from} → interrupted 不可达，落点会退化成失败`);
    // 中断之后还能回到等预算：resume() 重读门禁时靠这条边把它送回原落点。
    assert.doesNotThrow(() => tasks.transition(taskId, 'budget_exhausted'), `${from} 中断后回不到预算落点`);
  }
  // 关掉无人值守停在 awaiting_next_round 的人，手里已经有一份报告，必须能就地收尾。
  const parked = tasks.create({ prompt: '收口', permissionPreset: 'read-only', workspaceRoot: dir });
  for (const step of ['planning', 'plan_ready', 'awaiting_approval', 'executing', 'verifying', 'report_pending', 'awaiting_next_round']) {
    tasks.transition(parked.taskId, step);
  }
  assert.doesNotThrow(() => tasks.transition(parked.taskId, 'completed'), '停在等待续轮就关不掉任务：只剩白烧一轮或取消两条路');
  // 落点之后还得接得回去：resume() 的允许名单里要有它们。
  const main = read('src/main/orchestrator.ts');
  assert.match(main, /\['paused', 'interrupted', 'budget_exhausted', 'blocked'\]\.includes\(task\.status\)/);
});

test('真跑 fail()：受阻/超预算遇上通道故障只留 fault，不发终态', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tf-fault-fail-'));
  const store = new AgentStore(path.join(dir, 'agent-store.json'));
  const events = [];
  const emit = event => {
    events.push(event);
    if (event.taskId) store.appendEvent({ ...event, eventId: `ev_${String(events.length)}`, runId: event.taskId });
  };
  const tasks = new TaskManager(store, emit);
  const orch = new AgentOrchestrator({
    tasks,
    store,
    adapter: () => ({ cancelWait: () => {} }),
    emit,
    dbPath: () => path.join(dir, 'journal.json')
  });
  const park = async status => {
    const task = tasks.create({ prompt: '在途故障', permissionPreset: 'read-only', workspaceRoot: dir });
    tasks.transition(task.taskId, 'planning');
    tasks.transition(task.taskId, status);
    events.length = 0;
    // TS 的 private 在运行时不是黑盒：这里要测的就是这个私有收敛点本身。
    await orch.fail(task.taskId, new Error('主导模型五段汇总失败：连不上 https://api.scnet.cn/api/llm/v1'));
    return task.taskId;
  };
  for (const status of ['blocked', 'budget_exhausted']) {
    const taskId = await park(status);
    assert.equal(tasks.get(taskId).status, 'interrupted', `${status} 上的通道故障被判成了 ${tasks.get(taskId).status}`);
    // 事件与状态必须同侧：行还在非终态却发一条 task.failed，重建出来的列表就显示「已失败」，
    // 统计页拿 endedAt 把总耗时冻在一条还没结束的任务上。
    assert.equal(events.filter(event => event.type === 'task.failed').length, 0, `${status}：状态没进终态，事件不许先进`);
    const fault = events.find(event => event.type === 'task.fault.stopped');
    assert.ok(fault, '可恢复的停要留一条能解释的 fault 事件');
    assert.equal(fault.landedStatus, 'interrupted');
  }
  // 真·任务问题仍然判死，这条兜底不许把两侧一起放松。
  const doomed = tasks.create({ prompt: '真失败', permissionPreset: 'read-only', workspaceRoot: dir });
  tasks.transition(doomed.taskId, 'planning');
  events.length = 0;
  await orch.fail(doomed.taskId, new Error('本地状态与完成声明不一致'));
  assert.equal(tasks.get(doomed.taskId).status, 'failed');
  assert.equal(events.filter(event => event.type === 'task.failed').length, 1);
});

test('存储：解释停止原因的那几条事件不许被 800 条窗口挤掉', () => {
  const main = read('src/main/store.ts');
  const region = main.slice(main.indexOf('const KEEP_FOREVER'), main.indexOf(']);', main.indexOf('const KEEP_FOREVER')));
  for (const type of ['task.fault.stopped', 'task.round.await_user', 'task.round.user_continue', 'task.auto_continue.updated']) {
    assert.ok(region.includes(`'${type}'`), `${type} 不在常驻名单里：headline/howBack 只活在这一条事件上，挤掉之后重启就说不清当初为什么停`);
  }
});

test('收口出口：三个收尾动作共用一份允许状态，界面不再各自判一遍', () => {
  const shared = read('src/shared/task-continue.ts');
  assert.match(shared, /export const DELIVERY_CLOSE_STATUSES[^=]*= \['report_pending', 'awaiting_next_round'\]/);
  const main = read('src/main/orchestrator.ts');
  // 原来三处各写 `task.status !== 'report_pending'`：改一处漏两处，用户点到的按钮当场抛错。
  assert.equal(main.match(/isDeliveryCloseAllowed\(task\.status\)/g)?.length, 3, 'acceptUnverified/resumeRepair/recheckVerification 要过同一道判据');
  assert.equal(main.match(/task\.status !== 'report_pending'/g)?.length ?? 0, 0, '还有一处自己判状态，awaiting_next_round 依旧关不掉');
  const app = read('src/renderer/src/App.tsx');
  assert.match(app, /isDeliveryCloseAllowed\(activeTask\.status\)/, '收尾按钮的显隐要跟主进程同一份判据，否则注释里那句「共用同一个出口」是空的');
});

test('渲染层：切任务/新对话要把上一条的续轮指令一起放下', () => {
  const app = read('src/renderer/src/App.tsx');
  const select = app.slice(app.indexOf('async function selectTask('), app.indexOf('try {', app.indexOf('async function selectTask(')));
  assert.match(select, /setContinueText\(''\)/, 'A 上写了一半的指令会留在 B 的输入框里，点一下就逐字进了 B 的计划请求');
  assert.equal(app.match(/setContinueText\(''\)/g)?.length ?? 0, 4, '提交后清空 + selectTask + 新对话 + 清空当前页都要清');
});

test('状态表：可恢复落点在任务跑着的时候都到得了', () => {
  const manager = read('src/main/task-manager.ts');
  const row = from => {
    const line = manager.split('\n').find(item => item.trimStart().startsWith(`${from}: [`));
    assert.ok(line, `状态表里找不到 ${from}`);
    return line;
  };
  for (const from of ['planning', 'executing', 'verifying', 'awaiting_approval', 'blocked', 'budget_exhausted']) {
    assert.ok(row(from).includes("'interrupted'"), `${from} → interrupted 不可达，落点会退化成失败`);
  }
  // blocked 自己不判「到得了 blocked」：那条边不存在也不需要（已经在受阻上了）。
  for (const from of ['planning', 'executing', 'verifying', 'awaiting_approval', 'budget_exhausted']) {
    assert.ok(row(from).includes("'blocked'"), `${from} → blocked 不可达`);
  }
});
