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

/**
 * Bigrams that are grammar rather than subject matter.
 *
 * These are the ones that made "两个通道都在讲同一件事" unmeasurable: 常见、建议、
 * 主要 show up in every Chinese answer regardless of topic, so treating them as
 * evidence of overlap is noise. Everything else — 连接、数据、上限、超时 — is
 * real subject matter and is kept.
 */
const STOP_BIGRAMS = new Set([
  '的是', '不是', '可以', '这个', '那个', '一个', '如果', '以及', '是否', '就是', '已经',
  '没有', '通常', '这样', '那么', '这些', '那些', '所以', '但是', '因为', '由于', '然后',
  '并且', '而且', '我们', '你们', '他们', '它们', '什么', '怎么', '为什', '一些', '来说',
  '的话', '时候', '情况', '方法', '方式', '问题', '这里', '那里', '同时', '以上', '以下',
  '或者', '还是', '其实', '基本', '主要', '建议', '注意', '常见', '一般', '例如', '比如',
  '第一', '第二', '第三', '首先', '其次', '最后', '总之', '来说', '起来', '出来', '下来',
  // Verbs: the boundary rule lets a clause start with one, but "导致" tells a
  // reader nothing about what the two answers are about.
  '导致', '造成', '引起', '产生', '出现', '使用', '进行', '存在', '属于', '包括',
  '表示', '认为', '说明', '应该', '可能', '无法', '不能', '不要',
  // Determiners and quantities: "每个" got through the boundary rule and turned
  // up in the topic list as if it were a subject.
  '每个', '各种', '所有', '大量', '多数', '部分', '若干', '多个', '一次'
]);

/**
 * A figure with a unit, or a long bare number. These are the only claims a
 * rule-based pass can actually verify: "两边都写了 80%" is checkable in a way
 * that "these two paragraphs feel alike" never is.
 *
 * A bare single digit is deliberately excluded — "3 个原因" is a count, not a
 * fact about the world.
 */
const FIGURE = /(\d+(?:\.\d+)?)\s*(%|％|倍|秒|毫秒|分钟|小时|天|周|个月|月|年|万|亿|核|gb|mb|kb|ms)/gi;
const BARE_LONG_NUMBER = /\b\d{3,}\b/g;

/** Longest CJK phrase kept as a topic. Beyond this it is a sentence, not a topic. */
const MAX_PHRASE_CHARS = 5;

/**
 * Verbs and determiners that can open a clause but never open a topic.
 *
 * "导致连接" begins after a comma, so the boundary rule lets it through — but a
 * topic list headed by a verb describes the sentence, not the subject. Same for
 * "一个常见原", which is a slice of "的一个常见原因".
 */
const NOISE_PREFIXES = [
  '导致', '造成', '引起', '产生', '出现', '使用', '进行', '存在', '属于', '包括',
  '表示', '认为', '说明', '应该', '可能', '无法', '不能', '不要', '需要', '例如',
  '一个', '这个', '那个', '这些', '那些', '这种', '那种', '什么', '怎么', '如果',
  '因为', '所以', '但是', '而且', '以及', '或者', '首先', '其次', '最后'
];

/**
 * Characters that cannot begin or end a topic.
 *
 * Without this the shared-phrase list fills up with "到数据库", "是连接",
 * "的上限" — correct substrings, useless to a reader.
 */
const EDGE_CHARS = new Set(
  '的了和与及或是就都也还很更最在到从把被让给对为以而且但并则若因所之其此该这那再又却才们'
);

/**
 * Characters that cannot appear *anywhere* inside a topic.
 *
 * This is the rule that finally kills the fragments. "高的一个常" and
 * "连接数持续" are made of a particle plus its neighbours; a Chinese term does
 * not contain 的 / 了 / 是 / 在 / 到, so anything that does is a clause, not a term.
 */
const PARTICLES = new Set('的了地得着过和与及或是就在把被让给对为以而且但并则若因所之其此该这那再又却才们到从');

/** "三个" is a count, not a subject. */
const NUMERAL_START = /^[一二三四五六七八九十两几半]/;

