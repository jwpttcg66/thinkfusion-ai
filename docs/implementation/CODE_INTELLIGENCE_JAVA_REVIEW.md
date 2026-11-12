# Java 优先实施计划审核

- 审核对象：`/Users/yalla/Downloads/制定辩论主题方案 (8)-20261112-2005-7.md`
- 审核基线：`4cfd972a81e7fba27848bf6010eeaa1f3d1aa01f`（0.2.0）
- 审核日期：2026-11-12
- 结论：**有条件通过。方向正确，但不能按当前 D0～D8 直接进入 D1。**

---

## 1. 结论摘要

计划对当前 Java 能力的判断基本成立：`collectJava()` 是行级正则，不生成 `CALLS`，不能称为 Java AST 或语义分析。把 Java 提升为重点语言、引入 Tree-sitter + JDT 的分层思路也成立。

但计划目前是**能力愿望清单**，还不是可执行实施计划。D1 之前必须先关闭 5 个 P0 阻断项，并完成 2 个最小 spike：

1. **Tree-sitter 在 Electron 主进程的运行时与打包方式未定**（native N-API 还是 WASM；asar 如何加载 grammar）。
2. **JDT 的运行时、版本、分发和许可证未定**（JDT LS 要求 Java 21；master 已要求 Java 25；是否随包带 JRE）。
3. **JDT LS 不能直接提供“整库调用图”**。LSP 的 references / call hierarchy 是按符号请求的，不能假设一次启动就得到全量 `EXACT` 边。
4. **Maven / Gradle 导入会执行工程代码**。计划要求“尽可能使用实际 classpath”，但没有信任边界、审批、离线模式和沙箱策略。
5. **现有符号 ID 与边模型不足以承载 Java 语义**：节点 ID 含文件路径、重载方法会合并、边没有 `resolutionStatus` 和多候选目标、跨文件悬空边不会清理。

另外两个必须调整的设计问题：

- `Engineering Evidence Pack` 与现有 `EngineeringEvidence` / `RetrievalResult` / `DebateEvidence` 有重叠，必须定义为**快照容器 + 引用**，不能另建第三套证据结构。
- `D6 Engineering Evidence Pack` 不应被 JDT 完全阻塞。它可以先对现有 Core（TS/JS + FTS + Vector + Memory）生效，D7 也不必等 D5 完成；但 Java 语义未就绪时必须在证据上标明 `syntax-only` / `semantic-unavailable`。

**建议批准范围**：D0 + Tree-sitter spike + JDT spike。spike 通过后再批准 D1～D2。D3 是否采用 JDT LS 还是 JDT core helper，由 D0 spike 决定。D6/D7 拆成 D6a/D6b/D7，不与 Java 语义强绑定。

---

## 2. 与 4cfd972 现状核对

### 2.1 计划判断正确的部分

| 计划判断 | 代码事实 | 结论 |
| --- | --- | --- |
| Java 文件发现已实现 | `GRAPH_EXT` 含 `.java`，`walk()` 会索引 | 成立 |
| class / interface / enum 按行匹配 | `collectJava()` 的 `typeMatch` | 成立 |
| 方法按行匹配 | `methodMatch` | 成立 |
| 方法调用关系缺失 | Java 分支固定 `calls: []`（`indexer.ts:335`） | 成立 |
| 泛型/复杂签名不可靠 | 正则只覆盖有限修饰符与返回类型 | 成立 |
| 注解、record、sealed、extends/implements 缺失 | 正则均未处理 | 成立 |
| 构造方法不完整 | 实际上**完全未识别**：方法正则要求返回类型 | 计划说轻了 |
| 增量索引有通用基础 | 按文件 hash 推进 generation（`indexer.ts:607`） | 成立，但只到文件级 |
| 不能把正则结果冒充语义 | 当前 Java 边只有 `CONTAINS`，没有伪造 `CALLS` | 成立 |

### 2.2 计划低估或说错的部分

