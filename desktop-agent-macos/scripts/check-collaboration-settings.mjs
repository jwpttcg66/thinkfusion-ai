/** A-04：指标累计 + active 门禁设置。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CollaborationModeStore, collaborationModePath } from '../out-test/main/collaboration/mode.js';
import { ShadowMetricsStore } from '../out-test/main/collaboration/metrics-store.js';
import { CollaborationSettings } from '../out-test/main/collaboration/settings.js';

function open() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-settings-'));
  return {
    d,
    modes: new CollaborationModeStore(collaborationModePath(d)),
    metrics: new ShadowMetricsStore(path.join(d, 'metrics.json'))
  };
}

test('未达门禁切 active 被拒；legacy/shadow 可切', () => {
  const { d, modes, metrics } = open();
  const settings = new CollaborationSettings(modes, metrics);
  assert.equal(settings.set('shadow').mode, 'shadow');
  assert.throws(() => settings.set('active'), /门禁/);
  assert.equal(settings.get().gate.ok, false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('累计 20 问且覆盖 90% 后可切 active', () => {
  const { d, modes, metrics } = open();
  const settings = new CollaborationSettings(modes, metrics);
  for (let i = 0; i < 20; i += 1) {
    metrics.record({ planned: true, covered: true, tasks: 2, simple: true });
  }
  assert.equal(settings.get().gate.ok, true);
  assert.equal(settings.set('active').mode, 'active');
  fs.rmSync(d, { recursive: true, force: true });
});

test('指标持久化；简单任务数超限仍拒绝', () => {
  const { d, modes, metrics } = open();
  for (let i = 0; i < 20; i += 1) {
    metrics.record({ planned: true, covered: true, tasks: 3, simple: true });
  }
  const settings = new CollaborationSettings(modes, metrics);
  assert.equal(settings.get().gate.ok, false);
  assert.throws(() => settings.set('active'), /简单问题/);
  fs.rmSync(d, { recursive: true, force: true });
});
