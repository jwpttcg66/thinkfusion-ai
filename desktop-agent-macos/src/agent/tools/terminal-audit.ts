/**
 * 终端事件审计：每个会话一份 append-only JSONL。
 *
 * 与 `main/trace/trace-store.ts` 的分工：那份记对话/任务的阶段轨迹（route、
 * answer、execute），这份记**终端字节流**（stdout / stdin / resize / exit）。
 * 两边都是「每会话一份 JSONL + 单调递增 sequence + 坏行跳过」，但事件模型不同，
 * 不硬塞进同一个文件。
 *
 * 必须在 Runtime 进程里写：PTY 的 onData、write、resize 都发生在这里，主进程
 * 只能看到转发后的增量。目录由主进程在 `utilityProcess.fork` 时通过
 * `TF_TERMINAL_AUDIT_DIR` 注入；没有这个变量时整个审计静默停用（测试环境），
 * 绝不自己猜一个 userData 路径。
 *
 * 五条诚实约束：
 *
 * 1. **先脱敏再落盘。** stdin 可能粘进 API Key，CLI 的 envAllowlist 又允许透传
 *    `ANTHROPIC_API_KEY`，不脱敏就是在往磁盘写凭据。
 * 2. **PTY 是合并流。** node-pty 只给一个 onData，没有独立 stderr；PTY 事件一律
 *    记 `stdout` 并在 session-start 里标 `stream: 'pty-merged'`，不假装分得开。
 *    headless CLI 的 stderr 由调用方单独以 `stderr` 事件写入。
 * 3. **写失败要留痕。** 失败不抛、不让终端挂掉，但会把会话标记为「审计不完整」，
 *    并在下一次成功写入时补一条 `audit-error`，界面也能查到。
 * 4. **dropped 落盘。** 环形缓冲裁掉的字节数写进事件，不只停留在内存报告。
 * 5. **有上限与保留期。** 单文件 8MB，超过后只记结构事件、data 置空并标 dropped；
 *    默认保留 14 天，配置时清理过期文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { redactArgv, redactSecrets } from '../../shared/redact';
import type { TerminalProcessState } from '../../shared/terminal-state';

export type TerminalAuditEventType =
  | 'session-start'
  | 'stdout'
  | 'stderr'
  | 'stdin'
  | 'resize'
  | 'connection'
  | 'cancel'
  | 'exit'
  | 'session-end'
  | 'audit-error'
  | 'audit-truncated';

export interface TerminalAuditEvent {
  sessionId: string;
  /** 单会话内从 1 开始单调递增；回放靠它复原顺序。 */
  sequence: number;
  timestamp: number;
  type: TerminalAuditEventType;
  /** 已脱敏的文本。PTY 合并流的输出事件用 stdout。 */
  data?: string;
  cols?: number;
  rows?: number;
  exitCode?: number;
  signal?: string | null;
  /** 这段数据是否因缓冲/文件上限被丢弃。 */
  dropped?: boolean;
  /** 被丢弃的字符数（能数清就数，不能就只给 dropped）。 */
  droppedChars?: number;
  state?: TerminalProcessState;
  reason?: string;
}

export interface TerminalAuditMeta {
  cliName?: string;
  cliVersion?: string;
  os: string;
  cwd: string;
  /** 启动参数摘要，已脱敏。 */
  argv: string[];
  permissionMode?: string;
  /** PTY 是合并流；headless 才有独立的 stdout/stderr。 */
  stream: 'pty-merged' | 'headless';
  startedAt: number;
}

export interface TerminalAuditStatus {
  enabled: boolean;
  /** 写入失败过：这份记录不完整，不能当成完整审计。 */
  incomplete: boolean;
  truncated: boolean;
  bytes: number;
  events: number;
  file?: string;
}

