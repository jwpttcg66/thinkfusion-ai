/**
 * Cleaning up what a chat page hands us.
 *
 * `innerText` is a picture of the page, not of the answer. It carries the site's
 * furniture (disclaimers, "share", screen-reader labels) and the site's own
 * decoration (citation chips, which arrive as a vertical column of dashes and
 * digits). Both are invisible to a reader looking at the page and extremely
 * visible once the text is lifted into a bubble — so they are removed here, at
 * the one boundary where page text becomes app text.
 *
 * This module is deliberately dumb and pure: no DOM, no timing, no network. It
 * is the part of extraction that can be tested by reading it.
 */

/**
 * Lines that are page furniture, matched exactly.
 *
 * Exact, never substring: "内容由 AI 生成" is furniture, but an answer *about*
 * AI-generated content is not, and a substring rule cannot tell them apart.
 */
const CHROME_LINES: readonly RegExp[] = [
  /^内容由 ?AI ?生成[，,]?\s*请仔细甄别[。.]?$/,
  /^内容由 ?AI ?生成$/,
  /^ChatGPT (?:可能会出错|can make mistakes)[。.]?\s*(?:请核查重要信息|Check important info)[。.]?$/,
  /^深度思考(?:\(R1\))?$/,
  /^智能搜索$/,
  /^联网搜索$/,
  /^分享$/,
  /^升级订阅$/,
  /^跳转到内容$/,
  /^你说：?$/,
  /^ChatGPT 说：?$/,
  /^复制$/,
  /^重新生成$/,
  /^(?:赞|踩)$/,
  // ChatGPT's status line under a finished reply. Measured: the bubble comes
  // back as 「8回答已完成」 — the answer and this, with no separator.
  /^回答已完成$/,
  /^回答中$/,
  /^正在回答$/,
  // Gemini's shell. A new conversation renders the user bubble, the model
  // picker and the disclaimer before the answer exists; measured on the guest
  // page, that text sat still for seconds and was captured as the reply
  // （「3+5。结果是多少 Gemini 是一款 AI 工具…」）. None of it is ever an answer.
  /^与 ?Gemini ?对话$/,
  /^Gemini [\d.]+\s+\S+$/,
  /^Gemini 是一款 ?AI ?工具[，,]\s*其回答未必正确无误[。.]?$/,
  /^Gemini can make mistakes[.。]?.*$/
];

/**
 * Furniture that arrives *inside* a line, so a whole-line rule cannot see it.
 *
 * These are the sites' own promotional and legal strings. They sit inside the
 * transcript container, which means `innerText` mixes them into the answer:
 * a captured reply ended with "…无法在应用间共享复用。你正在使用 ChatGPT 免费版。
 * 升级即可使用高级模型…". Deleting them by exact phrase is safe in a way that a
 * looser rule would not be — nobody answers a technical question in ChatGPT's
 * upgrade copy, verbatim.
 */
const CHROME_PHRASES: readonly RegExp[] = [
  /你正在使用 ?ChatGPT ?免费版[。.]?/g,
  /升级即可使用高级模型[^。]*。?/g,
  /升级至 ?Go/g,
  /最新一条回复/g,
  /到目前为止[，,]?这段对话对你有帮助吗[？?]?/g,
  /内容由 ?AI ?生成[，,]?\s*请仔细甄别[。.]?/g,
  /ChatGPT 可能会出错[。.]?\s*请核查重要信息[。.]?/g,
  /ChatGPT can make mistakes[.。]?\s*Check important info[.。]?/g,
  // Gemini's footer, whether or not it lands on its own line.
  /Gemini 是一款 ?AI ?工具[，,]\s*其回答未必正确无误[。.]?/g,
  /登录即可关联到 ?Google ?应用[^。]*。?/g,
  // ChatGPT's status line, when `innerText` glues it to the answer instead of
  // putting it on its own line （「8回答已完成」）.
  /回答已完成|回答中/g
];

