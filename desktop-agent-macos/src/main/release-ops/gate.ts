/** P6-08：发布门禁。清单项必须全绿，缺项按失败处理。 */
export interface ReleaseCheck {
  id: string;
  ok: boolean;
  detail?: string;
}

export const REQUIRED_RELEASE_CHECKS = [
  'p0-p5-gates',
  'version-consistency',
  'signed-artifact',
  'clean-machine-install',
  'backup-restore-drill',
  'rollback-drill',
  'release-notes'
] as const;

export function evaluateReleaseGate(checks: readonly ReleaseCheck[]): {
  ok: boolean;
  failed: string[];
} {
  const byId = new Map(checks.map(check => [check.id, check]));
  const failed = REQUIRED_RELEASE_CHECKS.filter(id => !byId.get(id)?.ok);
  return { ok: failed.length === 0, failed };
}
