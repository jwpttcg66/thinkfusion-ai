# 任务书验收对照（AC-01 ~ AC-15）

对照对象：`docs/spec/DEBATE_ENGINE_TASK_V1.0.md` 第 16 节 15 条验收标准。
基线分支 `0.1.1`（Phase 0 审计在 `DEBATE_ENGINE_AUDIT.md`，各阶段交付在
`docs/implementation/PHASE-*.md`）。

状态只有三种：**达成**、**部分**（说清缺哪一块）、**不适用**（本仓库拿不到
那个数据，写清楚为什么，而不是假装有）。

除 15 条 AC 外，任务书还有 **§12 Prompt 模板**与 **§17 收尾文档**两项，
不在 AC 编号里，容易被漏掉。本次补齐后逐节状态见文末「任务书章节对照」。
配置 / 迁移 / 测试 / 运行四项集中在
`docs/implementation/DEBATE_RUNBOOK.md`；质量达标线在
`docs/architecture/DEBATE_QUALITY.md`，一键复核 `npm run quality:debate`。

## 阶段状态：0–5 全部完成

任务书第 15 节把工作分成六个阶段。15 条验收标准是**跨阶段**的，所以
「AC 全过」不等于「六个阶段都做完了」。六个阶段各自的交付物：

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| Phase 0 | 仓库审计、映射表 | 完成（`DEBATE_ENGINE_AUDIT.md`） |
| Phase 1 | 独立分析、Claim、争议、基础综合 | 完成（`PHASE-1-DEBATE-CLAIMS.md`） |
| Phase 2 | 多轮、挑战、回应、修订、预算 | 完成（`PHASE-2-DEBATE-REVISION.md`） |
| Phase 3 | 论证图、证据评价、多维裁判 | 完成（`PHASE-3-DEBATE-ARGUMENT-JUDGE.md`） |
| Phase 4 | 策略与 UI（六种协作策略、结果展示） | 完成（`PHASE-4-DEBATE-STRATEGIES.md`） |
| Phase 5 | 质量优化（标注集、评测指标、成本） | 完成（`PHASE-5-DEBATE-METRICS.md`） |
| 收尾 | §12 Prompt 模板版本化、§17 配置/迁移/测试/运行手册 | 完成（`DEBATE_RUNBOOK.md`、`src/main/debate/prompts.ts`） |

阶段完成不等于质量达标：Phase 5 的指标报告只有 4 条示例标签、回放发言，
它能守住链路，不能证明模型判断正确。这一点在 `PHASE-5-DEBATE-METRICS.md`
和 `docs/reports/DEBATE_QUALITY.md` 里都写明了。

## 总表

| 编号 | 条款 | 状态 | 证据 |
| --- | --- | --- | --- |
| AC-01 | 执行模式与协作策略相互独立 | 达成 | `shared/conversation.ts` 的 `executionMode` / `strategy` / `debateStrategy` 是三个字段；`DebateConfig.leadMode` 另管主导；`ResearchPanel` 里「执行模式」与「辩论策略」是两组控件；六种策略见 `strategies.ts`，`check-debate-strategies.mjs` 8 条 |
| AC-02 | 首轮分析相互隔离 | 达成 | `orchestrator.runRound` 首轮 `context` 只来自 seed（会话已有材料），不读其他成员首轮答案；`check-debate.mjs`「第一轮独立、后续轮带前序发言」 |
| AC-03 | 拆成结构化 Claim 并区分事实/推断/假设 | 达成 | `claims.ts`（切句）+ `synthesis/claim-extractor.ts`（`kind` / `kindCue` / `assumptions`）；`check-debate-claims.mjs` 第 1 条 |
| AC-04 | 识别直接矛盾、定义差异、范围差异、证据冲突 | 达成 | `DisputeType = factual / logical / scope / evidence_conflict / definitional`；`check-debate-claims.mjs` 第 2、3、4、7 条 |
| AC-05 | 挑战指向具体 Claim | 达成 | `challengesFor()` 带两句原话与冲突性质，最多 3 条；`check-debate-claims.mjs`「挑战照着具体两句写」 |
| AC-06 | 支持 accept / defend / revise / withdraw / inconclusive | 达成 | `revision.ts` 五个值 + `null`（判不出来）；`check-debate-revision.mjs` 决策解析与状态回写 |
| AC-07 | 可配置轮数、并发、超时、Token、费用 | 部分（按能力） | 轮数 `maxRounds`、并发 `budget.maxConcurrency`、单次 `stageTimeoutMs`、整场 `totalMs` 都有，且 `DebateConfigInput.budget` 已对渲染层开放（本次补齐，有归一与落盘用例）；**Token 与费用没有数据来源**（网页通道与本地 Ollama 都不报用量），类型里不留这两个字段 |
| AC-08 | ArgumentGraph 表达 Claim、Evidence、支持、反驳、依赖 | 达成 | `argument-graph.ts`：4 种节点、6 种边，边带轮次与来源；`check-debate-graph.mjs` 6 条 |
| AC-09 | 关键证据保留来源、定位、时间、指纹、评价理由 | 达成 | `evidence.ts` + `shared/evidence.ts`；页面驱动读回答里的 `a[href]`；`check-page-citations.mjs` 10 条 |
| AC-10 | 识别同源转载，不把重复来源当独立证据 | 达成 | `originKey` / `duplicateOf` / `independentSourceCount`；`check-debate-judge.mjs`「TF-D-012」 |
| AC-11 | 裁判至少含逻辑、证据、反例三维 | 达成 | `judges.ts`：三个维度各自 outcome + rationale，不平均；`check-debate-judge.mjs` 第 1 条 |
| AC-12 | 不以简单多数投票判真伪 | 达成 | 裁判输入里没有票数；结论对象无 `supportCount` 一类字段；`check-debate-judge.mjs`「TF-D-011」「整场结论里没有任何票数字段」 |
| AC-13 | 证据不足时输出 insufficient_evidence / inconclusive | 达成 | 五档含 `insufficient_evidence`，与 `unsupported` 分开；`check-debate-judge.mjs`「TF-D-013」 |
| AC-14 | 会话支持取消、失败恢复和幂等事件记录 | 达成 | `events.ts`（seq 单调 + key 幂等）+ `stop/resume`；`check-debate-events.mjs` 7 条 |
| AC-15 | TF-D-001~010 可自动执行并形成报告 | 达成（回放） | `check-debate-regression.mjs` + `fixtures/debate-regression.mjs`；报告 `docs/reports/DEBATE_REGRESSION.md` |

