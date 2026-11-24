# 长任务与上下文压缩 · 验收报告

状态：VERIFIED（带明确说明）  
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
| `test:long-task-e2e` | 2/2（30 步 + 故障注入） |
| `test:state` | 8/8 |
| `test:task-resume` | 3/3 |
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

## 4. 明确未执行 / 不适用

1. **30 步真实 Runtime 故障注入**：当前 30 步 E2E 使用真实 AgentStore、
   检查点文件、归档与恢复模块，但执行步骤来自落库报告，不启动 Runtime。
   真实工程任务已单独跑通一次 2 步任务；没有跑 30 步真实 Runtime 任务。
2. **Engineering 规划通道压缩**：工程规划直接把机器可读计划请求交给
   Web/Provider 适配器；Web/CLI 契约禁止注入 system/历史，因此这条通道
   保持原话直发。Context Manager 覆盖 Conversation、Debate/Reviewer 与
   ExecutionPool 中的模型请求。
3. **检查点恢复真机场景**：恢复模块有单元/集成测试（有效指针、stale、
   副作用缺失）；真机验证的是对话压缩与工程暂停/继续，没有制造一次
   工程任务检查点后中断再恢复。

## 5. 结论

可以确认：

- 真实云端会话触发压缩、生成摘要并原子提交检查点与归档；
- 未知窗口/Token 保持 null，没有伪造；
- 真实工程任务可暂停、继续并完成交付；
- 恢复模块能区分有效、stale、缺失副作用；
- 30 步故障注入在组件/集成层通过。

不能确认：

- 30 步真实 Runtime 任务可恢复；
- 工程规划通道使用 Context Manager 压缩。

因此状态为 **VERIFIED（带上述说明）**，不把未执行项写成已完成。
