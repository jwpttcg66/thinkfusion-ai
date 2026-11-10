# 通用工程能力：实施

> 配套设计：[GENERAL_ENGINEERING_CAPABILITIES](../spec/GENERAL_ENGINEERING_CAPABILITIES.md)。
> 六期，每期独立可回滚、独立提交。顺序原则：**先登记，再观测，再门禁，最后补缺口**——
> 反过来会变成「加了流程但没人知道它拦了什么」，或者「补了工具但没人知道它属于哪类」。

## 0. 分期总览

| 期 | 状态 | 内容 | 对应设计章节 | 产出 |
| --- | --- | --- | --- | --- |
| P0 | ✅ 已落地 | 冻结 dsh 76 条清单 + 本机 62 条归族，覆盖率测试 | §2–§5 | `dsh-tools.ts`、`engineering-capabilities.ts`、两个 check 脚本 |
| P1 | 未开始 | 执行证据账本（只记录，不判定） | §8 | `engineering-evidence.ts`、`ExecutionReport.evidence` |
| P2 | 未开始 | 技能包按族拆分 | §7 | 3 份新 `SKILL.md`、`trigger.ts` 改族选择 |
| P3 | 未开始 | 计划门禁（缺判据不许标「已验证」） | §8.2 | `checkPlanCapabilities` + 界面提示 |
| P4 | 未开始 | 场景回放与度量 | §11 | 5 个场景 JSON + 回放脚本 |
| P5 | 未开始 | 补齐运行时缺口（L2 中的 12 条） | §5.2–§5.6 | 提问工具、终端、诊断、会话检索、持久 shell |
| P6 | 未开始 | 治理能力 14 条 + 扩展裁决 3 条（L2 共 17） | §4、§5.4–§5.7 | 目标、定时、团队、扩展决策 |

P5/P6 是这轮新增的：上一版把「编排、扩展生态、终端、LSP」划到「不在这层」，
现在全部回到矩阵里，并给了期号。

## 1. 差距矩阵（按 §5 的层级）

| 层级 | 条数 | 分布 | 归属期 |
| --- | --- | --- | --- |
| L0 已有工具 | 17 | 文件 6、搜索 2、执行 4、作业 3、git 1、依赖 1 | 已可用，P0 只登记 |
| L1 等价机制 | 28 | 计划交互 5、委派 11、会话记忆 3、浏览器 6、插件 3 | P0 登记；P2/P3 补判据 |
| L2 待补 | 29 | 提问 1、终端 6、团队 7、目标 3、定时 4、会话检索 2、LSP 1、持久 bash 1、运行时查询 1、MCP/市场 3 | P5（12）· P6（14）· 裁决（3） |
| L3 平台不适用 | 2 | `pwsh` 两条 | 不排期，文档登记 |

L1 不是「不做」。它意味着能力已经存在，只是形态不同——比如 `working_directory`
在我们这边是会话级 `workspaceRoot`，工具层再开一个「切目录」反而会出现两套路径。
P0 的覆盖测试要求 L1 必须写「由谁承担」，写「无」直接失败。

注意 `ask_user_question` **不在 L1**：协议里的澄清只覆盖计划生成前，执行中要问用户
没有通道，所以它是 P5 要补的真工具（`ask.user`）。

## 2. P0 · 冻结清单与覆盖率（只读，不改行为）· ✅ 已落地

**落地记录（2026-11-10，提交 `d903e43` + `4692a82`）**：`src/shared/dsh-tools.ts`、
`src/shared/engineering-capabilities.ts`、两个 check 脚本与 `package.json` 的测试入口都在；
`test:dsh-coverage` 5 条、`test:engineering-capabilities` 6 条全过；`typecheck` 三份配置全过。
对账时修掉三处：能力数 61→62、`index` 的「schema 顺序」说法、L1 允许写「无」。

### 2.1 冻结 dsh 工具面

**新增** `src/shared/dsh-tools.ts`：把 `~/data/dsh-src/docs/tool-catalog.zh.md`
（提交 `ce7073d5`，0.2.2-alpha.2）的 **76 条 schema** 固化成数据，字段：

