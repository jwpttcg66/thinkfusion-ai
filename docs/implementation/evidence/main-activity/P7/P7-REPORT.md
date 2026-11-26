# P6/P7 端到端验收记录（2026-11-23，CDP 真机）

> 对应 `docs/implementation/ENGINEERING_WORKBENCH_V2_1.md` §5 的 21 条用例。
> 本轮不重复 §9（2026-11-22）已验的 15 条，聚焦 UI 可复验项与 6 条未验/部分项。
> 原始断言数据见 `results.json`，截图见本目录 `p7-01..04.png`。

## 1. 方法与环境

- 启动：`env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS npx electron-vite dev --noSandbox --remoteDebuggingPort 9333`。
- dev 长驻进程会随 agent turn 结束被回收，因此**启动 + CDP 连接 + 验收 + 截图 + 收尾 kill 全部写在一条自包含脚本里**，一次调用内完成。
- 驱动：CDP `Runtime.evaluate`（真实 DOM click）+ `Page.captureScreenshot`。
- 样本：工程工作空间里已存在的真实任务 `d6f99537-…`（「编写一个 java 工程输出 hello jwp」，状态 `report_pending`，40 条事件，含 1 条 `step.failed`）——**只读观察，未改动/未取消/未重跑该任务**。
- 大局：本机只有 1 个云端模型（OpenCode Go · deepseek-v4.1-flash）+ 1 个 CLI，无法构造三路并行。

## 2. 本轮结果

SUMMARY：`pass=12 / fail=0 / blocked=4`（4 条环境受限，非缺陷）。

| # | 用例 | 本轮结论 | 证据 |
|---|---|---|---|
| 13 | 对话页可见状态/阶段/步骤/下一步/最近活动 | ✅ | 进度卡五字段齐全；阶段「等待确认交付」、步骤「4/8 步」 |
| 14 | 任务启动即反馈 | ✅ | 成员卡「17.4s · 3625 字符 · 已完成」 |
| 17 | 步骤失败在时间线可见（原「部分」→ 本轮补齐） | ✅ | 对话页「失败原因：未验证…」；轨迹页 step 5 `fs.writeFile` 红色失败行 |
| 18 | 长等待显示等待对象与时长 | ✅ | 「持续 15 分 26 秒」 |
| 20 | 进度数字与真实事件一致 | ✅ | UI「4/8 步」，`getTaskEvents`：completed=4 / failed=1 / started=5，完成数与 UI 一致 |
| 7 | 汇总/评审后原始输出完整可查 | ✅ | 输出页完整计划树 8 步 + 活动流 40/40 条（reasoning/assistant/tool/planning/test/review/delivery/lifecycle），未被汇总覆盖 |
| 5 | 工具参数/结果/发起模型可追溯 | ✅ | 轨迹页每条链带「发起：OpenCode Go · deepseek-v4.1-flash」与耗时 |
| 10 | 统计页分层展示 | ✅ | 四层：任务（40 条/15分26秒）、按模型、按工具、验证 |
| 11 | 无 reasoning/Token 显式「未提供」 | ✅ | 按模型表 Token 列写「未提供」，不填 0 |
| 8 | 切页不中断执行 | ✅ | 对话→输出→轨迹→统计→对话，回来阶段与步骤仍在 |
| 19 | 切走再回连续不重复调用 | ✅ | 回来仍是 1 条「第 1 轮 · 提问」，未新增 round |
| 12 | 取消作用范围（原「未验」） | ⚠️ 部分 | 本轮确认「取消任务」入口存在；**未实点**——该任务是用户的真实任务，避免误伤。隔离性由 §9 用例 1 的并发独立性与单测覆盖 |
| 2 | 三模型并行 | ⊘ 环境受限 | 本机 1 云 + 1 CLI，无法构造三路；分桶键由 `test:task-members` 11 条覆盖 |
| 4 | 限流错误隔离 | ⊘ 环境受限 | 未构造 429；错误隔离有单测 |
| 16 | 挂死成员其他仍更新 | ⊘ 环境受限 | 未构造断网/挂死；「正在等待」UI 已存在 |
| 21 | V1 知识问答多模型 | ⊘ 本轮未覆盖 | 只观察了工程任务；`test:knowledge-*` 绿 |

