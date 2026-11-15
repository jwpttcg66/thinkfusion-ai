# Qoder / Claude CLI Spike 报告（0.2.7）

日期 2026-11-15 · 分支 `0.2.7` · worktree `/Users/yalla/data/localLab/thinkfusion-ai-0.2.7`
基线 `b6b2fa7` · 状态标签按审核要求统一使用
`SPECIFIED / IMPLEMENTED / INTEGRATED / VERIFIED / TESTED / PRODUCTION_READY`，
另补 `BLOCKED`（环境前置条件不具备，本轮没验证到，不算通过、也不算产品缺陷）。

本文只记**真实跑过的事实**。没有跑过的项写明没跑过和原因，不用文档自述冒充实测。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 机器 | macOS 26.3，arm64（Darwin `25.3.0`） |
| Node | v22.22.2 |
| 应用 | ThinkFusion 0.6.0 / Electron 45.1.0 / Chrome 156 |
| Qoder CLI | `1.1.89`，`~/.qoder/entry/qoder`（不在 PATH，注册表有回退查找） |
| Claude Code | `2.1.325 (Claude Code)`，`/opt/homebrew/bin/claude` |
| 云端 | OpenCode Go（Claude CLI 侧本轮周额度已耗尽，见 §4） |
| 能力记录 | `userData/cli-capabilities.json`，两条种子记录，`os: darwin arm64` |

Qoder 参数指纹 `32afab96b634d097`，Claude `0c8b3d95161611bd`；
指纹覆盖 `command basename`、`args`、`permissionArgs`、`interactiveArgs`。

## 2. 第一轮 Spike（同日早些时候，人工命令）

```bash
qoder  -p "Reply with exactly: OK" --output-format json
claude -p "Reply with exactly: OK" --output-format json
# 两者都返回 {"type":"result","subtype":"success","is_error":false,"result":"OK", ...}
```

临时 git 仓库里跑写文件任务（分别用 `accept_edits` / `acceptEdits`），两者
`exit 0`、`hello.txt` 出现、`git status` 能看到 `?? hello.txt`。

由此确立并写进代码的事实：

- 两家都支持 headless + JSON 输出、可靠退出码、可配置权限模式 —— `INTEGRATED` + `VERIFIED`；
- JSON 只有最终结果，没有逐条工具事件，不把 `result` 之外的字段当工具调用；
- 模型身份不按品牌猜：Claude 的 `modelUsage.canonicalModel` 实测为第三方模型，
  Qoder 的 `modelUsage` 键是 `auto` / `efficient`（档位，不是模型名）；没声明就
  记 `null` + `unverified` —— `IMPLEMENTED` + `TESTED`。

## 3. 0.2.7 自动复跑（`test:cli-real -- --run --all`）

命令：`node scripts/spikes/cli-real-e2e.mjs --run --all`（opt-in，会联网、消耗额度）。
报告：`/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-cli-real-e2e-1794717575623.json`。
不传 `--run` 只做版本探测，绝不联网。

| 用例 | Qoder 1.1.89 | Claude 2.1.325 | 状态 |
| --- | --- | --- | --- |
| `detect` | `1.1.89` | `2.1.325 (Claude Code)` | `VERIFIED` |
| `headless-minimal` | `exit 0`，`result: "OK"` | OpenCode Go 周额度耗尽 | Qoder `VERIFIED` / Claude `BLOCKED` |
| `write-file` | `exit 0`，`hello.txt` = `OK` | 同上 | Qoder `VERIFIED` / Claude `BLOCKED` |
| `cancel-process-group` | SIGTERM 进程组后 `kill(-pgid, 0)` 返回 `ESRCH` | 任务在 4 秒取消点之前就因 429 退出 | Qoder `VERIFIED` / Claude `BLOCKED` |
| `concurrent-minimal` | `ok` | 额度阻断 | `BLOCKED`（只有一家跑起来，并发无从验证） |

合计 **5 PASS / 0 FAIL / 4 BLOCK**，脚本退出码 1：没全验证到就不写「全部通过」。
Qoder 一整条链路 `IMPLEMENTED / INTEGRATED / VERIFIED / TESTED`；
Claude 的代码链路同样 `IMPLEMENTED / TESTED`，但**本轮 `VERIFIED` 未闭合**，
原因是外部额度，不是应用逻辑。

