import type { ArgumentRelation, RelationKind } from '../../shared/fusion';
import { conclusionOf, features, jaccard } from '../../shared/synthesizer';
import type { ExtractedClaim } from './claim-extractor';

/**
 * 判定观点之间的关系。
 *
 * 这一步只回答「A 对 B 是什么关系」，**不回答 B 对不对**。两者混在一起，
 * 模型（或任何判定器）会把「我不同意」写成「B 是错的」，然后这个判断一路
 * 传进结论——架构文档 11.2 的第二道边界就是为这件事立的。
 *
 * 本地规则能给出的关系很少，所以这里的原则是：**宁可少一条边，也不建一条
 * 说不出理由的边**。每条边都带 `reason`，写不出具体触发词和数值就不建。
 */

/** 反驳标记。它表示「作者在这里转向反对前文」，是一句话内部的结构信号。 */
const ATTACK_CUE = /(但是|然而|实际上|其实|恰恰相反|事实上|反例|并不是|并非如此|不然|否则)/;

/**
 * 剥离否定词，用于「去掉否定之后还像不像同一句话」。
 *
 * 比 `synthesizer.ts` 里那份 `NEGATIONS` 保守：那边只数个数，误伤一个「无」
 * 只是计数偏一；这边要拿结果算相似度，剥掉「无线」里的「无」会把两个本来
 * 不同的主题拉到一起。所以只剥不会构成词根的单字和固定搭配。
 */
const STRIPPED_NEGATIONS = ['并不是', '并非', '不是', '没有', '无法', '不能', '不会', '不要', '不再', '并不', '不', '没'];

function stripNegations(text: string): string {
  let value = text;
  for (const token of STRIPPED_NEGATIONS) value = value.split(token).join('');
  return value;
}

function sharesTopic(a: ExtractedClaim, b: ExtractedClaim): boolean {
  for (const topic of a.topics) if (b.topics.has(topic)) return true;
  return false;
}

function topicOf(a: ExtractedClaim, b: ExtractedClaim): string {
  for (const topic of a.topics) if (b.topics.has(topic)) return topic;
  return '同一主题';
}

function sharesFigure(a: ExtractedClaim, b: ExtractedClaim): string | null {
  for (const figure of a.figures) if (b.figures.includes(figure)) return figure;
  return null;
}

function isSubset(small: Set<string>, large: Set<string>): boolean {
  if (small.size === 0) return false;
  for (const item of small) if (!large.has(item)) return false;
  return true;
}

function edge(
  a: ExtractedClaim,
  b: ExtractedClaim,
  kind: RelationKind,
  confidence: number,
  reason: string
): ArgumentRelation {
  return { from: a.id, to: b.id, kind, confidence, reason };
}

/**
 * 一对 claim 只产出一条边：取置信度最高、判据最硬的那条。
 *
 * 允许多条边并存会让「A 既支持又反驳 B」变得合法，而那张图没有意义——
 * 真要表达「部分支持」，应该是两条不同的 claim，不是一条边。
 */
