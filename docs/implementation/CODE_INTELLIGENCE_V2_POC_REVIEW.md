# Engineering Intelligence V2.0-PoC 复审

日期：2026-11-12。分支：`0.2.0`。
被审计划：`制定辩论主题方案 (7)-20261112-1341-10.md`
（ThinkFusion Engineering Intelligence V2.0-PoC）。

## 0. 结论

**比上一版明显进步，可以有条件批准 Phase 0 / Gate 0；暂不批准进入正式架构。**

这一版已经吸收了上一轮的核心反对意见：

- 不再预设双 Neo4j；
- CGC / Graphiti 先做 PoC，再决定是否正式引入；
- 补了 Gate 1–4 的精度、资源、分发、许可证和一致性门禁；
- 中文 FTS5、`node:sqlite` 同步 API、MATCH 转义重新进入计划；
- VectorStore 重新后置；
- 安全、项目隔离、Prompt Injection 从 PoC 开始；
- 明确「接口已定义 ≠ 已实现 ≠ 已验证」。

这些变化让计划从「平台迁移」回到了「可验证的渐进升级」。剩下的问题主要是
**执行契约和事实核对**，不是方向问题。

但计划里仍有 5 处会直接影响 Gate 结论的错误或空白：

1. **SQLite 和 FTS5 在工程里并不存在。** 计划写「SQLite 保留」「FTS5 保留并修复」，
   但当前只有 JSON journal 和调用系统 `sqlite3` CLI 的只读工具；没有 FTS5 代码。
   应该说「新建」，不是「修复」。
2. **CGC / Graphiti 是黑盒，不能直接套 ProjectIndexGeneration。** CGC 是 CLI/MCP
   服务，Graphiti 有自己的 Neo4j schema；除非适配器能读/写它们的索引状态，
   否则 generation/outbox 只能包在外面，失败时全量重建。
3. **许可证表不完整。** FalkorDB 服务端是 SSPLv1（不是 OSI 开源），
   FalkorDB Lite 才是 BSD；Kuzu 是 MIT，但 Graphiti 已把 Kuzu 标为 deprecated。
   这些不能只写「FalkorDB 候选」「Kuzu 候选」。
4. **Gate 2 的统计样本太小。** 20–30 条对话支撑不了「Precision ≥85%、猜测误标 0」
   这种结论；需要至少 50–100 条标注事实，或明确写成定性验证。
5. **Code-Memory Link 仍没有可执行的 `SymbolKey`。** 三层身份方向对，但
   TypeScript/Java 各自怎么生成、rename 后怎么匹配、Link 存在哪张表，还没定。

建议：**先做 Phase 0 + Gate 0，限时 2–3 周；Gate 0 通过后，修正 B1–B5 再进
Gate 1/2。** 不要在同一轮里把 Gate 1–4 全部排成开发任务。

本机事实（2026-11-12）：macOS ARM64 / 24GB / 418GB free；Python 3.9.6
（不满足 CGC/Graphiti 的 >=3.10，FalkorDB Lite 要 3.12）；Java 21.0.11；
Neo4j 未安装；Docker 29.9.0；没有 uv/pyenv。Gate 0 的 Python 3.12 环境
必须从零建立，这不是已有条件。

## 1. 这一版改对了什么

| 上一版问题 | 这一版处理 | 评价 |
| --- | --- | --- |
| 先建两套 Neo4j | 取消前置，Neo4j 变成候选 | ✅ 正确 |
| CGC/Graphiti 直接正式集成 | Gate 1/2 精度验证 | ✅ 正确 |
| 向量提前到 Phase 3 | VectorStore 后置，先验证 | ✅ 正确 |
| 跨库一致性后期处理 | ProjectIndexGeneration / Outbox / Reconciliation 前置 | ✅ 正确 |
| 安全留到发布 | Prompt Injection、项目隔离进 PoC | ✅ 正确 |
| 接口当功能 | SPECIFIED/IMPLEMENTED/INTEGRATED/VERIFIED/TESTED/PRODUCTION_READY 分级 | ✅ 正确 |
| 符号身份只有一句 | SymbolKey / SymbolLocator / SymbolFingerprint | 方向对，细节不足 |
| 失败没有退路 | 每个组件都有回退方案 | ✅ 正确 |

这不是「再改一版」的问题；这一版已经可以作为 PoC 的工作基线。

## 2. 必须先纠正的事实

### F1（阻断）SQLite / FTS5 不是现有能力

