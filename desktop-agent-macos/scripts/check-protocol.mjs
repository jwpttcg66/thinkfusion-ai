/**
 * Behavioural tests for the desktop-agent/v1 protocol parser.
 *
 * Runs against the compiled output (out/shared/protocol.js), so it tests the
 * same code the main process uses. No Electron, no DeepSeek page needed.
 *
 *   npm run build:agent && node scripts/check-protocol.mjs
 */
import assert from 'node:assert/strict';
import { parseAnswer, buildInitialPrompt, buildReportPrompt } from '../out/shared/protocol.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
    process.exitCode = 1;
  }
}

const TASK = 'task-abc';
const ROUND = 'round-123';

function plan(overrides = {}) {
  return {
    protocol: 'desktop-agent/v1',
    type: 'plan',
    taskId: TASK,
    roundId: ROUND,
    title: '检查项目结构',
    description: '读取目录并生成报告',
    steps: [
      { id: 'step-1', tool: 'fs.list', args: { path: '.' } },
      { id: 'step-2', tool: 'fs.writeFile', args: { path: 'reports/a.md', content: '# report' } }
    ],
    completion: { condition: '报告已生成' },
    ...overrides
  };
}

const fenced = value => '这是计划：\n```json\n' + JSON.stringify(value, null, 2) + '\n```\n请确认。';

console.log('protocol parser');

