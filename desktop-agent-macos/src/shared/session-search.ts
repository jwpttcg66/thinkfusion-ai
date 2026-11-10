/**
 * 跨会话检索：只读、带来源、0 条不算失败。
 *
 * 这里刻意做成纯函数：主进程把会话与消息喂进来，结果怎么排序、片段怎么截、
 * 来源怎么写，都可以离线测。检索不是「再问一次模型」，是字符串匹配。
 *
 * 三条规矩：
 *
 * - **必须带来源。** 命中来自哪个会话、什么时间、标题是什么，一条都不能少；
 *   跨会话引用不标来源，等于让用户相信一段来路不明的话。
 * - **0 条就是 0 条。** 没搜到不是错误，也不能拿「相似主题」硬凑。
 * - **片段有上下文。** 只给命中词本身，读的人无法判断它说的是什么。
 */

export interface SearchableMessage {
  role: string;
  text: string;
  at: number;
}

export interface SearchableConversation {
  conversationId: string;
  title: string;
  updatedAt: number;
  messages: SearchableMessage[];
}

export interface SessionSearchHit {
  conversationId: string;
  title: string;
  /** 命中位置：标题还是某条消息。 */
  source: 'title' | 'message';
  role?: string;
  at: number;
  snippet: string;
}

export interface SessionSearchResult {
  query: string;
  hits: SessionSearchHit[];
  /** 扫过多少个会话、多少条消息，让「没搜到」也能被核对。 */
  scanned: { conversations: number; messages: number };
}

const MAX_SNIPPET = 160;

function snippetOf(text: string, index: number, queryLength: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const around = 60;
  const start = Math.max(0, index - around);
  const end = Math.min(flat.length, index + queryLength + around);
  const piece = flat.slice(start, end);
  if (piece.length <= MAX_SNIPPET) return `${start > 0 ? '…' : ''}${piece}${end < flat.length ? '…' : ''}`;
  return `${piece.slice(0, MAX_SNIPPET)}…`;
}

export function searchSessions(input: {
  query: string;
  conversations: readonly SearchableConversation[];
  limit?: number;
  conversationId?: string;
}): SessionSearchResult {
  const query = input.query.trim();
  const limit = Math.max(1, Math.min(input.limit ?? 10, 20));
  const needle = query.toLowerCase();
  const hits: SessionSearchHit[] = [];
  let scannedMessages = 0;

  for (const conversation of input.conversations) {
    if (input.conversationId && conversation.conversationId !== input.conversationId) continue;
    const messages = conversation.messages ?? [];
    scannedMessages += messages.length;

    if (conversation.title.toLowerCase().includes(needle)) {
      hits.push({
        conversationId: conversation.conversationId,
        title: conversation.title,
        source: 'title',
        at: conversation.updatedAt,
        snippet: conversation.title
      });
    }

    for (const message of messages) {
      const index = message.text.toLowerCase().indexOf(needle);
      if (index < 0) continue;
      hits.push({
        conversationId: conversation.conversationId,
        title: conversation.title,
        source: 'message',
        role: message.role,
        at: message.at,
        snippet: snippetOf(message.text, index, needle.length)
      });
      if (hits.length >= limit * 4) break;
    }
    if (hits.length >= limit * 4) break;
  }

  return {
    query,
    hits: hits.slice(0, limit),
    scanned: { conversations: input.conversations.length, messages: scannedMessages }
  };
}
