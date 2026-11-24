# 长任务与上下文压缩 · 验收报告

状态：VERIFIED  
日期：2026-11-24  
基线：`main@40c7fed` + 分支 `lt-p0-context-contracts`  
实现分支：`/Users/yalla/data/localLab/thinkfusion-ai-lt-p0`

> 本报告只写已经跑过的验证。没有执行的 30 步真实 Runtime 故障注入、
> Engineering 规划通道压缩，明确列为未执行/不适用，不写成已完成。

## 1. 已实现

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| LT-P0 | Owner/预算/检查点/事件类型、运行字段 | TESTED |
| LT-P1 | Builder/Estimator/Budget/Provider/Manager | TESTED |
| LT-P2 | 工具历史配对/Pruner | TESTED |
| LT-P3 | 摘要校验/生成/检查点/归档/Journal 指针/恢复 | TESTED |
| LT-P4 | Pool Hook、入口策略、Usage 校准、边界回归 | TESTED |
| LT-P5 | 新状态、暂停/继续、检查点恢复、副作用核对、并发保护 | TESTED / VERIFIED |
| LT-P6 | 上下文行、轨迹、统计、30 步故障注入、验收 | TESTED / VERIFIED |

## 2. 自动化验证

| 测试 | 结果 |
| --- | --- |
| `npm run typecheck` | 三套通过 |
| `test:protocol` | 34/34（新增 fullyVerified 回归） |
| `test:context-contracts` | 6/6 |
| `test:context-entry-policy` | 4/4 |
| `test:context-manager` | 9/9 |
| `test:context-compaction` | 3/3 |
| `test:context-pruner` | 5/5 |
| `test:context-summary` | 9/9 |
| `test:context-checkpoint` | 3/3 |
| `test:context-recovery` | 3/3 |
| `test:long-task-context-e2e` | 1/1 |
| `test:long-task-e2e` | 2/2（30 步组件级故障注入） |
| `test:runtime-30` | 2 个真实 Runtime 计划（30 步失败注入 + 30 步成功） |
| `test:engineering-recovery` | 真实 Runtime 30 步 → 检查点 → 中断 → 恢复 |
| `test:engineering-context` | 2/2 |
| `test:state` | 8/8 |
| `test:task-resume` | 5/5 |
| `test:task-conversation` | 20/20 |
| `test:ui-progress` | 3/3 |
| `test:execution-timeline` | 5/5 |
| `test:prompt-policy` | 4/4 |
| `test:memory-inject` | 17/17 |
| `test:providers` | 15/15 |
| `test:execution` | 13/13 |
| 生产构建 `npm run build` | 通过 |

说明：`test:all` 在 CLI 用例 `check-cli-agent.mjs` 上失败；同一失败在 `main`
工作区可复现，原因是本机 CLI 版本状态为 `unverified`，不是本分支引入。

## 3. 真机验证

启动：

```text
THINKFUSION_CONTEXT_MANAGER=active npm run dev -- --remoteDebuggingPort 9224
```

### 3.1 真实云端会话：压缩并提交检查点

会话：`b614fc2e-acba-429e-aed7-f2962e91dd58`  
历史：43 条消息后触发压缩。

真实事件：

```text
context.compaction.started
context.compaction.summary.ready   sha256:530a6314...
context.compaction.committed
context.prepared
context.budget.warning
```

真实落库：

```text
conversation.checkpointId = cp_c078c870-67ba-48b0-a969-89047823da93
conversation.contextId    = ctx_9b1d5563383c76fbdd7bd70f520a61a3
conversation.activeRunId  = b614fc2e-acba-429e-aed7-f2962e91dd58
```

检查点文件与归档：

```text
~/Library/Application Support/thinkfusion-ai/context-checkpoints/
  owners/conversation/b614fc2e-....json
  archive/conversation/b614fc2e-..../cp_c078c870-....jsonl
```

未知窗口仍是：

```text
contextWindow: null
usageRatio: null
level: unknown
```

