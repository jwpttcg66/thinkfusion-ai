/**
 * 任务级预算：轮数 / 模型调用数 / token 三条维度的唯一算法。
 *
 * 原来错在哪：`maxRounds` 的比较式在编排器里写了三遍（开轮前守卫、报告后判定、计划修正自纠），
 * 三处各自拿 `rounds.length` 现算，谁也说不清「现在到底用了多少」；token 维度只有形参没有记账，
 * 于是 `tokenExhausted` 永远是 false；超限的落点把任务直接标成 `failed`，而 `failed` 是终态——
 * 用户加完预算也接不回去，状态表里那条「budget_exhausted 可恢复」成了死代码。
 *
 * 三条约定：
 * 1. 没写的维度是「不设限」，不是「上限 0」；脏值（0/负数/小数/字符串/NaN）回落默认并留 `dirty` 记录，
 *    配置的笔误不能把任务一开局就判死，也不能悄悄变成「关掉预算」。
 * 2. token 拿不到就记 `unknown`：既不因为「读不到」判超限，也不假装成 0 装作还有余量。
 *    现网主进程确实不回填每轮 token 用量，所以未知是常态，界面必须看得出来。
 * 3. 门禁只回答「还能不能再开一轮」，怎么停、停完能不能续，交给判定与状态表，本模块不碰。
 */

export interface TaskBudget {
  maxRounds?: number;
  maxModelCalls?: number;
  /** 'unknown' 表示这条维度当前无法记账（通道没回报），不是「没有限制」。 */
  maxTokens?: number | 'unknown';
  /** 规整时被丢弃的字段名，供详情与事件核对——预算写错了要看得见，不能静默。 */
  dirty?: string[];
}

export type BudgetDimension = 'rounds' | 'model_calls' | 'tokens';

export interface BudgetUsage {
  rounds?: number;
  /**
   * `null` 表示这条维度当前记不了账（现网没有任务级的模型调用计数），不是「用了 0 次」。
   * 和 tokens 同一条规则：设了上限却读不到用量，只能显示「未记账」，
   * 既不能判超限，也不能假装余量充足。
   */
  modelCalls?: number | null;
  tokens?: number | null;
}

export interface BudgetState {
  exceeded: BudgetDimension[];
  /** 有上限但读不到用量的维度，界面要显示「未记账」而不是「未使用」。 */
  unknowns: BudgetDimension[];
  tokenAccounting: 'known' | 'unknown';
  usage: { rounds: number; modelCalls: number | null; tokens: number | null };
  limits: { maxRounds: number; maxModelCalls: number | null; maxTokens: number | 'unknown' | null };
}

export const DEFAULT_TASK_BUDGET: Required<Pick<TaskBudget, 'maxRounds'>> = { maxRounds: 20 };

/** 维度的中文说法：门禁理由与判定理由共用一份，两处各写一次迟早对不上。 */
export const BUDGET_DIMENSION_TEXT: Record<BudgetDimension, string> = {
  rounds: '轮数',
  model_calls: '模型调用',
  tokens: 'tokens'
};

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** 把用户/模型给的预算规整成可用形状，脏值回落默认并留痕。 */
export function normalizeTaskBudget(raw?: TaskBudget | null): TaskBudget {
  const budget: TaskBudget = { maxRounds: DEFAULT_TASK_BUDGET.maxRounds };
  const dirty: string[] = [];
  if (raw && typeof raw === 'object') {
    if (raw.maxRounds !== undefined) {
      const value = positiveInt(raw.maxRounds);
      if (value === null) dirty.push('maxRounds');
      else budget.maxRounds = value;
    }
    if (raw.maxModelCalls !== undefined) {
      const value = positiveInt(raw.maxModelCalls);
      if (value === null) dirty.push('maxModelCalls');
      else budget.maxModelCalls = value;
    }
    if (raw.maxTokens !== undefined) {
      if (raw.maxTokens === 'unknown') budget.maxTokens = 'unknown';
      else {
        const value = positiveInt(raw.maxTokens);
        if (value === null) dirty.push('maxTokens');
        else budget.maxTokens = value;
      }
    }
  }
  if (dirty.length > 0) budget.dirty = dirty;
  return budget;
}

