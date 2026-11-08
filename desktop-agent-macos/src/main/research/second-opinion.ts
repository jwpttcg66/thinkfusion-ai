/**
 * 工程空间的第二意见（2026-11-08 用户裁决）。
 *
 * 原话：「工程模式模型为第一意见，网页是辅导重大决策用的第二意见。」
 *
 * 第一意见由模型读工程证据给出（见 engineering-round.ts）：它快，而且是唯一
 * 真正读得到本机文件的一方。但模型读证据有它自己的盲点——证据有什么它说什么，
 * 看不出「这个改法三个月后会痛」「这个依赖明年会停止维护」。网页那边看不到本机
 * 文件，却带着另一套训练出来的判断与更宽的经验面，适合在**决策**上复核一次。
 *
 * 所以第二意见有两个硬边界：
 *
 * - 只在决策类问题上问。事实查询（多少条记录、这个函数干什么、报错在哪一行）
 *   问网页没有意义：它们看不到文件，只能把我们递过去的摘录复述一遍。判定用
 *   规则（classifyDecision），不交给模型——那要多一次生成，而且判错时被静默
 *   放过的那条恰恰是本该复核的决策。
 * - 只问**一个**通道。每个网页都要重新加载、键入一整段、等它写完，两分钟起步；
 *   多问一家只是把这个等待翻倍，不会让决策更清楚。第二意见要的是「另一个判断」，
 *   不是「又一次多方投票」。
 *
 * 递过去的材料里带上第一意见：没有第一意见做靶子，网页给的只是另一份并列看法，
 * 而不是「第二意见」。
 */

import type { SecondOpinionMode } from '../../shared/conversation';

/** 命中即算：这些词出现在问句里，说明用户在要一个决定，而不是一条事实。 */
const DECISION_VERBS = [
  '要不要',
  '该不该',
  '是否应该',
  '是否该',
  '值不值得',
  '值不值',
  '能不能删',
  '可不可以删',
  '建议',
  '推荐',
  '选哪个',
  '选哪种',
  '选哪一',
  '迁移',
  '重构',
  '升级',
  '替换',
  '回滚',
  '上线',
  '发布',
  '部署',
  '删掉',
  '删除',
  '移除',
  '废弃',
  '风险'
];

/** 单独出现只说明话题沾边，需要两处、或一处加疑问语气才算决策。 */
const DECISION_TOPICS = [
  '比较',
  '对比',
  '取舍',
  '权衡',
  '选型',
  '替代方案',
  '优缺点',
  '性能',
  '安全',
  '成本',
  '依赖',
  '接口',
  '数据库',
  '表结构',
  '兼容',
  '并发',
  '内存',
  '缓存',
  '协议',
  '规范',
  '方案'
];

/** 问句语气：只用来给「单个弱信号」加权，不单独构成决策。 */
const QUESTION_TONE = /[？?]|吗|如何|怎么|是否/;

/** 用户在问题里直接点名要网页的意见，跳过一切判定。 */
const EXPLICIT_ASK = /问(?:问|一下)?网页|网页(?:的)?(?:第二)?意见|第二意见|外部意见|参考网页/;

export interface DecisionSignal {
  major: boolean;
  /** 命中的词，写进系统消息，用户可以核对这一轮为什么发了网页。 */
  signals: string[];
  /** 一句话结论，系统消息直接用。 */
  reason: string;
}

/**
 * 这个问题是不是「要拍板」的决策。
 *
 * 语料来自真机上出现过的问题：读取/统计类的问题不该触发网页（它们只能复述
 * 摘录），选型、迁移、要不要删这类问题该触发。规则宁可漏一点也不要多问：
 * 多问一次是每个网页通道两分钟的等待，漏一次只是少了复核。
 */
export function classifyDecision(question: string): DecisionSignal {
  const text = question.toLowerCase();

  if (EXPLICIT_ASK.test(question)) {
    return { major: true, signals: ['你点名要网页的意见'], reason: '你在问题里点名要网页的独立意见' };
  }

  const strong = DECISION_VERBS.filter(word => text.includes(word.toLowerCase()));
  if (strong.length > 0) {
    return {
      major: true,
      signals: strong,
      reason: `问题在问「${strong.join('、')}」，是要拍板的决定`
    };
  }

  const topics = DECISION_TOPICS.filter(word => text.includes(word.toLowerCase()));
  if (topics.length >= 2) {
    return {
      major: true,
      signals: topics,
      reason: `问题同时涉及「${topics.join('、')}」，是取舍类决策`
    };
  }
  if (topics.length === 1 && QUESTION_TONE.test(question)) {
    return { major: true, signals: topics, reason: `问题在权衡「${topics[0]}」` };
  }

  return {
    major: false,
    signals: [],
    reason: '这不是决策类问题（读数、查事实、定位错误），第一意见够用'
  };
}