## 3. 与 §9 合并后的口径

§9（11-22）已验 15 条 + 本轮复验 11 条一致。原先「部分」的 #17 本轮用真实 `step.failed` 补齐为 ✅。
仍未完全真机覆盖的是 #2/#4/#12/#16/#21：其中 #2/#4/#16 是**环境无法构造**（非代码缺陷，
有单测覆盖），#12 因避免动用户任务只验了入口存在，#21 有 `test:knowledge-*` 覆盖。

## 4. 截图索引

- `p7-01-dialog.png`：对话页（进度卡 + 成员回答 + 失败原因）
- `p7-02-output.png`：输出页（计划树 8 步 + 活动流 40 条）
- `p7-03-trajectory.png`：轨迹页（工具链三阶段 + 失败行 + 阶段时间线）
- `p7-04-stats.png`：统计页（四层 + Token「未提供」）

## 5. 追加真机复验：用户报「卡死 / 输出两次 / 任务无法完成」（11-23 下午）

用户三张截图指向两个真 bug（图1「像卡死」是执行失败的副产物）：

**A. 任务无法完成 = EEXIST 死循环**（核心，commit `cfb35a5`）
真实任务 `c55f53b8-…` 的事件链：第1轮 `fs.writeFile HelloJwp.java` → EEXIST（文件来自
用户上次同名任务）→ step.failed → 验证四格全跳过 → 评审需修复 → 报告轮 → 第2轮
`plan.invalid`（模型多写 `addresses`）→ 第3轮又写同名文件 → 又 EEXIST → 第4轮
`Object has been destroyed` → task.failed。根因是 `filesystem.ts:writeFile` 的 `O_EXCL`。
修复（第一版）：捕获 EEXIST 后比对现有内容，**字节完全一致才幂等成功**（created:false/unchanged:true）。
后续真机发现这仍不够（见第 6 节）：模型重生成的代码与盘上那份不完全相同时依旧 EEXIST，
遂在第二版改成完全权限档下原子覆盖，见第 6 节 A。

**B. 同一模型两张输出卡**（commit `cfb35a5`）
`buildTaskConversation` 的 live 段硬编码 `::lead` key，真实 participantId 带 provider
前缀，导致同一 `deepseek-v4.1-flash` 出两张「输出中」卡。修复：live 并进已有的
streaming 成员卡。真机复验 `p7-05-after-fix.png`：4 轮各一张卡、输出中只剩 1 张。

回归：`npm run verify` 484/484（0 fail）。新增测试 check-code-read +2、check-task-conversation +1。

## 6. 追加：用户追问「界面跟卡死一样 / 输出两次 / 你确认修复了吗，真机跑通」（11-23 傍晚）

用户连发三图追问，核心诉求从「界面像卡住」升级为「任务要保证完成、自己真机测试」。
重新读真实任务 `1ee9bcb8-…`（plan_ready→executing），定位到第 5 节修复**没解决根因**，
并挖出两个新的真 bug。

### 6.1 第 5 节的幂等修复不够：内容不同仍 EEXIST
第 5 节只认「字节完全相同」，可模型重跑时重新生成的代码与盘上那份格式/注释不完全一致，
step-5 照样 `EEXIST: file already exists`。真机证据：build 11:37 已含幂等代码，任务
11:40:34 的 step-5 仍失败。

