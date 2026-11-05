/**
 * 执行阶段：主导人的三步。
 *
 * 用户裁决（2026-11-05）：执行模式 = 谁当主导人。主导人不只是"写一段结论"，
 * 他要做三件事：
 *
 *   1. 汇总——读完全部网页回答，写【结论/一致/分歧/存疑】；
 *   2. 指定辩论——从分歧里点出要辩的议题（【辩题】），没有实质分歧就写「无」；
 *   3. 获取辩论——读懂辩论记录，给出最终意见。
 *
 * 第一步和第二步合成一次调用：汇总完紧接着列辩题，主导人自己决定要不要辩、
 * 辩什么。第三步是另一次调用——它必须等辩论真的跑完。
 */

export interface LeadAnswer {
  channelId: string;
  label: string;
  text: string;
}

/**
 * 汇总 + 定辩题。
 *
 * 这段只发给本地/云端模型时才是 system；网页主导时页面会忽略 system，所以
 * 同一段要求也要能拼进 question 正文（`buildLeadSummaryQuestion` 的
 * `inlineInstructions`）。页面收到的仍然是一整段用户消息，不会有角色话术。
 */
export const LEAD_SUMMARY_SYSTEM: string[] = [
  '你在读多个网页 AI 对同一个问题的回答，并担任这一轮的主导人。',
  '只依据这些回答做事，不要补充它们没说过的事实，也不要替它们编造依据。',
  '按下面五段输出，每段简短，不要复述整篇回答：',
  '【结论】直接回答问题；如果回答之间没有形成可用的结论，就写「这轮没有形成结论」并说明卡在哪。',
  '【一致】各来源都说到的点；没有就写「没有」。',
  '【分歧】彼此矛盾的地方，写清各自立场并标注来源编号；没有就写「没有」。',
  '【存疑】证据薄弱、只有一处在说、答非所问的地方；回答明显残缺也要指出是哪个来源。',
  '【辩题】如果分歧会影响结论，列出需要辩清楚的议题，一行一条，用问句；没有实质分歧就只写「无」。'
];

export const LEAD_SUMMARY_TIMEOUT_MS = 120_000;

export function buildLeadSummaryQuestion(
  question: string,
  answers: readonly LeadAnswer[]
): string {
  const body = answers
    .map((answer, index) => `【来源${index + 1}】${answer.label}\n${answer.text.trim()}`)
    .join('\n\n');
  return `【用户的问题】\n${question.trim()}\n\n【各来源的回答】\n${body}`;
}

/** 网页主导专用：页面不认 system，把同样的话作为用户消息的一部分发进去。 */
export function inlineLeadInstructions(question: string, answers: readonly LeadAnswer[]): string {
  const body = answers
    .map((answer, index) => `【来源${index + 1}】${answer.label}\n${answer.text.trim()}`)
    .join('\n\n');
  return [
    `【用户的问题】\n${question.trim()}`,
    `【各来源的回答】\n${body}`,
    `【请你做的事】\n${LEAD_SUMMARY_SYSTEM.join('\n')}`,
    '直接按【结论】【一致】【分歧】【存疑】【辩题】五段回答，不要复述上面的全部内容。'
  ].join('\n\n');
}

/**
 * 从汇总里取辩题。写「无」「没有」或整段缺失都表示不辩——宁可少辩一场，
 * 也不要为了一句空话让几个模型空转好几轮。
 */
export function parseTopics(summary: string): string[] {
  const match = summary.match(/【辩题】([\s\S]*?)(?:\n【|$)/);
  if (!match) return [];
  // 模型经常把多条辩题写在同一行（「…？2. …」），所以先在句号/问号后的
  // 编号前断行，再按行取。否则一条辩题会把两条粘在一起，辩手读到的是一句混乱的话。
  const normalized = match[1].replace(/([？?。！!])\s*(?=\d{1,2}[.、)）](?!\d))/g, '$1\n');
  return normalized
    .split(/\n|\s(?=\d{1,2}[.、)）](?!\d))/)
    .map(line => line.replace(/^(?:[\s\-*]+|\d{1,2}[.、)）]\s*)+/, '').trim())
    .filter(line => line.length >= 4)
    .filter(line => !/^(无|没有|无需|不辩|none|n\/a)[。.]?$/i.test(line))
    .slice(0, 3);
}

/** 辩论记录转成一段可读文本，交给主导人做最后裁决。 */
export interface DebateDigestRound {
  index: number;
  messages: Array<{ author: string; kind: string; text: string }>;
  failures?: Array<{ agentId: string; detail: string }>;
}

export function formatDebateTranscript(rounds: readonly DebateDigestRound[]): string {
  return rounds
    .map(round => {
      const lines = round.messages.map(
        message => `- ${message.author}（${message.kind}）：${message.text.trim()}`
      );
      const failed = (round.failures ?? []).map(item => `- ${item.agentId} 没有发言：${item.detail}`);
      return `【第 ${round.index + 1} 轮】\n${[...lines, ...failed].join('\n')}`;
    })
    .join('\n\n');
}

export const LEAD_VERDICT_SYSTEM: string[] = [
  '你是这一轮的主导人。前面已经做过汇总，辩手们围绕你列出的辩题进行了交锋。',
  '现在读懂辩论记录，给出最终意见：',
  '1. 先直接回答问题（一句话到几句话）；',
  '2. 说明辩论中哪些质疑成立、哪些不成立，指出具体是哪一句；',
  '3. 如果辩论没有解决分歧，如实说明还差什么证据，不要假装已经定论。',
  '不要复述整篇辩论记录。'
];

export function buildVerdictQuestion(
  question: string,
  summary: string,
  transcript: string
): string {
  return [
    `【用户的问题】\n${question.trim()}`,
    `【你之前的汇总】\n${summary.trim()}`,
    `【辩论记录】\n${transcript.trim()}`,
    '【现在】给出最终意见。'
  ].join('\n\n');
}