| 计划表述 | 实际情况 | 影响 |
| --- | --- | --- |
| “package 提取：简单正则，初级” | `collectJava()` **没有 package 提取**，返回值只有 `declarations` 和 `imports`；类 `qualifiedName` 就是裸类名 | 现在无法表达 `com.foo.OrderService`，符号身份从 D1 就要重做 |
| “enum 已识别” | `enum` 被映射成 `Class` 节点，`types.ts` 没有 `Enum` 类型 | 节点类型从第一天就是错的，不能只补解析 |
| “内部类与嵌套类型不可靠” | 实际上没有父子关系：内层类会覆盖 `currentClass`，`qualifiedName` 也不含外层类 | 不能靠修一个正则解决，必须用 AST 的 owner 链 |
| “import 提取初级” | `import static ...` 不会匹配；通配符和普通 import 也只是字符串 | 静态导入和符号解析会缺 |
| “Java 模块系统必须” | D1～D8 没有对应交付项，`module-info.java` 也不在解析范围 | 计划内部不一致 |
| “框架语义重点增强” | 列了 Spring、MyBatis、Netty、gRPC、Dubbo、Redisson、Reactor | 这是无边界范围，D4 不可能一次完成；应缩到 Spring DI 注解的最小集合 |
| “方法 endLine 用 AST 范围” | 当前类 `endLine` 被设成文件末尾，方法 `endLine` 等于 `startLine`（`indexer.ts:267-271`） | 证据片段和影响分析会给出错误范围 |

### 2.3 计划没有提到、但会影响 Java 的现有约束

1. **Java 索引依赖 TypeScript 包**：`walk()` 一进来就 `loadTypeScript()`，找不到就抛 `AST_UNAVAILABLE`（`indexer.ts:280-281`）。Java-only 工程不应该因为 TS 加载失败而完全不能索引。
2. **节点 ID 含文件路径**：`codeNodeId(projectId, language, filePath, qualifiedName, kind)`（`store.ts:966`）。文件移动 = 节点 ID 变化；重载方法同文件同名同 kind = **同一个节点**。
3. **边只按源文件删除**：`replaceFileIndex()` / `deleteFile()` 只删 `file_path = 当前文件` 的边（`store.ts:374-455`）。目标文件被删或方法被删后，其他文件指向它的边会悬空。
4. **`CodeMemoryLink` 已有 `needs_relink` 状态，但从未使用**：`setLinkStatus()` 只有定义（`store.ts:931`），索引过程中没有校验或改状态。计划 5.2 要求的能力目前是 0。
5. **`symbolKey` 不含模块和签名**：`retrieval.ts:192` 只拼 `projectId|language|qualifiedName|kind`。同名类、重载方法都会撞 key。
6. **现有 Java 测试只验证“不伪造 CALLS”**：`check-code-index.mjs:332` 明确断言 Java 的 `CALLS` 为 0。D1 必须显式改这条测试，不能悄悄删掉。

---

## 3. P0 阻断项

### B1. Tree-sitter 运行时与打包方式未定

计划只写“引入 Tree-sitter Java”，没有回答：

- 用 native `tree-sitter` / `tree-sitter-java`，还是 `web-tree-sitter` + WASM grammar？
- Electron 45（Node 24）下 native addon 的 ABI、`@electron/rebuild`、`asarUnpack` 如何处理？
- WASM grammar 在 asar 里如何加载？`fetch()` 不能从 asar 路径直接取文件，必须 `fs.readFile` 后 `Language.load(Uint8Array)`，或把 `.wasm` 解包到 `app.asar.unpacked`。
- grammar 与 runtime 的 ABI 是否匹配？`web-tree-sitter@0.27.2` 和 `@vscode/tree-sitter-wasm@0.3.1` 里的 Java grammar 需要实测，不能按“都是 Tree-sitter”假设兼容。
- 解析失败、超时、超大文件、语法版本过新时，如何降级并报告错误位置？

**关闭标准**：在 Electron 主进程里，用最终选择的方案解析至少 20 个 Java 样本（含 record、sealed、switch expression、多行签名），拿到节点树；记录冷启动时间、内存、asar 打包后是否仍可加载；错误样本必须带 line/column 和 `parseStatus`。

### B2. JDT 的运行时、版本、分发和许可证未定

计划要求 JDT 语义分析，但没有回答：

- 用哪个 JDT LS 版本？JDT LS `v1.63.0` 的 README 要求 **Java 21 最低**；当前 master 已要求 **Java 25**。不能跟 master，必须 pin tag。
- 是否随应用分发 JRE？如果分发 Temurin 21，安装包体积、公证、GPLv2+CE  notices 都要处理；如果要求用户自备 JDK，必须检测 `JAVA_HOME` / `java -version` 并给出可操作提示。
- JDT LS 是 EPL-2.0。分发未修改的二进制通常需要保留 LICENSE/NOTICE；如果修改或裁剪，义务不同。这里只能列为待法务确认，不能在计划里写成“已解决”。
- JDT LS 的 workspace 数据目录、锁、崩溃恢复、升级清理放在哪里？不能写进用户工程目录。
- JDT LS 启动失败/超时/端口/stdio 断开时，UI 如何显示 `semantic-unavailable`，而不是静默退回语法级却仍标 `EXACT`？

