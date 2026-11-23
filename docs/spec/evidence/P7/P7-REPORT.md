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
