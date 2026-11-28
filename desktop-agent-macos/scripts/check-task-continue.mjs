/**
 * V4 P1 M3-4b：交付停在待确认时，人必须有一条「换手段再来一轮」的出口。
 *
 * 原来错在哪：GDC 判 `stop_and_wait` 时状态留在 `report_pending`，那里三个按钮中
 * 「继续修复」第一步就过 `verificationIsComplete`——编译/运行/测试/诊断都做全、但目标
 * 标准还没满足的任务（恰恰是 stop_and_wait 最常见的形状）当场抛「这一轮已经完成全部检查，
 * 不需要继续修复」，另两个出口都是收尾。于是「按人说的换个做法再来」在界面上无处可点，
 * 任务永久停住；状态表里也没有 `report_pending → planning` 这条边。
 *
 * 用例分工：
 * - 纯函数：上一轮手段清单（去重计数、标失败/跳过、封顶）、允许介入的状态集合；
 * - IPC 边界：指令空白/超长/多余键必须在边界拒掉，不能悄悄开一轮空请求；
 * - 计划请求：用户原话逐字进请求、清单一起下发、口径句按本轮范围改写给；
 * - 活动流投影：人要的那一轮与模型判出来的轮次分得开，详情说清「门禁怎么算的」；
 * - 源码守卫：不重跑判定（否则又拿一次 stop_and_wait）、过预算门禁、IPC/ preload/ 界面
 *   三件齐——只有源码能证明这条出口没被后来的改动摘掉。
 *
 * Run: npm run test:task-continue
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { autoContinueOf, continueExitText, isContinueRoundAllowed, meansOfRound } from '../out-test/shared/task-continue.js';
import { buildReportPrompt } from '../out-test/shared/protocol.js';
import { ContinueTaskRoundSchema, SetTaskAutoContinueSchema } from '../out-test/shared/schemas.js';
import { buildTaskConversation } from '../out-test/shared/task-conversation.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');

function step(tool, args, over = {}) {
  return {
    stepId: over.stepId ?? `s-${tool}-${Object.values(args)[0] ?? ''}`,
    tool,
    status: over.status ?? 'completed',
    verified: over.verified ?? true,
    durationMs: 10,
    args,
    ...('result' in over ? { result: over.result } : {})
  };
}

function report(results, over = {}) {
  return {
    protocol: 'thinkfusion.agent.v2',
    type: 'execution_report',
    taskId: 'task-1',
    roundId: 'round-1',
    planId: 'plan-1',
    status: 'completed',
    results,
    errors: [],
    nextAction: 'stop',
    createdAt: 1_700_000_000_000,
    ...over
  };
}

// ---------------------------------------------------------------- 上一轮手段清单

test('meansOfRound：点名到工具与关键参数，重复的记次数', () => {
  const lines = meansOfRound(
    report([
      step('shell.run', { command: 'go test ./...' }, { result: { exitCode: 1 } }),
      step('shell.run', { command: 'go test ./...' }, { result: { exitCode: 1 }, stepId: 'b' }),
      step('fs.write', { path: 'src/main.go', content: 'x'.repeat(300) }),
      step('shell.run', { command: 'go build ./...' }, { status: 'failed', stepId: 'c' })
    ])
  );
  assert.ok(lines.some(line => line.startsWith('shell.run command=go test ./...') && line.includes('×2')), `重复调用要记次数：${JSON.stringify(lines)}`);
  assert.ok(lines.some(line => line.startsWith('fs.write path=src/main.go') && !line.includes('x'.repeat(97))), '长参数要截断，不能把整份文件内容塞进计划请求');
  assert.ok(lines.some(line => line === 'shell.run command=go build ./...（失败）'), `失败要标出来：${JSON.stringify(lines)}`);
});

test('meansOfRound：没有可点名的调用时返回空列表，不编造', () => {
  assert.deepEqual(meansOfRound(null), []);
  assert.deepEqual(meansOfRound(report([])), []);
  assert.deepEqual(meansOfRound({ results: null }), []);
});

test('meansOfRound：封顶后如实说明还有多少条没列，不装作列全了', () => {
  const lines = meansOfRound(
    report(Array.from({ length: 20 }, (_, index) => step('fs.read', { path: `f${String(index)}.go` }))),
    12
  );
  assert.equal(lines.length, 13);
  assert.match(lines[12], /^…另有 8 条没列出$/);
});

// ---------------------------------------------------------------- 可介入的状态

test('只有「待确认的交付」和「停在轮次开始前」能要求再来一轮', () => {
  assert.equal(isContinueRoundAllowed('report_pending'), true);
  // M3-4c 关掉无人值守后的落点：判定说要开下一轮，等人点。
  assert.equal(isContinueRoundAllowed('awaiting_next_round'), true);
  // 别的状态各有出口（继续任务 / 追加并继续），正在跑的状态插一轮会两条线抢同一个工作区。
  for (const status of ['planning', 'executing', 'verifying', 'paused', 'interrupted', 'budget_exhausted', 'completed', 'failed', 'cancelled', 'blocked', 'created']) {
    assert.equal(isContinueRoundAllowed(status), false, `${status} 不该有这条出口`);
  }
});

test('停在这里的措辞只有一个出处，且必带「怎么回来」', () => {
  const pending = continueExitText('report_pending');
  const awaiting = continueExitText('awaiting_next_round');
  assert.ok(pending && awaiting);
  assert.match(pending.headline, /验证待你决定/);
  // 设置停的不能说成闸门拦的：原来界面只有一句「验证待你决定」，关掉无人值守后照样显示它。
  assert.doesNotMatch(awaiting.headline, /验证待你决定/);
  assert.match(awaiting.headline, /按你的设置停/);
  assert.match(awaiting.howBack, /继续下一轮|无人值守续轮/);
  for (const status of ['executing', 'completed', 'failed', 'paused']) {
    assert.equal(continueExitText(status), null, `${status} 不是这条出口的落点`);
  }
});

// ---------------------------------------------------------------- 无人值守开关

test('autoContinue：缺省按「自动续轮」算，只认显式 false', () => {
  // 字段是后加的：把缺省读成「关」等于给每个存量任务悄悄改了行为。
  assert.equal(autoContinueOf({}), true);
  assert.equal(autoContinueOf({ autoContinue: undefined }), true);
  assert.equal(autoContinueOf(null), true);
  assert.equal(autoContinueOf(undefined), true);
  assert.equal(autoContinueOf({ autoContinue: true }), true);
  assert.equal(autoContinueOf({ autoContinue: false }), false);
});

test('开关边界：只收布尔，多余键拒', () => {
  assert.equal(SetTaskAutoContinueSchema.safeParse({ taskId: 't', autoContinue: false }).success, true);
  assert.equal(SetTaskAutoContinueSchema.safeParse({ taskId: 't', autoContinue: 'false' }).success, false, '字符串 "false" 会被读成真，开关比没有更糟');
  assert.equal(SetTaskAutoContinueSchema.safeParse({ taskId: 't', autoContinue: 1 }).success, false);
  assert.equal(SetTaskAutoContinueSchema.safeParse({ taskId: 't' }).success, false);
  assert.equal(SetTaskAutoContinueSchema.safeParse({ taskId: 't', autoContinue: true, rounds: 2 }).success, false);
});

// ---------------------------------------------------------------- IPC 边界

test('指令边界：空白、超长、缺字段、多余键都拒', () => {
  assert.equal(ContinueTaskRoundSchema.safeParse({ taskId: 't', instruction: '换 mock 重跑测试' }).success, true);
  assert.equal(ContinueTaskRoundSchema.safeParse({ taskId: 't', instruction: '   ' }).success, false, '空白指令照样能烧一轮模型调用');
  assert.equal(ContinueTaskRoundSchema.safeParse({ taskId: 't', instruction: 'x'.repeat(2001) }).success, false);
  assert.equal(ContinueTaskRoundSchema.safeParse({ taskId: 't' }).success, false);
  assert.equal(ContinueTaskRoundSchema.safeParse({ taskId: 't', instruction: 'a', roundNumber: 3 }).success, false, '多余键必须拒（strict），不能悄悄吞掉调用方以为生效的字段');
});

// ---------------------------------------------------------------- 计划请求

test('计划请求：用户原话逐字进、上一轮清单一起下发', () => {
  const instruction = '别再用 go test 了，先只把 -race 这条跑穿，改不动就说是哪一步缺事实';
  const prompt = buildReportPrompt({
    taskId: 'task-1',
    roundId: 'round-2',
    report: report([step('shell.run', { command: 'go test ./...' }, { result: { exitCode: 1 } })]),
    userDirective: { instruction, means: ['shell.run command=go test ./...'] }
  });
  assert.ok(prompt.includes(`「${instruction}」`), '原话必须逐字出现，不能改写成系统口径');
  assert.match(prompt, /做法要与上一轮不同/);
  assert.ok(prompt.includes('- shell.run command=go test ./...'), '上一轮手段清单要进请求：只说「换个做法」没法核对重复没重复');
  assert.match(prompt, /clarification_required/, '拿不到新信息时要能诚实退出，而不是硬交一份同样的计划');
  // 本轮范围由用户指令定，四类检查那句全局口径不能再压在上面。
  assert.doesNotMatch(prompt, /编译、运行、测试、诊断四类检查/);
});

test('计划请求：不带指令时与改造前同口径', () => {
  const prompt = buildReportPrompt({
    taskId: 'task-1',
    roundId: 'round-2',
    report: report([step('shell.run', { command: 'go test ./...' })])
  });
  assert.match(prompt, /编译、运行、测试、诊断四类检查/);
  assert.doesNotMatch(prompt, /用户对上一轮的结论不满意/);
});

test('计划请求：上一轮没有可点名调用时也说明原因，不留空段', () => {
  const prompt = buildReportPrompt({
    taskId: 'task-1',
    roundId: 'round-2',
    report: report([]),
    userDirective: { instruction: '换个做法', means: [] }
  });
  assert.match(prompt, /上一轮没有可点名的工具调用记录/);
});

// ---------------------------------------------------------------- 活动流投影

test('活动流：人要的那一轮标成「你要求换手段再来」，详情带门禁与清单', () => {
  const at = 1_700_000_000_000;
  const entries = buildTaskConversation([
    { type: 'round.started', at, taskId: 'task-1', roundId: 'round-2', roundNumber: 2, inputType: 'user_continue' },
    {
      type: 'task.round.user_continue',
      at: at + 1,
      taskId: 'task-1',
      roundId: 'round-2',
      fromStatus: 'report_pending',
      instruction: '缩到 -race 这一条先做穿',
      means: ['shell.run command=go test ./...（失败）'],
      gate: { ok: true, reason: '轮数 2/20' }
    }
  ]);
  const roundNote = entries.find(entry => entry.text?.includes('你要求换手段再来'));
  assert.ok(roundNote, `轮次标注要把人要求的轮和模型判出来的轮分开：${JSON.stringify(entries.map(entry => entry.text))}`);
  const directive = entries.find(entry => entry.text?.startsWith('你要求换手段再来一轮'));
  assert.ok(directive, '指令本身要落进活动流，不能只在提示里闪一下');
  assert.equal(directive.subtype, 'continue');
  assert.ok(directive.text.includes('缩到 -race 这一条先做穿'));
  assert.equal(directive.roundId, 'round-2');
  assert.match(directive.detail, /开轮前状态：report_pending/);
  assert.match(directive.detail, /门禁：轮数 2\/20/);
  assert.match(directive.detail, /shell\.run command=go test \.\/\.\.\.（失败）/);
});

test('活动流：老任务没有这条事件时不凭空生成介入记录', () => {
  const entries = buildTaskConversation([
    { type: 'round.started', at: 1, taskId: 'task-1', roundId: 'r1', roundNumber: 1, inputType: 'user_prompt' }
  ]);
  assert.equal(entries.filter(entry => entry.subtype === 'continue').length, 0);
});

test('活动流：关掉无人值守后的「停」要说清为什么、怎么回来', () => {
  const entries = buildTaskConversation([
    { type: 'round.started', at: 10, taskId: 'task-1', roundId: 'r1', roundNumber: 1, inputType: 'execution_report' },
    {
      type: 'task.round.await_user',
      at: 11,
      taskId: 'task-1',
      purpose: '重做计划与手段',
      reason: '目标标准「测试通过」仍未满足，且上一轮同命令同退出码',
      gate: { ok: true, reason: '轮数 1/20' }
    }
  ]);
  const note = entries.find(entry => entry.text?.startsWith('判定要开下一轮，按你的设置停在这里'));
  assert.ok(note, `停必须留下可读的痕迹：${JSON.stringify(entries.map(entry => entry.text))}`);
  assert.match(note.text, /重做计划与手段/);
  assert.match(note.detail, /目标标准「测试通过」仍未满足/);
  assert.match(note.detail, /轮数 1\/20/);
  assert.match(note.detail, /无人值守续轮/);
});

test('活动流：开关变更留痕，改前的生效值按默认算不写 undefined', () => {
  const entries = buildTaskConversation([
    { type: 'task.auto_continue.updated', at: 12, taskId: 'task-1', autoContinue: false, previous: true, source: 'user' }
  ]);
  const note = entries.find(entry => entry.text?.startsWith('无人值守续轮已关闭'));
  assert.ok(note);
  assert.match(note.detail, /停在「等待你继续」/);
});

// ---------------------------------------------------------------- 源码守卫

test('主进程：这条入口不重跑判定，但要过预算门禁', () => {
  const main = read('src/main/orchestrator.ts');
  const body = main.slice(main.indexOf('async continueWithUserInstruction'), main.indexOf('async continueWithUserInstruction') + 3000);
  assert.ok(main.includes('async continueWithUserInstruction'), '没有开轮方法');
  // 重跑 decideCycleAction 只会再给一次 stop_and_wait，等于把同一个死结再解一遍。
  assert.doesNotMatch(body, /decideCycleAction/, '这条入口不能靠重跑判定开轮');
  assert.doesNotMatch(body, /continueAfterReport/, '绕开判定：复用那条会重新走一遍 stop_and_wait 分支');
  assert.ok(body.includes('this.tasks.budgetView(taskId)'), '必须过 M3-3 的预算单一读点，不能开一条绕过预算的后门');
  assert.ok(body.includes("inputType: 'user_continue'"), '轮次要单独记一类：人工介入的轮数必须数得出来');
  assert.ok(body.includes("userDirective: { instruction, means }"), '指令与上一轮清单必须真的进计划请求');
  assert.ok(body.includes("type: 'task.round.user_continue'"), '要发事件，否则事后无法核对用户那条指令去没进去');
  assert.ok(body.includes("this.tasks.transition(taskId, 'awaiting_next_round')"), '待确认交付要经这两条边接回 planning');
  assert.ok(body.includes("this.tasks.transition(taskId, 'planning')"), '没有这条边开不出轮（状态表里没有 report_pending → planning）');
  assert.ok(body.includes('isContinueRoundAllowed(task.status)'), '状态不合规要当场拒，不能悄悄改状态');
});

test('契约：轮次类型、事件、API 三处齐全', () => {
  const contracts = read('src/shared/contracts.ts');
  assert.match(contracts, /inputType: 'user_prompt' \| 'execution_report' \| 'clarification_answer' \| 'plan_repair' \| 'user_continue'/);
  assert.ok(contracts.includes("type: 'task.round.user_continue'"), '事件未进契约联合类型');
  assert.ok(contracts.includes('continueWithUserInstruction(input: {'), 'AgentTaskAPI 缺这条方法');
});

test('状态表：待确认交付有路走到 planning（经 awaiting_next_round）', () => {
  const manager = read('src/main/task-manager.ts');
  const line = manager.split('\n').find(row => row.includes('report_pending:'));
  assert.ok(line, '状态表里找不到 report_pending');
  assert.ok(line.includes('awaiting_next_round'), '缺这条边就只能停在待确认（新出口开不出轮）');
  const planningEdge = manager.split('\n').find(row => row.includes('awaiting_next_round:'));
  assert.ok(planningEdge && planningEdge.includes('planning'), 'awaiting_next_round → planning 必须留在表里');
});

test('主进程：无人值守关掉时停在轮次开始前，且停在开轮之前', () => {
  const main = read('src/main/orchestrator.ts');
  // 分支结尾要往后找：从文件头找分隔线会命中前面那道，切出来是空串，断言全假。
  const branchStart = main.indexOf("// nextAction === 'open_next_round'");
  assert.ok(branchStart > 0, '找不到 open_next_round 一支');
  const branch = main.slice(branchStart, main.indexOf('private async resolveWorkspace', branchStart));
  const gateIdx = branch.indexOf('autoContinueOf(');
  const createIdx = branch.indexOf('this.tasks.createRound');
  assert.ok(gateIdx > 0, 'open_next_round 一支没有无人值守开关');
  assert.ok(createIdx > gateIdx, '开关必须在开轮之前：先 createRound 再停会留下一条「已发回模型」却没发的轮次');
  assert.ok(branch.includes("type: 'task.round.await_user'"), '停下要发事件，否则只看得出轮数不涨');
  assert.ok(branch.includes('this.tasks.budgetView(taskId).gate'), '停的原因要带门禁读数（M3-3 单一读点）');
  assert.ok(branch.includes("this.tasks.transition(taskId, 'awaiting_next_round')"), '要停在 awaiting_next_round');
  // 开关只管「自动开下一轮」，不能顺手把预算/超限的停法也绕过去。
  assert.doesNotMatch(branch.slice(0, gateIdx), /this\.tasks\.transition\(taskId, 'planning'\)/, 'planning 迁移不能排在开关之前');
});

test('写路径与界面：开关持久化、发事件、有落点', () => {
  const manager = read('src/main/task-manager.ts');
  const index = read('src/main/index.ts');
  const preload = read('src/preload/index.ts');
  const stats = read('src/renderer/src/components/engineering/TaskStats.tsx');
  assert.ok(manager.includes('setAutoContinue(taskId: string, autoContinue: boolean)'), 'TaskManager 缺唯一写路径');
  assert.ok(manager.includes("type: 'task.auto_continue.updated'"), '写开关必须发事件');
  assert.ok(manager.includes('autoContinueOf(current)'), '改前的生效值要走同一个默认口径');
  assert.match(index, /ipcMain\.handle\('task:set-auto-continue'/, '没有 task:set-auto-continue 入口');
  assert.match(index, /SetTaskAutoContinueSchema\.parse/);
  assert.match(preload, /setTaskAutoContinue: /, 'preload 没暴露开关');
  assert.ok(stats.includes('setTaskAutoContinue('), '统计页没有开关控件');
  assert.ok(stats.includes('autoContinueOf(task)'), '界面显示的生效值要走同一个默认口径');
});

test('契约：AgentTask 字段与两条事件都进了联合类型', () => {
  const contracts = read('src/shared/contracts.ts');
  assert.match(contracts, /autoContinue\?: boolean;/);
  assert.ok(contracts.includes("type: 'task.round.await_user'"));
  assert.ok(contracts.includes("type: 'task.auto_continue.updated'"));
  assert.ok(contracts.includes('setTaskAutoContinue(input: {'));
});
test('渲染层与 IPC：入口、preload、IPC 三层都接上', () => {
  const index = read('src/main/index.ts');
  const preload = read('src/preload/index.ts');
  const app = read('src/renderer/src/App.tsx');
  assert.match(index, /ipcMain\.handle\('task:continue-round'/, '没有 task:continue-round 入口');
  assert.match(index, /ContinueTaskRoundSchema\.parse/, 'IPC 边界没过 schema');
  assert.match(preload, /continueWithUserInstruction: /, 'preload 没暴露这条方法');
  assert.ok(app.includes('换手段再来一轮'), '界面上没有这条出口，等于仍然无处可点');
  assert.ok(app.includes('window.agentAPI.continueWithUserInstruction'), '按钮没接 IPC');
  // 完全权限档里 GDC 照样可能停在 report_pending，那一档恰恰是无人值守跑的那一档：
  // 旧代码把整行动作按权限档藏掉，新出口不能跟着一起被藏。
  const rowStart = app.indexOf('verify-pending-actions');
  const row = app.slice(rowStart, rowStart + 2600);
  const gatingIdx = row.indexOf("permissionPreset !== 'danger-full-access'");
  const continueIdx = row.indexOf('void continueRound()');
  assert.ok(row.includes('换手段再来一轮'), '动作行里没有这颗按钮');
  assert.ok(gatingIdx >= 0 && continueIdx > gatingIdx, '「换手段再来一轮」被完全权限档的隐藏条件挡掉了');
  assert.ok(app.includes('async function continueRound()'), '按钮要有对应的事件处理，不能是个死标签');
  // 动作行按「停在哪」出，不再写死 report_pending：关掉无人值守后的落点也要有出口。
  assert.ok(app.includes('continueExitText(activeTask.status)'), '动作行的措辞没走唯一出处');
  assert.ok(app.includes('&& continueExit && ('), 'awaiting_next_round 没接上这条动作行');
});
