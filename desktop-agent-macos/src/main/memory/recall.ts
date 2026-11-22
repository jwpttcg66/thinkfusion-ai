/**
 * 召回：切分、打分、过滤、预算之前的那一段。
 *
 * 为什么不用现成的 `includes` / SQL LIKE：那是整句匹配，用户问一句话几乎
 * 不可能整句落在某条记忆里（旧 `KnowledgeIndex` 就是这样，实测近乎不命中）。
 *
 * 这一层是**纯函数**：输入记录数组，输出命中与排除原因，不碰数据库。
 * 好处是语料可以离线跑指标，不需要真模型、不需要 temp db。
 *
 * 规范见 `docs/spec/GLOBAL_MEMORY.md` §2。改公式或语料要同时改
 * `RECALL_CORPUS_VERSION`。
 */

import type { MemoryKind, MemoryRecord, MemoryScope } from '../../shared/memory';
import type { OmittedMemory, RecallCandidateScore, RecallQuery, RecallResult } from './types';

const CJK = /[\u4e00-\u9fff]/;
const SEGMENT = /[\u4e00-\u9fff]+|[A-Za-z0-9_$./:\\-]+/g;

/** 停用字只作用于单字 unigram；bigram 不受影响。 */
const STOP_CHARS = new Set('的了是在和与就都也很我你他这那吗呢吧啊个上下列里'.split(''));

const FIELD_WEIGHTS = {
  title: 1.0,
  symbol: 0.9,
  tags: 0.8,
  content: 0.7,
  source: 0.3
} as const;

const KIND_WEIGHT: Record<MemoryKind, number> = {
  constraint: 0.9,
  decision: 0.85,
  preference: 0.8,
  problem_solution: 0.7,
  fact: 0.6,
  procedure: 0.5,
  open_question: 0.3
};

const SCOPE_WEIGHT: Record<MemoryScope, number> = {
  PROJECT: 0.9,
  WORKSPACE: 0.6,
  GLOBAL: 0.7
};

function splitCamel(part: string): string[] {
  const pieces = part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g);
  return pieces && pieces.length > 1 ? pieces : [];
}

/**
 * 切成检索 token。
 *
 * 中文走字符 bigram（`订单` → `订单`），代码标识符**整段 + 子段双保留**，
 * 不做字符 bigram——把 `Redisson` 切成 `Re/ed/di/...` 之后，任何含
 * `ed` 的英文片段都会命中，噪声会压过真正的代码记忆。
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  if (!text) return tokens;
  const normalized = text.normalize('NFKC').toLowerCase();
  const segments = normalized.match(SEGMENT) ?? [];
  for (const segment of segments) {
    if (CJK.test(segment)) {
      if (segment.length === 1) {
        if (!STOP_CHARS.has(segment)) tokens.add(segment);
        continue;
      }
      for (let i = 0; i + 1 < segment.length; i += 1) tokens.add(segment.slice(i, i + 2));
      continue;
    }
    const ascii = segment.replace(/^[.:/-]+|[.:/-]+$/g, '');
    if (!ascii) continue;
    if (ascii.length >= 2) tokens.add(ascii);
    const subParts = ascii.split(/[_.:/-]+/).filter(Boolean);
    for (const part of subParts) {
      if (part.length >= 2) tokens.add(part);
      for (const camel of splitCamel(part)) {
        if (camel.length >= 2) tokens.add(camel.toLowerCase());
      }
    }
  }
  return tokens;
}

function intersectSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) if (b.has(token)) count += 1;
  return count;
}

/**
 * 长度归一化后的字段相似度。
 *
 * 任务书 §2.2 原本是 `0.6*jaccard + 0.4*coverage`，但语料实测暴露一个系统
 * 偏差：用户问题通常比记忆标题长得多（12 个 bigram vs 5 个），jaccard 的分母
 * 被长问题撑大，即便命中 2–6 个词也只有 0.13–0.2 —— 所有正常记忆都掉到
 * 阈值以下，召回率只有 0.25。评审 R2 要求「长度归一化」并用语料校准公式，
 * 因此把 **coverage 提为主项**（`shared/|q|`，天然按问题长度归一），jaccard
 * 退为抑制长文档堆词的辅项。两者仍在 0..1。
 */
