# 辩论引擎审计（Phase 0）

审计日期 2026-11-05。基线 `main@1feec86`，本次在 `0.1.1` 上实施。
所有路径相对 `desktop-agent-macos/`。对应文档：
`ThinkFusion_AI_真理发现与多模型辩论引擎_Codex实施任务书_V1.0`（下称「任务书」）。

这份审计只回答一件事：**任务书里的每个组件，在这个仓库里已经存在什么、缺什么、
该复用还是新建**。任务书第 2 节要求先出这张映射表，再动代码；它自己也写明
「文中目录和文件名均为建议落点」。

一个前提要先说清：这个仓库不是从零开始。多轮辩论、观点融合、裁判三块都已经
有实现（Phase G/H/I），但它们的**形状与任务书不同**——辩论跑的是自由文本发言，
结构化主张在另一条链（综合引擎）里算，两者没有接上。所有差距都来自这一条，
而不是缺少模块。

## 1. 技术栈与运行形态

| 层 | 真实实现 | 备注 |
| --- | --- | --- |
| 运行时 | Electron 37 + electron-vite，主进程 `src/main/` | 无服务端，无数据库 |
| 持久化 | `store.ts`（单个 `agent-store.json`）+ `debate/store.ts`（每场辩论一个 JSON 文件） | 不是表，没有迁移；写入用 `atomic-write.ts` |
| 模型接入 | 网页通道（`WebContentsView` + 页面驱动）、本地 Ollama（`adapters/providers/ollama.ts`）、云端 API（`adapters/providers/*`） | 三者的统一接口是 `SubAgentPool.ask` |
| 界面 | React + `agentAPI`（`preload/index.ts` 逐条 `ipcRenderer.invoke`） | 没有路由库；面板挂在 `ResearchPanel` 的 tab 里 |
| 测试 | `node --test` + `scripts/check-*.mjs`，编译到 `out-test/` 后跑 | 没有 jest/vitest，没有 e2e 框架，真机验证靠 CDP 脚本 |

任务书第 9 节假设的是「表/集合 + 迁移」。这个仓库没有数据库：**辩论的
`debate_*` 系列表在 V1.0 里落成 `DebateState` 一个对象、每场一个文件**。
要引入真正的表结构得先有存储层，那是另一个工程，不在本版范围。

## 2. 组件映射

| 任务书组件 | 现有实现 | 结论 |
| --- | --- | --- |
| MasterAgent | `master-agent.ts`：并发分发通道 + 调 `synthesize()` | 复用，不动 |
| SubAgentPool | `agents/registry.ts`、`agents/provider-agent.ts`；执行阶段另有 `execution/execution-pool.ts`（双名单：回答者 / 本地云端执行者） | 复用 |
| DebateStrategyRouter | **无**。是否辩论由主导人在汇总里写【辩题】决定（`synthesis/lead-stage.ts` 的 `parseTopics`）；策略枚举 `standard/deep/adversarial` 只在独立辩论面板生效 | 部分存在，需扩展 |
| DebateOrchestrator | `debate/orchestrator.ts`：轮次、发言、收敛、少数派、中止/恢复、代际防覆盖 | 复用 + 扩展（本版主战场） |
| DebateController | **无独立实现**。挑战指令是模板字符串（`orchestrator.ts` 的 `instructions()`），不含具体主张 | 新建 |
| ArgumentGraph | `synthesis/` 的 claim-extractor → clusterer → relations → evidence → ranker；产物 `FusionReport`（claims/relations/evidence） | 复用算法，未进辩论 |
| EvidenceEvaluator | `synthesis/evidence.ts`（七维打分）+ `judge/engine.ts` 的 `evidenceScore` | 部分存在，缺来源元数据 |
| DebateJudge | `judge/engine.ts`：规则版 + 可选模型版，`supportCount` 只描述不裁决，允许 `undetermined` | 复用，缺逻辑/反例分维 |
| SynthesisEngine | `synthesis/lead-stage.ts`（五段汇总）+ `fusion.ts` 的 `toSynthesis` | 复用 |
| 执行模式 Web/Local/Cloud/Hybrid | `shared/conversation.ts` 的 `ExecutionMode`，`execution/policy.ts` 决定谁回答、谁可执行 | 复用（已与策略分离） |

