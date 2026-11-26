# 外部 CLI Agent（Qoder / Claude）

这份文档记录**已经落地的东西**和**实测边界**。它不是路线图，也不承诺没测过的能力。

## 1. 定位

| 类别 | 做什么 | 是否自动参与普通回答 |
| --- | --- | --- |
| Web Source | 提供网页信息 | 是（已开启的都要问） |
| Local Model | 本地模型分析与回答 | `local` / `hybrid` 档 |
| Cloud Model | 远程模型分析与回答 | `cloud` / `hybrid` 档 |
| CLI Agent（Qoder / Claude） | **第三类回答源**，也可当主导/辩手/执行者 | 除 `local` 外都问 |

CLI 与网页是同一层级的回答源，不是「只在派活时才出现」：`web` / `hybrid` / `cloud`
都会把用户原话发给它，回答进第一轮与汇总材料；`local` 档才不问。
归属上算云端一类（`ownershipSourceOf(CLI) = cloud`），因此可以主导、可以辩论、可以执行；
但它不进工程编排名单（回答链没有文件工具），改文件仍走 `agent.exec`。

## 2. 已实现

| 能力 | 位置 |
| --- | --- |
| `agent.exec` 工具（计划里可用） | `src/shared/contracts.ts`、`src/agent/local-plugins.ts` |
| 真实进程执行 / 超时 / 进程组取消 | `src/agent/tools/cli-agent.ts` |
| 注册表（安装、版本、开关、能力） | `src/main/cli-agents.ts`、`userData/cli-agents.json` |
| 执行结果与验证联动 | `src/agent/verification.ts`、`src/shared/engineering-evidence.ts` |
| 任务级独立 Worktree（创建/提交/合并/删除） | `src/main/task-worktree.ts`、`src/renderer/src/components/TaskWorktree.tsx` |
| TerminalHost：多读者、程序直启、进程组 | `src/agent/tools/terminal.ts` |
| 终端 IPC 与面板 | `src/main/index.ts`、`src/preload/index.ts`、`src/renderer/src/components/AgentTerminal.tsx` |
| 设置开关 / 启动时准备 CLI 终端 | `src/main/index.ts`（ensure/sync/bootstrap）、`src/preload/index.ts` |
| 右侧栏：每个终端一个开关（窗口） | `src/renderer/src/components/SourceRail.tsx` |
| 终端窗口内容 | `src/renderer/src/components/TerminalPanel.tsx` |
| 每会话一个独立终端窗口 | `src/renderer/terminal.html`、`src/renderer/src/terminal-window.tsx`、`src/preload/terminal.ts` |
| 任务取消真的下发到 Runtime | `src/main/agent-manager.ts`（`cancelPlan`） |
| 测试 | `scripts/check-cli-agent.mjs`、`scripts/fixtures/fake-cli.mjs` |

## 3. 权限

启动外部 CLI 需要**完全访问**（danger-full-access）：

- 计划阶段：`workspace-write` 的工具清单里根本没有 `agent.exec`（`allowedToolsForPreset`）；
- 执行阶段：`assertGrant` 再拒绝一次；
- 逐次审批：`riskOf('agent.exec') = 'danger'`，每一步都要用户点批准；
- 授权剩余时间：`timeoutMs` 被 `grant.expiresAt` 截断，过期不会再启动。

**必须说清楚**：`TaskGrant` 拦不到 CLI 内部的每一次读写与命令。它自带工具循环，唯一的细粒度边界是 CLI 自己的 `--permission-mode`。所以：

- 默认配置用 `accept_edits` / `acceptEdits`（允许改文件，不绕过全部检查）；
- 需要更强隔离时自己换 Worktree、环境变量白名单或 CLI 权限参数；
- 不要把 Worktree 说成安全沙箱——它不是。

## 4. 独立工作树

含 `agent.exec` 的计划在**审批时**创建一棵独立 git worktree：

