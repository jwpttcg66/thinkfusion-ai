/**
 * P1：Judge 选择与独立性派生。
 *
 * Run with: npm run test:debate-resolve-judge
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveJudge } from '../out-test/main/judge/resolve.js';

const candidate = (id, overrides = {}) => ({
  id,
  label: id,
  type: 'cloud',
  available: true,
  modelId: id,
  providerId: 'opencode-go',
  ...overrides
});

test('有未参与辩论的第三模型：independent-judge', () => {
  const resolution = resolveJudge({
    candidates: [candidate('a'), candidate('b'), candidate('j')],
    participants: ['a', 'b'],
    participantModelIds: ['a', 'b']
  });
  assert.equal(resolution.judgeAgentId, 'j');
  assert.equal(resolution.judgeMode, 'independent-judge');
  assert.equal(resolution.judgeIndependent, true);
  assert.equal(resolution.modelIndependence, true);
  assert.equal(resolution.sharedWith, undefined);
});

test('单模型只能自评：self-review，非独立', () => {
  const resolution = resolveJudge({
    candidates: [candidate('a')],
    participants: ['a'],
    participantModelIds: ['a']
  });
  assert.equal(resolution.judgeAgentId, 'a');
  assert.equal(resolution.judgeMode, 'self-review');
  assert.equal(resolution.judgeIndependent, false);
  assert.equal(resolution.modelIndependence, false);
  assert.equal(resolution.sharedWith, 'a');
});

test('所有候选都参辩：participant-review，非独立第三方', () => {
  const resolution = resolveJudge({
    candidates: [candidate('a'), candidate('b')],
    participants: ['a', 'b'],
    participantModelIds: ['a', 'b'],
    preferredJudgeId: 'a'
  });
  assert.equal(resolution.judgeAgentId, 'a');
  assert.equal(resolution.judgeMode, 'participant-review');
  assert.equal(resolution.judgeIndependent, false);
  assert.equal(resolution.sharedWith, 'a');
});

test('指定裁判不可用：重新选择独立候选', () => {
  const resolution = resolveJudge({
    candidates: [candidate('a'), candidate('b'), candidate('j', { available: false })],
    participants: ['a', 'b'],
    participantModelIds: ['a', 'b'],
    preferredJudgeId: 'j'
  });
  assert.equal(resolution.judgeAgentId, 'a');
  assert.equal(resolution.judgeMode, 'participant-review');
  assert.equal(resolution.judgeIndependent, false);
});

test('不同 agent 但同一模型：modelIndependence=false', () => {
  const resolution = resolveJudge({
    candidates: [candidate('a', { modelId: 'same' }), candidate('b', { modelId: 'same' }), candidate('j', { modelId: 'same' })],
    participants: ['a', 'b'],
    participantModelIds: ['same']
  });
  const picked = resolution.judgeAgentId;
  assert.ok(picked);
  assert.equal(resolution.modelIndependence, false);
  assert.equal(resolution.judgeIndependent, false);
});

test('没有可用候选：rules-fallback', () => {
  const resolution = resolveJudge({
    candidates: [candidate('a', { available: false })],
    participants: ['a'],
    participantModelIds: ['a']
  });
  assert.equal(resolution.judgeAgentId, null);
  assert.equal(resolution.judgeMode, 'rules-fallback');
  assert.equal(resolution.judgeIndependent, false);
  assert.equal(resolution.modelIndependence, false);
});
