/**
 * 对话流投影：后面一轮不许覆盖前面一轮，中间执行与最后结论都要在流里。
 *
 * Run with: npm run test:task-conversation
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConclusion,
  buildTaskConversation,
  memberBodyView,
  protocolKind,
  protocolSummary
} from '../out-test/shared/task-conversation.js';

const task = 't1';

function roundStart(at, roundId, roundNumber, inputType) {
  return { type: 'round.started', at, taskId: task, roundId, roundNumber, inputType };
}

function peer(at, roundId, memberId, label, status, extra = {}) {
  return { type: 'round.peer', at, taskId: task, roundId, memberId, label, status, ...extra };
}

test('流式 live 并进已有的主导卡，不再另起一张 lead 卡', () => {
  const leadId = 'lead:OpenCode Go · deepseek-v4.1-flash';
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'execution_report'),
    peer(1100, 'r1', leadId, 'OpenCode Go · deepseek-v4.1-flash', 'started'),
    { type: 'round.delta', at: 1200, taskId: task, roundId: 'r1', participantId: leadId, streamId: 's1', text: '半句', modelId: 'deepseek-v4.1-flash' }
  ], {
    live: { roundId: 'r1', text: '半句续', reasoning: '想', providerId: 'OpenCode Go', modelId: 'deepseek-v4.1-flash' }
  });

  const members = entries.filter(entry => entry.kind === 'member');
  // 修复前：一张 leadId 卡 + 一张硬编码 lead 卡 = 两张；修复后只一张并合并文本。
  assert.equal(members.length, 1);
  assert.equal(members[0].memberId, leadId);
  assert.equal(members[0].text, '半句续');
  assert.equal(members[0].status, 'streaming');
});

test('两轮同名成员各留一条：第 2 轮不覆盖第 1 轮', () => {
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    peer(1100, 'r1', 'm1', 'OpenCode Go', 'started'),
    peer(1500, 'r1', 'm1', 'OpenCode Go', 'answered', { text: '第一轮回答', durationMs: 400 }),
    roundStart(2000, 'r2', 2, 'execution_report'),
    peer(2100, 'r2', 'm1', 'OpenCode Go', 'started'),
    peer(2400, 'r2', 'm1', 'OpenCode Go', 'answered', { text: '第二轮回答', durationMs: 300 })
  ]);

  const members = entries.filter(entry => entry.kind === 'member');
  assert.equal(members.length, 2);
  assert.equal(members[0].text, '第一轮回答');
  assert.equal(members[0].roundNumber, 1);
  assert.equal(members[1].text, '第二轮回答');
  assert.equal(members[1].roundNumber, 2);
});

test('中间执行过程进对话流：步骤带轮次、带真实 stdout', () => {
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    {
      type: 'step.completed',
      at: 1200,
      taskId: task,
      stepId: 's1',
      roundId: 'r1',
      tool: 'shell.run',
      durationMs: 162,
      result: { command: 'javac Hello.java && java Hello', stdout: 'hello everybody', stderr: '', exitCode: 0 }
    }
  ]);

  const steps = entries.filter(entry => entry.kind === 'step');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].roundId, 'r1');
  assert.equal(steps[0].roundNumber, 1);
  assert.equal(steps[0].card.tool, 'shell.run');
  assert.equal(steps[0].card.result.stdout, 'hello everybody');
});

test('用户原话在最前，结论在最后', () => {
  const entries = buildTaskConversation(
    [
      roundStart(1000, 'r1', 1, 'user_prompt'),
      peer(1100, 'r1', 'm1', '模型', 'answered', { text: '好' }),
      { type: 'task.completed', at: 3000, taskId: task, summary: '已经跑过 javac 与 java，退出码 0。' }
    ],
    { prompt: '写一个 Hello 并真机跑一下', summary: '已经跑过 javac 与 java，退出码 0。', status: 'completed' }
  );
  assert.equal(entries[0].kind, 'user');
  assert.equal(entries[0].text, '写一个 Hello 并真机跑一下');
  assert.equal(entries.at(-1).kind, 'conclusion');
  assert.equal(entries.at(-1).text, '已经跑过 javac 与 java，退出码 0。');
});

test('结论带真实事实：步数、验证、评审', () => {
  const entries = buildTaskConversation(
    [
      roundStart(1000, 'r1', 1, 'user_prompt'),
      {
        type: 'report.ready',
        at: 2000,
        taskId: task,
        roundId: 'r1',
        report: {
          status: 'completed',
          results: [{ status: 'completed' }, { status: 'completed' }],
          verification: {
            verified: true,
            reasons: [],
            changedFiles: 1,
            checks: {
              compile: { status: 'passed' },
              tests: { status: 'skipped' },
              diagnostics: { status: 'passed', errors: 0, warnings: 0 }
            }
          }
        }
      },
      {
        type: 'review.ready',
        at: 2200,
        taskId: task,
        roundId: 'r1',
        reviewer: 'OpenCode Go',
        backend: 'model',
        verdict: '没问题',
        issues: [],
        needsFix: false
      },
      { type: 'task.completed', at: 3000, taskId: task, summary: '完成。' }
    ],
    { summary: '完成。', status: 'completed' }
  );
  const conclusion = entries.at(-1);
  assert.equal(conclusion.kind, 'conclusion');
  assert.equal(conclusion.tone, 'ok');
  assert.match(conclusion.facts.join(' / '), /执行 2 步，完成 2 步/);
  assert.match(conclusion.facts.join(' / '), /验证通过/);
  assert.match(conclusion.facts.join(' / '), /改动 1 个文件/);
  assert.match(conclusion.facts.join(' / '), /独立评审：通过/);
});

test('协议 JSON 不是结论：没有 summary 就如实说没有结论文本', () => {
  const plan = JSON.stringify({
    protocol: 'desktop-agent/v1',
    type: 'plan',
    plan: { title: '写文件', steps: [] }
  });
  const entries = buildTaskConversation(
    [
      roundStart(1000, 'r1', 1, 'user_prompt'),
      { type: 'round.answer', at: 1500, taskId: task, roundId: 'r1', text: plan },
      { type: 'task.completed', at: 2000, taskId: task }
    ],
    { status: 'completed' }
  );
  const conclusion = entries.at(-1);
  assert.equal(conclusion.kind, 'conclusion');
  assert.doesNotMatch(conclusion.text, /"protocol"/);
  assert.match(conclusion.text, /没有给出结论文本/);

  const member = entries.find(entry => entry.kind === 'member');
  assert.equal(member.protocol, 'plan');
  assert.equal(member.text, plan);
});

test('失败任务的结论写失败原因，不写「任务完成」', () => {
  const conclusion = buildConclusion(
    [
      roundStart(1000, 'r1', 1, 'user_prompt'),
      { type: 'task.failed', at: 2000, taskId: task, error: '模型规划超时（120 秒）' }
    ],
    { status: 'failed' }
  );
  assert.equal(conclusion.tone, 'error');
  assert.match(conclusion.text, /模型规划超时/);
});

test('尚未结束的任务不出结论卡', () => {
  const conclusion = buildConclusion([roundStart(1000, 'r1', 1, 'user_prompt')], { status: 'executing' });
  assert.equal(conclusion, null);
});

test('协议识别：plan / execution_report / task_complete 认得出，普通文本与坏 JSON 不认', () => {
  assert.equal(protocolKind('{"protocol":"desktop-agent/v1","type":"plan"}'), 'plan');
  assert.equal(protocolKind('{"protocol":"desktop-agent/v1","type":"execution_report"}'), 'execution_report');
  assert.equal(protocolKind('{"protocol":"desktop-agent/v1","type":"clarification_required"}'), 'clarification_required');
  assert.equal(protocolKind('{"protocol":"desktop-agent/v1","type":"task_complete","summary":"完成"}'), 'task_complete');
  assert.equal(protocolKind('直接一段回答'), null);
  assert.equal(protocolKind('{"broken":'), null);
  assert.equal(protocolKind('{"type":"plan"}'), null);
  // 真机第一次验证栽在这：模型把协议包在 ```json 围栏里。
  assert.equal(
    protocolKind('```json\n{"protocol":"desktop-agent/v1","type":"plan","plan":{"title":"写文件"}}\n```'),
    'plan'
  );
  assert.equal(
    protocolSummary('```json\n{"protocol":"desktop-agent/v1","type":"execution_report","summary":"退出码 0"}\n```'),
    '退出码 0'
  );
  assert.equal(
    protocolSummary('{"protocol":"desktop-agent/v1","type":"execution_report","summary":"退出码 0"}'),
    '退出码 0'
  );
  assert.equal(protocolSummary('{"protocol":"desktop-agent/v1","type":"plan","plan":{"title":"写文件"}}'), '写文件');
});

// 同一份思考在流式期间只能出现一次：正文框铺了它，底部折叠就要收掉。
// 真机上三处重复（正文框 + 卡内折叠 + App 旧「模型思考」卡）就是这么来的。
test('流式期间正文未到：思考铺进正文框，卡内思考折叠收起', () => {
  const view = memberBodyView({
    status: 'streaming', text: '', reasoning: '先想清楚本机 IP 怎么取',
    reasoningSupported: true, protocol: null
  });
  assert.equal(view.bodyText, '先想清楚本机 IP 怎么取');
  assert.equal(view.bodyIsReasoning, true);
  assert.equal(view.showLiveThinking, true);
  assert.equal(view.showReasoningDetails, false, '同一份内容不能再折一次');
  assert.equal(view.displayLength, '先想清楚本机 IP 怎么取'.length);
  assert.equal(view.placeholder, null);
});

test('正文到了就切回正文，思考折叠恢复供查证（两份不同内容）', () => {
  const view = memberBodyView({
    status: 'streaming', text: '本机 IP 是 192.168.1.7', reasoning: '先想清楚本机 IP 怎么取',
    reasoningSupported: true, protocol: null
  });
  assert.equal(view.bodyText, '本机 IP 是 192.168.1.7');
  assert.equal(view.bodyIsReasoning, false);
  assert.equal(view.showLiveThinking, false);
  assert.equal(view.showReasoningDetails, true);
});

test('已完成成员：正文框只认正文，没正文就如实占位', () => {
  const withText = memberBodyView({
    status: 'completed', text: '结论', reasoning: '推理', reasoningSupported: true, protocol: null
  });
  assert.equal(withText.bodyText, '结论');
  assert.equal(withText.showReasoningDetails, true);
  const without = memberBodyView({
    status: 'completed', text: '', reasoning: '推理', reasoningSupported: true, protocol: null
  });
  assert.equal(without.bodyText, '');
  assert.equal(without.placeholder, '这次没有输出正文。');
  assert.equal(without.showReasoningDetails, true);
});

test('协议对象不把 JSON 原文误标成思考', () => {
  const plan = '{"protocol":"desktop-agent/v1","type":"plan","summary":"建工程"}';
  const view = memberBodyView({
    status: 'streaming', text: '', reasoning: plan, reasoningSupported: true, protocol: 'plan'
  });
  assert.equal(view.bodyIsReasoning, false);
  assert.equal(view.showLiveThinking, false);
  assert.equal(view.showReasoningDetails, true);
});

test('流式且思考也没来：只给占位，不显示空折叠', () => {
  const view = memberBodyView({
    status: 'streaming', text: '', reasoning: '', reasoningSupported: false, protocol: null
  });
  assert.equal(view.bodyText, '');
  assert.equal(view.placeholder, '等待模型输出…');
  assert.equal(view.showReasoningDetails, false);
  assert.equal(view.displayLength, 0);
});
