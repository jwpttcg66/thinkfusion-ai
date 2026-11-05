/**
 * Behaviour tests for the web-page channel.
 *
 * The parts that broke were never the DOM — they were the timing rules: when a
 * page counts as having accepted a request, and which text belongs to it. Those
 * rules cannot be checked by reading the code, and they cannot be checked
 * against a live page in CI, so this file drives the real adapter through a
 * scripted page: every probe observation is written out explicitly, and a
 * regression fails on the sequence rather than on a sleep.
 *
 * Run with: npm run test:adapter
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const { ChatPageDriver, callPage, DEFAULT_TUNING, selectAnswerText, answerLooksComplete, isOwnPromptEcho, transcriptHasPrompt, PROBE_VERSION, deleteChatScriptForSyntaxCheck, CITATIONS_SCRIPT } = await import(
  path.join(root, 'out/adapter/main/adapters/browser/page-driver.js')
);
const { DEEPSEEK_HOSTS, DEEPSEEK_SELECTORS, isAllowedDeepSeekUrl } = await import(
  path.join(root, 'out/adapter/main/adapters/providers/deepseek.js')
);
const { buildInitialPrompt, parseAnswer, stripEcho, containsEcho } = await import(path.join(root, 'out/adapter/shared/protocol.js'));

// ---------------------------------------------------------------------------
// A page whose every observation is written down in advance.
// ---------------------------------------------------------------------------

function state(overrides = {}) {
  return {
    url: 'https://chat.deepseek.com/',
    title: 'DeepSeek',
    hasPasswordField: false,
    hasInput: true,
    inputKind: 'contenteditable',
    hasSendButton: true,
    generating: false,
    messageCount: 0,
    lastText: '',
    conversationText: '',
    composerText: '',
    selectorHits: {},
    chosen: {},
    ...overrides
  };
}

/**
 * @param {object[]} observations - exact sequence of probe results; the last
 *   one repeats forever, so a test only writes the transitions it cares about.
 *   The sequence applies up to the click; `afterNewChat` / `afterReload` are
 *   what the page reports once the click or the reload actually happened.
 *   Without that split, one list has to describe both "the old thread is still
 *   there" and "the page is blank", and a test that waits for the blank state
 *   ends up proving only that the list ran out.
 * @param {{fillOk?: boolean, clickOk?: boolean, newChatOk?: boolean, loading?: boolean,
 *   afterNewChat?: object[], afterReload?: object[]}} options
 */
function scriptedPage(observations, options = {}) {
  const calls = { fill: 0, click: 0, enter: 0, probe: 0, newChat: 0, reload: 0, clear: 0 };
  let sequence = observations;
  let index = 0;
  let currentUrl = options.url ?? 'https://chat.deepseek.com/';

  return {
    calls,
    url: () => currentUrl,
    isDestroyed: () => false,
    /** `true` reproduces a page whose load never settles (Gemini's case). */
    isLoading: () => options.loading === true,
    async probe() {
      calls.probe += 1;
      const hit = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return { ...hit };
    },
    async fill() {
      calls.fill += 1;
      return options.fillOk === false ? { ok: false, reason: 'INPUT_NOT_FOUND' } : { ok: true, kind: 'contenteditable' };
    },
    async clickSend() {
      calls.click += 1;
      return options.clickOk === false ? { ok: false, reason: 'SEND_BUTTON_NOT_FOUND' } : { ok: true };
    },
    async clearComposer() {
      calls.clear += 1;
      return options.clearOk === false ? { ok: false, reason: 'INPUT_NOT_FOUND' } : { ok: true };
    },
    async pressEnter() {
      calls.enter += 1;
    },
    async newChat() {
      calls.newChat += 1;
      if (options.newChatOk === false) return { ok: false, reason: 'NEW_CHAT_BUTTON_NOT_FOUND' };
      if (options.afterNewChat) {
        sequence = options.afterNewChat;
        index = 0;
      }
      if (options.urlAfterNewChat) currentUrl = options.urlAfterNewChat;
      return { ok: true, method: 'label' };
    },
    async reloadHome() {
      calls.reload += 1;
      if (options.reloadOk === false) return { ok: false, reason: 'NAV_FAILED' };
      if (options.afterReload) {
        sequence = options.afterReload;
        index = 0;
      }
      if (options.urlAfterReload) currentUrl = options.urlAfterReload;
      return { ok: true };
    }
  };
}

const FAST = { pollMs: 5, settleMs: 20, enterAfterMs: 4000, clickRetryAfterMs: 8000 };

function adapterFor(page, tuning = {}) {
  const adapter = new ChatPageDriver(() => page, {
    hosts: DEEPSEEK_HOSTS,
    selectors: DEEPSEEK_SELECTORS,
    siteLabel: 'DeepSeek'
  });
  adapter.configure({ ...FAST, ...tuning });
  return adapter;
}

// ---------------------------------------------------------------------------
// Submission: the false negative that made a working send look broken
// ---------------------------------------------------------------------------

test('a slow page that eventually clears the composer counts as submitted', async () => {
  // The old implementation probed once at 600ms and threw. Here the page needs
  // three polls before it reacts, which is normal on a cold connection.
  const page = scriptedPage([
    state(), // snapshot before send
    state({ composerText: 'hello' }), // after filling
    state({ composerText: 'hello' }),
    state({ composerText: 'hello' }),
    state({ composerText: '', messageCount: 1, conversationText: 'hello' })
  ]);

  const outcome = await adapterFor(page, { confirmMs: 5000 }).sendMessage('hello', 'r1');

  assert.equal(outcome.submitted, true);
  assert.ok(outcome.signals.includes('composer:cleared'), `signals: ${outcome.signals.join(',')}`);
  assert.equal(page.calls.click, 1, 'submission is attempted with one click');
  assert.equal(page.calls.enter, 0, 'a page that reacts must not be escalated to a keystroke');
});

