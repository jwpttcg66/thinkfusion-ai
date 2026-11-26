# ThinkFusion V3 全局架构与实施计划一致性修订任务书

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


状态：待执行（文档治理与契约修订）  
版本：V1.0  
审计日期：2026-11-24  
审计仓库：`jwpttcg66/thinkfusion-ai`  
审计基线：`main@6f871e2b34c453c12db145d18a76441eba600026`  
设计基线：`main@e336ae434978211138879688031a9d40c1a27cd7`  
代码修改：本任务书不授权直接修改运行时代码  
远程推送：未经用户明确授权不得推送

> 本任务书不是第四套总体规划。它是在现有 V3 P0–P6 与 LT-P0–P6 之上，
> 先完成全局事实、契约、存储、测试和状态的一致性门禁，再进入 LT-P0。
>
> 已完成的长任务文档修订不重复施工；只处理剩余契约缺口与跨计划协调。

## 一、背景

截至 2026-11-24，远程 `main` 已完成三轮长任务文档建设：

| 提交 | 内容 | 性质 |
| --- | --- | --- |
| `8b812a5` | 冻结长任务架构与 LT-P0–P6 任务书 | 架构与计划 |
| `e336ae4` | 补全契约、存储、ADR、测试、UI、灰度 | 文档完善 |
| `6f871e2` | 应用上一轮审查修订 | 仅文档/工程规则 |

`6f871e2` 未修改 `src/`、`scripts/` 或 `package.json`。长任务功能仍未进入运行时。

上一轮审查已落实：

- 唯一状态板 `STATUS.md`；
- 区分 P0-J 设计门禁与功能实现；
- `ContextOwner` 支持 AgentTask/Conversation；
- 事件归档与完整来源引用；
- 检查点提交顺序修订；
- 未知窗口不伪造百分比；
- LT-P0-05～08；
- 未来测试脚本标记；
- Debate 历史规格与 reasoning 展示边界。

本任务书解决修订后仍存在的契约不一致与跨计划协调。

## 二、目标

1. 产品定位、总体架构、模块职责、工程规则一致。
2. V3 原计划与 LT 长任务计划无职责冲突。
3. Task/Execution/Session/Context 四种状态边界明确。
4. 新增能力有唯一数据来源和持久化责任。
5. 跨空间上下文覆盖 General、Knowledge、Engineering。
6. Journal、Evidence、Memory、Checkpoint 不重复建设。
7. 测试计划真正接入现有测试入口。
8. 每阶段有文件范围、验收、回滚。
9. 文档完成状态可追溯到代码与测试证据。

## 三、全局架构决议

### 3.1 工作空间

| 空间 | 职责 | 生命周期 |
| --- | --- | --- |
| General | 日常问答、分析、比较、研究 | Conversation |
| Knowledge | 知识研究、沉淀、历史结论复用 | Conversation |
| Engineering | 项目理解、架构、计划执行、代码修改与验证 | AgentTask / TaskManager |

系统自动识别空间，不要求用户选择辩论、评审或研究模式。辩论、交叉验证、
反例分析、方案竞争都是统一协作引擎的可选行为。

### 3.2 分层

```text
General / Knowledge / Engineering
        ↓
Collaboration Engine
  Planner · Scheduler · Participants · Runner · Replanner · Debate · Synthesizer
        ↓
Existing Execution Governance
  TaskManager · AgentOrchestrator · Approval · TaskGrant · Journal · Verifier
        ↓
Context Manager（新增）
  Builder · Budget · Estimator · Pruner · Summarizer · Checkpoint · Recovery
        ↓
Existing Infrastructure
  AgentStore / Conversation · EvidencePackStore · MemoryService · Provider/Adapter
```

### 3.3 不可违反的边界

1. 不新建第三套 Agent Runtime。
2. 不新建第二套 TaskManager、Journal、审批、TaskGrant、Verifier。
3. Context Manager 不是任务调度器。
4. General/Knowledge 不强行转成 AgentTask。
5. Memory、Evidence、Compaction 不合并。
6. 不用摘要替代真实执行事件。
7. 窗口未知不静默切换 Provider。
8. 不改变用户原始问题。
9. Web 保持原话输入；CLI 不伪造 system turn。
10. 工程可观测性保留真实事件、模型输出、工具执行记录。

