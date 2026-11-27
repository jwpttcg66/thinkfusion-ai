/**
 * 长任务版本一致性（P1-05）。
 *
 * 四层各自可追溯还不够：Goal 变了、WorkTask 还是旧目标下的分解、ECO 包读的是
 * 旧提交、贡献快照钉的是旧稿——任一层错位，下游都可能「静默复用旧结论」。
 *
 * 这里只做一件事：拿当前事实比对链上每一层，明确说清哪一层过期、哪些成果
 * 还能继承。判不出来的一律不判过期（宁可不判，也不靠猜），但一旦判出过期，
 * 下游各层一起作废——半新的结论比旧结论更危险。
 */

import type { AgentEvent } from './contracts';

export type VersionLayer = 'goal' | 'worktask' | 'eco' | 'contribution' | 'decision';

export const VERSION_LAYERS: readonly VersionLayer[] = ['goal', 'worktask', 'eco', 'contribution', 'decision'];

export interface VersionIssue {
  layer: VersionLayer;
  id: string;
  reason: string;
}

export interface VersionChainInput {
  goal?: { goalId: string; version: number } | null;
  /** 任务树里实际绑定的目标版本（取各子任务的最大值）。 */
  workTask?: { workId: string; goalVersion?: number } | null;
  eco?: {
    contextVersion: number;
    goalVersion?: number;
    sufficiency?: 'sufficient' | 'partial' | 'insufficient' | 'stale';
  } | null;
  contribution?: { snapshotId: string; goalVersion?: number } | null;
  decision?: { decisionId: string; contributionSnapshotId: string } | null;
  /** 当前事实：目标版本；没有就不比。 */
  current?: { goalVersion?: number } | null;
}

export interface VersionConsistency {
  consistent: boolean;
  issues: VersionIssue[];
  /** 仍然可以继承的层。 */
  inheritable: VersionLayer[];
  /** 必须重做/重新采集的层。 */
  expired: VersionLayer[];
  /** 目标或任务结构变了：要局部重规划，不能接着跑旧步骤。 */
  requiresReplan: boolean;
  /** 上下文过期：重新采集后可以继续，不必整体重规划。 */
  requiresContextRefresh: boolean;
  notes: string[];
}

/**
 * 逐层比对。传播规则：某一层过期，链上位于它下游的层一并过期——
 * 一份「基于旧上下文得出的贡献」不会因为文件还在就重新成立。
 */