test('a new message counts as submitted even when the composer text is invisible', async () => {
  const page = scriptedPage([
    state(),
    state({ composerText: '' }), // page does not reflect the text back
    state({ messageCount: 1, conversationText: 'hello' })
  ]);

  const outcome = await adapterFor(page).sendMessage('hello', 'r1');
  assert.equal(outcome.submitted, true);
  assert.ok(outcome.signals.includes('messages:grew'));
});

test('a page that never reacts fails loudly instead of silently', async () => {
  const page = scriptedPage([state(), state({ composerText: 'hello' })]);

  await assert.rejects(
    () => adapterFor(page, { confirmMs: 120, enterAfterMs: 20, clickRetryAfterMs: 60 }).sendMessage('hello', 'r1'),
    error => {
      assert.match(error.message, /SEND_UNCONFIRMED/);
      assert.match(error.message, /已尝试/, 'the failure must report what was tried');
      return true;
    }
  );
});

test('escalates to a real keystroke when the click does nothing', async () => {
  // A wrong or inert control must not end the attempt: the composer still holds
  // the text, so the adapter tries the next thing a user would try.
  const page = scriptedPage([state(), state({ composerText: 'hello' })]);
  await assert.rejects(() =>
    adapterFor(page, { confirmMs: 150, enterAfterMs: 10, clickRetryAfterMs: 400 }).sendMessage('hello', 'r1')
  );
  assert.ok(page.calls.enter >= 1, 'an inert click must escalate to a keystroke');
});

test('a rewritten transcript does not count while the composer still holds the text', async () => {
  // Switching conversation replaces the whole transcript. Treating that as
  // evidence reported the task as sent while the prompt was still unsent, and
  // the round then timed out waiting for an answer nobody had asked for.
  const page = scriptedPage([
    state({ conversationText: 'old chat', composerText: '' }),
    state({ composerText: 'hello' }), // after filling
    state({ conversationText: '', composerText: 'hello' }), // navigated to a new chat
    state({ conversationText: '', composerText: 'hello' }),
    state({ conversationText: '', composerText: 'hello' })
  ]);

  await assert.rejects(
    () => adapterFor(page, { confirmMs: 60, enterAfterMs: 4000, clickRetryAfterMs: 8000 }).sendMessage('hello', 'r1'),
    /SEND_UNCONFIRMED/
  );
});

test('never sends twice when the page reacts immediately', async () => {
  const page = scriptedPage([state(), state({ composerText: 'hello' }), state({ composerText: '', messageCount: 1 })]);
  await adapterFor(page).sendMessage('hello', 'r1');
  assert.equal(page.calls.click, 1, 'exactly one click');
  assert.equal(page.calls.enter, 0, 'no escalation after a successful send');
});

test('文字发出去后还留在输入框里，会被清掉', async () => {
  // 真机上见过：站点只清它自己认识的那份文档，页面上另一份残留一直挂着。
  // 语气上是「这条没发出去」，所以确认发送之后要主动清一次。
  const page = scriptedPage([
    state(),
    state({ composerText: 'hello' }),
    state({ composerText: 'hello', generating: true })
  ]);
  const outcome = await adapterFor(page).sendMessage('hello', 'r1');
  assert.equal(outcome.submitted, true);
  assert.equal(page.calls.clear, 1, '发送成功后清一次输入框');
  assert.ok(outcome.signals.includes('composer:cleared-after-send'));
});

test('输入框已经自己清干净时，不再多按一次清零', async () => {
  const page = scriptedPage([state(), state({ composerText: 'hello' }), state({ composerText: '', messageCount: 1 })]);
  await adapterFor(page).sendMessage('hello', 'r1');
  assert.equal(page.calls.clear, 0, '站点自己清了就不用再动它');
});

test('a composer that cannot be filled is refused before any click', async () => {
  const page = scriptedPage([state()], { fillOk: false });
  await assert.rejects(
    () => adapterFor(page).sendMessage('hello', 'r1'),
    /无法写入输入框：INPUT_NOT_FOUND/
  );
  assert.equal(page.calls.enter, 0, 'nothing may be submitted when the text never landed');
  assert.equal(page.calls.click, 0, 'nothing may be clicked when the text never landed');
});

// ---------------------------------------------------------------------------
// Completeness: a streamed prefix is not an answer
// ---------------------------------------------------------------------------

test('an unclosed JSON object is not a finished answer', () => {
  assert.equal(answerLooksComplete('json\n复制\n下载\n{'), false);
  assert.equal(answerLooksComplete('{"a": 1'), false);
  assert.equal(answerLooksComplete('{"a": "unterminated'), false);
  assert.equal(answerLooksComplete('{"a": 1}'), true);
  assert.equal(answerLooksComplete('{"a": "}"}'), true, 'a brace inside a string does not count');
  assert.equal(answerLooksComplete('纯文本回答'), true);
});

test('a prefix that pauses mid-stream is not returned', async () => {
  const snapshot = {
    messageCount: 0, lastText: '', url: '', capturedAt: 0, conversationText: '', composerText: ''
  };

  // The page stops growing for a while mid-object, then finishes. Accepting the
  // pause produced a 36-character "answer" that parsed as nothing.
  const partial = '{"protocol": "desktop-agent/v1", "type": "plan", "steps": [';
  const complete = '{"protocol": "desktop-agent/v1", "type": "plan", "steps": []}';
  const page = scriptedPage([
    state({ conversationText: partial }),
    state({ conversationText: partial }),
    state({ conversationText: partial }),
    state({ conversationText: partial }),
    state({ conversationText: complete }),
    state({ conversationText: complete }),
    state({ conversationText: complete }),
    state({ conversationText: complete })
  ]);

  const answer = await adapterFor(page, { pollMs: 5, settleMs: 10 }).waitForAnswer('r1', snapshot, 3000);
  assert.equal(answer, complete);
});

