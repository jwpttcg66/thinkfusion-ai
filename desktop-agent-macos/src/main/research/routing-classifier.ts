/**
 * 工程空间的路由判定：交给模型，而不是继续补动词表。
 *
 * 为什么改：`shared/workspace.ts` 里的动词表已经涨到 400 多个字符，仍然每踩
 * 一个说法就漏一次（真机：「这个方案」+ 附件 → 待确认）。枚举永远追不上自然
 * 语言，而「这句话要我看还是要我改」恰恰是模型擅长的判断。
 *
 * 三条边界，写在这里防止以后被悄悄放宽：
 *
 * - **只判路由，不干活。** 这个调用只回一个标签 + 一句理由，不读文件、不执行。
 * - **用户明确指定的优先。** 输入框上选了「本次按分析/实施」就不问模型。
 * - **模型不可用就退回规则。** 超时、报错、返回不合法的 JSON，一律用
 *   `routeTask()` 的规则结论，绝不把提问卡住。
 *
 * 归属口径沿用 2026-11-06 的裁决：网页主导时没有可问的模型（也绝不能把分类
 * 问题发进用户网页的会话历史），因此网页主导只用规则。
 */

import type { TaskRouting } from '../../shared/workspace';

export type RoutingKind = 'analysis' | 'execution' | 'clarify';

export interface RoutingVerdict {
  kind: RoutingKind;
  reason: string;
  /**
   * 回答这句话需不需要读工程目录里的文件。
   *
   * `null` = 模型没答这一项（老模型只说 kind，或者只回了 kind+reason），
   * 调用方按规则兜底，不当成 false。
   */
  readsProject: boolean | null;
}

/** 判路由给 4 秒：它是提问前的一次小调用，宁可退回规则也不许拖住提问。 */
export const ROUTING_TIMEOUT_MS = 4_000;

/**
 * 分类器的 system 段。
 *
 * 只描述「怎么分三类」和「只回 JSON」，不给例子堆砌——例子越多，模型越容易
 * 对着例子套而不是对着这句话判。
 */
export const ROUTING_SYSTEM = [
  '你在给一句工程请求分派处理方式，只做分类，不执行、不解释方案。',
  '三类：',
  'analysis —— 只读：看、读、分析、解释、定位、评估、对比、总结、评审、问「为什么/怎么样」。',
  'execution —— 要落到文件或系统动作：修改、实现、新建、删除、重命名、重构、修复、运行命令/测试、截屏、打开应用。',
  'clarify —— 只有在这句话根本看不出要做什么（例如「嗯」「这个」）时才用。',
  '判断顺序：先看有没有改动意图，再看是不是只读；两者同时出现且分不清主次时才算 clarify。',
  '另外判断 read_project：回答这句话要不要读工程目录里的文件。',
  '—— 只问随附文件本身（有多少行、里面写了什么、按这个命令跑）→ false；',
  '—— 要结合工程看（这个模块怎么实现、调用链、改哪里）或没附文件 → true。',
  '只输出一行 JSON，不要代码块、不要多余文字：',
  '{"kind":"analysis|execution|clarify","read_project":true|false,"reason":"不超过20个字的中文理由"}'
].join('\n');

/** 判定时每份附件最多带多少字。判定只需要看出「这是命令清单 / 需求 / 日志」。 */
export const ROUTING_EXCERPT_CHARS = 800;

/**
 * 给模型的那一问。
 *
 * 用户的句子原样放在里面（不改写、不套引导语）。附件报名字，并各带一小段
 * 开头——只报名字时，「把这个 run.sh 跑一遍」和「这个方案」在模型眼里一样，
 * 判定只能靠猜；800 字足够看出文件是命令清单、需求还是日志。
 */
