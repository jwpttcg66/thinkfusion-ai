/**
 * P0 回归的有限重试策略。
 *
 * 这里刻意不复用 Provider 内部的重试：Provider 的重试是给产品调用用的，
 * 只按状态码判断；回归需要把「403 Endpoint 不可用」和「429 限流」分开，
 * 需要在报告里留下每次重试，还需要保证不换模型。所以回归自己包一层，
 * Provider 以 `maxRetries: 0` 构造。
 *
 * 规则（V4.1 P0 任务书）：
 * - 403 Endpoint is unavailable：不重试，标 unavailable；
 * - 429：按 Retry-After（最多 30s）或退避重试，最多额外 3 次；
 * - 5xx / 网络中断 / 超时：最多额外 2 次；
 * - 请求错误、模型不存在、取消：不重试；
 * - 任何情况下都不更换模型；重试只用同一个 agent/model。
 */

const RETRY_POLICY_VERSION = '1.0.0';

/** 额外重试次数上限；不含首次调用。 */
const MAX_EXTRA_ATTEMPTS = {
  'rate-limit': 3,
  'server-error': 2,
  network: 2,
  timeout: 2
};

const DEFAULT_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 8000;
const MAX_RETRY_AFTER_MS = 30_000;

function classifyProviderError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error?.message ?? error ?? '');

  if (code === 'auth') {
    // 403 是端点不可用，不是「模型答错」，也不是 API Key 配错。
    if (/403|endpoint is unavailable/i.test(message)) return 'endpoint-unavailable';
    return 'auth';
  }
  if (code === 'busy' || /（429）|\(429\)|rate.?limit/i.test(message)) return 'rate-limit';
  if (code === 'unavailable') {
    if (/\b5\d\d\b|服务错误|service error/i.test(message)) return 'server-error';
    return 'network';
  }
  if (code === 'timeout') return 'timeout';
  if (code === 'cancelled') return 'cancelled';
  if (code === 'bad-request' || code === 'model-not-found') return 'request-error';
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|socket hang up/i.test(message)) {
    return 'network';
  }
  return 'unknown';
}

function isRetryable(classification) {
  return Object.prototype.hasOwnProperty.call(MAX_EXTRA_ATTEMPTS, classification);
}

function retryDelayMs(attempt, classification, error) {
  if (classification === 'rate-limit') {
    const retryAfterMs = error && typeof error === 'object' ? Number(error.retryAfterMs) : NaN;
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
      return Math.min(Math.max(retryAfterMs, 0), MAX_RETRY_AFTER_MS);
    }
  }
  return Math.min(DEFAULT_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

function policyError(error, classification, attempts) {
  const original = error instanceof Error ? error.message : String(error?.message ?? error ?? '未知错误');
  const wrapped = new Error(`[retry:${classification}] ${original}（尝试 ${attempts} 次）`);
  wrapped.name = 'RetryPolicyError';
  wrapped.policyClass = classification;
  wrapped.attempts = attempts;
  wrapped.code = error && typeof error === 'object' ? error.code : undefined;
  wrapped.cause = error;
  return wrapped;
}

/**
 * 执行 `run`，失败时按策略重试。
 *
 * `onAttempt` 每次重试前调用一次，记录的是「第几次尝试失败、为什么、等多久」，
 * 不记录请求内容。返回 `{ value, attempts }`；`attempts` 是实际调用次数。
 */
async function withRetryPolicy({ run, sleep = defaultSleep, onAttempt }) {
  let attempt = 0;
  for (;;) {
    try {
      const value = await run(attempt);
      return { value, attempts: attempt + 1 };
    } catch (error) {
      const classification = classifyProviderError(error);
      const maxExtra = isRetryable(classification) ? MAX_EXTRA_ATTEMPTS[classification] : 0;
      if (!isRetryable(classification) || attempt >= maxExtra) {
        throw policyError(error, classification, attempt + 1);
      }
      const delayMs = retryDelayMs(attempt, classification, error);
      onAttempt?.({
        attempt: attempt + 1,
        maxAttempts: maxExtra + 1,
        policyClass: classification,
        delayMs,
        code: error && typeof error === 'object' ? error.code ?? null : null,
        message: error instanceof Error ? error.message : String(error),
        retryAfterMs: error && typeof error === 'object' && Number.isFinite(Number(error.retryAfterMs))
          ? Number(error.retryAfterMs)
          : null
      });
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryPolicySnapshot() {
  return {
    version: RETRY_POLICY_VERSION,
    modelSwitch: false,
    classes: {
      'endpoint-unavailable': { retry: false, maxExtra: 0, note: '403 Endpoint is unavailable' },
      auth: { retry: false, maxExtra: 0 },
      'rate-limit': { retry: true, maxExtra: MAX_EXTRA_ATTEMPTS['rate-limit'], retryAfter: true },
      'server-error': { retry: true, maxExtra: MAX_EXTRA_ATTEMPTS['server-error'] },
      network: { retry: true, maxExtra: MAX_EXTRA_ATTEMPTS.network },
      timeout: { retry: true, maxExtra: MAX_EXTRA_ATTEMPTS.timeout },
      'request-error': { retry: false, maxExtra: 0 },
      cancelled: { retry: false, maxExtra: 0 },
      unknown: { retry: false, maxExtra: 0 }
    },
    backoff: { baseMs: DEFAULT_BACKOFF_MS, maxMs: MAX_BACKOFF_MS, maxRetryAfterMs: MAX_RETRY_AFTER_MS }
  };
}

module.exports = {
  RETRY_POLICY_VERSION,
  MAX_EXTRA_ATTEMPTS,
  classifyProviderError,
  isRetryable,
  retryDelayMs,
  withRetryPolicy,
  retryPolicySnapshot
};
