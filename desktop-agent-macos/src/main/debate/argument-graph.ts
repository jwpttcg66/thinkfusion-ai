import type {
  ArgumentEdge,
  ArgumentGraph,
  ArgumentNode,
  ClaimJudgment,
  DebateClaim,
  DebateDispute,
  DebateEvidence,
  DebateRevision
} from './types';

/**
 * 论证图（任务书 AC-08 / Phase 3）。
 *
 * 这里存的是**论证关系**，不是「谁同意了谁」的社交图：
 *
 * - 节点：Claim（可单独判断真假的一句）、Evidence（支持或反驳它的材料）、
 *   Challenge（对某几句的质疑）、Judgment（裁判的判断）。
 * - 边：supports / rebuts / qualifies / depends_on / contradicts / derived_from。
 *
 * 三条硬约束，都来自用户对 Phase 3 的要求：
 *
 * 1. **每条边都带轮次和来源对象**（`roundIndex` + `source`）。只存最终图的话，
 *    「这条反驳是怎么来的」就再也还原不出来。
 * 2. **不做推导式补边**。没有判据的关系就不连，图稀疏一点没关系，凭空补边会
 *    让人读出一个并不存在的论证。
 * 3. **不引入图数据库**。就是两个数组，跟着辩论快照一起落盘，读写走现有持久化。
 *
 * id 全部由被引用对象算出来（`claim:<claimId>`），所以「每轮追加」和「整场重建」
 * 得到的是同一个图：重复构建不会产生重复边，断电后重算也不会漂移。
 */

/** 一张图最多这么多节点。超过就停止追加，只记数量——不静默截断成一个小图。 */
const MAX_NODES = 5000;

export interface RoundGraphInput {
  roundIndex: number;
  claims: readonly DebateClaim[];
  disputes?: readonly DebateDispute[];
  revisions?: readonly DebateRevision[];
  evidence?: readonly DebateEvidence[];
  /** 建图时间，跟着这一轮走，便于排序。 */
  at: number;
}

export function emptyGraph(): ArgumentGraph {
  return { version: 1, nodes: [], edges: [] };
}

/**
 * 一轮的证据、争议、修订 → 这一轮的边。
 *
 * 主张节点不在这里建（见 `mergeGraph` 的调用方）：它属于「这一轮说了什么」，
 * 而边属于「这些说法之间是什么关系」。分开之后，重建图时不会因为某一轮没有
 * 争议就把主张也丢掉。
 */
export function graphOfRound(input: RoundGraphInput): ArgumentGraph {
  const graph = emptyGraph();
  const { roundIndex, at } = input;
  const claimIds = new Set(input.claims.map(claim => claim.claimId));

  // 1. 证据 → 主张：支持。
  for (const evidence of input.evidence ?? []) {
    for (const claimId of evidence.claimIds) {
      if (!claimIds.has(claimId)) continue;
      addEdge(graph, {
        fromId: evidenceNodeId(evidence.evidenceId),
        toId: claimNodeId(claimId),
        relation: 'supports',
        roundIndex,
        rationale:
          evidence.verified === 'page-link'
            ? `页面给出的来源「${short(evidence.excerpt)}」被用来支持这句主张`
            : `这句主张自己提到的出处「${short(evidence.excerpt)}」`,
        source: { messageIds: [evidence.messageId], claimIds: [claimId], evidenceId: evidence.evidenceId },
        createdAt: at
      });
    }
  }

  // 2. 主张 → 前提：依赖。前提是这句话自带的，不是谁外加的。
  for (const claim of input.claims) {
    claim.assumptions.forEach((assumption, index) => {
      const premiseId = `premise:${claim.claimId}:${String(index)}`;
      addNode(graph, {
        nodeId: premiseId,
        type: 'claim',
        ref: premiseId,
        roundIndex,
        agentId: claim.agentId,
        text: assumption,
        kind: 'assumption',
        status: 'proposed',
        createdAt: at
      });
      addEdge(graph, {
        fromId: claimNodeId(claim.claimId),
        toId: premiseId,
        relation: 'depends_on',
        roundIndex,
        rationale: `这句主张把「${short(assumption)}」当成成立前提`,
        source: { messageIds: [claim.messageId], claimIds: [claim.claimId] },
        createdAt: at
      });
    });
  }

  // 3. 争议 → 质疑节点 + 两句之间的关系。
  for (const dispute of input.disputes ?? []) {
    if (dispute.roundIndex !== roundIndex) continue;
    const [firstId, secondId] = dispute.claimIds;
    const challengeId = `challenge:${dispute.disputeId}`;
    addNode(graph, {
      nodeId: challengeId,
      type: 'challenge',
      ref: dispute.disputeId,
      roundIndex,
      agentId: dispute.agents[1],
      text: dispute.reason,
      createdAt: at
    });
    for (const claimId of [firstId, secondId]) {
      addEdge(graph, {
        fromId: challengeId,
        toId: claimNodeId(claimId),
        relation: 'derived_from',
        roundIndex,
        rationale: `这条质疑是从这句主张与另一句的对立里抽出来的（${dispute.type}）`,
        source: { messageIds: [], claimIds: [claimId], disputeId: dispute.disputeId },
        createdAt: at
      });
    }
    addEdge(graph, {
      // 方向固定为「先出现的那句 → 后出现的那句」，因为 claimIds 的顺序
      // 就是抽取顺序，读起来是「A 对 B」，不表示谁对谁错。
      fromId: claimNodeId(firstId),
      toId: claimNodeId(secondId),
      relation: relationOfDispute(dispute),
      roundIndex,
      rationale: dispute.reason,
      source: {
        messageIds: [],
        claimIds: [firstId, secondId],
        disputeId: dispute.disputeId
      },
      createdAt: at
    });
  }

  // 4. 修订 → 依赖来源：这一轮的回应是在被质疑的那几句上改的。
  for (const revision of input.revisions ?? []) {
    if (revision.roundIndex !== roundIndex) continue;
    const after = input.claims.filter(claim => claim.messageId === revision.messageId);
    for (const claim of after) {
      for (const target of revision.targetClaimIds) {
        addEdge(graph, {
          fromId: claimNodeId(claim.claimId),
          toId: claimNodeId(target),
          relation: 'derived_from',
          roundIndex,
          rationale: `第 ${String(roundIndex + 1)} 轮的回应（决策：${revision.decision ?? '未写明'}）针对这句修改`,
          source: {
            messageIds: [revision.messageId],
            claimIds: [claim.claimId, target],
            revisionId: revision.revisionId
          },
          createdAt: at
        });
      }
    }
  }

  return graph;
}