export function checkVersionChain(input: VersionChainInput): VersionConsistency {
  const issues: VersionIssue[] = [];
  const notes: string[] = [];
  const expired = new Set<VersionLayer>();

  const goal = input.goal ?? null;
  const currentGoal = input.current?.goalVersion;
  if (!goal) {
    notes.push('没有目标版本记录，跳过目标层比对');
  } else {
    if (currentGoal !== undefined && currentGoal !== goal.version) {
      issues.push({
        layer: 'goal',
        id: goal.goalId,
        reason: `当前目标版本 v${String(currentGoal)} 与任务记录的 v${String(goal.version)} 不一致`
      });
      expired.add('goal');
    }
    const workVersion = input.workTask?.goalVersion;
    if (workVersion !== undefined && workVersion !== goal.version) {
      issues.push({
        layer: 'worktask',
        id: input.workTask!.workId,
        reason: `任务树绑定的目标版本 v${String(workVersion)} 与目标 v${String(goal.version)} 不一致`
      });
      expired.add('worktask');
    }
    const ecoVersion = input.eco?.goalVersion;
    if (ecoVersion !== undefined && ecoVersion !== goal.version) {
      issues.push({
        layer: 'eco',
        id: `eco:v${String(input.eco!.contextVersion)}`,
        reason: `上下文包基于目标 v${String(ecoVersion)}，当前目标 v${String(goal.version)}`
      });
      expired.add('eco');
    }
    const contributionVersion = input.contribution?.goalVersion;
    if (contributionVersion !== undefined && contributionVersion !== goal.version) {
      issues.push({
        layer: 'contribution',
        id: input.contribution!.snapshotId,
        reason: `贡献快照基于目标 v${String(contributionVersion)}，当前目标 v${String(goal.version)}`
      });
      expired.add('contribution');
    }
  }

  if (input.eco?.sufficiency === 'stale') {
    issues.push({
      layer: 'eco',
      id: `eco:v${String(input.eco.contextVersion)}`,
      reason: '上下文包已被标记过期（代码或目标变化）'
    });
    expired.add('eco');
  }

  if (input.decision && input.contribution && input.decision.contributionSnapshotId !== input.contribution.snapshotId) {
    issues.push({
      layer: 'decision',
      id: input.decision.decisionId,
      reason: `决策钉住的快照 ${input.decision.contributionSnapshotId} 不是当前快照 ${input.contribution.snapshotId}`
    });
    expired.add('decision');
  }

  // 下游传播：目标 → 任务结构 → 上下文 → 贡献 → 决策。
  if (expired.has('goal')) {
    for (const layer of ['worktask', 'eco', 'contribution', 'decision'] as const) expired.add(layer);
  }
  if (expired.has('worktask')) {
    for (const layer of ['eco', 'contribution', 'decision'] as const) expired.add(layer);
  }
  if (expired.has('eco')) {
    for (const layer of ['contribution', 'decision'] as const) expired.add(layer);
  }
  if (expired.has('contribution')) expired.add('decision');

  const requiresReplan = expired.has('goal') || expired.has('worktask');
  const requiresContextRefresh = !requiresReplan && expired.has('eco');
  const inheritable = VERSION_LAYERS.filter(layer => !expired.has(layer));
  if (requiresReplan) {
    notes.push('目标/任务结构已变化：未完成的子任务要按新目标重规划，旧结论不得直接继承');
  } else if (requiresContextRefresh) {
    notes.push('工程上下文已过期：重新读取后可以继续，已通过的子任务结论仍可继承');
  } else if (inheritable.length === VERSION_LAYERS.length) {
    notes.push('四层版本一致，可以按检查点继续');
  }

  return {
    consistent: issues.length === 0,
    issues,
    inheritable,
    expired: VERSION_LAYERS.filter(layer => expired.has(layer)),
    requiresReplan,
    requiresContextRefresh,
    notes
  };
}

/** 恢复提示里的一段：只讲能继承什么、不能继承什么，不复述内部实现。 */
export function versionConsistencyPrompt(input: VersionConsistency): string {
  if (input.consistent) return '';
  const lines = [
    '版本一致性核对（自动比对，不是模型判断）：'
  ];
  for (const issue of input.issues) {
    lines.push(`- [${issue.layer}] ${issue.reason}`);
  }
  if (input.expired.length > 0) {
    lines.push(`已作废：${input.expired.join('、')}`);
  }
  if (input.inheritable.length > 0) {
    lines.push(`仍可继承：${input.inheritable.join('、')}`);
  }
  if (input.requiresReplan) {
    lines.push('要求：按当前目标重新规划，不得直接复用旧分解与旧结论。');
  } else if (input.requiresContextRefresh) {
    lines.push('要求：先重新读取相关文件与新上下文，再继续；旧贡献可以引用，但必须重新核验。');
  }
  return lines.join('\n');
}

/**
 * 恢复时每一层比对值的来源。不是装饰性元数据：历史 bug 就是把「当前事实」
 * 和「记录事实」都取成 `task.goalVersion`、把贡献快照和决策钉版都取成同一个
 * 决策事件，导致过期分支在生产中恒假。取源必须能在事件里核对。
 */
export interface ResumeVersionSources {
  goalVersion: 'task.goalVersion';
  currentGoalVersion: 'goal.contract.updated' | 'task.goalVersion';
  workTaskGoalVersion: 'work.task.upserted';
  ecoGoalVersion: 'checkpoint.ecoRef';
  contributionSnapshotId: 'plan.debated.contributionSnapshot';
  contributionGoalVersion: 'goal.contract.updated' | 'unavailable';
  decisionContributionSnapshotId: 'model.decision.snapshot';
}

