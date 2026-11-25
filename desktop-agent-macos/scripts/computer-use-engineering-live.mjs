/**
 * 工程侧真机核对：13 个 computer.* 能力各跑一遍真实桌面。
 * 不走模型计划。只动 TextEdit；结束前清空并停止会话。
 *
 *   npm run test:computer-use:live
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ComputerService } from '../out/agent/computer/service.js';
import { MacComputerBridge } from '../out/agent/computer/bridge.js';
import { TOOL_NAMES } from '../out/shared/contracts.js';

const REQUIRED = [
  'computer.capabilities',
  'computer.windows',
  'computer.screenshot',
  'computer.ax.tree',
  'computer.ax.find',
  'computer.click',
  'computer.type',
  'computer.keypress',
  'computer.scroll',
  'computer.drag',
  'computer.focus',
  'computer.verify',
  'computer.stop'
];

const MARKER = process.env.LIVE_MARKER ?? `tf-eng-${Date.now().toString(36)}`;
const REPORT = process.env.LIVE_REPORT ?? path.join(os.tmpdir(), 'tf-computer-use-engineering-live.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-eng-computer-'));
const evidenceDir = path.join(root, 'evidence');
fs.mkdirSync(evidenceDir, { recursive: true });
const BUNDLE = 'com.apple.TextEdit';

const grant = {
  taskId: 'task-computer-engineering-live',
  permissionPreset: 'workspace-write',
  approvalPolicy: 'ask',
  rootDir: root,
  allowedTools: [...TOOL_NAMES],
  expiresAt: Date.now() + 10 * 60_000,
  maxSteps: 40,
  grantVersion: 1
};

function ax(payload) {
  const helper = path.join(process.cwd(), 'resources/ax-bridge');
  const run = spawnSync(helper, [], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: 'utf8',
    timeout: 12000
  });
  const line = (run.stdout ?? '').trim().split('\n').filter(Boolean).at(-1);
  if (!line) throw new Error(run.stderr || 'helper 没有输出');
  return JSON.parse(line);
}

function walk(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  acc.push(node);
  for (const child of node.children ?? []) walk(child, acc);
  return acc;
}

function note(report, tool, detail) {
  report.tools[tool] = { ok: true, ...detail };
  report.order.push(tool);
  console.log(`OK  ${tool}${detail.summary ? ` — ${detail.summary}` : ''}`);
}

function assertActed(result, label) {
  const bad = new Set([
    'PERMISSION_REQUIRED', 'TARGET_UNCERTAIN', 'SNAPSHOT_EXPIRED', 'WINDOW_CHANGED',
    'CANCELLED', 'HELPER_FAILED', 'HELPER_MISSING', 'UNSUPPORTED_ACTION',
    'UNSUPPORTED_PLATFORM', 'TIMEOUT', 'INPUT_TOO_LARGE', 'RISK_CONFIRMATION_REQUIRED'
  ]);
  assert.ok(result, `${label} 没有结果`);
  assert.ok(!bad.has(result.code), `${label} 失败：${result.code} ${result.summary ?? ''}`);
}

function roleCounts(tree) {
  return walk(tree).reduce((acc, node) => {
    const role = node.role || '?';
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});
}

const report = {
  marker: MARKER,
  startedAt: new Date().toISOString(),
  required: REQUIRED,
  order: [],
  tools: {}
};

const front = ax({ command: 'frontmostApplication' });
report.frontmost = front.result ?? null;
if (front.result?.bundleId === 'com.apple.loginwindow' || front.result == null) {
  // 仍可核对与前台无关的能力；UI 操作需要桌面未锁屏。
  report.sessionLocked = true;
}

const blank = path.join(os.tmpdir(), 'tf-computer-use-blank.txt');
fs.writeFileSync(blank, '');
spawnSync('open', ['-a', 'TextEdit', blank]);
await new Promise(resolve => setTimeout(resolve, 1200));
ax({ command: 'focus', bundleId: BUNDLE });

let probe = ax({ command: 'observe', bundleId: BUNDLE, maxDepth: 6 });
assert.equal(probe.ok, true, `observe 失败：${JSON.stringify(probe)}`);
let fields = walk(probe.result?.tree).filter(node =>
  node.role === 'AXTextArea' || node.role === 'AXTextField'
);
for (const field of fields.filter(item => item.value)) {
  ax({
    command: 'setValue',
    elementId: field.id,
    text: '',
    expectedRole: field.role,
    bundleId: BUNDLE
  });
}
probe = ax({ command: 'observe', bundleId: BUNDLE, maxDepth: 6 });
fields = walk(probe.result?.tree).filter(node =>
  node.role === 'AXTextArea' || node.role === 'AXTextField'
);
const target = fields.find(node => !node.value) ?? fields[0];
if (!target?.id) {
  report.ok = false;
  report.blocked = 'TextEdit 控件树没有文本框（常见原因：桌面被 loginwindow 占住，应用未真正前台）';
  report.roles = roleCounts(probe.result?.tree);
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.error(`BLOCKED ${report.blocked}`);
  console.error(`frontmost=${JSON.stringify(report.frontmost)} report=${REPORT}`);
  process.exit(2);
}
if (target.value) {
  ax({
    command: 'setValue',
    elementId: target.id,
    text: '',
    expectedRole: target.role,
    bundleId: BUNDLE
  });
}

const desktop = new ComputerService({
  bridge: new MacComputerBridge(),
  evidenceDir,
  platform: 'darwin'
});

const caps = await desktop.capabilities(grant);
assert.equal(caps.available, true, caps.summary);
note(report, 'computer.capabilities', { summary: caps.summary, trusted: caps.trusted });

const windows = await desktop.windows(grant, { maxEntries: 20 });
assert.ok(Array.isArray(windows.windows) && windows.windows.length > 0, windows.summary);
note(report, 'computer.windows', { summary: windows.summary, count: windows.windows.length });

const shot = await desktop.screenshot(grant, {});
assert.ok(shot.screenshotRef && fs.existsSync(shot.screenshotRef), '截图文件不存在');
note(report, 'computer.screenshot', { summary: shot.summary, path: shot.screenshotRef });

const focused = await desktop.focus(grant, {
  snapshotId: shot.snapshotId,
  bundleId: BUNDLE,
  windowId: shot.windowId
});
assertActed(focused, 'computer.focus');
note(report, 'computer.focus', { summary: focused.summary, verified: focused.verified, code: focused.code });

const tree = await desktop.tree(grant, { bundleId: BUNDLE, maxDepth: 6 });
assert.equal(tree.bundleId, BUNDLE);
assert.ok((tree.elements?.length ?? 0) > 0, tree.summary);
note(report, 'computer.ax.tree', {
  summary: tree.summary,
  snapshotId: tree.snapshotId,
  elements: tree.elements.length
});

const found = await desktop.find(grant, {
  snapshotId: tree.snapshotId,
  role: target.role || 'AXTextArea',
  bundleId: BUNDLE
});
assert.equal(found.found, true, found.summary);
const elementId = found.element.elementId;
const frame = found.element.frame || target.frame;
assert.ok(frame && frame.width > 0 && frame.height > 0, '文本框没有 frame');
note(report, 'computer.ax.find', { summary: found.summary, elementId });

const clicked = await desktop.click(grant, {
  snapshotId: tree.snapshotId,
  bundleId: BUNDLE,
  elementId,
  expect: { role: target.role || 'AXTextArea' }
});
assertActed(clicked, 'computer.click');
note(report, 'computer.click', { summary: clicked.summary, verified: clicked.verified, code: clicked.code });

const typed = await desktop.typeText(grant, {
  snapshotId: clicked.snapshotId ?? tree.snapshotId,
  bundleId: BUNDLE,
  elementId,
  text: MARKER,
  expect: { textIncludes: MARKER, role: target.role || 'AXTextArea' }
});
assert.equal(typed.verified, true, typed.verification?.reason ?? typed.summary);
note(report, 'computer.type', { summary: typed.summary, verified: true });

const verified = await desktop.verify(grant, {
  bundleId: BUNDLE,
  expect: { textIncludes: MARKER, role: target.role || 'AXTextArea' }
});
assert.equal(verified.verified, true, verified.verification?.reason);
note(report, 'computer.verify', { summary: verified.summary, verified: true });

const keyed = await desktop.keypress(grant, {
  snapshotId: verified.snapshotId,
  bundleId: BUNDLE,
  elementId,
  key: 'right'
});
assertActed(keyed, 'computer.keypress');
note(report, 'computer.keypress', { summary: keyed.summary, code: keyed.code });

const centerX = frame.x + Math.min(40, frame.width / 2);
const centerY = frame.y + Math.min(20, frame.height / 2);
const scrolled = await desktop.scroll(grant, {
  snapshotId: keyed.snapshotId ?? verified.snapshotId,
  bundleId: BUNDLE,
  elementId,
  x: centerX,
  y: centerY,
  deltaY: -40
});
assertActed(scrolled, 'computer.scroll');
note(report, 'computer.scroll', { summary: scrolled.summary, code: scrolled.code });

const fromX = frame.x + 8;
const fromY = frame.y + 8;
const toX = Math.min(frame.x + frame.width - 8, fromX + 24);
const toY = Math.min(frame.y + frame.height - 8, fromY + 8);
const dragged = await desktop.drag(grant, {
  snapshotId: scrolled.snapshotId ?? verified.snapshotId,
  bundleId: BUNDLE,
  fromX,
  fromY,
  toX,
  toY
});
assertActed(dragged, 'computer.drag');
note(report, 'computer.drag', { summary: dragged.summary, code: dragged.code });

ax({
  command: 'setValue',
  elementId,
  text: '',
  expectedRole: target.role || 'AXTextArea',
  bundleId: BUNDLE
});
const after = ax({ command: 'observe', bundleId: BUNDLE, maxDepth: 6 });
const still = walk(after.result?.tree).some(node => String(node.value ?? '').includes(MARKER));
assert.equal(still, false, '清空后仍能看到标记');
report.cleared = true;

const stopped = await desktop.stop(grant);
assert.equal(stopped.verified, true);
note(report, 'computer.stop', { summary: stopped.summary });

const cancelled = await desktop.typeText(grant, {
  snapshotId: verified.snapshotId,
  bundleId: BUNDLE,
  elementId,
  text: 'should-not-type'
}).then(() => null).catch(error => error);
assert.equal(cancelled?.code, 'CANCELLED', 'stop 之后应拒绝再输入');
report.stopBlocksLaterType = true;

const missing = REQUIRED.filter(id => !report.tools[id]?.ok);
report.finishedAt = new Date().toISOString();
report.ok = missing.length === 0;
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  ok: report.ok,
  covered: report.order.length,
  required: REQUIRED.length,
  missing,
  marker: MARKER,
  cleared: true,
  report: REPORT
}, null, 2));
assert.equal(missing.length, 0, `未覆盖：${missing.join(', ')}`);