export function buildRoutingQuestion(input: {
  text: string;
  attachmentNames?: readonly string[];
  attachmentExcerpts?: ReadonlyArray<{ name: string; text: string }>;
  hasProject?: boolean;
}): string {
  const lines = [`用户的这句话：${input.text}`];
  const excerpts = (input.attachmentExcerpts ?? []).filter(item => item && item.name);
  const names = (input.attachmentNames ?? []).filter(Boolean);
  if (excerpts.length > 0) {
    lines.push(`随这句话附了 ${String(excerpts.length)} 个文件，文件名与开头如下：`);
    for (const item of excerpts) {
      const body = item.text.replace(/\s+/g, ' ').trim().slice(0, ROUTING_EXCERPT_CHARS);
      lines.push(`—— ${item.name} ——\n${body || '（空文件）'}`);
    }
  } else if (names.length > 0) {
    lines.push(`随这句话附了 ${names.length} 个文件：${names.join('、')}`);
  }
  lines.push(`工程目录：${input.hasProject ? '已选择' : '未选择'}`);
  return lines.join('\n');
}

/**
 * 解析模型回的那一行。
 *
 * 宽容但不瞎猜：只认 JSON 里的 kind，允许被代码块包着、允许前后有多余文字；
 * 认不出就返回 null，由调用方退回规则——不能把解析失败当成「分析」。
 */
export function parseRoutingVerdict(raw: string): RoutingVerdict | null {
  if (typeof raw !== 'string') return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed as { kind?: unknown; reason?: unknown; read_project?: unknown };
  const kind = normalizeKind(value.kind);
  if (!kind) return null;
  const reason = typeof value.reason === 'string' ? value.reason.trim().slice(0, 60) : '';
  return {
    kind,
    reason: reason || '模型未给出理由',
    readsProject: normalizeBoolean(value.read_project)
  };
}

/**
 * `read_project` 的宽松解析：认 true / "true" / "yes" / "是"，认 false / "false" /
 * "no" / "否"，其余（没写、写了个问号、写成 null）一律 null——**不认识就是没答**，
 * 不能默认成 false 把工程证据省掉。
 */
function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (['true', 'yes', 'y', '1', '是', '需要'].includes(text)) return true;
  if (['false', 'no', 'n', '0', '否', '不需要'].includes(text)) return false;
  return null;
}

/** 模型偶尔会写中文或大小写变体，这里收敛成三个固定值。 */
function normalizeKind(value: unknown): RoutingKind | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (['analysis', 'analyse', 'analyze', 'read', '分析', '只读'].includes(text)) return 'analysis';
  if (['execution', 'execute', 'write', '实施', '执行', '改动'].includes(text)) return 'execution';
  if (['clarify', 'unknown', 'ask', '待确认', '澄清'].includes(text)) return 'clarify';
  return null;
}

/**
 * 把模型结论套回 `routeTask()` 的形状。
 *
 * 只改判定与理由，`needsProject` / `stages` 这些由规则算出来的信息保留：
 * 「项目还没选」「先分析再修改」都不是模型该覆盖的事实。
 */
export function applyRoutingVerdict(rule: TaskRouting, verdict: RoutingVerdict): TaskRouting {
  const reason = `模型判定：${verdict.reason}`;
  // 模型没答 read_project 时留空，交给 `needsProjectEvidence()` 按规则兜底；
  // 写成 false 会把工程证据整段省掉，那是最危险的方向。
  const readsProject = verdict.readsProject ?? undefined;
  if (verdict.kind === 'clarify') {
    return {
      ...rule,
      taskKind: 'clarify',
      engineeringKind: 'clarify',
      reason,
      source: 'model',
      signals: [],
      stages: undefined,
      needsClarification: true,
      ...(readsProject === undefined ? {} : { readsProject })
    };
  }
  return {
    ...rule,
    taskKind: verdict.kind === 'analysis' ? 'engineering_analysis' : 'engineering_execution',
    engineeringKind: verdict.kind,
    reason,
    source: 'model',
    signals: [],
    // 模型判成实施时，「先分析再修改」的两阶段记录仍然有效。
    needsClarification: undefined,
    ...(readsProject === undefined ? {} : { readsProject })
  };
}
