# 通用工程能力：实施

> 配套设计：[GENERAL_ENGINEERING_CAPABILITIES](../spec/GENERAL_ENGINEERING_CAPABILITIES.md)。
> 四期，每期独立可回滚、独立提交。原则：**先观测，再门禁，最后才升温流程**——
> 顺序反了就会变成「加了流程但没人知道它拦了什么」。
>
> 全程不改工具 id、不改 `desktop-agent/v1` 的既有字段含义、不往用户提问里拼话术。

## 0. 现状差距矩阵

| 族 | 工具齐不齐 | 有没有工作流 | 缺口 |
| --- | --- | --- | --- |
| `code.read` | 齐（12 个） | 有：`engineeringToolSystem` 的读回环 | 一次只许读一个；没有「读够没够」的判据 |
| `code.change` | 齐（8 个） | 部分：`engineering-design` 的写→验→报 | 测试是否必须跑，只在 `ruleReview` 事后提，不拦 |
| `debug` | 齐（8 个） | **没有** | 没有复现前置；没有「三次未解决就停」的执行侧约束 |
| `test` | 齐（4 个） | **没有独立流程** | 不要求先红；不区分「跑过」与「通过」 |
| `docs` | 齐（4 个） | 混在 design 里 | 不校验文档引用的路径是否真实存在 |
| `data` | 齐（8 个） | **没有** | 没有输入指纹；没有样本量要求 |
| `frontend` | 齐（`fs.*` + 4 个验证类） | 混在 design 里 | 不要求构建证据或截图 |
| `review` | 齐（5 个） | 有 `reviewExecution`（规则版） | 只查「写没配测试」，不查「审阅意见有没有落点」 |

八族里 4 族有支撑但没流程，2 族完全没有流程，2 族只有事后一句 issue。P0–P4 按这个顺序补。

## 1. P0 · 能力清单与孤儿扫描（只读，不改行为）

**目标**：让「有哪些工程能力」变成一份可查、可测的数据，先不改任何执行路径。

**新增** `src/shared/engineering-capabilities.ts`（纯数据 + 纯函数，无副作用）：

```ts
export const FAMILIES = ['code.read','code.change','debug','test','docs','data','frontend','review'] as const;

export interface EngineeringCapability {
  id: string;
  family: (typeof FAMILIES)[number];
  goal: string;
  tools: string[];          // ToolName 或主进程能力 id
  preconditions: string[];
  outputs: string[];
  antiPatterns: string[];
  acceptance: string[];
}

export const ENGINEERING_CAPABILITIES: EngineeringCapability[];

/** 工具 → 族。一个工具可以属于多族。 */
export function familiesOfTool(id: string): string[];
```

**改动点**：

| 文件 | 改动 |
| --- | --- |
| `src/shared/engineering-capabilities.ts` | 新建；八个族、每族 1–3 条能力项，字段照设计文档第 2 节 |
| `scripts/check-engineering-capabilities.mjs` | 新建：扫 `TOOL_NAMES` + 主进程 5 个 id，断言每个都至少归一族；断言族 id 全部在 `FAMILIES` 里；断言每条能力项都有非空 `acceptance` |
| `package.json` | 加 `test:engineering-capabilities`，并接进 `test` 链（放在 `test:capabilities` 之后） |

**验收**：

```
npm run test:engineering-capabilities      # 孤儿工具 0，空判据 0
npm run typecheck                          # 三份 tsconfig 全过
```

**回滚**：这一期不参与运行时，删文件即可。

**刻意不做**：不往 `CAPABILITY_CATALOG` 里加东西。族是活动分类，不是插件；
混进插件清单会让设置页出现两套互相对不上的名字（`CAPABILITY_PLUGINS` 第 2 节的教训）。

## 2. P1 · 执行证据账本（写进去，但先不判）

**目标**：执行结束后，能把「读到过 / 跑过 / 改过」落成结构化记录。这一期只记录、只展示，
不改变任何结论。

**新增** `src/shared/engineering-evidence.ts`：

```ts
export type EvidenceRef =
  | { kind: 'file'; path: string; line?: number; sha256?: string; lines?: number }
  | { kind: 'command'; command: string; exitCode: number | null; at: number; timedOut?: boolean }
  | { kind: 'url'; url: string; fetchedAt: number };

export interface EvidenceLedger {
  refs: EvidenceRef[];
  /** 由计划反推的主族，用于界面显示「这次在做什么」。 */
  primaryFamily?: string;
}
```

