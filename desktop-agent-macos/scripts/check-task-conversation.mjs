/**
 * 对话流投影：后面一轮不许覆盖前面一轮，中间执行与最后结论都要在流里。
 *
 * Run with: npm run test:task-conversation
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConclusion,
  buildStreamLandmarks,
  buildTaskConversation,
  memberBodyView,
  protocolDerivation,
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

test('结论必须完整输出执行目标与执行结果', () => {
  const conclusion = buildConclusion(
    [
      roundStart(1000, 'r1', 1, 'user_prompt'),
      {
        type: 'plan.ready',
        at: 1500,
        taskId: task,
        roundId: 'r1',
        plan: {
          planId: 'p1',
          title: 'Go hello world',
          description: '本机写 demo',
          completion: '终端输出 hello world',
          steps: [
            { id: 's1', tool: 'fs.writeFile', args: { path: 'main.go' }, description: '写文件' },
            { id: 's2', tool: 'shell.run', args: { command: 'go run main.go' }, description: '运行' }
          ],
          warnings: []
        }
      },
      {
        type: 'report.ready',
        at: 2000,
        taskId: task,
        roundId: 'r1',
        report: {
          status: 'completed',
          results: [
            {
              stepId: 's1',
              tool: 'fs.writeFile',
              status: 'completed',
              verified: true,
              durationMs: 1,
              args: { path: 'main.go' },
              result: { path: 'main.go', bytes: 42 }
            },
            {
              stepId: 's2',
              tool: 'shell.run',
              status: 'completed',
              verified: true,
              durationMs: 1,
              args: { command: 'go run main.go' },
              result: { command: 'go run main.go', exitCode: 0, stdout: 'hello world\n' }
            }
          ],
          verification: {
            verified: true,
            reasons: [],
            changedFiles: 1,
            checks: {
              compile: { status: 'skipped' },
              tests: { status: 'skipped' },
              diagnostics: { status: 'skipped', errors: 0, warnings: 0 }
            }
          }
        }
      },
      { type: 'task.completed', at: 3000, taskId: task, summary: '完成' }
    ],
    { status: 'completed' }
  );
  assert.ok(conclusion);
  assert.match(conclusion.executionGoal, /终端输出 hello world/);
  assert.match(conclusion.executionGoal, /Go hello world/);
  assert.ok(conclusion.executionResults.some(item => /main\.go/.test(item)));
  assert.ok(conclusion.executionResults.some(item => /hello world/.test(item)));
  assert.match(conclusion.facts.join(' / '), /执行 2 步/);
  assert.ok(conclusion.deliverables.some(item => /main\.go/.test(item)), '目标物必须列出写出的文件');
});

test('方案评审 done 心跳不得把已辩完冲回进行中', () => {
  const topics = ['offset 格式'];
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    {
      type: 'plan.review.progress',
      at: 2000,
      taskId: task,
      roundId: 'r1',
      planId: 'p1',
      state: 'waiting',
      topics: 1,
      topicTexts: topics,
      elapsedMs: 1000,
      message: '评审中'
    },
    {
      type: 'plan.debated',
      at: 3000,
      taskId: task,
      roundId: 'r1',
      planId: 'p1',
      debate: {
        status: 'completed',
        topics,
        participants: ['m1'],
        summary: '可批',
        at: 3000
      }
    },
    {
      type: 'plan.review.progress',
      at: 3100,
      taskId: task,
      roundId: 'r1',
      planId: 'p1',
      state: 'done',
      topics: 1,
      topicTexts: topics,
      elapsedMs: 2000,
      message: '方案评审等待结束'
    }
  ], { status: 'awaiting_approval' });
  const debate = entries.find(entry => entry.kind === 'debate');
  assert.equal(debate.status, 'completed');
});

test('套话 summary 可作收口标题：执行明细进 facts，不把工具 stdout 顶成核心结论', () => {
  const conclusion = buildConclusion(
    [
      roundStart(1000, 'r1', 1, 'user_prompt'),
      {
        type: 'report.ready',
        at: 2000,
        taskId: task,
        roundId: 'r1',
        report: {
          status: 'completed',
          results: [
            {
              stepId: 's1',
              tool: 'fs.list',
              status: 'completed',
              verified: true,
              durationMs: 1,
              result: [
                { name: 'readme.txt', type: 'file' },
                { name: 'src', type: 'directory' }
              ]
            }
          ],
          verification: {
            verified: true,
            reasons: ['本轮没有写操作，无需验证'],
            changedFiles: 0,
            checks: {
              compile: { status: 'skipped' },
              tests: { status: 'skipped' },
              diagnostics: { status: 'skipped', errors: 0, warnings: 0 }
            }
          }
        }
      },
      { type: 'task.completed', at: 3000, taskId: task, summary: '执行完成，验证通过' }
    ],
    { summary: '执行完成，验证通过', status: 'completed' }
  );
  assert.ok(conclusion);
  assert.equal(conclusion.text, '执行完成，验证通过');
  assert.match(conclusion.facts.join(' / '), /目录内容：readme\.txt、src/);
  assert.match(conclusion.executionResults.join(' / '), /目录内容：readme\.txt、src/);
});

test('修复轮长命令不得顶成核心结论；目标物取全轮并集', () => {
  const conclusion = buildConclusion(
    [
      roundStart(1000, 'r1', 1, 'user_prompt'),
      {
        type: 'report.ready',
        at: 2000,
        taskId: task,
        roundId: 'r1',
        report: {
          status: 'completed',
          results: [
            {
              stepId: 's1',
              tool: 'fs.writeFile',
              status: 'completed',
              verified: true,
              durationMs: 1,
              args: { path: 'go-http-demo/main.go' },
              result: { path: 'go-http-demo/main.go' }
            }
          ],
          verification: {
            verified: true,
            reasons: [],
            changedFiles: 1,
            changedPaths: ['go-http-demo/main.go'],
            checks: {
              compile: { status: 'passed' },
              tests: { status: 'passed' },
              diagnostics: { status: 'passed', errors: 0, warnings: 0 }
            }
          }
        }
      },
      roundStart(3000, 'r2', 2, 'execution_report'),
      {
        type: 'report.ready',
        at: 4000,
        taskId: task,
        roundId: 'r2',
        report: {
          status: 'completed',
          results: [
            {
              stepId: 's2',
              tool: 'shell.run',
              status: 'completed',
              verified: true,
              durationMs: 1,
              args: { command: 'cd /tmp && ./bin/httpdemo >/tmp/x.log 2>&1 & pid=$!; kill $pid; exit 0' },
              result: { exitCode: 0, stdout: 'RUN_OK\nHEALTHZ\n{"status":"ok"}' }
            }
          ],
          verification: {
            verified: true,
            reasons: ['本轮没有写操作，无需验证'],
            changedFiles: 0,
            checks: {
              compile: { status: 'skipped' },
              tests: { status: 'skipped' },
              diagnostics: { status: 'skipped', errors: 0, warnings: 0 }
            }
          }
        }
      },
      { type: 'task.completed', at: 5000, taskId: task, summary: '执行完成，验证通过' }
    ],
    { summary: '执行完成，验证通过', status: 'completed' }
  );
  assert.ok(conclusion);
  assert.equal(conclusion.text, '执行完成，验证通过');
  assert.doesNotMatch(conclusion.text, /httpdemo|RUN_OK|pid=/);
  assert.ok(conclusion.deliverables.some(path => path.includes('go-http-demo/main.go')));
});

test('协议计划抽出可读推导：步骤与完成条件', () => {
  const plan = JSON.stringify({
    protocol: 'desktop-agent/v1',
    type: 'plan',
    summary: '列出根目录',
    plan: {
      title: '列出根目录',
      completion: { condition: '列出文件名' },
      steps: [
        { tool: 'fs.list', description: '列根目录', args: { path: '.' } }
      ]
    }
  });
  const text = protocolDerivation(plan);
  assert.match(text, /【计划】列出根目录/);
  assert.match(text, /完成条件：列出文件名/);
  assert.match(text, /1\. fs\.list — 列根目录/);
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

test('流式空等超过 3 秒：占位写明已等多久，不再只剩「等待模型输出」', () => {
  const view = memberBodyView({
    status: 'streaming', text: '', reasoning: '', reasoningSupported: false, protocol: null, waitMs: 11_000
  });
  assert.match(view.placeholder, /已等 11 秒/);
  assert.match(view.placeholder, /内部思考/);
});

function reportEvent(at, verification) {
  return {
    type: 'report.ready',
    at,
    taskId: task,
    roundId: 'r1',
    report: {
      protocol: 'desktop-agent/v1',
      type: 'execution_report',
      taskId: task,
      roundId: 'r1',
      planId: 'p1',
      status: 'completed',
      results: [
        { stepId: 's1', tool: 'shell.run', status: 'completed', verified: true, durationMs: 10 }
      ],
      errors: [],
      nextAction: 'complete',
      createdAt: at,
      verification
    }
  };
}

function verificationOf(verified, reasons, changedFiles = 1) {
  return {
    verified,
    reasons,
    changedFiles,
    checks: {
      compile: { status: 'passed' },
      tests: { status: verified ? 'passed' : 'skipped' },
      diagnostics: { status: 'skipped', errors: 0, warnings: 0 }
    }
  };
}

test('每次验证各占一条并编号：后一次不覆盖前一次', () => {
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    reportEvent(2000, verificationOf(false, ['测试未执行'])),
    reportEvent(4000, verificationOf(true, []))
  ], { status: 'executing' });

  const verifications = entries.filter(entry => entry.kind === 'verification');
  assert.equal(verifications.length, 2);
  assert.equal(verifications[0].index, 1);
  assert.equal(verifications[0].verified, false);
  assert.equal(verifications[0].reasons.join(''), '测试未执行');
  assert.equal(verifications[1].index, 2);
  assert.equal(verifications[1].verified, true);
  // 验证卡讲 checks；执行报告节点讲逐步结果——两者并存，结果不得被验证卡顶掉。
  const reportNotes = entries.filter(entry => entry.kind === 'note' && entry.text.startsWith('执行报告：'));
  assert.equal(reportNotes.length, 2);
  assert.ok(reportNotes.every(entry => typeof entry.detail === 'string' && entry.detail.includes('[shell.run]')));
});

test('独立评审按时间落进时间线，位置在两次验证之间', () => {
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    reportEvent(2000, verificationOf(false, ['测试未执行'])),
    {
      type: 'review.ready',
      at: 3000,
      taskId: task,
      roundId: 'r1',
      reviewer: 'OpenCode Go',
      backend: 'model',
      verdict: '还差一次测试',
      issues: ['测试未执行'],
      needsFix: true
    },
    reportEvent(4000, verificationOf(true, []))
  ], { status: 'executing' });

  const reviews = entries.filter(entry => entry.kind === 'review');
  const verifications = entries.filter(entry => entry.kind === 'verification');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].index, 1);
  assert.equal(reviews[0].needsFix, true);
  assert.equal(reviews[0].verdict, '还差一次测试');
  assert.deepEqual(reviews[0].issues, ['测试未执行']);
  assert.equal(verifications.length, 2);
  assert.ok(reviews[0].at > verifications[0].at);
  assert.ok(reviews[0].at < verifications[1].at);
  assert.equal(verifications.at(-1).at, 4000);
});

test('多次验证按时间排序：旧卡留在原位，新的追加在后面', () => {
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    reportEvent(2000, verificationOf(false, ['第一次'])),
    reportEvent(2500, verificationOf(false, ['第二次'])),
    reportEvent(3000, verificationOf(true, []))
  ], { status: 'executing' });

  const verifications = entries.filter(entry => entry.kind === 'verification');
  assert.deepEqual(verifications.map(entry => entry.at), [2000, 2500, 3000]);
  assert.deepEqual(verifications.map(entry => entry.index), [1, 2, 3]);
});

test('计划就绪生成计划卡：8 步原文都在，不只剩一句计数', () => {
  const steps = Array.from({ length: 8 }, (_, index) => ({
    id: `s${index + 1}`,
    tool: index === 3 ? 'fs.writeFile' : 'shell.run',
    description: `第 ${index + 1} 步`,
    args: { command: `echo ${index + 1}`, path: `hello/file-${index + 1}.go` }
  }));
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    {
      type: 'plan.ready',
      at: 2000,
      taskId: task,
      roundId: 'r1',
      plan: {
        planId: 'p1',
        taskId: task,
        roundId: 'r1',
        title: '新建 Go 程序输出 hello jwp 并本机运行验证',
        description: '写文件并真机跑一遍',
        completion: '退出码 0 且 stdout 为 hello jwp',
        steps
      }
    }
  ], { status: 'planning' });

  const plans = entries.filter(entry => entry.kind === 'plan');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].steps.length, 8);
  assert.equal(plans[0].steps[3].tool, 'fs.writeFile');
  assert.equal(plans[0].title, '新建 Go 程序输出 hello jwp 并本机运行验证');
  assert.equal(entries.filter(entry => entry.kind === 'note' && entry.text.startsWith('计划就绪')).length, 0);
});

test('方案评审心跳要把表态对象/目标与议题目标写进对话流', () => {
  const topics = ['步骤拆分是否合理', '系统动作影响面'];
  const topicGoals = ['标出可合并项与失败断点', '决定保留或砍掉并写失败收尾'];
  const expressTarget = '工程计划「Go demo」的步骤、系统动作与完成条件';
  const expressGoal = '给出可审批判断：哪些步骤保留/合并/砍掉，系统动作是否必要；结论必须指向具体步骤编号。';
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    {
      type: 'plan.review.progress',
      at: 2000,
      taskId: task,
      roundId: 'r1',
      planId: 'p1',
      state: 'started',
      topics: 2,
      topicTexts: topics,
      topicGoals,
      expressTarget,
      expressGoal,
      elapsedMs: 0,
      message: '开始'
    }
  ], { status: 'plan_ready' });
  const debate = entries.find(entry => entry.kind === 'debate');
  assert.ok(debate);
  assert.equal(debate.expressTarget, expressTarget);
  assert.equal(debate.expressGoal, expressGoal);
  assert.deepEqual(debate.topicGoals, topicGoals);
  assert.deepEqual(debate.topics, topics);
});

test('五段结论一出就要进方案评审卡，后续心跳不能冲掉原文', () => {
  const leadSummary = [
    '【结论】应先写最小可运行 demo。',
    '【一致】用标准库 time。',
    '【分歧】没有。',
    '【存疑】时区偏移格式。',
    '【辩题】offset 负值格式是否覆盖。'
  ].join('\n');
  const topics = ['offset 负值格式是否覆盖'];
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    {
      type: 'plan.review.progress',
      at: 2000,
      taskId: task,
      roundId: 'r1',
      planId: 'p1',
      state: 'waiting',
      topics: 1,
      topicTexts: topics,
      topicGoals: ['确认负偏移显示'],
      expressTarget: '工程计划',
      expressGoal: '可审批判断',
      leadSummary,
      elapsedMs: 12_000,
      message: '五段结论已出，主导模型指定 1 个辩题'
    },
    {
      type: 'plan.review.progress',
      at: 3000,
      taskId: task,
      roundId: 'r1',
      planId: 'p1',
      state: 'waiting',
      topics: 1,
      topicTexts: topics,
      elapsedMs: 22_000,
      message: '五段结论已出（1 个议题），成员表态中，已等待 22 秒'
    }
  ], { status: 'plan_ready' });
  const debate = entries.find(entry => entry.kind === 'debate');
  assert.ok(debate);
  assert.equal(debate.leadSummary, leadSummary);
  assert.deepEqual(debate.topics, topics);
  assert.equal(debate.elapsedMs, 22_000);
});

test('方案评审只有一个条目：心跳原地更新，辩完后带议题与结论', () => {
  const progress = (at, state, elapsedMs, topicTexts) => ({
    type: 'plan.review.progress',
    at,
    taskId: task,
    roundId: 'r1',
    planId: 'p1',
    state,
    topics: topicTexts.length,
    topicTexts,
    rounds: 2,
    roundsReason: '单成员自辩固定 2 轮：第 1 轮表态，第 2 轮必须质疑第 1 轮',
    elapsedMs,
    message: '方案评审'
  });
  const topics = ['步骤拆分是否合理：8 步里哪些可以合并', '这 4 个系统动作有没有更小的影响面'];
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    progress(2000, 'started', 0, topics),
    progress(3000, 'waiting', 1000, topics),
    progress(4000, 'done', 2000, topics),
    {
      type: 'plan.debated',
      at: 4000,
      taskId: task,
      roundId: 'r1',
      planId: 'p1',
      debate: {
        status: 'completed',
        topics,
        participants: ['opencode-go:deepseek-v4.1-flash'],
        summary: '两步可以合并，系统动作保留。',
        rounds: 2,
        roundsReason: '计划有 8 步，按规模跑 2 轮',
        at: 4000
      }
    }
  ], { status: 'plan_ready' });

  const debates = entries.filter(entry => entry.kind === 'debate');
  assert.equal(debates.length, 1);
  assert.equal(debates[0].topics.length, 2);
  assert.equal(debates[0].topics[1], topics[1]);
  assert.equal(debates[0].status, 'completed');
  assert.equal(debates[0].rounds, 2);
  assert.match(debates[0].summary, /系统动作保留/);
  assert.deepEqual(debates[0].participants, ['opencode-go:deepseek-v4.1-flash']);
  assert.equal(entries.filter(entry => entry.kind === 'note' && entry.text.startsWith('方案评审')).length, 0);
});

test('方案评审等待中也能看到议题原文', () => {
  const topics = ['覆盖已有文件是否必要', '步骤拆分是否合理'];
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    {
      type: 'plan.review.progress',
      at: 2000,
      taskId: task,
      roundId: 'r1',
      planId: 'p1',
      state: 'waiting',
      topics: 2,
      topicTexts: topics,
      rounds: 2,
      roundsReason: '单成员自辩固定 2 轮：第 1 轮表态，第 2 轮必须质疑第 1 轮',
      elapsedMs: 30000,
      message: '方案评审进行中'
    }
  ], { status: 'plan_ready' });

  const debate = entries.find(entry => entry.kind === 'debate');
  assert.equal(debate.status, 'running');
  assert.deepEqual(debate.topics, topics);
  assert.equal(debate.elapsedMs, 30000);
  assert.equal(debate.rounds, 2);
  assert.match(debate.roundsReason, /第 2 轮必须质疑/);
});

test('轮间桥接：先画出质疑/回应对象再开下一轮', () => {
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    {
      type: 'plan.review.bridge',
      at: 2100,
      taskId: task,
      roundId: 'r1',
      planId: 'p1',
      action: 'continue',
      fromRound: 1,
      fromPhase: 'analysis',
      fromPhaseLabel: '表态',
      nextPhase: 'challenge',
      nextPhaseLabel: '质疑',
      message: '第 1 轮表态结束，还有 1 条争议，进入第 2 轮质疑。先画出以下 1 条分歧，再发起第 2 轮质疑',
      targets: [{
        left: '应该先写测试',
        right: '可以直接改文件',
        reason: '两句互相否定',
        agents: ['本地 A', '云端 B']
      }]
    }
  ], { status: 'plan_ready' });

  const bridges = entries.filter(entry => entry.kind === 'bridge');
  assert.equal(bridges.length, 1);
  assert.equal(bridges[0].bridgeKind, 'review');
  assert.equal(bridges[0].action, 'continue');
  assert.equal(bridges[0].nextPhase, 'challenge');
  assert.match(bridges[0].title, /先画出依据，再开质疑/);
  assert.equal(bridges[0].targets.length, 1);
  assert.match(bridges[0].targets[0].left, /先写测试/);
  assert.match(bridges[0].targets[0].right, /直接改文件/);
  assert.equal(bridges[0].targets[0].reason, '两句互相否定');
});

test('执行前桥接：先画出将跑的步骤再动手', () => {
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    {
      type: 'execution.bridge',
      at: 3000,
      taskId: task,
      roundId: 'r1',
      planId: 'p1',
      message: '计划已批准，将按 2 步执行「补 Hello」',
      steps: [
        { index: 1, tool: 'fs.write', description: '写出 Hello.java', target: 'src/Hello.java' },
        { index: 2, tool: 'shell.run', description: '编译运行', target: 'javac Hello.java && java Hello' }
      ]
    }
  ], { status: 'executing' });

  const bridges = entries.filter(entry => entry.kind === 'bridge');
  assert.equal(bridges.length, 1);
  assert.equal(bridges[0].bridgeKind, 'execution');
  assert.equal(bridges[0].action, 'execute');
  assert.equal(bridges[0].title, '执行前依据');
  assert.equal(bridges[0].steps.length, 2);
  assert.equal(bridges[0].steps[0].tool, 'fs.write');
  assert.match(bridges[0].steps[1].target, /javac/);
});

test('时序里程碑：分解 / ECO / 参与决策按事件顺序进对话流', () => {
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    {
      type: 'work.breakdown.created',
      at: 1100,
      taskId: task,
      workId: 'work-1',
      title: '补 Hello World'
    },
    {
      type: 'eco.context.prepared',
      at: 1200,
      taskId: task,
      package: {
        contextPackageId: 'eco-1',
        contextVersion: 1,
        workId: 'work-1',
        stage: 'plan',
        role: 'planner',
        architectureSummary: '单文件 Java 示例',
        resources: [],
        constraints: [],
        decisions: [],
        verifiedFacts: [],
        inferences: [],
        unknowns: [],
        missingCritical: [],
        sufficiency: 'sufficient',
        createdAt: 1200
      }
    },
    {
      type: 'model.participation.selected',
      at: 1300,
      taskId: task,
      stage: 'plan',
      risk: 'L1',
      participants: [{ participantId: 'p1', roles: ['planner'], reason: '默认规划' }],
      excluded: [],
      debate: 'skip',
      modelReview: 'on_demand',
      reasons: ['低风险跳过辩论'],
      userPinned: false
    },
    peer(1400, 'r1', 'm1', 'OpenCode Go', 'answered', { text: '开始规划' })
  ]);

  const notes = entries.filter(entry => entry.kind === 'note');
  assert.equal(notes.length, 4); // 轮次 note + 三个里程碑
  assert.match(notes[0].text, /第 1 轮 · 提问/);
  assert.match(notes[1].text, /任务分解 · 补 Hello World/);
  assert.match(notes[2].text, /工程上下文 · sufficient · v1/);
  assert.match(notes[3].text, /模型参与 · L1 · 辩论 skip · 审核 on_demand/);
  assert.match(notes[3].detail, /p1（planner）/);
  assert.match(notes[3].detail, /低风险跳过辩论/);

  // 里程碑插在成员回答之前：提问 → 分解 → ECO → 参与 → 回答。
  const kinds = entries.map(entry => entry.kind);
  const firstMember = kinds.indexOf('member');
  assert.equal(firstMember, 4);
  assert.deepEqual(kinds.slice(0, firstMember), ['note', 'note', 'note', 'note']);
});

test('快速定位轴：只收提问/计划/结论等重点；旁注里程碑不进轴', () => {
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    {
      type: 'eco.context.prepared',
      at: 1050,
      taskId: task,
      package: {
        contextPackageId: 'eco-1',
        contextVersion: 1,
        workId: 'work-1',
        stage: 'plan',
        role: 'planner',
        architectureSummary: 'x',
        resources: [],
        constraints: [],
        decisions: [],
        verifiedFacts: [],
        inferences: [],
        unknowns: [],
        missingCritical: [],
        sufficiency: 'sufficient',
        createdAt: 1050
      }
    },
    {
      type: 'plan.ready',
      at: 1100,
      taskId: task,
      roundId: 'r1',
      plan: {
        planId: 'p1',
        taskId: task,
        roundId: 'r1',
        title: '补 Hello',
        description: '写文件并运行',
        completion: '看到 hello',
        steps: [
          { id: 's1', tool: 'fs.writeFile', description: '写 Hello.java', args: { path: 'Hello.java' } },
          { id: 's2', tool: 'shell.run', description: '运行', args: { command: 'javac Hello.java' } }
        ]
      }
    },
    {
      type: 'step.completed',
      at: 1200,
      taskId: task,
      stepId: 's1',
      roundId: 'r1',
      tool: 'fs.writeFile',
      durationMs: 10,
      result: { path: 'Hello.java' }
    },
    {
      type: 'step.completed',
      at: 1300,
      taskId: task,
      stepId: 's2',
      roundId: 'r1',
      tool: 'shell.run',
      durationMs: 20,
      result: { exitCode: 0, stdout: 'ok' }
    },
    {
      type: 'report.ready',
      at: 1400,
      taskId: task,
      roundId: 'r1',
      report: {
        status: 'completed',
        results: [
          {
            stepId: 's1',
            tool: 'fs.writeFile',
            status: 'completed',
            verified: true,
            durationMs: 10,
            args: { path: 'Hello.java' },
            result: { path: 'Hello.java' }
          }
        ],
        verification: {
          verified: true,
          reasons: [],
          changedFiles: 1,
          changedPaths: ['Hello.java'],
          checks: {
            compile: { status: 'passed' },
            tests: { status: 'skipped' },
            diagnostics: { status: 'skipped', errors: 0, warnings: 0 }
          }
        }
      }
    },
    { type: 'task.completed', at: 1500, taskId: task, summary: '执行完成，验证通过' }
  ], {
    prompt: '写一个 Hello',
    summary: '执行完成，验证通过',
    status: 'completed'
  });

  const landmarks = buildStreamLandmarks(entries);
  const kinds = landmarks.map(item => item.kind);
  assert.ok(kinds.includes('prompt'));
  assert.ok(kinds.includes('plan'));
  assert.ok(kinds.includes('step'));
  assert.ok(kinds.includes('conclusion'));
  assert.equal(kinds.filter(kind => kind === 'step').length, 1); // 只标首步
  assert.ok(!landmarks.some(item => /工程上下文|任务分解|循环决策/.test(item.label)));
  const conclusion = landmarks.find(item => item.kind === 'conclusion');
  assert.ok(conclusion);
  assert.match(conclusion.label, /结论 · 目标物/);
});

test('会话参与记录：参与/未参与都写清，不裁剪', async () => {
  const { describeConversationParticipation } = await import('../out-test/shared/conversation.js');
  const observed = describeConversationParticipation({
    answers: [{ channelId: 'local-a' }, { channelId: 'cloud-b' }, { channelId: 'web-c' }],
    debaters: ['local-a', 'cloud-b'],
    kindOf: id => (id.startsWith('local') ? 'local' : id.startsWith('cloud') ? 'cloud' : 'web')
  });
  assert.deepEqual(observed.participants.map(item => item.participantId), ['local-a', 'cloud-b']);
  assert.deepEqual(observed.excluded.map(item => item.participantId), ['web-c']);
  assert.match(observed.excluded[0].reason, /归属规则/);
  assert.match(observed.note, /2 人参与辩论，1 人未参与/);
});

test('A 方案接线：两条流按时间合并、同刻保序、重复 key 只留一条', async () => {
  const { mergeChronological } = await import('../out-test/shared/task-conversation.js');
  const conversation = [
    { key: 'q', at: 100, text: '提问' },
    { key: 'a', at: 300, text: '回答' }
  ];
  const task = [
    { key: 'plan', at: 200, text: '计划' },
    { key: 'a', at: 300, text: '回答（重复）' }
  ];
  const merged = mergeChronological(conversation, task);
  assert.deepEqual(merged.map(item => item.key), ['q', 'plan', 'a']);
  assert.equal(merged[2].text, '回答');
});

/* ------------------------------------------------------------------------- *
 * 阶段 A 渲染层接线：接口先立住，再谈画成什么样
 * ------------------------------------------------------------------------- */

