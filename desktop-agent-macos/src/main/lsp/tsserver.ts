/**
 * TypeScript 的语义导航：直接用 `tsserver`，不引 tsserver 包装层。
 *
 * 为什么不是标准 LSP：本机没有 `typescript-language-server`，但每个
 * TypeScript 工程都带 `tsserver`。它说 tsserver 自己的协议（同样是
 * `Content-Length` 分帧），能回答 definition / references / quickinfo /
 * navtree / 诊断——正好是 P1 要的四件事。没有它的时候不伪造结果，
 * 返回 `LSP_UNAVAILABLE`；其他语言以后再接标准 LSP Provider。
 *
 * 这里只做「读」：open/close 之外没有任何写命令。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface CodePosition {
  file: string;
  line: number;
  character: number;
}

export interface CodeLocation {
  path: string;
  line: number;
  character: number;
  /** 该位置所在行的原文（截断到 200 字），给模型一个可读的锚点。 */
  preview?: string;
}

export interface CodeHover {
  display: string;
  documentation: string;
}

export interface CodeSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
  character: number;
}

export interface CodeDiagnostic {
  path: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
  source: 'tsserver';
  code?: string;
}

interface TsserverMessage {
  type: 'response' | 'event';
  command?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: unknown;
  event?: string;
}

const FRAME_HEADER = /Content-Length: (\d+)\r\n\r\n/;

function findTsserver(root: string, extra: readonly string[] = []): string | null {
  const candidates = [
    path.join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js'),
    ...extra,
    path.join(path.dirname(process.execPath), '..', 'node_modules', 'typescript', 'lib', 'tsserver.js')
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续找下一个
    }
  }
  return null;
}

function lineAt(text: string, line: number): string | undefined {
  const lines = text.split('\n');
  const value = lines[line - 1];
  return value === undefined ? undefined : value.trim().slice(0, 200);
}

