/**
 * 从现有工程执行链的 `ExecutionReport` 生成 Claim 级执行证据。
 *
 * 这不是「模型说某个测试验证了 Claim」：调用方必须给出 claimId、assertionId
 * 和期望的测试命令；报告里的 tests 状态、命令、退出码必须一一对上。
 *
 * 尚未接辩论编排器：当前没有「Claim → 验证任务」的规划器。本模块只提供
 * 可信的生产边界，等验证任务链路就绪后再调用。
 */
import { createHash } from 'node:crypto';
import type { ExecutionReport } from '../../shared/contracts';
import { canonicalJson } from './hash';
import { sha256Hex } from './hash';
import type { EvidencePackStore } from './store';
import type { ExecutionAttestation, EvidencePackItemDraft } from './types';

export type ExecutionEvidenceErrorCode =
  | 'NO_REPORT'
  | 'TEST_NOT_RUN'
  | 'TEST_COMMAND_MISMATCH'
  | 'EXIT_CODE_MISMATCH'
  | 'INVALID_REQUEST'
  | 'PUBLISH_FAILED';

export class ExecutionEvidenceError extends Error {
  constructor(
    readonly code: ExecutionEvidenceErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ExecutionEvidenceError';
  }
}

export interface ExecutionEvidenceRequest {
  debateId: string;
  roundIndex: number;
  baselinePackId?: string;
  claimId: string;
  assertionId: string;
  testId?: string;
  /** 期望的完整测试命令；必须与报告里的 tests.command 逐字一致。 */
  testCommand: string;
  repoRoot: string;
  repoCommit: string;
  branch?: string;
  dirty?: boolean;
  snapshotFingerprint?: string;
  executionId?: string;
  report: ExecutionReport;
  store: EvidencePackStore;
  createdAt?: number;
}

export interface ExecutionEvidenceResult {
  packId: string;
  itemId: string;
  attestation: ExecutionAttestation;
  content: string;
}

function failure(code: ExecutionEvidenceErrorCode, message: string): never {
  throw new ExecutionEvidenceError(code, message);
}

export function executionResultHash(report: ExecutionReport): string {
  const tests = report.verification?.checks?.tests;
  return sha256Hex(
    canonicalJson({
      taskId: report.taskId,
      roundId: report.roundId,
      planId: report.planId,
      status: report.status,
      testCommand: tests?.command ?? null,
      testStatus: tests?.status ?? null,
      testExitCode: tests?.exitCode ?? null,
      testDetail: tests?.detail ?? null,
      createdAt: report.createdAt
    })
  );
}

export function produceExecutionEvidence(request: ExecutionEvidenceRequest): ExecutionEvidenceResult {
  const { report } = request;
  if (!report) failure('NO_REPORT', '缺少 ExecutionReport');
  if (!request.claimId || !request.assertionId) {
    failure('INVALID_REQUEST', 'claimId 与 assertionId 都必须显式提供');
  }
  if (!request.testCommand) failure('INVALID_REQUEST', '必须提供期望的测试命令');
  const tests = report.verification?.checks?.tests;
  if (!tests || tests.status === 'skipped') {
    failure('TEST_NOT_RUN', 'ExecutionReport 没有实际执行测试');
  }
  if (tests.command !== request.testCommand) {
    failure(
      'TEST_COMMAND_MISMATCH',
      `测试命令不一致：期望 ${request.testCommand}，报告 ${tests.command ?? '(空)'}`
    );
  }
  if (tests.status === 'passed' && tests.exitCode !== 0) {
    failure('EXIT_CODE_MISMATCH', `测试状态 passed，但 exitCode=${String(tests.exitCode)}`);
  }
  if (tests.status === 'failed' && (tests.exitCode === undefined || tests.exitCode === 0)) {
    failure('EXIT_CODE_MISMATCH', `测试状态 failed，但 exitCode=${String(tests.exitCode)}`);
  }

  const executionId = request.executionId ?? `exec-${report.taskId}-${report.roundId}`;
  const resultHash = executionResultHash(report);
  const attestation: ExecutionAttestation = {
    executionId,
    ...(request.testId ? { testId: request.testId } : {}),
    assertionId: request.assertionId,
    claimId: request.claimId,
    assertion: tests.status,
    ...(tests.exitCode !== undefined ? { exitCode: tests.exitCode } : {}),
    repoCommit: request.repoCommit,
    ...(request.snapshotFingerprint ? { snapshotFingerprint: request.snapshotFingerprint } : {}),
    resultHash,
    producer: { name: 'agent-orchestrator.execution-report', version: '1.0.0' }
  };

  const content = [
    `executionId: ${executionId}`,
    `taskId: ${report.taskId}`,
    `roundId: ${report.roundId}`,
    `planId: ${report.planId}`,
    `command: ${tests.command}`,
    `status: ${tests.status}`,
    `exitCode: ${String(tests.exitCode ?? 'unknown')}`,
    `detail: ${tests.detail ?? ''}`,
    `claimId: ${request.claimId}`,
    `assertionId: ${request.assertionId}`,
    `resultHash: ${resultHash}`
  ].join('\n');
  const lines = content.split('\n');
  const relative = `.thinkfusion/executions/${executionId.replace(/[^a-zA-Z0-9._-]/g, '_')}/result.log`;
  const items: EvidencePackItemDraft[] = [{
    kind: 'test-result',
    content,
    attestation,
    source: { commit: request.repoCommit, path: relative },
    locator: { path: relative, startLine: 1, endLine: lines.length },
    meta: {
      tool: 'execution-report',
      capturedAt: request.createdAt ?? Date.now(),
      assertion: tests.status,
      verifiesClaimIds: [request.claimId],
      reference: request.testId ?? request.assertionId
    }
  }];

  try {
    const published = request.store.publish({
      repoRoot: request.repoRoot,
      idempotencyKey: `debate:${request.debateId}:execution:${executionId}:${request.assertionId}`,
      context: {
        kind: 'round',
        debateId: request.debateId,
        roundIndex: request.roundIndex,
        ...(request.baselinePackId ? { baselinePackId: request.baselinePackId } : {})
      },
      repo: {
        commit: request.repoCommit,
        dirty: Boolean(request.dirty),
        ...(request.branch ? { branch: request.branch } : {})
      },
      createdAt: request.createdAt ?? Date.now(),
      items
    });
    return {
      packId: published.manifest.packId,
      itemId: published.manifest.items[0]!.itemId,
      attestation,
      content
    };
  } catch (error) {
    if (error instanceof ExecutionEvidenceError) throw error;
    failure('PUBLISH_FAILED', error instanceof Error ? error.message : String(error));
  }
}
