/**
 * Router tests.
 *
 * The rule these guard is the one the rebuild exists for: a question must not
 * be classified as a workspace task just because it mentions code, and a real
 * file change must not be downgraded to a chat. Both directions are silent
 * failures — the first wastes a round on a plan nobody wanted, the second never
 * touches the file the user asked about.
 *
 * Run with: npm run test:intent
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyIntent, isMultiChannel } from '../out/shared/intent.js';

test('a plain question is an answer, not a task', () => {
  assert.equal(classifyIntent('Redis 的 SETNX 是做什么的').kind, 'answer');
  assert.equal(classifyIntent('什么是连接池').kind, 'answer');
});

test('analysis questions are research', () => {
  assert.equal(classifyIntent('帮我分析 Redis 连接数过高的原因').kind, 'research');
  assert.equal(classifyIntent('研究一下 Java 堆外内存持续增长的问题').kind, 'research');
  assert.equal(classifyIntent('排查线上接口偶发超时的方案').kind, 'research');
});

test('a file change is a workspace task', () => {
  assert.equal(classifyIntent('帮我修改工作区中的某个文件').kind, 'workspace');
  assert.equal(classifyIntent('把 README.md 里那段删掉').kind, 'workspace');
  assert.equal(classifyIntent('新建一个 docs/faq.md 文件').kind, 'workspace');
});

test('mentioning code without asking to change it stays a question', () => {
  // This is the regression that mattered: 代码 used to be enough on its own.
  assert.equal(classifyIntent('帮我分析这段代码的性能问题').kind, 'research');
  assert.equal(classifyIntent('这个仓库的分层是怎么设计的').kind, 'research');
});

test('comparison is its own intent', () => {
  assert.equal(classifyIntent('比较 Envoy 和 Redis Enterprise Proxy').kind, 'compare');
  assert.equal(classifyIntent('Nginx vs Envoy 哪个更适合做入口').kind, 'compare');
});

test('a link plus a digest verb is an extract', () => {
  const intent = classifyIntent('帮我整理一下这个网页 https://example.com/post/1');
  assert.equal(intent.kind, 'extract');
  assert.equal(intent.url, 'https://example.com/post/1');
});

test('a bare link is not an extract', () => {
  assert.equal(classifyIntent('https://example.com/post/1').kind, 'answer');
});

test('every intent carries a reason', () => {
  for (const text of ['什么是连接池', '分析一下原因', '改一下这个文件', '比较 A 和 B']) {
    assert.ok(classifyIntent(text).reason.length > 0, text);
  }
});

test('multi-channel intents are exactly research, compare and extract', () => {
  assert.equal(isMultiChannel('research'), true);
  assert.equal(isMultiChannel('compare'), true);
  assert.equal(isMultiChannel('extract'), true);
  assert.equal(isMultiChannel('answer'), false);
  assert.equal(isMultiChannel('workspace'), false);
});