test('a candidate that still contains the prompt is skipped', async () => {
  const prompt = '你是本地 Desktop Agent 的任务规划引擎，请分析下面的用户任务并输出执行计划，不要执行任何操作。';
  const snapshot = {
    messageCount: 0, lastText: '', url: '', capturedAt: 0, conversationText: '', composerText: ''
  };

  const page = scriptedPage([
    state({ conversationText: prompt }), // the user bubble only
    state({ conversationText: prompt }),
    state({ conversationText: prompt }),
    state({ conversationText: `${prompt}\n{"protocol": "desktop-agent/v1", "type": "task_complete"}` }),
    state({ conversationText: `${prompt}\n{"protocol": "desktop-agent/v1", "type": "task_complete"}` }),
    state({ conversationText: `${prompt}\n{"protocol": "desktop-agent/v1", "type": "task_complete"}` }),
    state({ conversationText: `${prompt}\n{"protocol": "desktop-agent/v1", "type": "task_complete"}` })
  ]);

  const answer = await adapterFor(page, { pollMs: 5, settleMs: 10 }).waitForAnswer('r1', snapshot, 3000, prompt);
  assert.equal(answer.trim(), '{"protocol": "desktop-agent/v1", "type": "task_complete"}');
  assert.equal(containsEcho(answer, prompt), false);
});

// ---------------------------------------------------------------------------
// Answer ownership
// ---------------------------------------------------------------------------

test('an unchanged page never yields an answer', async () => {
  const page = scriptedPage([state({ conversationText: 'old', messageCount: 1, lastText: 'old' })]);
  await assert.rejects(
    () => adapterFor(page, { pollMs: 5 }).waitForAnswer('r1', {
      messageCount: 1,
      lastText: 'old',
      url: 'https://chat.deepseek.com/',
      capturedAt: Date.now(),
      conversationText: 'old',
      composerText: ''
    }, 80),
    /ANSWER_TIMEOUT/
  );
});

test('a streaming answer is only returned once it stops changing', async () => {
  const snapshot = {
    messageCount: 1,
    lastText: 'old',
    url: 'https://chat.deepseek.com/',
    capturedAt: Date.now(),
    conversationText: 'old',
    composerText: ''
  };

  const page = scriptedPage([
    state({ conversationText: 'old{"partial', messageCount: 2, lastText: '{"partial' }),
    state({ conversationText: 'old{"partial":{"a"', messageCount: 2, lastText: '{"partial":{"a"' }),
    state({ conversationText: 'old{"final":true}', messageCount: 2, lastText: '{"final":true}' }),
    state({ conversationText: 'old{"final":true}', messageCount: 2, lastText: '{"final":true}' }),
    state({ conversationText: 'old{"final":true}', messageCount: 2, lastText: '{"final":true}' }),
    state({ conversationText: 'old{"final":true}', messageCount: 2, lastText: '{"final":true}' }),
    state({ conversationText: 'old{"final":true}', messageCount: 2, lastText: '{"final":true}' })
  ]);

  const answer = await adapterFor(page, { pollMs: 5, settleMs: 15 }).waitForAnswer('r1', snapshot, 4000, 'ignored');
  assert.equal(answer, '{"final":true}');
});

test('a page that drops its stop control is done, without waiting out the stillness rule', async () => {
  // The stop control is on the page exactly while text is still arriving. When
  // it goes away the stream has ended — that is a statement, not the inference
  // from stillness the old rule had to make, and a thinking model is perfectly
  // still without being finished. Requiring three identical polls anyway put
  // ~2s of our own waiting on top of every answer, which is most of why the app
  // felt slower than the same page in a browser.
  const snapshot = {
    messageCount: 1,
    lastText: 'old',
    url: 'https://chat.deepseek.com/',
    capturedAt: Date.now(),
    conversationText: 'old',
    composerText: ''
  };
  const done = state({ conversationText: 'old 四十七', messageCount: 2, lastText: '四十七', generating: false });
  const streaming = state({ conversationText: 'old 四十七', messageCount: 2, lastText: '四十七', generating: true });
  const page = scriptedPage([streaming, streaming, done, done]);

  const startedAt = Date.now();
  const answer = await adapterFor(page, { pollMs: 5, settleMs: 2000 }).waitForAnswer('r1', snapshot, 8000);
  const took = Date.now() - startedAt;

  assert.equal(answer, '四十七');
  assert.ok(took < 500, `returned after ${String(took)}ms; the stop control going away should not cost a stillness window`);
});

test('a page with no stop control still waits for the stillness rule', async () => {
  // The fast path above must not become "the first repeated reading is the
  // answer" on pages that never report a stop control — a pause inside a
  // streaming answer looks exactly like that.
  const snapshot = {
    messageCount: 1,
    lastText: 'old',
    url: 'https://chat.deepseek.com/',
    capturedAt: Date.now(),
    conversationText: 'old',
    composerText: ''
  };
  const done = state({ conversationText: 'old 四十七', messageCount: 2, lastText: '四十七' });
  const page = scriptedPage([done]);

  const startedAt = Date.now();
  const answer = await adapterFor(page, { pollMs: 5, settleMs: 300 }).waitForAnswer('r1', snapshot, 8000);
  const took = Date.now() - startedAt;

  assert.equal(answer, '四十七');
  assert.ok(took >= 250, `returned after ${String(took)}ms; a page with no stop control must still settle`);
});

test('a prompt the page reflowed is still recognised as the echo', () => {
  // The page renders the prompt's list items as their own blocks, so the
  // newline before "1." disappears entirely. Collapsing whitespace to a space
  // inserted a character the page never had, the match failed, and the prompt
  // was accepted as the answer — which is exactly what showed up in a card.
  const prompt =
    '你是我在 ThinkFusion 里的研究伙伴，我们直接对话。\n\n几点要求：\n1. 用自然语言回答，不要输出 JSON。\n2. 信息不足时先说明。';
  const page =
    '你是我在 ThinkFusion 里的研究伙伴，我们直接对话。几点要求：1. 用自然语言回答，不要输出 JSON。2. 信息不足时先说明。对话已删除。';

  assert.equal(containsEcho(page, prompt), true, 'the reflowed prompt is still our prompt');
  assert.equal(stripEcho(page, prompt).trim(), '对话已删除。');
});

