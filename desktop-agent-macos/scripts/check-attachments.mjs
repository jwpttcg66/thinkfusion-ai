/**
 * 「＋ · 添加文件」的行为测试。
 *
 * 要钉住的是四件事：
 * 1. 没有附件时，问题与原来逐字相同——这是「不发固定提示词」那条硬规则
 *    在附件这条路上也要成立；
 * 2. 有附件时，用户原话在最前面，附件带标题行跟在后面，截断要说清楚；
 * 3. 读盘在发送那一刻：文件不在、是目录、是二进制、太大，都明确报错，
 *    而且**不留下一条「问过了」的会话**；
 * 4. 会话里只存引用（名字、路径、体积），正文不落盘。
 *
 * Run with: npm run test:attachments
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  attachmentCharBudget,
  buildAttachmentMaterial,
  composeQuestionWithAttachments,
  dedupeAttachments,
  describeAttachments,
  describeBytes,
  MAX_ATTACHMENT_CHARS,
  MAX_ATTACHMENT_TOTAL_CHARS
} from '../out-test/shared/attachments.js';
import { attachFiles, readAttachmentTexts, referenceFiles } from '../out-test/main/attachments.js';
import { ConversationRunner } from '../out-test/main/conversation-runner.js';

const work = mkdtempSync(join(tmpdir(), 'tf-attachments-'));
after(() => rmSync(work, { recursive: true, force: true }));

function textFile(name, content) {
  const file = join(work, name);
  writeFileSync(file, content);
  return file;
}

function attach(id, name, text, extra = {}) {
  return {
    id,
    name,
    path: `/tmp/${name}`,
    bytes: text.length,
    addedAt: 0,
    text,
    chars: text.length,
    totalChars: text.length,
    truncated: false,
    ...extra
  };
}

// ---------------------------------------------------------------------------
// 1. 拼装
// ---------------------------------------------------------------------------

test('没有附件时，问题一字不改', () => {
  assert.equal(composeQuestionWithAttachments('  这份日志有多少行？  ', []), '这份日志有多少行？');
});

test('有附件时：用户原话在前，附件带标题行在后', () => {
  const composed = composeQuestionWithAttachments('这份日志有多少行？', [
    attach('a', 'stream.log', '[INFO] 一行\n[WARN] 两行')
  ]);
  const lines = composed.split('\n');
  assert.equal(lines[0], '这份日志有多少行？');
  // 原话与附件之间空一行；标题行自己占一行。
  assert.equal(lines[1], '');
  assert.match(lines[2], /^【附件 1】stream\.log（/);
  assert.ok(composed.includes('[WARN] 两行'));
  // 附件之间空一行，读起来是两块内容，不是一整段。
  const two = composeQuestionWithAttachments('看看这两份', [
    attach('a', 'a.md', 'AAA'),
    attach('b', 'b.md', 'BBB')
  ]);
  assert.match(two, /【附件 1】a\.md/);
  assert.match(two, /【附件 2】b\.md/);
  assert.ok(two.indexOf('AAA') < two.indexOf('【附件 2】'));
});

test('截断要说清楚带上去多少、全文多少', () => {
  const composed = composeQuestionWithAttachments('看看', [
    attach('a', 'big.csv', 'x'.repeat(100), { chars: 40, totalChars: 100, truncated: true })
  ]);
  assert.match(composed, /已带前 40 字 \/ 全文 100 字/);
  assert.equal(describeAttachments([attach('a', 'big.csv', 'x', { truncated: true })]).includes('只带了前面一段'), true);
});

test('体积按人话写，不出现 0.0 KB', () => {
  assert.equal(describeBytes(0), '0 B');
  assert.equal(describeBytes(800), '800 B');
  assert.equal(describeBytes(2048), '2.0 KB');
  assert.equal(describeBytes(3 * 1024 * 1024), '3.0 MB');
});

test('同一路径只算一份，最多六份', () => {
  const list = Array.from({ length: 9 }, (_, index) => ({
    id: `id${index}`,
    name: `f${index}.md`,
    path: '/tmp/same.md',
    bytes: 1,
    addedAt: 0
  }));
  assert.equal(dedupeAttachments(list).length, 1);
  const many = Array.from({ length: 9 }, (_, index) => ({
    id: `id${index}`,
    name: `f${index}.md`,
    path: `/tmp/${index}.md`,
    bytes: 1,
    addedAt: 0
  }));
  assert.equal(dedupeAttachments(many).length, 6);
});

test('字数预算均分，夹在上下限之间', () => {
  assert.equal(attachmentCharBudget(1), MAX_ATTACHMENT_CHARS);
  assert.equal(attachmentCharBudget(6), Math.min(MAX_ATTACHMENT_CHARS, Math.floor(MAX_ATTACHMENT_TOTAL_CHARS / 6)));
  assert.equal(attachmentCharBudget(0), 0);
});

// ---------------------------------------------------------------------------
// 2. 读盘
// ---------------------------------------------------------------------------

test('挑中的文件读成正文，元信息来自真实磁盘', () => {
  const file = textFile('note.md', '# 标题\n正文');
  const [ref] = referenceFiles([file]);
  assert.equal(ref.name, 'note.md');
  assert.ok(ref.path.endsWith('note.md'));
  assert.equal(ref.bytes, Buffer.byteLength('# 标题\n正文'));

  const [text] = readAttachmentTexts([ref]);
  assert.equal(text.text, '# 标题\n正文');
  assert.equal(text.truncated, false);
  assert.equal(text.totalChars, text.text.length);
});

test('超过单份上限就截断，并标出全文多少字', () => {
  const body = 'a'.repeat(30_000);
  const [text] = readAttachmentTexts(referenceFiles([textFile('long.log', body)]));
  assert.equal(text.truncated, true);
  assert.equal(text.chars, MAX_ATTACHMENT_CHARS);
  assert.equal(text.totalChars, 30_000);
  assert.equal(text.text.length, MAX_ATTACHMENT_CHARS);
});

test('二进制文件拒绝，不当成一堆替换字符发出去', () => {
  const file = join(work, 'blob.bin');
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x0d]));
  assert.throws(() => attachFiles([file]), /二进制/);
});

test('文件不在了、是目录、太大，都明确报错', () => {
  assert.throws(() => referenceFiles([join(work, '没有这个文件.txt')]), /文件不在了/);
  assert.throws(() => referenceFiles([work]), /不是文件/);

  const huge = join(work, 'huge.log');
  writeFileSync(huge, Buffer.alloc(5 * 1024 * 1024, 0x61));
  assert.throws(() => attachFiles([huge]), /超过/);
});

// ---------------------------------------------------------------------------
// 3. 提问链路：附件真的随这一问发出去
// ---------------------------------------------------------------------------

function fakeStore() {
  const conversations = new Map();
  const messages = [];
  return {
    listConversations: () => [...conversations.values()],
    getConversation: id => conversations.get(id) ?? null,
    listMessages: id => messages.filter(message => message.conversationId === id),
    upsertConversation: conversation => conversations.set(conversation.conversationId, conversation),
    appendMessage: message => messages.push(message),
    deleteConversation: id => {
      conversations.delete(id);
    }
  };
}

function makeRunner(onAsk) {
  const store = fakeStore();
  const channel = {
    id: 'page-a',
    label: '页面 A',
    identity: { id: 'page-a', label: '页面 A', kind: 'provider', role: '代表页面 A' },
    async health() {
      return { id: 'page-a', label: '页面 A', available: true, loggedIn: true, pageReady: true, generating: false };
    },
    async ask(input) {
      const question = input.question;
      onAsk(question);
      return {
        agentId: 'page-a',
        stage: input.stage,
        channelId: 'page-a',
        text: '这是回答。',
        receivedAt: Date.now(),
        attribution: { requestId: 'r1', note: 'test' }
      };
    },
    cancel() {}
  };
  const channels = [channel];
  const registry = {
    all: async () => channels,
    available: async () => channels,
    get: id => channels.find(item => item.id === id),
    ask: async (id, input) => channel.ask(input),
    newConversation: async () => ({ ok: true }),
    deleteConversation: async () => ({ ok: true }),
    cancel() {},
    cancelAll() {}
  };
  const runner = new ConversationRunner({
    store,
    registry,
    emit: () => undefined,
    budgetMs: 5_000,
    submitWorkspace: async () => {
      throw new Error('unexpected workspace hand-off');
    },
    readAttachments: paths => attachFiles(paths)
  });
  return runner;
}

async function settle(runner, conversationId, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const conversation = runner.get(conversationId);
    if (conversation && ['answered', 'failed', 'cancelled'].includes(conversation.status)) return conversation;
    if (Date.now() > deadline) throw new Error(`conversation did not settle: ${conversation?.status}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('附件随这一问发到通道，原话在最前面，会话只存引用', async () => {
  const sent = [];
  const runner = makeRunner(question => sent.push(question));
  const file = textFile('stream.log', '[INFO] 开始\n[WARN] 掉线\n');

  const started = await runner.start({ text: '这份日志有几条 WARN？', attachments: [file] });
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered');
  assert.ok(sent.length > 0, '通道必须被问到');
  assert.ok(sent[0].startsWith('这份日志有几条 WARN？'), '用户原话在最前面');
  assert.ok(sent[0].includes('【附件 1】stream.log'));
  assert.ok(sent[0].includes('[WARN] 掉线'));

  // 会话里只有引用，没有正文。
  assert.equal(done.attachments.length, 1);
  assert.equal(done.attachments[0].name, 'stream.log');
  assert.equal(Object.hasOwn(done.attachments[0], 'text'), false);

  // 提问气泡仍是原话；附件在一条系统消息里说清楚。
  const messages = runner.messages(started.conversationId);
  assert.equal(messages.find(message => message.role === 'user').text, '这份日志有几条 WARN？');
  assert.ok(messages.some(message => message.role === 'system' && message.text.includes('stream.log')));
});

test('没有附件时照旧逐字发出去', async () => {
  const sent = [];
  const runner = makeRunner(question => sent.push(question));
  const started = await runner.start({ text: '3+5。结果是多少' });
  await settle(runner, started.conversationId);
  assert.deepEqual([...new Set(sent)], ['3+5。结果是多少']);
});

test('附件读不出来就不发问，也不留下一条空会话', async () => {
  const sent = [];
  const runner = makeRunner(question => sent.push(question));
  const before = runner.list().length;
  await assert.rejects(
    runner.start({ text: '看看这份', attachments: [join(work, '不存在.log')] }),
    /文件不在了/
  );
  assert.equal(sent.length, 0, '读盘失败不该发问');
  assert.equal(runner.list().length, before);
});

test('追问带的附件同样拼在原话后面', async () => {
  const sent = [];
  const runner = makeRunner(question => sent.push(question));
  const first = await runner.start({ text: '先问一句' });
  await settle(runner, first.conversationId);

  sent.length = 0;
  const file = textFile('config.json', '{"port": 8080}');
  await runner.followup(first.conversationId, '这个端口是多少？', undefined, undefined, [file]);
  // 追问是异步跑的：等通道真的被问到，而不是等会话状态（它还停在上一轮的
  // answered 上，那样会立刻返回、什么都没验到）。
  await waitFor(() => sent.length > 0);

  assert.ok(sent[0].startsWith('这个端口是多少？'));
  assert.ok(sent[0].includes('"port": 8080'));
  const stored = runner.get(first.conversationId);
  assert.equal(stored.attachments[0].name, 'config.json');
});

test('目录当成附件会被拒绝', async () => {
  const runner = makeRunner(() => undefined);
  mkdirSync(join(work, 'a-dir'), { recursive: true });
  await assert.rejects(runner.start({ text: '看看', attachments: [join(work, 'a-dir')] }), /不是文件/);
});

test('附件正文单独成材料，不是只能混在问题里', () => {
  // 真机 2026-11-09：用户附一份日志问「分析总行数」，日志开头写着总行数，
  // 第一手成员也答出来了，但最终结论是「无法确定」——附件正文只拼在
  // 【用户的问题】里，汇总纪律「只依据各来源的回答」就把它排除了。
  const text = {
    id: 'p1', name: 'run.log', path: '/tmp/run.log', bytes: 120,
    addedAt: 1, text: 'total lines: 414068\nstatus: ok', chars: 32, totalChars: 32, truncated: false
  };
  const material = buildAttachmentMaterial([text]);
  assert.ok(material.includes('run.log'));
  assert.ok(material.includes('414068'), '材料里必须有文件正文');
  assert.match(material, /不是模型推测/, '要说明这是用户亲手挑的原文，否则汇总不当作可引用依据');
  assert.equal(buildAttachmentMaterial([]), '', '没有附件时不产生任何材料段');
});

test('材料段与问题段分工清楚：原话只在问题里，正文两边都在但语义不同', () => {
  // 「原话只出现一次」是硬规则：材料段不重复用户的话，否则执行阶段会看到
  // 两份问题，主导人容易把材料当成第二段指令。
  const text = {
    id: 'p2', name: 'notes.md', path: '/tmp/notes.md', bytes: 40,
    addedAt: 1, text: '总行数是 414068', chars: 12, totalChars: 12, truncated: false
  };
  const question = composeQuestionWithAttachments('分析总行数', [text]);
  const material = buildAttachmentMaterial([text]);

  assert.ok(question.startsWith('分析总行数'), '问题段必须以用户原话开头');
  assert.ok(!material.includes('分析总行数'), '材料段不重复用户原话');
  assert.ok(material.includes('414068') && question.includes('414068'));
});
