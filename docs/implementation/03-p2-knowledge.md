# P2 知识学习空间

目标：让一次研究的结论**可沉淀、可检索、可复用、可过期**，而不是每次从零开始。
前置：P1 active。
**知识学习不是独立 Engine**：它是 CollaborationEngine 上的一类任务与能力集合，
不新建 ResearchEngine / KnowledgeEngine。
出口：同一主题第二次研究能复用旧结论并标时效；旧结论被推翻可追溯。

---

## 1. 领域模型

`KnowledgeCard` / `Topic` 的唯一权威定义见
[KNOWLEDGE_SPACE](../architecture/KNOWLEDGE_SPACE.md)；本节不重复字段。

规则：

- 一张卡只放**一条结论**；长报告拆成多张卡。
- 每张卡必须有至少一个 `EvidenceRef`，否则只能存为「草稿」，不进入复用。
- `status=refuted` 的卡保留，不删除；复用时要显示「已被推翻，原因…」。
- 知识卡不是基线：不冻结任务上下文，只作为带时效的证据引用。

---

## 2. 存储与索引

**不做新数据库。** 初始实现：

- 知识卡与主题落 `userData/knowledge/*.json`（原子写，复用 `atomic-write`）。
- 内存索引：`topicId → cardIds`、token → cardIds、`claimId → cardIds`；
  启动时加载，写入时增量更新。
- 搜索：规则召回（主题词 + Claim 文本 + 证据来源），不做向量库；
  规模上来后再单独评估纯 JS 索引，不引入 native 依赖。

索引不改变事实：

- 搜索结果必须带 `asOf` 与 `status`；
- 排序不能只看相似度，还要看时效与证据强度。

---

## 3. 复用规则

第二次研究同一主题：

1. **先查**：按主题/别名召回 active 卡；
2. **验时效**：`commit` 变化、网页时间过旧、来源不可用 → 标 `stale`；
3. **验依据**：证据引用还能打开/复验吗？不能 → 降级为「仅历史参考」；
4. **复用方式**：
   - `fresh`：作为已知结论进入交付物，注明「复用了 X 时间的结论」；
   - `stale`：作为对照，要求新研究补证据；
   - `refuted`：只作为「曾经错误」展示，不进入结论。
5. **更新**：新结论与旧卡冲突时，新建卡并 `supersedes` 旧卡；旧卡标 `superseded`。

禁止：把旧结论当新事实、静默覆盖旧卡、只按向量相似度复用。

---

## 4. 缺口驱动研究

复用 P1 的 Replanner，不另写一套：

- `acceptance` 未覆盖 → 生成补研究任务；
- 知识卡标 `stale` → 生成「更新证据」任务；
- 同一主题连续两次无新增 → 停，并输出「已知 / 争议 / 未回答」三块。

---

## 5. 知识地图

交付物 `kind='knowledge_map'`：

```text
主题
├── 已确认（active，有证据，未过期）
├── 有争议（有 Dispute 或 refuted/superseded）
└── 未回答（acceptance 缺口 / 无人提及的角度）
```

每一块都能点到：KnowledgeCard → Claim → EvidenceRef → 来源（网页/代码/执行）。

验收：地图上的每一条都能走通，不允许出现「来源：无」。

---

## 6. 场景与验收

### 场景 A：首次研究

输入：「系统学习 Redis Cluster Proxy 方案」。
期望：≥3 张知识卡，覆盖至少 2 个来源；每张有证据；输出知识地图。

### 场景 B：第二次研究

输入：「Redis Proxy 方案有什么变化？」
期望：

- 召回旧卡并显示 `asOf`；
- 至少一张卡被标 `stale` 或 `superseded`；
- 交付物明确写「哪些结论仍成立、哪些依据已变」；
- 不重新从零生成全部结论。

### 场景 C：被推翻

构造一条旧卡与新证据冲突 → 新卡 `supersedes` 旧卡；旧卡仍在、可追溯。

测试：

- `check-knowledge-store.mjs`：原子写、加载、增量索引；
- `check-knowledge-reuse.mjs`：fresh/stale/refuted 三态；
- `check-knowledge-map.mjs`：地图三块与出处。

---

## 7. 任务清单

| ID | 任务 | 文件 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| P2-01 | 知识卡/主题存储 | `src/main/knowledge/store.ts` | P1 | store 测试 |
| P2-02 | 内存索引与召回 | `src/main/knowledge/index.ts` | P2-01 | 召回测试 |
| P2-03 | 时效与复验 | `src/main/knowledge/freshness.ts` | P2-02 | 三态测试 |
| P2-04 | 复用接线 | `collaboration/planner` 增量 | P2-03 | 场景 B |
| P2-05 | 知识地图 | `synthesize/deliver.ts` 增量 | P2-03 | 地图测试 |
| P2-06 | 缺口驱动 | 复用 Replanner | P2-04 | 无新增即停 |

---

## 8. 出口清单

- [ ] 知识卡一条一结论，必有证据（否则只是草稿）
- [ ] 第二次研究能召回并标明时效
- [ ] stale / superseded / refuted 三态可追溯
- [ ] 旧卡不被静默覆盖
- [ ] 知识地图每一条都能走到来源
- [ ] 无新增信息时停止，并说明已确认 / 争议 / 未回答
- [ ] 未引入 native 数据库或向量服务