### 3.4 四种状态

| 状态 | 权威来源 | 职责 |
| --- | --- | --- |
| Task State | TaskManager / ConversationRunner | 任务/会话生命周期 |
| Execution State | AgentOrchestrator / Collaboration State | 执行步骤、审批、工具、副作用 |
| Session History | AgentStore / Conversation | 原始消息与事件 |
| Context State | Context Manager | 上下文版本、预算、摘要、检查点 |

任何一个状态改变不能直接推导其他状态已改变。

## 四、当前代码事实

| 文件 | 当前职责 | 本次原则 |
| --- | --- | --- |
| `src/main/task-manager.ts` | 工程任务状态机 | 沿用并扩展 |
| `src/main/orchestrator.ts` | 工程执行治理 | 沿用并扩展 |
| `src/main/conversation-runner.ts` | General/Knowledge 会话执行 | 保留独立生命周期 |
| `src/main/store.ts` | AgentTask/Conversation/事件/消息持久化 | 继续作为 Journal |
| `src/main/execution/execution-pool.ts` | 多模型执行入口 | 后续接 Context Manager |
| `src/main/execution/provider-sub-agent.ts` | Provider 调用适配 | 后续接上下文准备 |
| `src/main/memory/` | 长期记忆存储、召回、注入 | 不改造成压缩系统 |
| `src/main/providers/types.ts` | 请求、模型能力、Usage | 扩展时保持兼容 |
| `src/shared/task-events.ts` | 统一事件适配 | 扩展 ContextEvent |
| `src/shared/task-lifecycle.ts` | 任务事件生命周期 | 沿用 |

### 4.1 当前缺口

**任务恢复**

`TaskManager.reconcileInterrupted()` 把 `planning/executing/verifying` 转为
`failed`，要求重新提交；没有检查点恢复，也没有副作用核对。

**事件存储**

`AgentStore` 存在：

```text
MAX_EVENTS_PER_TASK = 800
MAX_RUN_EVENTS = 5000
```

`appendEvent()` 与 `appendRunEvent()` 都会裁剪。`persist()` 使用临时文件、
文件 fsync、rename，但没有父目录 fsync，也没有多字段原子提交接口。

**会话身份**

`Conversation` 没有独立 `runId/contextId/checkpointId`。
`conversationEventToTaskEvent()` 允许把 `conversationId` 当默认 `runId`，
不足以区分同一会话的不同执行过程。

**上下文管理**

当前没有 `src/main/context/`，没有预算、裁剪、摘要检查点、恢复实现。

**测试体系**

`npm test → run-test-suite.mjs → test:all` 已存在；长任务文档中的
`test:context-*` 仍是未来脚本，不能当现有测试。

## 五、本轮必须修正的契约

### V3-C01 统一 ContextManager API

当前契约：

```ts
interface ContextManager {
  prepare(input: PrepareContextInput): Promise<PreparedContext>;
  finalize(input: FinalizeContextInput): Promise<void>;
  recover(taskId: string, runId: string): Promise<PreparedContext | null>;
}
```

问题：`ContextOwner` 已支持两类 owner，但 recover/Prepare/Finalize 仍 task-only。

修订：

```ts
interface ContextManager {
  prepare(input: PrepareContextInput): Promise<PreparedContext>;
  finalize(input: FinalizeContextInput): Promise<void>;
  recover(input: { owner: ContextOwner; runId: string }): Promise<PreparedContext | null>;
}
```

`PrepareContextInput` / `FinalizeContextInput` 必须支持两类 owner。
禁止为 Conversation 伪造 AgentTask。

### V3-C02 Conversation 的运行身份

冻结：

- `conversationId`：整个会话的稳定身份；
- `runId`：一次连续执行过程；
- `contextId`：当前上下文版本；
- `checkpointId`：最近提交的上下文检查点。

规则：

1. 新用户请求启动新 runId；
2. 同一次请求的模型/工具/评审共享 runId；
3. 暂停恢复原 runId；
4. 明确重新开始时才生成新 runId；
5. 新 run 可继承已提交检查点，但记录来源 checkpointId；
6. 删除会话时指针与归档一致清理；
7. Conversation 上下文跨用户轮次延续，但 runId 不永久等于 conversationId。

