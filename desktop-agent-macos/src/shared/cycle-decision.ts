/**
 * GCE-P3：Cycle 决策纯函数。
 *
 * 只做确定性判断：给定目标符合度、验证状态、评审、预算、进度和诊断，
 * 选择下一步。不写事件、不调度任务。
 *
 * 规范：docs/spec/GOAL_CONTRACT_EVIDENCE_CONTRACTS.md
 * 设计：docs/architecture/GCE-P3-CYCLE-DECISION-DESIGN.md
 */

import type {
  GoalContract,
  GoalContractStatus,
  GoalFitAssessment
} from './goal-contract';
import type { DeliveryState } from './goal-contract';

export type GceCycleStage =
  | 'GOAL_REASONING'
  | 'ANALYSIS'
  | 'DESIGN'
  | 'DESIGN_DEBATE'
  | 'PLANNING'
  | 'IMPLEMENTATION'
  | 'REVIEW'
  | 'REVIEW_DEBATE'
  | 'CONCLUSION'
  | 'GOAL_FIT'
  | 'NEXT_DECISION';

export type CycleDecisionType =
  | 'CONTINUE'
  | 'REPAIR'
  | 'REPLAN'
  | 'REDESIGN'
  | 'REANALYZE'
  | 'CLARIFY_GOAL'
  | 'CHANGE_PROPOSED'
  | 'WAIT_USER'
  | 'BLOCKED'
  | 'COMPLETE'
  | 'FAIL_DELIVERY'
  | 'ABORT';

/**
 * 决策的**可执行**落点。
 *
 * 为什么把行为放进修函数：以前 `decideCycleAction` 只给标签、orchestrator 自己再判一遍
 * 行为（`goal-driven-cycle.ts:152` 的四出口 + 一段三元映射），于是「事件里记的决策」和
 * 「实际做的事」可以各说各话。现网读代码就能构造出这种组合：`goalNeedsMoreWork` 且
 * `atMaxRounds` 时标签走 `WAIT_USER` 分支，行为却仍按 `fail_budget` 把任务标成 `failed`
 * （`orchestrator.ts:3352-3382` 与 `:3512` 不在同一个条件上）。一个出口只有一处判定。
 */
export type CycleNextAction =
  | 'finish_completed'
  | 'open_next_round'
  | 'stop_and_wait'
  | 'fail_budget'
  | 'fail_delivery'
  | 'abort';

export type CycleDiagnosis =
  | 'none'
  | 'implementation'
  | 'design'
  | 'analysis'
  | 'task_plan'
  | 'goal'
  | 'environment';

/**
 * 空转的原因分类（任务书 M3-2 的四类）。
 *
 * 只从报告里已有的结构化事实判，不问模型「你为什么没进展」：模型会说「我再试一次」，
 * 而这句话既不能核对也不能当证据用。
 */
export type CycleNoProgressCause =
  /** 同一批命令又跑了一遍、退出码也一样——再开一轮只会得到同样的输出。 */
  | 'repeated_call'
  /** 这一轮没有采到任何可核对的事实，或做的事与未满足的标准无关。 */
  | 'missing_context'
  /** 步骤被授权/权限挡下（只有人能解除，模型重试不会让许可出现）。 */
  | 'missing_permission'
  /** 工具本身做不到（平台不支持、helper 缺失、参数不合法）。 */
  | 'needs_tool_change';

/** 分类的中文说法：理由文本、事件、界面共用一份，不再各处手抄。 */
export const CYCLE_NO_PROGRESS_CAUSE_TEXT: Record<CycleNoProgressCause, string> = {
  repeated_call: '重复调用',
  missing_context: '缺上下文',
  missing_permission: '缺权限',
  needs_tool_change: '需换工具'
};

export const CYCLE_DIAGNOSIS_TEXT: Record<CycleDiagnosis, string> = {
  none: '没有明确病因（各层都过得去，缺的是推进本身）',
  implementation: '实现层缺陷',
  design: '方案设计',
  analysis: '事实/分析不足',
  task_plan: '任务拆分或依赖',
  goal: '目标本身',
  environment: '执行通道或模型源'
};

