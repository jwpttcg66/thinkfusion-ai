import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../atomic-write';
import { LEGACY_LEAD, LEGACY_PLAN, type DebateState } from './types';

/**
 * 辩论记录独立成文件，**不进主 journal**。
 *
 * 计划里原本写的是「先按天分文件」，落到代码时改成了「每场辩论一个文件」，
 * 理由是不动 `AgentStore`：主 journal 每次 mutation 全量重写整个 state，
 * 而辩论一轮就有 N 条发言，塞进去会让每次写盘都变慢，还会把老数据读取路径
 * 全部改一遍。独立文件既解决了写放大，又让恢复只需读一个文件。
 *
 * 文件是每场辩论的完整快照（不是 append-only）：一场辩论最多几十条消息，
 * 全量写这个文件的代价可以忽略，而 append-only 需要额外的恢复解析。
 */
export class DebateStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(id: string): string {
    // id 由 randomUUID 生成，仍然挡一道路径穿越：IPC 输入不可信。
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('无效的辩论 id');
    return path.join(this.dir, `${id}.json`);
  }

  save(state: DebateState): void {
    writeFileAtomic(this.file(state.debateId), JSON.stringify(state, null, 2), 0o600);
  }

  get(id: string): DebateState | null {
    try {
      return this.parse(fs.readFileSync(this.file(id), 'utf8'));
    } catch {
      return null;
    }
  }

  private parse(raw: string): DebateState {
    const state = JSON.parse(raw) as DebateState;
    // 主导模式上线之前的文件没有 lead / plan。读的时候补齐，但不写回盘：
    // 一次只读不该产生写入，也不该把「未记录」伪装成某个真实模式。
    return {
      ...state,
      lead: state.lead ?? LEGACY_LEAD,
      plan: state.plan ?? LEGACY_PLAN,
      config: { ...state.config, leadMode: state.config.leadMode ?? 'hybrid' }
    };
  }

  /**
   * 给 GC 用：同时返回能读的记录和读不了的记录。
   *
   * `list()` 会静默跳过坏文件；GC 不能这样——读不了的辩论可能引用着
   * 某个 Pack，把「读不了」当成「没引用」会误删。
   */
  scanAll(): { states: DebateState[]; errors: string[] } {
    const states: DebateState[] = [];
    const errors: string[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter(name => name.endsWith('.json'));
    } catch (error) {
      return { states, errors: [`读不到辩论目录：${error instanceof Error ? error.message : String(error)}`] };
    }
    for (const name of names) {
      try {
        states.push(this.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')));
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    states.sort((a, b) => b.updatedAt - a.updatedAt);
    return { states, errors };
  }

  list(): DebateState[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter(name => name.endsWith('.json'))
        .map(name => this.get(name.slice(0, -5)))
        .filter((state): state is DebateState => state !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  remove(id: string): void {
    try {
      fs.unlinkSync(this.file(id));
    } catch {
      // 已经不在了，删两次不该报错。
    }
  }
}