test('the echoed prompt is stripped out of the captured answer', async () => {
  const prompt = 'line one is long enough\ntaskId：abc\nroundId：def';
  const snapshot = {
    messageCount: 0,
    lastText: '',
    url: 'https://chat.deepseek.com/',
    capturedAt: Date.now(),
    conversationText: '',
    composerText: ''
  };

  const page = scriptedPage([
    state({ conversationText: `${prompt}\n{"protocol":"desktop-agent/v1"}` }),
    state({ conversationText: `${prompt}\n{"protocol":"desktop-agent/v1"}` }),
    state({ conversationText: `${prompt}\n{"protocol":"desktop-agent/v1"}` }),
    state({ conversationText: `${prompt}\n{"protocol":"desktop-agent/v1"}` })
  ]);

  const answer = await adapterFor(page, { pollMs: 5, settleMs: 10 }).waitForAnswer('r1', snapshot, 3000, prompt);
  assert.ok(!answer.includes('line one is long enough'), `echo survived: ${answer}`);
  assert.ok(answer.includes('"protocol":"desktop-agent/v1"'), 'the real answer must survive');
});

// ---------------------------------------------------------------------------
// The hazard the echo check exists for
// ---------------------------------------------------------------------------

test('a prompt echoed back is not mistaken for a live protocol message', () => {
  const taskId = 'task-1';
  const roundId = 'round-1';
  const prompt = buildInitialPrompt({
    prompt: '整理项目结构',
    taskId,
    roundId,
    permissionPreset: 'workspace-write',
    workspaceRoot: '/tmp/ws',
    allowedTools: ['fs.list', 'fs.readFile', 'fs.mkdir', 'fs.writeFile'],
    maxSteps: 30
  });

  // The prompt itself contains a clarification sample and a completion sample,
  // both with the real ids. Fed back unmodified they are two distinct protocol
  // messages, so the answer is rejected as self-contradictory — the loop dies
  // with "回答中包含 2 个互相冲突的协议消息" on a prompt the page merely echoed.
  assert.equal(parseAnswer(prompt, { taskId, roundId }).kind, 'conflict');

  // With the echo removed, the same text yields nothing to act on.
  assert.equal(parseAnswer(prompt, { taskId, roundId }, { ignoreEcho: prompt }).kind, 'none');
});

test('stripEcho cuts the echoed region and keeps the answer intact', () => {
  const prompt = [
    '计划 JSON 结构：',
    '{',
    '  "protocol": "desktop-agent/v1",',
    '  "type": "plan",',
    '  "taskId": "<原样回填>"',
    '}'
  ].join('\n');

  // The answer reuses lines that also appear in the prompt. Cutting line by
  // line deleted those very fields and left invalid JSON, so the region has to
  // be removed as a whole.
  const answer = '{\n  "protocol": "desktop-agent/v1",\n  "type": "plan",\n  "steps": []\n}';
  const captured = `${prompt}\n${answer}`;

  assert.equal(stripEcho(captured, prompt).trim(), answer);

  // A page that re-wrapped the prompt must still match.
  const rewrapped = prompt.replace(/\n/g, '   \n  ');
  assert.equal(stripEcho(`${rewrapped}\n${answer}`, prompt).trim(), answer);
});

test('stripEcho does not touch text that merely shares a line with the prompt', () => {
  const prompt = '计划 JSON 结构：\n{ "protocol": "desktop-agent/v1", "type": "plan" }';
  const answer = '{ "protocol": "desktop-agent/v1", "type": "plan" }';
  assert.equal(stripEcho(answer, prompt), answer);
});

// ---------------------------------------------------------------------------
// Answer selection order
// ---------------------------------------------------------------------------

test('a page that is still loading is read, not written off', async () => {
  // Measured on Gemini: the page draws its whole chat UI while a request keeps
  // `isLoading()` true for a minute, and `executeJavaScript` queues behind that
  // load. The channel therefore said 「页面正在加载」 over a page that was open,
  // visible and ready to type in — the status was about the network, not about
  // the page. The driver now reads such a page through the debugger; what this
  // checks is that the status believes what it read.
  const page = scriptedPage([state({ hasInput: true })], { loading: true });
  const adapter = adapterFor(page);

  const status = await adapter.getStatus();
  assert.equal(status.pageReady, true, '输入框在，页面就算就绪');
  assert.notEqual(status.detail, '页面正在加载，加载完就能用');
});

test('a page with no composer while loading is a wait, not a broken profile', async () => {
  const page = scriptedPage([state({ hasInput: false })], { loading: true });
  const status = await adapterFor(page).getStatus();

  assert.equal(status.pageReady, false);
  assert.equal(status.detail, '页面正在加载，加载完就能用', '加载中不能说成「页面结构可能已变化」');
});

test('page chrome is never mistaken for an answer', () => {
  const snapshot = { messageCount: 0, lastText: '', url: '', capturedAt: 0, conversationText: '', composerText: '' };
  // What a fresh conversation actually shows after sending: a generated title,
  // the composer toggles and the footer disclaimer. It stabilises before the
  // reply does, and accepting it produced a 33-character "answer".
  const chrome = state({ conversationText: '列出工作区文件\n深度思考\n智能搜索\n内容由 AI 生成，请仔细甄别' });
  // The title is the question in fewer words — that is why it can be dropped
  // once the furniture around it is stripped. The question is passed because
  // the decision needs it: a short tail on its own is indistinguishable from a
  // short answer.
  assert.equal(selectAnswerText(chrome, snapshot, '列出工作区文件，不要修改任何内容'), '');
});

