# 对《最终审核意见》的审核（Gate 0 口径最后一次收紧）

- 审核时间：2026-11-15 11:35 +0800
- 被审对象：用户对 `DEBATE_V3_2_REREVIEW.md` 的审核结论
- 代码基线：`main` `b6b2fa7`；辩论代码仍为 `4125ba4`，本轮只提交了文档
- 本轮新核到的四处代码事实（见 §3、§4），其余结论沿用上一轮实跑结果
  （p0 10/10、p1 9/9、quality 5/5、judge 16/16）

---

## 1. 结论先行

**建议通过，四条口径成立。** 0A「不许把没实现的功能当测试通过」、0B「抽公共核
不等于合并裁决目标」、0C「18/24 是历史成绩不是当前成绩」、契约只定义不落地——
这四条都对，而且比上一版更清楚。

但有 **三处必须改**，否则 Codex 会照着错的方向做：

1. **0B 的架构图把质量引擎画成了第二个「裁决者」**。它不做裁决，只消费裁决。
   真实的重复是「三个入口 + 两套规则实现」，不是「辩论裁决 vs 质量裁决」。
   按现图施工，会额外造出一个并不存在的合并任务。
2. **0B 的通过条件写着「V3 质量引擎接入」，但质量引擎已经接好了**（手动裁决路径
   已接线 + 已持久化 + 已渲染）。写成「接入」会让 Codex 重写一遍接入层。
3. **0C 漏了一个会直接伪造结果的操作陷阱**：`--incremental` 按 fingerprint 复用
   旧结果，而 fingerprint **不含代码 SHA**。不改 `RUNNER_VERSION` 就带增量跑，
   会把 `60ada0e` 的 18/24 原样复用成「当前 main 的结果」——正是你这条口径要防的事，
   而且比「误读」更糟：它会写进报告，变成一份看起来全新的证据。

另有一处文档问题：禁令表写了四条，正文却称「三条禁令」。Codex 按编号引用时会错位，
建议对齐。

---

## 2. 0A：同意，补三条实现边界

同意「先检查现状 → 补实现 → 补 IPC 链 → 覆盖两类失败 → 失败原因可追踪」。

补三条写进验收，否则实现会走偏：

1. **失败候选必须出池**。重选时不能把刚失败的 `agentId` 再选回来，否则会在
   「失败 → 重选 → 又是它 → 再失败」之间循环。`reselection` 的入参要带
   `excludeAgentIds`。
2. **重算字段写死清单**：`judgeAgentId / judgeModelId / judgeProviderId /
   judgeMode / judgeIndependent / modelIndependence / sharedWith`。少算一个
   就会出现「人换了、独立性还是旧的」——正是你第二节点名的那件事。
3. **两种终态要分开记**：`model → rules-fallback（候选全部不可用或全部失败）`
   与 `独立裁判 → 参与者复评（participant-review）`。现在代码只有前者
   （`engine.ts:165-177`），`resolve.ts` 有后者但没人用它兜底。合并成一种状态
   会丢掉「到底有没有换过人」。

---

## 3. 0B：不同意现图，必须改成「三入口 + 两套规则实现」

你的图是：

```
       共享裁决核心
      ┌───────┴───────┐
  Debate Flow     V3 Quality Engine
   辩论裁决          质量裁决
```

问题在于：**质量引擎没有「质量裁决」这个动作**。`quality-engine.ts` 的入参就是
一份现成 `verdict`（`QualityInputs.verdict`），它只做规则门槛 + 维度评估 + 处置建议，
不选裁判、不调模型、不产生结论。图上画成两个平级裁决者，会让人以为要合并两套
判定标准，实际上它们根本不平行。

真实的重复是这样的（都在 `desktop-agent-macos/src`）：

