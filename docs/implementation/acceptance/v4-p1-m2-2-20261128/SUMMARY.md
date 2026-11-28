# V4 P1 M2-2 验收汇总：暂停→强退→重启后能续跑，续不了会点名原因

- 日期：2026-11-28
- 基线：main `5e72934`（M2-1 合并点）之上的任务分支 `v4/p1-m2-2-checkpoint-resume`
- 环境：默认数据目录 `~/Library/Application Support/thinkfusion-ai`，`electron-vite dev`
  + CDP 9333，暂停后 **SIGKILL** 强退再重启（AGENTS.md §10.2，未使用
  `THINKFUSION_USER_DATA` / `--user-data-dir`）
- 脚本：`desktop-agent-macos/scripts/verify-v4-p1-m2-2-cdp.mjs`
- 明细：[EVIDENCE.md](EVIDENCE.md)（43 项判定，0 项未通过）+ 七张截图 + `evidence.json`
  + `agent-store.before.json` / `context-checkpoints.before.tgz`（真机前的整份用户 journal 与
  检查点目录备份，**不入库**：里面是用户真实任务原文与证据路径，已在 `.gitignore` 里排除，只留本机回滚）

## 前提修正：验收判据本身在真机上是假的

任务书 M2-2 写「复用 `verify-p0-5-restart-cdp.mjs` 场景」，实现前核对代码发现三条前提需要修正
（详见 [任务书 · 实现后的口径修正](../../plans/active/V4-P1-TASK-BOOK.md)）：门槛不是字面的
`needsReconciliation==0`、没有新增 `interrupted → executing` 转移边、探针改成自写的固定工作流。

比这些更要紧的是：**这一轮修掉的四个缺陷里，有两个是「判据一直无效」而不是「功能没做」。**

- P0-5 那份探针走模型规划，步骤 id 与步数每轮都不同，命中不了「暂停时还剩 N 步」这个前提，
  M2-2 要的是确定性的两条路 → 另写 `verify-v4-p1-m2-2-cdp.mjs`，用 `workflow:run` 固定 14 步
  （节点 id 即步骤 id），暂停点定在 `write-4`。
- 真机首跑暴露的 schema 缺口（`reusedFrom` 被 `.strict()` 判非法）单测全绿也摸不到：测试自己造的
  假报告不经 IPC。这一条是「必须真机跑一遍」的直接理由。
- 探针自身的四条判据缺陷（段名带 `.json` 比对、跨两次取数比对象引用、`node --test .` 在这台
  node v26 上回「Could not find '.'」、界面判据找错页签）都记在任务书里，修完才是真判据：
  在此之前「续跑后第一个事件是不是 planning」这条最关键的判定实际取的是整份事件流。

## 交付内容

1. **判定函数与理由**（`src/main/context/recovery/continuation.ts`，新文件）：
   `collectCompletedSteps()` 只认「同一轮的 started+completed」，同名步骤不跨轮误认；
   `decideContinuation()` 逐条给理由（缺指针 / 检查点文件不在 / 摘要 hash 不符 /
   `ledger.missing>0` / 有结局未知且无路径可核对的在途写 / 步骤已全部跑完），
   结论只有 `continue`（带 `planId/roundId/reusedStepIds/pendingStepIds`）与 `replan` 两种；
   `mergeReusedResults()` 把复用步骤还原成上一轮的真实结果——没有证据的条目保留 `skipped`，
   不把缺口判成已完成。
2. **Runtime 支持跳过已跑完的步骤**：`skipStepIds` 下发 + `step.reused` 事件（带 `checkpointId`
   与真实执行时间戳），续跑不是「重放一遍」。
3. **resume 走续跑分支**（`orchestrator.ts`）：判定为 continue 时复用既有
   `paused/interrupted → executing` 边直达执行、不建新一轮；恢复结论写进
   `context.resume.continued` / `context.resume.replanned` 事件（带 `pointerSource` 与理由）。
   灰度口径落在注入点 `AgentOrchestratorDeps.resumeContinue`（`orchestrator.ts:247`，
   判定处 `?.() ?? true`），返回 false 即回到「继续一律重规划」，不用回滚续跑分支。
