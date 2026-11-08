# 工程空间：默认多 agent 编排（2026-11-08 最终裁决）

## 1. 裁决与覆盖范围

用户原话：

> 工程默认改成多agent编排，优先本地和远程模型，除非采用混合模式，才可以进行网页编排。

确认时的三条推荐（用户回「那就按照你的推荐做吧」）：

| 编号 | 结论 |
| --- | --- |
| 1A | 工程空间默认把**所有可用的本地模型 + 云端模型**编入，多 agent 编排；`local`/`web`/`cloud` 三档都不按归属挑人；非 `hybrid` 一个网页都不问；只有 `hybrid` 才允许网页编排。 |
| 2A | 多个模型并行读同一份工程证据、各给一份意见；主导人汇总、指定辩题交锋、给最终意见，复用既有执行阶段。 |
| 3A | 非混合档不再单独问网页第二意见；混合档下网页作为**编排成员**进场；`webSecondOpinion` 保留但只在混合档有意义。 |

这条裁决**覆盖**同一天更早的两条工程空间规则，下面两份文档降级为历史存档：

- [ENGINEERING_MODEL_FIRST.md](./ENGINEERING_MODEL_FIRST.md)：「工程空间第一意见只问一个模型」——已废弃。
- [WEB_SECOND_OPINION.md](./WEB_SECOND_OPINION.md)：「决策类问题追加一个网页第二意见，两份并列不汇总」——已废弃。

**不受影响、一个字节都没改**：

- 知识空间（workspaceMode=knowledge）的提问链路：用户原话原样发所有已开启且页面可用的网页通道，不套角色行、不套引导语；`prompts.ts` 已删且不得再造。
- 知识空间的归属规则：[DEBATE_LEAD_MODES.md](./DEBATE_LEAD_MODES.md) 开头那节仍然最高优先级——`local` 只用本地、`web` 只用网页、`cloud` 只用远程 API、`hybrid` 先择一类再严格只用那一类。
- 工程空间的证据纪律、专家/技能加载（[ENGINEERING_EXPERTISE.md](./ENGINEERING_EXPERTISE.md)）、能力插件化（[CAPABILITY_PLUGINS.md](./CAPABILITY_PLUGINS.md)）。

## 2. 为什么工程空间要绕开归属收敛

归属规则管的是「回答**之后**由谁汇总 / 交锋 / 给最终意见」，它的前提是**第一手回答全部来自网页通道**。
工程空间不是这样：第一手回答是「读本机文件」，网页读不到（真机 s20/s21 连着两轮都是「请上传文件」）。
所以 `executionMode` 在工程空间不该决定「谁读得动文件」——`web` 档也不能因此去找网页，
`cloud` 档也不能因此把本地模型剔掉。

结论：工程空间有一套**专属**的选人规则，与知识空间的 `ownershipOf` / `debatersFor` / `planLead`
完全分开，互不调用。

## 3. 行为

### 3.1 第一轮：谁进场

| 执行档 | 第一轮成员 | 网页 |
| --- | --- | --- |
| `web` / `local` / `cloud` | 所有可用的本地模型（按注册序）+ 所有可用的云端模型（按注册序） | **零**，连 `registry.available()` 都不调 |
| `hybrid` | 同上，**加上**所有已开启且可用的网页通道 | 由 `webSecondOpinion` 决定（见 3.3） |

- **本地优先、云端补充**：名单里本地在前；主导人取第一个本地模型，用户点名了某个本地/云端模型就用它。
- **点名网页通道不能主导**：它读不到本机文件，且执行阶段用 `pool.ask` 找模型，网页 id 在那里不存在。系统消息会明写「你点名的网页通道不能主导工程汇总」。
- **本地模型逐个问，不是一起发**：这是同日真机抓到的。两个 Ollama 模型同时请求时，
  `LocalAdmission`（24GB 统一内存只允许 1 个本地推理）让第二个在 30 秒排队上限里超时，
  系统消息如实记了「本地模型正忙：生成（gpt-oss:20b） 排队超过 30 秒」，编排只剩一份回答。
  因此 `researchEngineering()` 把本地成员排成一条串行链，云端 / 网页与这条链并行发；
  「全部进场」不等于「同时占用 GPU」。回归测试用并发计数器钉住 `max === 1`。
- **只有一个可用模型也照常编排**：`debaters` 长度 1，允许自辩；不再用「不足两位辩手」跳过整场。
- **一个可用模型都没有** → 如实退回网页链路，写「本机没有可用的本地/云端模型（Ollama 未启动，或没有配 API Key）」，并提醒网页多半只能回「请上传文件」。
- **模型全失败** → 写「本机模型没有给出回答（各家原因），这一轮改问网页通道」，不假装答过。

### 3.2 材料：两条消息，同一形状

- 模型成员：`buildEngineeringAnswerQuestion(question, material)` = `【用户的问题】\n用户原话` + 完整工程证据；
  `system` = 三条证据纪律 + （按场景加载的）专家/技能段。**question 一个字不改**。
- 网页成员（仅混合档）：`buildWebOrchestrationQuestion(question, material)` = 用户原话 + `secondOpinionExcerpt(material)`，
  证据按 6000 字摘录并标明「以上是摘录」。**不发 system**，不带「第一意见」「请给第二意见」这类话术，
  不写角色行——网页是**并列的编排成员**，不是事后复核。

### 3.3 混合档的三档开关

