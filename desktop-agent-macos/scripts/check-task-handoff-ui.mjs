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

test('工程方案评审与知识问答同一套：先五段再【辩题】，不按步数套模板', () => {
  const src = readFileSync(join(ROOT, 'src/main/engineering/plan-review.ts'), 'utf8');
  assert.match(src, /topicsFromLeadSummary/);
  assert.match(src, /buildPlanReviewLeadAsk/);
  assert.match(src, /结论\/一致\/分歧\/存疑\/辩题/);
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

test('工程判定前先建会话，并把模型思考推到 __routing__ 增量', () => {
  const src = readFileSync(join(ROOT, 'src/main/conversation-runner.ts'), 'utf8');
  const createdAt = src.indexOf("type: 'conversation.created'");
  const routingAt = src.indexOf('await this.engineeringRouting');
  assert.ok(createdAt >= 0 && routingAt >= 0);
  assert.ok(createdAt < routingAt, '必须先 conversation.created 再 engineeringRouting');
  assert.match(src, /__routing__/);
  assert.match(src, /判定是否转入工程工作空间/);
  // 判定一开始就推 answer.delta，首包前也有可读进度，不能干等。
  assert.match(src, /准备询问/);
  // 判定思考必须落盘为 channel 消息，不能只靠会被清空的 answer.delta。
  assert.match(src, /role: 'channel'/);
  assert.match(src, /channelId: routingChannelId/);
  const view = readFileSync(join(ROOT, 'src/renderer/src/components/ConversationView.tsx'), 'utf8');
  assert.match(view, /__routing__/);
  assert.match(view, /工程判定/);
  // 实时进度改挂 dock 胶囊；正文只保留用户消息锚点，不再插 conv-live-bottom。
  assert.match(view, /data-user-msg/);
  assert.doesNotMatch(view, /conv-live-bottom/);
  assert.doesNotMatch(view, /尚未开始向模型要思考内容/);
  const app = readFileSync(join(ROOT, 'src/renderer/src/App.tsx'), 'utf8');
  assert.match(app, /pending && active === pending\.id/);
  assert.match(app, /__routing__/);
  assert.match(app, /TaskPlanCapsule/);
  const capsule = readFileSync(join(ROOT, 'src/renderer/src/components/TaskPlanCapsule.tsx'), 'utf8');
  assert.match(capsule, /task-plan-capsule/);
  assert.match(capsule, /userTicksFromMessages/);
  assert.match(capsule, /工作计划/);
  assert.match(capsule, /resolveWorkPlanText|按问答处理/);
  assert.doesNotMatch(capsule, /正在理解任务目标…'\s*;/);
  assert.doesNotMatch(capsule, /task-plan-ticks/);
  assert.match(app, /jumpToUserMsg|cssAttrEscape/);
  assert.match(app, /UserMsgLocateRail/);
  assert.match(view, /ResizeObserver/);
  const rail = readFileSync(join(ROOT, 'src/renderer/src/components/UserMsgLocateRail.tsx'), 'utf8');
  assert.match(rail, /user-msg-locate-rail/);
  assert.match(rail, /user-msg-locate-hit/);
  assert.match(rail, /user-msg-locate-hit-bar/);
  assert.doesNotMatch(rail, /user-msg-locate-spine/);
  assert.doesNotMatch(rail, /user-msg-locate-track/);
  assert.match(rail, /没有连续粗黑竖线|等长居中短杠/);
  const shadow = readFileSync(join(ROOT, 'src/main/collaboration/engine.ts'), 'utf8');
  assert.match(shadow, /不要对全员做 health 探活/);
  assert.doesNotMatch(shadow, /new ParticipantManager\(input\.pool\)\.list\(\)/);
});

test('方案评审五段一出就要投影并分段画出，不能只留一句状态', () => {
  const debate = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8');
  assert.match(debate, /onLeadReady/);
  assert.match(debate, /撰写五段结论/);
  assert.match(debate, /askStream/);
  const orch = readFileSync(join(ROOT, 'src/main/orchestrator.ts'), 'utf8');
  assert.match(orch, /progressLeadSummary/);
  assert.match(orch, /onLeadReady/);
  const ui = readFileSync(join(ROOT, 'src/renderer/src/components/engineering/TaskConversation.tsx'), 'utf8');
  assert.match(ui, /splitSummarySections/);
  assert.match(ui, /主导五段结论/);
  const proj = readFileSync(join(ROOT, 'src/shared/task-conversation.ts'), 'utf8');
  assert.match(proj, /event\.leadSummary/);
});

test('收尾必须同时展示最终结论与目标物，不能只埋在输出页', () => {
  const panel = readFileSync(join(ROOT, 'src/renderer/src/components/CollaborationResultPanel.tsx'), 'utf8');
  assert.match(panel, /目标物/);
  assert.match(panel, /result\.conclusion\.deliverables|conclusion\?\.deliverables/);
  const chat = readFileSync(join(ROOT, 'src/renderer/src/components/engineering/TaskConversation.tsx'), 'utf8');
  assert.match(chat, /entry\.deliverables/);
  assert.match(chat, /目标物/);
  const conclusion = readFileSync(join(ROOT, 'src/shared/task-conversation.ts'), 'utf8');
  assert.match(conclusion, /deliverables:/);
});