export interface WebChannelView {
  agentId: string;
  label: string;
  available: boolean;
  detail?: string;
}

export interface SecondOpinionPlan {
  ask: boolean;
  /** 为什么问 / 为什么不问。写进系统消息。 */
  reason: string;
  target: WebChannelView | null;
  decision: DecisionSignal;
}

/**
 * 要不要问第二意见、问谁。
 *
 * 「不问」的每一种理由都和「问」一样要说清楚：用户看到的要不是一条沉默，
 * 而是「这一轮为什么没有网页的事」。
 */
export function planSecondOpinion(input: {
  mode: SecondOpinionMode;
  question: string;
  /** 这一轮有没有拿到模型的第一意见。没有靶子就不发网页。 */
  hasFirstOpinion: boolean;
  channels: readonly WebChannelView[];
  /** 用户在研究设置里勾选的网页通道；空 / 未设置表示全部。 */
  selected?: readonly string[];
}): SecondOpinionPlan {
  const decision = classifyDecision(input.question);
  const skip = (reason: string): SecondOpinionPlan => ({ ask: false, reason, target: null, decision });

  if (input.mode === 'off') {
    return skip('研究设置里关掉了网页第二意见：这一轮只有模型的第一意见');
  }
  if (!input.hasFirstOpinion) {
    return skip('这一轮没有第一意见可以复核，不发网页');
  }
  if (input.mode === 'auto' && !decision.major) {
    return skip(`不需要网页复核：${decision.reason}`);
  }

  const selected = input.selected && input.selected.length > 0 ? new Set(input.selected) : null;
  const permitted = input.channels.filter(
    channel => channel.available && (selected === null || selected.has(channel.agentId))
  );
  if (permitted.length === 0) {
    return skip('没有可用的网页通道（未登录或页面未就绪），第二意见跳过');
  }

  const target = permitted[0];
  const why = input.mode === 'always' ? '研究设置要求每个工程问题都问一次网页' : decision.reason;
  return {
    ask: true,
    reason: `网页第二意见：${target.label}（${why}）`,
    target,
    decision
  };
}

/** 发给网页的证据摘录上限。整段工程材料可达数万字，页面读完反而答得更散。 */
export const SECOND_OPINION_MATERIAL_LIMIT = 6000;

export function secondOpinionExcerpt(material: string, limit = SECOND_OPINION_MATERIAL_LIMIT): string {
  const text = material.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n（以上是摘录：证据共 ${text.length} 字，只发了前 ${limit} 字）`;
}

/**
 * 递给网页的那一条消息。
 *
 * 页面上它表现为用户说的另一段话，所以不写角色行、不写协议标记：就是「问题 +
 * 第一意见 + 证据摘录 + 一句要它做什么」。最后那句不是客套，没有它网页会把
 * 第一意见复述一遍。
 */
export function buildSecondOpinionQuestion(input: {
  question: string;
  firstOpinion: string;
  material: string;
  limit?: number;
}): string {
  return [
    `【用户的问题】\n${input.question.trim()}`,
    `【本机模型的意见（第一意见）】\n${input.firstOpinion.trim()}`,
    `【本机读到的工程证据摘录】\n${secondOpinionExcerpt(input.material, input.limit)}`,
    '请给第二意见：第一意见哪里判断错了、漏了什么风险或代价、还需要补哪些证据。证据不够的地方直接说不够，不要猜；同意就只说同意，不要复述。'
  ].join('\n\n');
}

/**
 * 等第二意见的额外预算。
 *
 * 网页要走「加载页面 → 键入整段 → 等它写完」，和网页主导的汇总同一量级。
 * 原来工程空间的预算只有五分钟，加了第二意见之后会被外层预算砍掉——那比不问更糟：
 * 用户等了五分钟，拿到的是「超时」而不是第二意见。
 */
export const SECOND_OPINION_BUDGET_MS = 180_000;
