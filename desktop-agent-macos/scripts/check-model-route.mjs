/**
 * V2.1 Model Router（产品定义第 8 节）。
 *
 * 测的是「这一轮会用哪些模型、为什么」：网页主导 / 混合第一手仍是网页；
 * 本地 / 云端主导第一手就是对应模型，不问网页；缺成员要说出来。
 *
 * Run with: npm run test:model-route
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { routeModels, toRouteTaskKind } from '../out/shared/model-route.js';

const all = {
  web: ['chatgpt', 'gemini', 'deepseek'],
  local: ['ollama:qwen2.5:7b'],
  cloud: ['openai:gpt-4o-mini']
};

test('网页主导 / 混合：回答者仍是网页通道', () => {
  for (const mode of ['web', 'hybrid']) {
    const route = routeModels({ taskKind: 'answer', executionMode: mode, available: all });
    assert.deepEqual(route.answerers, all.web, `${mode} 模式改变了网页回答者`);
  }
});

test('本地 / 云端主导：回答者就是对应模型，不问网页', () => {
  const local = routeModels({ taskKind: 'answer', executionMode: 'local', available: all });
  assert.deepEqual(local.answerers, all.local);
  assert.deepEqual(local.synthesizers, all.local);
  const cloud = routeModels({ taskKind: 'answer', executionMode: 'cloud', available: all });
  assert.deepEqual(cloud.answerers, all.cloud);
  assert.deepEqual(cloud.synthesizers, all.cloud);
});

test('用户点名只用某几条通道时，只问那几条', () => {
  const route = routeModels({
    taskKind: 'research',
    executionMode: 'web',
    available: all,
    selectedWebChannels: ['gemini', 'kimi']
  });
  assert.deepEqual(route.answerers, ['gemini']);
});

test('网页主导由网页通道汇总，本地模型只当辩手/评审', () => {
  const route = routeModels({ taskKind: 'compare', executionMode: 'web', available: all });
  assert.equal(route.mode, 'web');
  assert.deepEqual(route.synthesizers, all.web);
  assert.deepEqual(route.executors, [...all.local, ...all.cloud]);
});

test('云端主导按勾选裁名单；点名主导人可补进', () => {
  const empty = routeModels({
    taskKind: 'answer',
    executionMode: 'cloud',
    available: all,
    selectedCloudModels: []
  });
  assert.deepEqual(empty.answerers, []);
  assert.match(empty.reason, /不退回网页/);
  const picked = routeModels({
    taskKind: 'engineering_execution',
    executionMode: 'cloud',
    available: all,
    selectedCloudModels: ['openai:gpt-4o-mini']
  });
  assert.deepEqual(picked.answerers, all.cloud);
  const leadOnly = routeModels({
    taskKind: 'answer',
    executionMode: 'cloud',
    available: all,
    selectedCloudModels: [],
    leadAgentId: 'openai:gpt-4o-mini'
  });
  assert.deepEqual(leadOnly.answerers, ['openai:gpt-4o-mini']);
  assert.deepEqual(leadOnly.synthesizers, ['openai:gpt-4o-mini']);
});

test('选了本地主导但没有本地模型时不退回网页', () => {
  const route = routeModels({
    taskKind: 'answer',
    executionMode: 'local',
    available: { ...all, local: [] }
  });
  assert.equal(route.mode, 'local');
  assert.deepEqual(route.answerers, []);
  assert.equal(route.degraded, undefined);
  assert.match(route.reason, /不退回网页/);
});

test('混合模式：短结论走本地，工程实施走云端', () => {
  const answer = routeModels({ taskKind: 'answer', executionMode: 'hybrid', available: all });
  assert.equal(answer.mode, 'local');
  const analysis = routeModels({ taskKind: 'engineering_analysis', executionMode: 'hybrid', available: all });
  assert.equal(analysis.mode, 'local');
  const execution = routeModels({ taskKind: 'engineering_execution', executionMode: 'hybrid', available: all });
  assert.equal(execution.mode, 'cloud');
  const research = routeModels({ taskKind: 'research', executionMode: 'hybrid', available: all });
  assert.equal(research.mode, 'cloud');
});

test('混合模式没有 API 成员时降级为网页主导，不假装有结论', () => {
  const route = routeModels({
    taskKind: 'compare',
    executionMode: 'hybrid',
    available: { web: all.web, local: [], cloud: [] }
  });
  assert.equal(route.mode, 'web');
  assert.match(route.degraded, /混合主导.*网页主导/);
  assert.match(route.reason, /没有可用 API 模型/);
});

test('用户点名主导人时直接采信，不再自动挑', () => {
  const route = routeModels({
    taskKind: 'answer',
    executionMode: 'hybrid',
    available: all,
    leadAgentId: 'chatgpt'
  });
  assert.deepEqual(route.synthesizers, ['chatgpt']);
  assert.match(route.reason, /主导人由用户指定/);
});

test('调用量估算是「回答者 + 一次汇总」，方便看清成本', () => {
  const route = routeModels({ taskKind: 'research', executionMode: 'web', available: all });
  assert.equal(route.estimatedCalls, all.web.length + 1);
});

test('没有任何通道时如实说明这一轮无法回答', () => {
  const route = routeModels({
    taskKind: 'answer',
    executionMode: 'web',
    available: { web: [], local: [], cloud: [] }
  });
  assert.deepEqual(route.answerers, []);
  assert.match(route.reason, /没有可用的网页通道/);
});

test('旧意图名收敛：workspace 按工程实施算，clarify 按分析算', () => {
  assert.equal(toRouteTaskKind('workspace'), 'engineering_execution');
  assert.equal(toRouteTaskKind('clarify'), 'engineering_analysis');
  assert.equal(toRouteTaskKind('research'), 'research');
});
