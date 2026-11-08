# 专家与技能（工程空间第一意见）

> 2026-11-08，分支 `0.1.3`。用户裁决顺序：
> 「增加技能支持，像 WorkBuddy 一样，支持技能专家功能，默认是 10 年高级开发工程师那样吧」
> →「工程设计和实施的场景下增加这个技能」
> → 形态确认为「专家 + 技能文件」，触发确认为「按空间模式」；随后追问「这个是不是一个技能一个 agent」，
> 分析后定下 **一个 agent 带 N 个技能、技能不是成员**，并采纳「工程空间内再按问题区分是否加载技能」。

## 1. 先说清它是什么、不是什么

WorkBuddy 的 `senior-developer` 包里，`.codebuddy-plugin/plugin.json` 只有一个
`agents/senior-developer.md`（常驻人设），`skills/` 下三个 `SKILL.md` 是**按场景加载的工作流**，
技能没有自己的 agent。人设文件自己也写明「简单的代码编写任务不触发任何 skill」。

在 ThinkFusion 里 `agent` 这个词已经被**参与讨论的成员/通道**占用（`SubAgentPool`、
`extraAgents`、设置页「Agent 预设」）。工程空间第一意见是 `pool.ask(target.agentId, ...)`，
`planEngineeringAnswer()` 明确写了「只问一个」。所以：

- **不**给技能配独立 agent。多一个成员会破坏「只问一个」、归属规则，还会把网页通道拉进来；
  网页不收 `system`，那种做法只能把角色行塞进用户消息，正好踩中「用户原话原样发页面」的硬规则。
- 专家与技能是**内容**：往同一个本地/云端模型的 `system` 轮次里追加几行字。
  不是能力插件，不进 `CAPABILITY_CATALOG`（那边登记的是会执行、要权限、按 id 分派的能力）。

## 2. 结构

```
resources/expertise/
  EXPERT.md                              常驻人设：高级开发工程师（10 年全栈）
  skills/engineering-design/SKILL.md    工程设计与实施：frontmatter + 工作流正文
        │
        ├── src/main/expertise/frontmatter.ts   只解析 key: value / 块标量，不装 YAML 库
        ├── src/main/expertise/loader.ts        内置目录 + userData 覆盖，写坏明确报错
        ├── src/main/expertise/trigger.ts       纯规则判定这一问要不要加载技能
        ├── src/main/expertise/system.ts       唯一拼装 system 的地方
        ├── src/main/expertise/store.ts        开关落 expertise.json
        └── src/shared/expertise.ts            界面清单契约（两个 id、来源、可替换路径）
```

- 内置目录两个候选：开发态 `app.getAppPath()/resources/expertise`，打包后
  `process.resourcesPath/expertise`（`extraResources` 已登记）。
- 用户覆盖目录：`userData/expertise/`，同名文件优先。**用户文件一旦存在就只用它**：
  frontmatter 坏了 / 正文空 / 超过 20000 字都明确报错并且不注入，不静默退回内置——
  否则界面看着像替换生效了，实际注入的还是旧内容。
- 每次提问重新读盘，改完 md 不用重启应用。

## 3. 触发：为什么不是「进工程空间就全量注入」

最初倾向工程空间恒常加载，后来改判。工程空间里也有一类真机反复验证过的问题：
「这个文件多少行」「出现了多少次 stream」「对标签进行统计」
（s20 / s21 / s24 的本地读文件验收）。若在它们的 `system` 里塞进
「先给执行计划、写→验→报、交付清单」，本地 14b 很可能回一段任务分解而不是 664 行。

`src/main/expertise/trigger.ts` 用规则、不调模型，顺序是：

1. **纯事实题优先出局**：命中「多少行 / 统计 / 第几行 / 报错 / 查一下…」且没有实施动作词 → 不加载；
2. 复用 `classifyDecision`（用户裁决过、有测试守着的那套口径）：决策 / 取舍 / 迁移 / 选型 → 加载；
3. 补上 `classifyDecision` 不覆盖的实施动作词（设计 / 实现 / 重构 / 修 / 怎么改…）→ 加载；
4. 其余 → 不加载。

专家人设仍然常驻工程空间，但它的正文第一条就写明「证据纪律优先，纯事实题直接给结论，
不展开方案或流程」；流程性内容只在技能正文里。这样读数题受的是温和的人设影响，
设计实施题才拿到完整工作流。

## 4. 边界（每条都有测试守着）

| 边界 | 落法 |
| --- | --- |
| 用户原话原样 | `buildEngineeringAnswerQuestion()` 没改；专家/技能只追加到 `system` |
| 网页通道不碰 | 网页不收 `system`；工程空间第一意见本来也不发网页 |
| 知识空间零改动 | `buildEngineeringExpertise()` 在 `workspaceMode !== 'engineering'` 时返回空 |
| 不复活固定提示词 | 没有 `src/shared/prompts.ts`；`check-prompt-policy` 继续全绿 |
| 不新增成员 | 注入点只有 `conversation-runner.ts` 一处 `system: [...engineeringAnswerSystem(), ...expertise.system]` |
| 汇总 / 交锋 / 裁决 | 完全不碰 |

只有技能真的加载时才写一条系统消息（`已加载技能「…」：…`），读数题保持原来的安静。

## 5. 设置页

「设置 → 专家与技能」按「专家 / 技能」两组列出 2 条，每条显示 id、说明、触发 /
不触发场景、来源（内置 / 用户替换）、版本、正文字数、生效文件与**可替换路径**，
并带独立开关。开关落 `userData/expertise.json`，只记被停用的；文件坏了当全开。

与「内置插件」页分开：那边是执行能力，这里是模型读到的工作准则。

## 6. 验证

- `scripts/check-expertise.mjs`（17 条）：frontmatter 解析、用户覆盖、坏文件降级、
  读数题不加载 / 设计实施题加载、知识空间返回空、停用的组合、question 与基础 system
  的防回归断言、注入点唯一、开关落盘与重启读回、清单契约。
- 全量 `npm test` 叠加这 17 条；`npm run typecheck` 三套、`npm run build` 通过。
- 真机 s32a **16/16**：清单 2 条、两份内置文件真的从磁盘读到、开关回显、
  设置页 2 行 2 开关与分组标题、测后 `expertise.json` 为 `{"disabled":[]}`。
- 真机 s32b **10/10**：工程空间真发两条问题。读数题 44s 答「664行」且没有加载技能，
  答案与 s21/s24 一致；设计题 68s 系统消息写出「已加载技能…」，回答按技能正文的
  Phase 1（任务理解与规划 → 执行计划 → 任务分解）展开。两条都没发网页第二意见，
  测试会话已删、侧栏只剩用户自己的两条。详见验收报告第 14 节。

## 7. 刻意不做

- 不做多技能调度引擎、不开放第三方技能市场、不让模型自己挑技能（多一次生成且不可控）。
- 不按问题意图跨到知识空间：知识空间仍按硬规则问所有已开启网页通道。
- 不把专家/技能登记成能力插件：它们不执行动作、不需要权限、也不该被 `CapabilityRegistry.execute` 分派。
- 触发词表是规则，不是完备的自然语言理解；边界模糊的问句以「宁可不加载」为准，
  因为漏加载只是少一段工作准则，误加载会把确定性读数题带偏。
