# V4 P1 M2-1 验收汇总：检查点指针只有一个写者，恢复路径可观测

- 日期：2026-11-28
- 基线：main `5dc9ed7`（M1 合并点）之上的任务分支 `v4/p1-m2-1-checkpoint-pointers`
- 环境：默认数据目录 `~/Library/Application Support/thinkfusion-ai`，`electron-vite dev`
  + CDP 9333（AGENTS.md §10.2，未使用 `THINKFUSION_USER_DATA` / `--user-data-dir`）
- 脚本：`desktop-agent-macos/scripts/verify-v4-p1-m2-1-cdp.mjs`
- 明细：[EVIDENCE.md](EVIDENCE.md)（19 项判定，0 项未通过）+ 三张截图 + `evidence.json`
  + `agent-store.before-strip.json`（抹指针前的整份 store 备份，**不入库**：里面是用户真实
    journal 原文，已在 `.gitignore` 里排除，只留本机用于回滚）

## 前提修正：任务书要写的东西已经写过了

任务书 M2-1 的原始目标是「`commitPauseCheckpoint` 成功后 patch 任务
`{checkpointId, contextId, activeRunId}`」。实现前核对代码发现这条前提已过期：

- `store.commitContextCheckpoint()`（`src/main/store.ts:441`）在一次持久化里写完
  任务上的 `contextId/checkpointId/activeRunId` 三个字段，这才是 Journal 指针的权威；
  `index.ts:6491` 注入的 `journal: store` 让暂停检查点走的就是这条事务。
- `task-recovery.ts` 也早已优先读任务字段。

真正的问题是反过来的：`orchestrator.ts:1013` 在 Journal 事务**之后**又
`tasks.patch(taskId, { checkpointId, contextId })` 一遍。那是第二个写者，而且它漏了
`activeRunId`——把权威指针盖成半套，恢复时 `recoverContext()` 的
`pointer.activeRunId !== runId` 门判不过，出现「检查点文件明明在，任务却读不出上下文」。
所以本任务改判为：**去掉重复写者 + 补齐重建路径 + 把路径打点暴露出来**。

## 交付内容

1. **只有一个写者。** 删掉 `orchestrator.ts` 暂停后的重复 `tasks.patch`；
   `commitPauseCheckpoint()` 改为返回完整指针 `PauseCheckpointOutcome`
   （`contextId/checkpointId/activeRunId`）。
2. **暂停事件带完整指针。** `context.checkpoint.paused` 新增 `contextId/activeRunId`，
   与 `checkpointId` 成对出现，使任务字段缺失时事件流本身就能重建指针。
3. **恢复按两档取指针。** 新增 `resolveTaskPointer()`：任务字段齐全 → `task-fields`；
   字段不全 → 倒扫事件流取最后一条带完整指针的检查点事件（暂停事件或
   `context.compaction.committed`）→ `events-replay`。重建出的指针继续走同一套
   runId / 摘要 hash / 归档校验，读不出就 `stale`，不会因为「重建出来了」就放行。
   两者都拿不到 → `none`，不凭空造指针。
4. **路径可观测。** 恢复结论带 `pointerSource`，并写进 `context.recovered` /
   `context.refresh.required` / `context.compaction.stale` 三类事件；
   `recoveryPromptData()` 在走重放时如实告诉模型「这次指针来自事件流重建，
   目标版本与任务树 revision 按当前任务记录重新核对」。

## 真机场景

| 步骤 | 实测 |
| --- | --- |
| 固定工作流：`fs.writeFile` → `shell.run sleep 10`，执行中点暂停 | 状态序列 `created → planning → plan_ready → awaiting_approval → executing → pause_requested → pausing → paused`；暂停后在途 shell 没写出迟到文件 |
| 任务指针 vs 检查点文件 | `contextId/checkpointId/activeRunId` 三项齐全，界面读到的与 `agent-store.json` 落盘一致，且 `contextId`、`activeRunId` 与 `owners/agent-task/<taskId>.json` 里的 `contextId`、`runId` 逐项相等 |
| 暂停事件 | `context.checkpoint.paused` 带全三项指针，与任务字段完全相同 |
| 检查点内容真实性 | 摘要约束「目标版本 v1 / 任务树 revision 3 / 暂停原因：pause / 工具执行状态：已完成 0 步；副作用核对 applied 1 / missing 0 / needs_reconciliation 1」，证据里带上真实写出的文件路径 |
| SIGTERM 停进程 → 抹掉探针任务的三个指针字段 → 重启 | 重启后任务仍是 `paused`，指针为空（模拟半套落库） |
| 点「继续」 | `context.recovered` 落库：`pointerSource=events-replay`，重建出的 `checkpointId` 正是暂停那份检查点，副作用账本 `applied 2 / missing 0 / needsReconciliation 1`；拿到打点后立即取消并删除探针 |

## 自动化测试

- 新增 `test:checkpoint-pointer`（`scripts/check-checkpoint-pointer.mjs`，4 条）：
  字段↔文件一致、暂停事件带指针、两条恢复路径各自的 `pointerSource`。
- `test:pause-checkpoint` 扩到 7 条：新增「半套指针按事件流重建」与「既无字段也无事件
  → 判 none」。这一轮同时修了测试自身的口径——harness 过去只把事件收进数组、不落 Journal，
  所以「靠事件流重建」这条路径在本能通过的代码上永远测不到；现在 `emit` 与主进程同口径
  （转发即 `store.appendEvent`）。
- `test:context-recovery` 扩到 9 条：新增重建指针仍要过校验（指向不存在的检查点 →
  `stale`）、无事件可重放 → `none`、`pointerSource` 写进提示词。
- `npm run verify` 全绿（typecheck + build:agent + 全部套件；51 份 `node:test` 报告
  失败数均为 0）。

## 刻意不做

启动时全量扫一遍「任务字段 vs 检查点文件」对账。指针读不出时恢复本来就会在校验处
停下并点名原因，加一道启动扫描只是把同一个判断提前，还要为它付全量磁盘读的代价。

## 实测残留

- 探针任务已删（删除前后任务数都是 0），但 `context-checkpoints/owners/agent-task/`
  下现在有 **22 个孤立 owner 文件**（含本轮 `41d81e2d-…`），当前 store 里 `tasks` 为 0——
  即全部孤立。计数从 M1 记录的 11 涨到 22，因为 M1 之后又跑了若干轮真机。
  回收能力（检查点删除 API + 「最后一条绑定任务被删才回收」口径）已写进 M2-2 任务口径。
- `store.goals` 仍是 M1 收尾记录的那 6 条孤立目标，未擅自删用户数据。
- 探针产生的临时文件 `tf-m2-1-written-*.txt` 留在 `/tmp`（`tf-m2-1-late-*.txt` 未出现，
  正是「暂停后不得有迟到写入」的证据）。
- `settings.json` 与执行档配置未改动；本轮真机未派发网页源。

## 判定

M2-1 的验收条件（「暂停后 store 里任务字段与检查点文件一致；重启恢复走的路径打点可见」）
两条都拿到真机证据，自动化覆盖两条恢复路径与一致性断言 → **`LIVE_TESTED`**。
未覆盖项见 EVIDENCE.md，其中「事件落库但检查点文件没落」的窗口留给 M2-2 一起处理。
