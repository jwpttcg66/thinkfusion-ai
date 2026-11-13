# V3.1 方案与当前实现复核

- 方案：`/Users/yalla/Downloads/制定辩论主题方案 (9)-20261113-1131-2.md`
- 方案版本：V3.1
- 代码基线：`2dbbad4`（V3.1 方案审核之后又落地了 Gate 1A/1B 起步）
- 审核日期：2026-11-13
- 上一轮：`CODE_INTELLIGENCE_V3_1_PLAN_REVIEW.md`

---

## 1. 结论

**方案方向仍然成立；但“APPROVED”不能继续表示 Gate 已通过。**

V3.1 的五项 P0 修正仍然正确。代码也已经往前走了一步：

- 扫描截断不再误删旧索引；
- Schema v4 加法迁移落地；
- Java Symbol ID 标 `provisional`；
- 只读 Integrity Checker 落地；
- 5 问题基准文档已建立；
- 产品模式文档已同步 Managed 状态。

但 **Gate 1B 的核心没有完成**：Generation 仍不是原子快照，TS/JS Symbol ID 仍没有真正稳定，超过 500 个文件仍然只索引前 500 个。Gate 2～5 也没有进入实现。

**当前准确状态**：Gate 1A/1B 是 `IN_PROGRESS`，不是 `PASSED`。Gate 2 继续 `PENDING`。

---

## 2. 方案要求 vs 当前实现

| V3.1 要求 | 当前实现 | 状态 |
| --- | --- | --- |
| 扫描截断不删除旧文件 | `walk()` 返回 `complete/truncated`；只有 complete 才删除 | **已实现** |
| `ensureFresh` 与 `indexProject` 统一上限 | 共用 `DEFAULT_MAX_FILES=500` | **已实现** |
| `target/.gradle/.mvn` 忽略 | `IGNORED_DIRS` 已补 | **已实现** |
| Java `provisional` | 节点写 `symbolStatus='provisional'` | **已实现（部分）** |
| Schema v4 | `symbol_id/symbol_status/module_id/signature`、`resolution_status/call_site_id`、vectors generation | **加法迁移已实现** |
| 稳定 TS/JS Symbol ID | `symbolId` 仍回填 `nodeId`，`nodeId` 仍含文件路径 | **未实现** |
| Generation 全表原子化 | `replaceFileIndex()` 仍就地删写；读查询不过滤 generation | **未实现** |
| FTS/vector/link 同代一致 | FTS 无 generation；vectors generation 为 NULL；link 不参与校验 | **未实现** |
| Integrity Checker | `CodeIndexStore.integrity()` 只读检查悬空边/孤儿文档/孤儿向量/未完成 generation | **已实现（基础版）** |
| 5 问题基准 | `GATE0_BENCHMARK.md` 有 5 个问题；`agentic-search-real.cjs` 仍只跑 3 个 | **文档完成，执行未完成** |
| 模型工具能力真实探测 | 只有 spike 里的一次 probe，没有产品化能力缓存/UI | **未实现** |
| Maven 信任 Spike | 仅有 Gradle 最小验证 | **未实现** |
| Web 通道降级 | 方案有设计，没有 UI/产品路径 | **未实现** |
| Evidence Pack / Gate 4 | 未实现 | **未实现** |
| 辩论融合 / Gate 5 | 未实现 | **未实现** |

---

## 3. 仍然阻断 Gate 1B 的问题

### P0-1：Generation 仍不是快照

当前代码：

- `SCHEMA_VERSION=4`；
- `code_nodes/code_edges` 有 generation 字段，但主键仍是 `(project_id,node_id)`、`(project_id,edge_id)`；
- `replaceFileIndex()` 仍先 `DELETE` 当前文件旧行，再写新行；
- 读查询 `getNode / findSymbols / listNodes / search / getIncoming` 仍只按 `project_id`，不过滤 generation；
- `code_fts` 没有 generation；
- `code_vectors.generation` 允许 NULL，检索不筛；
- `code_memory_link` 不参与 generation 校验。

所以：

- 构建失败/取消后，旧索引可能已经被改；
- 新旧 generation 可能混读；
- FTS、vector、link 都可能混代。

这与 V3.1 的 Gate 1B 验收“失败不破坏旧索引、并发读取一致”不符。

**必须做**：

- 决定 Schema v5 的表主键方案（generation-scoped PK 或 shadow tables）；
- 所有读入口固定 current generation；
- FTS/vector/link 明确 generation 规则；
- 崩溃/取消/并发测试。

### P0-2：扫描完整性只解决了“不误删”，没有解决“能索引完”

当前 500 文件上限仍在：

- `walk()` 达到 500 就 `complete=false`；
- 只索引前 500；
- 没有分页、游标、source root 继续扫描；
- UI 显示“扫描不完整”，但不会继续索引剩余文件。

所以大工程不会误删，但仍只能检索前 500 个文件。

**必须做**：

- 分页/游标/后台继续；
- source root 优先；
- 显示“已索引 / 总数”；
- 明确 `maxFiles` 是单批上限，不是工程上限。

### P0-3：TS/JS Symbol ID 还没有稳定

当前：

