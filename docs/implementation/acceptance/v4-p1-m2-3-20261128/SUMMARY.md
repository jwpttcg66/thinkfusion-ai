# V4 P1 M2-3 验收汇总：暂停/恢复留下的上下文台账，任务详情页里看得见、可核对

- 日期：2026-11-28
- 基线：main `b39a587`（M2-2 合并点）之上的任务分支 `v4/p1-m2-3-context-visibility`
- 环境：默认数据目录 `~/Library/Application Support/thinkfusion-ai`，`electron-vite dev`
  + CDP 9333，**同一进程内**暂停→继续（AGENTS.md §10.2，未使用 `THINKFUSION_USER_DATA` /
  `--user-data-dir`；跨重启的续跑链路已在 M2-2 取过证据，本轮要验的是「界面会不会说」）
- 脚本：`desktop-agent-macos/scripts/verify-v4-p1-m2-3-cdp.mjs`
- 明细：[EVIDENCE.md](EVIDENCE.md)（47 项判定，0 项未通过）+ 五张截图 + `evidence.json`
  + `agent-store.before.json` / `context-checkpoints.before.tgz`（真机前的整份用户 journal 与
  检查点目录备份，**不入库**：里面是用户真实任务原文与证据路径，已在 `.gitignore` 里排除，只留本机回滚）

## 前提修正：任务书的两处口径按代码现状改

任务书 M2-3 写「投影扩展落在 `src/shared/task-view.ts`」＋「测试＝投影测试 + 组件测试」，
实现前核对代码后改成（详见 [任务书 · 实现后的口径修正](../../plans/active/V4-P1-TASK-BOOK.md)）：
投影另建 `src/shared/context-state.ts`（`TaskView` 是逐事件增量折叠，这一栏要的是整份历史的全貌），
「组件测试」按本仓库惯例落成**源码守卫 + 真机按格读数**（渲染层没有 DOM 测试设施）。

更要紧的是：**这一轮真机跑出来三个问题，都不是「功能没做」，而是「界面在骗人」。**

1. 折叠段的摘要行渲染成「上下文 上下文 pause:…」——标题重复一次，且 `pause:<taskId>:<时间戳>`
   这种长串把「最近检查点 / 核对」两句挤没。现在摘要只说三件事（几条事件、最近检查点、核对到什么程度），
   contextId 留在展开后的「当前上下文」栏。
2. 探针首轮在界面上只拿到 8 个字符：卡片自己发 `getTaskContext`，读数取到了「读取中…」的壳子。
   这是**探针的缺陷**，不是产品的——如果照这一轮的结果去判「投影有、界面空」，就会把功能判死。
   现在判据等到加载态消失才取数，并把 `loading` / `errorText` 一并记进证据。
3. 「重规划」那一行的行头写着「复用 0 步 · 本轮执行 0 步」——两个清单都空是「整轮作废」的意思，
   照这句话读会以为这一轮白跑。改成「不复用上一轮步骤」。

## 交付内容

1. **只读投影**（`src/shared/context-state.ts`，新文件 306 行）：`projectContextState(events)` 把既有
   `context.*` 事件折成 `ContextStateView`——`contextId`（取时间最新一条**非空**值，并记下是哪条事件给的）、
   `checkpoints[]`（暂停/取消/压缩三类来源分开，没有 `checkpointId` 的不算存档）、`rebuilds[]`（按时间升序、
   同刻按 `sequence` 保序，`kind` 覆盖 recovered / refresh-required / resume-continue / resume-replan /
   compaction-stale / checkpoint-missing）、`lastReconciliation`、`budget`、`entries[]`（§8 的详情检查入口，
   每条留原文 payload）。措辞一律取自 M2-2 收敛出的 `contextEventView()`，不再另写一份文案。
   **取不到的字段是 `null` 不是 0**：「没有记录」与「记录了 0 项」是两件事，后者会让人以为核对过。
2. **只读 IPC `task:context`**（`src/main/index.ts:3630`）：`trustedUiSender(event)` +
   `TaskIdSchema.parse(taskId)`，把 `store.listEvents(id)` 交给投影；不碰 orchestrator、不写事件、不落盘、
   不读检查点文件。取数口径与 M1-1 的 `task:executions` 一致——读 store 而不是界面那份按配额裁剪过的事件流，
   否则早先的暂停存档会被裁没，「这一栏说没有检查点」就成了假话。链路六处同步：
   `contracts.ts` 的 `AgentApi.getTaskContext`、`preload/index.ts`、`mock-api.ts`、`global.d.ts`（`agentAPI: AgentApi`
   已覆盖，无需改）、`docs/IPC.md`。
