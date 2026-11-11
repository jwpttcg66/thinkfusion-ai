/**
 * 语言服务 Provider 层：先解析「这个文件归谁管」，再拿客户端。
 *
 * 对齐 DSH 的分层（Tool → Service → Provider → Language Server），但只
 * 实现真实存在的那一个：TypeScript 用工程自带的 tsserver。其他语言没有
 * 装语言服务器时明确 `LSP_UNAVAILABLE`，不拿正则/文本搜索冒充语义结果。
 *
 * 工作区隔离：客户端按 root 缓存，同一个 root 复用同一个 tsserver；不同
 * root 各自一个实例。请求串行由 TsServerClient 自己保证。
 */

import path from 'node:path';
import { TsServerClient, TsServerManager } from './tsserver';

export interface LanguageProvider {
  id: string;
  label: string;
  /** 小写扩展名，含点。 */
  extensions: readonly string[];
  /** 这个 root 下能不能启起来；不能时给原因。 */
  probe(root: string): { available: boolean; detail?: string };
  client(root: string): TsServerClient | null;
  dispose?(): void;
}

export class TypeScriptProvider implements LanguageProvider {
  readonly id = 'typescript';
  readonly label = 'TypeScript / JavaScript';
  readonly extensions: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
  private readonly manager: TsServerManager;

  constructor(extraCandidates: readonly string[] = []) {
    this.manager = new TsServerManager(extraCandidates);
  }

  probe(root: string): { available: boolean; detail?: string } {
    const client = this.manager.get(root);
    return client
      ? { available: true }
      : { available: false, detail: '这个工作区没有找到 tsserver（node_modules/typescript/lib/tsserver.js）' };
  }

  client(root: string): TsServerClient | null {
    return this.manager.get(root);
  }

  dispose(): void {
    this.manager.dispose();
  }
}

export class LspProviderRegistry {
  constructor(private readonly providers: readonly LanguageProvider[] = []) {}

  providerFor(file: string): LanguageProvider | null {
    const extension = path.extname(file).toLowerCase();
    return this.providers.find(provider => provider.extensions.includes(extension)) ?? null;
  }

  /** 文件没有对应 Provider 时返回 null，调用方据此报 LSP_UNAVAILABLE。 */
  get(root: string, file: string): TsServerClient | null {
    return this.providerFor(file)?.client(root) ?? null;
  }

  /** 给错误信息用：说清楚是「没装语言服务」，而不是「没有定义」。 */
  unavailableReason(file: string, root?: string): string {
    const provider = this.providerFor(file);
    const extension = path.extname(file).toLowerCase() || '这个文件';
    if (!provider) {
      return `LSP_UNAVAILABLE：${extension} 还没有语言服务 Provider（当前只有 ${this.providers.map(item => item.label).join('、')}）`;
    }
    if (root) {
      const probe = provider.probe(root);
      if (!probe.available) return `LSP_UNAVAILABLE：${probe.detail ?? `${provider.label} 不可用`}`;
    }
    return `LSP_UNAVAILABLE：${provider.label} 客户端不可用`;
  }

  status(root: string): Array<{ id: string; label: string; extensions: readonly string[]; available: boolean; detail?: string }> {
    return this.providers.map(provider => {
      const probe = provider.probe(root);
      return {
        id: provider.id,
        label: provider.label,
        extensions: provider.extensions,
        available: probe.available,
        ...(probe.detail ? { detail: probe.detail } : {})
      };
    });
  }

  dispose(): void {
    for (const provider of this.providers) provider.dispose?.();
  }
}
