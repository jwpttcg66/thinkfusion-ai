/** P6-07：发布前安全复核清单。 */
export interface SecurityCheck {
  id: string;
  ok: boolean;
  detail?: string;
}

export const REQUIRED_SECURITY_CHECKS = [
  'no-secrets-in-repo',
  'keychain-only',
  'default-telemetry-off',
  'signed-binary',
  'trash-by-default'
] as const;

export function evaluateSecurity(checks: readonly SecurityCheck[]): { ok: boolean; failed: string[] } {
  const byId = new Map(checks.map(item => [item.id, item]));
  const failed = REQUIRED_SECURITY_CHECKS.filter(id => !byId.get(id)?.ok);
  return { ok: failed.length === 0, failed };
}