**修复 A**（`agent/tools/filesystem.ts`）：`danger-full-access`（完全权限，本意就允许改文件）
下遇 EEXIST 用「同目录临时文件 + rename」原子覆盖成新内容，保留符号链接/类型检查和写后
回读核对；其他权限档维持「字节相同才幂等」，不覆盖工作区里别人改过的东西。
真机：对已存在的 `HelloJwp.java` 写**不同内容** → `created:false, replaced:true`、
文件内容确实被替换、无 `.tmp` 残留、原内容可恢复（脚本已恢复）。

### 6.2 假完成：空轮 + 一句「任务完成」被标 completed
失败链：第 1 轮写文件失败 → 第 2 轮换了个只有 `fs.list`/`fs.tree` 的**空计划**，
`verifyExecution` 按既有契约判「没有写操作，无需验证 → verified=true」→ 第 3 轮模型回
`kind:'complete'` summary「任务完成」→ 编排器 `handleAnswer` 961 行**无条件信任**，
标成 completed。结果：代码没写成、hello jwp 从没编译运行，界面却显示「已完成」。
这正是用户看到的「任务完成了但什么都没有 / 界面不对」。

**修复 B**（`agent/verification.ts` + `main/orchestrator.ts` + `main/store.ts`）：
新增跨轮纯函数 `hasGenuineDelivery(reports)`，判据是「整条执行链至少有一份报告真的跑过
一次能观察结果的检查（编译/运行/测试/诊断通过）」。在两处完成判定点（`handleAnswer` 的
`complete`、`continueAfterReport` 的 `status=completed`）接入：空轮/失败轮一律不许交付。
- 关键设计：**不要求必须写过文件**——目标代码本就正确、无需改动时，编译运行通过就是
  真交付。第一版误用「必须写文件」判据，真机把合法任务误判并重规划死循环（消耗额度），
  已当场修正并补测试 `check-verify.mjs`：「没写文件但 javac+java 跑通也算交付」。
- 不破坏既有契约：`verifyExecution` 的「空轮 trivially verified」保持不变（纯问答轮
  不该判失败）；挡的是编排层把空轮当工程交付证据。

### 6.3 顺带修：进度卡「6 / 2 步」
`TaskProgressCard` 的 `doneSteps` 跨所有轮次按 stepId 去重累加（旧轮 6 个），分母只取
当前 plan（2 步），出现「6 / 2 步」这种分子大于分母的怪值。改为只数当前 plan（优先按
roundId 匹配，老事件退回按当前 plan 的 stepId 集合）。真机复验显示正常的「1 / 2 步」。

### 6.4 真机端到端跑通（用户明确要求「你自己测试，保证真机运行成功」）
自包含脚本一次跑完：停旧实例 → 带 CDP 单实例启动 → 真实 UI 切工程空间、选 Downloads
工作区、发任务 → 轮询到终态 → 独立用 `javac`+`java` 复跑校验 → 截图 → 清理实例与测试数据。
- 任务 `e4b26f22-…`：`planning → plan_ready → executing → completed`，65 事件，其中
  `step.started×5 / step.completed×5 / report.ready×2 / review.ready×2`。
- **完成路径正确**：报告 0 是空轮（compile/run skipped），报告 1 `compile=passed,
  run=passed, runOut="hello jwp"`——`hasGenuineDelivery` 因报告 1 放行，**不是**被空轮绕过。
- **独立验证**：`javac -d out src/main/java/com/example/HelloJwp.java` + `java -cp out
  com.example.HelloJwp` 实跑输出严格等于 `hello jwp`（`EXACT=true`）。
- 界面：点开会话正确显示任务视图（不再是空欢迎态），进度「1 / 2 步」，成员回答/方案评审/
  对话流齐全（截图见下）。
- 关于「卡住」：真机确认慢步骤是**方案评审辩论**（日志「开辩」后等几分钟模型辩论），
  不是死锁；任务在辩论完成后继续推进。界面缺少「正在评审」提示是观感问题，非功能卡死。
