/**
 * 桌面与系统能力：剪贴板、通知、系统信息、进程查看与结束。
 *
 * 这些操作在 DSH 里分散在 `bash` 与桌面插件中；对「在本机干活」来说它们
 * 是基础动作，单独给工具比让模型拼 osascript 更可控：
 * - 剪贴板读写走 `pbcopy` / `pbpaste`，文本上限 256 KiB；
 * - 通知走 `osascript ... on run argv`，内容作为 argv 传入，**不拼进脚本源码**；
 * - 系统信息只读关键指标（OS/CPU/内存/磁盘/电池），不做侵入式采集；
 * - 进程列表优先 `ps`，被环境挡住时退回 `pgrep`；
 * - 结束进程在 `workspace-write` 下一律拒绝：那是不可撤销的破坏，交给
 *   `job.kill` 结束本应用起的任务，或者显式切到完全权限。
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import type { TaskGrant } from '../../shared/contracts';

const MAX_CLIPBOARD = 262_144;

function run(file: string, argv: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, argv, {
        shell: false,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      // 有的宿主环境会同步拒绝 spawn（EPERM）；调用方要能读到"跑不了"而不是崩溃。
      resolve({ code: null, stdout: '', stderr: (error as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < MAX_CLIPBOARD) stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', error => resolve({ code: null, stdout, stderr: error.message }));
    child.on('close', code => resolve({ code, stdout, stderr }));
    if (input !== undefined) {
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });
}

function gb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10;
}

async function diskUsage(): Promise<Array<{ filesystem: string; sizeKb: number; usedKb: number; freeKb: number; capacity: string; mountedOn: string }>> {
  const result = await run('/bin/df', ['-k']);
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length >= 6 && parts[0].startsWith('/dev/'))
    .slice(0, 6)
    .map(parts => ({
      filesystem: parts[0],
      sizeKb: Number(parts[1]),
      usedKb: Number(parts[2]),
      freeKb: Number(parts[3]),
      // macOS 的 df 还有 iused/ifree/%iused 三列，挂载点是最后一列；
      // 早先按 parts.slice(5) 拼，会把容量百分比和 inode 计数拼进挂载点。
      capacity: parts[4] ?? '',
      mountedOn: parts[parts.length - 1]
    }));
}

async function battery(): Promise<{ percent: number | null; charging: boolean | null; source: string } | null> {
  const result = await run('/usr/bin/pmset', ['-g', 'batt']);
  if (result.code !== 0) return null;
  const percentMatch = result.stdout.match(/(\d+)%/);
  const charging = /AC Power/.test(result.stdout) ? true : /Battery Power/.test(result.stdout) ? false : null;
  return {
    percent: percentMatch ? Number(percentMatch[1]) : null,
    charging,
    source: charging === null ? 'unknown' : charging ? 'AC Power' : 'Battery Power'
  };
}

export const systemTools = {
  async clipboardRead(grant: TaskGrant) {
    const result = await run('/usr/bin/pbpaste', []);
    if (result.code !== 0) throw new Error(`读取剪贴板失败：${result.stderr.trim() || 'pbpaste 不可用'}`);
    const text = result.stdout;
    return {
      chars: text.length,
      text: text.length > MAX_CLIPBOARD ? text.slice(0, MAX_CLIPBOARD) : text,
      truncated: text.length > MAX_CLIPBOARD
    };
  },

  async clipboardWrite(grant: TaskGrant, args: { text: string }) {
    if (grant.permissionPreset === 'read-only') throw new Error('当前权限为“仅可查看”，禁止写剪贴板');
    if (Buffer.byteLength(args.text, 'utf8') > MAX_CLIPBOARD) throw new Error('剪贴板内容超过 256 KiB 上限');
    const result = await run('/usr/bin/pbcopy', [], args.text);
    if (result.code !== 0) throw new Error(`写入剪贴板失败：${result.stderr.trim() || 'pbcopy 不可用'}`);
    return { written: args.text.length };
  },

  /**
   * 系统通知。标题与正文作为 argv 传给 AppleScript，不拼进脚本——
   * 否则一段带引号的文本就能改变脚本语义。
   */
  async notify(grant: TaskGrant, args: { title: string; message?: string; subtitle?: string }) {
    if (grant.permissionPreset === 'read-only') throw new Error('当前权限为“仅可查看”，禁止发送系统通知');
    const script = [
      'on run argv',
      'set theTitle to item 1 of argv',
      'set theText to item 2 of argv',
      'display notification theText with title theTitle',
      'end run'
    ];
    const argv = script.flatMap(line => ['-e', line]).concat(['--', args.title, args.message ?? '']);
    const result = await run('/usr/bin/osascript', argv);
    if (result.code !== 0) throw new Error(`发送通知失败：${result.stderr.trim() || 'osascript 被拒绝'}`);
    return { shown: true, title: args.title, message: args.message ?? '', subtitle: args.subtitle ?? '' };
  },

  async info(grant: TaskGrant, args: { scope?: 'all' | 'os' | 'cpu' | 'memory' | 'disk' | 'battery' }) {
    const scope = args.scope ?? 'all';
    const payload: Record<string, unknown> = {};
    if (scope === 'all' || scope === 'os') {
      payload.os = {
        platform: process.platform,
        type: os.type(),
        release: os.release(),
        arch: os.arch(),
        hostname: os.hostname(),
        uptimeSeconds: Math.round(os.uptime())
      };
    }
    if (scope === 'all' || scope === 'cpu') {
      const cpus = os.cpus();
      payload.cpu = { model: cpus[0]?.model ?? 'unknown', cores: cpus.length, speedMHz: cpus[0]?.speed ?? null };
    }
    if (scope === 'all' || scope === 'memory') {
      payload.memory = { totalGb: gb(os.totalmem()), freeGb: gb(os.freemem()) };
    }
    if (scope === 'all' || scope === 'disk') {
      payload.disk = await diskUsage();
    }
    if (scope === 'all' || scope === 'battery') {
      payload.battery = await battery();
    }
    payload.readAt = Date.now();
    return payload;
  },

  async processList(grant: TaskGrant, args: { filter?: string; limit?: number }) {
    const limit = Math.min(args.limit ?? 40, 200);
    let entries: Array<{ pid: number; ppid: number | null; cpu: number | null; memory: number | null; command: string }> = [];
    const ps = await run('/bin/ps', ['-axo', 'pid=,ppid=,pcpu=,pmem=,comm=']);
    if (ps.code === 0 && ps.stdout.trim()) {
      entries = ps.stdout
        .split('\n')
        .map(line => line.trim().split(/\s+/))
        .filter(parts => parts.length >= 5 && Number(parts[0]) > 0)
        .map(parts => ({
          pid: Number(parts[0]),
          ppid: Number(parts[1]),
          cpu: Number(parts[2]),
          memory: Number(parts[3]),
          command: parts.slice(4).join(' ')
        }));
    } else {
      // `ps` 可能被宿主环境挡住；pgrep 通常还能用，至少给出 pid 与命令行。
      const pgrep = await run('/usr/bin/pgrep', ['-fl', '.']);
      if (pgrep.code !== 0 && !pgrep.stdout.trim()) throw new Error('无法读取进程列表（ps 与 pgrep 都不可用）');
      entries = pgrep.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const match = line.match(/^(\d+)\s+(.*)$/);
          return { pid: Number(match?.[1] ?? 0), ppid: null, cpu: null, memory: null, command: match?.[2] ?? line };
        })
        // 没有 pid 前缀的行（环境注入、告警文本）不是进程，别混进列表。
        .filter(entry => entry.pid > 0);
    }

    const needle = (args.filter ?? '').toLowerCase();
    const filtered = needle ? entries.filter(entry => entry.command.toLowerCase().includes(needle)) : entries;
    return {
      total: entries.length,
      matched: filtered.length,
      filter: args.filter ?? null,
      processes: filtered.slice(0, limit)
    };
  },

  /**
   * 进程树：`process.list` 只给平铺列表，父子关系一断，模型就容易把
   * 「Electron 主进程被 helper 拉起」看成一堆无关进程。这里按 ppid 连起来，
   * 并用 depth 表示层级，不返回嵌套对象——扁平结构更好截断、更好读。
   */
  async processTree(grant: TaskGrant, args: { pid?: number; filter?: string; maxEntries?: number }) {
    const limit = Math.min(Math.max(args.maxEntries ?? 120, 1), 500);
    const ps = await run('/bin/ps', ['-axo', 'pid=,ppid=,comm=']);
    if (ps.code !== 0 || !ps.stdout.trim()) {
      // 有的宿主环境拦住 ps（沙箱、缺少执行权限）。退回 pgrep 只能拿到平铺
      // 列表，父子关系就没了——如实说明，别让模型以为这是整棵树。
      const pgrep = await run('/usr/bin/pgrep', ['-fl', '.']);
      if (pgrep.code !== 0 && !pgrep.stdout.trim()) throw new Error('无法读取进程树（ps 与 pgrep 都不可用）');
      const flat = pgrep.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const match = line.match(/^(\d+)\s+(.*)$/);
          return { pid: Number(match?.[1] ?? 0), ppid: 0, depth: 0, command: match?.[2] ?? line };
        })
        .filter(entry => entry.pid > 0);
      const needle = (args.filter ?? '').toLowerCase();
      const matched = needle ? flat.filter(entry => entry.command.toLowerCase().includes(needle)) : flat;
      return {
        total: flat.length,
        matched: matched.length,
        truncated: matched.length > limit,
        note: 'ps 不可用，已退回 pgrep：这些进程没有父子关系',
        processes: matched.slice(0, limit)
      };
    }

    const nodes = ps.stdout
      .split('\n')
      .map(line => line.trim().split(/\s+/))
      .filter(parts => parts.length >= 3 && Number(parts[0]) > 0)
      .map(parts => ({ pid: Number(parts[0]), ppid: Number(parts[1]), command: parts.slice(2).join(' ') }));

    const byParent = new Map<number, typeof nodes>();
    const pids = new Set(nodes.map(node => node.pid));
    for (const node of nodes) {
      const siblings = byParent.get(node.ppid) ?? [];
      siblings.push(node);
      byParent.set(node.ppid, siblings);
    }

    const needle = (args.filter ?? '').toLowerCase();
    const roots = args.pid !== undefined
      ? nodes.filter(node => node.pid === args.pid)
      : nodes.filter(node => !pids.has(node.ppid));
    if (roots.length === 0) throw new Error(`找不到 pid ${args.pid ?? ''}`.trim());

    const out: Array<{ pid: number; ppid: number; depth: number; command: string }> = [];
    const walk = (pid: number, ppid: number, depth: number): void => {
      if (out.length >= limit) return;
      const siblings = byParent.get(pid) ?? [];
      for (const node of siblings) {
        // 上限必须在同级循环里检查：只放在函数入口，同一层兄弟多的时候
        // 会一口气全部塞进去，maxEntries 就形同虚设。
        if (out.length >= limit) return;
        if (needle && !node.command.toLowerCase().includes(needle)) {
          // 过滤命中才收，但子树仍要往下走：命中的可能是孙子进程。
          walk(node.pid, node.ppid, depth);
          continue;
        }
        out.push({ pid: node.pid, ppid, depth, command: node.command });
        walk(node.pid, node.ppid, depth + 1);
      }
    };
    for (const root of roots) {
      if (out.length >= limit) break;
      if (needle && !root.command.toLowerCase().includes(needle)) {
        // 根节点没命中不代表子树没有，照样往下走。
        walk(root.pid, root.ppid, 0);
        continue;
      }
      out.push({ pid: root.pid, ppid: root.ppid, depth: 0, command: root.command });
      walk(root.pid, root.ppid, 1);
    }

    return { total: nodes.length, matched: out.length, truncated: out.length >= limit, processes: out };
  },

  async processKill(grant: TaskGrant, args: { pid: number; signal?: 'TERM' | 'KILL' }) {
    if (grant.permissionPreset === 'read-only') throw new Error('当前权限为“仅可查看”，禁止结束进程');
    if (grant.permissionPreset !== 'danger-full-access') {
      throw new Error('结束任意进程需要完全权限；要停掉本应用起的命令请用 job.kill');
    }
    const signal = args.signal ?? 'TERM';
    try {
      process.kill(args.pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') throw new Error(`进程 ${args.pid} 不存在`);
      if (code === 'EPERM') throw new Error(`没有权限结束进程 ${args.pid}`);
      throw error;
    }
    // 给系统一点时间回收；这里如实报告"信号已发出"，再用 signal 0 探活。
    await new Promise(resolve => setTimeout(resolve, 300));
    let stillRunning = true;
    try { process.kill(args.pid, 0); } catch { stillRunning = false; }
    return { pid: args.pid, signal, delivered: true, stillRunning };
  }
};