test('a fresh assistant bubble wins over the raw transcript tail', () => {
  const snapshot = {
    messageCount: 1,
    lastText: 'old',
    url: '',
    capturedAt: 0,
    conversationText: 'old',
    composerText: ''
  };
  const probe = state({
    messageCount: 2,
    lastText: '{"protocol":"desktop-agent/v1","type":"plan"}',
    conversationText: 'old\nsome chrome\n{"protocol":"desktop-agent/v1","type":"plan"}'
  });
  assert.equal(selectAnswerText(probe, snapshot), '{"protocol":"desktop-agent/v1","type":"plan"}');
});

test('without a selectable bubble the stable tail is the answer', () => {
  const snapshot = {
    messageCount: 0,
    lastText: '',
    url: '',
    capturedAt: 0,
    conversationText: 'old',
    composerText: ''
  };

  // chatgpt.com exposes no message attributes at all, so this is the *only*
  // path there. It used to require the protocol marker, which the rebuild
  // stopped sending — so a finished answer sat on the page and the wait timed
  // out. Stillness is enforced by the caller.
  const prose = 'Redis 连接数过高最常见的原因是客户端代码存在连接泄漏：应用获取连接后没有正确关闭或归还连接池。';
  assert.equal(selectAnswerText(state({ conversationText: `old\n${prose}` }), snapshot), prose);

  // The page had already replied with one character. A length floor is not a
  // test of answers, and treating it as one is how this looked stuck.
  assert.equal(selectAnswerText(state({ conversationText: 'old\n8' }), snapshot), '8');

  // Page furniture is removed by name, not by length.
  assert.equal(
    selectAnswerText(state({ conversationText: 'old\n深度思考\n智能搜索\n内容由 AI 生成，请仔细甄别' }), snapshot),
    ''
  );

  // While the page says it is still working, a short line is its status line.
  assert.equal(
    selectAnswerText(state({ conversationText: 'old\n思考中', generating: true }), snapshot),
    ''
  );
});

test('the question we sent is not part of the answer', () => {
  const snapshot = {
    messageCount: 0,
    lastText: '',
    url: '',
    capturedAt: 0,
    conversationText: 'old',
    composerText: ''
  };

  // ChatGPT and Kimi both echo the user's bubble into the transcript, and on a
  // page with no assistant container that bubble is inside the tail. Leaving it
  // there made the candidate "contain our own prompt", which the echo guard
  // rejected on every poll — the answer was on screen and the turn timed out.
  assert.equal(selectAnswerText(state({ conversationText: 'old\n3+5。结果是多少\n8' }), snapshot, '3+5。结果是多少'), '8');

  // The page decides where the line breaks go; the match is whitespace-blind.
  assert.equal(
    selectAnswerText(state({ conversationText: 'old\n3+5。\n结果是多少\n8' }), snapshot, '3+5。结果是多少'),
    '8'
  );
});

test('an old assistant bubble is never reused as the answer', () => {
  const snapshot = { messageCount: 1, lastText: 'old', url: '', capturedAt: 0, conversationText: 'old', composerText: '' };
  const probe = state({ messageCount: 1, lastText: 'old' });
  assert.equal(selectAnswerText(probe, snapshot), '');
});

test('page furniture is not an answer when the question never left the composer', () => {
  // 真机（kimi.com）：发送键是个带 disabled 类的 div，按下去站点没反应，提问留在
  // 输入框里，页面停在起始页。那时候转录差异部分全是侧栏、工具栏和页脚，却被当成
  // 回答显示了出来——用户看到的就是「Kimi 回答不对」。
  const snapshot = { messageCount: 0, lastText: '', url: '', capturedAt: 0, conversationText: '新建会话\n我的 Kimi', composerText: '' };
  const chrome =
    '新建会话\n我的 Kimi\n邀请有奖\n抢 K3.1 Pro 权益\n登月者4903\n升级\n复制\n分享\n继续问，消息会排队发送…\n快速\n进阶';
  assert.equal(selectAnswerText(state({ conversationText: `新建会话\n我的 Kimi\n${chrome}` }), snapshot, '女生容易情绪化，给出原因'), '');

  // 同一个页脚，只要问题真的在转录里出现了，后面的文字才有资格被当成回答。
  assert.equal(
    selectAnswerText(
      state({ conversationText: '新建会话\n我的 Kimi\n女生容易情绪化，给出原因\n这是回答正文，足够长到不像状态行。' }),
      snapshot,
      '女生容易情绪化，给出原因'
    ).includes('这是回答正文'),
    true
  );
});

test('the transcript match tolerates the line breaks the page chooses', () => {
  assert.equal(transcriptHasPrompt('old\n3+5。\n结果是多少\n8', '3+5。结果是多少'), true);
  assert.equal(transcriptHasPrompt('old\n3+5。结果是多少\n8', '3+5。结果是多少'), true);
  assert.equal(transcriptHasPrompt('old\n完全不相干的一段话', '3+5。结果是多少'), false);
  // 没有给出问题就没法判断，不能反过来把正常回答挡掉。
  assert.equal(transcriptHasPrompt('old\n8', ''), true);
});

// ---------------------------------------------------------------------------
// Environment guards
// ---------------------------------------------------------------------------

test('only the deepseek chat origin is accepted', () => {
  assert.equal(isAllowedDeepSeekUrl('https://chat.deepseek.com/a/chat'), true);
  assert.equal(isAllowedDeepSeekUrl('https://chat.deepseek.com.evil.test/'), false);
  assert.equal(isAllowedDeepSeekUrl('http://chat.deepseek.com/'), false);
  assert.equal(isAllowedDeepSeekUrl('https://user:pass@chat.deepseek.com/'), false);
  assert.equal(isAllowedDeepSeekUrl(''), false);
});

test('status reports the diagnosis instead of a bare failure', async () => {
  const page = scriptedPage([state({ hasInput: false, inputKind: 'none', selectorHits: { 'input:#chat-input': 0 } })]);
  const status = await adapterFor(page).getStatus();
  assert.equal(status.pageReady, false);
  assert.equal(status.detail, '未找到输入框，页面结构可能已变化');
  assert.equal(status.diagnostics.probeVersion, PROBE_VERSION);
  assert.equal(status.diagnostics.selectorHits['input:#chat-input'], 0);
});

