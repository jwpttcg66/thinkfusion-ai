/**
 * P0 缺口测试：Judge 独立性元数据。
 *
 * 预期失败：
 * - JudgeVerdict 目前没有 judgeMode / judgeIndependent / modelIndependence；
 * - 独立性依赖调用方手动 sharedWith，而不是从实际参与者派生；
 * - Judge 的 provider/model 身份没有记录。
 *
 * 修复后应通过。Run with: npm run test:debate-independence
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { JudgeEngine } from '../out-test/main/judge/engine.js';

const answer = text => ({
  agentId: 'judge',
  text,
  receivedAt: Date.now(),
  attribution: { requestId: 'independence', note: 'test' },
  stage: 'initial'
});

const verdictJson = '{"conclusion":"有条件成立","undetermined":false,"reason":"证据有限","disagreement":"边界不同","unresolved":[]}';

function state(agentIds = ['a']) {
  return {
    debateId: 'judge-independence',
    question: '这个结论成立吗？',
    config: { strategy: 'truth', maxRounds: 1, participants: agentIds, convergenceStop: false },
    status: 'completed',
    rounds: [{
      index: 0,
      messages: agentIds.map((agentId, index) => ({
        messageId: `${agentId}-${index}`,
        roundIndex: 0,
        agentId,
        role: index === 0 ? 'proposer' : 'critic',
        kind: 'position',
        text: `${agentId} 的观点：有条件成立。`,
        createdAt: Date.now()
      })),
      startedAt: Date.now(),
      endedAt: Date.now(),
      failures: []
    }],
    minorities: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

test('单模型自评：judgeMode=self-review，非独立', async () => {
  const engine = new JudgeEngine({
    judgeAgentId: 'a',
    participants: ['a'],
    ask: async () => answer(verdictJson)
  });
  const verdict = await engine.judge(state(['a']));
  assert.equal(verdict.judgeMode, 'self-review');
  assert.equal(verdict.judgeIndependent, false);
  assert.equal(verdict.modelIndependence, false);
  assert.equal(verdict.judgeModelId, 'a');
});

test('参与者复评：judgeMode=participant-review，非独立第三方', async () => {
  const engine = new JudgeEngine({
    judgeAgentId: 'a',
    participants: ['a', 'b'],
    ask: async () => answer(verdictJson)
  });
  const verdict = await engine.judge(state(['a', 'b']));
  assert.equal(verdict.judgeMode, 'participant-review');
  assert.equal(verdict.judgeIndependent, false);
  assert.equal(verdict.modelIndependence, false);
});

test('未参与辩论的第三模型：judgeMode=independent-judge', async () => {
  const engine = new JudgeEngine({
    judgeAgentId: 'judge',
    participants: ['a', 'b'],
    ask: async () => answer(verdictJson)
  });
  const verdict = await engine.judge(state(['a', 'b']));
  assert.equal(verdict.judgeMode, 'independent-judge');
  assert.equal(verdict.judgeIndependent, true);
  assert.equal(verdict.modelIndependence, true);
  assert.equal(verdict.judgeModelId, 'judge');
});
