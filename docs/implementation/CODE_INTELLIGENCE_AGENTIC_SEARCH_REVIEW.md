# Agentic Search 工程智能路线复审（V2.0）

- 审核对象：`/Users/yalla/Downloads/制定辩论主题方案 (9)-20261112-2030-2.md`
- 审核基线：`4cfd972a81e7fba27848bf6010eeaa1f3d1aa01f`（0.2.0）
- 审核日期：2026-11-12
- 上一轮审核：`docs/implementation/CODE_INTELLIGENCE_JAVA_REVIEW.md`
- 结论：**技术路线通过；Gate 0 有条件通过；Gate 1 及以后暂不批准。**

---

## 1. 复审结论

V2.0 相比 V1 的 Java 优先版是一次实质性修正，不是换说法：

- 不再把 JDT / 完整调用图 / 编译器级语义作为前置条件；
- 把 Agentic Search 提升为核心，承认大模型负责理解、本地负责事实；
- 明确 Tree-sitter 只是候选，必须先做 Electron spike；
- 明确 Maven / Gradle 执行风险，给出 Level 0/1/2 信任边界；
- 明确 Evidence Pack 是引用现有证据的冻结快照，不新建第四套事实模型；
- 明确稳定 Symbol ID、边解析状态、Generation 和悬空边清理；
- 明确当前只批准 Gate 0，不改主链路。

这些判断我同意。上一轮审核中的 JDT 强制、构建脚本执行、Evidence Pack 重复、D6/D7 顺序、验收指标不可执行等阻断项，V2 已经大部分回应。

但 V2 仍然**不能直接按字面开工**。原因不是方向，而是 Gate 0 里还有三个没有回答的工程问题，以及几个“看起来已经解决、实际代码还不支持”的落差：

1. **Agentic Search 不是现有 Runtime 的小扩展。** 现有工程执行是“先出计划、审批、再执行”，现有的模型自主读文件只支持 1 轮、4 个只读工具；V2 要 8 轮、13 个工具，还要多模型并行探索。工具协议、模型能力矩阵、Web 通道降级都没定。
2. **Generation 原子更新目前不成立。** 现有 `generation` 只是元数据，读查询不过滤 generation；`replaceFileIndex()` 是就地删除/写入。构建中途失败时，旧 generation 标成 failed，但读路径已经能看到半新半旧的数据。V2 的“任何阶段失败不破坏现有索引”需要真实改造，不能只写 ADR。
3. **大工程会被 `maxFiles` 截断并误删。** 当前默认最多 500 个文件，`known` 集合只包含本次扫描到的文件；超过上限的旧文件会被当成“已删除”清掉。`ensureFresh()` 又用 1000 的上限扫描，和 500 的索引上限不一致，大工程可能每次检索都触发重建。
4. **Evidence Pack 的引用没有稳定 ID。** `EngineeringEvidence` 没有 `evidenceId`，`ExternalHit` 没有 `hitId`；Pack 里的 `evidenceRefs.id` 无法解析。旧 generation 清理后，Pack 可能指向不存在的数据。
5. **工具契约与安全边界不完整。** `EngineeringToolResult` 没有项目 ID、generation、截断、总数、耗时等字段，和 4.2 的要求不一致；`readFile` 的“读取完整文件”和 300 行预算冲突；正则搜索、密钥文件、代码外发、提示注入都没有边界。

所以：**Gate 0 可以批准，但要先收窄范围并定义通过/不通过标准；Gate 1 及以后不批准。**

---

## 2. 与上一轮审核的对照

| 上一轮阻断项 | V2 的处理 | 复审判断 |
| --- | --- | --- |
| 强制 JDT、JDT 运行时/许可证未定 | 10.1 明确第一阶段不要求 JDT；10.2 改为后续按需评估 | **已解决方向**，不再阻断 Gate 0 |
| Tree-sitter 打包/ABI 未定 | D0.5 要求 Electron spike，比较 Native/WASM、asar、公证 | **部分解决**，spike 范围仍过大 |
| Maven/Gradle 导入执行工程代码 | 第十一章 Level 0/1/2，默认不执行未知脚本 | **方向正确**，需映射到现有 TaskGrant/审批 |
| 符号 ID 含 filePath、重载合并、边无状态 | 6.2/6.3 + D0.2 Schema v4 ADR | **方向正确**，节点类型和迁移细节不足 |
| Evidence Pack 与现有证据重复 | 5.1 明确只做引用容器 | **方向正确**，缺稳定 ID、claim 关联、GC 策略 |
| 98%/95% 指标不可执行 | D0.7 人工基准集，14.2 明确不能模型自评 | **明显改进**，Gate 2 仍缺通过阈值 |
| D6/D7 顺序绑定 JDT | 改为 Gate 3/4，Gate 2 先做 Agentic Search | **已解决** |
| TS/JS 回归 | 14.1 有功能测试，但没有明确“不切换 TS/JS 解析器” | **仍需补** |