- 位置：`userData/worktrees/<仓库名>-<任务短 id>-<hash>`，不在仓库里，不污染 `git status`；
- 分支：`tf/<task-id>-<hash>`，基线是审批时的 `HEAD`；
- 授权里写 `worktreeDir`，`agent.exec` 的相对 `cwd` 以它为准，`..` 越界会被拒绝；
- 同一任务多轮复用同一棵树，不会每轮新建；
- 取消 / 失败 / 应用退出都**保留**这棵树，不自动回滚半成品；
- 合并是显式动作：先在面板里提交，再点合并；冲突自动 `merge --abort`，不留半合并状态；
- 删除时若有未提交改动默认拒绝，只有勾选「强制删除」才会丢改动；未合并的分支会保留。

界面在任务详情里显示：分支、路径、未提交文件数、领先提交数，并提供
打开目录 / 复制路径 / 查看 diff / 提交 / 合并 / 删除。没有 `agent.exec` 的任务不显示这块。

## 5. 实测记录（2026-11-15，macOS）

两台 CLI 都装在开发机上：

| CLI | 版本 | 可执行文件 |
| --- | --- | --- |
| Qoder CLI | 1.1.89 | `~/.qoder/entry/qoder`（不在 PATH 里，注册表有回退查找） |
| Claude Code | 2.1.325 | `/opt/homebrew/bin/claude` |

验证过的最小任务：

```bash
qoder -p "Reply with exactly: OK" --output-format json
# → {"type":"result","subtype":"success","is_error":false,"result":"OK", ...}

claude -p "Reply with exactly: OK" --output-format json
# → {"type":"result","subtype":"success","is_error":false,"result":"OK", ...}
```

写文件（在一个临时 git 仓库里）：

```bash
qoder -p "Create a file named hello.txt containing exactly the word OK." \
  --output-format json --permission-mode accept_edits
claude -p "Create a file named hello.txt containing exactly the word OK." \
  --output-format json --permission-mode acceptEdits
# 两者 exit 0，git status 都能看到 ?? hello.txt
```

由此确定的事实：

- **两者都支持 headless + JSON 输出**，所以 `headless: 'verified'`；
- **都返回可靠退出码**（成功 0，失败非 0）；
- **都支持可配置的权限模式**；
- **JSON 只有最终结果，没有逐条工具事件**：不把 `result` 之外的字段当作工具调用；
- **模型身份不能按品牌猜**：Claude CLI 的 `modelUsage.canonicalModel` 实测为一个第三方模型
  （`deepseek-v4.1-flash`），Qoder 的 `modelUsage` 键是 `auto` / `efficient`，不是模型名。
  两者都按「CLI 自己声明了什么」记录，没声明就是 `null` + `unverified`。

未验证、因此不承诺的：

- 取消时的子进程树是否总能清干净（代码按进程组杀，但需要真实长任务复核）；
- 多 CLI 并发时的订阅额度与限流行为；
- CLI 自动升级后参数是否漂移。**升级后必须重新跑上面的最小任务**，再决定是否保留 `verified`。

### 5.1 0.2.7 复跑（同日，`--run --all`）

`node scripts/spikes/cli-real-e2e.mjs --run --all` 会联网、消耗额度，结果写到系统
临时目录的 JSON 报告。本轮结论：

| 用例 | Qoder 1.1.89 | Claude 2.1.325 |
| --- | --- | --- |
| detect | PASS | PASS |
| headless-minimal | PASS（`OK`） | BLOCK：OpenCode Go **周额度耗尽**（429，19h31m 后重置） |
| write-file | PASS（`hello.txt` = `OK`） | BLOCK：同上 |
| cancel-process-group | PASS（真实 `kill(-pgid, 0)` 探测，取消后进程组不存在） | BLOCK：任务在取消信号发出前就因 429 退出 |
| concurrent-minimal | — | BLOCK：只有 Qoder 跑起来了，并发无从验证 |

合计 **5 PASS / 0 FAIL / 4 BLOCK**，因此脚本退出码仍为 1（没全验证到，不算通过）。
BLOCK 是「本轮没验证到」，不写成产品缺陷；等额度恢复后重跑同一条命令即可补齐。

这轮真机还抓出两个真实缺陷，均已修：

