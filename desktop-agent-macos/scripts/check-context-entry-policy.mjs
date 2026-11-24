/**
 * 入口上下文策略（LT-P4-02）。
 *
 * Web/CLI 必须拿不到历史；Debate 只取最近 20 条；Engineering 可以取 60 条；
 * 所有入口都不把内部推理当历史。
 *
 * Run with: npm run test:context-entry-policy
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { contextScopeFor, scopeHistory } from '../out-test/main/context/entry-policy.js';

const history = Array.from({ length: 80 }, (_, index) => ({
  eventId: `e${index}`,
  kind: index === 79 ? 'model' : 'message',
  text: index === 79 ? 'reasoning: 内部思考' : `历史 ${index}`,
  at: index
}));

test('Web/CLI：不注入任何历史，不注入 system', () => {
  for (const entry of ['web', 'cli']) {
    const scope = contextScopeFor(entry);
    assert.equal(scope.maxHistory, 0);
    assert.equal(scope.systemAllowed, false);
    assert.deepEqual(scopeHistory(entry, history), []);
  }
});

test('Debate/Reviewer：只取最近 20 条，evidenceOnly', () => {
  const scope = contextScopeFor('debate');
  assert.equal(scope.evidenceOnly, true);
  const selected = scopeHistory('debate', history);
  assert.equal(selected.length, 20);
  assert.equal(selected[0].eventId, 'e59');
  assert.equal(selected.at(-1).eventId, 'e78');
});

test('Engineering 取 60 条，Master/Collaboration 取 40 条', () => {
  assert.equal(scopeHistory('engineering', history).length, 60);
  assert.equal(scopeHistory('master', history).length, 40);
  assert.equal(scopeHistory('collaboration', history).length, 40);
});

test('内部推理不进入历史，即使模型事件落在窗口内', () => {
  const withReasoning = history.slice(70);
  assert.ok(!scopeHistory('engineering', withReasoning).some(item => item.text.includes('内部思考')));
});