export interface CycleProgress {
  fingerprint: string;
  repeated: number;
  criterionStalled: boolean;
  /** 未满足标准集合连续不变的轮数（0＝这一轮与上一轮不同）。 */
  criteriaStreak?: number;
  /** 未满足标准的集合签名，供下一轮比对。 */
  criterionKey?: string;
  /** 本轮采用的重复阈值：配置只在这一处，判定口径不再散在调用点。 */
  repeatLimit?: number;
  /** 本轮采用的标准停滞阈值，与 repeatLimit 同理由随进展落进事件（M3-2 的回退开关）。 */
  criteriaLimit?: number;
  /**
   * 连续被判定为空转的轮数（0＝这一轮有前进）。
   *
   * 需要单独记：只看指纹重复数，重做计划后仍然原地打转的任务会每轮都得到同一个
   * 「REPLAN」，等于把同一件事反复交给模型却不看它有没有改。有了这个数，第二连续
   * 空转就能改口为停下等人。
   */
  noProgressStreak?: number;
}

export const EMPTY_CYCLE_PROGRESS: CycleProgress = {
  fingerprint: '',
  repeated: 0,
  criterionStalled: false
};

/** 空转阈值默认值：同一证据指纹重复 2 轮、未满足标准集合停滞 2 轮，都算这一轮没有前进。 */
export const DEFAULT_NO_PROGRESS_REPEAT_LIMIT = 2;
export const DEFAULT_NO_PROGRESS_CRITERIA_LIMIT = 2;

export interface CycleNoProgressLimits {
  repeatLimit: number;
  criteriaLimit: number;
}

/**
 * 读用户配的阈值（M3-2 的回退开关）。
 *
 * 配置文件里可能是任意 JSON、缺字段、写 0、写字符串：非正整数一律回到默认值而不是
 * 「0＝永远判空转」或「NaN＝永远不判」——阈值参与的是 `>=` 比较，脏值会让空转判定
 * 变成一个静默失效或静默失控的开关。
 */
export function cycleNoProgressLimits(raw: unknown): CycleNoProgressLimits {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const positive = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
  return {
    repeatLimit: positive(record.repeatLimit, DEFAULT_NO_PROGRESS_REPEAT_LIMIT),
    criteriaLimit: positive(record.criteriaLimit, DEFAULT_NO_PROGRESS_CRITERIA_LIMIT)
  };
}

/**
 * 阈值的取值优先级：环境变量 > 配置文件 > 默认值（与 context-manager 开关同一套规则）。
 *
 * 环境变量写成 `3` 或 `3,4`：前者两阈值同值，后者依次是 repeatLimit、criteriaLimit。
 * 需要只调其中一个时用配置文件。写错的值不当成「关掉判定」——解析失败就退回下一档，
 * 因为空转判定是省轮次预算的那道闸，静默失效比误触发更难发现。
 */