---

## 3. 新的 P0 阻断项

### P0-A：Agentic Search 与现有 Runtime 的接入方式未定

V2 说“不另建 Agent Runtime”，但 Agentic Search 本身就是一个多轮工具循环。需要明确它接在哪里。

现状：

- `AgentOrchestrator` 是“提交 → 计划 → 审批 → 执行”的网页任务编排，不是开放式 ReAct 循环（`src/main/orchestrator.ts:88`）。
- 现有的模型自主读文件在 `conversation-runner.ts:903` 的 `askWithReadTool()`，只支持：
  - `MAX_TOOL_ROUNDS = 1`（`research/project-tools.ts:52`）；
  - `fs.stat / fs.readFile / fs.search / fs.list` 四个只读工具（`project-tools.ts:28`）；
  - 通过模型输出里的 JSON 识别请求（`parseToolRequest`），不是原生 function calling。
- `ModelRequest` 没有 `tools` 字段；Provider 只有 `toolCalling` 能力标志（`providers/types.ts:51`），没有真正的工具 schema 调用链。
- 网页通道 `toolCalling: false`（`web-channel.ts:47`），不能自主调用工具。

V2 要求 8 轮、13 个工具、多个模型并行探索，并说 Web/Local/Cloud/Hybrid 都可以用。这里至少有三个未决问题：

1. **工具协议**：用原生 function calling，还是继续 JSON-in-text？前者要改 Provider 请求/响应和每家 API 的 schema；后者要处理模型把 JSON 写进正文、解析失败、重复请求、上下文膨胀。
2. **模型能力矩阵**：默认本地模型是否能稳定发起工具调用？Web 通道不能；如果用户只选网页模型，Agentic Search 是否退化为“本地预检索 + 单次回答”？必须明确，不能静默假装在探索。
3. **接入点**：是扩展 `askWithReadTool()` 为可配置的 `project.explore`，还是新建一个独立的探索循环？如果新建，是否违反“不另建 Agent Runtime”？需要写清楚复用 `SubAgentPool`、`mainCapabilities.execute`、`TaskGrant`、`TraceRecorder` 的具体位置。

**Gate 0 关闭标准（D0.4 ADR）**：

- 明确选择：原生 tool calling / JSON 协议 / 两者兼容；给出每种 Provider 的请求与解析路径。
- 明确接入点：`conversation-runner` 的哪个函数、`mainCapabilities` 的哪个 capability、哪些现有预算/取消/追踪直接复用。
- 明确模型矩阵：默认本地模型、至少一个云端 API、网页通道；每种模式的行为和降级文案。
- 明确 Web 通道边界：网页模型不进入工具循环；只接收已冻结的证据包，或明确提示“当前模型不能自主搜索”。
- 明确 AGENTS.md 规则 #1 不被破坏：普通提问的 `question` 仍是用户原话；工具结果作为独立材料，不拼成固定角色提示词；网页通道不应看到工具指令。

### P0-B：Generation 原子更新目前不成立

V2 12.2 要求“构建 Generation 11 → 完整性检查 → 原子切换 → 清理旧 Generation；任何阶段失败都不能破坏现有可用索引”。

现有实现不是这样：

- `beginGeneration()` 只插入一条 `building` 记录（`store.ts:245`）。
- `replaceFileIndex()` 直接 `DELETE` 当前文件的 nodes/edges/docs，再写入新 generation（`store.ts:374`）。
- `commitGeneration()` 只把 generation 状态改成 ready/superseded（`store.ts:257`），没有切换数据快照。
- `failGeneration()` 只把 generation 标成 failed（`store.ts:274`），**不会撤销已经写入的文件**。
- 读路径 `getNode / findSymbols / listNodes / getOutgoing / getIncoming / search` 都只按 `project_id` 过滤，没有 `generation = current`（`store.ts:659-735`）。
- 因此构建失败或中途取消后，读路径会看到“部分文件是新 generation、部分是旧 generation”的混合状态。

这不是加一个 `generation` 列能解决的，是索引读写模型的改造。Gate 1 之前必须二选一：

