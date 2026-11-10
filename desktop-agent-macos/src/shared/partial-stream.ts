/**
 * 网页流式与工具请求防护的两个纯函数。
 *
 * 网页不是 SSE：它只会一段段把字打在 DOM 里。我们能做的是**轮询已渲染的部分**，
 * 把「这一版比上一版多了什么」算出来。网页还会改写自己：Markdown 收尾、代码块
 * 合拢、引用 chip 后插，都会让新文本不再以旧文本开头。这时只能整段替换（reset），
 * 不能硬拼——拼出来的会是「半截旧 + 半截新」。
 *
 * 另一个函数是工程模式专用的：模型第一个回答可能只是一行读文件请求
 * `{"tool":…}`。流式如果把它当正文先打出来，用户会先看到一段 JSON，再看到真正
 * 的回答。所以在缓冲区还没法排除「这是 JSON」之前，一个字都不发。
 */

export interface PartialDiff {
  /** 追加到已有文本后面的部分。 */
  append?: string;
  /** 网页改写了自己：用这一版整段替换。 */
  reset?: string;
}

export function diffPartial(previous: string, next: string): PartialDiff | null {
  if (!next || next === previous) return null;
  if (next.startsWith(previous)) {
    const append = next.slice(previous.length);
    return append ? { append } : null;
  }
  return { reset: next };
}

/**
 * 这段开头还可能是工具请求吗？
 *
 * 返回 true 时不要显示：等到出现第一个非空白字符后再判断，以 `{` 开头的都先
 * 按住。普通回答很少以 `{` 开头；即使真的以代码块开头，也会是 ``` 而不是 `{`。
 */
export function mightBeToolRequest(buffer: string): boolean {
  const trimmed = buffer.replace(/^\s+/, '');
  if (trimmed.length === 0) return true;
  return trimmed.startsWith('{');
}

/** 已经可以确定不是工具请求：出现第一个非 `{` 的非空白字符。 */
export function notToolRequest(buffer: string): boolean {
  const trimmed = buffer.replace(/^\s+/, '');
  return trimmed.length > 0 && !trimmed.startsWith('{');
}