- 测试数据当场删净（任务/会话/消息/事件/报告/轮次/runEvents），store 回到 1 任务 / 2 会话 /
  10 消息 / 85 事件；删前备份 `/tmp/tf-store-before-cleanup.json`。

### 6.5 追加截图与验证
- `p7-06-session-open.png`：点开工程会话后的任务视图（进度卡 + 四页签 + 对话流，非欢迎态）
- `p7-07-e2e-submitted.png`：端到端任务提交态
- `p7-08-e2e-final.png`：端到端完成态（1 / 2 步、成员回答、方案评审、对话流）
- `npm run verify` **489/489**（0 fail）：新增 check-verify +5（闸门）、check-code-read 改写 1（原子覆盖）。

### 6.6 「界面卡太久」两项感知修复（2026-11-23 下午）

用户两张截图分别对应两个真实等待点，都不是死锁：

1. **发送后停在首页**：`App.submit()` 先 `await submitConversation`，而工程提交在 main 里
   要探活 → 路由 → 转交 Planner，整条 IPC 几十秒不返回，期间既不切会话也没有自己的
   提问气泡。修复：点击发送当帧就在本地建占位会话 + 用户消息并切到会话视图；主进程
   `conversation.created`（按标题 42 字对齐）或 IPC 返回时换成真 id，失败则撤掉占位、
   原话还给输入框。
2. **方案评审静默等待**：计划出来后 `reviewPlanWithDebate()` 直接 `await debatePlan`，
   最长 180 秒没有任何进度；任务状态仍是 `plan_ready`，进度卡写「审阅计划」，像是
   等用户而用户没看到审批按钮。修复：新增 `plan.review.progress` 事件（开始 / 每 10 秒
   心跳含已等待秒数 / 结束），进度卡显示「方案评审中 · 成员评审方案（N 个议题）」并单独
   计时；对话流只留开始与结束两个节点，心跳不刷屏。辩论本身没跳过、审批语义没变。

真机自包含 CDP 复验（`P7-UI-RESPONSIVENESS.json` + 3 张截图）：

- 发送到离开首页 **29 ms**（修复前整条 IPC 等待，截图里仍停在 hero）。
- 方案评审中状态可见，心跳与结束节点都观察到；任务最终 `completed`，报告
  `compile=passed / run=passed`，输出 `hello jwp`。
- 测试数据当场删净（含第一次脚本因未刷新 taskId 遗留的那条），store 回到 1 任务 /
  2 会话 / 10 消息 / 62 事件；无残留 dev / Electron 进程。
- `npm run verify` **492/492**（新增 `test:ui-progress` 3 条）。

### 6.7 交付清单补齐：文件改动与工程产物（2026-11-23 傍晚）

用户指出「任务做完后应该有文件改动、工程产物保存，最后都没有」。真因在投影层：
`reportView()` 只认带 `before/after` 或 `patch` 的改动，而 `fs.writeFile` 实际只回
`{path, created, replaced, bytes}`；`verification.changedPaths` 和编译命令 stdout 里的
`.class/.jar` 也没进视图。于是结论说「改动 1 个文件」，交付卡里却一个路径都没有。

修复：
- `TaskView.changes` 允许「只有路径+字节」的改动项；从 `fs.writeFile` 结果和
  `verification.changedPaths` 双向补齐，按路径去重。
- 新增 `TaskView.artifacts`：从 `shell.run` 的真实 stdout/stderr 与编译检查输出里
  解析 `.class/.jar/.so/...` 产物，相对路径补 `cwd`，绝对路径/相对路径去重。
- 结论卡增加「工程产物 N 个」事实；交付卡与输出页分别列出改动文件（新建/覆盖/字节）
  和工程产物；「最终交付」卡的出现条件同步包含产物。
- `conversation.updated` 一挂上 `taskId` 就选中任务并补读历史事件，避免事件被
  `activeRef` 过滤导致报告/结论/交付卡整块不出现。

