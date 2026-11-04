import { ProviderError } from './types';

/**
 * 本地模型的并发闸门。
 *
 * 对应项目书 4.3 的 `LocalModelAdmissionController`。它只管一件事：**同一时刻
 * 只让一个本地推理跑起来**。原因是内存，不是礼貌——24GB 统一内存里同时加载
 * 两个 6GB 模型，加上 KV Cache 和 Electron 自己，系统会开始换页，表现出来是
 * 「模型突然变得极慢」，而日志上什么都看不到。
 *
 * 不做的事，也写清楚，免得将来有人往里加：
 *
 * - 不排优先级，不分会话。先到先得，因为队列里通常只有一两个请求。
 * - 不管超时之后的收尾。被 abort 的请求由 Provider 自己断开连接。
 * - 不重试。排队超时说明机器已经跟不上，重试只会让后面的人等更久。
 */
export interface AdmissionStats {
  running: number;
  queued: number;
}

interface Waiter {
  grant: () => void;
  timer: NodeJS.Timeout;
}

export class LocalAdmission {
  private running = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly providerId: string,
    /** 项目书 4.2：M5 / 24GB 默认 1。 */
    private readonly limit = 1,
    /**
     * 排队多久算失败。
     *
     * 没有上限的等待就是项目书要禁的那个「无限加载」：界面上转圈，用户不知道
     * 是在排队还是卡死了。30 秒足够让一个 7B 模型把上一轮答完。
     */
    private readonly queueTimeoutMs = 30_000
  ) {}

  stats(): AdmissionStats {
    return { running: this.running, queued: this.waiters.length };
  }

  /**
   * 排队 → 执行 → 归还。
   *
   * `label` 只用于错误文案（"本地模型正忙：总结第 2 段"），不参与调度。
   */
  async run<T>(label: string, task: () => Promise<T>): Promise<T> {
    await this.acquire(label);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /**
   * 单独开放，是因为流式请求没法用 `run` 包起来：`async *` 的函数体要到第一次
   * `next()` 才开始跑，而中间要一路 `yield` 出去。拿到名额之后必须在 `finally`
   * 里调 `release()`，否则闸门会被永久占住——那一刻所有本地请求都开始排队。
   */
  acquire(label: string): Promise<void> {
    if (this.running < this.limit) {
      this.running += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          this.running += 1;
          resolve();
        },
        // 先占位，下一行赋值；`grant` 只会在微任务之后被调用。
        timer: undefined as unknown as NodeJS.Timeout
      };

      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        // 已经被让位了，这个定时器是残留的，直接退出，不要双重释放。
        if (index < 0) return;
        this.waiters.splice(index, 1);
        reject(
          new ProviderError(
            'busy',
            `本地模型正忙：${label} 排队超过 ${Math.round(this.queueTimeoutMs / 1000)} 秒`,
            this.providerId
          )
        );
      }, this.queueTimeoutMs);

      this.waiters.push(waiter);
    });
  }

  release(): void {
    this.running -= 1;
    const next = this.waiters.shift();
    // 让位不改 running：`grant` 里已经在原占用者的名额上接了手。
    if (next) next.grant();
  }
}
