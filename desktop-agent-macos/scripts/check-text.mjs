/**
 * Behaviour tests for page-text cleaning.
 *
 * Both rules here exist because of text that was actually captured from a live
 * page: a DeepSeek answer that arrived as prose interrupted by a vertical column
 * of dashes and digits, and the disclaimers both sites put under every reply.
 * Cleaning is the one place where "what the page looks like" is allowed to
 * differ from "what the answer is", so it is worth pinning down.
 *
 * Run with: npm run test:text
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cutSpeakerLabels, normalizeAnswerText, stripChrome } from '../out-test/shared/text.js';

test('the prompt echo in front of the assistant label is cut away', () => {
  // Captured from chatgpt.com: the page flattens its speaker labels into the
  // transcript, and the reflowed prompt defeats an exact-string echo check.
  const raw =
    '你说：你是我在 ThinkFusion 里的研究伙伴，我们直接对话。几点要求：1. 用自然语言回答。' +
    'ChatGPT 说：Redis 连接数过高的一个常见原因是连接池没有复用。';
  assert.equal(cutSpeakerLabels(raw), 'Redis 连接数过高的一个常见原因是连接池没有复用。');
});

test('a label the answer itself quotes does not truncate it', () => {
  const raw = 'ChatGPT 说：回答里提到 ChatGPT 说：这个标签只是示例。';
  assert.equal(cutSpeakerLabels(raw), '这个标签只是示例。');
});

test('citation chips do not survive as a column of dashes and digits', () => {
  // Captured verbatim from chat.deepseek.com: the references are inline chips,
  // and innerText reports each one on its own line.
  const raw =
    'Redis 连接数过高最常见的原因是客户端代码存在连接泄漏：应用获取连接后没有正确关闭或归还连接池。-\n2\n-\n5\n-\n8\n\n' +
    '需要说明的是，这个判断有一个前提——它适用于“连接数持续上涨且不回落”的场景。-\n1\n-\n9';

  const clean = normalizeAnswerText(raw);

  assert.equal(clean.includes('-\n'), false, 'no dash line survives');
  assert.match(clean, /归还连接池。$/m, 'the sentence it interrupted is intact');
  assert.match(clean, /^需要说明的是/m, 'the next paragraph starts where it should');
  assert.equal(clean.includes('\n\n\n'), false, 'blank runs are collapsed');
});

test('a numbered list is not mistaken for citation chips', () => {
  // The rule removes a dash *followed by* a number. A list renders as "1. …",
  // which is a different shape and must survive untouched.
  const raw = '排查顺序：\n1. 看连接数是否回落\n2. 看是否有连接池上限\n3. 看客户端版本';
  assert.equal(normalizeAnswerText(raw), raw);
});

test('site furniture is removed by exact line, not by substring', () => {
  const raw = [
    'Redis 连接数过高的原因是连接泄漏。',
    '内容由 AI 生成，请仔细甄别',
    'ChatGPT 可能会出错。请核查重要信息。',
    '深度思考',
    '智能搜索',
    '分享'
  ].join('\n');

  const clean = stripChrome(raw);
  assert.equal(clean, 'Redis 连接数过高的原因是连接泄漏。');
});

test('a sentence that merely mentions AI-generated content is kept', () => {
  // The reason the furniture list matches whole lines: an answer *about* this
  // exact topic would otherwise be deleted.
  const answer = '内容由 AI 生成的内容需要人工复核，这是合规要求。';
  assert.equal(stripChrome(answer), answer);
});

test('upgrade banners inside the transcript are removed from the answer', () => {
  // Captured from chatgpt.com: the banner sits in the transcript container, so
  // innerText glued it onto the end of a real answer.
  const raw =
    'Redis 连接数过高的一个常见原因是连接池没有复用。' +
    '你正在使用 ChatGPT 免费版。升级即可使用高级模型、更强的记忆功能，并生成更高质量的图像。' +
    '升级至 GoChatGPT 可能会出错。请核查重要信息。最新一条回复';

  assert.equal(stripChrome(raw), 'Redis 连接数过高的一个常见原因是连接池没有复用。');
});

test('indentation inside an answer is never touched', () => {
  const code = '排查：\n```\n  redis-cli info clients\n```\n  上面一行看 connected_clients';
  assert.equal(stripChrome(code), code);
});

test('cleaning an empty page yields an empty answer, not whitespace', () => {
  assert.equal(normalizeAnswerText(''), '');
  assert.equal(normalizeAnswerText('   \n\n  \n'), '');
  assert.equal(stripChrome(''), '');
});

test("Gemini's shell is not an answer", () => {
  // Captured on the guest page before the reply existed: the user bubble, the
  // model picker and the disclaimer. It sat still for seconds and the app
  // reported it as Gemini's answer.
  const shell = [
    '与 Gemini 对话',
    'Gemini 3.5 Flash-Lite',
    '你说 3+5。结果是多少',
    'Gemini 是一款 AI 工具，其回答未必正确无误。',
    '登录即可关联到 Google 应用、制作图片等等'
  ].join('\n');

  const cleaned = stripChrome(cutSpeakerLabels(shell)).trim();
  assert.equal(cleaned.replace(/\s+/g, ''), '3+5。结果是多少', '只应剩用户自己那句话');
});

test('the assistant label is cut even without its colon', () => {
  // Gemini renders "Gemini 说\n18" — no colon, and the label is on its own line.
  assert.equal(cutSpeakerLabels('你说 3+5\nGemini 说 18').trim(), '18');
});