**关闭标准**：写一个独立 spike：用 Java 21 启动 JDT LS，加载一个最小 Maven 工程，完成 `initialize`、打开文件、`definition`、`references`、`documentSymbol`、`shutdown/exit`；记录冷启动、RSS、失败日志；确认 Electron 主进程能管理子进程生命周期。**不修改索引主链路。**

### B3. JDT LS 不等于“整库调用图”

这是计划最大的架构风险。

计划假设 JDT 能提供 Definition / References / Call Hierarchy / Type Hierarchy 后，D4 就能写出完整的 `CALLS` 图。实际约束是：

- LSP 的 `textDocument/references` 和 call hierarchy 都是**按符号/按位置**请求，不是“给我整个 workspace 的所有调用”。
- 要生成全量 `EXACT` 调用图，需要枚举所有方法/构造器，再逐个发 `outgoingCalls` 或 `references`。1 万个方法就是 1 万次请求，冷启动和 JDT 内部索引成本都很高。
- 字段读写、注解、`INJECTS`、`OVERRIDES` 等关系，LSP 标准能力覆盖不完整；JDT LS 的扩展命令也未必稳定。
- 如果目标是“全量精确图”，更合适的是用 **Eclipse JDT core** 写一个 Java helper，在进程内遍历 AST 并拿 `ITypeBinding` / `IMethodBinding`，批量输出；JDT LS 更适合按需查询、诊断和编辑器式交互。

**关闭标准**：D0 必须做决策记录，二选一：

- **方案 A（推荐先做）**：Tree-sitter 负责全量语法图；JDT LS 只做按需语义增强（definition/references/diagnostics/少量 call hierarchy），边标 `EXACT` 的范围严格限制在 JDT 实际返回的符号上。
- **方案 B**：引入 JDT core helper，批量构建语义图；代价是 Java 进程、classpath、内存和打包复杂度更高。

不能在没做这个决策前写 D4 的“全量 CALLS/REFERENCES/OVERRIDES”。

### B4. Maven / Gradle 导入会执行工程代码

计划要求“必须尽可能使用实际工程 classpath、modulepath 和依赖信息”，但没有安全模型。

事实：

- Maven 依赖解析会下载依赖，构建生命周期可能触发插件、注解处理器。
- Gradle Tooling API 会执行 `build.gradle` / `build.gradle.kts`，这是**任意代码执行**；Kotlin DSL 更是编译并运行构建脚本。
- JDT LS 的 Maven/Gradle 导入本身就可能触发上述行为。

必须在 D2 之前明确：

- 默认**不自动导入**不可信工程；首次导入需要用户确认“将运行构建工具并可能下载依赖/执行构建脚本”。
- 提供 offline / 只读 classpath 模式；至少允许用户拒绝执行构建脚本。
- 导入过程可取消、有超时、有日志；失败时退回 Tree-sitter 语法索引，并明确显示 `classpath: unresolved`。
- 不把构建工具输出直接当事实；classpath 解析结果要记录来源和 fingerprint。

**关闭标准**：一个威胁模型 + 一个最小 spike：对含自定义 Gradle task 的样本工程，确认默认不会执行；用户确认后才执行；拒绝后仍能语法索引。

### B5. 符号身份与边模型不足以承载 Java 语义

当前模型的具体问题：

| 问题 | 代码位置 | 后果 |
| --- | --- | --- |
| 节点 ID 含 `filePath` | `store.ts:966` | 文件移动导致 ID 变化，链接和边全部失效 |
| 节点 ID 不含签名/模块 | 同上 | 重载方法、多模块同名类合并 |
| `CodeNodeType` 缺 `Enum` / `Annotation` / `Record` / `Constructor` / `Field` / `Parameter` | `types.ts:3-13` | 只能把这些塞进 `Class` / `Method`，后续无法区分 |
| `CodeEdge` 没有 `resolutionStatus` | `types.ts:41-52` | 无法表达 `resolved / ambiguous / unresolved / dynamic` |
| 边没有候选目标组 | `store.ts:970` | 接口多实现只能随便选一个，或者丢关系 |
| `EdgeSource` 没有 `JDT` / `TREE_SITTER` | `types.ts:26` | 无法区分语法边和语义边 |
| `code_memory_link.symbol_key` 不含模块/签名 | `retrieval.ts:192` | 重载/同名类链接错位 |

