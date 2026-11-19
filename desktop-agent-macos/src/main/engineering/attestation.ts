/** P3-04：执行断言必须带 attestation，不能只凭文字说“跑过了”。 */
export interface ExecutionClaim {
  command: string;
  exitCode: number;
  outputHash: string;
  attestationId?: string;
  at: number;
}

export function isVerifiedExecution(claim: ExecutionClaim): boolean {
  return typeof claim.attestationId === 'string' && claim.attestationId.length > 0 && claim.outputHash.length > 0;
}

export function requireExecutionEvidence(claims: readonly ExecutionClaim[]): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (claims.length === 0) reasons.push('没有执行记录');
  for (const claim of claims) {
    if (!isVerifiedExecution(claim)) reasons.push(`执行缺少 attestation：${claim.command}`);
    if (claim.exitCode !== 0) reasons.push(`命令失败：${claim.command}（${String(claim.exitCode)}）`);
  }
  return { ok: reasons.length === 0, reasons };
}
