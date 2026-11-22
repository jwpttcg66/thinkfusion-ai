/**
 * 事件身份补齐（V2.1 P1b）：step.preparing 记身份，后续事件只补缺的字段。
 *
 * 用真实事件形状跑纯函数，不 mock。最要紧的三条：查不到不臆造、已有不覆盖、
 * 新计划不让旧 stepId 串进来。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEventIdentity, forgetTask, rememberStepIdentity } from '../out-test/shared/event-identity.js';

const preparing = (over = {}) => ({
  type: 'step.preparing', taskId: 't1', roundId: 'r1', stepId: 's1', callId: 'c1',
  tool: 'fs.read', args: { path: 'a.ts' }, at: 100, eventId: 'e1', sequence: 1, runId: 't1', phase: 'execution',
  ...over
});
const started = (over = {}) => ({
  type: 'step.started', taskId: 't1', stepId: 's1', tool: 'fs.read', at: 200,
  eventId: 'e2', sequence: 2, runId: 't1', phase: 'execution', ...over
});
const completed = (over = {}) => ({
  type: 'step.completed', taskId: 't1', stepId: 's1', tool: 'fs.read', result: { ok: true }, at: 300,
  eventId: 'e3', sequence: 3, runId: 't1', phase: 'execution', ...over
});

function seed() {
  const index = new Map();
  rememberStepIdentity(index, preparing());
  return index;
}

test('preparing 记下身份后，started / completed 补齐 roundId 与 callId', () => {
  const index = seed();
  const s = applyEventIdentity(index, started());
  assert.equal(s.roundId, 'r1');
  assert.equal(s.callId, 'c1');
  const c = applyEventIdentity(index, completed());
  assert.equal(c.roundId, 'r1', '完成事件也要能对回同一张卡');
  assert.equal(c.callId, 'c1');
});

test('事件自己带的 callId 不覆盖：Runtime 明确说了就用它的', () => {
  const index = seed();
  const s = applyEventIdentity(index, started({ callId: 'own-call', roundId: 'own-round' }));
  assert.equal(s.callId, 'own-call');
  assert.equal(s.roundId, 'own-round');
});

test('没有 preparing 就什么都不补，不拿 stepId 冒充 callId', () => {
  const index = new Map();
  const s = applyEventIdentity(index, started());
  assert.equal(s.roundId, undefined);
  assert.equal(s.callId, undefined, '查不到就必须留空，别造身份');
});

test('round.delta 缺 modelCallId 时用 streamId，已有则不覆盖', () => {
  const index = new Map();
  const delta = {
    type: 'round.delta', taskId: 't1', roundId: 'r1', streamId: 'req-1', text: 'hi', at: 1,
    eventId: 'd1', sequence: 1, runId: 't1', phase: 'planning'
  };
  assert.equal(applyEventIdentity(index, delta).modelCallId, 'req-1');
  assert.equal(applyEventIdentity(index, { ...delta, modelCallId: 'mc-1' }).modelCallId, 'mc-1');
  assert.equal(applyEventIdentity(index, { ...delta, streamId: undefined }).modelCallId, undefined);
});

test('round.answer 没有 streamId 时不拿 roundId 顶替', () => {
  const index = new Map();
  const answer = { type: 'round.answer', taskId: 't1', roundId: 'r1', text: 'x', at: 1, eventId: 'a1', sequence: 1, runId: 't1', phase: 'planning' };
  assert.equal(applyEventIdentity(index, answer).modelCallId, undefined);
});

test('新计划到达：旧 stepId 的身份作废，不串到下一轮', () => {
  const index = seed();
  rememberStepIdentity(index, {
    type: 'plan.ready', taskId: 't1', roundId: 'r2', plan: { goal: 'x', steps: [] }, at: 400,
    eventId: 'p1', sequence: 4, runId: 't1', phase: 'planning'
  });
  const s = applyEventIdentity(index, { ...started({ stepId: 's1' }), at: 500 });
  assert.equal(s.roundId, undefined, '旧计划的 s1 不能被新事件复用');
});

test('一个任务的索引不影响另一个任务', () => {
  const index = seed();
  const other = applyEventIdentity(index, started({ taskId: 't2' }));
  assert.equal(other.callId, undefined);
  forgetTask(index, 't1');
  assert.equal(applyEventIdentity(index, completed()).callId, undefined, '删任务后同一 stepId 不再有身份');
});

test('participantId 只在事件没写时按索引补', () => {
  const index = new Map();
  rememberStepIdentity(index, preparing({ participantId: 'p-models' }));
  assert.equal(applyEventIdentity(index, started()).participantId, 'p-models');
  assert.equal(applyEventIdentity(index, started({ participantId: 'p-own' })).participantId, 'p-own');
});

test('attemptId 从不自动生成', () => {
  const index = seed();
  const s = applyEventIdentity(index, started());
  assert.equal(s.attemptId, undefined, '没有重试就不写，别拿 0 冒充第一次');
});