- **方案 A：影子 generation**。新 generation 写到 `code_nodes_next / code_edges_next / code_search_docs_next`，提交时在事务里切换表或指针；旧表保留到清理。读路径永远读 active 表。
- **方案 B：全量 generation 过滤**。所有读查询加 `generation = current_generation(project)`；旧 generation 保留，提交后清理。代价是每个查询都要改，索引体积也会增长。

**Gate 0 关闭标准（D0.2 ADR）**：

- 写出具体 SQL / 表结构 / 切换步骤，不只写概念。
- 覆盖失败、取消、崩溃三种情况：旧 generation 仍可读；新 generation 要么完整，要么不可见。
- 覆盖悬空边：提交前检查 `target_node_id` 存在；目标文件删除时，入边清理或标 `unresolved`。
- 覆盖回滚：迁移失败保留 v3 可读，不能要求用户删库重建。
- 覆盖旧数据：TS/JS 现有节点 ID、Code-Memory Link、旧 generation 的兼容策略。

### P0-C：大工程会被 `maxFiles` 截断并误删

V2 反复强调大型工程、增量索引、不阻塞主界面。当前代码有三处直接冲突：

1. **默认最多 500 个文件**：`indexProject()` 用 `maxFiles: options.maxFiles ?? 500`（`indexer.ts:428`），`walk()` 达到上限就停止（`indexer.ts:285`）。
2. **截断后误删旧文件**：`known` 集合只包含本次 `walk()` 返回的文件（`indexer.ts:436`）；随后 `for (const old of store.listFiles(projectId)) if (!known.has(old.filePath)) store.deleteFile(...)`。超过 500 的文件不在 `known` 里，会被当成删除。对 5000 个 Java 文件的工程，第一次索引就会把未扫描到的旧索引清掉。
3. **freshness 上限不一致**：`ensureFresh()` 用 `maxFiles: 1000` 扫描（`service.ts:150`），索引只存 500；如果工程大于 1000 个文件，`current.length !== previous.size` 会一直成立，可能每次检索都触发重建。
4. **Java 构建输出没有忽略**：`IGNORED_DIRS` 没有 `target`、`.gradle`、`.mvn`，Maven/Gradle 生成的 `.java` 会被当源码索引（`indexer.ts:24-27`）。
5. **主进程阻塞**：`indexProject()` 的 AST 解析和 `node:sqlite` 写入都在主进程；`fs.watch` 回调直接 `this.index(root)`（`service.ts:95-119`）。大工程会把主进程占满，V2 的“不阻塞主界面”没有实现路径。

**Gate 1 关闭标准**：

- 明确“扫描是否完整”：`walk()` 返回 `complete: boolean`；不完整时**禁止删除未扫描到的旧文件**，UI 显示“已索引 500/12000，未扫描部分保留旧索引”。
- 支持 source root / 模块优先：Maven/Gradle 先索引 `src/main/java`、`src/test/java`，再按预算扩展；默认排除 `target`、`build`、`.gradle`、`.mvn`、`out`、`generated`。
- 统一 `maxFiles`：`ensureFresh` 与 `index` 使用同一上限，或者用“文件清单分页/目录游标”代替一次性截断。
- 索引放到 worker / utility process：主进程只处理 IPC、进度、取消；SQLite 写入在 worker 内完成，避免 UI 卡顿。
- 进度与取消：显示已扫描/已索引/跳过/截断；用户切换工程时可取消。
- 大工程测试：至少 5k / 10k 文件两个夹具，验证不会误删、不会无限重建、主进程响应不被阻塞。

### P0-D：工具契约与安全边界不完整

V2 4.2 要求工具返回：工程 ID、路径、行号、文件版本/指纹、搜索方式、结果数量、是否截断、错误信息。但接口只有：

```
interface EngineeringToolResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  evidence?: EngineeringEvidence[];
}
```

这不够，也无法表达“结果被截断”和“索引版本”。建议至少增加：

```
projectId: string;
generation?: number;
sourceVersion?: string;
total?: number;
truncated?: boolean;
warnings?: string[];
durationMs?: number;
```

其他安全边界：

