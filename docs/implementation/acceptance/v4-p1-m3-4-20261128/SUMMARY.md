# V4 P1 M3-4 验收汇总：停得下、说得清、接得回去，两个方向的边界各自有真机现场

- 日期：2026-11-28
- 基线：main `bf03d1f`（M3-3 合并点）之上的任务分支 `v4/p1-m3-4-continuous-loop`
- 环境：默认数据目录 `~/Library/Application Support/thinkfusion-ai`，`electron-vite dev`
  + CDP 9334，**同一进程**（AGENTS.md §10.2，未使用 `THINKFUSION_USER_DATA` / `--user-data-dir`）
- 模型通道：超算网关不可达（`https://api.scnet.cn/api/llm/v1` 连不上，run 8 现场留证
  `fault.cloud-unreachable.json`），按用户指示改用已实测可用的 Qoder CLI v1.1.101 规划；
  网页源保持关闭（`deepseek`/`kimi`/`gemini`/`workbuddy` disabled、`chatgpt` enabled），
  F 段就是拿这条关着的源做样本
- 脚本：`desktop-agent-macos/scripts/verify-v4-p1-m3-4-cdp.mjs`（采信 run 13；run 11/12 因我把两轮
  并发跑在同一 dev 实例上而作废，见「收尾补做」）
- 明细：[EVIDENCE.md](EVIDENCE.md)（51 项判定，**未通过 0 项**，跳过 3 项：
  `b-stops-before-round` / `c-auto-open-after-resume` / `f-source-disabled-landing`）+ 截图
  `01-auto-continue-switch.png` / `02-exit-visible.png` / `03-continue-round.png` /
  `04-fault-interrupted.png` / `05-default-auto-open.png` / `06-awaiting-next-round.png`
  + `evidence.json` + 停摆现场
  `events.after-fault.json`（故障到手后的完整事件流）+ `fault.cloud-unreachable.json`（run 8 超算断链原文）
- 备份：`agent-store.before.json`（真机前的整份用户 store，**不入库**：`.gitignore:51` 排除，只留本机回滚）
- 用时：13:49:39Z 起跑 → 14:05:44Z 收尾，墙钟 965 秒（约 16 分钟；四条探针同一进程，
  其中 E 段等判定边界就占 301 秒）
- 离线闸门：`npm run verify`（三份 tsconfig 全量 typecheck + 回归脚本）退出 0，966 项用例；
  本任务相关的 `npm run test:task-fault` 28 项、`npm run test:task-continue` 22 项全过

## 前提修正：任务书 M3-4 的四条口径按代码与现网实况改（全文见任务书「M3 开工前的现状审计」）

1. **「任务级 `autoContinue`（默认关）」在存量数据上做不到「默认关」。** 这个字段是本次新加的，
   老任务、老存档里根本没有它；把「读不到」当成 `false`，等于给每一个存量任务悄悄改了行为——
   原本会自己开下一轮的，升级后全停在「等待你继续」。所以 `autoContinueOf()` 只认显式
   `false`（`src/shared/task-continue.ts:76`），缺省按自动续轮算；「默认关」只在**新建任务后这颗
   开关在统计页看得见、拨一下就落库并发事件**这个意义上成立，不是缺省值。
2. **要补的出口比任务书说的多一个，而且两个落点都得补。** 任务书只提「`stop_and_wait` 之后没有
   『换手段再来一轮』」，核对代码发现：`report_pending` 的三颗按钮里「继续修复」先过
   `verificationIsComplete`，验证四类检查全过但目标仍有未满足标准时当场抛「这一轮已经完成全部
   检查，不需要继续修复」——这正是 M3-2 的 `b-resume-fired` 未通过项。而无人值守关着时的落点
   `awaiting_next_round` 更糟：`DELIVERY_CLOSE_STATUSES` 原来只认 `report_pending`，于是**关掉自动
   续轮的人比留着的人少一条收口出口**，只剩「白烧一轮去够那颗按钮」与「取消（把已交付的东西记成
   没交付）」。两处一起补：`task:continue-round` 开新轮，`接受未验证并结束` 就地收尾。
