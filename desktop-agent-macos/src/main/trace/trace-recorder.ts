import type { SubAgentAnswer } from '../agents/types';
import type { ChannelPhase, ConversationEvent, ConversationStatus } from '../../shared/conversation';
import {
  errorCodeOf,
  preview,
  type TraceEntry,
  type TraceError,
  type TraceGroup,
  type TraceMeta,
  type TraceRef,
  type TraceSource,
  type TraceStage,
  type TraceStatus,
  type TraceUsage
} from '../../shared/trace';

export interface StepHandle {
  turn: number;
  step: number;
}

export interface TraceJoin {
  agentId: string;
  label: string;
  sourceType: TraceSource;
}

/**
 * 一轮的追加记录器。
 *
 * 回答步不需要 MasterAgent 知道轨迹：它只调现有的 `sink.join` /
 * `sink.record` / `sink.phase`，这里把同一串事实翻译成 start/end 记录。
 * 主导汇总、辩论、追加轮、综合这些「一次相位包含多次模型调用」的阶段由
 * 调用方显式 `beginStep/endStep`，不从 phase 猜。
 */
export class TraceRecorder {
  private seq: number;
  private turn: number;
  private step = 0;
  private group: TraceGroup = 'prepare';
  private currentInput: string | null = null;
  private closed = false;
  /** endTurn 正在写收尾记录；此时 endStep 仍要放行。 */
  private ending = false;

  private readonly joined = new Map<string, TraceJoin>();
  private readonly started = new Map<TraceGroup, Set<string>>();
  private readonly skipped = new Map<TraceGroup, Map<string, string>>();
  private readonly open = new Map<string, StepHandle>();
  private readonly answers = new Map<string, { answer: SubAgentAnswer; messageId: string }>();

  constructor(
    private readonly store: {
      append(entry: TraceEntry): boolean;
      meta(conversationId: string): { lastSeq: number; lastTurn: number };
    },
    private readonly conversationId: string,
    private readonly emit: (event: ConversationEvent) => void,
    private readonly clock: () => number = Date.now
  ) {
    const meta = store.meta(conversationId);
    this.seq = meta.lastSeq;
    this.turn = meta.lastTurn;
  }

  beginTurn(input: { inputPreview?: string; reason?: string; meta?: TraceMeta }): number {
    this.turn += 1;
    this.step = 0;
    this.group = 'prepare';
    this.currentInput = input.inputPreview ?? null;
    this.closed = false;
    this.ending = false;
    this.joined.clear();
    this.started.clear();
    this.skipped.clear();
    this.open.clear();
    this.answers.clear();
    this.append({
      kind: 'turn',
      phase: 'start',
      turn: this.turn,
      step: 0,
      status: 'running',
      startedAt: this.clock(),
      ...(input.inputPreview ? { inputPreview: preview(input.inputPreview) ?? undefined } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.meta ? { meta: input.meta } : {})
    });
    return this.turn;
  }

  /** 幂等：重复调用只写一条 turn end。 */
  endTurn(input: {
    status: TraceStatus;
    meta?: TraceMeta;
    reason?: string;
    endedAt?: number;
    error?: TraceError;
  }): void {
    if (this.closed) return;
    this.closed = true;
    this.ending = true;
    const at = input.endedAt ?? this.clock();

    // 还开着的步先收尾，不能让它们永远 running。
    for (const [agentId, handle] of [...this.open.entries()]) {
      this.open.delete(agentId);
      this.answers.delete(agentId);
      this.endStep(handle, { status: 'interrupted', endedAt: at, reason: 'turn ended' });
    }

    // join 了但从未 asking 的成员：不是 failed，是 skipped。
    for (const group of ['first', 'followup'] as const) {
      const used = this.group === group || this.started.has(group) || this.skipped.has(group);
      if (!used) continue;
      const started = this.started.get(group) ?? new Set<string>();
      const skipped = this.skipped.get(group);
      for (const join of this.joined.values()) {
        if (started.has(join.agentId)) continue;
        const detail = skipped?.get(join.agentId) ?? '本轮没有开始提问';
        this.append({
          kind: 'event',
          phase: 'instant',
          turn: this.turn,
          step: 0,
          stage: 'answer',
          group,
          status: 'skipped',
          actorId: join.agentId,
          actorLabel: join.label,
          sourceType: join.sourceType,
          reason: detail,
          ...(detail !== '本轮没有开始提问'
            ? { error: { code: errorCodeOf(detail), detail } }
            : {}),
          meta: { code: 'not-asked' }
        });
      }
    }

    this.append({
      kind: 'turn',
      phase: 'end',
      turn: this.turn,
      step: 0,
      status: input.status,
      endedAt: at,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
      ...(input.error ? { error: input.error } : {})
    });
    this.ending = false;
  }

