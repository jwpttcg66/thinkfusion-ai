/**
 * P6 多轮自主研究：把「还缺什么」变成「再问一遍」。
 *
 * 一轮研究结束时，主导人写完【结论】【一致】【分歧】【存疑】之后，如果这一轮
 * 开了追加研究，它还要交出【待补】——具体缺哪个事实、哪条数字、哪个出处。
 * 这里的三个纯函数负责把那段话变成行动：
 *
 *   parseFollowUps      读【待补】，取出可以拿去问的具体问题；
 *   decideFollowUp      决定这一轮到底还问不问（上限、重复、用户已停）；
 *   buildFollowUpQuestion 把缺口拼成一条**普通问题**发给网页通道。
 *
 * 刻意不做的两件事：
 *
 * - 不自己编问题。主导人没写【待补】就停下来，而不是让程序按关键词猜「可能
 *   还想知道什么」——那等于替用户决定研究方向，还把成本算在他头上。
 * - 不套角色话术。追加研究发出去的仍然是「人话问题」，页面上看到的就是用户
 *   会问的那种句子。曾经那套「你是我在 ThinkFusion 里的研究伙伴…」的回声至今
 *   还要在答案里剥。
 */
import type { ConversationExecutionConfig } from '../../shared/conversation';
import { MAX_FOLLOW_UP_ROUNDS } from '../../shared/conversation';

/** 一轮追加研究最坏要多久：再问一遍所有网页 + 主导人更新一次汇总。 */
export const FOLLOW_UP_ROUND_BUDGET_MS = 3 * 60_000;

/** 每一轮最多补几个缺口。三条以上会被拼成一段长问句，页面答得反而更散。 */
export const MAX_FOLLOW_UP_ITEMS = 3;

/** 整个会话的追加研究轮数（0 = 单轮）。 */
export function followUpBudget(config?: ConversationExecutionConfig | null): number {
  const raw = Number(config?.followUpRounds ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.floor(raw), MAX_FOLLOW_UP_ROUNDS);
}

/** 比较两条缺口是不是同一件事：忽略空白与标点，免得同一句问两遍。 */
export function followUpKey(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：,.!?;:"'“”‘’()（）【】\[\]]/g, '')
    .toLowerCase();
}

/**
 * 从主导人的汇总里取【待补】。
 *
 * 写法容错按真机见过的那几种来：
 * - 段名可能是【待补】【待核实】【继续研究】【还缺什么】；
 * - 多条常挤在同一行（「…？2. …」），先在问号/句号后的编号前断行；
 * - 可能写「无」「没有」「无需补充」；
 * - 段末常粘着站点自己的一句追问（「需要我继续查吗？」），不当成缺口。
 */
