# Engineering Intelligence V2.0 计划书复审：双 Neo4j + Graphiti

日期：2026-11-12。分支：`0.2.0`。
被审计划：`制定辩论主题方案 (7)-20261112-1331-6.md`
（ThinkFusion Engineering Intelligence，双 Neo4j + Graphiti + Code-Memory Link）。

## 0. 结论

**不建议按 V2.0 直接进入 Phase 1。**

这份计划的原则是对的：代码事实与历史知识分域、保留来源与时间、当前源码优先、
不重建 AgentOrchestrator、不把接口当功能。但它把问题从「补一个 CodeGraph」
升级成了「在桌面应用里同时运行两套 Neo4j、两个 Python Worker、一个 Graphiti
抽取流水线和一个自研跨库关联层」。

这是一次**平台迁移**，不是渐进升级。当前没有任何实测数据证明需要它：

- 本仓库 208 个 TS/TSX 文件、61,622 行；不是百万行工程；
- 现有 `code.impact` 已经在 tsserver + AST 上区分 EXACT/POSSIBLE；
- 现有 `Engineering` 扫描、上下文包和 JSON 轨迹都还能用；
- 工程里没有 Neo4j、没有 Graphiti、没有 Python 3.10+、没有长期记忆库。

建议改成：

```
V2.0-PoC（门禁）
  CGC 嵌入库（Kuzu/FalkorDB Lite）或 SQLite CodeGraph
  + Graphiti 单实例 / 可选
  + 本机 Ollama 结构化抽取
  + 真实 TypeScript / Java 工程
        │
        ├─ 通过：再决定是否引入 Neo4j，以及一套还是两套
        └─ 不通过：回到上一版「SQLite + FTS5 + LSP/AST」路线
```

在没有 PoC 数据之前，**不要先建两套 Neo4j 管理器**。Phase 1 目前排在
Phase 2/4 的 PoC 之前，顺序是反的。

## 1. 基线与环境事实

### 1.1 代码事实

| 计划书的假设 | 真实情况 | 影响 |
| --- | --- | --- |
| 已有 CodeGraph | 只有 `engineering/analysis.ts` 的 ModuleGraph：正则符号 + 静态 import（`analysis.ts:71/137/169`） | CodeGraph 是新建，不是升级 |
| 已有 LSP/AST/Context/Impact | 有，但只覆盖 TypeScript/JS（`providers.ts:26/52`）；`code.impact` 是单位置查询 + mtime JSON 缓存（`impact.ts:44/50`） | 可复用，但不是持久化图 |
| 已有 Memory / Decision Records | 没有长期记忆库；只有会话消息、`Conversation.goal`、debate、trace、agent journal | Graphiti 是净新增；需要先定义「什么算记忆」 |
| 已有 SQLite 基础设施 | 没有。任务 journal 是原子 JSON（`store.ts:30`、`db.ts:10`）；`sqlite.query` 调系统 CLI（`data-tools.ts:247`） | 新库、新迁移、新备份都要从零建 |
| Python 环境可用 | 系统 Python 3.9.6；Graphiti 要 ≥3.10，CGC 要 ≥3.10；没有 uv/pyenv | 两个 Worker 都需要先安装/打包 Python 3.12+ |
| Neo4j 可用 | 没有安装 Neo4j；Java 21 在，但 Neo4j 服务/JRE 分发未定 | Phase 1 的「自动启动」没有落地路径 |
| 工程规模 | 208 个 TS/TSX 文件、61,622 行；仓库 362 个文件（不含构建产物） | 先证明 Neo4j 的必要性，而不是先建两套 |

### 1.2 本机环境

```
macOS / Apple Silicon / 24 GB RAM / 418 GB free
Java 21.0.11
Python 3.9.6（不满足 Graphiti/CGC 的 >=3.10）
Docker 29.9.0（可用于 PoC，但不能作为桌面应用运行前提）
Neo4j CLI：未安装
```

