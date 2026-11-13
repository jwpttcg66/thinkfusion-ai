/**
 * Phase I：观点融合引擎。
 *
 * 全部用真实的多通道回答形态做输入，重点测反例：同通道重复不算共识、
 「有/没有」不能被聚成一伙、条件不同不判矛盾、只有一份回答必须 degraded。
 *
 * Run with: npm run test:fusion
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fuse, synthesizeWithFusion } from '../out-test/main/synthesis/engine.js';
import { toSynthesis } from '../out-test/shared/fusion.js';
import { buildPickPrompt, PICK_SYSTEM, pickLeadLocally, heuristicPick } from '../out-test/main/synthesis/lead-selector.js';

const input = (channelId, messageId, text) => ({ channelId, messageId, text });

const A = '根据官方文档，连接池能把延迟从 200 毫秒降到 40 毫秒，因为复用连接省去了握手。';
const A2 = '官方文档显示连接池可以把延迟从 200 毫秒降到 40 毫秒，原因是复用了连接。';
const B = '如果只在单线程环境里使用，就不需要连接池，因为不会产生并发竞争。';

// ---------------------------------------------------------------------------

test('没有可抽取的观点时 degraded，limits 说清为什么', () => {
  const report = fuse([]);
  assert.equal(report.degraded, true);
  assert.equal(report.backend, 'local');
  assert.equal(report.consensus.length, 0);
  assert.ok(report.limits.some(line => /没有从回答里抽出/.test(line)));
  assert.match(toSynthesis(report).recommendation, /只保留原始回答/);
});

test('只有一份回答时 degraded，不能把单通道包装成共识', () => {
  const report = fuse([input('a', 'm1', A)]);
  assert.equal(report.degraded, true);
  assert.equal(report.consensus.length, 0);
  assert.match(report.recommendation, /没有跨通道共识/);
  assert.ok(report.limits.some(line => /不验证外部事实/.test(line)));
});

test('两个通道说同一件事才算共识；同通道重复三遍 support 仍是 1', () => {
  const agreed = fuse([input('a', 'm1', A), input('b', 'm2', A2)]);
  assert.equal(agreed.degraded, false);
  assert.ok(agreed.consensus.length >= 1);
  assert.ok(agreed.consensus.every(claim => claim.support >= 2));

  const repeated = fuse([
    input('a', 'm1', A),
    input('a', 'm2', A),
    input('a', 'm3', A)
  ]);
  assert.equal(repeated.consensus.length, 0, '同一个通道说三遍不是共识');
  assert.ok(repeated.claims.every(claim => claim.support === 1));
});

test('「有」和「没有」字面高度相似，必须出 contradicts 而不是聚成一伙', () => {
  const report = fuse([
    input('a', 'm1', '这个接口提供了多线程安全保证，可以放心并发调用。'),
    input('b', 'm2', '这个接口没有提供多线程安全保证，不能并发调用。')
  ]);
  assert.ok(
    report.relations.some(edge => edge.kind === 'contradicts'),
    '否定极性相反必须建 contradicts 边'
  );
  assert.ok(report.disputed.length > 0);
  assert.ok(report.rejected.length > 0);
  assert.ok(report.rejected.every(item => item.text.length > 0), '被否定的观点也要保留原文');
  assert.ok(report.relations.every(edge => edge.reason.length > 0), '每条边都要有理由');
});

test('条件句抽成 assumptions，条件不同不硬判矛盾', () => {
  const report = fuse([
    input('a', 'm1', '如果启用了持久化，就需要先初始化磁盘目录再启动服务。'),
    input('b', 'm2', '如果只运行在内存模式，就不需要准备磁盘目录。')
  ]);
  const withAssumptions = report.claims.filter(claim => claim.assumptions.length > 0);
  assert.ok(withAssumptions.length > 0, '条件必须成为一条记录，不能写进正文当形容词');
  // 条件被拆开时应该是 qualifies/contradicts 中的一种，但不能把两组聚成共识。
  assert.equal(report.consensus.length, 0);
});

test('共识句要报几分之几：两个通道同意不等于全体一致', () => {
  // 真实场景：四个通道里两个都说「押平水韵下平七阳」，另两个各用别的韵。
  // 这时候写「多通道共同提到的」读起来像全体一致，实际只有一半。
  const partial = fuse([
    input('a', 'm1', A),
    input('b', 'm2', A2),
    input('c', 'm3', '这首诗用的是下平十一尤，韵脚分别是眸、秋、愁、楼、头五个字。')
  ]);
  assert.ok(partial.consensus.length >= 1);
  assert.match(partial.recommendation, /2\/3 个通道提到/, '两个通道同意就要写成 2/3');
  assert.doesNotMatch(partial.recommendation, /所有/, '不是全体一致就不能写「所有」');

  const full = fuse([input('a', 'm1', A), input('b', 'm2', A2), input('c', 'm3', A)]);
  assert.match(full.recommendation, /所有 3 个通道都提到/);
});

test('证据七维分别打，timeliness 本地判不了就写 null', () => {
  const report = fuse([input('a', 'm1', A), input('b', 'm2', A2)]);
  assert.ok(report.evidence.length > 0);
  for (const item of report.evidence) {
    assert.equal(item.scores.timeliness, null);
    assert.equal(typeof item.scores.authority, 'number');
    assert.equal(typeof item.scores.independence, 'number');
    assert.ok(['unverified', 'corroborated', 'conflicted'].includes(item.verified));
    assert.ok(item.span.messageId.length > 0, '证据要能跳回原话');
  }
});

test('排序分数只决定先讲哪个，不声明真伪', () => {
  const report = fuse([input('a', 'm1', A), input('b', 'm2', A2), input('c', 'm3', B)]);
  assert.ok(report.claims.length > 0);
  assert.ok(report.claims.every(claim => claim.rank >= 0 && claim.rank <= 1));
  assert.ok(report.limits.some(line => /不声明哪个是真的/.test(line)));
  // 有争议的观点不该排在最前。
  const attacked = report.claims.find(claim =>
    report.relations.some(edge => edge.to === claim.id && (edge.kind === 'attacks' || edge.kind === 'contradicts'))
  );
  if (attacked) {
    const top = Math.max(...report.claims.map(claim => claim.rank));
    assert.ok(attacked.rank < top || report.claims.length === 1);
  }
});

test('toSynthesis 保留 Claim[] 的 sources 与 evidence，并带上融合摘要', () => {
  const report = fuse([input('a', 'm1', A), input('b', 'm2', A2)]);
  const synthesis = toSynthesis(report);
  assert.ok(Array.isArray(synthesis.consensus));
  for (const claim of synthesis.consensus) {
    assert.ok(Array.isArray(claim.sources) && claim.sources.length > 0);
    assert.ok(Array.isArray(claim.evidence));
    assert.ok(claim.sources[0].messageId.length > 0);
  }
  assert.equal(synthesis.fusion.backend, 'local');
  assert.equal(synthesis.fusion.evidenceCount, report.evidence.length);
  assert.equal(synthesis.fusion.relationCount, report.relations.length);
  assert.equal(synthesis.fusion.undetermined, true, '没有裁决时不能写成已确认');
  assert.ok(synthesis.fusion.limits.length > 0);
});

test('接入裁决后，finalDecision / 未解决问题 / 置信度都进综合报告', () => {
  const verdict = {
    verdictId: 'v1',
    debateId: 'd1',
    createdAt: 1,
    judgeAgentId: null,
    backend: 'rules',
    conclusion: '在并发场景下采用连接池',
    undetermined: false,
    reason: '证据一致',
    disagreement: '',
    evidence: [],
    argumentQuality: [],
    minorities: [],
    unresolved: [{ question: '单线程下还要不要连接池？', why: '没人回应', sourceMessageIds: [] }],
    confidence: { level: 'low', why: '规则版' },
    sourceMessageIds: [],
    supportCount: {}
  };
  const { report, synthesis } = synthesizeWithFusion(
    [input('a', 'm1', A), input('b', 'm2', A2)],
    { verdict }
  );
  assert.equal(report.finalDecision, verdict.conclusion);
  assert.equal(report.undetermined, false);
  assert.equal(report.debateId, 'd1');
  assert.equal(synthesis.recommendation, verdict.conclusion);
  assert.equal(synthesis.fusion.finalDecision, verdict.conclusion);
  assert.equal(synthesis.fusion.unresolvedQuestions.length, 1);
  assert.ok(report.gaps.some(gap => /单线程/.test(gap.topic)));
});

test('裁决无法确定时，综合报告明写 undetermined，不硬给结论', () => {
  const { report, synthesis } = synthesizeWithFusion([input('a', 'm1', A), input('b', 'm2', A2)], {
    verdict: {
      verdictId: 'v2', debateId: 'd2', createdAt: 1, judgeAgentId: null, backend: 'rules',
      conclusion: null, undetermined: true, reason: '分歧未消解', disagreement: '两边各执一词',
      evidence: [], argumentQuality: [], minorities: [], unresolved: [],
      confidence: { level: 'low', why: '证据不足' }, sourceMessageIds: [], supportCount: {}
    }
  });
  assert.equal(report.finalDecision, null);
  assert.equal(report.undetermined, true);
  assert.equal(synthesis.fusion.undetermined, true);
});

test('少数派原文进报告，不为达成共识被删掉', () => {
  const report = fuse([input('a', 'm1', A), input('b', 'm2', A2), input('c', 'm3', B)]);
  assert.ok(report.unique.length > 0, '条件不同的第三种观点应该作为独有保留');
  const texts = [...report.claims, ...report.rejected].map(item => item.text);
  assert.ok(texts.some(text => /单线程|内存模式|不需要连接池/.test(text)));
});

// ---------------------------------------------------------------------------
// 汇总阶段：本地模型读完整回答写结论，失败退回规则版
// ---------------------------------------------------------------------------

test('汇总提示词带上每个来源的标签和原文，不替用户改写问题', async () => {
  const { buildSummaryQuestion, SUMMARY_SYSTEM } = await import('../out-test/main/synthesis/local-summary.js');
  const question = '17 个任务平均分给 4 个人，每人几个？';
  const prompt = buildSummaryQuestion(question, [
    { channelId: 'chatgpt', label: 'ChatGPT', text: '每人 4 个，余 1 个。' },
    { channelId: 'kimi', label: 'Kimi', text: '4 余 1。' }
  ]);
  assert.ok(prompt.includes(question), '用户问题原样带进去');
  assert.ok(prompt.includes('ChatGPT') && prompt.includes('Kimi'), '来源要标号，否则分歧说清是跟谁分');
  assert.ok(prompt.includes('每人 4 个，余 1 个。'), '回答原文不能被改写');
  assert.ok(SUMMARY_SYSTEM.some(line => /不要补充它们没说过的事实/.test(line)));
});

test('本地模型不可用 / 只有一份回答 / provider 抛错，都返回 null 而不是编一个结论', async () => {
  const { summarizeLocally } = await import('../out-test/main/synthesis/local-summary.js');
  const one = [{ channelId: 'a', label: 'A', text: '只有一份' }];
  assert.equal(await summarizeLocally(null, 'q', one), null, '没装模型就没有汇总');
  assert.equal(await summarizeLocally({ generate: async () => ({ text: 'x' }) }, 'q', one), null, '一份回答不需要汇总');

  const two = [
    { channelId: 'a', label: 'A', text: '甲' },
    { channelId: 'b', label: 'B', text: '乙' }
  ];
  const failing = { generate: async () => { throw new Error('timeout'); } };
  assert.equal(await summarizeLocally(failing, 'q', two), null, '超时降级，不抛给上层');
  const empty = { generate: async () => ({ text: '   ' }) };
  assert.equal(await summarizeLocally(empty, 'q', two), null, '空串不算汇总');

  const ok = { generate: async request => ({ text: `【结论】4 余 1\n${request.system.length}`, modelId: 'local-test:7b' }) };
  const result = await summarizeLocally(ok, 'q', two);
  assert.equal(result.modelId, 'local-test:7b');
  assert.match(result.text, /【结论】4 余 1/);
});

// ---------------------------------------------------------------------------
// 主导轮：一位模型读完全部回答，指出错误、比较优劣、给最终答案
// ---------------------------------------------------------------------------

test('主导提示词把每份回答编号并标出来源，还标出哪一份是它自己写的', async () => {
  const { buildLeadPrompt } = await import('../out-test/main/synthesis/lead-prompt.js');
  const prompt = buildLeadPrompt(
    '9.11 和 9.9 哪个大？',
    [
      { agentId: 'chatgpt', label: 'ChatGPT', text: '9.9 更大。' },
      { agentId: 'gemini', label: 'Gemini', text: '9.11 更大。' }
    ],
    { selfAgentId: 'chatgpt' }
  );
  assert.ok(prompt.includes('9.11 和 9.9 哪个大？'), '原问题要在里面，否则主导不知道在评什么');
  assert.ok(prompt.includes('【回答1】ChatGPT（这是你自己的回答）'), '自己的回答要标出来，否则它会给自己投票');
  assert.ok(prompt.includes('【回答2】Gemini'), '别人的回答要编号');
  assert.ok(/指出.*事实错误|事实错误/.test(prompt), '必须要求指出错误，而不只是复述');
  assert.ok(/最终的答案/.test(prompt), '必须要求给出自己的最终答案');
  assert.ok(/无法确定/.test(prompt), '证据不足要允许说不知道');
});

test('API 主导用 system 轮次说评审要求，问题本身不被改写', async () => {
  const { LEAD_SYSTEM } = await import('../out-test/main/synthesis/lead-prompt.js');
  assert.ok(LEAD_SYSTEM.length >= 3);
  assert.ok(LEAD_SYSTEM.some(line => /不要编造/.test(line)));
  assert.ok(LEAD_SYSTEM.some(line => /无法确定/.test(line)));
});

// ---------------------------------------------------------------------------
// 主导自动选择：本地模型按「问题 + 答案」挑一位来源主导，失败退回启发式
// ---------------------------------------------------------------------------

test('buildPickPrompt 把问题和每份回答编号带进去，不改写问题', () => {
  const prompt = buildPickPrompt('9.11 和 9.9 谁大', [
    { agentId: 'chatgpt', label: 'ChatGPT', text: '9.9 大。' },
    { agentId: 'gemini', label: 'Gemini', text: '9.11 大。' }
  ]);
  assert.ok(prompt.includes('9.11 和 9.9 谁大'), '原问题要在');
  assert.ok(prompt.includes('【回答1】ChatGPT'), '第一份要标号带来源');
  assert.ok(prompt.includes('【回答2】Gemini'), '第二份也要');
  assert.ok(PICK_SYSTEM.some(line => /选择：回答N/.test(line)), 'system 要指明输出格式');
});

test('pickLeadLocally 解析「选择：回答N」，映射到候选的 agentId', async () => {
  const provider = { generate: async () => ({ text: '选择：回答2\nGemini 的推理更严谨。', modelId: 'local-test:7b' }) };
  const picked = await pickLeadLocally(provider, 'q', [
    { agentId: 'chatgpt', label: 'ChatGPT', text: 'a' },
    { agentId: 'gemini', label: 'Gemini', text: 'b' }
  ]);
  assert.equal(picked.agentId, 'gemini');
  assert.equal(picked.label, 'Gemini');
  assert.match(picked.reason, /Gemini 的推理更严谨/);
});

test('pickLeadLocally 编号越界时返回 null，交给兜底', async () => {
  const provider = { generate: async () => ({ text: '选择：回答9', modelId: 'local-test:7b' }) };
  const picked = await pickLeadLocally(provider, 'q', [
    { agentId: 'a', label: 'A', text: 'a' },
    { agentId: 'b', label: 'B', text: 'b' }
  ]);
  assert.equal(picked, null);
});

test('pickLeadLocally 没装模型 / 候选不足 / 报错都返回 null', async () => {
  assert.equal(await pickLeadLocally(null, 'q', [{ agentId: 'a', label: 'A', text: 'a' }]), null, '没装模型');
  assert.equal(
    await pickLeadLocally({ generate: async () => { throw new Error('x'); } }, 'q', [
      { agentId: 'a', label: 'A', text: 'a' },
      { agentId: 'b', label: 'B', text: 'b' }
    ]),
    null,
    '报错/超时'
  );
});

test('heuristicPick 选正文最长的那一份（确定性兜底）', () => {
  const picked = heuristicPick([
    { agentId: 'short', label: '短', text: '一两个字' },
    { agentId: 'long', label: '长', text: '这是一段明显长得多的回答内容用于测试启发式兜底逻辑是否真的挑选了长度更大的那一份' }
  ]);
  assert.equal(picked.agentId, 'long');
  assert.match(picked.reason, /完整度/);
});

test('同一份回答里前后两句相反，不算「两家分歧」；跨通道相反才算', () => {
  // 真机（网页主导的一张综合卡）：下面那栏「分歧（3）」里三条都是
  // 「ChatGPT 说 A ／ ChatGPT 说 B」——同一份回答自己的论证被当成了两家打架。
  const sameChannel = fuse([
    input('a', 'm1', '这个接口提供了多线程安全保证，可以并发调用。但文档也说这个接口没有提供多线程安全保证，不能并发调用。'),
    input('b', 'm2', '接口文档写得含糊，建议直接看源码。')
  ]);
  assert.ok(
    sameChannel.relations.some(relation => relation.kind === 'contradicts'),
    '规则确实看出了这两句相反'
  );
  assert.equal(toSynthesis(sameChannel).disputed.length, 0, '同一家的两句话不是分歧');

  const crossChannel = fuse([
    input('a', 'm1', '这个接口提供了多线程安全保证，可以放心并发调用。'),
    input('b', 'm2', '这个接口没有提供多线程安全保证，不能并发调用。')
  ]);
  const disputes = toSynthesis(crossChannel).disputed;
  assert.equal(disputes.length, 1, '两家说法相反才算分歧');
  assert.notEqual(disputes[0].positions[0].channelId, disputes[0].positions[1].channelId);
});
