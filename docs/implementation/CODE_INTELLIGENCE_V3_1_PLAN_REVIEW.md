# Agentic Search 实施计划 V3.1 审核

> 代码落地后的复核见 `CODE_INTELLIGENCE_V3_1_IMPLEMENTATION_REVIEW.md`。

- 审核对象：`/Users/yalla/Downloads/制定辩论主题方案 (9)-20261113-1131-2.md`
- 审核基线：`5b2e56eb6e2502eb2e14d8fac841f0a16c46b22e`
- 审核提交：`d51cd1c`（仅审核文档）
- 审核日期：2026-11-13
- 上一轮：`CODE_INTELLIGENCE_V3_PLAN_REVIEW.md`

---

## 1. 结论

**V3.1 已经可以作为实施主线，但“APPROVED”必须改成“AUTHORIZED / IN_PROGRESS”，不能表示 Gate 已经通过。**

五项 P0 修正基本到位：

- Gate 1 拆成 1A/1B；
- Java Symbol ID 明确 `provisional`，不提前冻结；
- Generation 覆盖 FTS/vectors/docs/link 等；
- D0.4 明确 Provider/Tool Contract；
- 5 个基准、Evidence ID、Claim 关联、Verdict 映射都已写入。

仍需要修正的地方集中在“状态语义”“基准循环依赖”“Generation 表分类”“TS/JS ID 仍含路径”和“回归命令/性能测量被删掉”。

**建议批准范围**：Gate 0、Gate 1A、Gate 1B 作为**实施授权**；Gate 2 继续 PENDING。不是在说 Gate 0/1 已经验收通过。

---

## 2. V3.1 已经解决的事项

| 上一轮 P0 | V3.1 处理 | 判断 |
| --- | --- | --- |
| Gate 1 先冻结 Java Symbol ID | 6.2 明确 Java `provisional`，Gate 3 再冻结 | **已解决** |
| Generation 只覆盖 nodes/edges | 7.1 列出 FTS/docs/vectors/link/file_state/outbox | **方向已解决**，分类仍需调整 |
| Agentic Search 没有 Provider/工具契约 | D0.4 列 ModelRequest、Provider、Tool Contract、接入点、安全 | **方向已解决**，字段仍需补全 |
| Gate 2 的 30 问题不可执行 | 第 9 章先做 5 问题，9.2/9.3 有基准字段和评分 | **已解决方向**，阈值仍需定 |
| Evidence 无 ID/Claim/Verdict | 第 12 章有 evidenceId/hitId/Claim 关系/Verdict 映射 | **方向已解决**，公式/生命周期仍需定 |
| TS/JS 不要切 Tree-sitter | 6.2/11.1 明确继续 TypeScript AST | **已解决** |
| `target/.gradle` 忽略 | 11.3 明确补 | **已解决** |
| 安装包只验证 grammar | 11.5 明确 runtime wasm + grammar + 安装包 | **已解决** |

V3.1 对当前代码的判断也基本准确：`askWithReadTool` 只有 1 轮、`ModelRequest` 无 tools、Web 不能工具调用、Generation 不是快照、`maxFiles` 风险、Java 仍是正则。

---

## 3. 仍需修正的 P0

### P0-1：APPROVED 语义错误，容易被当成“Gate 已通过”

第 4 章和第十九章把 Gate 0、1A、1B 标为 `APPROVED`，但 Gate 0 的工作内容（ADR、5 个基准、模型探测、Maven、Web 降级、成本基线）还没有完成；Gate 1A/1B 也还没有实现。

这会让执行者误以为“已经验收通过”，和文档自己写的“每个 Gate 完成后提交验收报告”矛盾。

**建议**：

状态拆成三类：

```
AUTHORIZED    允许开始实施，不代表完成
IN_PROGRESS   正在实施
PASSED        通过该 Gate 验收
```