- **路径越界**：所有工具必须复用 `project.read` 的 `resolveInScope()`（realpath、工程目录 + 附件），不能只做字符串前缀判断；符号链接必须挡住。
- **密钥文件**：Level 0 默认允许静态读取，但 `.env*`、`*.pem`、`*.key`、`id_rsa*`、`.aws/credentials`、`*.p12`、`*.jks` 等应默认拒绝或明确警告。Agentic Search 会把这些内容发给云端模型，必须有外发策略。
- **正则搜索**：模型提供的正则可能是非法或 ReDoS；需要编译校验、输入/结果上限、超时，最好放 worker 执行。
- **完整读取 vs 预算**：`readFile` 写“读取完整文件”，但 4.4 又说单文件默认 300 行。必须统一：小文件全文，大文件返回统计 + 指定区间，并标 `partial`。
- **提示注入**：源码内容是不可信数据，不能当指令执行；工具结果要有明确边界标记，模型结论必须引用证据，不得因为注释里写了“请执行 X”就改变任务。
- **Git 工具**：`getGitDiff/getGitHistory` 要限制提交数/文件数/输出大小，使用只读参数，避免在读取时修改 index；不要在工程里执行任意 git alias。
- **外发与本地模式**：工程代码可能敏感。默认本地模型/本地索引；云端模型需要明确提示“将发送哪些文件片段”，并允许用户拒绝。

**Gate 2 关闭标准**：工具契约、权限映射、路径范围、密钥拒绝、正则超时、输出截断、外发提示都有测试；不能用“模型自己会遵守”代替代码边界。

### P0-E：Evidence Pack 的引用没有稳定 ID

V2 5.2 的 Pack 是正确方向：`evidenceRefs` 只存引用，不复制内容。但现有类型无法支撑：

| Pack 引用类型 | 现有类型 | 是否有稳定 ID |
| --- | --- | --- |
| `engineering-evidence` | `EngineeringEvidence`（`shared/conversation.ts:15`） | **没有**；只有 path/line/sha256 |
| `retrieval-item` | `RetrievalItem` | 有 `id` |
| `memory-fact` | `MemoryFact` | 有 `factId` |
| `external-hit` | `ExternalHit`（`external.ts:10`） | **没有**；只有 source/title/path/line |

因此 `evidenceRefs: Array<{type, id}>` 里至少两类无法解析。需要：

- 给 `EngineeringEvidence` 增加 `evidenceId`（可由 `path + line + sha256 + readAt` 派生，或落库时生成）。
- 给 `ExternalHit` 增加 `hitId`（或 `source + path + title + content` 的稳定 hash）。
- Pack 引用带 `generation` 和 `sourceVersion`；解析时校验版本。
- **GC 策略**：Pack 引用旧 generation 的证据时，不能直接清理；要么 pin 住被引用的证据，要么在 Pack 里保留最小不可变快照（path/line/sha/excerpt 摘要）。V2 说“不复制内容”，但没有说“引用永不清理”，这两者需要明确取舍。
- **Claim 关联**：V2 5.3 要求“每个重要结论必须标注来源类型”，但现有 `DebateClaim` 只有 `evidenceDrafts`，`DebateEvidence` 有 `claimIds`；工程证据没有 claim 关联字段。需要在 claim 上增加 `engineeringEvidenceIds`，或建 claim↔evidence 关联表；否则“每个结论可追溯”只能停留在 UI 列表。
- **ConclusionStatus 与现有 Verdict 重复**：`debate/types.ts:404` 已有 `Verdict`（supported / partially_supported / unsupported / contradicted / insufficient_evidence），`ClaimStatus` 也有 proposed/supported/challenged/revised/withdrawn/unresolved。V2 的 `ConclusionStatus` 应映射到现有枚举，或明确新增字段只用于工程结论，不要再造第三套状态。

**Gate 3 关闭标准**：

- Pack 的每个 ref 都能解析到具体记录；解析失败时 `status = stale`，不是静默跳过。
- 代码变更后，sha/mtime 不匹配的证据标 stale；stale 证据不能支撑 `verified`。
- `verified` 只能来自用户确认、测试/构建证据或确定性工具；模型推断不能自动升级。
- 结论状态与 `Verdict` / `ClaimStatus` 的映射写成表，避免 UI 出现两套“支持/不支持”。

---

## 4. 产品承诺与能力边界

V2 1.1 列了几个产品问题：

- “找出某个方法的所有调用方”
- “分析一次代码变更的影响范围”
- “找出潜在的循环依赖”

在“不做完整调用图、不做类型绑定”的路线下，这些只能是**可能的调用点/候选影响集**，不是确定答案。`findReferences` 在 V2 4.2 里已经写了“搜索可能的引用位置”，这是对的；但产品目标里没加限定，容易让用户以为能得到精确结果。

建议：

- UI 和报告统一用“候选调用点”“可能受影响”“未验证关系”，并给出证据行号和搜索方式。
- `findReferences` 的返回必须带 `resolutionStatus: ambiguous | inferred`，不能因为文本命中就标 `resolved`。
- 只有同时满足“目标符号身份唯一 + 调用点语法明确 + 证据可复核”时，才允许 `resolved`；否则保留候选集。
- Gate 2 验收要测“误报”而不只是“找到”：例如 `save()`、`get()` 这类常见方法名，必须能说明哪些命中是候选、哪些被排除。

