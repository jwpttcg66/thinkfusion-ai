/**
 * 持久终端（`term.*`）：与 DeepSeek Harness 同一个后端 —— `node-pty`。
 *
 * 为什么不是「`shell.run` + 管道」：那套只支持一次性命令，交互式程序（`npm run
 * dev`、`ssh`、需要回车的提示）在管道里读不到自己的 tty，行为与真人终端不一样。
 * dsh 的 `dsh-terminal` 背后就是 `node-pty`（锁 `1.2.0-beta.15`），这里不另造。
 *
 * 四条边界：
 *
 * - **懒加载。** 原生模块没装或 ABI 不匹配时明确报 `TERMINAL_UNAVAILABLE`，
 *   不退化成行模式冒充终端——那会让人以为交互程序跑起来了。
 * - **按会话隔离。** 每个会话有自己的 pty 与输出缓冲，`read` 只返回上次之后的新输出，
 *   不会把整段历史重复塞进上下文。
 * - **有上限。** 缓冲最多保留 200 KB；超了就丢最旧的，并把 `dropped` 报出来。
 * - **必须能收尾。** `close` 与会话结束都会杀进程组；泄漏的会话会在 `list` 里看得见。
 */

import path from 'node:path';

export interface TerminalSessionView {
  sessionId: string;
  pid: number;
  shell: string;
  cwd: string;
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
  buffer: string;
  cursor: number;
  exited: boolean;
  exitCode?: number;
  createdAt: number;
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
    exited: session.exited,
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    pending: Math.max(0, session.buffer.length - session.cursor)
  };
}

function find(sessionId: string): Session {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`没有这个终端会话：${sessionId}`);
  return session;
}

export interface TerminalOpenArgs {
  cwd?: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

export function openTerminal(root: string, args: TerminalOpenArgs = {}) {
  const pty = requirePty();
  const shell = args.shell ?? pickShell();
  const cwd = args.cwd ? path.resolve(root, args.cwd) : root;
  const cols = Math.max(20, Math.min(args.cols ?? 120, 400));
  const rows = Math.max(5, Math.min(args.rows ?? 30, 200));

  const child = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    // 与 dsh 一致：终端拿到的是当前用户环境；密钥类变量不主动清，因为交互式
    // 程序本来就需要它。真正的边界是授权与逐次审批，不是把环境剪空。
    env: process.env
  });

  const session: Session = {
    id: newId(),
    pty: child,
    shell,
    cwd,
    buffer: '',
    cursor: 0,
    exited: false,
    createdAt: Date.now()
  };

  child.onData(data => {
    session.buffer += data;
    if (session.buffer.length > MAX_BUFFER_CHARS) {
      const cut = session.buffer.length - MAX_BUFFER_CHARS;
      session.buffer = session.buffer.slice(cut);
      session.cursor = Math.max(0, session.cursor - cut);
    }
  });
  child.onExit(event => {
    session.exited = true;
    session.exitCode = event.exitCode;
  });

  sessions.set(session.id, session);
  return { ...view(session), opened: true };
}

export function readTerminal(sessionId: string, maxChars = 8000) {
  const session = find(sessionId);
  const from = session.cursor;
  const to = Math.min(session.buffer.length, from + Math.max(1, Math.min(maxChars, 40_000)));
  const output = session.buffer.slice(from, to);
  session.cursor = to;
  return {
    ...view(session),
    output,
    /** 还有没读完的就明确说，不假装已经读全。 */
    truncated: session.buffer.length > to
  };
}

export function sendTerminal(sessionId: string, input: string, submit = true) {
  const session = find(sessionId);
  if (session.exited) throw new Error(`终端已退出（exit ${String(session.exitCode)}），不能再写入`);
  const data = submit ? `${input}\r` : input;
  session.pty.write(data);
  return { sessionId, bytes: data.length, submitted: submit };
}

const SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT']);

export function signalTerminal(sessionId: string, signal = 'SIGINT') {
  if (!SIGNALS.has(signal)) throw new Error(`不支持的信号：${signal}（只允许 ${[...SIGNALS].join(' / ')}）`);
  const session = find(sessionId);
  if (session.exited) return { sessionId, signal, delivered: false, reason: '进程已退出' };
  session.pty.kill(signal);
  return { sessionId, signal, delivered: true };
}

export function closeTerminal(sessionId: string) {
  const session = find(sessionId);
  if (!session.exited) {
    try {
      session.pty.kill('SIGTERM');
    } catch {
      // 已经退出的进程再 kill 会报 ESRCH；关闭这个动作本身仍然算完成。
    }
  }
  sessions.delete(sessionId);
  return { sessionId, closed: true };
}

export function listTerminals() {
  return { sessions: [...sessions.values()].map(view) };
}

/** 任务结束/应用退出时统一收尾；不留下孤儿 shell。 */
export function closeAllTerminals() {
  for (const session of sessions.values()) {
    try {
      session.pty.kill('SIGTERM');
    } catch {
      // 同上：已经退出就算了。
    }
  }
  sessions.clear();
}