### 1.3 第三方事实（2026-11-12 读取上游）

- **Graphiti**：Apache-2.0；`requires-python >=3.10,<4`；依赖 `neo4j>=5.26.0`、
  `openai>=1.91.0`；默认用 OpenAI 做 LLM 和 embedding；README 明确说明
  本地 Ollama 可通过 OpenAI 兼容端点接入，但默认/最佳是支持 Structured Output
  的模型。
- **CodeGraphContext (CGC)**：MIT；PyPI `codegraphcontext 0.6.13`；
  `requires-python >=3.10`；默认后端是 **FalkorDB Lite**（Python 3.12+），
  也支持 KuzuDB / LadybugDB / Neo4j；README 说 Neo4j 是显式配置项；
  SCIP 主要覆盖 C/C++、C#，TypeScript/Java 默认仍以 Tree-sitter 为主。
- **Neo4j Community**：GPLv3。计划自己也要求做合规评估；目前没有结论。

这意味着：

1. CGC **不一定需要 Neo4j A**。用它的嵌入后端就能先验证代码图；
2. Graphiti **不一定需要第二个 Neo4j**，FalkorDB 也是可选后端；
3. 「两套 Neo4j」是计划的产品选择，不是组件强制要求；
4. Python 3.12+ 和 Neo4j/JRE 的打包是 Phase 0 的阻断项，不是 Phase 8 的收尾项。

## 2. 阻断问题

### B1（阻断）没有实测证据证明需要两套 Neo4j

计划用「隔离、生命周期、资源争抢」论证两套实例，但没有给出规模阈值：

- 多少节点/边时 SQLite/嵌入库不够？
- 多少并发查询时一个 Neo4j 实例不够？
- 一套实例的两个 database 是否能满足隔离？
- 两套实例的内存/启动/备份成本是多少？

当前工程 208 个源文件。先用 CGC 的 Kuzu/FalkorDB Lite 或 SQLite 建出真实图，
测查询延迟、索引时间、内存；达到阈值再引入 Neo4j。否则先建两套 JVM 是
把运维成本放在验证之前。

**修正**：Phase 0 做 PoC；Phase 1 的「双 Neo4j」降级为「单实例/嵌入库」；
只有 PoC 指标超过阈值才升级。

### B2（阻断）Phase 顺序反了

当前顺序：

```
Phase 1 两套 Neo4j 管理
Phase 2 CodeGraph/Phase 4 Graphiti
```

应该先证明：

- CGC 在 macOS ARM64、TypeScript/Java 上到底能提出什么关系；
- CGC 的输出与 tsserver 的 definition/references 差多少；
- Graphiti 在本机 Ollama 上抽取工程事实的成功率；
- 两套服务 + Ollama 在 24GB 上的真实内存。

这些都属于 Phase 0 PoC。**先建管理器，后验证引擎**，一旦 CGC/Graphiti 不达标，
Phase 1 的代码全部作废。

**修正**：Phase 0 增加 4 个 PoC 门禁；Phase 1 只做通过后的最小运行方式。

### B3（阻断）Python 运行时没有落地

Graphiti ≥3.10，CGC ≥3.10；本机只有 3.9.6。需要决定：

- 随应用打包 Python 3.12/3.13（体积、签名、公证、升级）；
- 还是要求用户安装（桌面产品不能默认这个）；
- 两个 Worker 是两个 venv 还是一个（依赖冲突：CGC 的 tree-sitter/neo4j 与
  Graphiti 的 pydantic/openai 可能冲突）；
- Worker 崩溃/重启/端口/日志/退出清理。

计划只说「Python Sidecar Worker」，没有这些。**Phase 0 必须先做一个
Python 3.12 + CGC + Graphiti 的最小安装 spike**，记录包体积与启动时间。

### B4（阻断）Neo4j 的分发与 GPLv3 没有结论

Neo4j Community 是 GPLv3。需要明确：

