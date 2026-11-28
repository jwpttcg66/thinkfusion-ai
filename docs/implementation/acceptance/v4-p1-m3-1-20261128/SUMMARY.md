# V4 P1 M3-1 验收汇总：周期判定只剩一个出口，事件里说的和实际做的同源

- 日期：2026-11-28
- 基线：main `add2be9`（M2-3 合并点）之上的任务分支 `v4/p1-m3-1-cycle-decision`
- 环境：默认数据目录 `~/Library/Application Support/thinkfusion-ai`，`electron-vite dev`
  + CDP 9333，**同一进程内**连跑两轮（AGENTS.md §10.2，未使用 `THINKFUSION_USER_DATA` /
  `--user-data-dir`）
- 脚本：`desktop-agent-macos/scripts/verify-v4-p1-m3-1-cdp.mjs`
- 明细：[EVIDENCE.md](EVIDENCE.md)（21 项判定，0 项未通过）+ 截图
  `01-goal-card-cycle-decision.png` + `evidence.json` + 两轮判定原文
  （`decision-1.json` / `decision-2.json`）+ 事件流原文与 diff（`events.after-decision-*.json`、
  `event-stream.diff`）+ 投影读数（`projection-digest.json`）
- 备份：`agent-store.before.json`（真机前的整份用户 store，**不入库**：里面是用户真实任务原文
  与证据路径，已在 `.gitignore:51` 排除，只留本机回滚）
- 离线闸门：`npm run verify`（typecheck + 59 项回归脚本）退出 0，其中新增的
  `npm run test:cycle-decision` 21 项全过

## 前提修正：任务书 M3-1 的口径按代码现状改（全文见任务书「M3 开工前的现状审计」）

1. **「双轨」其实有三条轨。** 现网链是 `decideNextEngineeringAction`
   （`goal-driven-cycle.ts:152`，四出口，**决定行为**）→ orchestrator 里一段三元映射翻译成
   11 值枚举 → `emitCycleDecision`（只是个事件发射器，`decisionType` 由调用点硬编码）。
   `decideCycleAction` 确实零生产调用。
2. **直接接上 `decideCycleAction` 会把任务锁死。** 它的输入里 `diagnosis` 与 `progress`
   在生产中**从来没有来源**——没有任何代码产出诊断，`CycleProgress` 只出现在测试里。缺这两项，
   所有轮次都会落到 `WAIT_USER`（「目标符合度不足或未知」）。所以 M3-1 的真实工作量是先补输入的
   来源（M3-1a），再收敛出口（M3-1b），顺序不能颠倒。
3. **合并点选择**：`goalStatus` 门槛不会误伤——`goalContractFromPlan` 建契约写的是 `ACTIVE`，
   不在 `USER_GATE` 名单里，只有目标修订流程会推到 `CHANGE_PROPOSED`，那时返回 `CHANGE_PROPOSED`
   与 P0-2 已有的 replan 门禁同向。

## 交付内容

1. **纯函数给出可执行落点**（`src/shared/cycle-decision.ts`）：`CycleDecisionResult` 除标签外新增
   `nextAction: finish_completed | open_next_round | stop_and_wait | fail_budget | fail_delivery | abort`，
   `requiresUser` 由 `nextAction === 'stop_and_wait'` 推导而不是由标签推导——同样是 `BLOCKED`，
   版本链冲突是停下等人、预算耗尽是把任务判死，按标签判必然错一边。新增标签 `FAIL_DELIVERY`
   （交付不成立，不再借用 `failed` 冒充「做完了但没验」）。判定顺序写在函数头注释里，
   每条都是「不这样就会错下去」。
2. **补齐两个从未存在的输入**（`src/main/orchestrator.ts:3404-3426`）：`deriveCycleDiagnosis(facts)`
   用已算好的结构化事实（GCE 未覆盖标准数、验证三查状态、报告状态、失败步骤数、错误码、评审问题数）
   翻译成七值病因，不看模型自述；`detectNoProgress` 的上一份进展从**事件流**里读
   （`lastCycleProgress()`），所以进程重启不会把「同一件事已重复三轮」忘掉，与 M2-2 的续跑路径一致。
   事实来源与修复闸门合流：`evidenceFacts()` + `cycleFingerprint()` + `openCriteriaKey()`，
   不另造第二套空转判定。
3. **决策事件带全字段**（`src/shared/contracts.ts:2209-2231`）：`cycle.decision.created` 从裸枚举
   扩成 `reason / evidenceRefs / nextAction / requiresUser / targetStage / diagnosis / progress /
   goalFit / budget`。`goalFit` 没有契约就记 `null`，`budget.roundUsed/roundLimit` 拿不到记 `null`，
   不用 0 冒充；`progress` 把生效阈值一起存，重放时口径不漂。
