/**
 * Prompt 模板版本化（任务书 §12）。
 *
 * 这一组用例守的是「重构不许悄悄改文案」：
 *
 * 1. 七个模板都登记了输入 / 输出 / 禁止事项 / 引用要求 / 失败处理；
 * 2. `renderInstructions` 的三种轮次输出逐字等于搬迁前的文本（快照）；
 * 3. 版本号写进每场辩论的状态文件，读盘回来一致；
 * 4. 老文件没有 `promptVersion`，不补一个当前版本冒充记录过；
 * 5. **网页成员第一轮只收用户原话**——按归属规则，网页主导的后续交锋把
 *    材料拼进同一条用户消息，仍然不收 system / context，也不调用本地模型。
 *
 * Run with: npm run test:debate-prompts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PROMPT_TEMPLATES,
  PROMPT_VERSION,
  promptTemplate,
  promptVersion,
  renderInstructions
} from '../out-test/main/debate/prompts.js';
import { DebateStore } from '../out-test/main/debate/store.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { planLead } from '../out-test/main/debate/lead.js';

const QUESTION = '17 乘 3 应该等于 51 吗？';
const LEAD = { mode: 'local', agentId: 'a', label: 'a', reason: 'test', drivenBy: 'orchestrator' };

// ---------------------------------------------------------------------------
// 模板清单
// ---------------------------------------------------------------------------

test('七个模板齐全，版本一致，每项都有契约', () => {
  assert.equal(PROMPT_VERSION, '1.0.0');
  assert.equal(promptVersion(), PROMPT_VERSION);
  assert.equal(PROMPT_TEMPLATES.length, 7);
  const ids = PROMPT_TEMPLATES.map(item => item.id);
  assert.deepEqual(ids, [
    'independent-analysis', 'claim-extraction', 'dispute-detection',
    'challenge', 'revision', 'judgment', 'synthesis'
  ]);
  for (const template of PROMPT_TEMPLATES) {
    assert.equal(template.version, PROMPT_VERSION, `${template.id} 版本要一致`);
    assert.ok(template.inputs.length > 0, `${template.id} 缺输入 schema`);
    assert.ok(template.outputs.length > 0, `${template.id} 缺输出 schema`);
    assert.ok(template.prohibitions.length > 0, `${template.id} 缺禁止事项`);
    assert.ok(template.citation.length > 0, `${template.id} 缺引用要求`);
    assert.ok(template.onFailure.length > 0, `${template.id} 缺失败处理`);
    assert.ok(template.source.length > 0, `${template.id} 缺实现位置`);
  }
  assert.equal(promptTemplate('revision')?.id, 'revision');
  assert.equal(promptTemplate('nope'), undefined);
});

test('本地规则那四项如实标成 rule 且没有伪造文案', () => {
  const rules = PROMPT_TEMPLATES.filter(item => item.kind === 'rule');
  assert.deepEqual(rules.map(item => item.id), [
    'claim-extraction', 'dispute-detection', 'judgment', 'synthesis'
  ]);
  for (const rule of rules) {
    assert.equal(rule.text, null, `${rule.id} 是规则实现，不该挂一段假 prompt`);
  }
  const system = PROMPT_TEMPLATES.filter(item => item.kind === 'system');
  assert.equal(system.length, 3);
  for (const item of system) assert.ok(item.text.length > 0);
});

// ---------------------------------------------------------------------------
// 搬迁前后的文案逐字一致
// ---------------------------------------------------------------------------

test('position 轮：指令与搬迁前逐字一致', () => {
  assert.deepEqual(renderInstructions('truth', 'position', 'peer', LEAD), [
    '独立给出你对这个问题的观点，并说明成立的条件。',
    '先给结论，再标出支撑它的最强证据；没有证据支撑的部分，明确说这是推断。',
    '如果关键事实你也不确定，直接说「需要核实」，不要给一个听起来完整的答案。',
    '保留有依据的不同意见，不要为了达成一致而放弃它。'
  ]);
});

test('seeded 的 position 轮：不重复网页回答', () => {
  assert.deepEqual(renderInstructions('truth', 'position', 'peer', LEAD, { seeded: true }), [
    '网页通道的回答已经在上下文里。不要复述它们，直接指出其中站不住的那一条，并给出你的判断和条件。',
    '先给结论，再标出支撑它的最强证据；没有证据支撑的部分，明确说这是推断。',
    '如果关键事实你也不确定，直接说「需要核实」，不要给一个听起来完整的答案。',
    '保留有依据的不同意见，不要为了达成一致而放弃它。'
  ]);
});

test('question 轮：具体挑战排在通用指令后面，最多带三条', () => {
  assert.deepEqual(
    renderInstructions('truth', 'question', 'critic', LEAD, {
      challenges: ['- 甲说 A，乙说非 A：请给出依据。']
    }),
    [
      '逐条质疑上一轮发言里证据不足或推理跳跃的地方；指出具体是哪一句。',
      '优先检查证据链：哪一句的出处撑不住它，或者出处和这句话对不上。',
      '指出具体是哪一句，不要泛泛说「不够严谨」。',
      '这一轮先处理下面几处具体冲突，它们都是上一轮里彼此对不上的两句：',
      '- 甲说 A，乙说非 A：请给出依据。',
      '你的职责是检验主张的漏洞。',
      '保留有依据的不同意见，不要为了达成一致而放弃它。'
    ]
  );
});

test('revision 轮：决策行仍是机器唯一能确定读到的信号', () => {
  const lines = renderInstructions('truth', 'revision', 'peer', LEAD);
  assert.equal(lines[0], '针对质疑逐条回应；可以修正观点，也可以说明为什么坚持，并给出条件。');
  assert.equal(
    lines[1],
    '回答的第一行只写决策，从这五个里选一个：决策：accept / defend / revise / withdraw / inconclusive' +
      '（依次是 接受质疑 / 有依据地坚持 / 部分修正 / 撤回这条说法 / 现有信息判断不了）。'
  );
  assert.equal(lines.at(-1), '保留有依据的不同意见，不要为了达成一致而放弃它。');
});

test('网页主导时的基准说明只出现在非首轮', () => {
  const webLead = { ...LEAD, mode: 'web' };
  assert.equal(
    renderInstructions('truth', 'position', 'peer', webLead).some(line => line.includes('以网页通道的独立观点为基准')),
    false
  );
  assert.equal(
    renderInstructions('truth', 'question', 'peer', webLead).some(line => line.includes('以网页通道的独立观点为基准')),
    true
  );
});

test('策略只改侧重，不改骨架与决策行', () => {
  for (const strategy of ['truth', 'adversarial', 'expert', 'assumption', 'solution', 'discovery']) {
    const position = renderInstructions(strategy, 'position', 'peer', LEAD);
    assert.equal(position[0], '独立给出你对这个问题的观点，并说明成立的条件。');
    assert.equal(position.at(-1), '保留有依据的不同意见，不要为了达成一致而放弃它。');
    const revision = renderInstructions(strategy, 'revision', 'peer', LEAD);
    assert.match(revision[1], /^回答的第一行只写决策/);
  }
});

// ---------------------------------------------------------------------------
// 版本落盘 + 网页通道硬规则
// ---------------------------------------------------------------------------

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-debate-prompts-'));
  const store = new DebateStore(dir);
  const seen = [];
  const ask = async (agentId, task) => {
    seen.push({ agentId, question: task.question, context: task.context ?? [], system: task.system ?? [] });
    return {
      agentId,
      text: `${agentId} 的观点：条件不同，结论也不同。`,
      receivedAt: Date.now(),
      attribution: { requestId: 'r', note: 'test' },
      stage: task.stage
    };
  };
  return {
    dir, store, seen,
    orchestrator: new DebateOrchestrator(store, { ask }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

test('版本号跟着每场辩论落盘，读回来一致', async () => {
  const h = harness();
  try {
    const started = h.orchestrator.start(QUESTION, {
      strategy: 'truth', maxRounds: 1, participants: ['a', 'b'], convergenceStop: false
    });
    assert.equal(started.promptVersion, PROMPT_VERSION);

    const saved = await h.orchestrator.waitFor(started.debateId, 8000);
    assert.equal(saved?.status, 'completed');
    assert.equal(saved.promptVersion, PROMPT_VERSION);
    const reloaded = h.store.get(started.debateId);
    assert.equal(reloaded.promptVersion, PROMPT_VERSION);
    assert.equal(Object.hasOwn(reloaded, 'promptVersion'), true, '字段要真的写进文件');
  } finally {
    h.cleanup();
  }
});

test('老辩论文件没有 promptVersion：不伪造，也不影响读取', () => {
  const h = harness();
  try {
    const started = h.orchestrator.start(QUESTION, {
      strategy: 'truth', maxRounds: 1, participants: ['a', 'b'], convergenceStop: false
    });
    const file = path.join(h.dir, `${started.debateId}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.promptVersion;
    fs.writeFileSync(file, JSON.stringify(raw));
    const reloaded = h.store.get(started.debateId);
    assert.equal(reloaded.promptVersion, undefined, '不该补成当前版本');
    assert.equal(reloaded.debateId, started.debateId);
  } finally {
    h.cleanup();
  }
});

test('归属规则：网页主导只用网页，第一轮原话、后续材料拼进用户消息', async () => {
  const h = harness();
  try {
    const candidates = [
      { id: 'chatgpt', label: 'ChatGPT', type: 'web', available: true },
      { id: 'local', label: '本地', type: 'local', available: true }
    ];
    const plan = planLead({ mode: 'web', strategy: 'truth', candidates });
    assert.deepEqual(plan.participants, ['chatgpt'], '网页主导不引入本地模型');
    const started = h.orchestrator.start(QUESTION, {
      strategy: 'truth', maxRounds: 2, leadMode: 'web', convergenceStop: false
    }, undefined, plan);
    const saved = await h.orchestrator.waitFor(started.debateId, 8000);
    assert.equal(saved?.status, 'completed');

    const webCalls = h.seen.filter(call => plan.webOnly.includes(call.agentId));
    assert.equal(webCalls.length, 2, '两轮都由同一个网页通道发言（自辩）');
    assert.equal(webCalls[0].question, QUESTION, '第一轮页面收到的必须是用户原话');
    assert.match(webCalls[1].question, /【问题】/, '交锋材料拼进用户消息');
    assert.match(webCalls[1].question, /【观点】/, '交锋要看到上一轮观点');
    for (const call of webCalls) {
      assert.deepEqual(call.system, [], '网页成员不得收到任何模板指令');
      assert.deepEqual(call.context, [], '网页成员不得收到 context');
    }
    assert.equal(h.seen.filter(call => call.agentId === 'local').length, 0, '网页主导不得调用本地模型');
  } finally {
    h.cleanup();
  }
});
