/**
 * Checks the conversation path against the live app — without asking anything.
 *
 * This is the check the rebuild exists for. The old build could not pass it:
 * every prompt went out with a `desktop-agent/v1` plan request attached, so the
 * answer always came back as a plan — or as nothing, when the model decided the
 * question was not a file task.
 *
 * ## Why it no longer sends a question by default
 *
 * It used to submit a real question to the real pages, and the pages keep what
 * they are sent. Every run therefore wrote a fixture question into the user's
 * own DeepSeek and ChatGPT history — `Redis连接数过高原因` and friends — where it
 * is indistinguishable from something the user typed, and where this app has no
 * way to delete it. A check that edits the account it is testing is not a check;
 * it is a leak with assertions attached.
 *
 * So the default run asserts everything that can be established without sending:
 * the readiness pill, the router's verdict for both a question and a file
 * change, and that the run leaves no trace. The ask-answer-synthesise path is
 * covered by `check-runner` / `check-synthesis` / `check-text` against fakes,
 * where nothing leaves the machine.
 *
 * `CHECK_LIVE_ASK=1 node scripts/check-conversation.mjs` runs the full live path
 * for someone who explicitly accepts that a fixture question will land in their
 * web history.
 *
 * Usage: node scripts/check-conversation.mjs   (app running with CDP on)
 */
import { connect, createChecks, findAppTarget, listTargets, sleep, waitFor } from './lib/cdp.mjs';

const liveAsk = process.env.CHECK_LIVE_ASK === '1';

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

// The pill is the one place a user looks to decide whether to wait, so it has to
// agree with reality without anyone clicking anything. It used to be read once
// at startup, before the pages had loaded, and then stayed on "0/2 · 页面尚未
// 加载" for as long as the app was open.
const expectedPill = `${usable}/${channelStatuses.length} 页面就绪`;
const pill = await waitFor(
  () => cdp.evaluate(`document.querySelector('.topbar-right .pill')?.textContent ?? ''`),
  expectedPill,
  { timeoutMs: 12000 }
);
check('顶栏的就绪数量与实际可用通道一致', pill, expectedPill);
checkTrue(
  '顶栏不再挂着过期的「页面尚未加载」',
  !(await cdp.evaluate(`document.querySelector('.status-detail')?.textContent ?? ''`)).includes('页面尚未加载')
);

// A source that has never been clicked must still be askable. When it is not,
// the pill quietly says one channel fewer and the comparison silently becomes a
// single answer — which is exactly what a 0x0 page viewport used to cause.
//
// Signed out is not that failure. A page sitting on a login screen is honestly
// unavailable, and counting it as a regression would make this check depend on
// whoever ran it last having a live session. What must never happen is a channel
// that is down for a *structural* reason: no viewport, no input, no send button.
const broken = channelStatuses.filter(status => !status.available && !/登录/.test(status.detail ?? ''));
check('没有哪个来源因为页面结构而不可用', broken.map(status => status.id).join(','), '');
for (const status of channelStatuses.filter(item => !item.available)) {
  console.log(`  → ${status.id} 不可用：${status.detail ?? '没有说明'}`);
}

const before = await cdp.evaluate('window.agentAPI.getTaskHistory()');
const beforeConversations = await cdp.evaluate('window.agentAPI.getConversations()');

// --- 1. a question is routed to a conversation, not to a task -------------
// Classified, not submitted. See the note at the top of this file.
const question = '用一句话说明 Redis 连接数过高的一个常见原因';
const routed = await cdp.evaluate(`window.agentAPI.classifyIntent(${JSON.stringify(question)})`);
check('问题被路由成研究或问答，而不是工作区任务', ['research', 'answer'].includes(routed.intent), true);
checkTrue('路由给出了理由', typeof routed.reason === 'string' && routed.reason.length > 0);

// Classify only. Submitting this sentence for real sends the planning prompt to
// a live page, and that page keeps the thread in its own history forever — the
// check would litter the account it is supposed to be testing.
const routing = await cdp.evaluate(
  `window.agentAPI.classifyIntent(${JSON.stringify('帮我修改 README.md 里的标题')})`
);
check('文件改动仍然被识别为工作区任务', routing.intent, 'workspace');
checkTrue('路由给出了理由', typeof routing.reason === 'string' && routing.reason.length > 0);

