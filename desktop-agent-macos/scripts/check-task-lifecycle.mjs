import assert from 'node:assert/strict';
import test from 'node:test';
import { isTerminalPhase, lifecycleOfConversation, lifecycleOfTask } from '../out-test/shared/task-lifecycle.js';

test('任务与会话共享同一生命周期词汇', () => {
  assert.equal(lifecycleOfTask('awaiting_approval'), 'approval');
  assert.equal(lifecycleOfTask('executing'), 'executing');
  assert.equal(lifecycleOfTask('report_pending'), 'reviewing');
  assert.equal(lifecycleOfTask('completed'), 'completed');
  assert.equal(lifecycleOfConversation('thinking'), 'planning');
  assert.equal(lifecycleOfConversation('collecting'), 'executing');
  assert.equal(lifecycleOfConversation('synthesizing'), 'delivering');
  assert.equal(lifecycleOfConversation('answered'), 'completed');
  assert.equal(isTerminalPhase('failed'), true);
  assert.equal(isTerminalPhase('approval'), false);
});
