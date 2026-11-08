/**
 * 「这是不是要拍板的决策」的规则判定，以及网页编排成员的证据摘录工具。
 *
 * 历史：2026-11-08 早些时候这里还负责「工程空间只问一个网页、事后做第二意见」。
 * 同一天用户改了裁决：「工程默认改成多agent编排，优先本地和远程模型，除非采用
 * 混合模式，才可以进行网页编排」。第二意见那条链路已经删掉，网页现在是混合档
 * 里**并列的编排成员**，选人在 research/engineering-orchestration.ts。
 *
 * 这里保留两件仍然通用的东西：
 *
 * - `classifyDecision`：判断问题是不是决策类。工程编排在 auto 档用它决定网页
 *   要不要加入，专家/技能的加载判定（expertise/trigger.ts）也复用它。
 *   判定用规则，不交给模型——那要多一次生成，而且判错时被静默放过的那条
 *   恰恰是本该交叉验证的决策。
 * - `secondOpinionExcerpt`：整段工程证据可达几万字，页面读完反而答得更散，
 *   发给网页成员前按固定上限摘录。
 */

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

/** 发给网页的证据摘录上限。整段工程材料可达数万字，页面读完反而答得更散。 */
export const SECOND_OPINION_MATERIAL_LIMIT = 6000;

export function secondOpinionExcerpt(material: string, limit = SECOND_OPINION_MATERIAL_LIMIT): string {
  const text = material.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n（以上是摘录：证据共 ${text.length} 字，只发了前 ${limit} 字）`;
}

/**
 * 网页编排成员的额外预算。
 *
 * 网页要走「加载页面 → 键入整段 → 等它写完」，和网页主导的汇总同一量级。
 * 混合档开跑时还不知道这一轮到底会不会编网页，所以预算按「可能会问」提前给足：
 * 被预算砍掉的网页意见比不问更糟——用户等了几分钟，拿到的是「超时」。
 */
export const SECOND_OPINION_BUDGET_MS = 180_000;
