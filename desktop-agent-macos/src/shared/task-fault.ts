import type { AgentTask, PlanStep } from './contracts';

/**
 * 「为什么停」分得清，才谈得上「还回不回得来」（V4 P1 M3-4d）。
 *
 * 原来错在哪：`driveRound` 的六条 `.catch(error => this.fail(taskId, error))` 把所有异常
 * 一律写成终态 `failed`，其中「模型连续 N 秒没有输出」「请求超时」这类是**通道**的问题，
 * 不是任务做错了。而 `failed` 在状态表里没有出边：用户换了网络、换了模型之后除了重新提问
 * 什么都做不了，前面几轮的产物与检查点就此作废。真机留证：
 * `docs/implementation/acceptance/v4-p1-m3-3-20261128/events.after-budget-exhausted.json`
 * 里用户正在取消（`cancelling`），一条「请求超时」把任务判成了 `failed`。
 *
 * 这里只做**分类与措辞**，不落状态：迁移、发事件、写错误都是主进程那一处的事。
 */

export type FaultKind =
  | 'source_disabled'
  | 'channel_stall'
  | 'channel_timeout'
  | 'channel_context_full'
  | 'plan_unusable'
  | 'task_fault';

export interface FaultVerdict {
  kind: FaultKind;
  /**
   * 落点。终态 `failed` 只留给「确实是任务本身的问题」：
   * 通道故障落 `interrupted`、计划不合规或网页源没打开落 `blocked`——两者都在 `resume()`
   * 的允许名单里，也都不是「重新提问才能重来」。
   */
  status: AgentTask['status'];
  /** 给用户的一行：说清是哪儿停的，不写 zod 路径。 */
  headline: string;
  /** 怎么回来。停而没说法，等于逼用户猜哪颗按钮有效。 */
  howBack: string;
}

const STALL = /模型连续\s*\d+\s*秒没有输出/;
const TIMEOUT = /请求超时|响应超时|等待超时|provider[_ ]?timeout/i;
/**
 * 连不上 = 通道没建立起来，和「连上了但等不到」是同一类后果：这一轮没跑完，任务本身没错。
 *
 * 中文那句必须单列：真机第 8 次（2026-11-28）超算网关断了，主进程抛的是
 * 「主导模型五段汇总失败：连不上 https://api.scnet.cn/api/llm/v1」，`fetch failed` 之类的
 * 英文关键词一个都不在里面（`providers/openai-compatible.ts:648`、`ollama.ts:635` 自己
 * 包成了中文），于是判成 `task_fault → failed` 终态——正是本模块要堵的那个口。
 * 生产方是英文异常时也在同一句里带上 `fetch failed`/`ECONNREFUSED`，所以两侧都收。
 */
const NETWORK = /fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|network error|连不上|无法连接|连接被拒绝|连接失败/i;
const CONTEXT_FULL = /上下文已满/;
/**
 * 网页源被关掉时主进程抛的原文（`index.ts` 的 `activateSource`/`reloadPage` 与追问恢复路径）。
 *
 * 单独一类是因为它既不是通道断了也不是任务做错了：用户在设置里拨一下开关就能接着跑。
 * 落到 `failed` 会把「请打开网页源」这条本来能照做的提示藏进一个终态里。提问路径原来只会说
 * 「X 页面尚未就绪」（关着的源永远不会有视图），`adapterFor` 现在把设置里那句原话递过来，
 * 这一类才认得出来。
 */
const SOURCE_CLOSED = /还没启用，先在设置里打开|网页源已关闭/;

/**
 * 计划本身不能用（协议块缺失、校验过不去、同一份回答里两个冲突块）。
 *
 * 用它抛错而不是一条裸消息：`fail()` 收到的字符串可能是模型输出的正文，
 * 靠关键词猜「这是计划不合规」会把不相干的失败也接进同一条落点。
 */
export class PlanUnusableError extends Error {
  readonly faultKind = 'plan_unusable' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PlanUnusableError';
  }
}

/**
 * 这条异常该把任务停在哪里。
 *
 * 判定顺序有意先通道后计划：同一次 `driveRound` 里两种故障不会同时到，但错误文本
 * 可能既有「请求超时」又带一段计划正文，先认通道不会把「等不到回答」误判成「模型写错」。
 */