test('an unauthenticated page is reported as such, not as a broken selector', async () => {
  const page = scriptedPage([state({ hasPasswordField: true, hasInput: false })]);
  const status = await adapterFor(page).getStatus();
  assert.equal(status.loggedIn, false);
  assert.equal(status.detail, '需要登录 DeepSeek 才能继续');
});

test('a signed-out page with a working composer is a hint, not a failure', async () => {
  // Gemini answers guests: the composer works, only history and the heavier
  // models need an account. Calling that unusable would drop a channel that
  // can answer, so the signed-out marker changes the message, not the verdict.
  const page = scriptedPage([
    state({ hasInput: true, inputKind: 'contenteditable', signedOut: true, hasPasswordField: false })
  ]);
  const status = await adapterFor(page).getStatus();
  assert.equal(status.pageReady, true);
  assert.equal(status.loggedIn, false);
  assert.match(status.detail, /仍可使用/);
  assert.match(status.detail, /登录/);
});

test('the Gemini speaker label is cut even without a colon', async () => {
  // A Gemini bubble's innerText is "Gemini 说\n18", not "ChatGPT 说：18" — the
  // label has no colon and sits on its own line. Left in, every answer from
  // that channel would arrive prefixed with the site's own label.
  const { cutSpeakerLabels, normalizeAnswerText } = await import(
    path.join(root, 'out/adapter/shared/text.js')
  );
  assert.equal(normalizeAnswerText(cutSpeakerLabels('Gemini 说\n18')), '18');
  assert.equal(normalizeAnswerText(cutSpeakerLabels('Gemini said\n18')), '18');
});

test('default tuning is patient enough for a cold page load', () => {
  assert.ok(DEFAULT_TUNING.confirmMs >= 15000, 'a 600ms confirmation window is what caused the false failure');
  assert.ok(DEFAULT_TUNING.settleMs >= 1000);
});

// ---------------------------------------------------------------------------
// Window split
// ---------------------------------------------------------------------------

const { computeSplit, isSplitUsable, MIN_APP_COLUMN, MIN_PAGE_COLUMN, PAGE_GUTTER } = await import(
  path.join(root, 'out/adapter/shared/layout.js')
);

test('the page view never spills past the window edge', () => {
  // The old formula used a fixed minimum origin, so at the window's own minimum
  // width the view ended 88px outside the window and covered the app's column.
  for (let width = 1180; width <= 3000; width += 1) {
    const split = computeSplit(width);
    assert.ok(width - split >= MIN_APP_COLUMN, `width=${width} left the app only ${width - split}px`);
    assert.ok(split >= MIN_PAGE_COLUMN, `width=${width} gave the page only ${split}px`);
    // The view is placed at `width - split + PAGE_GUTTER` with width
    // `split - PAGE_GUTTER`, so its right edge lands exactly on the window's.
    // Getting this off by the gutter once cut off the page's own scrollbar.
    const x = width - split + PAGE_GUTTER;
    const viewWidth = split - PAGE_GUTTER;
    assert.equal(x + viewWidth, width, `width=${width} put the page view's right edge at ${x + viewWidth}`);
    assert.ok(viewWidth > 0);
  }
});

// ---------------------------------------------------------------------------
// Starting a new conversation on the page
//
// Typing into a fresh composer *is* starting a new conversation — that is how
// these sites work, on both of them. So the only thing to establish is that the
// composer belongs to a new conversation, and the only evidence for that is an
// empty transcript. A click is a request; it is never the outcome.
// ---------------------------------------------------------------------------

test('a page that is already a fresh chat is left alone', async () => {
  // The normal state of a page nobody has used yet: nothing to click, and a
  // reload here would throw away a perfectly good blank page.
  const page = scriptedPage([state({ messageCount: 0, composerText: '' })]);

  const result = await adapterFor(page).newConversation();

  assert.equal(result.ok, true);
  assert.equal(result.method, 'already-empty');
  assert.equal(page.calls.newChat, 0, 'nothing to click');
  assert.equal(page.calls.reload, 0, 'no reload for a page that is already new');
});

test('a page that reports loading forever still counts as cleared when it is empty', async () => {
  // Measured on ChatGPT: its page keeps a streaming connection open, so
  // `isLoading()` never settles while the transcript is already blank. Making
  // that a veto meant every reset expired against an empty page and the turn was
  // told 「页面没有清空，仍在原会话里」 with nothing in it.
  const page = scriptedPage([state({ messageCount: 0, conversationText: '' })], { loading: true });

  const result = await adapterFor(page, { alreadyEmptyMs: 2000, emptyStableMs: 40 }).newConversation();

  assert.equal(result.ok, true);
  assert.equal(result.method, 'already-empty');
  assert.equal(page.calls.newChat, 0);
});

test('one empty reading in the middle of a navigation is not a new conversation', async () => {
  // The page blanks out before the old thread renders back in. Accepting that
  // first reading is what made a reset look successful on a page that still
  // held the conversation it was told to leave.
  const page = scriptedPage(
    [state({ messageCount: 0, conversationText: '' }), state({ messageCount: 2, conversationText: '旧对话' })],
    { afterNewChat: [state({ messageCount: 0, conversationText: '' })] }
  );

  const result = await adapterFor(page, { alreadyEmptyMs: 1500, emptyStableMs: 40 }).newConversation();

  assert.equal(result.ok, true);
  assert.equal(result.method, 'label', 'the empty gap must not be mistaken for a fresh page');
  assert.equal(page.calls.newChat, 1);
});