/**
 * Where a topic is allowed to begin: at the start of a run, or right after one
 * of these.
 *
 * A phrase that starts mid-word is a sliding-window artifact, not a term. Without
 * this rule "池配置过大" and "设置过大" produce the shared phrase "置过大", which
 * reads as garbage and appears in neither answer as a word.
 */
const BOUNDARY_CHARS = new Set(
  '的了地得着过和与及或是就在把被让给对为以而且但并则若因所之其此该这那再又却才们到从' +
    '有没不无会能可要需应使得未已即故便令如按' +
    // Adverbs that precede a noun phrase ("归还连接池", "都很关键"). 最 is left
    // out on purpose: it would let "大连接数" out of "最大连接数".
    '都也还很更' +
    // Verbs that take an object: "确认连接池" has to yield 连接池, and 认 is not
    // a particle. Deliberately excludes 配 and 设 — they would re-admit "置过大",
    // the fragment this rule exists to reject.
    '认看查核调测算读写取存加减提降检用做换装挂开关停启跑走进出'
);

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

/** Figures worth comparing: 80%, 30 秒, 10000, 2 倍. */
function figuresIn(sentence: string): string[] {
  const found = new Set<string>();
  for (const match of sentence.matchAll(FIGURE)) found.add(`${match[1]}${match[2].toLowerCase()}`);
  for (const match of sentence.match(BARE_LONG_NUMBER) ?? []) found.add(match);
  return [...found];
}

/** ASCII identifiers (max_connections, processlist) plus CJK phrases. */
function topicsOf(sentence: string): Set<string> {
  const set = new Set<string>();
  for (const word of sentence.toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) ?? []) set.add(word);

  // Runs, not one glued string: `replace(/[^\u4e00-\u9fa5]/g, '')` would splice
  // "空闲连接，再确认连接池" into "空闲连接连接池" and then report a phrase
  // that neither answer ever wrote. Splitting at punctuation keeps every phrase
  // a real substring of a real sentence.
  for (const run of sentence.split(/[^\u4e00-\u9fa5]+/)) {
    for (let start = 0; start < run.length; start += 1) {
      if (start > 0 && !BOUNDARY_CHARS.has(run[start - 1])) continue;
      for (let length = 2; length <= MAX_PHRASE_CHARS && start + length <= run.length; length += 1) {
        const candidate = run.slice(start, start + length);
        if (length === 2 && STOP_BIGRAMS.has(candidate)) continue;
        if (NOISE_PREFIXES.some(prefix => candidate.startsWith(prefix))) continue;
        if (EDGE_CHARS.has(candidate[0]) || EDGE_CHARS.has(candidate[candidate.length - 1])) continue;
        if (NUMERAL_START.test(candidate)) continue;
        // A term never contains a particle: this is what separates 连接池 from
        // 高的一个常, both of which are substrings of a real sentence.
        if ([...candidate].some(char => PARTICLES.has(char))) continue;
        set.add(candidate);
      }
    }
  }
  return set;
}