### V3-C03 检查点活动指针唯一性

当前同时存在：

- AgentTask/Conversation 的 `contextId/checkpointId/activeRunId`；
- `ContextOwnerFile.active`。

必须冻结：**Journal 中 owner 的活动指针是唯一提交权威。**

检查点文件只保存：

- owner；
- 多 runId 的检查点记录；
- 内容与完整来源；
- 文件版本与更新时间。

不再让检查点文件 `active` 成为第二权威。如保留缓存指针，必须标明可重建，
不能参与提交/恢复决策。

### V3-C04 Journal 归档覆盖两类事件流

必须覆盖：

1. `AgentStore.events`：工程任务事件；
2. `AgentStore.runEvents`：General/Knowledge 映射事件。

明确：

- 两类事件来源与 ID；
- 序号与 runId 稳定性；
- 归档格式、哈希；
- 归档失败行为；
- 裁剪前如何确认归档完成；
- 检查点如何引用归档段；
- 归档段如何 GC；
- 是否与 ConversationMessage 正文重复；先确定权威来源再决定归档范围。

### V3-C05 检查点提交真实原子性

冻结：

```text
生成摘要
→ 校验摘要/EvidenceRef
→ 持久化原始事件归档
→ 写 prepared 检查点文件
→ fsync 文件
→ rename
→ fsync 父目录
→ Journal 单次原子更新：
   owner.contextId
   owner.checkpointId
   owner.activeRunId
   context.compaction.committed
→ 确认指针与 hash 一致
→ 异步 GC
```

必须提供：

```ts
commitContextCheckpoint(input): void | Promise<void>
```

一次更新 owner 指针、追加 committed 事件、一次持久化。
不得用多个独立 upsert/append 模拟事务。Journal 持久化需评估父目录 fsync。

### V3-C06 事件裁剪与归档一致协议

不能只写“未归档不得裁剪”。必须给 `trimEvents()` / `appendRunEvent()` 可验证保护：

- 被检查点引用的事件必须已有完整归档；
- 归档失败不能提交依赖它的检查点；
- 被引用未归档事件不能裁剪；
- 两套配额都遵守保护；
- 原始事件与归档段不能因检查点 GC 误删；
- 未被引用历史仍可按配额清理；
- 支持启动恢复、哈希校验、重复归档识别、故障注入。

### V3-C07 测试门禁统一

现有入口：

```text
npm test → run-test-suite.mjs → test:all
```

新增测试必须：

1. 登记 `package.json`；
2. 纳入 `test:all`；
3. 被 `run-test-suite.mjs` 正确解析；
4. 可单独运行；
5. 不重复全量编译；
6. 报告区分单测/集成/E2E/真机。

不允许只写不存在的测试命令。

## 六、两条实施轨道

| 轨道 | 编号 | 职责 |
| --- | --- | --- |
| V3 总体 | P0–P6 | 协作、知识、工程、证据、通道、UI、运维 |
| 长任务 | LT-P0–LT-P6 | Context Manager、压缩、检查点、恢复、UI |

不得混用编号。

### 6.1 共享文件所有权

| 文件 | 主要所有权 | LT 边界 |
| --- | --- | --- |
| `task-manager.ts` | V3 生命周期 | 扩展暂停/中断/预算状态 |
| `orchestrator.ts` | V3 执行治理 | 接入上下文/恢复钩子 |
| `store.ts` | V3 Journal | 归档保护与检查点事务接口 |
| `task-events.ts` | 统一事件契约 | 增加 ContextEvent |
| `task-view.ts` | 视图投影 | 增加上下文展示 |
| `conversation.ts` | 会话模型 | 增加上下文指针与运行身份 |
| `conversation-runner.ts` | General/Knowledge | 接入 ContextManager |
| `execution-pool.ts` | 模型执行入口 | prepare/finalize |
| `provider-sub-agent.ts` | Provider 适配 | 透传上下文与真实 Usage |

同一文件只能有一个任务负责修改；其他任务依赖其接口，不平行重写。

### 6.2 开发规则