**改动点**：

| 文件 | 改动 |
| --- | --- |
| `src/shared/engineering-evidence.ts` | 新建 |
| `src/shared/contracts.ts` | `ExecutionReport` 增加**可选**字段 `evidence?: EvidenceLedger`；不设默认值，老报告读进来没有这个字段 |
| `src/agent/step-approval.ts` 或步骤执行收口处 | 步骤完成后把 `fs.*` 的路径/哈希、`test.run` / `shell.run` 的退出码记进账本 |
| `src/main/engineering/review.ts` | 读账本：`command` 退出码非 0 或 `timedOut` 才判失败；`exitCode === null` 且不是后台作业，标「结果未出」 |
| `src/renderer`（执行报告区） | 展示「证据 N 条」，按 kind 分组；无账本时显示「未记录」（不伪装成 0） |

**兼容**：字段可选、读到缺失就退回现有行为；落盘的会话 JSON 不需要迁移。

**验收**：

```
npm run test:execution          # 老报告仍能解析
npm run test:engineering        # ruleReview 行为不变
```

## 3. P2 · 技能包按族拆分

**目标**：调试、审阅、数据各有一份自己的流程；一次只加载一份。

**新增**（resources，不进 `src`）：

```
resources/expertise/skills/engineering-debug/SKILL.md
resources/expertise/skills/engineering-review/SKILL.md
resources/expertise/skills/engineering-data/SKILL.md
```

frontmatter 照 `engineering-design` 的格式：`name / kind / title / version / description /
trigger / do_not_trigger / applies_to`。`do_not_trigger` 必须写明事实题（多少行、统计、报错在哪），
否则 `trigger.ts` 的事实短路会被绕过。

**改动点**：

| 文件 | 改动 |
| --- | --- |
| `src/main/expertise/trigger.ts` | 新增 `familyForSkill(plan)`：先用 `FACT_ONLY` 短路，再按主族选 `engineering-debug` / `engineering-review` / `engineering-data`，缺省 `engineering-design` |
| `src/main/expertise/system.ts` | 仍然只拼一段；断言 `loaded.length <= 1`，多于一份直接报错 |
| `src/main/expertise/index.ts` | 技能清单增加三个 id（`shared/expertise.ts` 的 `ExpertiseId` 同步） |

**不改**：`EXPERT.md` 不变，仍是工程空间常驻人设；网页通道仍然收不到任何 `system`。

**验收**：

```
npm run test:expertise          # 新增：纯事实题不加载、调试题只加载 debug、一次最多一份
npm run test:prompt-policy      # 技能正文在 resources/，不得出现在 src/shared/prompts.ts
npm run test:engineering-round  # 第一问/第二问的 question 未被改写
```

**风险**：技能正文变长会挤压本地小模型的输出预算。每份控制在 1500 字以内，
超出时优先删「代码自检」这类通用条目，不删判据。

## 4. P3 · 计划门禁：把判据从文案变成拦截

**目标**：计划生成后、执行前，检查主族的判据是否具备；缺了就拦，并说清缺哪条。

**改动点**：

| 文件 | 改动 |
| --- | --- |
| `src/main/engineering/plan-review.ts` | 新增 `checkPlanCapabilities(plan): { ok: boolean; missing: string[]; family: string }`：`code.change` 必须有写工具 + `test.run`；`debug` 必须有复现命令（`shell.run` / `test.run`）或报错串搜索（`fs.search`）；`review` 必须只有读工具；`data` 必须带输入读取步 |
| 调用点（`conversation-runner` 的计划分支） | 在 `shouldDebatePlan` **之前**跑；不 ok 时把 `missing` 作为计划提示交给用户选择「补计划」或「按现状执行」 |
| `src/renderer` 计划预览 | 显示主族与缺失项；「按现状执行」后，结论里固定标「未验证」 |
| `src/main/engineering/review.ts` | 执行后再查一次：计划声称满足的门禁，实际是否执行到（防止计划里有 `test.run` 但被判失败/跳过） |

**这一期的红线**：门禁**不是权限**。它不阻止用户执行，只阻止系统在缺判据时
把结果说成「已验证」。所以文案必须是「缺少 X，执行后不会标已验证」，不是「已被拒绝」。

**验收**：