interface Unit {
  channelId: string;
  messageId: string;
  text: string;
  /** Bigrams for whole-sentence similarity. */
  features: Set<string>;
  /** Stop-filtered bigrams and identifiers, for "are these about the same thing". */
  topics: Set<string>;
  figures: string[];
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

function sharesTopic(a: Unit, b: Unit): boolean {
  for (const topic of a.topics) if (b.topics.has(topic)) return true;
  return false;
}

/**
 * Words a one-line answer uses to say nothing. 「3 + 5 = 8」, 「3 + 5 的结果是
 * 8。」 and 「3 + 5 = 8。回答已完成」 are the same answer written three ways; the
 * difference is all in here.
 */
const FILLER = /(的结果是|结果是|答案是|回答已完成|已完成|所以|因此|等于|就是|答案|回答|是|为|的|了)/g;

/**
 * The numbers of an answer that is only a conclusion, or `null`.
 *
 * `topicsOf` finds 「结果」 in 「3 + 5 的结果是 8。」, so a topic test cannot tell
 * a bare calculation from prose. What separates them is how much meaning is left
 * once the numbers and the filler are removed: a real sentence keeps words, and
 * this keeps nothing.
 *
 * A negation disqualifies the answer outright. 「3 + 5 不等于 8」 leaves only
 * 「不」, which is short enough to pass, and treating it as the same answer as
 * 「3 + 5 = 8」 would be the worst thing this file could do.
 */
function conclusionOf(text: string): string[] | null {
  // `NEGATIONS` is a /g regex; `match` resets its lastIndex, `test` advances it.
  if ((text.match(NEGATIONS) ?? []).length > 0) return null;
  const numbers = numbersIn(text).map(number => number.replace(/[,_]/g, ''));
  if (numbers.length === 0) return null;

  const leftover = text
    .replace(/\d[\d,_.]*/g, '')
    .replace(FILLER, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
  return leftover.length <= 2 ? numbers : null;
}

/**
 * Agreement between answers that are nothing but a conclusion.
 *
 * 「3 + 5 = 8」 has nothing for `topicsOf` to find — no Chinese phrase, no
 * identifier — and `figuresIn` ignores a bare single digit, so three channels
 * answering this way reached `clusterUnits` with no feature and no figure,
 * landed in `unique` one by one, and the card said 「几乎没有重合」 above three
 * identical results.
 *
 * Prose never takes this path: `conclusionOf` refuses an answer that still has
 * meaning once the numbers and the filler are gone, and refuses a negation.
 */
function numericAnswers(units: Unit[]): { claims: Claim[]; covered: Unit[] } {
  const groups = new Map<string, Unit[]>();
  for (const unit of units) {
    const numbers = conclusionOf(unit.text);
    if (!numbers) continue;
    // The last number is the answer: 「8」 and 「3 + 5 = 8」 both end at 8, and
    // that is the same finding. The earlier numbers are the question restated.
    const key = numbers[numbers.length - 1];
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), unit]);
  }

  const claims: Claim[] = [];
  const covered: Unit[] = [];
  for (const [answer, group] of groups) {
    const byChannel = new Map<string, Unit>();
    for (const unit of group) if (!byChannel.has(unit.channelId)) byChannel.set(unit.channelId, unit);
    if (byChannel.size < 2) continue;

    const distinct = [...byChannel.values()];
    const head = distinct.reduce((a, b) => (a.text.length <= b.text.length ? a : b));
    covered.push(...distinct);
    claims.push({
      text: head.text,
      sources: distinct.map(unit => ({ channelId: unit.channelId, messageId: unit.messageId })),
      evidence: distinct.map(unit => `${unit.channelId}: ${answer}`)
    });
  }
  return { claims, covered };
}

/**
 * The one form of agreement a rule-based pass can actually verify.
 *
 * Two channels writing the same figure is checkable — you can open both answers
 * and look. But a figure alone is not agreement: both mentioning "2024 年" says
 * nothing about whether they agree. So the two sentences also have to share a
 * topic bigram, which keeps unrelated mentions from being dressed up as
 * consensus.
 */
function figureConsensus(units: Unit[]): Claim[] {
  const byFigure = new Map<string, Unit[]>();
  for (const unit of units) {
    for (const figure of unit.figures) {
      byFigure.set(figure, [...(byFigure.get(figure) ?? []), unit]);
    }
  }

  const claims: Claim[] = [];
  for (const [figure, holders] of byFigure) {
    if (new Set(holders.map(unit => unit.channelId)).size < 2) continue;

    for (let i = 0; i < holders.length; i += 1) {
      let paired = false;
      for (let j = i + 1; j < holders.length; j += 1) {
        const a = holders[i];
        const b = holders[j];
        if (a.channelId === b.channelId || !sharesTopic(a, b)) continue;

        const head = a.text.length <= b.text.length ? a : b;
        claims.push({
          text: head.text,
          sources: [a, b].map(unit => ({ channelId: unit.channelId, messageId: unit.messageId })),
          evidence: [a, b].map(unit => `${unit.channelId}: ${figure}`)
        });
        paired = true;
        break;
      }
      if (paired) break;
    }
  }
  return claims;
}

/**
 * What every channel kept talking about, even when no sentence matched.
 *
 * This exists to stop the code from lying. Two answers can cover exactly the
 * same ground in completely different words, and telling the user "几乎没有
 * 重合" in that case is simply false. Sentence similarity cannot see it; shared
 * subject matter can.
 */
