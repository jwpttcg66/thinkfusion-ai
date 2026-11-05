import type { EvidenceKind } from '../../shared/fusion';
import {
  canonicalUrl,
  digestCitations,
  fingerprintOf,
  isHttpUrl,
  originKeyOf,
  siteOf,
  type PageCitation
} from '../../shared/evidence';
import type { DebateClaim, DebateEvidence, DebateMessage, DebateRound, DebateState } from './types';

/**
 * 证据采集与同源识别（任务书 AC-09 / AC-10）。
 *
 * 两个来源，分开记录，不混成一种「证据强度」：
 *
 * 1. **页面给出的链接**（`verified: 'page-link'`）。地址是真的，可以点开复核；
 *    内容真不真、相不相关，另说。
 * 2. **主张自己说的出处**（`verified: 'reported'`）。「官方文档写明了」这句话
 *    能说明作者认为有来源，但页面没给链接时我们核对不了。
 * 3. 只有数字或什么都没有 → `unverified`。
 *
 * 同源识别与内容去重是两件事，这里也分开做：
 *
 * - 两条记录的 `url` / `finalUrl` 归一到同一个地址 → 同源（`originKey` 相同）。
 *   这是 TF-D-012 的场景：两个网站引用同一份官方文档，只是两条记录，不是两份证据。
 * - 地址不同、文字却一样 → 仍然按内容指纹认成同一份材料。地址不同不代表源头
 *   不同，但**地址相同一定同源**。
 *
 * 不做的：不联网解析短链、不按站点「可信度」打一个总分、不把转载判成造假。
 */

/** 这些出处类型才算「外部材料」；数字和断言不是。 */
const EXTERNAL_KINDS: EvidenceKind[] = ['official-doc', 'source-code', 'paper', 'benchmark', 'blog'];

/** 一句主张最多挂几条链接。多了没有意义，只会把「列了参考」当成「有证据」。 */
const MAX_CITATIONS_PER_CLAIM = 3;

/** 页面链接的兜底类型：认不出来源就当普通网页。 */
const BLOG_HOSTS = /(^|\.)(medium\.com|dev\.to|csdn\.net|juejin\.cn|cnblogs\.com|zhihu\.com|stackoverflow\.com|segmentfault\.com)$/;
const OFFICIAL_HOSTS = /(^|\.)(docs?\.[^.]+\.[a-z]+|developer\.[^.]+\.[a-z]+|rfc-editor\.org|w3\.org|ietf\.org|whatwg\.org|spec\.[^.]+\.[a-z]+)$/;
const CODE_HOSTS = /(^|\.)(github\.com|gitlab\.com|gitee\.com|bitbucket\.org)$/;
const PAPER_HOSTS = /(^|\.)(arxiv\.org|doi\.org|nature\.com|science\.org|acm\.org|ieee\.org|springer\.com|sciencedirect\.com)$/;

/** 页面链接 → 出处类型。只看地址和链接文字，不看内容（打不开）。 */
export function citationKindOf(citation: PageCitation): EvidenceKind {
  const site = siteOf(citation.finalUrl ?? citation.url);
  const text = `${citation.anchorText ?? ''} ${citation.title ?? ''}`;
  if (CODE_HOSTS.test(site)) return 'source-code';
  if (PAPER_HOSTS.test(site)) return 'paper';
  if (BLOG_HOSTS.test(site)) return 'blog';
  if (OFFICIAL_HOSTS.test(site) || /(官方|文档|规范|release notes|changelog)/i.test(text)) return 'official-doc';
  return 'blog';
}

/**
 * 这一轮的全部证据。
 *
 * 链接挂到哪句主张上，只用两条判据，不猜：
 *
 * - 这句主张自己提到了出处（`evidenceDrafts` 里有外部材料类型）——页面给的链接
 *   正好是它在说的那份材料；
 * - 链接文字/标题出现在这句主张里，或者主张出现在链接文字里。
 *
 * 两条都不成立时，链接仍然留在证据表里（`claimIds` 为空），只是不替它认领
 * 任何一句主张——页面给了来源，不等于这份来源支持某一句话。
 */