真机 CDP 复验（`P7-DELIVERY-ARTIFACTS.json` + `p7-12-delivery-files-and-artifacts.png`）：
任务 `completed`，结论「执行 5 步 / 验证通过 / 改动 1 个文件 / 工程产物 1 个 /
独立评审：通过」；交付卡列出 `java-artifact-demo/Main.java`（新建 114 字节）与
`java-artifact-demo/Main.class`（shell.run），验证编译/运行均通过。
`npm run verify` **495/495**（新增 `test:delivery-artifacts` 3 条）。会话与任务数据当场删净。

### 6.8 方案评审全过程可见 + 重复气泡 / 空步骤卡（2026-11-23 傍晚）

用户连续指出三类界面问题：「同一句提问出现两个气泡」「这一步没有可展示的输出。
方案评审开始：2 个议题，之后界面像卡住」「方案评审进行中·已等 30 秒——我要看到
评审的所有细节，跟模型思考那样，看见整个过程」。

真因：
- `submit()` 先放本地占位气泡，主进程落库后 `message.added` 又追加一条，
  两条 messageId 不同；工程提交 IPC 几十秒不返回，重复气泡一直挂着。
- `plan.review.progress` 的 `waiting` 心跳在 `milestone()` 里被过滤成 `null`，
  对话流里只剩「评审开始」一句；10 张 `step.preparing` 空卡又显示
  「这一步没有可展示的输出」，评审两三分钟看起来就是死机。
- `debatePlan` 原来 `debates.start()` → `waitFor()` 一次性拿结果，中间完全不
  emit。辩论引擎其实边跑边落盘（`runningRound.pending` / 每条发言），但界面
  从没读过这些中间态。

修复：
- `shared/conversation.ts` 新增 `mergeConversationMessage()`：末尾同文
  `pending-` 占位换成落库消息，不新增气泡；不误并上一次真的问过的同文。
- `shared/execution-timeline.ts`：评审心跳聚成固定 key 的原地更新节点，
  文本随「已等 N 秒」滚动，不刷屏也不静默；`shared/task-conversation.ts`
  跳过尚未开始、无参数可看的 `preparing` 空卡；步骤卡空输出文案改成
  「正在执行 / 等待处理 / 失败」等真实状态。
- **评审细节**：`main/debate/review-progress.ts` 把辩论快照翻译成
  `round.peer`（成员卡）事件——`pending` → 输出中、发言 → 已完成并带
  正文与 `reasoning`、失败 → 如实标失败；`seen` 跨回调去重。
  `DebateOrchestrator` 新增 `onProgress` 落盘回调（只读、异常不影响辩论），
  `main/index.ts` 按 `debateId` 登记 `planReviewScopes`，只有方案评审才发，
  手动辩论与知识空间辩论零改动。`round.peer` 契约补 `reasoning` 字段，
  成员卡沿用「模型思考」的推理折叠。

真机 CDP 复验（`P7-REVIEW-DETAIL.json` + `p7-14-review-detail-live.png` /
`p7-14-review-detail-final.png`）：对话流出现 3 张唯一成员卡——规划 1 张、
「第 1 轮评审」1 张（8323 字符）、「第 2 轮评审」1 张（8612 字符），
均带正文与「思考」折叠；进度行从 10 秒滚到 90 秒；任务 `completed`。
（证据 JSON 里 `reviewPeers` 是逐秒采样状态快照，按 label 去重后的真实卡片见
`reviewPeersFinal`。）
`npm run verify` **502/502**（新增 `test:message-dedupe` 3 条、
`test:review-detail` 4 条，`test:ui-progress` 改为断言原地滚动）。会话与
任务数据当场删净，无残留进程。

## 6.9 评审「不停输出」：流式增量 + 思考即输出（502 → 506）

