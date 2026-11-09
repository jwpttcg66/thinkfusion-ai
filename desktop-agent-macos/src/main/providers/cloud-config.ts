import fs from 'node:fs';
import { writeFileAtomic } from '../atomic-write';

/**
 * 云端服务的非敏感配置：baseUrl 与模型列表。
 *
 * 单独一个文件，**不跟 API Key 混在一起**：Key 走 safeStorage 加密，
 * 这份是明文可读的普通配置。混在一起会让「读一下模型列表」也必须解密，
 * 也会让以后想导出配置时不小心把 Key 带出去。
 *
 * 文件不存在、损坏、写不进，一律退回预设——配置读失败不该让整个应用起不来。
 */

export interface CloudOverrideRecord {
  baseUrl?: string;
  models?: string[];
  /**
   * 这份 `models` 是不是网关 `/models` 给的。
   *
   * 预设自带的那几条模型名不算：界面靠它区分「来自网关」和「预设兜底」，
   * 拿「列表非空」冒充来源，等于对用户说了一句没验证过的话。
   */
  modelsFromGateway?: boolean;
  /**
   * 只对用户自己加的服务有意义：目录里没有它，名字只能跟着配置存。
   * 内置三条不写这个字段，名字永远取自代码里的预设。
   */
  label?: string;
}

export class CloudConfigStore {
  constructor(private readonly file: string) {}

  private readAll(): Record<string, CloudOverrideRecord> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as Record<string, CloudOverrideRecord>;
    } catch {
      return {};
    }
  }

  get(id: string): CloudOverrideRecord | null {
    return this.readAll()[id] ?? null;
  }

  all(): Record<string, CloudOverrideRecord> {
    return this.readAll();
  }

  set(id: string, patch: CloudOverrideRecord): CloudOverrideRecord {
    const all = this.readAll();
    const next: CloudOverrideRecord = { ...(all[id] ?? {}) };
    if (patch.baseUrl !== undefined) {
      // 端点换了，清单本身留着（常常只是同一个网关的代理地址），但「这份清单
      // 是网关给的」这句话不再成立——清掉标记，界面退回「预设兜底」，
      // 后台再问一次新端点。
      if (patch.baseUrl !== next.baseUrl) delete next.modelsFromGateway;
      next.baseUrl = patch.baseUrl;
    }
    if (patch.models !== undefined) next.models = patch.models;
    if (patch.modelsFromGateway !== undefined) next.modelsFromGateway = patch.modelsFromGateway;
    if (patch.label !== undefined) next.label = patch.label;
    all[id] = next;
    writeFileAtomic(this.file, JSON.stringify(all, null, 2), 0o600);
    return next;
  }

  remove(id: string): void {
    const all = this.readAll();
    if (!(id in all)) return;
    delete all[id];
    writeFileAtomic(this.file, JSON.stringify(all, null, 2), 0o600);
  }
}
