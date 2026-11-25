/**
 * macOS 桌面控制：权限、过期快照、敏感动作、取消和未验证结果。
 * Helper 协议用真实二进制；点击和输入用假桥，避免动到当前桌面。
 *
 * Run with: npm run test:computer-use
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { ComputerService } from '../out/agent/computer/service.js';
import { redactComputerArgs } from '../out/agent/computer/types.js';
import { PlanSchema, READ_ONLY_TOOLS, MUTATING_TOOLS, TOOL_NAMES } from '../out/shared/contracts.js';
import { assertGrant } from '../out/agent/policy.js';
import { localCapabilities } from '../out/agent/local-plugins.js';
import { projectComputerUse, desktopActionStillOpen } from '../out/shared/computer-use-view.js';

const COMPUTER_READ = [
  'computer.capabilities', 'computer.windows', 'computer.screenshot', 'computer.ax.tree',
  'computer.ax.find', 'computer.verify', 'computer.stop'
];
const COMPUTER_WRITE = [
  'computer.click', 'computer.type', 'computer.keypress', 'computer.scroll', 'computer.drag', 'computer.focus'
];

const evidenceDir = mkdtempSync(join(tmpdir(), 'tf-computer-'));
test.after(() => rmSync(evidenceDir, { recursive: true, force: true }));

function grant(preset = 'workspace-write') {
  return {
    taskId: 'task-computer',
    permissionPreset: preset,
    approvalPolicy: 'ask',
    rootDir: evidenceDir,
    allowedTools: [...TOOL_NAMES],
    expiresAt: Date.now() + 60_000,
    maxSteps: 8,
    grantVersion: 1
  };
}

function observeResult(value = '') {
  return {
    application: { name: 'TextEdit', bundleId: 'com.apple.TextEdit' },
    screen: { width: 1200, height: 800, scaleFactor: 2 },
    windows: [{
      windowId: 'p1:0',
      title: 'Untitled',
      app: 'TextEdit',
      bundleId: 'com.apple.TextEdit',
      frame: { x: 10, y: 20, width: 400, height: 300 }
    }],
    tree: {
      id: 'p1',
      role: 'AXApplication',
      children: [{
        id: 'p1.0',
        role: 'AXTextArea',
        title: 'body',
        value,
        frame: { x: 20, y: 40, width: 200, height: 80 }
      }, {
        id: 'p1.1',
        role: 'AXButton',
        title: '删除',
        frame: { x: 20, y: 140, width: 60, height: 24 }
      }]
    }
  };
}

function fakeBridge() {
  const calls = [];
  let front = 'com.apple.TextEdit';
  let value = '';
  return {
    calls,
    setFront(bundleId) { front = bundleId; },
    async available() { return { ok: true }; },
    async call(command, payload) {
      calls.push({ command, payload });
      if (command === 'capabilities') return { platform: 'darwin', trusted: true, commands: ['observe', 'press'] };
      if (command === 'frontmostApplication') return { name: 'TextEdit', bundleId: front };
      if (command === 'observe') return observeResult(value);
      if (command === 'setValue') {
        value = String(payload.text ?? '');
        return { method: 'ax' };
      }
      if (command === 'press' || command === 'keypress' || command === 'scroll' || command === 'drag' || command === 'focus') {
        return { method: payload.elementId ? 'ax' : 'coordinate' };
      }
      throw new Error(`unexpected ${command}`);
    }
  };
}

function service(bridge, now = () => 1_000) {
  return new ComputerService({
    bridge,
    now,
    platform: 'darwin',
    evidenceDir,
    capture: async () => ({ path: join(evidenceDir, 'shot.png'), bytes: 8, width: 10, height: 10, sha256: 'abc' })
  });
}

async function codeOf(fn) {
  try {
    await fn();
  } catch (error) {
    return error.code;
  }
  return undefined;
}

test('只读不能点击，而且不会把点击送进桥', async () => {
  const bridge = fakeBridge();
  const code = await codeOf(() => service(bridge).click(grant('read-only'), {
    snapshotId: 'snap_missing',
    bundleId: 'com.apple.TextEdit',
    elementId: 'p1.0'
  }));
  assert.equal(code, 'PERMISSION_REQUIRED');
  assert.equal(bridge.calls.some(call => call.command === 'press'), false);
});

test('计划里还没有的快照号，会改用刚观察到的控件', async () => {
  const bridge = fakeBridge();
  const desktop = service(bridge);
  const seen = await desktop.tree(grant(), {});
  const found = await desktop.find(grant(), { snapshotId: 'not-issued-yet', role: 'AXTextArea' });
  assert.equal(found.element.elementId, 'p1.0');
  assert.equal(found.snapshotId, seen.snapshotId);
  const typed = await desktop.typeText(grant(), {
    snapshotId: 'also-not-issued',
    bundleId: 'com.apple.TextEdit',
    elementId: 'text-area',
    text: 'tf-live-window',
    expect: { textIncludes: 'tf-live-window', role: 'AXTextArea' }
  });
  assert.equal(typed.verified, true);
  assert.equal(bridge.calls.filter(call => call.command === 'setValue').at(-1).payload.elementId, 'p1.0');
});

test('计划里的占位控件号会改点唯一的文本框', async () => {
  const bridge = fakeBridge();
  const desktop = service(bridge);
  await desktop.tree(grant(), {});
  const clicked = await desktop.click(grant(), {
    snapshotId: 'snap_placeholder',
    bundleId: 'com.apple.TextEdit',
    elementId: '{{elementId}}'
  });
  assert.equal(clicked.code, 'NOT_VERIFIED');
  assert.equal(bridge.calls.filter(call => call.command === 'press').at(-1).payload.elementId, 'p1.0');
  const typed = await desktop.typeText(grant(), {
    snapshotId: '<step-5 返回的 snapshotId>',
    bundleId: 'com.apple.TextEdit',
    elementId: '<step-6 返回的文本区 elementId>',
    text: 'hello',
    expect: { textIncludes: 'hello' }
  });
  assert.equal(typed.verified, true);
  assert.equal(bridge.calls.filter(call => call.command === 'setValue').at(-1).payload.elementId, 'p1.0');
});

test('还没观察过就点击时，先观察，只点刚看到的控件', async () => {
  const bridge = fakeBridge();
  const clicked = await service(bridge).click(grant(), {
    snapshotId: 'snap_missing',
    bundleId: 'com.apple.TextEdit',
    elementId: 'p1.0'
  });
  assert.equal(clicked.code, 'NOT_VERIFIED');
  const press = bridge.calls.find(call => call.command === 'press');
  assert.equal(press.payload.elementId, 'p1.0');
  assert.ok(bridge.calls.findIndex(call => call.command === 'observe') < bridge.calls.findIndex(call => call.command === 'press'));
});

test('点击指定控件，没有预期时明确未验证', async () => {
  const bridge = fakeBridge();
  const desktop = service(bridge);
  const seen = await desktop.tree(grant(), {});
  assert.equal(existsSync(seen.accessibilityTreeRef), true);
  const clicked = await desktop.click(grant(), {
    snapshotId: seen.snapshotId,
    bundleId: 'com.apple.TextEdit',
    elementId: 'p1.0'
  });
  assert.equal(clicked.verified, false);
  assert.equal(clicked.code, 'NOT_VERIFIED');
  assert.equal(clicked.verification.reason, '没有可核对的预期');
  assert.equal(bridge.calls.filter(call => call.command === 'press').length, 1);
  assert.equal(bridge.calls.find(call => call.command === 'press').payload.elementId, 'p1.0');
});

test('前台应用变了就拒绝，不再点击', async () => {
  const bridge = fakeBridge();
  const desktop = service(bridge);
  const seen = await desktop.tree(grant(), {});
  bridge.setFront('com.apple.Notes');
  const code = await codeOf(() => desktop.click(grant(), {
    snapshotId: seen.snapshotId,
    bundleId: 'com.apple.TextEdit',
    elementId: 'p1.0'
  }));
  assert.equal(code, 'WINDOW_CHANGED');
  assert.equal(bridge.calls.some(call => call.command === 'press'), false);
});

test('过期快照和窗口外坐标都不能用', async () => {
  let now = 1_000;
  const bridge = fakeBridge();
  const desktop = service(bridge, () => now);
  const seen = await desktop.tree(grant(), {});
  now += 20_000;
  assert.equal(await codeOf(() => desktop.click(grant(), {
    snapshotId: seen.snapshotId,
    bundleId: 'com.apple.TextEdit',
    x: 30,
    y: 50
  })), 'SNAPSHOT_EXPIRED');
  now = 1_000;
  const fresh = await desktop.tree(grant(), {});
  assert.equal(await codeOf(() => desktop.click(grant(), {
    snapshotId: fresh.snapshotId,
    bundleId: 'com.apple.TextEdit',
    x: 2,
    y: 2
  })), 'SNAPSHOT_EXPIRED');
  assert.equal(bridge.calls.some(call => call.command === 'press'), false);
});

test('过期快照不能拿来点坐标，输入会重新观察文本框', async () => {
  const bridge = fakeBridge();
  let now = 1_000;
  const desktop = service(bridge, () => now);
  const seen = await desktop.tree(grant(), {});
  now += 20_000;
  const typed = await desktop.typeText(grant(), {
    snapshotId: seen.snapshotId,
    bundleId: 'com.apple.TextEdit',
    elementId: 'p1.0',
    text: 'again',
    expect: { textIncludes: 'again', role: 'AXTextArea' }
  });
  assert.equal(typed.verified, true);
  assert.equal(bridge.calls.filter(call => call.command === 'setValue').at(-1).payload.elementId, 'p1.0');
});

test('只观察过桌面时，输入要求还没完成', () => {
  assert.equal(desktopActionStillOpen('输入这段文字', [
    { tool: 'computer.ax.tree', status: 'completed' }
  ]), true);
  assert.equal(desktopActionStillOpen('输入这段文字', [
    { tool: 'computer.ax.tree', status: 'completed' },
    { tool: 'computer.type', status: 'completed' }
  ]), false);
  assert.equal(desktopActionStillOpen('工作区根目录下有哪些文件名？', [
    { tool: 'computer.ax.tree', status: 'completed' }
  ]), false);
});

test('删除按钮没有 confirmRisk 时不点击', async () => {
  const bridge = fakeBridge();
  const desktop = service(bridge);
  const seen = await desktop.tree(grant(), {});
  const code = await codeOf(() => desktop.click(grant(), {
    snapshotId: seen.snapshotId,
    bundleId: 'com.apple.TextEdit',
    elementId: 'p1.1'
  }));
  assert.equal(code, 'RISK_CONFIRMATION_REQUIRED');
  assert.equal(bridge.calls.some(call => call.command === 'press'), false);
  const clicked = await desktop.click(grant(), {
    snapshotId: seen.snapshotId,
    bundleId: 'com.apple.TextEdit',
    elementId: 'p1.1',
    confirmRisk: true
  });
  assert.equal(clicked.code, 'NOT_VERIFIED');
  assert.equal(bridge.calls.filter(call => call.command === 'press').length, 1);
});

test('输入后按预期重新观察，密钥不进结果', async () => {
  const bridge = fakeBridge();
  const desktop = service(bridge);
  const seen = await desktop.tree(grant(), {});
  const secret = 'sk-proj-' + 'a'.repeat(24);
  const typed = await desktop.typeText(grant(), {
    snapshotId: seen.snapshotId,
    bundleId: 'com.apple.TextEdit',
    elementId: 'p1.0',
    text: secret,
    expect: { textIncludes: secret }
  });
  assert.equal(typed.verified, true);
  assert.equal(JSON.stringify(typed).includes(secret), false);
  assert.match(typed.textSummary, /已隐藏/);
  const redacted = redactComputerArgs({ text: secret, bundleId: 'com.apple.TextEdit' });
  assert.equal(JSON.stringify(redacted).includes(secret), false);
  assert.equal(redacted.bundleId, 'com.apple.TextEdit');
});

test('停止之后不能再输入', async () => {
  const bridge = fakeBridge();
  const desktop = service(bridge);
  const seen = await desktop.tree(grant(), {});
  const stopped = await desktop.stop(grant(), {});
  assert.equal(stopped.verified, true);
  assert.equal(stopped.events[0].type, 'computer.action.cancelled');
  assert.equal(await codeOf(() => desktop.typeText(grant(), {
    snapshotId: seen.snapshotId,
    bundleId: 'com.apple.TextEdit',
    elementId: 'p1.0',
    text: 'hello'
  })), 'CANCELLED');
  assert.equal(bridge.calls.some(call => call.command === 'setValue'), false);
});

test('核对失败不会被标成已验证', async () => {
  const bridge = fakeBridge();
  const desktop = service(bridge);
  const checked = await desktop.verify(grant(), { expect: { textIncludes: 'missing-text' } });
  assert.equal(checked.verified, false);
  assert.equal(checked.code, 'NOT_VERIFIED');
  const found = await desktop.verify(grant(), { expect: { role: 'AXTextArea', title: 'body' } });
  assert.equal(found.verified, true);
});

test('非 macOS 明确降级，缺 helper 不报成功', async () => {
  const bridge = fakeBridge();
  const linux = new ComputerService({ bridge, platform: 'linux', evidenceDir });
  const degraded = await linux.capabilities(grant(), {});
  assert.equal(degraded.supported, false);
  assert.equal(degraded.code, 'UNSUPPORTED_PLATFORM');
  assert.equal(await codeOf(() => linux.click(grant(), {
    snapshotId: 'snap_x',
    bundleId: 'com.apple.TextEdit',
    elementId: 'p1.0'
  })), 'UNSUPPORTED_PLATFORM');

  const missing = new ComputerService({
    platform: 'darwin',
    evidenceDir,
    bridge: {
      async available() { return { ok: false, code: 'HELPER_MISSING' }; },
      async call() { throw new Error('should not be called'); }
    }
  });
  const status = await missing.capabilities(grant(), {});
  assert.equal(status.available, false);
  assert.equal(status.code, 'HELPER_MISSING');
  assert.equal(status.verified, true);
});

test('工具都进了契约、权限分区和注册表', () => {
  for (const id of [...COMPUTER_READ, ...COMPUTER_WRITE]) {
    assert.equal(TOOL_NAMES.includes(id), true, id);
    assert.equal(localCapabilities.has(id), true, id);
  }
  for (const id of COMPUTER_READ) assert.equal(READ_ONLY_TOOLS.includes(id), true, id);
  for (const id of COMPUTER_WRITE) {
    assert.equal(MUTATING_TOOLS.includes(id), true, id);
    assert.equal(READ_ONLY_TOOLS.includes(id), false, id);
  }
  assert.throws(() => assertGrant(grant('read-only'), 'computer.click', 1), /仅可查看/);
  const protocol = readFileSync(new URL('../src/shared/protocol.ts', import.meta.url), 'utf8');
  for (const id of [...COMPUTER_READ, ...COMPUTER_WRITE]) {
    assert.equal(protocol.includes(`- ${id}:`), true, id);
  }
});

test('计划能表达点击，但不能省掉目标', () => {
  const base = {
    protocol: 'desktop-agent/v1',
    type: 'plan',
    taskId: 'task-computer',
    roundId: 'round-1',
    title: '看 TextEdit',
    description: '',
    steps: [],
    completion: { condition: '重新观察到文本' }
  };
  const parsed = PlanSchema.parse({
    ...base,
    steps: [{
      id: 'step-1',
      tool: 'computer.click',
      args: { snapshotId: 'snap_1234', bundleId: 'com.apple.TextEdit', elementId: 'p1.0' }
    }]
  });
  assert.equal(parsed.steps[0].tool, 'computer.click');
  assert.throws(() => PlanSchema.parse({
    ...base,
    steps: [{
      id: 'step-1',
      tool: 'computer.click',
      args: { snapshotId: 'snap_1234', bundleId: 'com.apple.TextEdit' }
    }]
  }));
});

test('活动流投影只使用真实结果，没有桌面事件时不出现面板', () => {
  assert.equal(projectComputerUse([{ payload: { type: 'step.completed', tool: 'fs.readFile' } }]), null);
  const view = projectComputerUse([{
    occurredAt: 10,
    payload: {
      type: 'step.completed',
      tool: 'computer.ax.tree',
      result: {
        appName: 'TextEdit',
        bundleId: 'com.apple.TextEdit',
        windowId: 'p1:0',
        summary: '读到 2 个控件',
        verified: true,
        permissionDecision: 'read-only:tree',
        snapshotId: 'snap_1234',
        events: [{ type: 'computer.snapshot.created', timestamp: 10 }]
      }
    }
  }]);
  assert.equal(view.appName, 'TextEdit');
  assert.equal(view.verified, true);
  assert.deepEqual(view.events.map(item => item.type), ['computer.snapshot.created']);
  assert.equal(view.stopped, false);
});

test('AX helper 拒绝未知命令，并报告能力或权限', () => {
  const bin = join(process.cwd(), 'resources/ax-bridge');
  assert.equal(existsSync(bin), true);
  const unknown = spawnSync(bin, [], { input: '{"command":"not-a-command"}\n', encoding: 'utf8', timeout: 8_000 });
  const unknownBody = JSON.parse(unknown.stdout.trim().split('\n')[0]);
  assert.equal(unknownBody.ok, false);
  assert.equal(unknownBody.code, 'UNSUPPORTED_ACTION');

  const caps = spawnSync(bin, [], { input: '{"command":"capabilities"}\n', encoding: 'utf8', timeout: 8_000 });
  const capsBody = JSON.parse(caps.stdout.trim().split('\n')[0]);
  assert.equal(capsBody.ok, true);
  assert.equal(capsBody.result.platform, 'darwin');
  assert.equal(typeof capsBody.result.trusted, 'boolean');
  assert.equal(capsBody.result.commands.includes('press'), true);
  assert.equal(capsBody.result.commands.includes('setValue'), true);

  const front = spawnSync(bin, [], { input: '{"command":"frontmostApplication"}\n', encoding: 'utf8', timeout: 8_000 });
  const frontBody = JSON.parse(front.stdout.trim().split('\n')[0]);
  if (frontBody.ok) {
    assert.equal(frontBody.result === null || typeof frontBody.result.name === 'string', true);
  } else {
    assert.equal(frontBody.code, 'PERMISSION_REQUIRED');
  }
});
