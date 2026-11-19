/** P1-01：按名单问人；网页只收问题；不可用/未知有明确结果。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ParticipantManager } from '../out-test/main/collaboration/participants/manager.js';

function pool(seen) {
  const agents = [
    { id: 'web', label: '网页', sourceType: 'web', health: async () => ({ available: true }) },
    { id: 'local', label: '本地', sourceType: 'local', health: async () => ({ available: true }) },
    { id: 'down', label: '离线', sourceType: 'cloud', health: async () => ({ available: false, detail: '未登录' }) }
  ].map(agent => ({
    ...agent,
    ask: async task => { seen.push({ id: agent.id, task }); return { text: `${agent.id} answer` }; }
  }));
  return {
    all: async () => agents,
    available: async () => agents.filter(a => a.id !== 'down'),
    ask: async (id, task) => agents.find(a => a.id === id).ask(task),
    newConversation: async () => ({ ok: true }),
    deleteConversation: async () => ({ ok: true }),
    cancel: () => {}
  };
}

test('list：可用性与原因', async () => {
  const manager = new ParticipantManager(pool([]));
  const list = await manager.list();
  assert.equal(list.length, 3);
  assert.equal(list.find(x => x.participantId === 'down').available, false);
  assert.match(list.find(x => x.participantId === 'down').reason, /未登录/);
});

test('ask：只问名单；网页不带 context/system，本地带', async () => {
  const seen = [];
  const manager = new ParticipantManager(pool(seen));
  const out = await manager.ask(['web', 'local'], '原话', { context: ['前序'], system: ['契约'] });
  assert.deepEqual(out.map(x => x.status), ['done', 'done']);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].task.question, '原话');
  assert.equal(seen[0].task.context, undefined);
  assert.equal(seen[0].task.system, undefined);
  assert.deepEqual(seen[1].task.context, ['前序']);
  assert.deepEqual(seen[1].task.system, ['契约']);
});

test('ask：不可用跳过、未知失败、失败不抛', async () => {
  const manager = new ParticipantManager(pool([]));
  const out = await manager.ask(['down', 'nope'], 'q');
  assert.equal(out[0].status, 'skipped');
  assert.equal(out[1].status, 'failed');
});