另外两个能力边界必须在 Gate 0 说清楚：

1. **Web 通道不能自主探索**。网页模型 `toolCalling: false`，只能接收已组装的证据包。V2 说“Web/Local/Cloud/Hybrid 都可以使用不同策略”，但 Agentic Search 只适用于能调用工具的 API 模型。Web 模型的正确角色是“基于同一份冻结证据进行辩论”，不是“自己搜索”。
2. **默认本地模型可能不具备稳定的工具调用能力**。如果 Core 的默认本地模型不能可靠输出工具请求，Agentic Search 在 Core 独立运行场景下会退化。D0.6 必须用实际默认模型跑，并给出“工具调用成功率 / 需要重试次数 / 最终答案质量”；不能只用一个强云端模型证明可行。

---

## 5. Gate 0 范围收窄

V2 的 Gate 0 包含 8 个子任务：审计、Schema ADR、Evidence ADR、Agentic Search ADR、Tree-sitter spike（Java/Go/Python/TS）、Agentic Search spike（5 类问题）、Java 基准集（15 + 30-50 + 7）、构建信任 spike。这个范围作为“Gate”太大，容易变成又一轮长期建设。

建议拆成 Gate 0A / 0B：

### Gate 0A：决策（必须先做）

| 任务 | 产出 | 通过标准 |
| --- | --- | --- |
| D0.1 代码审计 | 现状能力/缺口/重复建设清单 | 逐条对应到文件/函数；确认不改主链路 |
| D0.2 Schema v4 ADR | 符号 ID、边状态、generation 原子切换、迁移/回滚 | 有 SQL、有失败场景、有旧数据兼容 |
| D0.3 Evidence Mapping ADR | Pack 与现有四类证据的 ID/引用/GC/claim 关联 | 每个 ref 可解析；stale 规则明确 |
| D0.4 Agentic Search ADR | 工具协议、接入点、模型矩阵、预算、取消、Web 降级 | 明确复用哪些现有模块；不新建 Runtime |
| D0.5 构建信任 ADR | Level 0/1/2 与 TaskGrant/审批映射 | 默认不执行未知构建脚本 |

### Gate 0B：最小验证

| 任务 | 范围 | 通过标准 |
| --- | --- | --- |
| Tree-sitter spike | **只做 Electron + Java**；Native/WASM 二选一 | 主进程可加载；asar 打包可运行；20 个 Java 样本；记录冷启动/RSS/错误位置 |
| Agentic Search spike | **一个真实工程、一个默认本地模型 + 一个云端模型、3～5 个问题** | 每个问题有期望文件/行号；记录轮数、工具调用成功率、证据准确率、耗时；与“一次性预检索”基线对比 |
| 构建信任 spike | Gradle 自定义 task / Maven 插件 | 默认不执行；确认后才执行；拒绝后仍能静态索引 |
| 基准集骨架 | Java 21 为主，Java 8 一个样本；TS/JS 现有测试保留 | 先能跑，不追求全矩阵 |

**暂缓到 Gate 1/2**：

- Go / Python / TypeScript 的 Tree-sitter 接入；
- Java 8/11/17/21 全矩阵；
- 7 个工程夹具、30～50 个理解用例；
- 完整 Evidence Pack UI；
- 多模型并行探索。

理由：Gate 0 只需要回答两个决定性问题：

1. Tree-sitter 能不能在 Electron 里稳定、可打包地解析 Java？
2. 模型能不能通过搜索/读取/继续探索，在真实工程里得到可追溯的结果？

这两个问题不过，后面的 Schema、图谱、辩论都不值得继续。

---

## 6. Gate 1～5 的修订建议

### Gate 1：本地工程事实层

在 V2 任务上补：

- **不切换 TS/JS 解析器**：现有 `typescript` AST 索引继续使用；Tree-sitter 只用于 Java（以及后续 Go/Python）。如果要用 Tree-sitter 替换 TS/JS，必须双跑对比并通过现有 17 条 `test:code-index` + 新增 golden 测试。
- **文件扫描完整性**：`complete` 标志、截断不删除、source root 优先、Java 构建目录忽略。
- **Worker 化**：索引不阻塞主进程；进度/取消；SQLite 写入边界。
- **Generation 原子提交**：按 D0.2 方案实现；失败/取消/崩溃后旧索引仍可读。
- **悬空边清理**：目标删除、文件移动、符号重命名、模块移动都要有测试。
- **Java 结构补齐**：package、static import、enum/annotation/record、构造器、字段、真实 endLine；节点类型增加 `Enum/Annotation/Record/Constructor/Field/Parameter`（或明确用现有 `Variable` 表示字段）。
- **准确率**：先以夹具 100% 为准；不要在没有标注集的情况下宣称 98%。