4. **暂停后迟到的执行报告不再把 `paused` 带去 `cancelled`**：报告照常落库（已完成步骤的证据不丢），
   状态保持暂停，之后仍能从检查点续跑。
5. **回收（关闭缺口 9/10）**（`src/main/context/checkpoint/gc.ts`，新文件）：
   `deleteTaskContextArtifacts()` 删任务时按 owner 回收检查点文件与归档段；
   `reclaimOrphanContextArtifacts()` 启动时只回收「任务表里查不到」的段，口径按归属文件比对、
   不按时间猜，且只扫 `agent-task`（会话归档不在范围内）；目标回收只认「最后一条绑定任务被删」。
6. **界面可核对**：标签与配色收进 `shared/context.ts` 的 `contextEventView()` 一处、两处投影共用；
   时间线新增暂停检查点里程碑（没落盘时如实写「未提交」并标成提醒色）、续跑/重规划各有说法，
   被复用的步骤标「复用自上次执行」；顺手修 `target('fs.search')` 丢掉检索词。

## 真机场景

| 步骤 | 实测 |
| --- | --- |
| 探针 A：固定工作流 14 步，跑到 `write-4` 点暂停 | 状态序列 `created → planning → plan_ready → awaiting_approval → executing → pause_requested → pausing → paused`；暂停事件带 `contextId/checkpointId/activeRunId`，磁盘 `context-checkpoints/owners/agent-task/36ea5531-….json` 落盘且 `checkpointId` 与任务字段一致 |
| 暂停账本读磁盘不抄事件 | `cp_33b18923…`：`applied 6 / missing 0 / needs_reconciliation 0`（无未知缺口，续跑门槛该放行） |
| 暂停落地 4s 后再看状态 | 仍是 `paused`（收尾报告迟到也没被带去 `cancelled`） |
| SIGKILL 强退 → 重启 | 任务 `paused`、`resumeStatus=executing`、`checkpointId` 不变；**活任务的 owner 文件穿过启动扫描被保留**（`owners/agent-task/36ea5531-….json` 仍在，任务表 1 条） |
| 点「继续」 | `context.resume.continued`，`pointerSource=task-fields`，用的正是暂停那份 `cp_33b18923…`；恢复打点在事件流下标 104（共 184 条） |
| 恢复后第一个执行事件 | `step.reused:seed-test`，打点之后 `round.started` **0 条**（没重开规划轮）；复用 `seed-test, write-1…write-5`，本轮执行 `write-6…write-12, final-gate` |
| 续跑是否真把剩余步骤跑完 | 12 个写步骤文件都在；收尾 `shell.run` 的 `step.completed` 退出码 0（断言由探针自带的 `probe.test.mjs` 在真机进程里做，不是脚本站在外面数） |
| 落库报告还原复用结果 | 报告 `e279497c…`（计划 `79289ed1…`，`completed`）14 步全 `completed`，其中 6 步标 `reusedFrom`；任务 `verifying → report_pending → completed` |
| 探针 B 反例：暂停时留一条起了但无路径可核对的 `shell.run` | 检查点 `cp_b0bd619c…`：`applied 1 / missing 0 / needs_reconciliation 1` → `context.resume.replanned`，理由点名「1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）」，开新轮 `5d531c0e…`、任务 `planning` |
| 界面对两条路的呈现 | 「输出」页时间线里「暂停已提交检查点 cp_…（待核对 N 项）」「已从检查点续跑：沿用已批准计划，未重新规划」「已重新规划：检查点不足以安全续跑」都是可点开详情的行（详情 JSON 点名 `long-shell（needs_reconciliation）`），报告明细标「复用自上次执行」6 次；「对话」页同样有这两条 `chat-note`。截图 05/06/07，且截图前把命中行滚进视口（时间线一屏装不下 184 条事件） |
| 删除探针任务时的回收 | A/B 均 `checkpointsRemoved=true`（owner 文件删掉）、`archiveSegments=0`，目标 `goal:36ea5531…` / `goal:9487adcf…` 不再存在 |
| 本轮之外有无误删 | `disk-has-no-orphan-after-run` 通过：探针之外没有无人认领的归属文件；任务数 `0 → 0` |