test('a page that never left its thread is not a new conversation, however empty it looks', async () => {
  // ChatGPT no longer ships data-message-author-role, so its transcript count is
  // always zero — including on the page that is still sitting on the old
  // thread. The address is what settles it: the same path means "still there",
  // a locale query string or not.
  const page = scriptedPage([state({ messageCount: 0, composerText: '' })], {
    url: 'https://chat.deepseek.com/a/chat/s/abc',
    afterNewChat: [state({ messageCount: 0, composerText: '' })],
    urlAfterNewChat: 'https://chat.deepseek.com/'
  });

  const result = await adapterFor(page, { alreadyEmptyMs: 1500, emptyStableMs: 40 }).newConversation(
    'https://chat.deepseek.com/a/chat/s/abc?hl=zh'
  );

  assert.equal(result.ok, true);
  assert.equal(result.method, 'label', 'the same thread is not a reset, even with nothing rendered');
  assert.equal(page.calls.newChat, 1);
});

test('a leftover draft in the composer does not stop a reset', async () => {
  // A person can start a new chat and type before sending. Requiring an empty
  // composer made the reset fail on exactly that page, and ChatGPT was the one
  // that kept it failing: with no message markup to count, the composer was the
  // only evidence left.
  const page = scriptedPage([state({ messageCount: 0, composerText: 'draft' })], {
    url: 'https://chat.deepseek.com/c/1',
    afterNewChat: [state({ messageCount: 0, composerText: 'draft' })],
    urlAfterNewChat: 'https://chat.deepseek.com/'
  });

  const result = await adapterFor(page, { alreadyEmptyMs: 1500, emptyStableMs: 40 }).newConversation('https://chat.deepseek.com/c/1');

  assert.equal(result.ok, true);
  assert.equal(result.method, 'label');
});

test('a new conversation waits for the page to actually clear', async () => {
  // Before the click the transcript still holds the old thread; only after it
  // does the page go blank, and only then may the reset count as done.
  const page = scriptedPage([state({ messageCount: 2, conversationText: '旧对话' })], {
    afterNewChat: [
      state({ messageCount: 2, conversationText: '旧对话' }),
      state({ messageCount: 0, conversationText: '' })
    ]
  });

  const result = await adapterFor(page, { newChatMs: 2000 }).newConversation();

  assert.equal(result.ok, true);
  assert.equal(result.method, 'label');
  assert.equal(page.calls.newChat, 1, 'one request, not a loop of clicks');
  assert.equal(page.calls.reload, 0, 'a click that worked must not be followed by a reload');
  assert.ok(page.calls.probe >= 3, 'the click alone is never taken as evidence');
});

test('a page with no new-chat control falls back to the site root', async () => {
  // chatgpt.com at a narrow pane has no new-chat button at all — only a
  // "show sidebar" toggle — so the reload is the path that has to work.
  const page = scriptedPage([state({ messageCount: 3, conversationText: '旧对话' })], {
    newChatOk: false,
    afterReload: [state({ messageCount: 0, conversationText: '' })]
  });

  const result = await adapterFor(page, { newChatMs: 2000 }).newConversation();

  assert.equal(result.ok, true);
  assert.equal(result.method, 'reload');
  assert.equal(page.calls.reload, 1);
  assert.ok(page.calls.probe >= 2, 'the reload is still not taken as evidence on its own');
});

test('a page that stays on the old thread reports the drift instead of pretending', async () => {
  const page = scriptedPage([state({ messageCount: 2, conversationText: '旧对话' })]);
  delete page.reloadHome;

  const result = await adapterFor(page, { newChatMs: 60 }).newConversation();

  assert.equal(result.ok, false);
  assert.match(result.detail, /没有清空/);
});

test('a page with no new-chat control says so instead of throwing', async () => {
  const page = scriptedPage([state()]);
  delete page.newChat;
  delete page.reloadHome;

  const result = await adapterFor(page).newConversation();

  assert.equal(result.ok, false);
  assert.equal(result.method, 'unsupported');
});

