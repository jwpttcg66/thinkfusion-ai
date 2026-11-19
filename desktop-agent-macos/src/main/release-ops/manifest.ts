/**
 * P6-01：发布清单。版本、tag、产物哈希必须能对上。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

export interface ReleaseArtifact {
  name: string;
  sha256: string;
  size: number;
}

export interface ReleaseManifest {
  productLine: 'V3';
  appVersion: string;
  tag: string;
  commit: string;
  builtAt: number;
  artifacts: ReleaseArtifact[];
  dataSchema: number;
  notes: string;
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export interface ManifestCheck {
  ok: boolean;
  reasons: string[];
}

export function validateManifest(
  manifest: ReleaseManifest,
  expected: { version: string; packageVersion: string; tag: string }
): ManifestCheck {
  const reasons: string[] = [];
  if (manifest.appVersion !== expected.version) reasons.push('版本与 VERSION 不一致');
  if (manifest.appVersion !== expected.packageVersion) reasons.push('版本与 package.json 不一致');
  if (manifest.tag !== expected.tag) reasons.push('tag 与版本不一致');
  if (manifest.tag !== `v${manifest.appVersion}`) reasons.push('tag 格式应为 v<version>');
  if (manifest.artifacts.length === 0) reasons.push('没有发布产物');
  for (const artifact of manifest.artifacts) {
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) reasons.push(`产物哈希非法：${artifact.name}`);
    if (artifact.size <= 0) reasons.push(`产物为空：${artifact.name}`);
  }
  return { ok: reasons.length === 0, reasons };
}
