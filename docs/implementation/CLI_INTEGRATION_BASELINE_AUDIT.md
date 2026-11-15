# CLI 接入基线审计（0.2.7）

日期 2026-11-15 · 基线提交 `b6b2fa7`（main）· 开发分支 `0.2.7`
方法：`git log --diff-filter=A` 取每个文件的首次提交，逐个读当前源码核对。
**不以计划书或文档自述作为代码事实。**

## 1. 状态标签

| 标签 | 含义 |
| --- | --- |
| `SPECIFIED` | 只在计划/文档里写了 |
| `NOT_IMPLEMENTED` | 文档声称有、代码里没有 |
| `PARTIAL` | 有部分实现，但不满足验收条件 |
| `IMPLEMENTED` | 代码存在且链路接通 |
| `INTEGRATED` | 与其它模块联调通过 |
| `VERIFIED` | 真机或真实进程验证过 |
| `TESTED` | 有自动化测试覆盖且通过 |
| `PRODUCTION_READY` | 治理、审计、验证、回归全部闭合 |

后两个标签（`NOT_IMPLEMENTED` / `PARTIAL`）是本轮新增：原计划只给
`SPECIFIED → PRODUCTION_READY` 六个档，会把「文档写了、代码没做」的项误标成
`IMPLEMENTED`。

## 2. 三类基线（以 Git 事实为准）

### 实施前已有（本次 CLI 接入之前）

| 组件 | 首次提交 | 日期 |
| --- | --- | --- |
| `AgentOrchestrator`（`src/main/orchestrator.ts:94`） | `7d41bb4` | 2026-10-31 |
| `src/main/agent-manager.ts` | `7d41bb4` | 2026-10-31 |
| `TaskGrantSchema`（`src/shared/contracts.ts`） | `7d41bb4` | 2026-10-31 |
| `verifyExecution()`（`src/agent/verification.ts`） | `a9b2002` | 2026-11-11 |
| `src/agent/tools/terminal.ts`（持久 PTY） | `1e43a03` | 2026-11-10 |
| `src/agent/step-approval.ts`（逐次审批） | `e3ef2b9` | 2026-11-09 |
| `src/main/trace/trace-store.ts`（append-only JSONL） | 早期 | 2026-11 |
| xterm.js / Agent UtilityProcess | 初版 | 2026-10-31 |

### 同一批接入时新增（2026-11-15，均在 `fb43002` 之后）

| 组件 | 首次提交 |
| --- | --- |
| `shared/cli-agents.ts`、`main/cli-agents.ts`、`agent/tools/cli-agent.ts` | `fb43002` |
| `AgentTerminal.tsx`、`docs/CLI_AGENTS.md`、`check-cli-agent.mjs`、`fixtures/fake-cli.mjs` | `fb43002` |
| `TerminalPanel.tsx`、`terminal-window.tsx`、`terminal.html` | `5601906` |
| `terminal-sessions.ts` | `4fc22de` |
| `task-worktree.ts` | `bca2f2e` |
| 右侧栏 / 面板 / 独立窗口的一串交互修复 | `30f0169` → `e626a2c` |

**计划书 V1.0 第三节把 `agent.exec`、`AgentTerminal`、`TerminalPanel`、
`Terminal Window` 写成「现有组件」，这四个全是当天新建的。** 这是原计划最严重的
事实错误。`TerminalHost`、`TerminalRouter`、`CliAdapter`、`QoderCliAdapter`
在代码里 **0 命中**，只是文档概念名——见
`ADR_CONFIG_DRIVEN_CLI_ADAPTER.md`。

### 0.2.7 本轮新增（审核后补齐）

