/** P6-02：真实 package.json 的 dmg+zip 配置。 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { checkMacConfig, readMacConfig } from '../out-test/main/release-ops/package-config.js';

test('package.json 的 mac target 含 dmg 与 zip', () => {
  const file = path.resolve(import.meta.dirname, '..', 'package.json');
  const config = readMacConfig(file);
  const result = checkMacConfig(config);
  assert.equal(result.ok, true, result.reasons.join('；'));
  assert.ok(result.targets.includes('dmg'));
  assert.ok(result.targets.includes('zip'));
});
