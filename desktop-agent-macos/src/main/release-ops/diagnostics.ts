/** P6-05：诊断快照与脱敏；默认不收集正文。 */
export function redact(text: string): string {
  return text
    .replace(/\/Users\/[^/\s]+/g, '/Users/<user>')
    .replace(/\b(sk-[A-Za-z0-9]{8,})\b/g, '<key>')
    .replace(/(cookie|authorization)\s*[:=]\s*\S+/gi, '$1: <redacted>');
}

export interface DiagnosticsSnapshot {
  at: number;
  channels: Array<{ id: string; available: boolean; detail?: string }>;
  recentErrors: string[];
}

export function buildDiagnostics(input: {
  channels: Array<{ id: string; available: boolean; detail?: string }>;
  errors: readonly string[];
}): DiagnosticsSnapshot {
  return {
    at: Date.now(),
    channels: input.channels.map(item => ({
      id: item.id,
      available: item.available,
      ...(item.detail ? { detail: redact(item.detail) } : {})
    })),
    recentErrors: input.errors.slice(-20).map(redact)
  };
}
