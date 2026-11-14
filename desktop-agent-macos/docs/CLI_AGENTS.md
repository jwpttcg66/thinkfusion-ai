# 外部 CLI Agent（Qoder / Claude）

这份文档记录**已经落地的东西**和**实测边界**。它不是路线图，也不承诺没测过的能力。

## 1. 定位

| 类别 | 做什么 | 是否自动参与普通回答 |
| --- | --- | --- |
| Web Source | 提供网页信息 | 是（已开启的都要问） |
| Local / Cloud Model | 模型分析与回答 | 按执行模式 |
| CLI Agent（Qoder / Claude） | 工程执行者；可选的分析参与者 | 否 |

CLI 不是「回答通道」：打开它只决定新任务能不能把工程活派给它，不会让它在每个问题上发言。
这条区分写在 `src/main/cli-agents.ts` 的注释里，也写在设置页「外部 CLI Agent（执行者）」的说明里。

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

## 8. 生命周期

| 动作 | 结果 |
| --- | --- |
| 关闭终端面板 | CLI 继续跑，重新打开能看到 backlog |
| 取消任务 | 下发 `task.cancel`，Runtime 按进程组终止 CLI；工作树保留 |
| 计划执行超时 | 先下发取消再拒绝，不留「界面超时、进程还在改文件」 |
| 应用退出 | Runtime 退出时终止所有 CLI 与 PTY，并落任务终止记录；工作树保留 |
| 后台续跑 | 本期不支持；需要独立的进程宿主与恢复设计 |

## 9. 测试

```bash
npm run test:cli        # 真实子进程：argv、退出码、超时、取消、改动路径、权限门
npm run test:worktree   # 真实 git：建树、复用、隔离、提交、合并、删除
npm run test:terminal   # 真实 PTY
npm run test:verify     # 验证规则（含 CLI 改动）
npm run test:capabilities
```

`test:cli` 用 `scripts/fixtures/fake-cli.mjs`，是真进程、真 argv，不是模块 mock。
真实 CLI 回归仍要在有登录态的机器上跑，并记录版本与日期——见上面的实测记录。
