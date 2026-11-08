/**
 * 专家 / 技能的开关，单独一个 JSON 文件。
 *
 * 和 capabilities.json 同一个道理：只记「被停用的」，新增条目默认开着；文件
 * 坏了就当全开，不猜半截 JSON。开关跟网页源、昵称、能力插件都没有关系，
 * 混进别的文件会让一次无关的配置损坏顺手带走它。
 */

import fs from 'node:fs';
import { writeFileAtomic } from '../atomic-write';
import { isExpertiseId, normalizeExpertiseDisabled } from '../../shared/expertise';

interface ExpertiseFile {
  disabled?: string[];
}

export class ExpertiseStore {
  private disabled: string[] = [];

  constructor(private readonly file: string) {
    this.load();
  }

  private load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ExpertiseFile;
      this.disabled = normalizeExpertiseDisabled(parsed?.disabled);
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

  /** 返回更新后的停用列表；不认识的 id 直接拒绝，不写坏文件。 */
  setEnabled(id: string, enabled: boolean): string[] {
    if (!isExpertiseId(id)) throw new Error(`没有这个专家或技能：${String(id)}`);
    const next = new Set(normalizeExpertiseDisabled(this.disabled));
    if (enabled) next.delete(id);
    else next.add(id);
    this.disabled = [...next];
    this.persist();
    return this.disabledIds();
  }
}