**Gate 1 验收**：5k/10k 文件不误删、不无限重建；TS/JS 现有测试全绿；Java 夹具通过；generation 失败回滚测试通过；无悬空边。

### Gate 2：Agentic Search 核心能力

在 V2 任务上补：

- **工具协议先定**：原生 tool calling 或 JSON 协议；每个 Provider 的解析和失败重试。
- **模型矩阵**：默认本地模型、云端 API、Web 通道；Web 只接收冻结证据。
- **预算**：最大轮数、单轮结果数、单文件行数、总 token/字符、墙钟时间、最大重复搜索；超预算要停止并给“当前证据不足”的答案。
- **去重与缓存**：按 path + line + content hash 去重；同一文件同一版本不重复读；文件变更后失效。
- **终止条件**：连续两轮无新增证据、达到预算、模型明确表示证据足够；不能无限循环。
- **取消**：复用现有 `sink.cancelled()`，用户停止后立即返回已收集证据和限制说明。
- **错误恢复**：工具失败把错误递回模型；模型不能把失败重试成编造结果。
- **安全**：路径范围、密钥拒绝、正则超时、输出截断、外发提示。
- **证据**：每次工具调用都产生 `evidenceRef`；最终答案的每个关键结论带 evidence ID；无证据结论显式标注。

**Gate 2 验收（建议先用 5 个问题，不追求 20 个）**：

- 至少 4/5 个问题能找到期望的跨文件组件；
- 关键结论的文件/行号准确率 ≥ 95%（人工核对）；
- 0 条“无证据却写成已确认”的调用关系；
- 每个问题 ≤ 8 轮、≤ 3 分钟（本地模型可放宽，但要有基线）；
- 与“一次性预检索 + 单次回答”基线相比，关键结论正确率有提升，且成本可接受；
- Web-only 配置能明确降级，不假装搜索。

### Gate 3：证据与渐进式图谱

在 V2 任务上补：

- Evidence ID、Pack 引用解析、GC/pin 策略；
- Claim↔Evidence 关联；
- `verified/source-confirmed/inferred/ambiguous/unknown/contradicted` 与现有 `Verdict` 的映射；
- 图查询默认只使用 `resolved` / `source-confirmed`；`inferred` / `ambiguous` 作为候选展示，不进入“确定影响”；
- 模型写入图谱必须经过 host 校验：源/目标存在、证据存在、关系类型合法、用户确认（至少对 `resolved`）；
- 代码变更后 stale 检测与重新验证；
- 任何“模型推断”不得覆盖已有确定边。

### Gate 4：多模型协作与辩论

在 V2 任务上补：

- **共享代码快照**：所有模型在同一 `gitCommit / workingTreeFingerprint / generation` 上探索；不允许 A 模型看旧代码、B 模型看新代码。
- **每模型独立预算**：否则 5 个模型 × 8 轮 = 40 次调用，成本和等待不可控。
- **共享证据缓存**：相同文件/行不重复读取；但每个模型可以提出新的搜索。
- **Web 模型**：只接收冻结证据包，不进入工具循环；辩论中被明确标注“未自主探索”。
- **角色映射**：V2 的 Lead/Explorer/Architect/Reviewer/Challenger/Judge 要映射到现有 `DebateRole`（proposer/critic/peer/domain_expert/evidence_reviewer）和现有 Lead/Judge 结构，不能另起一套。
- **Judge**：必须引用 evidence ID；区分事实、推断、未知；保留少数派。
- **记忆沉淀**：辩论结束不自动写长期记忆；仍走用户确认。

### Gate 5：外部增强与产品化

V2 的边界基本正确，但有一处事实需要修正：

- **Neo4j Managed 不是“未来再增强”**。当前 0.2.0 已经有 `managed.ts`、设置页启停/重启/版本检查、autoStart/autoStop；剩余的是 Python/CGC/Graphiti 生命周期、自动升级、真实本机安装目录验证、GPLv3 分发结论。Gate 5 不应重复实现已有 Neo4j 管理。
- Python 3.12 + CGC/Graphiti 打包、签名、公证、单/双实例资源测试仍是 Gate 5 的真实工作。
- 外部数据删除：Graphiti 没有 project group_id 映射，仍不能猜删；这与 V2 的“数据来源追踪”一致，但要在 Gate 5 明确。