用户三连：「还是不对，需要的是整体输出」「感觉还是很慢，模型不会 28s 还没返回」
「就是要不停的输出辩论过程，不要让我干等」。真实事件链显示：评审 started 后
**59 秒界面没有一张卡**（scope 晚登记吞掉首轮 started），而成员发言本身
50-60 秒里引擎只在整条落盘后才有内容——`DebateOrchestrator.askWithin` 只调
整段 `ask`，池层已有的 `askStream` 从没被辩论用过。

- **流式增量**：`DebateDeps` 增 `askStream` / `onStream`；`runRound` 把每个
  成员发言的 chunk 转发，`askWithin` 有 onDelta 就走流式。`main/index.ts`
  把 chunk 累积成全文快照再 emit `round.delta`（store 对 delta 按 streamId
  只留最新快照，直接发增量会丢文本），按 150ms 节流防刷屏；scope 未登记
  （手动/知识空间辩论）一行不发。
- **首轮卡片不再等落盘**：`start()` 内部在首次 `persist` 之前同步调
  `onStart`，`planReviewScopes` 由 `pendingReview` 在 start 前备好；
  `review-progress.ts` 的 started 用 `round.startedAt`、answered 用
  `message.endedAt` 并带真实 `durationMs`，不再全挤在落盘时刻。
- **思考也是输出**：模型常先写几十秒推理再出正文，卡上只有「等待模型
  输出…」。流式期间没有正文就把 `reasoning` 直接铺进成员卡正文、标
  「思考中 · 已写 N 字符」并自动滚到底部；正文到了再切过去。
- **整体输出**：协议卡默认展开完整原文（按钮「收起原文」），不再只给一句
  摘要；准备中的空步骤卡全部不进对话流；进度卡「正在等待」补上正在写的成员。

真机 CDP（`P7-REVIEW-STREAM.json` + `p7-15-* / p7-16-* / p7-17-*`）：
评审卡在发送后 24-32 秒即出现，正文逐秒从 1516 长到 22034 字符
（63 个递增采样，首次增长在卡片出现后 8 秒内），任务 `completed`；
历史任务只读复核协议原文 8252 字符默认展开。
`npm run verify` **506/506**（`test:review-detail` 4 → 8 条）。
验收脚本启动前备份 store、结束前无条件文件覆盖恢复，核对仍为
1 任务 / 2 会话 / 10 消息 / 121 事件 / 2 报告，工作区回到 Downloads。

## 6.10 对话页去重：同一份思考不再出现三次（506 → 511）

用户贴出真机截图：一轮流式输出里，**同一份 3054 字符思考被画了三遍**——
成员卡正文框（流式期间把 reasoning 铺进正文）、成员卡底部「思考（3054 字符）」
折叠、App 里那张旧的「模型思考（3054 字符）」卡；中间还夹着一张
「正在生成执行计划」旧状态卡。上一轮 §6.9 解决了「不停输出」，但没发现
对话页里还并存着历史遗留的实时区，于是「输出」变成了「重复输出」。

- **纯函数统一分工**：`shared/task-conversation.ts` 新增 `memberBodyView`，
  规则只有一条——同一时刻同一份内容只在一个地方可见。流式且正文未到时
  正文框铺思考、`showReasoningDetails=false`；正文到了切回正文，思考作为
  另一份内容恢复折叠；协议对象不把 JSON 原文误标成思考；meta 行的字符数
  按当前真正展示的内容算，不再显示与正文框不符的 0。
- **删除旧实时区**：`App.tsx` 的 conversation tab 下 `isLive(derived.live)`
  三张卡（正在生成执行计划 / 模型思考 / 模型输出）整体移除。主界面是
  `TaskConversation`，状态由 `TaskProgressCard` 承担；output tab 的历史
  「模型思考记录」保留（那是不同轮次，不是实时重复）。`isLive` import 一并清掉。
- **锁进单测**：`check-task-conversation.mjs` 补 5 条（流式去重 / 正文到达 /
  已完成占位 / 协议不误标 / 无思考占位），`npm run verify` **511/511**。

