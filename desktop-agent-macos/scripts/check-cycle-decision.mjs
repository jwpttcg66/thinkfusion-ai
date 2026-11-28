/**
 * GCE-P3 + V4 P1 M3-1/M3-2：Cycle 决策纯函数是唯一判定出口，且空转真的会被拦下。
 *
 * 三组用例的分工：
 * - 「场景 → 决策」映射：把 orchestrator 现场会出现的组合（交付未确认、修复闸门已停、
 *   无契约、预算见底、连续无进展）逐个钉死在纯函数上，不再靠读代码确认它有没有被用；
 * - 反空转（M3-2）：三轮同证据必须在第三轮被拦下、带上原因分类、连续两次空转就停下等人，
 *   同时正常推进的任务不误伤，阈值调大等效关闭；
 * - 源码守卫：简化版四出口必须已删除，决策事件必须带全字段，空转判定必须真的接进执行层
 *   ——这三条只有源码能证明。
 * Run: npm run test:cycle-decision
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  cycleFingerprint,
  cycleNoProgressLimits,
  decideCycleAction,
  deriveCycleDiagnosis,
  deriveNoProgressCause,
  detectNoProgress,
  isNoProgress,
  legacyDecisionOf,
  openCriteriaKey,
  resolveNoProgressLimits
} from '../out-test/shared/cycle-decision.js';

const CLEAN_REVIEW = { needsFix: false, blockingIssues: 0, unresolved: 0 };
const DONE_DELIVERY = { execution: 'COMPLETED', verification: 'PASSED', goal: 'MET' };

function fit(fitValue, overrides = {}) {
  return {
    goalId: 'goal:w1',
    goalVersion: 1,
    fit: fitValue,
    met: 0, partial: 0, unmet: 0, unverified: 0, waived: 0,
    blockingRisks: [],
    evidenceCompleteness: 1,
    notes: [],
    ...overrides
  };
}

function input(overrides = {}) {
  return {
    goalStatus: 'ACTIVE',
    goalFit: fit('MET'),
    delivery: DONE_DELIVERY,
    review: CLEAN_REVIEW,
    budget: { atMaxRounds: false },
    task: {},
    progress: { fingerprint: 'f1', repeated: 0, criterionStalled: false },
    diagnosis: 'none',
    ...overrides
  };
}

test('取消/阻塞/目标未就绪优先于完成判断', () => {
  assert.equal(decideCycleAction(input({ task: { cancelled: true } })).decision, 'ABORT');
  assert.equal(decideCycleAction(input({ task: { cancelled: true } })).nextAction, 'abort');
  assert.equal(decideCycleAction(input({ task: { blockedReason: '网络不可用' } })).decision, 'BLOCKED');
  // 同样是 BLOCKED：外部阻塞要人处理，预算耗尽是把任务判死——requiresUser 跟落点走。
  assert.equal(decideCycleAction(input({ task: { blockedReason: '网络不可用' } })).requiresUser, true);
  assert.equal(decideCycleAction(input({ goalStatus: 'DRAFT' })).decision, 'CLARIFY_GOAL');
  assert.equal(
    decideCycleAction(input({ goalStatus: 'CHANGE_PROPOSED' })).decision,
    'CHANGE_PROPOSED'
  );
});

test('连续无进展只出重做计划或停下等人，不再按诊断继续执行', () => {
  // 原来这里按诊断出 REDESIGN / REANALYZE：两条都落 open_next_round，等于明知在空转
  // 还把同一批调用再交一遍。现在诊断只进理由文本，落点收窄到 REPLAN / WAIT_USER 两种。
  const progress = { fingerprint: 'f1', repeated: 2, criterionStalled: false, noProgressStreak: 1 };
  for (const diagnosis of ['design', 'analysis', 'implementation', 'task_plan', 'goal', 'none']) {
    const out = decideCycleAction(input({ progress, diagnosis }));
    assert.ok(
      out.decision === 'REPLAN' || out.decision === 'WAIT_USER',
      `${diagnosis} 的空转轮落在了 ${out.decision}：既不是重做计划也不是停下等人`
    );
    assert.equal(out.noProgressCause, 'repeated_call', '不传分类时按最保守的「重复调用」');
    assert.match(out.reason, /连续无进展（原因分类：重复调用，这是连续第 1 轮）/);
  }
  // 不传分类时不能拿别的分类冒充；理由要点名轮数，否则界面只剩一句「等待用户」。
  assert.match(
    decideCycleAction(input({ progress })).reason,
    /同一批证据已连续 3 轮没有变化/
  );
});

test('GAP 按诊断回到实现/设计/分析/规划/目标', () => {
  const gap = fit('GAP', { unmet: 1 });
  assert.equal(decideCycleAction(input({ goalFit: gap, diagnosis: 'implementation' })).decision, 'REPAIR');
  assert.equal(decideCycleAction(input({ goalFit: gap, diagnosis: 'design' })).decision, 'REDESIGN');
  assert.equal(decideCycleAction(input({ goalFit: gap, diagnosis: 'analysis' })).decision, 'REANALYZE');
  assert.equal(decideCycleAction(input({ goalFit: gap, diagnosis: 'task_plan' })).decision, 'REPLAN');
  assert.equal(decideCycleAction(input({ goalFit: gap, diagnosis: 'goal' })).decision, 'CLARIFY_GOAL');
});

test('评审问题与验证失败不能被 complete 覆盖', () => {
  assert.equal(
    decideCycleAction(input({ review: { needsFix: true, blockingIssues: 1, unresolved: 0 } })).decision,
    'REPAIR'
  );
  assert.equal(
    decideCycleAction(input({ delivery: { ...DONE_DELIVERY, verification: 'FAILED' } })).decision,
    'REPAIR'
  );
  assert.equal(
    decideCycleAction(input({
      delivery: { ...DONE_DELIVERY, verification: 'FAILED' },
      diagnosis: 'design'
    })).decision,
    'REDESIGN'
  );
});

test('MET 仍需验证通过；WITH_RISKS 需接受风险', () => {
  assert.equal(
    decideCycleAction(input({ delivery: { ...DONE_DELIVERY, verification: 'UNVERIFIED' } })).decision,
    'WAIT_USER'
  );
  const risks = fit('WITH_RISKS', { waived: 1 });
  assert.equal(decideCycleAction(input({ goalFit: risks })).decision, 'WAIT_USER');
  assert.equal(
    decideCycleAction(input({ goalFit: risks, gates: { risksAccepted: true } })).decision,
    'COMPLETE'
  );
});

test('交付证据不成立时不得按完成收尾（报告自述完成也不算）', () => {
  const unconfirmed = decideCycleAction(input({ gates: { deliveryUnconfirmed: true } }));
  assert.equal(unconfirmed.decision, 'FAIL_DELIVERY');
  assert.equal(unconfirmed.nextAction, 'fail_delivery');
  // 无契约任务同理：执行 completed 但没有可核对交付证据。
  const noContract = decideCycleAction(input({
    goalStatus: undefined,
    goalFit: null,
    delivery: { execution: 'COMPLETED', verification: 'PASSED', goal: 'UNKNOWN' },
    gates: { deliveryUnconfirmed: true }
  }));
  assert.equal(noContract.decision, 'FAIL_DELIVERY');
});

test('修复闸门已停：接受过风险就如实收尾，否则停下等人', () => {
  const stopped = decideCycleAction(input({
    goalFit: fit('PARTIAL', { partial: 1 }),
    gates: { repairBlocked: true, repairBlockedReason: '命令、输出、退出码与上一轮完全相同' }
  }));
  assert.equal(stopped.decision, 'WAIT_USER');
  assert.equal(stopped.nextAction, 'stop_and_wait');
  assert.match(stopped.reason, /命令、输出、退出码与上一轮完全相同/);

  const accepted = decideCycleAction(input({
    goalFit: fit('PARTIAL', { partial: 1 }),
    gates: { repairBlocked: true, repairBlockedReason: '两轮之间没有任何新事实', risksAccepted: true }
  }));
  assert.equal(accepted.decision, 'COMPLETE');
  assert.equal(accepted.nextAction, 'finish_completed');
});

test('环境不满足停在人这里，不进修复轮', () => {
  const env = decideCycleAction(input({ diagnosis: 'environment', goalFit: fit('GAP', { unmet: 1 }) }));
  assert.equal(env.decision, 'WAIT_USER');
  assert.equal(env.nextAction, 'stop_and_wait');
  assert.match(env.reason, /模型源/);
});

test('没有契约时不伪造符合度，只按执行与验证判定', () => {
  const done = decideCycleAction(input({
    goalStatus: undefined,
    goalFit: null,
    delivery: { execution: 'COMPLETED', verification: 'PASSED', goal: 'UNKNOWN' }
  }));
  assert.equal(done.decision, 'COMPLETE');
  const failed = decideCycleAction(input({
    goalStatus: undefined,
    goalFit: null,
    delivery: { execution: 'FAILED', verification: 'UNVERIFIED', goal: 'UNKNOWN' }
  }));
  assert.equal(failed.decision, 'REPAIR');
  // 契约未建立又停在人这里：理由必须点名契约，不能只说「等待用户」。
  const waiting = decideCycleAction(input({
    goalStatus: undefined,
    goalFit: null,
    delivery: { execution: 'PENDING', verification: 'UNVERIFIED', goal: 'UNKNOWN' }
  }));
  assert.equal(waiting.decision, 'WAIT_USER');
  assert.match(waiting.reason, /目标契约还未确认/);
});

test('预算：还能收尾就收尾，需要再开一轮才判耗尽', () => {
  // 正好用完最后一轮把目标做完——结论是完成，不是预算耗尽。
  const finished = decideCycleAction(input({ budget: { atMaxRounds: true } }));
  assert.equal(finished.decision, 'COMPLETE');
  assert.equal(finished.nextAction, 'finish_completed');
  // 还需要再修一轮时，预算见底必须停下并把原因说成预算，而不是悄悄多跑一轮。
  // M3-3 改了这里的落点：原来是 `BLOCKED` + `fail_budget` 且 requiresUser=false（等于判死），
  // 但 `failed` 没有回来的边，用户加完预算接不回去；现在出 `PAUSE` + `pause_budget` 并明确要人。
  const exhausted = decideCycleAction(input({
    budget: { atMaxRounds: true },
    review: { needsFix: true, blockingIssues: 1, unresolved: 0 }
  }));
  assert.equal(exhausted.decision, 'PAUSE');
  assert.equal(exhausted.nextAction, 'pause_budget');
  assert.equal(exhausted.requiresUser, true, '预算耗尽是暂停等人追加预算，不是把任务判死');
  assert.match(exhausted.reason, /预算已用尽/);
  assert.match(exhausted.reason, /追加预算/);
});

test('桌面动作链未收口时不得完成', () => {
  const open = decideCycleAction(input({ gates: { desktopOpen: true } }));
  assert.equal(open.decision, 'REPAIR');
  assert.equal(open.nextAction, 'open_next_round');
  assert.match(open.reason, /桌面动作链未收口/);
});

test('旧四出口兼容：新语义不被压成 complete', () => {
  assert.equal(legacyDecisionOf('COMPLETE'), 'complete');
  assert.equal(legacyDecisionOf('REPAIR'), 'repair');
  assert.equal(legacyDecisionOf('FAIL_DELIVERY'), 'fail_delivery');
  assert.equal(legacyDecisionOf('REDESIGN'), 'observe');
  assert.equal(legacyDecisionOf('WAIT_USER'), 'observe');
});

test('指纹与进展：同证据连续重复才算空转', () => {
  const a = cycleFingerprint({ b: 2, a: [1, 2] });
  const b = cycleFingerprint({ a: [1, 2], b: 2, c: 3 });
  assert.equal(cycleFingerprint({ b: 2, a: [1, 2] }), a, '键顺序不影响指纹');
  const first = detectNoProgress({ previous: null, fingerprint: a, criterionKey: 'c1' });
  assert.equal(first.repeated, 0);
  assert.equal(isNoProgress(first), false);
  const second = detectNoProgress({ previous: first, fingerprint: a, criterionKey: 'c1' });
  assert.equal(second.repeated, 1);
  assert.equal(isNoProgress(second), false, '重复一轮可能只是重试');
  const third = detectNoProgress({ previous: second, fingerprint: a, criterionKey: 'c1' });
  assert.equal(third.repeated, 2);
  assert.equal(isNoProgress(third), true);
  assert.equal(third.noProgressStreak, 1, '第一次判空转：还没有重规划过');
  // A→B→A 的来回摆：证据每轮都在变，但没满足的标准一条没少——仍算停滞。
  const swung = detectNoProgress({ previous: third, fingerprint: b, criterionKey: 'c1' });
  assert.equal(swung.repeated, 0);
  assert.equal(isNoProgress(swung), true);
  assert.equal(swung.noProgressStreak, 2, '重规划后仍空转要能数出来，否则每轮都只会重复给一次机会');
  // 阈值配置化：调大即等效关闭。
  assert.equal(isNoProgress({ ...third, repeatLimit: 9, criterionStalled: false }), false);
});

test('进展：标准集合变化后停滞计数归零', () => {
  const first = detectNoProgress({ previous: null, fingerprint: 'f1', criterionKey: 'open-a' });
  const second = detectNoProgress({ previous: first, fingerprint: 'f2', criterionKey: 'open-a' });
  assert.equal(second.criteriaStreak, 1);
  const third = detectNoProgress({ previous: second, fingerprint: 'f3', criterionKey: 'open-b' });
  assert.equal(third.criteriaStreak, 0);
  assert.equal(third.criterionStalled, false);
});

test('未满足标准集合：变了就不算停滞', () => {
  const contract = {
    criteria: [
      { criterionId: 'c1', description: '编译通过', status: 'MET' },
      { criterionId: 'c2', description: '测试全绿', status: 'UNMET' }
    ]
  };
  const key = openCriteriaKey(contract);
  assert.ok(key);
  assert.notEqual(key, openCriteriaKey({ criteria: [...contract.criteria, { criterionId: 'c3', description: '文档更新', status: 'PARTIAL' }] }));
  assert.equal(openCriteriaKey(null), '');
  assert.equal(
    openCriteriaKey({ criteria: [contract.criteria[1], { criterionId: 'c2b', description: '编译通过', status: 'MET' }] }),
    key,
    '集合只看仍未满足的那几条，顺序无关'
  );
});

test('三轮同证据：第三轮判空转、带分类，且不再选择继续执行（任务书 M3-2 用例）', () => {
  const first = detectNoProgress({ previous: null, fingerprint: 'F', criterionKey: 'K' });
  const second = detectNoProgress({ previous: first, fingerprint: 'F', criterionKey: 'K' });
  const third = detectNoProgress({ previous: second, fingerprint: 'F', criterionKey: 'K' });
  assert.equal(isNoProgress(first), false, '第一轮没有可比对象');
  assert.equal(isNoProgress(second), false, '第二轮可能只是重试，不能当空转杀掉');
  assert.equal(isNoProgress(third), true);
  // 「非 EXECUTE」在这套枚举里的意思是：既不 CONTINUE 也不 REPAIR（那两条就是把同一批
  // 调用再跑一遍），更不是 COMPLETE（明知没进展还收尾）。
  const decision = decideCycleAction(input({ progress: third, noProgressCause: 'repeated_call' }));
  assert.equal(decision.decision, 'REPLAN');
  assert.equal(decision.noProgressCause, 'repeated_call', '事件要能说出这一轮为什么被判空转');
  assert.equal(decision.nextAction, 'open_next_round');
  assert.match(decision.reason, /不得重复同样的调用/);
  // 重做计划之后仍然同样的证据 → 不再给第三次机会，停下等人。
  const fourth = detectNoProgress({ previous: third, fingerprint: 'F', criterionKey: 'K' });
  const waited = decideCycleAction(input({ progress: fourth, noProgressCause: 'repeated_call' }));
  assert.equal(waited.decision, 'WAIT_USER');
  assert.equal(waited.nextAction, 'stop_and_wait');
  assert.equal(waited.requiresUser, true);
  assert.match(waited.reason, /重做计划后仍未出现新事实/);
});

test('正常推进不误伤：证据换了、标准集合缩了都不判空转', () => {
  const first = detectNoProgress({ previous: null, fingerprint: 'A', criterionKey: 'K-open-both' });
  const second = detectNoProgress({ previous: first, fingerprint: 'B', criterionKey: 'K-open-both' });
  const third = detectNoProgress({ previous: second, fingerprint: 'C', criterionKey: 'K-one-left' });
  // 三轮各做掉一条标准：未满足集合每轮都在变，即使证据指纹完全不同也不该被杀。
  assert.equal(isNoProgress(third), false);
  assert.equal(third.noProgressStreak, 0);
  const done = decideCycleAction(input({ progress: third }));
  assert.equal(done.decision, 'COMPLETE');
  assert.equal(done.noProgressCause, null, '没有命中空转判定就不写分类');
});

test('缺权限的空转不给自动重规划：重试不会让授权出现', () => {
  const progress = { fingerprint: 'f1', repeated: 2, criterionStalled: false, noProgressStreak: 1 };
  const out = decideCycleAction(input({ progress, noProgressCause: 'missing_permission' }));
  assert.equal(out.decision, 'WAIT_USER');
  assert.equal(out.noProgressCause, 'missing_permission');
  assert.match(out.reason, /只有用户能解除/);
  // 预算见底时的空转轮也不能「再开一轮」：落点必须是判耗尽，不是继续跑。
  const broke = decideCycleAction(input({
    progress,
    noProgressCause: 'needs_tool_change',
    budget: { atMaxRounds: true }
  }));
  assert.equal(broke.nextAction, 'pause_budget');
  assert.equal(broke.noProgressCause, 'needs_tool_change');
});

test('空转分类只从结构化事实推导，不看模型自述', () => {
  const facts = { errorCodes: [], steps: 2, evidence: 1, repeatedCommands: 0 };
  // 被授权/审批挡下排第一：改计划不会让许可出现，分类错就会白重规划一轮。
  assert.equal(deriveNoProgressCause({ ...facts, errorCodes: ['STEP_REJECTED'], repeatedCommands: 2 }), 'missing_permission');
  assert.equal(deriveNoProgressCause({ ...facts, errorCodes: ['GRANT_INVALID', 'COMMAND_FAILED'] }), 'missing_permission');
  // 什么都没执行、什么都没采到 → 缺的是上下文。
  assert.equal(deriveNoProgressCause({ ...facts, steps: 0, evidence: 0 }), 'missing_context');
  // 工具本身不支持 → 换手段，不是改实现。
  assert.equal(deriveNoProgressCause({ ...facts, errorCodes: ['UNSUPPORTED_PLATFORM'] }), 'needs_tool_change');
  // 同命令同退出码 → 重复调用。
  assert.equal(deriveNoProgressCause({ ...facts, repeatedCommands: 2 }), 'repeated_call');
  // COMMAND_FAILED / TEST_FAILED 是本轮要修的东西本身，不能算「工具不行」。
  assert.equal(deriveNoProgressCause({ ...facts, errorCodes: ['COMMAND_FAILED'] }), 'missing_context');
  // 带后缀的原始 code 不在这里归一：`COMMAND_FAILED: 命令退出码 3` 认不出来，
  // 冒号前截取只在 orchestrator 那一处做（诊断与分类共用同一份 errorCodes）。
  assert.equal(deriveNoProgressCause({ ...facts, errorCodes: ['GRANT_INVALID: 未授权工具'] }), 'missing_context');
});

test('阈值来源：环境变量 > 配置文件 > 默认；脏值不会静默关掉判定', () => {
  assert.deepEqual(resolveNoProgressLimits({}), { repeatLimit: 2, criteriaLimit: 2 });
  assert.deepEqual(resolveNoProgressLimits({ config: { repeatLimit: 4 } }), { repeatLimit: 4, criteriaLimit: 2 });
  assert.deepEqual(resolveNoProgressLimits({ env: '5', config: { repeatLimit: 4 } }), { repeatLimit: 5, criteriaLimit: 5 });
  assert.deepEqual(resolveNoProgressLimits({ env: '3,7' }), { repeatLimit: 3, criteriaLimit: 7 });
  for (const dirty of ['', 'abc', '0', '-1', '0,9', '1,2,3', 'null', '2.5']) {
    assert.deepEqual(
      resolveNoProgressLimits({ env: dirty, config: { repeatLimit: 6 } }),
      { repeatLimit: 6, criteriaLimit: 2 },
      `「${dirty}」退回配置文件那一档，不能被读成「永远判空转」或「永远不判」`
    );
  }
  assert.deepEqual(cycleNoProgressLimits({ repeatLimit: 0, criteriaLimit: 'x' }), { repeatLimit: 2, criteriaLimit: 2 });
  assert.deepEqual(cycleNoProgressLimits(null), { repeatLimit: 2, criteriaLimit: 2 });
});

test('阈值调大即等效关闭（M3-2 回退路径，不需要删判定分支）', () => {
  const first = detectNoProgress({ previous: null, fingerprint: 'F', criterionKey: 'K', repeatLimit: 9, criteriaLimit: 9 });
  const second = detectNoProgress({ previous: first, fingerprint: 'F', criterionKey: 'K', repeatLimit: 9, criteriaLimit: 9 });
  const third = detectNoProgress({ previous: second, fingerprint: 'F', criterionKey: 'K', repeatLimit: 9, criteriaLimit: 9 });
  assert.equal(isNoProgress(third), false);
  assert.equal(third.noProgressStreak, 0);
  // 同一份进展在默认阈值下是空转：差别只在阈值，不在调用点各自加条件。
  assert.equal(isNoProgress({ ...third, repeatLimit: 2, criterionStalled: true }), true);
  const done = decideCycleAction(input({ progress: third, noProgressCause: 'repeated_call' }));
  assert.equal(done.decision, 'COMPLETE');
  assert.equal(done.noProgressCause, null);
});

test('诊断从结构化事实推导，不读模型自述', () => {
  assert.equal(
    deriveCycleDiagnosis({
      goalFit: fit('MET'), uncoveredCriteria: 0, verification: null,
      reportStatus: 'completed', failedSteps: 0, errorCodes: ['MODEL_UNAVAILABLE'], reviewIssues: 0
    }),
    'environment'
  );
  assert.equal(
    deriveCycleDiagnosis({
      goalFit: fit('GAP', { unmet: 1 }), uncoveredCriteria: 2, verification: null,
      reportStatus: 'completed', failedSteps: 0, errorCodes: [], reviewIssues: 0
    }),
    'task_plan',
    '计划没覆盖到标准时先回规划，不在实现层空修'
  );
  assert.equal(
    deriveCycleDiagnosis({
      goalFit: fit('MET'), uncoveredCriteria: 0,
      verification: { compile: 'passed', tests: 'failed' },
      reportStatus: 'completed', failedSteps: 0, errorCodes: [], reviewIssues: 0
    }),
    'implementation'
  );
  assert.equal(
    deriveCycleDiagnosis({
      goalFit: fit('MET'), uncoveredCriteria: 0, verification: { compile: 'passed' },
      reportStatus: 'cancelled', failedSteps: 0, errorCodes: [], reviewIssues: 0
    }),
    'none',
    '用户取消不是缺陷'
  );
  assert.equal(
    deriveCycleDiagnosis({
      goalFit: fit('MET', { unverified: 1, evidenceCompleteness: 0.5 }), uncoveredCriteria: 0,
      verification: null, reportStatus: 'completed', failedSteps: 0, errorCodes: [], reviewIssues: 0
    }),
    'analysis'
  );
});

// --- 投影层：判定句是界面唯一可读的那份说法 ------------------------------------------

test('判定句：只认带落点的循环判定，取最近一条', async () => {
  const { cycleDecisionText, latestCycleDecision } = await import('../out-test/shared/goal-driven-cycle.js');
  const decisions = [
    // 评审处置也是一条 decision：没有 nextAction 就不是周期判定，不能顶替显示。
    { decisionId: 'd0', workId: 'w', cycleId: 'c', decisionType: 'accepted', decision: 'accepted', rationale: '并入修复', nextAction: undefined, eventAt: 30 },
    { decisionId: 'd1', workId: 'w', cycleId: 'c', decisionType: 'REPAIR', decision: 'REPAIR', rationale: '验证未通过', nextAction: 'open_next_round', eventAt: 10 },
    { decisionId: 'd2', workId: 'w', cycleId: 'c', decisionType: 'COMPLETE', decision: 'COMPLETE', rationale: '目标标准已满足', nextAction: 'finish_completed', eventAt: 20 }
  ];
  assert.equal(latestCycleDecision(decisions)?.decisionId, 'd2');
  assert.equal(cycleDecisionText(latestCycleDecision(decisions)),
    '最近一次周期判定：COMPLETE · 按完成收尾｜目标标准已满足');
  assert.equal(cycleDecisionText(latestCycleDecision([decisions[0]])), '', '处置决定不能显示成周期判定');
  assert.equal(cycleDecisionText(null), '');
  assert.ok(cycleDecisionText({ ...decisions[2], nextAction: 'action_not_in_enum' })
    .includes('action_not_in_enum'), '枚举新增成员时界面要暴露原始值，不能显示成空白');
});

// --- 源码守卫：双轨必须真的并成一套，光看函数测试证明不了调用点 ---------------------

test('守卫：简化版四出口已删除', () => {
  const gdc = readFileSync(new URL('../src/shared/goal-driven-cycle.ts', import.meta.url), 'utf8');
  assert.ok(!gdc.includes('export function decideNextEngineeringAction'), '四出口简化版仍在，双轨没消灭');
  const orch = readFileSync(new URL('../src/main/orchestrator.ts', import.meta.url), 'utf8');
  assert.ok(!orch.includes('decideNextEngineeringAction'), 'orchestrator 还在用旧出口');
});

test('守卫：orchestrator 只有一个判定出口并按 nextAction 落行为', () => {
  const orch = readFileSync(new URL('../src/main/orchestrator.ts', import.meta.url), 'utf8');
  assert.ok(orch.includes('decideCycleAction('), 'orchestrator 没有改调 decideCycleAction');
  assert.ok(!orch.includes('emitCycleDecision'), '裸枚举手写映射的 emitCycleDecision 还在');
  assert.ok(orch.includes('this.decideAndEmit('), '判定与落事件没有走同一处');
  assert.ok(/nextAction === 'finish_completed'/.test(orch), '收尾行为没有按决策落点分支');
  assert.ok(/nextAction === 'pause_budget'/.test(orch), '预算行为没有按决策落点分支');
  assert.ok(/nextAction === 'stop_and_wait'/.test(orch), '等待行为没有按决策落点分支');
  assert.ok(!/const actualDecision =/.test(orch), '决策标签的本地三元映射还在');
});

test('守卫：决策事件带 CycleDecisionResult 全字段', () => {
  const contracts = readFileSync(new URL('../src/shared/contracts.ts', import.meta.url), 'utf8');
  const block = contracts.slice(
    contracts.indexOf("type: 'cycle.decision.created'"),
    contracts.indexOf("type: 'cycle.decision.created'") + 1600
  );
  for (const field of ['roundId', 'decisionType', 'reason', 'evidenceRefs', 'nextAction', 'requiresUser', 'targetStage', 'diagnosis', 'progress', 'goalFit', 'budget']) {
    assert.ok(block.includes(`${field}:`), `cycle.decision.created 少了 ${field}`);
  }
  // 枚举与纯函数同源，不再在事件契约里另列一份。
  assert.ok(block.includes('CycleDecisionType'), 'decisionType 仍是手抄枚举');
  const orch = readFileSync(new URL('../src/main/orchestrator.ts', import.meta.url), 'utf8');
  assert.ok(orch.includes('nextAction: decision.nextAction'), '事件没有记判定给出的落点');
  assert.ok(orch.includes('progress: input.progress'), '事件没有记进展计数');
});

test('守卫：反空转真的接进了执行层（阈值、分类、指令三处都不留第二套口径）', () => {
  const orch = readFileSync(new URL('../src/main/orchestrator.ts', import.meta.url), 'utf8');
  assert.ok(
    /detectNoProgress\(\{[\s\S]{0,400}repeatLimit: limits\.repeatLimit/.test(orch),
    '阈值没有传进 detectNoProgress——配置化就只剩一个没人读的常量'
  );
  assert.ok(orch.includes('deriveNoProgressCause({'), '空转分类没有从两轮报告的硬事实推导');
  // 截取冒号前的 code 只准有一处：诊断与分类共用同一份 errorCodes，各截一次迟早不一致。
  assert.equal((orch.match(/code\.split\(':'\)\[0\]/g) ?? []).length, 1, '归一化错误码的地方不止一处');
  assert.match(orch, /deriveNoProgressCause\(\{[\s\S]{0,240}errorCodes,/, '分类没有复用归一化后的错误码');
  assert.ok(orch.includes('noProgressCause: decision.noProgressCause'), '事件记的不是判定真正用上的分类');
  assert.ok(orch.includes('noProgress: cycleDecision.noProgressCause'), '空转指令没有随下一轮计划请求下发');
  // 下一轮的定位写死成「修复」时，REPLAN 轮在界面上会显示成修 bug，和事件里的决策对不上。
  assert.ok(!orch.includes('GDC 下一轮=repair'), '下一轮的定位仍写死为修复');
  assert.ok(!orch.includes("'修复轮重新规划'"), '阶段提示仍写死为修复轮');

  const contracts = readFileSync(new URL('../src/shared/contracts.ts', import.meta.url), 'utf8');
  const block = contracts.slice(contracts.indexOf("type: 'cycle.decision.created'"));
  assert.ok(block.slice(0, 1800).includes('noProgressCause:'), 'cycle.decision.created 少了空转分类字段');

  // 算了没拼进提示词等于没做：这一段曾经是一个没人用的局部变量。
  const protocol = readFileSync(new URL('../src/shared/protocol.ts', import.meta.url), 'utf8');
  assert.ok(protocol.includes('${idleSection}'), '空转指令算出来了但没有进下一轮提示词');

  // 阈值来源只有一处解析：调用点各写各的 `?? 2` 会让「配置了但没生效」查不出来。
  const shared = readFileSync(new URL('../src/shared/cycle-decision.ts', import.meta.url), 'utf8');
  assert.ok(shared.includes('export function resolveNoProgressLimits'), '阈值优先级没有放在纯函数侧');
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  assert.ok(main.includes('noProgressLimits: () => resolveNoProgressLimits('), '宿主没有把阈值接进编排器');
});

test('守卫：详情入口能看到判定落点，且说法只有一个来源（渲染层无测试框架，按源码核对）', () => {
  const shared = readFileSync(new URL('../src/shared/cycle-decision.ts', import.meta.url), 'utf8');
  const gdc = readFileSync(new URL('../src/shared/goal-driven-cycle.ts', import.meta.url), 'utf8');
  assert.ok(shared.includes('export const CYCLE_NEXT_ACTION_TEXT'), '落点的中文说法没有放在纯函数侧');
  assert.ok(gdc.includes('export function cycleDecisionText'), '判定句没有由投影层给出');

  const panel = readFileSync(
    new URL('../src/renderer/src/components/CollaborationResultPanel.tsx', import.meta.url),
    'utf8'
  );
  const card = readFileSync(
    new URL('../src/renderer/src/components/engineering/GoalContractCard.tsx', import.meta.url),
    'utf8'
  );
  for (const [name, source] of [['结果面板', panel], ['目标契约卡', card]]) {
    assert.ok(source.includes('cycleDecisionText('), `${name}没有用投影层那句判定`);
    // 组件里再列一份映射表：枚举加了成员时只有一处会更新，另一处静默显示原始英文。
    assert.ok(!source.includes('finish_completed:'), `${name}自己抄了一份落点说法`);
  }
  // 工程任务的判定只能在目标契约卡上看到——结果面板挂在会话视图里。
  assert.ok(card.includes('latestCycleDecision'), '目标契约卡没有「最近一次周期判定」入口');
});