- Gate 0：`AUTHORIZED`（不是 PASSED）；
- Gate 1A/1B：`AUTHORIZED`；
- Gate 2～5：`DEFERRED/PENDING`。
- 只有 Gate 验收报告 + 测试证据齐全，才能写 `PASSED`。

**关闭标准**：全文状态表统一语义；不再用 `APPROVED` 同时表示“批准做”和“已经过”。

### P0-2：五个基准与 Agentic Search 存在循环依赖

第 9 章要求 Gate 0 先完成 5 个工程问题基准；但当前产品还没有正式的 Agentic Search 循环，只有 `askWithReadTool` 1 轮和 `scripts/spikes/agentic-search-real.cjs` 的独立 harness。

Gate 2 又要求“D0.4 ADR + 五问题基准”后才批准。问题是：

- 如果 5 个问题用正式产品跑，产品还不存在；
- 如果用 Spike harness 跑，需要明确“这是 harness 结果，不是产品结果”；
- 如果只跑 baseline，无法验证 Agentic Search 的增益。

**建议**：

- 明确 5 个问题由 `scripts/spikes/agentic-search-real.cjs` 或一个新的只读 harness 执行；
- 基准记录必须标 `harness` / `baseline`，不能标 `product`；
- Gate 2 批准的是“实现正式循环”，不是“基准已经证明产品完成”；
- 5 个问题通过后，Gate 2 才允许写多轮循环；30 个问题仍是 Gate 2 验收，不是 Gate 0。

**关闭标准**：基准文档写清运行载体、模型、代码版本、是否产品路径。

### P0-3：Generation 表分类不清，`code_memory_link` / `code_outbox` 不应简单复制

7.1 把 8 张表都标成“纳入 Generation”。但它们的性质不同：

| 表 | 性质 | 建议 |
| --- | --- | --- |
| `code_nodes` / `code_edges` / `code_search_docs` / `code_fts` / `code_vectors` | 索引快照 | 写新 generation，读 current |
| `code_file_state` | 扫描状态 | 记录 generation + 扫描完整性，不能简单复制 |
| `code_outbox` | 任务队列 | 不应按 generation 复制；记录目标 generation |
| `code_memory_link` | 用户记忆关联 | 不应复制；提交后校验 `active/needs_relink/pending_review` |

如果强行把 link/outbox 塞进 generation 快照：

- 用户记忆会被复制成多份；
- 清理旧 generation 时可能误删用户关联；
- outbox 任务会被重复执行。

**建议**：

- 明确“索引快照表”和“派生/用户数据表”的边界；
- link 采用 generation-aware validation，而不是 generation-scoped copy；
- outbox 记录 `target_generation` / `status`，不参与快照复制；
- 7.1 的表格增加“处理方式”列。

**关闭标准**：D1B 设计文档逐表写“复制 / 引用 / 校验 / 不参与”，并有对应测试。

### P0-4：TS/JS Symbol ID 仍包含文件路径，和“文件移动保持身份”冲突

6.2 写 TS/JS 稳定 ID 需要考虑“文件相对路径”。但路径进入 ID 后：

- 文件移动 → ID 变化；
- Code-Memory Link 断；
- 边需要重写；
- 和“稳定身份”目标冲突。

**建议**：

- 路径只作为 `locator`，不作为 `symbolId` 的组成部分；
- `symbolId = project + language + symbolKind + qualifiedName + scope + signature?`；
- 文件移动只更新 locator，不改 ID；
- 如果确实需要路径参与，必须在 6.4 明确“文件移动会产生新 ID，link 进 needs_relink”，不能同时声称稳定。

**关闭标准**：Gate 1A 的 TS/JS 测试包含“移动文件后 symbolId 不变”；如果做不到，明确降级并写入验收。

### P0-5：Gate 2 的 Tool Contract 仍缺关键字段

D0.4 问题四列了 toolCallId/toolName/参数摘要/状态/结果/证据/错误/耗时，但还缺：

