/**
 * P3-A/B：模型裁判引用 Pack 工程证据。
 *
 * 只允许引用调用方提供的 claimId + evidenceId；relation 由模型显式给出，
 * 代码不根据“引用了代码”自动升级。非法/编造引用进入 rejected。
 *
 * Run with: npm run test:judge-pack-evidence
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { JudgeEngine } from '../out-test/main/judge/engine.js';
import { adjudicateDebate } from '../out-test/main/judge/adjudicate.js';
import { handleJudgeAdjudicate } from '../out-test/main/judge/handler.js';

const commit = 'a'.repeat(40);
const packId = 'pack_aaaaaaaaaaaaaaaa';
const evidenceId = `pack:${packId}:item_1`;

const claim = {
  claimId: 'c1',
  messageId: 'm1',
  agentId: 'a',
  roundIndex: 0,
  text: '这段代码证明了缓存会失效。',
  claimScope: 'code',
  kind: 'fact',
  kindCue: '陈述句',
  span: { messageId: 'm1', start: 0, end: 10 },
  assumptions: [],
  evidenceDrafts: [],
  status: 'proposed'
};

const message = {
  messageId: 'm1',
  roundIndex: 0,
  agentId: 'a',
  role: 'peer',
  kind: 'position',
  text: claim.text,
  createdAt: 1
};

function state({ withPack = true } = {}) {
  const evidence = {
    evidenceId,
    origin: 'repo-snapshot',
    claimIds: [],
    kind: 'source-code',
    excerpt: 'if (!cache.has(key)) return null;',
    span: { messageId: evidenceId, start: 0, end: 30 },
    sourceId: `evidence-pack:${packId}`,
    messageId: evidenceId,
    roundIndex: -1,
    url: `repo://${commit}/src/cache.ts#L10-L11`,
    finalUrl: `repo://${commit}/src/cache.ts#L10-L11`,
    fingerprint: 'fp',
    originKey: `repo:${commit}`,
    independent: true,
    verified: 'snapshot',
    assessment: '来自冻结快照',
    soleAttribution: false
  };
  return {
    debateId: 'debate-p3',
    question: '这段代码证明缓存会失效吗？',
    repository: { root: '/repo', commit, branch: 'main', dirty: false },
    config: { strategy: 'truth', maxRounds: 1, participants: ['a', 'b'], convergenceStop: false },
    rounds: [{
      index: 0,
      phase: 'analysis',
      messages: [message],
      startedAt: 1,
      endedAt: 2,
      converged: false,
      failures: [],
      claims: [claim]
    }],
    minorities: [],
    disputes: [],
    evidence: withPack ? [evidence] : [],
    packEvidence: withPack ? [evidence] : undefined,
    packEvidenceLinks: withPack ? [{
      debateId: 'debate-p3',
      claimId: 'c1',
      evidenceId,
      relation: 'context',
      source: 'pack',
      reason: '该主张引用了冻结快照 src/cache.ts:10-11'
    }] : undefined,
    createdAt: 1,
    updatedAt: 2
  };
}

const answer = (body) => ({
  agentId: 'judge',
  text: JSON.stringify(body),
  receivedAt: Date.now(),
  attribution: { requestId: 'q', note: 'test' },
  stage: 'initial'
});

const base = {
  questionType: 'FACT',
  conclusion: '不能仅凭代码存在证明缓存一定失效。',
  undetermined: false,
  reason: '代码只说明实现，不证明运行行为',
  disagreement: '无',
  unresolved: []
};

test('模型引用提供的 Pack 证据：保留 relation 与快照来源', async () => {
  let systemText = '';
  const engine = new JudgeEngine({
    judgeAgentId: 'judge',
    ask: async (agentId, task) => {
      systemText = (task.system ?? []).join('\n');
      return answer({
        ...base,
        packEvidence: [{
          claimId: 'c1',
          evidenceId,
          relation: 'context',
          reason: '代码只证明实现存在，不证明缓存一定失效',
          confidence: 'high',
          limitations: ['没有执行结果']
        }]
      });
    }
  });
  const verdict = await engine.judge(state());
  assert.match(systemText, /工程证据/);
  assert.match(systemText, new RegExp(evidenceId));
  assert.equal(verdict.packEvidence.length, 1);
  assert.equal(verdict.packEvidence[0].relation, 'context');
  assert.equal(verdict.packEvidence[0].sourceSnapshot.packId, packId);
  assert.equal(verdict.packEvidence[0].sourceSnapshot.commit, commit);
  assert.deepEqual(verdict.packEvidenceRejected, undefined);
});

test('编造 evidenceId / 非法 relation 被拒绝，不进入 packEvidence', async () => {
  const engine = new JudgeEngine({
    judgeAgentId: 'judge',
    ask: async () => answer({
      ...base,
      packEvidence: [
        {
          claimId: 'c1',
          evidenceId: 'pack:bbbbbbbbbbbbbbbb:item_9',
          relation: 'supports',
          reason: '编造',
          confidence: 'high',
          limitations: []
        },
        {
          claimId: 'c1',
          evidenceId,
          relation: 'certain',
          reason: '非法方向',
          confidence: 'high',
          limitations: []
        }
      ]
    })
  });
  const verdict = await engine.judge(state());
  assert.equal(verdict.packEvidence, undefined);
  assert.equal(verdict.packEvidenceRejected.length, 2);
  assert.ok(verdict.packEvidenceRejected.some(item => item.includes('未提供')));
  assert.ok(verdict.packEvidenceRejected.some(item => item.includes('非法 relation')));
});

test('没有 Pack 上下文：不注入工程证据提示，也不接受编造的 packEvidence', async () => {
  let systemText = '';
  const engine = new JudgeEngine({
    judgeAgentId: 'judge',
    ask: async (agentId, task) => {
      systemText = (task.system ?? []).join('\n');
      return answer({
        ...base,
        packEvidence: [{
          claimId: 'c1',
          evidenceId,
          relation: 'supports',
          reason: '编造',
          confidence: 'high',
          limitations: []
        }]
      });
    }
  });
  const verdict = await engine.judge(state({ withPack: false }));
  assert.doesNotMatch(systemText, /工程证据/);
  assert.equal(verdict.packEvidence, undefined);
  assert.ok(verdict.packEvidenceRejected.length > 0);
});

test('规则版不产生 packEvidence', async () => {
  const verdict = await new JudgeEngine({}).judge(state());
  assert.equal(verdict.backend, 'rules');
  assert.equal(verdict.packEvidence, undefined);
});

test('adjudicate 把模型 Pack 判断写进状态关联；代码-only supports 被质量标记', async () => {
  const debate = state();
  const verdict = await adjudicateDebate(debate, {
    candidates: async () => [{
      id: 'judge',
      label: 'judge',
      type: 'cloud',
      available: true,
      modelId: 'judge-model',
      providerId: 'p'
    }],
    ask: async () => answer({
      ...base,
      packEvidence: [{
        claimId: 'c1',
        evidenceId,
        relation: 'supports',
        reason: '代码这样写，所以缓存一定失效',
        confidence: 'high',
        limitations: []
      }]
    })
  });

  assert.equal(verdict.packEvidence.length, 1);
  assert.equal(debate.judgePackEvidenceLinks.length, 1);
  assert.equal(debate.judgePackEvidenceLinks[0].source, 'judge');
  assert.equal(debate.judgePackEvidenceLinks[0].relation, 'supports');
  assert.equal(debate.claimEvidenceLinksSource, 'model-judge');
  assert.ok(debate.claimEvidenceLinks.some(link => link.relation === 'supports' && link.source === 'judge'));
  assert.ok(verdict.quality.criticalIssues.some(issue => issue.includes('没有成功执行结果')));
});

test('adjudicate 的 context 判断不触发“代码-only supports”质量警告', async () => {
  const debate = state();
  const verdict = await adjudicateDebate(debate, {
    candidates: async () => [{
      id: 'judge',
      label: 'judge',
      type: 'cloud',
      available: true,
      modelId: 'judge-model',
      providerId: 'p'
    }],
    ask: async () => answer({
      ...base,
      packEvidence: [{
        claimId: 'c1',
        evidenceId,
        relation: 'context',
        reason: '只证明实现存在',
        confidence: 'medium',
        limitations: ['没有执行结果']
      }]
    })
  });
  assert.equal(debate.judgePackEvidenceLinks[0].relation, 'context');
  assert.equal(verdict.quality.criticalIssues.some(issue => issue.includes('没有成功执行结果')), false);
});

test('IPC handler：模型 Pack 关联通过 saveDebate 落盘', async () => {
  const debate = state();
  let saved = null;
  const verdict = await handleJudgeAdjudicate('debate-p3', {
    getDebate: id => (id === 'debate-p3' ? debate : null),
    saveVerdict: () => undefined,
    candidates: async () => [{
      id: 'judge',
      label: 'judge',
      type: 'cloud',
      available: true,
      modelId: 'judge-model',
      providerId: 'p'
    }],
    ask: async () => answer({
      ...base,
      packEvidence: [{
        claimId: 'c1',
        evidenceId,
        relation: 'context',
        reason: '只证明实现存在',
        confidence: 'medium',
        limitations: []
      }]
    }),
    saveDebate: stateToSave => { saved = stateToSave; }
  });
  assert.ok(saved);
  assert.equal(saved.judgePackEvidenceLinks.length, 1);
  assert.equal(saved.judgePackEvidenceLinks[0].evidenceId, evidenceId);
  assert.equal(verdict.packEvidence.length, 1);
});

test('claimScope 缺失：非 context 判断被拒绝', async () => {
  const debate = state();
  delete debate.rounds[0].claims[0].claimScope;
  const verdict = await new JudgeEngine({
    judgeAgentId: 'judge',
    ask: async () => answer({
      ...base,
      packEvidence: [{
        claimId: 'c1',
        evidenceId,
        relation: 'supports',
        reason: '代码存在',
        confidence: 'high',
        limitations: []
      }]
    })
  }).judge(debate);
  assert.equal(verdict.packEvidence, undefined);
  assert.ok(verdict.packEvidenceRejected.some(item => item.includes('claimScope')));
});

test('runtime Claim + 静态代码：supports 被拒绝', async () => {
  const debate = state();
  debate.rounds[0].claims[0].claimScope = 'runtime';
  const verdict = await new JudgeEngine({
    judgeAgentId: 'judge',
    ask: async () => answer({
      ...base,
      packEvidence: [{
        claimId: 'c1',
        evidenceId,
        relation: 'supports',
        reason: '代码存在',
        confidence: 'high',
        limitations: []
      }]
    })
  }).judge(debate);
  assert.equal(verdict.packEvidence, undefined);
  assert.ok(verdict.packEvidenceRejected.some(item => item.includes('执行证据')));
});

test('evidenceId 规范化：只允许补 pack: 前缀且必须唯一匹配', async () => {
  const debate = state();
  const raw = evidenceId.replace(/^pack:/, '');
  const verdict = await new JudgeEngine({
    judgeAgentId: 'judge',
    ask: async () => answer({
      ...base,
      packEvidence: [{
        claimId: 'c1',
        evidenceId: raw,
        relation: 'context',
        reason: '引用代码',
        confidence: 'medium',
        limitations: []
      }]
    })
  }).judge(debate);
  assert.equal(verdict.packEvidence.length, 1);
  assert.equal(verdict.packEvidence[0].evidenceId, evidenceId);
  assert.equal(verdict.packEvidence[0].normalized, true);
  assert.equal(verdict.packEvidence[0].normalizationRule, 'add-pack-prefix');
  assert.equal(verdict.packEvidence[0].rawEvidenceId, raw);
});

test('evidenceId 无法唯一匹配：拒绝，不做模糊补全', async () => {
  const debate = state();
  const verdict = await new JudgeEngine({
    judgeAgentId: 'judge',
    ask: async () => answer({
      ...base,
      packEvidence: [{
        claimId: 'c1',
        evidenceId: 'item_1',
        relation: 'context',
        reason: '引用代码',
        confidence: 'medium',
        limitations: []
      }]
    })
  }).judge(debate);
  assert.equal(verdict.packEvidence, undefined);
  assert.ok(verdict.packEvidenceRejected.some(item => item.includes('未提供')));
});
