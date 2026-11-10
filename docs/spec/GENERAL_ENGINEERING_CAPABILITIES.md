# 通用工程能力：整体设计

> 2026-11-10。设计对象是工程空间里的**通用工程能力层**：读代码、改代码、调试、测试、
> 写文档、数据脚本、前端、审阅。
>
> 相关文档：[ARCHITECTURE](../ARCHITECTURE.md)（五层）、
> [CAPABILITY_PLUGINS](../implementation/CAPABILITY_PLUGINS.md)（61 个能力插件）、
> [ENGINEERING_ROUTING](../implementation/ENGINEERING_ROUTING.md)（谁判路由）、
> [ENGINEERING_READ_TOOLS](../implementation/ENGINEERING_READ_TOOLS.md)（模型自己读文件）、
> [ENGINEERING_EXPERTISE](../implementation/ENGINEERING_EXPERTISE.md)（专家与技能）。
>
> 本文只回答「通用能力怎么组织、怎么判定、怎么证明」；逐期改动见
> [GENERAL_ENGINEERING_ROLLOUT](../implementation/GENERAL_ENGINEERING_ROLLOUT.md)。

## 0. 一句话结论

> 通用能力不是再新增一路「能力路由模型」，而是把已有的 61 个能力按**八类工程活动**归族，
> 每族带一条能跑的判据；一次任务属于哪几族，由**计划里的工具序列反推**，
> 不由请求前的自我声明决定。

## 1. 原来错在哪

四件事，按影响从大到小：

| # | 现状 | 后果 |
| --- | --- | --- |
| 1 | 能力清单是**工具清单**：`fs.edit`、`git.diff`、`sqlite.query`……61 条，全是操作系统式动词（`src/shared/capabilities.ts`） | 设置页能看见「能执行什么操作」，看不见「能承担什么工程活动」。用户问「你能调试吗」没有可查的答案 |
| 2 | 工作流只有一份：`resources/expertise/skills/engineering-design/SKILL.md`，45 行、三阶段通用流程 | 设计/实现有流程；调试、审阅、数据、前端靠模型自由发挥。真机表现是「改完不跑测试就宣布完成」「审阅把 diff 念一遍」 |
| 3 | 判据写在提示词句子和 `ruleReview` 的 issue 文案里（`src/main/engineering/review.ts`） | 「改了文件必须有 `test.run`」只在执行后作为一句话出现，不拦任何东西，也不进计划门禁 |
| 4 | 读工具一次回答最多请求一次（`engineeringToolSystem()` 明写「一次回答最多请求一次」） | 跨文件定位要「读 A → 发现 B → 再读 B」时必须靠用户催第二轮。不是能力不够，是预算没设计 |

共同点：**能力都在，但缺了「活动」这一层**。工具是动词，工程活动是「完成一件可验收的事」，
两者之间没有模型。缺了这层，能力就只能按工具名被记住，不能按场景被调用、被检查、被关闭。

## 2. 三层模型

```
能力族 family (8)
   └── 能力项 item (每族 1–3 条，带触发词与判据)
          └── 工具 tool (现有 61 个，id 一个不改)
```

一条能力项固定包含七个字段：

```ts
interface EngineeringCapability {
  id: string;              // 稳定 id，如 'code.change'
  family: FamilyId;        // 所属族
  goal: string;            // 这件事「做完」是什么样，一句话
  tools: ToolName[];       // 会用到的工具；可以重叠，族不互斥
  preconditions: string[]; // 下结论前必须已经拿到的事实
  outputs: string[];       // 产出物：文件 / 报告 / 命令输出
  antiPatterns: string[];  // 明确不做的事
  acceptance: string[];    // 验收判据，必须是能跑或能查的
}
```

三条硬约束，缺一条就不算能力项：

1. **判据可执行。** 验收必须是命令与退出码、文件与行号、diff 非空这一类；「质量良好」
   「逻辑清晰」不是判据。
