/**
 * Behaviour tests for the 「更新样式」 repair path.
 *
 * This is the only feature that writes to the page-driving layer from the UI,
 * and the way it fails is quiet: a learned selector that does not actually work
 * gets appended to a profile, the next question silently targets the wrong node,
 * and the app looks broken in a way nobody connects to the button they pressed.
 *
 * So the rules being pinned here are the ones that keep it honest — built-ins
 * win, a proposal the probe cannot confirm is thrown away, and a repair learned
 * on one host never applies to another.
 *
 * Run with: npm run test:selectors
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { confirmRepairs, proposeRepairs } from '../out-test/shared/selectors.js';
import { mergeProfile, SelectorStore } from '../out-test/main/selector-profile.js';

// Loaded through `await import` because these modules are compiled output, not
// source: the test build compiles the app, then this file reads what it wrote.
const providers = await import('../out-test/main/adapters/providers/index.js');
const sharedSelectors = await import('../out-test/shared/selectors.js');

const BASE = {
  input: ['#chat-input', 'textarea'],
  sendButton: ['button[aria-label*="发送"]'],
  stopButton: ['[aria-label*="停止"]'],
  newChatButton: ['[aria-label*="新对话"]'],
  assistant: ['.ds-markdown', '[class*="markdown"]'],
  passwordField: ['input[type="password"]']
};

const nothingWorking = { input: false, sendButton: false, assistant: false };
const allWorking = { input: true, sendButton: true, assistant: true };

test('a role that already works is never proposed for repair', () => {
  const proposal = proposeRepairs(allWorking, {
    input: { selector: '#prompt-textarea', hits: 1 },
    sendButton: { selector: '[data-testid="send-button"]', hits: 1 },
    assistant: { selector: 'article', hits: 3 }
  });
  assert.deepEqual(proposal.candidate, {});
  assert.deepEqual(proposal.intact, ['input', 'sendButton', 'assistant']);
  assert.deepEqual(proposal.failed, []);
});

test('a broken role with a live selector is proposed', () => {
  const proposal = proposeRepairs(nothingWorking, {
    input: { selector: '#prompt-textarea', hits: 1 },
    sendButton: { selector: '[data-testid="send-button"]', hits: 1 },
    assistant: null
  });
  assert.deepEqual(proposal.candidate, {
    input: ['#prompt-textarea'],
    sendButton: ['[data-testid="send-button"]']
  });
  // `assistant` had nothing to propose, which is a failure to report, not a
  // candidate to try.
  assert.deepEqual(proposal.failed, ['assistant']);
  assert.deepEqual(proposal.intact, []);
});

test('an empty composer is not a reason to learn somebody else button', () => {
  // Measured on Gemini: an idle composer has no send control at all, and the
  // last button in that toolbar is 语音输入. The old fallback learned it as
  // 发送, which would have clicked the microphone instead of sending.
  const proposal = proposeRepairs(
    nothingWorking,
    { input: { selector: '#chat-input', hits: 1 }, sendButton: null, assistant: null },
    { composerEmpty: true }
  );
  assert.deepEqual(proposal.candidate, { input: ['#chat-input'] });
  assert.deepEqual(proposal.pending, ['sendButton']);
  assert.deepEqual(proposal.failed, ['assistant'], '回答区域 is still a real miss');
});

test('a selector that matches nothing right now is not proposed', () => {
  const proposal = proposeRepairs(nothingWorking, {
    input: { selector: '#prompt-textarea', hits: 0 },
    sendButton: { selector: 'button.send', hits: 2 },
    assistant: null
  });
  assert.equal(proposal.candidate.input, undefined);
  assert.deepEqual(proposal.failed.sort(), ['assistant', 'input']);
});

test('a proposal the probe cannot confirm is discarded', () => {
  // The page still reports no input after the candidate is merged in. Keeping it
  // would mean the app now believes it can ask, and it cannot.
  const verdict = confirmRepairs({ input: ['div.composer'], sendButton: ['button.go'] }, {
    hasInput: false,
    hasSendButton: false,
    messageCount: 0
  });
  assert.deepEqual(verdict.confirmed, {});
  assert.deepEqual(verdict.learned, []);
  assert.deepEqual(verdict.failed.sort(), ['input', 'sendButton']);
});

test('a proposal the probe confirms is kept, per role', () => {
  const verdict = confirmRepairs({ input: ['div.composer'], assistant: ['div.reply'] }, {
    hasInput: true,
    hasSendButton: false,
    messageCount: 2
  });
  assert.deepEqual(verdict.learned.sort(), ['assistant', 'input']);
  assert.deepEqual(verdict.failed, []);
  assert.deepEqual(verdict.confirmed, { input: ['div.composer'], assistant: ['div.reply'] });
});

test('learned selectors are appended, so a working built-in still wins', () => {
  const merged = mergeProfile(BASE, { input: ['div.composer'], assistant: ['div.reply'] });
  assert.deepEqual(merged.input, ['#chat-input', 'textarea', 'div.composer']);
  assert.deepEqual(merged.assistant, ['.ds-markdown', '[class*="markdown"]', 'div.reply']);
  // Untouched roles are the same array reference, not a copy that could drift.
  assert.equal(merged.sendButton, BASE.sendButton);
});

test('merging never mutates the built-in profile', () => {
  mergeProfile(BASE, { input: ['div.composer'] });
  assert.deepEqual(BASE.input, ['#chat-input', 'textarea']);
});

test('a selector already in the built-in list is not duplicated', () => {
  const merged = mergeProfile(BASE, { input: ['#chat-input'] });
  assert.deepEqual(merged.input, ['#chat-input', 'textarea']);
});

test('learned selectors only apply to the host they were learned on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-selectors-'));
  const file = path.join(dir, 'selector-profile.json');
  try {
    const store = new SelectorStore(file);
    store.save('chatgpt', 'chatgpt.com', { input: ['div.composer'] });

    assert.deepEqual(store.forHost('chatgpt', 'chatgpt.com'), { input: ['div.composer'] });
    // Signing in happens on another host, and a composer selector from the chat
    // page is meaningless there.
    assert.equal(store.forHost('chatgpt', 'auth.openai.com'), undefined);
    assert.equal(store.forHost('deepseek', 'chatgpt.com'), undefined);

    // Survives a restart, because the whole point is that a repair outlives the
    // session that made it.
    const reopened = new SelectorStore(file);
    assert.deepEqual(reopened.forHost('chatgpt', 'chatgpt.com'), { input: ['div.composer'] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt selector file degrades to "nothing learned"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-selectors-'));
  const file = path.join(dir, 'selector-profile.json');
  try {
    fs.writeFileSync(file, '{ not json', 'utf8');
    const store = new SelectorStore(file);
    assert.equal(store.forHost('deepseek', 'chat.deepseek.com'), undefined);
    // And it can still be written afterwards.
    store.save('deepseek', 'chat.deepseek.com', { input: ['#x'] });
    assert.deepEqual(store.forHost('deepseek', 'chat.deepseek.com'), { input: ['#x'] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Built-in profiles: the constraints that are not obvious from the markup.
// ---------------------------------------------------------------------------

test('the Kimi profile keeps the send control apart from the stop control', () => {
  const { providerFor, reasoningFor } = providers;
  const kimi = providerFor('kimi');
  assert.ok(kimi, 'Kimi 应当有内置画像');
  // The page turns the same div into a stop button by adding a class while it
  // generates. A send list that still matches there reports a submit that never
  // happened, so the first selector must exclude that state.
  assert.equal(kimi.selectors.sendButton[0], '.send-button-container:not(.stop)');
  assert.ok(kimi.selectors.stopButton.includes('.send-button-container.stop'));
  // Kimi exposes no role/aria/testid on the control, so the class is the only
  // hook — a regression to a button-based selector would silently fall back to
  // the composer toolbar and click 「上传文件」.
  assert.ok(kimi.selectors.sendButton.every(selector => !/^button\[type=/.test(selector)));
  assert.ok(kimi.hosts.has('www.kimi.com') && kimi.hosts.has('kimi.com'));
});

test('the Kimi profile counts answers by bubble and cuts the reasoning out', () => {
  const { providerFor, reasoningFor } = providers;
  const kimi = providerFor('kimi');
  // One element per answer. Counting markdown blocks over-counts a reply that
  // spans several of them, and hands the driver only its last fragment.
  assert.equal(kimi.selectors.assistant[0], '.chat-content-item-assistant');
  const cuts = reasoningFor('kimi');
  assert.ok(cuts.includes('.toolcall-flow'), '思考面板必须被剔除');
  assert.ok(cuts.includes('.segment-assistant-actions'), '复制/分享按钮必须被剔除');
  // A site with no such noise opts out by saying nothing, not by guessing.
  assert.deepEqual(reasoningFor('chatgpt'), []);
  assert.deepEqual(reasoningFor('deepseek'), []);
});

test('the Gemini profile fills the Quill editor, not the wrapper around it', () => {
  const { providerFor } = providers;
  const gemini = providerFor('gemini');
  assert.ok(gemini, 'Gemini 应当有内置画像');
  // `<rich-textarea>` is a custom element with no editable surface of its own;
  // writing to it does nothing. The editor is the `div.ql-editor` inside.
  assert.match(gemini.selectors.input[0], /\.ql-editor/);
  // The send control only exists once the composer has text, so a list that
  // starts with a structural guess would click 「上传和工具」 instead.
  assert.ok(gemini.selectors.sendButton.some(selector => selector.includes('发送')));
  assert.ok(gemini.selectors.sendButton.some(selector => selector.includes('Send')));
  // 「新对话」 is spelled `reset` here.
  assert.ok(gemini.selectors.newChatButton.includes('[data-test-id="reset-button"]'));
});

test('the Gemini profile counts answers by turn and cuts the thinking panel', () => {
  const { providerFor, reasoningFor } = providers;
  const gemini = providerFor('gemini');
  // One element per reply. `message-content` is the renderer inside a single
  // turn, so it stays as the fallback rather than the first choice.
  assert.equal(gemini.selectors.assistant[0], 'model-response');
  assert.ok(reasoningFor('gemini').includes('model-thoughts'), '思考面板必须被剔除');
  // Signed out, Gemini accepts a question and renders nothing. The login button
  // is a stable hook, and `accounts.google.com` has to be reachable or the
  // channel can never leave that state.
  assert.ok(gemini.hosts.has('accounts.google.com'));
  assert.ok(gemini.hosts.has('gemini.google.com'));
  // Signed out, Gemini is usable but says so. The visible sign-in control has no
  // hook to select it by — measured on the guest page it is a plain
  // `<button>登录</button>` — so the label is what is matched.
  assert.deepEqual(gemini.signedOutText, ['登录', 'Sign in']);
  // `[data-test-id="signed-out-disclaimer"]` must NOT be used: measured on the
  // same page, that element is the terms-and-privacy paragraph and it stays on
  // screen after signing in, so it reported 未登录 for a logged-in account.
  assert.ok(
    !gemini.signedOut.includes('[data-test-id="signed-out-disclaimer"]'),
    '条款段落不是未登录信号'
  );
  // The other shape of the same state: `/app` sometimes redirects to `/signin`,
  // and that page has no composer — without the path, the status calls a
  // working redirect "页面结构可能已变化".
  assert.deepEqual(gemini.signedOutPaths, ['/signin']);
  // The signed-out page still answers (measured: "18" in one turn), so the
  // login is a hint rather than a gate — but only because this profile says so.
  assert.equal(gemini.guestUsable, true);
  assert.equal(providers.guestUsableFor('chatgpt'), false);
  assert.equal(providers.guestUsableFor('kimi'), false);
  // Kimi 未登录时输入框还在、发送键还亮着、字也写得进去，点了却什么都不发生
  // （实测：点击被 `.login-modal-next-mask` 或页面自身的访客限制吃掉）。不声明
  // 这个状态，提问路径就要白烧 20 秒并报成「发送未确认」。
  assert.deepEqual(providers.signedOutFor('kimi'), [
    '.login-modal-next-mask',
    'button.login-button',
    '.next-sidebar-history-list__login'
  ]);
  // A site with nothing of its own to say opts out by saying nothing.
  assert.deepEqual(providers.signedOutFor('chatgpt'), []);
  assert.deepEqual(providers.signedOutPathsFor('kimi'), []);
});

test('every built-in profile covers all six roles', () => {
  const { SELECTOR_ROLES } = sharedSelectors;
  for (const [id, profile] of Object.entries(providers.PROVIDERS)) {
    for (const role of SELECTOR_ROLES) {
      assert.ok(Array.isArray(profile.selectors[role]) && profile.selectors[role].length > 0, `${id} 缺少 ${role}`);
    }
  }
});

// 已登录也会弹的排队提示：2026-11-07 真机实测，Kimi 的 .modal-mask 盖住整页，
// 字写得进去、发送键亮着，点击却被吃掉，最后只报一个看不出原因的 180 秒超时。
// 只声明「我知道了」，不声明「去升级」——后者会把用户带进付费流程。
test('只有 Kimi 声明了要关掉的纯提示弹层', () => {
  assert.deepEqual(providers.dismissTextFor('kimi'), ['我知道了']);
  for (const id of ['chatgpt', 'gemini', 'deepseek', 'workbuddy']) {
    assert.deepEqual(providers.dismissTextFor(id), [], `${id} 没见过这种弹层，不该去猜按钮`);
  }
  assert.ok(!providers.dismissTextFor('kimi').includes('去升级'));
});

// 登录着也用不了：Kimi 排队高峰把整页转到 /membership/pricing，连输入框都没有。
// 和 signedOutPaths 分开声明，因为给出路完全不同（稍后再试 / 关闭通道，不是去登录）。
test('只有 Kimi 声明了付费墙路径', () => {
  assert.deepEqual(providers.blockedPathsFor('kimi'), ['/membership/pricing']);
  for (const id of ['chatgpt', 'gemini', 'deepseek', 'workbuddy']) {
    assert.deepEqual(providers.blockedPathsFor(id), [], `${id} 没见过付费墙`);
  }
});

// 2026-11-07 真机：DeepSeek 连问多次后弹点图验证，页面写「点击图中最小的
// 蓝色三棱柱」。只声明站点真正会用的短语，且不声明任何「答题」动作——识别
// 只为请人去点，不为代替人去解。
test('只有真人机验证声明了验证短语，且不含任何代答动作', () => {
  assert.ok(providers.challengeTextFor('deepseek').length > 0);
  assert.ok(providers.challengeTextFor('chatgpt').length > 0);
  assert.deepEqual(providers.challengeTextFor('gemini'), []);
  assert.deepEqual(providers.challengeTextFor('kimi'), []);
  for (const id of ['deepseek', 'chatgpt']) {
    const words = providers.challengeTextFor(id);
    assert.ok(words.every(word => !/点击|click|solve|solveChallenge/i.test(word) || word.includes('点击图中')),
      `${id} 的验证短语里不该出现动作指令`);
  }
});