3. **「瞬时通道故障不该判死」不是一个 if，而是四个判死口。** 只补分类函数一条也堵不住：
   ① 关键词表漏中文——生产方把网络异常自己包成中文（`providers/openai-compatible.ts:648`、
   `ollama.ts:635`），run 8 现场那句「主导模型五段汇总失败：连不上 https://api.scnet.cn…」里
   `fetch failed`/`ECONNREFUSED` 一个都没有，于是判成 `task_fault → failed` 终态；② `approve`
   与「恢复执行」两条 `catch` 直接调 `fail()`；③ 零步骤报告走的是显式 `failed`；④ 最隐蔽的一条
   来自本轮代码复审——`budget_exhausted` / `blocked` 两个落点缺 `→ interrupted` 边，通道断了
   `transition()` 抛错，`fail()` 的兜底**只补发 `task.failed` 事件而不写状态**，于是行还停在
   非终态、事件流却说它已经死了（按事件重建的列表显示「已失败」、统计页拿 `endedAt` 冻住总耗时，
   而这条任务其实还能 resume）。四个口现在全部过 `classifyFault()`，并由两条真跑用例与一处计数
   守卫钉住。
4. **`plan.invalid` 白烧一轮的根因是 schema 严格性，不是模型乱写。** `StepSchema` 每个分支都
   `.strict()`，模型多写一个 `dependsOn` 就让整份计划判废（真机样本：8 个步骤全带
   `dependsOn`/`expect`，其中 5 个还带 `checksCategory`），代价是一整轮真金白银的模型调用。
   本轮采取的不是放宽整份 schema，而是**接住这批「执行器不看但模型确实写了」的说明字段**并在
   界面明说忽略了什么——尤其 `dependsOn`：执行器按数组顺序跑，声明的依赖**不会被强制**，
   这句必须让用户看见，不能悄悄吞掉。

## 交付内容

1. **无人值守开关（`autoContinue`）**：`AgentTask.autoContinue`（`src/shared/contracts.ts`）+
   IPC `task:set-auto-continue`（`src/main/index.ts:3704`，`SetTaskAutoContinueSchema`
   `.strict()` 且只收布尔——字符串 `"false"` 在代码里 `!== false` 会显示成「已打开」，比没开关更糟）
   + `TaskManager.setAutoContinue()` 落库并发 `task.auto_continue.updated`（带 `previous`）+
   统计页那颗开关（`TaskStats.tsx`，拨完就地读回执与界面文案）。续轮判定只在
   `continueAfterReport()`（`orchestrator.ts:3447`）读一次，所以拨动它只影响**之后的边界**。
2. **「换手段再来一轮」出口（M3-4b）**：IPC `task:continue-round`（`src/main/index.ts:3696`）→
   `Orchestrator.continueRound()`；新一轮 `inputType='user_continue'`，请求文本带**用户原话 +
   上一轮手段清单**（`meansOfRound()` 把「哪条命令、结果如何、重复几次」点名到行，只说「换个手段」
   模型下一轮照样能交同一批调用）；开轮前必须过 M3-3 的同一道预算门禁，不开例外。
3. **停得下的落点与措辞（M3-4c）**：无人值守关着时 `transition → awaiting_next_round`
   （`orchestrator.ts:3777`，已在该状态时不再自环迁移——状态表没有自环边）+ 事件
   `task.round.await_user`；「为什么停/怎么回来」单源在 `continueExitText()`，活动流旁注与统计页
   念同一句话，两个界面不得各写一遍。
4. **停止原因可解释（M3-4d）**：`classifyFault()` 六类病因 → 三个可恢复落点
   （`channel_stall`/`channel_timeout`/`channel_context_full` → `interrupted`；
   `source_disabled`/`plan_unusable` → `blocked`；只有 `task_fault` 落终态 `failed`），
   `stopIntent()` 保证用户已经在按暂停/取消时不被通道故障顶掉结局（真机那条
   `task.failed（请求超时）` 就发生在 `cancelling` 中间）；三种可恢复落点统一发
   `task.fault.stopped`（`orchestrator.ts:3915`，带 `kind`/`error` 原文/`landedStatus`/
   `headline`/`howBack`），活动流旁注 + 折叠详情 + 统计页读数三处呈现。
