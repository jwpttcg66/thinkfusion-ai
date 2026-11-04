import type { ModelMetadata, ModelProvider, ProviderHealth } from './types';

/**
 * 所有 Provider 的名单。
 *
 * 没有单独的 `ModelRegistry`：模型是挂在 Provider 下面的，再存一份就是缓存，
 * 而缓存的第一件事是同步——谁忘了同步，界面上就会出现一个已经删掉的模型。
 * 需要模型列表时向各自要（`models()`），不要维护镜像。
 *
 * 和 `SubAgentRegistry` 一样，这里是**名单**，不是调度器：它不决定谁参与
 * 一轮研究，只回答「有谁」。混合模式的分工属于 Orchestrator，放进来会让
 * 「有多少个 Provider」悄悄变成「谁被问了」。
 */
export class ProviderRegistry {
  private readonly byId = new Map<string, ModelProvider>();

  register(provider: ModelProvider): void {
    if (this.byId.has(provider.id)) {
      // 静默覆盖会让「设置里关掉的那个站点还在回答」这种问题查很久。
      throw new Error(`Provider 重复注册：${provider.id}`);
    }
    this.byId.set(provider.id, provider);
  }

  /**
   * 换掉整份名单，保留这个实例。
   *
   * 和 `SubAgentRegistry.replaceAll` 同一个理由：设置里开关一个来源，持有
   * 引用的一方（状态轮询、将来的混合调度）不能继续对着旧对象说话。
   */
  replaceAll(providers: readonly ModelProvider[]): void {
    this.byId.clear();
    for (const provider of providers) this.byId.set(provider.id, provider);
  }

  list(): ModelProvider[] {
    return [...this.byId.values()];
  }

  get(id: string): ModelProvider | undefined {
    return this.byId.get(id);
  }

  /** 拿不到就抛。调用方知道自己要谁，返回 `undefined` 只会把判断推给上面。 */
  require(id: string): ModelProvider {
    const provider = this.byId.get(id);
    if (!provider) throw new Error(`没有这个 Provider：${id}`);
    return provider;
  }

  /** 逐个探测。一个探测失败不影响其他，失败的那个标记为不可用。 */
  async health(): Promise<Record<string, ProviderHealth>> {
    const entries = await Promise.all(
      this.list().map(async provider => {
        try {
          return [provider.id, await provider.health()] as const;
        } catch (error) {
          return [
            provider.id,
            {
              available: false,
              detail: error instanceof Error ? error.message : String(error),
              checkedAt: Date.now()
            }
          ] as const;
        }
      })
    );
    return Object.fromEntries(entries);
  }

  async available(): Promise<ModelProvider[]> {
    const status = await this.health();
    return this.list().filter(provider => status[provider.id]?.available === true);
  }

  /**
   * 汇总所有 Provider 的模型。
   *
   * 一个 Provider 报错不影响其他：本地 Ollama 没启动，不该让网页通道的模型
   * 也跟着消失。报错的那家直接跳过，它的状态由 `health()` 单独说。
   */
  async models(): Promise<ModelMetadata[]> {
    const results = await Promise.all(
      this.list().map(provider => provider.listModels().catch(() => [] as ModelMetadata[]))
    );
    return results.flat();
  }
}
