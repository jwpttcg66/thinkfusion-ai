# 混合代码索引与 CodeGraph：实施计划书审核

日期：2026-11-12。分支：`0.2.0`（从 `fd657ec` 建立）。
被审计划：`制定辩论主题方案 (5)-20261112-1139-8.md`
（ThinkFusion Code Intelligence & Hybrid Retrieval）。

## 0. 结论

方向采纳：**LSP + AST → CodeGraph → FTS5 → HybridRetriever → CodeContext →
Agent 接入 → 增量一致性**，分阶段交付，不重建 Runtime。这与现有 V1.2 的
边界一致，P6 向量索引继续后置。

但计划书目前**不能直接交给 Codex 从 P1 开始写**。有 5 个必须先定的工程选择，
以及 12 处与真实代码不符或缺失的约束。最关键的三个：

1. **SQLite 驱动没写。** 现在工程里没有 SQLite，也没有 `better-sqlite3`；
   Electron 45 自带 Node 24.22.1 / SQLite 3.53.4，`node:sqlite` 的 FTS5 在本机
   可用。计划必须明确用内置 `node:sqlite`，不要引 native addon。
2. **中文 FTS5 不能按默认 tokenizer 承诺。** 实测 `unicode61` 搜「登录」是 0 条；
   `trigram` 搜「登录」也是 0 条，只有「登录失败」（≥3 字）才命中。必须设计
   trigram + LIKE 回退，或 bigram 预处理，否则 P2 验收过不了。
3. **P0 说的「检查 SQLite 初始化/迁移」实际上没有东西可检查。** 任务 journal
   是 JSON（`src/main/store.ts:30`、`src/agent/db.ts:10`），不是 SQLite。P0 要
   产出的是**新库的 DDL 与迁移机制**，不是审计旧库。

建议：先完成 0.2.0 的 P0a（驱动与契约冻结），确认下面「需要裁决的 5 件事」，
再进入 P1。不要把 P1–P5 一次排成一条长任务。

## 1. 基线与事实核对

计划书写的审查基线 `fd657ecf303a8cd386c8846973550e17723e1c6d` 与当前
`0.2.0` 一致。以下事实来自源码与本机运行，不是计划书的推断。

| 计划书的说法 | 真实情况 | 对计划的影响 |
| --- | --- | --- |
| 已有 CodeGraph | 只有 `engineering/analysis.ts` 的 ModuleGraph：正则提取符号、静态 import 估依赖（`analysis.ts:71/137/169`），注释明确「不引 AST」 | P1 是**新建** CodeGraph，不是升级现有图 |
| 已有 LSP Impact | `code.impact` 是「单个位置」的 tsserver + TS AST 查询，按目标文件 mtime 缓存 JSON（`impact.ts:44/50`） | 可复用关系判定，但它不是持久化图；不要重复实现调用判定 |
| 已有 CodeContext | `buildCodeContext` 只处理一个文件/位置，返回 symbols / definitions / references / hover / 候选测试（`context.ts:30`） | P4 应扩展它，不要新建平行 ContextBuilder |
| 已有 SQLite 初始化/迁移 | 没有。任务 journal 是原子 JSON；`store.ts:30` 明确说为了避开 node-gyp 不引 better-sqlite3 | P0 必须新建 `code-index.sqlite`，不能改任务 journal |
| 工程扫描可当索引用 | `scanProject` 是「按问题关键词」的限界扫描：默认 6 层 / 500 文件 / 单文件 256KB / 总量 2MB（`project.ts:466-474`） | 不能直接拿它做全量索引；只能复用忽略规则与路径边界 |
| LSP 支持多语言 | Provider 只有 TypeScript/JavaScript（`providers.ts:26/52`），其他扩展名明确 `LSP_UNAVAILABLE` | P1 的精确节点/边只能承诺 TS/JS；其他语言要么跳过，要么标 `UNKNOWN` |
| 文件修改入口已知 | `local-plugins.ts` 只在 `fs.edit`（157）、`fs.applyPatch`（205）、`fs.writeFile`（305）后做诊断；`fs.remove/move/copy/archive.extract` 没有统一索引钩子 | P5 需要单独的写后/删除/移动事件，不要只改这三个 |
| Embedding 已可语义检索 | `EmbeddingService` 只提供文本→向量（`embeddings/service.ts:37`），不接主循环、不建索引；本机 Ollama 还没有 embedding 模型 | P6 继续后置，不能把 provider 说成向量搜索 |
| SQLite 驱动已选 | `package.json` 没有 SQLite 依赖；`sqlite.query` 是调用系统 `sqlite3` CLI 的只读工具（`data-tools.ts:247`） | 内部索引不能用 CLI；也不建议引 better-sqlite3 |

### 1.1 本机 SQLite / FTS5 实测