export function evidenceOfRound(round: DebateRound): DebateEvidence[] {
  const claims = round.claims ?? [];
  const claimsByMessage = new Map<string, DebateClaim[]>();
  for (const claim of claims) {
    const list = claimsByMessage.get(claim.messageId) ?? [];
    list.push(claim);
    claimsByMessage.set(claim.messageId, list);
  }

  const found: DebateEvidence[] = [];

  for (const claim of claims) {
    const drafts = claim.evidenceDrafts ?? [];
    for (const [index, draft] of drafts.entries()) {
      const excerpt = draft.excerpt.trim();
      if (!excerpt) continue;
      const external = EXTERNAL_KINDS.includes(draft.kind);
      found.push({
        evidenceId: `ev:${claim.claimId}:d${String(index)}`,
        claimIds: [claim.claimId],
        kind: draft.kind,
        excerpt,
        span: { messageId: claim.messageId, start: draft.start, end: draft.end },
        sourceId: claim.agentId,
        messageId: claim.messageId,
        roundIndex: round.index,
        fingerprint: fingerprintOf(excerpt),
        // 没有地址就没有「同一份材料」的证据；留空比编一个 key 诚实。
        originKey: null,
        independent: true,
        verified: external ? 'reported' : 'unverified',
        assessment: external
          ? `这句主张自称有出处（${draft.cue}），但页面没有给出可核验的地址`
          : `只有${draft.kind === 'model-claim' ? '数字' : '断言'}，没有来源`
      });
    }
  }

  for (const message of round.messages) {
    if (!message.citations?.length) continue;
    const digest = digestCitations(message.citations, {
      pageUrl: message.threadUrl,
      sourceId: message.agentId,
      now: message.createdAt
    });
    const ownClaims = claimsByMessage.get(message.messageId) ?? [];
    for (const [index, citation] of digest.citations.entries()) {
      const kind = citationKindOf(citation);
      const owners = claimsForCitation(ownClaims, citation, digest.citations.length);
      const soleAttribution = ownClaims.length === 1 && digest.citations.length === 1;
      const excerpt = (citation.anchorText || citation.title || citation.finalUrl || citation.url).trim();
      found.push({
        evidenceId: `ev:${message.messageId}:c${String(index)}`,
        claimIds: owners.slice(0, MAX_CITATIONS_PER_CLAIM),
        kind,
        excerpt: excerpt.slice(0, 200),
        span: { messageId: message.messageId, start: 0, end: 0 },
        sourceId: message.agentId,
        messageId: message.messageId,
        roundIndex: round.index,
        url: citation.url,
        finalUrl: citation.finalUrl,
        pageTitle: citation.title,
        fetchedAt: citation.fetchedAt ?? message.createdAt,
        fingerprint: fingerprintOf(`${citation.anchorText ?? ''}${citation.title ?? ''}`),
        originKey: originKeyOf({
          url: citation.url,
          finalUrl: citation.finalUrl,
          fingerprint: fingerprintOf(`${citation.anchorText ?? ''}${citation.title ?? ''}`) || undefined
        }),
        independent: true,
        verified: 'page-link',
        ...(soleAttribution && owners.length > 0 ? { soleAttribution: true } : {}),
        assessment:
          owners.length > 0
            ? soleAttribution
              ? '这条发言只有一句主张、一个引用，按页面气泡里的唯一关联认领；内容是否支持该句仍需人读'
              : '页面给出的链接，可点开复核（内容是否支持该句仍需人读）'
            : '页面给出的链接，但没有哪一句主张能对上，未被任何主张引用'
      });
    }
  }

  return found;
}

/**
 * 这条链接挂到哪几句主张上。
 *
 * 三条判据，前两条按字面可复核，第三条是**唯一关联**：
 *
 * 1. 这句主张自己提到了外部出处（「官方文档写明……」）；
 * 2. 链接文字或标题出现在这句主张里；
 * 3. 这条发言**只切出一句主张、且页面只给了这一个引用**：此时关联是页面
 *    气泡里唯一的一对，不是我们猜的。网页引用常画成上标或链接 chip，锚文字
 *    （「RFC 7230」「参考」）几乎不会原文出现在句子里；只靠前两条会把网页
 *    通道的引用系统性判成「没有哪一句能对上」。
 *
 * 第三条严格限制在 1:1：多句主张或多条链接时一律不启用——页面在末尾列一串
 * 「参考资料」，不等于其中每一份都支持其中某一句。认领了也只算 `page-link`
 * （地址可点开），内容真伪仍要人读，`assessment` 里如实写明。
 */
