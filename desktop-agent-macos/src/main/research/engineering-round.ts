/**
 * 工程空间的第一手回答：由模型直接读工程证据回答。
 *
 * 2026-11-08 用户裁决：「工程模式，不需要优先问网页，读取本地应该是模型所做的」。
 *
 * 「第一手回答永远来自网页通道」那条硬规则是给知识空间的：网页通道读不到本机
 * 文件，工程分析里问它们只会得到「请上传文件」——真机 s20/s21 连着两次都是这个
 * 结果。所以工程空间的例外是：**回答就是读证据这件事本身**，只能交给能拿到证据
 * 的成员，也就是本地/云端模型。
 *
 * 这个模块只做两个判断，不碰调度：
 *
 * - 谁回答：本地模型优先（内容不出本机），云端主导时才用云端；用户点名了某个
 *   成员就用它。都没有可用成员时返回 fallback，由调用方如实退回网页。
 *
 *   只问**一个**：读证据回答是确定性任务，同一份证据问两个模型只会把等待时间
 *   翻倍，接着还会触发汇总与辩论——一条「这个文件多少条记录」的问题不值得花
 *   三次生成。要第二个意见就点名另一个成员再问一次，或者追问。
 * - 问什么：用户原话 + 工程证据。证据是程序在提问那一刻真实读盘得到的，带路径、
 *   行号与指纹；它不是「提示词包装」，用户的问题一字不改地放在最前面。
 */

export interface ModelMemberView {
  agentId: string;
  label: string;
  kind: 'local' | 'cloud';
  available: boolean;
  detail?: string;
}

export interface EngineeringAnswerPlan {
  /** 这一轮真正要问的模型。空数组表示退回网页。 */
  targets: ModelMemberView[];
  /** 为什么是这几个人 / 为什么要退回网页。写进系统消息，用户能核对。 */
  reason: string;
  /** 本机没有可用模型：调用方退回网页通道。 */
  fallback: boolean;
}

export function planEngineeringAnswer(input: {
  mode: 'web' | 'local' | 'cloud' | 'hybrid';
  leadAgentId?: string;
  members: readonly ModelMemberView[];
}): EngineeringAnswerPlan {
  const available = input.members.filter(member => member.available);
  const pinned = input.leadAgentId
    ? available.find(member => member.agentId === input.leadAgentId)
    : undefined;
  if (pinned) {
    return {
      targets: [pinned],
      reason: `工程空间：你指定了 ${pinned.label} 读工程证据回答`,
      fallback: false
    };
  }

  const local = available.filter(member => member.kind === 'local');
  const cloud = available.filter(member => member.kind === 'cloud');

  // 云端主导且云端可用时才用云端——这是既有的归属裁决；其余情况一律本地优先，
  // 哪怕界面上选的是网页主导：网页读不到本机文件，那条路已经证明只会得到
  // 「请上传文件」。
  if (input.mode === 'cloud' && cloud.length > 0) {
    return {
      targets: cloud.slice(0, 1),
      reason: '工程空间：云端主导，由云端模型读工程证据回答',
      fallback: false
    };
  }
  if (local.length > 0) {
    return {
      targets: local.slice(0, 1),
      reason: '工程空间：本地模型读工程证据回答，本轮不发网页',
      fallback: false
    };
  }
  if (cloud.length > 0) {
    return {
      targets: cloud.slice(0, 1),
      reason: '工程空间：没有可用本地模型，改用云端模型读工程证据回答',
      fallback: false
    };
  }
  return {
    targets: [],
    reason: '本机没有可用的本地/云端模型（Ollama 未启动，或没有配 API Key）',
    fallback: true
  };
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
