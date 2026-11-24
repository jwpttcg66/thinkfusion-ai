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
 * 方案评审 brief：议题之外，还必须写清表态对象与目标。
 *
 * 议题**不是**主导模型当场写的。这里用计划结构套固定模板：
 * ≥4 步 → 问拆分/合并/失败断点；有系统动作 → 问影响面与收尾；有覆盖写 → 问必要性……
 * 模板里的数字（几步、几个动作）来自本份计划，问法本身写死在代码里。
 * 模型的工作是**回答**这些议题，不是发明议题。
 *
 * 界面曾经只列议题原文和「第 1 轮表态」流程，用户看不到：
 * - 需要对什么表达立场；
 * - 表态要产出什么可审批判断；
 * - 每条议题辩完要落到什么决策。
 * 这些是产品可观测字段，不是提示词包装。
 */
export interface PlanDebateBrief {
  topics: PlanDebateTopicItem[];
  /** 需要对什么表达立场。 */
  expressTarget: string;
  /** 表态要产出什么判断。 */
  expressGoal: string;
}

/** 计划里值得辩的风险点，最多三条，按严重程度排序；附带每条决策目标。 */
export function planDebateBrief(plan: AgentPlan): PlanDebateBrief {
  if (plan.kind === 'design' && plan.design) {
    return {
      expressTarget: `设计文档「${plan.title}」及其观点编号`,
      expressGoal: '对每个观点给出成立/不成立判断，指出互相矛盾或缺依据处，并给出更稳妥替代（若有）。',
      topics: plan.design.viewpoints.slice(0, 3).map((viewpoint, index) => ({
        text: viewpoint,
        goal: `就观点 ${String(index + 1)} 给出可否采纳的结论，并写明依据是否充分。`
      }))
    };
  }
  const steps = plan.steps ?? [];
  const writes = steps.filter(step =>
    step.tool === 'fs.writeFile' || step.tool === 'fs.mkdir' || step.tool === 'fs.edit' ||
    step.tool === 'fs.remove' || step.tool === 'fs.move' || step.tool === 'fs.copy'
  );
  const overwrites = steps.filter(step => {
    if (step.tool !== 'fs.writeFile') return false;
    const args = step.args as { overwrite?: boolean };
    return args.overwrite === true;
  });
  const runsShell = steps.filter(step => step.tool === 'shell.run');
  /** 计划里有没有任何能看见改动效果的动作；有就不该再追着要某一种工具。 */
  const hasEvidence = planHasObservableEvidence(steps);
  const systemSteps = steps.filter(step =>
    step.tool === 'shell.run' || step.tool === 'screen.capture' || step.tool === 'app.open' ||
    step.tool === 'code.run'
  );
  const topics: PlanDebateTopicItem[] = [];

  if (overwrites.length > 0) {
    topics.push({
      text:
        `覆盖已有文件是否必要：计划里有 ${overwrites.length} 处 overwrite，` +
        '逐条说明为什么不能只追加或新建，以及回退办法。',
      goal: '决定每处覆盖是保留、改为追加/新建，还是先备份；必须写出回退办法。'
    });
  }
  if (writes.length > 0 && !hasEvidence) {
    // 不写死「必须有 test.run」：验证方式是模型按任务设计的（Java 用 javac +
    // 运行断言，前端用构建加截屏，脚本用一次真跑）。这里只把「什么时候算
    // 验证过」抛给它，由它给出这个任务该用的办法。
    topics.push({
      text:
        `改完之后怎么证明没改坏：这份计划有 ${writes.length} 处写入，但没有任何能观察结果的动作。` +
        '请按这个任务本身设计验证方式（跑哪条命令、看什么输出、什么算通过），并说明缺了它能不能算完成。',
      goal: '确定本任务的验证动作与通过标准；缺验证时明确能否标完成。'
    });
  }
  if (steps.length >= 4) {
    topics.push({
      text:
        `步骤拆分是否合理：${steps.length} 步里哪些可以合并、哪些顺序可调整，` +
        '哪一步失败会让后面全部作废。',
      goal: '产出可执行的步骤集合：标出可合并项、可调顺序，以及失败断点（哪一步失败则后续作废）。'
    });
  }
  if (runsShell.length > 0 && !hasEvidence) {
    topics.push({
      text:
        `这 ${runsShell.length} 条 shell 命令凭什么安全：逐条说明它会读还是写、` +
        '作用范围是否只在工作区内、失败时会不会留下半成品。',
      goal: '逐条裁定命令是否保留；不保留则给替代，保留则写明失败收尾（半成品如何处理）。'
    });
  } else if (systemSteps.length > 0) {
    topics.push({
      text:
        `这 ${systemSteps.length} 个系统动作（命令/截屏/启动应用/跑代码）有没有更小的影响面：` +
        '是否真的需要，以及失败了怎么收尾。',
      goal: '决定每个系统动作保留或砍掉；保留的必须写清更小影响面（若有）与失败收尾。'
    });
  }
  if (topics.length === 0) {
    topics.push({
      text: `这份计划的验收条件「${plan.completion?.condition ?? '未写明'}」是否足够，有没有更容易出错的地方。`,
      goal: '确认验收条件是否可操作；不足则补具体判据，并点名最易出错处。'
    });
  }
  return {
    expressTarget: `工程计划「${plan.title}」的步骤、系统动作与完成条件`,
    expressGoal:
      '给出可审批判断：哪些步骤保留/合并/砍掉，系统动作是否必要；结论必须指向具体步骤编号。',
    topics: topics.slice(0, 3)
  };
}