### 3.1 真机抓出并已修的两个缺陷

1. **警告行让整段 JSON 解析失败。** Qoder 1.1.89 在结果 JSON 之前先打
   `Custom command '/goal' was renamed to '/goal1' ...`。原先「重新验证」与 E2E
   脚本都直接 `JSON.parse(stdout.trim())`，于是 `exit 0`、`result:"OK"`、文件也真的
   创建出来了，却被判「没有可识别的结构化结果」。
   修法：新建 `src/shared/cli-result.ts`，统一「先试整段、再倒序逐行找最后一个
   JSON 对象」；主进程 `verifyCliHeadless()`、Runtime `runCliAgent()`、E2E 脚本
   三处共用同一口径，并加自动化测试防止两份实现漂移。成功标准**没有放宽**：
   `is_error` 为真、没有非空 `result` 依旧算失败。
   复跑真机：`verifyCliHeadless('qoder')` →
   `{ ok: true, version: "1.1.89", headless: "verified" }`，能力记录已落盘。
   状态 `IMPLEMENTED / INTEGRATED / VERIFIED / TESTED`。
2. **取消检查是空集上的假阳性。** 原脚本靠 `ps -eo pid=,pgid=` 统计进程组成员，
   在受限环境里 `ps` 直接 EPERM 返回空列表，「进程组已清空」其实什么都没观测到。
   改用 `process.kill(-pgid, 0)` 真发信号探测（`ESRCH` = 组已不存在）；
   CLI 提前退出、探测不可用、取消前组就不存在，一律标 `BLOCKED`，不冒充 PASS。
   状态 `IMPLEMENTED / VERIFIED / TESTED`。

### 3.2 应用退出时审计没有收尾（真机抓出并已修）

优雅退出调试实例后，`app-exit.jsonl` 正常写出
（`{"reason":"应用正常退出（before-quit）","pid":71138,...}`），但仍在运行的
Claude PTY 会话那份 JSONL 只有 `session-start / resize / 9 条 stdout`，
`replay --verify` 报「缺少 session-end」。原因是 Electron 退出会直接杀掉
UtilityProcess，Runtime 的 `process.on('exit') → closeAllTerminals()` 根本不执行；
原注释里「Runtime 会自己补 session-end」的假设是错的。

修法：`src/main/terminal-audit-reconcile.ts` 在 `before-quit` 同步扫描目录，只给
「有 session-start、没有 session-end」的文件补 `exit` + `session-end`，明确标
`auditIncomplete: true` / `recoveredBy: 'main-process'` / 退出码未知，不伪造正常关闭。

用这份真机遗留文件做样本复验：补尾前 `--verify` 报缺 session-end；补尾后事件
11 → 13、`sequence` 12/13 续上，校验明确报「退出码/信号未知，这份记录不完整」；
再跑一次 `reconciled: []`（幂等），已完整的文件不被改动。

随后用最终构建重启调试实例、再优雅退出，直接从应用侧复核：
新写出的 `app-exit.jsonl` 带
`"reconciledSessions":["term-mwhbn0xy-2","term-mwhd86ei-1","term-mwhd86ep-2"]`；
三个文件的末条 `session-end` 都是 `recoveredBy:"main-process"`、
`auditIncomplete:true`；本来已经完整结束的 `term-mwhbn0xo-1.jsonl`
（73 事件、`CANCELLED`）一个字节没动。
状态 `IMPLEMENTED / INTEGRATED / VERIFIED / TESTED`。

### 3.3 顺带抓出的错误分类缺口

Claude 周额度耗尽的原始返回是
`{ "subtype": "error", "is_error": true, "result": "API Error: Request rejected (429) · OpenCode Go usage limit reached (weekly...)" }`。
`subtype` 只有笼统的 `error`，旧 `classifyCliError()` 会短路成
`UNKNOWN_ERROR / structured / high`，把最常见的额度错误分错。
现在错误 JSON 的 `result` / `error_message` 正文作为第二层 `structured` 证据参与
匹配，置信度明确标 `medium`，真机样本分到 `RATE_LIMITED`；成功结果正文里出现
「rate limit / 429」不会被误判。状态 `IMPLEMENTED / VERIFIED / TESTED`。

