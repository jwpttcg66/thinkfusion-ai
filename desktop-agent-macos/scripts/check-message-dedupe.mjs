/**
 * 提交时的占位气泡不能被主进程推来的同一句话再追加一次。
 *
 * Run with: npm run test:message-dedupe
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeConversationMessage } from '../out-test/shared/conversation.js';

const message = (messageId, conversationId, role, text) => ({
  messageId, conversationId, role, text, at: 1
});

test('占位用户气泡被落库消息替换，不会出现两个「你」', () => {
  const text = '编写一个java工程，输出当前系统时间';
  const before = [message('pending-pending-1', 'pending-1', 'user', text)];
  const after = mergeConversationMessage(before, message('uuid-real', 'conv-1', 'user', text));
  assert.equal(after.length, 1);
  assert.equal(after[0].messageId, 'uuid-real');
  assert.equal(after[0].conversationId, 'conv-1');
});

test('同一会话连续两次同文提问都保留', () => {
  const text = '继续';
  // 没有占位时正常追加；前面的同文落库消息不能被当成占位并掉。
  const before = [message('uuid-1', 'conv-1', 'user', text)];
  const after = mergeConversationMessage(before, message('uuid-2', 'conv-1', 'user', text));
  assert.equal(after.length, 2);
  assert.deepEqual(after.map(item => item.messageId), ['uuid-1', 'uuid-2']);
});

test('同一 messageId 重复推送仍只保留一条', () => {
  const first = message('uuid-1', 'conv-1', 'channel', '回答');
  const after = mergeConversationMessage([first], first);
  assert.equal(after.length, 1);
});
