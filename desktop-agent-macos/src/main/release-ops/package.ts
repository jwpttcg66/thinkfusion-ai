/** P6-02：打包目标检查（dmg + zip，arm64，签名/公证）。 */
export interface PackageConfig {
  targets: string[];
  arch: string[];
  signed: boolean;
  notarized: boolean;
}

export function checkPackageConfig(config: PackageConfig): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!config.targets.includes('dmg')) reasons.push('缺少 dmg');
  if (!config.targets.includes('zip')) reasons.push('缺少 zip');
  if (!config.arch.includes('arm64')) reasons.push('缺少 arm64');
  if (!config.signed) reasons.push('未签名');
  if (!config.notarized) reasons.push('未公证');
  return { ok: reasons.length === 0, reasons };
}
