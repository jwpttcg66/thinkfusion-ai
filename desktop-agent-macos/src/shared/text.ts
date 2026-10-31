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
  /^(?:赞|踩)$/
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
  /内容由 ?AI ?生成[，,]?\s*请仔细甄别[。.]?/g,
  /ChatGPT 可能会出错[。.]?\s*请核查重要信息[。.]?/g,
  /ChatGPT can make mistakes[.。]?\s*Check important info[.。]?/g
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
 * Both sites render these for screen readers, and `innerText` flattens them
 * into the middle of the transcript, so a captured answer arrives as
 * "…你说：<our whole prompt>ChatGPT 说：<the answer>". Everything up to the
 * assistant label is the echo of our own question — and since the page reflows
 * that prompt, an exact-string echo check no longer matches it. The label is the
 * boundary the page itself draws, so it is the reliable one to cut on.
 */
const ASSISTANT_LABELS = [/ChatGPT\s*说[：:]/, /ChatGPT\s+said[：:]/i];
const USER_LABELS = [/你说[：:]/, /You\s+said[：:]/i];

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
