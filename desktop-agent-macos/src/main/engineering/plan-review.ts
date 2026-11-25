import type { AgentPlan } from '../../shared/contracts';
import type { EcoEvidenceSummary } from '../../shared/eco';
import { planHasObservableEvidence, stepEvidenceKinds } from '../../shared/verification-evidence';
import {
  buildLeadSummaryQuestion,
  leadSummarySystem,
  parseDoubts,
  parseTopics,
  LEAD_SUMMARY_TIMEOUT_MS,
  type LeadAnswer
} from '../synthesis/lead-stage';

export { LEAD_SUMMARY_TIMEOUT_MS };

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
/**
 * 多写入目标却没有 decomposition：不是错误，但任务树会缺 L2。
 *
 * 这条只做可见提示：模型可以合理判断「这两处改动属于同一件事」而不拆，
 * 但审批的人需要知道「这份计划没有可独立验收的子任务层」，
 * 而不是看到一个只有 L1→L3 的树却以为分解已经发生。
 */
export function planDecompositionWarning(plan: AgentPlan): string | null {
  if (plan.decomposition && plan.decomposition.length > 0) return null;
  const targets = new Set<string>();
  for (const step of plan.steps) {
    if (!WRITE_TOOLS.has(step.tool)) continue;
    const target = (step.args as { path?: unknown }).path;
    if (typeof target === 'string' && target.trim()) targets.add(target);
  }
  if (targets.size < 2) return null;
  return `计划涉及 ${String(targets.size)} 个独立写入目标，但没有 decomposition：任务树只有 L1→L3，没有可独立验收的 L2 子任务`;
}

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
 * 方案评审与知识问答同一套顺序：
 * 1) 主导模型先写【结论/一致/分歧/存疑/辩题】五段；
 * 2) 只从【辩题】（及【存疑】转核查）取议题；
 * 3) 有议题才辩论。系统不得按步数/工具名套模板编造辩论。
 */
export interface PlanDebateBrief {
  topics: PlanDebateTopicItem[];
  expressTarget: string;
  expressGoal: string;
  /** model = 五段里提出了辩题；none = 五段写无或还没汇总。 */
  source: 'model' | 'none';
  /** 主导模型五段原文；老记录没有。 */
  leadSummary?: string;
}

/** 计划正文作为「一份材料」交给主导模型做五段汇总（与知识问答同一口径）。 */
export function planAsLeadAnswer(plan: AgentPlan): LeadAnswer {
  return { channelId: 'plan', label: '计划', text: planReviewQuestion(plan) };
}

/**
 * 已核验工程证据作为「材料」附给评审。
 *
 * 只给路径、摘要前 12 位和字节数：这是可核对的来源清单，不是文件内容，
 * 也不是指令。给出证据比让模型自己猜「这份计划读过哪些文件」更有依据；
 * 但摘要不能反推内容，避免把「核对过存在」说成「理解过实现」。
 */
export function formatEcoEvidence(items: readonly EcoEvidenceSummary[]): string {
  if (items.length === 0) return '';
  return [
    '以下文件已由系统从工作区实际读取并核验（sha256 前 12 位 · 字节数）：',
    ...items.map(item => `- ${item.path} · sha256:${item.digest.slice(0, 12)} · ${item.size ?? '?'}B`)
  ].join('\n');
}

/** 构造主导模型五段汇总请求：问题 = 用户原话/计划标题，材料 = 计划数据（+ 已核验证据）。 */
export function buildPlanReviewLeadAsk(
  plan: AgentPlan,
  userPrompt?: string,
  evidence?: readonly EcoEvidenceSummary[]
): { question: string; system: string[] } {
  const answers = [planAsLeadAnswer(plan)];
  const question = (userPrompt?.trim() || plan.title || '评审这份计划').trim();
  const material = evidence && evidence.length > 0 ? formatEcoEvidence(evidence) : undefined;
  return {
    question: buildLeadSummaryQuestion(question, answers, {
      taskKind: 'compare',
      ...(material ? { material } : {})
    }),
    system: leadSummarySystem('compare')
  };
}