## 3. 关键数据结构：已有 / 缺失

| 任务书对象 | 现状 | 落点 |
| --- | --- | --- |
| DebateSession | `DebateState`（debateId / conversationId / question / config / lead / plan / status / rounds / minorities） | `debate/types.ts` |
| DebateParticipant | `LeadPlan` 的 participants / debaters / webOnly / excluded（只有 id 与角色，无能力快照） | `debate/lead.ts` |
| DebateRound | `DebateRound`（index / messages / startedAt / endedAt / converged / failures） | `debate/types.ts` |
| DebateClaim | `ExtractedClaim`（id / text / span / kind / assumptions / negation / figures / topics / evidence） | `synthesis/claim-extractor.ts` |
| DebateEvidence | `EvidenceDraft` + `Evidence.scores`（七维） | `synthesis/evidence.ts` |
| DebateDispute | `ArgumentRelation` 的 contradicts / attacks 边（只有 from/to/confidence/reason，无类型与优先级） | `synthesis/relations.ts` |
| ArgumentEdge | `ArgumentRelation`（7 种关系） | `shared/fusion.ts` |
| DebateJudgment | `JudgeVerdict`（结论、证据评分、少数派、未解决问题） | `judge/types.ts` |
| DebateResult | `JudgeVerdict` + `Synthesis`（recommendation / fusion） | 同上 |
| 事件流 `debate_events` | **无**。辩论是整份快照覆盖写，没有 append-only 事件与幂等键 | 待定，见 §5 |

## 4. 验收标准逐条对照

| 编号 | 现状 | 差距 | 计划 |
| --- | --- | --- | --- |
| AC-01 执行模式与策略独立 | 两者是不同字段、不同枚举，界面上也分开 | 会话内发起的辩论把策略写死 `standard`、轮数写死 2 | Phase 2 |
| AC-02 首轮互相隔离 | 独立辩论的第一轮 `context` 为空；会话内辩论第一轮拿到的是**网页回答**（基准材料），不是其他参辩模型的首轮答案 | 无 | 已满足，需要在文档里说清「seed ≠ 参与者答案」 |
| AC-03 结构化 Claim | 综合链里有，辩论里没有 | 辩论发言未抽 claim | **Phase 1** |
| AC-04 四类争议 | 有直接矛盾（极性/数字）与范围差异（假设句）；定义差异、证据冲突没有 | 缺两类判据 | **Phase 1**（前两类 + 证据冲突） |
| AC-05 针对具体 Claim 的挑战 | 只有 `targetMessageId`，指令是「逐条质疑上一轮」 | 挑战不指向具体主张 | **Phase 1** |
| AC-06 accept/defend/revise/withdraw/inconclusive | `DebateMessageKind` 有 `revision`，没有决策枚举 | 修订不记决策 | Phase 2 |
| AC-07 轮数/并发/超时/预算 | 有 `maxRounds`、`convergenceStop`、`waitFor(180s)` | 无 token/费用预算，无阶段级超时 | Phase 2 |
| AC-08 论证图 | `ArgumentRelation` 七种关系 + evidence 边 | 不落盘、不进辩论 | Phase 3 |
| AC-09 证据保留来源/定位/时间/指纹/评价理由 | 有 excerpt + span + 七维理由；**没有 URL、抓取时间、指纹** | 网页通道只取文本，不取引用链接 | Phase 3（需先有抓链接的能力） |
| AC-10 同源转载识别 | 独立性维度靠「是否同一通道说话」近似 | 无 URL/指纹，做不了真同源判定 | Phase 3，同上 |
| AC-11 逻辑/证据/反例三维裁判 | 证据分与论证质量分；反例只在提示词里提 | 缺维度拆分 | Phase 3 |
| AC-12 不用多数票 | `supportCount` 只描述，`undetermined` 是正当结果 | 无 | 已满足 |
| AC-13 证据不足输出 inconclusive | `undetermined` + `fusion.degraded` | 没有 `insufficient_evidence` 这一档 | Phase 3 |
| AC-14 取消/恢复/幂等事件 | 取消、恢复、代际防覆盖都有；**没有事件流** | 快照覆盖写，无法审计中间态 | Phase 2（轻量事件） |
| AC-15 TF-D-001~010 可自动执行 | 无 | 需要可编排的回归脚本 | Phase 5 |