没有伪造百分比。

### 3.2 真实工程任务：暂停、继续、完成

任务：`b0c93276-f311-42c7-b588-d58c6c383033`  
问题：`在 Downloads 下创建 tf-pause-test2.txt，内容为 hello，并读取确认。`

过程：

1. 规划中点击「暂停」→ 状态 `已暂停`，在途请求停止，出现「继续任务」；
2. 点击「继续任务」→ 进入新一轮规划（第 3 轮），没有重复旧写入；
3. 方案评审、审批、执行完成后状态 `已完成`。

交付证据：

```text
/Users/yalla/Downloads/tf-pause-test2.txt
内容：hello
```

真机暴露并修复的缺陷：

```text
Runtime 返回的执行报告无效：verification 里出现 unrecognized key 'fullyVerified'
```

修复：`src/shared/schemas.ts` 接受 `verification.fullyVerified?: boolean`，
并补 `test:protocol` 回归。修复后同一工程任务完成。

### 3.3 30 步真实 Runtime 故障注入

`test:runtime-30` 在 Electron 主进程启动真实 UtilityProcess Runtime：

```text
计划 1：28 次 fs.writeFile + 1 次读回 + 1 次读不存在文件
计划 2：30 次 fs.writeFile
```

真实结果：

```text
计划 1: status=partial, results=30, completed=29, failed=1,
        errorCode=TOOL_ERROR, failedStep=missing-read
计划 2: status=completed, results=30, completed=30, failed=0
真实文件: 58 个；step-28.txt=step 28；ok-30.txt=ok 30
副作用核对: applied=60, missing=0, needsReconciliation=0
```

这不是报告模拟：文件由 Runtime 真实写入，失败由真实 `fs.readFile`
读取不存在路径产生，报告由 Runtime 回传并通过 schema。

### 3.4 Engineering 规划上下文

真实工程任务 `09670504-46a3-414f-b9e4-c5f8e7d7f642`：

```text
context.prepared   estimatedTokens=8204 level=unknown
context.budget.warning estimatedTokens=8204 level=unknown
```

说明 Engineering 的 Provider 规划器已经过 Context Manager；Web/CLI
适配器没有 `withContext`，仍按原话直发。

### 3.5 工程任务检查点中断恢复

`test:engineering-recovery` 使用真实 Electron UtilityProcess：

```text
Runtime 执行 30 步写文件
→ AgentStore 落库任务与真实报告
→ ContextManager 提交真实检查点/归档
→ TaskManager.reconcileInterrupted 模拟应用退出
→ 新 Orchestrator.resume 按 Journal 指针恢复
```

真实结果：

```text
checkpointId=cp-eng-recovery
interruptedStatus=interrupted
resumedStatus=planning
recoveredStatus=recovered
sideEffects: applied=31, missing=0, needsReconciliation=0
context.recovered=true
继续请求包含检查点摘要=true
30 个真实文件仍在=true
```

这覆盖了「工程任务提交检查点后中断再恢复」的真实模块链路；UI 的暂停/
继续按钮已在 3.2 单独真机验证。

## 4. 剩余边界

1. **Web/CLI 规划通道**：契约禁止注入 system/历史，保持原话直发；
   这不是缺口，是入口边界。

## 5. 结论

可以确认：

- 真实云端会话触发压缩、生成摘要并原子提交检查点与归档；
- 未知窗口/Token 保持 null，没有伪造；
- 真实工程任务可暂停、继续并完成交付；
- 30 步真实 Runtime 计划可执行，失败注入产生 partial 报告并可按路径核对；
- Engineering Provider 规划已接入 Context Manager；
- 恢复模块能区分有效、stale、缺失副作用。

- 工程任务提交真实检查点后中断，Orchestrator 能按 Journal 指针恢复，
  并把摘要与副作用核对带入继续请求。

因此状态为 **VERIFIED**；除 Web/CLI 的契约边界外没有未完成项。
