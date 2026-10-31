/**
 * Checks the conversation path end to end, against the live app.
 *
 * This is the check the rebuild exists for. The old build could not pass it:
 * every prompt went out with a `desktop-agent/v1` plan request attached, so the
 * answer always came back as a plan — or as nothing, when the model decided the
 * question was not a file task.
 *
 * What is asserted here:
 *   1. A plain question is routed to a conversation, not to a task.
 *   2. The answer contains no protocol block.
 *   3. The conversation renders as a conversation (bubbles), not as a plan card.
 *   4. A file change is still routed to a task — the split did not break it.
 *
 * Usage: node scripts/check-conversation.mjs   (app running with CDP on)
 */
import { connect, createChecks, findAppTarget, listTargets, sleep } from './lib/cdp.mjs';

const targets = await listTargets();
const app = findAppTarget(targets);
if (!app) throw new Error('找不到应用渲染进程；请用 --remote-debugging-port=9222 启动');

const cdp = await connect(app);
const { check, checkTrue, summary } = createChecks();

const channelStatuses = await cdp.evaluate('window.agentAPI.getChannelStatuses()');
console.log('通道状态', channelStatuses.map(status => `${status.id}:${status.available ? 'ready' : status.detail ?? 'down'}`));

const usable = channelStatuses.filter(status => status.available).length;
if (usable === 0) {
  console.error('没有可用通道，无法验证对话链路：请先在内嵌页面登录至少一个 AI。');
  cdp.close();
  process.exit(1);
}

// --- 1. a question becomes a conversation, not a task ---------------------
const before = await cdp.evaluate('window.agentAPI.getTaskHistory()');
const question = '用一句话说明 Redis 连接数过高的一个常见原因';

const started = await cdp.evaluate(`window.agentAPI.submitConversation(${JSON.stringify({ text: question })})`);
checkTrue('提交立刻返回，不等整段回答', Boolean(started?.conversationId));
check('问题被路由成研究或问答，而不是工作区任务', ['research', 'answer'].includes(started.intent), true);
checkTrue('路由给出了理由', typeof started.intentReason === 'string' && started.intentReason.length > 0);
checkTrue('没有创建执行任务', started.taskId === undefined);

// --- 2. wait for the answer ------------------------------------------------
const deadline = Date.now() + 240_000;
let conversation = started;
while (Date.now() < deadline) {
  conversation = await cdp.evaluate(`window.agentAPI.getConversation(${JSON.stringify(started.conversationId)})`);
  if (['answered', 'failed', 'cancelled'].includes(conversation.status)) break;
  await sleep(1500);
}

check('对话有结论（answered/failed/cancelled）', ['answered', 'failed', 'cancelled'].includes(conversation.status), true);

const messages = await cdp.evaluate(`window.agentAPI.getConversationMessages(${JSON.stringify(started.conversationId)})`);
const channelMessages = messages.filter(message => message.role === 'channel');
const synthesisMessages = messages.filter(message => message.role === 'synthesis');

checkTrue('至少一个通道给出了回答', channelMessages.length > 0);
checkTrue('每个回答都带着来源通道', channelMessages.every(message => typeof message.channelId === 'string'));

// The whole point: no protocol block leaked into a normal answer.
const leaked = channelMessages.filter(message => message.text.includes('desktop-agent/v1') || /"protocol"\s*:/.test(message.text));
check('回答里没有 desktop-agent/v1 协议块', leaked.length, 0);

// --- 3. two channels means a synthesis ------------------------------------
if (channelMessages.length >= 2) {
  checkTrue('多通道时生成了综合分析', synthesisMessages.length === 1);
  const synthesis = synthesisMessages[0]?.synthesis;
  checkTrue('综合分析带着结构（共识/分歧/缺口）', Boolean(synthesis) && Array.isArray(synthesis.consensus));
  checkTrue(
    '综合要么指出分歧/缺口，要么明确说明是降级结果',
    Boolean(synthesis) &&
      (synthesis.disputed.length > 0 || synthesis.gaps.length > 0 || synthesis.degraded === true)
  );
} else {
  console.log('note  只有一个通道可用，本次没有可比较对象，综合环节跳过');
}

// --- 4. the UI actually shows a conversation ------------------------------
await cdp.evaluate(`(async () => {
  const items = [...document.querySelectorAll('.task-item')];
  const target = items.find(item => (item.textContent || '').includes(${JSON.stringify(question.slice(0, 12))}));
  target?.click();
  await new Promise(resolve => setTimeout(resolve, 800));
})()`);

const ui = await cdp.evaluate(`(() => {
  const pane = document.querySelector('.conversation');
  return {
    hasPane: Boolean(pane),
    bubbles: document.querySelectorAll('.bubble').length,
    hasPlan: Boolean(document.querySelector('.plan-card, .plan-preview')),
    title: document.querySelector('.conversation-title h2')?.textContent ?? null,
    intentBadge: document.querySelector('.intent-badge')?.textContent ?? null
  };
})()`);

checkTrue('右侧显示的是对话视图', ui.hasPane);
checkTrue('对话里有气泡', ui.bubbles >= 2);
check('对话视图里没有计划卡片', ui.hasPlan, false);
checkTrue('对话标题是用户的问题', Boolean(ui.title) && question.startsWith(ui.title.slice(0, 6)));

// --- 5. a file change still goes to the task path -------------------------
const workspaceIntent = await cdp.evaluate(`window.agentAPI.submitConversation(${JSON.stringify({
  text: '帮我修改 README.md 里的标题',
  workspaceRoot: undefined
})})`);
check('文件改动仍然被识别为工作区任务', workspaceIntent.intent, 'workspace');
checkTrue(
  '没有工作区时明确失败，而不是悄悄当成聊天',
  workspaceIntent.status === 'failed' && /工作区/.test(workspaceIntent.error ?? '')
);

const after = await cdp.evaluate('window.agentAPI.getTaskHistory()');
check('一次问答没有制造执行任务', after.length, before.length);

const tally = summary();
cdp.close();
process.exit(tally.fail === 0 ? 0 : 1);
