import type { AgentPlan } from '../../shared/contracts';
import { planHasObservableEvidence, stepEvidenceKinds } from '../../shared/verification-evidence';

/** 会改动工作区的工具；与 PlanPreview 的 isWrite 保持同一口径。 */
const WRITE_TOOLS = new Set([
  'fs.writeFile', 'fs.mkdir', 'fs.edit', 'fs.remove', 'fs.move', 'fs.copy'
]);

/** 数据类能力：查询本身带结果集大小风险。 */
const DATA_TOOLS = new Set(['csv.summary', 'sqlite.query', 'code.run']);
const AGGREGATE_SQL = /^\s*(select\s+count|select\s+sum|select\s+avg|select\s+min|select\s+max|pragma|explain)/i;

export interface PlanCapabilityGate {
  /** 这次计划的主族，用于界面显示与后续度量。 */
  family: 'code.change' | 'test' | 'data' | 'frontend' | 'debug' | 'code.read';
  /** 缺哪些判据；空数组表示通过。 */
  missing: string[];
}

/**
 * 计划门禁：执行前检查主族要求的判据是否在计划里。
 *
 * 它不是权限，也不阻止执行——只在缺判据时告诉用户「执行后不会标已验证」。
 * 缺判据仍照跑，是用户的选择；把没跑测试的改动说成「已验证」才是错。
 */
export function checkPlanCapabilities(plan: AgentPlan): PlanCapabilityGate {
  const steps = plan.steps ?? [];
  const writes = steps.filter(step => WRITE_TOOLS.has(step.tool));
  // 「验没验」不按工具名判：`shell.run` 里写 javac/mvn/pytest 或对输出做断言，
  // 与 `test.run` 是同一类事实。用哪条命令由模型按任务决定，这里只问有没有。
  const tests = steps.filter(step => stepEvidenceKinds({ tool: step.tool, args: step.args }).includes('tests'));
  const screens = steps.filter(step => step.tool === 'screen.capture');
  const dataSteps = steps.filter(step => DATA_TOOLS.has(step.tool));
  const missing: string[] = [];

  if (writes.length > 0 && !planHasObservableEvidence(steps)) {
    missing.push('计划改了文件，但没有任何能看见改动效果的动作（构建、测试、运行断言或诊断）：执行后不会标已验证');
  }

  const touchesUi = writes.some(step => {
    const args = step.args as { path?: unknown };
    return typeof args.path === 'string' && args.path.replace(/\\/g, '/').includes('src/renderer/');
  });
  if (touchesUi && screens.length === 0 && !planHasObservableEvidence(steps)) {
    missing.push('计划改了界面，但没有截屏或任何构建 / 运行检查：布局与交互没有被验证');
  }

  // 只拦「会把整表读进上下文」的查询；聚合、PRAGMA、EXPLAIN 没有这个问题。
  const unbounded = steps.filter(step => {
    if (step.tool !== 'sqlite.query') return false;
    const sql = (step.args as { sql?: unknown }).sql;
    return typeof sql === 'string' && !/\blimit\b/i.test(sql) && !AGGREGATE_SQL.test(sql);
  });
  if (unbounded.length > 0) {
    missing.push(`${unbounded.length} 条 SQL 没有 LIMIT：大表会把结果整段读进上下文`);
  }

  // 复现 + 定位（命令或测试 + 搜索）是调试，不是「读代码」；族影响界面显示与度量。
  const debugs = steps.some(step => step.tool === 'shell.run' || step.tool === 'test.run') &&
    steps.some(step => step.tool === 'fs.search' || step.tool === 'fs.readFile');

  const family: PlanCapabilityGate['family'] =
    writes.length > 0 ? 'code.change'
      : tests.length > 0 ? 'test'
        : screens.length > 0 ? 'frontend'
          : dataSteps.length > 0 ? 'data'
            : debugs ? 'debug'
              : 'code.read';

  return { family, missing };
}

/**
 * 方案评审辩论的判据（V2.1 D-03 / 任务书 Phase F）。
 *
 * 这一层只有纯函数，因为它要回答的是产品问题而不是执行问题：
 * 「这份计划值不值得先辩一场」「辩什么」「辩出来的东西怎么给审批的人看」。
 *
 * 一条底线：辩论不改变执行语义。辩完仍然要人点确认，权限也不会因为辩出
 * 「应该改 3 个文件」而扩大到能改 3 个文件。
 */

/** 单条议题：问什么 + 辩清后要达成什么决策。 */
export interface PlanDebateTopicItem {
  text: string;
  goal: string;
}

/**
 * 方案评审 brief：议题只能来自主导模型，系统不得按步数/工具名套模板编造。
 *
 * - design：议题 = 模型写的 viewpoints
 * - implementation：议题 = 模型写的 concerns；没有 concerns 就空议题（不开辩）
 *
 * 表态对象/目标只陈述「就模型提出的议题作裁定」，不另写导演话术。
 */
