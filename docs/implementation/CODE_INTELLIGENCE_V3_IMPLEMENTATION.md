# Engineering Intelligence V3.0：Phase 0 实施记录

日期：2026-11-12。分支：`0.2.0`。
基线：`fd657ec`（V1.2 P2）。
依据：`制定辩论主题方案 (7)-20261112-1351-10.md`（V3.0）。

## 1. 环境结论

Phase 0 实测：

| 项目 | 结果 |
| --- | --- |
| 芯片 / 内存 | Apple M5 / 24GB |
| 磁盘 | 约 418GB free |
| Python | 3.9.6（不满足 CGC/Graphiti 的 >=3.10） |
| Java | 21.0.11 |
| Neo4j | 未安装 |
| Docker | 29.9.0（仅 PoC 可用） |
| uv / pyenv | 未安装 |
| `node:sqlite` | Electron 45 / Node 24.22.1 / SQLite 3.53.4，可用 |
| FTS5 | 可用；trigram 可建 |

因此：

- CGC / Graphiti / Neo4j 的正式集成**不能标记为已验证**；
- 按 V2.0-PoC 的失败回退规则（V3.0 保留 Adapter 可替换原则），先交付
  **本地方案 A/B**：LSP/AST + SQLite + FTS5 + Project Memory + Code-Memory Link；
- CGC / Graphiti / Neo4j 仍是候选，状态为 `SPECIFIED`，不是 `IMPLEMENTED`。

这不是把未完成说成完成：本地核心已经在真机上跑通并有测试；外部组件没有
运行环境，所以没有被写成「已接入」。

## 2. 本次已实现

### 2.1 本地事实库

`src/main/code-index/store.ts`

- `node:sqlite` 的 `DatabaseSync`，WAL、foreign_keys、busy_timeout；
- 迁移：`PRAGMA user_version`；
- 表：
  - `code_generation`：pending / building / ready / superseded / failed；
  - `code_file_state`：文件 hash、size、mtime、generation；
  - `code_nodes`：Project / File / Class / Interface / Function / Method /
    Variable / Type / Package；
  - `code_edges`：CONTAINS / IMPORTS / CALLS / REFERENCES / EXTENDS /
    IMPLEMENTS / DEFINES / DEPENDS_ON，带 confidence / source；
  - `code_search_docs` + `code_fts`（FTS5 trigram）；
  - `code_memory_facts`：candidate / confirmed / deprecated；
  - `code_memory_link`：symbol_key / locator / fingerprint / status；
  - `code_outbox`：任务、generation、payload hash、状态、重试计数字段。

### 2.2 AST 索引器

`src/main/code-index/indexer.ts`

- 扫描 TS/TSX/JS/JSX/MJS/CJS；
- 复用 `lsp/ts-ast.ts` 的 TypeScript 加载；
- 提取声明、相对 import、AST 调用点；
- 生成：
  - File / Class / Interface / Function / Method / Variable / Package 节点；
  - File CONTAINS 符号、Class CONTAINS 方法；
  - 相对 import → IMPORTS；
  - 外部包 → DEPENDS_ON；
  - 调用名唯一命中 → CALLS（AST/HIGH）；多候选 → POSSIBLE；
- 不把正则匹配当精确关系；
- 每个文件一个 generation 内替换，重复索引幂等（节点去重、边 `INSERT OR IGNORE`）。

### 2.3 检索

`src/main/code-index/store.ts` + `retrieval.ts`

- FTS5 trigram：≥3 字子串；
- 1–2 字中文走 `LIKE` 回退（实测「登录」可命中）；
- `MATCH` 查询先转义 token，不拼接用户原文；
- 图谱查询：`findSymbols` / `getOutgoing` / `getIncoming` / `impact`；
- `KnowledgeRouter` 规则：
  - 调用/引用/影响/定义/依赖 → CODE；
  - 为什么/以前/历史/决策/约束 → MEMORY；
  - 两者都有 → HYBRID；
- `assembleContext`：代码优先、已确认记忆其次、候选最后，带字符预算、去重、来源、
  置信度和警告。

### 2.4 主进程门面与 Agent 工具

`src/main/code-index/service.ts`

- `CodeIndexService`：按工作区真实路径生成 projectId，同一个 DB 内隔离；
- `index` / `summary` / `retrieve` / `context` / `impact` / `remember` / `link`；
- `ensureFresh`：检索前用轻量 `stat` 扫描比对文件集合/size/mtime；新增、删除、
  修改都会触发重建，不把旧索引当最新结果；
- `watch` / `unwatch`：`fs.watch` 递归监听源码扩展名，700ms 去抖后后台重建；
  界面挂载面板时自动开启，每 4 秒刷新状态；
- 索引器默认增量：内容 hash 没变的文件只推进 generation，不重写节点/边；
- 同一工程并发索引只跑一份（Promise 去重）。