```
npm run test:plan-review        # 新增 4 条：缺测试拦、调试无复现拦、审阅含写工具拦、正常计划放行
npm run test:engineering-orchestration
```

## 5. P4 · 场景回放与度量

**目标**：指标能自动跑，不靠人工打分。

**新增**：

```
scripts/scenarios/engineering/read-line-count.json    s20 类：这个文件多少行
scripts/scenarios/engineering/read-keyword.json       s21 类：出现了多少次
scripts/scenarios/engineering/write-with-test.json    写文件 + 跑测试
scripts/scenarios/engineering/debug-red-test.json     测试红 → 定位 → 修 → 复跑
scripts/check-engineering-scenarios.mjs               离线回放：喂固定回答，断言族判定与门禁结论
```

**改动点**：

| 文件 | 改动 |
| --- | --- |
| `src/shared/trace.ts` | trace 事件增加可选 `capability?: { family: string; derived: true }`，只记不驱动 |
| `scripts/check-engineering-scenarios.mjs` | 新建；`npm run test:engineering-scenarios` |
| `package.json` | 接进 `test` 链末尾 |

**验收**：

```
npm run test:engineering-scenarios   # 5 个场景全过
npm test                             # 全链路，含既有 60+ 个 check
```

**度量口径**（与设计文档第 9 节一一对应）：工具归族覆盖率、`code.change` 计划带测试比例、
结论可追溯率、事实题误加载率、场景通过数。每项都能从上述测试或 trace 里直接读出来。

## 6. 分期依赖与提交

| 期 | 依赖 | 改动范围 | 单独可回滚 |
| --- | --- | --- | --- |
| P0 | 无 | `shared` 新增 + 一个脚本 | 是 |
| P1 | P0（族 id） | `shared` + agent 收口 + review + 渲染 | 是（字段可选） |
| P2 | P1（主族来源） | `resources` + `expertise` 三个文件 | 是（退回单技能） |
| P3 | P1、P2 | `plan-review` + runner + 渲染 | 是（门禁开关置 false） |
| P4 | P0–P3 | 脚本 + trace 可选字段 | 是 |

提交信息按仓库规矩写「原来错在哪」，例如：

```
P0 通用工程能力：能力清单只有工具名，没有活动这一层

原来设置页只能看到 fs.edit、git.diff 这类操作名，工程空间实际承担的设计、调试、
审阅活动没有任何清单可查，测试也无法断言某个工具没有归属。现在按八族登记能力项，
孤儿工具 0，判据全部可执行。
```

## 7. 验收清单（合并前全跑）

```
npm run typecheck
npm run test:engineering-capabilities
npm run test:evidence            # P1 新增
npm run test:expertise
npm run test:plan-review
npm run test:engineering
npm run test:engineering-round
npm run test:engineering-tools
npm run test:engineering-orchestration
npm run test:engineering-scenarios
npm run test:prompt-policy
npm test
```

真机（至少一台本地 14b + 一个云端模型）：

1. 「这个文件多少行」→ 直接给行数，不出现执行计划，不加载技能；
2. 「把 X 改成 Y」→ 计划里有 `test.run`，缺了会被门禁点名；
3. 「这个测试红了，查原因」→ 走 `engineering-debug`，报告四段齐全；
4. 「审一下这次改动」→ 意见带文件行号，不逐行复述 diff；
5. 「统计这份 CSV」→ 给样本量与指纹，不整份读进上下文。

## 8. 已知风险

| 风险 | 表现 | 处置 |
| --- | --- | --- |
| 门禁文案被读成「系统拒绝执行」 | 用户以为不能跑 | 文案固定为「执行后不会标已验证」；保留「按现状执行」 |
| 主族反推偏 `code.change` | 只读任务被套上测试要求 | 事实题在 P0 的 `deriveCapabilities` 里先短路，P2 再加一层技能层的 `FACT_ONLY` |
| 技能包膨胀 | 本地 14b 回流程不复述结论 | 每份 ≤1500 字；`test:expertise` 断言总字数上限 |
| 证据账本字段影响老会话 | 旧 JSON 解析失败 | 字段一律可选，读取处用 `?? []`；`test:runner` 覆盖老报告 |
| 场景回放与真机漂移 | 脚本过、真机错 | 场景只断言族判定与门禁，不 pretend 模型输出；真机清单第 7 节每期手跑一次 |
