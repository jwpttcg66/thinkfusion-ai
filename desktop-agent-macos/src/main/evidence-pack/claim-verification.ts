/**
 * Runtime Claim 的验证任务边界。
 *
 * 不自动替用户跑测试：test.run 有副作用，必须经过现有 Agent Runtime 的
 * TaskGrant / 审批链。这里只负责：
 * 1. 把 Claim 的验证意图构造成受 schema 约束的计划；
 * 2. 用现有 runPlan 执行；
 * 3. 把真实 ExecutionReport 交给生产器生成 attestation。
 */
import { randomUUID } from 'node:crypto';
import {
  PlanSchema,
  PROTOCOL,
  TaskGrantSchema,
  TEST_COMMANDS,
  type AgentPlan,
  type ExecutionReport,
  type TaskGrant,
  type TestCommand
} from '../../shared/contracts';
import {
  produceExecutionEvidence,
  type ExecutionEvidenceRequest,
  type ExecutionEvidenceResult
} from './execution-producer';
import type { EvidencePackStore } from './store';

export interface ClaimVerificationInput {
  debateId: string;
  roundIndex: number;
  baselinePackId?: string;
  claimId: string;
  assertionId: string;
  testId?: string;
  /** 只允许现有 test.run 支持的命令；不接受任意 shell。 */
  testCommand: TestCommand;
  rootDir: string;
  repoCommit: string;
  branch?: string;
  dirty?: boolean;
  snapshotFingerprint?: string;
  timeoutMs?: number;
}

export interface ClaimVerificationPlan {
  plan: AgentPlan;
  grant: TaskGrant;
  roundId: string;
  planId: string;
}

export function buildClaimVerificationPlan(
  input: ClaimVerificationInput,
  now = Date.now()
): ClaimVerificationPlan {
  if (!TEST_COMMANDS.includes(input.testCommand)) {
    throw new Error(`test.run 不支持的命令：${input.testCommand}`);
  }
  const taskId = `claim-verify-${randomUUID()}`;
  const roundId = `claim-round-${randomUUID()}`;
  const planId = `claim-plan-${randomUUID()}`;
  const plan = PlanSchema.parse({
    protocol: PROTOCOL,
    type: 'plan',
    taskId,
    roundId,
    planId,
    title: `验证 Claim ${input.claimId}`,
    description: `执行 ${input.testCommand}，把真实退出码与断言结果写成工程证据。`,
    steps: [{
      id: 'verify',
      tool: 'test.run',
      description: input.testCommand,
      args: { command: input.testCommand }
    }],
    completion: { condition: '测试命令真实执行并返回退出码' }
  });
  const grant = TaskGrantSchema.parse({
    taskId,
    permissionPreset: 'workspace-write',
    approvalPolicy: 'ask',
    rootDir: input.rootDir,
    allowedTools: ['test.run'],
    expiresAt: now + 10 * 60 * 1000,
    maxSteps: 1,
    stepApproval: 'mutating'
  });
  return { plan, grant, roundId, planId };
}

export interface VerifyClaimDeps {
  runPlan: (
    plan: AgentPlan,
    grant: TaskGrant,
    roundId: string,
    planId: string
  ) => Promise<ExecutionReport>;
  store: EvidencePackStore;
  now?: () => number;
}

/**
 * 执行验证计划并生成证据。调用方必须先走现有审批/Runtime；本函数不绕开
 * TaskGrant，也不把「计划已批准」当成「测试已通过」。
 */
export async function verifyClaim(
  input: ClaimVerificationInput,
  deps: VerifyClaimDeps
): Promise<ExecutionEvidenceResult> {
  const built = buildClaimVerificationPlan(input, deps.now?.() ?? Date.now());
  const report = await deps.runPlan(built.plan, built.grant, built.roundId, built.planId);
  return produceExecutionEvidence({
    debateId: input.debateId,
    roundIndex: input.roundIndex,
    ...(input.baselinePackId ? { baselinePackId: input.baselinePackId } : {}),
    claimId: input.claimId,
    assertionId: input.assertionId,
    ...(input.testId ? { testId: input.testId } : {}),
    testCommand: input.testCommand,
    repoRoot: input.rootDir,
    repoCommit: input.repoCommit,
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.dirty !== undefined ? { dirty: input.dirty } : {}),
    ...(input.snapshotFingerprint ? { snapshotFingerprint: input.snapshotFingerprint } : {}),
    report,
    store: deps.store,
    createdAt: deps.now?.() ?? Date.now()
  } satisfies ExecutionEvidenceRequest);
}
