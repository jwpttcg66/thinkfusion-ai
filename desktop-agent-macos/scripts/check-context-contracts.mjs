/**
 * LT-P0 契约冻结：owner、状态、预算与检查点类型守卫。
 *
 * 这里验证的是“契约不能悄悄变宽/变窄”，不是 Context Manager 实现。
 *
 * Run with: npm run test:context-contracts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_CONTRACT_VERSION,
  LONG_TASK_STATUSES,
  contextOwnerKey,
  isCheckpointStatus,
  isContextCompactionStatus,
  isContextOwner,
  isLongTaskStatus
} from '../out-test/shared/context.js';

test('契约版本固定为 1', () => {
  assert.equal(CONTEXT_CONTRACT_VERSION, 1);
});

test('ContextOwner：AgentTask 与 Conversation 各有独立 key', () => {
  const task = { ownerType: 'agent-task', ownerId: 'task-1', taskId: 'task-1', runId: 'run-1' };
  const conversation = { ownerType: 'conversation', ownerId: 'conv-1', conversationId: 'conv-1', runId: 'run-1' };
  assert.equal(contextOwnerKey(task), 'agent-task:task-1');
  assert.equal(contextOwnerKey(conversation), 'conversation:conv-1');
  assert.ok(isContextOwner(task));
  assert.ok(isContextOwner(conversation));
});

test('ContextOwner 拒绝伪造/缺字段对象', () => {
  assert.equal(isContextOwner(null), false);
  assert.equal(isContextOwner({}), false);
  assert.equal(isContextOwner({ ownerType: 'agent-task', ownerId: 'x' }), false);
  assert.equal(isContextOwner({ ownerType: 'conversation', ownerId: 'x', conversationId: 'x' }), false);
  assert.equal(isContextOwner({ ownerType: 'other', ownerId: 'x', runId: 'r' }), false);
});

test('检查点状态只认 prepared/committed/failed', () => {
  for (const value of ['prepared', 'committed', 'failed']) assert.ok(isCheckpointStatus(value));
  for (const value of ['running', 'done', '', null, undefined]) assert.equal(isCheckpointStatus(value), false);
});

test('压缩状态枚举完整，未知值被拒', () => {
  for (const value of ['not-needed', 'preparing', 'summarizing', 'validating', 'committed', 'failed', 'stale']) {
    assert.ok(isContextCompactionStatus(value));
  }
  assert.equal(isContextCompactionStatus('done'), false);
});

test('长任务状态先独立定义，不混入当前 TaskStatus', () => {
  assert.deepEqual([...LONG_TASK_STATUSES], ['paused', 'interrupted', 'budget_exhausted', 'blocked']);
  for (const value of LONG_TASK_STATUSES) assert.ok(isLongTaskStatus(value));
  assert.equal(isLongTaskStatus('completed'), false);
  assert.equal(isLongTaskStatus('executing'), false);
});
