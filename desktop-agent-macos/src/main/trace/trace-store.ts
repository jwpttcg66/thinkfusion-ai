import fs from 'node:fs';
import path from 'node:path';
import type { TraceEntry, TraceStatus } from '../../shared/trace';

/**
 * 每条会话一份 append-only JSONL。
 *
 * 为什么不塞进 AgentStore 的单 JSON journal：那份文件每次消息都整体重写，
 * 而轨迹是高频追加、条数更多。轨迹又是诊断数据，不是状态数据——崩溃最多
 * 丢最后一行，读取时跳过坏行即可；会话、消息、计划仍然在主 journal 里，
 * 一份都不能少。
 */
export class TraceStore {
  private readonly cache = new Map<string, { lastSeq: number; lastTurn: number }>();

  constructor(private readonly root: string) {}

  private fileOf(conversationId: string): string {
    // conversationId 由 randomUUID() 生成；仍然 basename 一次，防止未来变成用户输入。
    const safe = path.basename(conversationId);
    return path.join(this.root, `${safe}.jsonl`);
  }

  /** 追加一行；写失败返回 false，不抛。 */
  append(entry: TraceEntry): boolean {
    const file = this.fileOf(entry.conversationId);
    try {
      fs.mkdirSync(this.root, { recursive: true });
      const handle = fs.openSync(file, 'a');
      try {
        fs.writeFileSync(handle, `${JSON.stringify(entry)}\n`);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      const previous = this.cache.get(entry.conversationId);
      this.cache.set(entry.conversationId, {
        lastSeq: Math.max(previous?.lastSeq ?? 0, entry.seq),
        lastTurn: Math.max(previous?.lastTurn ?? 0, entry.turn)
      });
      return true;
    } catch {
      // 轨迹是旁路：写不进去最多让这次复盘少一段，不能让提问失败。
      return false;
    }
  }

  readAll(conversationId: string): TraceEntry[] {
    const file = this.fileOf(conversationId);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const entries: TraceEntry[] = [];
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (!text) continue;
      try {
        const parsed = JSON.parse(text) as TraceEntry;
        if (!parsed || parsed.conversationId !== conversationId) continue;
        if (typeof parsed.seq !== 'number' || typeof parsed.turn !== 'number') continue;
        entries.push(parsed);
      } catch {
        // 崩溃留下的半行：跳过，前面的记录仍然可读。
      }
    }
    entries.sort((left, right) => left.seq - right.seq);
    return entries;
  }

  read(
    conversationId: string,
    options: { beforeSeq?: number; limit?: number } = {}
  ): { entries: TraceEntry[]; hasMore: boolean } {
    const all = this.readAll(conversationId);
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000);
    const before = options.beforeSeq;
    const filtered = before === undefined ? all : all.filter(entry => entry.seq < before);
    const entries = filtered.slice(-limit);
    return { entries, hasMore: filtered.length > entries.length };
  }

  /** 最后一个 seq/turn；第一次调用扫一遍文件，之后缓存。 */
  meta(conversationId: string): { lastSeq: number; lastTurn: number } {
    const cached = this.cache.get(conversationId);
    if (cached) return cached;
    let lastSeq = 0;
    let lastTurn = 0;
    for (const entry of this.readAll(conversationId)) {
      if (entry.seq > lastSeq) lastSeq = entry.seq;
      if (entry.turn > lastTurn) lastTurn = entry.turn;
    }
    const meta = { lastSeq, lastTurn };
    this.cache.set(conversationId, meta);
    return meta;
  }

  /** 未结束的轮：有 turn start、没有 turn end。 */
  openTurns(conversationId: string): number[] {
    const opened = new Set<number>();
    const closed = new Set<number>();
    for (const entry of this.readAll(conversationId)) {
      if (entry.kind !== 'turn') continue;
      if (entry.phase === 'start') opened.add(entry.turn);
      if (entry.phase === 'end') closed.add(entry.turn);
    }
    return [...opened].filter(turn => !closed.has(turn)).sort((left, right) => left - right);
  }

  /**
   * 崩溃收尾：给没写完的轮补一条 turn end。
   *
   * @returns 补了几轮。
   */
  closeOpenTurns(conversationId: string, at = Date.now(), status: TraceStatus = 'interrupted'): number {
    const open = this.openTurns(conversationId);
    if (open.length === 0) return 0;
    let seq = this.meta(conversationId).lastSeq;
    let closed = 0;
    for (const turn of open) {
      seq += 1;
      const written = this.append({
        seq,
        at,
        conversationId,
        turn,
        step: 0,
        kind: 'turn',
        phase: 'end',
        status,
        endedAt: at,
        meta: { code: 'reconcile' }
      });
      if (written) closed += 1;
    }
    return closed;
  }

  remove(conversationId: string): void {
    try {
      fs.rmSync(this.fileOf(conversationId), { force: true });
    } catch {
      /* best effort */
    } finally {
      this.cache.delete(conversationId);
    }
  }
}
