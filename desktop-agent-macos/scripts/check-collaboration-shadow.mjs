/** P1-08：shadow 只算计划，不调用模型。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShadowPlan } from '../out-test/main/collaboration/engine.js';

function pool(asked) {
  const agents = [
    { id: 'web', label: 'web', sourceType: 'web', health: async () => ({ available: true }) },
    { id: 'local', label: 'local', sourceType: 'local', health: async () => ({ available: true }) }
  ].map(agent => ({
    ...agent,
    ask: async task => { asked.push({ id: agent.id, task }); return { text: 'x' }; }
  }));
  return {
    all: async () => agents,
    available: async () => agents,
    ask: async (id, task) => agents.find(a => a.id === id).ask(task),
    newConversation: async () => ({ ok: true }),
    deleteConversation: async () => ({ ok: true }),
    cancel: () => {}
  };
}

test('shadow：产出计划，零 ask', async () => {
  const asked = [];
  const plan = await buildShadowPlan({
    conversationId: 'c1',
    workspace: 'general',
    question: '什么是递归',
    pool: pool(asked)
  });
  assert.equal(plan.goalId, 'c1');
  assert.ok(plan.tasks.length >= 2);
  assert.equal(asked.length, 0, 'shadow 不得调用模型');
});

test('shadow：没有可用参与者时抛错（调用方吞掉）', async () => {
  const empty = { ...pool([]), all: async () => [], available: async () => [] };
  await assert.rejects(
    () => buildShadowPlan({ conversationId: 'c1', workspace: 'general', question: 'q', pool: empty }),
    /没有满足范围/
  );
});
