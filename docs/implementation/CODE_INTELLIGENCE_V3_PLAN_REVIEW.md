# Agentic Search 实施计划 V3 审核

- 审核对象：`/Users/yalla/Downloads/制定辩论主题方案 (9)-20261113-1115-2.md`
- 审核基线：`5b2e56eb6e2502eb2e14d8fac841f0a16c46b22e`
- 当前代码：`main` / `0.2.1` 均指向 `5b2e56e`
- 审核日期：2026-11-13
- 上一轮审核：`CODE_INTELLIGENCE_AGENTIC_SEARCH_REVIEW.md`

---

## 1. 结论

**方向与优先级通过。Gate 0 可以收尾；Gate 1 有条件批准；Gate 2 暂不批准。**

这份 V3 比上一版更接近真实代码：基线选对了，指出 Agentic Search 只有 1 轮、Generation 没有原子性、扫描上限会误删、Java 仍是正则，也承认 15 个夹具只是 Spike。把“修复索引基础”排在 Agentic Search 前面，是正确的。

但仍有关键阻塞：

1. **Gate 1 的“稳定 Symbol ID”与 Gate 3 的 Java Tree-sitter 顺序冲突。** 当前 Java 没有 package、构造器、字段、Enum/Record 节点；Gate 1 只能用正则生成错的 Java 身份，Gate 3 再换会二次迁移。
2. **Generation 原子化只写了 nodes/edges，没有覆盖 FTS、vectors、Code-Memory Link、file_state、outbox。** 只改节点表仍会读到旧全文/旧向量/旧链接。
3. **Agentic Search 没有落到具体 Provider 协议和函数接入点。** 当前 `ModelRequest` 没有 tools 字段，`askWithReadTool()` 只有 1 轮；D2 只说“正式接入”，没有说改哪个类、哪个 Provider、Web 如何降级。
4. **Gate 2 的 30 个问题/3 个工程没有基准数据、通过阈值和成本上限。** “必须证明有增益”不是可执行验收。
5. **Evidence Pack 的引用没有稳定 ID、GC 策略和 Claim 关联。** `EngineeringEvidence` / `ExternalHit` 目前没有 `evidenceId` / `hitId`，旧 Generation 清理后 Pack 可能指向不存在的数据。

**建议批准范围**：Gate 0 收尾 + Gate 1A（Schema/TS-JS 基础）+ Gate 1B（扫描/Generation）。Gate 2 先做 D0.4 工具协议 ADR 和基准集，验收通过后再写多轮循环。Gate 3 的 Java Symbol ID 等 Tree-sitter 正式集成后再冻结。

---

## 2. 计划与当前代码核对

| 计划判断 | 代码事实 | 判断 |
| --- | --- | --- |
| 基线 5b2e56e | 当前 `main` / `0.2.1` HEAD 一致 | 正确 |
| Agentic Search 只有有限文件读取 | `conversation-runner.ts:903` 的 `askWithReadTool()`；`MAX_TOOL_ROUNDS = 1`；只有 4 个 fs 工具 | 正确 |
| Generation 没有真正快照 | `replaceFileIndex()` 就地删写；读查询不过滤 generation | 正确 |
| 大工程扫描可能误删 | `maxFiles=500`；`known` 只含本次扫描；`ensureFresh` 用 1000 | 正确 |
| Java 仍是行级正则 | `collectJava()`；`calls: []`；无 package/构造器/字段 | 正确 |
| 15 个夹具只是 Spike | `scripts/spikes/fixtures/java/*.java`，未进主链路 | 正确 |
| 本地模型已动态选择、移除 qwen | `localModels=[]`；`OllamaProvider.resolveModel()` | 正确 |
| 真机 live 有 SKIP | `test:ollama:live`：5 通过，2 SKIP | 正确 |
| Managed 文档落后于代码 | `CODE_INTELLIGENCE_PRODUCT_MODES.md:13` 仍写“Managed 暂不实现” | 正确，需同步 |
| 工程证据未统一接入 | `EngineeringEvidence` 只在对话/片段层使用，无 Pack 引用 | 正确 |

计划对现状的判断基本准确。下面是需要修改的地方。

---

## 3. P0 阻断项

### B1. Gate 1 的 Java Symbol ID 早于 Java 解析

计划 D1.3 要求“稳定 Symbol ID、方法重载区分、构造方法区分、同名类考虑模块和 package”；但 Java 的 package、构造器、字段、Enum/Record、嵌套关系要到 Gate 3 的 Tree-sitter 才正式提取。

