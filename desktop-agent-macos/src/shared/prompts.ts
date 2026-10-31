import type { IntentKind } from './intent';

/**
 * Prompts for the conversation path.
 *
 * Kept apart from `protocol.ts` on purpose. That file exists to make a model
 * emit `desktop-agent/v1` JSON, and every line of it is about format. This file
 * is the opposite: it never mentions a format, because a research partner that
 * is thinking about JSON is not thinking about the question.
 *
 * The one rule that matters here: the user's text goes out verbatim. The role
 * line is a preamble, not a rewrite.
 */

/**
 * Stable role line, sent once at the start of a conversation.
 *
 * Only once, because the page keeps its own context: repeating this every turn
 * would slowly turn the chat into a sequence of instructions rather than a
 * conversation, and web chat pages start truncating older turns.
 */
export const CONVERSATION_ROLE = `你是我在 ThinkFusion 里的研究伙伴，我们直接对话。

几点要求：
1. 用自然语言回答，不要输出 JSON，也不要输出执行计划或步骤清单。
2. 信息不足时，先给出你能确定的部分，再用一句话说明还缺什么，不要空转。
3. 有分歧、有前提条件、或你不确定的地方，明确标出来，不要抹平成一个平滑的结论。
4. 你没有本地文件访问权限，也不要假设能读写我的磁盘。

下面是用户的真实问题。`;

const STAGE_PREAMBLE: Record<Exclude<IntentKind, 'workspace'>, string> = {
  answer: '',
  research: '这是一个需要调查的问题。请给出你的判断和依据，并指出你不确定的部分。',
  compare: '请对下面这些选项做比较。给出判断时说明依据，并指出在什么条件下结论会反转。',
  extract: '请读下面这个链接的内容并提炼要点。如果无法访问，直接说明，不要凭标题猜测内容。'
};

/**
 * Builds the text actually sent to a channel.
 *
 * `first` decides whether the role line is included; `stage` decides whether a
 * one-line framing is added. Neither ever replaces the user's words — the
 * question is appended last, unchanged.
 */
export function buildConversationPrompt(input: {
  question: string;
  intent: Exclude<IntentKind, 'workspace'>;
  first: boolean;
  followup: boolean;
}): string {
  const parts: string[] = [];

  if (input.first) parts.push(CONVERSATION_ROLE);

  // On a follow-up the page already holds the framing, so repeating it reads as
  // a new instruction and the model starts over instead of continuing.
  if (!input.followup) {
    const preamble = STAGE_PREAMBLE[input.intent];
    if (preamble) parts.push(preamble);
  }

  parts.push(input.question);
  return parts.join('\n\n');
}

/**
 * A targeted challenge, used when two channels disagree.
 *
 * The disagreement is handed over as a claim to adjudicate, not as "please
 * reconsider" — the latter produces agreement, which is the opposite of what a
 * conflict is for.
 */
export function buildChallengePrompt(input: { question: string; stance: string; counter: string }): string {
  return `关于这个问题：

${input.question}

一种说法是：${input.stance}

另一种说法是：${input.counter}

这两者不可能同时成立。请判断哪一种更站得住脚，说明你的依据，并指出对方说法在什么条件下才是对的。不要两边都同意。`;
}