interface AuditSession {
  id: string;
  file: string;
  fd: number | null;
  seq: number;
  bytes: number;
  truncated: boolean;
  incomplete: boolean;
  /** 写入失败但还没补记的事件数。 */
  pendingErrors: number;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_START_TYPE: TerminalAuditEventType = 'session-start';

const sessions = new Map<string, AuditSession>();
let root: string | null = null;
let configured = false;

/** 主进程注入目录；显式传空字符串可关闭（测试用）。 */
export function configureTerminalAudit(dir?: string | null): void {
  configured = true;
  root = dir && dir.trim() ? dir.trim() : null;
  if (root) {
    try {
      fs.mkdirSync(root, { recursive: true });
      pruneTerminalAudit();
    } catch {
      // 目录建不起来就当作没启用：审计是旁路，不该让终端起不来。
      root = null;
    }
  }
}

/** 读环境变量的懒初始化，让测试不依赖 fork 环境。 */
function ensureRoot(): string | null {
  if (root === null && !configured) {
    configured = true;
    configureTerminalAudit(process.env.TF_TERMINAL_AUDIT_DIR);
  }
  return root;
}

/** 清掉超过保留期的记录；只删本目录的 .jsonl，不递归、不碰别的文件。 */
export function pruneTerminalAudit(now = Date.now(), retentionMs = RETENTION_MS): number {
  if (!root) return 0;
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(root, name);
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs <= retentionMs) continue;
      fs.unlinkSync(file);
      removed += 1;
    } catch {
      // 单个文件删不掉不影响其它文件。
    }
  }
  return removed;
}

export function terminalAuditDir(): string | null {
  return ensureRoot();
}

function fileOf(sessionId: string): string {
  // sessionId 是内部生成的，仍然 basename 一次，防止将来换成用户输入。
  const safe = path.basename(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(ensureRoot() ?? '', `${safe}.jsonl`);
}

/** JSONL 一行一个事件；脱敏在这里做，调用方不需要记得。 */
function encode(session: AuditSession, event: Omit<TerminalAuditEvent, 'sessionId' | 'sequence' | 'timestamp'> & Partial<Pick<TerminalAuditEvent, 'timestamp'>>): string {
  session.seq += 1;
  const full: TerminalAuditEvent = {
    sessionId: session.id,
    sequence: session.seq,
    timestamp: event.timestamp ?? Date.now(),
    type: event.type,
    ...(event.data !== undefined ? { data: redactSecrets(event.data) } : {}),
    ...(event.cols !== undefined ? { cols: event.cols } : {}),
    ...(event.rows !== undefined ? { rows: event.rows } : {}),
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    ...(event.signal !== undefined ? { signal: event.signal } : {}),
    ...(event.dropped !== undefined ? { dropped: event.dropped } : {}),
    ...(event.droppedChars !== undefined ? { droppedChars: event.droppedChars } : {}),
    ...(event.state !== undefined ? { state: event.state } : {}),
    ...(event.reason !== undefined ? { reason: redactSecrets(event.reason) } : {})
  };
  return `${JSON.stringify(full)}\n`;
}

/**
 * 真正写一行。失败时标记 incomplete 并累计待补记次数；不抛错。
 * 到上限后 data 置空、标 dropped，结构事件仍然写，这样回放还能还原时序。
 */
function writeLine(session: AuditSession, line: string, durable: boolean): void {
  if (session.fd === null) return;
  if (session.bytes + Buffer.byteLength(line) > MAX_FILE_BYTES && !session.truncated) {
    session.truncated = true;
    try {
      const notice = encode(session, {
        type: 'audit-truncated',
        reason: `单会话记录超过 ${String(MAX_FILE_BYTES)} 字节，之后的正文不再落盘，只保留结构事件`
      });
      fs.writeSync(session.fd, notice);
      session.bytes += Buffer.byteLength(notice);
    } catch {
      session.incomplete = true;
      session.pendingErrors += 1;
    }
  }
  let text = line;
  // 只裁正文事件；session-start / session-end 的 data 是元数据，不能一起丢。
  if (session.truncated) {
    try {
      const parsed = JSON.parse(line) as TerminalAuditEvent;
      if (parsed.data && (parsed.type === 'stdout' || parsed.type === 'stderr' || parsed.type === 'stdin')) {
        parsed.data = '';
        parsed.dropped = true;
        text = `${JSON.stringify(parsed)}\n`;
      }
    } catch {
      // 编码出来的行一定是合法 JSON；真出问题就按原样写。
    }
  }
  try {
    fs.writeSync(session.fd, text);
    session.bytes += Buffer.byteLength(text);
    if (durable) fs.fsyncSync(session.fd);
    // 之前有写失败：现在能写了，补一条，明确告诉读日志的人中间缺过东西。
    if (session.pendingErrors > 0) {
      const count = session.pendingErrors;
      session.pendingErrors = 0;
      const notice = encode(session, {
        type: 'audit-error',
        reason: `此前有 ${String(count)} 条事件写入失败，这份记录不完整`
      });
      fs.writeSync(session.fd, notice);
      session.bytes += Buffer.byteLength(notice);
      if (durable) fs.fsyncSync(session.fd);
    }
  } catch {
    session.incomplete = true;
    session.pendingErrors += 1;
  }
}

export function startTerminalAudit(sessionId: string, meta: TerminalAuditMeta): void {
  if (!ensureRoot()) return;
  const file = fileOf(sessionId);
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'a', 0o600);
  } catch {
    return;
  }
  const session: AuditSession = {
    id: sessionId,
    file,
    fd,
    seq: 0,
    bytes: 0,
    truncated: false,
    incomplete: false,
    pendingErrors: 0
  };
  sessions.set(sessionId, session);
  const head = {
    type: SESSION_START_TYPE,
    data: JSON.stringify({
      ...meta,
      argv: redactArgv(meta.argv),
      cwd: redactSecrets(meta.cwd),
      permissionMode: meta.permissionMode ? redactSecrets(meta.permissionMode) : undefined
    })
  };
  writeLine(session, encode(session, head), true);
}