1. **Qoder 会在 JSON 之前打一行自定义命令重命名警告**。整段 `JSON.parse` 会把
   `exit 0`、`result:"OK"`、文件也真写出来了的任务判成「没有结构化结果」。
   `src/shared/cli-result.ts` 统一为「先整段、再倒序逐行找最后一个 JSON 对象」，
   主进程「重新验证」、Runtime 执行器、E2E 脚本三处共用同一口径；复跑后
   `verifyCliHeadless('qoder')` 真机返回 `ok:true, version:1.1.89, headless:verified`。
2. **取消检查原先靠 `ps -eo pid,pgid` 数成员**，受限环境里 `ps` 直接 EPERM 返回
   空列表，「进程组已清空」是空集上的假阳性。改用 `process.kill(-pgid, 0)` 真发
   信号探测；CLI 提前退出或探测不可用时一律标 BLOCK，不冒充 PASS。

## 6. 结果与验证

`agent.exec` 返回：

```ts
{
  exitCode, signal, timedOut, cancelled, durationMs,
  stdoutTail, stderrTail, truncated,
  changedPaths,          // 运行前后 git status 的差集，不是 CLI 自报
  text, model, costUsd, sessionId, permissionDenials
}
```

验证规则：

- CLI 改文件但**没有**独立的 `test.run` / `code.diagnostics` → `verified=false`，
  理由写「外部 Agent 改了 N 个文件，但没有独立的测试或诊断」；
- 有独立检查通过 → `verified=true`，理由里同时给出改动路径的来源；
- 退出码非 0 / 超时 / 取消 → 这一步失败，计划停止；
- 证据账本会同时记一条命令（退出码）和每条改动文件。

代码里对应：`src/agent/verification.ts`、`src/shared/engineering-evidence.ts`。

## 7. 终端

- `agent.exec` 走 headless（管道），**没有 PTY**：JSON 与 stderr 混在 PTY 里会互相污染，
  所以不为了「看起来有终端」把控制通道塞进 PTY；
- `term.open` 仍然开真实 PTY，界面可以 attach；
- 一个 Electron Renderer 内多个 xterm 实例，不为每个 CLI 开新的 Renderer；
- 关闭面板只 detach，不杀进程；要结束必须点「结束会话」或取消任务；
- xterm 不注册 OSC 52 / OSC 8 处理器，第三方输出不能改剪贴板、不能把链接变成动作。

右侧栏里**每个终端一个按钮**，与网页通道并列；默认显示在右侧面板，"放大"才开独立窗口：

- 设置「外部 CLI Agent（执行者）」里 **开** → 准备好该 CLI 的交互终端会话
  （侧栏出现 Q/C 按钮），但**不自动弹窗**；**关** → 结束该终端、按钮变灰；
  两个都开就是两个会话同时运行，可以在侧栏切换；
- 点侧栏按钮：终端显示在**右侧面板**（网页让位），面板里没有标签栏；
- 面板里的「放大」→ 该会话单独开一个窗口；窗口里的「吸附回来」关窗并把终端
  放回右侧面板；关窗不会结束会话；
- 任务里 `term.open` 产生的会话也各有一个按钮；CLI 自己的交互终端不会重复
  画成普通 `>_` 按钮；
- 页面工具栏的终端按钮：有面板就收起，没有就打开第一个 CLI / 终端；
- 设置里关闭某个 CLI 时，如果它正显示在面板或放大窗口里，会一起关掉。

## 8. 生命周期

| 动作 | 结果 |
| --- | --- |
| 关闭终端窗口 | CLI 继续跑，侧栏按钮再点一次能重新打开 |
| 取消任务 | 下发 `task.cancel`，Runtime 按进程组终止 CLI；工作树保留 |
| 计划执行超时 | 先下发取消再拒绝，不留「界面超时、进程还在改文件」 |
| 应用退出 | Runtime 退出时终止所有 CLI 与 PTY，并落任务终止记录；工作树保留 |
| 后台续跑 | 本期不支持；需要独立的进程宿主与恢复设计 |

## 9. 测试

