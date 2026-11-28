# V4 P1 M3-2 验收汇总：反空转拦得住、说得清，但「停下等人」之后用户接不回去

- 日期：2026-11-28
- 基线：main `f6ea915`（M3-1 合并点）之上的任务分支 `v4/p1-m3-2-no-progress-cause`
- 环境：默认数据目录 `~/Library/Application Support/thinkfusion-ai`，`electron-vite dev`
  + CDP 9333，**同一进程**（AGENTS.md §10.2，未使用 `THINKFUSION_USER_DATA` / `--user-data-dir`）
- 脚本：`desktop-agent-macos/scripts/verify-v4-p1-m3-2-cdp.mjs`
- 明细：[EVIDENCE.md](EVIDENCE.md)（18 项判定，17 通过 / 1 未通过 `b-resume-fired`）+ 截图
  `01-idle-decision-goal-card.png` + `evidence.json` + 三条判定原文
  （`decision-baseline.json` / `decision-idle.json` / `decision-stop.json`）+ 事件流原文
  （`events.after-idle.json`、`events.after-stop.json`，均为 A 段静默期后的同一份 267 条）
- 备份：`agent-store.before.json`（真机前的整份用户 store，**不入库**：`.gitignore:51` 排除，只留本机回滚）
- 用时：14:55:54 起跑 → 15:54:04 结束（58 分钟，其中第 1 具探针被模型通道打断、重建后跑完）
- 离线闸门：`npm run verify`（typecheck + 回归脚本）退出 0；本任务相关的
  `npm run test:cycle-decision` 28 项、`npm run test:repair-loop` 11 项全过

## 前提修正：任务书 M3-2 的三条口径按代码与现网实况改（全文见任务书「M3 开工前的现状审计」）

1. **「构造 3 轮同证据」在真机上拿不到。** 探针每轮都在换工具（第 1 轮 6 次 `fs.writeFile` +
   `shell.run` 退出码 3；第 2 轮 `session.search`/`fs.tree`/`fs.search`/`fs.find`/`git status`
   退出码 128；第 3 轮 `fs.tree`/`fs.search`×3/`fs.find`×2），所以 `progress.repeated` 三轮都是
   **0**，空转是靠第二个维度 `criterionStalled`（未满足的标准集合连续不变）触发的。「同证据 3 轮」
   这条留在离线用例 `check-cycle-decision.mjs` 里按默认阈值 2/2 覆盖。真机这轮反而更硬：模型**换了
   手段却没推进任何一条标准**，这正是只按「重复调用」判空转会漏掉的那一类。
2. **阈值下调到 1/1 只为省时间，不为改结论。** 默认 2/2 要跑到第 4 轮才停下，上一版实测 70 分钟以上
   且一次通道抖动就得整段重来；A 段写 `repeatLimit:1, criteriaLimit:1` 后三条判定即可跑完
   （15:17 → 15:25 → 15:31）。触发轮数不由真机证明，由离线用例证明。
3. **「关得掉」只证到一半。** 配置侧证到了（阈值能写进 `no-progress.json`、产品按它算，跑完恢复原状）；
   用户侧没证到——因为任务被 `WAIT_USER` 停下之后，界面上根本没有把任务重新跑起来的入口。
   这是本轮唯一的未通过项，且是产品缺口，见下文。

## 交付内容

1. **上一轮报告取对了**（`src/main/orchestrator.ts` 抽出 `previousReport(report)`）：原来错在拿
   store 里「最后两份」当相邻两轮——续跑、补报或 `plan.invalid` 吃掉一轮之后，最后两份并不相邻，
   `criteriaStreak` 就会跳错，第二次空转可能被算成第一次从而少停一轮。现在按判定点当时的事件序
   回溯上一条判定所依据的那份报告。
2. **空转原因分类与文案单源**（`src/shared/cycle-decision.ts` +227 行）：四类病因 +
   `CYCLE_NO_PROGRESS_CAUSE_TEXT` 中文说法，判定理由点名
   「连续无进展（原因分类：X，这是连续第 N 轮）」；`noProgressCause` 进
   `cycle.decision.created` 事件（`src/shared/contracts.ts`），没有分类也要写 `null` 不能省键。
