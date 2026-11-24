/**
 * 转交工程探活：只探可能当主导的模型，并按 Provider 去重。
 *
 * Run with: npm run test:planning-health
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { planningHealthShortlist, uniqueByProvider } from '../out-test/main/engineering/planning-health.js';

const agents = [
  { id: 'opencode-go:deepseek-v4.1-flash', sourceType: 'cloud', providerId: 'opencode-go' },
  { id: 'opencode-go:gpt-6-luna', sourceType: 'cloud', providerId: 'opencode-go' },
  { id: 'opencode-go:glm-5.3', sourceType: 'cloud', providerId: 'opencode-go' },
  { id: 'ollama:qwen', sourceType: 'local', providerId: 'ollama' },
  { id: 'web:deepseek', sourceType: 'web' }
];

test('指定主导时只探这一条，不扫 OpenCode 全量模型', () => {
  const shortlist = planningHealthShortlist(agents, {
    executionMode: 'cloud',
    plannerAgentId: 'opencode-go:deepseek-v4.1-flash',
    selectedCloudModels: ['opencode-go:deepseek-v4.1-flash', 'opencode-go:gpt-6-luna']
  });
  assert.deepEqual(shortlist.map(item => item.id), ['opencode-go:deepseek-v4.1-flash']);
  assert.equal(uniqueByProvider(shortlist).length, 1);
});

test('未指定主导时，只探已选云端模型，并按 Provider 去重探活', () => {
  const shortlist = planningHealthShortlist(agents, {
    executionMode: 'cloud',
    selectedCloudModels: ['opencode-go:deepseek-v4.1-flash', 'opencode-go:gpt-6-luna']
  });
  assert.equal(shortlist.length, 2);
  assert.equal(uniqueByProvider(shortlist).length, 1, '同一 OpenCode Provider 只探一次');
});

test('本地档不混入云端模型', () => {
  const shortlist = planningHealthShortlist(agents, { executionMode: 'local' });
  assert.deepEqual(shortlist.map(item => item.id), ['ollama:qwen']);
});
