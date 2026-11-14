/**
 * 持久终端（`term.*`）：与 DeepSeek Harness 同一个后端 —— `node-pty`。
 *
 * 为什么不是「`shell.run` + 管道」：那套只支持一次性命令，交互式程序（`npm run
 * dev`、`ssh`、需要回车的提示）在管道里读不到自己的 tty，行为与真人终端不一样。
 * dsh 的 `dsh-terminal` 背后就是 `node-pty`（锁 `1.2.0-beta.15`），这里不另造。
 *
 * 六条边界：
 *
 * - **懒加载。** 原生模块没装或 ABI 不匹配时明确报 `TERMINAL_UNAVAILABLE`，
 *   不退化成行模式冒充终端——那会让人以为交互程序跑起来了。
 * - **按会话隔离。** 每个会话有自己的 pty 与输出缓冲，`read` 只返回上次之后的新输出，
 *   不会把整段历史重复塞进上下文。
 * - **有上限。** 缓冲最多保留 200 KB；超了就丢最旧的，并把 `dropped` 报出来。
 * - **多读者不互相偷输出。** 模型用 `term.read` 推进自己的 cursor；界面 attach
 *   用绝对 offset 读，两边各记各的。以前只有一个 cursor，谁先读谁把输出吃掉。
 * - **必须能收尾。** `close` 与会话结束都会杀进程组；泄漏的会话会在 `list` 里看得见。
 * - **两种启动方式。** `openTerminal` 开登录 shell（人用）；`openProgram` 直接
 *   exec 一个程序（CLI Agent 用），参数是数组，不经过 shell。
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface TerminalSessionView {
  sessionId: string;
  pid: number;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  exited: boolean;
  exitCode?: number;
  /** 当前缓冲里还能读多少字符。 */
  pending: number;
}

interface Session {
  id: string;
  pty: PtyProcess;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  buffer: string;
  /** buffer[0] 在完整输出里的绝对位置；裁剪时前移。 */
  baseOffset: number;
  /** 模型工具 `term.read` 的游标（绝对位置）。 */
  modelCursor: number;
  exited: boolean;
  exitCode?: number;
  createdAt: number;
  listeners: Set<(chunk: TerminalChunk) => void>;
}

export interface TerminalChunk {
  sessionId: string;
  data: string;
  /** 读者落后于缓冲起点时丢弃的字符数。 */
  dropped: number;
  exited: boolean;
  exitCode?: number;
}

interface PtyProcess {
  pid: number;
  write(data: string): void;
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
}

interface PtyModule {
  spawn(file: string, args: string[] | string, options: {
    name?: string; cols?: number; rows?: number; cwd?: string; env?: NodeJS.ProcessEnv;
  }): PtyProcess;
}

/** 缓冲上限：一个 TUI 刷新几屏就能到这个量，再多就不该塞给模型。 */
const MAX_BUFFER_CHARS = 200_000;
const sessions = new Map<string, Session>();
let counter = 0;

function loadPty(): { pty: PtyModule } | { error: string } {
  try {
    // 动态 require：没装 node-pty 时整个模块仍能被测试和其他工具加载。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pty = require('node-pty') as PtyModule;
    if (!pty || typeof pty.spawn !== 'function') return { error: 'node-pty 已安装但没有导出 spawn' };
    return { pty };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `node-pty 不可用：${detail.split('\n')[0]}` };
  }
}

function requirePty(): PtyModule {
  const loaded = loadPty();
  if ('error' in loaded) throw new Error(`TERMINAL_UNAVAILABLE ${loaded.error}`);
  return loaded.pty;
}

function pickShell(): string {
  const fromEnv = process.env.SHELL;
  return fromEnv && fromEnv.startsWith('/') ? fromEnv : '/bin/zsh';
}

function newId(): string {
  counter += 1;
  return `term-${Date.now().toString(36)}-${counter}`;
}

function view(session: Session): TerminalSessionView {
  return {
    sessionId: session.id,
    pid: session.pty.pid,
    shell: session.shell,
    cwd: session.cwd,
    cols: session.cols,
    rows: session.rows,
    exited: session.exited,
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    pending: Math.max(0, session.buffer.length + session.baseOffset - session.modelCursor)
  };
}

function find(sessionId: string): Session {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`没有这个终端会话：${sessionId}`);
  return session;
}

/**
 * 取进程组号。node-pty 在子进程里 setsid，所以子进程自己就是组长；
 * 但这里仍然先问 `ps`，因为「以为它是组长」和「它真是组长」不能混为一谈。
 */
function processGroupOf(pid: number): number | null {
  const run = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  if (run.status !== 0) return null;
  const pgid = Number(run.stdout.trim());
  return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
}