```bash
npm run test:cli             # 真实子进程：argv、退出码、超时、取消、改动路径、权限门
npm run test:cli-production  # 脱敏、有效参数、状态机、错误分类、能力记录、终端审计（28 条）
npm run test:worktree        # 真实 git：建树、复用、隔离、提交、合并、删除
npm run test:terminal        # 真实 PTY
npm run test:verify          # 验证规则（含 CLI 改动）
npm run test:capabilities
npm run replay:terminal -- <sessionId> --markers   # 终端事件回放
npm run replay:terminal -- <sessionId> --verify    # 审计完整性校验
npm run test:cli-real -- --run --all               # opt-in：真实 Qoder / Claude E2E
```

`test:cli` 用 `scripts/fixtures/fake-cli.mjs`，是真进程、真 argv，不是模块 mock。
真实 CLI 回归仍要在有登录态的机器上跑，并记录版本与日期——见上面的实测记录。
`test:cli-real` 不传 `--run` 时只做版本探测，绝不联网，因此普通 CI 不会因本机
没装 CLI 而失败。传 `--run` 才有三种结果：`PASS` 真跑过且满足判定、`FAIL` 真跑过
但不满足、`BLOCK` 前置条件不具备（额度/鉴权/CLI 提前退出，本轮没验证到）。
BLOCK 不算通过，退出码仍非 0；报告里会分别列出「未通过」和「本轮无法验证」。

## 10. 版本绑定与「重新验证」

`headless: 'verified'` 不再是永久有效的常量。记录落在
`userData/cli-capabilities.json`，一条记录 =
`(cliId, 能力项, 语义化版本, 系统, 参数指纹)` + 验证时间 + 结果：

- 版本比较取第一个 `x.y.z`（Claude 输出 `2.1.325 (Claude Code)`，Qoder 输出 `1.1.89`）；
- 指纹覆盖 `args` / `permissionArgs` / `interactiveArgs` / 可执行文件 basename；
- 改版本或改参数 → 只让 `headless` 这一项降级 `unverified`，不清零其它能力；
- 首次运行种入 2026-11-15 Spike 的两条记录，保证当时实测过的版本继续可用；
- 设置 → 智能体 → 对应 CLI 行 →「重新验证」会真的跑一次 headless 最小任务
  （消耗云端额度，最多 90 秒），通过才写新记录。这是 opt-in，不自动执行。
- 「重新验证」与执行器共用 `src/shared/cli-result.ts` 的按行容错解析：Qoder 的
  自定义命令警告行不会再把成功任务误判为失败；成功标准本身没有放宽
  （`is_error` 为真、没有非空 `result` 依然算失败）。

`agent.exec` 只认下发的 `headless` 字段；`cliAgentSnapshot()` 用当前版本重算它，
所以「升级了但还没重验」在这里就被挡住，不会等到运行时报错。

## 11. 审批卡上的最终有效参数

用户点「执行这一步」时确认的是**实际会启动的东西**，不是计划里的配置名：

- CLI 类型、展开后的 argv（`{task}` 已替换、权限参数已追加）、真实工作目录
  （worktree 路径，不是相对路径）、有效权限模式、是否允许改文件、是否高风险；
- argv 与 `argsPreview` 都先过 `src/shared/redact.ts` 脱敏；
- 配置名对不上时卡片会明确写「注册表里没有这个 CLI 的配置」，不假装能展开。

## 12. 终端审计与状态

审计在 Runtime 里写（PTY 的 onData / stdin / resize 都在那儿），目录由主进程
在 `utilityProcess.fork` 时通过 `TF_TERMINAL_AUDIT_DIR` 注入，缺省静默停用。

- 位置：`userData/terminal-records/<sessionId>.jsonl`，每会话一份 append-only；
- 事件：`session-start` / `stdout` / `stderr` / `stdin` / `resize` / `connection` /
  `cancel` / `exit` / `session-end` / `audit-error` / `audit-truncated`，`sequence` 单调递增；
- **PTY 是合并流**：node-pty 只给一个 onData，没有独立 stderr。PTY 输出一律记
  `stdout` 并在 `session-start` 标 `stream: 'pty-merged'`，不假装分得开；