---

## 7. 数据模型补充

### 7.1 节点

V2 6.1 的图里有 `Field`，但现有 `CodeNodeType` 没有 `Field`、`Enum`、`Annotation`、`Record`、`Constructor`、`Parameter`（`types.ts:3-13`）。Gate 1 必须明确：

- 扩展节点类型，或明确 `Field` 用 `Variable`、`Constructor` 用 `Method` 表示；不能两者混着来。
- Java `package` 必须有独立 `Package` 节点或至少进入 `qualifiedName`；当前 `collectJava()` 没有 package。
- `Enum` 不能再映射成 `Class`。
- `Module` / `Project` 节点在多模块工程必须有稳定 `moduleId`。

### 7.2 Symbol ID

V2 6.2 的方向正确。补充规则：

- 方法身份：`language | moduleId | package | ownerChain | name | normalizedParameterTypes | kind`；返回类型不参与 Java 重载键（V2 已写）。
- 构造器：用 `<init>` 或 `Constructor` kind，避免和同名方法冲突。
- 泛型/数组/可变参数：参数类型归一化规则要写清楚（`List<String>`、`String[]`、`String...`）。
- 匿名类/局部类：`ownerChain + enclosingMethod + 源码区间`；区间变化时 link 进入 `needs_relink`，不能自动绑新匿名类。
- 枚举常量、record 组件、静态初始化块：明确节点类型和身份。
- 重命名：名称变化必然产生新 symbol ID；旧 ID 通过 redirect/history 或 `needs_relink` 处理，不能假装 ID 不变。
- 跨语言统一：Go/Python/TS 的签名规则不同；`symbolId` 生成器要按语言分派，不要硬套 Java 规则。

### 7.3 边

V2 6.3 的 `CodeEdge` 仍太宽松：

- `relationType: string` 建议改成联合类型，避免拼写漂移。
- 增加 `callSiteId` / `candidateGroup`：同一调用点的多个候选目标共享，`resolutionStatus = ambiguous`。
- 增加 `confidence` 或明确“resolutionStatus 足够，不再用 confidence”；不要让 UI 同时显示两套强弱。
- 增加 `evidenceRefs` 的实际 ID 类型（不是任意 string）。
- 唯一键要包含 `source + target? + relation + callSite + generation`，否则候选边会互相覆盖。
- 查询策略：默认 `resolved` / `source-confirmed`；`inferred` / `ambiguous` 单独展示，不能混入“确定调用方”。

### 7.4 Generation 与 evidence

- Generation 必须能回答：当前读的是哪一版；旧版是否还可读；Pack 引用是否仍可解析。
- `sourceVersion` 建议同时包含：git commit、branch、dirty 标志、working tree fingerprint（非 git 工程用目录指纹）。
- 旧 generation 清理前，检查是否有 Pack 引用；有引用则 pin 或保留摘要。
- 证据 stale 判断：`sha256` 优先，`mtime/size` 只作快速判断；文件移动不等于内容变化，但 locator 要更新。

---

## 8. 测试与指标

V2 14.2 的指标方向正确，但需要落成可执行的门槛：

| 指标 | 怎么算 | 建议门槛 |
| --- | --- | --- |
| 符号定位准确率 | 人工标注 symbol → file:line | ≥ 95%（Java 夹具） |
| 源码行号准确率 | 证据行号与真实文件对比 | ≥ 95% |
| 跨文件关系准确率 | 人工标注关系，按 precision/recall | precision ≥ 90%，候选关系单独统计 |
| 证据引用准确率 | 结论 claim 是否真的有 evidence ID | 100% 关键结论有引用 |
| 模型推断误标率 | inferred 被写成 verified/source-confirmed 的比例 | 0（硬性） |
| 无证据结论比例 | 没有 evidenceRef 的关键结论 | 越低越好，Gate 2 先要求 0 条“确定语气” |
| 重复搜索比例 | 相同 path+line+hash 的重复工具调用 | ≤ 20% |
| 分析成本 | 模型调用次数 / token / 墙钟 | 先测量，再定预算 |

测试分层：

- **语法夹具**：15 个 Java 文件，覆盖 package/import static/class/interface/enum/annotation/record/constructor/field/generic/annotation/extends/implements/nested/inner/anonymous/lambda/method reference/multi-line/switch expression/sealed。
- **工程夹具**：先 Java 21 单模块、Java 21 多模块（含同名类）、Maven、Gradle Kotlin DSL、最小 Spring Boot；Java 8/11/17 后补。
- **Agentic Search**：5 个问题，期望组件和文件/行号；记录轮数、工具调用、证据、错误。
- **回归**：现有 `npm test`、`test:code-index` 17 条、`test:code-index-external` 3 条；TS/JS 节点/边 golden 对比。
- **性能**：5k/10k 文件索引、增量、内存、主进程响应、取消延迟。