主进程新增只读能力 `code.search`：

- 参数：`query`、`mode`（CODE/MEMORY/HYBRID）、`limit`、`context`；
- 第一次调用若没有 READY generation，先建索引；
- 返回每条结果的路径、行号、来源、置信度、警告；
- `context=true` 时附一段可直接放进模型的预算内上下文；
- root 由 Runtime 从 TaskGrant 注入，模型不能自己换根。

能力总数从 94 变为 95（89 Runtime + 6 主进程），设置页能看到 `code.search`。

### 2.5 记忆与关联

- `remember`：必须带来源；默认 candidate；confirmed 仅由调用方明确指定；
- `linkSymbolToMemory`：
  - `symbolKey` **不含文件路径**（`project|language|qualifiedName|kind`）；
  - 文件路径只进 `symbolLocator`；
  - 写 `code_memory_link`，状态 active/needs_relink/...
- 这修正了 V3.0 计划 5.1 里 SymbolKey 包含 filePath 的矛盾。

## 3. 真机验证

### 3.1 测试

```bash
cd desktop-agent-macos
npm run test:code-index
```

9 条：

1. 真实 TS 工程索引：节点、CONTAINS / IMPORTS / CALLS；
2. 中文两字 LIKE 回退、三字 trigram、标识符；
3. FTS 查询转义；
4. 影响分析沿 incoming 调用边；
5. 记忆 candidate/confirmed/来源必填；
6. Link 的 SymbolKey 不含文件路径；
7. Generation pending 不冒充 READY；
8. 删除文件清理节点/文档/状态；
9. Router 规则与 Context Assembly 预算。

全绿。

### 3.2 用 ThinkFusion 自身工程跑一遍

```bash
node scripts/check-code-index-live.mjs
```

实测（`src/`，212 个 TS/TSX 文件）：

```json
{
  "files": 212,
  "nodes": 6667,
  "edges": 26803,
  "docs": 5949,
  "generation": 1,
  "indexMs": 1775,
  "queryHits": 4,
  "first": "runCodingTeam",
  "dbBytes": 21684224
}
```

即：约 1.8 秒建完 212 个文件，DB 约 21.7MB，`runCodingTeam` 能命中。

应用已用最新构建启动，`getCapabilities` 返回 95 条，包含 `code.search`。

### 3.3 界面

工程空间新增 `CodeIndexPanel`（只在工程模式显示）：

- 显示 READY generation、文件/节点/边/文档数；
- 「建立/更新索引」；
- 搜索框 + CODE / MEMORY / HYBRID；
- 结果带路径、行号、来源、置信度；可展开组装后的上下文。

真机 UI 验证：切换工程工作区到本仓库，建立索引后搜 `runCodingTeam`，
面板返回 6 条，第一条是 `src/main/coding/team.ts` 的 FTS5/CodeGraph 结果。
文件 watcher 真机验证：新增 `src/__watch_probe.ts` 后 generation 4→5、
文件 318→319；删除后 5→6、319→318。

## 4. 明确未完成

| 能力 | 状态 | 原因 |
| --- | --- | --- |
| CGC 集成 | SPECIFIED | 无 Python 3.12 / CGC 运行环境 |
| Graphiti 集成 | SPECIFIED | 无 Python 3.12 / Neo4j / embedding 模型 |
| Neo4j | SPECIFIED | 未安装；GPLv3 分发未定 |
| VectorStore | SPECIFIED | 没有 embedding 模型，未做召回验证 |
| 增量索引 worker / 文件 watcher | 未做 | 当前每次全量索引；需要 P5 |
| Outbox 执行器 / Reconciliation | 表已建，执行器未做 | 需要 P5 |
| Agent / UI 接入 | 未做 | 需要 Phase 7；当前是主进程可调用模块 |
| Java Provider | 未做 | 当前只有 TS/JS AST |

这些不标记为 `IMPLEMENTED` 或 `VERIFIED`。

## 5. 下一步（按 V3.0 Gate）

1. 建 Python 3.12 独立环境，跑 CGC/Graphiti PoC；
2. 给本地 store 加 Outbox worker、增量索引、文件变更通知；
3. 接 `code.index` / `code.search` / `code.impact` 到主进程和 Agent；
4. 用真实任务验证检索质量和上下文预算；
5. 再决定 Neo4j/Graphiti/Vector 是否进入正式架构。

## 6. 设计边界

- 不新建 Runtime、审批、Journal；
- 不修改 AgentOrchestrator / TaskGrant；
- 不把 SQLite 当作 Graphiti/CodeGraph 的替代品来宣称「已完成」；
- 图库/记忆后端通过接口隔离，后续可替换；
- 当前本地实现是 V3.0 的回退路径，不是 CGC/Graphiti 已通过的证明。
