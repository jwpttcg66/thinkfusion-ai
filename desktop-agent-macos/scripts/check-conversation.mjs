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
 *   5. Every channel that was asked also got a fresh session on its page, so
 *      the two sides are the same thread rather than the same page reused.
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

// --- 2b. the pages were started over --------------------------------------
// A page that could not reset still answers, but it says so. Zero such notes
// means the web session and the conversation began together.
const resetNotes = messages.filter(message => message.role === 'system' && /没能开新会话/.test(message.text));
check('每个通道都在网页里开了新会话', resetNotes.length, 0);
if (resetNotes.length > 0) console.log('  →', resetNotes.map(note => note.text).join(' | '));

// --- 3. two channels means a synthesis ------------------------------------
if (channelMessages.length >= 2) {
  checkTrue('多通道时生成了综合分析', synthesisMessages.length === 1);
  const synthesis = synthesisMessages[0]?.synthesis;
  checkTrue('综合分析带着结构（共识/分歧/缺口）', Boolean(synthesis) && Array.isArray(synthesis.consensus));
  // A bare consensus is allowed only if it is labelled unverified: "both said
  // 80%" is checkable, but checkable is not the same as confirmed.
  checkTrue(
    '综合要么指出分歧/缺口，要么说明是降级结果，要么把共识标为未经验证',
    Boolean(synthesis) &&
      (synthesis.disputed.length > 0 ||
        synthesis.gaps.length > 0 ||
        synthesis.degraded === true ||
        (synthesis.consensus.length > 0 && /不代表结论已经被验证/.test(synthesis.recommendation)))
  );
  checkTrue('综合带着共同提到的话题字段', Boolean(synthesis) && Array.isArray(synthesis.overlap));
  if (synthesis) {
    console.log(
      `  综合 degraded=${synthesis.degraded} 共识${synthesis.consensus.length} 分歧${synthesis.disputed.length} ` +
        `缺口${synthesis.gaps.length} 单方${synthesis.unique.length} 共同提到${(synthesis.overlap ?? []).join('/')}`
    );
    console.log('  →', synthesis.recommendation);
  }
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
    cards: document.querySelectorAll('.channel-card').length,
    gridColumns: getComputedStyle(document.querySelector('.channel-grid') ?? document.body).gridTemplateColumns,
    hasPlan: Boolean(document.querySelector('.plan-card, .plan-preview')),
    overlapChips: document.querySelectorAll('.synthesis-term').length,
    title: document.querySelector('.conversation-title h2')?.textContent ?? null,
    intentBadge: document.querySelector('.intent-badge')?.textContent ?? null
  };
})()`);

checkTrue('右侧显示的是对话视图', ui.hasPane);
checkTrue('对话里有气泡', ui.bubbles >= 1);
// One card per answer, not one column of prose: comparing answers is the point.
check('每个通道的回答各自成卡', ui.cards, channelMessages.length);
checkTrue('多通道时并排显示，而不是上下堆叠', channelMessages.length < 2 || ui.gridColumns.split(' ').length >= 2);
check('对话视图里没有计划卡片', ui.hasPlan, false);
// The chips are the answer to "why are these two answers worth comparing at
// all" — the recommendation text alone reads as an opinion.
checkTrue('综合卡片上画出了共同提到的话题', channelMessages.length < 2 || ui.overlapChips > 0);
checkTrue('对话标题是用户的问题', Boolean(ui.title) && question.startsWith(ui.title.slice(0, 6)));

// --- 5. a file change still goes to the task path -------------------------
// Counted here, not at the very end: the workspace submission below is allowed
// to create a task, so comparing the final count would blame the conversation
// for something the next step did on purpose.
const afterConversation = await cdp.evaluate('window.agentAPI.getTaskHistory()');
check('一次问答没有制造执行任务', afterConversation.length, before.length);

const workspaceIntent = await cdp.evaluate(`window.agentAPI.submitConversation(${JSON.stringify({
  text: '帮我修改 README.md 里的标题',
  workspaceRoot: undefined
})})`);
check('文件改动仍然被识别为工作区任务', workspaceIntent.intent, 'workspace');

// Two honest outcomes, and only two. With a remembered workspace the task is
// handed off; with none it must fail and say so. Silently becoming a chat is
// the failure this check exists for — the old build did exactly that.
const handedOff = typeof workspaceIntent.taskId === 'string';
const refusedClearly = workspaceIntent.status === 'failed' && /工作区/.test(workspaceIntent.error ?? '');
checkTrue('工作区任务要么转交执行，要么明确说没有工作区', handedOff || refusedClearly);

// --- 6. leave no trace -----------------------------------------------------
// This check drives the real app, so everything it submits is real history:
// two conversations and possibly a task land in the sidebar every run, under
// fixture titles that look like something the user typed. Deleting them at the
// end is not tidiness — a check that litters the product's own list is a check
// nobody will run twice.
await cdp.evaluate(`(async () => {
  const cleanup = { conversations: 0, tasks: 0, skipped: [] };
  const mine = ${JSON.stringify([started.conversationId, workspaceIntent.conversationId])};

  for (const item of await window.agentAPI.getConversations()) {
    if (!mine.includes(item.conversationId)) continue;
    await window.agentAPI.deleteConversation(item.conversationId);
    cleanup.conversations += 1;
  }

  const taskId = ${JSON.stringify(workspaceIntent.taskId ?? '')};
  if (taskId) {
    try {
      // A task that was only just created is still running, and a running task
      // cannot be deleted — it has to be stopped first.
      await window.agentAPI.cancelTask(taskId);
      await window.agentAPI.deleteTask(taskId);
      cleanup.tasks += 1;
    } catch (error) {
      cleanup.skipped.push(String(error).slice(0, 80));
    }
  }
  return cleanup;
})()`).then(cleanup => console.log('清理', JSON.stringify(cleanup)));

const leftover = await cdp.evaluate(`(async () => {
  const mine = ${JSON.stringify([started.conversationId, workspaceIntent.conversationId])};
  const conversations = await window.agentAPI.getConversations();
  return conversations.filter(item => mine.includes(item.conversationId)).length;
})()`);
check('检查结束后没有留下测试对话', leftover, 0);

const tally = summary();
cdp.close();
process.exit(tally.fail === 0 ? 0 : 1);
