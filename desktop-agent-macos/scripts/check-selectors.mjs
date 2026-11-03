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

test('every built-in profile covers all six roles', () => {
  const { SELECTOR_ROLES } = sharedSelectors;
  for (const [id, profile] of Object.entries(providers.PROVIDERS)) {
    for (const role of SELECTOR_ROLES) {
      assert.ok(Array.isArray(profile.selectors[role]) && profile.selectors[role].length > 0, `${id} 缺少 ${role}`);
    }
  }
});