function counted(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function usageOf(usage?: BudgetUsage | null) {
  return {
    rounds: Number.isFinite(Number(usage?.rounds)) ? Math.trunc(Number(usage?.rounds)) : 0,
    modelCalls: counted(usage?.modelCalls),
    tokens: counted(usage?.tokens)
  };
}

/** 算了多少、超没超、哪条维度根本记不了账——一次算清，编排器与界面都读这份。 */
export function budgetStateOf(input: { budget?: TaskBudget | null; usage?: BudgetUsage | null }): BudgetState {
  const budget = normalizeTaskBudget(input.budget);
  const usage = usageOf(input.usage);
  const exceeded: BudgetDimension[] = [];
  const unknowns: BudgetDimension[] = [];
  const maxTokens = budget.maxTokens === 'unknown' ? null : budget.maxTokens ?? null;

  if (usage.rounds >= (budget.maxRounds ?? DEFAULT_TASK_BUDGET.maxRounds)) exceeded.push('rounds');
  // 设了上限却读不到用量 → 记未知（不判超限，也不当 0）。没设上限的维度不参与核算。
  if (budget.maxModelCalls !== undefined) {
    if (usage.modelCalls === null) unknowns.push('model_calls');
    else if (usage.modelCalls >= budget.maxModelCalls) exceeded.push('model_calls');
  }
  if (maxTokens !== null) {
    if (usage.tokens === null) unknowns.push('tokens');
    else if (usage.tokens >= maxTokens) exceeded.push('tokens');
  } else if (budget.maxTokens === 'unknown') {
    unknowns.push('tokens');
  }

  return {
    exceeded,
    unknowns,
    tokenAccounting: usage.tokens === null ? 'unknown' : 'known',
    usage,
    limits: {
      maxRounds: budget.maxRounds ?? DEFAULT_TASK_BUDGET.maxRounds,
      maxModelCalls: budget.maxModelCalls ?? null,
      maxTokens: budget.maxTokens ?? null
    }
  };
}

/** 「还能不能再开一轮」的唯一答案，附带能直接给人看的理由。 */
export function canOpenRound(input: { budget?: TaskBudget | null; usage?: BudgetUsage | null }): {
  ok: boolean;
  reason: string;
  blockedBy: BudgetDimension[];
} {
  const budget = normalizeTaskBudget(input.budget);
  const state = budgetStateOf({ budget, usage: input.usage });
  const clauses: string[] = [`轮数 ${String(state.usage.rounds)}/${String(budget.maxRounds ?? DEFAULT_TASK_BUDGET.maxRounds)}`];
  if (budget.maxModelCalls !== undefined) {
    clauses.push(state.usage.modelCalls === null
      ? '模型调用已设上限但没有调用计数'
      : `模型调用 ${String(state.usage.modelCalls)}/${String(budget.maxModelCalls)}`);
  }
  if (budget.maxTokens === 'unknown') clauses.push('token 未记账');
  else if (typeof budget.maxTokens === 'number') {
    clauses.push(state.usage.tokens === null
      ? 'token 已设上限但本轮没有回报用量'
      : `tokens ${String(state.usage.tokens)}/${String(budget.maxTokens)}`);
  }
  return { ok: state.exceeded.length === 0, reason: clauses.join('，'), blockedBy: state.exceeded };
}

/** 追加预算只增不减：手滑填了个更小的数不能把正在跑的预算缩掉。 */
export function extendTaskBudget(current: TaskBudget | null | undefined, patch: TaskBudget | null | undefined): TaskBudget {
  const base = normalizeTaskBudget(current);
  const next: TaskBudget = { ...base };
  const dirty = [...(base.dirty ?? [])];
  const merge = (key: 'maxRounds' | 'maxModelCalls', incoming: unknown) => {
    if (incoming === undefined) return;
    const value = positiveInt(incoming);
    if (value === null) {
      dirty.push(key);
      return;
    }
    if (base[key] === undefined || value > base[key]!) next[key] = value;
  };
  merge('maxRounds', patch?.maxRounds);
  merge('maxModelCalls', patch?.maxModelCalls);
  if (patch?.maxTokens !== undefined) {
    const value = patch.maxTokens === 'unknown' ? null : positiveInt(patch.maxTokens);
    if (patch.maxTokens === 'unknown') next.maxTokens = 'unknown';
    else if (value === null) dirty.push('maxTokens');
    else if (typeof base.maxTokens !== 'number' || value > base.maxTokens) next.maxTokens = value;
  }
  if (dirty.length > 0) next.dirty = [...new Set(dirty)];
  else delete next.dirty;
  return next;
}
