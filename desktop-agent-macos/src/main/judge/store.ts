import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../atomic-write';
import type { JudgeVerdict } from './types';

/** 裁决和辩论一样独立成文件，按 debateId 一对一存，不进主 journal。 */
export class VerdictStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(debateId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(debateId)) throw new Error('无效的辩论 id');
    return path.join(this.dir, `${debateId}.json`);
  }

  save(verdict: JudgeVerdict): void {
    writeFileAtomic(this.file(verdict.debateId), JSON.stringify(verdict, null, 2), 0o600);
  }

  get(debateId: string): JudgeVerdict | null {
    try {
      return JSON.parse(fs.readFileSync(this.file(debateId), 'utf8')) as JudgeVerdict;
    } catch {
      return null;
    }
  }
}