export interface PlanDebateBrief {
  topics: PlanDebateTopicItem[];
  /** 需要对什么表达立场。 */
  expressTarget: string;
  /** 表态要产出什么判断；无议题时为空。 */
  expressGoal: string;
  /** model = 来自计划字段；none = 主导模型未提出议题。 */
  source: 'model' | 'none';
}

/** 只抽取主导模型写进计划的议题；绝不按计划结构发明辩题。 */
export function planDebateBrief(plan: AgentPlan): PlanDebateBrief {
  if (plan.kind === 'design' && plan.design) {
    const viewpoints = plan.design.viewpoints ?? [];
    if (viewpoints.length === 0) {
      return {
        expressTarget: `设计文档「${plan.title}」`,
        expressGoal: '',
        topics: [],
        source: 'none'
      };
    }
    return {
      expressTarget: `设计文档「${plan.title}」· 主导模型提出的观点`,
      expressGoal: '就主导模型提出的设计观点给出可审批判断。',
      topics: viewpoints.slice(0, 5).map((viewpoint, index) => ({
        text: viewpoint,
        goal: `裁定观点 ${String(index + 1)} 是否成立，并写明依据。`
      })),
      source: 'model'
    };
  }
  const concerns = plan.concerns ?? [];
  if (concerns.length === 0) {
    return {
      expressTarget: `工程计划「${plan.title}」`,
      expressGoal: '',
      topics: [],
      source: 'none'
    };
  }
  return {
    expressTarget: `工程计划「${plan.title}」· 主导模型提出的议题`,
    expressGoal: '就主导模型提出的议题与原因给出可审批判断；结论指向具体步骤编号。',
    topics: concerns.slice(0, 5).map(item => ({
      text: item.topic,
      goal: (item.goal ?? item.reason ?? '').trim() || '就该议题给出可审批裁定'
    })),
    source: 'model'
  };
}

/** 兼容旧调用：只要议题原文。 */
export function planDebateTopics(plan: AgentPlan): string[] {
  return planDebateBrief(plan).topics.map(item => item.text);
}

/**
 * 要不要辩。
 *
 * 只看主导模型有没有提出议题（design.viewpoints / concerns）。
 * 不再按步数、写入、shell 等结构特征自动开辩——那会编造「莫名其妙的辩论」。
 * `off` 仍可关掉；`on`/`auto` 在没有模型议题时同样不辩。
 */
export function shouldDebatePlan(
  mode: 'auto' | 'on' | 'off' | undefined,
  plan: AgentPlan
): { debate: boolean; reason?: string } {
  const effective = mode ?? 'auto';
  const brief = planDebateBrief(plan);
  if (plan.kind === 'design' && brief.source === 'model' && brief.topics.length > 0) {
    return { debate: true, reason: `主导模型提出了 ${String(brief.topics.length)} 个设计观点，按观点评审` };
  }
  if (effective === 'off') {
    return { debate: false, reason: '这一轮按设置关闭了辩论' };
  }
  if (brief.source === 'none' || brief.topics.length === 0) {
    return { debate: false, reason: '主导模型未提出议题，不编造辩论' };
  }
  return {
    debate: true,
    reason: `主导模型提出了 ${String(brief.topics.length)} 个议题${effective === 'on' ? '（设置开启评审）' : ''}`
  };
}

/**
 * 交给辩论引擎的材料：只附计划数据与主导模型提出的议题，不追加评审话术。
 */
export function planReviewQuestion(plan: AgentPlan): string {
  if (plan.kind === 'design' && plan.design) {
    return [
      `【设计文档】${plan.title}`,
      plan.design.document,
      '',
      '【主导模型提出的观点】',
      ...plan.design.viewpoints.map((item, index) => `${String(index + 1)}. ${item}`)
    ].join('\n');
  }
  const brief = planDebateBrief(plan);
  const steps = (plan.steps ?? [])
    .map((step, index) => `${index + 1}. [${step.tool}] ${step.description ?? ''} ${JSON.stringify(step.args)}`)
    .join('\n');
  const lines = [
    `【工程计划】${plan.title}`,
    plan.description,
    '',
    '【步骤】',
    steps,
    '',
    `【完成条件】${plan.completion?.condition ?? '未写明'}`
  ];
  if (brief.topics.length > 0) {
    lines.push('', '【主导模型提出的议题】');
    for (const [index, topic] of brief.topics.entries()) {
      lines.push(
        `${String(index + 1)}. ${topic.text}${topic.goal ? `（目标：${topic.goal}）` : ''}`
      );
    }
  }
  return lines.join('\n');
}