```ts
export interface DshTool {
  /** 本工程的行号，1–76；按族分组，不是 dsh 目录的 schema 顺序。 */
  index: number;
  packageName: string;   // 'dsh-tool-fs'
  tool: string;          // 'read'
  family: FamilyId;      // 我们的族
  ours: string;          // 对应物：工具 id 或机制名
  layer: 'L0' | 'L1' | 'L2' | 'L3';
  /** L1 必填：由谁承担；L2 必填：期号。 */
  note: string;
}

export const DSH_TOOLS: readonly DshTool[];
/** 同名不同包（bash/pwsh/interrupt_agent/list_agents/send_message）在这里列清楚。 */
export const DSH_UNIQUE_NAMES: readonly string[]; // 71 条
/** 同名不同包的五组（bash / pwsh / interrupt_agent / list_agents / send_message）。 */
export const DSH_DUPLICATE_NAMES: Readonly<Record<string, readonly string[]>>;
```

**新增** `scripts/check-dsh-drift.mjs`（开发期用，不进构建、不进 `test` 链）：读本地
`~/data/dsh-src/docs/tool-catalog.zh.md`（或 `DSH_CATALOG` 指定的路径），按
`(packageName, tool)` 集合与 `DSH_TOOLS` 比对，打印新增/删除的工具并以非零码退出。
升版本时先跑它，再补 `family/ours/layer/note`——**不做自动生成**，避免生成器覆盖人工判断。

**新增** `scripts/check-dsh-coverage.mjs`，断言：

1. `DSH_TOOLS.length === 76`，`index` 连续且唯一；
2. 每条 `family` 在 13 族里；
3. `layer` 合法，L1 的 `ours` 不能是「无」，L2 的 `note` 必须写期号（`P5`/`P6`/`裁决`）；
4. 每条 L0 的 `ours` 必须真的出现在 `TOOL_NAMES` 或主进程能力 id 里；
5. 71 个唯一名字、五组同名不同包的条数与包名一致。

### 2.2 本机 62 条归族

**新增** `src/shared/engineering-capabilities.ts`：

```ts
export const WORK_FAMILIES = ['code.read','code.change','debug','test','docs','data','frontend','review'] as const;
export const GOVERN_FAMILIES = ['runtime.exec','plan.control','collab.delegate','memory.context','platform.extend'] as const;

export interface EngineeringCapability {
  id: string;
  family: (typeof WORK_FAMILIES)[number] | (typeof GOVERN_FAMILIES)[number];
  goal: string;
  tools: string[];
  preconditions: string[];
  outputs: string[];
  antiPatterns: string[];
  acceptance: string[];
}

export const ENGINEERING_CAPABILITIES: EngineeringCapability[];
export function familiesOfTool(id: string): string[];
```

**新增** `scripts/check-engineering-capabilities.mjs`：13 个族每个至少一条能力项；每个
`TOOL_NAMES` + 主进程 6 个 id 至少归一族；每条能力项 `acceptance` 非空；族 id 全部合法。

**改** `package.json`：加 `test:dsh-coverage`、`test:engineering-capabilities`，接进 `test` 链。

**验收**：

```
npm run test:dsh-coverage                 # 76/76，无缺字段
npm run test:engineering-capabilities     # 孤儿工具 0
npm run typecheck                         # 三份 tsconfig 全过
```

**回滚**：不参与运行时，删文件即可。

## 3. P1 · 执行证据账本（写进去，先不判）

**新增** `src/shared/engineering-evidence.ts`：

```ts
export type EvidenceRef =
  | { kind: 'file'; path: string; line?: number; sha256?: string; lines?: number }
  | { kind: 'command'; command: string; exitCode: number | null; at: number; timedOut?: boolean }
  | { kind: 'url'; url: string; fetchedAt: number };

export interface EvidenceLedger {
  refs: EvidenceRef[];
  primaryFamily?: string;
}
```

| 文件 | 改动 |
| --- | --- |
| `src/shared/contracts.ts` | `ExecutionReport` 增加**可选** `evidence?: EvidenceLedger`，不设默认值 |
| 步骤执行收口（`src/agent/step-approval.ts` 及执行处） | 完成后记录 `fs.*` 的路径/哈希、`test.run` / `shell.run` 的退出码 |
| `src/main/engineering/review.ts` | 读账本：退出码非 0 或 `timedOut` 判失败；`exitCode === null` 且非后台作业标「结果未出」 |
| `src/renderer` 执行报告区 | 展示「证据 N 条」，按 kind 分组；无账本显示「未记录」，不伪装成 0 |

**兼容**：字段可选，老会话 JSON 不需要迁移；写入与读取都允许缺失。

**验收**：`npm run test:execution`、`npm run test:engineering`、`npm run test:runner`。

## 4. P2 · 技能包按族拆分

**新增**（`resources`，不进 `src`）：

```
resources/expertise/skills/engineering-debug/SKILL.md
resources/expertise/skills/engineering-review/SKILL.md
resources/expertise/skills/engineering-data/SKILL.md
```