当前事实：

- `collectJava()` 没有 package；
- `enum` 被映射成 `Class`；
- 构造器完全识别不到；
- 方法 `endLine` 不可靠；
- `CodeNodeType` 没有 `Enum` / `Annotation` / `Record` / `Constructor` / `Field`（`types.ts:3-13`）；
- `codeNodeId()` 仍包含 `filePath`（`store.ts:966`）；
- `code_memory_link.symbol_key` 不含模块和签名（`retrieval.ts:192`）。

如果 Gate 1 先冻结 Java symbol ID，得到的会是“没有 package、没有构造器、摸不到字段”的身份；Gate 3 换 Tree-sitter 后必须再迁移一次，链接和边会二次断裂。

**修订建议**：

- Gate 1 只冻结 **Schema + TS/JS Symbol ID + 通用身份规则**；
- Java Symbol ID 标记为 `provisional`，Gate 3 Tree-sitter 正式提取后再冻结；
- 或者把 Java 的 package/declaration 提取提前到 Gate 1，但这会扩大 Gate 1 范围，和“Gate 3 才接 Tree-sitter”冲突，不推荐。
- Gate 1 必须同时扩展节点类型与边类型，否则 Gate 3 还要改 schema：
  - `Enum` / `Annotation` / `Record` / `Constructor` / `Field` / `Parameter`；
  - `OVERRIDES` / `CREATES` / `ANNOTATED_BY` / `THROWS` / `READS` / `WRITES` / `INJECTS`。

**关闭标准**：D1.3 的交付物明确写“TS/JS 已冻结；Java provisional”，并有二次迁移测试。

### B2. Generation 原子化范围不完整

计划 D1.1 只写“新节点和边写入独立 Generation”。但当前索引不只有 nodes/edges：

- `code_search_docs` 与 `code_fts`：不带 generation；
- `code_vectors`：不带 generation；
- `code_memory_link`：不带 generation；
- `code_file_state`、`code_outbox`：与 generation 状态相关；
- `CodeIndexStore` 的 `getNode / findSymbols / search / getIncoming` 都只按 `project_id` 过滤。

只做节点和边的写时复制，仍然会出现：

- 旧 FTS 能搜到已删除文件；
- 旧向量仍参与 HYBRID；
- Code-Memory Link 指向旧节点；
- `current_generation` 切换后，检索结果混两代。

**修订建议**：

- D1.1 明确覆盖 FTS、vectors、docs、file_state、outbox、Code-Memory Link；
- FTS 增加 `generation UNINDEXED`，检索 join `code_search_docs.generation`；
- vectors 增加 generation，或在切换后按 doc generation 过滤；
- `Code-Memory Link` 在提交后统一校验：`active` / `needs_relink` / `pending_review`；不能静默绑同名；
- `replaceFileIndex()` 改为写新 generation，不再删除旧 generation；
- 旧 generation 清理前检查 Evidence Pack 引用（见 B5）。

**关闭标准**：失败/取消/崩溃后旧 generation 可读；新 generation 不可见；FTS/vector/link 都不能混代。

### B3. Agentic Search 没有落到 Provider 与具体接入点

计划 D2 写了很多能力，但没有回答实现边界：

- `ModelRequest` 目前没有 `tools` 字段（`providers/types.ts`）；Provider 只有 `toolCalling` 能力标志；
- `askWithReadTool()` 只支持 1 轮、JSON 文本解析；
- `project-tools.ts` 只有 4 个只读工具；
- Web 通道 `toolCalling: false`（`web-channel.ts:47`）；
- 计划没有指定改哪个函数、哪个 capability、是否新增 `project.explore`。

**修订建议**：D0.4 ADR 必须先写死：

1. **协议**：原生 tool calling 优先；JSON 兼容协议用于不支持 native 的本地模型；Web 不进入循环。
2. **接入点**：在 `conversation-runner` 扩展 `askWithEngineeringTools()`，复用 `SubAgentPool` / `askGuarded` / `mainCapabilities` / `TraceRecorder` / 取消/超时；不新建 Runtime。
3. **Provider 改动**：`ModelRequest` 是否增加 `tools`、`toolChoice`；Ollama `/api/chat` 与 OpenAI `/chat/completions` 的 tool 消息格式；错误/重试/取消。
4. **工具结果契约**：至少包含 `projectId / generation / total / truncated / warnings / sourceVersion / durationMs / evidenceRefs`；上一版计划定义的 `EngineeringToolResult` 只有 `success/data/error/evidence`，V3 仍没有补全。
5. **模型能力探测**：D0.4 的 `supports_native_tools` 等状态要缓存并显示在 UI；不能仅信 Provider 的 `toolCalling` 标志。
6. **Web 降级**：Web 模型只接收冻结 Evidence Pack；UI 显示“未自主探索”；Gate 2 必须有 Web-only 测试。
7. **安全**：路径 realpath 范围、密钥文件拒绝、正则超时/ReDoS、输出截断、源码内容按数据而非指令处理、云端外发提示。