- 所有 `data` / `argv` / `reason` 落盘前脱敏；`dropped` 与 `droppedChars` 落盘；
- 写失败标记 `auditIncomplete` 并在下次成功写入时补一条 `audit-error`；
- 单文件上限 8 MB，超过后只记结构事件、正文置空并标 `dropped`；保留期 14 天，
  配置时清理过期文件；
- 应用退出在 `before-quit` 同步写 `app-exit.jsonl`。**别指望 Runtime 自己补尾**：
  真机实测 Electron 退出会直接终止 UtilityProcess，`process.on('exit') →
  closeAllTerminals()` 不会执行，仍在跑的 PTY 那份 JSONL 会永远停在最后一条
  stdout。所以 `recordAppExit()` 同时调用
  `src/main/terminal-audit-reconcile.ts`，同步给「有 session-start、没有
  session-end」的文件补 `exit` + `session-end`，带
  `recoveredBy: 'main-process'`、`auditIncomplete: true`，不伪造退出码。
  `replay --verify` 会明确报「退出码/信号未知，这份记录不完整」，不会把补尾
  误读成完整审计。补尾幂等，已有 session-end 的文件一个字节都不动。

`npm run replay:terminal -- <id> --markers` 按 sequence 重现输出顺序与 resize；
`--verify` 检查 sequence 单调、结构完整、resize 保留、写入失败标记。
`--list` 一次列出所有会话及其完整性结论。

**状态分开记**：进程状态由真实进程事件驱动（`STARTING / RUNNING / EXITING /
EXITED / FAILED / CANCELLED`），连接状态由面板 attach/detach 驱动。
`CANCELLED` 只在终止成功后置位；强杀失败保留 `FAILED` 与错误说明。
面板状态栏并列显示进程状态、连接状态、运行时长、丢弃字符数与审计标记。
「结束会话」需二次确认（5 秒内点「确认终止」），关面板只 detach。

## 13. 错误分类

三层信任（不再只靠 stderr 文本）：

1. `structured`（high）—— CLI JSON 里的错误码字段（`is_error` / `subtype` /
   `error.code` / `status`）；
2. `structured`（medium）—— 错误 JSON 的 `result` / `error_message` 正文。
   Claude Code 2.1.325 真机周额度耗尽时，`subtype` 只有笼统的 `error`，
   「Request rejected (429) · usage limit reached」全在 `result` 里；旧实现会
   直接短路成 `UNKNOWN_ERROR(high)`，现已按 medium 分到 `RATE_LIMITED`；
3. `process`（high/medium）—— 超时、信号、非零退出码、spawn errno；
4. `text`（low）—— stderr 文本兜底，附命中片段，界面明确标低置信度。

成功结果的正文即使提到「rate limit / 429」也不参与错误分类。

成功与用户取消返回 `null`，不硬塞一个「无错误」类别。`stdoutTail` /
`stderrTail` / `text` 进报告前也统一脱敏。

## 14. 软件源设置（0.2.7 追加）

「设置 → 智能体 → 外部 CLI Agent」每一行新增「软件源设置」，能改/记三件事：

| 项 | 作用 | 会不会执行 |
| --- | --- | --- |
| 可执行文件 | PATH 里的命令名，或文件对话框亲手挑的绝对路径 | 保存时只验 `X_OK` 与 `--version` |
| 安装 / 更新来源 | `manual / npm / brew / https URL` + 包名或地址 | **不会**安装、更新、联网 |
| 服务端点 / 备注 | 这个 CLI 走哪个网关、版本通道 | 只作记录，不替代「云端 API 模型」的配置 |

两条安全边界：命令名只能是干净 basename 或绝对路径（拒绝 shell 元字符、
`..`、相对路径）；绝对路径必须是本次在「选择…」对话框里亲手挑过的，
渲染层不能凭空塞一条路径进来。填了不存在的可执行文件会当场报错，不会把一个
可用的 CLI 悄悄变成「找不到」。