3. **界面折叠段**（`src/renderer/src/components/engineering/TaskContextCard.tsx`，新文件 250 行 + `style.css` 38 行）：
   挂在「统计」页 `ExecutionHistory` 之后，`<details>` 收起时那行摘要给三件事；展开后 10 格台账
   （当前上下文 / 来源事件 / 最近检查点 / 存档时间 / 副作用核对 / 核对来源 / 上次重建 / 重建原因 / 续跑判定 / 预算水位）、
   「重建经过」逐行（指针来源标签、原因、检查点、副作用账本、`resume.reasons` 清单、可展开的步骤清单）、
   「逐条原文」每条可展开看事件 payload 的 JSON。空态直说「这个任务没有记录到上下文事件」，
   并在只有待核对数时补一句口径说明「不拿 0 代替没核对」。
4. **测试**（`scripts/check-context-state.mjs`，新文件 18 条 = 13 投影 + 5 源码守卫）：守卫分别守住
   投影是纯函数（不发事件、不落盘、不读检查点文件，且不引用事件契约之外的 `context.*` 名字）、
   `task:context` 处理器只读且做了信任检查与 schema 校验、契约/preload/mock/文档四处口径一致、
   折叠段挂载且目标状态要求的字段都有出口、界面缺失写「未记录」不许用 0 冒充。
   `test:context-state` 已并入 `npm run verify`（55 步 → **56 步**）。

## 真机场景

| 步骤 | 实测 |
| --- | --- |
| 探针 A：固定工作流 8 步写入，跑到 `write-4` 点暂停 | 暂停事件 `cp_8af45f5d…` 的 `checkpointId/contextId/activeRunId` 与投影、与磁盘 `owners/agent-task/275e5b15-….json` 三方逐项相等；磁盘账本 `applied 6 / missing 0 / needs_reconciliation 0` |
| 暂停后界面（截图 01） | 10 格齐：「最近检查点 cp_8af45f5d…（暂停存档）」「存档时间 11:28:17」；副作用核对「存在 未记录 · 已消失 未记录 · 待核对 0」+ 口径说明；「上次重建」= 未重建、「重建原因」= 未记录、续跑判定 =「没有点过「继续」」——暂停没做的事界面不替它编 |
| 只读性 | 同一任务连读两次 `getTaskContext` 投影完全一致（`ipc-task-context-is-read-only`）：不写盘、不推进状态、不补数据 |
| 点「继续」 | `context.recovered` 带 `pointerSource=task-fields`、`reason=从 Journal 活动指针恢复`、账本 `applied 7 / missing 0 / needsReconciliation 0`；判定 `context.resume.continued`，沿用计划 `3bb24e9c…`、复用 `write-1…write-6`、本轮执行 `write-7、write-8` |
| 恢复后界面（截图 02/03） | 副作用核对「存在 7 · 已消失 0 · 待核对 0」、核对来源「恢复时核对 @ 11:28:21」、「上次重建 / 续跑判定」都是「已从检查点续跑：沿用已批准计划，未重新规划 @ 11:28:21」、重建原因正是事件那句带 planId 的原文；重建经过两行都带「指针来自任务字段」，续跑行给出「复用 6 步 · 本轮执行 2 步」并可展开步骤清单（`复用 write-1、…`／`本轮 write-7、write-8`／`计划 3bb24e9c · 轮次 bbe89182`） |
| 逐条原文 | 3 条：`context.checkpoint.paused`、`context.event:context.recovered`、`context.event:context.resume.continued`；展开的 JSON 里能看到 `sideEffects`（§8 的详情检查入口，不是一句话结论） |
| 探针 B 反例：整轮没暂停过 | 投影 `hasEvents=false`；界面摘要「上下文 没有记录到上下文事件」、空态文案命中、10 格不出现、「最近检查点」一格为空——并且原文里不出现探针 A 的 `cp_8af45f5d…`（不串任务）（截图 04） |
| 探针 C 第二条路：暂停时留一条起了但无路径可核对的 `shell.run` | 恢复账本 `applied 2 / missing 0 / needs_reconciliation 1` → `context.resume.replanned`，理由「1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）」；界面上「上次重建 / 续跑判定」都是「已重新规划：检查点不足以安全续跑 @ 11:29:32」，行配色类名 `t-warn`，行头尾部「不复用上一轮步骤」，重建原因与理由清单都点名 `long-shell`，副作用核对是「存在 2 · 已消失 0 · 待核对 1」（缺口是数字不是 0），「最近检查点」仍留着被拒的那份 `cp_0637ddb5…`（截图 05） |
| 删除三个探针任务 | A/B/C 均 `checkpointsRemoved=true`（owner 文件删掉）、`archiveSegments=0`；`owners/agent-task/` 回到 0 段、无无人认领的归属文件；任务数 `1 → 0`（开头 1 条是上一轮中断留下的探针，脚本起手已删） |

## 自动化测试

- 新增 `test:context-state` 18 条（投影 13 + 守卫 5），并入 `npm run verify` → **56 步 exit 0**
  （日志 `/tmp/m23-verify-after-ui.log`，含界面文案改动后复跑）。
