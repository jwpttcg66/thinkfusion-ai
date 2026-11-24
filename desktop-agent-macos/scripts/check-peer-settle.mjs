/**
 * 旁听收尾后才进入计划/评审（回归）。
 *
 * 真机问题：主导几秒就返回计划，方案评审立即开始，但旁听模型还在输出；
 * 界面同时显示「评审中」和「输出中」。这里锁定顺序：
 * 所有旁听先 answered/failed，再出现 plan.ready。
 *
 * Run with: npm run test:peer-settle
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgentStore } from '../out-test/main/store.js';
import { TaskManager } from '../out-test/main/task-manager.js';
import { AgentOrchestrator } from '../out-test/main/orchestrator.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-peer-settle-'));
const store = new AgentStore(path.join(dir, 'agent-store.json'));
const events = [];
const tasks = new TaskManager(store, event => events.push(event));
const workspace = path.join(dir, 'workspace');
fs.mkdirSync(workspace, { recursive: true });

function snapshot() {
  return {
    messageCount: 0,
    lastText: '',
    url: 'stub://',
    capturedAt: Date.now(),
    conversationText: '',
    composerText: ''
  };
}

function planFromPrompt(prompt) {
  const taskId = /taskId：(\S+)/.exec(prompt)?.[1];
  const roundId = /roundId：(\S+)/.exec(prompt)?.[1];
  assert.ok(taskId && roundId, 'prompt 必须带 taskId/roundId');
  return '```json\n' + JSON.stringify({
    protocol: 'desktop-agent/v1',
    type: 'plan',
    taskId,
    roundId,
    title: '旁听收尾测试',
    description: '只读一个文件，不执行。',
    kind: 'implementation',
    steps: [{ id: 's1', tool: 'fs.readFile', args: { path: 'package.json' }, description: '读文件' }],
    completion: { condition: '读到文件' }
  }) + '\n```';
}

function adapter(label, delayMs, textOf) {
  return {
    siteLabel: label,
    concurrent: true,
    getStatus: async () => ({
      url: `stub://${label}`,
      pageReady: true,
      loggedIn: true,
      hasInput: true,
      hasSendButton: true,
      generating: false,
      messageCount: 0
    }),
    sendMessage: async (text, requestId, onDelta) => {
      onDelta?.({ text: '…', mode: 'snapshot' });
      return {
        submitted: true,
        snapshotBefore: snapshot(),
        method: 'stub',
        signals: [],
        waitedMs: 0
      };
    },
    waitForAnswer: async (requestId, snap, timeoutMs, sentText = '') => {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return textOf(sentText);
    },
    newConversation: async () => ({ ok: true, method: 'stub' }),
    cancelWait: () => {}
  };
}

test('旁听未收尾时不进入 plan.ready', async () => {
  const lead = adapter('lead', 5, planFromPrompt);
  const peer = adapter('peer', 220, () => '旁听完成');
  const orchestrator = new AgentOrchestrator({
    tasks,
    store,
    adapter: () => lead,
    emit: event => events.push(event),
    dbPath: () => path.join(dir, 'journal.json')
  });

  const task = await orchestrator.submit({
    prompt: '只看一下 package.json',
    permissionPreset: 'read-only',
    workspaceRoot: workspace,
    planDebate: 'off',
    planners: [
      { id: 'lead', label: '主导', adapter: lead },
      { id: 'peer', label: '旁听', adapter: peer }
    ]
  });

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const status = tasks.get(task.taskId).status;
    if (status === 'plan_ready' || status === 'awaiting_approval' || status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.ok(['plan_ready', 'awaiting_approval'].includes(tasks.get(task.taskId).status));
  const peerAnswered = events.find(event =>
    event.type === 'round.peer' && event.memberId === 'peer' && event.status === 'answered'
  );
  const planReady = events.find(event => event.type === 'plan.ready' && event.taskId === task.taskId);
  assert.ok(peerAnswered, '旁听必须有 answered 事件');
  assert.ok(planReady, '必须生成计划');
  assert.ok(
    peerAnswered.at <= planReady.at,
    `旁听 answered(${peerAnswered.at}) 必须早于 plan.ready(${planReady.at})`
  );
  // 旁听在 220ms 后才回答；如果提前返回，plan.ready 会在 200ms 内出现。
  assert.ok(planReady.at - task.createdAt >= 150, 'plan.ready 不能早于旁听收尾');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function streamingAdapter(label, totalMs, textOf) {
  return {
    ...adapter(label, 0, textOf),
    streamIdleTimeout: true,
    sendMessage: async (text, requestId, onDelta) => {
      // 在 waitForAnswer 之前持续吐字；总时长远超 planningIdleMs。
      void (async () => {
        for (let index = 0; index < 8; index += 1) {
          onDelta?.({ text: `块${String(index)}`, mode: 'snapshot' });
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      })();
      return {
        submitted: true,
        snapshotBefore: snapshot(),
        method: 'stub',
        signals: [],
        waitedMs: 0
      };
    },
    waitForAnswer: async (requestId, snap, timeoutMs, sentText = '') => {
      await new Promise(resolve => setTimeout(resolve, totalMs));
      return textOf(sentText);
    }
  };
}

test('规划看门狗按「无输出」计时：持续吐字时不因总时长被杀', async () => {
  const lead = streamingAdapter('lead', 180, planFromPrompt);
  const peer = streamingAdapter('peer', 180, () => '旁听完成');
  const orchestrator = new AgentOrchestrator({
    tasks,
    store,
    adapter: () => lead,
    emit: event => events.push(event),
    dbPath: () => path.join(dir, 'journal.json'),
    planningIdleMs: 70
  });
  const task = await orchestrator.submit({
    prompt: '持续输出测试',
    permissionPreset: 'read-only',
    workspaceRoot: workspace,
    planDebate: 'off',
    planners: [
      { id: 'lead', label: '主导', adapter: lead },
      { id: 'peer', label: '旁听', adapter: peer }
    ]
  });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const status = tasks.get(task.taskId).status;
    if (['plan_ready', 'awaiting_approval', 'failed'].includes(status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.notEqual(tasks.get(task.taskId).status, 'failed', '持续输出不应触发规划超时');
  assert.ok(['plan_ready', 'awaiting_approval'].includes(tasks.get(task.taskId).status));
});
