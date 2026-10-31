import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export interface AXNode { role: string; title?: string; value?: string; children?: AXNode[]; }
export interface AccessibilityProvider {
  isAvailable(): Promise<boolean>;
  getFrontmostApplication(): Promise<{ name: string; bundleId?: string } | null>;
  getElementTree(maxDepth?: number): Promise<AXNode[]>;
}

interface BridgeResponse<T> { ok: boolean; result?: T; error?: string; }

export class PlatformAccessibility implements AccessibilityProvider {
  private helperPath() {
    const candidates = [
      path.join(process.resourcesPath || '', 'ax-bridge'),
      path.resolve(process.cwd(), 'resources/ax-bridge')
    ];
    return candidates.find(p => fs.existsSync(p));
  }

  private request<T>(command: string, maxDepth = 4): Promise<T> {
    if (process.platform !== 'darwin') return Promise.reject(new Error('Accessibility provider not implemented for this OS'));
    const helper = this.helperPath();
    if (!helper) return Promise.reject(new Error('AX helper missing. Run: npm run build:ax:mac'));
    return new Promise((resolve, reject) => {
      const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
      child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) return reject(new Error(stderr || `AX helper exited: ${code}`));
        try {
          const response = JSON.parse(stdout.trim().split(/\r?\n/)[0]) as BridgeResponse<T>;
          if (!response.ok) return reject(new Error(response.error || 'AX request failed'));
          resolve(response.result as T);
        } catch (e) { reject(new Error(`Invalid AX helper response: ${String(e)}; ${stderr}`)); }
      });
      child.stdin.end(JSON.stringify({ command, maxDepth }) + '\n');
    });
  }

  async isAvailable() {
    if (process.platform !== 'darwin' || !this.helperPath()) return false;
    try { await this.request('frontmostApplication'); return true; } catch { return false; }
  }
  getFrontmostApplication() { return this.request<{ name: string; bundleId?: string } | null>('frontmostApplication'); }
  async getElementTree(maxDepth = 4) {
    const result = await this.request<AXNode>('focusedTree', maxDepth);
    return result ? [result] : [];
  }
}