function sharedOverlap(units: Unit[], channelCount: number): string[] {
  const figures = new Map<string, Set<string>>();
  const words = new Map<string, Set<string>>();
  const phrases = new Map<string, Set<string>>();

  const record = (table: Map<string, Set<string>>, item: string, channelId: string): void => {
    const set = table.get(item) ?? new Set<string>();
    set.add(channelId);
    table.set(item, set);
  };

  for (const unit of units) {
    for (const figure of unit.figures) record(figures, figure, unit.channelId);
    for (const topic of unit.topics) {
      const isWord = /^[a-z]/.test(topic);
      record(isWord ? words : phrases, topic, unit.channelId);
    }
  }

  const everywhere = (table: Map<string, Set<string>>): string[] =>
    [...table.entries()].filter(([, channels]) => channels.size >= channelCount).map(([item]) => item);

  const kept: string[] = [];
  const take = (item: string, skipIfContained: boolean): void => {
    if (kept.length >= 6) return;
    if (skipIfContained && kept.some(other => other.includes(item))) return;
    kept.push(item);
  };

  // Figures first: a shared number is the most concrete thing two answers can
  // have in common. Then the longest Chinese phrases — 连接池 outranks 连接, so
  // the containment check keeps only the widest one. Identifiers last: they are
  // usually library names and read as noise to anyone not debugging.
  everywhere(figures).forEach(item => take(item, false));
  everywhere(phrases)
    .sort((a, b) => b.length - a.length)
    .forEach(item => take(item, true));
  everywhere(words).forEach(item => take(item, false));
  return kept;
}

/**
 * Channels that wrote the same answer, character for character.
 *
 * The one form of agreement no heuristic is needed for, and the one the
 * sentence-level rules were missing. "3+5" answered "8" by three channels
 * produced three one-sentence units with no shared bigram and no figure, so
 * every one of them landed in `unique` and the synthesis reported "几乎没有
 * 重合" — over three identical answers. Exact equality is checkable by eye,
 * which is the bar this module holds itself to.
 *
 * Compared after removing whitespace and trailing punctuation, because the page
 * decides where the line breaks go, not the model.
 */
function identicalAnswers(inputs: SynthesisInput[]): Claim[] {
  const groups = new Map<string, SynthesisInput[]>();
  for (const input of inputs) {
    const key = input.text.replace(/\s+/g, '').replace(/[。．.!！?？]+$/, '').toLowerCase();
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), input]);
  }

  const claims: Claim[] = [];
  for (const group of groups.values()) {
    const channels = new Set(group.map(item => item.channelId));
    if (channels.size < 2) continue;
    claims.push({
      text: group[0].text.trim(),
      sources: group.map(item => ({ channelId: item.channelId, messageId: item.messageId })),
      evidence: [`${String(channels.size)} 个通道给出完全相同的回答`]
    });
  }
  return claims;
}

/**
 * One answer as the units the synthesis compares.
 *
 * Usually this is its sentences. But `sentencesOf` drops anything under twelve
 * characters, and a short answer is all it has: 「3 + 5 = 8」 is nine. So three
 * channels answering the same question produced one unit between them and the
 * card said 「只有一个通道给出了回答」 — the answers were in the pane, in the
 * conversation, and missing only here. An answer that cannot be segmented is
 * still an answer; keep it whole rather than dropping the channel.
 */
function unitsOf(input: SynthesisInput): Unit[] {
  const sentences = sentencesOf(input.text);
  const texts = sentences.length > 0 ? sentences : [input.text.trim()].filter(Boolean);

  return texts.map(text => ({
    channelId: input.channelId,
    messageId: input.messageId,
    text,
    features: features(text),
    topics: topicsOf(text),
    figures: figuresIn(text)
  }));
}

