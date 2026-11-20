/** A-04：shadow 指标累计，供 active 门禁使用。 */
import fs from 'node:fs';
import { writeFileAtomic } from '../atomic-write';
import type { ShadowMetrics } from './gate';

export class ShadowMetricsStore {
  constructor(private readonly file: string) {}

  get(): ShadowMetrics {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<ShadowMetrics>;
      return {
        questions: Math.max(0, Number(raw.questions) || 0),
        planned: Math.max(0, Number(raw.planned) || 0),
        covered: Math.max(0, Number(raw.covered) || 0),
        maxTasksSimple: Math.max(0, Number(raw.maxTasksSimple) || 0)
      };
    } catch {
      return { questions: 0, planned: 0, covered: 0, maxTasksSimple: 0 };
    }
  }

  record(input: { planned: boolean; covered: boolean; tasks: number; simple: boolean }): ShadowMetrics {
    const current = this.get();
    const next: ShadowMetrics = {
      questions: current.questions + 1,
      planned: current.planned + (input.planned ? 1 : 0),
      covered: current.covered + (input.covered ? 1 : 0),
      maxTasksSimple: input.simple
        ? Math.max(current.maxTasksSimple, input.tasks)
        : current.maxTasksSimple
    };
    writeFileAtomic(this.file, JSON.stringify(next, null, 2), 0o600);
    return next;
  }

  reset(): void {
    writeFileAtomic(this.file, JSON.stringify({ questions: 0, planned: 0, covered: 0, maxTasksSimple: 0 }, null, 2), 0o600);
  }
}
