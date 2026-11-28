/**
 * V4 P1 M3-3：任务级预算只有一个算法、一处记账、一种超限后果。
 *
 * 原来错在哪：轮数上限在 orchestrator 里算了三遍（开轮前守卫、报告后判定、计划修正自纠），
 * token 维度形参存在但没人传值，超限的落点 `fail_budget` 直接把任务标成 `failed`——
 * 而 `failed` 是终态，用户加完预算也接不回去；状态表里明明写着 `budget_exhausted` 可恢复、
 * 界面也备好「追加预算或结束」的文案，却没有任何代码会把任务放进这个状态。
 *
 * 用例分工：
 * - 纯函数：预算规整（脏值不许等效关闭）、三维用量核算、开轮门禁、追加预算只增不减；
 * - token 如实：通道不回报 token 就记 `unknown`，既不能因为「拿不到」判超限，
 *   也不能假装成 0 装作没用完；
 * - 决策出口：超限出 `PAUSE` + `pause_budget`（等人追加预算），不再是 `fail_budget` 判死；
 * - 源码守卫：三处重复算术必须收敛掉、状态表的三条边必须补上、事件必须带预算快照——
 *   只有源码能证明「单点」这件事没被后来的改动破坏。
 *
 * Run: npm run test:task-budget
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DEFAULT_TASK_BUDGET,
  budgetStateOf,
  canOpenRound,
  extendTaskBudget,
  normalizeTaskBudget
} from '../out-test/shared/task-budget.js';
import { decideCycleAction } from '../out-test/shared/cycle-decision.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');

const CLEAN_REVIEW = { needsFix: false, blockingIssues: 0, unresolved: 0 };
const DONE_DELIVERY = { execution: 'COMPLETED', verification: 'PASSED', goal: 'MET' };

function fit(fitValue, overrides = {}) {
  return {
    goalId: 'goal:b1', goalVersion: 1, fit: fitValue,
    met: 0, partial: 0, unmet: 0, unverified: 0, waived: 0,
    blockingRisks: [], evidenceCompleteness: 1, notes: [], ...overrides
  };
}

function decisionInput(overrides = {}) {
  return {
    goalStatus: 'ACTIVE',
    goalFit: fit('UNMET'),
    delivery: { execution: 'COMPLETED', verification: 'FAILED', goal: 'NOT_MET' },
    review: CLEAN_REVIEW,
    budget: { atMaxRounds: false },
    task: {},
    progress: { fingerprint: 'f1', repeated: 0, criterionStalled: false },
    diagnosis: 'none',
    ...overrides
  };
}

test('默认预算：轮数有上限，其余维度不设限', () => {
  const budget = normalizeTaskBudget(undefined);
  assert.equal(budget.maxRounds, DEFAULT_TASK_BUDGET.maxRounds);
  assert.equal(budget.maxModelCalls, undefined);
  assert.equal(budget.maxTokens, undefined);
  // 没写的维度不能当成「上限 0」：那样每个任务第一秒就超限了。
  assert.deepEqual(budgetStateOf({ budget, usage: { rounds: 1, modelCalls: 99, tokens: 99_000 } }).exceeded, []);
});

test('脏值回落默认，而不是等效关闭或判死', () => {
  // maxRounds: 0 / 负数 / 小数 / 字符串 / NaN 都是脏值。原来 `rounds.length >= 0` 恒真，
  // 等于「配置写错 → 任务一开局就判失败」；现在必须退回默认值并可核对。
  for (const raw of [{ maxRounds: 0 }, { maxRounds: -3 }, { maxRounds: 2.5 }, { maxRounds: '12' }, { maxRounds: NaN }]) {
    const budget = normalizeTaskBudget(raw);
    assert.equal(budget.maxRounds, DEFAULT_TASK_BUDGET.maxRounds, `${JSON.stringify(raw)} 应回落默认`);
    assert.equal(budget.dirty?.includes('maxRounds'), true, `${JSON.stringify(raw)} 要留下脏值记录`);
  }
  // 合法值原样保留，不能被「规整」掉。
  assert.equal(normalizeTaskBudget({ maxRounds: 5, maxModelCalls: 40, maxTokens: 100000 }).maxModelCalls, 40);
});

test('轮数超限：门禁拦住并说清用了多少', () => {
  const budget = { maxRounds: 3 };
  const atLimit = budgetStateOf({ budget, usage: { rounds: 3, modelCalls: 5 } });
  assert.deepEqual(atLimit.exceeded, ['rounds']);
  const gate = canOpenRound({ budget, usage: { rounds: 3, modelCalls: 5 } });
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /轮数 3\/3/);
  // 还剩一轮时不得提前拦：判定要卡在「再开一轮才超」这一点上。
  assert.equal(canOpenRound({ budget, usage: { rounds: 2, modelCalls: 5 } }).ok, true);
});

test('模型调用数超限：单独成一个维度', () => {
  const budget = { maxModelCalls: 4 };
  const state = budgetStateOf({ budget, usage: { rounds: 1, modelCalls: 6 } });
  assert.deepEqual(state.exceeded, ['model_calls']);
  assert.equal(canOpenRound({ budget, usage: { rounds: 1, modelCalls: 6 } }).ok, false);
});

test('token 未知就如实记未知，不判超限也不假装为零', () => {
  // 现网主进程根本不回填 round.delta 的 usage（2026-11-28 代码核查），所以拿不到 token
  // 是常态。把未知当 0 会显示「还有一大笔预算」，把未知当超限会误停任务。
  const unknown = budgetStateOf({ budget: { maxTokens: 'unknown' }, usage: { rounds: 1, modelCalls: 2 } });
  assert.equal(unknown.tokenAccounting, 'unknown');
  assert.deepEqual(unknown.exceeded, []);
  assert.deepEqual(unknown.unknowns, ['tokens']);
  assert.equal(canOpenRound({ budget: { maxTokens: 'unknown' }, usage: { rounds: 1, modelCalls: 2 } }).ok, true);

  const notReported = budgetStateOf({ budget: { maxTokens: 5000 }, usage: { rounds: 1, modelCalls: 2, tokens: null } });
  assert.equal(notReported.tokenAccounting, 'unknown');
  assert.deepEqual(notReported.exceeded, []);

  const known = budgetStateOf({ budget: { maxTokens: 5000 }, usage: { rounds: 1, modelCalls: 2, tokens: 6100 } });
  assert.equal(known.tokenAccounting, 'known');
  assert.deepEqual(known.exceeded, ['tokens']);
  assert.match(canOpenRound({ budget: { maxTokens: 5000 }, usage: { rounds: 1, modelCalls: 2, tokens: 6100 } }).reason, /tokens 6100\/5000/);
});

test('多个维度同时超限时理由要逐条点名', () => {
  const gate = canOpenRound({
    budget: { maxRounds: 2, maxModelCalls: 3 },
    usage: { rounds: 4, modelCalls: 9 }
  });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.blockedBy, ['rounds', 'model_calls']);
  assert.match(gate.reason, /轮数 4\/2/);
  assert.match(gate.reason, /模型调用 9\/3/);
});

test('追加预算只增不减，加完门禁就放行', () => {
  const budget = { maxRounds: 2 };
  const usage = { rounds: 3, modelCalls: 1 };
  assert.equal(canOpenRound({ budget, usage }).ok, false);
  const extended = extendTaskBudget(budget, { maxRounds: 6 });
  assert.equal(extended.maxRounds, 6);
  assert.equal(canOpenRound({ budget: extended, usage }).ok, true);
  // 用户手滑填了个更小的数不能把在跑的预算缩掉（原值仍然可读）。
  assert.equal(extendTaskBudget(extended, { maxRounds: 1 }).maxRounds, 6);
  assert.equal(extendTaskBudget(extended, { maxRounds: 'lots' }).maxRounds, 6);
});

test('超限出 PAUSE 而不是判死，且要求用户介入', () => {
  const state = budgetStateOf({ budget: { maxRounds: 3 }, usage: { rounds: 3, modelCalls: 9 } });
  const decision = decideCycleAction(decisionInput({
    budget: { atMaxRounds: true, exceeded: state.exceeded, note: canOpenRound({ budget: { maxRounds: 3 }, usage: { rounds: 3, modelCalls: 9 } }).reason }
  }));
  assert.equal(decision.decision, 'PAUSE');
  assert.equal(decision.nextAction, 'pause_budget');
  assert.equal(decision.requiresUser, true);
  // 预算见底时不再重规划：再开一轮本身就是超限动作。
  assert.notEqual(decision.nextAction, 'open_next_round');
});

test('空转停下等人优先于预算兜底（顺序不能被预算抢走）', () => {
  const decision = decideCycleAction(decisionInput({
    budget: { atMaxRounds: true, exceeded: ['rounds'], note: '轮数 20/20' },
    progress: { fingerprint: 'f9', repeated: 4, criterionStalled: true, noProgressStreak: 2 },
    noProgressCause: 'repeated_call'
  }));
  assert.equal(decision.decision, 'WAIT_USER');
  assert.equal(decision.nextAction, 'stop_and_wait');
});

test('源码守卫：记账收敛为单点、超限落 budget_exhausted、事件带快照', () => {
  const orchestrator = read('src/main/orchestrator.ts');
  const taskManager = read('src/main/task-manager.ts');
  const contracts = read('src/shared/contracts.ts');
  const cycleDecision = read('src/shared/cycle-decision.ts');

  // 1) 重复的轮数算术必须换成统一门禁：编排器里一处比较都不许留，只许读核算结果。
  assert.equal(
    (orchestrator.match(/>=\s*task\.maxRounds/g) ?? []).length,
    0,
    '仍有地方自己比较 `>= task.maxRounds`，预算没收敛成单点'
  );
  assert.equal(
    (orchestrator.match(/listRounds\([a-zA-Z._]+\)\.length\s*>=|rounds\.length\s*>=/g) ?? []).length,
    0,
    '仍有地方拿轮数直接比较，绕过了门禁'
  );
  assert.match(orchestrator, /canOpenRound\(|budgetView\(/, '编排器没有改用统一门禁');
  assert.match(orchestrator, /this\.tasks\.budgetView\(/, '编排器的预算读数没有走任务级唯一核算');

  // 2) 超限不再把任务判死：落点是可恢复的 budget_exhausted。
  assert.doesNotMatch(orchestrator, /transition\([a-zA-Z]+, 'failed', \{\s*error: `达到最大轮数/, '超限仍走 failed');
  assert.match(orchestrator, /'budget_exhausted'/, '编排器没有任何地方进入 budget_exhausted');

  // 3) 状态表补齐三条边，否则超限暂停会被「非法状态转换」抛错拦住。
  for (const from of ['executing', 'verifying', 'report_pending', 'awaiting_next_round', 'planning']) {
    const line = taskManager.split('\n').find(item => item.trim().startsWith(`${from}: [`));
    assert.ok(line, `task-manager 状态表找不到 ${from}`);
    assert.match(line, /budget_exhausted/, `${from} 缺到 budget_exhausted 的边，超限暂停会抛非法转换`);
  }

  // 4) 枚举、落点文案、事件字段与持久化都得在场（AGENTS.md §8：事件 + 持久化 + 详情入口）。
  assert.match(cycleDecision, /'pause_budget'/, 'CycleNextAction 没有 pause_budget 落点');
  assert.match(cycleDecision, /pause_budget: '[^']+'/, 'pause_budget 没有中文说法，界面只能显示英文');
  assert.match(contracts, /budget\?: TaskBudget/, 'AgentTask 上没有持久化的 budget 字段');
  assert.match(contracts, /budget: \{[^}]*exceeded/, 'cycle.decision.created 事件没带超预算的核算结果');

  // 5) 详情入口：预算要在任务详情里读得到，不能只在事件流里。
  const stats = read('src/renderer/src/components/engineering/TaskStats.tsx');
  assert.match(stats, /预算|budget/i, '任务详情里没有预算段');
});

/**
 * 「可恢复」这三个字要能被机器证伪：暂停有事件、加预算有入口、加完真能接回循环。
 * 原来状态表里 `budget_exhausted` 谁都能读，但没人进得去、也没出得来。
 */
