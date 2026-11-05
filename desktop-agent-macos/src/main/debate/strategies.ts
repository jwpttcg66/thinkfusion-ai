/**
 * 协作策略（任务书 4.2）。
 *
 * 这里的「策略」不是标签：每种策略都改三件真的事情——
 *
 * 1. **每轮问什么**：第一轮要它先给结论、还是先列前提、还是先给候选方案；
 *    质疑轮盯证据链还是盯反例；回应轮允许它改口还是要求它给边界。
 * 2. **谁是什么角色**：主辩 / 质疑者 / 领域专家 / 证据核对者。
 * 3. **先处理哪类争议**：同一条辩论里可能同时有事实冲突、范围差异和定义
 *    差异，不同策略该先问哪一个不一样。
 *
 * 不做的事也要写明白：策略**不改变裁判口径**。同一份证据，换一个策略跑出来
 * 的结论应当一致——否则「换个策略就得到想要的答案」，那不是在找事实。
 * 所以 `judges.ts` 里没有 strategy 参数。
 *
 * `standard` / `deep` 是 0.1.0 的旧名字，保留是为了老辩论文件读得回来；
 * 它们的行为等同「真理发现」的两轮版与三轮版。
 */
import type { DebateMessageKind, DebateRole, DebateStrategy, DisputeType } from './types';

export interface StrategyProfile {
  id: DebateStrategy;
  label: string;
  /** 一句话说清它在做什么，界面上直接显示。 */
  summary: string;
  /** 默认轮数。用户可以在界面改，这里只是初值。 */
  rounds: number;
  /** 三轮各要模型额外做的事。只发给能读 system 的成员。 */
  focus: { analysis: string[]; challenge: string[]; response: string[] };
  /** 主辩与其余成员的默认角色。 */
  roles: { lead: DebateRole; other: DebateRole };
  /** 先处理哪类争议。没列到的排在后面，仍按 priority 排。 */
  disputeOrder: DisputeType[];
  /** 这种策略做不到什么，如实写出来。 */
  limit: string;
  /** 旧名字，界面上不再单独列。 */
  legacy?: boolean;
}

const TRUTH_FOCUS: StrategyProfile['focus'] = {
  analysis: [
    '先给结论，再标出支撑它的最强证据；没有证据支撑的部分，明确说这是推断。',
    '如果关键事实你也不确定，直接说「需要核实」，不要给一个听起来完整的答案。'
  ],
  challenge: [
    '优先检查证据链：哪一句的出处撑不住它，或者出处和这句话对不上。',
    '指出具体是哪一句，不要泛泛说「不够严谨」。'
  ],
  response: [
    '证据不足以支持原判断时，改口；不要为了前后一致而坚持。',
    '仍然成立的部分，说明它靠哪一条证据。'
  ]
};

