/**
 * Synthesis tests.
 *
 * The rule under test is the product claim: a synthesis must contain either a
 * disagreement or a coverage gap. If it contains neither and nothing was shared,
 * it is not a synthesis and has to say so (`degraded`) rather than dress up two
 * parallel answers as agreement.
 *
 * Run with: npm run test:synthesis
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { synthesize } from '../out/shared/synthesizer.js';

const one = (channelId, text) => ({ channelId, messageId: `m-${channelId}`, text });

test('agreement across channels becomes consensus', () => {
  const result = synthesize([
    one('a', '连接数过高的主要原因是客户端没有复用连接。'),
    one('b', '连接数过高的主要原因是客户端没有复用连接，而是每次新建。')
  ]);

  assert.ok(result.consensus.length > 0, 'expected at least one shared claim');
  assert.equal(result.degraded, false);
  assert.ok(result.recommendation.includes('一致认为'));
});

test('opposite negation on the same point becomes a dispute', () => {
  const result = synthesize([
    one('a', '生产环境必须开启连接池复用来降低连接数。'),
    one('b', '生产环境不要开启连接池复用，否则连接数会更高。')
  ]);

  assert.ok(result.disputed.length > 0, 'expected a dispute');
  assert.match(result.disputed[0].pivot, /否定/);
  assert.equal(result.disputed[0].positions.length, 2);
});

test('different numbers for the same thing become a dispute', () => {
  const result = synthesize([
    one('a', '默认最大连接数是 10000，超过之后开始拒绝。'),
    one('b', '默认最大连接数是 65535，超过之后开始拒绝。')
  ]);

  assert.ok(result.disputed.length > 0, 'expected a numeric clash');
  assert.match(result.disputed[0].pivot, /数字/);
});

test('a topic only some channels cover is reported as a gap', () => {
  const result = synthesize([
    one('a', '这个方案要考虑 ZXCV 这个限制条件。'),
    one('b', '同样要处理 ZXCV 带来的额外开销。'),
    one('c', '这里只讨论常规的扩容流程和容量评估。')
  ]);

  assert.ok(result.gaps.length > 0, 'expected at least one gap');
  assert.ok(result.gaps.some(gap => gap.topic.includes('zxcv') || gap.topic.includes('ZXCV')));
});

test('a single channel is explicitly not a synthesis', () => {
  const result = synthesize([one('a', '只有一个通道回答了这一段内容，没有比较对象。')]);

  assert.equal(result.degraded, true);
  assert.equal(result.consensus.length, 0);
  assert.match(result.recommendation, /只有一个通道/);
});

test('two channels that share nothing are reported as degraded, not as agreement', () => {
  const result = synthesize([
    one('a', '先说结论：这次故障是内存碎片导致的。'),
    one('b', '完全无关的一段话，讲的是发布流程应该怎么排期。')
  ]);

  assert.equal(result.degraded, true);
  assert.equal(result.consensus.length, 0);
  assert.match(result.recommendation, /无法形成共识/);
});

test('the same channel repeating itself does not count as agreement', () => {
  const result = synthesize([
    one('a', '连接数过高的主要原因是客户端没有复用连接。连接数过高的主要原因是客户端没有复用连接。')
  ]);

  assert.equal(result.degraded, true);
  assert.equal(result.consensus.length, 0);
});

test('every claim points back at the messages it came from', () => {
  const result = synthesize([
    one('a', '连接数过高的主要原因是客户端没有复用连接。'),
    one('b', '连接数过高的主要原因是客户端没有复用连接，而是每次新建。')
  ]);

  for (const claim of result.consensus) {
    assert.ok(claim.sources.length >= 2, 'a consensus claim needs two sources');
    for (const source of claim.sources) {
      assert.ok(source.channelId && source.messageId);
    }
  }
});

/**
 * The cases below are the ones that actually failed in a live run: two answers
 * that agreed on the substance (same 80% cap, same 连接池 / 数据库 / 上限) were
 * reported as "几乎没有重合，无法形成共识". Whole-sentence bigram similarity is
 * structurally too low for paraphrased Chinese, and lowering the threshold far
 * enough to catch them would also pair up unrelated sentences.
 */
const paraphraseA = `连接池打满通常不是连接数不够，而是连接没有被归还。常见原因有三个：一是业务代码里拿到了连接但异常路径没有 finally 释放；二是事务超时后连接还挂在事务上。
排查建议：先用 show processlist 看 Sleep 状态的连接有多少。
修复上，先把连接池的最大连接数调到数据库上限的 80%，再给连接加一个归还超时。`;

const paraphraseB = `这通常是连接泄漏，不是池子太小。可以先从三个方向确认：应用侧是否在 finally 里关闭连接、事务提交或回滚后连接是否回到池里。
定位方法：查数据库的 processlist，看空闲连接的数量和存活时间。
处理办法：把池子上限降到数据库 max_connections 的 80% 以内。`;

