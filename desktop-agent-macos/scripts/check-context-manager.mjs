/**
 * LT-P1 Context Manager 基础：Builder / Estimator / Budget / Provider 适配。
 *
 * 不调用 Provider、不读写磁盘、不压缩。
 *
 * Run with: npm run test:context-manager
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContext } from '../out-test/main/context/builder.js';
import { estimateTextTokens, TokenEstimator } from '../out-test/main/context/estimator.js';
import { computeContextBudget, decideBudget, CONSERVATIVE_INPUT_LIMIT } from '../out-test/main/context/budget.js';
import { providerContextCapability } from '../out-test/main/context/adapters/provider-context.js';
import { DefaultContextManager } from '../out-test/main/context/manager.js';
import { prepareSubAgentTask, finalizeSubAgentTask } from '../out-test/main/context/adapters/sub-agent.js';

const taskOwner = {
  ownerType: 'agent-task',
  ownerId: 'task-1',
  taskId: 'task-1',
  runId: 'run-1'
};
const conversationOwner = {
  ownerType: 'conversation',
  ownerId: 'conv-1',
  conversationId: 'conv-1',
  runId: 'run-1'
};

const history = [
  { eventId: 'e1', kind: 'message', role: 'user', text: '写一个 hello', at: 1 },
  { eventId: 'e2', kind: 'tool', text: 'go run main.go → hello', at: 2 }
];

const baseInput = {
  owner: taskOwner,
  runId: 'run-1',
  question: '原话一个字都不能改',
  context: ['前序回答'],
  system: ['系统契约'],
  history,
  evidenceRefs: ['ev-1'],
  providerId: 'local',
  modelId: 'qwen'
};

test('Builder：原话不变，Memory 只进 system，contextId 稳定', () => {
  const input = { ...baseInput, memory: ['长期记忆 A'] };
  const a = buildContext(input);
  const b = buildContext(input);
  assert.equal(a.question, baseInput.question);
  assert.equal(a.contextId, b.contextId);
  assert.ok(a.systemLines.some(line => line.includes('长期记忆 A')));
  assert.ok(!a.contextLines.some(line => line.includes('长期记忆 A')));
  assert.deepEqual(a.includedEventIds, ['e1', 'e2']);
  assert.deepEqual(a.evidenceRefs, ['ev-1']);
});

test('Builder：Conversation owner 与 AgentTask owner 上下文 ID 不同', () => {
  const a = buildContext(baseInput);
  const b = buildContext({ ...baseInput, owner: conversationOwner });
  assert.notEqual(a.contextId, b.contextId);
});

test('Estimator：空串为 0，中文按字符估算，未知 actual 不校准', () => {
  assert.equal(estimateTextTokens(''), 0);
  assert.ok(estimateTextTokens('hello world') > 0);
  assert.ok(estimateTextTokens('你好世界') >= 4);
  const estimator = new TokenEstimator();
  const before = estimator.factorOf('m');
  estimator.recordUsage('m', 100, null);
  assert.equal(estimator.factorOf('m'), before);
  estimator.recordUsage('m', 100, 200);
  assert.notEqual(estimator.factorOf('m'), before);
});

test('Budget：已知窗口计算比例，未知窗口不给假百分比', () => {
  const known = computeContextBudget({
    providerId: 'p', modelId: 'm', contextWindow: 100_000,
    maxOutputTokens: 8_000, estimatedInputTokens: 70_000
  });
  const decision = decideBudget(known);
  assert.ok(decision.usageRatio !== null);
  assert.equal(decision.level, 'warning');

  const unknown = computeContextBudget({
    providerId: 'web', modelId: 'page', contextWindow: null,
    maxOutputTokens: null, estimatedInputTokens: 70_000
  });
  const unknownDecision = decideBudget(unknown);
  assert.equal(unknownDecision.usageRatio, null);
  assert.equal(unknownDecision.level, 'unknown');
  assert.equal(unknownDecision.inputLimit, CONSERVATIVE_INPUT_LIMIT);
});

test('Budget：配置上限可作为分母，但不伪装 Provider 窗口', () => {
  const budget = computeContextBudget({
    providerId: 'p', modelId: 'm', contextWindow: null,
    maxOutputTokens: null, estimatedInputTokens: 5_000,
    configuredInputLimit: 10_000
  });
  const decision = decideBudget(budget);
  assert.equal(budget.contextWindow, null);
  assert.equal(budget.budgetSource, 'config');
  assert.equal(decision.usageRatio, 0.5);
});

test('Provider：web/cli 永远 unknown，config 标 configured', () => {
  assert.equal(providerContextCapability({ providerId: 'web', modelId: 'p', contextTokens: 99_999, source: 'web' }).contextWindow, null);
  assert.equal(providerContextCapability({ providerId: 'cli', modelId: 'c', contextTokens: 99_999, source: 'cli' }).confidence, 'unknown');
  const config = providerContextCapability({ providerId: 'p', modelId: 'm', contextTokens: 50_000, source: 'config' });
  assert.equal(config.confidence, 'configured');
  assert.equal(config.contextWindow, 50_000);
});

test('Manager：prepare 不改原话，finalize 可校准，recover 在 P1 返回 null', async () => {
  const estimator = new TokenEstimator();
  const manager = new DefaultContextManager({
    estimator,
    capabilityOf: () => ({ providerId: 'p', modelId: 'm', contextTokens: 100_000, source: 'provider' }),
    extrasOf: () => ({ memory: ['记忆'], summary: '摘要' })
  });
  const prepared = await manager.prepare(baseInput);
  assert.equal(prepared.question, baseInput.question);
  assert.equal(prepared.context.owner.ownerType, 'agent-task');
  assert.equal(prepared.context.estimatedTokens > 0, true);
  assert.equal(manager.lastBudget(prepared.context.contextId)?.level, 'normal');
  await manager.finalize({
    contextId: prepared.context.contextId,
    owner: taskOwner,
    runId: 'run-1',
    usage: { inputTokens: 123, outputTokens: 4 },
    providerId: 'p',
    modelId: 'm'
  });
  assert.equal(await manager.recover(), null);
});


test('P4 SubAgent 适配：无 contextState 时零变化', async () => {
  const task = { question: 'q', stage: 'answer', context: ['c'], system: ['s'] };
  assert.equal(await prepareSubAgentTask(task, { providerId: 'p', modelId: 'm' }), null);
});

test('P4 SubAgent 适配：有 contextState 时只改 system/context，原话不变', async () => {
  const calls = [];
  const context = {
    contextId: 'ctx1',
    owner: taskOwner,
    taskId: 'task-1',
    runId: 'run-1',
    includedEventIds: ['e1'],
    retainedEventIds: ['e1'],
    evidenceRefs: ['ev-1'],
    estimatedTokens: 10,
    contextWindow: 1000,
    compactionStatus: 'not-needed'
  };
  const manager = {
    prepare: async input => {
      calls.push(input);
      return { context, question: input.question, contextLines: ['C2'], systemLines: ['S2'] };
    },
    finalize: async input => calls.push(input),
    recover: async () => null
  };
  const prepared = await prepareSubAgentTask({
    question: '原话',
    stage: 'answer',
    context: ['C1'],
    system: ['S1'],
    contextState: { manager, owner: taskOwner, runId: 'run-1', history, evidenceRefs: ['ev-1'] }
  }, { providerId: 'p', modelId: 'm' });
  assert.ok(prepared);
  assert.equal(prepared.task.question, '原话');
  assert.deepEqual(prepared.task.context, ['C2']);
  assert.deepEqual(prepared.task.system, ['S2']);
  assert.equal(prepared.task.contextState, undefined);
  assert.equal(calls[0].owner.ownerType, 'agent-task');
  assert.deepEqual(calls[0].history.map(item => item.eventId), ['e1', 'e2']);
  await finalizeSubAgentTask(prepared, { text: 'ok', usage: { inputTokens: 12, outputTokens: 3 } }, { providerId: 'p', modelId: 'm' });
  assert.equal(calls[1].usage.inputTokens, 12);
  assert.equal(calls[1].contextId, 'ctx1');
});
