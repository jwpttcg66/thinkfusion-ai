/**
 * 内置插件体系的行为测试。
 *
 * 要钉住的是五件事：
 * 1. 清单——所有本地能力与所有保存能力都在同一份清单里，权限与宿主写清楚；
 * 2. 注册表——注册可逆、重复注册拒绝、未装载/被停用都明确报错；
 * 3. 宿主——83 个 Runtime 工具与 6 个主进程能力各自注册，都能真的干活
 *    （读文件、扫工程、联网搜索、导出文档、保存网页文档）；
 * 4. 开关——停用落到磁盘、同步给两个宿主、下次执行生效；
 * 5. 防回归——执行主链路不再有 switch 分派，设置页不再写「还没有插件」。
 *
 * Run with: npm run test:capabilities
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CAPABILITY_CATALOG,
  CAPABILITY_IDS,
  MAIN_CAPABILITY_IDS,
  RUNTIME_CAPABILITY_IDS,
  CapabilityRegistry,
  capabilityMeta,
  describeCapabilities,
  normalizeDisabled
} from '../out/shared/capabilities.js';
import { TOOL_NAMES } from '../out/shared/contracts.js';
import { localCapabilities } from '../out/agent/local-plugins.js';
import { mainCapabilities } from '../out-test/main/capabilities/index.js';
import { CapabilityStore } from '../out-test/main/capability-store.js';
import { disabledCapabilities, setDisabledCapabilities } from '../out-test/main/capability-state.js';

const work = mkdtempSync(join(tmpdir(), 'tf-capabilities-'));
after(() => {
  setDisabledCapabilities([]);
  rmSync(work, { recursive: true, force: true });
});

const source = rel => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// 1. 清单
// ---------------------------------------------------------------------------

test('一份清单收齐 89 个 Runtime 工具与 6 个主进程能力，合计 95，id 不重复', () => {
  assert.equal(CAPABILITY_CATALOG.length, 95);
  assert.equal(new Set(CAPABILITY_IDS).size, CAPABILITY_IDS.length);
  assert.deepEqual([...RUNTIME_CAPABILITY_IDS], [...TOOL_NAMES]);
  assert.deepEqual([...MAIN_CAPABILITY_IDS], [
    'project.scan',
    'file.attach',
    'project.read',
    'web.search.browser',
    'document.export',
    'page.save-document'
  ]);
  assert.equal(CAPABILITY_CATALOG.filter(m => m.kind === 'local').length, 89);
  assert.equal(CAPABILITY_CATALOG.filter(m => m.kind === 'network').length, 4);
  assert.equal(CAPABILITY_CATALOG.filter(m => m.kind === 'save').length, 2);
  for (const meta of CAPABILITY_CATALOG) {
    assert.ok(meta.title && meta.description, `${meta.id} 没有名字或说明`);
    assert.ok(['read-only', 'workspace-write', 'danger-full-access'].includes(meta.permission));
    assert.equal(meta.enabledByDefault, true);
  }
});

test('联网能力单独成组：两个 Runtime 工具与主进程的浏览器搜索后端', () => {
  assert.equal(capabilityMeta('web.fetch').kind, 'network');
  assert.equal(capabilityMeta('web.fetch').host, 'runtime');
  assert.equal(capabilityMeta('web.search').kind, 'network');
  assert.equal(capabilityMeta('web.search').host, 'runtime');
  const browser = capabilityMeta('web.search.browser');
  assert.equal(browser.kind, 'network');
  assert.equal(browser.host, 'main');
  assert.equal(browser.permission, 'read-only');
  assert.equal(capabilityMeta('project.scan').kind, 'local');
  assert.equal(capabilityMeta('document.export').kind, 'save');
  assert.deepEqual(
    CAPABILITY_CATALOG.filter(m => m.kind === 'network').map(m => m.id),
    ['dns.lookup', 'web.fetch', 'web.search', 'web.search.browser']
  );
});


test('权限与能力相符，不是所有插件一个档', () => {
  assert.equal(capabilityMeta('fs.readFile').permission, 'read-only');
  assert.equal(capabilityMeta('fs.search').permission, 'read-only');
  assert.equal(capabilityMeta('fs.writeFile').permission, 'workspace-write');
  assert.equal(capabilityMeta('process.kill').permission, 'danger-full-access');
  assert.equal(capabilityMeta('project.scan').permission, 'read-only');
  assert.equal(capabilityMeta('file.attach').permission, 'read-only');
  assert.equal(capabilityMeta('document.export').permission, 'workspace-write');
  assert.equal(capabilityMeta('page.save-document').permission, 'workspace-write');
  assert.equal(capabilityMeta('document.export').host, 'main');
  assert.equal(capabilityMeta('fs.readFile').host, 'runtime');
});

test('停用列表只认清单里的 id，未知项与重复项都丢掉', () => {
  assert.deepEqual(normalizeDisabled(null), []);
  assert.deepEqual(normalizeDisabled('fs.readFile'), []);
  assert.deepEqual(normalizeDisabled(['fs.readFile', 'fs.readFile', 'nope', 42]), ['fs.readFile']);
  assert.deepEqual(normalizeDisabled(['document.export', 'page.save-document']), [
    'document.export',
    'page.save-document'
  ]);
});

test('设置页视图带开关与装载状态，默认全开', () => {
  const all = describeCapabilities([]);
  assert.equal(all.length, 95);
  assert.ok(all.every(item => item.enabled && item.registered));
  const off = describeCapabilities(['document.export'], ['fs.readFile']);
  const exported = off.find(item => item.id === 'document.export');
  assert.equal(exported.enabled, false);
  assert.equal(exported.registered, false);
  assert.equal(off.find(item => item.id === 'fs.readFile').registered, true);
});

// ---------------------------------------------------------------------------
// 2. 注册表
// ---------------------------------------------------------------------------

test('注册是可逆的副作用，重复注册与清单外插件都拒绝', () => {
  const registry = new CapabilityRegistry();
  const meta = capabilityMeta('fs.list');
  const dispose = registry.register({ ...meta, run: args => ({ path: args.path }) });
  assert.equal(registry.has('fs.list'), true);
  assert.throws(() => registry.register({ ...meta, run: () => null }), /重复注册/);
  assert.throws(() => registry.register({ ...meta, id: 'not.in.catalog', run: () => null }), /不在清单/);
  dispose();
  assert.equal(registry.has('fs.list'), false);
});

test('execute 是唯一入口：未装载、被停用都明确报错，重新启用可再跑', async () => {
  const registry = new CapabilityRegistry();
  registry.register({ ...capabilityMeta('fs.list'), run: args => `listed:${args.path}` });
  assert.equal(await registry.execute('fs.list', { path: '.' }, {}), 'listed:.');
  await assert.rejects(registry.execute('fs.stat', {}, {}), /未装载/);
  registry.setDisabled(['fs.list', 'not.in.catalog']);
  await assert.rejects(registry.execute('fs.list', { path: '.' }, {}), /已停用/);
  assert.deepEqual(registry.disabledIds(), ['fs.list']);
  registry.setDisabled([]);
  assert.equal(await registry.execute('fs.list', { path: 'src' }, {}), 'listed:src');
  assert.equal(registry.unregister('fs.list'), true);
});

// ---------------------------------------------------------------------------
// 3. 两个宿主
// ---------------------------------------------------------------------------

test('Runtime 注册了全部 89 个工具，插件能真读本机目录', async () => {
  assert.deepEqual([...localCapabilities.ids()].sort(), [...TOOL_NAMES].sort());
  const root = join(work, 'runtime-project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), '# demo\n');
  const grant = {
    taskId: 'task-capabilities',
    permissionPreset: 'read-only',
    approvalPolicy: 'ask',
    rootDir: root,
    allowedTools: [...TOOL_NAMES],
    expiresAt: Date.now() + 60_000,
    maxSteps: 10,
    grantVersion: 1
  };
  const outcome = await localCapabilities.execute('fs.list', { path: '.' }, { grant });
  assert.equal(outcome.verified, true);
  assert.equal(outcome.failure, null);
  assert.ok(JSON.stringify(outcome.result).includes('README.md'));
});

test('主进程注册了工程读取、附件读取、浏览器联网搜索与两个保存插件', () => {
  assert.deepEqual([...mainCapabilities.ids()].sort(), [...MAIN_CAPABILITY_IDS].sort());
});

test('file.attach 插件按宿主注入的读盘实现执行，停用即明确报错', async () => {
  const paths = ['/tmp/不存在也行.md'];
  const context = {
    readAttachments: seen => seen.map(path => ({
      id: 'x',
      name: 'a.md',
      path,
      bytes: 3,
      addedAt: 0,
      text: 'abc',
      chars: 3,
      totalChars: 3,
      truncated: false
    }))
  };
  const list = await mainCapabilities.execute('file.attach', { paths }, context);
  assert.equal(list.length, 1);
  assert.equal(list[0].text, 'abc');
  await assert.rejects(mainCapabilities.execute('file.attach', { paths: [] }, context), /至少一个文件路径/);
  // 没注入实现的宿主必须报错，而不是「没有附件」。
  await assert.rejects(mainCapabilities.execute('file.attach', { paths }, {}), /宿主没有提供所需依赖/);

  setDisabledCapabilities(['file.attach']);
  await assert.rejects(mainCapabilities.execute('file.attach', { paths }, context), /已停用：读取附件文件/);
  setDisabledCapabilities([]);
});

test('web.search.browser 插件按宿主注入的浏览器后端执行，停用即明确报错', async () => {
  const calls = [];
  const context = {
    browserSearch: async (query, limit) => {
      calls.push({ query, limit });
      return {
        results: [{ title: '一条真实结果', url: 'https://example.com/a', snippet: '摘要', rank: 1 }],
        finalUrl: `https://cn.bing.com/search?q=${encodeURIComponent(query)}`,
        pageTitle: '搜索结果',
        emptyNote: undefined
      };
    }
  };
  const hit = await mainCapabilities.execute('web.search.browser', { query: '  ThinkFusion  ', limit: 8 }, context);
  assert.deepEqual(calls, [{ query: 'ThinkFusion', limit: 8 }]);
  assert.equal(hit.results[0].url, 'https://example.com/a');
  await assert.rejects(
    mainCapabilities.execute('web.search.browser', { query: '', limit: 8 }, context),
    /搜索词不能为空/
  );
  // 没注入实现的宿主也必须报错，不能悄悄当成「搜到 0 条」。
  await assert.rejects(
    mainCapabilities.execute('web.search.browser', { query: 'x', limit: 8 }, {}),
    /宿主没有提供所需依赖/
  );

  setDisabledCapabilities(['web.search.browser']);
  assert.equal(mainCapabilities.isEnabled('web.search.browser'), false);
  await assert.rejects(
    mainCapabilities.execute('web.search.browser', { query: 'ThinkFusion', limit: 8 }, context),
    /已停用：浏览器联网搜索/
  );
  setDisabledCapabilities([]);
  assert.equal(mainCapabilities.isEnabled('web.search.browser'), true);
});

test('project.scan 插件真读工程目录', async () => {
  const root = join(work, 'engineering-project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'stream.log'), '[INFO] CarromStream 开始\n[WARN] CarromStream 掉线\n');
  const scan = await mainCapabilities.execute('project.scan', { root, question: '统计 stream.log 里的标签' }, {});
  assert.ok(Array.isArray(scan.evidence));
  assert.ok(scan.evidence.length > 0);
  assert.ok(scan.summary && typeof scan.summary === 'string');
});

test('document.export 插件真写会话文档（默认 md）', async () => {
  const target = join(work, 'conversation.md');
  const conversation = {
    conversationId: 'conv-cap',
    title: '插件导出验收',
    intent: 'research',
    intentReason: '工程空间直接问',
    status: 'answered',
    channels: ['ollama:deepseek-r1:14b'],
    createdAt: Date.UTC(2026, 10, 8, 7, 51),
    updatedAt: Date.UTC(2026, 10, 8, 8, 5),
    workspaceMode: 'knowledge',
    executionConfig: { executionMode: 'web' }
  };
  const context = {
    exportDeps: () => ({
      conversation: () => conversation,
      messages: () => [
        {
          messageId: 'u1',
          conversationId: 'conv-cap',
          role: 'user',
          text: '这份日志有多少行？',
          at: Date.UTC(2026, 10, 8, 7, 51)
        },
        {
          messageId: 'a1',
          conversationId: 'conv-cap',
          role: 'channel',
          text: '664 行。',
          channelId: 'ollama:deepseek-r1:14b',
          at: Date.UTC(2026, 10, 8, 7, 52)
        }
      ],
      labels: () => ({ 'ollama:deepseek-r1:14b': 'deepseek-r1:14b' }),
      defaultDir: () => work,
      pickPath: async () => null
    })
  };
  const result = await mainCapabilities.execute(
    'document.export',
    { conversationId: 'conv-cap', path: target },
    context
  );
  assert.equal(result.format, 'md');
  assert.ok(existsSync(target));
  const text = readFileSync(target, 'utf8');
  assert.ok(text.includes('插件导出验收') && text.includes('664 行'));
});

test('page.save-document 插件真写网页文档（含计划）', async () => {
  const target = join(work, 'page.md');
  const context = {
    readPage: async sourceId => ({
      sourceLabel: 'ChatGPT',
      pageTitle: '迁移方案',
      url: 'https://chatgpt.com/c/demo',
      documents: ['# 迁移方案\n\n计划：\n1. 备份数据库\n2. 切流量'],
      transcript: ''
    }),
    savePageDeps: () => ({ defaultDir: () => work, pickPath: async () => null })
  };
  const result = await mainCapabilities.execute(
    'page.save-document',
    { sourceId: 'chatgpt', path: target },
    context
  );
  assert.equal(result.format, 'md');
  assert.equal(result.documents, 1);
  assert.ok(existsSync(target));
  assert.ok(readFileSync(target, 'utf8').includes('备份数据库'));
});

// ---------------------------------------------------------------------------
// 4. 开关
// ---------------------------------------------------------------------------

test('CapabilityStore 落盘、重启读回、拒绝未知 id、坏文件回退全启用', () => {
  const file = join(work, 'capabilities.json');
  const store = new CapabilityStore(file);
  assert.deepEqual(store.disabledIds(), []);
  assert.deepEqual(store.setEnabled('page.save-document', false), ['page.save-document']);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).disabled[0], 'page.save-document');
  assert.deepEqual(new CapabilityStore(file).disabledIds(), ['page.save-document']);
  assert.throws(() => store.setEnabled('not.in.catalog', false), /没有这个内置插件/);

  const broken = join(work, 'broken.json');
  writeFileSync(broken, '{ not json');
  assert.deepEqual(new CapabilityStore(broken).disabledIds(), []);
});

test('开关同步给主进程注册表，并作为 Runtime 下次执行的下发值', async () => {
  assert.deepEqual(setDisabledCapabilities(['document.export', 'unknown']), ['document.export']);
  assert.deepEqual([...disabledCapabilities()], ['document.export']);
  assert.deepEqual(mainCapabilities.disabledIds(), ['document.export']);
  await assert.rejects(
    mainCapabilities.execute('document.export', { conversationId: 'x' }, {}),
    /已停用/
  );
  // 未知 id 没有被写进开关，也不会误伤其它插件
  assert.equal(mainCapabilities.isEnabled('page.save-document'), true);
  setDisabledCapabilities([]);
  assert.deepEqual(mainCapabilities.disabledIds(), []);
});

// ---------------------------------------------------------------------------
// 5. 防回归
// ---------------------------------------------------------------------------

test('执行主链路按插件 id 分派，不再有工具 switch', () => {
  const agent = source('agent/index.ts');
  assert.ok(!agent.includes('switch (step.tool)'));
  assert.ok(agent.includes('localCapabilities.execute<LocalStepOutcome>'));
  assert.ok(agent.includes('localCapabilities.setDisabled(request.disabledCapabilities ?? [])'));
  const main = source('main/index.ts');
  assert.ok(main.includes("mainCapabilities.execute('document.export'"));
  assert.ok(main.includes("mainCapabilities.execute('page.save-document'"));
  // 独立窗口的保存选择必须作为它的子窗口出现，不能把主窗口调到前台遮住原页面。
  const detachedSaveStart = main.indexOf("ipcMain.handle('page:request-save-from-detached'");
  assert.notEqual(detachedSaveStart, -1);
  const detachedSaveEnd = main.indexOf("ipcMain.handle('page:focus-detached'", detachedSaveStart);
  const detachedSaveHandler = main.slice(detachedSaveStart, detachedSaveEnd);
  assert.match(detachedSaveHandler, /openDetachedSaveWindow\(detached\.window, detached\.sourceId, raw\)/);
  assert.doesNotMatch(detachedSaveHandler, /win\.show\(\)|win\.focus\(\)|page:save-request/);
  const saveWindow = source('main/detached-save-document.ts');
  assert.match(main, /parent,\s*modal:\s*true/);
  assert.match(main, /preload: path\.join\(__dirname, '\.\.\/preload\/detachedSave\.js'\)/);
  assert.ok(saveWindow.includes('tfDetachedSave'));
  assert.ok(saveWindow.includes('selected-items'));
  assert.ok(saveWindow.includes('selected-merge'));
  assert.ok(saveWindow.includes('all-merge'));
  assert.ok(!saveWindow.includes('innerHTML'));
  assert.ok(main.includes("ipcMain.handle('page:detached-save-preview'"));
  assert.ok(main.includes("ipcMain.handle('page:detached-save-document'"));
  assert.ok(main.includes("ipcMain.on('page:detached-save-close'"));
  assert.ok(main.includes("ipcMain.handle('page:focus-detached'"));
  assert.ok(main.includes("ipcMain.on('page:reattach-from-detached'"));
  assert.ok(main.includes("preload: path.join(__dirname, '../preload/detached.js')"));
  const detachedPreload = source('preload/detached.ts');
  assert.ok(detachedPreload.includes("ipcRenderer.invoke('page:request-save-from-detached'"));
  assert.ok(detachedPreload.includes("ipcRenderer.send('page:reattach-from-detached'"));
  const savePreload = source('preload/detached-save.ts');
  assert.ok(savePreload.includes("ipcRenderer.invoke('page:detached-save-preview'"));
  assert.ok(savePreload.includes("ipcRenderer.invoke('page:detached-save-document'"));
  assert.ok(savePreload.includes("ipcRenderer.send('page:detached-save-close'"));
  assert.ok(!main.includes('exportConversation({ ...input, format }, deps)'));
  const runner = source('main/conversation-runner.ts');
  assert.match(runner, /mainCapabilities\.execute<ProjectScan>\(\s*'project\.scan'/);
  assert.ok(!runner.includes('scanProject('));
  // 浏览器搜索那半边也不能再绕过注册表直接调实现。
  const manager = source('main/agent-manager.ts');
  assert.match(manager, /mainCapabilities\s*\.execute<BrowserSearchOutcome>\(\s*'web\.search\.browser'/);
  assert.ok(!manager.includes('void searchInBrowser('));
});

test('设置页列出真实清单，不再写着「还没有插件」', () => {
  const panel = source('renderer/src/components/SettingsPanel.tsx');
  assert.ok(!panel.includes('还没有插件'));
  assert.ok(panel.includes('getCapabilities()'));
  assert.ok(panel.includes('setCapabilityEnabled(id, enabled)'));
  assert.ok(panel.includes('capability-row'));
  assert.ok(panel.includes("'local', 'network', 'save'"));
});
