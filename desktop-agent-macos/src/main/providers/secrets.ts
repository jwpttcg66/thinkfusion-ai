import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../atomic-write';

/**
 * API Key 的密文存储。
 *
 * 项目书 Phase D 的硬约束是「API Key 不暴露给 Renderer」「不明文写入配置和
 * 日志」。所以这一层只做三件事：加密后落盘、按 id 取回明文、以及一个
 * **不含明文**的清单给 IPC 用。
 *
 * `safeStorage` 只有打包后的 Electron 里能用（开发时和 node:test 里都没有），
 * 所以做成可注入的 `SecretBox`：默认延迟 load electron，测试注入内存实现。
 * 刻意不在文件顶层 `import { safeStorage } from 'electron'`——那会让整个
 * Provider 层在普通 Node 进程里一 import 就炸。
 *
 * **安全盒不可用时直接拒绝写入**，绝不降级成明文。明文降级是最容易在
 * 「先跑起来再说」时留下、又最难在事后发现的一种妥协。
 */

export interface SecretBox {
  available(): boolean;
  /** 返回可安全落盘的编码字符串（Electron 下是 base64 的密文）。 */
  encrypt(plain: string): string;
  decrypt(payload: string): string;
}

/** Electron 的 OS 级加密：macOS 走 Keychain，Windows 走 DPAPI。 */
export function electronSecretBox(): SecretBox {
  let cached: { encryptString(value: string): Buffer; decryptString(value: Buffer): string; isEncryptionAvailable(): boolean } | null = null;
  const box = () => {
    if (!cached) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const electron = require('electron') as { safeStorage?: typeof cached };
      cached = electron.safeStorage ?? null;
    }
    return cached;
  };
  return {
    available: () => Boolean(box()?.isEncryptionAvailable()),
    encrypt: plain => {
      const impl = box();
      if (!impl || !impl.isEncryptionAvailable()) throw new Error('系统加密不可用，拒绝以明文保存 API Key');
      return impl.encryptString(plain).toString('base64');
    },
    decrypt: payload => {
      const impl = box();
      if (!impl || !impl.isEncryptionAvailable()) throw new Error('系统加密不可用，无法读取 API Key');
      return impl.decryptString(Buffer.from(payload, 'base64'));
    }
  };
}

/** 只给测试用：内存中做一层可逆变换，验证的是读写链路而不是加密强度。 */
export function memorySecretBox(): SecretBox {
  return {
    available: () => true,
    encrypt: plain => Buffer.from(plain, 'utf8').toString('base64'),
    decrypt: payload => Buffer.from(payload, 'base64').toString('utf8')
  };
}

interface StoredKey {
  cipher: string;
  updatedAt: number;
}

export interface ApiKeyStoreOptions {
  file: string;
  box?: SecretBox;
  now?: () => number;
}

export class ApiKeyStore {
  private readonly file: string;
  private readonly box: SecretBox;
  private readonly now: () => number;
  private state: Record<string, StoredKey> = {};

  constructor(options: ApiKeyStoreOptions) {
    this.file = options.file;
    this.box = options.box ?? electronSecretBox();
    this.now = options.now ?? Date.now;

    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, StoredKey>;
      for (const [id, value] of Object.entries(parsed)) {
        if (typeof value?.cipher === 'string') this.state[id] = value;
      }
    } catch {
      // 文件不存在或损坏时从空开始。损坏的密文解不开，保留明文更糟。
      this.state = {};
    }
  }

  /** 给 renderer 的清单：只有 id 和时间，没有 key、没有密文。 */
  list(): Array<{ id: string; updatedAt: number }> {
    return Object.entries(this.state).map(([id, value]) => ({ id, updatedAt: value.updatedAt }));
  }

  has(id: string): boolean {
    return typeof this.state[id]?.cipher === 'string';
  }

  /** 只在主进程里调用。任何 IPC handler 都不许把它直接返回出去。 */
  get(id: string): string | null {
    const stored = this.state[id];
    if (!stored) return null;
    try {
      return this.box.decrypt(stored.cipher);
    } catch {
      return null;
    }
  }

  set(id: string, plain: string): void {
    if (!plain.trim()) throw new Error('API Key 不能为空');
    if (!this.box.available()) throw new Error('系统加密不可用，拒绝以明文保存 API Key');
    this.state[id] = { cipher: this.box.encrypt(plain), updatedAt: this.now() };
    this.persist();
  }

  remove(id: string): void {
    if (!this.state[id]) return;
    delete this.state[id];
    this.persist();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(this.state, null, 2), 0o600);
  }
}
