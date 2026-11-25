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

test('套话 summary 不冒充结论：用 fs.list 真实结果当结论文本', () => {
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
  assert.match(conclusion.text, /目录内容：readme\.txt、src/);
  assert.match(conclusion.facts.join(' / '), /目录内容：readme\.txt、src/);
  assert.doesNotMatch(conclusion.text, /^执行完成/);
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
