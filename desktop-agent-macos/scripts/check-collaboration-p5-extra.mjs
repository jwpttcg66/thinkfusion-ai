/** P5-03/05：通道声明校验、发布矩阵。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateChannelSpec } from '../out-test/main/collaboration/channel-template.js';
import { runReleaseMatrix } from '../out-test/main/collaboration/matrix.js';

test('网页声明 system/工具被拒绝', () => {
  const result = validateChannelSpec({
    id: 'w', kind: 'web', requiresLogin: false, declaredCapabilities: ['knowledge'],
    capabilities: { kind: 'web', canSystemPrompt: true, canUseTools: false, canStream: true, canSeeOtherAgents: false, maxConcurrency: 1, costClass: 'low' }
  });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(','), /system/);
});

test('合法声明通过；发布矩阵 5 组通过', () => {
  assert.equal(validateChannelSpec({
    id: 'c', kind: 'cloud', requiresLogin: true, declaredCapabilities: ['reasoning'],
    capabilities: { kind: 'cloud', canSystemPrompt: true, canUseTools: true, canStream: true, canSeeOtherAgents: true, maxConcurrency: 2, costClass: 'medium', requiresLogin: true }
  }).ok, true);
  assert.deepEqual(runReleaseMatrix(), { ok: true, failures: [] });
});