## 自动化测试

- `test:task-resume` 6 条 → **16 条**（+10）：续跑正例（直达执行、不建新一轮、复用清单下发 Runtime）、
  续跑负例（在途 `shell.run` 无路径可核对 → 仍走重规划且不开 Runtime）、暂停报告迟到的
  `skipped` 不算缺口 / 带 `reusedFrom` 的照旧算、回退开关关闭恒定重规划、
  `decideContinuation()` 理由逐条列全与 `none`/`missing` 不放行、步骤结局认定、收尾还原。
- `test:pause-checkpoint` 7 条 → **14 条**（+7）：真检查点续跑/拦下续跑两条、暂停后报告才到仍续得上、
  删除任务按 owner 回收、目标回收只认「最后一条绑定任务被删」、启动扫描回收孤儿且不动活任务与会话、
  无残留时不报数也不误删。
- `test:execution-timeline` 5 条 → **8 条**（+3）、`test:task-conversation` 68 条 → **70 条**（+2）、
  `test:protocol` 新增 1 条（续跑报告带 `reusedFrom` 必须过 schema，同条保留「未知键仍要拒」）。
- `test:protocol`（177 条）与 `test:execution-timeline` 已并入 `npm run verify`（53 步 → 55 步）——
  前者此前不在闸门里，schema 那类「真机才炸」的回归下次能拦住。
- `npm run verify` 全绿：55 步、exit 0，日志 `/tmp/m2-2-verify-final.log`。

## 刻意不做

- **不把续跑开关接到环境变量/设置项。** 灰度口径先落在注入点，真要在界面上关还得再加一层
  设置面与文案；本轮只保证「改一行注入即可回退」，记为后续项。
- **不回收会话（conversation）归档。** 回收只扫 `agent-task`；会话上下文的生命周期归会话，
  按任务表比对会把还活着的会话归档删掉。
- 不做「暂停后跨设备/换工作区续跑」——检查点里的证据路径是本机绝对路径。

## 实测残留

- `/tmp` 下留 10 个探针工作区 `tf-m2-2-ws-*`（每轮一个，只写探针自己的 `d1/f*.txt` 与
  `probe.test.mjs`，未碰用户目录）。
- 默认数据目录现存 `context-checkpoints/owners/conversation/b614fc2e-….json` 1 段（9.0K）——
  会话归档，按上面的口径不在回收范围内；`owners/agent-task/` 为 0 段。
- 任务表 `tasks 0`、`goals 0`：M1 记录的 6 条孤儿目标与 M2-1 记录的 22 个孤立 owner 文件
  已在本功能的启动扫描下清干净（本轮基线快照即为 0/0，故未擅自删任何用户数据）。
- `settings.json` 与执行档配置未改动；本轮真机未派发网页源（§9.1 无涉及）。

## 判定

M2-2 的验收条件（「SIGKILL 重启后 resume 能从最近检查点续跑」+「不可核对时明确重规划」+
「UI 可核对上下文状态」+ 顺带关闭缺口 9/10）四项都拿到真机证据：续跑路径有 `context.resume.continued`
（沿用被中断那份计划、复用 6 步、剩余 8 步真跑完、报告带 `reusedFrom`），反例有
`context.resume.replanned`（理由点名那条无路径可核对的写），两条都在界面时间线/对话流里可见，
回收在删任务与启动扫描两处都有正/反样本 → **`LIVE_TESTED`**（43 项判定 0 未通过，`error` 为空）。
未覆盖项见 EVIDENCE.md：`pointerSource=events-replay` 的续跑（M2-1 已验重建路径，本轮两条都是
`task-fields`）与跨重启的 `budget_exhausted` 续跑，留给 M2-3/M3。
