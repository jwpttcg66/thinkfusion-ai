/** P6-02/05/06/07：打包、诊断、回滚、安全。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPackageConfig } from '../out-test/main/release-ops/package.js';
import { buildDiagnostics, redact } from '../out-test/main/release-ops/diagnostics.js';
import { planRollback } from '../out-test/main/release-ops/rollback.js';
import { evaluateSecurity } from '../out-test/main/release-ops/security.js';

test('打包：dmg+zip+arm64+签名+公证', () => {
  assert.equal(checkPackageConfig({ targets: ['dmg', 'zip'], arch: ['arm64'], signed: true, notarized: true }).ok, true);
  assert.equal(checkPackageConfig({ targets: ['dmg'], arch: ['arm64'], signed: true, notarized: true }).ok, false);
});

test('诊断：脱敏路径/key/cookie，不收集正文', () => {
  assert.equal(redact('/Users/alice/post sk-abcdefgh cookie: abc'), '/Users/<user>/post <key> cookie: <redacted>');
  const diag = buildDiagnostics({ channels: [{ id: 'web', available: false, detail: '/Users/alice/x' }], errors: ['sk-abcdefgh'] });
  assert.equal(diag.channels[0].detail, '/Users/<user>/x');
  assert.equal(diag.recentErrors[0], '<key>');
});

test('回滚：计划含步骤；旧 schema 可读', () => {
  const plan = planRollback({ fromVersion: '0.4.0', toVersion: '0.3.0', fromSchema: 2, toSchema: 1, backupPath: '/b' });
  assert.equal(plan.preservesData, false);
  assert.ok(plan.steps.some(step => step.includes('恢复备份')));
});

test('安全：缺项拒绝', () => {
  assert.equal(evaluateSecurity([{ id: 'no-secrets-in-repo', ok: true }]).ok, false);
});
