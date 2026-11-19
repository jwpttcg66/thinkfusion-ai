/**
 * P6-03：数据迁移。先备份，只加不删；失败保留备份。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface MigrationStep {
  from: number;
  to: number;
  run: (dir: string) => void | Promise<void>;
}

export interface MigrationResult {
  ok: boolean;
  from: number;
  to: number;
  backup: string | null;
  applied: number;
  error?: string;
}

export async function migrateWithBackup(input: {
  dir: string;
  current: number;
  target: number;
  steps: readonly MigrationStep[];
  backupRoot: string;
}): Promise<MigrationResult> {
  const backup = path.join(input.backupRoot, `migrate-${String(Date.now())}`);
  fs.mkdirSync(input.backupRoot, { recursive: true });
  if (fs.existsSync(input.dir)) fs.cpSync(input.dir, backup, { recursive: true });
  let current = input.current;
  let applied = 0;
  try {
    const steps = [...input.steps].sort((a, b) => a.from - b.from);
    for (const step of steps) {
      if (step.from !== current) continue;
      if (step.to > input.target) break;
      await step.run(input.dir);
      current = step.to;
      applied += 1;
    }
    return { ok: current === input.target, from: input.current, to: current, backup, applied };
  } catch (error) {
    return {
      ok: false,
      from: input.current,
      to: current,
      backup,
      applied,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