- `projectId`；
- `generation` / `sourceVersion`；
- `total` / `truncated`；
- `warnings`；
- 证据引用的 `type/id`，不能只有一个“证据引用”；
- 工具调用的 `callIndex` / `remainingBudget`（便于 Trace 和调试）；
- 模型返回的原始 tool call 与 host 实际执行的对应关系。

**建议**：定义统一的 `EngineeringToolResult`：

```
toolCallId, toolName, projectId, generation,
argsSummary, status, content, evidenceRefs[],
total?, truncated?, warnings?, error?, durationMs?
```

**关闭标准**：D0.4 交付物包含完整 TypeScript 接口；后续 Provider/工具实现不得各写一套。

### P0-6：回归命令和性能测量被删掉

V3 里明确列了：

```
npm run typecheck
npm test
npm run build
npm run test:code-index
npm run test:debate
npm run test:engineering-tools
npm run test:ollama
npm run test:ollama:live
```

V3.1 没有保留这组命令，只写了“运行测试并记录结果”。这会让 Gate 验收不可复现。

另外 V3 的 Gate 1 “测量 1000/5000/10000 文件、主进程 CPU/RSS/UI 卡顿，必要时 Worker”也被删掉；V3.1 只在 Gate 3 写“大工程性能可接受”。

**建议**：

- 恢复回归命令清单；
- Gate 1B 增加 1k/5k/10k 基线，记录主进程事件循环延迟/RSS/SQLite 增长；
- 明确 Worker Thread 触发条件，否则 Gate 1B 无法证明“大工程可用”；
- live 测试的 SKIP 必须单独列出，不能算 PASS（V3.1 第十七章已写，保留）。

---

## 4. 其他需要修正的点

### 4.1 `confirmed` / `resolved` / `provisional` 三套词

- 原则四用 `confirmed`；
- Gate 3 用 `confirmed`；
- ADR-0002 / 现有 `ResolutionStatus` 用 `resolved`；
- `provisional` 又用于 Java Symbol ID。

**建议**：统一一套 RelationStatus：

```
resolved | ambiguous | unresolved | dynamic | inferred
```

- `confirmed` 作为 UI 文案，不进入数据枚举；
- `provisional` 只用于 `symbolStatus`，不用于边；
- 在 ADR 里写映射。

### 4.2 Claim 关系名与现有 ArgumentRelation 不一致

Gate 4 用 `supportedBy / contradictedBy / partiallySupportedBy / unresolvedBy`；现有 `ArgumentRelation` 是 `supports / rebuts / qualifies / depends_on / contradicts / derived_from`。

需要映射表，不要新增第二套关系词。

### 4.3 `code.references` 不能直接叫“已确认”

Gate 2 工具表写 `code.references` “获取已确认的引用关系”。当前图谱仍可能包含 `ambiguous/inferred`，而且 Gate 1B 才修关系状态。

**建议**：工具返回 `relationStatus`，默认只返回 `resolved`，并把 `ambiguous/inferred` 作为候选显式列出；不能把候选叫“已确认”。

### 4.4 `JuryOrchestrator` 可能变成第二个辩论编排器

Gate 5 计划新增 `JuryOrchestrator`、多个 Jury Agent。现有 DebateOrchestrator 已经有多轮、Claim、Evidence、Revision、Judge、Argument Graph。

**建议**：Jury 先作为 DebateOrchestrator 的一种评审模式/角色扩展，不新建独立 orchestration 层；如果确实需要独立，先写 ADR，说明为什么不复用现有 orchestrator。

### 4.5 Managed 文档仍有两套说法

第 5.2 节要求更新 `CODE_INTELLIGENCE_PRODUCT_MODES.md`，但第 14 章 Managed 仍写“后续支持：Neo4j…”，而当前代码已经有 ManagedNeo4j 启停/重启/版本/健康检查。

**建议**：把 Managed 拆成：

- 已实现：本机 Neo4j 生命周期；
- 规划中：Python/CGC/Graphiti 托管、外部托管图数据库、多项目图谱；
- 未审查：GPLv3 分发。