Electron 45.1.0 的 Node 与 SQLite：

```
process.versions.node    = 24.22.1
process.versions.sqlite  = 3.53.4
```

在 Electron-as-node 下执行：

```sql
CREATE VIRTUAL TABLE t USING fts5(content);
INSERT INTO t(content) VALUES ('用户登录失败 error_code=AUTH_401');
```

结果：

| tokenizer | `登录` | `登录失败` | `AUTH_401` |
| --- | --- | --- | --- |
| `unicode61`（默认） | 0 | 0 | 1 |
| `trigram` | 0 | 1 | 1 |

也就是说：

- 中文两字词在两种 tokenizer 下都搜不到；
- `trigram` 能覆盖 ≥3 字的中文子串和带下划线的标识符；
- 标识符 `AUTH_401` 两种都能命中。

这直接推翻「建了 FTS5 就能搜中文注释」的假设。P2 必须有回退策略。

## 2. 必须修正的 12 处

### F1（阻断）明确 SQLite 驱动：用 `node:sqlite`，不要 native addon

计划只写「SQLite」，没写驱动。当前 `store.ts:30` 明确避免 native addon。
建议：

- 新库 `userData/code-index.sqlite`，只服务 Code Intelligence；
- 用 `node:sqlite` 的 `DatabaseSync`（Node 24 / Electron 45 内置，SQLite 3.53.4）；
- 不引 `better-sqlite3`、不引 `sqlite3` npm 包、不调系统 `sqlite3` CLI；
- 封装一个 `SqliteDriver` 接口（`exec/prepare/transaction/close`），未来可换；
- 加 `PRAGMA journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout`。

P0 需要一个真实 spike：在 **Electron 主进程**（不是只有系统 Node）打开
`DatabaseSync`、建 FTS5 表、插入/查询、关闭。现在只验证了
`ELECTRON_RUN_AS_NODE=1`，主进程还要再跑一次。

### F2（阻断）FTS5 中文策略必须先定

不能只写「建 `code_fts`」。实测默认 tokenizer 对两字中文为 0。建议二选一：

1. **trigram + LIKE 回退**（推荐，改动小）：
   - `code_fts` 用 `tokenize='trigram'`；
   - 查询长度 ≥3 走 `MATCH`；
   - 长度 1–2 的中文走 `LIKE '%词%'`（有上限、有超时），并在结果里标
     `source: 'like-fallback'`；
   - 标识符/英文走 `MATCH`，不要把用户原文直接拼进 MATCH 语法。
2. **bigram 预处理**：额外存一列把中文切成双字 token，再建 `unicode61`。
   检索准确率更好，但索引体积和实现复杂度更高。

无论哪种，P2 验收必须包含：

```
中文两字：登录
中文三字：登录失败
英文标识符：AUTH_401
中文注释 + 英文错误码混合
```

只测英文/只测「跑通」不算 P2 通过。

### F3（阻断）索引不能跑在主线程

`node:sqlite` 的 `DatabaseSync` 是同步 API。全量扫描 + 写 FTS5 放主进程会卡
UI，尤其是首次索引。建议：

- 索引任务放 `worker_threads`（或 Electron `utilityProcess`）；
- 主进程只发「文件变更/重建」消息，不直接跑长事务；
- 同一 project 单写者，按 file 串行/合并；不同 project 可并行但限制并发；
- worker 崩溃不能带走主进程；任务可重试；
- 索引状态（pending/running/failed/stale）持久化，重启可恢复。

计划 P5 说「后台任务、限制并发」，但没落到进程/线程边界，需补。

### F4（阻断）P1 只承诺 TS/JS 的精确关系

计划列了 CLASS / INTERFACE / METHOD / FUNCTION 等节点，但 LSP Provider 只有
TypeScript。非 TS/JS：

- 不要用 `analysis.ts` 的正则结果冒充 `EXACT`；
- 可以索引文本、文件、import 级关系，但符号/调用标 `POSSIBLE` 或
  `UNKNOWN`，或在 P1 直接跳过符号边；
- 其他语言 Provider 单独排期，不能写进 P1 验收。

### F5（高）P0 的「源码盘点」要改成交付 DDL，不是再检查一遍

计划 P0 的任务是「检查 SQLite 初始化、迁移和事务」。实际上没有 SQLite。
P0 应交付：

- 新库 DDL（`code_nodes`、`code_edges`、`code_file_state`、`code_index_state`、
  `code_fts`）；
- `PRAGMA user_version` 迁移器与回滚策略；
- 节点/边 ID 规则（稳定 hash，重复索引幂等）；
- `ProjectIndexer` / `CodeGraphStore` / `CodeTextSearch` / `HybridCodeRetriever`
  四个接口的 TS 契约；