**关闭标准**：D0.4 ADR 评审通过；`ModelRequest`/Provider/工具契约有具体 diff 范围；Web-only 和本地弱模型都有降级路径。

### B4. Gate 2 验收不可执行

计划要求“至少三个真实工程、30 个问题、证明跨文件理解有实际增益、成本可控”，但没有：

- 30 个问题在哪里、谁标注；
- 每个问题的期望文件/符号/行号、允许的未知项；
- 基线怎么跑、如何计分；
- 正确率、引用率、无证据结论率的具体门槛；
- 成本上限（token/耗时/工具调用）；
- 多模型并行探索的单独预算。

**修订建议**：

- 先建立 `docs/implementation/agentic-benchmark.md` 或 JSON manifest；
- 每个问题记录：`question / expectedFiles / expectedSymbols / expectedLines / allowedUnknown / antiAnswers / baselineResult / agentResult`；
- 指标：文件定位、符号定位、行号、候选关系、无证据结论、成本；
- 先 5 个问题（Gate 0），再 30 个（Gate 2）；不要用一次运行的数字当稳定结论；
- 明确“agent 不要求每个问题更快，但必须在跨文件/配置定位上有增益，且成本在预算内”。

**关闭标准**：基准集可复跑，评分脚本输出原始结果；没有“人工感觉更好”作为通过条件。

### B5. Evidence Pack 缺稳定 ID、GC 与 Claim 关联

计划 D4.1 的容器方向正确，但当前类型无法支撑：

- `EngineeringEvidence` 没有 `evidenceId`；
- `ExternalHit` 没有 `hitId`；
- `MemoryFact` 有 `factId`，`RetrievalItem` 有 `id`；
- `DebateEvidence` 有 `claimIds`、URL/span/fingerprint，但没有工程证据字段；
- `Verdict` 已有 `supported / partially_supported / unsupported / contradicted / insufficient_evidence`，计划又提出 `ConclusionStatus`，需要映射，不能形成第三套状态。

**修订建议**：

- `evidenceId = hash(path | line | endLine | fileSha256 | excerptHash)`；
- `hitId = hash(source | path | line | title | contentHash)`；
- Pack `evidenceRefs` 带 `type / id / generation / sha256`；
- 旧 generation 清理前 pin 被引用证据，或保留最小不可变摘要；
- Claim 增加 `engineeringEvidenceIds` 或关联表；
- `ConclusionStatus` 映射到现有 `Verdict` / `ClaimStatus`，写一张表；
- stale 检测：sha/mtime 不匹配 → `stale`，不能支撑 `verified`。

**关闭标准**：Pack 每个 ref 可解析；旧 generation 清理后仍可审计或明确 stale；关键结论有 evidence ID。

### B6. 成本数据与模型结论不一致

计划 2.5 已指出“文档中的部分成本比例与逐条测试数据不完全一致”，这是正确的自我修正。当前报告中：

- 本地 agent 两次运行结果不同（一次 3/3，一次 2.75/3）；
- 云端 agent 引用数/耗时也有波动；
- API 返回 cost 0 只代表当前额度；
- live 测试 2 条 SKIP，不能算通过。

**修订建议**：

- 用原始 JSON 重新生成成本表，不手工抄比例；
- 记录每次运行，不只报告最好一次；
- 至少 5 个问题、2 次重复，再谈“稳定”；
- 明确本地/云端/token/耗时/工具调用四项成本；
- 不许把 SKIP 写成 PASS（计划已写，执行时要遵守）。

### B7. Java/Tree-sitter 的生产化还有几个缺口

计划 D3.1/D3.2 方向正确，但补充：

