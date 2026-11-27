/**
 * GCE 生产接线：计划 → GoalContract → 执行报告证据 → Goal Fit。
 *
 * 纯函数，供 Orchestrator 调用；不写存储、不发事件。
 * 只有明确标准（用户目标或计划完成条件）才创建 Criterion；没有标准保持 UNKNOWN，
 * 不拿任务摘要或执行完成冒充成功标准。
 */

import type { ExecutionReport } from '../../shared/contracts';
import {
  assessGoalContractFit,
  createGoalContract,
  createGoalCriterion,
  type CriterionStatus,
  type GoalContract,
  type GoalContractFit,
  type GoalContractStatus,
  type GoalCriterion,
  type GoalEvidenceLink
} from '../../shared/goal-contract';
import { applyEvidenceToGoalContract } from '../../shared/goal-evidence';

export interface PlanContractInput {
  taskId: string;
  userPrompt: string;
  goalId?: string;
  goalVersion?: number;
  /** 用户明确给出的成功标准；来自任务绑定目标，不是模型摘要。 */
  goalCriteria?: readonly string[];
  planTitle: string;
  planDescription?: string;
  completionCondition?: string;
  at?: number;
}

function criteriaFor(input: PlanContractInput, goalId: string): GoalCriterion[] {
  const at = input.at ?? Date.now();
  const version = input.goalVersion ?? 1;
  const criteria: GoalCriterion[] = [];
  const seen = new Set<string>();
  const add = (description: string, source: GoalCriterion['source'], id: string): void => {
    const text = description.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    criteria.push(createGoalCriterion({
      goalId,
      goalVersion: version,
      criterionId: id,
      description: text,
      source,
      priority: 'MUST',
      verificationMethod: '执行报告中的测试/编译/运行/诊断或非代码回读证据',
      acceptanceThreshold: '存在与该标准匹配的 PASSED 证据，且没有 FAILED 证据',
      updatedAt: at
    }));
  };

  (input.goalCriteria ?? []).forEach((item, index) => {
    add(item, 'USER_EXPLICIT', `criterion:${input.taskId}:user:${String(index + 1)}`);
  });
  if (input.completionCondition) {
    add(input.completionCondition, 'MODEL_INFERRED', `criterion:${input.taskId}:plan`);
  }
  return criteria;
}

/**
 * 从已生成计划建立契约。
 * 没有用户标准且计划没有 completion.condition 时不生成 Criterion，Fit 只能是 UNKNOWN。
 */
export function goalContractFromPlan(input: PlanContractInput): GoalContract {
  const at = input.at ?? Date.now();
  const goalId = input.goalId ?? `goal:${input.taskId}`;
  const criteria = criteriaFor(input, goalId);
  return createGoalContract({
    goalId,
    workId: input.taskId,
    originalRequest: input.userPrompt,
    goalVersion: input.goalVersion ?? 1,
    // 计划已进入审批/执行，目标处于活动状态；不是“已达成”。
    status: 'ACTIVE',
    dimensions: [
      { kind: 'USER_INTENT', text: input.userPrompt, source: 'USER_EXPLICIT', confidence: 1, updatedAt: at },
      { kind: 'DESIRED_OUTCOME', text: input.planTitle, source: 'MODEL_INFERRED', confidence: 0.6, updatedAt: at },
      {
        kind: 'SUCCESS_CRITERIA',
        text: criteria.map(item => item.description).join('\n'),
        source: criteria.some(item => item.source === 'USER_EXPLICIT')
          ? 'USER_EXPLICIT'
          : criteria.length > 0
            ? 'MODEL_INFERRED'
            : 'UNRESOLVED',
        confidence: criteria.length > 0 ? 0.7 : 0,
        updatedAt: at
      },
      {
        kind: 'IMPLICIT_CONSTRAINT',
        text: '工程执行约束由 TaskGrant/审批决定',
        source: 'SYSTEM_CONSTRAINT',
        confidence: 1,
        updatedAt: at
      },
      { kind: 'FEASIBILITY', text: '以 Runtime 实际执行为准', source: 'UNRESOLVED', confidence: 0, updatedAt: at },
      { kind: 'GOAL_VALUE', text: '', source: 'UNRESOLVED', confidence: 0, updatedAt: at }
    ],
    criteria,
    assumptions: input.planDescription ? [input.planDescription] : [],
    openQuestions: criteria.length === 0 ? ['计划没有给出可验收的完成条件'] : [],
    createdAt: at
  });
}

function codePath(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rs)$/i.test(path);
}

export interface ReportEvidenceInput {
  contract: GoalContract;
  report: ExecutionReport;
  cycleId?: string;
  at?: number;
}

/**
 * 把执行报告转成 Criterion 证据。
 *
 * 只使用报告真实字段：
 * - 测试/编译/运行/诊断通过 → 对应 RESULT；
 * - 非代码改动且 verification.verified → FILE_READBACK；
 * - 报告失败/取消 → FAILED 证据；
 * - 只有“执行完成”而没有可核对验证 → UNKNOWN；
 * - 模型文本不在报告里，不生成 MODEL_CLAIM。
 *
 * 每条 Criterion 都建立链接；没有链接的 Criterion 保持 PENDING。
 */