**关闭标准**：先写 schema v4 设计，不写 Java 解析器：

- `symbol_id` 稳定身份：`language + moduleId + package + ownerChain + name + signature + kind`，不含文件路径。
- `locator` 单独存：`filePath + startLine/endLine + generation`。
- 边增加 `resolutionStatus`、`callSiteId`（或 `candidateGroup`）、`targetSignature`、`language`、`moduleId`。
- 多候选调用：同一调用点写多条候选边，共享 `callSiteId`，状态 `ambiguous`；不得只留一条并标 `EXACT`。
- 悬空边清理：目标节点不存在时，要么删除，要么标 `unresolved`；`impact()` 不能返回指向不存在节点的边。
- 迁移策略：v3 → v4 的 `ALTER TABLE` / 回填 / 旧链接 `needs_relink`；TS/JS 现有节点 ID 是否保留要明确。

### B6. Engineering Evidence Pack 与现有证据类型重叠

现有三套相关结构：

1. `EngineeringEvidence`（`shared/conversation.ts:15`）：路径、行号、片段、整文件 sha256、mtime、readAt、why、totalLines、partial、structure。它回答“这一轮到底看了哪几行代码”。
2. `RetrievalItem` / `RetrievalResult`（`code-index/types.ts`）：代码/记忆、来源、置信度、文件、行号、状态、stale、warnings。
3. `DebateEvidence`（`debate/types.ts:264`）：主张关联、原文 span、来源、URL、指纹、同源、验证状态。它回答“这条辩论主张凭什么”。

计划的 `EngineeringEvidencePack` 如果直接定义 `EngineeringCodeFact.content`、`EngineeringMemoryFact`、`EngineeringExternalEvidence`，会变成第四套证据结构，后续无法保证同一段代码在 UI、辩论、记忆中 sha/行号一致。

**关闭标准**：Pack 定义为**冻结快照容器**，内部引用现有结构：

- `packId / projectId / question / generation / createdAt / warnings / unresolvedItems` 是新的容器字段。
- `codeFacts` 引用 `EngineeringEvidence` 或 `RetrievalItem`，补充 `evidenceId / symbolId? / relation? / source / resolution / generation`；不要重复存 `excerpt` 和 `sha256`。
- `memoryFacts` 引用 `MemoryFact`，保留 `status`（confirmed/approved/candidate/deprecated）。
- `externalSources` 引用外部 Adapter 的 `ExternalHit`，保留 `source`（CGC/Graphiti）和 `confidence`。
- Pack 创建时冻结 generation；所有参辩模型拿到同一个 packId，不允许中途重新检索。

### B7. 验收指标不可执行

计划写了语法召回率 98%、语义准确率 98%/95%、20 个辩论案例，但没有给出：

- 基准集在哪里、多少个样本、谁标注、如何计数。
- “召回率”的分母是节点、边、还是构造？重载和匿名类怎么算？
- 语法解析成功但字段/调用抽取失败，算语法通过还是语义失败？
- 动态调用、反射、外部依赖如何单独统计。
- 性能预算没有数字：冷启动、10k 文件索引、JDT RSS、空闲退出时间、取消延迟。

**关闭标准**：D0 先建立可执行基准集：

- 语法：至少 15 个 Java 文件 / 每个构造有期望节点和边；先要求样本 100% 通过，再谈统计指标。
- 语义：至少 30～50 个符号用例，人工标注 definition/reference/call target/override；precision 优先于 recall，`EXACT` 只算 JDT 绑定。
- 工程：Maven 单模块、Maven 多模块（含同名类）、Gradle Kotlin DSL、最小 Spring Boot、接口多实现、反射/动态代理、Java 8/17/21 各一个。
- 辩论：先 10 个案例，不追 20 个；每个案例记录期望证据路径/行号、允许的未知项、必须保留的反方意见。

---

## 4. 依赖与许可证（D0 必须落表）

