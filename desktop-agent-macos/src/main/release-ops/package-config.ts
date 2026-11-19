/** P6-02：从 package.json 读 mac target，检查 dmg+zip。 */
import fs from 'node:fs';

export interface MacTargetConfig {
  target: string[] | Array<{ target: string; arch?: string[] }>;
}

export function normalizeTargets(target: MacTargetConfig['target']): string[] {
  return target.map(item => (typeof item === 'string' ? item : item.target));
}

export function checkMacConfig(config: MacTargetConfig): { ok: boolean; reasons: string[]; targets: string[] } {
  const targets = normalizeTargets(config.target);
  const reasons: string[] = [];
  if (!targets.includes('dmg')) reasons.push('缺少 dmg');
  if (!targets.includes('zip')) reasons.push('缺少 zip');
  return { ok: reasons.length === 0, reasons, targets };
}

export function readMacConfig(packageFile: string): MacTargetConfig {
  const parsed = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { build?: { mac?: MacTargetConfig } };
  if (!parsed.build?.mac) throw new Error('package.json 缺少 build.mac');
  return parsed.build.mac;
}