4. **删除双轨**：`emitCycleDecision()` 与 orchestrator 侧那段「四出口 → 11 值」的手写映射整体删除，
   换成 `decideAndEmit()`（判定与落事件同一处）；紧随其后的 `cycle.snapshot` 的 `decision` 必须等于
   `legacyDecisionOf(decisionType)`、非收尾时 `nextAction` 逐字等于事件 `reason`——两处判定分叉会被
   `test:cycle-decision` 的源码守卫直接判失败。
5. **判定句说法单源**（`CYCLE_NEXT_ACTION_TEXT` + `goal-driven-cycle.ts` 的
   `latestCycleDecision()` / `cycleDecisionText()`）：任务侧「工程目标」卡
   （`GoalContractCard.tsx`）与对话侧结果面板（`CollaborationResultPanel.tsx`）渲染同一句话，
   两边都不再各自抄一份映射；`latestCycleDecision` 只认带 `nextAction` 的循环判定，
   评审处置类决定（没有落点字段）不会被当成「系统打算做什么」。守卫用例断言两个组件里
   都不得再出现 `finish_completed:` 字面量。

## 真机结论（探针任务已删除，两轮判定原文见 `decision-*.json`）

| 判据 | 结果 |
| --- | --- |
| 两轮判定都带全字段 | 第 1 轮 `REPAIR → open_next_round`、第 2 轮 `COMPLETE → finish_completed`，字段缺失 0 项 |
| 证据可追 | `file:` 两条在磁盘上存在、`cmd:` 两条退出码与报告一致（0 与 3）、`evidence:` 逐段对上真实任务/轮次/标准 |
| progress 反算一致 | 用事件里的上一份 + 本轮报告指纹 + 未满足标准集合重算，逐字段相同（`repeated 0 / criteriaStreak 0 / repeatLimit 2 / criterionStalled false`） |
| 落点与行为对得上 | `open_next_round` 之后出现新 `round.started`；`finish_completed` 之后出现 `task.completed` |
| 事件流 diff 存证 | 两轮之间新增 95 行、移除 1 行，落在 `event-stream.diff`（4.8K） |
| 界面看得到判定落点 | 「最近一次周期判定：COMPLETE · 按完成收尾｜执行、验证和目标标准均已满足」，与最新事件逐字对齐；下一步行引用判定 reason 原文 |

## 本轮真机跑出来的两个问题，都是**验收脚本自己错**，不是产品

如实记下，因为它们差点把功能判死：

1. 原断言要求每条 `evidence:` 引用都带本轮 `roundId`。第 2 轮判定引用了第 1 轮的 `execution`
   证据——目标证据本来就按轮累计，这条口径是错的。改成逐段核对真实性（任务、轮次、标准都必须
   在事件流里真实存在），并新增 `d2-cites-own-round-evidence` 要求判定至少引用一条本轮证据，
   防止「只复述上一轮结论」蒙过去。
2. 原断言写死「第二条判定挂在上一条判定之后紧跟的那一轮、且事件流正好两轮」。实况是第 2 轮
   计划未通过校验（`plan.invalid`）没产生执行报告，判定落在第 3 轮。改成核对「判定轮属于新开的
   轮次 + 该轮真的出过报告 + `budget.roundUsed` 与事件流轮数一致（3=3）」，并把「有一轮只开了轮
   没出报告」写进存证文字。

## 遗留（不在 M3-1 范围内，已挂后续项）

- **`plan.invalid` 白烧一轮**：两次运行都在第 2 轮复现——模型给步骤多写了 `dependsOn` /
  `expect` / `checksCategory`，计划 zod 严格模式直接判非法，整轮消耗掉却没有报告。要么按
  「可修复字段」宽容处理并回一条纠正提示，要么在计划提示里明确禁止这些键。属于计划校验
  与提示词的口径问题，与决策收敛无关。
- **M3-2 尚未做**：`isNoProgress()` 命中时现在仍可能返回 `REDESIGN` / `REANALYZE`
  （`cycle-decision.ts:253-256`），与任务书「无进展只能是 `WAIT_USER` 或 `REPLAN`」不符；
  空转原因分类（重复调用 / 缺上下文 / 缺权限 / 需换工具）与阈值配置化都在 M3-2。
- **M3-3 尚未做**：`advance()` 在预算见底时给 `fail_budget` → 任务落 `failed`，
  超限暂停（`budget_exhausted`）与用户批准继续是 M3-3 的行为。