export function synthesize(inputs: SynthesisInput[]): Synthesis {
  const units: Unit[] = inputs.flatMap(unitsOf);

  const channelCount = new Set(inputs.map(input => input.channelId)).size;

  // Identical answers first: no heuristic can beat equality, and the sentence
  // pass cannot see it on a one-line reply. Everything else about this function
  // is a guess; this is not.
  const identical = identicalAnswers(inputs);
  if (identical.length > 0) {
    const claimed = new Set(identical.flatMap(claim => claim.sources.map(source => source.messageId)));
    const unique: Claim[] = inputs
      .filter(input => !claimed.has(input.messageId))
      .map(input => ({
        text: input.text.trim(),
        sources: [{ channelId: input.channelId, messageId: input.messageId }],
        evidence: ['只有这个通道这样回答']
      }));
    return {
      consensus: identical,
      disputed: [],
      unique,
      gaps: [],
      overlap: [],
      recommendation: buildRecommendation(identical, [], [], [], channelCount, false),
      degraded: false
    };
  }

  // Nothing to compare. Which of the two reasons it is matters: saying 「只有
  // 一个通道」 when three answered is a false statement about what happened,
  // and it sends the user looking for a page that never failed.
  if (channelCount < 2) {
    return {
      consensus: [],
      disputed: [],
      unique: [],
      gaps: [],
      overlap: [],
      recommendation: '只有一个通道给出了回答，没有可比较的对象。以下内容未做交叉验证。',
      degraded: true
    };
  }

  if (units.length < 2) {
    return {
      consensus: [],
      disputed: [],
      unique: [],
      gaps: [],
      overlap: [],
      recommendation: `${String(channelCount)} 个通道都给出了回答，但没有可以逐句对比的内容。请直接看下方各自的原话。`,
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

  // Agreement that a sentence-similarity pass cannot see: same numbers for the
  // answers that are only numbers, and a shared figure for the rest. Deduped by
  // text so the same sentence cannot arrive twice.
  const numeric = numericAnswers(units);
  for (const claim of [...numeric.claims, ...figureConsensus(units)]) {
    if (consensus.some(item => item.text === claim.text)) continue;
    consensus.push(claim);
  }

  const gaps = findGaps(units, channelCount);
  const overlap = sharedOverlap(units, channelCount);

  // A sentence already quoted as consensus must not also appear as "only one
  // channel said this" — the same text in both columns reads as a bug. The same
  // goes for an answer counted above: 「3 + 5 的结果是 8。」 is the same finding
  // as 「3 + 5 = 8」, and listing it under 「只有这个通道这样回答」 next to that
  // consensus is how the card contradicts itself.
  const counted = new Set(numeric.covered.map(unit => unit.text));
  const soloed = unique.filter(
    claim => !counted.has(claim.text) && !consensus.some(item => item.text === claim.text)
  );

  // Degraded means "we produced a list, not a synthesis": no claim was shared by
  // two channels. The UI must label it instead of presenting it as agreement.
  const degraded = consensus.length === 0;

  return {
    consensus: consensus.slice(0, 8),
    disputed: disputed.slice(0, 5),
    unique: soloed.slice(0, 8),
    gaps,
    overlap,
    recommendation: buildRecommendation(consensus, disputed, gaps, overlap, channelCount, degraded),
    degraded
  };
}

function buildRecommendation(
  consensus: Claim[],
  disputed: Dispute[],
  gaps: Gap[],
  overlap: string[],
  channelCount: number,
  degraded: boolean
): string {
  if (degraded) {
    // Saying "几乎没有重合" here would be false whenever both answers simply
    // chose different words for the same subject. Name what they share instead.
    if (overlap.length > 0) {
      const named = overlap.slice(0, 3).map(item => `「${item}」`).join('');
      return `${channelCount} 个通道都在讲${named}，但没有一句话相似到可以直接对比，所以这里不做逐条判定。请按下面的原话自行核对它们是不是在说同一件事。`;
    }
    return `${channelCount} 个通道的回答几乎没有重合，无法形成共识。请直接阅读下方各自的原话，并注意这本身就是一种信号：问题可能没有标准答案，或者提问需要收窄。`;
  }

  const scope = consensus[0].sources.length >= channelCount ? '所有通道' : '多数通道';
  const claimed = consensus[0].text.trim();
  // The parts are joined without separators, so a claim that ends in a number
  // ran straight into the next sentence: 「一致认为：8未发现明显冲突」. Close the
  // quote properly instead.
  const stop = /[。！？.!?）)」』"]$/.test(claimed) ? '' : '。';
  const head = `${scope}（${String(consensus[0].sources.length)} 处提及）一致认为：${claimed}${stop}`;
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