// --- 2. the UI shows the conversation workspace, not a plan ----------------
const ui = await cdp.evaluate(`(() => {
  const pane = document.querySelector('.conversation, .hero');
  return {
    hasPane: Boolean(pane),
    hasPlan: Boolean(document.querySelector('.plan-card, .plan-preview')),
    hasComposer: Boolean(document.querySelector('.composer textarea, .composer textarea[data-testid]'))
  };
})()`);
checkTrue('右侧显示的是对话工作区', ui.hasPane);
check('对话视图里没有计划卡片', ui.hasPlan, false);
checkTrue('输入框就在对话视图里', ui.hasComposer);

// --- 3. and the default run changes nothing --------------------------------
if (!liveAsk) {
  const after = await cdp.evaluate('window.agentAPI.getTaskHistory()');
  const afterConversations = await cdp.evaluate('window.agentAPI.getConversations()');
  check('默认检查没有制造执行任务', after.length, before.length);
  check('默认检查没有制造对话', afterConversations.length, beforeConversations.length);
  console.log('note  未向网页发送任何问题；要跑完整的提问→回答→综合链路，请用 CHECK_LIVE_ASK=1');
}

// --- 4. opt-in: the full ask → answer → synthesise path -------------------
if (liveAsk) {
  const started = await cdp.evaluate(`window.agentAPI.submitConversation(${JSON.stringify({ text: question })})`);
  checkTrue('提交立刻返回，不等整段回答', Boolean(started?.conversationId));
  checkTrue('没有创建执行任务', started.taskId === undefined);

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

  // A page that could not reset still answers, but it says so. Zero such notes
  // means the web session and the conversation began together.
  const resetNotes = messages.filter(message => message.role === 'system' && /没能开新会话/.test(message.text));
  check('每个通道都在网页里开了新会话', resetNotes.length, 0);
  if (resetNotes.length > 0) console.log('  →', resetNotes.map(note => note.text).join(' | '));

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

  await cdp.evaluate(`(async () => {
    const items = [...document.querySelectorAll('.task-item')];
    const target = items.find(item => (item.textContent || '').includes(${JSON.stringify(question.slice(0, 12))}));
    target?.click();
    await new Promise(resolve => setTimeout(resolve, 800));
  })()`);

  const rendered = await cdp.evaluate(`(() => {
    const pane = document.querySelector('.conversation');
    return {
      hasPane: Boolean(pane),
      bubbles: document.querySelectorAll('.bubble').length,
      cards: document.querySelectorAll('.channel-card').length,
      gridColumns: getComputedStyle(document.querySelector('.channel-grid') ?? document.body).gridTemplateColumns,
      hasPlan: Boolean(document.querySelector('.plan-card, .plan-preview')),
      overlapChips: document.querySelectorAll('.synthesis-term').length,
      title: document.querySelector('.conversation-title h2')?.textContent ?? null
    };
  })()`);

  checkTrue('右侧显示的是对话视图', rendered.hasPane);
  checkTrue('对话里有气泡', rendered.bubbles >= 1);
  // One card per answer, not one column of prose: comparing answers is the point.
  check('每个通道的回答各自成卡', rendered.cards, channelMessages.length);
  checkTrue('多通道时并排显示，而不是上下堆叠', channelMessages.length < 2 || rendered.gridColumns.split(' ').length >= 2);
  check('对话视图里没有计划卡片', rendered.hasPlan, false);
  checkTrue('综合卡片上画出了共同提到的话题', channelMessages.length < 2 || rendered.overlapChips > 0);
  checkTrue('对话标题是用户的问题', Boolean(rendered.title) && question.startsWith(rendered.title.slice(0, 6)));

  // Leave no trace in the app's own list. The page-side history cannot be
  // cleaned from here — which is exactly why this branch is opt-in.
  await cdp.evaluate(`(async () => {
    for (const item of await window.agentAPI.getConversations()) {
      if (item.conversationId === ${JSON.stringify(started.conversationId)}) {
        await window.agentAPI.deleteConversation(item.conversationId);
      }
    }
    return true;
  })()`);

  const leftover = await cdp.evaluate(`(async () => {
    const conversations = await window.agentAPI.getConversations();
    return conversations.filter(item => item.conversationId === ${JSON.stringify(started.conversationId)}).length;
  })()`);
  check('检查结束后没有留下测试对话', leftover, 0);
}

const tally = summary();
cdp.close();
process.exit(tally.fail === 0 ? 0 : 1);
