/**
 * 定时任务的落盘与触发。
 *
 * 两条硬约束：
 * 1. 只跑 `local` / `cloud`，没有 web —— 无人值守往网页发提示词会在用户账号里
 *    留会话，仓库规则不允许。
 * 2. 触发失败要说出来：`lastError` 原样写回，下一次运行不因为上次失败而静默跳过。
 *
 * 触发本身由主进程的 `conversations.start` 承担；这里只管「什么时候该跑」。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  advance,
  isDue,
  type Schedule
} from '../shared/schedule';

export interface ScheduleFile {
  version: 1;
  items: Schedule[];
}

export class ScheduleStore {
  private state: ScheduleFile = { version: 1, items: [] };

  constructor(private readonly file: string) {
    this.load();
  }

  private load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ScheduleFile>;
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      this.state = {
        version: 1,
        items: items.filter((item): item is Schedule =>
          Boolean(item) && typeof item.id === 'string' && typeof item.text === 'string' &&
          (item.mode === 'local' || item.mode === 'cloud')
        )
      };
    } catch {
      // 坏文件当空表：定时任务丢了比应用起不来轻，且下次写入会覆盖它。
      this.state = { version: 1, items: [] };
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  list(): Schedule[] {
    return [...this.state.items].sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  }

  get(id: string): Schedule | null {
    return this.state.items.find(item => item.id === id) ?? null;
  }

  add(schedule: Schedule): Schedule {
    this.state.items.push(schedule);
    this.persist();
    return schedule;
  }

  update(id: string, patch: Partial<Schedule>): Schedule {
    const index = this.state.items.findIndex(item => item.id === id);
    if (index < 0) throw new Error(`没有这个定时任务：${id}`);
    const next = { ...this.state.items[index], ...patch, id };
    this.state.items[index] = next;
    this.persist();
    return next;
  }

  remove(id: string): void {
    this.state.items = this.state.items.filter(item => item.id !== id);
    this.persist();
  }
}

export interface SchedulerDeps {
  store: ScheduleStore;
  /** 真正跑一次：只能本地/云端，不碰网页。 */
  run: (schedule: Schedule) => Promise<void>;
  now?: () => number;
  /** 检查间隔；缺省 30 秒。 */
  tickMs?: number;
}

let ticking = false;

/**
 * 启动调度循环。返回停止函数，测试与退出时都能收掉。
 *
 * 单飞：上一次触发还没跑完时不再触发第二条，避免到点连发、把本地模型打满。
 */
export function startScheduler(deps: SchedulerDeps): () => void {
  const now = deps.now ?? Date.now;
  const timer = setInterval(() => {
    if (ticking) return;
    const at = now();
    const due = deps.store.list().filter(schedule => isDue(schedule, at));
    if (due.length === 0) return;
    ticking = true;
    void (async () => {
      try {
        for (const schedule of due) {
          try {
            await deps.run(schedule);
            deps.store.update(schedule.id, advance(schedule, now()));
          } catch (error) {
            // 失败也要推进下一次，否则一条坏任务会每 30 秒重试一次。
            deps.store.update(schedule.id, {
              ...advance(schedule, now()),
              lastError: error instanceof Error ? error.message : String(error)
            });
          }
        }
      } finally {
        ticking = false;
      }
    })();
  }, deps.tickMs ?? 30_000);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