export function fieldSimilarity(query: Set<string>, field: string): number {
  if (query.size === 0) return 0;
  const tokens = tokenize(field);
  if (tokens.size === 0) return 0;
  const shared = intersectSize(query, tokens);
  if (shared === 0) return 0;
  const union = query.size + tokens.size - shared;
  const jaccard = union === 0 ? 0 : shared / union;
  const coverage = shared / query.size;
  return 0.6 * coverage + 0.4 * jaccard;
}

/**
 * 多字段合并评分：逐字段加权平均 **与全字段合并取 max**。
 *
 * 只做加权平均会稀释命中——用户问题里的词往往分散在标题和内容里
 * （例如「数据库迁移」「验证」在 content，「迁移前」在 title），任何单个
 * 字段都覆盖不全。把字段拼成一段再算一次，取两者较大值，才是「这条记忆
 * 与这一问有没有关系」的合理度量（R2 要求明确「多个匹配字段如何合并」）。
 */
function lexScore(query: Set<string>, record: MemoryRecord): number {
  let weighted = 0;
  let weightSum = 0;
  const parts: string[] = [];
  const add = (weight: number, text: string) => {
    if (!text.trim()) return;
    parts.push(text);
    weighted += weight * fieldSimilarity(query, text);
    weightSum += weight;
  };
  add(FIELD_WEIGHTS.title, record.title);
  const symbols = record.codeRefs.map(ref => ref.symbolKey).join(' ');
  add(FIELD_WEIGHTS.symbol, symbols);
  add(FIELD_WEIGHTS.tags, record.tags.join(' '));
  add(FIELD_WEIGHTS.content, record.content);
  add(FIELD_WEIGHTS.source, record.sourceRefs.join(' '));
  const perField = weightSum === 0 ? 0 : weighted / weightSum;
  const whole = parts.length === 0 ? 0 : fieldSimilarity(query, parts.join(' '));
  return Math.max(perField, whole);
}

export interface ScoreOptions {
  now?: number;
  headCommit?: string;
  projectStaleDays?: number;
}

export interface ScoredMemory extends RecallCandidateScore {
  record: MemoryRecord;
}

/** 打分。返回拆项，界面要能回答"为什么命中"。 */
export function scoreMemory(
  record: MemoryRecord,
  queryTokens: Set<string>,
  options: ScoreOptions = {}
): RecallCandidateScore {
  const now = options.now ?? Date.now();
  const lex = lexScore(queryTokens, record);
  const days = Math.max(0, (now - record.updatedAt) / 86_400_000);
  const recency = Math.exp(-days / 90);
  const confirmBonus =
    record.lastConfirmedAt !== undefined && now - record.lastConfirmedAt <= 30 * 86_400_000 ? 1 : 0;
  const staleDays = options.projectStaleDays ?? 90;
  const commitMoved =
    record.kind === 'decision' &&
    options.headCommit !== undefined &&
    record.codeRefs.some(ref => ref.commit !== undefined && ref.commit !== options.headCommit);
  const lastConfirmed = record.lastConfirmedAt ?? record.updatedAt;
  const stale = commitMoved && now - lastConfirmed > staleDays * 86_400_000;
  const penalty = stale ? 0.5 : 0;

  /**
   * 乘性质量权重，而不是六项直接相加。
   *
   * 任务书 §2.2 的字面公式是 `0.45*lex + 0.20*kind + …`，但那 0.55 的静态项
   * 与查询**完全无关**：一条毫不相关的 active 记忆也能拿到约 0.49 分，高于
   * 任何可行阈值 → 空召回查询必然误命中、P@5 必然不达标（§2.4 的指标做不到）。
   * 这是评审 R2「用固定语料校准评分公式」要抓的那类问题。
   *
   * 改成 `lex * quality`：权重和仍是 1.00、满分仍可到 1.0，但 `lex=0` 一定
   * 得 0 分——只有真的与查询共享 token 的记忆才可能进入候选。静态项退化为
   * 「质量放大系数」，继续决定同类命中之间的排序，不再凭空造分。
   */
  const quality =
    0.45 +
    0.2 * KIND_WEIGHT[record.kind] +
    0.15 * SCOPE_WEIGHT[record.scope] +
    0.1 * recency +
    0.05 * record.confidence +
    0.05 * confirmBonus;
  const score = lex * quality - penalty;

  return {
    memoryId: record.memoryId,
    score: Math.max(0, Math.min(1, score)),
    lex,
    kindWeight: KIND_WEIGHT[record.kind],
    scopeWeight: SCOPE_WEIGHT[record.scope],
    recency,
    confidence: record.confidence,
    confirmBonus,
    penalty
  };
}