| 能力 | 文件 | 状态 |
| --- | --- | --- |
| 脱敏（落盘/展示前） | `src/shared/redact.ts` | `IMPLEMENTED` + `TESTED` |
| 最终有效参数审批卡 | `src/agent/effective-args.ts`、`App.tsx`、`style.css` | `IMPLEMENTED` + `TESTED` |
| 版本/参数绑定能力验证 | `src/main/cli-capabilities.ts`、`cli-agents.ts`、`SettingsPanel.tsx` | `IMPLEMENTED` + `TESTED` |
| 终端审计 JSONL | `src/agent/tools/terminal-audit.ts`、`terminal.ts`、`agent-manager.ts` | `IMPLEMENTED` + `TESTED` |
| 进程状态机 | `src/shared/terminal-state.ts`、`TerminalPanel.tsx` | `IMPLEMENTED` + `TESTED` |
| 事件回放与完整性校验 | `scripts/replay-terminal.mjs` | `IMPLEMENTED` + `TESTED` |
| 关闭二次确认 / 应用退出记录 | `TerminalPanel.tsx`、`main/index.ts` | `IMPLEMENTED` |
| 配额限流错误分类 | `src/shared/cli-errors.ts`、`cli-agent.ts`、`ExecutionLog.tsx` | `IMPLEMENTED` + `TESTED` |
| 真实 CLI opt-in E2E | `scripts/spikes/cli-real-e2e.mjs` | `IMPLEMENTED` + `VERIFIED`（Qoder） |
| 结构化结果统一解析 | `src/shared/cli-result.ts` | `IMPLEMENTED` + `VERIFIED` + `TESTED` |
| 四份交付文档 + ADR | `docs/implementation/` | 本文、ADR、Spike Report、Final Report 均已齐备 |

## 3. 审核结论逐项复核

| # | 审核判断 | 代码复核结果 |
| --- | --- | --- |
| 1 | 基线错误 | ✅ 成立，且范围更宽（四个组件 + 两个不存在的类名） |
| 2 | 不增加空壳 Adapter | ✅ 成立；配置驱动链路真实存在，另补 ADR |
| 3 | UI 以侧栏/面板/独立窗口为准 | ✅ 成立；标签页布局已废弃 |
| 4 | 状态机只有 exited + exitCode | ✅ 成立；但 headless 结果里已有 `timedOut/cancelled/signal`，本轮是把这套字段接到终端会话，未新建无法观测的枚举态 |
| 5 | 审计持久化是最大缺口 | ✅ 成立；但 `trace-store.ts` 已有 JSONL 基础设施（记阶段轨迹，不含终端字节流），本轮复用其约定另建 `terminal-records`，未从零造轮子 |
| 6a | 审批卡缺有效权限 | ✅ 成立；原卡片只有 `toolLabel` + `argsPreview`，而 `agent.exec` 的 args schema 只有 `cli/task/cwd/timeoutMs` |
| 6b | 版本变化能力失效 | ✅ 成立且更严重：`headless:'verified'` 是硬编码常量，`refreshCliAgentVersions()` 全仓无调用点 |
| 6c | 配额限流分类 | ✅ 成立；原代码 0 命中 |
| 7 | 关闭确认 / 退出记录 | ⚠️ 部分成立：「关面板只 detach」已落地；「结束会话」原先无确认、`before-quit` 不写退出原因 |
| 8 | 真实 CLI E2E 未完成 | ⚠️ 需修正：Fake CLI 测试确实不能替代真实 CLI，但 **2026-11-15 的真实 Spike 做过**，结果记在 `CLI_AGENTS.md §5`（Qoder 1.1.89 / Claude 2.1.325）。缺的是独立成文与可复跑脚本，不是 Spike 本身。0.2.7 复跑后 Qoder 全通过，Claude 因外部周额度 `BLOCKED`，见 `QODER_CLI_SPIKE_REPORT.md` |

## 4. 本轮修正的三处优先级

1. **脱敏提为 P0 硬前置，排在审计落盘之前**。原代码无任何 redact，而
   `envAllowlist` 允许透传 `ANTHROPIC_API_KEY`、`stdoutTail/stderrTail` 直接进报告；
   一旦把 stdin/stderr 写进 JSONL 就有真实泄漏路径。审核结论没单列这条。
2. **版本能力不是「补一个降级」，而是当前完全没有绑定**。本轮把 verified 绑定到
   `(cliId, 语义化版本, os, 参数指纹)`，改参数只让相关能力失效。
3. **不重跑 Spike、不重建存储**：抽取既有实测记录，复用既有 JSONL 写盘约定。

## 5. Git 集成约定

- 本任务从最新 `main`（`b6b2fa7`）建独立 worktree
  `/Users/yalla/data/localLab/thinkfusion-ai-0.2.7`，分支 `0.2.7`。
- 所有改动、评审修复都留在该 worktree；不在 `main` 直接提交，不 push。
- 合并按 `AGENTS.md` 第 5 节：先本地提交并通过测试/typecheck，再由用户决定合并。