| 依赖 | 候选版本 | 许可证 | 用途 | 风险 / 结论 |
| --- | --- | --- | --- | --- |
| `web-tree-sitter` | 0.27.2 | MIT | WASM 运行时 | 需与 grammar ABI 匹配；asar 内加载方式要 spike |
| `@vscode/tree-sitter-wasm` | 0.3.1 | MIT | 预编译 grammar（含 Java） | 其 runtime 可能是 VS Code 分支；需验证能否与选定运行时共用 |
| `tree-sitter-java` | 0.23.5 | MIT | Java grammar | npm 包是 native N-API addon（`bindings/node`），不是 WASM；Electron 需 rebuild/asarUnpack |
| `tree-sitter` | 0.25.1 | MIT | native 运行时备选 | 与 `tree-sitter-java` 的 ABI、Node 24、Electron 45 需实测 |
| `tree-sitter-wasms` | 0.1.13 | Unlicense | 预编译 grammar 集合 | 许可证和 grammar 版本都要单独审，不能默认采用 |
| Eclipse JDT LS | pin `v1.63.0` | EPL-2.0 | Java 语义服务 | README 要求 Java 21 最低；master 已要求 Java 25；不要跟 master |
| Temurin JDK | 21 LTS | GPLv2+CE | 可选随包 JRE | 安装包体积、公证、NOTICE；也可要求用户自备 |
| Maven | 3.9.x | Apache-2.0 | classpath / 工程模型 | 会下载依赖、可能执行插件；需要信任边界 |
| Gradle | 8.x | Apache-2.0 | classpath / 工程模型 | Tooling API 会执行构建脚本，属于任意代码执行 |
| Neo4j | 5.26 | GPLv3 | 可选外部图 | 本阶段不新增；正式分发仍需单独法律结论 |

**结论**：D0 之前不新增任何运行时依赖。先做 spike，再决定 native 还是 WASM、是否带 JRE。许可证只做工程记录，不代替法务结论。

---

## 5. 数据模型修订建议

### 5.1 节点

现有 `CodeNode` 只有：`projectId / nodeId / nodeType / name / qualifiedName / filePath / startLine / endLine / language / generation`。

建议 v4：

```
CodeNode
  projectId
  nodeId            // 稳定 symbol id，不含 filePath
  nodeType          // 扩展 Enum/Annotation/Record/Constructor/Field/Parameter
  name
  qualifiedName     // 含 package + owner chain
  signature?        // 方法/构造器：参数类型 + 返回类型（可选）
  moduleId?
  filePath          // locator，不是身份
  startLine/endLine
  language
  metadataJson?     // annotations/visibility/isStatic/isAbstract/isFinal/genericParameters
  generation
```

身份规则：

```
symbolId = hash(
  language | moduleId | packageName | ownerChain |
  name | normalizedSignature | nodeType
)
```

- 重载：`normalizedSignature` 区分。
- 内部类：`ownerChain` 是 `Outer.Inner`。
- 匿名类：`ownerChain + enclosingMethod + 源码区间`；区间变化时 link 进入 `needs_relink`，不能自动绑到新匿名类。
- 多模块同名类：`moduleId` 区分。
- 文件移动：`symbolId` 不变，只更新 locator。

### 5.2 边

建议 v4：

```
CodeEdge
  projectId
  edgeId
  sourceNodeId
  targetNodeId?
  relationType
  resolutionStatus   // resolved | ambiguous | unresolved | dynamic
  confidence         // EXACT | HIGH | POSSIBLE | UNKNOWN
  source             // JDT | TREE_SITTER | LSP | AST | STATIC_ANALYSIS | CGC | MANUAL
  callSiteId?        // 同一调用点的候选边共享
  targetSignature?
  moduleId?
  filePath/line      // 调用点位置
  generation
```

关键约束：

- `confidence = EXACT` 只能由 JDT 绑定产生；Tree-sitter 最多 `HIGH` 或 `POSSIBLE`。
- 接口调用无法确定实现时：写多条候选边，`resolutionStatus = ambiguous`；不能选一个实现标 `EXACT`。
- 反射/动态代理：`resolutionStatus = dynamic`，并写入 `unresolvedItems`，不要伪造目标。
- 目标节点不存在：清理或标 `unresolved`；D5 必须验证“悬空边 = 0”。

### 5.3 schema 迁移

当前 `SCHEMA_VERSION = 3`（`store.ts:30`）。v4 迁移需要：

1. `ALTER TABLE code_nodes ADD COLUMN symbol_id / module_id / signature / metadata_json`。
2. `ALTER TABLE code_edges ADD COLUMN resolution_status / call_site_id / target_signature / module_id`。
3. 新索引：`(project_id, symbol_id)`、`(project_id, call_site_id)`、`(project_id, resolution_status)`。
4. 回填：旧节点用现有 `node_id` 作为 `symbol_id` 的临时值；旧边 `resolution_status = 'resolved'`（仅当目标存在），否则 `unresolved`。
5. 旧 TS/JS 链接：`symbol_key` 迁移到新规则时，不能静默重绑；无法确认的置 `needs_relink`。
6. 迁移必须在事务中完成；失败回滚并保留 v3 可读。

