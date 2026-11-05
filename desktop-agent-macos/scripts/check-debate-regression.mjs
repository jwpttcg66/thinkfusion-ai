/**
 * AC-15：TF-D-001 ~ TF-D-010 自动回归（固定回放 + 结构化断言 + 报告）。
 *
 * 跑法：
 *   npm run test:debate-regression          # 只跑，报告写 out-test/
 *   npm run report:debate-regression        # 跑完把报告写到 docs/reports/
 *
 * 断言的写法见 `fixtures/debate-regression.mjs` 的 `expect`：每条用例列几个
 * 检查项，检查项只读结构（主张、争议、证据、结论），不比对具体措辞。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { independentSourceCount } from '../out-test/main/debate/evidence.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { DebateStore } from '../out-test/main/debate/store.js';
import { CASES } from './fixtures/debate-regression.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

const claimsOf = state => state.rounds.flatMap(round => round.claims ?? []);
const allText = state => claimsOf(state).map(claim => claim.text).join('\n').toLowerCase();

const CHECKS = {
  claimsMentionAll(state, words) {
    const text = allText(state);
    const missing = words.filter(word => !text.includes(word.toLowerCase()));
    return { ok: missing.length === 0, detail: missing.length ? `缺关键词：${missing.join('、')}` : `关键词齐全：${words.join('、')}` };
  },
  disputeType(state, type) {
    const found = (state.disputes ?? []).filter(dispute => dispute.type === type);
    return { ok: found.length > 0, detail: found.length ? `${type} 争议 ${found.length} 条` : `没有 ${type} 争议` };
  },
  verdictIs(state, value) {
    return { ok: state.verdict?.verdict === value, detail: `结论：${state.verdict?.verdict ?? '无'}` };
  },
  verdictNot(state, value) {
    return { ok: state.verdict?.verdict !== value, detail: `结论：${state.verdict?.verdict ?? '无'}（不应是 ${value}）` };
  },
  noAbsoluteConclusion(state) {
    const conclusion = state.verdict?.conclusion ?? '';
    const absolute = /(一定|绝对|必然|毫无疑问|肯定|所有情况下)/.test(conclusion);
    return { ok: !absolute, detail: absolute ? '结论里有绝对化表述' : conclusion ? '结论没有绝对化表述' : '没有给出结论' };
  },
  minorityWins(state) {
    return { ok: state.verdict?.minorityWins === true, detail: state.verdict?.minorityWins ? '少数派胜出' : '少数派没有胜出' };
  },
  independentSourcesAtMost(state, limit) {
    const claims = claimsOf(state);
    const max = claims.reduce(
      (value, claim) => Math.max(value, independentSourceCount(state.evidence ?? [], claim.claimId)),
      0
    );
    return { ok: max <= limit, detail: `单条主张最多 ${max} 个独立来源（上限 ${limit}）` };
  },
  duplicateEvidenceAtLeast(state, count) {
    const duplicates = (state.evidence ?? []).filter(item => item.duplicateOf);
    return { ok: duplicates.length >= count, detail: `${duplicates.length} 条证据被标成同源重复` };
  },
  noSupportedClaims(state) {
    const supported = (state.judgments ?? []).filter(judgment => judgment.verdict === 'supported');
    return { ok: supported.length === 0, detail: `${supported.length} 条主张被判成立（不该有）` };
  },
  conclusionNull(state) {
    return { ok: state.verdict?.conclusion === null, detail: state.verdict?.conclusion ? `给了结论：${state.verdict.conclusion.slice(0, 20)}` : '没有给结论' };
  },
  correctsPremise(state) {
    const text = allText(state);
    const corrected = /(前提不对|前提不成立|纠正|不等于|并不是|不能笼统)/.test(text);
    return { ok: corrected, detail: corrected ? '发言指出了前提问题' : '没有指出前提问题' };
  }
};

async function runCase(item) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-reg-'));
  const store = new DebateStore(dir);
  const spoken = new Map();
  const ask = async (agentId, task) => {
    const round = spoken.get(agentId) ?? 0;
    spoken.set(agentId, round + 1);
    const scripted = item.rounds[Math.min(round, item.rounds.length - 1)];
    const text = scripted[agentId];
    if (typeof text !== 'string') throw new Error(`${item.id}：fixture 缺 ${agentId} 第 ${round} 轮发言`);
    const citations = scripted.citations?.[agentId];
    return {
      agentId,
      text,
      receivedAt: Date.now(),
      ...(citations ? { citations: citations.map(citation => ({ ...citation, fetchedAt: 1700000000000 })) } : {}),
      attribution: { requestId: 'replay', note: '固定回放' },
      stage: task.stage
    };
  };

  const orchestrator = new DebateOrchestrator(store, { ask });
  const started = orchestrator.start(item.question, {
    strategy: 'standard',
    maxRounds: item.rounds.length,
    participants: item.participants,
    convergenceStop: false
  });
  const state = await orchestrator.waitFor(started.debateId, 10_000);
  fs.rmSync(dir, { recursive: true, force: true });
  return state;
}

const rows = [];

test('TF-D-001 ~ TF-D-010 固定回放回归', async t => {
  for (const item of CASES) {
    await t.test(`${item.id} ${item.title}`, async () => {
      const state = await runCase(item);
      const results = [];
      for (const [name, ...args] of item.expect) {
        const check = CHECKS[name];
        assert.ok(check, `未知的检查项：${name}`);
        const result = check(state, ...args);
        results.push({ name, ...result });
      }
      rows.push({
        id: item.id,
        title: item.title,
        verdict: state.verdict?.verdict ?? '无',
        rounds: state.rounds.length,
        claims: claimsOf(state).length,
        evidence: (state.evidence ?? []).length,
        passed: results.every(result => result.ok),
        details: results
      });
      const failed = results.filter(result => !result.ok);
      assert.equal(failed.length, 0, `${item.id} 未通过：${failed.map(result => `${result.name}（${result.detail}）`).join('；')}`);
    });
  }
});

test('回归报告', () => {
  const report = renderReport(rows);
  const output = path.join(ROOT, 'out-test');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'debate-regression.md'), report, 'utf8');
  if (process.env.TF_REPORT === '1') {
    const docs = path.join(ROOT, '..', 'docs', 'reports');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'DEBATE_REGRESSION.md'), report, 'utf8');
  }
  assert.equal(rows.length, CASES.length, '每条用例都要跑过');
});

function renderReport(items) {
  const passed = items.filter(item => item.passed).length;
  const lines = [
    '# 辩论回归报告（TF-D-001 ~ TF-D-010）',
    '',
    `由 \`npm run report:debate-regression\` 生成，生成时间 ${new Date().toISOString()}。`,
    '断言只看结构（主张、争议、证据、结论），不比措辞；用例数据见',
    '`desktop-agent-macos/scripts/fixtures/debate-regression.mjs`。',
    '',
    `**${String(passed)}/${String(items.length)} 通过。**`,
    '',
    '| 用例 | 场景 | 结论 | 轮次 | 主张 | 证据 | 结果 |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ];
  for (const item of items) {
    lines.push(
      `| ${item.id} | ${item.title} | ${item.verdict} | ${String(item.rounds)} | ${String(item.claims)} | ${String(item.evidence)} | ${item.passed ? '通过' : '未通过'} |`
    );
  }
  lines.push('', '## 各用例检查明细', '');
  for (const item of items) {
    lines.push(`### ${item.id} ${item.title}`, '');
    for (const detail of item.details) {
      lines.push(`- ${detail.ok ? '✅' : '❌'} \`${detail.name}\`：${detail.detail}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
