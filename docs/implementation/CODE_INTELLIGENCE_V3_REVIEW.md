# Engineering Intelligence V3.0 复审

日期：2026-11-12。分支：`0.2.0`。
被审计划：`制定辩论主题方案 (7)-20261112-1351-10.md`
（ThinkFusion Engineering Intelligence V3.0，完整范围实施）。

## 0. 结论

**目标架构可以作为 V3.0 基线；完整实施范围可以按你的决定纳入批准范围。
但 V3.0 不是一份可以直接从 Phase 1 一路写代码的任务书，Phase 4/5 之前仍有
硬门禁。**

本机环境按 Phase 0 记录：Apple M5 / 24GB / 418GB free；Python 3.9.6；
Java 21.0.11；Neo4j 未安装；Docker 29.9.0；没有 uv/pyenv。Python 3.12
独立环境、Neo4j/JRE 或嵌入图库的分发，都必须从零建，不是已有条件。

这版比 V2.0-PoC 更完整：

- SQLite/FTS5 明确写成「新建能力」，不再把 `sqlite.query` 当应用层存储；
- Code-Memory Link 补了三层身份、SQLite 表、Rename/Move 状态机；
- Graphiti 质量验证补到 100 条标注、两人裁决、Precision/Recall/F1、置信区间；
- IndexAdapter / Generation 生命周期写成了目标契约；
- Phase 0 重新审计路径，删除了不存在的 `engineering/lsp.ts`；
- 全阶段质量 Gate 和状态分级（SPECIFIED → PRODUCTION_READY）保留。

但仍有三类问题：

1. **V3.0 把 V2.0-PoC 的一些防线删掉了**：中文 FTS5、Outbox/Reconciliation、
   失败回退表、资源预算、许可证矩阵都不够具体；
2. **SymbolKey 的示例仍包含文件路径**，与「文件移动后仍稳定」自相矛盾；
3. **「全部阶段批准」不等于「可以跳过 Gate」**。Phase 4/5 依赖 Gate 2/3、
   许可证和 Adapter 契约；这些没有通过之前，正式集成不能开工。

建议：**批准 V3.0 目标与范围；执行仍按 Phase 0 → Gate 0 → Phase 1/2 PoC →
Phase 3 设计/Gate → Phase 4/5 的顺序。** 不要直接把 Phase 0–8 排成一条长任务。

## 1. V3.0 改对了什么

| 上一版问题 | V3.0 处理 |
| --- | --- |
| SQLite/FTS5 被当成现有能力 | 明确「新建能力」，`sqlite.query` 不算应用层 |
| 20–30 条样本证明记忆质量 | Phase 3 改成 ≥100 条标注、两人裁决、CI、误标 ≤2% |
| Code-Memory Link 没有 schema | 补 `code_memory_link` SQLite 表与状态机 |
| Java 没有策略 | Tree-sitter 基础结构 → 后续 JDT，不假装已有 |
| Adapter / Generation 没定义 | 补 `IndexAdapter` 契约与 generation 流程 |
| 路径引用错误 | 删除了不存在的 `engineering/lsp.ts` |
| 接口当功能 | 保留 SPECIFIED/IMPLEMENTED/.../PRODUCTION_READY |

这些是实质进步。

## 2. 阻断正式集成的问题

### B1（阻断）SymbolKey 示例包含文件路径，和「移动后稳定」矛盾

计划 5.1：

```
project://thinkfusion
  /typescript
  /src/main/agent/orchestrator.ts
  #AgentOrchestrator.execute
```

`SymbolKey` 里直接放了 `filePath`。但计划同时要求文件移动/重命名后仍能关联。
文件路径一改，Key 就变；Rename/Move 匹配再靠 Fingerprint 找回，等于 Key 不是
「稳定逻辑身份」。

建议拆成：

```
SymbolKey        = project + language + module/qualified name + kind + signature
SymbolLocator    = filePath + range + provider
SymbolFingerprint= normalized signature + parent + structure hash
```

文件路径只进 Locator。否则 Phase 6 的 `UNIQUE(project_id, symbol_key, memory_entity_id)`
会在移动文件后产生一条新 Link，而不是迁移旧 Link。