- 随 DMG 捆绑 Neo4j/JRE，还是用户自行安装？
- 如果是捆绑，GPLv3 对闭源 Electron 应用的义务是什么？
- 如果用户安装，怎么检测版本、数据目录、端口、账号、升级？
- 两套实例是否都需要独立 JRE/数据目录/备份？
- Docker 只用于 PoC，不能作为终端用户的运行前提。

这是发布阻断项，不是 Phase 8 的测试项。**先做法律/分发方案，再写 Manager。**

### B5（阻断）Graphiti 的价值依赖 LLM 抽取，尚未验证

Graphiti 默认 OpenAI；本地 Ollama 可通过 OpenAI 兼容端点接入，但 README 明确
「best with Structured Output」的模型。本机 Ollama 目前只有
`deepseek-r1:14b` / `gpt-oss:20b`，没有 embedding 模型。

需要 PoC 回答：

- 20–30 条真实工程对话，抽取出的决策/约束/问题，人工标注 precision/recall；
- 重复事实、互相矛盾、模型猜测被写成「已确认」的比例；
- 本地模型失败时是否降级到云端，用户是否接受；
- 单条 Episode 的抽取耗时与内存。

如果本地抽取 precision 不达标，Graphiti 只能作为云端功能；这会影响产品定位。
**不要等到 Phase 4 才发现。**

### B6（阻断）Code-Memory Link 的符号身份没有算法

计划说 `symbolId` 要「基于语言语义和稳定符号身份」，但没有给出：

- TypeScript 用什么？LSP 没有稳定 moniker；SCIP 对 TS 不默认；
- Java 用什么？需要 Java LSP/SCIP，当前 ThinkFusion 没有 Java Provider；
- rename/move 后怎么迁移？content hash 会变，qualified name 会变；
- 重载/同名方法怎么区分？
- CGC 的 Tree-sitter 节点 ID 是否稳定、是否可跨 commit？

没有这个算法，Code-Memory Link 在第一次重命名后就会大量失效。
**先定义 ID 方案（SCIP symbol / 签名 + 文件 + 范围 + commit 的复合键），
再谈关联。**

### B7（阻断）三套存储之间没有一致性机制

V2.0 实际有：

- Neo4j A（CodeGraph）
- Neo4j B（Graphiti）
- SQLite FTS5（全文）
- VectorStore（向量）
- CodeMemoryLink（关联，存在哪里未定）

跨库没有事务。计划没有 outbox、generation、reconciliation、幂等重放。
文件修改后，代码图、FTS、向量、关联可能分别成功/失败，查询会看到混合版本。

**修正**：加一个 `IndexCoordinator`：

```
write → outbox(event, generation) → each store idempotent apply
     → mark generation committed / failed
query → only return items with committed generation; stale flagged
```

没有这个，P5 的「一致性」只是口号。

## 3. 高风险问题

### H1 CGC 的 TS/Java 精确度未验证

CGC 支持很多语言，但：

- TypeScript/Java 默认走 Tree-sitter，不是编译器级；
- SCIP 在 CGC 文档中主要覆盖 C/C++、C#；
- 调用关系、重载、动态分派可能不如 tsserver；
- CGC 是 CLI/MCP，不是稳定 TypeScript 库；需要 pin 版本、包一层适配器。

必须用同一 TS 工程对照 tsserver 的 definition/references，抽样 50 个符号；
Java 需要另找 provider（jdtls/SCIP-Java），当前工程没有。

### H2 FTS5 中文/驱动/线程问题仍未解决

上一轮审核的结论没有进入新计划：

- `unicode61` / `trigram` 都搜不到中文两字词（实测「登录」=0）；
- `node:sqlite` 可用，但 `DatabaseSync` 同步，必须放 Worker；
- FTS `MATCH` 要转义，不能拼用户原文；
- SQLite 驱动/迁移/备份。

新计划保留 FTS5 和 VectorStore，但没有带这些约束。P2/P3 会重复踩坑。

### H3 Phase 3 又把向量塞进第一期