| 入口 | 谁调用 | 裁决实现 | 是否选裁判 | 产出 |
| --- | --- | --- | --- | --- |
| 每场辩论结束 | `debate/orchestrator.ts:360` | `debate/judges.ts:107` `judgeDebate`（三维规则） | 否 | `DebateVerdict`，`backend:'rules'` |
| 用户点「裁决」 | `main/index.ts:4028-4049` | `judge/engine.ts:76` `JudgeEngine`（模型） | 是，`resolveJudge` 一次 | `JudgeVerdict`，`backend:'model'|'rules'` |
| 24 题回归 | `scripts/regression/run-debate-regression.cjs:226,314` | 同上 `JudgeEngine` | **否，脚本自己按轮换指定** | `JudgeVerdict` |

也就是说：**三个入口、两套规则实现、一次选裁判逻辑还没被共用**。

### 3.1 两套规则实现是更要命的重复

- `judges.ts` 的 `judgeDebate`：三维各自判（逻辑/证据/反例），合成五档结论；
- `engine.ts:182` 的 `ruleVerdict`：按文本线索打分（数字、出处词、条件词、推理词），
  产出另一种形状的 `JudgeVerdict`。

两者都自称 `backend:'rules'`，但算法不同，同一场辩论可能得出不同结论。
现在这两个结果可以并存：`DebateState.verdict`（规则三维）与
`verdicts/<debateId>.json`（可能是模型，也可能是另一套规则）。一旦不一致，
界面会同时展示两份，没有任何一处说明谁优先。

所以 0B 的第一个交付物不是「抽函数」，而是**一句契约：谁是权威 rules 结论**。
不先回答这个，抽出来的公共核只会把两份不一致搬进同一个文件。

### 3.2 抽公共核会踩到一个已存在的质量门槛

`debate/quality.ts:79` 有这么一条：

```ts
const recomputed = judgeDebate(state, { at: verdict?.createdAt ?? state.updatedAt });
// 'verdict.recomputable'：落盘的结论必须能被当前规则复算出来
```

它的设计意图是「规则升级后读老文件会对不上——那正是要暴露的」。这意味着：
**抽公共核时只要动了 `judgeDebate` 的判定逻辑，全部历史辩论的
`verdict.recomputable` 会集体由 pass 翻成 fail**，连带 24 题里已通过的题也会变
`needs_revision`。

必须在 0B 里二选一，并写进文档：

- **A（推荐）**：规则实现保持行为不变，只抽「选人 → 调用 → 解析 → 兜底 → 归一化
  → 持久化」这一层编排；`judgeDebate` 原样保留为规则内核。
- **B**：给规则实现加 `rulesVersion` 并在复算时按当时版本跑；代价是要维护多版本
  规则，历史文件才读得回一致结果。

不选，就会出现「抽完公共核，24 题成绩反而下降」，然后被误判为质量退化。

### 3.3 建议的 0B 交付物

```ts
// src/main/judge/adjudicate.ts
export interface AdjudicateDeps {
  candidates(): Promise<JudgeCandidateInfo[]>;
  ask(agentId: string, task: SubAgentTask): Promise<SubAgentAnswer>;
}
export async function adjudicateDebate(
  state: DebateState,
  deps: AdjudicateDeps
): Promise<JudgeVerdict>   // 内含 quality + finalDecision
```

三件事必须一起做，缺一件就等于没抽：

1. IPC `judge:adjudicate` 改调它（删除内联的 4028-4064）；
2. 24 题回归改调它（删除脚本里两处 `new JudgeEngine`）——顺带让它真正走
   `resolveJudge`，回归才代表产品路径；
3. 明确它**不负责**什么：不改 `judgeDebate`、不改质量维度、不改 UI 文案。

「不合并裁决目标」这点你说得对，保留：`adjudicateDebate` 只做机制，
评价标准仍由 `evaluateDebateQuality` / `judgeDebate` 各自持有。

---

## 4. 0C：口径同意，但增量回归会伪造结果

### 4.1 陷阱的具体机制