/** Remove whole lines that are page furniture. */
export function stripChrome(raw: string): string {
  if (!raw) return '';
  const kept = raw
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return true;
      return !CHROME_LINES.some(pattern => pattern.test(trimmed));
    });
  let text = kept.join('\n');
  for (const phrase of CHROME_PHRASES) text = text.replace(phrase, '');
  // No whitespace collapsing here on purpose: an answer can contain indented
  // code, and "tidy up the gaps" is how that indentation gets destroyed. A
  // leftover double space is invisible; a flattened code block is not.
  return text;
}

/**
 * Speaker labels the page puts in front of each message.
 *
 * Every driven site renders these for screen readers, and `innerText` flattens them
 * into the middle of the transcript, so a captured answer arrives as
 * "…你说：<our whole prompt>ChatGPT 说：<the answer>". Everything up to the
 * assistant label is the echo of our own question — and since the page reflows
 * that prompt, an exact-string echo check no longer matches it. The label is the
 * boundary the page itself draws, so it is the reliable one to cut on.
 */
const ASSISTANT_LABELS = [
  /ChatGPT\s*说[：:]/,
  /ChatGPT\s+said[：:]/i,
  // Gemini's label carries no colon and lives on its own line: a bubble's
  // innerText is "Gemini 说\n18". Without this the answer arrives prefixed with
  // the site's speaker label — measured on gemini.google.com, signed out.
  /Gemini\s*说[：:]?/,
  /Gemini\s+said[：:]?/i
];
// Gemini writes the label without a colon — 「你说 3+5。结果是多少」 — so the
// colon-only rule left 「你说」 in front of the question, and with the question
// cut out the answer became the two characters 「你说」. Anchored to the line
// start so an answer that quotes the words 「你说」 keeps them.
const USER_LABELS = [/^[ \t]*你说[：:]?[ \t]*/gm, /^[ \t]*You\s+said[：:]?[ \t]*/gim];

export function cutSpeakerLabels(raw: string): string {
  if (!raw) return '';
  let text = raw;
  for (const label of ASSISTANT_LABELS) {
    const matches = [...text.matchAll(new RegExp(label.source, 'gi'))];
    const last = matches[matches.length - 1];
    // Last, not first: an answer can quote the label, and only the final one
    // marks where the assistant's own text begins.
    if (last && typeof last.index === 'number') text = text.slice(last.index + last[0].length);
  }
  for (const label of USER_LABELS) text = text.replace(label, '');
  return text;
}

/**
 * Turn lifted page text into something that reads like the answer.
 *
 * The citation rule is the one that matters. A site renders references as inline
 * chips; `innerText` reports each chip on its own line, so a finished sentence
 * arrives followed by
 *
 *     累积。-
 *     2
 *     -
 *     5
 *
 * which is unreadable in a bubble. The chips always come as a dash line plus a
 * number, so the pair is removed together — a number on its own is left alone,
 * because a numbered list also produces one.
 */
export function normalizeAnswerText(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/[-–—][ \t]*\n[ \t]*\d{1,3}(?=\n|$)/g, '')
    .replace(/^[ \t]*[-–—•·][ \t]*$/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 整段只是页面在说「我还在想」——不是回答。
 *
 * 站点在生成前会先渲染一行状态字（Kimi：「正在思考中」，ChatGPT：「回答中」），
 * 回答气泡本身也已经存在了。那一行会静止好几秒，完全满足「三段一样的文本」这条
 * 稳定判据，于是被当成答案收下来：实测卡片里出现的就是 10 个字的
 * 「正在思考中 / User」，而真正的答案几秒后才到。
 *
 * 只判「整段都是这些词」，不做行内删除：回答里出现 User 这个词（代码、示例）
 * 很常见，只有整段只剩状态词时它才不可能是答案。
 */
const PLACEHOLDER_LINES: ReadonlySet<string> = new Set([
  '正在思考中',
  '思考中',
  '思考已完成',
  '正在生成',
  '生成中',
  '正在回答',
  'User',
  '你说',
  'You',
  'ChatGPT',
  'Gemini',
  'Kimi'
]);

export function looksLikePlaceholder(text: string): boolean {
  const lines = text
    .split('\n')
    .map(line => line.trim().replace(/[：:]\s*$/, ''))
    .filter(line => line.length > 0);
  if (lines.length === 0) return true;
  return lines.every(line => PLACEHOLDER_LINES.has(line));
}
