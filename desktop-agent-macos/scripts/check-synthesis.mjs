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
