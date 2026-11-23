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
修复：捕获 EEXIST 后比对现有内容，**字节完全一致才幂等成功**（created:false/unchanged:true），
内容不同仍拒绝（保留 overwriteFile+sha256 安全语义）。真机对已存在的 `HelloJwp.java`
写同内容 → created:false、sha256 不变，死循环解除。

**B. 同一模型两张输出卡**（commit `cfb35a5`）
`buildTaskConversation` 的 live 段硬编码 `::lead` key，真实 participantId 带 provider
前缀，导致同一 `deepseek-v4.1-flash` 出两张「输出中」卡。修复：live 并进已有的
streaming 成员卡。真机复验 `p7-05-after-fix.png`：4 轮各一张卡、输出中只剩 1 张。

回归：`npm run verify` 484/484（0 fail）。新增测试 check-code-read +2、check-task-conversation +1。