- 索引根、忽略规则、文件大小/二进制/符号链接边界；
- 一份「复用 / 新增 / 不碰」清单，明确不改 `AgentStore`、不改
  `AgentOrchestrator`、不改 `TaskGrant`。

### F6（高）Schema 与 FTS 表要可删除、可重建、可按项目过滤

计划只列字段，没有约束。建议最小 DDL 约束：

```sql
code_nodes(
  project_id, node_id, node_type, name, qualified_name,
  file_path, start_line, end_line, content_hash, metadata,
  PRIMARY KEY(project_id, node_id)
);
code_edges(
  project_id, edge_id, source_node_id, target_node_id, relation_type,
  confidence, source, file_path, line, source_file_hash, updated_at,
  PRIMARY KEY(project_id, edge_id)
);
code_file_state(
  project_id, file_path, content_hash, size, mtime_ms,
  indexed_at, status, error,
  PRIMARY KEY(project_id, file_path)
);
code_index_state(project_id, schema_version, last_scan_at, last_error);
```

FTS5 建议分成：

- 正常表 `code_chunks`：`project_id, file_path, symbol_id, kind, content,
  comments, content_hash`；
- `code_fts` 用 `content='code_chunks'` 或独立表，至少把 `project_id`,
  `file_path` 作为 `UNINDEXED` 列；
- 删除文件时先删 `code_chunks` 再删 FTS 行，避免 external-content 不一致；
- `PRAGMA user_version` 管迁移；迁移失败要保留旧库并禁止查询当最新。

所有查询必须带 `project_id`，不能跨工程串结果。

### F7（高）P5 的写入入口覆盖不完整

计划只列 `fs.writeFile / fs.edit / fs.applyPatch / Agent 修改 / 外部变更`。
真实入口还包括：

- `fs.remove`、`fs.move`、`fs.copy`（`local-plugins.ts:162/167/168`）；
- `archive.extract`（解压会写多个文件）；
- `image.resize`、`text.base64` 等写文件工具；
- `git.worktree` 创建/删除目录；
- `code.run` 可能写工作区。

建议在 Runtime 侧加一个 `notifyWorkspaceChanged({root, paths, kind})`
桥（不是新执行器）：写成功后 fire-and-forget 通知主进程索引队列；
索引失败不影响工具返回值。删除/移动要同时失效源与目标路径。

### F8（高）P3 不要重复造 `code.context` / `code.impact`

现有 `code.context` 已经返回 symbols/definitions/references/hover/候选测试；
`code.impact` 已经区分 `EXACT/POSSIBLE`。P3 的 `HybridCodeRetriever` 应该是
**编排层**：

```
query intent
  → graph / fts / lsp
  → normalize
  → dedupe by (file,line,symbol)
  → rank
  → freshness/source/confidence
```

不要改掉现有两个工具的返回结构；新增一个统一入口（例如 `code.retrieve`），
内部复用 `buildCodeContext` / `buildImpact` / 新 graph。现有工具继续可用。

### F9（高）FTS 查询要防语法注入与慢查询

`MATCH` 不是普通字符串参数。用户问题里可能有 `"`、`*`、`-`、`NEAR`、括号。
必须：

- 把查询拆 token 后逐个加引号，或使用 FTS5 的 phrase quoting；
- 限制 query 长度、结果数、执行时间；
- 不把原始问题直接拼成 `... MATCH '${query}'`；
- 结果里标注 `sources` 与 `staleIndex`；过期数据不能当最新结果。

### F10（中）索引范围与凭证边界

复用 `project.ts:30` 的忽略目录和 `:34` 的凭证/锁文件规则，但注意：

- 索引器需要自己的全量遍历，不能复用 `scanProject` 的问题关键词筛选；
- 不索引 `.env`、密钥、证书、`.sqlite`、`.db`、锁文件、二进制、构建产物；
- 不跟随符号链接；
- 单文件大小上限、总预算、文件数上限要可配置并在结果里报告截断；
- 是否读 `.gitignore` 需要明确（建议第一版沿用固定忽略表，避免 gitignore
  解析引入新依赖）。

### F11（中）测试不能只跑「程序成功」

计划第七节方向对，但要落成可执行测试：

- `test:code-index`：临时 TS 工程 + 临时 DB，真实写入/查询；
- 图谱：跨文件定义、引用、调用、同名方法、循环依赖、动态调用（标 POSSIBLE）；
- FTS：中文两字/三字、中文注释、英文标识符、错误码、路径过滤、忽略目录；
- 增量：首次扫描、修改、连续修改、删除、并发不同文件、重启恢复、失败重试；
- 幂等：同一文件索引两次不产生重复节点/边；
- 故障隔离：索引失败后 `fs.edit` 仍成功；
- Electron 主进程启动 smoke：`node:sqlite` + FTS5 真实可用；
- 检索效果：固定任务集，记录 Top-K、耗时、上下文 token、过期命中率。

