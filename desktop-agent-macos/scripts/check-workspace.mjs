/**
 * V2.1 工作空间与工程任务路由。
 *
 * 这一组用例直接对应《Codex 实施任务书》第 6 节的 K/E 回归清单。
 * 全部是纯函数：不建会话、不碰网页、不写用户数据。
 *
 * Run with: npm run test:workspace
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WORKSPACE_STATE,
  classifyEngineeringIntent,
  normalizeDebateMode,
  normalizeWorkspaceMode,
  normalizeWorkspaceState,
  routeTask,
  routingLabel
} from '../out/shared/workspace.js';

test('坏的工作空间状态退回出厂值，不猜半个对象', () => {
  assert.deepEqual(normalizeWorkspaceState(null), DEFAULT_WORKSPACE_STATE);
  assert.deepEqual(normalizeWorkspaceState({ workspaceMode: 'nope', workspaceRoot: 42 }), DEFAULT_WORKSPACE_STATE);
  assert.equal(normalizeWorkspaceMode('engineering'), 'engineering');
  assert.equal(normalizeWorkspaceMode(undefined), 'knowledge');
  assert.equal(normalizeWorkspaceState({ workspaceRoot: '/tmp/project' }).workspaceRoot, '/tmp/project');
  assert.equal(normalizeWorkspaceState({ workspaceRoot: 'x'.repeat(5000) }).workspaceRoot.length, 2000);
});

test('辩论开关只有三档，坏值退回 auto', () => {
  assert.equal(normalizeDebateMode('off'), 'off');
  assert.equal(normalizeDebateMode('on'), 'on');
  assert.equal(normalizeDebateMode(undefined), 'auto');
  assert.equal(normalizeDebateMode('sometimes'), 'auto');
});

test('工程识别：V2.1 的七条回归语句都判对', () => {
  const cases = [
    ['分析当前项目结构', 'analysis'],
    ['解释某个方法', 'analysis'],
    ['定位这个 Bug', 'analysis'],
    ['评审这套架构方案', 'analysis'],
    ['修改一个文件', 'execution'],
    ['实现一个功能', 'execution'],
    ['重构这个模块', 'execution']
  ];
  for (const [text, expected] of cases) {
    const result = classifyEngineeringIntent(text);
    assert.equal(result.kind, expected, `${text} 应判成 ${expected}，实际 ${result.kind}（${result.reason}）`);
    assert.ok(result.reason.length > 0);
  }
});

test('先分析再修改：本轮只读分析，并记录两阶段', () => {
  const result = classifyEngineeringIntent('先分析再修改');
  assert.equal(result.kind, 'analysis');
  assert.deepEqual(result.stages, ['analysis', 'execution']);
  const routing = routeTask({ text: '先分析再修改', workspaceMode: 'engineering', hasProject: true });
  assert.equal(routing.taskKind, 'engineering_analysis');
  assert.deepEqual(routing.stages, ['analysis', 'execution']);
});

test('同时出现只读词与改动词：不确定就问，不擅自进高权限', () => {
  const result = classifyEngineeringIntent('分析一下怎么修改这个模块');
  assert.equal(result.kind, 'clarify');
  assert.match(result.reason, /明确/);
});

test('知识空间仍然走旧的五类意图，老行为一个字节没改', () => {
  assert.equal(routeTask({ text: '什么是连接池', workspaceMode: 'knowledge' }).taskKind, 'answer');
  assert.equal(routeTask({ text: '研究 Java 虚拟线程', workspaceMode: 'knowledge' }).taskKind, 'research');
  assert.equal(routeTask({ text: '对比 Envoy 和 Redis Proxy', workspaceMode: 'knowledge' }).taskKind, 'compare');
  assert.equal(routeTask({ text: '整理这个网页 https://example.com/a', workspaceMode: 'knowledge' }).taskKind, 'extract');
  assert.equal(routeTask({ text: '帮我修改 README.md 里的标题', workspaceMode: 'knowledge' }).taskKind, 'workspace');
});

test('工程空间没有项目目录：clarify，而不是让模型猜', () => {
  const routing = routeTask({ text: '分析当前项目结构', workspaceMode: 'engineering', hasProject: false });
  assert.equal(routing.needsProject, true);
  assert.equal(routing.taskKind, 'engineering_analysis');
});

test('用户本轮明确指定优先于规则，并标记来源', () => {
  const byRule = routeTask({ text: '实现一个功能', workspaceMode: 'engineering', hasProject: true });
  assert.equal(byRule.source, 'rule');
  assert.equal(byRule.taskKind, 'engineering_execution');

  const byUser = routeTask({
    text: '实现一个功能', workspaceMode: 'engineering', hasProject: true, override: 'analysis'
  });
  assert.equal(byUser.source, 'user_selected');
  assert.equal(byUser.taskKind, 'engineering_analysis');
  assert.equal(byUser.reason, '用户本轮明确指定');
});

test('识别不出来时待确认，绝不默认执行', () => {
  const routing = routeTask({ text: '嗯……这个怎么说', workspaceMode: 'engineering', hasProject: true });
  assert.equal(routing.taskKind, 'clarify');
  assert.equal(routing.needsClarification, true);
  assert.equal(routingLabel(routing), '待确认');
  assert.equal(routingLabel(routeTask({ text: '解释某个方法', workspaceMode: 'engineering', hasProject: true })), '工程分析');
});

test('系统动作类请求算工程实施（shell / 截屏 / 打开应用 / 找文件）', () => {
  const cases = [
    '执行命令 pwd 并告诉我输出',
    '帮我截屏，看看当前界面',
    '打开应用 TextEdit 写个便签',
    '搜索文件，找出所有 .ts'
  ];
  for (const text of cases) {
    const routing = routeTask({ text, workspaceMode: 'engineering', hasProject: true });
    assert.equal(routing.taskKind, 'engineering_execution', `应当判为实施：${text}`);
  }
});