### B2（阻断）Neo4j 是目标，但许可证/分发还没有结论，且没有回退表

V3.0 明确「目标图库 Neo4j」，同时承认 GPLv3 必须审查。问题是：

- 如果 Gate 0 的许可证结论是「不能随 DMG 捆绑」，Phase 4/5 怎么办？
- 如果用户不允许安装 Java/Neo4j，是否回到 CGC 嵌入后端或 SQLite？
- V3.0 删除了 V2.0-PoC 的「失败回退方案」章节；
- Gate 7 才做最终许可证审查，太晚；Phase 4/5 已经写进 Neo4j schema。

建议：

- 把许可证结论作为 **Gate 0 的硬门禁**，不是 Phase 8；
- 明确三种分发方案（用户自装 / 应用下载 / DMG 捆绑）的许可证结论；
- 保留 V2.0-PoC 的回退表：Neo4j 不通过 → CGC 嵌入库或 SQLite；
- Phase 4 之前不允许把 Neo4j 特有 schema 写成不可替换的领域模型。

### B3（阻断）CGC/Graphiti 黑盒与 Generation 契约没有验证

V3.0 补了 `IndexAdapter`，方向对，但仍只是目标契约：

- CGC 是 CLI/MCP，自带 FalkorDB Lite/Kuzu 数据库；它有自己的一套索引状态；
- Graphiti 有自己的 Neo4j schema（Episodes / Entities / Facts）；
- 两者都不保证能按外部 `generation` 写入、查询 `committedGeneration`、
  删除旧 generation；
- 如果底层不支持，Adapter 只能整库重建或双库切换，成本完全不同。

Gate 1 必须证明：

```
CGC/Graphiti 能否：
  - 标记某个 generation 完成？
  - 查询某个 generation 是否 searchable？
  - 删除旧 generation 而不影响当前？
  - 在崩溃后恢复未完成 generation？
```

不能证明，就必须在 Phase 3 改成「整库重建/双库切换」，并把它写进资源预算。
不能假设 Adapter 能凭空补出这些能力。

### B4（阻断）Gate 与 Phase 的映射不清

V3.0 的 Gate 表：

```
Gate 0 环境/CGC/Graphiti/Ollama
Gate 1 Adapter/数据模型/生命周期
Gate 2 Graphiti 记忆质量
Gate 3 CodeGraph 关系准确性
Gate 4 Code-Memory Link
Gate 5 Hybrid Retrieval
Gate 6 Agent/Debate 集成
Gate 7 生产化/许可证
```

但 Phase 顺序是：

```
Phase 1 CGC PoC
Phase 2 Graphiti PoC
Phase 3 设计/质量验证
Phase 4 CodeGraph 正式集成
Phase 5 Graphiti 正式集成
Phase 6 Hybrid + Link
Phase 7 Context/Agent
Phase 8 生产化
```

需要明确：

- Phase 1 的出口是 Gate 3（CodeGraph 精度）；
- Phase 2 的出口是 Gate 2（Graphiti 质量）；
- Phase 3 的出口是 Gate 1（Adapter/模型/生命周期）+ Gate 4（Link 身份）；
- Phase 6 的出口是 Gate 5；
- Phase 7 的出口是 Gate 6；
- Phase 8 的出口是 Gate 7。

否则「全部阶段批准」会被理解成 Phase 4 可以不等 Gate 2/3。建议在任务书里
写死「Phase N 的入口条件 = Gate X 通过；未通过写 ADR 并停止，不降标准」。

### B5（阻断）中文 FTS5 / Worker / MATCH 转义在 V3.0 消失了

V2.0-PoC 明确写了：

- `unicode61` 对中文两字词的限制；
- `trigram` 对短词的限制；
- `MATCH` 转义；
- `node:sqlite` 同步 API 放 Worker。

V3.0 4.1 只写「新建 FTS5 虚拟表、文档索引、符号索引、关键词检索」，
没有这些约束。实际测量仍然是：

