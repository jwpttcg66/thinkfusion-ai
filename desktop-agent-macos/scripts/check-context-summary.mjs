/**
 * LT-P3 摘要 Schema / Validator / Summarizer。
 *
 * Run with: npm run test:context-summary
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateContextSummary,
  hashContextSummary
} from '../out-test/main/context/compaction/summary.js';
import {
  parseContextSummary,
  summarizeHistory,
  SummaryTimeoutError,
  SummaryValidationError
} from '../out-test/main/context/compaction/summarizer.js';

const owner = { ownerType: 'agent-task', ownerId: 't1', taskId: 't1', runId: 'r1' };
const history = [
  { eventId: 'e1', kind: 'message', role: 'user', text: '目标', at: 1 },
  { eventId: 'e2', kind: 'tool', text: '测试通过', at: 2 }
];
const evidenceRefs = ['ev-1'];

const summary = {
  goal: '完成目标',
  constraints: ['不改用户原话'],
  completed: [{ text: '完成实现', certainty: 'verified', eventIds: ['e1', 'e2'] }],
  decisions: [{ text: '采用方案 A', status: 'active', eventIds: ['e1'] }],
  evidence: [{ ref: 'ev-1', kind: 'test', eventIds: ['e2'] }],
  openIssues: [],
  currentStep: '交付',
  nextActions: ['检查'],
  risks: [],
  stopConditions: ['用户取消']
};

const context = { eventIds: new Set(['e1', 'e2']), evidenceRefs: new Set(evidenceRefs) };

test('摘要 Validator：有事件/证据的摘要通过，hash 稳定', () => {
  const result = validateContextSummary(summary, context);
  assert.equal(result.ok, true, result.reasons.join('；'));
  assert.equal(hashContextSummary(summary), hashContextSummary(structuredClone(summary)));
});

test('摘要 Validator：无证据的完成声明被拒', () => {
  const forged = {
    ...summary,
    completed: [{ text: '测试通过', certainty: 'verified', eventIds: [] }],
    evidence: []
  };
  const result = validateContextSummary(forged, context);
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('；'), /没有事件依据/);
});

test('摘要 Validator：不存在的事件/证据被拒', () => {
  const bad = {
    ...summary,
    completed: [{ text: 'x', certainty: 'verified', eventIds: ['missing'] }],
    evidence: [{ ref: 'missing-ev', kind: 'test', eventIds: ['missing'] }]
  };
  const result = validateContextSummary(bad, context);
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('；'), /不存在事件/);
  assert.match(result.reasons.join('；'), /不存在证据/);
});

test('摘要 Validator：superseded 必须写 supersededBy', () => {
  const bad = {
    ...summary,
    decisions: [{ text: '旧方案', status: 'superseded', eventIds: ['e1'] }]
  };
  const result = validateContextSummary(bad, context);
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('；'), /supersededBy/);
});

test('Summarizer：解析围栏 JSON，返回 hash 与完整来源', async () => {
  const result = await summarizeHistory(
    { owner, runId: 'r1', history, evidenceRefs, modelId: 'm' },
    { ask: async () => '```json\n' + JSON.stringify(summary) + '\n```' }
  );
  assert.equal(result.summary.goal, summary.goal);
  assert.deepEqual(result.sourceEventIds, ['e1', 'e2']);
  assert.match(result.summaryHash, /^sha256:/);
});

test('Summarizer：校验失败不返回摘要', async () => {
  const forged = { ...summary, completed: [{ text: '测试通过', certainty: 'verified', eventIds: [] }], evidence: [] };
  await assert.rejects(
    () => summarizeHistory(
      { owner, runId: 'r1', history, evidenceRefs, modelId: 'm' },
      { ask: async () => JSON.stringify(forged) }
    ),
    error => error instanceof SummaryValidationError
  );
});

test('Summarizer：超时抛明确错误，不提交半成品', async () => {
  await assert.rejects(
    () => summarizeHistory(
      { owner, runId: 'r1', history, evidenceRefs, modelId: 'm', timeoutMs: 20 },
      { ask: () => new Promise(() => {}) }
    ),
    error => error instanceof SummaryTimeoutError
  );
});

test('parseContextSummary 去掉 Markdown 围栏', () => {
  assert.equal(parseContextSummary('```json\n' + JSON.stringify(summary) + '\n```').goal, summary.goal);
});