`scripts/regression/incremental.cjs:11-33`：

```js
fingerprintFor({ runnerVersion, promptVersion, item, standardItem, models, completeness })
canReuseResult(old, fp)  // fp 相同 && 上次 COMPLETED && V1 通过 → 直接复用
```

`runnerVersion` 是手写常量（`run-debate-regression.cjs:42` = `'2.0.0'`），
`promptVersion` 来自 `debate/prompts.ts`。**两者都不随代码 SHA 变化**。

所以：如果这次为了「省时间」带上 `--incremental=docs/.../debate-regression-v1-1-completeness-latest.json`，
而 `RUNNER_VERSION` / `PROMPT_VERSION` 没动，24 题会被全部判定为「可复用」，
报告里会出现一份结构与新跑完全一致、时间戳是新的、内容是 18/24 的结果。

这正是你这条口径要防的事，而且它比人工误读更难发现——因为报告看起来是新生成的。

**必须写进 Gate 0C 的硬约束**：本次全量回归**禁止使用 `--incremental`**；
若一定要用，必须先 bump `RUNNER_VERSION`，并在报告里打印 `incremental: null`。
报告字段里已经有 `incremental` 与 `completeness`（`results[].fingerprint` 也在），
验收时直接检查这两个字段，不用靠人记。

### 4.2 逐题差异可做，但要锁三样东西

历史报告 `docs/implementation/regression/debate-regression-v1-1-completeness-latest.json`
的 `results` 有 24 条，每条带 `id / category / strategy / judge / quality / decision /
standard / anchor / error`，逐题对比可以机械产出，不需要手工整理。

但对比只有在三样都一致时才有意义：

- 数据集 sha256（`ebd15b7e…`，报告里已有 `dataset` 字段）；
- `PROMPT_VERSION`；
- `completeness` 开关（历史是开的）。

任何一项不同，就要在报告里写「口径不同，不作逐题差异」，而不是硬比。

### 4.3 连接失败的处理沿用既有规矩

`DEBATE_V2_P3_TARGETED.md` 已经立过：连接失败的题单独记、单题重跑结果
**不并入主结果**。0C 沿用，不要因为「重跑一次就过了」把失败题改写成通过。
你列的六项交付物里建议再加两条：`PROMPT_VERSION` 与 `workers`，
以及「本次是否 incremental」。

---

## 5. 四个契约：同意四分法，但每条都要带硬约束

你的四分法（Evidence Pack / EvidencePackItem / DebateClaim / FactVerification）
比我上一版按「挂载位置」分的更好读，采纳。但每条必须附一条不可让步的约束，
否则评审只会审类型、不审边界：

| 契约 | 必须一起定下来的硬约束 |
| --- | --- |
| Evidence Pack | 含 `EvidencePackStore` 的持久化语义：原子写、按 `manifestHash` 不可变命名、同一 debatId 并发「复用或拒绝」二选一、损坏 pack 只让证据不可用而不让辩论消失 |
| EvidencePackItem | 显式映射表（`packItemKind → DebateEvidence.kind`），未知组合**拒绝**、不许默认成 `blog`；行号越界判 `line-out-of-range` |
| DebateClaim | 只留**一条权威边**（`ClaimEvidenceLink`）；`Claim.evidenceRefs` 与 `Evidence.claimIds` 都是派生，测试断言一致。禁止 `supportingEvidence[]` + `contradictingEvidence[]` + `claimIds` 三处真相 |
| FactVerification | 独立记录（claimId + status + 来源 + 时间 + 方法），质量报告只**引用**不复制；`QualityStatus` 里永远不出现 `fact-verified` |

关于「四个契约不必在 Gate 0 实现」——同意，而且建议再进一步：**连类型定义都放
Gate 1 评审通过后再写进 `src`**。现在写进代码，第二天就会有人 import 它，
然后状态表上就会多出一个 IMPLEMENTED。

---

