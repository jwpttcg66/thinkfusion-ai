/**
 * 工程分析里「模型自己读文件」的测试（2026-11-09 用户裁决）。
 *
 * 用户原话：「读取文件，模型不是应该调用本地能力，没看到调用本地能力，输出也是
 * 糟糕的。」真机现场：附一份 md 问「这个文件有多少行」，两个本地模型都答
 * 「无法确定」，依据还是一段无关的 index.html:8——第一手只是 `generate()`，
 * 模型没有读整份文件的能力。
 *
 * 这里钉四件事：
 *
 * 1. 认请求要准——正常回答里的花括号不能被当成读文件请求；
 * 2. 真读——行数/字节按整份文件算，读出来的正文带行号；
 * 3. 范围硬——工程目录与这一问的附件之外读不到（模型不能读 ~/.ssh）；
 * 4. 链路闭合——模型请求了，宿主真读，结果被递回去，模型接着回答，且转录里
 *    看得到「调用了本机能力」。预算用完不再循环。
 * 5. 本问判定不读工程、也没附件时，不开放读文件工具——否则常识题也会去
 *    fs.list，最后答「无法确定」（真机 2026-11-10）。
 *
 * Run with: npm run test:engineering-tools
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationRunner } from '../out-test/main/conversation-runner.js';
import {
  buildToolFollowupQuestion,
  engineeringAnswerSystem,
  engineeringToolSystem
} from '../out-test/main/research/engineering-round.js';
import {
  executeReadTool,
  MAX_TOOL_ROUNDS,
  parseToolRequest
} from '../out-test/main/research/project-tools.js';
import { CAPABILITY_CATALOG } from '../out/shared/capabilities.js';

const root = mkdtempSync(join(tmpdir(), 'tf-tools-'));
const outside = mkdtempSync(join(tmpdir(), 'tf-outside-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

mkdirSync(join(root, 'src'), { recursive: true });
writeFileSync(join(root, 'log.txt'), 'record-1\nrecord-2\nrecord-3\n');
writeFileSync(join(root, 'src', 'app.ts'), 'export const a = 1;\nexport const b = 2;\n');
writeFileSync(join(outside, 'attached.md'), '# 方案\n第一行\n第二行\n');

// ---------------------------------------------------------------------------
// 1. 认请求
// ---------------------------------------------------------------------------

test('只认白名单里的读文件请求，正常回答不被误判', () => {
  assert.deepEqual(
    parseToolRequest('{"tool":"fs.stat","args":{"path":"log.txt"}}'),
    { tool: 'fs.stat', args: { path: 'log.txt' } }
  );
  // 模型爱套代码块，也要认
  assert.equal(
    parseToolRequest('```json\n{"tool":"fs.readFile","args":{"path":"log.txt","limit":10}}\n```')?.tool,
    'fs.readFile'
  );
  // 正常回答里出现的花括号不是请求（认错就会白跑一次工具、白等一轮推理）
  assert.equal(parseToolRequest('【结论】共 {3} 行，见 log.txt:1'), null);
  assert.equal(parseToolRequest('{"结论":"3 行"}'), null);
  // 不在白名单里的能力一律不认，尤其是写操作
  assert.equal(parseToolRequest('{"tool":"fs.writeFile","args":{"path":"x"}}'), null);
  assert.equal(parseToolRequest('{"tool":"shell.run","args":{"command":"rm -rf /"}}'), null);
});

// ---------------------------------------------------------------------------
// 2. 真读
// ---------------------------------------------------------------------------

test('fs.stat 报整份文件的行数与字节数', async () => {
  const result = await executeReadTool({ tool: 'fs.stat', args: { path: 'log.txt' } }, {
    root,
    extraFiles: []
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /3 行/);
  assert.match(result.text, /字节/);
  assert.match(result.text, /sha256/);
});

test('fs.readFile 带行号，且永远先报总行数', async () => {
  const result = await executeReadTool(
    { tool: 'fs.readFile', args: { path: 'log.txt', offset: 2, limit: 1 } },
    { root, extraFiles: [] }
  );
  assert.equal(result.ok, true);
  assert.match(result.text, /共 3 行/);
  assert.match(result.text, /2\trecord-2/);
  assert.doesNotMatch(result.text, /record-1/);
});

test('fs.search 与 fs.list 能用', async () => {
  const found = await executeReadTool(
    { tool: 'fs.search', args: { pattern: 'record-2' } },
    { root, extraFiles: [] }
  );
  assert.equal(found.ok, true);
  assert.match(found.text, /log\.txt:2/);

  const listed = await executeReadTool({ tool: 'fs.list', args: { path: 'src' } }, {
    root,
    extraFiles: []
  });
  assert.equal(listed.ok, true);
  assert.match(listed.text, /app\.ts/);
});

// ---------------------------------------------------------------------------
// 3. 范围
// ---------------------------------------------------------------------------

test('工程目录之外读不到，失败如实递回去而不是抛错', async () => {
  const denied = await executeReadTool(
    { tool: 'fs.readFile', args: { path: '/etc/hosts' } },
    { root, extraFiles: [] }
  );
  assert.equal(denied.ok, false);
  assert.match(denied.text, /不在工程目录/);

  // 这一问的附件可以读，哪怕它不在工程目录里
  const allowed = await executeReadTool(
    { tool: 'fs.readFile', args: { path: join(outside, 'attached.md') } },
    { root, extraFiles: [join(outside, 'attached.md')] }
  );
  assert.equal(allowed.ok, true);
  assert.match(allowed.text, /共 3 行/);
});

// ---------------------------------------------------------------------------
// 4. 链路
// ---------------------------------------------------------------------------

function fakeStore() {
  const conversations = new Map();
  const messages = [];
  return {
    listConversations: () => [...conversations.values()],
    getConversation: id => conversations.get(id) ?? null,
    listMessages: id => messages.filter(message => message.conversationId === id),
    upsertConversation: conversation => conversations.set(conversation.conversationId, conversation),
    appendMessage: message => messages.push(message),
    deleteConversation: () => {}
  };
}

function fakeRegistry() {
  return {
    all: async () => [],
    available: async () => [],
    list: () => [],
    get: () => undefined,
    ask: async () => { throw new Error('这一组用例不该问网页'); },
    newConversation: async () => ({ ok: true }),
    deleteConversation: async () => ({ ok: true }),
    cancel() {},
    cancelAll() {}
  };
}

function makeRunner(scripted, hooks = {}) {
  const asks = [];
  const notes = [];
  const model = {
    id: 'local:r1',
    label: 'Ollama（本地）· r1',
    kind: 'local',
    identity: { id: 'local:r1', label: 'r1', kind: 'provider', role: 'local' },
    async health() {
      return { id: 'local:r1', label: 'r1', available: true };
    },
    async ask(input) {
      asks.push(input);
      const index = asks.length - 1;
      return {
        agentId: 'local:r1',
        channelId: 'local:r1',
        stage: input.stage,
        // 注意别写成 scripted(Math.min(index, scripted.length - 1))：箭头函数的
        // length 是形参个数（恒为 1），那样每次都会回同一条脚本。
        text: scripted(index, input),
        receivedAt: Date.now()
      };
    },
    cancel() {}
  };
  const runner = new ConversationRunner({
    store: fakeStore(),
    registry: fakeRegistry(),
    emit: event => {
      if (event.type === 'conversation.message' && event.message?.role === 'system') {
        notes.push(event.message.text);
      }
    },
    submitWorkspace: async () => { throw new Error('unexpected hand-off'); },
    poolFor: (_config, pool) => ({
      all: () => pool.all(),
      available: () => pool.available(),
      get: id => (id === model.id ? model : pool.get(id)),
      ask: (id, input) => (id === model.id ? model.ask(input) : pool.ask(id, input)),
      newConversation: async () => ({ ok: true }),
      deleteConversation: async () => ({ ok: true }),
      cancel() {},
      cancelAll() {}
    }),
    executorIdsFor: () => new Set([model.id]),
    modelMembers: async () => [
      { agentId: model.id, label: model.label, kind: 'local', available: true }
    ],
    agentSource: () => 'local',
    budgetMs: 8000,
    ...(hooks.routeWithModel ? { routeWithModel: hooks.routeWithModel } : {}),
    ...(hooks.expertiseFor ? { expertiseFor: hooks.expertiseFor } : {})
  });
  return { runner, asks, notes };
}

async function settle(runner, conversationId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const conversation = runner.get(conversationId);
    if (conversation && ['answered', 'failed', 'cancelled'].includes(conversation.status)) return conversation;
    if (Date.now() > deadline) throw new Error(`没有收敛：${conversation?.status}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('模型请求读文件时，宿主真读并把结果递回去，转录里看得到', async () => {
  const { runner, asks } = makeRunner(index =>
    index === 0
      ? '{"tool":"fs.stat","args":{"path":"log.txt"}}'
      : '依据 fs.stat 的结果，log.txt 共 3 行，也就是 3 条记录。'
  );
  const started = await runner.start({
    text: '工程里的 log.txt 有多少条记录',
    workspaceMode: 'engineering',
    workspaceRoot: root,
    taskKindOverride: 'analysis',
    executionConfig: { executionMode: 'local' }
  });
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered');
  const firstHand = asks.filter(input => input.stage === 'initial');
  assert.ok(firstHand.length >= 2, `应该问两次（先请求、后回答），实际 ${String(firstHand.length)} 次`);
  assert.match(firstHand[1].question, /读取结果/);
  assert.match(firstHand[1].question, /3 行/, '读到的行数要进第二问');

  const messages = runner.messages(started.conversationId);
  assert.ok(
    messages.some(message => /调用了本机能力：fs\.stat log\.txt/.test(message.text ?? '')),
    '用户要看到真的调了本地能力'
  );
  const answer = messages
    .filter(message => message.role === 'channel')
    .map(message => message.text)
    .join('\n');
  assert.match(answer, /3 行/);
});

test('预算用完不再循环：一直请求也只按 MAX_TOOL_ROUNDS 轮', async () => {
  const { runner, asks } = makeRunner(() => '{"tool":"fs.readFile","args":{"path":"log.txt"}}');
  const started = await runner.start({
    text: '工程里的 log.txt 有多少条记录',
    workspaceMode: 'engineering',
    workspaceRoot: root,
    taskKindOverride: 'analysis',
    executionConfig: { executionMode: 'local' }
  });
  await settle(runner, started.conversationId);
  assert.equal(asks.filter(input => input.stage === 'initial').length, MAX_TOOL_ROUNDS + 1);
  const report = runner.messages(started.conversationId)
    .filter(message => message.role === 'channel')
    .map(message => message.text)
    .join('\n');
  assert.match(report, /Agentic Search 报告/);
  assert.match(report, /终止原因/);
  assert.match(report, /已取得的证据|未取得有效证据/);
});

test('模型正常回答时一次都不多问', async () => {
  const { runner, asks } = makeRunner(() => '依据证据，log.txt 共 3 行。');
  const started = await runner.start({
    text: '工程里的 log.txt 有多少行',
    workspaceMode: 'engineering',
    workspaceRoot: root,
    taskKindOverride: 'analysis',
    executionConfig: { executionMode: 'local' }
  });
  await settle(runner, started.conversationId);
  assert.equal(asks.filter(input => input.stage === 'initial').length, 1);
});

test('选「本次按分析」的常识题也不扫工程、不开放读文件——真机 java vs go', async () => {
  // 真机 2026-11-10：override 跳过模型判定后旧默认仍读 Downloads，再开放工具去 fs.search；
  // 即便不读了，常驻专家仍写「证据不足就无法确定」，hy4 会答成汇总腔。
  let expertiseCalls = 0;
  const { runner, asks } = makeRunner(() => '{"tool":"fs.search","args":{"pattern":"java|go"}}', {
    expertiseFor: () => {
      expertiseCalls += 1;
      return {
        system: [
          '工程证据纪律永远排在本专家的一切工作习惯之前',
          '证据不足就写「无法确定」，不用常识补'
        ],
        note: '',
        loaded: ['senior-developer']
      };
    }
  });
  const started = await runner.start({
    text: 'java和go谁更适合做游戏服务器',
    workspaceMode: 'engineering',
    workspaceRoot: root,
    taskKindOverride: 'analysis',
    executionConfig: { executionMode: 'local' }
  });
  const done = await settle(runner, started.conversationId);
  assert.equal(done.status, 'answered');
  const systemTexts = runner
    .messages(started.conversationId)
    .filter(message => message.role === 'system')
    .map(message => message.text ?? '');
  assert.equal(started.engineeringEvidence?.length ?? 0, 0, '常识题不该落工程证据');
  assert.equal(asks.filter(input => input.stage === 'initial').length, 1);
  assert.equal(expertiseCalls, 0, '无工程证据时根本不该去加载专家/技能');
  const firstSystem = (asks[0].system ?? []).join('\n');
  assert.equal(firstSystem, '', '常识题第一手不带 system');
  assert.equal(asks[0].question, 'java和go谁更适合做游戏服务器', '问题原话直送，不套【用户的问题】');
  assert.ok(!systemTexts.some(text => /调用了本机能力/.test(text)));
  assert.ok(!systemTexts.some(text => /已读取工程目录/.test(text)));
  assert.ok(!systemTexts.some(text => /没有读取工程目录/.test(text)), '决定进轨迹，不贴系统消息');
});

test('本问不读工程、无附件时不开放读文件工具，模型回 JSON 也不执行', async () => {
  const { runner, asks } = makeRunner(
    () => '{"tool":"fs.list","args":{"path":"."}}',
    {
      routeWithModel: async () => ({
        kind: 'analysis',
        reason: '选型比较，不必看工程',
        readsProject: false
      })
    }
  );
  // 带「分析」避免规则 clarify；不传 override，才能走到 routeWithModel 的 readsProject=false。
  const started = await runner.start({
    text: '分析 java 和 go 谁更适合做游戏服务器',
    workspaceMode: 'engineering',
    workspaceRoot: root,
    executionConfig: { executionMode: 'local' }
  });
  const done = await settle(runner, started.conversationId);
  assert.equal(done.status, 'answered');
  const systemTexts = runner
    .messages(started.conversationId)
    .filter(message => message.role === 'system')
    .map(message => message.text ?? '');
  assert.equal(started.engineeringEvidence?.length ?? 0, 0, '应跳过工程扫描');
  assert.equal(
    asks.filter(input => input.stage === 'initial').length,
    1,
    '没有工具跟进轮'
  );
  const first = asks.find(input => input.stage === 'initial');
  assert.ok(first);
  assert.ok(
    !(first.system ?? []).join('\n').includes('你可以自己读文件'),
    'system 不该教模型去读文件'
  );
  assert.ok(
    !systemTexts.some(text => /调用了本机能力/.test(text)),
    '宿主不该执行 fs.list'
  );
  assert.ok(
    !systemTexts.some(text => /没有读取工程目录/.test(text)),
    '决定进轨迹，不贴系统消息'
  );
});

// ---------------------------------------------------------------------------
// 5. 提示词与能力清单
// ---------------------------------------------------------------------------

test('system 教模型可以自己读，且写明只读与一次上限', () => {
  const system = engineeringToolSystem().join('\n');
  assert.match(system, /fs\.readFile/);
  assert.match(system, /只能读工程目录/);
  assert.match(system, /不能写/);
});

test('附了文件时 system 必须说明附件也算依据', () => {
  const withAttachment = engineeringAnswerSystem({ attachments: 1 }).join('\n');
  assert.match(withAttachment, /附件/);
  assert.match(withAttachment, /优先于任何推测/);
  // 没附件时不多说，老的三条不变
  assert.equal(engineeringAnswerSystem().length, 3);
});

test('第二问把原证据、能力调用、读取结果拼在一起', () => {
  const question = buildToolFollowupQuestion(
    '【用户的问题】\nlog.txt 有多少行\n\n【工程证据】\n[证据1] log.txt:1',
    'fs.stat log.txt',
    'log.txt：60 字节，3 行'
  );
  assert.match(question, /【用户的问题】/);
  assert.match(question, /【工程证据】/);
  assert.match(question, /fs\.stat log\.txt/);
  assert.match(question, /3 行/);
  assert.match(question, /可以再输出一次工具请求/);
});

test('project.read 已登记进能力清单（插件化，不散装实现）', () => {
  const meta = CAPABILITY_CATALOG.find(item => item.id === 'project.read');
  assert.ok(meta, 'project.read 必须在 CAPABILITY_CATALOG 里');
  assert.equal(meta.host, 'main');
  assert.equal(meta.permission, 'read-only');
  assert.equal(meta.enabledByDefault, true);
});
