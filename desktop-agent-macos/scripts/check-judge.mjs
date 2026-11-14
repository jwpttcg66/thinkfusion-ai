/**
 * Phase H：独立裁判。
 *
 * 最该钉住的是红线：支持人数只描述分歧形状，绝不自动变成结论；
 * 证据不足时「无法确定」是正当结果；裁判不能删少数派。
 *
 * Run with: npm run test:judge
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JudgeEngine } from '../out-test/main/judge/engine.js';
import { VerdictStore } from '../out-test/main/judge/store.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function message(agentId, text, kind = 'position', roundIndex = 0, overrides = {}) {
  return {
    messageId: `${agentId}-${kind}-${roundIndex}-${text.length}`,
    roundIndex,
    agentId,
    role: 'peer',
    kind,
    text,
    createdAt: 1,
    ...overrides
  };
}

function state(messages, minorities = []) {
  return {
    debateId: 'debate-test',
    question: '这个方案可靠吗？',
    config: { strategy: 'standard', maxRounds: 2, participants: [...new Set(messages.map(m => m.agentId))], convergenceStop: false },
    status: 'completed',
    rounds: [{
      index: 0,
      messages,
      startedAt: 1,
      endedAt: 2,
      converged: false,
      failures: []
    }],
    minorities,
    createdAt: 1,
    updatedAt: 2
  };
}

const answer = text => ({
  agentId: 'judge',
  text,
  receivedAt: Date.now(),
  attribution: { requestId: 'r', note: 'test' },
  stage: 'initial'
});

// ---------------------------------------------------------------------------

test('没有独立裁判模型时如实标 rules，不假装是模型裁决', async () => {
  const verdict = await new JudgeEngine({}).judge(state([message('a', '甲因为网络连接会断开，所以需要重试机制。')]));
  assert.equal(verdict.backend, 'rules');
  assert.equal(verdict.judgeAgentId, null);
  assert.equal(verdict.confidence.level, 'low');
  assert.match(verdict.confidence.why, /不验证外部事实/);
});

test('多个未消解立场时无法确定，结论是 null', async () => {
  const verdict = await new JudgeEngine({}).judge(state([
    message('a', '甲方案依赖持久长连接，必须用心跳保活，否则会断线。'),
    message('b', '乙方案采用无状态短连接，通过指数退避重试来保证可靠性。')
  ]));
  assert.equal(verdict.undetermined, true);
  assert.equal(verdict.conclusion, null);
  assert.match(verdict.reason, /多个未消解/);
  assert.match(verdict.disagreement, /甲方案/);
});

test('多数票不当真理：3 票对 1 票也照样无法确定', async () => {
  const verdict = await new JudgeEngine({}).judge(state([
    message('a', '根据官方文档，长连接需要心跳保活。'),
    message('b', '根据官方文档，长连接需要心跳保活。'),
    message('c', '根据官方文档，长连接需要心跳保活。'),
    message('d', '实验数据显示短连接重试更可靠，因为失败可隔离。')
  ]));
  assert.equal(verdict.undetermined, true);
  assert.equal(verdict.conclusion, null);
  // 数字还在，但只是描述，没有被当成判定依据。
  assert.equal(Math.max(...Object.values(verdict.supportCount)), 3);
});

test('单一立场且带可核查线索时给出结论，并说明依据', async () => {
  const verdict = await new JudgeEngine({}).judge(state([
    message('a', '根据官方文档与压测数据，QPS 达到 3000 时需要连接池，因为每次新建连接会超时。')
  ]));
  assert.equal(verdict.undetermined, false);
  assert.ok(verdict.conclusion);
  assert.ok(verdict.evidence[0].score >= 0.5);
  assert.ok(verdict.evidence[0].signals.some(signal => /数字|出处/.test(signal)));
});

test('只有断言、没有线索时，不给高置信度也不硬给结论', async () => {
  const verdict = await new JudgeEngine({}).judge(state([message('a', '我觉得应该这样做才比较好。')]));
  assert.equal(verdict.undetermined, true);
  assert.equal(verdict.confidence.level, 'low');
  assert.match(verdict.evidence[0].why, /只有断言/);
});

test('少数派观点原样保留，并说明为什么留着', async () => {
  const minority = message('d', '少数派认为应该保留短连接重试路径。');
  const verdict = await new JudgeEngine({}).judge(state([
    message('a', '甲方案依赖持久长连接，必须用心跳保活。'),
    message('b', '乙方案采用无状态短连接，通过重试保证可靠性。')
  ], [minority]));
  assert.equal(verdict.minorities.length, 1);
  assert.equal(verdict.minorities[0].text, minority.text);
  assert.match(verdict.minorities[0].why, /差异明显/);
});

test('未回答的疑问句进 unresolved，出处可查', async () => {
  const verdict = await new JudgeEngine({}).judge(state([
    message('a', '因为连接会断开，所以需要重试。但是如果重试导致重复写入呢？'),
    message('b', '我认为重试是安全的。')
  ]));
  assert.ok(verdict.unresolved.length > 0);
  assert.match(verdict.unresolved[0].question, /重复写入/);
  assert.equal(verdict.unresolved[0].sourceMessageIds.length, 1);
});

test('论证质量：回应过质疑的成员分数更高', async () => {
  const verdict = await new JudgeEngine({}).judge(state([
    message('a', '因为连接会断开，所以需要重试机制。'),
    message('b', '根据文档，应该保持长连接。'),
    message('a', '针对质疑，我修正为仅在网络抖动时重试。', 'revision', 1)
  ]));
  const a = verdict.argumentQuality.find(item => item.agentId === 'a');
  const b = verdict.argumentQuality.find(item => item.agentId === 'b');
  assert.equal(a.responded, true);
  assert.equal(b.responded, false);
  assert.ok(a.score > b.score);
});

test('结果关联回所有原始发言', async () => {
  const messages = [
    message('a', '甲因为连接会断开需要重试。'),
    message('b', '乙根据文档建议保持长连接。'),
    message('a', '我修正为条件重试。', 'revision', 1)
  ];
  const verdict = await new JudgeEngine({}).judge(state(messages));
  assert.deepEqual(
    [...verdict.sourceMessageIds].sort(),
    messages.map(m => m.messageId).sort()
  );
});

test('独立模型给出合法 JSON 时走 model 后端', async () => {
  const engine = new JudgeEngine({
    judgeAgentId: 'judge-model',
    ask: async () => answer('```json\n{"questionType":"CONTEXTUAL","conclusion":"采用条件重试","undetermined":false,"reason":"两边都认可重试，只是条件不同","disagreement":"重试触发条件","unresolved":[]}\n```')
  });
  const verdict = await engine.judge(state([message('a', '甲方案'), message('b', '乙方案')]));
  assert.equal(verdict.backend, 'model');
  assert.equal(verdict.judgeAgentId, 'judge-model');
  assert.equal(verdict.judgeAttempts, 1);
  assert.equal(verdict.questionType, 'CONTEXTUAL');
  assert.equal(verdict.conclusion, '采用条件重试');
  assert.equal(verdict.undetermined, false);
});

test('非法 questionType 被忽略，不影响裁决解析', async () => {
  const engine = new JudgeEngine({
    judgeAgentId: 'judge-model',
    ask: async () => answer('{"questionType":"MAYBE","conclusion":null,"undetermined":true,"reason":"证据不足","disagreement":"分歧","unresolved":[]}')
  });
  const verdict = await engine.judge(state([message('a', '甲'), message('b', '乙')]));
  assert.equal(verdict.backend, 'model');
  assert.equal(verdict.questionType, undefined);
  assert.equal(verdict.undetermined, true);
});

test('第一次输出不是 JSON 时重试一次，第二次合法就采用', async () => {
  let calls = 0;
  const engine = new JudgeEngine({
    judgeAgentId: 'judge-model',
    ask: async () => {
      calls += 1;
      return calls === 1
        ? answer('我先分析一下，双方都有道理。')
        : answer('{"conclusion":"采用条件重试","undetermined":false,"reason":"第二次只输出 JSON","disagreement":"触发条件","unresolved":[]}');
    }
  });
  const verdict = await engine.judge(state([message('a', '甲方案'), message('b', '乙方案')]));
  assert.equal(calls, 2);
  assert.equal(verdict.backend, 'model');
  assert.equal(verdict.judgeAttempts, 2);
  assert.equal(verdict.conclusion, '采用条件重试');
});

test('兼任裁判必须明确标记 sharedWith', async () => {
  const engine = new JudgeEngine({
    judgeAgentId: 'a',
    sharedWith: 'a',
    ask: async () => answer('{"conclusion":null,"undetermined":true,"reason":"证据不足","disagreement":"双方分歧","unresolved":["还需要压测吗？"]}')
  });
  const verdict = await engine.judge(state([message('a', '甲'), message('b', '乙')]));
  assert.equal(verdict.backend, 'model');
  assert.equal(verdict.sharedWith, 'a');
  assert.equal(verdict.conclusion, null);
  assert.equal(verdict.undetermined, true);
  assert.ok(verdict.unresolved.some(item => /压测/.test(item.question)));
});

test('模型输出不是 JSON 时退回规则版，并写明原因', async () => {
  const engine = new JudgeEngine({
    judgeAgentId: 'judge-model',
    ask: async () => answer('我认为两边都有道理，很难说。')
  });
  const verdict = await engine.judge(state([message('a', '甲方案'), message('b', '乙方案')]));
  assert.equal(verdict.backend, 'rules');
  assert.equal(verdict.judgeAttempts, 2);
  assert.match(verdict.fallbackReason, /不是可解析的 JSON/);
});

test('模型调用失败时退回规则版，不把失败伪装成裁决', async () => {
  const engine = new JudgeEngine({
    judgeAgentId: 'judge-model',
    ask: async () => { throw new Error('模型不可用'); }
  });
  const verdict = await engine.judge(state([message('a', '甲方案')]));
  assert.equal(verdict.backend, 'rules');
  assert.match(verdict.fallbackReason, /模型不可用/);
});

test('裁决独立落盘，重启后能读到', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-verdict-'));
  const store = new VerdictStore(dir);
  const verdict = await new JudgeEngine({}).judge(state([message('a', '甲方案')]));
  store.save(verdict);
  const reopened = new VerdictStore(dir).get('debate-test');
  assert.equal(reopened.verdictId, verdict.verdictId);
  assert.deepEqual(reopened.sourceMessageIds, verdict.sourceMessageIds);
  assert.throws(
    () => new VerdictStore(dir).save({ ...verdict, debateId: '../evil' }),
    /无效的辩论 id/
  );
  fs.rmSync(dir, { recursive: true, force: true });
  await sleep(0);
});
