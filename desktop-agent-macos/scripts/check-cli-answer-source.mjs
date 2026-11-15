/**
 * 三类回答源：网页 / 模型 / CLI（2026-11-15 用户裁决）。
 *
 * 这里只钉住「跟网页源同一层级」这件事：
 * - 网页主导 / 混合：CLI 与网页一起进第一轮；
 * - 本地 / 云端主导：不问网页，也不问 CLI（归属规则不变）；
 * - 第一轮只放「此刻可用」的 CLI，关掉的如实写进 blocked；
 * - 送进去的是用户原话，不夹角色行；不传权限参数、不在工程目录里跑；
 * - 失败翻译成 CLI 错误分类，不糊一整段 stderr。
 *
 * Run with: npm run test:cli-answer
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { selectParticipants } from '../out-test/main/execution/policy.js';
import { normalizeExecutionConfig } from '../out-test/shared/conversation.js';
import { planLead } from '../out-test/main/debate/lead.js';
import { ExecutionPool } from '../out-test/main/execution/execution-pool.js';
import { CliAnswerAgent, runCliAnswer, cancelCliAnswer } from '../out-test/main/execution/cli-answer-agent.js';

const QUESTION = '这个项目 0.2.7 的 CLI 会不会被当成回答源？';

function pageAgent(id) {
  return {
    id,
    label: id,
    identity: { id, label: id, kind: 'provider', role: 'web' },
    health: async () => ({ id, label: id, available: true, loggedIn: true, pageReady: true, generating: false }),
    ask: async task => ({
      agentId: id,
      text: 'web 回答',
      receivedAt: Date.now(),
      attribution: { requestId: 'r', note: 'web' },
      stage: task.stage
    }),
    cancel: () => {}
  };
}

function cliAgent(id, available = true) {
  return {
    id: `cli:${id}`,
    label: `${id} CLI`,
    sourceType: 'cli',
    identity: { id: `cli:${id}`, label: `${id} CLI`, kind: 'provider', role: 'CLI 软件源' },
    health: async () => ({
      id: `cli:${id}`,
      label: `${id} CLI`,
      sourceType: 'cli',
      available,
      loggedIn: available,
      pageReady: available,
      generating: false,
      ...(available ? {} : { detail: '已在设置里关闭' })
    }),
    ask: async task => ({
      agentId: `cli:${id}`,
      text: `CLI 回答：${task.question}`,
      receivedAt: Date.now(),
      attribution: { requestId: 'r', note: `cli:${id}` },
      stage: task.stage
    }),
    cancel: () => {}
  };
}

const web = [pageAgent('deepseek'), pageAgent('chatgpt')];
const cli = [cliAgent('qoder'), cliAgent('claude')];

// ---------------------------------------------------------------------------

test('网页主导：CLI 跟网页一起进第一轮，也进执行名单（可主导 / 可辩）', () => {
  const selection = selectParticipants({ executionMode: 'web' }, web, [], cli);
  const answers = [...selection.answerIds].sort();
  assert.deepEqual(answers, ['chatgpt', 'cli:claude', 'cli:qoder', 'deepseek']);
  // 2026-11-15 裁决：CLI 属云端一类，可以主导、辩论、执行——执行名单里要有它。
  assert.deepEqual([...selection.executorIds].sort(), ['cli:claude', 'cli:qoder']);
  assert.match(selection.reason, /CLI 2 个/);
});

test('云端主导：CLI 也属这一类，照常被问；本地主导仍不问', () => {
  const cloudMode = selectParticipants(
    { executionMode: 'cloud', selectedCloudModels: [] },
    web, [], cli
  );
  assert.deepEqual([...cloudMode.answerIds].sort(), ['cli:claude', 'cli:qoder']);
  assert.match(cloudMode.reason, /云端 0 个 \+ CLI 2 个/);
  assert.ok(cloudMode.blocked.some(item => item.id === 'chatgpt' && /不问网页/.test(item.why)));

  const cloudPicked = selectParticipants(
    { executionMode: 'cloud', selectedCloudModels: [], selectedCliAgents: ['cli:qoder'] },
    web, [], cli
  );
  assert.deepEqual([...cloudPicked.answerIds].sort(), ['cli:qoder']);
  assert.ok(cloudPicked.blocked.some(item => item.id === 'cli:claude' && /没有在这一轮被选中/.test(item.why)));

  const localMode = selectParticipants({ executionMode: 'local' }, web, [], cli);
  assert.equal([...localMode.answerIds].filter(id => id.startsWith('cli:')).length, 0);
  assert.ok(localMode.blocked.some(item => item.id === 'cli:qoder' && /本地主导只用本地模型/.test(item.why)));
});

test('混合：同样问 CLI；CLI 不看 selectedWebChannels（那是站点名单）', () => {
  const selection = selectParticipants(
    { executionMode: 'hybrid', selectedWebChannels: ['chatgpt'] },
    web,
    [],
    cli
  );
  const answers = [...selection.answerIds].sort();
  assert.deepEqual(answers, ['chatgpt', 'cli:claude', 'cli:qoder']);
});

test('selectedCliAgents：undefined = 开着的全部，[] = 一个都不问，非空 = 只勾的', () => {
  const all = selectParticipants({ executionMode: 'web' }, web, [], cli);
  assert.equal([...all.answerIds].filter(id => id.startsWith('cli:')).length, 2);

  const none = selectParticipants({ executionMode: 'web', selectedCliAgents: [] }, web, [], cli);
  assert.equal([...none.answerIds].filter(id => id.startsWith('cli:')).length, 0);
  assert.ok(none.blocked.some(item => item.id === 'cli:qoder' && /没有在这一轮被选中/.test(item.why)));
  assert.match(none.reason, /CLI 0 个/);

  const only = selectParticipants(
    { executionMode: 'web', selectedCliAgents: ['cli:qoder'] },
    web, [], cli
  );
  assert.deepEqual([...only.answerIds].filter(id => id.startsWith('cli:')), ['cli:qoder']);
  assert.match(only.reason, /CLI 1 个/);

  // 名单里的陈旧 id（CLI 已删）无害：直接忽略，不连带挡掉别人。
  const stale = selectParticipants(
    { executionMode: 'web', selectedCliAgents: ['cli:gone', 'cli:claude'] },
    web, [], cli
  );
  assert.deepEqual([...stale.answerIds].filter(id => id.startsWith('cli:')), ['cli:claude']);
});

test('normalize 保留 selectedCliAgents 的三态：空数组留下，缺失是 undefined', () => {
  // 空对象 = 老会话缺字段：不能擅自填 []，否则「缺省 = 开着的全部」被抹掉。
  assert.equal('selectedCliAgents' in normalizeExecutionConfig({}), false);
  assert.deepEqual(normalizeExecutionConfig({ selectedCliAgents: [] }).selectedCliAgents, []);
  assert.deepEqual(
    normalizeExecutionConfig({ selectedCliAgents: ['cli:qoder', 3, null] }).selectedCliAgents,
    ['cli:qoder']
  );
  assert.equal('selectedCliAgents' in normalizeExecutionConfig({ selectedCliAgents: 'nope' }), false);
});

test('本地主导不问 CLI：CLI 属云端一类，不过本地那一场', () => {
  const selection = selectParticipants({ executionMode: 'local' }, web, [], cli);
  assert.equal([...selection.answerIds].filter(id => id.startsWith('cli:')).length, 0);
  const blocked = selection.blocked.filter(item => item.id.startsWith('cli:'));
  assert.equal(blocked.length, 2, '本地主导要把两个 CLI 都标成未问');
  assert.match(blocked[0].why, /本地主导只用本地模型/);
});

test('第一轮只放可用的 CLI：关掉的那一个进 blocked 之外，由 available() 筛掉', async () => {
  const base = {
    list: () => web,
    all: async () => web,
    available: async () => web,
    ask: async (id, task) => web.find(agent => agent.id === id).ask(task),
    newConversation: async () => ({ ok: true }),
    deleteConversation: async () => ({ ok: true }),
    cancel: () => {}
  };
  const onlyQoder = [cliAgent('qoder', true), cliAgent('claude', false)];
  const selection = selectParticipants({ executionMode: 'web' }, web, [], onlyQoder);
  const pool = new ExecutionPool(base, [], selection.answerIds, selection.executorIds, onlyQoder);

  const available = await pool.available();
  assert.deepEqual(available.map(agent => agent.id), ['deepseek', 'chatgpt', 'cli:qoder']);

  // 所有成员（含不可用）都在 all() 里，MasterAgent 才能报出「为什么没问它」。
  const all = await pool.all();
  assert.equal(all.filter(agent => agent.id.startsWith('cli:')).length, 2);
});

test('送进 CLI 的是用户原话，逐字，不加角色行', async () => {
  const seen = [];
  const agent = {
    ...cliAgent('qoder'),
    ask: async task => {
      seen.push(task.question);
      return {
        agentId: 'cli:qoder',
        text: 'ok',
        receivedAt: Date.now(),
        attribution: { requestId: 'r', note: 'cli:qoder' },
        stage: task.stage
      };
    }
  };
  const base = {
    list: () => web,
    all: async () => web,
    available: async () => web,
    ask: async () => {
      throw new Error('不该问网页');
    },
    newConversation: async () => ({ ok: true }),
    deleteConversation: async () => ({ ok: true }),
    cancel: () => {}
  };
  const pool = new ExecutionPool(base, [], new Set(['cli:qoder']), new Set(), [agent]);
  const answer = await pool.ask('cli:qoder', { question: QUESTION, stage: 'answer' });
  assert.deepEqual(seen, [QUESTION]);
  assert.equal(answer.text, 'ok');
  assert.equal(answer.attribution.note, 'cli:qoder');
});

test('直接辩论：CLI 按云端一类进名单，可当主辩；网页主导只用网页', () => {
  const candidates = [
    { id: 'chatgpt', label: 'ChatGPT', type: 'web', available: true },
    { id: 'cli:qoder', label: 'Qoder CLI', type: 'cloud', available: true, cli: true }
  ];
  const plan = planLead({
    mode: 'cloud',
    strategy: 'truth',
    candidates,
    selected: ['cli:qoder'],
    leadAgentId: 'cli:qoder'
  });
  assert.deepEqual(plan.participants, ['cli:qoder']);
  assert.equal(plan.lead.agentId, 'cli:qoder', '点名 CLI 当主辩要生效');

  const webPlan = planLead({
    mode: 'web',
    strategy: 'truth',
    candidates,
    selected: ['chatgpt', 'cli:qoder']
  });
  assert.deepEqual(webPlan.participants, ['chatgpt'], '网页主导只用网页通道');
  assert.ok(webPlan.excluded.some(item => item.id === 'cli:qoder' && /网页主导/.test(item.reason)));
});

test('CliAnswerAgent：辩论材料随提示下发，第一轮仍是原话', async () => {
  const seen = [];
  const agent = new CliAnswerAgent('qoder', {
    view: () => ({ id: 'qoder', label: 'Qoder CLI', available: true }),
    run: async ({ task }) => {
      seen.push(task);
      return {
        text: 'ok',
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        durationMs: 1,
        stderrTail: '',
        cliVersion: '1.0.0',
        errorClassification: null
      };
    },
    cancel: () => false
  });
  await agent.ask({ question: QUESTION, stage: 'answer' });
  assert.deepEqual(seen, [QUESTION], '第一轮不能加料，原话逐字');
  await agent.ask({
    question: '请就以下分歧表态',
    stage: 'challenge',
    system: ['你是正方'],
    context: ['对方说 X']
  });
  assert.equal(seen[1].includes('你是正方'), true, '辩手角色要发过去');
  assert.equal(seen[1].includes('对方说 X'), true, '对方的回答要发过去');
  assert.ok(seen[1].endsWith('请就以下分歧表态'), '问题在最后');
});

test('CliAnswerAgent：可用性取注册表，关闭时给出原因', async () => {
  const closed = {
    id: 'claude',
    label: 'Claude CLI',
    command: 'claude',
    args: ['-p', '{task}'],
    headless: 'verified',
    enabled: false,
    detected: true,
    executable: '/usr/local/bin/claude',
    version: '2.1.325',
    available: false,
    reason: '已在设置里关闭'
  };
  const agent = new CliAnswerAgent('claude', {
    view: () => closed,
    run: async () => {
      throw new Error('不该跑');
    },
    cancel: () => false
  });
  const health = await agent.health();
  assert.equal(health.sourceType, 'cli');
  assert.equal(health.available, false);
  assert.equal(health.detail, '已在设置里关闭');
  assert.equal(agent.sourceType, 'cli');
});

test('CliAnswerAgent：失败按 CLI 错误分类说，不糊 stderr', async () => {
  const agent = new CliAnswerAgent('claude', {
    view: () => ({ id: 'claude', label: 'Claude CLI', available: true }),
    run: async () => ({
      text: '',
      exitCode: 1,
      timedOut: false,
      cancelled: false,
      durationMs: 12,
      stderrTail: 'some noise\n429 Too Many Requests',
      cliVersion: '2.1.325',
      errorClassification: { kind: 'RATE_LIMITED', source: 'structured', confidence: 'high', evidence: 'subtype=error' }
    }),
    cancel: () => false
  });
  await assert.rejects(
    () => agent.ask({ question: QUESTION, stage: 'answer' }),
    /RATE_LIMITED（subtype=error）/
  );
});

test('真实 spawn：不带权限参数、问题作为单个 argv、不在工程目录里跑', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cli-answer-'));
  const script = path.join(dir, 'fake-cli.mjs');
  fs.writeFileSync(
    script,
    [
      'const args = process.argv.slice(2);',
      'process.stdout.write(JSON.stringify({ result: `${args.join("\\u0001")}|cwd=${process.cwd()}` }));'
    ].join('\n'),
    'utf8'
  );
  const config = {
    id: 'fake',
    label: 'Fake CLI',
    command: process.execPath,
    // 权限参数故意配着：回答这条链决不能用它。
    args: [script, '-p', '{task}', '--output-format', 'json'],
    permissionArgs: ['--permission-mode', 'accept_edits'],
    headless: 'verified',
    enabled: true,
    version: '1.0.0'
  };
  const outcome = await runCliAnswer(config, { task: QUESTION, requestId: 'test-answer-1' });
  const [sent, cwdPart] = outcome.text.split('|cwd=');
  assert.deepEqual(sent.split('\u0001'), ['-p', QUESTION, '--output-format', 'json']);
  assert.ok(!sent.includes('accept_edits'), '回答链不能带权限参数');
  assert.ok(!outcome.text.includes(process.cwd()), '回答不在工程目录里跑');
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.errorClassification, null);
  assert.equal(cwdPart.length > 0, true);
  assert.equal(cancelCliAnswer('不存在的请求'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
