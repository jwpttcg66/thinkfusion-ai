/**
 * 会话转工程任务时，主区曾因「showingConversation 关掉、tasks 还没有本体」
 * 直接掉进空白首页（卡住后消失）。这里锁住合并逻辑与 UI 桥接。
 *
 * Run with: npm run test:task-handoff-ui
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeTaskLists } from '../out-test/shared/task-list.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'src/renderer/src/App.tsx');

function stub(taskId, updatedAt, title = taskId) {
  return {
    taskId,
    title,
    userPrompt: title,
    status: 'running',
    permissionPreset: 'read-only',
    createdAt: updatedAt,
    updatedAt,
    maxRounds: 1,
    maxSteps: 1,
    timeoutMs: 1
  };
}

test('晚到的 getTaskHistory 不得冲掉实时挂上的更新任务', () => {
  const live = stub('t-new', 200, 'live');
  const staleHistory = [stub('t-old', 50), stub('t-new', 100, 'stale')];
  const merged = mergeTaskLists(staleHistory, [live]);
  assert.equal(merged.find(t => t.taskId === 't-new')?.title, 'live');
  assert.ok(merged.some(t => t.taskId === 't-old'));
  assert.equal(merged[0].taskId, 't-new');
});

test('历史里更新的任务可以覆盖本地更旧的缓存', () => {
  const local = stub('t1', 10, 'old');
  const incoming = [stub('t1', 20, 'fresh')];
  const merged = mergeTaskLists(incoming, [local]);
  assert.equal(merged[0].title, 'fresh');
});

test('App 在会话挂上 taskId 时选中任务并展示转入桥，而不是空白首页', () => {
  const src = readFileSync(APP, 'utf8');
  assert.match(src, /mergeTaskLists/);
  assert.match(src, /handoffPending/);
  assert.match(src, /正在转入工程工作空间/);
  assert.match(src, /getTask\(taskId\)/);
  assert.match(src, /void selectTask\(attachedTaskId\)/);
  assert.match(src, /setActiveId\(attachedTaskId\)/);
  assert.match(src, /!activeTask && !showingConversation && !handoffPending/);
});

test('工程方案议题只认计划 concerns，不再按步数套模板', () => {
  const src = readFileSync(join(ROOT, 'src/main/engineering/plan-review.ts'), 'utf8');
  assert.match(src, /主导模型未提出议题，不编造辩论/);
  assert.match(src, /plan\.concerns/);
  assert.doesNotMatch(src, /步骤拆分是否合理/);
  assert.doesNotMatch(src, /系统动作（命令\/截屏\/启动应用\/跑代码）/);
});

test('转交工程前必须先落系统提示，不能先跑 shadow plan 再让界面空等思考中', () => {
  const src = readFileSync(join(ROOT, 'src/main/conversation-runner.ts'), 'utf8');
  const handoffStart = src.indexOf('const handoff = async');
  assert.ok(handoffStart >= 0);
  const slice = src.slice(handoffStart, handoffStart + 2500);
  const msgAt = slice.indexOf('已判定为工程任务，正在生成计划并转入工程工作空间');
  const shadowAt = slice.indexOf('await buildShadowPlan');
  assert.ok(msgAt >= 0, '必须有转交提示');
  assert.ok(shadowAt >= 0, '仍会跑 shadow plan');
  assert.ok(msgAt < shadowAt, '系统提示必须早于 await buildShadowPlan');
});
