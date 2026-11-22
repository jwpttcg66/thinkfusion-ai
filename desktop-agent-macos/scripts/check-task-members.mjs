import assert from 'node:assert/strict';
import test from 'node:test';
import { reduceTaskMembers, projectTaskMembers } from '../out-test/shared/task-stream.js';

/**
 * 多成员独立输出（V2.1 §10.1-2/3/4/11）。
 *
 * 这些断言守的是「不串流」和「不伪造」两件事：两个成员的 delta 不能拼进
 * 同一段文本；没给 reasoning / token 的来源不能显示成 0 或空字符串。
 */

test('两个成员的 delta 各自累积，互不串流', () => {
  let members = [];
  members = reduceTaskMembers(members, { type: 'round.peer', at: 1, roundId: 'r', memberId: 'lead', label: '主导模型', status: 'started' });
  members = reduceTaskMembers(members, { type: 'round.peer', at: 2, roundId: 'r', memberId: 'peer', label: '旁听模型', status: 'started' });
  members = reduceTaskMembers(members, { type: 'round.delta', at: 3, roundId: 'r', participantId: 'lead', text: 'A1' });
  members = reduceTaskMembers(members, { type: 'round.delta', at: 4, roundId: 'r', participantId: 'peer', text: 'B1' });
  members = reduceTaskMembers(members, { type: 'round.delta', at: 5, roundId: 'r', participantId: 'lead', text: 'A2', mode: 'delta' });
  members = reduceTaskMembers(members, { type: 'round.delta', at: 6, roundId: 'r', participantId: 'peer', text: 'B2', mode: 'delta' });

  assert.equal(members.length, 2);
  assert.equal(members[0].memberId, 'lead');
  assert.equal(members[0].text, 'A1A2');
  assert.equal(members[1].memberId, 'peer');
  assert.equal(members[1].text, 'B1B2');
  assert.equal(members[0].status, 'streaming');
  assert.equal(members[1].status, 'streaming');
});

test('reset 表示整段替换，不是追加', () => {
  let members = reduceTaskMembers([], { type: 'round.delta', at: 1, roundId: 'r', participantId: 'm', text: 'partial' });
  members = reduceTaskMembers(members, { type: 'round.delta', at: 2, roundId: 'r', participantId: 'm', text: 'full', reset: true });
  assert.equal(members[0].text, 'full');
});

test('snapshot 模式直接替换，delta 模式追加', () => {
  let members = reduceTaskMembers([], {
    type: 'round.delta', at: 1, roundId: 'r', participantId: 'm', text: 'one', mode: 'snapshot'
  });
  members = reduceTaskMembers(members, {
    type: 'round.delta', at: 2, roundId: 'r', participantId: 'm', text: 'two', mode: 'delta'
  });
  assert.equal(members[0].text, 'onetwo');
  members = reduceTaskMembers(members, {
    type: 'round.delta', at: 3, roundId: 'r', participantId: 'm', text: 'final', mode: 'snapshot'
  });
  assert.equal(members[0].text, 'final');
});

test('一个成员失败不影响另一个；失败只落在自己卡片', () => {
  let members = [];
  members = reduceTaskMembers(members, { type: 'round.peer', at: 1, roundId: 'r', memberId: 'a', label: 'A', status: 'started' });
  members = reduceTaskMembers(members, { type: 'round.peer', at: 2, roundId: 'r', memberId: 'b', label: 'B', status: 'started' });
  members = reduceTaskMembers(members, { type: 'round.delta', at: 3, roundId: 'r', participantId: 'a', text: 'ok' });
  members = reduceTaskMembers(members, { type: 'round.peer', at: 4, roundId: 'r', memberId: 'b', label: 'B', status: 'failed', error: 'RATE_LIMITED' });

  const a = members.find(item => item.memberId === 'a');
  const b = members.find(item => item.memberId === 'b');
  assert.equal(a.status, 'streaming');
  assert.equal(a.error, null);
  assert.equal(b.status, 'failed');
  assert.equal(b.error, 'RATE_LIMITED');
});