/**
 * 从五段汇总取议题：先【辩题】，没有再用【存疑】转核查题。
 * 与会话侧主导人逻辑一致，不拿用户原问凑辩题。
 */
export function topicsFromLeadSummary(summary: string): string[] {
  let topics = parseTopics(summary);
  if (topics.length === 0) {
    const doubts = parseDoubts(summary);
    if (doubts.length > 0) topics = doubts.map(item => `核实：${item}`);
  }
  return topics.slice(0, 5);
}

/** 五段汇总之后的 brief：议题只来自汇总，不来自计划结构模板。 */
export function planDebateBriefFromSummary(
  plan: AgentPlan,
  leadSummary: string
): PlanDebateBrief {
  const topics = topicsFromLeadSummary(leadSummary);
  if (topics.length === 0) {
    return {
      expressTarget: plan.kind === 'design'
        ? `设计文档「${plan.title}」`
        : `工程计划「${plan.title}」`,
      expressGoal: '',
      topics: [],
      source: 'none',
      leadSummary
    };
  }
  return {
    expressTarget: plan.kind === 'design'
      ? `设计文档「${plan.title}」· 主导模型五段结论中的议题`
      : `工程计划「${plan.title}」· 主导模型五段结论中的议题`,
    expressGoal: '就主导模型五段结论里提出的议题给出可审批判断。',
    topics: topics.map(text => ({ text, goal: '就该议题给出可审批裁定' })),
    source: 'model',
    leadSummary
  };
}

/** @deprecated 兼容旧测试：无五段时不再从计划结构编造议题。 */
export function planDebateBrief(plan: AgentPlan): PlanDebateBrief {
  return {
    expressTarget: `工程计划「${plan.title}」`,
    expressGoal: '',
    topics: [],
    source: 'none'
  };
}

export function planDebateTopics(plan: AgentPlan): string[] {
  return planDebateBrief(plan).topics.map(item => item.text);
}

/** 协作克制：计划风险等级（纯启发式，禁止为定级再调模型）。 */
export type CollaborationRiskLevel = 'L0' | 'L1' | 'L2' | 'L3';

export interface CollaborationRiskAssessment {
  level: CollaborationRiskLevel;
  reasons: string[];
}

const HIGH_RISK_TOOLS = new Set([
  'fs.remove', 'process.kill', 'job.kill', 'clipboard.write', 'notify'
]);

/**
 * 不调用模型：按工具族、步数、设计文档与能力门禁估协作等级。
 * 等级只喂 DMOCA/ECO（人数、角色、充分度），**不**替代主导模型写五段定辩题。
 */
export function assessCollaborationRisk(plan: AgentPlan): CollaborationRiskAssessment {
  const steps = plan.steps ?? [];
  const reasons: string[] = [];
  const writes = steps.filter(step => WRITE_TOOLS.has(step.tool));
  const computers = steps.filter(step => step.tool.startsWith('computer.'));
  const highRisk = steps.filter(step => HIGH_RISK_TOOLS.has(step.tool));
  const gate = checkPlanCapabilities(plan);

  if (plan.kind === 'design') {
    reasons.push('设计文档需要观点对照');
    return { level: 'L3', reasons };
  }
  if (highRisk.length > 0) {
    reasons.push(`含高风险工具 ${highRisk.map(step => step.tool).join('、')}`);
    return { level: 'L3', reasons };
  }
  if (computers.length > 0) {
    reasons.push(`含桌面控制 ${String(computers.length)} 步`);
    return { level: 'L3', reasons };
  }
  if (gate.missing.length > 0) {
    reasons.push(`计划缺判据：${gate.missing[0] ?? '未知'}`);
    return { level: 'L2', reasons };
  }
  if (writes.length >= 3 || steps.length >= 9) {
    reasons.push(`写入 ${String(writes.length)} / 共 ${String(steps.length)} 步`);
    return { level: 'L2', reasons };
  }
  if (writes.length > 0) {
    reasons.push(`小范围写入 ${String(writes.length)} 步`);
    return { level: 'L1', reasons };
  }
  if (gate.family === 'code.read' || steps.length <= 5) {
    reasons.push(gate.family === 'code.read' ? '只读/观察类计划' : `仅 ${String(steps.length)} 步且无写盘`);
    return { level: 'L0', reasons };
  }
  reasons.push(`主族 ${gate.family} · ${String(steps.length)} 步`);
  return { level: 'L1', reasons };
}

