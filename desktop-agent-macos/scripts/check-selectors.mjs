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