## 需要说明的三条

### AC-01：四个字段各管一件事，六种策略已落地

「执行模式」与「协作策略」在数据模型和界面上是两组独立配置：

- 执行模式：`web / local / cloud / hybrid`（`executionMode`），决定在哪里执行、
  谁当主导人；
- 协商策略：`smart / parallel / all-selected / sequential`（`strategy`），决定这一轮
  怎么调度子任务；
- 辩论策略：`truth / adversarial / expert / assumption / solution / discovery`
  （`debateStrategy` / `DebateConfig.strategy`），决定辩手怎么辩；
- 主导方式：`local / web / hybrid`（`leadMode`），决定谁给基准观点。

六种策略改的是三件可验证的事：每轮指令、角色分配、先处理哪类争议（见
`strategies.ts` 与 `PHASE-4-DEBATE-STRATEGIES.md`）。**策略不改裁判口径**：
`judges.ts` 没有 strategy 参数，同一份证据换策略跑，结论一致——有用例守着。
旧名字 `standard` / `deep` 仍能读回老记录，界面不再提供。

### AC-07：Token 与费用不做，是因为拿不到

任务书要求「Token、费用、时间三类预算同时控制」。这个仓库三条通道都不报用量：
网页通道没有接口，本地 Ollama 的响应里没有 usage，云端 Provider 只有部分返回。
写一个估算值会让「预算」变成假的，所以只做时间与并发，并在
`DebateBudget` 的注释里写明另外两项没有数据来源。

### AC-15：回放断言的是结构，不是模型的判断

十条用例的发言是**录好的**（按任务书场景写成），断言的是链路有没有把话弄丢：
关键词还在不在、争议有没有判出来、证据不足时会不会硬给结论、多数一致会不会
自动变成正确、转载会不会被算成两份独立来源。

它**不能**证明真模型在这些场景下判断正确——那需要人工标注集（Phase 5）。
这一组的作用是：真模型换掉之后，链路的退化会先在这里红。