test('round.answer 收口主导，不伪造 token；没有 reasoning 的来源标未提供', () => {
  let members = [];
  members = reduceTaskMembers(members, { type: 'round.peer', at: 1, roundId: 'r', memberId: 'lead', label: 'Lead', status: 'started' });
  members = reduceTaskMembers(members, { type: 'round.peer', at: 5, roundId: 'r', memberId: 'cli', label: 'CLI', status: 'answered', text: 'done' });
  members = reduceTaskMembers(members, { type: 'round.answer', at: 6, roundId: 'r', participantId: 'lead', text: 'plan text' });

  const lead = members.find(item => item.memberId === 'lead');
  const cli = members.find(item => item.memberId === 'cli');
  assert.equal(lead.status, 'completed');
  assert.equal(lead.text, 'plan text');
  assert.equal(lead.tokenSupported, false);
  assert.equal(lead.usage, null);
  assert.equal(cli.reasoningSupported, false);
  assert.equal(cli.tokenSupported, false);
  assert.equal(cli.status, 'completed');
});

test('有 usage 时 tokenSupported 为真；有 reasoning 时 reasoningSupported 为真', () => {
  let members = [];
  members = reduceTaskMembers(members, { type: 'round.peer', at: 1, roundId: 'r', memberId: 'm', label: 'M', status: 'started' });
  members = reduceTaskMembers(members, { type: 'round.peer', at: 9, roundId: 'r', memberId: 'm', label: 'M', status: 'answered', text: 'x', usage: { totalTokens: 42 } });
  members = reduceTaskMembers(members, { type: 'round.delta', at: 3, roundId: 'r', participantId: 'n', reasoning: 'why' });
  const m = members.find(item => item.memberId === 'm');
  const n = members.find(item => item.memberId === 'n');
  assert.equal(m.tokenSupported, true);
  assert.equal(m.usage.totalTokens, 42);
  assert.equal(n.reasoningSupported, true);
});

test('新一轮清空上一轮卡片', () => {
  let members = reduceTaskMembers([], { type: 'round.delta', at: 1, roundId: 'r1', participantId: 'm', text: 'old' });
  members = reduceTaskMembers(members, { type: 'round.started', at: 2, roundId: 'r2' });
  assert.equal(members.length, 0);
});

test('任务取消时在跑的成员记 cancelled，不是 failed', () => {
  let members = reduceTaskMembers([], { type: 'round.peer', at: 1, roundId: 'r', memberId: 'm', label: 'M', status: 'started' });
  members = reduceTaskMembers(members, { type: 'task.cancelled', at: 2 });
  assert.equal(members[0].status, 'cancelled');
});

test('任务结束时仍无终态的成员记中断，已完成的保留', () => {
  let members = [];
  members = reduceTaskMembers(members, { type: 'round.peer', at: 1, roundId: 'r', memberId: 'done', label: 'Done', status: 'started' });
  members = reduceTaskMembers(members, { type: 'round.peer', at: 2, roundId: 'r', memberId: 'late', label: 'Late', status: 'started' });
  members = reduceTaskMembers(members, { type: 'round.peer', at: 3, roundId: 'r', memberId: 'done', label: 'Done', status: 'answered', text: 'ok' });
  members = reduceTaskMembers(members, { type: 'task.completed', at: 4 });
  assert.equal(members.find(item => item.memberId === 'done').status, 'completed');
  assert.equal(members.find(item => item.memberId === 'late').status, 'interrupted');
});

test('没有 participantId 的旧事件不造匿名成员', () => {
  const members = reduceTaskMembers([], { type: 'round.delta', at: 1, roundId: 'r', text: 'legacy' });
  assert.equal(members.length, 0);
});

test('projectTaskMembers 从完整事件列表重建，顺序按开始时间', () => {
  const members = projectTaskMembers([
    { type: 'round.peer', at: 5, roundId: 'r', memberId: 'b', label: 'B', status: 'started' },
    { type: 'round.peer', at: 1, roundId: 'r', memberId: 'a', label: 'A', status: 'started' },
    { type: 'round.delta', at: 6, roundId: 'r', participantId: 'b', text: 'from b' },
    { type: 'round.answer', at: 7, roundId: 'r', participantId: 'a', text: 'from a' }
  ]);
  assert.deepEqual(members.map(item => item.memberId), ['a', 'b']);
  assert.equal(members[0].text, 'from a');
  assert.equal(members[1].text, 'from b');
});