## 6. 状态阶梯：同意，但现在没有地方存它

同意六个状态分开标注，也同意加「测试通过 ≠ 生产可用」。

但要说清一个现实：代码里目前**没有地方承载这个状态**——`DebateState` 没有
`schemaVersion`（`types.ts:522` 起），两个 store 都是解析失败返回 `null`
（`DebateStore.get()` / `VerdictStore.get()`）。所以这套阶梯本轮只能活在文档里；
想让它进代码，得等 Gate 1 先把 schema 版本与迁移方案定下来。这也反过来支持
「Gate 1 不许跳过」这条。

---

## 7. 修订后的 Gate 表（只改必要处）

顺序不动，改 0B/0C 的措辞与通过条件，补 0A 的交付物：

| Gate | 优先级 | 工作内容 | 通过条件 |
| --- | --- | --- | --- |
| Gate 0 | P0 | 现有系统集成复核 | 真实代码状态与缺口确认（已完成于本轮审核） |
| Gate 0A | P0 | Judge 降级实现 + IPC 测试 | ① 重选实现（排池 + 重算七字段 + 记录 `judgeReselection`）；② IPC 级测试覆盖「调用失败」「候选失败」「无候选」；③ 两种终态可区分 |
| Gate 0B | P0 | 抽公共裁决核（**不是**「接入质量引擎」） | ① `adjudicateDebate` 同时被 IPC 与 24 题回归调用；② 明确权威 rules 结论；③ `verdict.recomputable` 在历史辩论上不翻红 |
| Gate 0C | P0 | 当前 main 全量 24 题（**禁 incremental**） | ① 记录 SHA / dataset sha256 / PROMPT_VERSION / completeness / workers / incremental:null；② 与 18/24 逐题差异（新增通过 / 退化 / 不变）；③ 连接失败单独记，不并入主结果 |
| Gate 0D | P0 | `npm test` + typecheck 全量 | 记录命令、SHA、失败项；不接受抽样 |
| Gate 1 | P0 | 四契约定义 + 兼容性 + 迁移方案 | 四份契约含 §5 的硬约束；`schemaVersion` 方案通过 |
| Gate 1A | P0 | Evidence Pack Spike | 七条断言（旧快照不变、hash 变、越界拒绝、manifest 校验、历史回放、并发语义） |
| Gate 2 | P0 | Evidence Pack 最小实现 | 契约落地并测试通过 |
| Gate 3 | P0 | 工程辩论闭环 | 工程证据可进入辩论且可追溯 |
| Gate 4 | P1 | 外部事实核验 | 独立核验链路完成 |
| Gate 5 | P1 | 最终回归与稳定性 | 全量回归 + 异常场景 |
| Gate 6 | P2 | 4+ 模型动态分工 | 对比实验证明有效 |

---

## 8. 最终审核意见

**有条件通过。** 你这四条口径和三条禁令的方向都成立，可以作为计划书的修订依据。
但发布前必须改四处：

1. **0B 的图与通过条件**：质量引擎不是第二个裁决者；它已接入，0B 做的是抽核与共用，
   不是「接入」。同时回答「谁是权威 rules 结论」。
2. **0B 加一条不可逆风险**：抽公共核若动 `judgeDebate` 的判定，历史辩论的
   `verdict.recomputable` 会集体翻红；规则实现要么保持不变，要么版本化。
3. **0C 禁 `--incremental`**（或先 bump `RUNNER_VERSION`），否则会产出一份
   「看起来是新的、其实是历史复用」的 24 题报告。
4. **契约四分法保留，但把 §5 的四条硬约束写进每条契约的验收**；类型定义仍留到
   Gate 1 评审通过后再进 `src`。

禁令补一条：**测试通过不等于生产可用**（TESTED ≠ PRODUCTION_READY）。
另把「三条禁令」的编号对齐成四条。

一句话：**方向批准；0B 改图、0C 禁增量，两条不改就不要开工。**
