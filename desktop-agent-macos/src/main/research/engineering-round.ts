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

/** 只对本地/云端模型生效的 system；网页通道会忽略它，工程空间也不发网页。 */
export function engineeringAnswerSystem(): string[] {
  return [
    '你在做工程分析：用户的问题针对本机一个目录里的真实文件。下面附上的【工程证据】是程序在本机读取到的原文，带路径、行号与内容指纹。',
    '只依据这些证据回答。每条结论后面写明依据（路径:行号）；证据不足以支撑的地方写「无法确定」，不要凭常识补。',
    '证据里有全文行数、字节数这类统计时，直接引用它们回答「多少条 / 多少行 / 多大」这类问题。'
  ];
}