遵守 `AGENTS.md`：最新 main 建 worktree/分支；一任务一 worktree；不在 main
直接开发；不覆盖未提交工作；不推送；先完成验证提交，再串行集成；合并验证
通过后清理 worktree/分支。

## 七、G0–G6 任务

### G0 审计基线与事实清单

- G0-01 读取最新 main/分支/提交；
- G0-02 确认代码相对 `e336ae4` 是否变化；
- G0-03 核对 AgentTask/Conversation/Journal/Memory/Evidence/Provider；
- G0-04 整理文档分类；
- G0-05 记录已解决/未解决问题。

产出：`docs/implementation/V3-GLOBAL-CONSISTENCY-AUDIT.md`。

验收：结论能指向文件/代码；不把设计当实现；不重复审计无关模块。

### G1 全局架构一致性

- G1-01 三空间生命周期；
- G1-02 Collaboration Engine 与 AgentOrchestrator 职责；
- G1-03 四种状态；
- G1-04 Debate/Evidence/Memory/Compaction 边界；
- G1-05 Web/Local/Remote/Hybrid/CLI 边界；
- G1-06 reason/输出/工具/摘要来源；
- G1-07 历史规格约束清理。

产出：`docs/architecture/V3-GLOBAL-ARCHITECTURE.md`。

验收：无重复 Runtime/Journal；无多模块争夺同一状态；历史规格不覆盖当前架构。

### G2 跨空间上下文契约

- G2-01 ContextOwner/ownerId；
- G2-02 AgentTask runId；
- G2-03 Conversation runId；
- G2-04 PrepareContextInput；
- G2-05 FinalizeContextInput；
- G2-06 recover owner-aware；
- G2-07 多 runId 检查点；
- G2-08 活动指针唯一权威。

产出：修订 `docs/spec/LONG_TASK_CONTEXT_CONTRACTS.md`。

验收：两类 owner 可用；不伪造 AgentTask；旧数据兼容；多 run 不串；
无上下文字段按未压缩。

### G3 Journal 与检查点存储

- G3-01 独立检查点文件方案；
- G3-02 owner 文件与 Journal 指针；
- G3-03 `commitContextCheckpoint()`；
- G3-04 文件/Journal 原子顺序；
- G3-05 父目录 fsync；
- G3-06 AgentEvent 归档；
- G3-07 TaskEventEnvelope 归档；
- G3-08 Journal 裁剪保护；
- G3-09 删除后异步 GC；
- G3-10 备份/恢复/孤儿清理。

产出：修订 `CONTEXT_CHECKPOINT_STORAGE.md` 与 `ADR 0010`。

验收：任意崩溃点可恢复；Journal 不指向不存在检查点；未归档不裁剪；
归档 hash 可验；活动检查点不 GC；旧数据可读。

### G4 V3/LT 计划协调

- G4-01 V3 P0–P6 实际状态；
- G4-02 LT 实际状态；
- G4-03 共享文件所有权；
- G4-04 任务依赖；
- G4-05 去重；
- G4-06 PR 边界；
- G4-07 不重写 V3。

产出：修订 `TASK-BOOK.md` 与 `LONG-TASK-CONTEXT-TASK-BOOK.md`。

验收：每个文件唯一责任任务；依赖明确；无并行重写；退出条件明确。

### G5 测试、状态与文档

- G5-01 package.json 测试脚本；
- G5-02 `test:all` / `run-test-suite.mjs`；
- G5-03 登记未来 `test:context-*`；
- G5-04 单测/集成/故障注入/真机分层；
- G5-05 `STATUS.md`；
- G5-06 `docs/README/ROADMAP/PRODUCT`；
- G5-07 V3/LT 互相引用；
- G5-08 ADR 0010。

验收：状态与代码事实一致；脚本存在或标未来；新增测试入 `test:all`；
唯一状态板；历史文档标 `HISTORICAL`。

### G6 全局评审与冻结

- G6-01 架构复审；
- G6-02 上下文契约复审；
- G6-03 存储复审；
- G6-04 计划冲突复审；
- G6-05 测试门禁复审；
- G6-06 评审记录。

产出：`docs/implementation/V3-GLOBAL-CONSISTENCY-REVIEW.md`。

验收：G0–G5 完成；无 P0 冲突；ADR 0010 通过；状态/任务书一致；
LT-P0 出口明确。