/** 兼容旧调用：只要议题原文。 */
export function planDebateTopics(plan: AgentPlan): string[] {
  return planDebateBrief(plan).topics.map(item => item.text);
}

/**
 * 要不要辩。
 *
 * `auto` 只在计划足够大或带风险动作时才辩——任务书要求 Auto 不得无声扩大
 * 模型调用与成本，一次两步的只读计划不值得开一场辩论。
 */
export function shouldDebatePlan(
  mode: 'auto' | 'on' | 'off' | undefined,
  plan: AgentPlan
): { debate: boolean; reason?: string } {
  const effective = mode ?? 'auto';
  const steps = plan.steps ?? [];
  // 设计文档/观点：强制评审，不受开关影响；与写文件等工具无关。
  if (plan.kind === 'design') return { debate: true, reason: '设计文档/观点，强制评审' };
  if (effective === 'off') {
    return { debate: false, reason: '这一轮按设置关闭了辩论' };
  }
  if (effective === 'on') return { debate: true, reason: '设置要求开启方案评审' };
  const risky = steps.some(step =>
    step.tool === 'fs.writeFile' || step.tool === 'fs.mkdir' || step.tool === 'test.run' ||
    // shell / 截屏 / 启动应用的影响面在工作区之外，auto 下同样值得先辩一轮。
    step.tool === 'shell.run' || step.tool === 'screen.capture' || step.tool === 'app.open' ||
    // 删除、结束进程、抓网页会改变磁盘或把内容发到外网，不能按"小计划"跳过评审。
    step.tool === 'fs.remove' || step.tool === 'fs.move' || step.tool === 'fs.copy' ||
    step.tool === 'process.kill' || step.tool === 'job.kill' || step.tool === 'web.fetch' ||
    // 跑一段代码等于跑一段任意逻辑（能读能写能联网），风险不低于 shell。
    step.tool === 'code.run'
  );
  if (steps.length >= 3 || risky) {
    const riskyTools = [...new Set(steps
      .filter(step =>
        step.tool === 'fs.writeFile' || step.tool === 'fs.mkdir' || step.tool === 'test.run' ||
        step.tool === 'shell.run' || step.tool === 'screen.capture' || step.tool === 'app.open' ||
        step.tool === 'fs.remove' || step.tool === 'fs.move' || step.tool === 'fs.copy' ||
        step.tool === 'process.kill' || step.tool === 'job.kill' || step.tool === 'web.fetch' ||
        step.tool === 'code.run'
      )
      .map(step => step.tool))];
    return {
      debate: true,
      reason: `计划 ${String(steps.length)} 步${riskyTools.length > 0 ? `，含 ${riskyTools.join('、')}` : ''}，按 auto 规则先评审`
    };
  }
  return { debate: false, reason: `计划只有 ${steps.length} 步且都是只读操作，按 auto 不单独开辩` };
}

/**
 * 交给辩论引擎的问题。
 *
 * 写成一条可以直接被辩手回答的问题，而不是「请评审这份 JSON」：辩手是模型，
 * 它需要知道要判断什么，也需要看到计划本身。
 */
export function planReviewQuestion(plan: AgentPlan): string {
  if (plan.kind === 'design' && plan.design) {
    return [
      `【待评审的设计文档】${plan.title}`,
      plan.design.document,
      '',
      '【设计观点】',
      ...plan.design.viewpoints.map((item, index) => `${String(index + 1)}. ${item}`),
      '',
      '请判断：这份设计是否成立？哪些观点互相矛盾、缺了什么依据、有没有更稳妥的替代方案。' +
        '结论要指向具体观点编号。'
    ].join('\n');
  }
  const steps = (plan.steps ?? [])
    .map((step, index) => `${index + 1}. [${step.tool}] ${step.description ?? ''} ${JSON.stringify(step.args)}`)
    .join('\n');
  return [
    `【待评审的工程计划】${plan.title}`,
    plan.description,
    '',
    '【步骤】',
    steps,
    '',
    `【完成条件】${plan.completion?.condition ?? '未写明'}`,
    '',
    '请判断：这份计划能不能真正完成上面这件事？哪些步骤会失败、缺了什么验证、' +
      '有没有更稳妥的顺序。结论要指明具体步骤编号。'
  ].join('\n');
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
