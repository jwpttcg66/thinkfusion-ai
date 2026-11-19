/** P5-01/02/04：能力声明、路由降级、按通道观测。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilitiesOf, supportsRole } from '../out-test/main/collaboration/capabilities.js';
import { routeParticipants } from '../out-test/main/collaboration/routing.js';
import { TelemetryLog } from '../out-test/main/collaboration/telemetry.js';

const p = (id, kind, capabilities = ['reasoning', 'knowledge'], available = true) => ({
  participantId: id, label: id, kind, capabilities, available, ...(available ? {} : { reason: '未登录' })
});

test('能力声明：网页无 system/工具；角色限制', () => {
  assert.equal(capabilitiesOf('web').canSystemPrompt, false);
  assert.equal(capabilitiesOf('web').canUseTools, false);
  assert.equal(capabilitiesOf('cloud').canUseTools, true);
  assert.equal(supportsRole('web', 'knowledge', 'questioner'), true);
  assert.equal(supportsRole('web', 'engineering', 'questioner'), false);
  assert.equal(supportsRole('local', 'knowledge', 'questioner'), false);
});

test('路由：local 不选 cloud；跳过有原因', () => {
  const result = routeParticipants({
    participants: [p('local', 'local'), p('cloud', 'cloud')],
    modelScope: 'local', includeWeb: false
  });
  assert.deepEqual(result.selected.map(x => x.participantId), ['local']);
  assert.equal(result.skipped.find(x => x.participantId === 'cloud').reason, '超出模型范围');
});

test('路由：工程网页 questioner 被拒；缺能力被拒', () => {
  const engineering = routeParticipants({
    participants: [p('web', 'web')], modelScope: 'hybrid', includeWeb: true,
    role: 'questioner', workspace: 'engineering'
  });
  assert.equal(engineering.selected.length, 0);
  assert.match(engineering.skipped[0].reason, /不允许此角色/);
  const cli = routeParticipants({
    participants: [p('cli', 'cli', ['reasoning'])], modelScope: 'hybrid', includeWeb: false,
    requiredCapabilities: ['knowledge']
  });
  assert.equal(cli.selected.length, 0);
  assert.match(cli.skipped[0].reason, /缺少所需能力/);
});

test('观测：网页 billing none 且不计 token；云端计 token', () => {
  const log = new TelemetryLog();
  log.record({ participantId: 'web', kind: 'web', ok: true, ms: 100, inputTokens: 10, outputTokens: 5 });
  log.record({ participantId: 'cloud', kind: 'cloud', ok: false, ms: 50, inputTokens: 8, outputTokens: 2 });
  const [cloud, web] = log.summary();
  assert.equal(web.billing, 'none');
  assert.equal(web.inputTokens, 0);
  assert.equal(cloud.billing, 'tokens');
  assert.equal(cloud.failures, 1);
  assert.equal(cloud.inputTokens, 8);
});