5. **网页源关着要说得清（不是「页面尚未就绪」）**：`page-driver.ts` 把设置里那句原话递到
   `adapterFor`，`SOURCE_CLOSED` 才认得出来（`src/shared/task-fault.ts:59`）——落 `blocked` 而不是
   `failed`，因为用户在设置里拨一下开关就能接着跑。
6. **状态表与事件保留**：`budget_exhausted` / `blocked` 各补 `→ interrupted` 边、
   `awaiting_next_round` 补 `→ completed` 边（`src/main/task-manager.ts`）；`fail()` 的兜底改成
   「要么把状态真写成终态再发事件，要么只留日志」；`store.ts` 的 `KEEP_FOREVER` 纳入
   `task.fault.stopped`/`task.round.await_user`/`task.round.user_continue`/
   `task.auto_continue.updated`——这四类是「停在哪、为什么停、怎么回来」的唯一出处，挤到 800 条
   窗口外之后重启就再也说不出当初为什么没判死。
7. **顺带修掉的三处**：`PlanPreview` 的告警原来固定念一句「计划缺少判据…」，判据齐全的计划也套
   这个前缀（现按 `warnings` 逐条原文渲染）；切任务/新对话/清屏时上一条的续轮指令没放下，会串到
   下一条任务的输入框（`App.tsx` 补 `setContinueText('')`）；`task:set-budget` 的回执读的是改前状态。
8. **测试**：新增 `test:task-fault`（28 项）+ `test:task-continue`（22 项）并入 `verify`。守卫从
   「正则扫源码」往「真跑」挪了两格：状态表用真的 `TaskManager` 实例把新加的边逐条走一遍（含
   `planning→…→awaiting_next_round→completed` 全链），`fail()` 用内存 orchestrator 现场
   落点断言（`blocked`/`budget_exhausted` 遇通道故障只留 fault、`task.failed` 事件 0 条；对照组
   「本地状态与完成声明不一致」仍落 `failed` 且恰好一条 `task.failed`）。同时修掉一条会误伤的旧
   守卫（`check-goal-revision.mjs:103` 把 `KEEP_FOREVER` 钉成「名单里最后一条」，后来人加一项就以
   「M1-3 的卡片丢了」报失败）。

## 真机结论（四条探针、同一进程，判定原文见 `evidence.json` 分段）

探针分工：A+B 共用 `3040c256`（边界与出口）、C 用 `235c063a`（通道停住）、E 用 `71aa36ae`
（一次开关都没碰的缺省探针）、G 用 `9bdcf62b`（显式拨关的停轮探针）。F 段那条只建出会话、
没建出任务（被提交门禁拒掉）。全部走 `cli:qoder`、云模型清空，用户默认配置（`executionMode:cloud` +
`超算:GLM-5.3-Flash`）原样留在 `evidence.defaults` 未被改动。