export function evidenceFromReport(input: ReportEvidenceInput): GoalEvidenceLink[] {
  const at = input.at ?? Date.now();
  const cycleId = input.cycleId ?? `cycle:${input.contract.workId}:1`;
  const report = input.report;
  const verification = report.verification;
  const checks = verification?.checks;
  const changed = verification?.changedPaths ?? [];
  const nonCode = changed.length > 0 ? changed.every(path => !codePath(path)) : false;

  type Kind = GoalEvidenceLink['evidenceType'];
  const observed: Array<{ type: Kind; status: GoalEvidenceLink['verificationStatus']; suffix: string }> = [];
  const add = (type: Kind, status: GoalEvidenceLink['verificationStatus'], suffix: string): void => {
    observed.push({ type, status, suffix });
  };

  if (report.status === 'failed' || report.status === 'cancelled') {
    add('TOOL_RESULT', 'FAILED', 'report');
  } else {
    if (checks?.tests.status === 'passed') add('TEST_RESULT', 'PASSED', 'tests');
    else if (checks?.tests.status === 'failed') add('TEST_RESULT', 'FAILED', 'tests-failed');
    if (checks?.compile.status === 'passed') add('BUILD_RESULT', 'PASSED', 'compile');
    else if (checks?.compile.status === 'failed') add('BUILD_RESULT', 'FAILED', 'compile-failed');
    if (checks?.run?.status === 'passed') add('RUNTIME_RESULT', 'PASSED', 'run');
    else if (checks?.run?.status === 'failed') add('RUNTIME_RESULT', 'FAILED', 'run-failed');
    if (checks?.diagnostics.status === 'passed' && observed.length === 0) {
      add('TOOL_RESULT', 'PASSED', 'diagnostics');
    } else if (checks?.diagnostics.status === 'failed' && observed.length === 0) {
      add('TOOL_RESULT', 'FAILED', 'diagnostics-failed');
    }
    if (observed.length === 0 && verification?.verified && nonCode) {
      add('FILE_READBACK', 'PASSED', 'readback');
    }
    if (observed.length === 0) {
      add('TOOL_RESULT', 'UNKNOWN', 'execution');
    }
  }

  const links: GoalEvidenceLink[] = [];
  for (const criterion of input.contract.criteria) {
    for (const item of observed) {
      links.push({
        evidenceId: `evidence:${input.contract.workId}:${report.roundId}:${criterion.criterionId}:${item.suffix}`,
        workId: input.contract.workId,
        cycleId,
        criterionId: criterion.criterionId,
        goalVersion: input.contract.goalVersion,
        evidenceType: item.type,
        source: `execution_report:${report.roundId}`,
        verificationStatus: item.status,
        linkedAt: at
      });
    }
  }
  return links;
}

/** 目标状态跟随 Goal Fit，但不把执行完成直接写成 ACHIEVED。 */
export function statusForFit(
  current: GoalContractStatus,
  fit: GoalContractFit
): GoalContractStatus {
  if (current === 'ABANDONED') return current;
  switch (fit) {
    case 'MET': return 'ACHIEVED';
    case 'WITH_RISKS': return 'ACHIEVED_WITH_RISKS';
    case 'PARTIAL': return 'AT_RISK';
    case 'GAP': return 'AT_RISK';
    default: return current === 'DRAFT' ? 'ACTIVE' : current;
  }
}

export function assessReportAgainstGoal(input: ReportEvidenceInput): {
  contract: GoalContract;
  links: GoalEvidenceLink[];
  fit: ReturnType<typeof assessGoalContractFit>;
  criteria: Array<{ criterionId: string; description: string; priority: GoalCriterion['priority']; status: CriterionStatus }>;
} {
  return assessReportsAgainstGoal({
    contract: input.contract,
    reports: [input.report],
    ...(input.cycleId ? { cycleId: input.cycleId } : {}),
    ...(input.at ? { at: input.at } : {})
  });
}

/**
 * 全轮证据一起判定。
 *
 * 修复/再验证轮常常不再写文件；只看最后一轮会把前面已满足的标准冲回 PENDING。
 * 证据来自全部执行报告并集（AGENTS §8.2 同一原则）。
 */
export function assessReportsAgainstGoal(input: {
  contract: GoalContract;
  reports: readonly ExecutionReport[];
  cycleId?: string;
  at?: number;
}): {
  contract: GoalContract;
  links: GoalEvidenceLink[];
  fit: ReturnType<typeof assessGoalContractFit>;
  criteria: Array<{ criterionId: string; description: string; priority: GoalCriterion['priority']; status: CriterionStatus }>;
} {
  const links = input.reports.flatMap(report => evidenceFromReport({
    contract: input.contract,
    report,
    ...(input.cycleId ? { cycleId: input.cycleId } : {}),
    ...(input.at ? { at: input.at } : {})
  }));
  const applied = applyEvidenceToGoalContract(input.contract, links, input.at);
  const fit = assessGoalContractFit(applied.contract);
  const contract: GoalContract = {
    ...applied.contract,
    status: statusForFit(applied.contract.status, fit.fit),
    updatedAt: input.at ?? Date.now()
  };
  return {
    contract,
    links,
    fit,
    criteria: contract.criteria.map(item => ({
      criterionId: item.criterionId,
      description: item.description,
      priority: item.priority,
      status: item.status
    }))
  };
}