## 怎么复核

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:debate-claims        # AC-03/04/05
npm run test:debate-revision      # AC-06
npm run test:debate-graph         # AC-08
npm run test:page-citations       # AC-09（三家 HTML fixture）
npm run test:debate-judge         # AC-10/11/12/13（含 TF-D-011/012/013）
npm run test:debate-events        # AC-14
npm run test:debate-regression    # AC-15
npm run test:debate-strategies    # AC-01（六种策略、角色、争议排序）
npm run test:debate-metrics       # Phase 5 指标 + 成本 + 历史复用
npm run quality:debate            # 质量达标：十一项硬门槛 + 13 条基准场景 + 报告
npm run test:debate-prompts       # §12 模板契约、文案快照、版本落盘、网页原话
npm test                          # 全量，含上面全部
```

`npm run report:debate-regression` 会把报告写到
`docs/reports/DEBATE_REGRESSION.md`，`npm run report:debate-eval` 写到
`docs/reports/DEBATE_QUALITY.md`；不写 `TF_REPORT=1` 时只写 `out-test/`，
不弄脏仓库。

## 任务书章节对照（AC 之外，逐节核）

任务书 19 节 + 附录。下表只列「容易被读成没做」或「有明确不做」的部分；
正文各节的落地文件都能在 `PHASE-*.md` 里找到。

| 章节 | 要求 | 状态 | 落点 |
| --- | --- | --- | --- |
| §8 接口设计 | 逻辑契约（Orchestrator / EvidenceEvaluator / DebateJudge / SynthesisEngine） | 达成 | 名字按项目风格调整：`DebateOrchestrator`、`buildEvidence`/`dedupeEvidence`、`judgeDebate`、`DebateVerdict` + 两个渲染组件。任务书明说「接口名称为逻辑契约，应遵循现有项目语言调整」 |
| §9 持久化与事件 | 幂等键、可恢复、稳定顺序 | 达成 | 每场辩论一个 JSON 快照（不进主 journal）+ `events.ts`；没有拆成 13 张表，理由写在 `DEBATE_RUNBOOK.md` §1.6 |
| §10 并发/预算/可靠性 | 默认 3 模型 / 3 轮 / 并发 3 / 阶段 60s；超时、部分失败、降级 | 达成（Token/费用除外） | `budgetOf`、`mapLimit`、`askWithin`、`round.failures`；Provider 层已有退避重试；搜索失败按「没检索到」处理，不解释成「资料不存在」 |
| §11 安全与防护 | 外部内容不可信、注入隔离、权限校验、结构化校验 | 达成（按能力） | 网页回答只作证据文本不进 `system`；`debateId` 正则挡路径穿越；文件 `0600`；模型输出按纯文本落盘，不执行生成的 JSON；决策行只认五个固定词。**没有独立的用户级权限系统**：本应用是单机单用户，数据按 `debateId` / `conversationId` 隔离 |
| §12 Prompt 文件 | 七个独立模板、版本化、可测试、历史会话保留版本 | 达成（载体与建议不同） | `src/main/debate/prompts.ts`：七个模板的输入/输出/禁止/引用/失败处理齐全；`PROMPT_VERSION` 随 `DebateState` 落盘；四项本地规则如实标 `rule` 且 `text: null`，不编造 prompt；`check-debate-prompts.mjs` 11 条（含文案逐字快照）。**没有用 `prompts/debate/*.md`**：四个模板是规则、没有模型文本，写成 md 只会是死文件；TS 模块能直接被用例 import，才真的「可测试」。模板升级规则见 `DEBATE_RUNBOOK.md` §2.3 |
| §13.1 模式选择 | 快速回答与深度辩论两种入口；简单问题不自动开完整辩论 | 达成（按现有形态） | 两种入口已经存在且**默认就是快速回答**：输入框直接提问走综合，不启动辩论；要深度辩论得去「研究设置 → 辩论」手动发起，会话内也只在主导人计划里明确指定时才跑。四个执行模式与六种策略各自独立可选。**没做**的是输入框旁的显式双按钮和「按问题长度自动判断要不要辩论」——前者会改提问链路，后者会按意图替用户分通道，都不做 |
| §13.2 最终报告 | 九块结构 | 达成 | 研究设置 → 辩论 → 结论报告九块；对话页另有五档结论条 |
| §14.1/14.2 | 单元测试与 TF-D-001~010 | 达成 | 见「怎么复核」；回放断言结构，不断言模型措辞 |
| §14.3 质量指标 | 七项 | 部分（有明确达标线） | 可追溯率、错误前提纠正率、无效辩论率、分歧保留率、延迟已算并出报告；十一项硬门槛 + 13 条基准场景由 `quality:debate` 一键判定（`DEBATE_QUALITY.md`），做过变异测试确认会红。**事实准确率与概率校准度仍算不了**：标签是 `rule`/`seed`（人工 0 条），结论不带置信度；Token/费用无数据源 |
| §17 收尾文档 | 架构文档、配置示例、迁移说明、测试说明、运行手册 | 达成 | `PHASE-*.md` + `DEBATE_ACCEPTANCE.md` + `DEBATE_RUNBOOK.md`（后四项）；`README.md` 里「辩论尚未接线」的过时描述已更正 |
| 附录 A | 最终结果 JSON 示例 | 达成 | `DebateVerdict` / `DebateView` 是实际落盘与界面结构；没有照抄示例里的「置信度」字段（无数据来源） |

## 已知不达成的部分（汇总）

| 项 | 原因 | 归属 |
| --- | --- | --- |
| Token / 费用预算 | 三条通道都不报用量 | 无法做，不做假 |
| 网页通道参与的真机辩论 | 没向三站发测试提问（会动用户账号，且要清理） | 只用脚本用例覆盖「只发原话、只跑第一轮」 |
| 裁判读网页正文 | 只有地址与文本线索，不抓取网页内容 | 未做；要靠浏览器抓正文，另立项 |
| 事实准确率 / 概率校准度 | 需要人工标注集；结论不带置信度，给数字就是编的 | 报告只给「与规则基准一致」与确定性的「档位 ↔ 证据强度自洽」，两者都不冒充准确率/校准度 |
| 网页正文抓取 / 按钮式引用 | 只保留回答里的 `a[href]` 与文本线索 | 另立项，不从链接猜内容 |