- `codeNodeId()` 仍含 `filePath`；
- `symbolId` 在插入时默认 `nodeId`；
- 没有“文件移动后 symbolId 不变”的实现或测试。

所以 V3.1 Gate 1A 的“TS/JS Symbol ID 稳定”没有完成。

**必须做**：

- 决定路径是 locator 还是 identity；
- 如果路径必须参与，明确“文件移动会产生新 ID”，不能再声称稳定；
- 或者实现模块/scope/signature 身份，并补文件移动测试。

### P0-4：Gate 2 仍没有可实现的工具契约

当前：

- `ModelRequest` 没有 `tools`；
- `askWithReadTool()` 仍是 1 轮；
- `project-tools.ts` 只有 4 个 fs 工具；
- `code.references` 等工具不存在；
- Web 通道 `toolCalling:false`；
- 方案 D0.4 有设计，但代码没有 `EngineeringToolResult` 的完整字段。

V3.1 要求 Gate 2 先完成 D0.4 ADR 和 5 问题基准，目前：

- `GATE0_BENCHMARK.md` 有 5 个问题；
- 真实 harness 只跑 3 个；
- 没有产品化的模型能力探测；
- 没有工具契约 TypeScript 接口。

### P0-5：Gate 0 的“APPROVED”语义必须改

方案把 Gate 0/1A/1B 标为 `APPROVED`，但：

- Gate 0 的 ADR 状态、Maven、模型探测、成本复核还没完成；
- Gate 1A/1B 只是部分实现；
- Gate 0 的 5 问题基准还没全部执行。

`APPROVED` 现在同时表示“批准做”和“已经过”，会导致验收误判。

建议继续使用：

```text
AUTHORIZED / IN_PROGRESS / PASSED
```

---

## 4. 需要方案修订的地方

### 4.1 把 Gate 1B 的范围再拆清

建议拆成：

- **1B-1 扫描覆盖**：分页/游标、source root、文件总数、UI 覆盖率；
- **1B-2 Generation 原子化**：v5 schema、读写分离、失败/取消/崩溃；
- **1B-3 一致性**：FTS/vector/link、Integrity Checker、并发读取。

当前代码只完成了 1B-1 的一半（不误删）和 1B-3 的只读检查。

### 4.2 明确 Benchmark 的运行载体

V3.1 要求 Gate 0 完成 5 个问题，但产品还没有 Agentic Search 循环。必须写：

- 用哪个 harness；
- 哪个模型；
- 代码版本；
- 结果是 `harness` 还是 `product`；
- 是否允许用 3 个问题 + 2 个补充问题分两次跑。

否则会出现“基准完成，但产品没实现”或“产品没实现，所以基准无法完成”的循环。

### 4.3 明确 Evidence 的 v5 生命周期

当前 Schema v4 只加了字段，没有决定：

- Evidence ID 生成公式；
- Pack 引用旧 generation 的 pin/摘要；
- Claim↔Evidence 关联表；
- `ConclusionStatus` 与 `Verdict` 映射；
- 旧 generation 清理时的引用保护。

这些应在 Gate 4 前写成 ADR，不要等到实现时临时补。

### 4.4 明确 Gate 2 的工具契约

至少：

```ts
interface EngineeringToolResult {
  toolCallId: string;
  toolName: string;
  projectId: string;
  generation: number;
  argsSummary: string;
  status: 'ok' | 'failed' | 'cancelled';
  content: string;
  evidenceRefs: string[];
  total?: number;
  truncated?: boolean;
  warnings?: string[];
  error?: string;
  durationMs: number;
}
```

没有这个，Provider、Trace、Evidence、UI 会各写一套。

---

## 5. 当前可验收的部分

已完成并有测试：

- 扫描截断不删除旧索引；
- `target/.gradle/.mvn` 忽略；
- `scanSourceFilesDetailed` 的 `complete/truncated`；
- Schema v4 加法迁移；
- `symbolId` 回填、Java `provisional`；
- `resolutionStatus/callSiteId`；
- Integrity Checker 发现悬空边；
- 产品模式文档同步 Managed；
- 5 问题基准文档。

验证记录：

```text
npm run typecheck        通过
npm run test:code-index  21 条通过
npm test                 全绿
npm run build            通过
真机 Electron            启动、建索引、检索正常
```

提交：

```text
2dbbad4 Gate 1A 起步：Schema v4 加法迁移与只读 Integrity Checker
1f430b0 Gate 1B 起步：扫描截断不再误删旧索引
```

---

## 6. 评审结论

- 方案方向：**通过**。
- Gate 0/1A/1B：**继续实施**，状态应为 `IN_PROGRESS`，不是 `PASSED`。
- Gate 2：**继续 PENDING**，必须先完成 D0.4 和 5 问题基准。
- Gate 3～5：**DEFERRED**，不提前实现。

下一步最合理的顺序：

1. 把 5 问题基准真正跑完（harness，3+2）；
2. 做 Schema v5 / Generation 原子化；
3. 做扫描分页/覆盖率；
4. 再做 D0.4 与 Gate 2。

**一句话**：当前代码已经把“不要误删”和“Schema 预留”做好了，但“原子 Generation”和“正式 Agentic Search”还没有；方案不能把这两件事写成已完成。
