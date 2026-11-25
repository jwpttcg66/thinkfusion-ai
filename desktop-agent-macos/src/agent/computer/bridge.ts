import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ComputerError, type ComputerBridge } from './types';

export function locateHelper(): string | undefined {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'ax-bridge') : '',
    path.resolve(process.cwd(), 'resources/ax-bridge'),
    path.resolve(__dirname, '../../../resources/ax-bridge')
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate));
}

export class MacComputerBridge implements ComputerBridge {
  async available(): Promise<{ ok: boolean; code?: string; message?: string }> {
    if (process.platform !== 'darwin') {
      return { ok: false, code: 'UNSUPPORTED_PLATFORM', message: '当前平台没有桌面控制实现' };
    }
    if (!locateHelper()) {
      return { ok: false, code: 'HELPER_MISSING', message: 'AX helper 不存在。先运行 npm run build:ax:mac' };
    }
    return { ok: true };
  }

  call(command: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const helper = locateHelper();
    if (process.platform !== 'darwin') {
      return Promise.reject(new ComputerError('UNSUPPORTED_PLATFORM', '当前平台没有桌面控制实现'));
    }
    if (!helper) return Promise.reject(new ComputerError('HELPER_MISSING', 'AX helper 不存在。先运行 npm run build:ax:mac'));
    return new Promise((resolve, reject) => {
      const child = spawn(helper, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: Error, value?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value ?? {});
      };
      const onAbort = () => {
        try { child.kill('SIGKILL'); } catch { /* 进程可能已经退出 */ }
        const reason = signal.reason;
        finish(reason instanceof ComputerError ? reason : new ComputerError('CANCELLED', '桌面操作已取消'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort);
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('error', error => finish(new ComputerError('HELPER_CRASHED', error.message)));
      child.on('close', code => {
        if (signal.aborted) return;
        const line = stdout.trim().split(/\r?\n/).find(item => item.startsWith('{'));
        if (!line) {
          finish(new ComputerError('HELPER_CRASHED', stderr.trim() || `AX helper 退出码 ${String(code)}，没有 JSON 响应`));
          return;
        }
        try {
          const parsed = JSON.parse(line) as { ok?: boolean; result?: Record<string, unknown>; error?: string; code?: string };
          if (!parsed.ok) {
            finish(new ComputerError(parsed.code || 'HELPER_FAILED', parsed.error || 'AX 请求失败'));
            return;
          }
          finish(undefined, parsed.result ?? {});
        } catch (error) {
          finish(new ComputerError('HELPER_CRASHED', `AX helper 响应无法解析：${String(error)}`));
        }
      });
      const body: Record<string, unknown> = { command };
      for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined) body[key] = value;
      }
      child.stdin.end(`${JSON.stringify(body)}\n`);
    });
  }
}
