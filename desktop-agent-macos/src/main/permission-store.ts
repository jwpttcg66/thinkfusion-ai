/** 权限预设持久化；重启后仍保持用户保存的“完全权限”。 */
import fs from 'node:fs';
import { writeFileAtomic } from './atomic-write';
import type { PermissionPreset } from '../shared/contracts';

const VALID: readonly PermissionPreset[] = ['read-only', 'workspace-write', 'danger-full-access'];

export function loadPermissionPreset(file: string): PermissionPreset {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { preset?: unknown };
    return typeof parsed.preset === 'string' && (VALID as readonly string[]).includes(parsed.preset)
      ? (parsed.preset as PermissionPreset)
      : 'workspace-write';
  } catch {
    return 'workspace-write';
  }
}

export function savePermissionPreset(file: string, preset: PermissionPreset): void {
  if (!(VALID as readonly string[]).includes(preset)) throw new Error('未知权限预设');
  writeFileAtomic(file, JSON.stringify({ preset }, null, 2), 0o600);
}
