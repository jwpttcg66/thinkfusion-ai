import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTaskViewEvent, projectTaskView } from '../out-test/shared/task-view.js';

const event = (value) => ({ at: 1, eventId: Math.random().toString(36), sequence: 1, ...value });

test('TaskView 按轮次投影：新一轮清空旧计划和旧回答', () => {
  const plan = { planId: 'p1', taskId: 't', roundId: 'r1', title: '计划', steps: [], completion: { condition: '完成' } };
  const events = [
    event({ type: 'round.started', taskId: 't', roundId: 'r1', roundNumber: 1, inputType: 'user_prompt' }),
    event({ type: 'plan.ready', taskId: 't', roundId: 'r1', plan }),
    event({ type: 'round.answer', taskId: 't', roundId: 'r1', text: '旧回答' }),
    event({ type: 'round.delta', taskId: 't', roundId: 'r1', text: '迟到', reasoning: '内部' }),
    event({ type: 'round.started', taskId: 't', roundId: 'r2', roundNumber: 2, inputType: 'user_prompt' })
  ];
  const view = projectTaskView(events);
  assert.equal(view.plan, null, '新一轮不能显示旧计划');
  assert.equal(view.answer, '', '新一轮不能显示旧回答');
  assert.equal(view.live.text, '');
  assert.equal(view.live.roundId, 'r2');
});

test('报告轮不清计划：步骤总数与计划预览不能凭空消失', () => {
  const steps = [
    { stepId: 's1', tool: 'fs.writeFile', title: '写文件', args: {}, intent: '写' },
    { stepId: 's2', tool: 'fs.readFile', title: '读回', args: {}, intent: '读' }
  ];
  const plan = { planId: 'p1', taskId: 't', roundId: 'r1', title: '计划', steps, completion: { condition: '完成' } };
  const events = [
    event({ type: 'round.started', taskId: 't', roundId: 'r1', roundNumber: 1, inputType: 'user_prompt' }),
    event({ type: 'plan.ready', taskId: 't', roundId: 'r1', plan }),
    event({ type: 'step.completed', taskId: 't', roundId: 'r1', stepId: 's1', callId: 's1' }),
    // 执行报告发回模型：新一轮，但问的是同一份计划。
    event({ type: 'round.started', taskId: 't', roundId: 'r2', roundNumber: 2, inputType: 'execution_report' })
  ];
  const view = projectTaskView(events);
  assert.equal(view.plan?.steps.length, 2, '报告轮之后仍要能数出「已完成 / 总数」');
  assert.equal(view.answer, '', '回答仍然按轮次清空');
});

test('补充回答轮同样不清计划', () => {
  const plan = { planId: 'p1', taskId: 't', roundId: 'r1', title: '计划', steps: [], completion: { condition: '完成' } };
  const view = projectTaskView([
    event({ type: 'round.started', taskId: 't', roundId: 'r1', roundNumber: 1, inputType: 'user_prompt' }),
    event({ type: 'plan.ready', taskId: 't', roundId: 'r1', plan }),
    event({ type: 'round.started', taskId: 't', roundId: 'r2', roundNumber: 2, inputType: 'clarification_answer' })
  ]);
  assert.equal(view.plan?.planId, 'p1');
});

test('回答到达后流状态结算，迟到 delta 不复活', () => {
  const events = [
    event({ type: 'round.started', taskId: 't', roundId: 'r1', roundNumber: 1, inputType: 'user_prompt' }),
    event({ type: 'round.delta', taskId: 't', roundId: 'r1', text: 'hello', reasoning: '想一想' }),
    event({ type: 'round.answer', taskId: 't', roundId: 'r1', text: 'hello' }),
    event({ type: 'round.delta', taskId: 't', roundId: 'r1', text: 'late' })
  ];
  const view = projectTaskView(events);
  assert.equal(view.answer, 'hello');
  assert.equal(view.live.text, '');
  assert.equal(view.modelTrace.length, 1);
  assert.equal(view.modelTrace[0].text, 'hello');
});

// 2026-11-22 真机：任务跑完、验证也通过了，交付卡整块不渲染——因为在线事件
// 走的是 applyTaskViewEvent，而它当初只处理了轮次 / 计划 / 回答，报告与评审
// 只在全量重算里落地，用户得重新点开这条任务才看得见验证结果。
test('在线事件也把验证与评审落进视图，不用等重新打开任务', () => {
  const report = {
    protocol: 'desktop-agent/v1', type: 'execution_report', taskId: 't', roundId: 'r1', planId: 'p1',
    status: 'completed', errors: [], nextAction: 'complete', createdAt: 1,
    results: [{ stepId: 's1', tool: 'fs.writeFile', status: 'completed', verified: true, durationMs: 1, result: { path: 'a.java', before: 'x', after: 'y' } }],
    verification: {
      verified: true, reasons: [], changedFiles: 1, changedPaths: ['a.java'],
      checks: {
        compile: { status: 'passed', exitCode: 0 },
        run: { status: 'passed', exitCode: 0, command: 'java A', output: 'hello everybody' },
        tests: { status: 'skipped' },
        diagnostics: { status: 'skipped', errors: 0, warnings: 0 },
        changedFiles: ['a.java']
      }
    }
  };
  let view = projectTaskView([event({ type: 'round.started', taskId: 't', roundId: 'r1', roundNumber: 1, inputType: 'user_prompt' })]);
  view = applyTaskViewEvent(view, event({ type: 'report.ready', taskId: 't', roundId: 'r1', report }));
  view = applyTaskViewEvent(view, event({
    type: 'review.ready', taskId: 't', roundId: 'r1', reviewer: 'model', backend: 'model',
    verdict: '通过', issues: [], needsFix: false
  }));
  assert.equal(view.verification.verified, true);
  assert.equal(view.verification.checks.run.output, 'hello everybody');
  assert.equal(view.changes.length, 1);
  assert.equal(view.review.needsFix, false);
  // 全量与增量必须给出同一个结果。
  const full = projectTaskView([
    event({ type: 'round.started', taskId: 't', roundId: 'r1', roundNumber: 1, inputType: 'user_prompt' }),
    event({ type: 'report.ready', taskId: 't', roundId: 'r1', report }),
    event({ type: 'review.ready', taskId: 't', roundId: 'r1', reviewer: 'model', backend: 'model', verdict: '通过', issues: [], needsFix: false })
  ]);
  assert.deepEqual(view.verification, full.verification);
});