| 判据 | 结果 |
| --- | --- |
| 开关边界拒脏值 | 4 条全拒并点名 zod 路径：缺 `autoContinue`、字符串 `"false"`、数字 `1`、多余键 `extra`（strict） |
| 关掉无人值守真落盘 | 回执 `{autoContinue:false,previous:true,status:"awaiting_approval"}`；落库 `autoContinue=false`；事件 `{autoContinue:false,previous:true}` 共 1 条；界面读数「无人值守 停在轮次开始前，等你点「继续下一轮」」；再拨回开也同向 |
| 「换手段再来一轮」的边界 | `task:continue-round` 拒 4 条（空指令「不能空着」、多余键、缺 `taskId`、状态 `awaiting_approval` 不在允许名单），且当场没偷开轮（轮数仍 1） |
| 用户出口真开一轮 | `report_pending` → 轮数 **1→2**、状态 `planning`；新轮 `inputType=user_continue`、请求文本含用户原话逐字、带上上一轮手段清单（`fs.list path=.`）；事件 `gate={"ok":true,"reason":"轮数 1/20"}` 与脚本用同一批纯函数反算逐字相同 |
| 通道停住不判死 | SIGSTOP 停住 CLI 子进程（pid 94738、组 94753，进程态 `TNs`）后，**编排器自己的看门狗**说出真机那句「模型连续 120 秒没有输出，已停止。请重试或换模型。」→ 落点 `interrupted`（不是 `failed`）；`task.fault.stopped` 五字段齐全（`kind=channel_stall`/`error` 原文/`landedStatus=interrupted`/`headline`/`howBack`）；故障后 `task.failed` **0 条**；停住期间轮数 1→1 没偷开轮；观察完 SIGCONT 放开、不补刀 |
| 停止原因在界面说清 | 活动流旁注「这一轮模型不再输出，是通道停住了 · 停在「interrupted」 详情」＋折叠详情原文；仍在说「失败原因」的条数 **0**；统计页同场给出无人值守读数与「轮次 1 轮」 |
| 「可恢复」不是状态表里的空话 | 点「继续任务」→ `planning`、轮数 1→2；恢复后停在 `awaiting_approval`，脚本代点「确认并执行」→ `report_pending` |
| 开着无人值守时判定说了算（反例半边） | 判定 `WAIT_USER/stop_and_wait`（目标仅部分达成，0 项部分满足）之后**没有**新轮，出口点击 0 次——开着也不新开轮才算对 |
| 缺省即开（正向半边） | 没碰过开关、字段从未写过的探针：判定 `REPAIR/open_next_round`「存在待修或未解决评审问题」→ 自动开出 `execution_report` 轮（轮次记录 `1:user_prompt、2:execution_report`），改动事件 0 条、出口点击 0 次、没落「等你点继续」旁注；等这条判定等了 301 秒 |
| **关掉即停（反向半边，M3-4c 的新落点）** | 显式拨关的探针同一问法：判定仍是 `REPAIR/open_next_round`「存在待修或未解决评审问题」→ 停在 **`awaiting_next_round`**（不是 `report_pending`、不是终态），`task.round.await_user` 带 `purpose`「按评审与验证问题修复」与 `gate`「轮数 1/20」；界面原文「判定要开下一轮，按你的设置停在这里」＋同组四颗按钮 `["继续修复（重新执行验证）","按当前口径重新判定","接受未验证并结束","继续下一轮"]`；出口点击 **0** 次、轮数 **1→1**（没偷开轮）——`06-awaiting-next-round.png` |
| `plan.invalid` 不再白烧轮 | 事件尾部 40 条里没有因说明字段判废的计划（`plan.invalid` 本轮 **0 次**，对比 M3-2 一轮里 2 次）；前四个里程碑的真机原文 5 条通道类错误回放当前分类器：落点 `["channel_timeout→interrupted"]`、仍判死 `[]` |
| 现场不留副作用 | 四条探针 + F 段那条孤儿会话删净（store 任务 **0→0**、会话 **0→0**，探针会话 5 条残留 0）、工作区 `…/tf-m3-4-ws-1795873779456` 已移除；开局还按标题清掉了上一轮遗留的 2 条探针任务 + 2 条探针会话；用户默认数据目录其余内容未动 |

## 未通过项：**0 条**——M3-2 留的那个洞这次补上了

M3-2 的 `b-resume-fired` 未通过项（判定说「停下等你决定」，界面上却没有「再来一轮」的入口）本轮通过：
`b-exit-visible-in-ui` 证到那颗按钮与同组四颗的完整清单
`["继续修复（重新执行验证）","按当前口径重新判定","接受未验证并结束","换手段再来一轮"]`，
`b-opened-round` 证到它真开出第 2 轮（不是只回一个回执），`b-instruction-persisted` 证到用户原话与
上一轮手段清单进了请求。它绕开的正是 `verificationIsComplete` 那道门禁——要改的是计划与手段，
不是补一次验证，所以不需要把 `verified:yes` 的报告假装还没验。

## 本轮证不到的东西（跳过，不当作通过）