2. **证据可追溯。** 结论里每条断言能指回 `(path, line)` / `(command, exitCode)` / `(url)`。
   指不回去就只能写「无法确定」。
3. **可按族关闭。** 停用一族后退回「只读分析」，并明确说出来；不允许降到半套流程还假装完整。

能力族的划分只按**用户能说出口的活动**，不按代码模块、不按进程边界。所以 61 个工具会跨族复用
（`fs.readFile` 同时属于读、调试、审阅），这是对的，不做互斥校验。

## 3. 八族总表

| 族 | 活动 | 主要工具（真实 id） | 必备证据 | 典型反模式 |
| --- | --- | --- | --- | --- |
| `code.read` | 读懂代码 | `fs.tree` `fs.search` `fs.find` `fs.stat` `fs.readFile` `project.outline` `project.dependencies` `git.status` `git.diff` `git.log` `git.show` `json.query` | 路径:行号；计数类要给真实行数/字节数 | 拿关键词命中的片段当「工程全貌」；附件被截断还报总数 |
| `code.change` | 改代码 | `fs.edit` `fs.applyPatch` `fs.writeFile` `fs.move` `fs.copy` `fs.remove` `git.worktree` `test.run` | diff + 测试退出码；写入后回读 | 一次改十个文件说「应该可以」；测试红了继续下一步 |
| `debug` | 调试定位 | `fs.search`（报错串）`fs.readFile` `git.log` `git.diff` `test.run` `shell.run` `process.list` `port.list` | 复现命令 + 退出码 → 根因行 → 修复 → 复跑 | 连续三次盲改；把「不报错了」当「修好了」 |
| `test` | 测试验证 | `test.run` `code.run` `fs.readFile`（读现有测试风格）`text.diff` | 命令 + 退出码 + 用例数 | 为通过而写测试；改断言迁就实现 |
| `docs` | 文档说明 | `fs.readFile` `fs.writeFile` `fs.applyPatch` `git.diff` | 文档里的行为描述能对上代码位置 | 复述代码当文档；写「已支持」但代码没接 |
| `data` | 数据与脚本 | `json.query` `csv.summary` `sqlite.query` `code.run` `text.base64` `archive.list` `archive.extract` `archive.create` | 输入指纹 + 命令 + 输出摘要 | 全量读进上下文口算；不带 `LIMIT` 就跑 SQL |
| `frontend` | 前端界面 | `fs.*` `test.run` `code.run` `screen.capture` `window.list` | 构建退出码 + 截图或可复现步骤 | 只改样式不验证布局；只说「应该没问题」 |
| `review` | 审阅风险 | `git.diff` `git.show` `fs.readFile` `text.diff` `project.outline` | 每条意见指到行 + 触发条件 | 把 diff 念一遍；提「建议加注释」这类无风险意见 |

### 3.1 `code.read` 读懂代码

- **做完的样子**：能回答「有什么 / 在哪 / 谁用谁 / 改它会波及什么」，并给出可点回去的位置。
- **前置事实**：读过的文件清单；计数类问题的真实统计来源（`fs.stat` 的 `lines` / `bytes`）。
- **反模式**：把 `project.outline` 的正则识别结果说成 AST 结论（`engineering/analysis.ts` 已经约定了
  要写明「按正则识别」，这条继续有效）；用 8 个关键词片段代替整份文件去数行数。
- **验收**：问「这个文件多少行」→ 引用 `fs.stat`；问「谁调用 X」→ 给出定义处与调用处行号；
  确实没有 → 说「未找到」，不说「大概没有」。

### 3.2 `code.change` 改代码

- **做完的样子**：工作区里出现了可展示的 diff，且有一个真实检查跑过。
- **前置事实**：要改的位置读过；改动前的哈希（`fs.edit` 支持 `expectedHash`）；现有测试怎么跑。
- **反模式**：多个文件一起改完再说「应该可以」；测试失败时把断言改松；把「跳过检查」写进交付清单。
- **验收**：计划里每个写操作之后 3 步内出现一次 `test.run` 或等价的构建检查；失败即停，
  由 `review` 判「需要修复」，不自动继续。

