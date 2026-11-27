# V4 P1 M1　Goal / Task / Execution 统一真机验收汇总

本目录只汇总已经真实跑过的证据，不把未跑的场景写成通过。

- 基线：`v4/p1-engineering-runtime` 分支的 M1-1（执行历史投影）、M1-2（目标聚合视图）、M1-3（目标变更影响面确认）三次实现提交。
- 启动方式：ThinkFusion Dev（`electron-vite dev --noSandbox --remoteDebuggingPort 9333`）+ CDP，先 `npm run build:agent` 再起跑。
- 数据目录：默认 `~/Library/Application Support/thinkfusion-ai`；未提供 `THINKFUSION_USER_DATA`，未复制用户数据。
- 数据隔离：脚本只按探针标题 `V4M1执行历史探针` 清理旧探针，验收后取消并删除本轮探针；用户任务数前后一致（2 → 2）。收尾另按用户批准清掉了上一里程碑遗留的 2 个 P0-4 探针，见「收尾清理」。
- 验收脚本：`desktop-agent-macos/scripts/verify-v4-p1-m1-cdp.mjs`
- 证据：[EVIDENCE.md](EVIDENCE.md) / [evidence.json](evidence.json)（本目录记录的是最后一次复跑，探针 `0a429d96`；首轮真机探针 `6a8b9375` 的结论在正文里单独标注，两次都真实跑过）

## 场景①　M1-1 执行历史：同一 Task 下多条执行各自可见

- 探针：固定工作流单节点 `shell.run`（`echo v4m1-round1-begins; exit 3`），`danger-full-access`，工作区 `/tmp`。
- 任务 ID：`6a8b9375-9220-4f18-aeee-0842b027908a`（验收后删除，用户任务数 2 → 2）。
- 实测结论：
  - 同一个 Task 投影出 4 条执行，`roundId` 去重后 4 条，第 1 条仍是 `round 1 / outcome=failed`——后续轮次没有覆盖前一轮的事实。
  - 第 1 轮确定性失败被如实记录：`steps={total:1, failed:1}`、失败原因 `COMMAND_FAILED: 命令退出码 3`、证据 1 条、`sources={round:true, report:true, events:12}`。
  - 第 2、3 轮没有执行报告，投影写成 `outcome=null` + `steps.unknown=true`，界面显示「未收口」而不是 0 次失败；第 4 轮 `plan_repair` 拿到 `partial`（5 步 4 完成 1 失败、2 条失败原因）。
  - 输入类型如实区分 `user_prompt / execution_report / plan_repair`；4 条执行共用同一个 `runId`，即这是同一次连续执行的续跑，不是四次独立运行。
  - 界面（统计页）与投影同时刻一致：卡片头「执行历史 4 次执行 · 1 次失败」，`.exec-item` 4 条 = 投影 4 条；无报告轮显示「这一轮没有执行报告，交付未记录」。截图 [01-execution-history.png](01-execution-history.png)。
  - 第 2 条及以后的执行由目标驱动闭环自己续出来，`loopActions` 为空——脚本没有调用 `resumeRepair`、没有放行审批、没有代替用户回答澄清。
- 顺带观察到的运行时问题（不属 M1 范围，未改）：第 2 轮 `execution_report` 与第 3 轮 `plan_repair` 都以 `plan_invalid` 收口、零步骤，闭环连着烧掉两轮才在第 4 轮拿到报告。台账如实显示为「未收口」，所以不是投影的错，但自动续轮的规划质量值得单独查一次。
- 复跑（M1-3 影响面分账改动后的回归，探针 `0a429d96`）：同一个 Task 投影出 2 条执行，`roundId` 去重 2 条，第 1 条仍是 `round 1 / outcome=failed`（`COMMAND_FAILED: 命令退出码 3`），第 2 条 `round 2 / completed`（5 步全完成、证据 5 条）；两条都带报告，所以本轮没再出现「未收口」那种轮次。统计页卡片头「执行历史 2 次执行 · 1 次失败」，`.exec-item` 2 条＝同时刻重读投影 2 条；`loopActions` 仍为空，第 2 条依旧是闭环自己续的。第 2 条成员列表里保留了一条「未记录成员」，投影没有把缺字段抹平成 0 或省略。
- 未覆盖：跨 `runId` 的两次独立运行（同一 Task 被再次启动）未在本探针里出现；两轮真机各自都只有一个 `runId`，所以只验到一次连续执行内的多轮台账。

