# V3 全局一致性审计（G0）

状态：完成（文档级）  
日期：2026-11-24  
审计基线：`main@6f871e2b34c453c12db145d18a76441eba600026`  
对照基线：`e336ae434978211138879688031a9d40c1a27cd7`  
任务书：[V3-GLOBAL-CONSISTENCY-TASK-BOOK.md](V3-GLOBAL-CONSISTENCY-TASK-BOOK.md)

> 本审计只读取代码与文档，不修改运行时代码、不提交、不推送。
> 结论以 `6f871e2` 的文件事实为准，不把设计文档当实现。

## 1. 基线与分支

| 项 | 值 |
| --- | --- |
| `origin/main` | `6f871e2` |
| `origin/product-v3` | `4955bbf` |
| 共同祖先 | `product-v3` 是 `main` 祖先 |
| `product-v3..main` | 234 个提交 |
| `main..product-v3` | 0 个提交 |
| 本次提交性质 | 仅文档/工程规则 |
| 运行时代码变化 | 无 |

核对命令：

```bash
git merge-base --is-ancestor 4955bbf origin/main   # yes
git rev-list --count 4955bbf..origin/main          # 234
git rev-list --count origin/main..4955bbf          # 0
git diff --stat e336ae4..6f871e2 -- desktop-agent-macos/src desktop-agent-macos/scripts desktop-agent-macos/package.json
# 空
```

> 说明：上一轮审查文字写“233 个提交”，本次实际 `git rev-list --count` 为 234；
> 以命令结果为准。

## 2. 代码事实

### 2.1 任务与执行

| 文件 | 事实 |
| --- | --- |
| `src/main/task-manager.ts` | `reconcileInterrupted()` 把 `planning/executing/verifying` 转为 `failed`，要求重新提交 |
| `src/main/orchestrator.ts` | 工程执行治理；`continueAfterReport` 是修复入口之一 |
| `src/shared/contracts.ts` | `TaskStatus` 无 `paused/interrupted/budget_exhausted/blocked` |
| `src/shared/contracts.ts` | `AgentTask` 无 `runId/contextId/checkpointId/activeRunId` |
| `src/main/conversation-runner.ts` | General/Knowledge 独立生命周期；不伪造 AgentTask |

### 2.2 会话

`Conversation` 当前字段（`src/shared/conversation.ts`）没有：

- `runId`
- `contextId`
- `checkpointId`
- `activeRunId`

`conversationEventToTaskEvent()` 允许 `conversationId` 作为默认 `runId`。
同一会话的不同执行过程无法仅靠 `runId` 区分。

### 2.3 Journal

`src/main/store.ts` 事实：

- `MAX_EVENTS_PER_TASK = 800`
- `MAX_RUN_EVENTS = 5000`
- `appendEvent()` 调用 `trimEvents()`；
- `appendRunEvent()` 直接按全局 5000 裁剪；
- `trimEvents()` 按 task 分组，跳过 `KEEP_FOREVER`；
- `persist()` 使用临时文件 + 文件 `fsync` + `rename`；
- **没有父目录 fsync**；
- 没有 `commitContextCheckpoint()` 一类多字段原子提交接口；
- 两套事件流：`events`（AgentEvent）与 `runEvents`（TaskEventEnvelope）。

### 2.4 Provider

`src/main/providers/types.ts`：

- `ModelMetadata.contextTokens: number | null`；
- `ModelUsage.inputTokens/outputTokens: number | null`；
- 未知值不能写 0。

### 2.5 上下文运行时

当前不存在：

```text
desktop-agent-macos/src/main/context/
```

长任务文档中的 Context Manager 仍是设计，不是代码。

### 2.6 测试体系

`package.json` 存在：

```text
test → build:agent + build:test + run-test-suite.mjs
test:all → 长链
```

`scripts/run-test-suite.mjs` 从 `test:all` 解析测试文件，要求：

- 链步骤以 `npm run test:` 开头；
- 脚本实际实现是 `node --test ...` 或 `node <file>`；
- 未识别的命令形态会抛错。

当前不存在：

- `test:context-contracts`
- `test:context-builder`
- `test:context-budget`
- `test:context-pruner`
- `test:context-summary`
- `test:context-checkpoint`
- `test:context-recovery`
- `test:long-task-context-e2e`

## 3. 文档事实

| 文档 | 当前内容 | 判断 |
| --- | --- | --- |
| `docs/implementation/STATUS.md` | 唯一状态板；区分 P0-J/P0-04/P0-06/P1-001/LT | 有效 |
| `docs/architecture/LONG_TASK_AND_CONTEXT_COMPACTION.md` | 长任务架构、四态、压缩、决议 | 有效（设计） |
| `docs/implementation/LONG-TASK-CONTEXT-TASK-BOOK.md` | 35 项 LT 任务 | 有效（设计） |
| `docs/spec/LONG_TASK_CONTEXT_CONTRACTS.md` | ContextOwner、预算、检查点、事件 | 部分需 G2 修订 |
| `docs/architecture/CONTEXT_CHECKPOINT_STORAGE.md` | 独立文件 + Journal 指针 | 部分需 G3 修订 |
| `docs/adr/0010-context-checkpoint-storage.md` | Proposed | 需按 G3 复审 |
| `docs/spec/DEBATE_RUNBOOK.md` | 历史入口与动态轮次说明 | 已标注 |
| `docs/implementation/UNIFIED-TASK-RUNTIME.md` | 重启恢复口径修正 | 有效（历史记录） |
| `docs/implementation/COMPLETION-AUDIT.md` | 历史完成度 | 已标历史 |

## 4. 剩余问题

### P0

1. `ContextManager.recover` 仍 task-only，与 `ContextOwner` 不一致。
2. `PrepareContextInput` / `FinalizeContextInput` 仍以 taskId 为必需。
3. Conversation 无 `runId/contextId/checkpointId/activeRunId`。
4. 检查点文件 `active` 与 Journal 指针存在双权威风险。
5. 两套事件流（`events`/`runEvents`）的归档协议未统一。
6. `trimEvents()` / `appendRunEvent()` 没有归档保护接口。
7. `persist()` 没有父目录 fsync；没有一次性更新指针 + 事件的 Journal 事务。
8. ADR 0010 未按新协议复审。

### P1

1. 测试脚本未登记；`test:all` 解析规则要求明确。
2. `STATUS.md` 尚未纳入 G0–G6 状态。
3. V3 `TASK-BOOK.md` 与 LT 任务书的共享文件所有权需要正式落表。
4. `PRODUCT/ROADMAP` 的状态口径需持续以 `STATUS.md` 为准。

### P2

1. 历史规格/任务书较多，需继续标注 `HISTORICAL`。
2. Debate Runbook 的旧入口说明需要与产品文档互链。
3. `UNIFIED-TASK-RUNTIME` 的 P4/P5 状态板已修正，但应明确长任务恢复在 LT-P5。

## 5. G0 结论

- 长任务/上下文压缩：**设计完成，未实现**；
- V3 主体：**有代码与测试，状态以 `STATUS.md` 为准**；
- 本轮不需要改运行时代码；
- 必须先完成 G2/G3 契约与存储冻结，再进入 LT-P0；
- G0 通过，可进入 G1。

## 6. 证据

- 基线提交：`6f871e2`
- `git diff` 代码为空
- `src/main/store.ts` 行号：配额/裁剪/persist
- `src/shared/conversation.ts`：Conversation 字段
- `src/main/task-manager.ts`：reconcileInterrupted
- `scripts/run-test-suite.mjs`：test:all 解析
- 文档索引与 STATUS