/**
 * 给整个进程组发信号。
 *
 * 只杀 pty 子进程会留下一堆孙进程（CLI 的 node worker、它启动的构建）；
 * 报告里写「已取消」而实际还在跑，比不取消更糟。
 */
export function signalProcessGroup(pid: number, signal: string): boolean {
  const pgid = processGroupOf(pid);
  if (pgid === null) return false;
  // 绝不能把信号打到自己所在的进程组：那会把 Runtime 一起带走。
  if (pgid === process.pid || pgid === process.ppid) return false;
  try {
    process.kill(-pgid, signal as NodeJS.Signals);
    return true;
  } catch {
    return false;
  }
}

function pushChunk(session: Session, chunk: string) {
  session.buffer += chunk;
  if (session.buffer.length > MAX_BUFFER_CHARS) {
    const cut = session.buffer.length - MAX_BUFFER_CHARS;
    session.buffer = session.buffer.slice(cut);
    session.baseOffset += cut;
    session.modelCursor = Math.max(session.modelCursor, session.baseOffset);
  }
  if (session.listeners.size === 0) return;
  // 订阅者只拿增量；被裁掉的旧数据通过 cursor/dropped 报出来。
  const event: TerminalChunk = {
    sessionId: session.id,
    data: chunk,
    dropped: 0,
    exited: session.exited,
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode })
  };
  for (const listener of session.listeners) {
    try {
      listener(event);
    } catch {
      // 一个订阅者坏了不能影响终端本身。
    }
  }
}

function createSession(input: {
  pty: PtyModule;
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}): Session {
  const child = input.pty.spawn(input.file, input.args, {
    name: 'xterm-256color',
    cols: input.cols,
    rows: input.rows,
    cwd: input.cwd,
    env: input.env
  });

  const session: Session = {
    id: newId(),
    pty: child,
    shell: input.file,
    cwd: input.cwd,
    cols: input.cols,
    rows: input.rows,
    buffer: '',
    baseOffset: 0,
    modelCursor: 0,
    exited: false,
    createdAt: Date.now(),
    listeners: new Set()
  };

  child.onData(data => pushChunk(session, data));
  child.onExit(event => {
    session.exited = true;
    session.exitCode = event.exitCode;
    const chunk: TerminalChunk = {
      sessionId: session.id,
      data: '',
      dropped: 0,
      exited: true,
      exitCode: event.exitCode
    };
    for (const listener of session.listeners) {
      try {
        listener(chunk);
      } catch {
        // 同上。
      }
    }
  });

  sessions.set(session.id, session);
  return session;
}

function clampSize(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(value ?? fallback, max));
}

export interface TerminalOpenArgs {
  cwd?: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

/** 开一个登录 shell（给人用，也给计划里的 `term.open`）。 */
export function openTerminal(root: string, args: TerminalOpenArgs = {}) {
  const pty = requirePty();
  const shell = args.shell ?? pickShell();
  const cwd = args.cwd ? path.resolve(root, args.cwd) : root;
  const session = createSession({
    pty,
    file: shell,
    args: ['-l'],
    cwd,
    cols: clampSize(args.cols, 120, 20, 400),
    rows: clampSize(args.rows, 30, 5, 200),
    // 与 dsh 一致：终端拿到的是当前用户环境；密钥类变量不主动清，因为交互式
    // 程序本来就需要它。真正的边界是授权与逐次审批，不是把环境剪空。
    env: process.env
  });
  return { ...view(session), opened: true };
}

/**
 * 直接 exec 一个程序（CLI Agent 用）。
 *
 * 与 `openTerminal` 的区别不是外观：这里不经过 shell、不读 shell 配置，
 * `file`/`args`/`env` 都必须由调用方（注册表 + 授权执行逻辑）构造。
 */
export function openProgram(input: {
  file: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}) {
  const pty = requirePty();
  const session = createSession({
    pty,
    file: input.file,
    args: input.args ?? [],
    cwd: input.cwd,
    cols: clampSize(input.cols, 120, 20, 400),
    rows: clampSize(input.rows, 30, 5, 200),
    env: input.env ?? process.env
  });
  return view(session);
}

/** 模型视角的读：推进自己的游标，返回上次之后的新输出。 */
export function readTerminal(sessionId: string, maxChars = 8000) {
  const session = find(sessionId);
  const wanted = session.modelCursor;
  const from = Math.max(wanted, session.baseOffset);
  const endOffset = session.buffer.length + session.baseOffset;
  const to = Math.min(endOffset, from + Math.max(1, Math.min(maxChars, 40_000)));
  const start = from - session.baseOffset;
  const end = to - session.baseOffset;
  const output = session.buffer.slice(start, end);
  session.modelCursor = to;
  return {
    ...view(session),
    output,
    /** 还有没读完的就明确说，不假装已经读全。 */
    truncated: endOffset > to,
    /** 读者落在缓冲起点之前时，这部分已经丢了。 */
    dropped: Math.max(0, session.baseOffset - wanted)
  };
}

/**
 * 界面视角的读：按调用方持有的绝对 cursor 读，不推进模型游标。
 * 返回的 cursor 是下一次该传的值。
 */
export function readSince(sessionId: string, cursor: number, maxChars = 8000) {
  const session = find(sessionId);
  const endOffset = session.buffer.length + session.baseOffset;
  const from = Math.max(0, Math.min(cursor, endOffset));
  const dropped = Math.max(0, session.baseOffset - from);
  const start = Math.max(0, from - session.baseOffset);
  const to = Math.min(session.buffer.length, start + Math.max(1, Math.min(maxChars, 40_000)));
  return {
    chunk: session.buffer.slice(start, to),
    cursor: session.baseOffset + to,
    dropped,
    ...(session.exited ? { exited: true } : {}),
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode })
  };
}