test('a reload that fails is reported, not swallowed', async () => {
  const page = scriptedPage([state({ messageCount: 1 })], { newChatOk: false, reloadOk: false });

  const result = await adapterFor(page, { newChatMs: 60 }).newConversation();

  assert.equal(result.ok, false);
  assert.match(result.detail, /重新加载站点失败/);
  assert.match(result.detail, /NAV_FAILED/);
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

test('the split is stable across the range a user can drag', () => {
  assert.equal(computeSplit(1560), Math.round(1560 * 0.42));
  // At the window's minimum width the app column wins: the page gets the rest.
  assert.equal(computeSplit(1180), 1180 - MIN_APP_COLUMN);
  // Monotonic: a wider window never gives the page less room.
  let previous = 0;
  for (let width = 1180; width <= 2400; width += 40) {
    const split = computeSplit(width);
    assert.ok(split >= previous, `split shrank at width=${width}`);
    previous = split;
  }
});

test('a dragged width is honoured but never at the app column\'s expense', () => {
  // A width the user can actually reach is applied unchanged.
  assert.equal(computeSplit(1560, 700), 700);
  assert.ok(isSplitUsable(1560, 700));
  // Dragging far left must not squeeze the app below its minimum.
  assert.equal(computeSplit(1560, 5000), 1560 - MIN_APP_COLUMN);
  // Dragging far right must not collapse the page to nothing.
  assert.equal(computeSplit(1560, 10), MIN_PAGE_COLUMN);
  // 0 and null both mean "put it back", not "zero pixels".
  assert.equal(computeSplit(1560, 0), computeSplit(1560, null));
  assert.equal(computeSplit(1560, null), computeSplit(1560));
  // A hostile value is clamped rather than rejected, so a stale renderer
  // cannot leave the window in an unusable state.
  assert.ok(Number.isFinite(computeSplit(1560, Number.POSITIVE_INFINITY)));
});

// ---------------------------------------------------------------------------
// The driver knows no site
// ---------------------------------------------------------------------------

/**
 * A page belonging to a site the app has never heard of.
 *
 * `scriptedPage` is hardwired to chat.deepseek.com because the timing tests are
 * about that page. These two tests exist to prove the opposite property: the
 * driver's entire knowledge of "which site is this" is what the caller passed
 * to the constructor.
 */
function foreignPage(url, probeOverrides = {}) {
  return {
    url: () => url,
    isDestroyed: () => false,
    async probe() {
      return state({ url, ...probeOverrides });
    }
  };
}

function adapterForSite(page, { hosts, siteLabel, selectors = DEEPSEEK_SELECTORS }) {
  return new ChatPageDriver(() => page, { hosts, siteLabel, selectors });
}

test('a site the driver has never heard of is driven by label and hosts alone', async () => {
  const hosts = new Set(['chat.example.test']);
  const selectors = { ...DEEPSEEK_SELECTORS, input: ['#foreign-input'] };
  const page = foreignPage('https://chat.example.test/', { hasPasswordField: true, hasInput: false });
  const adapter = adapterForSite(page, { hosts, siteLabel: '示例站点', selectors });

  const status = await adapter.getStatus();
  assert.equal(status.loggedIn, false);
  // The login hint used to read "需要在内嵌页面完成 DeepSeek 登录" on every page,
  // so a ChatGPT pane told the user to log into DeepSeek.
  assert.match(status.detail, /示例站点/);
  assert.doesNotMatch(status.detail, /DeepSeek/);

  // The diagnosis reports the selectors actually in use, not a module default.
  // That was the bug where the panel under a ChatGPT page listed DeepSeek's
  // selectors — the numbers looked authoritative and described the wrong page.
  const report = await adapter.diagnose();
  assert.equal(report.selectors.input[0], '#foreign-input');
});

test('the same driver refuses another site host, and names the right site', async () => {
  const adapter = adapterForSite(foreignPage('https://chat.deepseek.com/'), {
    hosts: new Set(['chat.example.test']),
    siteLabel: '示例站点'
  });

  const status = await adapter.getStatus();
  assert.equal(status.pageReady, false);
  assert.match(status.detail, /示例站点/);
});

// ---------------------------------------------------------------------------
// The deadline on the Electron boundary.
//
// Everything above this line assumes the page answers. A renderer that is
// navigating, crashed, or stuck in a synchronous task answers nothing, and the
// promise never settles — which is how a turn could sit at 「提问中」 while every
// timer inside the wait loop kept being skipped: the loop only checks its clock
// between polls, and a poll that never returns stops it from ever returning.
// ---------------------------------------------------------------------------

test('a page call that never answers gives up instead of hanging', async () => {
  const stuck = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: () => new Promise(() => {})
    }
  };

  const started = Date.now();
  await assert.rejects(() => callPage(stuck, '读取页面状态', '1 + 1', 120), /没有响应/);
  assert.ok(Date.now() - started < 2000, '超时必须在限期内发生，而不是等到天荒地老');
});

test('a closed page is refused before anything is executed in it', async () => {
  let executed = false;
  const closed = {
    webContents: {
      isDestroyed: () => true,
      executeJavaScript: () => {
        executed = true;
        return Promise.resolve(null);
      }
    }
  };

  await assert.rejects(() => callPage(closed, '读取页面状态', '1 + 1', 120), /页面已关闭/);
  assert.equal(executed, false);
});

test('a page that answers in time returns its value untouched', async () => {
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: () => Promise.resolve({ messageCount: 2 })
    }
  };
  assert.deepEqual(await callPage(view, '读取页面状态', 'x', 120), { messageCount: 2 });
});

// 2026-11-04 真机回归发现：问「17 乘 3」时 Gemini 把提问气泡当成回答收下。
// containsEcho 对短提问有 40 字门槛，39 字的测试题差一个字没过，于是整段
// 提问原样进了综合报告。下面几条把这个长度无关的判据钉住。
test('a short prompt echoed back whole is not an answer', () => {
  const question = 'TF-B-REGRESSION-20261104 17 乘 3 等于多少？只回答数字。';
  assert.equal(question.replace(/\s+/g, '').length, 39, '正好低于 containsEcho 的 40 字门槛');
  assert.equal(isOwnPromptEcho(question, question), true);
  assert.equal(isOwnPromptEcho(question.replace(/ /g, '\n'), question), true, '空白差异不算新内容');
  assert.equal(isOwnPromptEcho('17 乘 3 等于多少？', question), true, '提问的一部分也不算回答');
});

test('a real short answer is never mistaken for an echo', () => {
  const question = '17 乘 3 等于多少？只回答数字。';
  assert.equal(isOwnPromptEcho('51', question), false);
  assert.equal(isOwnPromptEcho('17 乘 3 等于 51。', question), false, '引用了问题但更长');
  assert.equal(isOwnPromptEcho('51', '17 乘 3 等于 51 吗？'), false, '两个字的答案不参与判断');
  assert.equal(isOwnPromptEcho('51'), false, '没发过问题就无从判断');
});

// 页面脚本是拼出来的字符串，写坏一个转义（`\/` 在模板里变成 `/`，把后半行变成
// 注释）不会有任何编译期错误——它只会在用户点删除时以「Script failed to execute」
// 出现，而那句话不指向任何位置。这条用例把每个页面脚本都真正编译一遍。
test('every page script still compiles', () => {
  const sources = {
    deleteChat: deleteChatScriptForSyntaxCheck('https://chatgpt.com/c/6aec0dc3-5568-83ec-a1d1-7263d543e624'),
    deleteChatLocateOnly: deleteChatScriptForSyntaxCheck('https://chatgpt.com/c/6aec0dc3-5568-83ec-a1d1-7263d543e624', true),
    // 读引用是模板拼出来的脚本：拼接被转义吃掉时页面不会报错，只会静默返回空，
    // 所以这里至少要先过一遍编译。
    citations: CITATIONS_SCRIPT(DEEPSEEK_SELECTORS)
  };
  for (const [name, source] of Object.entries(sources)) {
    assert.doesNotThrow(() => new Function('return ' + source), `${name} 编译失败`);
  }
});
