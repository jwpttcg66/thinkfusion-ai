/**
 * 工程空间发给模型的「第一手问题」与证据纪律。
 *
 * 2026-11-08 裁决链：先是「工程模式不需要优先问网页，读本地由模型做」，后来
 * 又改成「工程默认多 agent 编排，优先本地和远程模型，除非混合模式才可以网页
 * 编排」。选人因此搬到了 research/engineering-orchestration.ts，这里只保留
 * 两件与成员无关的事：**问什么**、**system 里那三条纪律**。
 *
 * 「第一手回答永远来自网页通道」那条硬规则是给知识空间的：网页通道读不到本机
 * 文件，工程分析里问它们只会得到「请上传文件」——真机 s20/s21 连着两次都是
 * 这个结果。工程空间的例外是：回答就是读证据这件事本身，只能交给能拿到证据
 * 的成员（本地/云端模型；混合档再加网页，且给它证据摘录）。
 *
 * 问题 = 用户原话 + 工程证据。证据是程序在提问那一刻真实读盘得到的，带路径、
 * 行号与指纹；它不是「提示词包装」，用户的问题一字不改地放在最前面。
 */

export interface ModelMemberView {
  agentId: string;
  label: string;
  kind: 'local' | 'cloud';
  available: boolean;
  detail?: string;
}

/**
 * 发给模型的第一手问题：用户原话在前，工程证据在后。
 *
 * 故意没有「你是一位……」这种开场：问题就是用户问的那句，证据就是程序读到的
 * 那些片段。模型要做的判断只有「这些证据能不能回答问题」。
 */
export function buildEngineeringAnswerQuestion(question: string, material: string): string {
  return [`【用户的问题】\n${question.trim()}`, material.trim()].filter(Boolean).join('\n\n');
}

/**
 * 只对本地/云端模型生效的 system；网页通道会忽略它，工程空间也不发网页。
 *
 * `attachments` 是这一问随行附件的数量。真机 2026-11-09：附了一份 md 问「这个
 * 文件有多少行」，模型却只盯着【工程证据】里那段无关的 `index.html:8`，答
 * 「无法确定」——「只依据这些证据」被读成「附件不算证据」。附了文件就必须写明
 * 附件也是依据。
 */
export function engineeringAnswerSystem(options: { attachments?: number } = {}): string[] {
  const attached = Math.max(0, options.attachments ?? 0);
  return [
    '你在做工程分析：用户的问题针对本机一个目录里的真实文件。下面附上的【工程证据】是程序在本机读取到的原文，带路径、行号与内容指纹。',
    '只依据这些证据回答。每条结论后面写明依据（路径:行号）；证据不足以支撑的地方写「无法确定」，不要凭常识补。',
    '证据里有全文行数、字节数这类统计时，直接引用它们回答「多少条 / 多少行 / 多大」这类问题。',
    ...(attached > 0
      ? [`用户随这一问附了 ${String(attached)} 个文件，正文紧跟在【用户的问题】后面，同样是可引用的依据；文件里写明的数字与清单优先于任何推测。附件正文被截断时不要拿它数行数——要准确数字就用下面的读文件请求。`]
      : [])
  ];
}

/**
 * 教模型「可以自己读文件」的那几条。
 *
 * 2026-11-09 用户裁决：「读取文件，模型不是应该调用本地能力，没看到调用本地能力，
 * 输出也是糟糕的。」——原来第一手只是一次 `generate()`，模型只能吃程序切好的
 * 8 个片段，遇到「这个文件有多少行」只能认输。
 *
 * 走的是**文本协议**而不是各家模型的 function calling：本地 Ollama 上的模型对
 * 工具调用支持参差不齐，而「看不懂就照旧回答」必须是无损的——认不出 JSON 时
 * 这段提示不产生任何副作用。
 */
export function engineeringToolSystem(): string[] {
  return [
    '【你可以自己读文件】上面的证据不够时，不要猜，也不要直接说「无法确定」：你可以要求读一次本机文件。',
    '需要时只输出一行 JSON，不要解释、不要代码块：',
    '{"tool":"fs.stat|fs.readFile|fs.search|fs.list","args":{"path":"相对工程目录的路径，或附件的绝对路径"}}',
    'fs.stat 回字节数与总行数；fs.readFile 可选 offset/limit（行，默认第 1 行起 200 行）；',
    'fs.search 用 {"pattern":"正则","path":"可选起点"}；fs.list 列目录。',
    '只能读工程目录与这一问附上的文件，不能写、不能执行命令；最多 4 轮，每轮只请求一个工具。',
    '能直接回答时就不要请求工具。'
  ];
}

/**
 * 工具读完之后的第二问：同一份证据 + 刚才那次读取的结果。
 *
 * 用户原话与证据都不重发第二遍以外的内容；这里只追加「你请求了什么、读到了什么」，
 * 再明确要求给结论，避免模型第二次又只回一个 JSON 请求。
 */
export function buildToolFollowupQuestion(
  engineered: string,
  summary: string,
  result: string,
  history = ''
): string {
  return [
    engineered.trim(),
    history ? `【之前的工具结果】\n${history}` : '',
    `【本轮请求的本机能力】${summary}`,
    `【本轮读取结果】\n${result}`,
    '如果证据足够，现在直接回答用户的问题；结论写明依据（路径:行号，或上面给出的行数/字节数）。如果仍缺关键证据，可以再输出一次工具请求；不要编造读取结果。'
  ]
    .filter(Boolean)
    .join('\n\n');
}