frontmatter 照 `engineering-design`：`name / kind / title / version / description /
trigger / do_not_trigger / applies_to`。`do_not_trigger` 必须包含事实题（多少行、统计、
报错在哪），否则 `trigger.ts` 的事实短路会被绕过。

| 文件 | 改动 |
| --- | --- |
| `src/main/expertise/trigger.ts` | 新增 `familyForSkill(plan)`：先 `FACT_ONLY` 短路，再按主族选四份技能之一，缺省 `engineering-design` |
| `src/main/expertise/system.ts` | 仍只拼一段；`loaded.length <= 1`，多于一份直接报错 |
| `src/main/expertise/index.ts` / `src/shared/expertise.ts` | 技能 id 清单同步 |

**不改**：`EXPERT.md` 仍是常驻人设；网页通道仍收不到 `system`。

**验收**：

```
npm run test:expertise          # 纯事实题不加载；调试题只加载 debug；一次最多一份；总字数上限
npm run test:prompt-policy      # 技能正文在 resources/，不得出现在 src/shared/prompts.ts
npm run test:engineering-round  # question 未被改写
```

**风险**：技能变长会挤压本地小模型的输出预算。每份 ≤1500 字，超了删「代码自检」
这类通用条目，不删判据。

## 5. P3 · 计划门禁

`checkPlanCapabilities(plan)` 放在 `engineering/plan-review.ts`，在 `shouldDebatePlan`
**之前**跑：

| 主族 | 必须有的判据 | 缺失时的文案 |
| --- | --- | --- |
| `code.change` | 写工具 + `test.run` | 「计划里没有真实检查，执行后不会标已验证」 |
| `debug` | 复现命令（`shell.run` / `test.run`）或报错串搜索 | 「没有复现步，结论只能算猜测」 |
| `review` | 只含读工具 | 「审阅计划里包含写操作，请拆成两轮」 |
| `data` | 输入读取步（`fs.readFile` / `csv.summary` / `sqlite.query`） | 「没有输入读取，数字没有来源」 |

**红线**：门禁不是权限。它不阻止执行，只阻止系统把缺判据的结果说成「已验证」。
所以文案是「执行后不会标已验证」，不是「已拒绝」。

**验收**：`test:plan-review`（新增 4 条）、`test:engineering-orchestration`。

## 6. P4 · 场景回放与度量

**新增**：

```
scripts/scenarios/engineering/read-line-count.json
scripts/scenarios/engineering/read-keyword.json
scripts/scenarios/engineering/write-with-test.json
scripts/scenarios/engineering/debug-red-test.json
scripts/scenarios/engineering/review-diff.json
scripts/check-engineering-scenarios.mjs
```

| 文件 | 改动 |
| --- | --- |
| `src/shared/trace.ts` | trace 事件增加可选 `capability?: { family: string; derived: true }`，只记不驱动 |
| `package.json` | 加 `test:engineering-scenarios` |

**验收**：5 个场景全过；`npm test` 全链路。

## 7. P5 · 补齐运行时缺口（12 条）

按「用户真的会碰到」排序：

### 7.1 向用户提问（1 条，`plan.control`）

`ask_user_question` → `ask.user`（用户裁决：「这个是肯定需要的」）。

现有 `clarification_required` 只在计划生成前生效：模型还没动手时把问题抛回来。
执行到一半要确认（用哪个目录、要不要覆盖、两个方案选哪个）时没有通道，模型只能猜。
所以它是真工具，不是等价机制。

| 事项 | 决定 |
| --- | --- |
| 参数 | `{ question, options?, allowFreeText?, timeoutMs? }`；`question` 必填且不超过 500 字 |
| 链路 | 步骤执行 → runtime 发 `user.question` → 主进程中转 → 渲染层问题卡片 → 用户回答 → 原路返回步骤结果 |
| 返回值 | `{ answered: true, value, optionIndex? }` 或 `{ answered: false, reason: 'timeout' \| 'cancelled' }` |
| 超时 | 缺省 10 分钟；超时不算工具失败，返回 `answered: false`，模型不得替用户选 |
| 预算 | 每份计划最多 3 次；第 4 次直接拒绝并说明「请把问题合并后再问」 |
| 权限 | `read-only`（不动文件）；但会阻塞计划，必须能被用户取消 |
| 落盘 | `{question, options, answer, at}` 进会话，刷新后仍可见 |
| 复用 | 复用澄清卡片 UI 与 `awaiting_user` 状态，不新开第二种提问样式 |
| 不做 | 不向网页通道开放（收不到 `system`）；不自动超时替用户默认 |

