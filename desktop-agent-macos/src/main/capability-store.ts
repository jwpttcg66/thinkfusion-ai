import fs from 'node:fs';
import { writeFileAtomic } from './atomic-write';
import { capabilityMeta, normalizeDisabled } from '../shared/capabilities';

interface CapabilityFile {
  /** 被停用的插件 id。文件里只存「关掉的」，新装一个插件默认就是开的。 */
  disabled?: string[];
}

/**
 * 内置插件的开关，单独一个 JSON 文件。
 *
 * 和 `profile.json` 一个道理：开关跟网页源、跟用户昵称都没关系，混进别的
 * 文件会让一次改名或一次源配置损坏顺手带走能力开关。文件坏了就当全部启用，
 * 不猜半截 JSON——最坏情况是用户重新关一次，比错误地停掉某个能力安全。
 */
export class CapabilityStore {
  private disabled: string[] = [];

  constructor(private readonly file: string) {
    this.load();
  }

  private load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as CapabilityFile;
      this.disabled = normalizeDisabled(parsed?.disabled);
    } catch {
      /* missing or corrupt: everything stays on */
    }
  }

  private persist() {
    writeFileAtomic(this.file, JSON.stringify({ disabled: this.disabled }));
  }

  disabledIds(): string[] {
    return [...this.disabled];
  }

  /** 返回更新后的停用列表；id 不认识就直接拒绝，不写坏文件。 */
  setEnabled(id: string, enabled: boolean): string[] {
    if (!capabilityMeta(id)) throw new Error(`没有这个内置插件：${String(id)}`);
    const next = new Set(normalizeDisabled(this.disabled));
    if (enabled) next.delete(id);
    else next.add(id);
    this.disabled = [...next];
    this.persist();
    return this.disabledIds();
  }
}