| tokenizer | 登录 | 登录失败 | AUTH_401 |
| --- | --- | --- | --- |
| unicode61 | 0 | 0 | 1 |
| trigram | 0 | 1 | 1 |

如果 V3.0 直接按「建 FTS5 表」实现，中文两字词仍然搜不到。必须把
V2.0-PoC 的中文策略带回任务书：

- trigram + LIKE 回退，或 bigram 预处理；
- 查询长度 <3 的中文走回退；
- MATCH 查询转义；
- SQLite 写操作放 Worker；
- T09 的「按设计检索」要写成具体预期（命中/不命中、来源）。

### B6（阻断）Outbox / Reconciliation / Project Memory 被弱化

V3.0 有 `IndexAdapter` 和 generation 流程，但没有 V2.0-PoC 里的：

- Outbox 表结构；
- 任务重试；
- 文件存在性/指纹/关系有效性的 Reconciliation；
- 删除级联；
- 重启恢复；
- 旧 generation 不可检索的查询规则。

Phase 6 同时做 FTS5 + Vector + Graph + Link，规模很大。建议拆成：

- Phase 6a：FTS5 + Graph retrieval；
- Phase 6b：Link；
- Phase 6c：Vector（如果 Gate 5 通过）；
- 每个子阶段都有 generation/outbox/reconciliation 测试。

### B7（高）VectorStore 没有「不通过就取消」的门禁

V3.0 把 VectorStore 纳入完整交付，但没有像 V2.0-PoC 那样写：

- 没有 embedding 模型怎么办；
- 中文/代码语义召回不达标怎么办；
- 模型维度变化/重建成本；
- 向量索引失败是否影响主检索。

建议把 Vector 设成独立 Gate：

- 先证明有可用 embedding 模型（本机 Ollama 当前没有）；
- 固定任务集测 Top-K / 延迟 / 内存；
- 不达标 → 保留 Graph + FTS + LSP，不交付 VectorStore。

### B8（高）许可证矩阵仍不完整

V3.0 说要审查 CGC、Graphiti、Neo4j、Kuzu、FalkorDB Lite，但没有给结论。
实际：

| 组件 | 许可证 |
| --- | --- |
| CGC | MIT |
| Graphiti | Apache-2.0 |
| Neo4j Community | GPLv3 |
| FalkorDB 服务端 | **SSPLv1** |
| FalkorDB Lite | BSD |
| Kuzu | MIT；但 Graphiti 已标 deprecated |

尤其 FalkorDB 服务端不是 OSI 开源；如果 Graphiti 用它，风险不低于 Neo4j。
许可证报告必须按「实际后端 + 实际分发方式」列，并在 Phase 4/5 前完成。

### B9（高）安全记忆写入仍缺可执行策略

V3.0 保留「未确认不能升级」「外部 MCP 不默认开放」，但没有：

- 网页/README/代码注释/模型输出是否一律 `untrusted`；
- 候选记忆的隔离、过期、撤回；
- 确认状态由谁升级（用户/工具/裁决）；
- 删除记忆时 Link/FTS/Vector 的级联；
- Prompt Injection 的写入阻断点。

Phase 5 之前必须定义，否则「来源追溯」只是字段存在。

### B10（中）KnowledgeRouter / Context Assembly 仍无可执行规则

V3.0 说「Agent 根据任务类型选择，也允许用户指定」，但没有：

- 规则还是模型分类；
- 分类失败怎么降级；
- Token 预算如何分配；
- 冲突如何表示（`conflicts` 字段）；
- `stale` / `incomplete` 如何进入结果。

Phase 7 之前冻结即可，但不要在 Phase 6 把接口写成无法承载冲突/版本信息。

### B11（中）测试仍是阶段名，不是命令

V3.0 有 Gate 表，但没有每阶段的：

- 测试命令；
- 固定 fixture；
- 真实工程数据；
- 失败注入；
- 报告模板。

建议每个 Phase 交付里加：

```
npm run test:<area>
node --test scripts/check-<area>.mjs
```

以及 T01–T25 的具体断言。只写「集成测试」不算。

## 3. 建议的执行顺序（范围不变，门禁更硬）