计划 3.1 写：

```
SQLite | 保留 | 现有存储基础
FTS5   | 保留并修复 | 中文检索回归通过
```

实际代码：

- 任务/会话 journal 是原子 JSON（`src/main/store.ts:30`、`src/agent/db.ts:10`）；
- 轨迹是 append-only JSONL（`src/main/trace/trace-store.ts`）；
- `sqlite.query` 只是调用系统 `sqlite3 -readonly` 的只读工具（`data-tools.ts:247`）；
- 全仓库没有 `node:sqlite`、没有 `CREATE VIRTUAL TABLE ... fts5`、没有 FTS5 查询。

所以：

- Phase 0 的「现有 FTS5 问题报告」应改成「FTS5 新建方案与中文验证」；
- Gate 1 之前要先有 FTS5 的最小实现，否则 T09/T10/T11 没有对象；
- 计划应写 `node:sqlite`（Electron 45 / Node 24.22.1 / SQLite 3.53.4）和
  同步 API 的 Worker 边界，不能写「保留」。

### F2（阻断）`engineering/code-read.ts` 不存在

计划 4.1 把它列为重点核实路径。实际 `src/main/engineering/` 只有：

```
analysis.ts
plan-review.ts
project.ts
review.ts
```

代码读取能力在 `src/agent/tools/filesystem.ts`、`project-read.ts` 和
`agent/tools/extended.ts`，不在 `engineering/code-read.ts`。

同类问题：`engineering/lsp.ts` 已在本版被删除，这是对的；`code-read.ts` 也要删。
Phase 0 的路径清单应以实际文件为准，不要给实施者一个不存在的入口。

### F3（高）「SQLite Project Memory」回退路线没有 schema

计划在 Gate 2 未通过时回退到 `SQLite Project Memory + Journal`，但没有定义：

- 记忆表结构（事实、来源、时间、确认状态、失效时间）；
- 与 `Conversation` / `TraceEntry` / `ExecutionReport` 的外键关系；
- 候选/确认/废弃的状态机；
- 项目隔离与删除；
- 查询接口（给 KnowledgeRouter 用）。

没有这些，「回退」只是一个词，实际会退化成把 JSON 再读一遍。

### F4（中）基线 commit / 分支没有写

计划只说「重新读取最新代码」，没有记录基线。审核时当前是：

```
分支：0.2.0
基线：fd657ec（V1.2 P2）
```

Phase 0 报告必须固定 commit，否则 Gate 1/2 的对照结果不可复现。

## 3. 仍然阻断正式架构的问题

### B1（阻断）CGC / Graphiti 的黑盒索引状态

`ProjectIndexGeneration` / Outbox / Reconciliation 假设每个存储都能：

- 按 generation 应用变更；
- 查询当前已提交的 generation；
- 幂等重试；
- 删除旧 generation。

但：

- CGC 是 CLI/MCP 服务，默认自带 FalkorDB Lite / Kuzu 数据库；它的索引状态、
  节点 ID、增量更新语义由 CGC 管理；
- Graphiti 有自己的 Neo4j schema（Episodes / Entities / Facts），有自己的
  时间有效性；
- 两者都不保证接受外部 generation 字段。

所以必须先定义 **Adapter 契约**：

```
CodeGraphAdapter.apply(change, generation) -> appliedGeneration
CodeGraphAdapter.committedGeneration() -> number
CodeGraphAdapter.deleteGeneration(g) -> void
```

如果 CGC 不支持，只有两个选择：

1. 包一层自有 SQLite 图（不用 CGC）；
2. 接受「CGC 整库重建」作为 generation 切换，查询期间标记 `rebuilding`。

Graphiti 也一样：generation 只能放在 Episode/业务 metadata 里，不能改它的
核心 schema。Gate 4 必须先证明这一点，否则 Phase 4/5 会返工。

### B2（阻断）许可证表不完整

计划只写了 Neo4j GPLv3 和 Python 分发，候选表里还有 FalkorDB、Kuzu。
实际（2026-11-12 上游）：

| 组件 | 许可证 | 备注 |
| --- | --- | --- |
| CodeGraphContext | MIT | PyPI 0.6.13，Python >=3.10 |
| Graphiti | Apache-2.0 | Python >=3.10；默认 OpenAI；Neo4j >=5.26 |
| Neo4j Community | GPLv3 | 计划已要求合规评估 |
| FalkorDB 服务端 | **SSPLv1** | 不是 OSI 开源；比 GPL 更容易触发分发义务 |
| FalkorDB Lite (PyPI) | BSD | Python >=3.12；CGC 默认后端 |
| Kuzu | MIT | CGC 可用；但 Graphiti README 已把 Kuzu 标为 deprecated |

