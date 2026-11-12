/**
 * Managed 模式：由 ThinkFusion 启停用户提供的本机 Neo4j。
 *
 * 不下载、不升级二进制：`neo4jHome` 是用户已有的安装目录（含 bin/neo4j）。
 * 这里负责 start/stop/restart/version/health；升级通过替换安装目录后重启，
 * 不在后台静默下载可执行文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Neo4jHttpClient } from './neo4j-http';

export interface ManagedNeo4jOptions {
  home: string;
  url: string;
  user: string;
  password: string;
  fetchImpl?: typeof fetch;
}

export interface ManagedRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class ManagedNeo4j {
  constructor(private readonly options: ManagedNeo4jOptions) {}

  private bin(): string | null {
    const candidate = path.join(this.options.home, 'bin', 'neo4j');
    try {
      return fs.statSync(candidate).isFile() ? candidate : null;
    } catch {
      return null;
    }
  }

  async run(args: string[], timeoutMs = 60_000): Promise<ManagedRunResult> {
    const bin = this.bin();
    if (!bin) throw new Error('NEO4J_HOME_INVALID：找不到 <neo4jHome>/bin/neo4j');
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: this.options.home,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
          HOME: process.env.HOME ?? '',
          JAVA_HOME: process.env.JAVA_HOME ?? ''
        }
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(0, 64 * 1024); });
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, 16 * 1024); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    });
  }

  async healthy(): Promise<boolean> {
    const client = new Neo4jHttpClient({
      baseUrl: this.options.url,
      user: this.options.user,
      password: this.options.password,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      timeoutMs: 1500
    });
    try {
      await client.query('RETURN 1 AS ok');
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<'running' | 'stopped' | 'unavailable' | 'error'> {
    if (!this.bin()) return 'unavailable';
    return (await this.healthy()) ? 'running' : 'stopped';
  }

  async start(): Promise<ManagedRunResult> {
    if (await this.healthy()) return { code: 0, stdout: 'already running', stderr: '' };
    const result = await this.run(['start']);
    if (result.code !== 0) return result;
    for (let i = 0; i < 30; i += 1) {
      if (await this.healthy()) return result;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return { ...result, code: 1, stderr: `${result.stderr}\n启动后 30 秒内未通过健康检查` };
  }

  async stop(): Promise<ManagedRunResult> {
    if (!(await this.healthy())) return { code: 0, stdout: 'already stopped', stderr: '' };
    return this.run(['stop']);
  }

  async restart(): Promise<ManagedRunResult> {
    await this.stop();
    return this.start();
  }

  async version(): Promise<string | null> {
    if (!this.bin()) return null;
    try {
      const result = await this.run(['version'], 15_000);
      return (result.stdout || result.stderr).trim().split('\n')[0] || null;
    } catch {
      return null;
    }
  }
}