- 投影负样本各自守住一处「不许编」：无事件（判「没有记录」而非「已核对 0 项」）、暂停未落盘（进不了检查点清单但
  必须看得见「未提交」+原因 + `checkpoint-missing`）、压缩存档（算一次存档但不产账本，`needsReconciliation` 留 null）、
  `context.prepared` 空串 contextId（视作未提供，不算换了一份上下文）、预算水位（只取真带 usage 的那条，缺的字段留 null）、
  事件乱序（按时间升序折、同刻按 sequence 保序）、多次暂停（留多行、摘要取最近一份）。
- 本轮改的界面文案（摘要句、「不复用上一轮步骤」）都有断言钉住：`contextStateSummary(...).startsWith('上下文') === false`
  与卡片源码守卫，改回去就红。

## 刻意不做

- **卡片不读检查点文件、也不读任务上的指针字段。** 一栏里出现两个真相源，就再也说不清「界面显示的那份」
  与「恢复链路实际用的那份」是不是同一个；两者不一致由恢复打点的 `pointerSource` 点名（M2-1 已埋），
  卡片把它原样摆在每行标签上。磁盘内容要核对，走「逐条原文」里事件自己带的 payload。
- **不与「统计」页 TaskStats 那排计数合并。** 它给次数（压缩 N 次 / 恢复 N 次，且只覆盖界面收到的事件），
  这一段给台账（哪份检查点、核对结果、走哪条指针、为什么重规划），底部写明「依据 N 条持久化的 context 事件」。
- 不做跨设备/换工作区的上下文核对（证据路径是本机绝对路径，同 M2-2 口径）。

## 实测残留

- `/var/folders/…/T` 下留 6 个探针工作区 `tf-m2-3-ws-*`（每轮一个，探针只写自己的 `d1/f*.txt`、`d2/f*.txt`、
  `c1.txt/c3.txt/late-from-paused-shell.txt`），未碰用户目录；上一阶段 M2-2 的 10 个 `tf-m2-2-ws-*` 仍在。
- 两个探针（A 续跑完剩余步骤、C 判成重规划开新轮）在收尾时状态都是 `failed`，`cancelTask` 因此报
  「非法状态转换：failed → cancelled」（`dev.log:42/46`，脚本已忽略该回包，回收由 `deleteTask` 完成）。
  **本轮判定不覆盖任务结局**，也未采到 `failed` 的原因事件；现象与 M2-2 探针（带 `final-gate` 写入证据、
  跑到 `completed`）的差别指向「验证门判不过 → 重规划 → 重规划这一轮需要模型规划源」这条链，
  列为 M3-1/M3-2（决策函数收敛、验证收敛）要处理的输入，不在 M2-3 内扩大改动。
- `goalReclaimed=false`：`runWorkflow` 的文本 `goal` 只产生 `goalId=goal:<taskId>` 这个分组键，
  没有对应的 StoredGoal 实体，因此「最后一条绑定任务被删」这条回收判据不成立——不是漏删，是本来没有实体可回收。
- 默认数据目录收尾：任务 `0`、目标 `0`、`owners/agent-task/` `0` 段；`settings.json` 与执行档配置未改动；
  本轮真机未派发网页源（§9.1 无涉及）。

## 判定

M2-3 的验收条件（「暂停→恢复一次后，『上下文』段显示核对结果与重建原因」+「截图存证」+ 数据全部来自既有事件投影、
新 IPC 只读）四项都拿到真机证据：暂停与恢复两个时点，界面上的每个数字都能追到同一条 `context.*` 事件与磁盘上那份
检查点（三方一致），恢复后的核对结果「存在 7 · 已消失 0 · 待核对 0」与重建原因（带 planId 的原句）都摆在栏里；
不可核对时改判「已重新规划」并点名 `long-shell（needs_reconciliation）`，提醒色、理由清单、被拒的那份检查点 id 都在；
没暂停过的任务该栏直说「没有记录到上下文事件」，不拿 0 冒充核对、不串别的任务。→ **`LIVE_TESTED`**
（47 项判定 0 未通过，`error` 为空）。

未覆盖项见 EVIDENCE.md：`pointerSource=events-replay` 下这张卡的读数（M2-1/M2-2 已在事件与续跑链路上验过重建，
本轮三个样本都是 `task-fields`）、跨重启后这张卡的读数（卡片取数即 `store.listEvents`，本轮 `ipc-task-context-is-read-only`
只证明同进程内稳定）、`budget` 水位与 `context.refresh.required` 的真机样本（探针走固定工作流、未触发 ECO 过期与预算告警）。
M2 里程碑的三条完成条件至此都有真机证据：M2-1/M2-2/M2-3 三任务 `LIVE_TESTED`、「暂停→强退→重启→续跑」与
「→明确重规划」两条路径（M2-2）成立、「UI 可核对上下文状态」（M2-2 时间线/对话流 + M2-3 上下文台账）。