/** 主张节点本身：每轮先把话说过的句子放进图，再连边。 */
export function claimNodesOf(claims: readonly DebateClaim[], roundIndex: number, at: number): ArgumentNode[] {
  return claims.map(claim => ({
    nodeId: claimNodeId(claim.claimId),
    type: 'claim' as const,
    ref: claim.claimId,
    roundIndex,
    agentId: claim.agentId,
    text: claim.text,
    kind: claim.kind,
    status: claim.status,
    createdAt: at
  }));
}

/**
 * 整场重建。每轮调用一次，代价是线性的（主张几百条），换来的是：
 *
 * - 主张状态被后续决策改写后，节点上的 `status` 跟着更新，不会停在旧值；
 * - 断电后重算得到同一张图（id 由对象决定，不含随机数）；
 * - 不需要「增量合并」这套额外逻辑，也就没有合并顺序的坑。
 */
export function buildGraph(state: {
  rounds: ReadonlyArray<{
    index: number;
    startedAt: number;
    endedAt?: number;
    claims?: readonly DebateClaim[];
  }>;
  disputes?: readonly DebateDispute[];
  revisions?: readonly DebateRevision[];
  evidence?: readonly DebateEvidence[];
  judgments?: readonly ClaimJudgment[];
}): ArgumentGraph {
  let graph = emptyGraph();
  for (const round of state.rounds) {
    const at = round.startedAt;
    const claims = round.claims ?? [];
    const evidence = (state.evidence ?? []).filter(item => item.roundIndex === round.index);
    graph = mergeGraph(graph, {
      version: 1,
      nodes: [...claimNodesOf(claims, round.index, at), ...evidenceNodesOf(evidence, round.index, at)],
      edges: []
    });
    graph = mergeGraph(
      graph,
      graphOfRound({
        roundIndex: round.index,
        claims,
        disputes: (state.disputes ?? []).filter(dispute => dispute.roundIndex === round.index),
        revisions: (state.revisions ?? []).filter(revision => revision.roundIndex === round.index),
        evidence,
        at
      })
    );
  }
  const lastRound = state.rounds.at(-1);
  if (state.judgments?.length && lastRound) {
    graph = mergeGraph(graph, graphOfJudgments(state.judgments, lastRound.endedAt ?? lastRound.startedAt, lastRound.index));
  }
  return graph;
}

/** 证据节点：地址和指纹都留在节点上，点开就能回查。 */
export function evidenceNodesOf(
  evidence: readonly DebateEvidence[],
  roundIndex: number,
  at: number
): ArgumentNode[] {
  return evidence
    .filter(item => item.roundIndex === roundIndex)
    .map(item => {
      const url = item.finalUrl ?? item.url;
      return {
        nodeId: evidenceNodeId(item.evidenceId),
        type: 'evidence' as const,
        ref: item.evidenceId,
        roundIndex,
        agentId: item.sourceId,
        text: item.excerpt,
        // 没有地址就没有这个字段：写 `url: undefined` 会让 JSON 往返后
        // 少一个键，图就不再等于它自己（deepEqual 会失败，也会让 diff 变脏）。
        ...(url ? { url } : {}),
        createdAt: at
      };
    });
}

/**
 * 裁判结论 → 判断节点与边。
 *
 * 判断节点保留 verdict 原文；边指向被裁判的主张（`derived_from`：判断是从这条
 * 主张得出的），以及对它用到的证据（`depends_on`：判断依据这些材料）。
 */