## 八、与 LT-P0–P6 的关系

| 阶段 | 内容 | 进入条件 |
| --- | --- | --- |
| LT-P0 | 契约与存储冻结 | G6 通过 |
| LT-P1 | Context Manager 基础 | LT-P0 完成 |
| LT-P2 | 工具结果裁剪 | LT-P1 完成 |
| LT-P3 | 摘要与检查点 | LT-P0 ADR、P1、P2 完成 |
| LT-P4 | Provider 接线 | P1/P2/P3 完成 |
| LT-P5 | 暂停恢复 | P0/P3/P4 完成 |
| LT-P6 | UI 与 E2E | P4/P5 完成 |

现有 35 项 LT 任务继续是功能实施清单。G0–G6 是治理门禁，不与 LT 混用。

## 九、验收矩阵

| 领域 | 必须证明 |
| --- | --- |
| 产品架构 | 三空间共用协作引擎，但生命周期正确 |
| 任务管理 | TaskManager 仍是工程状态权威 |
| 会话 | Conversation 不伪造 AgentTask |
| 协作 | 不新建第二套 Runtime |
| 上下文 | ContextManager 只管模型输入 |
| Memory | 长期记忆与本轮摘要分离 |
| Evidence | 摘要引用真实证据，不替代证据 |
| Journal | 原始事件可追溯，裁剪受归档保护 |
| Checkpoint | Journal 指针唯一提交权威 |
| Provider | 未知窗口/Usage/费用保持 null |
| Web/CLI | 协议边界不变 |
| UI | 只展示真实事件与来源 |
| 测试 | 新测试入 test:all |
| 恢复 | 不重复已完成副作用 |
| 文档 | 唯一状态板，完成可追溯 |

## 十、回滚与安全

1. G0–G6 以文档/契约为主，不顺手改无关代码。
2. ADR 0010 未通过前不实施检查点存储。
3. ContextOwner 未冻结前不开始跨空间接线。
4. 归档协议未冻结前不启用历史裁剪。
5. 开关关闭时请求行为不变。
6. 检查点失败回退未压缩，不阻塞普通问答。
7. 恢复不确定副作用进入 `needs_reconciliation`，不自动重做。
8. 备份恢复失败保留原数据，不覆盖唯一副本。
9. 功能变更可独立回滚。
10. 不自动发布/签名/公证/推送。

## 十一、交付物

| 交付物 | 路径 |
| --- | --- |
| 本任务书 | `docs/implementation/V3-GLOBAL-CONSISTENCY-TASK-BOOK.md` |
| 全局审计 | `docs/implementation/V3-GLOBAL-CONSISTENCY-AUDIT.md` |
| 全局架构 | `docs/architecture/V3-GLOBAL-ARCHITECTURE.md` |
| 跨空间上下文契约 | `docs/spec/LONG_TASK_CONTEXT_CONTRACTS.md` |
| 检查点 ADR | `docs/adr/0010-context-checkpoint-storage.md` |
| Journal 归档协议 | `docs/architecture/CONTEXT_CHECKPOINT_STORAGE.md` |
| V3/LT 依赖 | `docs/implementation/TASK-BOOK.md` |
| 唯一状态板 | `docs/implementation/STATUS.md` |
| 评审记录 | `docs/implementation/V3-GLOBAL-CONSISTENCY-REVIEW.md` |

不新建第二份 LT 总任务书。

## 十二、完成判据

- G0 审计报告完成；
- G1 架构一致性通过；
- G2 跨空间 Context API 冻结；
- G3 Journal/检查点协议冻结；
- G4 文件所有权/依赖明确；
- G5 测试门禁/状态板统一；
- G6 评审通过；
- ADR 0010 正式通过；
- 文档互引正确；
- 不把设计完成误报为功能实现；
- 不改无关运行时代码；
- 未经授权不推送。

## 十三、实施纪律

**先统一事实，再统一契约；先冻结职责，再实施功能；先证明可恢复，再允许裁剪历史；先完成真实验证，再更新状态。**

所有后续开发以届时最新远程 `main` 为依据，只审计当前任务涉及的文件、调用链和测试。
任何设计变更先更新契约、ADR 和任务依赖，再改代码。