function inScope(record: MemoryRecord, query: RecallQuery): boolean {
  if (record.scope === 'GLOBAL') return true;
  if (record.scope === 'PROJECT') return Boolean(query.projectId) && record.scopeId === query.projectId;
  return Boolean(query.workspaceId) && record.scopeId === query.workspaceId;
}

export interface RecallOptions extends ScoreOptions {
  limit?: number;
  minScore?: number;
  threshold?: number;
  /** 关掉预算之前的最大条目数上限；默认 5。 */
  maxRecords?: number;
}

/**
 * 召回主函数（纯函数）。
 *
 * 顺序很重要：先按状态与 scope 排除，再判过期/陈旧/冲突，最后打分排序。
 * 先打分后过滤会让"被排除的记忆"出现在 scores 里，界面就会解释错。
 */
export function recallMemories(
  records: readonly MemoryRecord[],
  query: RecallQuery,
  options: RecallOptions = {}
): RecallResult {
  const now = options.now ?? query.now ?? Date.now();
  const threshold = options.threshold ?? options.minScore ?? 0.18;
  const limit = Math.max(1, Math.min(options.limit ?? options.maxRecords ?? 5, 20));
  const omitted: OmittedMemory[] = [];
  const eligible: MemoryRecord[] = [];

  for (const record of records) {
    if (!inScope(record, query)) {
      omitted.push({ memoryId: record.memoryId, reason: 'scope' });
      continue;
    }
    if (record.status !== 'active') {
      const reason =
        record.status === 'candidate'
          ? 'candidate'
          : record.status === 'superseded'
            ? 'superseded'
            : record.status === 'refuted'
              ? 'refuted'
              : record.status === 'expired'
                ? 'expired'
                : 'archived';
      omitted.push({ memoryId: record.memoryId, reason });
      continue;
    }
    if (record.expiresAt !== undefined && record.expiresAt < now) {
      omitted.push({ memoryId: record.memoryId, reason: 'expired' });
      continue;
    }
    eligible.push(record);
  }

  // 同 normalizedKey 的重复 active：留最可信的一条，其余记 conflict（不静默合并）。
  const byKey = new Map<string, MemoryRecord[]>();
  for (const record of eligible) {
    const key = `${record.scope}|${record.scopeId}|${record.normalizedKey}`;
    const list = byKey.get(key);
    if (list) list.push(record);
    else byKey.set(key, [record]);
  }
  const deduped: MemoryRecord[] = [];
  for (const list of byKey.values()) {
    if (list.length === 1) {
      deduped.push(list[0]);
      continue;
    }
    const sorted = [...list].sort(
      (a, b) =>
        (b.lastConfirmedAt ?? b.updatedAt) - (a.lastConfirmedAt ?? a.updatedAt) ||
        b.updatedAt - a.updatedAt ||
        a.memoryId.localeCompare(b.memoryId)
    );
    deduped.push(sorted[0]);
    for (const loser of sorted.slice(1)) omitted.push({ memoryId: loser.memoryId, reason: 'conflict' });
  }

  const queryTokens = tokenize(query.question);
  const scored: ScoredMemory[] = deduped.map(record => ({
    ...scoreMemory(record, queryTokens, {
      now,
      ...options,
      // `query.headCommit` 是项目当前 HEAD；之前没往下传，导致决策类记忆的
      // stale 判定永远不触发（MEM-05）。options 里显式给的优先。
      ...(query.headCommit ? { headCommit: options.headCommit ?? query.headCommit } : {})
    }),
    record
  }));

  const staleIds = new Set(
    scored
      .filter(item => item.penalty > 0)
      .map(item => item.memoryId)
  );
  for (const id of staleIds) omitted.push({ memoryId: id, reason: 'stale' });

  const passed = scored.filter(item => item.score >= threshold && !staleIds.has(item.memoryId));
  passed.sort(
    (a, b) =>
      b.score - a.score ||
      b.record.updatedAt - a.record.updatedAt ||
      a.memoryId.localeCompare(b.memoryId)
  );

  for (const item of scored) {
    if (item.score < threshold) omitted.push({ memoryId: item.memoryId, reason: 'low-score' });
  }

  const included = passed.slice(0, limit);
  for (const extra of passed.slice(limit)) omitted.push({ memoryId: extra.memoryId, reason: 'budget' });

  return {
    included: included.map(item => item.record),
    omitted,
    scores: passed.map(item => ({
      memoryId: item.memoryId,
      score: Number(item.score.toFixed(6)),
      lex: Number(item.lex.toFixed(6)),
      kindWeight: item.kindWeight,
      scopeWeight: item.scopeWeight,
      recency: Number(item.recency.toFixed(6)),
      confidence: item.confidence,
      confirmBonus: item.confirmBonus,
      penalty: item.penalty
    })),
    threshold
  };
}