/**
 * 方案评审的上限轮数。
 *
 * 不再按计划规模写死「2 轮」或「3 轮」：轮次由辩论引擎按分歧收敛自主决定。
 * 这里只给一个上限，并说明继续下一轮的条件：
 * - 第 1 轮表态；有未解决争议才进入第 2 轮质疑；
 * - 质疑需要被答复才进入第 3 轮回应；
 * - 任何一轮收敛、或没有新的修订/争议，就提前结束。
 *
 * 上限设为 3 是成本边界，不是固定轮次；实际跑几轮看 plan.debated.rounds。
 */
export interface PlanReviewRounds {
  /** 最多跑几轮；实际轮次由收敛结果决定。 */
  rounds: 3;
  /** 给审批的人看的一句话规则，界面会显示，不只是日志。 */
  reason: string;
}

export function planReviewRounds(plan: AgentPlan, participantCount: number): PlanReviewRounds {
  const steps = plan.steps?.length ?? 0;
  const scope = [
    `${String(steps)} 步`,
    plan.kind === 'design' ? '设计文档' : null,
    `${String(participantCount)} 位评审`
  ].filter(Boolean).join('、');
  return {
    rounds: 3,
    reason: `最多 3 轮，实际按分歧收敛（${scope}）：第 1 轮表态；有未解决争议才进入第 2 轮质疑；质疑需要答复才进入第 3 轮回应`
  };
}

/**
 * 与轮次配套的预算。
 *
 * 只改轮数不改预算，第三轮会直接被总时长砍掉，等于没改：`totalMs` 到点
 * 引擎就 break 并出结论。每轮按 100 秒估（最慢成员要写思考再出正文），
 * 再留 30 秒落盘与汇总；等待时间比预算多 20 秒，避免「引擎刚收尾就被判超时」。
 */
export function planReviewBudget(rounds: number): {
  stageTimeoutMs: number;
  totalMs: number;
  waitMs: number;
} {
  const stageTimeoutMs = 120_000;
  const totalMs = rounds >= 3 ? 300_000 : 180_000;
  return { stageTimeoutMs, totalMs, waitMs: totalMs + 20_000 };
}

/**
 * 把一场辩论收成审批前能读的一段话。
 *
 * 优先取「回应」轮：那才是被质疑之后还坚持的立场。只取最后一轮会有个坑——
 * 2 轮评审的最后一轮是质疑，把质疑当结论等于说「反对意见已经答复过」，
 * 而对方其实一个字都没回。没有回应轮时如实标注，不伪装成收敛后的意见。
 *
 * 失败成员必须点名，否则「三个模型都同意」可能只有一个人真的说过话。
 */
export function summarizePlanDebate(input: {
  rounds: Array<{
    index: number;
    /** 老记录没有这个字段，按 index 兜底推断。 */
    phase?: 'analysis' | 'challenge' | 'response';
    messages: Array<{ author: string; kind: string; text: string }>;
    failures?: Array<{ agentId: string; detail: string }>;
  }>;
  topics: string[];
}): string {
  const { rounds, topics } = input;
  if (rounds.length === 0) return '辩论没有产生任何发言，不能据此判断计划是否可行。';
  const phaseOf = (round: { index: number; phase?: 'analysis' | 'challenge' | 'response' }) =>
    round.phase ?? (round.index === 0 ? 'analysis' : round.index === 1 ? 'challenge' : 'response');
  const spoken = rounds.filter(round => round.messages.some(message => message.text.trim()));
  const responseRound = [...spoken].reverse().find(round => phaseOf(round) === 'response');
  const last = spoken.at(-1) ?? rounds[rounds.length - 1];
  const source = responseRound ?? last;
  const failures = rounds.flatMap(round => round.failures ?? []);
  const lines: string[] = [];
  if (topics.length > 0) lines.push(`辩题：${topics.join('；')}`);
  if (!responseRound && spoken.length > 0 && phaseOf(last) === 'challenge') {
    lines.push('（这场只跑到互相质疑，没有回应轮：下面是质疑意见，被评审方尚未答复。）');
  }
  const stances = source.messages
    .filter(message => message.text.trim())
    .map(message => `【${message.author}】${message.text.trim().slice(0, 400)}`);
  if (stances.length === 0) lines.push('最后一轮没有留下发言。');
  else lines.push(...stances);
  if (failures.length > 0) {
    const names = [...new Set(failures.map(item => `${item.agentId}（${item.detail}）`))];
    lines.push(`未参与或中途失败的成员：${names.join('、')}；上面的结论不代表他们。`);
  }
  return lines.join('\n');
}


/** 方案评审只允许任务选定的模型；没传选择时才保留调用方候选。 */
export function filterDebateCandidates<T extends { id: string }>(
  candidates: readonly T[],
  allowedIds?: readonly string[]
): T[] {
  const allowed = new Set(allowedIds ?? []);
  if (allowed.size === 0) return [...candidates];
  return candidates.filter(candidate => allowed.has(candidate.id));
}