export function resolveNoProgressLimits(input: { env?: unknown; config?: unknown }): CycleNoProgressLimits {
  const fallback = cycleNoProgressLimits(input.config);
  const text = typeof input.env === 'string' ? input.env.trim() : '';
  if (!text) return fallback;
  const parts = text.split(',').map(item => item.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return fallback;
  const numbers = parts.map(item => Number(item));
  if (numbers.some(item => !Number.isInteger(item) || item <= 0)) return fallback;
  const [repeatLimit, criteriaLimit] = numbers;
  return {
    repeatLimit: repeatLimit ?? fallback.repeatLimit,
    criteriaLimit: criteriaLimit ?? repeatLimit ?? fallback.criteriaLimit
  };
}

export interface CycleDecisionInput {
  /** 没有目标契约就是没有：不传而不是塞一个 DRAFT 假装契约存在。 */
  goalStatus?: GoalContractStatus;
  goalFit?: GoalFitAssessment | null;
  delivery: DeliveryState;
  review: { needsFix: boolean; blockingIssues: number; unresolved: number };
  budget: { atMaxRounds: boolean; tokenExhausted?: boolean; roundUsed?: number; roundLimit?: number };
  task: { cancelled?: boolean; blockedReason?: string };
  progress: CycleProgress;
  diagnosis: CycleDiagnosis;
  /**
   * 空转的原因分类（`deriveNoProgressCause` 的产物）。
   *
   * 只在 `isNoProgress(progress)` 为真时参与判定；不传时按「重复调用」处理——
   * 拿不到分类事实的最保守解释就是「这一轮做的事和上一轮一样」。
   */
  noProgressCause?: CycleNoProgressCause;
  /**
   * 执行层已经算出的硬闸门。
   *
   * 放进输入而不是留在调用点，是为了「只有一个判定出口」这条目标真的成立：
   * 这几条一旦留在 orchestrator 里另判一次，就又是第二套决策——而且是最难查的那种，
   * 因为事件里记的是纯函数给的标签，实际走的却是本地分支。
   */
  gates?: {
    /** 报告自述完成，但没有任何可核对的交付证据（`hasGenuineDelivery()` 为假）。 */
    deliveryUnconfirmed?: boolean;
    /** 桌面动作链未收口（Computer Use 窗口还开着）。 */
    desktopOpen?: boolean;
    /** 自动修复已停：两轮之间没有任何新事实、评审也没提新问题。 */
    repairBlocked?: boolean;
    /** 修复闸门给出的原话；没有这句，界面只能看到「等待用户」而不知道卡在哪。 */
    repairBlockedReason?: string;
    /** 风险/未验证已被接受（完全权限或用户点过「接受未验证」），出口不再丢回给人点。 */
    risksAccepted?: boolean;
  };
}

export interface CycleDecisionResult {
  decision: CycleDecisionType;
  reason: string;
  targetStage: GceCycleStage;
  /** 这一步是否停在人这里——与 `nextAction === 'stop_and_wait'` 同源。 */
  requiresUser: boolean;
  nextAction: CycleNextAction;
  /** 命中空转判定时的原因分类；其它判定为 null（没有分类就不写，不拿默认值冒充）。 */
  noProgressCause: CycleNoProgressCause | null;
}

/**
 * 判定落点的中文说法。放在纯函数侧而不是各组件里手抄：任务卡与结果面板要写同一句话，
 * 两处各列一份迟早会跟 `CycleNextAction` 的成员对不上。
 */
export const CYCLE_NEXT_ACTION_TEXT: Record<CycleNextAction, string> = {
  finish_completed: '按完成收尾',
  open_next_round: '开下一轮',
  stop_and_wait: '停下等你决定',
  fail_budget: '预算用尽，判失败',
  fail_delivery: '交付不成立，判失败',
  abort: '终止'
};

const USER_GATE: readonly GoalContractStatus[] = [
  'DRAFT',
  'UNDERSTANDING',
  'CLARIFYING',
  'READY_FOR_CONFIRMATION',
  'CHANGE_PROPOSED',
  'BLOCKED'
];

function stageFor(decision: CycleDecisionType): GceCycleStage {
  switch (decision) {
    case 'REPAIR': return 'IMPLEMENTATION';
    case 'REPLAN': return 'PLANNING';
    case 'REDESIGN': return 'DESIGN';
    case 'REANALYZE': return 'ANALYSIS';
    case 'CLARIFY_GOAL':
    case 'CHANGE_PROPOSED': return 'GOAL_REASONING';
    case 'FAIL_DELIVERY': return 'CONCLUSION';
    case 'COMPLETE':
    case 'ABORT': return 'NEXT_DECISION';
    case 'CONTINUE':
    case 'WAIT_USER':
    case 'BLOCKED':
    default: return 'NEXT_DECISION';
  }
}

/** 标签 → 可执行落点；只有预算这条需要调用点点名（M3-3 会改成超限暂停）。 */
function nextActionOf(decision: CycleDecisionType): CycleNextAction {
  switch (decision) {
    case 'COMPLETE': return 'finish_completed';
    case 'FAIL_DELIVERY': return 'fail_delivery';
    case 'ABORT': return 'abort';
    case 'REPAIR':
    case 'REPLAN':
    case 'REDESIGN':
    case 'REANALYZE':
    case 'CONTINUE': return 'open_next_round';
    case 'WAIT_USER':
    case 'CLARIFY_GOAL':
    case 'CHANGE_PROPOSED':
    case 'BLOCKED':
    default: return 'stop_and_wait';
  }
}

function result(
  decision: CycleDecisionType,
  reason: string,
  nextAction?: CycleNextAction,
  noProgressCause?: CycleNoProgressCause
): CycleDecisionResult {
  const action = nextAction ?? nextActionOf(decision);
  return {
    decision,
    reason,
    targetStage: stageFor(decision),
    // 「要不要人」跟着落点走，不跟着标签走：同样是 BLOCKED，版本链冲突是停下等人，
    // 预算耗尽是把任务判死——按标签判会前把后者也报成「等你」，后把前者漏掉。
    requiresUser: action === 'stop_and_wait',
    nextAction: action,
    noProgressCause: noProgressCause ?? null
  };
}

/**
 * 唯一的周期判定出口。
 *
 * 判定顺序（每条都是「不这样就会错下去」）：
 * 取消 > 外部阻塞 > 目标契约未就绪 > 环境不满足 > 连续无进展 > 修复闸门 > 无契约时的
 * 交付证据 > 评审 > 验证 > 桌面收口 > 目标符合度 > 预算兜底 > 完成。
 *
 * 预算为什么排在各条「要再开一轮」的判定里而不是最前：正好用完最后一轮把目标做完的任务，
 * 结论是完成；反过来，任何还需要再开一轮的路径在预算见底时都必须落到 `fail_budget`，
 * 而不是悄悄多跑一轮。`advance()` 就是这个兜底。
 */
export function decideCycleAction(input: CycleDecisionInput): CycleDecisionResult {
  const gates = input.gates ?? {};
  /** 已接受未验证/风险（完全权限档）：出口不再丢回给人点。 */
  const autoAdvance = gates.risksAccepted === true;

  /** 需要再开一轮的判定：预算见底时改口为 `fail_budget`，标签如实写 BLOCKED。 */
  const advance = (
    decision: CycleDecisionType,
    reason: string,
    noProgressCause?: CycleNoProgressCause
  ): CycleDecisionResult => {
    if (input.budget.atMaxRounds || input.budget.tokenExhausted) {
      return result(
        'BLOCKED',
        `预算已用尽，无法再开一轮（本来要做的是：${reason}${gateNote}）`,
        'fail_budget',
        noProgressCause
      );
    }
    return result(decision, `${reason}${gateNote}`, undefined, noProgressCause);
  };

  if (input.task.cancelled) return result('ABORT', '用户取消或终止');

  if (input.task.blockedReason) {
    return result('BLOCKED', `外部阻塞：${input.task.blockedReason}`);
  }

  if (input.goalStatus && USER_GATE.includes(input.goalStatus)) {
    if (input.goalStatus === 'BLOCKED') return result('BLOCKED', '目标契约被阻塞');
    if (input.goalStatus === 'CHANGE_PROPOSED') return result('CHANGE_PROPOSED', '目标变更等待用户确认');
    return result('CLARIFY_GOAL', `目标契约未就绪：${input.goalStatus}`);
  }

  /** 走到这里契约仍未建立（未就绪的状态已在上面返回）：任何「停在人这里」的出口都要点名它。 */
  const gateNote = input.goalStatus ? '' : '；目标契约还未确认，需要先确认目标';

  // 环境类问题只能停在这里：换通道、换源是用户的决定，模型重试不会让源出现。
  if (input.diagnosis === 'environment') {
    return result('WAIT_USER', `执行通道或模型源不满足，需要调整配置后重试${gateNote}`);
  }

  if (isNoProgress(input.progress)) {
    const cause = input.noProgressCause ?? 'repeated_call';
    const streak = input.progress.noProgressStreak ?? 1;
    // 理由只写事实里真有的东西：指纹重复触发的空转和「证据换了但目标没前进」是两回事，
    // 混成一句「同一证据重复 N 轮」会让后面核对的人对不上事件里的计数。
    const evidencePart = input.progress.repeated > 0
      ? `同一批证据已连续 ${String(input.progress.repeated + 1)} 轮没有变化`
      : '这一轮采到了不一样的证据，但未满足的标准一条也没变';
    const factsLine =
      `连续无进展（原因分类：${CYCLE_NO_PROGRESS_CAUSE_TEXT[cause]}，这是连续第 ${String(streak)} 轮）：${evidencePart}` +
      `${input.progress.criterionStalled ? `；未满足的标准集合连续 ${String(input.progress.criteriaStreak ?? 0)} 轮没有变化` : ''}` +
      `；诊断指向${CYCLE_DIAGNOSIS_TEXT[input.diagnosis]}`;
    // 任务书 M3-2：判定无进展时只许两种出口——重做计划（换手段）或停下等人，绝不再把
    // 同一批调用 EXECUTE 一遍。原来这里按诊断直接出 REDESIGN / REANALYZE，两条都落
    // open_next_round，等于「明知在空转还继续执行」；诊断信息不丢，改写在理由里。
    // 缺权限不给自动重规划的机会：重试不会让授权出现（与 AGENTS.md §9.1 同一个理由）。
    // 其余分类先给一次「必须换个做法」的重规划；连续第二次仍空转，说明重规划也没换来
    // 新事实，再跑只是烧轮次预算，交回给人。
    const byPermission = cause === 'missing_permission';
    if (byPermission || streak >= 2) {
      return result(
        'WAIT_USER',
        `${factsLine}；${byPermission
          ? '这一步只有用户能解除（授权或审批），停止自动循环'
          : '重做计划后仍未出现新事实，停止自动循环等待用户决定'}${gateNote}`,
        undefined,
        cause
      );
    }
    return advance(
      'REPLAN',
      `${factsLine}；下一轮必须先改变计划与手段（换验证方式、换工具，或把范围缩到一条未满足的标准上），不得重复同样的调用`,
      cause
    );
  }

  // 修复闸门：两轮之间没有任何新事实、评审也没提新问题，就到此为止。
  // 收尾还是等人，取决于风险是否已被接受——两种情况给出不同标签，不再共用一个 WAIT_USER。
  if (gates.repairBlocked) {
    const why = gates.repairBlockedReason ?? '两轮之间没有出现任何新证据';
    return autoAdvance
      ? result('COMPLETE', `自动修复已停：${why}；按未验证交付如实收尾`, 'finish_completed')
      : result('WAIT_USER', `自动修复已停：${why}${gateNote}`);
  }

  const goalFit = input.goalFit ?? null;

  // 评审、验证、桌面收口是「这一轮有没有把活干完」的证据，与有没有目标契约无关，只判一次。
  if (input.review.needsFix || input.review.blockingIssues > 0 || input.review.unresolved > 0) {
    return advance('REPAIR', '存在待修或未解决评审问题');
  }

  if (input.delivery.verification === 'FAILED') {
    return advance(
      diagnosisSplit(input.diagnosis, 'REPAIR'),
      input.diagnosis === 'design'
        ? '验证失败且设计不成立'
        : input.diagnosis === 'analysis'
          ? '验证失败且事实依据不足'
          : '验证未通过，进入修复'
    );
  }

  if (gates.desktopOpen) return advance('REPAIR', '桌面动作链未收口，Computer Use 窗口仍在等待');

  // 没有目标契约（老任务或还没建契约）：只按交付证据判定，不伪造一个符合度出来当依据。
  if (!goalFit) {
    if (input.delivery.execution === 'COMPLETED') {
      return gates.deliveryUnconfirmed
        ? result('FAIL_DELIVERY', '报告声明完成，但计划里的检查没有落到可核对的验证结论')
        : result('COMPLETE', '执行与验证均已完成（无目标契约，按交付证据判定）');
    }
    if (input.delivery.execution === 'FAILED') return advance('REPAIR', '执行失败，进入修复');
    return result('WAIT_USER', `执行尚未收口，需要用户确认${gateNote}`);
  }

  if (goalFit.fit === 'GAP') {
    if (input.diagnosis === 'goal') return result('CLARIFY_GOAL', '目标本身存在歧义或不可行');
    const gapReason =
      input.diagnosis === 'analysis'
        ? '目标缺口来自事实/分析不足'
        : input.diagnosis === 'design'
          ? '现有设计无法满足成功标准'
          : input.diagnosis === 'task_plan'
            ? '任务拆分/依赖无法覆盖目标'
            : input.diagnosis === 'implementation'
              ? '实现存在明确缺陷'
              : `目标存在 ${String(goalFit.unmet)} 项未满足标准`;
    if (input.diagnosis === 'none' && !autoAdvance) {
      return result(
        'WAIT_USER',
        `目标未达成：${gapReason}；需要确认下一轮计划（批准计划或提高权限后可自动推进）${gateNote}`
      );
    }
    return advance(diagnosisSplit(input.diagnosis, 'REPAIR'), gapReason);
  }

  if (goalFit.fit === 'WITH_RISKS') {
    return autoAdvance
      ? result('COMPLETE', '已接受带风险/未验证交付，如实带风险收尾', 'finish_completed')
      : result('WAIT_USER', `仅带风险达成，需用户确认是否接受${gateNote}`);
  }

  if (goalFit.fit === 'MET') {
    if (input.delivery.verification !== 'PASSED') {
      return result('WAIT_USER', `目标标准已满足，但验证状态未通过，需人工确认${gateNote}`);
    }
    if (gates.deliveryUnconfirmed) {
      return result('FAIL_DELIVERY', '标准判为已满足，但没有任何可核对的交付证据支撑这次完成');
    }
    return result('COMPLETE', '执行、验证和目标标准均已满足');
  }

  if (goalFit.fit === 'PARTIAL' || goalFit.fit === 'UNKNOWN') {
    if (input.diagnosis === 'implementation') return advance('REPAIR', '部分标准未满足，继续实现修复');
    return result(
      'WAIT_USER',
      goalFit.fit === 'PARTIAL'
        ? `目标仅部分达成（${String(goalFit.partial)} 项部分满足），需补充证据或调整范围${gateNote}`
        : `目标符合度无法判定，需补充目标或证据${gateNote}`
    );
  }

  return result('CONTINUE', '继续当前阶段');
}

/** 诊断决定「修哪一层」；没有诊断时按最靠近的实现层处理。 */
function diagnosisSplit(diagnosis: CycleDiagnosis, fallback: CycleDecisionType): CycleDecisionType {
  if (diagnosis === 'design') return 'REDESIGN';
  if (diagnosis === 'analysis') return 'REANALYZE';
  if (diagnosis === 'task_plan') return 'REPLAN';
  return fallback;
}

/** 旧四出口兼容：新决策不应被压成错误的 complete/repair。 */
export function legacyDecisionOf(
  decision: CycleDecisionType
): 'complete' | 'repair' | 'fail_budget' | 'fail_delivery' | 'observe' {
  switch (decision) {
    case 'COMPLETE': return 'complete';
    case 'REPAIR': return 'repair';
    case 'FAIL_DELIVERY': return 'fail_delivery';
    case 'BLOCKED':
    case 'WAIT_USER':
    case 'CLARIFY_GOAL':
    case 'CHANGE_PROPOSED':
    case 'ABORT':
      return 'observe';
    case 'REPLAN':
    case 'REDESIGN':
    case 'REANALYZE':
    case 'CONTINUE':
    default:
      return 'observe';
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

/** 稳定指纹：键排序、数组保序；只用于去重/回归，不作为业务 ID。 */
export function cycleFingerprint(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function detectNoProgress(input: {
  previous: CycleProgress | null;
  fingerprint: string;
  criterionKey: string;
  /** 同一证据指纹连续重复几轮算空转；调大即等效关闭这条判定。 */
  repeatLimit?: number;
  /** 未满足标准集合连续几轮不变算停滞；调大即等效关闭这条判定。 */
  criteriaLimit?: number;
}): CycleProgress {
  const previous = input.previous ?? EMPTY_CYCLE_PROGRESS;
  const repeatLimit = input.repeatLimit ?? DEFAULT_NO_PROGRESS_REPEAT_LIMIT;
  const criteriaLimit = input.criteriaLimit ?? DEFAULT_NO_PROGRESS_CRITERIA_LIMIT;
  const sameEvidence = Boolean(input.fingerprint) && previous.fingerprint === input.fingerprint;
  const sameCriteria = Boolean(input.criterionKey) && previous.criterionKey === input.criterionKey;
  const repeated = sameEvidence ? previous.repeated + 1 : 0;
  const criteriaStreak = sameCriteria ? (previous.criteriaStreak ?? 0) + 1 : 0;
  // 判定口径与 `isNoProgress` 必须同源，否则「进展状态说空转、决策函数说没空转」。
  const noProgress = repeated >= repeatLimit || criteriaStreak >= criteriaLimit;
  return {
    fingerprint: input.fingerprint,
    criterionKey: input.criterionKey,
    repeated,
    criteriaStreak,
    // 两个阈值都跟着进展一起落进事件：判定口径从此可核对、可重放，重启或改配置后
    // 回头看这条判定仍然说得出「当时用的是重复 2 轮就停」。
    repeatLimit,
    criteriaLimit,
    criterionStalled: criteriaStreak >= criteriaLimit,
    noProgressStreak: noProgress ? (previous.noProgressStreak ?? 0) + 1 : 0
  };
}

/** 判定「这一轮是不是空转」的口径：重复轮数阈值 + 标准集合停滞都来自同一份进展状态。 */
export function isNoProgress(progress: CycleProgress): boolean {
  return progress.repeated >= (progress.repeatLimit ?? 2) || progress.criterionStalled;
}

/**
 * 仍未满足的标准集合签名。
 *
 * 用它而不是证据指纹判停滞：证据可以每轮都换（改了文件、跑了新命令），但只要
 * UNMET/PARTIAL/UNVERIFIED 的集合连续两轮一模一样，目标就没有前进。
 */
export function openCriteriaKey(contract: GoalContract | null | undefined): string {
  if (!contract) return '';
  return cycleFingerprint(
    contract.criteria
      .filter(item => item.status === 'UNMET' || item.status === 'PARTIAL' || item.status === 'UNVERIFIED')
      .map(item => item.description.trim())
      .sort()
  );
}

/**
 * 错误码里属于「宿主/通道本身不满足」的那一类。
 *
 * 只认冒号前的结构化 code，不解析中文文案：把失败归到 environment 会让决策
 * 去 REANALYZE/REPLAN，而真正该做的是停下来告诉用户源不可用（AGENTS.md §9.1）。
 */
const ENVIRONMENT_ERROR_CODES = new Set([
  'TOOL_ERROR',
  'PLUGIN_UNAVAILABLE',
  'UNAVAILABLE',
  'ADAPTER_UNAVAILABLE',
  'MODEL_UNAVAILABLE',
  'SESSION_UNAVAILABLE'
]);

/**
 * 「这一步不被允许执行」的错误码。
 *
 * 全部取自 Runtime 实际写出的 code（`agent/index.ts` 的 `errorCode()` 与审批拒绝路径），
 * 不解析中文文案：把缺权限判成实现缺陷，决策就会去 REPAIR，而重试不会让授权出现。
 */
const PERMISSION_ERROR_CODES = new Set([
  'GRANT_INVALID',
  'TOOL_NOT_ALLOWED',
  'PATH_DENIED',
  'STEP_REJECTED'
]);

/**
 * 「工具本身做不到这件事」的错误码：换手段才有进展，改实现没有用。
 *
 * 同样只列 Runtime / 桌面通道实际写出的 code（`agent/index.ts` 的 `errorCode()`、
 * `agent/computer/bridge.ts`）。`TEST_FAILED`/`COMMAND_FAILED` 不在这里——那是本轮要修的
 * 东西本身，把它当成「工具不行」会让决策放弃修复。
 */
const TOOL_CHANGE_ERROR_CODES = new Set([
  'UNSUPPORTED_PLATFORM',
  'HELPER_MISSING',
  'NOT_FOUND',
  'LIMIT_EXCEEDED'
]);

/** `deriveCycleDiagnosis` 的输入：全部是已经算好的结构化事实，不含模型自述。 */
export interface CycleDiagnosisFacts {
  goalFit: GoalFitAssessment | null;
  /** GCE 覆盖门禁判出的「计划没有覆盖到的成功标准」条数。 */
  uncoveredCriteria: number;
  /** 本轮验证三查的状态；缺字段＝没记录，不当成通过。 */
  verification: { compile?: string; run?: string; tests?: string } | null;
  reportStatus: 'completed' | 'partial' | 'failed' | 'cancelled';
  failedSteps: number;
  /** 步骤错误里冒号前的 code（`COMMAND_FAILED: 命令退出码 3` → `COMMAND_FAILED`）。 */
  errorCodes: string[];
  reviewIssues: number;
}

/**
 * 本轮该往哪一层追因——`decideCycleAction` 的 `diagnosis` 输入。
 *
 * 这个函数存在的理由：纯决策函数早就写好了按 diagnosis 分流（REPAIR / REDESIGN /
 * REANALYZE / REPLAN / CLARIFY_GOAL），但生产里**没有任何代码产出 diagnosis**，
 * 所以直接把 orchestrator 接上去，所有轮次都会落进「无法自动判断下一步 → WAIT_USER」。
 * 这里用一个可测的优先级把已有事实翻译成病因，而不是再问模型一次。
 *
 * 顺序即优先级：环境不满足先说环境（改代码修不好）→ 计划没覆盖标准先改计划
 * （覆盖都缺，修实现是白修）→ 验证失败/未满足标准是实现缺陷 → 只有证据缺口
 * 而没有明确失败时才是「事实不足，先补分析」。
 */
export function deriveCycleDiagnosis(facts: CycleDiagnosisFacts): CycleDiagnosis {
  if (facts.errorCodes.some(code => ENVIRONMENT_ERROR_CODES.has(code))) return 'environment';
  if (facts.reportStatus === 'cancelled') return 'none';
  if (facts.uncoveredCriteria > 0) return 'task_plan';

  const checks = facts.verification;
  if (checks && (checks.compile === 'failed' || checks.tests === 'failed' || checks.run === 'failed')) {
    return 'implementation';
  }

  const fit = facts.goalFit;
  if (fit) {
    if (fit.blockingRisks.length > 0) return 'goal';
    if (fit.unmet > 0 || facts.failedSteps > 0) return 'implementation';
    // 标准没有被判失败、但一条都没被证据支撑：缺的是事实，不是实现。
    if (fit.unverified > 0 || fit.evidenceCompleteness < 1) return 'analysis';
  }

  if (facts.reportStatus === 'failed' || facts.failedSteps > 0) return 'implementation';
  if (facts.reviewIssues > 0) return 'implementation';
  return 'none';
}

/** `deriveNoProgressCause` 的输入：全部来自两轮报告的差集与错误码，不含模型自述。 */
export interface NoProgressCauseFacts {
  /** 本轮步骤错误里冒号前的 code。 */
  errorCodes: string[];
  /** 本轮真实执行过的步骤条数（0＝只出了一段话，什么都没做）。 */
  steps: number;
  /** 本轮采到的证据条数。 */
  evidence: number;
  /** 与上一轮「命令相同且退出码也相同」的条数——重复调用的直接证据。 */
  repeatedCommands: number;
}

/**
 * 空转是哪一类空转——`decideCycleAction` 的 `noProgressCause` 输入。
 *
 * 顺序即优先级：被授权挡下的步骤再多也不算「方法不对」（改计划不会让许可出现，必须等人）
 * → 什么都没做、什么都没采到就是缺上下文 → 工具本身不支持就先换手段 → 同命令同退出码就是
 * 重复调用。最后兜到缺上下文：能走到这里说明命令换过但判据没前进，缺的是「还差哪条标准」
 * 这份上下文，而不是又一次重复。
 */
export function deriveNoProgressCause(facts: NoProgressCauseFacts): CycleNoProgressCause {
  if (facts.errorCodes.some(code => PERMISSION_ERROR_CODES.has(code))) return 'missing_permission';
  if (facts.steps === 0 && facts.evidence === 0) return 'missing_context';
  if (facts.errorCodes.some(code => TOOL_CHANGE_ERROR_CODES.has(code))) return 'needs_tool_change';
  if (facts.repeatedCommands > 0) return 'repeated_call';
  return 'missing_context';
}

