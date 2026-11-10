/**
 * 执行中提问（`ask.user`）。
 *
 * 测四件事：
 * 1. 计划 schema 接受合法参数、拒绝空问题与超量选项；
 * 2. 它是只读能力，且在能力清单里登记为 read-only；
 * 3. 只读授权下可用（不触发逐次审批）；
 * 4. 没有接提问通道时明确报错，而不是假装问了。
 *
 * Run with: npm run test:ask-user
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { PlanSchema, READ_ONLY_TOOLS, TOOL_NAMES } from '../out-test/shared/contracts.js';
import { CAPABILITY_CATALOG } from '../out-test/shared/capabilities.js';
import { riskOf } from '../out-test/agent/step-approval.js';
import { localCapabilities } from '../out-test/agent/local-plugins.js';

function plan(args) {
  return {
    protocol: 'desktop-agent/v1',
    type: 'plan',
    taskId: 't1',
    roundId: 'r1',
    title: '问用户',
    description: '',
    steps: [{ id: 's1', tool: 'ask.user', args }],
    completion: { condition: '用户回答' }
  };
}

test('计划接受合法提问：问题 + 选项 + 超时', () => {
  const parsed = PlanSchema.safeParse(
    plan({ question: '要覆盖已有文件吗？', options: ['覆盖', '另存'], allowFreeText: true, timeoutMs: 60_000 })
  );
  assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
});

test('空问题和超过 6 个选项都被拒绝', () => {
  assert.equal(PlanSchema.safeParse(plan({ question: '' })).success, false);
  assert.equal(
    PlanSchema.safeParse(plan({ question: '选一个', options: ['1', '2', '3', '4', '5', '6', '7'] })).success,
    false
  );
});

test('它是只读能力：清单、权限、审批都不把它当写操作', () => {
  assert.ok(TOOL_NAMES.includes('ask.user'));
  assert.ok(READ_ONLY_TOOLS.includes('ask.user'));
  const meta = CAPABILITY_CATALOG.find(item => item.id === 'ask.user');
  assert.equal(meta?.permission, 'read-only');
  assert.equal(riskOf('ask.user'), 'read');
});

test('没有接提问通道时明确报错', async () => {
  await assert.rejects(
    () => localCapabilities.execute('ask.user', { question: '选哪个？' }, {}),
    /没有接入提问通道/
  );
});

test('接了通道时把问题原样递出去，未回答不算失败', async () => {
  const seen = [];
  const outcome = await localCapabilities.execute(
    'ask.user',
    { question: '用哪个目录？', options: ['src', 'docs'] },
    {
      ask: async input => {
        seen.push(input);
        return { answered: false, reason: 'timeout' };
      }
    }
  );
  assert.deepEqual(seen, [{ question: '用哪个目录？', options: ['src', 'docs'] }]);
  assert.equal(outcome.failure, null);
  assert.deepEqual(outcome.result, { answered: false, reason: 'timeout' });
});