- `IGNORED_DIRS` 目前没有 `target`、`.gradle`、`.mvn`；Maven/Gradle 生成源码会被索引；
- `maxFileBytes` 默认 256 KB；大文件/生成文件要明确截断与警告；
- 索引仍在主进程；Gate 1 只“测量”，但应给出 worker 触发阈值，否则 10k 文件仍会卡 UI；
- `web-tree-sitter.wasm` 运行时 + Java grammar 都要进安装包；当前只验证 grammar 从 asar 读取；
- `web-tree-sitter` / `@vscode/tree-sitter-wasm` 现在在 devDependencies；Gate 3 必须进入 production packaging；
- TS/JS 继续用现有 TypeScript AST，不要在 Gate 3 静默切换；
- Tree-sitter 的 `CALLS` 是语法调用表达式，目标可能未解析；只能 `ambiguous/inferred`，不能直接 `resolved`。

---

## 4. Gate 修订建议

### Gate 0：收尾

保留计划的 6 项，但加通过条件：

| 项 | 必须产出 |
| --- | --- |
| ADR 状态 | 0001/0002/0003/0004/0005 逐条 Accepted/Deferred，不接受全部 Proposed |
| 5 个基准问题 | 每题含期望文件/符号/行号/反例 |
| 模型工具探测 | 本地默认模型、gpt-oss 类模型、云端模型各一条结果；失败可复现 |
| Maven 信任 | 默认不执行、拒绝后静态扫描、批准后执行、超时/取消 |
| Web 降级 | Web-only 配置的 UI 文案和证据包路径 |
| 成本复核 | 从原始 JSON 重算，不用手写比例 |

### Gate 1：拆成 1A / 1B

- **1A：Schema/身份基础**
  - v3→v4 迁移与回滚；
  - 节点类型/边类型扩展；
  - TS/JS Symbol ID 冻结；
  - Java ID 标 provisional。
- **1B：扫描/Generation**
  - complete/truncated/failed/cancelled；
  - 截断不删除；
  - 统一 maxFiles；
  - FTS/vectors/links 的 generation；
  - 失败/取消/崩溃测试；
  - 5k/10k 性能数据与 worker 决策。

**不要**在 1B 之前用 Java 正则冻结 symbol ID。

### Gate 2：先 ADR，再写循环

- D0.4 ADR 通过后再写 `askWithEngineeringTools`；
- 工具契约、Provider 协议、能力探测、Web 降级、预算、Trace、取消先定；
- 先 5 个问题通过，再扩到 30 个；
- 30 个问题必须有 manifest 和评分脚本。

### Gate 3：Tree-sitter 正式化

- 安装包内验证 runtime wasm + grammar；
- production dependency/打包路径；
- `target/.gradle` 忽略；
- 节点/边类型与 `resolutionStatus` 落地；
- 解析错误、取消、大文件；
- TS/JS AST 回归。

### Gate 4：Evidence

- 稳定 ID、Pack pin/GC、Claim 关联、stale；
- `Verdict`/`ConclusionStatus` 映射；
- Code-Memory Link 的 `needs_relink`/`pending_review` 实际使用。

### Gate 5：Debate

- 工程证据 → `DebateEvidence` 的映射；
- Web 模型标注“未自主探索”；
- Judge 证据 ID 校验；
- 多模型并行共享快照与预算；
- 少数派/未解决项保留。

---

## 5. 批准范围

| 阶段 | 结论 | 条件 |
| --- | --- | --- |
| Gate 0 收尾 | **批准** | 按上表补齐 6 项 |
| Gate 1A | **批准** | 先做 Schema v4/迁移/TS-JS ID；Java provisional |
| Gate 1B | **批准** | 扫描完整性、Generation 全表覆盖、回滚测试 |
| Gate 2 | **暂不批准** | D0.4 ADR + 5 问题基准先通过 |
| Gate 3 | 暂不批准 | Gate 1B + 安装包验证通过 |
| Gate 4/5 | 暂不批准 | Gate 2/3 结果 |

不建议一次把 Batch 0～6 全交给 Codex。计划最后也说了先 Batch 0/1；这个判断正确。

---

## 6. 最终意见

这份计划已经可以作为当前主线，**优先修数据基础、再接 Agentic Search** 的顺序是对的。主要问题不是方向，而是三处“看起来已经设计、实际还没落地”的边界：

- Gate 1 的 Java Symbol ID 早于 Java 解析；
- Generation 只覆盖 nodes/edges，没覆盖 FTS/vectors/links；
- Agentic Search 没有 Provider/工具契约/基准阈值。

把这三处写进 ADR 和验收命令，再开始 Batch 0/1，风险最低。

**一句话**：V3 选对了顺序，但 Gate 1 不能先冻结 Java 身份，Gate 2 不能先写 8 轮循环；先把 Generation、扫描完整性和工具协议钉死。