test('定位轨色档：地标类型都能落到 CSS 认识的五档，不靠渲染层猜', async () => {
  const { landmarkTone, buildStreamLandmarks, buildTaskConversation } = await import(
    '../out-test/shared/task-conversation.js'
  );
  const entries = buildTaskConversation(
    [
      roundStart(1000, 'r1', 1, 'execution_report'),
      { type: 'plan.ready', at: 1100, taskId: task, roundId: 'r1', plan: { planId: 'p1', title: '读文件再跑测试', steps: [] } },
      { type: 'step.started', at: 1200, taskId: task, roundId: 'r1', stepId: 's1', tool: 'fs.readFile', index: 1, total: 2 },
      { type: 'step.completed', at: 1300, taskId: task, roundId: 'r1', stepId: 's1', tool: 'fs.readFile', result: {}, durationMs: 100 },
      { type: 'task.completed', at: 1400, taskId: task, summary: '做完了' }
    ],
    { prompt: '读一下再跑测试' }
  );
  const landmarks = buildStreamLandmarks(entries);
  assert.ok(landmarks.length >= 3, `地标太少：${String(landmarks.length)}`);
  const tones = landmarks.map(item => landmarkTone(item.kind));
  // 每种 kind 都必须有明确色档，不能 undefined 落到默认灰点。
  assert.ok(tones.every(tone => ['prompt', 'plan', 'debate', 'exec', 'check', 'done'].includes(tone)));
  assert.equal(landmarkTone('prompt'), 'prompt');
  assert.equal(landmarkTone('debate_peer'), 'debate');
  assert.equal(landmarkTone('bridge'), 'exec');
  assert.equal(landmarkTone('verification'), 'check');
  assert.equal(landmarkTone('conclusion'), 'done');
  // 未知类型不抛错：宁可画成执行点，也不能把整条流打挂。
  assert.equal(landmarkTone('something_new'), 'exec');
});