export const STRATEGY_PROFILES: Record<DebateStrategy, StrategyProfile> = {
  truth: {
    id: 'truth',
    label: '真理发现',
    summary: '找最有证据支持的解释；先给结论，再检验证据链',
    rounds: 3,
    focus: TRUTH_FOCUS,
    roles: { lead: 'proposer', other: 'peer' },
    disputeOrder: ['evidence_conflict', 'factual', 'scope', 'logical', 'definitional'],
    limit: '只认规则判得出来的争议；裁判是规则版，读不懂文档内容本身'
  },
  adversarial: {
    id: 'adversarial',
    label: '对抗辩论',
    summary: '优先找反例、漏洞和隐藏假设；主张与质疑分工',
    rounds: 3,
    focus: {
      analysis: [
        '给结论时同时给出它最可能错在哪：一个能让它不成立的具体情形。',
        '不要只列优点；你的任务是先把结论放到最不利的位置上看它还站不站得住。'
      ],
      challenge: [
        '优先找反例和隐藏前提：给出一个具体的、可发生的情形，让这句话不成立。',
        '如果找不到反例，说明你试过哪些，不要用「可能有例外」搪塞。'
      ],
      response: [
        '正面回应反例：要么承认它成立并修正结论，要么说明它为什么不适用于本题。',
        '修正后的结论要写清新的适用范围。'
      ]
    },
    roles: { lead: 'proposer', other: 'critic' },
    disputeOrder: ['factual', 'logical', 'evidence_conflict', 'scope', 'definitional'],
    limit: '反例来自模型自己，不来自真实实验；「能找到反例」不等于「反例成立」'
  },
  expert: {
    id: 'expert',
    label: '专家评审',
    summary: '按领域标准判断证据等级，要求专业出处',
    rounds: 3,
    focus: {
      analysis: [
        '先说明这个问题属于哪个领域、这个领域里什么算证据（规范 / 源码 / 实测 / 论文 / 报告）。',
        '按这个标准给判断，并标出你的结论需要哪一级证据才成立。'
      ],
      challenge: [
        '按领域标准核对对方的证据等级：行业报告不能当官方规范用，博客不能当源码用。',
        '指出对方把哪一级证据当成了更高一级。'
      ],
      response: [
        '说明你的结论在别的领域或别的版本是否适用，边界在哪。',
        '证据等级不够的部分，降级表述，不要保留绝对化措辞。'
      ]
    },
    roles: { lead: 'domain_expert', other: 'domain_expert' },
    disputeOrder: ['evidence_conflict', 'definitional', 'scope', 'factual', 'logical'],
    limit: '「领域」由模型自称，系统不校验它真的具备该领域资质'
  },
  assumption: {
    id: 'assumption',
    label: '假设审查',
    summary: '把结论依赖的前提逐条列出来，再逐项验证',
    rounds: 3,
    focus: {
      analysis: [
        '把结论依赖的前提逐条列出来，最多四条，每条注明：事实 / 行业惯例 / 假设。',
        '只列真的缺了结论就不成立的前提，不要把背景知识也算成前提。'
      ],
      challenge: [
        '逐条核对对方列出的前提：哪一条没有证据、哪一条在本题条件下不成立。',
        '被推翻的前提要指名，不要笼统说「前提有问题」。'
      ],
      response: [
        '前提被推翻的，结论跟着改；前提成立的，说明它凭什么成立。',
        '把仍然没有被验证的前提留在结论里，作为不确定性写出来。'
      ]
    },
    roles: { lead: 'proposer', other: 'evidence_reviewer' },
    disputeOrder: ['scope', 'definitional', 'factual', 'logical', 'evidence_conflict'],
    limit: '只能看出「前提没被证据支持」，看不出「前提其实是对的」'
  },
  solution: {
    id: 'solution',
    label: '方案竞争',
    summary: '给出多个候选方案，按约束、风险和证据比较后收敛',
    rounds: 3,
    focus: {
      analysis: [
        '给出两到三个候选方案，按约束、风险和证据逐项对比，不要只给一个。',
        '每个方案写清它在什么条件下更优，以及它最怕什么。'
      ],
      challenge: [
        '检查对方漏掉的约束、失败模式和候选方案；指出被忽略的那一个。',
        '对比要在同一组约束下进行，不要拿 A 的优点比 B 的缺点。'
      ],
      response: [
        '按对比结果收敛到推荐方案，并写明它在什么条件下不适用。',
        '如果两个方案各有胜负，说清按什么优先级取舍。'
      ]
    },
    roles: { lead: 'proposer', other: 'critic' },
    disputeOrder: ['factual', 'scope', 'evidence_conflict', 'logical', 'definitional'],
    limit: '方案优劣取决于你给的约束；约束本身错了，比较就白做'
  },
  discovery: {
    id: 'discovery',
    label: '探索发现',
    summary: '并行提出互相竞争的假设，用能区分它们的证据逐步排除',
    rounds: 3,
    focus: {
      analysis: [
        '提出两到三个互相竞争的假设，并给出能区分它们的观察或证据。',
        '宁可给出「如果是 A 会看到什么、如果是 B 会看到什么」，也不要急着下结论。'
      ],
      challenge: [
        '指出哪个假设还没有被检验，以及用哪一条证据能最快排除它。',
        '不要重复已经排除的假设。'
      ],
      response: [
        '按已有证据排除假设，缩小范围；剩下的不确定要明说。',
        '如果证据仍然区分不了两个假设，就说区分不了，不要硬选一个。'
      ]
    },
    roles: { lead: 'peer', other: 'peer' },
    disputeOrder: ['factual', 'evidence_conflict', 'scope', 'logical', 'definitional'],
    limit: '探索的假设由模型提出，系统不会去执行实验来验证'
  },
  // 下面两个是 0.1.0 的旧名字，只在读老文件时出现。
  standard: {
    id: 'standard',
    label: '标准（旧名）',
    summary: '旧版标准策略，等同「真理发现」的两轮版',
    rounds: 2,
    focus: TRUTH_FOCUS,
    roles: { lead: 'proposer', other: 'peer' },
    disputeOrder: ['evidence_conflict', 'factual', 'scope', 'logical', 'definitional'],
    limit: '旧版本没有策略区分，行为固定',
    legacy: true
  },
  deep: {
    id: 'deep',
    label: '深度（旧名）',
    summary: '旧版深度策略，等同「真理发现」的三轮版',
    rounds: 3,
    focus: TRUTH_FOCUS,
    roles: { lead: 'proposer', other: 'peer' },
    disputeOrder: ['evidence_conflict', 'factual', 'scope', 'logical', 'definitional'],
    limit: '旧版本没有策略区分，行为固定',
    legacy: true
  }
};