**基线对比**：D0.6 必须同时跑“现有一次性预检索 + 单次回答”和“Agentic Search”，否则无法证明新路线更好。比较维度：关键结论正确率、证据可追溯率、耗时、模型调用次数。

---

## 9. 依赖与许可证

V2 取消 JDT 前置后，Gate 0 的依赖只剩 Tree-sitter 及 grammar：

| 依赖 | 候选 | 许可证 | 备注 |
| --- | --- | --- | --- |
| `web-tree-sitter` | 0.27.2 | MIT | WASM 运行时；需与 grammar ABI 匹配 |
| `@vscode/tree-sitter-wasm` | 0.3.1 | MIT | 含预编译 Java grammar（基于 tree-sitter-java 0.23.5）；需验证 runtime 兼容 |
| `tree-sitter-java` | 0.23.5 | MIT | npm 包是 native N-API addon；Electron 45 需 rebuild/asarUnpack |
| `tree-sitter` | 0.25.1 | MIT | native 运行时备选 |
| `tree-sitter-wasms` | 0.1.13 | Unlicense | 预编译集合；许可证/grammar 版本需单独审 |

Gate 0 不新增 JDT 依赖。若 Gate 2/3 后决定引入 JDT，再单独评估：

- JDT LS `v1.63.0` 要求 Java 21（master 已要求 Java 25）；EPL-2.0；是否随包 JRE、公证、安装包体积。
- JDT LS 不等于全量调用图工具；如果要做批量精确图，需另做 JDT core helper 的性能验证。

---

## 10. 风险与回滚

| 风险 | 处理 |
| --- | --- |
| Agentic Search 在默认本地模型上不稳定 | D0.6 用实际模型测；失败则退回“预检索 + 单次回答”，并明确 UI 能力 |
| Web 通道无法工具调用 | Web 模型只接收冻结证据；不假装自主搜索 |
| 多轮搜索成本/延迟失控 | 轮数、结果数、token、墙钟四重预算；提前停止；显示进度和取消 |
| Tree-sitter 打包失败 | Gate 0 决策；失败则保留现有 Java 结构提取，不回归正则冒充 AST；明确 Java 能力降级 |
| 大工程误删/无限重建 | 完整扫描标志、分页/游标、统一上限、worker、进度 |
| Generation 半新半旧 | 影子表或全量 generation 过滤；失败/取消/崩溃测试 |
| 模型推断污染图谱 | `inferred` 独立状态/视图；默认查询过滤；用户确认才升 `resolved` |
| 证据引用失效 | 稳定 evidenceId；Pack pin/摘要；stale 检测 |
| TS/JS 回归 | 保留现有 TypeScript AST；新增 golden 对比；不静默切换 |
| 代码/密钥外发 | 路径范围、密钥拒绝、云端外发提示、本地优先 |
| 文档/Schema 迁移失败 | ADR 先定；迁移事务；v3 保留；回滚测试 |

---

## 11. 最终审核意见

- **路线：通过。** “本地事实 + 模型探索 + 可验证证据 + 渐进图谱”比“本地预建完整语义”更符合现有工程和产品边界。
- **Gate 0：有条件通过。** 先做 Gate 0A 决策，再做 Gate 0B 最小验证；Tree-sitter 只验证 Electron + Java，Agentic Search 只验证 3～5 个真实问题。
- **Gate 1 及以后：暂不批准。** 等 Gate 0B 的实测结果回答：
  1. Tree-sitter 能否稳定打包并解析 Java？
  2. 默认本地模型能否通过工具探索得到可追溯结果？
  3. 大工程索引能否不误删、不阻塞、可回滚？
- **不能接受的实现方式**：
  - 用正则继续冒充 Java AST；
  - 用文本搜索命中冒充“所有调用方”；
  - 让 Web 通道假装自主搜索；
  - 让模型推断直接写成 `verified` / `resolved`；
  - 在 Generation 半新半旧时继续读写；
  - 为了“图谱完整”牺牲证据可追溯性。

**一句话**：V2 把路线从“造编译器”拉回到“让模型带着证据探索工程”，这是对的；现在要做的不是继续扩写 Gate 1～5，而是用 Gate 0 的两个 spike 证明这条路在 Electron、默认本地模型和大型 Java 工程上真的走得通。