## 5. 建议的落点（与任务书目录的对应）

任务书第 18 节建议 `debate/domain|orchestration|evaluation|persistence`。本仓库
已有 `src/main/debate/`（4 个文件、788 行）与 `src/main/synthesis/`（10 个文件、
1367 行），**不建议**为了目录形状整体搬迁——搬一次要改所有 import 和测试，收益
只有好看。

建议的映射：

| 任务书建议路径 | 本仓库落点 |
| --- | --- |
| `debate/domain/*` | `debate/types.ts`（会话与轮次）+ `debate/claims.ts`（新增：claim/dispute） |
| `debate/orchestration/DebateOrchestrator` | `debate/orchestrator.ts`（已有） |
| `debate/orchestration/DebateController` | `debate/claims.ts`（抽取/检测/排序）+ 下一轮挑战生成 |
| `debate/orchestration/DebateStrategyRouter` | `synthesis/lead-stage.ts` 的 `parseTopics` 已有雏形，Phase 4 再拆出独立 router |
| `debate/evaluation/*` | `judge/engine.ts`（已有）+ `synthesis/evidence.ts` |
| `debate/persistence/*` | `debate/store.ts`（已有） |
| `prompts/debate/*.md` | 本仓库的提示词是 TypeScript 字符串常量（`lead-stage.ts`、`judge/engine.ts`、`debate/orchestrator.ts` 的 `instructions()`），没有独立的 prompts 目录。**不建议只为对齐文档改成 md 文件**：那样每次读文件、要处理路径，收益是零。版本信息写进常量旁的注释即可 |

## 6. Phase 1 的实际改动（本次实施）

任务书 Phase 1 的交付物是「可运行的单轮辩论流程 + Claim 提取 + 争议检测 +
基础综合」，完成标准是「至少 2 个参与者、首轮隔离」——后两条已经满足，
需要补的是结构化那一层：

1. `src/main/debate/claims.ts`（新增）
   - 从本轮每条发言抽 claim（复用 `synthesis/claim-extractor.ts`，不改它）。
   - 跨参与者的 claim 两两比较，产出争议：`factual`（极性/数字冲突）、
     `scope`（假设/范围不同）、`evidence_conflict`（两边都给了数字且不一致）。
   - 按 `impact × uncertainty` 排序，只把前几条交给下一轮。
2. `debate/types.ts`：`DebateRound.claims`、`DebateState.disputes` 两个可选字段。
   老文件读出来是 `undefined`，不迁移、不改形状。
3. `debate/orchestrator.ts`：每轮结束后算 claims/disputes；下一轮的 system 指令
   带上具体是哪两句在冲突（而不是「请质疑上一轮」）。
4. `scripts/check-debate-claims.mjs`：抽取、三类争议、排序、挑战指向具体主张、
   没有争议时不硬造。

不做的：不改 `claim-extractor` 的判据、不动综合链、不加界面。

## 7. 与任务书不一致、建议保留差异的地方

1. **首轮喂网页回答**（`DebateConfig.seed`）。任务书 AC-02 要求首轮隔离，这里的
   会话内辩论第一轮会让辩手看到网页通道的回答。这不是违规：网页回答是**这一轮
   要检验的基准材料**，不是另一个参辩模型的首轮答案；参辩模型彼此仍然隔离。
   独立辩论面板不传 seed，行为与任务书一致。
2. **没有独立 prompts 目录**。理由见 §5。
3. **持久化不是表**。理由见 §1。
4. **裁判可以与被裁判者同源**。任务书 7.1 要求裁判尽量独立；本仓库单机只有
   一两个模型时允许兼任，但结果里 `sharedWith` 会写明——这比因为「不够独立」
   就拒绝给结论更诚实。

## 8. 风险

- `claim-extractor` 是为**中文网页回答**调的（句号/换行切句、12 字门槛）。辩论
  发言更短、更口语，可能抽不出 claim。Phase 1 的测试要用真实辩论文本，不能只用
  造好的长句。
- 争议检测是规则版（bigram + 极性 + 数字）。任务书 AC-04 的「定义差异」规则判不了，
  本轮不做，如实写在类型里而不是假装有。
- 界面目前不展示 claim/dispute。Phase 4 之前，它们只出现在辩论文件与挑战指令里。