配置落 `userData/cli-agents.json` 的 `softwareSource`，坏值按「未登记」处理，
不拖垮注册表。改了命令名会让参数指纹变化，headless 能力自动降为
`unverified`，要重新点「重新验证」。测试：`npm run test:cli-source`（8 条）。

**回答源边界（2026-11-15 用户裁决，覆盖本文早前版本）**：回答源只有三类——
**网页 / 模型 / CLI**，同一层级。打开的 CLI 会像 DeepSeek / Kimi 一样被问同一句
原话，答案进第一轮、进通道条、进汇总；它只回答，不主导、不当辩手。

早前版本写的是「CLI 是执行者，不是被问的通道」，那条已作废：它当时的理由
（「会改代码的进程不能每条问题都启动」）用参数边界解决，而不是靠不给它发言权——
回答这条链 **不传 `permissionArgs`、cwd 固定在系统临时目录**，它拿不到改文件的
能力；改文件仍走 `agent.exec` 的授权与工作树。

| | 网页源 | 模型源 | CLI 源 |
| --- | --- | --- | --- |
| 第一轮被问 | ✅（`web` / `hybrid`） | ✅（`local` / `cloud`） | ✅（`web` / `hybrid` / `cloud`） |
| 归属规则里算一类成员 | 网页 | 本地 / 云端 | **云端这一类**：可主导、可辩论 |
| 状态与开关 | 设置 → 网页源 | 设置 → 模型 | 设置 → Agent 预设 |
| 失败原因 | 登录 / 页面未就绪 | 缺 Key / Ollama 未启动 | 没装 / 能力未验证 / 限流额度等 |

**归属（2026-11-15 第二次裁决，覆盖同日早前「只回答」版本）**：CLI **属于云端主导的
一种**——可以主导、可以回答、可以辩论、可以执行。所以：

- 选人：`web` / `hybrid` / `cloud` 三档都会问 CLI；`local` 主导不问（本地只用本地模型，
  跟不问网页是同一条规则）。CLI 同时进执行名单（可当主导 / 辩手），并归到 cloud 一类。
- 辩论：CLI 进 `debateCandidates`（`type: 'cloud'`、`cli: true`），可当主辩；编排器把
  材料放进 `system` / `context`，`CliAnswerAgent.ask` 拼成一条提示发过去；第一轮没有
  材料时仍是用户原话逐字。
- 执行：工程活照旧走 `agent.exec`；回答 / 辩论这条链仍不传 `permissionArgs`、cwd 在
  临时目录——「可以执行」指的是它有执行那条链，不是回答时顺手改文件。
- 不进的两处：方案评审辩论（`debatePlan`）与多 agent 编码（`code.team.run`）明确
  排除 CLI——前者会拖住任务审批链路，后者要读文件而回答链没有文件工具。

`local` 主导时不问 CLI 的实现：`execution/policy.ts`；归属映射在
`conversation-runner.ts` 的 `ownershipSourceOf`（CLI → cloud）。
实现：`execution/cli-answer-agent.ts`（`CliAnswerAgent` + 真实 spawn）、
`execution/policy.ts`（选人）、`execution/execution-pool.ts`（第一轮名单）。
测试：`npm run test:cli-answer`（13 条）。

**按问勾选（2026-11-15 追加）**：输入框「模型」弹层里，模型清单下方有「CLI 来源」
区块，按问筛 CLI——`selectedCliAgents` 三态与 `selectedCloudModels` 一致：
`undefined` = 设置里开着的全部（缺省，老会话不迁移）；`[]` = 这一问一个都不问；
非空 = 只勾的这些。写回会话 `executionConfig` 并同步执行默认值。注意 id 形态：
名单按回答成员 id（`cli:qoder`）对齐，注册表 id（`qoder`）不带前缀，混用会全部落空。
`local` 主导下勾选不生效（本就不问 CLI）；`cloud` 主导会问 CLI，勾选照常生效。

## 15. 交付文档

- [ADR 0007：配置驱动的 CLI Adapter](../../docs/adr/0007-config-driven-cli-adapter.md)
- 接入期的一次性报告（基线审计、Spike、最终验收）见 git 提交历史。