### 3.3 `debug` 调试定位

- **做完的样子**：报告里四段齐全——复现、根因、修复、复跑。
- **前置事实**：一条能稳定复现的命令与它的退出码；报错原文（不是转述）。
- **反模式**：没有复现就开始改；同一处连改三次仍无解释；把根因写成「可能是缓存」。
- **验收**：四段里缺哪段就标「未验证」，不许只写最后一段。连续三次未解决必须停下来
  说明已试方案（`SKILL.md` 的「错误恢复」已有同样口径，这里把它变成族级要求）。

### 3.4 `test` 测试验证

- **做完的样子**：新增/修改的断言能在失败时失败、在修复后通过。
- **前置事实**：现有测试组织方式；这条测试要覆盖的那一行代码。
- **反模式**：测试里断言实现细节而不断言行为；为了让新测试过而改动旧断言。
- **验收**：报告里给出「改动前是红」的证据；做不到先红时，必须说明为什么（例如新增文件没有旧断言）。

### 3.5 `docs` 文档说明

- **做完的样子**：读者能据此复现或接手；每个路径都真实存在。
- **反模式**：把 diff 翻译成自然语言；写「已支持」而实际没接线；只写「改了什么」不写「原来错在哪」。
- **验收**：文档中引用的文件路径存在；声称的行为有代码行或测试可以指过去。

### 3.6 `data` 数据与脚本

- **做完的样子**：分析可复跑，数字有来源。
- **前置事实**：输入文件指纹（`fs.stat` 的 `sha256`）；数据规模（行数/字节数）。
- **反模式**：把十万行 CSV 读进上下文再口算；`sqlite.query` 不带 `LIMIT`；把推测当统计。
- **验收**：脚本落盘、命令可复跑、输出摘要带样本量。

### 3.7 `frontend` 前端界面

- **做完的样子**：构建通过，关键路径有截图或可复现步骤。
- **反模式**：只改 CSS 就断言「布局没问题」；在没有运行态的情况下评价交互。
- **验收**：`test.run` 的构建退出码为 0；至少一张 `screen.capture` 或一段用户可照做的验证步骤。

### 3.8 `review` 审阅风险

- **做完的样子**：至少指出一个具体输入下的错误行为，或明确「未发现阻断问题」。
- **反模式**：逐行复述 diff；只提风格；把「我看不懂」写成「有风险」。
- **验收**：每条意见带位置与触发条件；`reviewExecution` 的规则版继续只陈述能从报告读到的事实，
  不假装评了代码质量（`backend: 'rules'` 的约定不变）。

## 4. 能力从哪来：工具序列反推

### 4.1 为什么不在提问前让模型声明「这次属于哪族」

三个理由，都是实测口径：

1. **声明与行为会不一致。** 模型说「这次是调试」，计划里却一条复现命令都没有；此时该信谁？
   工具序列是事实，声明只是意图。
2. **多一次模型往返就多一种失败。** `ENGINEERING_ROUTING` 才刚把「程序猜意图」换成模型判定，
   再加一层能力路由，等于在 4 秒/15 秒的预算里再塞一次超时。
3. **纯事实题会被误套流程。** `expertise/trigger.ts` 已经踩过这个坑：给「这个文件多少行」
   套上「先给执行计划、写→验→报」，本地 14b 会回一段任务分解而不是 664。

### 4.2 反推规则

`deriveCapabilities(plan)` 是纯函数，输入 `AgentPlan`，输出族集合与主族：

| 优先级 | 触发条件 | 主族 |
| --- | --- | --- |
| 1 | 计划含写工具（`fs.writeFile` / `fs.edit` / `fs.applyPatch` / `fs.move` / `fs.copy` / `fs.remove`） | `code.change` |
| 2 | 计划含 `test.run` 且无写工具 | `test` |
| 3 | 计划只含读工具且问题是事实题（命中 `FACT_ONLY` 且无 `WORK_VERBS`） | 族为空，直接回答 |
| 4 | 计划含 `shell.run` + 报错串搜索 / 日志读取 | `debug`（与 1、2 同时成立时仍以 1 为主族） |
| 5 | 其余含读工具 | `code.read` |

