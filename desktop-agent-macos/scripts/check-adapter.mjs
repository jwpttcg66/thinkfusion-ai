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
const { DeepSeekAdapter, DEFAULT_TUNING, selectAnswerText, answerLooksComplete, isAllowedDeepSeekUrl, PROBE_VERSION } = await import(
  path.join(root, 'out/adapter/main/deepseek-adapter.js')
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
 * @param {{fillOk?: boolean, clickOk?: boolean}} options
 */
function scriptedPage(observations, options = {}) {
  const calls = { fill: 0, click: 0, enter: 0, probe: 0 };
  let index = 0;

  return {
    calls,
    url: () => 'https://chat.deepseek.com/',
    isDestroyed: () => false,
    async probe() {
      calls.probe += 1;
      const hit = observations[Math.min(index, observations.length - 1)];
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
    async pressEnter() {
      calls.enter += 1;
    }
  };
}

const FAST = { pollMs: 5, settleMs: 20, enterAfterMs: 4000, clickRetryAfterMs: 8000 };

function adapterFor(page, tuning = {}) {
  const adapter = new DeepSeekAdapter(() => page);
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
  const page = scriptedPage([
    state({ conversationText: '{"protocol"' }),
    state({ conversationText: '{"protocol"' }),
    state({ conversationText: '{"protocol"' }),
    state({ conversationText: '{"protocol"' }),
    state({ conversationText: '{"protocol": "desktop-agent/v1"}' }),
    state({ conversationText: '{"protocol": "desktop-agent/v1"}' }),
    state({ conversationText: '{"protocol": "desktop-agent/v1"}' }),
    state({ conversationText: '{"protocol": "desktop-agent/v1"}' })
  ]);

  const answer = await adapterFor(page, { pollMs: 5, settleMs: 10 }).waitForAnswer('r1', snapshot, 3000);
  assert.equal(answer, '{"protocol": "desktop-agent/v1"}');
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

test('page chrome is never mistaken for an answer', () => {
  const snapshot = { messageCount: 0, lastText: '', url: '', capturedAt: 0, conversationText: '', composerText: '' };
  // What a fresh conversation actually shows after sending: a generated title,
  // the composer toggles and the footer disclaimer. It stabilises before the
  // reply does, and accepting it produced a 33-character "answer".
  const chrome = state({ conversationText: '列出工作区文件\n深度思考\n智能搜索\n内容由 AI 生成，请仔细甄别' });
  assert.equal(selectAnswerText(chrome, snapshot), '');
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

test('without a selectable bubble only protocol-bearing text is used', () => {
  const snapshot = {
    messageCount: 0,
    lastText: '',
    url: '',
    capturedAt: 0,
    conversationText: 'old',
    composerText: ''
  };

  // A page whose bubbles cannot be selected still works, as long as the text
  // carries the protocol marker — which every real answer does.
  const probe = state({ conversationText: 'old\n{"protocol":"desktop-agent/v1","type":"task_complete"}' });
  assert.equal(selectAnswerText(probe, snapshot), '{"protocol":"desktop-agent/v1","type":"task_complete"}');

  // Prose without the marker is not accepted; the alternative is acting on
  // page furniture.
  assert.equal(selectAnswerText(state({ conversationText: 'old\n随便聊聊' }), snapshot), '');
});

test('an old assistant bubble is never reused as the answer', () => {
  const snapshot = { messageCount: 1, lastText: 'old', url: '', capturedAt: 0, conversationText: 'old', composerText: '' };
  const probe = state({ messageCount: 1, lastText: 'old' });
  assert.equal(selectAnswerText(probe, snapshot), '');
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
  assert.equal(status.detail, '需要在内嵌页面完成 DeepSeek 登录');
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