你已决定完整范围；下面不是缩减范围，而是排执行顺序：

```
Phase 0 审计/环境
   ↓
Gate 0 环境 + 许可证初判 + Python 3.12
   ↓
Phase 1 CGC PoC  ──→ Gate 3 CodeGraph 精度
Phase 2 Graphiti PoC ─→ Gate 2 记忆质量
   ↓
Phase 3 设计与质量验证 ─→ Gate 1 Adapter/Generation + Gate 4 Link
   ↓
Phase 4 CodeGraph 正式集成
Phase 5 Graphiti 正式集成
   ↓
Phase 6a FTS5 + Graph → Gate 5
Phase 6b Link
Phase 6c Vector（独立 Gate）
   ↓
Phase 7 Router/Context/Agent/Debate → Gate 6
   ↓
Phase 8 生产化 → Gate 7
```

硬规则：

- Gate 未通过，不进入依赖它的 Phase；
- 不通过时写 ADR，选择回退方案，不降低验收标准；
- Phase 4/5 之前必须完成许可证结论；
- Phase 6c 之前必须证明 embedding 模型可用；
- Phase 8 的打包/资源测试不能替代 Gate 0 的环境验证。

## 4. 需要补进 V3.0 的具体内容

1. **SymbolKey 修正**：去掉 filePath，文件路径只放 Locator；
2. **失败回退表**：恢复 V2.0-PoC 的 CGC/Graphiti/Neo4j/Python/Embedding 回退；
3. **中文 FTS5**：trigram + LIKE 回退 / bigram、MATCH 转义、Worker；
4. **Outbox/Reconciliation 表**：任务、重试、删除级联、重启恢复；
5. **许可证矩阵**：FalkorDB 服务端 SSPL、Lite BSD、Kuzu deprecated、Neo4j GPL；
6. **Gate↔Phase 映射**：每个 Phase 的入口 Gate 写死；
7. **Vector 独立 Gate**：不达标就不交付；
8. **安全写入策略**：untrusted 标记、候选隔离、确认升级、删除级联；
9. **每阶段测试命令**：真实 fixture，不用 Mock 代替集成；
10. **时间盒**：Gate 0–4 总计 ≤ 8 周，超时写 ADR。

## 5. 需要确认的 6 件事

| # | 决策 | 建议 |
| --- | --- | --- |
| 1 | 是否按 V3.0 全范围执行 | 是，但按 Gate 顺序，不跳过 |
| 2 | Neo4j 是否仍为目标 | 是，但 Gate 0 许可证结论为硬门禁；保留嵌入库回退 |
| 3 | SymbolKey 是否接受「去 filePath」 | 是；filePath 只进 Locator |
| 4 | FTS5 中文策略 | trigram + LIKE / bigram，先 PoC 对比 |
| 5 | Vector 是否独立 Gate | 是；没有 embedding 模型就不交付 |
| 6 | Gate 时间盒 | Gate 0–4 ≤ 8 周；超时 ADR 回退 |

## 6. 最终判断

V3.0 可以作为**目标架构和完整范围基线**，这一点已经比前几版成熟。

但它仍然不是「可以直接从 Phase 1 写到 Phase 8」的任务书。真正要补的是：

- 把 SymbolKey 从「文件路径」里解耦；
- 把 Neo4j/许可证从 Phase 8 提前到 Gate 0/Phase 4 前；
- 把中文 FTS5、Outbox/Reconciliation、失败回退、测试命令补回；
- 把 Gate 和 Phase 的依赖关系写死。

这些补完后，可以按 Phase 0 → Gate 0 → Phase 1/2 → Phase 3 → Phase 4/5 推进。
**范围批准不等于门禁豁免；这是 V3.0 最需要写清楚的一句话。**

---

附：V2.0-PoC 复审
[CODE_INTELLIGENCE_V2_POC_REVIEW.md](./CODE_INTELLIGENCE_V2_POC_REVIEW.md)
里的 Gate 阈值、许可证、Python 分发、中文 FTS5、黑盒一致性问题仍然适用；
V3.0 的完整范围不改变这些技术约束。