3. **无进展只有两个落点，且自动重规划只给一次机会**：`REPAIR`/`CONTINUE`/`COMPLETE` 在空转时全部禁止
   （明知没前进还继续执行）；`streak≥2` 必须 `WAIT_USER`；分类是 `missing_permission` 时不给
   重规划机会直接停手。反过来第一次就停下等人也判失败（缺权限除外）——防止把「自动重试」调成 0 轮。
4. **判定不只是换个标签**（`buildReportPrompt({ noProgress })`）：判为空转的那一轮，下一轮的
   **计划请求原文**里必须出现「系统判定：」那段原话与「这些命令已经带着同样的退出码跑过一遍」的
   `#<退出码>` 清单；真机第 2 条判定后的那一轮请求 6176 字节里含该段。判为非空转的那一段则不得出现
   （第 1 条判定后的 9164 字节请求里没有）。
5. **阈值配置化**：`resolveNoProgressLimits({env, config})`，优先级 `THINKFUSION_NO_PROGRESS_LIMITS`
   > `userData/no-progress.json` > 默认 `2/2`，脏值（`0`/负数/小数/非数字）一律回退默认并被记下来；
   宿主注入的是 `noProgressLimits: () => resolveNoProgressLimits(...)`（`src/main/index.ts:6255`），
   由守卫用例 `check-cycle-decision.mjs:497` 断言必须是**函数**形式而不是启动时算好的值。
6. **轮次用途按判定给措辞**：原来写死「进入下一轮修复」，`REPLAN` 的轮也这么说，日志与判定自相矛盾；
   现在按判定标签映射 `roundPurpose`，并额外带一句空转说明。

## 真机结论（探针任务已删除，判定原文见 `decision-*.json`）

| 判据 | 结果 |
| --- | --- |
| 第 1 条判定不误伤正常波动 | 15:17:03 `REPAIR → open_next_round`，`criteriaStreak 0`、`criterionStalled false`、无分类 |
| 空转出现且落点合法 | 15:25:51 `REPLAN → open_next_round`，分类 `missing_context`，理由点名「连续无进展（原因分类：缺上下文，这是连续第 1 轮）」 |
| 连续第二次改口等人 | 15:31:34 `WAIT_USER → stop_and_wait`，`noProgressStreak 2`，之后**没有**新 `round.started` |
| progress 反算逐字段一致 | 三条全过（阈值 1/1、指纹、`criterionKey`、streak 全部与事件相同），反算用的就是产品自己的 `detectNoProgress`/`cycleFingerprint` |
| 落点与行为对得上 | 两条 `open_next_round` 各自后面都出现新轮；`stop_and_wait` 后无新轮，日志「GDC 停在待确认：」后面与事件 `reason` 逐字相同 |
| 任务没被判死 | 停在 `report_pending`（不是 `failed`），界面给出「继续修复（重新执行验证）」/「接受未验证并结束」 |
| 界面与事件同源 | 「工程目标」卡「最近一次周期判定：WAIT_USER · 停下等你决定｜…」472 字符与最新事件逐字对齐，投影句同文 |
| 现场不留副作用 | 工作区在 `/tmp`；`no-progress.json` 跑完已删（原本就没有），不会把用户的反空转静默留在 99/99 |

事件流也印证了「白烧轮」：5 次 `round.started` 只出 3 份报告，`plan.invalid` 出现 2 次，所以
`budget.roundUsed` 是 1 → 3 → 5 跳着走。

## 未通过的一条：**它不是用例写错，是产品少了个入口**

`b-resume-fired`：B 段把阈值热切成 `99/99` 后，从「继续修复」入口把停下的任务接回去，主进程直接拒绝——
「这一轮已经完成全部检查，不需要继续修复」。根因在第 3 轮的报告形态：`verified:yes` 而
`check:compile` / `check:run` / `check:tests` 三项全 `skipped`（模型那轮没写文件，理由写的是
「本轮没有写操作，无需验证」），`resumeRepair()` 的前置门禁要求「验证尚未完成」，于是判定说
「停下等你决定」，而**等来的这个入口恰恰不接受「再来一轮」**：界面上只剩「接受未验证并结束」（等于放弃目标）
与取消。

