import type { ClaimKind, ClaimSpan, EvidenceKind } from '../../shared/fusion';
import { features, figuresIn, negationCount, topicsOf } from '../../shared/synthesizer';

/**
 * 把一段回答切成观点。
 *
 * 这一步只做一件事：**把「一段话」变成「可以被单独判断真假的句子」**，并且记下
 * 每一句在原话里的位置。
 *
 * 这里刻意不做两件事：
 *
 * 1. 不判断谁支持谁。抽取器一旦知道关系，它就会开始「为了凑成一组关系」而切句。
 * 2. 不判断哪句是对的。它只记录「这句话带了什么」——类型、前提、数字、出处痕迹。
 *
 * 规则而不是模型：`docs/ARCHITECTURE.md` 11.6 的顺序是「V1/V2 纯 TypeScript」。
 * 一个模型说「这句是建议」，错了没人能复核；一条正则说「这句里有『建议』」，
 * 任何人都能打开原话指着它同意或反驳。
 */

export interface EvidenceDraft {
  excerpt: string;
  kind: EvidenceKind;
  /** 相对整段回答的偏移，和 claim 的 span 同一个坐标系。 */
  start: number;
  end: number;
  /** 凭什么认成这种材料：数字 / 官方文档 / 源码 / 压测…，用于给人看。 */
  cue: string;
}

export interface ExtractedClaim {
  id: string;
  channelId: string;
  messageId: string;
  text: string;
  span: ClaimSpan;
  kind: ClaimKind;
  /** 判成这个类型的依据，保留原词。 */
  kindCue: string;
  assumptions: string[];
  negation: boolean;
  figures: string[];
  topics: Set<string>;
  /** 整句 bigram，用于相似度。 */
  features: Set<string>;
  evidence: EvidenceDraft[];
}

/** 句子边界。换行也算：聊天里的回答是列表式的。 */
const BOUNDARY = /[。！？!?；;\n]/g;

/** 和 `shared/synthesizer.ts` 的 `sentencesOf` 同一条门槛，理由也一样。 */
const MIN_CLAIM_CHARS = 12;

/** 收尾话、开场白。它们不是观点，而且每条回答里都有。 */
const BOILERPLATE = /^(以下是|以上就是|希望对你有帮助|如果需要|总结一下[:：]?$|以上[:：]?$|还有别的|欢迎继续)/;

const QUESTION = /[？?]\s*$|^(请问|是否|为什么|为何|如何|怎么|能否|可否|哪一个|哪个)/;

/** 前提句：这一句本身就是条件，而不是带条件的断言。 */
const PREMISE = /^(假设|假定|前提是|如果|假如|倘若)/;

const PREDICTION = /(将会|预计|预测|未来|下一个版本|即将|迟早|最终会|明年|下个季度)/;

const RECOMMENDATION = /(建议|推荐|应该|必须|最好|务必|优先|尽量|可以考虑|需要先|切记|不要忘记)/;

const INFERENCE = /(可能|大概|也许|推测|估计|看起来|似乎|这说明|意味着|由此可见|大概率|很可能|因此|所以)/;

/**
 * 条件从句。抽出来是因为它**必须成为一条记录**：
 * 「在 Redis 6 之前没有多线程 IO」和「Redis 6 有多线程 IO」在正文里只差几个字，
 * 一旦条件被当成形容词，两条观点就会互相矛盾而没人知道为什么。
 */
const CONDITIONS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(?:如果|假如|假设|倘若)[^，。；,;]{2,30}/g, label: '前提' },
  { pattern: /在[^，。；,;]{1,24}(?:之前|之后|情况下|时|以后)/g, label: '范围' },
  { pattern: /(?:取决于|仅在)[^，。；,;]{2,24}/g, label: '条件' },
  { pattern: /前提是[^，。；,;]{2,30}/g, label: '前提' }
];

/**
 * 出处的痕迹。本地算法**打不开这些材料**，只能认出「作者提到了它」——
 * 这正是证据强度的第一个维度（可核验性）能拿分的地方，也是它拿不到满分的地方。
 */
const CITATIONS: Array<{ pattern: RegExp; kind: EvidenceKind; cue: string }> = [
  { pattern: /(官方文档|官方手册|官网|RFC|规范里|标准规定)/g, kind: 'official-doc', cue: '官方文档' },
  { pattern: /(源码|代码里|实现里|仓库里|看实现)/g, kind: 'source-code', cue: '源码' },
  { pattern: /(论文|研究中|paper|文献)/gi, kind: 'paper', cue: '论文' },
  { pattern: /(压测|基准测试|benchmark|实测|跑过|性能测试)/gi, kind: 'benchmark', cue: '实测数据' },
  { pattern: /(博客|文章里|帖子|社区里)/g, kind: 'blog', cue: '博客文章' }
];

/** 数字 + 单位，或长整数。和综合那套用的是同一个口径：单个位数不算事实。 */
const FIGURE = /(\d+(?:\.\d+)?)\s*(%|％|倍|秒|毫秒|分钟|小时|天|周|个月|月|年|万|亿|核|gb|mb|kb|ms)/gi;
const BARE_LONG_NUMBER = /\b\d{3,}\b/g;