这不是「再列一个表」的问题：

- 如果 CGC 用 FalkorDB Lite（BSD），Graphiti 用 FalkorDB 服务端（SSPL），
  两者不是同一个许可证；
- 如果为了共用后端选 Neo4j，回到 GPLv3 评估；
- 如果选 Kuzu 给 Graphiti，它已 deprecated，不能作为长期依赖。

Gate 0 的许可证报告必须按「实际后端 + 实际分发方式」列，而不是按组件名。

### B3（阻断）Gate 2 的统计设计不成立

计划写：

```
20–30 条真实工程对话
决策和约束 Precision ≥85%
猜测误标为事实 0
重复记忆率 ≤10%
```

问题：

- 20 条里 17 条正确就是 85%，置信区间很宽；30 条也不足以支持「0 误标」；
- 一条对话可能抽出多个事实，样本单位是「事实」还是「对话」没有定义；
- 「猜测误标 0」无法证明，只能说「在人工裁决样本中为 0」；
- 没有 Recall 门槛，模型可以只抽最保守的几条来刷 Precision。

建议：

- 标注单位改为「事实/决策/约束」条目，至少 100 条；
- Precision / Recall / F1 都报，附置信区间；
- 由两个人独立裁决分歧，记录 adjudication；
- 「0 误标」改成「误标率 ≤2%，且没有把未确认猜测标成已确认」；
- 样本里必须包含：已废弃决策、冲突决策、未确认推测、恶意注入文本。

Gate 2 不通过时，回退到 SQLite Project Memory，而不是继续调 Graphiti 提示词
直到指标好看。

### B4（阻断）Code-Memory Link 仍缺可执行身份

计划的三层身份方向是对的，但仍是「设计意图」：

- `SymbolKey`：tsserver 没有稳定 moniker；TypeScript 可用
  checker + declaration identity，但需要验证；
- `SymbolFingerprint`：没有说用什么（签名 AST hash？参数类型 + 返回类型？）；
- Java：没有 Provider，必须先用 jdtls/SCIP-Java 验证；
- rename/move：没有匹配算法（AST diff？content hash？qualified name？）；
- Link 存哪：SQLite 表？Neo4j？没有 schema。

Gate 4 必须产出：

1. TypeScript 的 `SymbolKey` 生成算法与 20 个 rename/move 样本；
2. Java 的 Provider 结论（没有就明确 `NEEDS_RELINK`）；
3. Link 表的 DDL 与查询；
4. 旧 commit 关联保留、当前关联 `needs_relink` 的状态机。

没有这些，Phase 4 不能开始。

### B5（高）Gate 0 只有「记录」，没有通过标准

Gate 0 目前列了要测什么，但没有「什么算通过」。建议加：

- CGC 能在 macOS ARM64 安装、索引 200 文件、查询符号/调用、增量更新；
- CGC 不要求 Docker（PoC 可以，但记录正式路径）；
- Graphiti 能连一个后端、写入 20 条 Episode、查询时间事实；
- 本机 Ollama 至少一个模型能稳定输出 Graphiti 需要的结构；失败要记录；
- Python 3.12 venv 可复现，安装日志/版本锁定；
- 峰值内存可测，不出现 OOM；
- 2–3 周内完成；超时则停止，不进入 Gate 1。

### B6（高）Gate 1 只有 Precision，没有 Recall/裁决

`符号识别 Precision ≥95%` 可以靠「少返回」刷出来。建议：

- 50 个符号样本，Precision / Recall 都报；
- Definition/References 用集合对照：至少 98% 交集，差异逐条列出；
- 确定性 CALLS 由人工裁决，记录样本量与误报；
- 增量更新要测「连续修改同一文件」和「删除后重建」；
- CGC 版本、后端、配置、commit 全部记录。

### B7（高）KnowledgeRouter / Context Assembly 仍无可执行规则

计划列了 CODE / MEMORY / HYBRID 和证据字段，但没有：

- 路由是规则还是模型？失败怎么降级？
- 冲突时谁优先？（建议：当前源码 > 用户确认 > 历史记忆）
- Token 预算怎么分？
- 去重键是什么？
- `stale` / `incomplete` 怎么进入结果？