不要用 Mock 代替真实 SQLite；不要只断言接口存在。

### F12（中）性能承诺要可测量，不要先写死指标

计划说「首次扫描后台、限制并发、AST 按需」，方向对。补充：

- 首次扫描给出进度/取消；
- 单文件 AST 解析只在需要符号/调用时做，不全量 parse；
- FTS 写入批量事务，避免每文件一次 fsync；
- 查询有最大结果数、最大耗时、最大返回字符；
- 记录 CPU/内存/磁盘/索引时间/查询耗时，而不是提前承诺「快」。

## 3. 建议修订后的阶段

### P0a：驱动与契约冻结（1 个小 PR）

- `node:sqlite` 在 Electron 主进程跑通，FTS5 + 中文实测；
- `SqliteDriver`、`CodeGraphStore`、`CodeTextSearch`、`HybridCodeRetriever`
  TS 接口；
- DDL + `user_version` 迁移器；
- 稳定 ID 规则；
- 不接 Agent、不改 UI。

**出口条件**：`test:code-index` 的 driver/DDL/FTS smoke 全绿；应用启动仍然
94 条能力不变。

### P1a：文件与符号节点

- 全量扫描（新扫描器，不复用 `scanProject` 的问题筛选）；
- PROJECT / MODULE / FILE / CLASS / INTERFACE / FUNCTION / METHOD 节点；
- `CONTAINS` / `DEFINES` 边（AST/正则的置信度分级）；
- 幂等写入与文件删除清理。

### P1b：导入/依赖/引用/调用

- `IMPORTS` / `DEPENDS_ON`（工程分析，标 HIGH/POSSIBLE）；
- `REFERENCES`（tsserver，EXACT）；
- `CALLS`（tsserver call hierarchy 或 TS AST，EXACT；无 AST 标 POSSIBLE）；
- `IMPLEMENTS` / `EXTENDS`（tsserver/AST）；
- 与现有 `code.impact` 的 EXACT/POSSIBLE 语义保持一致。

### P2：FTS5

- trigram + LIKE 回退（或 bigram 预处理，先做 spike 比较）；
- 符号名/限定名/路径/注释/字符串/错误码/配置项；
- 查询转义、结果上限、项目过滤、忽略规则；
- 重建索引与删除清理。

### P3：HybridCodeRetriever

- 意图 → 通道选择；
- 结果归一化/去重/排序；
- `sources`、`confidence`、`staleIndex`、`warnings`；
- 新工具 `code.retrieve`（或等价入口），现有工具不变。

### P4：CodeContext 与 Agent 接入

- 扩展 `buildCodeContext` 接受 HCR 结果；
- L1–L4 上下文预算；
- 单 Agent 先接，再 Coding Team；
- 不绕过 TaskGrant/审批。

### P5：增量一致性

- 写后/删除/移动/解压通知；
- 队列、重试、重启恢复；
- 查询时 freshness 检查；
- 失败不影响文件写入。

### P6：向量（继续后置）

- 复用 `EmbeddingService`；
- CodeChunker / VectorStore / VectorIndexer / VectorRetriever；
- 必须先用真实任务证明收益，不能在 P1–P5 之前启动。

## 4. 需要裁决的 5 件事

| # | 选择 | 建议 |
| --- | --- | --- |
| 1 | SQLite 驱动 | `node:sqlite`（内置，无 node-gyp）；P0 spike 验证 Electron 主进程 |
| 2 | 中文 FTS | trigram + LIKE 回退；P2 用真实中文查询验收 |
| 3 | 索引范围 | 第一版 TS/JS 精确，其他语言只做文件/文本，不假装语义 |
| 4 | 索引执行位置 | worker_threads（或 utilityProcess），主进程不跑长事务 |
| 5 | 统一检索入口 | 新增一个 `code.retrieve`，内部复用现有 `code.context` / `code.impact`，不改旧接口 |

如果这 5 项不先定，P1 会在“图中文/多语言/主线程/接口重复”上返工。

## 5. 最终判断

计划书的**目标与分层是对的**，尤其是：

- 不重建 Runtime、不重复审批；
- REFERENCES ≠ CALLS；
- 置信度与来源必须保留；
- 向量索引后置；
- 文件修改不能依赖索引成功。

但它现在更像“系统设计”，还不像“Codex 可执行任务书”。按本审核修正后，
0.2.0 的第一刀应落在 **P0a：node:sqlite + DDL + 契约 + 中文 FTS smoke**，
而不是直接写 CodeGraph 业务。

审核结论：**可以进入 P0a；P1–P5 暂不开始，先确认第 4 节 5 个决策。**