function claimsForCitation(
  claims: readonly DebateClaim[],
  citation: PageCitation,
  citationCount = 1
): string[] {
  const anchor = (citation.anchorText ?? '').trim();
  const title = (citation.title ?? '').trim();
  const matches: string[] = [];
  for (const claim of claims) {
    const claimsSource = (claim.evidenceDrafts ?? []).some(draft => EXTERNAL_KINDS.includes(draft.kind));
    const sharedText =
      (anchor.length >= 2 && claim.text.includes(anchor)) || (title.length >= 2 && claim.text.includes(title));
    if (claimsSource || sharedText) matches.push(claim.claimId);
    if (matches.length >= MAX_CITATIONS_PER_CLAIM) break;
  }
  if (matches.length === 0 && claims.length === 1 && citationCount === 1) {
    return [claims[0].claimId];
  }
  return matches;
}

/**
 * 整场证据：逐轮算完再统一做同源/去重。
 *
 * 必须整场做而不是逐轮做：同一份材料可能在第一轮被 A 引用、第二轮被 B 引用，
 * 逐轮算会把两者都标成「独立来源」。
 */
export function buildEvidence(state: Pick<DebateState, 'rounds'>): DebateEvidence[] {
  const all = state.rounds.flatMap(round => evidenceOfRound(round));
  return dedupeEvidence(all);
}

/**
 * 同源与去重。
 *
 * 规则只有一条：`originKey` 相同就是同一份材料，第二次出现标 `independent: false`，
 * 并指回第一条（`duplicateOf`）。这不是「造假」的判断——转载是正常行为，
 * 只是不能拿它当第二个独立来源。
 */
export function dedupeEvidence(items: readonly DebateEvidence[]): DebateEvidence[] {
  const firstByOrigin = new Map<string, string>();
  return items.map(item => {
    // 有地址就以地址为准重算：来源标识是「这段材料从哪来」，不能由调用方
    // 传一个随便的值把它覆盖掉。
    const key = item.url
      ? originKeyOf({ url: item.url, finalUrl: item.finalUrl }) ?? item.originKey
      : item.originKey;
    if (!key) return { ...item, originKey: null, independent: true };
    const first = firstByOrigin.get(key);
    if (!first) {
      firstByOrigin.set(key, item.evidenceId);
      return { ...item, originKey: key, independent: true };
    }
    return {
      ...item,
      originKey: key,
      independent: false,
      duplicateOf: first,
      assessment: `${item.assessment}；与 ${first} 同源（同一地址或同一段内容），不能算两份独立证据`
    };
  });
}

/**
 * 一条主张背后的独立来源数。只数**页面给了地址**的证据：主张自称的出处
 * 没有可核验的链接，把它算进独立性只会虚增。
 *
 * 按 `originKey` 去重，而不是数记录条数：同一条主张挂了两条指向同一份文档的
 * 链接，仍然是一个来源。`independent` 那个标记是整场视角的（「谁是第一条」），
 * 不参与这里的计算——否则第二句主张会因为「它引用的文档前面有人引过」而
 * 变成零来源，反而不对。
 */
export function independentSourceCount(items: readonly DebateEvidence[], claimId: string): number {
  const keys = new Set<string>();
  for (const item of items) {
    if (!item.claimIds.includes(claimId)) continue;
    if (item.verified !== 'page-link') continue;
    keys.add(item.originKey ?? item.evidenceId);
  }
  return keys.size;
}

/** 这条主张名下的证据（任何类型）。 */
export function evidenceForClaim(items: readonly DebateEvidence[], claimId: string): DebateEvidence[] {
  return items.filter(item => item.claimIds.includes(claimId));
}

/**
 * 地址与指纹之外的一层兜底：两条证据是不是同一份材料。
 *
 * 导出给测试与界面用；判定顺序与 `dedupeEvidence` 一致（先地址、后指纹）。
 */
export function sameOrigin(a: DebateEvidence, b: DebateEvidence): boolean {
  if (a.originKey && b.originKey) return a.originKey === b.originKey;
  if (a.url && b.url) {
    const left = canonicalUrl(a.finalUrl ?? a.url);
    const right = canonicalUrl(b.finalUrl ?? b.url);
    if (left && right) return left === right;
  }
  return Boolean(a.fingerprint && a.fingerprint === b.fingerprint);
}

/** 这条证据是不是外部材料（不是「模型自己说的数字」）。 */
export function isExternal(item: DebateEvidence): boolean {
  return EXTERNAL_KINDS.includes(item.kind);
}

/** 页面地址是否可用作来源链接（导出给测试用）。 */
export function usableUrl(raw: string): boolean {
  return isHttpUrl(raw);
}
