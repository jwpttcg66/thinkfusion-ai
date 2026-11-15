import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CLI_SOURCE_KINDS,
  describeCliSoftwareSource,
  isHttpsUrl,
  normalizeCliSoftwareSource,
  validateCliCommand
} from '../out-test/shared/cli-software-source.js';
import { CliAgentSoftwareSourceSchema } from '../out-test/shared/schemas.js';
import { configureCliAgents, listCliAgents, setCliSoftwareSource } from '../out-test/main/cli-agents.js';
import { capabilityFingerprint, findCapabilityRecord, resolveHeadless } from '../out-test/main/cli-capabilities.js';

const MANUAL = { kind: 'manual', value: '' };

function tempUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cli-source-'));
  return {
    dir,
    file: path.join(dir, 'cli-agents.json'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

test('命令名只认 PATH 名字或干净绝对路径，shell 元字符一律拒绝', () => {
  assert.equal(validateCliCommand('qoder'), 'qoder');
  assert.equal(validateCliCommand('  claude  '), 'claude');
  assert.equal(validateCliCommand('/opt/homebrew/bin/qoder'), '/opt/homebrew/bin/qoder');
  for (const bad of [
    'qoder; rm -rf /',
    '$(whoami)',
    '`id`',
    'a && b',
    '../bin/q',
    'bin/q',
    '/usr/bin/../../bin/sh',
    '/usr/bin/',
    'qoder\n--evil',
    ''
  ]) {
    assert.throws(() => validateCliCommand(bad), /可执行文件|命令名|绝对路径|shell/, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('安装来源逐类校验，坏值当场报错，不静默降级为 manual', () => {
  assert.deepEqual(normalizeCliSoftwareSource(MANUAL), MANUAL);
  assert.equal(normalizeCliSoftwareSource({ kind: 'npm', value: '@qoder/cli' }).value, '@qoder/cli');
  assert.equal(normalizeCliSoftwareSource({ kind: 'brew', value: 'qoder-cli' }).kind, 'brew');
  assert.equal(
    normalizeCliSoftwareSource({ kind: 'url', value: 'https://example.com/qoder.dmg' }).value,
    'https://example.com/qoder.dmg'
  );
  assert.deepEqual(CLI_SOURCE_KINDS, ['manual', 'npm', 'brew', 'url']);
  for (const bad of [
    { kind: 'manual', value: 'qoder' },
    { kind: 'npm', value: 'bad name;rm' },
    { kind: 'brew', value: '../evil' },
    { kind: 'url', value: 'http://example.com/a' },
    { kind: 'url', value: 'https://u:p@example.com/a' },
    { kind: 'url', value: 'not-a-url' },
    { kind: 'unknown', value: '' },
    { kind: 'npm', value: 'x', endpoint: 'http://insecure.example.com' },
    { kind: 'npm', value: 'x', note: 'x'.repeat(121) }
  ]) {
    assert.throws(() => normalizeCliSoftwareSource(bad), undefined, `应拒绝：${JSON.stringify(bad)}`);
  }
  assert.equal(isHttpsUrl('https://example.com/v1'), true);
  assert.equal(isHttpsUrl('https://'), false);
});

test('软件源描述把来源、包名和端点都摆出来，没登记就直说', () => {
  assert.match(describeCliSoftwareSource(undefined), /未登记/);
  const text = describeCliSoftwareSource({
    kind: 'npm',
    value: '@qoder/cli',
    endpoint: 'https://opencode.ai/inference/go/openai/v1'
  });
  assert.match(text, /npm 包/);
  assert.match(text, /@qoder\/cli/);
  assert.match(text, /端点/);
});

test('IPC schema 只收约定字段，挡住多余参数和非法 kind', () => {
  const ok = CliAgentSoftwareSourceSchema.parse({
    id: 'qoder',
    command: 'qoder',
    softwareSource: MANUAL
  });
  assert.equal(ok.id, 'qoder');
  assert.throws(() => CliAgentSoftwareSourceSchema.parse({ id: 'qoder', softwareSource: { kind: 'curl', value: '' } }));
  assert.throws(() => CliAgentSoftwareSourceSchema.parse({ id: 'qoder', softwareSource: MANUAL, executable: '/bin/sh' }));
});

test('设置页保存的软件源会落盘，重启读回同一份；端点不写进命令', () => {
  const tmp = tempUserData();
  try {
    configureCliAgents({ userDataDir: tmp.dir });
    const list = setCliSoftwareSource({
      id: 'qoder',
      softwareSource: {
        kind: 'npm',
        value: '@qoder/cli',
        endpoint: 'https://opencode.ai/inference/go/openai/v1',
        note: 'Go 订阅'
      }
    });
    const qoder = list.find(item => item.id === 'qoder');
    assert.equal(qoder.softwareSource.kind, 'npm');
    assert.equal(qoder.softwareSource.endpoint, 'https://opencode.ai/inference/go/openai/v1');
    assert.equal(qoder.command, 'qoder', '没改命令就不该动 command');

    const stored = JSON.parse(fs.readFileSync(tmp.file, 'utf8'));
    assert.equal(stored.agents.qoder.softwareSource.value, '@qoder/cli');
    assert.equal(stored.agents.qoder.args.includes('https://'), false, '端点不能混进 argv');

    configureCliAgents({ userDataDir: tmp.dir });
    assert.equal(listCliAgents().find(item => item.id === 'qoder').softwareSource.note, 'Go 订阅');
  } finally {
    tmp.cleanup();
  }
});

test('坏掉的软件源落盘内容不会拖垮注册表，按未登记处理', () => {
  const tmp = tempUserData();
  try {
    fs.writeFileSync(
      tmp.file,
      JSON.stringify({ agents: { claude: { enabled: true, command: 'claude', softwareSource: { kind: 'oops' } } } }),
      'utf8'
    );
    configureCliAgents({ userDataDir: tmp.dir });
    const claude = listCliAgents().find(item => item.id === 'claude');
    assert.equal(claude.softwareSource, undefined);
    assert.match(describeCliSoftwareSource(claude.softwareSource), /未登记/);
  } finally {
    tmp.cleanup();
  }
});

test('绝对路径必须是本次亲手挑过的；命令找不到就拒绝保存', () => {
  const tmp = tempUserData();
  try {
    configureCliAgents({ userDataDir: tmp.dir });
    assert.throws(
      () => setCliSoftwareSource({ id: 'claude', command: '/bin/ls', softwareSource: MANUAL }),
      /文件对话框里挑过/
    );
    const list = setCliSoftwareSource({
      id: 'claude',
      command: '/bin/ls',
      softwareSource: MANUAL,
      isPicked: candidate => candidate === '/bin/ls'
    });
    assert.equal(list.find(item => item.id === 'claude').command, '/bin/ls');
    assert.throws(
      () => setCliSoftwareSource({ id: 'claude', command: 'tf-no-such-cli-9f8e7d', softwareSource: MANUAL }),
      /找不到可执行文件/
    );
    assert.throws(
      () => setCliSoftwareSource({ id: 'nope', softwareSource: MANUAL }),
      /没有这个 CLI Agent/
    );
    assert.throws(() => setCliSoftwareSource({ id: 'qoder' }), /缺少软件源配置/);
  } finally {
    tmp.cleanup();
  }
});

test('换命令名会改参数指纹，旧能力记录不再匹配 -> headless 降为 unverified', () => {
  const tmp = tempUserData();
  try {
    configureCliAgents({ userDataDir: tmp.dir });
    // 与 DEFAULTS 里 qoder 的参数一致：种子记录必须命中，才能证明「换命令名」
    // 造成的降级不是因为测试自己写错了指纹。
    const base = {
      command: 'qoder',
      args: ['-p', '{task}', '--output-format', 'json'],
      permissionArgs: ['--permission-mode', 'accept_edits'],
      interactiveArgs: []
    };
    const changed = { ...base, command: '/opt/homebrew/bin/qoder-2' };
    const fingerprint = capabilityFingerprint(base);
    assert.notEqual(capabilityFingerprint(changed), fingerprint);
    assert.ok(
      findCapabilityRecord({ cliId: 'qoder', capability: 'headless', version: '1.1.89', fingerprint }),
      '默认参数应该命中种子记录'
    );
    assert.equal(
      findCapabilityRecord({
        cliId: 'qoder',
        capability: 'headless',
        version: '1.1.89',
        fingerprint: capabilityFingerprint(changed)
      }),
      null,
      '换了命令名就不该再命中旧记录'
    );
    assert.equal(
      resolveHeadless({ ...changed, id: 'qoder', label: 'Qoder', headless: 'verified', enabled: true }, '1.1.89'),
      'unverified'
    );
  } finally {
    tmp.cleanup();
  }
});
