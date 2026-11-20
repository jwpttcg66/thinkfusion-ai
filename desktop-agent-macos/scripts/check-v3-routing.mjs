/** 回归：工程动词与路由；制作/生成/搭建必须判实施。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { routeTask } from '../out-test/shared/workspace.js';
import { selectParticipants } from '../out-test/main/execution/policy.js';

const route = text => routeTask({ text, workspaceMode: 'engineering', hasProject: true });

test('制作示例工程判实施，不再落成只读问答', () => {
  for (const text of ['制作一个spring boot的示例工程，', '生成一个示例工程', '搭建一个脚手架']) {
    const result = route(text);
    assert.equal(result.taskKind, 'engineering_execution', text);
    assert.equal(result.engineeringKind, 'execution');
  }
});

test('只读分析仍然不误判', () => {
  assert.equal(route('分析这个工程的目录结构').taskKind, 'engineering_analysis');
});


test('云端主导不把网页放进回答名单', () => {
  const web = { id: 'web', sourceType: 'web' };
  const cloud = { id: 'cloud', sourceType: 'cloud' };
  const selection = selectParticipants(
    { executionMode: 'cloud', selectedCloudModels: ['cloud'] },
    [web], [cloud], []
  );
  assert.equal(selection.answerIds.has('cloud'), true);
  assert.equal(selection.answerIds.has('web'), false);
  assert.ok(selection.blocked.some(item => item.id === 'web' && /不问网页/.test(item.why)));
});