/** 评测指标：P@k / R@k / 误注入率。语料测试与界面解释共用。 */
export interface EvalQuery {
  question: string;
  projectId?: string;
  workspaceId?: string;
  expectedIds: string[];
  mustNotContainIds?: string[];
}

export interface EvalReport {
  precision: number;
  recall: number;
  wrongInjectionRate: number;
  emptyQueryHits: number;
  perQuery: Array<{ question: string; got: string[]; expected: string[]; wrong: string[] }>;
}

export function evaluateRecall(
  records: readonly MemoryRecord[],
  queries: readonly EvalQuery[],
  options: RecallOptions = {}
): EvalReport {
  let hit = 0;
  let got = 0;
  let expectedTotal = 0;
  let wrong = 0;
  let emptyQueryHits = 0;
  const perQuery: EvalReport['perQuery'] = [];

  for (const query of queries) {
    const result = recallMemories(
      records,
      {
        question: query.question,
        conversationId: 'eval',
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.workspaceId ? { workspaceId: query.workspaceId } : {})
      },
      options
    );
    const ids = result.included.map(record => record.memoryId);
    const wrongIds = ids.filter(id => (query.mustNotContainIds ?? []).includes(id));
    const hits = ids.filter(id => query.expectedIds.includes(id));
    hit += hits.length;
    got += ids.length;
    expectedTotal += query.expectedIds.length;
    wrong += wrongIds.length;
    if (query.expectedIds.length === 0 && ids.length > 0) emptyQueryHits += ids.length;
    perQuery.push({ question: query.question, got: ids, expected: query.expectedIds, wrong: wrongIds });
  }

  return {
    precision: got === 0 ? 1 : hit / got,
    recall: expectedTotal === 0 ? 1 : hit / expectedTotal,
    wrongInjectionRate: got === 0 ? 0 : wrong / got,
    emptyQueryHits,
    perQuery
  };
}