**不要**在 D1 直接改 `SCHEMA_VERSION` 并重写所有节点；先把迁移和兼容读写好。

### 5.4 Code-Memory Link

现有字段已经接近计划要求：`symbolKey / symbolLocator / symbolFingerprint / linkType / confidence / status`。缺的是：

- `symbolKey` 改为稳定 `symbolId`（含模块/签名）。
- 索引完成后做一次 link 校验：符号存在且 fingerprint 匹配 → `active`；不存在 → `needs_relink`；签名变化 → `needs_relink`，不自动绑同名。
- UI 要能显示 `needs_relink` 并让用户确认，不能只在数据库里标记。

---

## 6. D0～D8 修订

### D0：源码复核 + 架构冻结 + 两个 spike

原 D0 只做“复核”，不够。建议增加：

- **S1 Tree-sitter spike**：Electron 主进程加载 Java grammar，解析 20 个样本，验证 asar 打包、ABI、错误位置、冷启动/内存。
- **S2 JDT LS spike**：Java 21 启动、初始化、打开文件、definition/references、shutdown，验证子进程管理、超时、崩溃恢复。
- **S3 构建信任 spike**：Gradle 自定义 task 默认不执行；用户确认后才执行；拒绝后仍可语法索引。
- **S4 schema v4 ADR**：符号 ID、边状态、多候选、悬空边、迁移。
- **S5 证据模型 ADR**：Pack 与 `EngineeringEvidence` / `RetrievalResult` / `DebateEvidence` 的映射。
- **S6 基准集**：15 个语法夹具 + 30～50 个语义用例 + 7 个工程夹具。

**D0 出口条件**：S1/S2 有可复现命令和实测结果；S4/S5 有决策记录；S6 能跑出基线。没有这些，不进入 D1。

### D1：Java AST 解析

修订：

- 保留 `collectJava()` 作为 fallback，不直接“替换”；用 feature flag 双跑，比较节点/边差异。
- 先做 Tree-sitter → Unified IR → 现有节点/边，不接 JDT。
- 解析范围按 D0 夹具逐项交付：package、import（含 static）、class/interface/enum/annotation/record、constructor、method、field、generic、annotations、extends、implements、nested/inner/anonymous、calls、object creation、lambda、method reference、switch expression、sealed。
- 每个节点必须有真实 `endLine`，不再用文件末尾兜底。
- 解析失败：返回 `parseStatus`、line/column、失败节点；不得静默跳过。
- Java-only 工程不依赖 `loadTypeScript()`；按语言路由 Provider。

**不交付**：`EXACT` 边、跨文件类型绑定、Maven/Gradle classpath。

### D2：Java 工程模型

修订：

- 先做**只读识别**：`pom.xml` / `settings.gradle(.kts)` / `build.gradle(.kts)` / `module-info.java` / source roots。
- 多模块必须有稳定 `moduleId`；同名类不能合并。
- classpath 解析放到“用户确认后”的独立步骤；默认 `dependencyStatus = unresolved`。
- Gradle Kotlin DSL 如果必须执行 Tooling API，明确标注为“执行构建脚本”，并受 B4 约束。
- Java 版本：识别 `maven.compiler.release` / `sourceCompatibility` / `toolchain`；无法识别时用 JDT 默认并报告。
- 生成源目录（`target/generated-sources`、`build/generated`）默认索引但标 `generated`，避免与手写代码混淆。

### D3：JDT 语义分析

修订：

- 先按 D0 决策选 A 或 B；不要同时写两套。
- 方案 A（JDT LS）：只承诺按需查询和有限批处理；定义每次请求的超时、取消、并发上限。
- 方案 B（JDT core helper）：定义批量遍历的边界、内存上限、classpath 输入、输出格式；不把 helper 做成第二个 LSP。
- 语义状态必须可观测：`semantic: ready / indexing / unavailable / error`，并在 UI 和证据里显示。
- 诊断（diagnostics）可以独立交付，不要和调用图绑定。
- 语义不可用时，Tree-sitter 结果继续可用，但所有边只能是 `HIGH/POSSIBLE`。

### D4：Java 代码图谱

修订：