### 4.6 Gate 1B 的 SQLite 并发/长事务风险

当前 `store.ts` 已设置 WAL + busy_timeout 5000，这是好基础。但“新 generation 全量复制 + 单事务切换 + 并发读”需要验证：

- 长写事务是否阻塞读；
- 10k 文件复制 + FTS 重建的耗时；
- 清理旧 generation 时是否锁库；
- 进程退出时的 WAL 恢复。

Gate 1B 应有对应实测，不只写“支持并发读取”。

### 4.7 扫描上限的“分页/继续”没有定义

7.5 说“不完整扫描不能全量删除”，但没有说明超过 `maxFiles` 的文件如何被索引：

- 只索引前 500/1000 个，其余永远不索引？
- 分页继续扫描？
- 按 source root 分批？
- UI 如何显示覆盖率？

**建议**：增加“扫描分页/游标/后台继续”的设计；否则大工程只是“不误删”，不是“能索引”。

### 4.8 Gate 0 状态与 D0.4/5 问题的顺序

第十九章最终顺序把 D0.4 和五问题基准放在 Gate 1B 之后，但 Gate 0 验收又要求“模型工具能力有真实测试记录、五个基准有预期答案”。需要明确：

- Gate 0 只做“基准问题和模型探测”；
- D0.4 ADR 可以在 Gate 1B 后写；
- 但 Gate 2 前必须两者都完成。

建议画一张前置依赖图，避免执行者把 D0.4 当成 Gate 0 的一部分或反过来。

---

## 5. 修订后的批准范围

| 阶段 | 建议状态 | 条件 |
| --- | --- | --- |
| Gate 0 | **AUTHORIZED** | 完成 ADR 状态、5 问题、模型探测、Maven、Web、成本；报告后才是 PASSED |
| Gate 1A | **AUTHORIZED** | Schema v4 + 迁移 + TS/JS ID；Java provisional |
| Gate 1B | **AUTHORIZED** | 全表 generation、崩溃/并发、扫描分页、性能基线 |
| D0.4 | REQUIRED | Gate 2 前完成，不要求 Gate 0 前 |
| 5 问题基准 | REQUIRED | 明确 harness/baseline；Gate 2 前完成 |
| Gate 2 | PENDING | 上述完成 + 30 问题/3 工程门槛批准后 |
| Gate 3～5 | DEFERRED | 不提前 |

---

## 6. 实施顺序建议

```
Gate 0 收尾（AUTHORIZED）
  ├─ ADR 状态
  ├─ 产品模式文档
  ├─ 5 问题 manifest（harness）
  ├─ 模型工具探测
  ├─ Maven/Gradle 信任
  └─ 成本基线
        │
        ▼
Gate 1A（AUTHORIZED）
  Schema v4 / 迁移 / TS-JS ID / Java provisional
        │
        ▼
Gate 1B（AUTHORIZED）
  Generation 全表 / 扫描分页 / 崩溃恢复 / 并发 / 性能
        │
        ├──────────────┐
        ▼              ▼
   D0.4 ADR        5 问题基准
        └──────┬───────┘
               ▼
        Gate 2 重新审批
```

Gate 2 之前不要把多轮循环、30 问题、Jury 一起做。

---

## 7. 最终意见

V3.1 已经吸收了 V3 审核的主要 P0，方向正确，可以作为实施主线。

现在最重要的不是再扩写能力，而是把以下四件事钉死：

1. **状态语义**：`AUTHORIZED` 不等于 `PASSED`；
2. **基准载体**：5 个问题是 harness 还是产品，必须先说清；
3. **Generation 表分类**：快照、用户数据、任务队列分开处理；
4. **TS/JS ID**：路径不能进身份，否则“文件移动稳定”自相矛盾。

这四点修正后，Gate 0、1A、1B 可以按计划实施；Gate 2 继续等 D0.4 和基准结果。