/** attach 时一次把现有 backlog 给全；之后用 readSince + 订阅。 */
export function attachTerminal(sessionId: string) {
  const session = find(sessionId);
  return {
    sessionId: session.id,
    cols: session.cols,
    rows: session.rows,
    backlog: session.buffer.slice(),
    cursor: session.baseOffset + session.buffer.length,
    dropped: 0,
    exited: session.exited,
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode })
  };
}

export function subscribeTerminal(sessionId: string, listener: (chunk: TerminalChunk) => void): () => void {
  const session = find(sessionId);
  session.listeners.add(listener);
  return () => {
    session.listeners.delete(listener);
  };
}

export function sendTerminal(sessionId: string, input: string, submit = true) {
  const session = find(sessionId);
  if (session.exited) throw new Error(`终端已退出（exit ${String(session.exitCode)}），不能再写入`);
  const data = submit ? `${input}\r` : input;
  session.pty.write(data);
  return { sessionId, bytes: data.length, submitted: submit };
}

export function resizeTerminal(sessionId: string, cols: number, rows: number) {
  const session = find(sessionId);
  const nextCols = clampSize(cols, session.cols, 20, 400);
  const nextRows = clampSize(rows, session.rows, 5, 200);
  session.cols = nextCols;
  session.rows = nextRows;
  session.pty.resize(nextCols, nextRows);
  return { sessionId, cols: nextCols, rows: nextRows };
}

const SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT']);

export function signalTerminal(sessionId: string, signal = 'SIGINT') {
  if (!SIGNALS.has(signal)) throw new Error(`不支持的信号：${signal}（只允许 ${[...SIGNALS].join(' / ')}）`);
  const session = find(sessionId);
  if (session.exited) return { sessionId, signal, delivered: false, reason: '进程已退出' };
  // 先打进程组，再补一次 pty 本身：组号拿不到时才只退到后者。
  const grouped = signalProcessGroup(session.pty.pid, signal);
  if (!grouped) {
    try {
      session.pty.kill(signal);
    } catch {
      // 已经退出时 kill 会报 ESRCH；这个动作本身仍然算完成。
    }
  }
  return { sessionId, signal, delivered: true, processGroup: grouped };
}

export function closeTerminal(sessionId: string) {
  const session = find(sessionId);
  const pid = session.pty.pid;
  if (!session.exited) {
    const grouped = signalProcessGroup(pid, 'SIGTERM');
    if (!grouped) {
      try {
        session.pty.kill('SIGTERM');
      } catch {
        // 已经退出的进程再 kill 会报 ESRCH；关闭这个动作本身仍然算完成。
      }
    }
    // 5 秒还没退，就强杀整个组：留着半死的 TUI 只会让下一次取消更混乱。
    const timer = setTimeout(() => {
      if (session.exited) return;
      const killed = signalProcessGroup(pid, 'SIGKILL');
      if (!killed) {
        try {
          session.pty.kill('SIGKILL');
        } catch {
          // 同上。
        }
      }
    }, 5000);
    timer.unref?.();
  }
  sessions.delete(sessionId);
  return { sessionId, closed: true };
}

export function listTerminals() {
  return { sessions: [...sessions.values()].map(view) };
}

/** 应用退出时收掉所有 pty：不把交互式进程留在后台。 */
export function closeAllTerminals() {
  for (const session of sessions.values()) {
    try {
      if (!session.exited) {
        const grouped = signalProcessGroup(session.pty.pid, 'SIGTERM');
        if (!grouped) session.pty.kill('SIGTERM');
      }
    } catch {
      // 退出路径上不再抛错：收尾失败也不该阻止进程结束。
    }
  }
  sessions.clear();
}