test('源码守卫：超限暂停有事件、追加预算有入口、加完真能接回循环', () => {
  const contracts = read('src/shared/contracts.ts');
  const schemas = read('src/shared/schemas.ts');
  const main = read('src/main/index.ts');
  const preload = read('src/preload/index.ts');
  const taskManager = read('src/main/task-manager.ts');
  const stats = read('src/renderer/src/components/engineering/TaskStats.tsx');
  const conversation = read('src/shared/task-conversation.ts');

  // 事件：停手与改预算各自留一条，不能只改状态不发声。
  assert.match(contracts, /type: 'task\.budget\.exhausted'/, '超限暂停没有事件');
  assert.match(contracts, /type: 'task\.budget\.updated'/, '追加预算没有事件');
  assert.match(contracts, /reason: string;[\s\S]{0,240}budgetUsage:/, 'task.budget.exhausted 没带核算读数');

  // 活动流：停手原因要说人话（M3-2 真机教训——停下来等人，但没人告诉你怎么回来）。
  assert.match(conversation, /task\.budget\.exhausted/, '活动流里没有超限暂停这条旁注');
  assert.match(conversation, /预算用尽，任务已暂停/, '暂停卡片没有说清停手原因');

  // 入口：IPC 边界校 schema，主进程只走 extendBudget 这一条写路径。
  assert.match(schemas, /SetTaskBudgetSchema/, '预算入参没有 IPC 校验');
  assert.match(main, /ipcMain\.handle\('task:set-budget'/, "没有 task:set-budget 入口");
  assert.match(main, /tasks\.extendBudget\(/, 'IPC 绕过了唯一写路径自己改预算');
  // 加完预算必须真接回去，否则「可恢复」只是状态名好听。
  assert.match(main, /status === 'budget_exhausted'[\s\S]{0,120}orchestrator\.resume\(/, '追加预算后没有接回常规恢复链路');
  assert.match(preload, /setTaskBudget: /, 'preload 没有暴露 setTaskBudget');
  assert.match(taskManager, /extendBudget\(/, '预算没有唯一写路径');
  assert.match(taskManager, /type: 'task\.budget\.updated'/, '唯一写路径没有发事件');
  assert.match(taskManager, /budgetStateOf\(\{ budget, usage \}\)|state: budgetStateOf\(/, '任务级核算没有走 budgetStateOf');

  // 恢复路径的三条来路（paused/interrupted/blocked）都得能进 budget_exhausted，
  // 否则 resume 里撞到门禁就抛「非法状态转换」，用户看到的是崩而不是提示。
  for (const from of ['paused', 'interrupted', 'blocked']) {
    const line = taskManager.split('\n').find(item => item.trim().startsWith(`${from}: [`));
    assert.ok(line, `状态表找不到 ${from}`);
    assert.match(line, /budget_exhausted/, `${from} 缺到 budget_exhausted 的边`);
  }

  // 详情入口要真能操作，不是只读一排数字。
  assert.match(stats, /setTaskBudget\(/, '任务详情的追加按钮没有接 IPC');
  assert.match(stats, /未记账/, '详情把记不了账的维度写成 0 了');
});
