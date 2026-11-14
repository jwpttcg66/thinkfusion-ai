/**
 * V3.0 P1/P2：自动质量报告与 Final Judge。
 *
 * 钉住的是边界，不是“模型说好就算好”：
 * - 规则版结论不会被冒充成模型评审；
 * - 模型评审只能标 model-assessed，不能标事实正确；
 * - undetermined 必须保留，不能被强行压成 accepted；
 * - Final Judge 不新增第三套结论状态，只映射现有五档。
 *
 * Run with: npm run test:debate-quality
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DebateStore } from '../out-test/main/debate/store.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import {
  evaluateDebateQuality,
  finalizeDebate,
  isQualityPass,
  normalizeVerdict
} from '../out-test/main/debate/quality-engine.js';

const QUESTION = '本地代码索引改成 Generation 原子快照，收益和风险是什么？';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-quality-'));
  const store = new DebateStore(dir);
  const ask = async (agentId, task) => ({
    agentId,
    text: `${agentId}：Generation 快照能避免读到一半的索引；代价是磁盘占用和清理策略更复杂。如果清理失败，旧快照会堆积。`,
    receivedAt: Date.now(),
    attribution: { requestId: 'q', note: 'test' },
    stage: task.stage,
    providerId: 'test-provider',
    modelId: agentId,
    usage: { inputTokens: 20, outputTokens: 10, cost: null }
  });
  return {
    dir,
    orchestrator: new DebateOrchestrator(store, { ask }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

async function runDebate() {
  const h = harness();
  const started = h.orchestrator.start(QUESTION, {
    strategy: 'truth',
    maxRounds: 2,
    participants: ['a', 'b'],
    convergenceStop: false
  });
  const state = await h.orchestrator.waitFor(started.debateId, 10_000);
  h.cleanup();
  assert.ok(state, '辩论应该跑完');
  assert.ok(state.verdict, '规则版应该生成结论');
  return state;
}

function modelVerdict(debateId, overrides = {}) {
  return {
    verdictId: 'judge-1',
    debateId,
    createdAt: Date.now(),
    judgeAgentId: 'independent-judge',
    backend: 'model',
    conclusion: 'Generation 原子快照值得做，但必须先定义旧快照回收策略。',
    undetermined: false,
    reason: '两位都同意收益；分歧集中在磁盘回收。',
    disagreement: '回收失败时是否保留旧快照。',
    evidence: [],
    argumentQuality: [
      { agentId: 'a', score: 0.9, why: '给出了收益与代价，并回应了回收问题', responded: true },
      { agentId: 'b', score: 0.7, why: '指出了清理失败的风险', responded: true }
    ],
    minorities: [],
    unresolved: [],
    confidence: { level: 'medium', why: '论点和风险都有文本依据，但没有实测数据' },
    sourceMessageIds: [],
    supportCount: {},
    ...overrides
  };
}

test('规则版结论：只做规则/结构评估，不冒充模型评审', async () => {
  const state = await runDebate();
  const report = evaluateDebateQuality({ state });

  assert.equal(report.modelAssessed, false);
  assert.notEqual(report.status, 'passed');
  assert.ok(['unknown', 'insufficient'].includes(report.dimensions.factualAccuracy.status));
  assert.equal(report.dimensions.factualAccuracy.status === 'supported', false);
  assert.equal(isQualityPass(report), false);

  const decision = finalizeDebate(state, state.verdict, report);
  assert.notEqual(decision.action, 'accept', '没有模型评审和外部核验，不能直接接受');
  assert.equal(decision.verdict, state.verdict.verdict, 'Final Judge 直接复用现有五档结论');
  assert.equal(decision.conclusion, state.verdict.conclusion);
});

test('模型版裁判：论证质量可标 supported，事实只能标 model-assessed', async () => {
  const state = await runDebate();
  const verdict = modelVerdict(state.debateId);
  const report = evaluateDebateQuality({ state, verdict, modelAssessed: true });

  assert.equal(report.modelAssessed, true);
  assert.equal(report.dimensions.logicalValidity.status, 'supported');
  assert.equal(report.dimensions.factualAccuracy.status, 'model-assessed');
  assert.notEqual(report.dimensions.factualAccuracy.status, 'supported', '模型评审不能变成事实正确');
  assert.match(report.explanation, /model-assessed/);
  assert.notEqual(report.recommendedAction, 'accept', '没有外部核验就不能推荐直接接受');

  const decision = finalizeDebate(state, verdict, report);
  assert.equal(decision.action, 'accept_with_caveats');
  assert.equal(decision.verdict, 'partially_supported', '模型评审没有外部核验，不能标 supported');
  assert.equal(decision.conclusion, verdict.conclusion);
  assert.ok(decision.supportingArguments.length >= 1);
});

test('undetermined 保留到 Final Judge，不强行给结论', async () => {
  const state = await runDebate();
  const verdict = modelVerdict(state.debateId, {
    conclusion: null,
    undetermined: true,
    reason: '双方对回收失败的后果都没有数据。',
    confidence: { level: 'low', why: '缺少实测数据' },
    unresolved: [{ question: '旧快照回收失败的影响有多大？', why: '没有实测', sourceMessageIds: [] }]
  });
  const report = evaluateDebateQuality({ state, verdict, modelAssessed: true });

  assert.equal(report.status, 'inconclusive');
  assert.equal(report.dimensions.uncertaintyCalibration.status, 'supported');
  assert.deepEqual(report.unresolvedDisputes, ['旧快照回收失败的影响有多大？']);

  const decision = finalizeDebate(state, verdict, report);
  assert.equal(decision.action, 'hold');
  assert.equal(decision.verdict, 'insufficient_evidence');
  assert.equal(decision.conclusion, null);
  assert.equal(decision.uncertainty.level, 'low');
});

test('backend 退回 rules 时，即使调用方误传 modelAssessed 也不冒充模型评审', async () => {
  const state = await runDebate();
  const verdict = modelVerdict(state.debateId, { backend: 'rules', fallbackReason: '模型输出解析失败' });
  const report = evaluateDebateQuality({ state, verdict, modelAssessed: true });

  assert.equal(report.modelAssessed, false);
  assert.notEqual(report.status, 'passed');
  assert.ok(report.criticalIssues.some(item => item.includes('backend')));
  assert.ok(report.criticalIssues.some(item => item.includes('规则版')));
  assert.equal(report.dimensions.logicalValidity.status, 'unknown', '规则版 argumentQuality 不能标成模型评审');
  assert.equal(isQualityPass(report), false);
});

test('归一化：规则版没有 argumentQuality/undetermined，模型版没有五档 verdict', async () => {
  const state = await runDebate();
  const rules = normalizeVerdict(state.verdict);
  assert.equal(rules.backend, 'rules');
  assert.equal(rules.argumentQuality.length, 0);
  assert.equal(rules.undetermined, state.verdict.verdict === 'insufficient_evidence');

  const judged = normalizeVerdict(modelVerdict(state.debateId));
  assert.equal(judged.backend, 'model');
  assert.equal(judged.fiveTier, null);
  assert.equal(judged.undetermined, false);
  assert.equal(judged.argumentQuality.length, 2);
});