上一版计划把向量放 P6（P1–P5 稳定后再评估）；新计划 Phase 3 直接做
CodeChunker + VectorStore + VectorRetriever。这是范围回退。

建议：Phase 3 只做 Graph + FTS；向量单独 Phase 6，且必须先证明召回收益。
当前本机没有 embedding 模型，`EmbeddingService` 也没有接主循环。

### H4 记忆写入策略不足以防 Prompt Injection

计划有「来源校验、用户授权」，但没有可执行规则：

- 哪些来源是可信的？（用户明确确认 / 工具执行结果 / 辩论裁决）
- 网页、附件、模型输出是否一律 `untrusted`，只能作为候选？
- 候选事实如何隔离、过期、撤回？
- 如何防止一段网页内容被抽取成「项目决策」？
- 用户删除一条记忆时，如何删掉关联和向量？

这些必须在 Phase 4 之前定；只靠 Phase 8 的测试不够。

### H5 KnowledgeRouter 的分类方式没有定义

CODE / MEMORY / HYBRID 由规则还是模型判定？失败了怎么降级？
模型分类会增加一次 LLM 调用和延迟。建议第一版用可解释规则：
问题里出现「为什么/以前/决策/历史」→ MEMORY；出现「调用/引用/影响/定义」→ CODE；
同时出现 → HYBRID；不确定 → CODE + 标 `incomplete`。

### H6 Context Assembly 的冲突策略没有算法

计划说「历史决策与当前源码冲突要提示」，但没有：

- 以什么为准？（建议：当前源码 > 最新用户确认 > 历史记忆）
- 冲突如何表示？（`conflicts: [{memoryId, codeRef, reason}]`）
- Token 预算如何分给代码/记忆/证据？
- 去重键是什么？（file+line+symbol vs memory entity）

### H7 测试是场景，不是验收命令

T01–T20 是场景名，缺少：

- 每个 Phase 的通过/失败阈值；
- 真实数据集（工程、对话、标注）；
- 延迟/内存/磁盘预算；
- 失败注入（worker crash、Neo4j down、DB corrupt、断电）；
- 打包后的安装/升级/卸载测试。

Phase 8 才做性能/安全/打包太晚。至少资源与许可证要前置到 Phase 0。

## 4. 建议的 V2.0-PoC 门禁

在写任何 Manager 之前，用 1–2 周做一个可丢弃的 PoC，顺序如下。

### Gate 0：运行环境

- Python 3.12（独立 venv，不污染系统 3.9）；
- CGC 0.6.13 嵌入后端（Kuzu 或 FalkorDB Lite）；
- Graphiti + 一个 Neo4j 5.26（Docker 可，仅 PoC）；
- 本机 Ollama（deepseek-r1:14b / gpt-oss:20b）+ 一个 embedding 模型；
- 记录安装包体积、启动时间、空闲内存。

**不通过**：无法在 macOS ARM64 稳定启动 → 不进入 V2.0。

### Gate 1：CGC 代码图

在同一个 TypeScript 工程上：

- 索引 200–500 文件；
- 取 50 个符号，对照 tsserver 的 definition/references；
- 检查 CALLS 的 EXACT/POSSIBLE 是否可区分；
- 修改一个文件，测增量更新与幂等；
- 记录索引时间、查询 p95、内存。

**建议阈值**：

- 符号定位 precision ≥ 95%；
- CALLS 中「确定」级别不得有已知误报；
- 增量更新 < 2s/文件；
- 查询 p95 < 500ms。

不通过 → 回到 SQLite/自研 CodeGraph，不引 Neo4j A。

### Gate 2：Graphiti 记忆抽取

- 20–30 条真实工程对话/辩论结论；
- 人工标注「事实 / 决策 / 约束 / 问题」；
- 比较本地 Ollama 与云端模型的抽取结果；
- 记录 precision/recall、重复率、幻觉率、耗时。

**建议阈值**：