/** 界面上列出来的策略：六个，旧名字不出现在选择器里。 */
export const SELECTABLE_STRATEGIES: DebateStrategy[] = [
  'truth',
  'adversarial',
  'expert',
  'assumption',
  'solution',
  'discovery'
];

export const STRATEGY_IDS: DebateStrategy[] = [
  ...SELECTABLE_STRATEGIES,
  'standard',
  'deep'
];

export function isStrategy(value: unknown): value is DebateStrategy {
  return typeof value === 'string' && (STRATEGY_IDS as string[]).includes(value);
}

/** 老文件里的未知值一律按真理发现读，不抛错、也不静默换成另一个已知策略。 */
export function strategyProfile(strategy: DebateStrategy | string | undefined): StrategyProfile {
  return isStrategy(strategy) ? STRATEGY_PROFILES[strategy] : STRATEGY_PROFILES.truth;
}

/** 这一轮策略额外要求做的事。`kind` 是发言性质，不是界面上的一句话。 */
export function strategyFocus(strategy: DebateStrategy, kind: DebateMessageKind): string[] {
  const profile = strategyProfile(strategy);
  const phase =
    kind === 'position'
      ? 'analysis'
      : kind === 'question' || kind === 'rebuttal'
        ? 'challenge'
        : 'response';
  return profile.focus[phase];
}

/**
 * 按策略偏好重排争议：先问这种策略最在意的那一类，同类之间仍按 priority。
 *
 * 稳定排序：`priority` 相同、类型也相同时保持原顺序，挑战的先后不会因为
 * 一次重排而抖动。
 */
export function orderDisputes<T extends { type: DisputeType; priority: number }>(
  disputes: readonly T[],
  strategy: DebateStrategy
): T[] {
  const order = strategyProfile(strategy).disputeOrder;
  const rank = (type: DisputeType): number => {
    const index = order.indexOf(type);
    return index === -1 ? order.length : index;
  };
  return [...disputes]
    .map((dispute, index) => ({ dispute, index }))
    .sort((a, b) =>
      rank(a.dispute.type) - rank(b.dispute.type) ||
      b.dispute.priority - a.dispute.priority ||
      a.index - b.index
    )
    .map(item => item.dispute);
}

/** 界面上要显示的一句话说明。plan 里也存一份，老文件读不到时用这个兜底。 */
export function strategyLabel(strategy: DebateStrategy | string | undefined): string {
  return strategyProfile(strategy).label;
}
