/**
 * 长任务上下文管理器的开关解析。
 *
 * 以前只认环境变量 `THINKFUSION_CONTEXT_MANAGER=active`，默认关闭，
 * 而且用户没有可持久化的开关。这里把优先级写死：
 * 环境变量（运维覆盖） > 配置文件 `context-manager.json` > 默认关闭。
 *
 * 默认保持关闭：打开会改变所有任务的上下文准备行为，属于产品决策，
 * 不能让一次升级静默改变所有人的执行路径。
 */
export interface ContextManagerSwitch {
  enabled: boolean;
  source: 'env' | 'config' | 'default';
  reason: string;
}

export function normalizeContextManagerConfig(raw: unknown): boolean | null {
  if (!raw || typeof raw !== 'object') return null;
  const enabled = (raw as { enabled?: unknown }).enabled;
  return typeof enabled === 'boolean' ? enabled : null;
}

export function resolveContextManagerSwitch(input: {
  env?: string;
  config?: unknown;
}): ContextManagerSwitch {
  const env = input.env?.trim().toLowerCase();
  if (env === 'active' || env === '1' || env === 'on') {
    return { enabled: true, source: 'env', reason: '环境变量显式开启' };
  }
  if (env === 'off' || env === '0') {
    return { enabled: false, source: 'env', reason: '环境变量显式关闭' };
  }
  const configured = normalizeContextManagerConfig(input.config);
  if (configured !== null) {
    return {
      enabled: configured,
      source: 'config',
      reason: configured ? '配置文件开启' : '配置文件关闭'
    };
  }
  return { enabled: false, source: 'default', reason: '默认关闭' };
}
