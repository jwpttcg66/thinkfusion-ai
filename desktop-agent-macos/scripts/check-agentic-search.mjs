/**
 * Agentic Search 的预算与确定性收束：纯逻辑，不连模型、不读工程。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSearchContext,
  deterministicFinalReport,
  formatSearchReport,
  DEFAULT_SEARCH_BUDGET,
  SearchBudgetManager,
  nextToolCallId,
  transitionSearchState,
  validateToolArgs
} from '../out-test/main/research/agentic-search.js';

test('预算：单题独立、累计、硬预算耗尽', () => {
  let now = 0;
  const manager = new SearchBudgetManager(
    { ...DEFAULT_SEARCH_BUDGET, maxRounds: 2, maxToolCalls: 2, maxDurationMs: 1000 },
    { now: () => now }
  );
  assert.equal(manager.canStartRound(10, 10), true);
  manager.startRound();
  manager.recordModelUsage({ inputTokens: 10, outputTokens: 5, cost: null }, 100, 40);
  assert.equal(manager.usage().inputUsageSource, 'provider');
  manager.useTool();
  manager.addEvidence(100);
  manager.startRound();
  manager.useTool();
  assert.deepEqual(manager.exhaustedDimensions().sort(), ['rounds', 'toolCalls']);
  assert.equal(manager.canStartRound(10, 10), false);
  now = 2000;
  assert.ok(manager.exhaustedDimensions().includes('durationMs'));
});

test('预算：没有 usage 时标记 estimated，不冒充真实值', () => {
  const manager = new SearchBudgetManager({ ...DEFAULT_SEARCH_BUDGET, maxRounds: 2 }, { now: () => 0 });
  manager.recordModelUsage(null, 400, 80);
  const usage = manager.usage();
  assert.equal(usage.inputUsageSource, 'estimated');
  assert.equal(usage.outputUsageSource, 'estimated');
  assert.equal(usage.inputTokens, 100); // ceil(400/4)
  assert.equal(usage.outputTokens, 20); // ceil(80/4)
});

test('确定性报告：有证据 PARTIAL，无证据 FAILED，取消 CANCELLED', () => {
  const context = createSearchContext({ model: 'test', generation: 3, budget: DEFAULT_SEARCH_BUDGET });
  context.manager.startRound();
  context.manager.useTool();
  context.evidenceRefs.push({
    path: 'src/a.ts',
    line: 2,
    excerpt: 'export const a = 1;',
    toolCallId: 'tc1',
    generation: 3,
    source: 'file_read',
    verificationStatus: 'verified'
  });
  context.toolResults.push({
    callId: 'tc1',
    toolName: 'fs.readFile',
    argsSummary: '{"path":"src/a.ts"}',
    status: 'success',
    evidenceRefs: context.evidenceRefs,
    warnings: [],
    truncated: false,
    durationMs: 1
  });

  const partial = deterministicFinalReport({
    context,
    terminationReason: 'BUDGET_EXHAUSTED',
    unresolvedQuestions: ['原问题']
  });
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.terminationReason, 'BUDGET_EXHAUSTED');
  assert.equal(partial.findings[0].confidence, 'verified');
  assert.match(formatSearchReport(partial), /Agentic Search 报告/);

  const empty = createSearchContext({ model: 'test' });
  const failed = deterministicFinalReport({ context: empty, terminationReason: 'TOOL_ERROR' });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.findings.length, 0);

  const cancelled = deterministicFinalReport({ context: empty, terminationReason: 'CANCELLED' });
  assert.equal(cancelled.status, 'CANCELLED');
});

test('上下文：新问题新预算，Generation 固定', () => {
  const a = createSearchContext({ model: 'a', generation: 3 });
  const b = createSearchContext({ model: 'b', generation: 4 });
  assert.notEqual(a.searchId, b.searchId);
  assert.notEqual(a.manager, b.manager);
  assert.equal(a.generation, 3);
  assert.equal(b.generation, 4);
});


test('Tool Contract：参数校验和 callId 唯一性', () => {
  assert.equal(validateToolArgs('fs.stat', { path: 'log.txt' }).ok, true);
  assert.equal(validateToolArgs('fs.stat', {}).ok, false);
  assert.equal(validateToolArgs('fs.stat', { path: 1 }).ok, false);
  assert.equal(validateToolArgs('fs.readFile', { path: 'a', offset: '1' }).ok, false);
  assert.equal(validateToolArgs('fs.search', { pattern: 'x', extra: true }).ok, false);
  assert.equal(validateToolArgs('fs.rm', { path: 'a' }).ok, false);

  const context = createSearchContext({ model: 'test' });
  const a1 = nextToolCallId(context, 'agent-a');
  const a2 = nextToolCallId(context, 'agent-a');
  const b1 = nextToolCallId(context, 'agent-b');
  assert.notEqual(a1, a2);
  assert.notEqual(a1, b1);
  assert.match(a1, new RegExp(`^tc_${context.searchId}_agent-a_1$`));
});

test('状态机：FINALIZING 后不能回 SEARCHING', () => {
  const context = createSearchContext({ model: 'test' });
  transitionSearchState(context, 'SEARCHING');
  transitionSearchState(context, 'OBSERVING');
  transitionSearchState(context, 'FINALIZING');
  assert.throws(() => transitionSearchState(context, 'SEARCHING'), /非法/);
  transitionSearchState(context, 'COMPLETED');
  assert.throws(() => transitionSearchState(context, 'SEARCHING'), /非法/);
});