1. `b-stops-before-round`——**「同一条任务里先拨关、随后判定说要开」这条串联路径没有现场**。
   A/B 那共用探针在等待前就把无人值守拨成关（`b-stopped-before-wait`），但它自己那一轮判成
   `stop_and_wait`，于是停在 `report_pending` 而不是 `awaiting_next_round`。
   **落点本身已由 G 段独立探针补上真机现场**（见上表「关掉即停」行与 `06-awaiting-next-round.png`）：
   `awaiting_next_round` 状态、`task.round.await_user` 事件、`continueExitText` 那句界面原文、
   `DELIVERY_CLOSE_STATUSES` 在这个状态下多给的「接受未验证并结束」出口、以及「停住期间不偷开轮」
   五条全部实拍到。剩下的缺口只是「不是同一条任务从开→关→停一路走下来」，
   而 G 段的 `switchOff` 回执本身就带着 `previous:true`（先开后关）——差别在于关掉之后有没有
   再走一轮判定，这条判定来自另一条探针而不是 A/B 那一轮。
2. `f-source-disabled-landing`——**`source_disabled → blocked` 只有分类器单测口径**。F 段按
   `selectedWebChannels:['deepseek']`（关着的源）建探针，被拒的那句却是
   `ChatGPT 未登录：页面尚未加载`：提交阶段的登录门禁（`orchestrator.ts:479`）读的是选出来的第一个成员，
   选不出就退回**默认适配器**，而不是这条任务勾选的那条通道；`model-route.ts:181` 那句说得对的
   「没有可用的网页通道…需要先在通道设置里打开一条」轮不到执行。所以本轮不只是「没采到样本」——
   **现网在这条路径上会把「你指定的源关着」说成「另一条源没登录」**，`SOURCE_CLOSED` 的改进被上游门禁
   挡住。登录是用户动作，脚本不代登。已把这条记进任务书 M3-4 落地校正 4 并列为后续项。
3. `c-auto-open-after-resume`——恢复后那一轮自己判成 `stop_and_wait`，正向半边由 E 段独立探针补上
   （见上表「缺省即开」行），不是同一轮里连起来的。

## 跑完之后才改的脚本三处（本轮证据原样保留，不回填）

1. **落库值的打印（run 10 之后改，run 13 已生效）**。`EVIDENCE.md`「结论」第 1 条原来读的是
   **收尾时**的 `storeTask()`，而探针在收尾前已删，于是那句回退成「（探针已删除，见 A 段回执）」——
   实测值本身在断言行里是有的（`a-switch-off-persisted — 落库 autoContinue=false`）。改成在删探针
   之前抄进 `evidence.phaseA.persistedAutoContinue` 之后，采信这轮的结论段打印出 `落库 autoContinue=false`。
2. **停轮段的两处「没有样本」说法（run 13 之后改，两处同因）**。`b-stops-before-round` 的 skip 原文写
   「停轮段本轮没有样本」，`EVIDENCE.md` 结论第 5 条原文写「本轮没有 `task.round.await_user` 样本，
   停轮段由离线用例覆盖」——那两句都是 G 段存在之前的口径。现在这两处只在「A/B 那条共用探针没走到」
   这个意义上成立，落点样本在 `g-*` 三条与结论第 8 条里。**读 run 13 的 `EVIDENCE.md` 第 5 条时请连着
   第 8 条一起读**：第 5 条说的是「同一条任务内没串起来」，不是「`awaiting_next_round` 没采到」。
3. **开局清扫补上会话 + 新增 `conversations-back-to-baseline`（run 11 之后改，run 13 生效）**。
   run 13 开局那句 `a-stale-probes-cleared — 清掉 2 条遗留探针任务 + 2 条探针会话，基线任务数 0／会话数 0`
   就是它第一次真跑到；收尾两条基线断言 `tasks-back-to-baseline 0→0`、
   `conversations-back-to-baseline 0→0` 同时在场。

## 现网把整轮吃掉的东西

1. 超算模型网关不可达，全部探针由 Qoder CLI 驱动（按用户指示）。这不是判定逻辑问题，但它决定了
   本轮能采到哪些落点：`cloud` 档在 run 8 现场的「主导模型五段汇总失败：连不上
   https://api.scnet.cn/api/llm/v1」正是分类器关键词表原来漏中文的那条证据，已存
   `fault.cloud-unreachable.json`。
