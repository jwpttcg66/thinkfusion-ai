/**
 * P3-Evidence Producer：从 ExecutionReport 生成可信 attestation。
 *
 * 钉住的是「不能随手把 Claim 绑到测试上」：
 * - 测试命令必须与报告逐字一致；
 * - passed/failed 与 exitCode 必须自洽；
 * - attestation 进入 Pack hash；
 * - 映射后的 DebateEvidence.execution 能被 Judge 消费。
 *
 * Run with: npm run test:execution-evidence
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { produceExecutionEvidence, ExecutionEvidenceError } from '../out-test/main/evidence-pack/execution-producer.js';
import { buildClaimVerificationPlan, verifyClaim } from '../out-test/main/evidence-pack/claim-verification.js';
import { EvidencePackStore } from '../out-test/main/evidence-pack/store.js';
import { mapPackToDebateEvidence } from '../out-test/main/evidence-pack/mapping.js';

const commit = 'a'.repeat(40);

function report(tests, overrides = {}) {
  return {
    protocol: 'thinkfusion.agent/v1',
    type: 'execution_report',
    taskId: 'task-1',
    roundId: 'round-1',
    planId: 'plan-1',
    status: 'completed',
    results: [],
    errors: [],
    nextAction: 'complete',
    createdAt: 1000,
    verification: {
      verified: tests.status === 'passed',
      reasons: [],
      changedFiles: 0,
      checks: {
        compile: { status: 'skipped' },
        tests,
        diagnostics: { status: 'skipped', errors: 0, warnings: 0 },
        changedFiles: []
      }
    },
    ...overrides
  };
}

function request(store, repoRoot, tests, overrides = {}) {
  return {
    debateId: 'debate-exec',
    roundIndex: 1,
    baselinePackId: 'pack_aaaaaaaaaaaaaaaa',
    claimId: 'c1',
    assertionId: 'assert-hit-rate',
    testId: 'cache.test.ts > hit rate',
    testCommand: 'npm test -- cache',
    repoRoot,
    repoCommit: commit,
    report: report(tests),
    store,
    createdAt: 2000,
    ...overrides
  };
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-exec-producer-'));
  const storeDir = path.join(root, 'store');
  return { root, storeDir, store: new EvidencePackStore(storeDir) };
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

test('passed 测试生成 attestation，映射为 supports 证据', () => {
  const h = setup();
  try {
    const result = produceExecutionEvidence(request(h.store, h.root, {
      status: 'passed', exitCode: 0, command: 'npm test -- cache', detail: '1 passed'
    }));
    const pack = h.store.replay(result.packId);
    assert.equal(pack.items.length, 1);
    assert.equal(pack.items[0].attestation.claimId, 'c1');
    assert.equal(pack.items[0].attestation.assertion, 'passed');
    assert.match(pack.items[0].attestation.resultHash, /^[a-f0-9]{64}$/);
    assert.equal(pack.manifest.context.kind, 'round');

    const mapped = mapPackToDebateEvidence(pack);
    assert.deepEqual(mapped[0].execution, {
      kind: 'test-result',
      exitCode: 0,
      assertion: 'passed',
      verifiesClaimIds: ['c1'],
      reference: 'cache.test.ts > hit rate'
    });
  } finally {
    cleanup(h.root);
  }
});

test('failed 测试生成 failed attestation，映射为 contradicts 证据', () => {
  const h = setup();
  try {
    const result = produceExecutionEvidence(request(h.store, h.root, {
      status: 'failed', exitCode: 1, command: 'npm test -- cache', detail: '1 failed'
    }));
    const pack = h.store.replay(result.packId);
    assert.equal(pack.items[0].attestation.assertion, 'failed');
    assert.equal(pack.items[0].attestation.exitCode, 1);
    assert.deepEqual(mapPackToDebateEvidence(pack)[0].execution, {
      kind: 'test-result',
      exitCode: 1,
      assertion: 'failed',
      verifiesClaimIds: ['c1'],
      reference: 'cache.test.ts > hit rate'
    });
  } finally {
    cleanup(h.root);
  }
});

test('命令不一致 / 未执行 / 退出码自相矛盾：拒绝生产', () => {
  const h = setup();
  try {
    assert.throws(
      () => produceExecutionEvidence(request(h.store, h.root, {
        status: 'passed', exitCode: 0, command: 'npm test -- other'
      })),
      error => error instanceof ExecutionEvidenceError && error.code === 'TEST_COMMAND_MISMATCH'
    );
    assert.throws(
      () => produceExecutionEvidence(request(h.store, h.root, {
        status: 'skipped', command: 'npm test -- cache'
      })),
      error => error.code === 'TEST_NOT_RUN'
    );
    assert.throws(
      () => produceExecutionEvidence(request(h.store, h.root, {
        status: 'passed', exitCode: 1, command: 'npm test -- cache'
      })),
      error => error.code === 'EXIT_CODE_MISMATCH'
    );
  } finally {
    cleanup(h.root);
  }
});

test('重复生产同一条执行：幂等复用同一 Pack', () => {
  const h = setup();
  try {
    const tests = { status: 'passed', exitCode: 0, command: 'npm test -- cache', detail: 'ok' };
    const first = produceExecutionEvidence(request(h.store, h.root, tests));
    const second = produceExecutionEvidence(request(h.store, h.root, tests));
    assert.equal(first.packId, second.packId);
    assert.equal(first.itemId, second.itemId);
  } finally {
    cleanup(h.root);
  }
});

test('Claim 验证计划：只允许 test.run 固定命令，受 TaskGrant 约束', () => {
  const built = buildClaimVerificationPlan({
    debateId: 'debate-exec',
    roundIndex: 1,
    claimId: 'c1',
    assertionId: 'assert-1',
    testCommand: 'npm test',
    rootDir: '/tmp/repo',
    repoCommit: commit
  }, 1000);
  assert.equal(built.plan.steps[0].tool, 'test.run');
  assert.deepEqual(built.plan.steps[0].args, { command: 'npm test' });
  assert.equal(built.grant.allowedTools.length, 1);
  assert.equal(built.grant.allowedTools[0], 'test.run');
  assert.equal(built.grant.permissionPreset, 'workspace-write');
  assert.equal(built.grant.approvalPolicy, 'ask');
  assert.equal(built.grant.maxSteps, 1);
  assert.throws(
    () => buildClaimVerificationPlan({
      debateId: 'd', roundIndex: 0, claimId: 'c1', assertionId: 'a1',
      testCommand: 'rm -rf /', rootDir: '/tmp/repo', repoCommit: commit
    }),
    /test.run 不支持/
  );
});

test('verifyClaim：真实报告 → attestation；runPlan 失败不生产证据', async () => {
  const h = setup();
  try {
    let called = null;
    const result = await verifyClaim({
      debateId: 'debate-exec',
      roundIndex: 1,
      claimId: 'c1',
      assertionId: 'assert-1',
      testCommand: 'npm test',
      rootDir: h.root,
      repoCommit: commit
    }, {
      store: h.store,
      runPlan: async (plan, grant, roundId, planId) => {
        called = { plan, grant, roundId, planId };
        return report({ status: 'passed', exitCode: 0, command: 'npm test', detail: 'ok' });
      },
      now: () => 2000
    });
    assert.ok(called);
    assert.equal(called.plan.taskId, called.grant.taskId);
    assert.equal(result.attestation.claimId, 'c1');
    assert.equal(result.attestation.assertion, 'passed');
    assert.ok(h.store.get(result.packId));

    await assert.rejects(
      () => verifyClaim({
        debateId: 'debate-exec', roundIndex: 1, claimId: 'c1', assertionId: 'a2',
        testCommand: 'npm test', rootDir: h.root, repoCommit: commit
      }, {
        store: h.store,
        runPlan: async () => { throw new Error('审批被拒绝'); }
      }),
      /审批被拒绝/
    );
  } finally {
    cleanup(h.root);
  }
});