这些可以放到 Phase 5 前，但必须在 Gate 4 之后、Phase 5 之前冻结。

### B8（中）安全写入策略还缺「不可信」标记

计划有分级记忆和 Prompt Injection 测试，但没有定义：

- 网页/README/代码注释/模型输出是否一律 `untrusted`；
- 候选事实如何隔离，谁能升级为已确认；
- 删除记忆时如何删除 Link/向量/FTS；
- 跨项目污染的阻断点在哪。

Gate 2 的标注数据里应包含恶意 README/注释，验证它们不会变成已确认决策。

### B9（中）测试清单仍缺关键故障

建议补：

- T26：索引失败不影响 `fs.edit` / `fs.applyPatch` / `fs.writeFile` 成功；
- T27：项目删除/重命名后，图、FTS、Link、向量都被清理；
- T28：数据库迁移/升级失败可回滚；
- T29：备份/恢复后 generation 一致；
- T30：离线（无外网）时，本地模型/本地图库可用，云端不可用要降级。

### B10（中）时间与范围没有上限

Phase 0 + Gate 0–4 + Phase 1–7 是一个很大的项目。建议明确：

- Gate 0 ≤ 2 周；
- Gate 1 ≤ 2 周；
- Gate 2 ≤ 2 周；
- Gate 3/4 各 ≤ 1 周；
- 任何 Gate 超时或未达标，写 ADR 并回退，不把项目拖成无限 PoC。

## 4. 修正后的批准建议

### 可以现在批准

- Phase 0：源码/环境/许可证/FTS5/测试集审计；
- Gate 0：Python 3.12、CGC 嵌入后端、Graphiti + 一个图后端、本机 Ollama；
- 只写 PoC 代码，不进入正式 `src/main` 架构。

### 暂不批准

- Gate 1/2 之后的正式 CodeGraph / Graphiti 集成；
- 双 Neo4j / 双 Python Worker；
- Code-Memory Link；
- KnowledgeRouter / Context Assembly 正式实现；
- VectorStore。

### Gate 0 通过后的下一步

1. 修正 F1–F4 的事实与文档；
2. 用 Gate 1 结果决定 CGC 是否值得；
3. 用 Gate 2 结果决定 Graphiti 是否值得；
4. 用 Gate 3 结果决定图库/Python 分发；
5. 用 Gate 4 结果决定 Link/一致性；
6. 写 ADR，再进 Phase 1。

## 5. 需要确认的 7 件事

| # | 决策 | 建议 |
| --- | --- | --- |
| 1 | 是否只批准 Phase 0 + Gate 0 | 是；Gate 1–4 等 PoC 数据 |
| 2 | CGC PoC 后端 | 先用嵌入式 Kuzu 或 FalkorDB Lite，不先上 Neo4j |
| 3 | Graphiti PoC 后端 | Docker Neo4j（仅 PoC）；同时记录 GPLv3/SSPL 风险 |
| 4 | Gate 2 样本量 | ≥100 条标注事实，Precision/Recall/F1 + 置信区间 |
| 5 | Code-Memory Link 存储 | SQLite 表 + outbox，不建第三套图库 |
| 6 | FTS5 实现 | 新建 `node:sqlite` FTS5 + Worker；中文两字走 LIKE 回退或 bigram |
| 7 | 时间盒 | Gate 0–4 总计 ≤ 8 周；超时写 ADR 回退 |

## 6. 最终判断

这版计划已经具备可执行性，方向也正确。**可以开始 Phase 0 / Gate 0，但不要
把「Gate 通过后的正式架构」提前写进代码。**

剩余风险不在技术愿景，而在三件事：

1. 把「计划中的 SQLite/FTS5」误当成「现有能力」；
2. 把 CGC/Graphiti 当成可随意加 generation 字段的自研模块；
3. 用 20–30 条样本证明 85% 精度和 0 幻觉。

把这三件事修正，Gate 0–4 的结论才可信。否则会出现「PoC 通过了，但正式集成
发现 CGC 不支持增量 generation、Graphiti 的实体 ID 不稳定、FTS5 中文仍然
搜不到」的返工。

---

附：上一版 V2.0 复审
[CODE_INTELLIGENCE_ENGINEERING_INTELLIGENCE_REVIEW.md](./CODE_INTELLIGENCE_ENGINEERING_INTELLIGENCE_REVIEW.md)
的「双 Neo4j 不前置」结论已被本版采纳；本文保留其许可证、Python 分发、
资源与黑盒一致性的约束。