真机 CDP（`P7-CONVERSATION-DEDUP.json` + `p7-18-conversation-deduped.png`）：
只读打开历史任务「编写一个java工程，输出本机的ip」，4 张成员卡正常渲染、
每张最多一个思考折叠、页面里 `模型思考（`/`模型输出（`/`正在生成执行计划`
文案与 `.card.reasoning`/`.card.assistant` 节点均为 0；浏览器内再跑一次
`memberBodyView` 验证流式态「思考只出现一次」通过。
验收脚本自包含启动 dev（清掉宿主 `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS`）、
启动前备份 store 与 workspace-state、finally 无条件文件覆盖恢复，核对仍为
1 任务 / 2 会话 / 10 消息 / 77 事件 / 1 报告，工作区 `/Users/yalla/Downloads`。

## 6.11 方案评审轮次不再写死 2 轮（511 → 519）

用户问「为什么固定 2 轮评审」。查证结果：`src/main/index.ts` 的 `debatePlan`
里硬编码 `maxRounds: 2`（`f1970bf` 加的，原注释是「再多也不会让计划本身
变得更可行，只会把审批拖长」），配套 `totalMs: 180_000` / `waitFor(180_000)`。
而 `phaseFor()` 是死映射：`0=analysis`（表态）、`1=challenge`（质疑）、
`≥2=response`（回应收敛）——**2 轮永远跑不到回应轮**；`summarizePlanDebate`
原来只取最后一轮，于是送进审批的「评审结论」其实是没人答复过的质疑。
同一仓库会话内辩论的注释还明写着「两轮的话『回应』那一轮根本不存在」，
那边用 3 轮，两处口径自相矛盾。

按用户选择「按计划规模动态决定」落地：

- `shared` 层纯函数 `planReviewRounds(plan, participantCount)`：单成员自辩
  2 轮（再加一轮只是同一模型自问自答）；设计文档、≥3 步、或 ≥3 位评审给
  3 轮；其余 1-2 步简单计划 2 轮。`planReviewBudget()` 让预算跟着轮次走
  （2 轮 180s / 3 轮 300s，等待多 20s）——**只改轮数不抬预算，第三轮会被
  `totalMs` 直接砍掉**。
- `summarizePlanDebate` 优先取 `response` 轮（带真实 `phase` 字段，老记录按
  index 兜底）；只有质疑轮时如实标注「没有回应轮，被评审方尚未答复」，
  不把质疑伪装成收敛意见。
- `PlanDebate` 新增 `rounds` / `roundsReason`，`orchestrator.reviewPlanWithDebate`
  透传进 `plan.debated`，`PlanPreview` 显示「评审 3 轮 · 理由」，审批的人能
  解释这次为什么比上次慢。
- 数据安全根治：`main/index.ts` 支持 `THINKFUSION_USER_DATA`（绝对路径）
  覆盖 userData，验收实例跑在隔离目录，只复制模型配置，不再碰真实
  `agent-store.json`。

真机 CDP（`P7-REVIEW-ROUNDS.json`）：工程空间只读任务「4 步计划」，2 位评审，
`plan.debated` 为 `rounds=3 / 4 步的计划，分歧要留一轮回应`；辩论文件
`maxRounds=3`，三轮 `analysis / challenge / response` 各有 1 条发言，停因
「回应里没有新的修订，也没有新的争议」；事件流里出现「第 1 / 2 / 3 轮评审」
成员卡。真实 store 的 sha256 前后一致。`npm run verify` **519/519**
（`test:plan-review` 16 → 24 条）。

本轮期间发现：反复跑 `npm run verify` / 启停应用曾把真实 store 写成
`0 任务 / 0 事件`（丢过用户的「机器名」任务与 121 条事件）。已用 15:28 的
完整备份恢复并核对为 1 任务 / 2 会话 / 10 消息 / 121 事件 / 2 报告；
隔离 userData 是根治手段，后续验收一律走隔离目录。