/**
 * 要不要走方案评审流水线（先五段，再按辩题决定是否辩论）。
 * - `off`：用户设置整段关掉（唯一允许的非模型跳过）
 * - `on` / `auto`：一定先让主导模型写五段。
 *   **辩题 / 是否辩论 / 是否继续审——一定由模型五段决定**，系统不得用 L0/步数启发式代替。
 */
export function shouldDebatePlan(
  mode: 'auto' | 'on' | 'off' | undefined,
  plan: AgentPlan
): { debate: boolean; reason?: string; risk?: CollaborationRiskAssessment } {
  const effective = mode ?? 'auto';
  if (effective === 'off') {
    return { debate: false, reason: '这一轮按设置关闭了辩论' };
  }
  const risk = assessCollaborationRisk(plan);
  return {
    debate: true,
    reason:
      effective === 'on'
        ? '设置开启方案评审：主导模型先写【结论/一致/分歧/存疑/辩题】；辩题/是否辩论一定由模型决定'
        : `auto：${risk.level}（${risk.reasons.join('；')}）只作协作预算参考；五段、辩题、是否辩论一定由模型决定`,
    risk
  };
}

/**
 * 计划数据正文（给主导模型当材料 / 给辩手当上下文）。
 * 不追加「请判断…」类评审话术。
 */
export function planReviewQuestion(plan: AgentPlan): string {
  if (plan.kind === 'design' && plan.design) {
    return [
      `【设计文档】${plan.title}`,
      plan.design.document,
      '',
      '【设计观点】',
      ...plan.design.viewpoints.map((item, index) => `${String(index + 1)}. ${item}`)
    ].join('\n');
  }
  const steps = (plan.steps ?? [])
    .map((step, index) => `${index + 1}. [${step.tool}] ${step.description ?? ''} ${JSON.stringify(step.args)}`)
    .join('\n');
  return [
    `【工程计划】${plan.title}`,
    plan.description,
    '',
    '【步骤】',
    steps,
    '',
    `【完成条件】${plan.completion?.condition ?? '未写明'}`
  ].join('\n');
}

/**
 * 方案评审的上限轮数（成本边界，不是固定跑满）。
 *
 * 实际轮次仍由分歧收敛决定；这里按协作等级收紧默认预算：
 * - L0/L1：最多 1 轮（表态即可；无实质争议不开下一轮）
 * - L2：最多 2 轮
 * - L3：最多 3 轮
 */
export interface PlanReviewRounds {
  /** 最多跑几轮；实际轮次由收敛结果决定。 */
  rounds: 1 | 2 | 3;
  /** 给审批的人看的一句话规则，界面会显示，不只是日志。 */
  reason: string;
  risk: CollaborationRiskLevel;
}

export function planReviewRounds(plan: AgentPlan, participantCount: number): PlanReviewRounds {
  const risk = assessCollaborationRisk(plan);
  const steps = plan.steps?.length ?? 0;
  let rounds: 1 | 2 | 3 =
    risk.level === 'L3' ? 3 : risk.level === 'L2' ? 2 : 1;
  // 多方评审且至少 L1：允许多一轮质疑，但仍不超过等级上限+1（封顶 3）。
  if (participantCount >= 3 && rounds < 3 && risk.level !== 'L0') {
    rounds = (rounds + 1) as 2 | 3;
  }
  const scope = [
    risk.level,
    `${String(steps)} 步`,
    plan.kind === 'design' ? '设计文档' : null,
    `${String(participantCount)} 位评审`,
    ...risk.reasons.slice(0, 2)
  ].filter(Boolean).join('、');
  return {
    rounds,
    risk: risk.level,
    reason: `最多 ${String(rounds)} 轮（${scope}），实际按分歧收敛：无新争议/无新证据提前结束`
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
