import { conclusionOf, jaccard } from '../../shared/synthesizer';
import type { ExtractedClaim } from './claim-extractor';

/**
 * 把不同通道讲的同一件事收到一组里。
 *
 * 两条硬规则：
 *
 * 1. **同一个通道的两句永远不合并。** 一个回答重复自己不是「两个通道达成了一致」，
 *    把它算进共识，等于让一个说得啰嗦的模型投两票。
 * 2. **相似不等于等价。** 「Redis 6 有多线程 IO」和「Redis 6 没有多线程 IO」
 *    字面相似度很高，含义相反。所以聚类只负责「是不是在讲同一件事」，
 *    是不是一伙的由关系判定去说（`relations.ts`）。
 *
 * 召回用三条判据，谁的证据更硬就用谁：
 *
 * - 逐字相同（去空白与结尾标点）—— 唯一不需要任何启发式的一条；
 * - 两段都是「只有一个结论」的回答，且结论数字相同（`3 + 5 = 8` vs `8`）；
 * - 整句 bigram 相似度 ≥ 0.34，或「同一个数字 + 共用主题词」。
 *
 * 第四条刻意不存在：只有共同主题词就合并。那只能证明「可比」，不能证明「一致」。
 */

export interface ClaimCluster {
  claims: ExtractedClaim[];
  channels: Set<string>;
  /** 最短的一条通常限定最少，读起来最像一条观点。 */
  representative: ExtractedClaim;
  /** 这一组是靠哪条判据收起来的，界面上可以显示，出错时也查得到原因。 */
  reason: 'identical' | 'same-answer' | 'similar' | 'shared-figure';
}

const SIMILAR_THRESHOLD = 0.34;
const SAME_ANSWER_FILLER = /[\s\p{P}\p{S}]/gu;

function normalized(text: string): string {
  return text.replace(/\s+/g, '').replace(/[。．.!！?？]+$/, '').toLowerCase();
}

function sharesTopic(a: ExtractedClaim, b: ExtractedClaim): boolean {
  for (const topic of a.topics) if (b.topics.has(topic)) return true;
  return false;
}

function sharesFigure(a: ExtractedClaim, b: ExtractedClaim): boolean {
  for (const figure of a.figures) if (b.figures.includes(figure)) return true;
  return false;
}

/** 只有结论的短回答：`3 + 5 = 8` 和 `8` 是同一个答案。 */
function bareAnswerOf(claim: ExtractedClaim): string | null {
  const numbers = conclusionOf(claim.text);
  if (!numbers || numbers.length === 0) return null;
  return numbers[numbers.length - 1] ?? null;
}

function mergeReason(a: ExtractedClaim, b: ExtractedClaim): ClaimCluster['reason'] | null {
  if (normalized(a.text) === normalized(b.text)) return 'identical';

  const answerA = bareAnswerOf(a);
  const answerB = bareAnswerOf(b);
  if (answerA !== null && answerB !== null && answerA === answerB) return 'same-answer';

  if (jaccard(a.features, b.features) >= SIMILAR_THRESHOLD) return 'similar';
  if (sharesFigure(a, b) && sharesTopic(a, b)) return 'shared-figure';
  return null;
}

/** 一组里最短的那条当代表；同样短时按 id 排，保证结果可复现。 */
function pickRepresentative(claims: ExtractedClaim[]): ExtractedClaim {
  return [...claims].sort((a, b) => a.text.length - b.text.length || a.id.localeCompare(b.id))[0];
}

export function clusterClaims(claims: ExtractedClaim[]): ClaimCluster[] {
  const parent = claims.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  const reasons = new Map<number, ClaimCluster['reason']>();

  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      if (claims[i].channelId === claims[j].channelId) continue;
      const reason = mergeReason(claims[i], claims[j]);
      if (!reason) continue;

      const a = find(i);
      const b = find(j);
      if (a === b) continue;
      parent[b] = a;
      // 保留更硬的那条判据：同一组里既有逐字相同又有相似，说「逐字相同」。
      const order: ClaimCluster['reason'][] = ['identical', 'same-answer', 'similar', 'shared-figure'];
      const previous = reasons.get(a);
      const winning = !previous || order.indexOf(reason) < order.indexOf(previous) ? reason : previous;
      reasons.set(a, winning);
      reasons.delete(b);
    }
  }

  const groups = new Map<number, ExtractedClaim[]>();
  claims.forEach((claim, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), claim]);
  });

  return [...groups.entries()].map(([root, group]) => ({
    claims: group,
    channels: new Set(group.map(claim => claim.channelId)),
    representative: pickRepresentative(group),
    reason: reasons.get(root) ?? 'similar'
  }));
}
