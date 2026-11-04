/**
 * 主导轮：让一个模型读完全部回答，做评判并给出最终答案。
 *
 * 这是产品的核心动作——不是把几段回答并列，而是让一位能读上下文的主导者
 * 指出错误、比较优劣、给出更好的答案。
 *
 * 三种主导者的收件方式不同：
 *
 * - 网页通道：页面读不到别人的回答，只能由我们把各家答案拼成**一条消息**
 *   发进去。它在页面上表现为用户说的第二段话，这是网页模式的固有限制。
 * - 本地 / 云端：走 API，题目照旧原话，评判要求放在 system 轮次里。
 *
 * 因此这里导出两份：`buildLeadPrompt` 给网页（自包含，一段话），
 * `LEAD_SYSTEM` 给 API（结构化指令不进用户问题）。
 */

export interface LeadAnswerInput {
  agentId: string;
  label: string;
  text: string;
}

/**
 * 网页主导时发出去的那段话。
 *
 * 不写「你是一位资深评审」这类角色包装：页面上会把它原样显示成用户发言，
 * 而用户没这么说过。要求写清楚就够——要指出错误、要比较、要给最终答案、
 * 不知道就说不知道。
 */
export function buildLeadPrompt(
  question: string,
  answers: readonly LeadAnswerInput[],
  options: { selfAgentId?: string } = {}
): string {
  const body = answers
    .map((answer, index) => {
      const mark = answer.agentId === options.selfAgentId ? '（这是你自己的回答）' : '';
      return `【回答${index + 1}】${answer.label}${mark}\n${answer.text.trim()}`;
    })
    .join('\n\n');

  return [
    '【原问题】',
    question.trim(),
    '',
    '【几个不同的模型对这个问题的回答】',
    body,
    '',
    '请按顺序做四件事，不要只复述它们：',
    '1. 逐条指出上面回答里的事实错误、逻辑漏洞和没有依据的断言，指明是哪一份回答的哪一句；',
    '2. 比较这几份回答：哪一份更正确、更完整，为什么；如果各有对错，说清各自对在哪里、错在哪里；',
    '3. 给出你最终的答案（可以直接采用某份回答的关键部分，但要由你自己重写，并把缺失的部分补齐）；',
    '4. 如果某一点现有信息不足以判断，明确写「无法确定」，不要硬给结论。'
  ].join('\n');
}

/**
 * API 主导者（本地 / 云端）的 system 轮次。
 *
 * 刻意与网页那份分开：API 能收 system，就不必把这些要求塞进「用户说的话」
 * 里，问题保持原样。
 */
export const LEAD_SYSTEM: string[] = [
  '你在评审几个模型对同一个问题的回答，目标是得到最正确的答案。',
  '只依据这些回答和公认常识判断，不要编造它们没提到的外部资料。',
  '先指出具体错误（指明是哪一份回答的哪一句），再比较优劣，最后给出你自己的最终答案。',
  '证据不足的地方写「无法确定」，不要为了给结论而猜。'
];