- 派生结果**只用于**三处：计划门禁（第 6 节）、界面显示「这次在做什么」、度量。
  它不改执行顺序，不改权限，不参与选人。
- 主族决定加载哪份技能（第 5 节）；副族只影响门禁检查项。
- 纯事实题短路的判定直接复用 `trigger.ts` 的 `FACT_ONLY`，不新写一套词表——那套词表已经被
  s20 / s21 / s24 的真机验收校准过。

### 4.3 反推的代价与缓解

事后才知道族归属，意味着「计划错了才发现要补流程」。缓解点在 `plan-review`
（`shouldDebatePlan` 之前）：计划生成后、执行前跑一次 `checkPlanCapabilities`，
缺判据就在这里拦下并说明，而不是执行完再报 issue。

## 5. 技能加载：一族一份技能

现状是一份 `engineering-design` 技能，覆盖设计/实现/改造。目标形态：

```
resources/expertise/
  EXPERT.md                        常驻人设（不改）
  skills/
    engineering-design/SKILL.md    设计/实现/改造（保留，扩写交付判据）
    engineering-debug/SKILL.md     复现→根因→修复→复跑
    engineering-review/SKILL.md    正确性优先的审阅顺序
    engineering-data/SKILL.md      指纹、样本量、可复跑
```

前端与文档暂不单独开技能，合并进 `engineering-design`：它们的流程与「写→验→报」同构，
拆开只会让 system 变长、触发更难解释。技能目录数量与族数量不强制一一对应，这是有意的。

加载规则（顺序固定，任一命中即停）：

1. 事实题且无实施动作 → 不加载（沿用 `trigger.ts` 现有优先出局）；
2. 计划主族是 `debug` → `engineering-debug`；
3. 计划主族是 `review` → `engineering-review`；
4. 主族是 `data` → `engineering-data`；
5. 其余 → `engineering-design`；
6. 一次最多一份，正文合计不超过现有的 20000 字上限。

不变的三条边界（`expertise/system.ts` 已写明，继续有效）：只在工程空间返回；只拼 `system`，
不碰 `question`；网页通道收不到 `system`，所以天然只影响本地/云端第一意见。

## 6. 证据账本与结论规则

### 6.1 三种可验证事实

```ts
type EvidenceRef =
  | { kind: 'file'; path: string; line?: number; sha256?: string }
  | { kind: 'command'; command: string; exitCode: number | null; at: number }
  | { kind: 'url'; url: string; fetchedAt: number };
```

- **读到过**：`file`，行号可选（计数类必须带 `sha256` 或 `lines`）。
- **跑过**：`command`，没有退出码（后台作业/超时）就记 `null`，不能当成成功。
- **改过**：`file` + 写前写后哈希，或一条非空 diff。

### 6.2 三个校验点

| 时机 | 校验 | 失败时的行为 |
| --- | --- | --- |
| 计划生成后、执行前 | `checkPlanCapabilities`：主族要求的判据是否在计划里（写操作有没有配测试、调试有没有复现步） | 拦下计划，列出缺哪一条，给「按现状执行」与「补计划」两个选择 |
| 执行后 | `ruleReview` 扩写：除「写文件没配 `test.run`」，增加「测试红」「后台作业当成功」 | 产出 `needsFix`，不自动改 |
| 回答前 | 引用检查：结论里的每条断言能否落到账本 | 落不到的断言降级成「未验证」或删除，不静默保留 |

### 6.3 措辞规则（`AGENTS.md` 第 3 条的落地）

