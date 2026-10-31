import type { Claim, Dispute, Gap, Synthesis } from './conversation';

/**
 * Turns several answers into a synthesis, without asking a model to do it.
 *
 * This is deliberately rule-based for the first version. Two reasons:
 *
 * 1. A model-based summariser is how "synthesis" degenerates into "compress N
 *    answers into one", which is the thing this product is supposed to be
 *    better than.
 * 2. Rules can be inspected when they are wrong. "Why did it say these two
 *    agree?" has an answer here; with a model it does not.
 *
 * The output must contain disagreement or missing coverage, or it is not a
 * synthesis — see `degraded` for the honest failure mode.
 */

export interface SynthesisInput {
  channelId: string;
  messageId: string;
  text: string;
}

const NEGATIONS = /(不|没|无|非|别|勿|禁止|避免|无需|不需要|不能|无法|并非|不会)/g;

/** Sentence terminators for Chinese and English. Newlines count too: chat answers are listy. */
const SENTENCE_SPLIT = /(?<=[。！？!?；;])|\n+/;

const MIN_SENTENCE_CHARS = 12;

function sentencesOf(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map(sentence => sentence.replace(/^[\s\-*•\d.、)）]+/, '').trim())
    .filter(sentence => sentence.length >= MIN_SENTENCE_CHARS)
    .filter(sentence => !/^(以下是|希望对你有帮助|如果需要|总结一下[:：]?$)/.test(sentence));
}

/**
 * Feature set for similarity.
 *
 * Chinese has no spaces, and pulling in a segmenter for this is not worth it:
 * character bigrams plus ASCII words are enough to tell "连接复用" apart from
 * "故障恢复", which is all the clustering needs to do.
 */
function features(sentence: string): Set<string> {
  const set = new Set<string>();
  const ascii = sentence.toLowerCase().match(/[a-z0-9_.-]{2,}/g) ?? [];
  for (const word of ascii) set.add(word);

  const cjk = sentence.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i < cjk.length - 1; i += 1) set.add(cjk.slice(i, i + 2));

  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function negationCount(sentence: string): number {
  return (sentence.match(NEGATIONS) ?? []).length;
}

function numbersIn(sentence: string): string[] {
  return sentence.match(/\d[\d,_.]*/g) ?? [];
}

interface Unit {
  channelId: string;
  messageId: string;
  text: string;
  features: Set<string>;
}

interface Cluster {
  units: Unit[];
  channels: Set<string>;
}

/** Union-find over sentence similarity, across channels only. */
function clusterUnits(units: Unit[]): Cluster[] {
  const parent = units.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])));

  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      // Same channel never merges: one answer repeating itself is not agreement.
      if (units[i].channelId === units[j].channelId) continue;
      if (jaccard(units[i].features, units[j].features) >= 0.34) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[b] = a;
      }
    }
  }

  const groups = new Map<number, Unit[]>();
  units.forEach((unit, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), unit]);
  });

  return [...groups.values()].map(group => ({
    units: group,
    channels: new Set(group.map(unit => unit.channelId))
  }));
}

/** The shortest unit is usually the least hedged, which reads best as a claim. */
function representative(cluster: Cluster): Unit {
  return [...cluster.units].sort((a, b) => a.text.length - b.text.length)[0];
}

function toClaim(cluster: Cluster): Claim {
  const head = representative(cluster);
  return {
    text: head.text,
    sources: cluster.units.map(unit => ({ channelId: unit.channelId, messageId: unit.messageId })),
    // Anything that looks like a figure is kept as evidence; hedged prose is not.
    evidence: cluster.units.flatMap(unit => numbersIn(unit.text).map(number => `${unit.channelId}: ${number}`))
  };
}

/**
 * Disagreement is only claimed when there is something concrete to point at: an
 * opposite negation, or two different numbers for the same thing. "These two
 * paragraphs feel different" is not a finding.
 */
function findDispute(cluster: Cluster): Dispute | null {
  const units = cluster.units;
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const a = units[i];
      const b = units[j];
      if (a.channelId === b.channelId) continue;

      const negated = negationCount(a.text) > 0 !== negationCount(b.text) > 0;
      const numsA = numbersIn(a.text).join(',');
      const numsB = numbersIn(b.text).join(',');
      const numericClash = numsA !== '' && numsB !== '' && numsA !== numsB;

      if (negated || numericClash) {
        return {
          topic: representative(cluster).text.slice(0, 40),
          positions: [
            { channelId: a.channelId, stance: a.text },
            { channelId: b.channelId, stance: b.text }
          ],
          pivot: negated ? '一方带否定词，另一方没有' : `数字不一致：${numsA} vs ${numsB}`
        };
      }
    }
  }
  return null;
}

