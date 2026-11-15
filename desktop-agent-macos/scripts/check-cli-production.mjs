/**
 * CLI 生产化补齐的自动化测试。
 *
 * 覆盖上一轮审核里点名、这一轮落地的六块：脱敏、审批有效参数、状态机、
 * 错误分类、版本绑定能力验证、终端审计 JSONL 与回放校验。
 *
 * 这一套只跑纯函数与本地临时目录，不启动真实 CLI、不联网；真实 CLI 的
 * opt-in 验证在 scripts/spikes/cli-real-e2e.mjs。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  containsSecret,
  describeEffective,
  effectivePermissionMode,
  redactArgv,
  redactSecrets
} from '../out-test/shared/redact.js';
import {
  deriveTerminalState,
  describeDuration,
  describeTerminalState
} from '../out-test/shared/terminal-state.js';
import { classifyCliError } from '../out-test/shared/cli-errors.js';
import { isStructuredCliSuccess, parseCliResultJson } from '../out-test/shared/cli-result.js';
import {
  environmentalBlocker as spikeBlocker,
  isStructuredSuccess as spikeSuccess,
  parseStructured as spikeParse
} from './spikes/cli-real-e2e.mjs';
import {
  capabilityFingerprint,
  configureCliCapabilities,
  listCapabilityRecords,
  normalizeVersion,
  recordCapability,
  resolveHeadless
} from '../out-test/main/cli-capabilities.js';
import { buildEffectiveExecution, expandCliArgv, resolveStepCwd } from '../out-test/agent/effective-args.js';
import {
  appendTerminalAudit,
  configureTerminalAudit,
  endTerminalAudit,
  pruneTerminalAudit,
  readTerminalAudit,
  startTerminalAudit,
  terminalAuditStatus,
  TERMINAL_AUDIT_LIMITS
} from '../out-test/agent/tools/terminal-audit.js';
import { verifyEvents } from './replay-terminal.mjs';
import { reconcileTerminalAuditFiles } from '../out-test/main/terminal-audit-reconcile.js';

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cli-prod-'));
  return dir;
}

function withAuditDir(fn) {
  const dir = tempDir();
  try {
    configureTerminalAudit(dir);
    return fn(dir);
  } finally {
    configureTerminalAudit(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. 脱敏：落盘前的硬前置
// ---------------------------------------------------------------------------

test('已知厂商 Key 前缀全部被遮掉，且留下 REDACTED 痕迹', () => {
  const input = 'oc_sk_abcdefghijklmnop / sk-ant-api03-abcdefghijklmnop / gsk_abcdefghijklmnop';
  const out = redactSecrets(input);
  assert.match(out, /\[REDACTED:KEY\]/);
  assert.doesNotMatch(out, /oc_sk_abcdefghijklmnop/);
  assert.doesNotMatch(out, /sk-ant-api03-abcdefghijklmnop/);
  assert.doesNotMatch(out, /gsk_abcdefghijklmnop/);
  assert.equal(containsSecret(input), true);
});

test('Authorization / 环境变量赋值 / URL query 只遮值不遮名', () => {
  const out = redactSecrets(
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijk\n' +
      'ANTHROPIC_API_KEY=oc_sk_abcdefghijklmnop\n' +
      'GET https://api.example.com/v1?api_key=abcdefghijklmnop&x=1'
  );
  assert.match(out, /Authorization: \[REDACTED/);
  assert.match(out, /ANTHROPIC_API_KEY=\[REDACTED/);
  assert.match(out, /api_key=\[REDACTED/);
  assert.match(out, /&x=1/, 'URL 里的其它参数不能被赋值规则一起吞掉');
  assert.doesNotMatch(out, /oc_sk_abcdefghijklmnop/);
  assert.doesNotMatch(out, /eyJhbGciOiJIUzI1NiJ9/);
});

test('私钥块整段替换，普通词不被误伤', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
  assert.match(redactSecrets(pem), /\[REDACTED:PRIVATE_KEY\]/);
  const normal = 'skill skim sk statistics and a short sk- token';
  assert.equal(redactSecrets(normal), normal, '短词不该被当作 Key 毁掉');
});

test('argv 里整项就是 Key 时完全替换，不留首尾字符', () => {
  const out = redactArgv(['--key', 'oc_sk_abcdefghijklmnop', '--model', 'x']);
  assert.equal(out[1], '[REDACTED:KEY]');
  assert.equal(out[3], 'x');
});

// ---------------------------------------------------------------------------
// 2. 审批卡：确认的是最终有效参数
// ---------------------------------------------------------------------------

test('权限模式：accept_edits 允许写但不高危，bypassPermissions 是高危', () => {
  const edit = effectivePermissionMode(['--permission-mode', 'accept_edits']);
  assert.equal(edit.mode, 'accept_edits');
  assert.equal(edit.allowsWrites, true);
  assert.equal(edit.highRisk, false);
  const bypass = effectivePermissionMode(['--permission-mode', 'bypassPermissions']);
  assert.equal(bypass.highRisk, true);
  assert.equal(bypass.allowsWrites, true);
});

test('describeEffective 把 CLI / 权限 / 工作目录 / 是否可写都列出来', () => {
  const lines = describeEffective({
    cli: 'Qoder CLI',
    permissionMode: 'accept_edits',
    allowsWrites: true,
    highRisk: false,
    cwd: '/tmp/worktree',
    argv: ['qoder', '-p', 'fix bug']
  });
  const text = lines.join('\n');
  for (const word of ['Qoder CLI', 'accept_edits', '/tmp/worktree', '允许修改文件：是', 'qoder -p fix bug']) {
    assert.ok(text.includes(word), `缺少 ${word}`);
  }
});

const qoderConfig = {
  id: 'qoder',
  label: 'Qoder CLI',
  command: '/Users/yalla/.qoder/entry/qoder',
  args: ['-p', '{task}', '--output-format', 'json'],
  interactiveArgs: [],
  permissionArgs: ['--permission-mode', 'accept_edits'],
  headless: 'verified',
  enabled: true,
  envAllowlist: []
};

test('expandCliArgv：{task} 原样替换，权限参数追加在末尾', () => {
  const argv = expandCliArgv(qoderConfig, 'fix bug with spaces');
  assert.deepEqual(argv, [
    '-p', 'fix bug with spaces', '--output-format', 'json',
    '--permission-mode', 'accept_edits'
  ]);
});

test('buildEffectiveExecution 展开真实 cwd、argv 与权限，并脱敏任务文本', () => {
  const grant = {
    taskId: 't1',
    permissionPreset: 'danger-full-access',
    approvalPolicy: 'ask',
    rootDir: '/repo',
    worktreeDir: '/repo-worktrees/t1',
    allowedTools: ['agent.exec'],
    expiresAt: Date.now() + 10000,
    maxSteps: 5
  };
  assert.equal(resolveStepCwd(grant, 'src'), '/repo-worktrees/t1/src');
  const effective = buildEffectiveExecution({
    tool: 'agent.exec',
    args: { cli: 'qoder', task: 'use oc_sk_abcdefghijklmnop to fix', cwd: 'src' },
    grant,
    cliAgents: [qoderConfig],
    risk: 'danger'
  });
  assert.equal(effective.cwd, '/repo-worktrees/t1/src');
  assert.equal(effective.permissionMode, 'accept_edits');
  assert.equal(effective.allowsWrites, true);
  assert.ok(effective.argv[0].endsWith('qoder'));
  assert.ok(!effective.argv.join(' ').includes('oc_sk_abcdefghijklmnop'), 'argv 必须已脱敏');
});

// ---------------------------------------------------------------------------
// 3. 状态机：CANCELLED 只在真的终止成功
// ---------------------------------------------------------------------------

test('状态由真实进程事件推导：启动 / 运行 / 终止中 / 正常退出', () => {
  assert.equal(deriveTerminalState({ exited: false, starting: true }), 'STARTING');
  assert.equal(deriveTerminalState({ exited: false }), 'RUNNING');
  assert.equal(deriveTerminalState({ exited: false, exiting: true }), 'EXITING');
  assert.equal(deriveTerminalState({ exited: true, exitCode: 0 }), 'EXITED');
});

test('非零退出码 / 信号 / 超时都是 FAILED，不写成已退出', () => {
  assert.equal(deriveTerminalState({ exited: true, exitCode: 1 }), 'FAILED');
  assert.equal(deriveTerminalState({ exited: true, exitCode: 0, signal: 'SIGKILL' }), 'FAILED');
  assert.equal(deriveTerminalState({ exited: true, exitCode: 0, timedOut: true }), 'FAILED');
  assert.match(describeTerminalState({ exited: true, exitCode: 1, state: 'FAILED' }), /异常退出/);
});

test('CANCELLED 表示终止成功；强杀失败保留 FAILED 与错误说明', () => {
  assert.equal(deriveTerminalState({ exited: true, exitCode: 0, cancelled: true }), 'CANCELLED');
  assert.equal(
    deriveTerminalState({ exited: true, exitCode: 0, cancelled: true, terminateFailed: true }),
    'FAILED'
  );
  assert.match(
    describeTerminalState({ exited: true, exitCode: 0, cancelled: true, terminateFailed: true, state: 'FAILED' }),
    /终止失败/
  );
});

test('时长展示：毫秒 / 秒 / 分 / 小时，负值显示破折号', () => {
  assert.equal(describeDuration(500), '500 毫秒');
  assert.equal(describeDuration(3000), '3 秒');
  assert.equal(describeDuration(65_000), '1 分 5 秒');
  assert.equal(describeDuration(3_600_000), '1 小时 0 分');
  assert.equal(describeDuration(-1), '—');
});

// ---------------------------------------------------------------------------
// 4. 错误分类：结构化优先、文本兜底带置信度
// ---------------------------------------------------------------------------

test('结构化 rate_limit 优先于 stderr 文本，标 high 置信度', () => {
  const hit = classifyCliError({
    exitCode: 1,
    parsed: { is_error: true, subtype: 'error_rate_limit' },
    stderrTail: 'ECONNREFUSED'
  });
  assert.equal(hit.kind, 'RATE_LIMITED');
  assert.equal(hit.source, 'structured');
  assert.equal(hit.confidence, 'high');
});

test('六类都能分出来：额度 / 认证 / 网络 / 超时 / 未知', () => {
  const cases = [
    [{ parsed: { is_error: true, subtype: 'quota_exceeded' }, exitCode: 1 }, 'QUOTA_EXCEEDED'],
    [{ parsed: { is_error: true, code: 401 }, exitCode: 1 }, 'AUTH_FAILED'],
    [{ exitCode: 1, stderrTail: 'ECONNREFUSED connect' }, 'NETWORK_ERROR'],
    [{ exitCode: null, timedOut: true }, 'TIMEOUT'],
    [{ exitCode: 7, stderrTail: '' }, 'UNKNOWN_ERROR']
  ];
  for (const [input, expected] of cases) {
    assert.equal(classifyCliError(input).kind, expected, JSON.stringify(input));
  }
});

test('文本兜底明确标 low 置信度并附命中片段', () => {
  const hit = classifyCliError({ exitCode: 1, stderrTail: 'HTTP 429 too many requests' });
  assert.equal(hit.kind, 'RATE_LIMITED');
  assert.equal(hit.source, 'text');
  assert.equal(hit.confidence, 'low');
  assert.match(hit.evidence, /429|too many requests/i);
});

test('结构化输出标记错误但没有错误码 -> UNKNOWN_ERROR，不猜类别', () => {
  const hit = classifyCliError({ exitCode: 1, parsed: { is_error: true, subtype: 'error' } });
  assert.equal(hit.kind, 'UNKNOWN_ERROR');
  assert.equal(hit.source, 'structured');
});

test('真机 429：错误原因在结构化 result 正文里，不能误判成 UNKNOWN_ERROR', () => {
  // 2026-11-15 Claude Code 2.1.325 + OpenCode Go 周额度耗尽的原始返回形态。
  const parsed = {
    type: 'result',
    subtype: 'error',
    is_error: true,
    terminal_reason: 'api_error',
    result: 'API Error: Request rejected (429) · OpenCode Go usage limit reached (weekly).'
  };
  const hit = classifyCliError({ exitCode: 1, parsed, stderrTail: '[claude-code:unrecognized_model]' });
  assert.equal(hit.kind, 'RATE_LIMITED');
  assert.equal(hit.source, 'structured');
  assert.equal(hit.confidence, 'medium');
  assert.match(hit.evidence, /429|usage limit/);
  // 成功结果正文里出现同样的词，不能凭空造出一个错误分类。
  const ok = classifyCliError({
    exitCode: 0,
    parsed: { is_error: false, subtype: 'success', result: 'Here is how a rate limit works: HTTP 429.' }
  });
  assert.equal(ok, null);
});

test('成功与用户取消都不返回错误分类', () => {
  assert.equal(classifyCliError({ exitCode: 0, stderrTail: '' }), null);
  assert.equal(classifyCliError({ exitCode: null, cancelled: true }), null);
});

// ---------------------------------------------------------------------------
// 5. 版本绑定能力验证
// ---------------------------------------------------------------------------

test('normalizeVersion 从 CLI 原文里取语义化版本', () => {
  assert.equal(normalizeVersion('2.1.325 (Claude Code)'), '2.1.325');
  assert.equal(normalizeVersion('1.1.89'), '1.1.89');
  assert.equal(normalizeVersion(null), '');
});

test('参数指纹随 args / permissionArgs 变化，命令改名不影响（只看 basename）', () => {
  const a = capabilityFingerprint(qoderConfig);
  assert.equal(a, capabilityFingerprint({ ...qoderConfig, command: '/other/path/qoder' }));
  assert.notEqual(a, capabilityFingerprint({ ...qoderConfig, args: ['-p', '{task}'] }));
  assert.notEqual(a, capabilityFingerprint({ ...qoderConfig, permissionArgs: ['--permission-mode', 'bypassPermissions'] }));
});

test('种子记录让实测过的版本可用；升级版本或改参数自动降级', () => {
  const dir = tempDir();
  try {
    configureCliCapabilities({ userDataDir: dir, defaults: [qoderConfig] });
    assert.equal(resolveHeadless(qoderConfig, '1.1.89'), 'verified');
    assert.equal(resolveHeadless(qoderConfig, '1.1.90'), 'unverified', '升级后必须重验');
    assert.equal(resolveHeadless(qoderConfig, '1.1.89 (Qoder)'), 'verified', '原文带后缀也要认');
    const changed = { ...qoderConfig, permissionArgs: ['--permission-mode', 'bypassPermissions'] };
    assert.equal(resolveHeadless(changed, '1.1.89'), 'unverified', '改参数只让相关能力失效');
    assert.equal(listCapabilityRecords().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recordCapability 写新版本后重新可用，并落盘可读', () => {
  const dir = tempDir();
  try {
    configureCliCapabilities({ userDataDir: dir, defaults: [qoderConfig] });
    recordCapability({
      cliId: 'qoder',
      capability: 'headless',
      version: '1.1.90 (beta)',
      fingerprint: capabilityFingerprint(qoderConfig),
      note: '真实最小任务通过'
    });
    assert.equal(resolveHeadless(qoderConfig, '1.1.90 (beta)'), 'verified');
    const file = path.join(dir, 'cli-capabilities.json');
    assert.ok(fs.existsSync(file));
    assert.match(fs.readFileSync(file, 'utf8'), /1\.1\.90/);
    // 重新初始化应读回记录，而不是又种一遍种子。
    configureCliCapabilities({ userDataDir: dir, defaults: [qoderConfig] });
    assert.equal(listCapabilityRecords().length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. 终端审计 JSONL + 回放校验
// ---------------------------------------------------------------------------

test('未配置审计目录时静默停用，不往磁盘写东西', () => {
  configureTerminalAudit(null);
  startTerminalAudit('term-none', {
    os: 'test', cwd: '/tmp', argv: [], stream: 'pty-merged', startedAt: Date.now()
  });
  assert.equal(terminalAuditStatus('term-none').enabled, false);
});

test('会话事件按 sequence 单调递增，元数据与 resize 都落盘', () => {
  withAuditDir(dir => {
    const id = 'term-audit-1';
    startTerminalAudit(id, {
      cliName: 'qoder',
      cliVersion: '1.1.89',
      os: 'darwin arm64',
      cwd: '/tmp/work',
      argv: ['qoder', '-p', 'hi'],
      permissionMode: 'accept_edits',
      stream: 'pty-merged',
      startedAt: Date.now()
    });
    appendTerminalAudit(id, { type: 'stdout', data: 'hello ' });
    appendTerminalAudit(id, { type: 'stdin', data: 'world\r' });
    appendTerminalAudit(id, { type: 'resize', cols: 100, rows: 40 });
    appendTerminalAudit(id, { type: 'stdout', data: 'done', dropped: true, droppedChars: 12 });
    endTerminalAudit(id, { exitCode: 0, state: 'EXITED', reason: '正常结束' });

    const events = readTerminalAudit(path.join(dir, `${id}.jsonl`));
    assert.equal(events.length, 7, 'session-start + 4 事件 + exit + session-end；初始 resize 由 createSession 写');
    assert.deepEqual(events.map(item => item.sequence), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(events[0].type, 'session-start');
    const meta = JSON.parse(events[0].data);
    assert.equal(meta.stream, 'pty-merged');
    assert.equal(meta.cliName, 'qoder');
    assert.equal(meta.permissionMode, 'accept_edits');
    assert.ok(events.some(item => item.type === 'resize' && item.cols === 100));
    assert.ok(events.some(item => item.dropped === true && item.droppedChars === 12));
    assert.equal(events.at(-1).type, 'session-end');
    // 这条记录里故意有一条 dropped 事件：校验器必须把它说出来，不能假装完整。
    assert.deepEqual(verifyEvents(events), ['1 条事件的正文被丢弃（dropped=true，回放不完整）']);
  });
});

test('stdout / stdin 里的 Key 在落盘前被脱敏', () => {
  withAuditDir(dir => {
    const id = 'term-redact';
    const secret = 'oc_sk_abcdefghijklmnop';
    startTerminalAudit(id, { os: 'test', cwd: '/tmp', argv: [secret], stream: 'pty-merged', startedAt: Date.now() });
    appendTerminalAudit(id, { type: 'stdout', data: `token=${secret}` });
    appendTerminalAudit(id, { type: 'stdin', data: secret });
    endTerminalAudit(id, { exitCode: 0, state: 'EXITED' });
    const raw = fs.readFileSync(path.join(dir, `${id}.jsonl`), 'utf8');
    assert.ok(!raw.includes(secret), '明文 Key 绝不能出现在 JSONL 里');
    assert.ok(raw.includes('[REDACTED'), '要留下脱敏痕迹');
  });
});

test('单文件超上限后写 audit-truncated，结构事件仍在、正文置空并标 dropped', () => {
  withAuditDir(dir => {
    const id = 'term-big';
    startTerminalAudit(id, { os: 'test', cwd: '/tmp', argv: [], stream: 'pty-merged', startedAt: Date.now() });
    appendTerminalAudit(id, { type: 'stdout', data: 'x'.repeat(TERMINAL_AUDIT_LIMITS.maxFileBytes + 10) });
    appendTerminalAudit(id, { type: 'stdout', data: 'after-limit' });
    endTerminalAudit(id, { exitCode: 0, state: 'EXITED' });
    const events = readTerminalAudit(path.join(dir, `${id}.jsonl`));
    assert.ok(events.some(item => item.type === 'audit-truncated'));
    const later = events.filter(item => item.type === 'stdout').at(-1);
    assert.equal(later.data, '');
    assert.equal(later.dropped, true);
    assert.equal(terminalAuditStatus(id).enabled, false, 'end 之后会话从内存表移除');
    assert.ok(verifyEvents(events).some(line => line.includes('超过单文件上限')));
  });
});

test('写失败标记审计不完整，并在下一次成功写入时补一条 audit-error', () => {
  withAuditDir(dir => {
    const id = 'term-write-fail';
    startTerminalAudit(id, { os: 'test', cwd: '/tmp', argv: [], stream: 'pty-merged', startedAt: Date.now() });
    const original = fs.writeSync;
    let blocked = 0;
    try {
      fs.writeSync = function (...args) {
        blocked += 1;
        if (blocked === 1) throw new Error('EIO: simulated write failure');
        return original.apply(fs, args);
      };
      appendTerminalAudit(id, { type: 'stdout', data: 'lost' });
      assert.equal(terminalAuditStatus(id).incomplete, true);
      appendTerminalAudit(id, { type: 'stdout', data: 'recovered' });
    } finally {
      fs.writeSync = original;
    }
    endTerminalAudit(id, { exitCode: 0, state: 'EXITED' });
    const events = readTerminalAudit(path.join(dir, `${id}.jsonl`));
    assert.ok(events.some(item => item.type === 'audit-error'), '补记必须落盘');
    assert.ok(verifyEvents(events).some(line => line.includes('写入失败')));
  });
});

test('过期记录按保留期清理，只删 .jsonl 不动别的文件', () => {
  withAuditDir(dir => {
    const old = path.join(dir, 'old.jsonl');
    const fresh = path.join(dir, 'fresh.jsonl');
    const keep = path.join(dir, 'notes.txt');
    fs.writeFileSync(old, '{}\n');
    fs.writeFileSync(fresh, '{}\n');
    fs.writeFileSync(keep, 'keep');
    const past = Date.now() - TERMINAL_AUDIT_LIMITS.retentionMs - 1000;
    fs.utimesSync(old, new Date(past), new Date(past));
    assert.equal(pruneTerminalAudit(), 1);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(keep), true);
  });
});

test('回放校验能抓出 sequence 乱序、缺 session-end 与半行坏数据', () => {
  const good = [
    { sequence: 1, type: 'session-start' },
    { sequence: 2, type: 'stdout', data: 'a' },
    { sequence: 3, type: 'resize', cols: 80, rows: 24 },
    { sequence: 4, type: 'session-end' }
  ];
  assert.deepEqual(verifyEvents(good), []);
  assert.ok(verifyEvents([good[0], good[2], good[1], good[3]]).some(line => line.includes('非单调')));
  assert.ok(verifyEvents(good.slice(0, 3)).some(line => line.includes('缺少 session-end')));
  assert.ok(verifyEvents(good, 2).some(line => line.includes('不是合法事件')));
});

// 2026-11-15 真机 E2E 抓到：Qoder 1.1.89 在 JSON 前打一行自定义命令警告，
// 「重新验证」原先整段 JSON.parse 会把 exit 0 的成功任务判成失败。
const QODER_WARNING_OUTPUT = [
  "Custom command '/goal' was renamed to '/goal1' because it conflicts with built-in command.",
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', duration_ms: 3801 })
].join('\n');

test('结构化结果：前面有警告行仍能解析，且不放宽成功判定', () => {
  const parsed = parseCliResultJson(QODER_WARNING_OUTPUT);
  assert.equal(parsed?.result, 'OK');
  assert.equal(isStructuredCliSuccess(parsed), true);
  assert.equal(isStructuredCliSuccess(parseCliResultJson('just a warning, no json')), false);
  // 配额 / 鉴权失败的 JSON 仍然是失败，不能因为能解析就算实测通过。
  const quota = JSON.stringify({ is_error: true, subtype: 'error', result: 'API Error: Request rejected (429)' });
  assert.equal(isStructuredCliSuccess(parseCliResultJson(quota)), false);
  assert.equal(isStructuredCliSuccess(parseCliResultJson('{"result":"   "}')), false);
});

test('结构化结果：多行只取最后一个完整 JSON 行，坏行不顶替结果', () => {
  const output = [
    '{"type":"progress","result":"half"}',
    '[claude-code:diagnostic]',
    JSON.stringify({ type: 'result', is_error: false, result: 'final' }),
    'trailing diagnostic'
  ].join('\n');
  assert.equal(parseCliResultJson(output)?.result, 'final');
  assert.equal(parseCliResultJson('{"broken":'), null);
});

test('E2E 脚本与主进程/执行器用同一套解析口径，额度阻断不被误判', () => {
  assert.deepEqual(spikeParse(QODER_WARNING_OUTPUT), parseCliResultJson(QODER_WARNING_OUTPUT));
  assert.equal(spikeSuccess(spikeParse(QODER_WARNING_OUTPUT)), true);
  const quota = JSON.stringify({ is_error: true, result: 'API Error: Request rejected (429) · OpenCode Go usage limit reached' });
  assert.equal(spikeSuccess(spikeParse(quota)), false);
  assert.match(spikeBlocker(quota), /额度|限流/);
  // 数字里带 429 不能误命中（CLI 的 JSON 里全是数字）。
  assert.equal(spikeBlocker('{"duration_ms":1429,"result":"OK"}'), null);
});

// ---------------------------------------------------------------------------
// 7. 应用退出时的审计补尾（真机抓到：Runtime 被杀，process.on('exit') 不会跑）
// ---------------------------------------------------------------------------

test('应用退出只给没有 session-end 的会话补尾，并如实标不完整', () => {
  withAuditDir(dir => {
    const live = path.join(dir, 'term-live.jsonl');
    const done = path.join(dir, 'term-done.jsonl');
    const head = (id, seq) => `${JSON.stringify({ sessionId: id, sequence: seq, timestamp: 1000 + seq, type: 'session-start' })}\n`;
    fs.writeFileSync(
      live,
      head('term-live', 1) +
        `${JSON.stringify({ sessionId: 'term-live', sequence: 2, timestamp: 1002, type: 'stdout', data: 'hi' })}\n` +
        `${JSON.stringify({ sessionId: 'term-live', sequence: 3, timestamp: 1003, type: 'stdout', data: 'still running' })}\n`
    );
    const doneRaw =
      head('term-done', 1) +
      `${JSON.stringify({ sessionId: 'term-done', sequence: 2, timestamp: 1002, type: 'exit', exitCode: 0 })}\n` +
      `${JSON.stringify({ sessionId: 'term-done', sequence: 3, timestamp: 1003, type: 'session-end', data: JSON.stringify({ auditIncomplete: false }) })}\n`;
    fs.writeFileSync(done, doneRaw);
    fs.writeFileSync(path.join(dir, 'app-exit.jsonl'), '{"type":"app-exit"}\n');

    const first = reconcileTerminalAuditFiles(dir, '应用正常退出（before-quit）', 9000);
    assert.equal(first.scanned, 2, 'app-exit.jsonl 不算会话文件');
    assert.deepEqual(first.reconciled, ['term-live']);
    assert.equal(first.skipped, 1);
    assert.equal(fs.readFileSync(done, 'utf8'), doneRaw, '已完整的文件一个字节都不能动');

    const events = readTerminalAudit(live);
    assert.deepEqual(events.map(item => item.sequence), [1, 2, 3, 4, 5]);
    assert.deepEqual(events.slice(-2).map(item => item.type), ['exit', 'session-end']);
    assert.equal(events[3].exitCode, undefined, '不能伪造退出码');
    const meta = JSON.parse(events[4].data);
    assert.equal(meta.auditIncomplete, true);
    assert.equal(meta.recoveredBy, 'main-process');
    assert.deepEqual(verifyEvents(events), ['会话收尾由主进程补记（auditIncomplete=true）：退出码/信号未知，这份记录不完整']);

    // 幂等：再退出一次不能重复补尾。
    const second = reconcileTerminalAuditFiles(dir, '应用正常退出（before-quit）', 9100);
    assert.deepEqual(second.reconciled, []);
    assert.equal(readTerminalAudit(live).length, 5);
  });
});

test('崩溃留下的半行不会被粘成一行，sequence 仍从最后一条有效事件续上', () => {
  withAuditDir(dir => {
    const file = path.join(dir, 'term-crash.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ sessionId: 'term-crash', sequence: 1, timestamp: 1001, type: 'session-start' })}\n` +
        `${JSON.stringify({ sessionId: 'term-crash', sequence: 2, timestamp: 1002, type: 'stdout', data: 'a' })}\n` +
        '{"sessionId":"term-crash","sequence":3' // 无换行的崩溃半行
    );
    const result = reconcileTerminalAuditFiles(dir, '应用正常退出', 9000);
    assert.deepEqual(result.reconciled, ['term-crash']);
    const events = readTerminalAudit(file);
    assert.deepEqual(events.map(item => item.sequence), [1, 2, 3, 4]);
    assert.deepEqual(events.slice(-2).map(item => item.type), ['exit', 'session-end']);
    // 半行如实保留，校验器明确指出「不是合法事件」。
    assert.ok(verifyEvents(events, 1).some(line => line.includes('不是合法事件')));
  });
});

test('不是会话的文件不动；目录读不到时静默返回，不挡住退出', () => {
  withAuditDir(dir => {
    const stray = path.join(dir, 'notes.jsonl');
    fs.writeFileSync(stray, '{"hello":1}\n');
    const result = reconcileTerminalAuditFiles(dir, '应用正常退出');
    assert.equal(result.scanned, 1);
    assert.deepEqual(result.reconciled, []);
    assert.equal(fs.readFileSync(stray, 'utf8'), '{"hello":1}\n');
  });
  const missing = reconcileTerminalAuditFiles(path.join(os.tmpdir(), 'tf-no-such-dir-xyz'), 'x');
  assert.deepEqual(missing.reconciled, []);
});