  join(input: TraceJoin): void {
    this.joined.set(input.agentId, input);
  }

  /** 暂存回答，等 phase='answered' 收步时一起写入。 */
  record(answer: SubAgentAnswer, messageId: string): void {
    if (this.closed) return;
    this.answers.set(answer.agentId, { answer, messageId });
  }

  beginGroup(group: TraceGroup, inputPreview?: string): void {
    if (this.closed) return;
    this.group = group;
    if (inputPreview !== undefined) this.currentInput = inputPreview;
  }

  /** 现有 channel.phase 的旁路：asking 建回答步，answered/failed/busy 收步。 */
  phase(agentId: string, phase: ChannelPhase, detail?: string): void {
    if (this.closed) return;
    if (phase === 'asking') {
      if (this.closed || this.open.has(agentId)) return;
      this.startedIn(this.group).add(agentId);
      const who = this.joined.get(agentId) ?? {
        agentId,
        label: agentId,
        sourceType: 'web' as const
      };
      const handle = this.beginStep({
        stage: 'answer',
        group: this.group,
        actorId: agentId,
        actorLabel: who.label,
        sourceType: who.sourceType,
        ...(this.currentInput ? { inputPreview: this.currentInput } : {})
      });
      if (handle) this.open.set(agentId, handle);
      return;
    }

    if (phase === 'answered' || phase === 'failed' || phase === 'busy') {
      const handle = this.open.get(agentId);
      const saved = this.answers.get(agentId);
      if (!handle) {
        // 主导/辩论/综合组没有 answer 步；收尾由显式步负责。
        if (this.group === 'lead' || this.group === 'debate' || this.group === 'synthesis') return;
        // 本组已经问过：同一组的后续相位，不要补 skipped。
        if (this.startedIn(this.group).has(agentId)) return;
        // 先记住原因，轮结束时统一写。这里直接写会和 endTurn 的兜底重复。
        this.skippedIn(this.group).set(agentId, detail ?? '本轮没有开始提问');
        return;
      }

      this.open.delete(agentId);
      this.answers.delete(agentId);
      this.endStep(handle, {
        status: phase === 'answered' ? 'ok' : phase === 'busy' ? 'busy' : 'failed',
        endedAt: this.clock(),
        ...(saved
          ? {
              usage: saved.answer.usage ?? null,
              ...(typeof saved.answer.firstTokenAt === 'number'
                ? { firstTokenAt: saved.answer.firstTokenAt }
                : {}),
              outputPreview: saved.answer.text,
              messageId: saved.messageId,
              meta: {
                outputChars: saved.answer.text.length,
                citations: saved.answer.citations?.length ?? 0
              }
            }
          : {}),
        ...(detail && phase !== 'answered'
          ? { error: { code: errorCodeOf(detail), detail } }
          : {})
      });
      return;
    }

    if (phase === 'resetting') {
      const who = this.joined.get(agentId);
      this.append({
        kind: 'event',
        phase: 'instant',
        turn: this.turn,
        step: 0,
        stage: 'prepare',
        group: 'prepare',
        status: detail ? 'failed' : 'ok',
        actorId: agentId,
        actorLabel: who?.label ?? agentId,
        sourceType: who?.sourceType ?? 'web',
        reason: 'page.reset',
        ...(detail ? { error: { code: errorCodeOf(detail), detail } } : {})
      });
    }
  }

  /** 一句话旁路；默认进“提问前”事件行，不建步。 */
  note(text: string): void {
    if (this.closed) return;
    this.event({
      stage: 'route',
      group: 'prepare',
      status: 'ok',
      reason: text,
      meta: { code: 'note' }
    });
  }

  /** 会话状态旁路：轮结束由 endTurn 统一写，这里只留一个可查的事件。 */
  status(status: ConversationStatus): void {
    if (this.closed) return;
    if (status === 'thinking' || status === 'collecting' || status === 'synthesizing') return;
    this.event({
      stage: 'route',
      group: 'prepare',
      status: 'ok',
      reason: `status:${status}`,
      meta: { code: 'status' }
    });
  }

