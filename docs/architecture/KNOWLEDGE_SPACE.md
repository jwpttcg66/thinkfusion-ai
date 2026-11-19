# P2 知识学习空间设计

状态：**设计稿完成（2026-11-18）；方向确认；P0 门禁未过；未实施。**
评审快照：`2d05b12`（当前 HEAD 见 git log）；代码基线：`cd30be3`。
设计分支：`product-v3`。代码基线：`cd30be3`。
上游契约：[P1-002 领域与运行时契约](../implementation/P1-002-DOMAIN-RUNTIME-CONTRACT.md)。

定位见 [PRODUCT.md](../PRODUCT.md)。知识空间是 `CollaborationEngine` 上的一类任务 +
能力 + 存储，**不是独立 Engine**。

---

## 1. 目标与非目标

目标：

- 一次研究产出可复用的**知识卡**，不是一篇长报告；
- 第二次研究能召回旧结论，并标明时效；
- 旧结论被推翻时保留、可追溯；
- 缺口能变成下一轮研究问题。

非目标：

- 不建向量库、Neo4j、Graphiti；
- 不引入 native 数据库；
- 不把「相似」当成「正确」；
- 不做跨用户共享。

---

## 2. 领域模型（唯一权威）

```ts
export interface Topic {
  topicId: string;
  title: string;
  aliases: string[];
  createdAt: number;
  updatedAt: number;
}

export type CardStatus = 'active' | 'superseded' | 'refuted';

export interface Freshness {
  asOf: number;
  /** 依据的版本：commit / 文档版本 / 软件版本。 */
  version?: string;
  /** 代码仓库结论。 */
  commit?: string;
  /** 网页来源时间。 */
  sourceAt?: number;
  state: 'fresh' | 'stale' | 'unknown';
  reasons: string[];
}

/** 一条可独立复述的结论；长报告拆成多张卡。 */
export interface KnowledgeCard {
  cardId: string;
  topicId: string;
  statement: string;
  /** 指向 P1-002 Claim；可空（只有原文时先存草稿）。 */
  claimIds: string[];
  /** 指向 P1-002 EvidenceRef；进入复用的卡必须非空。 */
  evidenceRefs: string[];
  conditions: string[];
  freshness: Freshness;
  status: CardStatus;
  /** 新卡取代旧卡。 */
  supersedes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeGap {
  topicId: string;
  question: string;
  /** 来自 acceptance 缺口、stale 卡或无人回答的角度。 */
  source: 'acceptance' | 'stale' | 'unanswered';
  severity: 'high' | 'medium' | 'low';
}

export interface ReuseDecision {
  cardId: string;
  action: 'reuse' | 'update' | 'refute' | 'ignore';
  reason: string;
  needsEvidence: boolean;
}
```

规则：

- 一张卡只放一条结论；
- 无 `evidenceRefs` 的卡只能是草稿，不进入复用；
- `status=refuted` 的卡保留，不删除；
- `supersedes` 只指向旧卡，不覆盖内容。

---

## 3. 存储与索引

```text
userData/knowledge/
  topics/<topicId>.json
  cards/<cardId>.json
  index.json          # 可选：加速启动，损坏可由卡片重建
```

- 原子写复用 `atomic-write`；
- 不新建数据库；规模上来后再评估纯 JS 索引；
- 启动时加载；写入时增量更新内存索引。

索引键：

| 键 | 用途 |
| --- | --- |
| topicId / aliases | 主题召回 |
| token | 标题/结论关键词 |
| claimId | 从 Claim 反查卡 |
| evidenceId | 从证据反查卡 |

召回规则：主题/别名优先，其次 token + Claim；排序看 `status`、`freshness.state`、
证据强度，**不只看相似度**。

---

## 4. 流程

### 4.1 首次研究

```text
Goal(knowledge)
  → Planner: recall? research / extract / verify / deliver
  → Runner: Observations + EvidenceRef
  → Extractor: Claim → KnowledgeCard（草稿）
  → Verifier: 关键 Claim 有证据 → 卡转 active
  → Deliver: 知识地图 + 卡片
```

### 4.2 第二次研究

```text
Goal(knowledge, 同主题)
  → recall 旧卡
  → freshness 检查（commit/version/sourceAt）
  → reuse decision:
       fresh   → 复用，标注 asOf
       stale   → 作为对照，补证据任务
       refuted → 只展示「曾经错误」
  → 新结论与旧卡冲突：新卡 supersedes，旧卡 superseded
```

### 4.3 缺口驱动

- `acceptance` 未覆盖 → `KnowledgeGap(source=acceptance)`；
- `stale` 卡 → gap；
- 无人回答的角度 → gap；
- Replanner 把 gap 变成新任务；无新增信息即停。

---

## 5. 交付

```text
知识地图
├── 已确认：active + fresh
├── 有争议：dispute / refuted / superseded
└── 未回答：gap
```

每条必须能点到：Card → Claim → EvidenceRef → 来源（网页/代码/执行）。

---

## 6. 验收

| 场景 | 期望 |
| --- | --- |
| 首次研究 | ≥3 张卡，覆盖 ≥2 来源，每张有证据 |
| 第二次研究 | 召回旧卡；至少一张 stale/superseded；写明哪条仍成立 |
| 旧结论被推翻 | 新卡 supersedes；旧卡保留、可追溯 |
| 无来源 | 只能草稿/未核验，不进入复用 |
| 缺口 | 输出「已确认/争议/未回答」三块 |

测试：`check-knowledge-store`、`check-knowledge-reuse`、`check-knowledge-map`。

---

## 7. 风险

| 风险 | 对策 |
| --- | --- |
| 把相似当正确 | 复用必须带证据与时效 |
| 卡片变成长报告 | 一卡一结论，长文拆分 |
| 旧卡被静默覆盖 | supersedes/refuted 保留 |
| 提前上向量库 | P2 只用 JSON + 规则索引 |
| 知识引擎化 | 只作为 Task.context + capabilities |