- 依赖 S4 schema v4；先写迁移，再写图。
- 先交付：Class/Method/Constructor/Field 节点，`CONTAINS`、`IMPORTS`、`EXTENDS`、`IMPLEMENTS`、`CALLS`（语法级 + 可选 JDT 增强）、`CREATES`、`ANNOTATED_BY`。
- `REFERENCES`、`READS`、`WRITES`、`OVERRIDES`、`INJECTS` 作为第二批；每个都要有 resolution 状态。
- Spring DI 只做最小集合：`@Autowired` / `@Inject` / `@Resource` 字段/构造器注入 → `INJECTS`，标 `POSSIBLE` 或 `EXACT`（只有 JDT 能确认类型时）。不做 Spring Cloud / MyBatis / Netty / Dubbo / Reactor 的框架语义。
- 多候选调用必须保留候选集；不得为了图好看只留一条。
- 增加图完整性检查：目标存在、generation 一致、无悬空边。

### D5：增量索引与关联维护

修订：

- AST 增量继续用文件 hash；语义增量不要自己重写一套，**JDT 自己维护 workspace 状态**，我们只在文件变更后触发 JDT 的 didChange/didSave，并按需快照。
- classpath / build 文件变化 → 使语义索引失效，重新导入；AST 索引不必全量重跑。
- 文件移动/类重命名/方法重命名：先更新 locator，再校验 link；不能仅凭同名自动重绑。
- 删除符号：清理其出边、入边、link；入边无法确认时标 `unresolved` 并报告。
- 每次 generation 结束做一致性检查：`edges.target_node_id` 必须存在，`code_memory_link` 不得指向不存在符号。

### D6：Engineering Evidence Pack（拆分）

- **D6a（可立即做，语言无关）**：在现有 `RetrievalResult` + `EngineeringEvidence` 上做冻结快照容器；支持 TS/JS、FTS、Vector、Memory、外部 Adapter；先接现有综合链路。
- **D6b（Java 增强）**：把 D4 的 symbol/relation/resolution 写进 codeFacts；JDT 不可用时标 `syntax-only`；不要把 `EngineeringEvidence` 替换掉。

### D7：Engineering Debate

修订：

- 不新建 Orchestrator / Store；在 `DebateOrchestrator` 前加 `EngineeringContextProvider`，输出 `DebateSeedEntry` 或等价的上下文包。
- 需要明确 `DebateEvidence` 与工程证据的映射：工程证据不是网页链接，不应塞进 `url/span` 字段；建议新增 `sourceKind: 'engineering'` + `engineeringEvidenceId`，或单独的引用表。
- 参辩模型共享同一个 `packId` / `generation`；中途不允许重新检索。
- Judge 必须引用证据 ID；少数派意见保留；辩论结束不自动写长期记忆，仍走用户确认。
- 普通问答的 `question` 必须保持用户原话，不因工程上下文拼接固定提示词；上下文作为独立材料展示，并让用户知道发送了什么。
- D7 可以在 D6a 之后启动，不必等 D5；Java 语义未完成时，用 `semantic-unavailable` 明确限制结论强度。

### D8：回归与性能

修订：

- 原有 TS/JS 索引、审批、权限、Journal 回归必须单独跑。
- Java 夹具分三层：语法、语义、工程。
- 增量测试必须包含：改方法体、加/删/重命名方法、类重命名、文件移动、模块移动、改 Maven/Gradle 依赖、改 Java 版本。
- 性能先测量再定预算：冷启动、10k 文件索引、JDT RSS、空闲退出、取消延迟、崩溃恢复。
- 输出 `SPECIFIED / IMPLEMENTED / INTEGRATED / VERIFIED / TESTED / PRODUCTION_READY` 状态表；不能用“代码写完”代替“功能完成”。

---

## 7. 验收标准改写建议

### 7.1 语法

- 15 个夹具，逐构造断言节点类型、名称、qualifiedName、startLine/endLine、父子关系。
- 解析错误必须带 line/column 和错误类型；不允许“跳过但返回成功”。
- record/sealed/switch expression 按 grammar 实际支持情况标注；不支持就明确报 `unsupported-syntax`，不要静默。

### 7.2 语义

- 30～50 个符号用例，人工标注。
- `definition` / `references` / `call target` / `override` 分别统计。
- `EXACT` 只算 JDT 绑定；Tree-sitter 结果单独统计。
- 接口多实现、重载、泛型、内部类、匿名类、反射/动态代理分别统计。
- 目标：precision ≥ 0.98（宁缺毋滥），recall 先 ≥ 0.90，稳定后再谈 0.95；不要用未标注的“召回率 98%”。