  beginStep(input: {
    stage: TraceStage;
    group?: TraceGroup;
    actorId: string;
    actorLabel: string;
    sourceType: TraceSource;
    modelId?: string;
    inputPreview?: string;
    reason?: string;
    parentStep?: number;
    refs?: TraceRef[];
    meta?: TraceMeta;
    /** 历史步骤的真实开始时间；不传就是现在。 */
    startedAt?: number;
  }): StepHandle | undefined {
    if (this.closed) return undefined;
    this.step += 1;
    const handle = { turn: this.turn, step: this.step };
    this.append({
      kind: 'step',
      phase: 'start',
      turn: handle.turn,
      step: handle.step,
      stage: input.stage,
      group: input.group ?? this.group,
      status: 'running',
      actorId: input.actorId,
      actorLabel: input.actorLabel,
      sourceType: input.sourceType,
      startedAt: input.startedAt ?? this.clock(),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.inputPreview
        ? { inputPreview: preview(input.inputPreview) ?? undefined }
        : this.currentInput
          ? { inputPreview: preview(this.currentInput) ?? undefined }
          : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(typeof input.parentStep === 'number' ? { parentStep: input.parentStep } : {}),
      ...(input.refs ? { refs: input.refs } : {}),
      ...(input.meta ? { meta: input.meta } : {})
    });
    return handle;
  }

  endStep(
    handle: StepHandle | undefined,
    input: {
      status: TraceStatus;
      endedAt?: number;
      firstTokenAt?: number;
      usage?: TraceUsage | null;
      outputPreview?: string;
      messageId?: string;
      error?: TraceError;
      meta?: TraceMeta;
      refs?: TraceRef[];
      reason?: string;
    }
  ): void {
    if (!handle) return;
    if (this.closed && !this.ending) return;
    this.append({
      kind: 'step',
      phase: 'end',
      turn: handle.turn,
      step: handle.step,
      status: input.status,
      endedAt: input.endedAt ?? this.clock(),
      ...(typeof input.firstTokenAt === 'number' ? { firstTokenAt: input.firstTokenAt } : {}),
      ...(input.usage !== undefined ? { usage: input.usage ?? undefined } : {}),
      ...(input.outputPreview ? { outputPreview: preview(input.outputPreview, 4000) ?? undefined } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
      ...(input.refs ? { refs: input.refs } : {}),
      ...(input.reason ? { reason: input.reason } : {})
    });
  }

  event(input: {
    stage: TraceStage;
    group?: TraceGroup;
    status: TraceStatus;
    actorId?: string;
    actorLabel?: string;
    sourceType?: TraceSource;
    reason?: string;
    error?: TraceError;
    refs?: TraceRef[];
    meta?: TraceMeta;
    step?: number;
  }): void {
    if (this.closed) return;
    this.append({
      kind: 'event',
      phase: 'instant',
      turn: this.turn,
      step: input.step ?? 0,
      stage: input.stage,
      group: input.group ?? this.group,
      status: input.status,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.actorLabel ? { actorLabel: input.actorLabel } : {}),
      ...(input.sourceType ? { sourceType: input.sourceType } : {}),
      ...(input.reason ? { reason: preview(input.reason, 400) ?? undefined } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.refs ? { refs: input.refs } : {}),
      ...(input.meta ? { meta: input.meta } : {})
    });
  }

  private startedIn(group: TraceGroup): Set<string> {
    const existing = this.started.get(group);
    if (existing) return existing;
    const created = new Set<string>();
    this.started.set(group, created);
    return created;
  }

  private skippedIn(group: TraceGroup): Map<string, string> {
    const existing = this.skipped.get(group);
    if (existing) return existing;
    const created = new Map<string, string>();
    this.skipped.set(group, created);
    return created;
  }

  private append(entry: Omit<TraceEntry, 'seq' | 'at' | 'conversationId'> & { at?: number }): void {
    const at = entry.at ?? this.clock();
    const full: TraceEntry = {
      ...entry,
      seq: ++this.seq,
      at,
      conversationId: this.conversationId
    };
    // 写盘失败不抛；界面上的实时行来自下面这次 emit，重启后最多少一段。
    this.store.append(full);
    this.emit({
      type: 'trace.appended',
      at,
      conversationId: this.conversationId,
      entries: [full]
    });
  }
}