export type TerminalAuditAppend = Omit<TerminalAuditEvent, 'sessionId' | 'sequence' | 'timestamp'> & {
  timestamp?: number;
};

/** 追加一条事件；未知会话直接忽略（审计不该反过来影响终端）。 */
export function appendTerminalAudit(sessionId: string, event: TerminalAuditAppend): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  writeLine(session, encode(session, event), false);
}

/** 会话收尾：写 exit + session-end，fsync 后关 fd。 */
export function endTerminalAudit(
  sessionId: string,
  input: { exitCode?: number; signal?: string | null; state: TerminalProcessState; reason?: string; cancelReason?: string }
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  appendTerminalAudit(sessionId, {
    type: 'exit',
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    state: input.state,
    ...(input.reason ? { reason: input.reason } : {})
  });
  appendTerminalAudit(sessionId, {
    type: 'session-end',
    state: input.state,
    data: JSON.stringify({
      endedAt: Date.now(),
      cancelReason: input.cancelReason ? redactSecrets(input.cancelReason) : null,
      finalState: input.state,
      auditIncomplete: session.incomplete,
      truncated: session.truncated
    })
  });
  try {
    if (session.fd !== null) fs.fsyncSync(session.fd);
  } catch {
    session.incomplete = true;
  }
  try {
    if (session.fd !== null) fs.closeSync(session.fd);
  } catch {
    // 关不掉也不影响已写入的字节。
  }
  session.fd = null;
  sessions.delete(sessionId);
}

/**
 * 应用退出时给所有还活着的会话补一条终止原因，别留一堆没有结尾的 JSONL。
 * 应用退出不是「用户点了取消」，所以状态用 EXITED，不粉饰成 CANCELLED。
 */
export function endAllTerminalAudit(reason: string, state: TerminalProcessState = 'EXITED'): void {
  for (const id of [...sessions.keys()]) {
    endTerminalAudit(id, { state, reason, cancelReason: reason });
  }
}

export function terminalAuditStatus(sessionId: string): TerminalAuditStatus {
  const session = sessions.get(sessionId);
  if (!session) return { enabled: false, incomplete: false, truncated: false, bytes: 0, events: 0 };
  return {
    enabled: true,
    incomplete: session.incomplete,
    truncated: session.truncated,
    bytes: session.bytes,
    events: session.seq,
    file: session.file
  };
}

/** 回放/检查用：读一份 JSONL，跳过崩溃留下的半行，按 sequence 排序。 */
export function readTerminalAudit(file: string): TerminalAuditEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const events: TerminalAuditEvent[] = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as TerminalAuditEvent;
      if (typeof parsed.sequence !== 'number' || typeof parsed.type !== 'string') continue;
      events.push(parsed);
    } catch {
      // 崩溃留下的半行：跳过，前面的仍然可读。
    }
  }
  events.sort((left, right) => left.sequence - right.sequence);
  return events;
}

export const TERMINAL_AUDIT_LIMITS = {
  maxFileBytes: MAX_FILE_BYTES,
  retentionMs: RETENTION_MS,
  platform: os.platform()
};