/**
 * Coverage gaps: a term that two channels found worth mentioning but a third
 * did not. That is checkable, unlike "what nobody thought of", which this
 * version cannot know.
 */
function findGaps(units: Unit[], channelCount: number): Gap[] {
  const byTerm = new Map<string, Set<string>>();
  for (const unit of units) {
    for (const feature of unit.features) {
      if (feature.length < 2) continue;
      if (!/^[a-z0-9]/.test(feature) && feature.length < 2) continue;
      const set = byTerm.get(feature) ?? new Set<string>();
      set.add(unit.channelId);
      byTerm.set(feature, set);
    }
  }

  const gaps: Gap[] = [];
  for (const [term, channels] of byTerm) {
    if (channels.size >= 2 && channels.size < channelCount) {
      gaps.push({ topic: term, why: `${channels.size}/${channelCount} 个通道提到，其余没有涉及` });
    }
  }

  // Keep the widest gaps, and drop terms that are substrings of a kept term.
  gaps.sort((a, b) => b.topic.length - a.topic.length);
  const kept: Gap[] = [];
  for (const gap of gaps) {
    if (kept.some(item => item.topic.includes(gap.topic) || gap.topic.includes(item.topic))) continue;
    kept.push(gap);
    if (kept.length >= 5) break;
  }
  return kept;
}

export function synthesize(inputs: SynthesisInput[]): Synthesis {
  const units: Unit[] = inputs.flatMap(input =>
    sentencesOf(input.text).map(text => ({
      channelId: input.channelId,
      messageId: input.messageId,
      text,
      features: features(text)
    }))
  );

  const channelCount = new Set(inputs.map(input => input.channelId)).size;

  // Nothing to compare: one channel, or text we could not segment. Saying so is
  // the point — a fake consensus is worse than an honest "couldn't".
  if (channelCount < 2 || units.length < 2) {
    return {
      consensus: [],
      disputed: [],
      unique: [],
      gaps: [],
      recommendation: '只有一个通道给出了回答，没有可比较的对象。以下内容未做交叉验证。',
      degraded: true
    };
  }

  const clusters = clusterUnits(units);
  const consensus: Claim[] = [];
  const unique: Claim[] = [];
  const disputed: Dispute[] = [];

  for (const cluster of clusters) {
    if (cluster.channels.size >= 2) {
      consensus.push(toClaim(cluster));
      const dispute = findDispute(cluster);
      if (dispute) disputed.push(dispute);
    } else {
      unique.push(toClaim(cluster));
    }
  }

  const gaps = findGaps(units, channelCount);

  // Degraded means "we produced a list, not a synthesis": no claim was shared by
  // two channels. The UI must label it instead of presenting it as agreement.
  const degraded = consensus.length === 0;

  return {
    consensus: consensus.slice(0, 8),
    disputed: disputed.slice(0, 5),
    unique: unique.slice(0, 8),
    gaps,
    recommendation: buildRecommendation(consensus, disputed, gaps, channelCount, degraded),
    degraded
  };
}

function buildRecommendation(
  consensus: Claim[],
  disputed: Dispute[],
  gaps: Gap[],
  channelCount: number,
  degraded: boolean
): string {
  if (degraded) {
    return `${channelCount} 个通道的回答几乎没有重合，无法形成共识。请直接阅读下方各自的原话，并注意这本身就是一种信号：问题可能没有标准答案，或者提问需要收窄。`;
  }

  const head = `多数通道（${consensus[0].sources.length} 处提及）一致认为：${consensus[0].text}`;
  const parts = [head];

  if (disputed.length > 0) {
    parts.push(`但 ${disputed.length} 处存在分歧，集中在「${disputed[0].topic}」，建议按分歧点逐条核对，不要直接采信多数。`);
  }
  if (gaps.length > 0) {
    parts.push(`另有 ${gaps.length} 个要点覆盖不全（例如「${gaps[0].topic}」），这是缺失而不是共识。`);
  }
  if (disputed.length === 0 && gaps.length === 0) {
    parts.push('未发现明显冲突，但这只说明各通道没有互相矛盾，不代表结论已经被验证。');
  }

  return parts.join('');
}
