# Phase 4：协作策略与结果展示

对应任务书 Phase 4（策略选择、执行模式解耦、结果展示）与 AC-01。
分支 `0.1.1`，接在 Phase 3 之后。

这一阶段的判断标准不是「多了一个下拉框」，而是**换策略之后，模型收到的要求
真的变了**。所以每个策略都落到三件可验证的事情上：每轮指令、角色分配、
先处理哪类争议。

## 交付了什么

| 文件 | 变更 |
| --- | --- |
| `src/main/debate/strategies.ts`（新增） | 六种策略的行为表：轮数、三轮指令、角色、争议优先级、做不到什么 |
| `src/main/debate/types.ts` | `DebateStrategy` 扩到六个可选值 + 两个旧名字；`DebateRole` 增 `domain_expert` / `evidence_reviewer`；默认策略改为 `truth` |
| `src/main/debate/lead.ts` | 角色由策略表决定，不再写死 `adversarial` |
| `src/main/debate/orchestrator.ts` | 把策略指令拼进 system；挑战按策略优先级排序；成本提前收尾 |
| `src/shared/conversation.ts` | `ConversationExecutionConfig.debateStrategy`（与 `executionMode`、`strategy` 三权分立） |
| `src/main/conversation-runner.ts` | 会话内辩论把选中的策略传给编排器 |
| `src/main/index.ts` | `debate:start` 接受六种策略；新增 `debate:related` 只读查询 |
| `src/shared/contracts.ts` | `DebateStrategyId`；`DebateView` 增 `judgments/evidence/disputes/revisions/metrics` |
| `src/renderer/src/components/ResearchPanel.tsx` | 六张策略卡片；成本开关；历史相似辩论；完整结果报告 |
| `src/renderer/src/components/ConversationView.tsx` | 综合卡下方显示五档结论 + 三维 + 指标 |
| `src/renderer/src/style.css` | 策略卡、结论横幅、三维小卡 |
| `scripts/check-debate-strategies.mjs`（新增） | 8 条 |

## 1. 六种策略各改了什么

| 策略 | 第一轮要求 | 质疑轮盯什么 | 角色 | 先处理的争议 |
| --- | --- | --- | --- | --- |
| `truth` 真理发现 | 先给结论，标出最强证据，推断了就说推断 | 证据链哪一环撑不住 | 主辩 / 平等 | 证据冲突 → 事实 |
| `adversarial` 对抗 | 同时给出「最可能错在哪」 | 反例与隐藏前提 | 主张 / 质疑 | 事实 → 推理 |
| `expert` 专家评审 | 说明本领域什么算证据、需要哪一级 | 证据等级有没有被高估 | 全员领域专家 | 证据冲突 → 定义 |
| `assumption` 假设审查 | 前提逐条列出并标注类型 | 哪条前提没有证据或在本题不成立 | 主辩 / 证据核对 | 范围 → 定义 |
| `solution` 方案竞争 | 两到三个候选方案逐项对比 | 漏掉的约束、失败模式、候选 | 主张 / 质疑 | 事实 → 范围 |
| `discovery` 探索发现 | 两到三个竞争假设 + 区分证据 | 哪个假设还没被检验 | 全员平等 | 事实 → 证据冲突 |

`standard` / `deep` 是 0.1.0 的名字，只用于读旧记录：行为等同真理发现的两轮
/三轮版，界面上不再提供。

## 2. 策略不改裁判口径

`judges.ts` 里**没有** strategy 参数。同一份证据换策略跑，结论必须一样——
`check-debate-strategies.mjs` 最后一条就是这么验的：truth / adversarial /
assumption 三种策略跑同一组发言，三份结论都等于 `supported`。

这不是省事，是边界：如果换个策略就能得到想要的答案，那不是在找事实，是在
调参。策略只影响「问了什么、谁来问、先问哪个」，不影响「证据够不够」。

## 3. 执行模式 × 策略：各管一件事

| 字段 | 回答的问题 | 取值 |
| --- | --- | --- |
| `executionMode` | 在哪执行 / 谁当主导人 | web / local / cloud / hybrid |
| `strategy` | 这一轮子任务怎么调度 | smart / parallel / all-selected / sequential |
| `debateStrategy` | 辩手怎么辩 | 六种策略 |
| `DebateConfig.leadMode` | 辩论由谁给基准观点 | local / web / hybrid |

四种执行模式与六种策略的所有组合都合法，没有交叉校验——它们本来就不冲突。
界面把它们分成两组控件（「执行模式」和「辩论策略」），不是一组下拉里的
两个选项。

## 4. 结果展示（任务书 13.2）

两个位置，分工不同：

- **对话里**（`DebateVerdictStrip`）：只有五档结论、三维各自一句话、可追溯率
  和轮次/耗时。对话要能读，不塞整份报告。读不到辩论就整块不显示——综合卡
  本身仍然成立。
- **研究设置 → 辩论 → 结论报告**（`DebateReport`）：结论、关键主张、证据链
  （含可点击来源）、主要分歧、反例与边界、修订记录（改之前/改之后）、
  不确定性、参考来源、质量指标。

报告里没有「综合评分」。可追溯率、无效轮次、耗时分开列：合成一个分数之后，
没人知道分数变高是因为证据变好，还是因为跑得更久。

## 5. 验证

- `npm run test:debate-strategies`，8 条：六种策略可选、旧名字分离；六种第一轮
  与质疑轮指令互不相同；角色按策略分配；争议按策略排序且不改原数组；真跑
  一场假设审查（前提清单指令、角色、决策写回）；旧名仍能跑；**同一份证据三种
  策略同结论**；执行模式四种 × 策略六种全部能归一，非法值不写入。
- `npm run typecheck`、`npm run build` 通过；`npm test` 全绿。

## 6. 已知边界

- **真机仍未跑满一场多轮辩论**：本机只有一个可用本地模型，会话内辩论会被
  如实跳过。策略差异是在脚本化的两位辩手上验证的。
- **`expert` 的「领域」由模型自称**，系统不校验资质；它只影响提问角度。
- **界面策略卡片里的说明与主进程各写一份**（渲染层不 import main），改行为
  时必须改 `strategies.ts`，界面文字不会自动跟着变。
- **结论报告读的是 `debate:list` 返回的完整状态**：辩论很多时这一屏会变重。
  目前的量级（一个人手动发起的辩论）没问题，长期要改成按需拉单场。
