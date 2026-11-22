import assert from 'node:assert/strict';
import test from 'node:test';
import { filterDebateCandidates } from '../out-test/main/engineering/plan-review.js';

const candidates = [
  { id: 'ollama:deepseek-r1:14b' },
  { id: 'ollama:gpt-oss:20b' },
  { id: 'opencode-go:deepseek-v4.1-flash' }
];

test('用户选中一个模型时，方案评审只使用这个模型', () => {
  assert.deepEqual(filterDebateCandidates(candidates, ['opencode-go:deepseek-v4.1-flash']).map(item => item.id), ['opencode-go:deepseek-v4.1-flash']);
});

test('没有显式选择时才沿用调用方候选', () => {
  assert.equal(filterDebateCandidates(candidates).length, 3);
  assert.equal(filterDebateCandidates(candidates, []).length, 3);
});
