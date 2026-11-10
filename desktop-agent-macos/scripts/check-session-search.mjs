/**
 * 跨会话检索（`session.search`）：只读、带来源、0 条不算失败。
 *
 * Run with: npm run test:session-search
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { searchSessions } from '../out-test/shared/session-search.js';
import { PlanSchema, READ_ONLY_TOOLS } from '../out-test/shared/contracts.js';
import { CAPABILITY_CATALOG } from '../out-test/shared/capabilities.js';

const conversations = [
  {
    conversationId: 'c1',
    title: 'Redis 连接复用',
    updatedAt: 200,
    messages: [
      { role: 'user', text: 'Redis 连接池怎么配？', at: 100 },
      { role: 'channel', text: '建议使用连接池，并设置 maxIdle。', at: 110 }
    ]
  },
  {
    conversationId: 'c2',
    title: '无关话题',
    updatedAt: 100,
    messages: [{ role: 'user', text: '今天天气不错', at: 50 }]
  }
];

test('命中消息时带来源会话、角色、时间与片段', () => {
  const result = searchSessions({ query: '连接池', conversations });
  assert.equal(result.hits.length, 2);
  const hit = result.hits.find(item => item.role === 'channel');
  assert.equal(hit.conversationId, 'c1');
  assert.equal(hit.title, 'Redis 连接复用');
  assert.equal(hit.source, 'message');
  assert.equal(hit.role, 'channel');
  assert.equal(hit.at, 110);
  assert.match(hit.snippet, /连接池/);
});

test('命中标题也算，且大小写不敏感', () => {
  const result = searchSessions({ query: 'redis', conversations });
  assert.ok(result.hits.some(hit => hit.source === 'title'));
});

test('0 条不是失败：返回空列表和扫描量', () => {
  const result = searchSessions({ query: '不存在的东西', conversations });
  assert.deepEqual(result.hits, []);
  assert.equal(result.scanned.conversations, 2);
  assert.equal(result.scanned.messages, 3);
});

test('可以限定会话，也可以限制条数', () => {
  const only = searchSessions({ query: '连接池', conversations, conversationId: 'c2' });
  assert.deepEqual(only.hits, []);

  const limited = searchSessions({ query: 'e', conversations, limit: 1 });
  assert.equal(limited.hits.length, 1);
});

test('计划接受 session.search 与 plugin.inspect，且都是只读', () => {
  for (const step of [
    { id: 's1', tool: 'session.search', args: { query: 'Redis' } },
    { id: 's2', tool: 'plugin.inspect', args: {} }
  ]) {
    const parsed = PlanSchema.safeParse({
      protocol: 'desktop-agent/v1',
      type: 'plan',
      taskId: 't1',
      roundId: 'r1',
      title: '查',
      description: '',
      steps: [step],
      completion: { condition: '拿到结果' }
    });
    assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    assert.ok(READ_ONLY_TOOLS.includes(step.tool));
  }
  assert.equal(CAPABILITY_CATALOG.find(item => item.id === 'session.search')?.permission, 'read-only');
  assert.equal(CAPABILITY_CATALOG.find(item => item.id === 'plugin.inspect')?.permission, 'read-only');
});