test('valid plan is accepted', () => {
  const result = parseAnswer(fenced(plan()), { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'plan');
  assert.equal(result.plan.steps.length, 2);
});

test('prose without a protocol block yields none', () => {
  const result = parseAnswer('我先解释一下思路，稍后再给计划。', { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'none');
});

test('json without protocol field is ignored, not executed', () => {
  const result = parseAnswer('```json\n{"hello":"world"}\n```', { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'none');
});

test('missing protocol is rejected', () => {
  const result = parseAnswer(fenced({ ...plan(), protocol: 'other/v9' }), { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'none');
});

test('unknown type is rejected', () => {
  const result = parseAnswer(fenced({ ...plan(), type: 'shell' }), { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'invalid');
});

test('taskId mismatch is rejected', () => {
  const result = parseAnswer(fenced(plan({ taskId: 'someone-else' })), { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'invalid');
  assert.match(result.error, /taskId/);
});

test('roundId mismatch is rejected', () => {
  const result = parseAnswer(fenced(plan({ roundId: 'round-old' })), { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'invalid');
  assert.match(result.error, /roundId/);
});

test('duplicate step ids are rejected', () => {
  const result = parseAnswer(
    fenced(plan({ steps: [{ id: 'x', tool: 'fs.list', args: { path: '.' } }, { id: 'x', tool: 'fs.list', args: { path: '.' } }] })),
    { taskId: TASK, roundId: ROUND }
  );
  assert.equal(result.kind, 'invalid');
});

test('unknown tool is rejected', () => {
  const result = parseAnswer(fenced(plan({ steps: [{ id: 's', tool: 'process.exec', args: { cmd: 'rm -rf /' } }] })), {
    taskId: TASK,
    roundId: ROUND
  });
  assert.equal(result.kind, 'invalid');
});

test('wrong argument type is rejected', () => {
  const result = parseAnswer(fenced(plan({ steps: [{ id: 's', tool: 'fs.readFile', args: { path: 42 } }] })), {
    taskId: TASK,
    roundId: ROUND
  });
  assert.equal(result.kind, 'invalid');
});

test('more than 30 steps is rejected', () => {
  const steps = Array.from({ length: 31 }, (_, i) => ({ id: `s${i}`, tool: 'fs.list', args: { path: '.' } }));
  const result = parseAnswer(fenced(plan({ steps })), { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'invalid');
});

test('two conflicting plans are rejected', () => {
  const text = `${fenced(plan())}\n\n另一个方案：\n${fenced(plan({ title: '另一个方案' }))}`;
  const result = parseAnswer(text, { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'conflict');
});

test('identical duplicate blocks are tolerated', () => {
  const text = `${fenced(plan())}\n\n${fenced(plan())}`;
  const result = parseAnswer(text, { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'plan');
});

test('clarification request is parsed', () => {
  const text = fenced({
    protocol: 'desktop-agent/v1',
    type: 'clarification_required',
    taskId: TASK,
    roundId: ROUND,
    questions: ['是否允许创建 reports 目录？']
  });
  const result = parseAnswer(text, { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'clarification');
  assert.equal(result.questions.length, 1);
});

test('task_complete is parsed', () => {
  const text = fenced({
    protocol: 'desktop-agent/v1',
    type: 'task_complete',
    taskId: TASK,
    roundId: ROUND,
    summary: '报告已生成'
  });
  const result = parseAnswer(text, { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'complete');
  assert.equal(result.summary, '报告已生成');
});

test('legacy <AGENT_PLAN> wrapper still works', () => {
  const text = `<AGENT_PLAN>${JSON.stringify(plan())}</AGENT_PLAN>`;
  const result = parseAnswer(text, { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'plan');
});

console.log('prompt templates');

test('initial prompt carries ids, tools and workspace', () => {
  const prompt = buildInitialPrompt({
    prompt: '分析项目',
    taskId: TASK,
    roundId: ROUND,
    permissionPreset: 'workspace-write',
    workspaceRoot: '/tmp/ws',
    allowedTools: ['fs.list'],
    maxSteps: 30
  });
  assert.match(prompt, /task-abc/);
  assert.match(prompt, /round-123/);
  assert.match(prompt, /fs\.writeFile/);
  assert.match(prompt, /\/tmp\/ws/);
  // The runtime only accepts paths relative to the workspace, and the prompt is
  // the only place the model can learn that. When it was unstated, DeepSeek
  // prefixed the workspace root itself and burned a whole round on a rejected
  // step before trying again with ".".
  assert.match(prompt, /相对路径/);
  assert.match(prompt, /不要写绝对路径/);
  assert.match(prompt, /基准目录/);
});

test('report prompt embeds the structured report', () => {
  const prompt = buildReportPrompt({
    taskId: TASK,
    roundId: ROUND,
    report: {
      protocol: 'desktop-agent/v1',
      type: 'execution_report',
      taskId: TASK,
      roundId: 'round-0',
      planId: 'plan-1',
      status: 'completed',
      results: [{ stepId: 's1', tool: 'fs.list', status: 'completed', verified: true, durationMs: 3 }],
      errors: [],
      nextAction: 'continue',
      createdAt: 1
    }
  });
  assert.match(prompt, /execution_report/);
  assert.match(prompt, /"verified": true/);
});

// ---------------------------------------------------------------------------
// Rendered-page shapes
//
// The answer arrives as *displayed* markdown, so the fences never reach
// innerText and the JSON body is all that is left. These cases come from a real
// captured answer, not from imagination.
// ---------------------------------------------------------------------------

test('a code block whose fences are gone still parses', () => {
  // Exactly what .ds-markdown.innerText yields: the block toolbar labels, then
  // the JSON with no ``` markers anywhere.
  const rendered = `json
复制
下载
{
  "protocol": "desktop-agent/v1",
  "type": "task_complete",
  "taskId": "${TASK}",
  "roundId": "${ROUND}",
  "summary": "不需要文件系统操作"
}`;
  const result = parseAnswer(rendered, { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'complete');
  assert.match(result.summary, /不需要/);
});

test('a plan whose strings contain raw newlines still parses', () => {
  // Models emit literal newlines inside JSON strings; JSON.parse rejects that,
  // and rejecting the plan would strand the task on a fixable mistake.
  const broken = `{
  "protocol": "desktop-agent/v1",
  "type": "plan",
  "taskId": "${TASK}",
  "roundId": "${ROUND}",
  "title": "整理",
  "description": "第一行
第二行",
  "steps": [{ "id": "s1", "tool": "fs.list", "description": "列目录", "args": { "path": "." } }],
  "completion": { "condition": "完成" }
}`;
  const result = parseAnswer(broken, { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'plan');
  assert.match(result.plan.description, /第一行\n第二行/);
});

test('a trailing comma does not invalidate the plan', () => {
  const broken = `{
  "protocol": "desktop-agent/v1",
  "type": "task_complete",
  "taskId": "${TASK}",
  "roundId": "${ROUND}",
  "summary": "好了",
}`;
  assert.equal(parseAnswer(broken, { taskId: TASK, roundId: ROUND }).kind, 'complete');
});

test('braces inside a string do not truncate the object', () => {
  const tricky = `{
  "protocol": "desktop-agent/v1",
  "type": "task_complete",
  "taskId": "${TASK}",
  "roundId": "${ROUND}",
  "summary": "写入 {a: 1} 这样的片段"
}`;
  const result = parseAnswer(tricky, { taskId: TASK, roundId: ROUND });
  assert.equal(result.kind, 'complete');
  assert.match(result.summary, /\{a: 1\}/);
});

test('prose containing braces is not mistaken for a protocol message', () => {
  const prose = '我认为 {这} 不是一个计划，也没有 {JSON}。';
  assert.equal(parseAnswer(prose, { taskId: TASK, roundId: ROUND }).kind, 'none');
});

test('a protocol block that cannot be parsed reports why', () => {
  const broken = '{ "protocol": "desktop-agent/v1", "type": "plan", }';
  const result = parseAnswer(broken, { taskId: TASK, roundId: ROUND });
  // Either it is repaired into a rejected plan or it reports a parse failure;
  // silence would be the one unacceptable outcome.
  assert.notEqual(result.kind, 'none');
});

console.log('');
if (process.exitCode) {
  console.error(`Protocol tests failed.`);
} else {
  console.log(`All ${passed} protocol tests passed.`);
}