/** 恢复中的版本链取源：把「任务记录」和「事件流里的当前事实」分开。 */
export function buildResumeVersionChainInput(input: {
  task: { taskId: string; goalId?: string; goalVersion?: number };
  events: readonly AgentEvent[];
  workTasks: readonly { workTaskId: string; goalVersion?: number }[];
  ecoRef?: {
    contextVersion: number;
    goalVersion?: number;
    sufficiency?: 'sufficient' | 'partial' | 'insufficient' | 'stale';
  } | null;
}): { chain: VersionChainInput; sources: ResumeVersionSources } {
  const ordered = [...input.events].sort((a, b) => a.at - b.at);
  const latest = (predicate: (event: AgentEvent) => boolean): AgentEvent | undefined => {
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const event = ordered[index];
      if (predicate(event)) return event;
    }
    return undefined;
  };

  const latestContract = latest(event => event.type === 'goal.contract.updated');
  const latestStale = latest(event => event.type === 'goal.contract.stale');
  // 契约已被判定过期时，事件流里的版本不再代表当前目标，退回任务记录。
  const contractIsCurrent = Boolean(
    latestContract && (!latestStale || latestStale.at < latestContract.at)
  );
  const recordedGoalVersion = input.task.goalVersion ?? 1;
  const currentGoalVersion = contractIsCurrent && latestContract?.type === 'goal.contract.updated'
    ? latestContract.contract.goalVersion
    : recordedGoalVersion;

  const boundGoalVersions = input.workTasks
    .map(item => item.goalVersion)
    .filter((item): item is number => typeof item === 'number');

  // 贡献快照落在 plan.debated 上；决策快照另落在 model.decision.snapshot 上。
  // 快照本身没有 goalVersion，用「快照生成时生效的契约版本」回填；查不到就
  // 留 undefined（checkVersionChain 的缺字段不误判语义）。
  const latestDebate = latest(event => event.type === 'plan.debated' && Boolean(event.debate.contributionSnapshot));
  const contributionSnapshot = latestDebate?.type === 'plan.debated'
    ? latestDebate.debate.contributionSnapshot ?? null
    : null;
  let contributionGoalVersion: number | undefined;
  if (contributionSnapshot) {
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const event = ordered[index];
      if (event.at > contributionSnapshot.createdAt) continue;
      if (event.type === 'goal.contract.stale') break;
      if (event.type === 'goal.contract.updated') {
        contributionGoalVersion = event.contract.goalVersion;
        break;
      }
    }
  }
  const lastDecisionEvent = latest(event => event.type === 'model.decision.snapshot');

  return {
    chain: {
      goal: {
        goalId: input.task.goalId ?? `goal:${input.task.taskId}`,
        version: recordedGoalVersion
      },
      workTask: {
        workId: input.task.taskId,
        ...(boundGoalVersions.length > 0 ? { goalVersion: Math.max(...boundGoalVersions) } : {})
      },
      eco: input.ecoRef
        ? {
            contextVersion: input.ecoRef.contextVersion,
            ...(input.ecoRef.goalVersion !== undefined ? { goalVersion: input.ecoRef.goalVersion } : {}),
            sufficiency: input.ecoRef.sufficiency
          }
        : null,
      contribution: contributionSnapshot
        ? {
            snapshotId: contributionSnapshot.snapshotId,
            ...(contributionGoalVersion !== undefined ? { goalVersion: contributionGoalVersion } : {})
          }
        : null,
      decision: lastDecisionEvent?.type === 'model.decision.snapshot'
        ? {
            decisionId: lastDecisionEvent.snapshot.decisionId,
            contributionSnapshotId: lastDecisionEvent.snapshot.contributionSnapshotId
          }
        : null,
      current: { goalVersion: currentGoalVersion }
    },
    sources: {
      goalVersion: 'task.goalVersion',
      currentGoalVersion: contractIsCurrent ? 'goal.contract.updated' : 'task.goalVersion',
      workTaskGoalVersion: 'work.task.upserted',
      ecoGoalVersion: 'checkpoint.ecoRef',
      contributionSnapshotId: 'plan.debated.contributionSnapshot',
      contributionGoalVersion: contributionGoalVersion !== undefined ? 'goal.contract.updated' : 'unavailable',
      decisionContributionSnapshotId: 'model.decision.snapshot'
    }
  };
}
