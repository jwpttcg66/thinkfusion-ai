/**
 * 宿主环境：环境变量、监听端口、已装应用、窗口标题、DNS、当前时间。
 *
 * 这些都在 DSH 里散落在 `bash` 里，每次让模型写一行 shell 再解析文本。单独
 * 给结构化结果的好处不只是省一步：
 * - `env.read` **默认不吐敏感值**。`OPENAI_API_KEY` 这类名字一律打码，只报
 *   长度；否则一次「看看环境变量」就把密钥写进了会话记录。
 * - `port.list` 用 `lsof` 而不是 `netstat`，能直接给出「哪个进程占着 3000」。
 * - `app.list` / `window.list` 只读名字，不启动、不激活任何程序。
 * - `dns.lookup` 属于联网（`network`），因为它会把域名发出去。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { spawn } from 'node:child_process';
import type { TaskGrant } from '../../shared/contracts';

const SENSITIVE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|AUTH)/i;
const MAX_ENV = 200;

function run(file: string, argv: string[], timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, argv, { shell: false, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: (error as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', chunk => { if (stdout.length < 256 * 1024) stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export interface EnvReadResult {
  entries: Array<{ name: string; value: string; masked: boolean }>;
  total: number;
  truncated: boolean;
}

async function envRead(
  _grant: TaskGrant,
  args: { names?: string[]; maxEntries?: number }
): Promise<EnvReadResult> {
  const all = Object.entries(process.env) as Array<[string, string | undefined]>;
  const requested = args.names && args.names.length > 0
    ? all.filter(([name]) => args.names!.includes(name))
    : all;

  const limit = Math.min(Math.max(args.maxEntries ?? 60, 1), MAX_ENV);
  const entries = requested.slice(0, limit).map(([name, value]) => {
    const raw = value ?? '';
    if (SENSITIVE.test(name)) {
      // 打码而不是省略：调用方要能确认「这个变量存在」，但不能看到值。
      return { name, value: raw ? `***（已隐藏，长度 ${raw.length}）` : '', masked: true };
    }
    return { name, value: raw.length > 500 ? `${raw.slice(0, 500)}…` : raw, masked: false };
  });
  return { entries, total: requested.length, truncated: requested.length > limit };
}

export interface PortEntry {
  port: number;
  address: string;
  process: string;
  pid: number;
}

async function portList(_grant: TaskGrant, args: { port?: number; maxEntries?: number }): Promise<{ entries: PortEntry[]; available: boolean }> {
  const result = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
  if (result.code !== 0 && !result.stdout.trim()) {
    return { entries: [], available: false };
  }
  const entries: PortEntry[] = [];
  for (const line of result.stdout.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const name = cols[cols.length - 1];
    const portMatch = /:(\d+)$/.exec(name);
    if (!portMatch) continue;
    const port = Number(portMatch[1]);
    if (args.port !== undefined && port !== args.port) continue;
    entries.push({
      port,
      address: name.replace(/:\d+$/, ''),
      process: cols[0],
      pid: Number(cols[1]) || 0
    });
  }
  const limit = Math.min(Math.max(args.maxEntries ?? 50, 1), 500);
  entries.sort((a, b) => a.port - b.port);
  return { entries: entries.slice(0, limit), available: true };
}

async function appList(_grant: TaskGrant, args: { maxEntries?: number }): Promise<{ apps: string[]; truncated: boolean }> {
  const roots = ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')];
  const names = new Set<string>();
  for (const root of roots) {
    let items: string[];
    try {
      items = await fs.readdir(root);
    } catch {
      continue; // 用户没有这个目录很正常
    }
    for (const item of items) {
      if (item.endsWith('.app')) names.add(item.slice(0, -4));
    }
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const limit = Math.min(Math.max(args.maxEntries ?? 200, 1), 1000);
  return { apps: sorted.slice(0, limit), truncated: sorted.length > limit };
}

export interface WindowEntry {
  app: string;
  title: string;
}

async function windowList(_grant: TaskGrant): Promise<{ windows: WindowEntry[]; note?: string }> {
  // 走 System Events 拿标题；没有「辅助功能」授权时这里会报 -1719 / -25211，
  // 那是有用的信息（告诉用户去哪开权限），不该当成代码缺陷。
  const script = [
    'tell application "System Events"',
    '  set out to ""',
    '  repeat with p in (every process whose visible is true)',
    '    repeat with w in (every window of p)',
    '      try',
    '        set out to out & (name of p) & "\\t" & (name of w) & linefeed',
    '      end try',
    '    end repeat',
    '  end repeat',
    '  return out',
    'end tell'
  ].join('\n');
  const result = await run('/usr/bin/osascript', ['-e', script]);
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    if (/-1719|-25211|-1743/.test(detail)) {
      return { windows: [], note: '需要「辅助功能」授权才能读到窗口标题（系统设置 → 隐私与安全性 → 辅助功能）' };
    }
    return { windows: [], note: `读取窗口失败：${detail || '没有输出'}` };
  }
  const windows = result.stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter(parts => parts.length === 2 && parts[1].trim())
    .map(([app, title]) => ({ app: app.trim(), title: title.trim() }))
    .slice(0, 200);
  return { windows };
}

export interface DnsResult {
  host: string;
  addresses: Array<{ address: string; family: number }>;
}

async function dnsLookup(_grant: TaskGrant, args: { host: string }): Promise<DnsResult> {
  const host = (args.host ?? '').trim();
  // 只接受域名形状：不允许 `host:port`、URI 或任何能拼出别的东西的输入。
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) || !host.includes('.')) {
    throw new Error('host 必须是域名，例如 example.com');
  }
  const found = await dns.lookup(host, { all: true });
  return { host, addresses: found.map(item => ({ address: item.address, family: item.family })) };
}

export interface TimeResult {
  iso: string;
  epochMs: number;
  timeZone: string;
  offsetMinutes: number;
  weekday: string;
  local: string;
}

async function timeNow(): Promise<TimeResult> {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    iso: now.toISOString(),
    epochMs: now.getTime(),
    timeZone,
    // getTimezoneOffset 返回的是「比 UTC 晚多少分钟」，符号与直觉相反，这里取反。
    offsetMinutes: -now.getTimezoneOffset(),
    weekday: now.toLocaleDateString('zh-CN', { weekday: 'long' }),
    local: now.toLocaleString('zh-CN', { hour12: false })
  };
}

export const hostTools = { envRead, portList, appList, windowList, dnsLookup, timeNow };