/**
 * 一段回答切成带位置的句子。
 *
 * 不能直接用 `text.split(/[。！？]/)`：那样只有句子，没有偏移，`span` 就只能是
 * 一个假的 `{ messageId }`。这里按边界扫描，每段都记住自己在原文里的起止。
 */
export function segmentsOf(text: string): Array<{ text: string; start: number; end: number }> {
  const segments: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;
  BOUNDARY.lastIndex = 0;

  const push = (from: number, to: number): void => {
    const raw = text.slice(from, to);
    // 列表符号、序号不属于观点本身，但也不该把偏移算错：只把起点往后挪。
    const lead = raw.match(/^[\s\-*•\d.、)）]+/)?.[0].length ?? 0;
    const trimmedEnd = raw.replace(/\s+$/, '').length;
    const value = raw.slice(lead, trimmedEnd);
    if (!value) return;
    segments.push({ text: value, start: from + lead, end: from + lead + value.length });
  };

  for (let match = BOUNDARY.exec(text); match; match = BOUNDARY.exec(text)) {
    push(cursor, match.index + 1);
    cursor = match.index + 1;
  }
  push(cursor, text.length);

  const kept = segments.filter(item => item.text.length >= MIN_CLAIM_CHARS && !BOILERPLATE.test(item.text));
  // 短回答也要留下来：一句话的回答（「3 + 5 = 8」）切完是空的，而它确实是这一轮
  // 唯一的观点。宁可留着整段，也不能让一个通道凭空消失。
  if (kept.length === 0 && segments.length > 0) return [segments[0]];
  return kept;
}

function kindOf(text: string): { kind: ClaimKind; cue: string } {
  const question = text.match(QUESTION);
  if (question) return { kind: 'question', cue: question[0] };

  // 前提句优先于建议：一句「如果连接池满了就会超时」不是在给建议，它在给条件。
  if (PREMISE.test(text)) return { kind: 'assumption', cue: PREMISE.exec(text)?.[0] ?? '前提' };

  const prediction = text.match(PREDICTION);
  if (prediction) return { kind: 'prediction', cue: prediction[0] };

  const recommendation = text.match(RECOMMENDATION);
  if (recommendation) return { kind: 'recommendation', cue: recommendation[0] };

  const inference = text.match(INFERENCE);
  if (inference) return { kind: 'inference', cue: inference[0] };

  return { kind: 'fact', cue: '陈述句' };
}

function assumptionsOf(text: string): string[] {
  const found: string[] = [];
  for (const { pattern } of CONDITIONS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[0].trim();
      if (value && !found.includes(value)) found.push(value);
    }
  }
  return found;
}

/** 引文所在的那一小段：取短语所在的分句，太长就截断。 */
function clauseAround(text: string, index: number, length: number): { text: string; start: number } {
  const before = text.lastIndexOf('，', index);
  const comma = text.indexOf('，', index + length);
  const start = before + 1;
  const end = comma === -1 ? text.length : comma;
  const clause = text.slice(start, end).trim();
  const offset = text.indexOf(clause, start);
  return { text: clause.length > 48 ? `${clause.slice(0, 48)}…` : clause, start: offset === -1 ? index : offset };
}

function evidenceOf(text: string, base: number): EvidenceDraft[] {
  const drafts: EvidenceDraft[] = [];

  for (const citation of CITATIONS) {
    citation.pattern.lastIndex = 0;
    for (const match of text.matchAll(citation.pattern)) {
      const index = match.index ?? 0;
      const clause = clauseAround(text, index, match[0].length);
      drafts.push({
        excerpt: clause.text,
        kind: citation.kind,
        start: base + clause.start,
        end: base + clause.start + clause.text.length,
        cue: citation.cue
      });
      break; // 一句话里同类出处只留第一处，`innerText` 会把同一句重复带出来。
    }
  }

  const figures = new Set<string>();
  for (const pattern of [FIGURE, BARE_LONG_NUMBER]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      const value = match[0];
      if (figures.has(value)) continue;
      figures.add(value);
      drafts.push({
        excerpt: value,
        kind: 'model-claim',
        start: base + index,
        end: base + index + value.length,
        // 数字能核对，但没有出处；所以它算可核验，不算权威。
        cue: `数字 ${value}`
      });
    }
  }

  return drafts;
}

export function extractClaims(input: { channelId: string; messageId: string; text: string }): ExtractedClaim[] {
  return segmentsOf(input.text)
    .map((segment, index) => ({ segment, index }))
    // 收尾话/开场白不是观点。放在这里再挡一道：segmentsOf 只管切句，
    // 「以下是……」这种长得像观点的开场白会在切句后漏过来。
    .filter(({ segment }) => !BOILERPLATE.test(segment.text.trim()))
    .map(({ segment, index }) => {
    const { kind, cue } = kindOf(segment.text);
    return {
      id: `${input.messageId}#${String(index)}`,
      channelId: input.channelId,
      messageId: input.messageId,
      text: segment.text,
      span: { messageId: input.messageId, start: segment.start, end: segment.end },
      kind,
      kindCue: cue,
      assumptions: assumptionsOf(segment.text),
      negation: negationCount(segment.text) > 0,
      figures: figuresIn(segment.text),
      topics: topicsOf(segment.text),
      features: features(segment.text),
      evidence: evidenceOf(input.text.slice(segment.start, segment.end), segment.start)
    };
    });
}