- 决策/约束 precision ≥ 85%；
- 不得把模型猜测标成「已确认」；
- 重复事实 ≤ 10%；
- 单条 Episode 抽取 < 30s（本地）。

不通过 → 记忆先用结构化 JSON/SQLite + 人工确认，不引 Graphiti B。

### Gate 3：资源与分发

- 两套 Neo4j + 两个 Python Worker + Ollama 14B 的峰值内存；
- 24GB 机器留 ≥ 4GB 余量；
- DMG 体积增量预算（建议 ≤ 300MB）；
- GPLv3 / Apache-2.0 / MIT 清单与分发方案；
- 无 Docker 的终端用户安装路径。

不通过 → 只保留一个图库/一个 Worker，或改为用户可选安装。

### Gate 4：跨库一致性

- 用 10 次文件修改 + 3 次删除 + 2 次 worker crash 验证：
  - 不会把旧 generation 当最新；
  - 重试幂等；
  - CodeMemoryLink 不会指向已删除符号；
  - 单库故障时其他库仍可查，并返回 `incomplete`。

不通过 → 不上 Code-Memory Link。

## 5. 如果 PoC 通过：建议的最小架构

不要直接上「两套 Neo4j」：

```
CodeGraph: CGC 嵌入库（Kuzu/FalkorDB Lite）或 SQLite CodeGraph
Memory:    Graphiti + 单 Neo4j（仅当 Gate 2 通过）
FTS:       node:sqlite FTS5（Worker）
Vector:    可选，Phase 6
Link:      SQLite 表 + outbox（不要放第三套图库）
Router:    规则优先，模型可选
Context:   扩展现有 buildCodeContext
```

只有当 Gate 1/3 证明嵌入库不够时，才把 CodeGraph 迁到 Neo4j A；
只有 Gate 2 证明 Graphiti 必须独立实例时，才拆 Neo4j B。
「两套 Neo4j」是结果，不是起点。

## 6. 需要裁决的 7 件事

| # | 决策 | 建议 |
| --- | --- | --- |
| 1 | 是否接受「先 PoC、后建两套 Neo4j」 | 接受；否则 Phase 1 风险不可控 |
| 2 | CGC 后端 | 先用嵌入 Kuzu/FalkorDB Lite，不先上 Neo4j A |
| 3 | Graphiti 是否第一期 | 先 Gate 2；不通过就做轻量记忆 |
| 4 | Python 运行时 | 随应用打包 3.12/3.13 + 独立 venv，Phase 0 验证体积/签名 |
| 5 | Neo4j 分发 | 用户可选安装或捆绑 + 法务结论；不能依赖 Docker |
| 6 | 记忆写入策略 | 只有用户确认/工具验证可升级为「已确认」；网页/模型输出一律候选 |
| 7 | Code-Memory Link 身份 | 先定 symbol ID（SCIP/签名+范围+commit），再写关联 |

## 7. 最终判断

这份 V2.0 的**产品愿景成立**：代码事实、工程记忆、两者关联，确实是
ThinkFusion 的长期方向。当前计划的问题不是方向，而是**顺序和证据**：

- 没有证明需要两套 Neo4j，就先把它们写成 Phase 1；
- 没有验证 CGC/Graphiti 在 macOS ARM64 + 本机模型上的效果，就先排 Phase 2/4；
- 没有解决 Python/Neo4j/GPLv3 的分发，就写自动启动；
- 没有定义符号身份和跨库一致性，就写 Code-Memory Link。

建议把 V2.0 改成 **V2.0-PoC 门禁 + V2.1 最小实现**：
先跑 Gate 0–4，用真实数据决定是否引入 Neo4j/Graphiti；通过后再写 Manager。
在没有 PoC 数据前，**不批准进入 Phase 1**。

---

附：上一版「单库 CodeGraph + SQLite FTS5」审核仍适用于 P1–P5 的代码图/
全文/增量部分；本复审只改变「是否引入双 Neo4j + Graphiti」的决策顺序。