**验收**：`test:ask-user`（新脚本）：回答后步骤继续、超时返回 `answered:false`、取消后计划停在
`awaiting_user`、第 4 次被拒、问答落盘可读。

### 7.2 终端（6 条，`runtime.exec`）

`terminal_open / read / send / signal / close / list` → 我们的 `term.open` 等 6 个 id。

| 事项 | 决定 |
| --- | --- |
| 实现 | 优先 `node-pty`（原生依赖，需先验证 `electron-builder` 打包与 arm64）；不行就退回 `script -q /dev/null sh` + 管道，只支持行模式 |
| 权限 | `open/read/close/list` 需 `workspace-write`；`send` 每次调用单独审批（等价于执行任意命令）；`signal` 需 `danger-full-access` |
| 沙箱 | 与 `shell.run` 同一条 spawn 前置沙箱；探测失败要在报告里写 `sandboxed: false`（沿用 `HARNESS_ALIGNMENT` 的口径） |
| 不做 | 不做 TUI、具名按键序列、跨会话共享终端（与 dsh 的 schema 边界一致） |
| 关闭策略 | 会话结束、应用退出、授权过期三条路径都要关；泄漏的 PTY 记进 `job.list` |

**验收**：`test:terminal`（新脚本）：开一个 shell、`echo` 回读、`signal` 后进程组消失、
关闭后 `term.list` 为空；真机跑一次 `vim` 之类全屏程序，确认「不支持」时说清楚而不是卡死。

### 7.3 语言诊断（1 条，`runtime.exec`）

`lsp` → 先做 `code.diagnostics`，不引语言服务器进程：

- 只用工程里已有的检查命令：`tsc --noEmit --pretty false`、`eslint -f json`、（可选）`ruff`；
- 输出归一成 `{path, line, severity, message, source}[]`，进证据账本（kind 用 `command`）；
- 没有可用检查器时明确报 `DIAGNOSTICS_UNAVAILABLE`，不改 schema、不假装有结果。

**后续**：真接 LSP 需要常驻进程与文件监听，单独一期，不塞进本轮。

### 7.4 会话检索（2 条，`memory.context`）

`session_event_search` / `session_search` → `session.search`：

- 只读检索 `store` 里的会话（标题、消息文本、工具名、时间范围），返回命中片段 + 会话 id；
- 权限 `read-only`，结果带命中数；0 条不算失败（沿用 `web.search` 的口径）；
- 跨会话检索意味着能把 A 会话的结论带进 B 会话——结果里必须标明来源会话与时间，
  不允许静默引用（`AGENTS.md` 第 3 条）。

### 7.5 持久 shell 与运行时查询（2 条）

- `bash`（持久）→ 由 `term.open` + `working_directory` 覆盖，不单独做工具；
- `cordis_inspect_query` → `plugin.inspect`：只读查询某个能力 id 的 `enabled/registered/权限`，
  与设置页同源（`capability-state.ts`）。

**P5 验收**：`npm run test:ask-user && npm run test:terminal && npm run test:diagnostics && npm run test:session-search`，
再把对应的 L2 在 `dsh-tools.ts` 里改成 `L0`（覆盖率测试会强制改，不改就失败）。

## 8. P6 · 治理能力（14 条）与扩展裁决（3 条）

### 8.1 目标（3 条，`plan.control`）

`create_goal / get_goal / update_goal` → 会话级 `goal`：

- 先做**状态**：`Conversation.goal = { text, status: 'active'|'paused'|'blocked'|'done', rounds }`；
- 再决定要不要给模型工具。给工具的前提是「创建/暂停/恢复必须来自用户」，
  模型只能更新进度——否则会出现模型自己改目标、自己宣布完成；
- 验收：`test:goal`：模型不能创建目标；用户暂停后计划不再自动续跑；完成必须带证据。

### 8.2 定时（4 条，`plan.control`）

`schedule_create / edit / list / view` → 本地调度器：

- 需要一个常驻调度循环（主进程），任务落 `userData/schedules.json`；
- 权限：创建要用户确认，委派子代理不能调用（dsh 同样限制）；
- 验收：`test:schedule`：到点触发一次、错过补跑一次、删除后不再触发。

### 8.3 团队（7 条，`collab.delegate`）

`spawn_teammate / team_task_create / get / list / update / wait_agent`
（`interrupt_agent` `list_agents` `send_message` 已在 L1）：

- 这是最大的一块，且与现有「辩论成员 + 执行池」有重叠。**先做任务板，不做第二套 agent 体系**：
  `team.task` 落在会话里，成员仍是 `SubAgentRegistry` 的成员；
