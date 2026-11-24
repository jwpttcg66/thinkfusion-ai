/** 方案评审：与知识问答同一套「先五段再辩题」。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planDebateBriefFromSummary,
  planReviewQuestion,
  shouldDebatePlan,
  topicsFromLeadSummary
} from '../out-test/main/engineering/plan-review.js';

const plan = steps => ({ title: 't', steps, createdAt: 1 });
const write = { tool: 'fs.writeFile', args: { path: 'a', content: 'x' }, description: '写文件' };
const read = { tool: 'fs.read', args: { path: 'a' }, description: '读文件' };

test('写文件不再单独触发强制辩题模板', () => {
  assert.equal(shouldDebatePlan('off', plan([write])).debate, false);
});

test('纯只读短计划仍可走五段流水线（auto），off 才整段关掉', () => {
  assert.equal(shouldDebatePlan('off', plan([read])).debate, false);
  assert.equal(shouldDebatePlan('auto', plan([read])).debate, true);
});

test('design 计划：五段里的辩题才开辩；材料含观点不含请判断', () => {
  const design = {
    title: '缓存方案设计',
    description: '设计文档',
    kind: 'design',
    design: { document: '采用两级缓存...', viewpoints: ['一致性问题', '成本问题'] },
    steps: [read],
    completion: { condition: '评审通过' }
  };
  assert.equal(shouldDebatePlan('auto', design).debate, true);
  const question = planReviewQuestion(design);
  assert.match(question, /采用两级缓存/);
  assert.match(question, /一致性问题/);
  assert.doesNotMatch(question, /请判断/);

  const summary = [
    '【结论】两级缓存可做。',
    '【一致】需要谈一致性。',
    '【分歧】成本是否可接受。',
    '【存疑】没有。',
    '【辩题】',
    '1. 一致性问题是否阻断？'
  ].join('\n');
  assert.deepEqual(topicsFromLeadSummary(summary), ['一致性问题是否阻断？']);
  const brief = planDebateBriefFromSummary(design, summary);
  assert.equal(brief.source, 'model');
  assert.equal(brief.topics[0].text, '一致性问题是否阻断？');
});

test('五段无辩题：不编造辩论', () => {
  const summary = '【结论】够用。\n【一致】没有。\n【分歧】没有。\n【存疑】没有。\n【辩题】无';
  assert.deepEqual(topicsFromLeadSummary(summary), []);
  assert.equal(planDebateBriefFromSummary(plan([write]), summary).source, 'none');
});