### 7.3 图与增量

- 每次索引后：悬空边 = 0；目标节点存在；generation 一致。
- 文件移动后：`symbolId` 不变，locator 更新，link 状态正确。
- 方法重命名后：旧 link `needs_relink`，不自动绑同名。
- 删除方法后：入边清理或 `unresolved`，不能留下“幽灵调用”。

### 7.4 辩论

- 10 个案例起步；每个案例有期望证据路径/行号、允许未知项、必须保留的反方意见。
- 检查：是否读到正确代码、是否引用证据 ID、是否把推断写成事实、Judge 是否区分事实/推断、是否产生可执行建议。
- 不允许“模型共识 = 用户批准”。

---

## 8. 风险与回滚

| 风险 | 触发 | 处理 |
| --- | --- | --- |
| Tree-sitter ABI/打包失败 | Electron 升级、asar、native rebuild | 先 WASM；保留 native 备选；失败回退 `collectJava()` |
| JDT LS 启动慢/吃内存 | 大工程、Maven 导入 | 延迟启动、单实例、LRU workspace、空闲退出、硬超时 |
| JDT 崩溃/挂起 | 工程损坏、OOM | supervisor + kill tree + 重试一次 + `semantic-unavailable` |
| 构建脚本执行 | Gradle/Maven 导入 | 首次确认、offline 模式、超时、日志、拒绝后语法索引 |
| 符号 ID 迁移破坏 TS/JS | v3→v4 | 保留旧 ID 映射；迁移测试；回滚保留 v3 备份 |
| 悬空边/幽灵调用 | 跨文件删除 | generation 结束一致性检查；D5 强制测试 |
| 证据不一致 | Pack 与 UI/辩论各存一份 | Pack 只引用现有证据；统一 sha/行号 |
| 计划范围膨胀 | Spring Cloud/MyBatis/Netty 等 | 本阶段只做最小 Spring DI；其余后置 |
| 许可证/分发 | JRE、JDT LS、Neo4j | D0 落表；不把工程记录当法务结论；未确认前不打正式包 |

---

## 9. 建议执行顺序（Gate）

```
Gate 0（现在）
  D0 文档 + S4 schema ADR + S5 证据 ADR + S6 基准集骨架
  S1 Tree-sitter spike（不改索引主链路）
  S2 JDT LS spike（不改索引主链路）
  S3 构建信任 spike
       |
       v
Gate 1（决策）
  native vs WASM
  JDT LS vs JDT core helper
  是否随包 JRE
  schema v4 是否保留旧 ID
       |
       v
D1 Java AST（feature flag + 双跑）
       |
       v
D2 工程模型（只读识别优先）
       |
       v
D3 语义（按 Gate 1 方案）
       |
       v
D4 图谱（schema v4）
       |
       v
D5 增量 + link 校验
       |
       +----> D6a Evidence Pack（可提前并行，语言无关）
       |
       v
D6b Java 证据增强
       |
       v
D7 Engineering Debate（D6a 后即可启动，不等 D5）
       |
       v
D8 回归 + 性能 + 状态表
```

**建议先批准 Gate 0，不批准 D1 之后的代码修改。** Gate 0 的产出应该是一份带实测数据的决策记录，而不是又一份设计文档。

---

## 10. 审核结论

- 计划的方向、原则和“Java 优先”判断：**通过**。
- 计划对当前 Java 缺口的判断：**基本准确**，但 package/enum/constructor/endLine 等细节需要修正。
- 计划的 D0～D8：**暂不通过**，需要按本文修订后再作为实施任务书。
- 允许立即开始：D0、S1/S2/S3 spike、S4/S5 ADR、S6 基准集。**不允许**在 spike 前改 `indexer.ts` 主链路、改 `SCHEMA_VERSION`、引入 JDT 依赖或写 D4 的全量调用图。
- D6a/D7 不应被 JDT 完全阻塞；可以先在现有 Core 上交付语言无关的证据快照和辩论接入，但对 Java 结论必须标明 `syntax-only` / `semantic-unavailable`。

**一句话**：这份计划选对了技术方向，但把“JDT 可用”当成了“全量精确图可用”，也低估了 Electron 打包、构建脚本执行和符号身份迁移的成本。先把这三个问题用 spike 和 ADR 钉死，再写 D1。
