/**
 * CLI 能力验证记录：把「实测过」绑定到**具体版本 + 具体参数 + 具体系统**。
 *
 * 原来的问题：`DEFAULTS` 里写死 `headless: 'verified'`，注释里记着实测版本，
 * 但代码从不检查版本。CLI 自动升级后参数可能漂移，应用却继续按「已验证」
 * 启动；`refreshCliAgentVersions()` 也只是一个没人调用的空函数。
 *
 * 现在的规则：
 *
 * - 一条记录 = `(cliId, capability, version, os, fingerprint)`，附验证时间与结果；
 * - `fingerprint` 覆盖 args / permissionArgs / interactiveArgs / 可执行文件；
 *   改任何一个参数都只让**相关能力**失效，不清零全部能力；
 * - 版本用语义化主串比较（Claude 输出 `2.1.325 (Claude Code)`，Qoder 输出
 *   `1.1.89`，显示保留原文，比较只取 `x.y.z`）；
 * - 找不到匹配记录就是 `unverified`，`agent.exec` 会明确拒绝启动。
 *
 * 首次运行会种入 2026-11-15 Spike 的两条记录（见 docs/CLI_AGENTS.md §5），
 * 保证当时已实测通过的本机版本继续可用，但不是「永远 verified」。
 * 升级后要么重新跑真实 CLI 验证脚本写新记录，要么如实降级。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CliAgentConfig, CliHeadlessSupport } from '../shared/cli-agents';

export type CliCapabilityName = 'headless';

export interface CapabilityRecord {
  cliId: string;
  capability: CliCapabilityName;
  /** 语义化版本主串，例如 2.1.325；显示用原文，比较用这个。 */
  version: string;
  /** `${platform} ${arch}`，例如 darwin arm64。 */
  os: string;
  /** 启动参数指纹；改参数就换指纹。 */
  fingerprint: string;
  verifiedAt: number;
  result: 'pass';
  /** 实测方式/说明，给审计看。 */
  note: string;
}

interface StoreFile {
  records?: CapabilityRecord[];
}

/** Spike 实测当天的版本；源码注释与 docs/CLI_AGENTS.md §5 一致。 */
const SEED_VERSIONS: Record<string, string> = {
  qoder: '1.1.89',
  claude: '2.1.325'
};
const SEED_NOTE = '2026-11-15 Spike：-p + --output-format json 最小任务与写文件任务均 exit 0';

let storeFile: string | null = null;
let records: CapabilityRecord[] = [];

/** 显示保留原文，比较只取第一个 x.y.z；取不到就退回 trim 的原文。 */
export function normalizeVersion(raw: string | null | undefined): string {
  if (!raw) return '';
  const match = raw.trim().match(/\b(\d+\.\d+\.\d+(?:[.-][0-9A-Za-z]+)?)\b/);
  return match ? match[1] : raw.trim();
}

export function systemTag(): string {
  return `${os.platform()} ${os.arch()}`;
}

export function capabilityFingerprint(config: Pick<CliAgentConfig, 'command' | 'args' | 'permissionArgs' | 'interactiveArgs'>): string {
  const payload = JSON.stringify({
    command: path.basename(config.command),
    args: config.args,
    permissionArgs: config.permissionArgs ?? [],
    interactiveArgs: config.interactiveArgs ?? []
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function load(): CapabilityRecord[] {
  if (!storeFile) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8')) as StoreFile;
    return Array.isArray(parsed.records) ? parsed.records.filter(item => item && typeof item.cliId === 'string') : [];
  } catch {
    return [];
  }
}

function save(): void {
  if (!storeFile) return;
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, `${JSON.stringify({ records }, null, 2)}\n`, 'utf8');
}

/**
 * 初始化。文件不存在时按 Spike 结果种入记录；文件已存在（哪怕内容损坏）
 * 也不覆盖——用户重新验证过的结论比内置种子可信。
 */
export function configureCliCapabilities(input: {
  userDataDir: string;
  defaults: readonly CliAgentConfig[];
}): void {
  storeFile = path.join(input.userDataDir, 'cli-capabilities.json');
  const exists = fs.existsSync(storeFile);
  records = exists ? load() : [];
  if (exists) return;
  const at = Date.now();
  for (const config of input.defaults) {
    const version = SEED_VERSIONS[config.id];
    if (!version || config.headless !== 'verified') continue;
    records.push({
      cliId: config.id,
      capability: 'headless',
      version,
      os: systemTag(),
      fingerprint: capabilityFingerprint(config),
      verifiedAt: at,
      result: 'pass',
      note: SEED_NOTE
    });
  }
  save();
}

/** 查一条仍然有效的验证记录；任何一维不匹配都返回 null。 */
export function findCapabilityRecord(input: {
  cliId: string;
  capability: CliCapabilityName;
  version: string | null;
  fingerprint: string;
  now?: number;
}): CapabilityRecord | null {
  const version = normalizeVersion(input.version);
  if (!version) return null;
  const tag = systemTag();
  return (
    records.find(
      item =>
        item.cliId === input.cliId &&
        item.capability === input.capability &&
        item.version === version &&
        item.os === tag &&
        item.fingerprint === input.fingerprint &&
        item.result === 'pass'
    ) ?? null
  );
}

/** 写一条新记录（重复维度覆盖旧的），由「重新验证」流程调用。 */
export function recordCapability(input: {
  cliId: string;
  capability: CliCapabilityName;
  version: string;
  fingerprint: string;
  note: string;
}): CapabilityRecord {
  const next: CapabilityRecord = {
    cliId: input.cliId,
    capability: input.capability,
    version: normalizeVersion(input.version),
    os: systemTag(),
    fingerprint: input.fingerprint,
    verifiedAt: Date.now(),
    result: 'pass',
    note: input.note
  };
  records = records.filter(
    item =>
      !(
        item.cliId === next.cliId &&
        item.capability === next.capability &&
        item.version === next.version &&
        item.os === next.os &&
        item.fingerprint === next.fingerprint
      )
  );
  records.push(next);
  save();
  return next;
}

/**
 * 一个配置在当前版本下**实际**的非交互能力。
 *
 * `config.headless` 只表达「代码里有没有做过实测」，`unsupported` 是硬事实；
 * 其余一律以记录为准。这样升级版本、改参数都会自动降级，不靠人记得改常量。
 */
export function resolveHeadless(config: CliAgentConfig, rawVersion: string | null): CliHeadlessSupport {
  if (config.headless === 'unsupported') return 'unsupported';
  const record = findCapabilityRecord({
    cliId: config.id,
    capability: 'headless',
    version: rawVersion,
    fingerprint: capabilityFingerprint(config)
  });
  return record ? 'verified' : 'unverified';
}

export function listCapabilityRecords(): CapabilityRecord[] {
  return records.map(item => ({ ...item }));
}
