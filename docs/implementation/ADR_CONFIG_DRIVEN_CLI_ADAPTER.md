# ADR：采用配置驱动的 CLI Adapter 架构

日期 2026-11-15 · 分支 `0.2.7` · 状态 **ACCEPTED**

## 背景

《ThinkFusion CLI 接入实施计划书 V1.0》第五节要求一个 `CliAdapter` 接口和
`QoderCliAdapter` / `ClaudeCliAdapter` / `OpenCodeCliAdapter` / `CodeBuddyCliAdapter`
四个实现，并明确写「不得把所有 CLI 的启动参数硬编码到一个通用命令生成器中」。

核对最新 `main` 的真实代码后，这个要求与实现现状不符：两个 CLI 的差异**已经**
完全由配置表达，没有需要多态分派的行为差异。为了凑出计划里的类名而新建一层
空壳接口，只会增加维护成本，还会把「配置」与「执行」两处事实来源拆开。

## 决策

**不引入 Adapter 类，维持配置驱动。** 差异留在配置与少量解析逻辑里：

| 差异 | 落在哪里 |
| --- | --- |
| 可执行文件、headless / 交互参数、权限参数、环境变量白名单 | `CliAgentConfig`（`src/shared/cli-agents.ts`）与 `DEFAULTS`（`src/main/cli-agents.ts`） |
| 装没装、什么版本、能不能用、用户开没开 | `listCliAgents()` / `cliAgentSnapshot()`（主进程） |
| 参数展开、真实进程执行、超时、进程组取消、工作区快照 | `buildArgs()` / `runCliAgent()`（`src/agent/tools/cli-agent.ts`） |
| JSON 结果里模型身份、权限拒绝、错误分类的解析 | `modelFrom()` / `denialsFrom()` / `classifyCliError()` |
| 能力结论与版本/参数的绑定 | `src/main/cli-capabilities.ts` |

能力插件的宿主分派同样按 id 查注册表（`localCapabilities.execute`），不认识任何
具体工具名；这是同一条原则在工程执行侧的体现。

## 后果

**正面**

- 新增一家 CLI = 在 `DEFAULTS`/目录里加一条配置 + 跑一次能力验证，不修改通用执行逻辑。
- 参数只有一处事实来源：审批卡展示的有效参数与真正执行的 argv 由同一份配置展开。
- 版本/参数变化能自动让相关能力失效，不必记得改一堆子类。

**代价与边界**

- **只有出现无法通过配置表达的真实差异时**才增加专用实现，且应先写一份新 ADR
  说明具体差异，不能因为「接口看起来更整齐」而抽象。
- 配置不是万能的：若某家 CLI 未来不再支持 OpenAI 风格的 `--output-format json`，
  或需要完全不同的结果协议，就属于「配置表达不了」，届时按上一条处理。
- `TerminalHost` / `TerminalRouter` / `CliAdapter` 这些名字在计划书里出现过，
  **代码里从未存在**；不要为了对齐文档把它们造出来。终端承载的真实实现是
  `src/agent/tools/terminal.ts`（PTY）+ `TerminalPanel.tsx`（面板）。

## 与能力插件的关系

CLI 接入本身**不是**能力插件目录里的条目，但 `agent.exec` 作为计划步骤工具，
必须遵守同一套登记规则：`TOOL_NAMES` 白名单、`StepSchema` 逐工具分支、
`local-plugins.ts` 注册、`CAPABILITY_CATALOG` 与 `TOOL_SPEC` 说明。少任何一处
都会出现「模型写了步骤却执行不了」。本 ADR 不改这条规则。