## 场景②　M1-2 目标聚合视图：分组渲染与退回开关

- 实测结论：
  - 侧栏出现 3 个目标分组，「◈」开关 `aria-pressed=true`；关掉后 `.goal-group` 归零、`.task-item` 仍列 3 条，退回平铺可用。截图 [02-sidebar-goal-grouping.png](02-sidebar-goal-grouping.png)。
  - 未绑定目标的任务落进「未绑定目标」桶并排在最后。
- **未达成项（如实记录）**：`live-two-tasks-one-goal` 失败。现网数据里没有任何两条任务共用一个 `goalId`——代码里没有把新任务绑到既有 `goalId` 的写入路径（`task-manager.create` 一律写 `goal:<taskId>`）。M1 完成条件里的「同一 Goal 下 ≥2 Task」在当前版本无法由界面产生，本场景只验到分组渲染与退回开关。要补的是目标绑定入口（新建任务时选既有目标，或把已有任务并入目标），这是一次产品决定，不在 M1-2 的只读投影范围内。

## 场景③　M1-3 目标变更影响面确认

- 实测结论：
  - 基线口径以契约 Criterion 为准：契约里 1 条标准，追加 1 条判为 `clarify`、`requiresUserConfirmation=false`、版本仍为 v1——补充不会被误判成变更。
  - 把标准删到 1 条（即删除既有标准）判为 `change`、`requiresUserConfirmation=true`、`nextVersion=v2`，且确认前任务 `goalVersion` 保持 v1，没有偷抬版本。
  - 首轮真机（探针 `6a8b9375`）：`goal.revision.pending` 事件落库并带原文——`reason=目标变更影响 7 个未完成任务；已完成且不受影响的成果可继承`、`impactedTaskIds` 7 条、`inheritedCount=5`、`nextVersion=2`；确认卡显示「目标变更待确认 v1 → v2 · 确认前不抬版本、不改任务」＋标准 1 条/受影响 7 条。当时暴露一个呈现缺陷：7 条里 `wt-work-*` 与 `wt-group-*` 两个任务级汇总节点（同名「执行计划」）和真实步骤并列，读起来像重复项。事件没说谎（这些节点确实未收口），但确认卡不该把它们混进步骤清单。
  - 修法（只动呈现层）：shared 新增纯函数 `partitionImpactedTasks()`，按 id 前缀把 `wt-work-*`/`wt-group-*` 归「任务级节点」，其余（含 L2 子任务 `wt-task-*`，那是有名字的真实工作）归「可执行步骤」；确认卡逐条列步骤，节点折成一行「另有 N 条任务级节点（任务本体 / 执行计划组）· 状态，随下属步骤一起重规划」，顶部加一行分账「受影响 X 条：可执行步骤 Y 条，任务级节点 Z 条」，其中 X 取事件原文 `impactedTaskIds.length`，不是折叠后的步骤数。`goal.revision.pending` 的字段与写入路径完全没改。
  - 复跑真机（探针 `0a429d96`）：删标准判 `change`，事件 `impactedTaskIds=["wt-work-0a429d96","wt-group-0a429d96"]`、`inheritedCount=6`、`nextVersion=2`；确认卡分账行「受影响 2 条： 可执行步骤 0 条，任务级节点 2 条。」与事件数字一致，节点折叠行为「另有 2 条任务级节点（任务本体 / 执行计划组） · 就绪，随下属步骤一起重规划」，步骤列表为空且不再出现同名「执行计划」行；点「确认变更」后 `goalVersion` 抬到 v2，刷新后卡片不再出现。「暂不变更」不写库，卡片留在原地。截图 [03-goal-revision-pending.png](03-goal-revision-pending.png)、[04-goal-revision-confirmed.png](04-goal-revision-confirmed.png)（截图取的是对话页，确认卡在工作台下方未入镜，卡片文案以 `evidence.json` 的 `confirmCard` 原文为准）。