export class TsServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly opened = new Map<string, string>();

  constructor(
    private readonly root: string,
    private readonly tsserverPath: string
  ) {}

  /** 懒启动；重复调用只启动一次。 */
  start(): void {
    if (this.process) return;
    // tsserver 的输入是「一行一条 JSON」（不是 LSP 的 Content-Length 分帧）；
    // 输出反过来是 Content-Length 分帧。两者都按各自协议处理。
    //
    // 主进程的 process.execPath 是 Electron 本身：直接 spawn 会再开一个应用，
    // 不是 node。用 ELECTRON_RUN_AS_NODE=1 让它以 Node 身份跑 tsserver。
    const env = process.versions.electron
      ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      : process.env;
    const child = spawn(process.execPath, [this.tsserverPath, '--disableAutomaticTypingAcquisition'], {
      cwd: this.root,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.process = child;
    child.stdout.on('data', chunk => this.consume(chunk));
    // tsserver 的诊断日志很多，不往主进程日志里灌。
    child.stderr.on('data', () => undefined);
    child.on('exit', () => {
      this.process = null;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('LSP_TIMEOUT：tsserver 已退出'));
      }
      this.pending.clear();
      this.opened.clear();
    });
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const header = FRAME_HEADER.exec(this.buffer.toString('utf8', 0, Math.min(this.buffer.length, 200)));
      if (!header) return;
      const headerEnd = header.index + header[0].length;
      const length = Number(header[1]);
      if (!Number.isFinite(length) || this.buffer.length < headerEnd + length) return;
      const payload = this.buffer.subarray(headerEnd, headerEnd + length).toString('utf8');
      this.buffer = this.buffer.subarray(headerEnd + length);
      let message: TsserverMessage;
      try { message = JSON.parse(payload) as TsserverMessage; } catch { continue; }
      if (message.type === 'response' && typeof message.request_seq === 'number') {
        const entry = this.pending.get(message.request_seq);
        if (!entry) continue;
        this.pending.delete(message.request_seq);
        clearTimeout(entry.timer);
        if (message.success === false) entry.reject(new Error(message.message ?? `tsserver ${message.command ?? ''} 失败`));
        else entry.resolve(message.body);
      }
    }
  }

  private request(command: string, args: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
    this.start();
    const child = this.process;
    if (!child) return Promise.reject(new Error('LSP_UNAVAILABLE：tsserver 没有启动'));
    this.seq += 1;
    const seq = this.seq;
    const payload = JSON.stringify({ seq, type: 'request', command, arguments: args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`LSP_TIMEOUT：${command} 超过 ${Math.round(timeoutMs / 1000)} 秒`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      child.stdin.write(`${payload}\n`, 'utf8');
    });
  }

  /** 文件被工具改过之后 tsserver 不会自己知道：按 mtime 决定是否重开。 */
  private async ensureOpen(file: string): Promise<void> {
    const stat = fs.statSync(file);
    const fingerprint = `${String(stat.mtimeMs)}:${String(stat.size)}`;
    if (this.opened.get(file) === fingerprint) return;
    if (this.opened.has(file)) {
      await this.request('close', { file }).catch(() => undefined);
    }
    await this.request('open', { file });
    this.opened.set(file, fingerprint);
  }

  async definition(position: CodePosition): Promise<CodeLocation[]> {
    return this.queryLocations('definition', position);
  }

  async references(position: CodePosition): Promise<CodeLocation[]> {
    return this.queryLocations('references', position);
  }

  private async queryLocations(command: 'definition' | 'references', position: CodePosition): Promise<CodeLocation[]> {
    await this.ensureOpen(position.file);
    const body = await this.request(command, {
      file: position.file,
      line: position.line,
      offset: position.character
    });
    const list = Array.isArray(body) ? body : (body as { refs?: unknown[] } | null)?.refs;
    if (!Array.isArray(list)) return [];
    return list
      .map(item => {
        const entry = item as { file?: string; start?: { line?: number; offset?: number } };
        if (!entry.file || !entry.start?.line || !entry.start.offset) return null;
        let preview: string | undefined;
        try { preview = lineAt(fs.readFileSync(entry.file, 'utf8'), entry.start.line); } catch { preview = undefined; }
        return {
          path: path.relative(this.root, entry.file).split(path.sep).join('/'),
          line: entry.start.line,
          character: entry.start.offset,
          ...(preview ? { preview } : {})
        } satisfies CodeLocation;
      })
      .filter((item): item is CodeLocation => item !== null);
  }

  async hover(position: CodePosition): Promise<CodeHover | null> {
    await this.ensureOpen(position.file);
    const body = (await this.request('quickinfo', {
      file: position.file,
      line: position.line,
      offset: position.character
    })) as { displayString?: string; documentation?: string } | null;
    if (!body?.displayString && !body?.documentation) return null;
    return {
      display: String(body.displayString ?? '').trim(),
      documentation: String(body.documentation ?? '').trim()
    };
  }

  async symbols(file: string, max = 200): Promise<CodeSymbol[]> {
    await this.ensureOpen(file);
    const body = (await this.request('navtree', { file })) as { childItems?: unknown[] } | null;
    const out: CodeSymbol[] = [];
    const walk = (items: unknown[]): void => {
      for (const item of items) {
        if (out.length >= max) return;
        const node = item as {
          text?: string;
          kind?: string;
          spans?: Array<{ start?: { line?: number; offset?: number } }>;
          childItems?: unknown[];
        };
        const span = node.spans?.[0]?.start;
        if (node.text && span?.line) {
          out.push({
            name: node.text,
            kind: node.kind ?? 'unknown',
            path: path.relative(this.root, file).split(path.sep).join('/'),
            line: span.line,
            character: span.offset ?? 1
          });
        }
        if (Array.isArray(node.childItems)) walk(node.childItems);
      }
    };
    if (Array.isArray(body?.childItems)) walk(body.childItems);
    return out;
  }

  async diagnostics(file: string): Promise<CodeDiagnostic[]> {
    await this.ensureOpen(file);
    const [syntactic, semantic] = await Promise.all([
      this.request('syntacticDiagnosticsSync', { file }),
      this.request('semanticDiagnosticsSync', { file })
    ]);
    const list = [
      ...(Array.isArray(syntactic) ? syntactic : []),
      ...(Array.isArray(semantic) ? semantic : [])
    ];
    return list.map((item): CodeDiagnostic => {
      const entry = item as {
        start?: { line?: number; offset?: number };
        text?: string;
        category?: string;
        code?: number;
      };
      return {
        path: path.relative(this.root, file).split(path.sep).join('/'),
        line: entry.start?.line ?? 1,
        column: entry.start?.offset ?? 1,
        severity: entry.category === 'warning' ? ('warning' as const) : ('error' as const),
        message: String(entry.text ?? ''),
        source: 'tsserver' as const,
        ...(typeof entry.code === 'number' ? { code: `TS${String(entry.code)}` } : {})
      };
    }).filter(item => item.message.length > 0);
  }

  dispose(): void {
    this.process?.kill();
    this.process = null;
    this.opened.clear();
  }
}

/** 按工作区根复用同一个 tsserver；没有 TypeScript 的工程明确报不可用。 */
export class TsServerManager {
  private readonly clients = new Map<string, TsServerClient | null>();

  constructor(private readonly extraCandidates: readonly string[] = []) {}

  get(root: string): TsServerClient | null {
    if (this.clients.has(root)) return this.clients.get(root) ?? null;
    const tsserver = findTsserver(root, this.extraCandidates);
    const client = tsserver ? new TsServerClient(root, tsserver) : null;
    this.clients.set(root, client);
    return client;
  }

  dispose(): void {
    for (const client of this.clients.values()) client?.dispose();
    this.clients.clear();
  }
}

export function fileFingerprint(file: string): string {
  const stat = fs.statSync(file);
  return createHash('sha256').update(`${String(stat.mtimeMs)}:${String(stat.size)}`).digest('hex').slice(0, 16);
}