export function classifyFault(error: unknown): FaultVerdict {
  if (error instanceof PlanUnusableError) {
    return {
      kind: 'plan_unusable',
      status: 'blocked',
      headline: '模型连续交上来的计划都不能用，自动重出已停',
      howBack: '点「继续任务」让它再出一版；若反复如此，用「换手段再来一轮」把要改的做法写清楚，比再等一次自动重出有用。'
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (SOURCE_CLOSED.test(message)) {
    return {
      kind: 'source_disabled',
      status: 'blocked',
      headline: '这一轮要用网页源，但源是关着的',
      howBack: '去「设置 · 来源」把要用的网页源打开，再点「继续任务」——不用重新提问，前面的轮次与检查点都还在。'
    };
  }
  if (STALL.test(message)) {
    return {
      kind: 'channel_stall',
      status: 'interrupted',
      headline: '这一轮模型不再输出，是通道停住了',
      howBack: '不是任务做错了：换模型或等通道恢复后点「继续任务」，会按上一轮检查点重开一轮。'
    };
  }
  if (CONTEXT_FULL.test(message)) {
    return {
      kind: 'channel_context_full',
      status: 'interrupted',
      headline: '这条会话的上下文已满，自动开新会话也没接上',
      howBack: '点「继续任务」：恢复流程会重开一条会话，并按检查点核对已经改过的文件。'
    };
  }
  if (TIMEOUT.test(message) || NETWORK.test(message)) {
    return {
      kind: 'channel_timeout',
      status: 'interrupted',
      headline: '模型通道没接上（连不上或等不到响应）',
      howBack: '不是任务做错了：确认网络/模型可用后点「继续任务」，会按上一轮检查点重开一轮。'
    };
  }
  return {
    kind: 'task_fault',
    status: 'failed',
    headline: '任务失败',
    howBack: '看下面的原因后重新提问。'
  };
}

/**
 * 用户已经按下暂停/取消时，通道故障不该顶掉用户选的那个结局。
 *
 * 真机那条 `task.failed（请求超时）` 就发生在 `cancelling` 中间：结果是「失败」，
 * 用户做的却是「取消」——两者的交付含义不同，前者还会被读成「任务出了问题」。
 * 返回落点状态名；没在停的过程中就返回 null。
 */
export function stopIntent(status: AgentTask['status']): AgentTask['status'] | null {
  if (status === 'cancel_requested' || status === 'cancelling') return 'cancelled';
  if (status === 'pause_requested' || status === 'pausing') return 'paused';
  return null;
}

/**
 * 步骤上「执行器不看、但模型确实写了」的说明字段。
 *
 * 为什么接住而不是拒绝：`StepSchema` 每个分支都 `.strict()`，模型在步骤上多写一个
 * `dependsOn` 就让整份计划判成 `plan.invalid`，代价是一轮真金白银的模型调用（真机样本：
 * 8 个步骤全带 `dependsOn`/`expect`，其中 5 个还带 `checksCategory`）。这些字段不影响
 * 真机要跑什么，忽略它们比拒绝整份计划安全。
 *
 * 但不能装作用户知道：`describeIgnoredAnnotations` 把那几列说出来，尤其是 `dependsOn`——
 * 执行器按数组顺序跑，声明的依赖关系**不会被强制**。
 */
export const IGNORED_STEP_KEYS = [
  'acceptance',
  'acceptanceCriteria',
  'dependsOn',
  'expect',
  'checksCategory'
] as const;

export function describeIgnoredAnnotations(steps: readonly PlanStep[]): string | null {
  const hits = new Map<string, number>();
  for (const step of steps) {
    const record = step as unknown as Record<string, unknown>;
    for (const key of IGNORED_STEP_KEYS) {
      if (record[key] !== undefined) hits.set(key, (hits.get(key) ?? 0) + 1);
    }
  }
  if (hits.size === 0) return null;
  const listed = [...hits]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key} ×${String(n)}`)
    .join('、');
  return hits.has('dependsOn')
    ? `计划里的步骤带了执行器不用的说明字段（${listed}）；已按数组顺序执行，dependsOn 声明的依赖不会被强制`
    : `计划里的步骤带了执行器不用的说明字段（${listed}）；执行器忽略，计划与评审材料仍保留`;
}