- 影响：M3-2 的回退开关在用户侧走不通——阈值调大之后，任务不会因为阈值变宽而重新自转，因为它已经停在
  一个没有出口的 `report_pending` 上。
- 归属：**M3-4（持续循环的用户介入出口）**。`stop_and_wait` 之后需要一条「换手段再来一轮」的用户动作，
  它必须绕开「本轮已验证完」的门禁（要改的是计划与手段，不是补一次验证），并且要留下事件与界面痕迹。
- 脚本据此改为：接回去被拒就当场记 `b-hot-threshold-pending-m3-4` 并跳过 B 段，不再干等满窗口。
  这条快败逻辑是 run 5 跑完之后才加的，所以 `evidence.json` 里留下的是
  `等待超时：B 段新增判定 出现第 4 条周期判定`，而不是该标记。

## 同样跑完之后才加、因此本轮产物**证不到**的一条

`a-threshold-applies-without-restart`（阈值不重启就生效）。我最初把它写成「进程启动时没有配置文件，
运行中写入 1/1，后续判定事件里就是 1/1」——但 run 5 的脚本是在 `startDev` **之前**写的
`no-progress.json`，那样只能证明文件读得到，证不了「不用重启」。已把写入时机挪到「渲染进程连上之后」，
并新增 `rendererReadyAt` / `configWrittenAt` 两个时间戳由断言比较，下一轮运行才会真正跑出这条。
本轮对「判定当下现读配置」只有两类证据：宿主注入的是箭头函数（结构性）+ 阈值优先级/脏值 4 条离线用例，
**不认领现场热生效**。

## 现网把整轮吃掉的两个东西（都不是判定逻辑，但要如实记下）

1. 第 1 具探针 `7af5a428` 在第 2 轮收到「模型连续 120 秒没有输出，已停止。」→ `task.failed`（终态，
   恢复门禁不认），只拿到 2 条判定；重建的第 2 具 `5c8edc7b` 才跑完三条。两次尝试的状态、任务错误原文、
   轮数都留在 `evidence.phases[0].attempts`，没有用「重试到成功」把这条脆弱路径抹掉。
2. `plan.invalid`：模型给步骤多写 `mapsTo` / `expect` / `checksCategory`，计划 zod strict 校验整份拒绝，
   靠 `repairPlan` 自纠（最多 2 次）。这是 M3-1 就记下的同一个问题，仍未修——它会直接决定无人值守任务
   的轮数成本，M3-3（预算）与 M3-4（持续循环）都会被它放大。

## 收尾时补做的两件事

- 探针任务 `5c8edc7b-5421-4636-9753-90340639782f` 因 B 段抛错没走到 `cleanupProbe`，留在默认数据目录里
  （`report_pending`）。已另起一次短生命周期 dev 实例走产品自己的 `cancelTask` + `deleteTask` 删除，
  核对结果：store 里任务 0 条、`context-checkpoints/owners/agent-task` 目录为空。同时把脚本的汇总行改成
  由删除回执算出「N/M 具已删除，另有 …… 没有删除回执」，不再写死「收尾已删除」。
- `no-progress.json` 确认不存在（`configRestoredAfterError.exists === false`），用户的反空转没有被留在
  测试阈值上。

## 遗留（不在 M3-2 范围内，已挂后续项）

- **M3-3 预算**：`advance()` 在预算见底时仍给 `fail_budget` → 任务落 `failed`；超限暂停
  （`budget_exhausted`）与用户批准继续是 M3-3 的行为，`TaskBudget` 纯函数与红用例
  （`scripts/check-task-budget.mjs`）已就位。
- **M3-4 持续循环**：`stop_and_wait` 之后的用户介入入口（本轮未通过项）、任务级 `autoContinue`
  （默认关）、以及「瞬时通道故障不该把任务判死」都要在这里收口。
- **默认阈值下的触发轮数、同证据空转**：由离线用例覆盖，真机这一条要等 M3 的 ≥2 小时无人值守任务
  顺手跑到（P1 闸门）。
