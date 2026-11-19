/** P5-04：按通道记调用/失败/耗时；网页没有 token，单独标。 */
export interface ChannelCall {
  participantId: string;
  kind: 'web' | 'local' | 'cloud' | 'cli';
  ok: boolean;
  ms: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export interface ChannelTelemetry {
  participantId: string;
  calls: number;
  failures: number;
  totalMs: number;
  billing: 'none' | 'tokens' | 'subscription';
  inputTokens: number;
  outputTokens: number;
}

export class TelemetryLog {
  private readonly byId = new Map<string, ChannelTelemetry>();

  record(call: ChannelCall): void {
    const current = this.byId.get(call.participantId) ?? {
      participantId: call.participantId,
      calls: 0,
      failures: 0,
      totalMs: 0,
      billing: call.kind === 'web' ? 'none' : call.kind === 'cli' ? 'subscription' : 'tokens',
      inputTokens: 0,
      outputTokens: 0
    };
    current.calls += 1;
    if (!call.ok) current.failures += 1;
    current.totalMs += call.ms;
    if (call.kind !== 'web') {
      current.inputTokens += call.inputTokens ?? 0;
      current.outputTokens += call.outputTokens ?? 0;
    }
    this.byId.set(call.participantId, current);
  }

  summary(): ChannelTelemetry[] {
    return [...this.byId.values()].sort((a, b) => a.participantId.localeCompare(b.participantId));
  }
}