test('the same figure in both answers is consensus even when no sentence matches', () => {
  const result = synthesize([one('a', paraphraseA), one('b', paraphraseB)]);

  assert.equal(result.degraded, false, 'a shared 80% is a checkable agreement');
  assert.ok(result.consensus.length >= 1);
  assert.ok(
    result.consensus.some(claim => claim.evidence.some(item => item.includes('80%'))),
    'the figure itself must be quoted as evidence, or the claim is unverifiable'
  );
});

test('agreement on all channels says so instead of claiming a majority', () => {
  const result = synthesize([one('a', paraphraseA), one('b', paraphraseB)]);

  assert.match(result.recommendation, /所有通道/, 'two of two is not a majority');
  assert.doesNotMatch(result.recommendation, /多数通道/);
});

test('a figure alone is not agreement when the sentences are about different things', () => {
  const result = synthesize([
    one('a', '这个库在 2024 年发布了新版本。'),
    one('b', '2024 年的价格是 199 元。')
  ]);

  assert.equal(result.degraded, true, 'sharing a year is not sharing a claim');
  assert.equal(result.consensus.length, 0);
});

test('shared subject matter is named instead of claiming there is no overlap', () => {
  const result = synthesize([
    one('a', '排查的时候先看数据库的空闲连接，再确认连接池上限。'),
    one('b', '定位办法是查数据库里的空闲连接数量，并核对连接池的上限设置。')
  ]);

  assert.equal(result.degraded, true, 'no sentence matched, so there is still no claim');
  assert.ok(result.overlap.length > 0, 'the overlap list is the whole point here');
  assert.ok(result.overlap.includes('连接池'));
  assert.ok(result.overlap.includes('数据库'));

  // "几乎没有重合" would be a lie: they cover identical ground in different words.
  assert.doesNotMatch(result.recommendation, /几乎没有重合/);
  assert.match(result.recommendation, /连接池/);
});

test('shared phrases are substrings both answers actually wrote', () => {
  const result = synthesize([
    one('a', '排查的时候先看数据库的空闲连接，再确认连接池上限。'),
    one('b', '定位办法是查数据库里的空闲连接数量，并核对连接池的上限设置。')
  ]);

  // Splicing bigrams across the comma yields "空闲连接池", which appears in
  // neither answer. A phrase list that invents words is worse than no list.
  assert.ok(!result.overlap.some(item => item.includes('空闲连接池')));
  for (const item of result.overlap) {
    assert.ok(item.length >= 2);
    assert.ok(!/^[的了和与及或是在到从把被]/.test(item), `phrase should not start with a particle: ${item}`);
  }
});

test('two channels that share nothing still say so plainly', () => {
  const result = synthesize([
    one('a', '先说结论：这次故障是内存碎片导致的。'),
    one('b', '完全无关的一段话，讲的是发布流程应该怎么排期。')
  ]);

  assert.equal(result.degraded, true);
  assert.deepEqual(result.overlap, [], 'nothing shared means an empty overlap list, not a guess');
  assert.match(result.recommendation, /几乎没有重合/);
});

/**
 * Verbatim answers from a live run. The first version of the overlap list read
 * 连接数持续 / 连接池 / 池配置 / 置过大 / 导致 / 创建 — only one of the six was a
 * phrase either answer actually wrote. "置过大" is the tail of two different
 * words (池配置 / 设置) and "连接数持续" straddles a word boundary, so both came
 * from taking every substring instead of every term.
 */
const liveChatGpt =
  '微服务实例过多或连接池配置过大，导致每个实例独立创建大量 Redis 长连接，最终使 Redis 总连接数持续累积。';
const liveDeepSeek =
  'Redis 连接数过高的一个常见原因是应用侧存在连接泄漏，即代码获取连接后未正确关闭或归还连接池，导致连接被持续占用而无法释放。';

test('overlap is terms, not every substring two answers happen to share', () => {
  const result = synthesize([one('a', liveChatGpt), one('b', liveDeepSeek)]);

  assert.ok(result.overlap.includes('连接池'));
  // Every one of these is a real substring of both answers, and none of them is
  // a word. "高的一个常" straddles 的, "置过大" is the tail of two different
  // words, "一个常见原" starts with a determiner.
  for (const fragment of ['置过大', '池配置', '连接数持续', '高的一个常', '一个常见原', '导致', '创建', '需要', '具体']) {
    assert.ok(!result.overlap.includes(fragment), `fragment leaked into the topic list: ${fragment}`);
  }
});

test('different root causes are not dressed up as agreement', () => {
  // ChatGPT blames over-provisioning, DeepSeek blames a leak. They share a
  // subject and disagree on the answer, which is the case this must not paper
  // over with a consensus.
  const result = synthesize([one('a', liveChatGpt), one('b', liveDeepSeek)]);

  assert.equal(result.degraded, true);
  assert.equal(result.consensus.length, 0);
  assert.ok(result.overlap.length > 0, 'they are still comparable, and the card should say why');
});
