/**
 * Runtime Claim 的验证规划。
 *
 * 这一步不生成测试命令：命令来自 Claim 上由 author/reviewer/user 填写的
 * `verification` 意图。没有显式意图的 Runtime Claim 不自动跑测试；模型和
 * 裁判都不能补这个字段。
 */
import { TEST_COMMANDS, type TestCommand } from '../../shared/contracts';
import type { ClaimVerificationIntent, DebateState } from '../debate/types';
import { verifyClaim, type VerifyClaimDeps } from './claim-verification';
import type { ExecutionEvidenceResult } from './execution-producer';
import type { EvidencePackStore } from './store';

export interface ClaimVerificationTask {
  debateId: string;
  roundIndex: number;
  claimId: string;
  claimText: string;
  intent: ClaimVerificationIntent;
  repoRoot: string;
  repoCommit: string;
  branch?: string;
  dirty?: boolean;
  snapshotFingerprint?: string;
  baselinePackId?: string;
}

export interface PlannedClaimVerifications {
  tasks: ClaimVerificationTask[];
  skipped: Array<{ claimId: string; reason: string }>;
}

const SOURCES = new Set(['author', 'reviewer', 'user']);

export function planRuntimeClaimVerifications(state: DebateState): PlannedClaimVerifications {
  const tasks: ClaimVerificationTask[] = [];
  const skipped: Array<{ claimId: string; reason: string }> = [];
  const claims = state.rounds.flatMap(round => round.claims ?? []);

  for (const claim of claims) {
    const intent = claim.verification;
    if (!intent) {
      if (claim.claimScope === 'runtime') skipped.push({ claimId: claim.claimId, reason: 'no-intent' });
      continue;
    }
    if (claim.claimScope !== 'runtime') {
      skipped.push({ claimId: claim.claimId, reason: 'not-runtime' });
      continue;
    }
    if (!SOURCES.has(intent.source)) {
      skipped.push({ claimId: claim.claimId, reason: 'invalid-source' });
      continue;
    }
    if (!TEST_COMMANDS.includes(intent.testCommand as TestCommand)) {
      skipped.push({ claimId: claim.claimId, reason: 'unsupported-command' });
      continue;
    }
    if (!intent.assertionId || !intent.reason.trim()) {
      skipped.push({ claimId: claim.claimId, reason: 'invalid-intent' });
      continue;
    }
    if (!state.repository) {
      skipped.push({ claimId: claim.claimId, reason: 'no-repository' });
      continue;
    }
    tasks.push({
      debateId: state.debateId,
      roundIndex: claim.roundIndex,
      claimId: claim.claimId,
      claimText: claim.text,
      intent,
      repoRoot: state.repository.root,
      repoCommit: state.repository.commit,
      ...(state.repository.branch ? { branch: state.repository.branch } : {}),
      dirty: state.repository.dirty,
      ...(state.repository.dirtyFingerprint ? { snapshotFingerprint: state.repository.dirtyFingerprint } : {}),
      ...(state.evidencePack?.baselinePackId ? { baselinePackId: state.evidencePack.baselinePackId } : {})
    });
  }
  return { tasks, skipped };
}

export interface ExecuteClaimVerificationDeps {
  store: EvidencePackStore;
  runPlan: VerifyClaimDeps['runPlan'];
  now?: () => number;
}

export interface ClaimVerificationExecution {
  claimId: string;
  result?: ExecutionEvidenceResult;
  error?: string;
}

/** 顺序执行；一个 Claim 失败不阻止其他 Claim，错误逐条返回。 */
export async function executeClaimVerificationTasks(
  tasks: readonly ClaimVerificationTask[],
  deps: ExecuteClaimVerificationDeps
): Promise<ClaimVerificationExecution[]> {
  const out: ClaimVerificationExecution[] = [];
  for (const task of tasks) {
    try {
      const result = await verifyClaim({
        debateId: task.debateId,
        roundIndex: task.roundIndex,
        ...(task.baselinePackId ? { baselinePackId: task.baselinePackId } : {}),
        claimId: task.claimId,
        assertionId: task.intent.assertionId,
        ...(task.intent.testId ? { testId: task.intent.testId } : {}),
        testCommand: task.intent.testCommand as TestCommand,
        rootDir: task.repoRoot,
        repoCommit: task.repoCommit,
        ...(task.branch ? { branch: task.branch } : {}),
        ...(task.dirty !== undefined ? { dirty: task.dirty } : {}),
        ...(task.snapshotFingerprint ? { snapshotFingerprint: task.snapshotFingerprint } : {})
      }, {
        store: deps.store,
        runPlan: deps.runPlan,
        ...(deps.now ? { now: deps.now } : {})
      });
      out.push({ claimId: task.claimId, result });
    } catch (error) {
      out.push({
        claimId: task.claimId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return out;
}
