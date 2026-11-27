# P0-5　当前基线真机恢复验收汇总

本目录只汇总已经真实跑过的证据，不把未跑的场景写成通过。

- 基线：`main@af7b312` + 分支 `p0-version-recovery` 的 P0-1～P0-4 提交，以及本目录记录的工作流规划成员修复。
- 启动方式：各验收脚本均为 ThinkFusion Dev（`electron-vite dev --noSandbox --remoteDebuggingPort 9333`）+ CDP。
- 数据目录：默认 `~/Library/Application Support/thinkfusion-ai`；未提供 `THINKFUSION_USER_DATA`，未复制用户数据。
- 数据隔离：每个脚本只按自己的探针标题清理旧探针，验收后删除本轮探针；用户任务数前后一致。
- 证据根：`docs/implementation/acceptance/`。

## 场景①　目标修订后中断恢复：旧目标计划不得执行

- 启动配置：默认数据目录 / CDP 9333 / 固定工作流探针 / `danger-full-access` / 工作区 `/tmp`。
- 任务 ID：`11941006-4419-4706-8ecc-7b44daa2bd64`（验收后删除，用户任务数 0 → 0）。
- 证据：
  - [P0-1 版本链取源](../p0-1-version-chain-20261127/EVIDENCE.md)
  - [P0-2 needs_replan 硬门禁](../p0-2-replan-gate-20261127/EVIDENCE.md)
  - 原始事件：[evidence.json](../p0-1-version-chain-20261127/evidence.json)
- 实测结论：目标修订到 v2 但故意不重打在途任务树后恢复，`version.consistency` 带 `sources` 且判出任务树 v1 过期、`requiresReplan=true`、`actedOnReplan=true`；任务进入 `blocked` 并发 `WAIT_USER`，旧未完成子任务被作废；恢复时间点之后没有新的 `round.started`。
- 未覆盖：目标变更发生在模型规划轮进行中的竞态；本次用固定工作流暂停后修订目标来模拟。

## 场景②　规划/执行中暂停：在途 shell 被中断，状态与检查点有据

- 启动配置：默认数据目录 / CDP 9333 / 固定工作流探针 / `danger-full-access` / 工作区 `/tmp`。
- 任务 ID：
  - P0-3：`17cb09d7-08ef-4836-8b75-0ea3f3fabd3a`
  - P0-4：`7842257a-9b5c-4218-bbc8-c240f7767708`
  - 均验收后删除；P0-4 用户任务数 2 → 2。
- 证据：
  - [P0-3 在途 shell 中断](../p0-3-shell-interrupt-20261127/EVIDENCE.md)
  - [P0-4 暂停状态机与检查点](../p0-4-pause-checkpoint-20261127/EVIDENCE.md)
  - 截图：[01-pause-checkpoint.png](../p0-4-pause-checkpoint-20261127/01-pause-checkpoint.png)
- 实测结论：长 `shell.run` 在 628ms 内被进程组中断，执行结果标 `COMMAND_INTERRUPTED`，标记文件未出现；暂停状态序列 `created → planning → plan_ready → awaiting_approval → executing → pause_requested → pausing → paused` 有事件；`context.checkpoint.paused` 带目标版本、任务树 revision、工具执行状态和副作用缺口 `needsReconciliation=1`，检查点文件落盘且截图显示侧栏已选中探针任务。
- 未覆盖：非 shell 写工具在暂停瞬间的逐个磁盘核对；当前通过副作用账本如实标 `needs_reconciliation`，不冒充已核对。

## 场景③　强制退出重启：`interrupted → resume` 核对后继续

- 启动配置：默认数据目录 / CDP 9333 / 固定工作流探针 / `danger-full-access` / 工作区 `/tmp`；shell 执行中 `SIGKILL` 整个 dev 进程组，再重启。
- 任务 ID：`dc75dbf6-fc29-4593-865b-5cbc82711bb5`（验收后删除，用户任务数 2 → 2）。
- 证据：
  - [场景③完整结果](EVIDENCE.md)
  - 原始事件：[evidence.json](evidence.json)
  - 主进程日志：`dev.log` 本机保留（`*.log` 按仓库规则不入库）；「无网页回退」判定已写进 `evidence.json` 的 `no-web-planner-after-resume`
  - 截图：[01-restarted-interrupted.png](01-restarted-interrupted.png)
  - 验收脚本：`desktop-agent-macos/scripts/verify-p0-5-restart-cdp.mjs`
- 实测结论：
  - shell 步骤开始后强退，重启后任务为 `interrupted`，侧栏选中探针任务并截图。
  - `resumeTask` 发 `version.consistency`，`sources` 逐层记录目标、任务树、上下文、贡献与决策取源；`requiresReplan=false`。
  - 恢复后进入 `planning`，没有再出现 `ChatGPT 页面尚未就绪`；执行档选中的云端模型 `opencode-go:deepseek-v4.1-flash` 已写入任务并用于重启后的规划成员重建。
  - 标记文件未出现；探针删除后用户任务列表不变。
- 修复的问题：固定工作流原本不记录规划成员，进程重启后 orchestrator 内存成员表为空，会退回网页 planner；现在创建工作流任务时按当前执行档记录显式勾选/主导/CLI 成员，重启后按它重建 adapter，云端档不再偷偷使用网页。
- 未覆盖：恢复后完整跑到交付。脚本在进入 `planning` 后即取消并删除探针，避免验收任务继续消耗模型与产生副作用；完整交付链由 P0-4 暂停恢复样本及既有工程任务覆盖。

## 汇总判定

P0-5 三个场景均已按任务书要求留下任务 ID、事件序列、输出文件/截图与本文件的未覆盖项。P0-1～P0-4 的单测、`typecheck` 与 P0-5 真机均通过；按照用户约定只本地提交，不 push。