## 4. 真机应用侧验证（Electron 调试实例，CDP 9222）

| 项 | 结果 |
| --- | --- |
| `getCliAgents()` | Qoder `1.1.89`、Claude `2.1.325`，均 `headless: verified`、`available: true` |
| `getCliCapabilities()` | 两条种子记录含 `os`、参数指纹、验证时间、Spike note |
| 设置 → 智能体 | 两行显示版本、可执行路径、非交互已实测、权限参数、实测记录、「重新验证」按钮；无溢出/错位 |
| `listTerminals()` | 两个 PTY 会话，`state: RUNNING`、`startedAt`、`durationMs` |
| 终端审计 | `userData/terminal-records/term-mwhbn0xo-1.jsonl`、`term-mwhbn0xy-2.jsonl`；`sequence` 单调递增；含 `session-start/resize/stdout/connection/stdin/cancel/exit/session-end`；无明文 Key |
| 状态栏 | `运行中 · 连接：已连接 · 运行 2 分 9 秒` |
| 结束会话 | 二次确认 `将终止进程组，确认？` → `确认终止`；确认后 `listTerminals()` 只剩 Claude，审计 `finalState: CANCELLED` |
| 回放 | `replay-terminal.mjs term-mwhbn0xo-1 --verify` → 73 事件 / 6 resize，`校验通过：sequence 单调递增、结构完整、resize 保留、无写入失败标记`；`--markers` 重现 `[SESSION-START]`、`[RESIZE 120x30]`、`[RESIZE 75x49]`、`[STDIN]`、`[SESSION-END]` |

## 5. 状态汇总

| 能力 | 状态 |
| --- | --- |
| 配置驱动 CLI 接入（不造 Adapter 空壳） | `IMPLEMENTED / INTEGRATED / VERIFIED / TESTED` |
| Qoder headless / 写文件 / 取消 | `PRODUCTION_READY` |
| Claude headless / 写文件 / 取消 | `IMPLEMENTED / TESTED`，`VERIFIED` 本轮 `BLOCKED` |
| 多 CLI 并发 | `IMPLEMENTED`，`VERIFIED` 本轮 `BLOCKED` |
| 结构化结果解析（警告行容错） | `PRODUCTION_READY` |
| 进程组取消验证 | `PRODUCTION_READY` |
| 六类错误分类 | `IMPLEMENTED / TESTED / VERIFIED`（真机 429 样本） |
| 版本/参数绑定能力记录 | `IMPLEMENTED / INTEGRATED / VERIFIED / TESTED` |
| 终端审计 / 回放 / 状态机 | `IMPLEMENTED / INTEGRATED / VERIFIED / TESTED` |
| 应用退出时审计补尾 | `IMPLEMENTED / VERIFIED / TESTED`（补尾记录明确标不完整） |

## 6. 未承诺 / 复跑方式

- **不承诺** Claude 链路已在本轮真机通过：OpenCode Go 周额度提示约 19h31m 后重置，
  重置后重跑 `npm run test:cli-real -- --run --all` 即可补齐 4 个 `BLOCKED`。
- **不承诺** CLI 自动升级后参数不漂移；升级后必须点「重新验证」或重跑本脚本。
- **不承诺** PTY 能分出独立 stderr：node-pty 是合并流，审计一律记 `stdout` 并标
  `stream: 'pty-merged'`。
- 不把 dry-run（只探版本）写成 E2E 通过；不把 Fake CLI 测试写成真实 CLI 测试。

复跑命令：

```bash
cd /Users/yalla/data/localLab/thinkfusion-ai-0.2.7/desktop-agent-macos
npm run test:cli-real                 # dry-run，不联网
npm run test:cli-real -- --run --all  # 真跑，消耗额度
npm run replay:terminal -- <sessionId> --verify
```

另见 `CLI_INTEGRATION_BASELINE_AUDIT.md`（基线）、
`ADR_CONFIG_DRIVEN_CLI_ADAPTER.md`（架构决策）、
`CLI_INTEGRATION_FINAL_REPORT.md`（整体验收）。