`webSecondOpinion` 语义改为「工程空间网页编排开关」，**只在 `executionMode === 'hybrid'` 生效**：
保留字段是为了老会话不迁移。

| 档 | 混合档行为 | 非混合档 |
| --- | --- | --- |
| `auto`（缺省） | `classifyDecision` 判为决策类时，把**所有**已开启且可用的网页通道编进来 | 一律零网页 |
| `always` | 每个工程问题都编网页 | 一律零网页 |
| `off` | 也只用本地/云端模型 | 一律零网页 |

`classifyDecision` 的规则口径不变（强信号单独命中、弱信号两处或加疑问语气、用户点名直接算），
只是用途从「挑一个通道做第二意见」变成「决定网页要不要加入编排」。没有可用网页通道时如实跳过。

### 3.4 回答之后：恢复执行阶段

工程空间重新走 `runExecutionStage`，产物是**汇总 → 辩题 → 交锋 → 最终意见**，
不再让两份意见并列了事：

1. 主导人（本地优先）读全部编排成员的回答，写【结论/一致/分歧/存疑/辩题】；
2. 有实质辩题时，`runDebate` 拿 `orchestration.debaters` 开交锋；
3. 主导人读辩论记录给最终意见；综合卡里辩前汇总与辩后意见**分开存**。

关键边界：

- `debaters` = 全部本地 + 云端模型，**不按 `executionMode` 收敛成一类**，也不含网页成员。
  网页已在第一轮贡献并列意见（作为 seed 交给模型读）；再让每个页面各写三轮质疑只是把等待翻三倍。
- `src/main/index.ts` 的 `runDebate` 在收到 `orchestration` 时**直接组 `LeadPlan`**，跳过 `planLead`
  的归属收敛，否则本地/云端模型会被剔成一类。
- 工程编排的融合阈值降为 1；融合引擎未开启且 `synthesis` 为空时构造空壳容器，
  保证只有一位成员时主导人的汇总照样落得进综合卡。
- `run()` 的外层预算只在「工程 + hybrid + 网页编排未关」时追加 180 秒，避免页面意见被预算砍掉。

## 4. 代码位置

| 文件 | 职责 |
| --- | --- |
| `src/main/research/engineering-orchestration.ts` | **新增**。`planEngineeringOrchestration()` 出计划（members / lead / debaters / webIncluded / reason / fallback）；`buildWebOrchestrationQuestion()` 拼网页成员的消息 |
| `src/main/research/engineering-round.ts` | 只留与成员无关的 `ModelMemberView`、`buildEngineeringAnswerQuestion()`、`engineeringAnswerSystem()`；旧的 `planEngineeringAnswer()` 已删 |
| `src/main/research/second-opinion.ts` | 只留通用的 `classifyDecision()`、`secondOpinionExcerpt()`、`WebChannelView`、`SECOND_OPINION_MATERIAL_LIMIT`、`SECOND_OPINION_BUDGET_MS`；`planSecondOpinion()` / `buildSecondOpinionQuestion()` 已删 |
| `src/main/conversation-runner.ts` | `researchEngineering()` 问全部编排成员（本地串行链 + 云端/网页并发）；`conduct()` 不再跳过执行阶段；`runExecutionStage(..., orchestration)` 用编排名单绕过归属过滤 |
| `src/main/index.ts` | `runDebate` 见到 `input.orchestration` 时直接组 `LeadPlan`，不走 `planLead` |
| `src/shared/conversation.ts` | `webSecondOpinion` 注释改为「工程空间网页编排开关」，说明只在混合档生效 |
| `src/renderer/src/components/ResearchPanel.tsx` | 四档 hints 区分知识空间/工程空间；下拉文案改成「混合档下…」 |

## 5. 验证

- `scripts/check-engineering-orchestration.mjs`：**21 条**（15 条编排计划/消息纯函数 + 6 条链路）
  - 选人：三档都不按归属挑人、本地优先主导、点名云端、点名网页不主导、单模型自辩、无模型兜底、
    hybrid 五种子场景、勾选范围、网页不进 debaters；
  - 链路：三模型全进场且零网页零探活、本地模型不并发抢闸门、知识空间零改动、单模型也写汇总、
    **汇总→辩题→交锋→最终意见**且交锋名单不被 `cloud` 档收敛、混合档网页并列进场、网页失败如实记。
- `scripts/check-engineering-round.mjs`：**6 条**，只钉「问什么」与「如实兜底」。
- `scripts/check-web-orchestration.mjs`（原 `check-second-opinion.mjs`）：**15 条**，
  决策判定 + 6000 字摘录 + 混合档网页编排矩阵（auto/always/off/非混合档硬规则/勾选/失败）。
- 全量 `npm test` 与 `npm run typecheck` 见提交记录。

## 6. 与旧文档的对照

| 旧说法 | 现在 |
| --- | --- |
| 工程空间只问一个模型，问两个只是把等待翻倍 | 默认**全部**本地 + 云端模型都给一份意见（本地按闸门逐个问）；多份意见正是编排的输入 |
| 决策类问题追加一个网页做第二意见 | 非混合档零网页；混合档是**所有**网页通道并列进场 |
| 两份意见并列，不汇总、不融合 | 恢复汇总 → 交锋 → 最终意见 |
| `webSecondOpinion` 管所有工程会话 | 只在 `executionMode === 'hybrid'` 生效 |
| `local`/`web`/`cloud` 决定工程空间谁读文件 | 工程空间不按归属挑人；归属规则仍是知识空间的最高优先级 |