2. 通道停摆仍然会发生：本轮 C 段是**主动 SIGSTOP 注入**的（走 CLI 通道那条），`模型连续 120 秒没有
   输出` 现场在 M3-2/M3-3 也自然出现过。M3-4d 改的是「停在哪里、说不说得清、接不接得回去」，
   不是让停摆不发生。
3. 看门狗 120 秒静默 + E 段等判定边界 301 秒，决定了墙钟压不到更短：判定句要真从模型那一轮里出来
   才算数，不能拿构造好的事件冒充。

## 收尾补做：漏在用户目录里的现场与一次作废的取证，都是我的账不是产品的账

1. **F 段被拒之后那条会话没人认领（run 10）**。探针建不出来时 `createProbe` 直接返回
   `conversationId: null`，可提交被拒前会话已经落库了——收尾名单里没有它，
   `probe-conversations-cleaned-up` 于是报了「残留 0 条」，而默认目录里实际多了一条
   「网页源关闭探针」会话。先按产品自己的口径回收（CDP 走 `getConversations()` +
   `deleteConversation()`，store 会话 1→0、mtime 与调用时刻对上），再把这条补进
   `evidence.cleanup`，断言读的是回收之后的磁盘。run 13 的 F 段就自己做了这件事：
   「顺手回收 1 条会话，仍没删掉的 0 条」，并且那条会话出现在收尾名单里（`（F 段只有会话，没有任务）`）。
2. **开局清残留只清任务、不清会话**。`deleteTask` 回收的是检查点/归档/孤儿目标，**不碰会话**
   （`orchestrator.ts:1945`）——会话挂在 `conversation.taskId` 上，任务没了它就永久成孤儿。
   现在开局按任务与会话两条名单一起清，并新增 `conversations-back-to-baseline` 兜住
   「建出来却没进收尾名单」的那一类。
3. **run 11 / run 12 作废：两轮真机并发跑在同一个 dev 实例上**。我在 run 11 还在等 E 段判定时起了
   run 12，于是共用了一个 CLI 单名额、同一个证据目录（截图与 `EVIDENCE.md` 互相覆盖），而 run 11
   收尾的 F 段孤儿清扫把 run 12 刚建出来的探针会话当遗留删掉了——表现在 run 11 的日志上是三条
   `FAIL tasks-back-to-baseline 0→1`、`SKIP e-default-auto-open（状态 null，轮次记录 无）`、
   `顺手回收 2 条会话`。**采信的只有 run 13**：它开局清了这两轮留下的 2 任务 + 2 会话，
   51 项判定 0 未通过，四条基线断言全绿。教训写在这儿而不是藏起来：**验收脚本必须串行跑**，
   「同一进程」既是产品前提也是取证前提。
4. **run 13 第一次没跑起来**：shell 的工作目录被切到仓库根，`node scripts/verify-…` 报
   `MODULE_NOT_FOUND` 而外层 `echo` 仍返回 0——「后台任务 exit 0」不等于脚本跑过了，得看日志首行。
5. **探针工作区留在临时目录**：`os.tmpdir()` 下这几轮共产出 `tf-m3-4-ws-*` 若干（run 11 那份是
   `/var/folders/…/T/tf-m3-4-ws-1795872599499`），脚本结尾只删自己这一份 `WORKSPACE`，被掐断的
   那轮删不到。按 AGENTS.md §5.1 这类临时工作区不做自动清理，此处只记账不假装清干净。

## 遗留（不在 M3-4 范围内）

- **P1 闸门的 ≥2 小时无人值守任务**：按用户指示暂缓，本轮只证到「判定要开下一轮时确实自动开了」
  与「关着时确实停住且接得回去」，没有跑小时级长任务；多轮自动推进的样本最多到 2 轮。
- **`plan.invalid` 的模型侧**：本轮把说明字段接住并明说，但模型仍会写执行器不用的键；真正的修法在
  计划协议与 prompt 收敛，属后续。
- **token / 模型调用计数**：M3-3 遗留，仍然不回报，界面读「未记账」。