function judge(a: ExtractedClaim, b: ExtractedClaim): ArgumentRelation | null {
  const plain = jaccard(a.features, b.features);
  const stripped = jaccard(features(stripNegations(a.text)), features(stripNegations(b.text)));
  const subject = sharesTopic(a, b);
  const comparable = subject || plain >= 0.3;

  // 1. 同一命题真假相反。先剥否定再比，是唯一能区分「Redis 6 有多线程」
  //    和「Redis 6 没有多线程」的判据——它们原句相似度高达 0.8。
  if (a.negation !== b.negation) {
    if (stripped >= 0.6) {
      return edge(a, b, 'contradicts', 0.85, `去掉否定词后相似度 ${stripped.toFixed(2)}，极性相反`);
    }
    if (subject && stripped >= 0.3) {
      return edge(a, b, 'contradicts', 0.7, `同一主题「${topicOf(a, b)}」，其中一句带否定`);
    }
  }

  // 2. 数字冲突：同一主题、各自有数字、没有共同的数字。
  //    置信度低于否定冲突——「默认 10000」和「上限 65535」可能各说一面。
  if (comparable && a.figures.length > 0 && b.figures.length > 0 && !sharesFigure(a, b) && plain >= 0.3) {
    return edge(a, b, 'contradicts', 0.6, `同一主题给出不同数字：${a.figures[0]} / ${b.figures[0]}`);
  }

  // 3. 依赖前提：一方的条件句在另一方那里是一条独立观点。
  //    前提被推翻时，下游必须跟着塌——这条边就是让它塌的抓手。
  for (const premise of a.assumptions) {
    const overlap = jaccard(features(premise), b.features);
    if (overlap >= 0.5) return edge(a, b, 'depends_on', 0.65, `前提「${premise}」由对方提出`);
  }
  for (const premise of b.assumptions) {
    const overlap = jaccard(features(premise), a.features);
    if (overlap >= 0.5) return edge(b, a, 'depends_on', 0.65, `前提「${premise}」由对方提出`);
  }

  // 4. 限定条件：一方带条件、一方是绝对表述。
  //    这类边最容易被漏掉，漏掉的后果是结论从「某些场景成立」变成「成立」。
  if (comparable && a.assumptions.length > 0 && b.assumptions.length === 0) {
    return edge(a, b, 'qualifies', 0.65, `「${a.assumptions[0]}」限定了适用范围`);
  }
  if (comparable && b.assumptions.length > 0 && a.assumptions.length === 0) {
    return edge(b, a, 'qualifies', 0.65, `「${b.assumptions[0]}」限定了适用范围`);
  }

  // 5. 明确反驳：句内出现转向标记，且对面在讲同一件事。
  const cueA = a.text.match(ATTACK_CUE);
  if (cueA && comparable) return edge(a, b, 'attacks', 0.6, `出现「${cueA[0]}」，指向同一主题`);
  const cueB = b.text.match(ATTACK_CUE);
  if (cueB && comparable) return edge(b, a, 'attacks', 0.6, `出现「${cueB[0]}」，指向同一主题`);

  // 6. 细化：一方覆盖了另一方的全部内容，还多说了。
  if (a.text.length >= b.text.length * 1.3 && isSubset(b.features, a.features)) {
    return edge(a, b, 'refines', 0.55, `覆盖对方全部要点，多出 ${a.text.length - b.text.length} 字`);
  }
  if (b.text.length >= a.text.length * 1.3 && isSubset(a.features, b.features)) {
    return edge(b, a, 'refines', 0.55, `覆盖对方全部要点，多出 ${b.text.length - a.text.length} 字`);
  }

  // 7. 支持：事实句为推断/建议提供依据。要求跨通道——同一通道里的事实
  //    支撑自己的结论，那不是独立证据，是自己给自己作证。
  if (a.channelId !== b.channelId) {
    const pair = [
      [a, b],
      [b, a]
    ] as const;
    for (const [fact, target] of pair) {
      if (fact.kind !== 'fact') continue;
      if (target.kind !== 'inference' && target.kind !== 'recommendation') continue;
      if (!subject) continue;
      return edge(fact, target, 'supports', 0.55, `陈述句为对方的「${target.kindCue}」提供依据`);
    }
  }

  // 8. 同一结论：`3 + 5 = 8` 和 `8` 之间没有措辞可借，只有结论可对。
  const answerA = conclusionOf(a.text)?.at(-1) ?? null;
  const answerB = conclusionOf(b.text)?.at(-1) ?? null;
  if (answerA && answerB && answerA === answerB && a.channelId !== b.channelId) {
    return edge(a, b, 'supports', 0.7, `两边结论相同：${answerA}`);
  }

  return null;
}

export function detectRelations(claims: ExtractedClaim[]): ArgumentRelation[] {
  const relations: ArgumentRelation[] = [];

  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const relation = judge(claims[i], claims[j]);
      if (relation) relations.push(relation);
    }
  }

  // 稳定排序：同样的输入必须得到同样的边序，否则报告每次都长得不一样，
  // 出了问题没法复现。
  return relations.sort(
    (a, b) => b.confidence - a.confidence || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  );
}

/** 某条 claim 被哪些边指向。合成阶段要回答「它有没有未解决的反驳」。 */
export function incomingOf(relations: ArgumentRelation[], claimId: string): ArgumentRelation[] {
  return relations.filter(relation => relation.to === claimId);
}

/** 某条 claim 指出哪些边。 */
export function outgoingOf(relations: ArgumentRelation[], claimId: string): ArgumentRelation[] {
  return relations.filter(relation => relation.from === claimId);
}