| 看到的事实 | 能说 | 不能说 |
| --- | --- | --- |
| 只有一个通道回答 | 「只有一个通道给出了回答」 | 「多数通道认为」 |
| 三个通道答案一致 | 「三个通道给出了相同结论」 | 「几乎没有重合」 |
| 页面结构没识别出来 | 「没找到回答区域」 | 拿侧边栏/推荐位文字冒充回答 |
| 读到了文件但没跑测试 | 「改动已写入，未验证」 | 「已修复」 |
| 后台命令还在跑 | 「命令已启动，结果未出」 | 「命令执行成功」 |

## 7. 权限与拒绝

族不改变权限，只声明「这一族通常需要什么」：

| 族 | 至少需要的权限 | 达不到时 |
| --- | --- | --- |
| `code.read` `review` `data`（只读查询） | `read-only` | 直接报错，说明缺哪个授权 |
| `code.change` `test` `docs` `frontend` | `workspace-write` | 拒绝写，但允许给 diff 让用户自己应用 |
| `debug` 里的进程/端口操作 | `read-only` | 可以看，不能杀 |
| `debug` 里的强杀 | `danger-full-access` | 必须用户显式确认 |

强制点不变：`assertGrant` / `resolveGrantedPath` 在每一步执行时判，插件清单里的 `permission`
只是展示。任何「按族取消权限检查」的改法都不接受。

## 8. 非目标

- 不做完整的通用 coding harness：不引入 AST、向量库、全量调用图（沿用 `analysis.ts` 的边界）。
- 不新增一路「能力路由」模型调用；能力由计划反推。
- 不开放第三方插件、不做运行时下载（沿用 `CAPABILITY_PLUGINS` 决定）。
- 不为了「像 agent」而把技能配成独立成员：技能是内容，不是 `SubAgent`。
- 不给网页通道加任何 `system`，不往用户提问里拼话术（`test:prompt-policy` 守着）。
- 不自动修：`review` 只产出问题与建议，是否重修由用户确认。

## 9. 成功判据

| 指标 | 目标 | 怎么量 |
| --- | --- | --- |
| 工具归族覆盖率 | 100%，孤儿 0 | `test:engineering-capabilities` 扫 `TOOL_NAMES` |
| 主族 `code.change` 的计划中带真实检查的比例 | 100% | 门禁拦截日志 + 场景回放 |
| 结论可追溯率 | 抽样 ≥ 90% | 场景回放的引用检查 |
| 事实题被误加载技能的比例 | 0 | `trigger` 单测 + s20/s21/s24 回放 |
| 真机回归场景通过数 | 只增不减 | `test:engineering-scenarios` |

指标全部来自可跑的检查或回放，不靠人工打分。

## 10. 与现有实现的关系

| 现有东西 | 这次怎么用 | 改不改 |
| --- | --- | --- |
| `src/shared/capabilities.ts`（61 条） | 工具表是族的输入；不改 id | 不改 |
| `src/shared/contracts.ts`（`TOOL_NAMES` / `READ_ONLY_TOOLS`） | 归族扫描的唯一来源 | 不改 |
| `src/main/engineering/analysis.ts` | 读族的结构事实来源，保留「按正则识别」的声明 | 不改 |
| `src/main/engineering/review.ts` | 证据账本的执行后校验点 | 扩写 |
| `src/main/engineering/plan-review.ts` | 执行前门禁挂在这里 | 扩写 |
| `src/main/expertise/trigger.ts` | 事实题短路 + 技能选择 | 扩写 |
| `src/main/expertise/system.ts` | 唯一拼 `system` 的地方 | 不改语义，只加技能来源 |
| `src/main/research/engineering-round.ts` | 读工具回环；预算从「一次」放开到按族配额 | 改一处常量 |
| `src/main/execution/policy.ts` | 选人，与族无关 | 不改 |
| `src/shared/evidence.ts` | 页面引用与正文指纹，**不并入**执行证据 | 不改 |
| 新增 `src/shared/engineering-evidence.ts` | 执行证据账本（file / command / url） | 新建 |