export function parseFollowUps(summary: string, limit = MAX_FOLLOW_UP_ITEMS): string[] {
  if (!summary) return [];
  const match = summary.match(/【(?:待补|待核实|待查|继续研究|还缺什么|待补充)】([\s\S]*?)(?:\n【|$)/);
  if (!match) return [];
  const body = match[1];
  if (/^\s*(无|没有|无需|不需要|none|n\/a)(?:[。.！!？?，,、\s]|$)/i.test(body)) return [];
  // 「无」后面直接接一句站点追问的情况，与 parseTopics 同一个坑。
  if (/^\s*(无|没有|无需)(?:你|您|我|他|她|它|这|那|要|需|是|有|会|能)/.test(body)) return [];

  const normalized = body.replace(/([？?。！!])\s*(?=\d{1,2}[.、)）](?!\d))/g, '$1\n');
  const items = normalized
    .split(/\n|\s(?=\d{1,2}[.、)）](?!\d))/)
    .map(line => line.replace(/^(?:[\s\-*]+|\d{1,2}[.、)）]\s*)+/, '').trim())
    // 真机上主导人写的是 markdown：`- **硬件条件**：测试机器具体 CPU 是多少？`。
    // 行首的项目符号被去掉之后，** 还留在原地，发到页面上的问题就带着星号。
    // 这里把强调、行内代码、引号一并剥掉——发出去的应该是一句干净的中文问句。
    .map(line => line
      .replace(/\*\*|__|`/g, '')
      .replace(/^["'“”『「]+|["'“”』」]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(line => line.length >= 4)
    .filter(line => !/^(无|没有|无需|不需要|none|n\/a)[。.]?$/i.test(line))
    // 站点追问：问「要不要我继续」的那种句子不是缺口。
    .filter(line => !/^(需要|要不要|是否)(我|我们)?(继续|再|进一步)/.test(line))
    // 一条缺口问成一整段，页面答得反而更散；超过 160 字就截断。
    .map(line => (line.length > 160 ? `${line.slice(0, 159)}…` : line));

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of items) {
    const key = followUpKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
    if (unique.length >= limit) break;
  }
  return unique;
}

export interface FollowUpDecision {
  go: boolean;
  /** 无论停还是走，都写清理由——它会作为系统消息出现在会话里。 */
  reason: string;
}

/**
 * 这一轮还问不问。
 *
 * 全部条件都是「不问」的方向优先：用户停手、没开、跑满上限、主导人没给缺口、
 * 缺口上一轮已经问过。宁可少问一轮，也不要在用户看不见的地方多花一次生成。
 */
export function decideFollowUp(input: {
  /** 这是第几轮**追加**研究（1 起）。 */
  round: number;
  budget: number;
  items: readonly string[];
  /** 已经问过的缺口（`followUpKey` 形式）。 */
  asked: ReadonlySet<string>;
  cancelled: boolean;
}): FollowUpDecision {
  if (input.cancelled) return { go: false, reason: '你已经停止了这一轮' };
  if (input.budget <= 0) return { go: false, reason: '研究轮次设为单轮' };
  if (input.round > input.budget) return { go: false, reason: `已经跑满 ${input.budget} 轮追加研究` };
  if (input.items.length === 0) return { go: false, reason: '主导人没有指出还缺哪些事实，没有可补的问题' };
  const fresh = input.items.filter(item => !input.asked.has(followUpKey(item)));
  if (fresh.length === 0) return { go: false, reason: '这一轮要补的问题上一轮已经问过，不重复问' };
  return { go: true, reason: `第 ${input.round} 轮追加研究：${fresh.length} 个缺口` };
}

/**
 * 把缺口拼成一条发给网页通道的问题。
 *
 * 它是一句正常人会问的话：先点名原问题（页面可能已经翻页或换了会话，需要这个
 * 锚点），再逐条列出缺口。没有角色行，没有协议标记，没有「请以 JSON 输出」。
 */
export function buildFollowUpQuestion(original: string, items: readonly string[], round: number): string {
  const list = items
    .map((item, index) => `${String(index + 1)}. ${item.trim()}`)
    .join('\n');
  const head = round <= 1
    ? `关于「${original.trim()}」，上一轮的回答里这几处还没有落实：`
    : `关于「${original.trim()}」，上一轮的补充之后，这几处仍然没有落实：`;
  return [head, list, '请直接回答这几点；能给具体数字或出处时，把数字和出处写出来。'].join('\n');
}

/**
 * 追加研究之后让主导人更新汇总。
 *
 * 给的是「你上一轮的汇总」+「这一轮新问到的回答」，要求同样的五段（外加
 * 【待补】），这样下一轮还能继续判断，界面上的结论也还是同一套结构。
 */
export function buildFollowUpSummaryQuestion(input: {
  question: string;
  previousSummary: string;
  round: number;
  answers: ReadonlyArray<{ label: string; text: string }>;
  followUp: boolean;
}): string {
  const body = input.answers
    .map(answer => `${answer.label}：\n${answer.text.trim()}`)
    .join('\n\n');
  return [
    `【用户的问题】\n${input.question.trim()}`,
    `【你上一轮的汇总】\n${input.previousSummary.trim()}`,
    `【第 ${input.round} 轮追加研究问到的新回答】\n${body}`,
    '【现在】把上面这些新回答并进你的汇总，按【结论】【一致】【分歧】【存疑】【辩题】'
      + (input.followUp ? '【待补】' : '')
      + '重新写一遍：新回答支持或推翻了原来的判断，都要明说；新回答没提到的部分保持原样，不要重编。'
  ].join('\n\n');
}

/** 会话里那条「这一轮做了什么」的系统消息。 */
export function followUpNote(round: number, budget: number, items: readonly string[]): string {
  return [
    `第 ${round} 轮追加研究（上限 ${budget} 轮）：${items.join('；')}`,
    '这一轮会把上面几点重新问一遍所有网页通道，再由主导人更新汇总。'
  ].join('\n');
}