- 新暴露的观察（不属 M1-3，未改）：本轮 6 个步骤全部终态、被判为可继承，但 `wt-work-*`/`wt-group-*` 的状态仍是 `ready`——汇总节点没有从下属收敛，所以「计划已全部做完」的任务重规划时仍会把两个节点列进受影响清单（这正是复跑里步骤 0 条、节点 2 条的由来）。属状态收敛问题，应单独排。

## 过程中修掉的脚本口径错误（不是产品缺陷）

第一次跑（探针任务 `866fd72b`，本机日志保留）出现 3 项假失败，均已定位到脚本自己的假设错误后复跑通过：

1. 等「第 1 轮收口」时按 `report_pending / awaiting_next_round / failed / blocked` 轮询状态，而运行时在报告落库后直接自动开下一轮，任务停在 `planning / awaiting_answer`，于是判成超时并误调 `resumeRepair`。现改为等「≥2 条带报告的执行」，只在循环真停住时才补最小一步动作并记录在 `loopActions`。
2. 页签按 `button[role="tab"]` 全文案匹配，点中的是会话页那一排「统计」而不是工作台那一排，导致「界面 0 条 / 投影 2 条」。现限定在 `.wb-tabs` 内，并等卡片渲染出行再比对同时刻的投影。
3. 执行历史卡按 `textContent.includes('执行历史')` 找 `.card`，命中了别的卡片。现按卡片自己的 `<h2>` 精确匹配。

另外，第一次跑抛错时清理逻辑被跳过，探针任务 `19f60921` 留在默认数据目录；现已把清理放进 `finally`，本轮起跑时先按探针标题清掉了它，收尾任务数 2 → 2。

## 收尾清理（按用户批准执行）

- 默认数据目录里原本留着上一里程碑的 2 个 P0-4 暂停检查点探针（`ef852583`、`9b4f2d6f`，均 `paused`），它们就是 M1 起跑时用户的全部任务，也是侧栏分组数被算成 3 的原因。
- 用应用自己的 `cancelTask` → `deleteTask` 删除，两条都已消失，用户任务数 2 → 0。一次性脚本放在 `/tmp/tf-cleanup-p04-probes.mjs`，不进仓库。
- 顺带实测到一处残留（只报告，没擅自删）：任务删除后 `context-checkpoints/owners/agent-task/<taskId>.json` 全部仍在，owner 目录 11 个文件对应 0 条任务。代码侧对得上——`store.deleteTask()` 只清 tasks/rounds/plans/reports/events，checkpoint store 没有删除接口。已记入 STATUS「当前已知缺口」第 9 条。

## 汇总判定

- M1-1、M1-3：真机场景已按任务书跑通，可记 `LIVE_TESTED`。M1-3 的受影响清单已按「可执行步骤 / 任务级节点」分账并复跑验证，`test:goal-revision` 从 8 条增至 11 条。
- M1-2：分组渲染与退回开关已真机验证，但「同一 Goal 下 ≥2 Task」没有写入路径可产生，该子条件未验证。
- 因此 **M1 里程碑的完成条件（三任务全部 `LIVE_TESTED` + 同一 Goal 下 ≥2 Task + 同一 Task 下 ≥2 Execution）尚未全部满足**，缺口只剩目标绑定写入路径这一项，等用户决定是否补。
- 单测、`typecheck` 与本文件记录的真机验收均通过；按仓库约定只本地提交，不 push。