- `wait_agent` 用现有的执行等待实现，不新开轮询；
- 前置条件：P3 门禁稳定后再开，否则团队里每个成员都会绕过判据。

### 8.4 扩展（3 条，`platform.extend`）· 需裁决

`plugin_market / list_mcp_resources / read_mcp_resource` 意味着运行时安装第三方能力，
与 2026-11-08 的「不开放第三方包、不支持运行时下载插件」直接冲突。

**本期的交付不是实现，是裁决记录**：

1. 若维持原裁决：`dsh-tools.ts` 里保持 `L2 / 裁决`，设置页写明「不支持第三方扩展」；
2. 若改为开放：先写安全评估（安装脚本、版本豁免、权限继承），再排 P7。

## 9. 兼容、提交与回滚

| 期 | 依赖 | 单独回滚 |
| --- | --- | --- |
| P0 | 无 | 删两个 shared 文件 + 两个脚本 |
| P1 | P0（族 id） | 字段可选，删字段即可 |
| P2 | P1（主族来源） | 退回单技能 |
| P3 | P1、P2 | 门禁开关置 false |
| P4 | P0–P3 | 删场景与脚本 |
| P5 | P0（映射表） | 删 `term.*` / `code.diagnostics` / `session.search` 注册 |
| P6 | P5、P3 | 目标/定时/团队各自有开关 |

提交信息写「原来错在哪」。示例（P0）：

```
P0 通用工程能力：能力清单只有工具名，dsh 76 条有一半没登记

原来设置页只能看到 fs.edit、git.diff 这类操作名，dsh 的编排、终端、扩展那半边
既没有工具也没有「为什么没有」的记录，覆盖率无法断言。现在把 dsh 76 条 schema
冻结成数据并逐条映射到 13 族，L1 写承担者、L2 写期号，测试从 0 条覆盖变成 76/76。
```

**不推送**：按仓库规矩，推送由用户执行。

## 10. 验收清单（合并前全跑）

```
npm run typecheck
npm run test:dsh-coverage
npm run test:engineering-capabilities
npm run test:evidence
npm run test:expertise
npm run test:plan-review
npm run test:engineering
npm run test:engineering-round
npm run test:engineering-tools
npm run test:engineering-orchestration
npm run test:engineering-scenarios
npm run test:ask-user
npm run test:prompt-policy
npm test
```

真机（一台本地 14b + 一个云端模型）：

1. 「这个文件多少行」→ 直接给行数，不出现执行计划，不加载技能；
2. 「把 X 改成 Y」→ 计划里有 `test.run`，缺了被门禁点名；
3. 「这个测试红了，查原因」→ 走 `engineering-debug`，四段齐全；
4. 「审一下这次改动」→ 意见带文件行号，不逐行复述 diff；
5. 「统计这份 CSV」→ 给样本量与指纹，不整份读进上下文；
6. P5 之后：「开个终端跑 npm run dev」→ `term.open` 有回读、关闭后列表为空；
7. P5 之后：「搜一下我们以前讨论过 Redis 吗」→ `session.search` 带来源会话与时间。

## 11. 已知风险

| 风险 | 表现 | 处置 |
| --- | --- | --- |
| 覆盖率变成纸面数字 | 76/76 但 L1 全是「等价机制」的空话 | `test:dsh-coverage` 强制 L1 写承担者、L2 写期号；每期把至少一条 L2 改成 L0 |
| 门禁被读成「系统拒绝执行」 | 用户以为不能跑 | 文案固定为「执行后不会标已验证」，保留「按现状执行」 |
| 主族反推偏 `code.change` | 只读任务被套测试要求 | 事实题在 `deriveCapabilities` 先短路，P2 再加技能层 `FACT_ONLY` |
| 技能包膨胀 | 本地 14b 回流程不复述结论 | 每份 ≤1500 字；`test:expertise` 断言总字数 |
| PTY 原生依赖 | `node-pty` 打包或 arm64 失败 | 先做 `script(1)` 版本，PTY 作为可选后端；失败要明说降级 |
| 团队能力与辩论重复 | 两套 agent 体系 | P6 只做任务板，成员复用 `SubAgentRegistry` |
| 提问工具被当成拖延手段 | 模型反复问、计划不推进 | 每份计划最多 3 次；合并提问；第 4 次拒绝并说明 |
| 场景回放与真机漂移 | 脚本过、真机错 | 场景只断言族判定与门禁，不 pretend 模型输出；真机清单每期手跑 |