export function graphOfJudgments(
  judgments: readonly ClaimJudgment[],
  at: number,
  roundIndex: number
): ArgumentGraph {
  const graph = emptyGraph();
  for (const judgment of judgments) {
    const judgmentId = `judgment:${judgment.judgmentId}`;
    addNode(graph, {
      nodeId: judgmentId,
      type: 'judgment',
      ref: judgment.judgmentId,
      roundIndex,
      agentId: judgment.agentId,
      text: `${judgment.verdict}：${judgment.rationale}`,
      verdict: judgment.verdict,
      createdAt: at
    });
    addEdge(graph, {
      fromId: judgmentId,
      toId: claimNodeId(judgment.claimId),
      relation: 'derived_from',
      roundIndex,
      rationale: `裁判对这句主张的判断：${judgment.verdict}`,
      source: { messageIds: [], claimIds: [judgment.claimId] },
      createdAt: at
    });
    for (const evidenceId of judgment.evidenceIds) {
      addEdge(graph, {
        fromId: judgmentId,
        toId: evidenceNodeId(evidenceId),
        relation: 'depends_on',
        roundIndex,
        rationale: '这条判断依据了这份材料',
        source: { messageIds: [], claimIds: [judgment.claimId], evidenceId },
        createdAt: at
      });
    }
  }
  return graph;
}

/**
 * 合并两张图。按 id 去重、按稳定顺序排序，所以同一批输入合并几次结果都一样。
 *
 * 达到节点上限后停止追加，并记下丢掉的条数：宁可明说「图被截断了」，
 * 也不要让人以为这就是全部。
 */
export function mergeGraph(base: ArgumentGraph | undefined, extra: ArgumentGraph): ArgumentGraph {
  const nodes = new Map<string, ArgumentNode>();
  for (const node of base?.nodes ?? []) nodes.set(node.nodeId, node);
  for (const node of extra.nodes) nodes.set(node.nodeId, node);

  const edges = new Map<string, ArgumentEdge>();
  for (const edge of base?.edges ?? []) edges.set(edge.edgeId, edge);
  for (const edge of extra.edges) edges.set(edge.edgeId, edge);

  const sortedNodes = [...nodes.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const kept = sortedNodes.slice(0, MAX_NODES);
  const keptIds = new Set(kept.map(node => node.nodeId));
  const sortedEdges = [...edges.values()]
    .filter(edge => keptIds.has(edge.fromId) && keptIds.has(edge.toId))
    .sort((a, b) => a.edgeId.localeCompare(b.edgeId));

  const graph: ArgumentGraph = { version: 1, nodes: kept, edges: sortedEdges };
  if (sortedNodes.length > kept.length) graph.truncated = sortedNodes.length - kept.length;
  return graph;
}

function relationOfDispute(dispute: DebateDispute): ArgumentEdge['relation'] {
  if (dispute.type === 'scope') return 'qualifies';
  if (dispute.type === 'logical') return 'rebuts';
  return 'contradicts';
}

export function claimNodeId(claimId: string): string {
  return `claim:${claimId}`;
}

export function evidenceNodeId(evidenceId: string): string {
  return `evidence:${evidenceId}`;
}

/**
 * 已见过的 id。建一张图要连上千条边，逐条 `some()` 扫数组会是平方复杂度；
 * 用 WeakMap 把索引挂在图对象上，不改 `ArgumentGraph` 的序列化形状。
 */
const nodeIndex = new WeakMap<ArgumentGraph, Set<string>>();
const edgeIndex = new WeakMap<ArgumentGraph, Set<string>>();

function addNode(graph: ArgumentGraph, node: ArgumentNode): void {
  let seen = nodeIndex.get(graph);
  if (!seen) {
    seen = new Set(graph.nodes.map(existing => existing.nodeId));
    nodeIndex.set(graph, seen);
  }
  if (seen.has(node.nodeId)) return;
  seen.add(node.nodeId);
  graph.nodes.push(node);
}

function addEdge(graph: ArgumentGraph, edge: Omit<ArgumentEdge, 'edgeId'>): void {
  const edgeId = `edge:${edge.fromId}->${edge.toId}:${edge.relation}`;
  let seen = edgeIndex.get(graph);
  if (!seen) {
    seen = new Set(graph.edges.map(existing => existing.edgeId));
    edgeIndex.set(graph, seen);
  }
  if (seen.has(edgeId)) return;
  seen.add(edgeId);
  graph.edges.push({ ...edge, edgeId });
}

function short(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > 32 ? `${trimmed.slice(0, 32)}…` : trimmed;
}

/** 统计：给文档、测试和「这张图到底有什么」用。 */
export function graphSummary(graph: ArgumentGraph | undefined): {
  nodes: Record<string, number>;
  edges: Record<string, number>;
  total: number;
} {
  const nodes: Record<string, number> = {};
  const edges: Record<string, number> = {};
  for (const node of graph?.nodes ?? []) nodes[node.type] = (nodes[node.type] ?? 0) + 1;
  for (const edge of graph?.edges ?? []) edges[edge.relation] = (edges[edge.relation] ?? 0) + 1;
  return { nodes, edges, total: graph?.nodes.length ?? 0 };
}