test('锚点 id 只由 entry.key 决定：重算投影后同一个条目锚点不变', async () => {
  const { streamAnchorId, buildTaskConversation } = await import('../out-test/shared/task-conversation.js');
  const events = [
    roundStart(1000, 'r1', 1, 'execution_report'),
    { type: 'round.peer', at: 1100, taskId: task, roundId: 'r1', memberId: 'm1', label: 'A · 模型', status: 'completed', text: '答' }
  ];
  const first = buildTaskConversation(events, { prompt: '问题' });
  const second = buildTaskConversation(events, { prompt: '问题' });
  assert.deepEqual(first.map(entry => entry.key), second.map(entry => entry.key));
  assert.equal(streamAnchorId('q'), 'stream-q');
  assert.equal(streamAnchorId(first[0].key), streamAnchorId(second[0].key));
  // 同一份数据，换渲染顺序也不能换锚点身份：锚点里不许出现下标。
  assert.doesNotMatch(streamAnchorId(first[0].key), /#\d|:\d+$/);
  assert.notEqual(streamAnchorId('a'), streamAnchorId('b'));
});

test('步骤耗时：运行中现算，结束后用真实耗时，没有起点就不编', async () => {
  const { stepElapsedMs } = await import('../out-test/shared/task-conversation.js');
  // 运行中：8 秒（原来界面这里什么都不显示）
  assert.equal(stepElapsedMs({ status: 'running', startedAt: 1000 }, 9000), 8000);
  // 没有 startedAt 就不给值，不拿 now 当起点
  assert.equal(stepElapsedMs({ status: 'running' }, 9000), null);
  // 结束：优先真实 durationMs
  assert.equal(stepElapsedMs({ status: 'completed', startedAt: 1000, durationMs: 250 }, 99999), 250);
  // 没有 durationMs 时用起止补
  assert.equal(stepElapsedMs({ status: 'failed', startedAt: 1000, endedAt: 1700 }, 99999), 700);
  // 还没开始跑的不算耗时
  assert.equal(stepElapsedMs({ status: 'preparing' }, 9000), null);
  assert.equal(stepElapsedMs({ status: 'waiting' }, 9000), null);
});

test('运行秒数文案：不到 1 秒 / 8 秒 / 1 分 05 秒，非法值不显示', async () => {
  const { liveElapsedText } = await import('../out-test/shared/task-conversation.js');
  assert.equal(liveElapsedText(800), '不到 1 秒');
  assert.equal(liveElapsedText(8000), '8 秒');
  assert.equal(liveElapsedText(59999), '59 秒');
  assert.equal(liveElapsedText(65000), '1 分 05 秒');
  assert.equal(liveElapsedText(Number.NaN), '');
  assert.equal(liveElapsedText(-1), '');
});

test('每秒重画的条件要包含「有步骤在跑」，不能只看成员流式', async () => {
  const { needsLiveTimer } = await import('../out-test/shared/task-conversation.js');
  const member = status => ({ key: 'm', at: 1, kind: 'member', status });
  const step = status => ({ key: 's', at: 1, kind: 'step', card: { stepId: 's', tool: 'fs.readFile', status } });
  // 修复前：只有这一步，timer 不启动，秒数停住
  assert.equal(needsLiveTimer([step('running')]), true);
  assert.equal(needsLiveTimer([member('streaming')]), true);
  assert.equal(needsLiveTimer([member('streaming'), step('running')]), true);
  assert.equal(needsLiveTimer([member('completed'), step('completed')]), false);
  assert.equal(needsLiveTimer([step('waiting'), step('preparing')]), false);
  assert.equal(needsLiveTimer([]), false);
});

test('定位轨高亮：取可视锚点里最靠后那个，都不在轨道上就不改', async () => {
  const { activeLandmarkId } = await import('../out-test/shared/task-conversation.js');
  const landmarks = [
    { id: 'lm-q', kind: 'prompt', label: '提问', entryKey: 'q', at: 1 },
    { id: 'lm-plan', kind: 'plan', label: '计划', entryKey: 'plan', at: 2 },
    { id: 'lm-step', kind: 'step', label: '开始执行', entryKey: 'step1', at: 3 },
    { id: 'lm-done', kind: 'conclusion', label: '结论', entryKey: 'done', at: 4 }
  ];
  assert.equal(activeLandmarkId(landmarks, ['q', 'plan']), 'lm-plan');
  // 传入顺序不影响结果：按轨道顺序取最靠后
  assert.equal(activeLandmarkId(landmarks, ['step1', 'q']), 'lm-step');
  assert.equal(activeLandmarkId(landmarks, ['done']), 'lm-done');
  // 可视里没有轨道节点（比如旁注）→ 保留上次高亮
  assert.equal(activeLandmarkId(landmarks, ['note-x']), null);
  assert.equal(activeLandmarkId(landmarks, []), null);
});

test('只有一个地标时不出定位轨：一个点占一列没有跳转价值', async () => {
  const { shouldShowLandmarkRail } = await import('../out-test/shared/task-conversation.js');
  assert.equal(shouldShowLandmarkRail([]), false);
  assert.equal(shouldShowLandmarkRail([{ id: 'lm-q', kind: 'prompt', label: '提问', entryKey: 'q', at: 1 }]), false);
  assert.equal(
    shouldShowLandmarkRail([
      { id: 'lm-q', kind: 'prompt', label: '提问', entryKey: 'q', at: 1 },
      { id: 'lm-c', kind: 'conclusion', label: '结论', entryKey: 'c', at: 2 }
    ]),
    true
  );
});

test('时间线不再单独挂定位列表：里程碑直接在正文流里出现', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const ui = readFileSync(join(root, 'src/renderer/src/components/engineering/TaskConversation.tsx'), 'utf8');
  const css = readFileSync(join(root, 'src/renderer/src/style.css'), 'utf8');

  assert.match(ui, /from '\.\.\/\.\.\/\.\.\/\.\.\/shared\/task-conversation'/);
  // 独立定位轨连组件带样式一起退场；里程碑本身已经是流里的记录。
  assert.doesNotMatch(ui, /LocateRail/);
  assert.doesNotMatch(ui, /chat-locate/);
  assert.doesNotMatch(css, /chat-locate/);
  assert.doesNotMatch(css, /--chat-locate-w/);
  assert.doesNotMatch(css, /\.chat-feed-layout\s*\{[^}]*grid-template-columns/);

  // 锚点 id 只能有一个来源：渲染层不许再手拼 `stream-${key}`。
  assert.match(ui, /id=\{streamAnchorId\(entryKey\)\}/);
  assert.doesNotMatch(ui, /id=\{`stream-\$\{/);

  // 计时：条件与文案都走投影层，渲染层只调用。
  assert.match(ui, /needsLiveTimer\(entries\)/);
  assert.match(ui, /stepElapsedMs\(card, props\.now\)/);
  assert.match(ui, /liveElapsedText\(live\)/);
  // 旧写法（只看成员流式）必须彻底消失，否则步骤跑起来秒数还是不动。
  assert.doesNotMatch(ui, /entries\.some\(entry => entry\.kind === 'member' && entry\.status === 'streaming'\)/);
});

/* ------------------------------------------------------------------------- *
 * 阶段 B：稳定身份 / 统一状态 / 类型化旁注 / 真实改动量聚合
 * ------------------------------------------------------------------------- */

function reportWithDiff(at, roundId, verificationPatch) {
  return {
    type: 'report.ready',
    at,
    taskId: task,
    roundId,
    report: {
      status: 'ok',
      results: [
        { stepId: 'step-1', tool: 'fs.readFile', status: 'completed' },
        { stepId: 'step-2', tool: 'test.run', status: 'completed' }
      ],
      verification: {
        verified: true,
        fullyVerified: true,
        reasons: ['测试通过'],
        changedFiles: 2,
        changedPaths: ['a.ts', 'b.ts'],
        checks: {
          compile: { status: 'passed' },
          tests: { status: 'passed' },
          diagnostics: { status: 'passed', errors: 0, warnings: 0 },
          changedFiles: ['a.ts', 'b.ts']
        },
        ...verificationPatch
      }
    }
  };
}

test('B1 稳定身份与统一状态：id 只由事件内容决定，业务状态一个字都不改', async () => {
  const { buildTaskConversation } = await import('../out-test/shared/task-conversation.js');
  const events = [
    roundStart(1000, 'r1', 1, 'execution_report'),
    peer(1100, 'r1', 'm1', 'A · 模型', 'started'),
    // 成员答完的事件状态是 'answered'（写成 'completed' 会被投影当成取消）
    peer(1200, 'r1', 'm1', 'A · 模型', 'answered', { text: '答' })
  ];
  const first = buildTaskConversation(events, { prompt: '问题' });
  const second = buildTaskConversation(events, { prompt: '问题' });
  // 每条都有身份与统一状态
  assert.ok(first.every(entry => typeof entry.id === 'string' && entry.id.length > 0));
  assert.ok(first.every(entry => typeof entry.conversationStatus === 'string'));
  // 重算投影 id 不变（不用下标）
  assert.deepEqual(first.map(entry => entry.id), second.map(entry => entry.id));
  // 成员的业务状态仍是 streaming/completed，统一状态只做呈现
  const member = first.find(entry => entry.kind === 'member');
  assert.equal(member.status, 'completed');
  assert.equal(member.conversationStatus, 'completed');
  const streaming = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'execution_report'),
    peer(1100, 'r1', 'm1', 'A · 模型', 'started')
  ], { prompt: '问题' }).find(entry => entry.kind === 'member');
  assert.equal(streaming.status, 'streaming');
  assert.equal(streaming.conversationStatus, 'running');
});

test('B1 统一状态不吞业务状态：辩论 stopped 记 cancelled，不是 completed', async () => {
  const { normalizeEntries, conversationStatusOf } = await import('../out-test/shared/task-conversation.js');
  const base = { key: 'd1', at: 1, roundId: 'r1', roundNumber: 1 };
  const stopped = { ...base, kind: 'debate', status: 'stopped', topics: [], participants: ['a', 'b'], summary: '', elapsedMs: 1 };
  assert.equal(conversationStatusOf(stopped), 'cancelled');
  assert.equal(stopped.status, 'stopped');
  const skipped = { ...base, kind: 'debate', status: 'skipped', topics: [], participants: [], summary: '', elapsedMs: 0 };
  assert.equal(conversationStatusOf(skipped), 'skipped');
  // 步骤四态映射：preparing/waiting 是 pending，失败不被说成完成
  const stepOf = status => ({ ...base, kind: 'step', card: { stepId: 's', tool: 'fs.readFile', status } });
  assert.equal(conversationStatusOf(stepOf('waiting')), 'pending');
  assert.equal(conversationStatusOf(stepOf('running')), 'running');
  assert.equal(conversationStatusOf(stepOf('failed')), 'failed');
  // 重复 key 不互相覆盖：第二个带后缀，仍然确定
  const dup = normalizeEntries([{ ...base, kind: 'note', subtype: 'milestone', tone: 'muted', text: 'a' },
    { ...base, kind: 'note', subtype: 'milestone', tone: 'muted', text: 'b' }]);
  assert.deepEqual(dup.map(entry => entry.id), ['d1', 'd1#2']);
});

test('B2 旁注带类型：不再靠 text.startsWith 猜自己是什么', async () => {
  const { buildTaskConversation } = await import('../out-test/shared/task-conversation.js');
  const entries = buildTaskConversation(
    [
      roundStart(1000, 'r1', 1, 'execution_report'),
      { type: 'work.breakdown.created', at: 1100, taskId: task, roundId: 'r1', workId: 'w1', title: '两个子任务' },
      { type: 'eco.context.requested', at: 1200, taskId: task, roundId: 'r1', request: { requestId: 'q1', reason: '需要看入口文件', requestedPaths: ['a.ts'] } }
    ],
    { prompt: '读一下入口' }
  );
  const notes = entries.filter(entry => entry.kind === 'note');
  assert.ok(notes.length >= 2);
  // 每条旁注都必须有类型；漏标会让呈现层退回猜前缀。
  assert.ok(notes.every(entry => typeof entry.subtype === 'string' && entry.subtype.length > 0));
  const subtypes = notes.map(entry => entry.subtype);
  assert.ok(subtypes.includes('round'));
  assert.ok(subtypes.includes('breakdown'));
  assert.ok(subtypes.includes('context_request'));
});

test('B3 改动量：只认真实统计，取不到就写「统计不可用」，老报告只写文件数', async () => {
  const { diffSummaryOf, diffText } = await import('../out-test/shared/task-conversation.js');
  // 有真数字
  const real = diffSummaryOf({ changedFiles: 3, insertions: 1253, deletions: 390, diffAvailable: true });
  assert.equal(diffText(real), '改动 3 个文件 · +1253 / -390');
  // 取 diff 失败：不说 0
  assert.equal(diffText(diffSummaryOf({ changedFiles: 3, diffAvailable: false })), '改动 3 个文件 · 统计不可用');
  // 老报告：只有文件数
  assert.equal(diffText(diffSummaryOf({ changedFiles: 2 })), '改动 2 个文件');
  // 没改动就不出胶囊
  assert.equal(diffSummaryOf({ changedFiles: 0 }), null);
  assert.equal(diffSummaryOf(null), null);
});

test('B3 聚合条目：后一份报告只改数字，位置固定在第一次出现处', async () => {
  const { buildTaskConversation } = await import('../out-test/shared/task-conversation.js');
  const events = [
    roundStart(1000, 'r1', 1, 'execution_report'),
    reportWithDiff(2000, 'r1', { changedFiles: 2, insertions: 10, deletions: 2, diffAvailable: true }),
    reportWithDiff(5000, 'r1', { changedFiles: 3, insertions: 18, deletions: 6, diffAvailable: true })
  ];
  const entries = buildTaskConversation(events, { prompt: '改点东西' });
  const diffs = entries.filter(entry => entry.kind === 'note' && entry.subtype === 'diff');
  assert.equal(diffs.length, 1, `应当只有一条聚合条目，实际 ${String(diffs.length)}`);
  const diff = diffs[0];
  assert.equal(diff.at, 2000, '位置由 firstAt 决定，不能被 updatedAt 拽到末尾');
  assert.equal(diff.aggregate.firstAt, 2000);
  assert.equal(diff.aggregate.updatedAt, 5000);
  assert.match(diff.text, /\+18 \/ -6/);
  // 投影可重复计算：同一份事件两次结果完全一致
  const again = buildTaskConversation(events, { prompt: '改点东西' });
  assert.deepEqual(again.find(entry => entry.kind === 'note' && entry.subtype === 'diff'), diff);
});

test('B3 取 diff 的解析与失败：二进制跳过、失败不写 0', async () => {
  const { parseNumstat, collectDiffStats, withDiffStats } = await import('../out-test/main/engineering/diff-stats.js');
  const total = parseNumstat('12\t3\tsrc/a.ts\n-\t-\tassets/logo.png\n4\t0\tsrc/b.ts\n');
  assert.equal(total.insertions, 16);
  assert.equal(total.deletions, 3);
  assert.equal(total.binaryFiles, 1);
  assert.deepEqual(total.files, [
    { path: 'src/a.ts', insertions: 12, deletions: 3 },
    { path: 'assets/logo.png', insertions: 0, deletions: 0, binary: true },
    { path: 'src/b.ts', insertions: 4, deletions: 0 }
  ]);

  const failing = () => ({ status: 128, stdout: '' });
  const failed = collectDiffStats({ workspaceRoot: '/tmp/whatever', run: failing });
  assert.equal(failed.available, false);
  assert.match(failed.detail, /git diff 失败/);
  // 拿不到统计时不许填 0
  const patched = withDiffStats({ changedFiles: 2, reasons: [] }, failed);
  assert.equal(patched.diffAvailable, false);
  assert.equal(patched.insertions, undefined);

  const ok = collectDiffStats({
    workspaceRoot: '/tmp/whatever',
    run: () => ({ status: 0, stdout: '7\t1\ta.ts\n' })
  });
  assert.equal(ok.available, true);
  assert.equal(ok.insertions, 7);
  assert.equal(withDiffStats({ changedFiles: 1, reasons: [] }, ok).insertions, 7);
  // 没有工作区直接判失败，不猜
  assert.equal(collectDiffStats({ workspaceRoot: null }).available, false);
});

/* ------------------------------------------------------------------------- *
 * 阶段 1：逐文件 Diff 明细（C3b 的数据前置）
 * ------------------------------------------------------------------------- */

test('阶段1：parseNumstat 一次解析同时给出总数与逐文件，行数之和等于总数', async () => {
  const { parseNumstat } = await import('../out-test/main/engineering/diff-stats.js');
  const stdout = [
    '12\t3\tsrc/a.ts',
    '1\t1\tdocs/设计 交付 验证.md',   // 路径含空格
    '-\t-\tassets/logo.png',          // 二进制
    '29\t29\tdocs/方案.md',
    '4\t0\tnew.ts'                     // 新增文件
  ].join('\n');
  const parsed = parseNumstat(stdout);
  const sum = parsed.files.filter(f => !f.binary).reduce(
    (acc, f) => ({ i: acc.i + f.insertions, d: acc.d + f.deletions }), { i: 0, d: 0 }
  );
  assert.equal(sum.i, parsed.insertions, '逐文件 insertions 之和 = 总数');
  assert.equal(sum.d, parsed.deletions, '逐文件 deletions 之和 = 总数');
  // 空格路径整段保留，不被截断
  assert.ok(parsed.files.some(f => f.path === 'docs/设计 交付 验证.md'));
  // 二进制不虚构行数
  const binary = parsed.files.find(f => f.path === 'assets/logo.png');
  assert.equal(binary?.binary, true);
  assert.equal(binary?.insertions, 0);
  assert.equal(binary?.deletions, 0);
  assert.equal(parsed.binaryFiles, 1);
});

test('阶段1：未跟踪文件导致明细不完整时标 filesAvailable=false，不伪造清单', async () => {
  const { collectDiffStats, withDiffStats } = await import('../out-test/main/engineering/diff-stats.js');
  const run = () => ({ status: 0, stdout: '1\t0\ta.ts\n' });
  // 报告说改了 a.ts 和 new-untracked.ts，numstat 只采到 a.ts → 明细不完整
  const incomplete = collectDiffStats({
    workspaceRoot: '/tmp/whatever',
    paths: ['a.ts', 'new-untracked.ts'],
    run
  });
  assert.equal(incomplete.available, true);
  assert.equal(incomplete.filesAvailable, false);
  const report = withDiffStats({ changedFiles: 2 }, incomplete);
  assert.equal(report.diffAvailable, true, '总数仍可信');
  assert.equal(report.diffFilesAvailable, false);
  assert.equal(report.diffFiles, undefined, '不完整时就不写 diffFiles，界面没有假清单');

  // 全部路径都能在 numstat 里找到 → 明细完整
  const complete = collectDiffStats({ workspaceRoot: '/tmp/whatever', paths: ['a.ts'], run });
  assert.equal(complete.filesAvailable, true);
  const fullReport = withDiffStats({ changedFiles: 1 }, complete);
  assert.deepEqual(fullReport.diffFiles, [{ path: 'a.ts', insertions: 1, deletions: 0 }]);
});

test('阶段1：投影层透传 diffFiles，明细不完整时不出 fileStats', async () => {
  const { diffSummaryOf } = await import('../out-test/shared/task-conversation.js');
  const files = [
    { path: 'BilliardShellJson.java', insertions: 1, deletions: 1 },
    { path: '验证.md', insertions: 29, deletions: 29 }
  ];
  const full = diffSummaryOf({
    changedFiles: 2, insertions: 30, deletions: 30, diffAvailable: true,
    diffFiles: files, diffFilesAvailable: true
  });
  assert.deepEqual(full.fileStats, files);
  assert.equal(full.filesAvailable, true);

  const noDetail = diffSummaryOf({
    changedFiles: 2, insertions: 30, deletions: 30, diffAvailable: true,
    diffFiles: files, diffFilesAvailable: false
  });
  assert.equal(noDetail.fileStats, undefined, '明细不完整时不透传，界面画不出假列表');
  assert.equal(noDetail.filesAvailable, false);
});

test('阶段1：文件变更块聚合条目位置仍由 firstAt 决定，逐文件数据随报告更新', async () => {
  const events = [
    roundStart(1000, 'r1', 1, 'execution_report'),
    reportWithDiff(2000, 'r1', {
      changedFiles: 2, insertions: 10, deletions: 2, diffAvailable: true,
      diffFiles: [{ path: 'a.ts', insertions: 9, deletions: 1 }, { path: 'b.ts', insertions: 1, deletions: 1 }],
      diffFilesAvailable: true
    }),
    reportWithDiff(5000, 'r1', {
      changedFiles: 3, insertions: 18, deletions: 6, diffAvailable: true,
      diffFiles: [
        { path: 'a.ts', insertions: 9, deletions: 1 },
        { path: 'b.ts', insertions: 1, deletions: 1 },
        { path: 'c.ts', insertions: 8, deletions: 4 }
      ],
      diffFilesAvailable: true
    })
  ];
  const entries = buildTaskConversation(events, { prompt: '改点东西' });
  const diffs = entries.filter(entry => entry.kind === 'note' && entry.subtype === 'diff');
  assert.equal(diffs.length, 1, '只有一条聚合条目');
  assert.equal(diffs[0].at, 2000, '位置固定在第一次出现处');
  assert.equal(diffs[0].diff.filesAvailable, true);
  assert.equal(diffs[0].diff.fileStats.length, 3, '逐文件明细跟随最新报告更新');
  const sum = diffs[0].diff.fileStats.reduce((acc, f) => acc + f.insertions, 0);
  assert.equal(sum, 18, '逐文件 insertions 之和等于最新总数');
});

/* ------------------------------------------------------------------------- *
 * C1 / C2：呈现映射与连续步骤聚合
 * ------------------------------------------------------------------------- */

test('C1-C4 接线守住：渲染层真的消费了 subtype / 聚合 / 三元素 / MarkdownBody', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const ui = readFileSync(join(root, 'src/renderer/src/components/engineering/TaskConversation.tsx'), 'utf8');
  const css = readFileSync(join(root, 'src/renderer/src/style.css'), 'utf8');

  // C1：前缀正则判类型必须彻底消失，改由 shared 的 subtype 映射。
  assert.doesNotMatch(ui, /function noteEmphasis\(/);
  assert.match(ui, /noteEmphasisOf\(entry\.kind === 'note' \? entry\.subtype : undefined\)/);

  // C2：聚类只改呈现，渲染层消费 clusterSteps 结果。
  assert.match(ui, /clusterSteps\(entries\)/);
  assert.match(ui, /<StepClusterMessage/);
  // 失败输出仍逐条画：聚合组内部还调 StepMessage。
  assert.match(ui, /<StepMessage key=\{entry\.key\} entry=\{entry\} now=\{props\.now\}/);

  // C3：三元素各自独立，变更块不是胶囊的展开态。
  assert.match(ui, /function DiffCapsule\(/);
  assert.match(ui, /function DiffChangeBlock\(/);
  assert.match(ui, /function DeliverableCards\(/);
  assert.match(ui, /diff\.filesAvailable && diff\.fileStats\.length > 0/);

  // C4：MarkdownBody 接入，流式期间仍降级为 pre（半成品不崩溃、不逐字符重排）。
  assert.match(ui, /import \{ MarkdownBody \}/);
  // 两处成员正文（辩论卡 + 普通流式成员）都要接，漏一处就有一半回答还是 <pre>。
  const mdCalls = ui.match(/<MarkdownBody text=/g) ?? [];
  assert.ok(mdCalls.length >= 2, `MarkdownBody 接线应 ≥2 处，实际 ${String(mdCalls.length)}`);
  assert.match(ui, /live \? \(/);

  // 样式槽位真实存在。
  for (const cls of ['chat-diff-capsule', 'chat-diff-block', 'chat-deliverables', 'chat-step-cluster', 'chat-member-md']) {
    assert.match(css, new RegExp(`\\.${cls}`), `样式缺失：${cls}`);
  }
});

test('C1：noteEmphasis 由 subtype 决定，旧数据缺 subtype 回退 focus', async () => {
  const { noteEmphasisOf } = await import('../out-test/shared/task-conversation.js');
  assert.equal(noteEmphasisOf('context'), 'aside');
  assert.equal(noteEmphasisOf('breakdown'), 'aside');
  assert.equal(noteEmphasisOf('participation'), 'aside');
  assert.equal(noteEmphasisOf('goal_fit'), 'aside');
  assert.equal(noteEmphasisOf('clarification'), 'focus');
  assert.equal(noteEmphasisOf('milestone'), 'focus');
  assert.equal(noteEmphasisOf('diff'), 'focus');
  assert.equal(noteEmphasisOf(undefined), 'focus', '缺类型不藏重点内容');
});

test('C2：连续同类 step 聚合，失败数准确，跨轮/跨工具/审批处断开', async () => {
  const { clusterSteps } = await import('../out-test/shared/task-conversation.js');
  const base = [
    roundStart(1000, 'r1', 1, 'execution_report'),
    { type: 'step.completed', at: 1100, taskId: task, roundId: 'r1', stepId: 's1', tool: 'fs.readFile', result: {}, durationMs: 10 },
    { type: 'step.completed', at: 1200, taskId: task, roundId: 'r1', stepId: 's2', tool: 'fs.readFile', result: {}, durationMs: 10 },
    { type: 'step.failed', at: 1300, taskId: task, roundId: 'r1', stepId: 's3', tool: 'fs.search', error: 'boom', durationMs: 10 },
    // 中间夹一条成员输出 → 断开
    peer(1350, 'r1', 'm1', '某模型', 'answered', { text: '回答' }),
    { type: 'step.completed', at: 1400, taskId: task, roundId: 'r1', stepId: 's4', tool: 'fs.readFile', result: {}, durationMs: 10 },
    // 跨轮 → 断开
    roundStart(2000, 'r2', 2, 'execution_report'),
    { type: 'step.completed', at: 2100, taskId: task, roundId: 'r2', stepId: 's5', tool: 'fs.readFile', result: {}, durationMs: 10 },
    { type: 'step.completed', at: 2200, taskId: task, roundId: 'r2', stepId: 's6', tool: 'fs.readFile', result: {}, durationMs: 10 }
  ];
  const entries = buildTaskConversation(base);
  const { clusters, clusterByEntry } = clusterSteps(entries);
  // s1+s2 是连续同类读文件；s3 是 search 但兼容读类，且紧邻 → 并入？search 属读类，应并入成 3 条 1 失败
  const first = clusters.find(c => c.memberKeys.some(k => k.includes('s1')));
  assert.ok(first, '应聚出一组');
  assert.equal(first.total, 3, 's1/s2/s3 三条连续读类合并');
  assert.equal(first.failed, 1, '失败数准确');
  assert.equal(clusterByEntry.get(first.memberKeys[0]), first.key);
  // 成员输出后的 s4 单条，不聚合
  assert.equal(clusterByEntry.has(entries.find(e => e.kind === 'step' && e.card.stepId === 's4')?.key ?? 'none'), false);
  // r2 的 s5+s6 聚成另一组
  const second = clusters.find(c => c.memberKeys.some(k => k.includes('s5')));
  assert.equal(second?.total, 2, '新一轮另起一组，不跨轮');

  // 原始条目一个都没少：失败步骤仍在流里，stdout/stderr 可展开
  const steps = entries.filter(e => e.kind === 'step');
  assert.equal(steps.length, 6, '聚合不改原始条目数量');
  assert.ok(steps.some(e => e.kind === 'step' && e.card.status === 'failed'));
});

function teamStep(at, result, extra = {}) {
  return {
    type: 'step.completed',
    at,
    taskId: task,
    stepId: 'team-1',
    roundId: 'r1',
    tool: 'code.team.run',
    args: { task: '改两处 proto' },
    durationMs: 120000,
    result,
    ...extra
  };
}

test('D1：code.team.run 的真实 proposals 抽成子 Agent 卡，字段来自执行本身', () => {
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    teamStep(5000, {
      task: '改两处 proto',
      proposals: [
        { agentId: 'gpt-5', role: 'explore', text: '找到 A/B 两处', durationMs: 125000, patches: [], context: [] },
        { agentId: 'claude-x', role: 'code', text: '```diff\n+ x\n```', durationMs: 130000, patches: [{ path: 'a.proto' }], context: ['探索：找到 A/B 两处'] },
        { agentId: 'deepseek-v4', role: 'verify', text: '', durationMs: 98000, failure: '超时', patches: [], context: [] }
      ]
    })
  ]);
  const agents = entries.filter(entry => entry.kind === 'agent');
  assert.equal(agents.length, 3, '三个 proposal 各一张卡');
  assert.deepEqual(agents.map(item => item.agentId), ['gpt-5', 'claude-x', 'deepseek-v4']);
  assert.equal(agents[0].role, 'explore');
  assert.equal(agents[0].task, '改两处 proto');
  assert.equal(agents[0].durationMs, 125000, '耗时取 proposal 自己的真实值');
  assert.equal(agents[0].text, '找到 A/B 两处');
  assert.equal(agents[1].patchCount, 1, '补丁数取真实 patches 长度');
  assert.equal(agents[1].context[0], '探索：找到 A/B 两处');
  assert.equal(agents[2].status, 'failed', '有 failure 的 proposal 是 failed');
  assert.equal(agents[2].error, '超时');
  assert.equal(agents[2].text, '', '没有输出就不编一句');
  assert.equal(agents[0].stepKey, entries.find(entry => entry.kind === 'step').key, '卡片回溯到真实 step');
  assert.equal(agents[0].conversationStatus, 'completed');
  assert.equal(agents[2].conversationStatus, 'failed');
});

test('D1：没有真实 proposals 就不出卡，不伪造 AgentRun', () => {
  const bad = [
    {},
    { task: 'x', proposals: 'not-an-array' },
    { task: 'x', proposals: [{ role: 'code', text: '缺 agentId' }] }
  ];
  for (const result of bad) {
    const entries = buildTaskConversation([roundStart(1000, 'r1', 1, 'user_prompt'), teamStep(5000, result)]);
    assert.equal(entries.filter(entry => entry.kind === 'agent').length, 0, `结构不对不出卡：${JSON.stringify(result)}`);
  }
  // step 还在：不出卡不等于删掉真实执行步骤。
  const entries = buildTaskConversation([teamStep(5000, {})]);
  assert.equal(entries.filter(entry => entry.kind === 'step').length, 1);
});

test('D1：WorkTask 只在 agentTaskId / assignedAgent 真实命中时关联', () => {
  const entries = buildTaskConversation([
    roundStart(1000, 'r1', 1, 'user_prompt'),
    {
      type: 'work.task.upserted', at: 2000, taskId: task, workId: 'w1',
      task: {
        workTaskId: 'wt-7', workId: 'w1', title: '改 proto', assignedAgent: 'gpt-5',
        dependencies: [], acceptanceCriteria: [], status: 'pending', complexity: 'medium',
        collaborationPolicy: { debate: 'off', review: 'auto' }, artifacts: [], evidence: [], revision: 1,
        createdAt: 2000, updatedAt: 2000
      }
    },
    teamStep(5000, {
      task: '改两处 proto',
      proposals: [
        { agentId: 'gpt-5', role: 'explore', text: 'ok', durationMs: 1000, patches: [], context: [] },
        { agentId: 'unknown-agent', role: 'code', text: 'ok', durationMs: 1000, patches: [], context: [] }
      ]
    })
  ]);
  const agents = entries.filter(entry => entry.kind === 'agent');
  assert.deepEqual(agents[0].workTask, { workTaskId: 'wt-7', title: '改 proto' }, '命中才关联');
  assert.equal(agents[1].workTask, undefined, '对不上就不写，不猜');
});

test('D1：投影可重复计算，重算两次的 agent 卡身份一致', () => {
  const events = [
    roundStart(1000, 'r1', 1, 'user_prompt'),
    teamStep(5000, {
      task: '改两处 proto',
      proposals: [{ agentId: 'gpt-5', role: 'explore', text: 'ok', durationMs: 1000, patches: [], context: [] }]
    })
  ];
  const first = buildTaskConversation(events).filter(entry => entry.kind === 'agent');
  const second = buildTaskConversation(events).filter(entry => entry.kind === 'agent');
  assert.deepEqual(first.map(item => item.id), second.map(item => item.id));
  assert.deepEqual(first.map(item => item.text), second.map(item => item.text));
});

test('D1：渲染层真的画出 AgentCard 与样式槽位', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const ui = readFileSync(join(root, 'src/renderer/src/components/engineering/TaskConversation.tsx'), 'utf8');
  const css = readFileSync(join(root, 'src/renderer/src/style.css'), 'utf8');
  assert.match(ui, /function AgentCard\(/);
  assert.match(ui, /entry\.kind === 'agent'/);
  assert.match(ui, /<AgentCard key=\{entry\.key\} entry=\{entry\} \/>/);
  // 真实输出走 MarkdownBody，和 C4 一致；失败时默认展开。
  assert.match(ui, /<MarkdownBody text=\{entry\.text\} \/>/);
  assert.match(ui, /open=\{failed\}/);
  for (const cls of ['chat-agent', 'chat-agent-pill', 'chat-agent-output', 'chat-agent-worktask']) {
    assert.match(css, new RegExp(`\\.${cls}`), `样式缺失：${cls}`);
  }
});

// ---------------- D2：并行对话浮层 ----------------

function channelMsg(at, messageId, channelId, text, extra = {}) {
  return { role: 'channel', at, messageId, conversationId: 'c1', channelId, text, ...extra };
}

test('D2：每轮各通道回答成独立 lane，新一轮追加不清空上一轮', async () => {
  const { buildParallelLanes, shouldShowParallelRail } = await import('../out-test/shared/parallel-lanes.js');
  const messages = [
    { role: 'user', at: 1000, messageId: 'u1', conversationId: 'c1', text: '第一个问题' },
    channelMsg(2000, 'm1', 'claude', '回答 A'),
    channelMsg(2100, 'm2', 'gemini', '回答 B'),
    { role: 'user', at: 3000, messageId: 'u2', conversationId: 'c1', text: '第二个问题' },
    channelMsg(4000, 'm3', 'claude', '回答 C')
  ];
  const turns = buildParallelLanes({ messages, labels: new Map([['claude', 'Claude'], ['gemini', 'Gemini']]) });
  assert.equal(turns.length, 2);
  assert.equal(turns[0].prompt, '第一个问题');
  assert.equal(turns[0].lanes.length, 2, '第一轮两路并行');
  assert.deepEqual(turns[0].lanes.map(item => item.label), ['Claude', 'Gemini']);
  assert.equal(turns[0].lanes[0].messageId, 'm1', '关联到真实主流消息');
  assert.equal(turns[1].lanes.length, 1, '第二轮单独一组，不清空第一轮');
  assert.equal(turns[1].lanes[0].text, '回答 C');
  assert.equal(shouldShowParallelRail(turns), true);
});

test('D2：没有真实回答不出线；提问名单不冒充并行对话', async () => {
  const { buildParallelLanes, shouldShowParallelRail } = await import('../out-test/shared/parallel-lanes.js');
  const turns = buildParallelLanes({
    messages: [{ role: 'user', at: 1000, messageId: 'u1', conversationId: 'c1', text: '问了' }]
  });
  assert.equal(shouldShowParallelRail(turns), false, '只有提问没有回答，浮层不出空壳');
  const empty = buildParallelLanes({ messages: [] });
  assert.equal(shouldShowParallelRail(empty), false);
});

test('D2：流式增量出输出中线；落盘后同一通道不再多一条假线', async () => {
  const { buildParallelLanes } = await import('../out-test/shared/parallel-lanes.js');
  const deltas = { claude: { text: '半句', reasoning: '', done: false } };
  const streaming = buildParallelLanes({
    messages: [{ role: 'user', at: 1000, messageId: 'u1', conversationId: 'c1', text: '问' }],
    deltas,
    live: true,
    now: 1500
  });
  const liveLane = streaming[0].lanes.find(item => item.channelId === 'claude');
  assert.equal(liveLane.status, 'streaming');
  assert.equal(liveLane.text, '半句');
  assert.equal(liveLane.messageId, null, '增量没有落盘消息 id，不伪造');

  const settled = buildParallelLanes({
    messages: [
      { role: 'user', at: 1000, messageId: 'u1', conversationId: 'c1', text: '问' },
      channelMsg(2000, 'm1', 'claude', '完整回答')
    ],
    deltas,
    live: false
  });
  const lanes = settled[0].lanes.filter(item => item.channelId === 'claude');
  assert.equal(lanes.length, 1, '落盘后只一条，增量线让位');
  assert.equal(lanes[0].status, 'answered');
});

test('D2：投影可重复计算，注入相同 now 得同样身份与时间', async () => {
  const { buildParallelLanes } = await import('../out-test/shared/parallel-lanes.js');
  const input = {
    messages: [
      { role: 'user', at: 1000, messageId: 'u1', conversationId: 'c1', text: '问' },
      channelMsg(2000, 'm1', 'claude', '答')
    ],
    deltas: { gemini: { text: '半句', reasoning: '', done: false } },
    live: true,
    now: 2500
  };
  const a = buildParallelLanes(input);
  const b = buildParallelLanes(input);
  assert.deepEqual(a, b);
  assert.equal(a[0].lanes.find(item => item.channelId === 'gemini').at, 2500);
});

test('D2：浮层接线与样式槽位真实存在', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const ui = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8');
  const rail = readFileSync(join(root, 'src/renderer/src/components/ParallelConversationRail.tsx'), 'utf8');
  const main = readFileSync(join(root, 'src/renderer/src/components/ConversationView.tsx'), 'utf8');
  const css = readFileSync(join(root, 'src/renderer/src/style.css'), 'utf8');
  assert.match(ui, /<ParallelConversationRail/);
  assert.match(ui, /onInterrupt=\{\(\) => void cancel\(\)\}/, '中断复用 App 的 cancel');
  assert.match(rail, /buildParallelLanes\(/);
  assert.match(rail, /onJump\(lane\.messageId\)/, '点条目跳主流');
  assert.match(main, /id=\{`parallel-msg-\$\{message\.messageId\}`\}/, '主流有可跳的锚点');
  for (const cls of ['parallel-rail', 'parallel-lane', 'parallel-turn-prompt']) {
    assert.match(css, new RegExp(`\\.${cls}`), `样式缺失：${cls}`);
  }
});

test('主会话按流式文档排版，不再套卡片', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const css = readFileSync(join(root, 'src/renderer/src/style.css'), 'utf8');
  assert.match(css, /主会话流式文档/);
  assert.match(css, /\.chat-feed \.chat-member,[\s\S]{0,500}border:\s*0;[\s\S]{0,200}background:\s*none;/);
  assert.match(css, /\.chat-feed \.chat-note \{ font-size: 13px/);
});

test('思考流式正文默认停在最新一行', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const ui = readFileSync(join(root, 'src/renderer/src/components/engineering/TaskConversation.tsx'), 'utf8');
  assert.match(ui, /const bodyRef = useRef<HTMLPreElement \| null>\(null\)/);
  assert.match(ui, /el\.scrollTop = live \? el\.scrollHeight : 0/);
  assert.match(ui, /ref=\{bodyRef\}/);
});

test('折叠的流式正文必须能在框内滚动，不能只靠「展开全文」', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const css = readFileSync(join(root, 'src/renderer/src/style.css'), 'utf8');
  for (const cls of ['chat-stream-body', 'chat-member-text']) {
    const block = css.match(new RegExp(`\\.${cls}\\.is-clamped\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    assert.ok(block, `缺少样式：${cls}.is-clamped`);
    assert.match(block, /overflow-y:\s*auto/, `${cls}.is-clamped 必须可纵向滚动`);
    assert.doesNotMatch(block, /-webkit-line-clamp|overflow:\s*hidden/, `${cls}.is-clamped 不能用截断隐藏`);
  }
  // 自动跟到底只应在用户本来就贴着底部时发生，否则往上翻会被流式输出拽回去。
  const ui = readFileSync(join(root, 'src/renderer/src/components/engineering/TaskConversation.tsx'), 'utf8');
  assert.match(ui, /stickRef/);
  assert.match(ui, /onScroll=\{followScroll\}/);
});
