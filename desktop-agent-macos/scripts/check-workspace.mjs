/**
 * V2.1 工作空间与工程任务路由。
 *
 * 这一组用例直接对应《Codex 实施任务书》第 6 节的 K/E 回归清单。
 * 全部是纯函数：不建会话、不碰网页、不写用户数据。
 *
 * Run with: npm run test:workspace
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceListStore } from '../out-test/main/workspace-list-store.js';
import {
  DEFAULT_WORKSPACE_STATE,
  classifyEngineeringIntent,
  groupByWorkspace,
  normalizeDebateMode,
  normalizeWorkspaceEntries,
  normalizeWorkspaceMode,
  normalizeWorkspaceState,
  routeTask,
  routingLabel,
  workspaceNameFromRoot
} from '../out/shared/workspace.js';

test('坏的工作空间状态退回出厂值，不猜半个对象', () => {
  assert.deepEqual(normalizeWorkspaceState(null), DEFAULT_WORKSPACE_STATE);
  assert.deepEqual(normalizeWorkspaceState({ workspaceMode: 'nope', workspaceRoot: 42 }), DEFAULT_WORKSPACE_STATE);
  assert.equal(normalizeWorkspaceMode('engineering'), 'engineering');
  assert.equal(normalizeWorkspaceMode(undefined), 'knowledge');
  assert.equal(normalizeWorkspaceState({ workspaceRoot: '/tmp/project' }).workspaceRoot, '/tmp/project');
  assert.equal(normalizeWorkspaceState({ workspaceRoot: 'x'.repeat(5000) }).workspaceRoot.length, 2000);
  // 老文件没有 activeWorkspaceId：读回来的默认值必须是空，而不是 undefined。
  assert.equal(normalizeWorkspaceState({ workspaceRoot: '/tmp/project' }).activeWorkspaceId, '');
  assert.equal(normalizeWorkspaceState({ activeWorkspaceId: 'w'.repeat(100) }).activeWorkspaceId.length, 64);
});

test('工作区列表：坏条目跳过、同目录去重、名字取目录末段', () => {
  assert.deepEqual(normalizeWorkspaceEntries(null), []);
  assert.deepEqual(normalizeWorkspaceEntries({}), []);
  assert.equal(workspaceNameFromRoot('/Users/example/yalla-project/'), 'yalla-project');
  assert.equal(workspaceNameFromRoot('/'), '/');
  assert.equal(workspaceNameFromRoot(''), '');

  const list = normalizeWorkspaceEntries([
    { workspaceId: 'a', name: '', root: '/tmp/one/', createdAt: 1, updatedAt: 2 },
    { workspaceId: 'b', name: '重复目录', root: '/tmp/one', createdAt: 3, updatedAt: 3 },
    { workspaceId: 'c', root: '/tmp/two' },
    { workspaceId: '', root: '/tmp/three' },
    { workspaceId: 'd', root: '   ' },
    null,
    'nope'
  ]);
  assert.deepEqual(list.map(item => item.workspaceId), ['a', 'c']);
  assert.equal(list[0].name, 'one', '空名字用目录末段补，不空白');
  assert.equal(list[0].root, '/tmp/one', '末尾斜杠去掉，/tmp/one/ 与 /tmp/one 是同一个目录');
  assert.equal(list[1].name, 'two');
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

test('带了附件但没说做什么：按只读分析走，不再要求用户先确认', () => {
  // 真机反馈：上传一份 .md，正文只有「这个方案」，被判成待确认后原地不动。
  const routing = routeTask({
    text: '这个方案', workspaceMode: 'engineering', hasProject: true, attachmentCount: 1
  });
  assert.equal(routing.taskKind, 'engineering_analysis');
  assert.equal(routing.engineeringKind, 'analysis');
  assert.equal(routing.needsClarification, undefined);
  assert.match(routing.reason, /附了 1 个文件/);
  // 附件只把「没有动词」抬到只读分析，不会把改动词降级，也不会凭空放行实施。
  assert.equal(routeTask({ text: '这个方案', workspaceMode: 'engineering', hasProject: true, attachmentCount: 0 }).taskKind, 'clarify');
  assert.equal(
    routeTask({ text: '按这个方案修改 README.md', workspaceMode: 'engineering', hasProject: true, attachmentCount: 1 }).taskKind,
    'engineering_execution'
  );
  // 同时命中只读与改动词时仍按「不确定就问」，附件不参与化解这条冲突。
  assert.equal(
    routeTask({ text: '分析一下怎么修改这个模块', workspaceMode: 'engineering', hasProject: true, attachmentCount: 2 }).taskKind,
    'clarify'
  );
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

test('shell 之外的系统动作也判为实施（抓取 / 通知 / 列进程）', () => {
  const cases = [
    '用 web.fetch 抓取 https://example.com 并告诉我状态码',
    '发一条系统通知，标题写完成',
    '列出命令名里含 sleep 的进程'
  ];
  for (const text of cases) {
    const routing = routeTask({ text, workspaceMode: 'engineering', hasProject: true });
    assert.equal(routing.taskKind, 'engineering_execution', `应当判为实施：${text}`);
  }
});

const WORKSPACES = [
  { workspaceId: 'w-one', name: 'alpha', root: '/tmp/alpha', createdAt: 1, updatedAt: 10 },
  { workspaceId: 'w-two', name: 'beta', root: '/tmp/beta', createdAt: 2, updatedAt: 20 }
];

test('侧栏分组：先按 id，老会话再按目录，最后才落「未分组」', () => {
  const groups = groupByWorkspace(
    [
      { title: '新会话', workspaceId: 'w-one', updatedAt: 100 },
      // 升级前的会话只有 workspaceRoot，也要回到同一个目录的组。
      { title: '老会话', workspaceRoot: '/tmp/beta/', updatedAt: 90 },
      { title: '没有归属', updatedAt: 80 }
    ],
    WORKSPACES
  );
  const byName = new Map(groups.map(group => [group.name, group]));
  assert.deepEqual(byName.get('alpha')?.items.map(item => item.title), ['新会话']);
  assert.deepEqual(byName.get('beta')?.items.map(item => item.title), ['老会话']);
  assert.deepEqual(byName.get('未分组')?.items.map(item => item.title), ['没有归属']);
  // 会话多的、最近的排前面；未分组固定末尾。
  assert.equal(groups[groups.length - 1].workspaceId, '');
  assert.equal(groups[0].workspaceId, 'w-one');
});

test('侧栏分组：空工作区也列出来，未分组只在有内容时出现', () => {
  const groups = groupByWorkspace([{ title: '一个会话', workspaceId: 'w-two', updatedAt: 1 }], WORKSPACES);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.items.length), [1, 0]);
  assert.ok(!groups.some(group => group.workspaceId === ''), '没有未归属内容时不凭空造一个「未分组」');
});

test('侧栏分组：工作区被移除后，会话落到未分组而不是消失', () => {
  const groups = groupByWorkspace(
    [{ title: '挂在已删除工作区上的会话', workspaceId: 'w-gone', updatedAt: 5 }],
    WORKSPACES
  );
  const loose = groups.find(group => group.workspaceId === '');
  assert.ok(loose, '找不到工作区时必须留下一个「未分组」');
  assert.deepEqual(loose.items.map(item => item.title), ['挂在已删除工作区上的会话']);
  // 空工作区仍然保留在列表里，用户可以继续往里面放东西。
  assert.equal(groups.filter(group => group.workspaceId).length, 2);
});

// --- 工作区清单的真实落盘 ---------------------------------------------------
//
// 上面的分组是纯函数；这一组碰磁盘，因为「加了一个目录、重启还在不在」只能
// 通过真的读写一个临时目录来回答。用 mkdtemp 而不是写死路径，测试之间不共享
// 状态，也不会碰到用户的 userData。

function tempStoreFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-workspace-'));
  return path.join(dir, 'workspaces.json');
}

test('工作区清单：加目录落盘、同目录去重、重启读回', () => {
  const file = tempStoreFile();
  const store = new WorkspaceListStore(file);

  const first = store.add({ root: '/tmp/alpha' });
  assert.equal(first.created, true);
  assert.equal(first.workspace.name, 'alpha', '名字默认取目录末段');
  assert.equal(store.all().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 1, '加完必须真的写进文件');

  // 末尾斜杠不是另一个目录：同一路径第二次添加只返回原条目。
  const again = store.add({ root: '/tmp/alpha/' });
  assert.equal(again.created, false);
  assert.equal(again.workspace.workspaceId, first.workspace.workspaceId);
  assert.equal(store.all().length, 1);

  assert.throws(() => store.add({ root: 'relative/dir' }), /绝对路径/);
  assert.throws(() => store.add({ root: '   ' }), /不能为空/);

  // 重启：新建 store 从同一个文件读回，id 与名字都不变。
  const reopened = new WorkspaceListStore(file);
  assert.deepEqual(
    reopened.all().map(item => [item.workspaceId, item.name, item.root]),
    [[first.workspace.workspaceId, 'alpha', '/tmp/alpha']]
  );
});

test('工作区清单：改名拒绝空名字，移除只删分组', () => {
  const file = tempStoreFile();
  const store = new WorkspaceListStore(file);
  const { workspace } = store.add({ root: '/tmp/beta', name: '  项目乙  ' });
  assert.equal(workspace.name, '项目乙', '加的时候也去掉首尾空白');

  assert.throws(() => store.rename(workspace.workspaceId, '   '), /不能是空的/);
  assert.equal(store.get(workspace.workspaceId)?.name, '项目乙', '失败的改名不能留下半个新名字');

  assert.throws(() => store.rename('not-there', '新名字'), /已经不在了/);

  const renamed = store.rename(workspace.workspaceId, '乙项目');
  assert.equal(renamed.name, '乙项目');
  assert.equal(new WorkspaceListStore(file).get(workspace.workspaceId)?.name, '乙项目');

  const removed = store.remove(workspace.workspaceId);
  assert.equal(removed.workspaceId, workspace.workspaceId);
  assert.equal(store.all().length, 0);
  assert.equal(new WorkspaceListStore(file).all().length, 0, '移除也要落盘');
  assert.throws(() => store.remove(workspace.workspaceId), /已经不在了/);
});

test('工作区清单：坏文件退回空列表', () => {
  const file = tempStoreFile();
  fs.writeFileSync(file, '{ 这不是 json');
  assert.deepEqual(new WorkspaceListStore(file).all(), []);
  assert.equal(fs.existsSync(file), true, '读坏了不主动删用户的文件');
});
