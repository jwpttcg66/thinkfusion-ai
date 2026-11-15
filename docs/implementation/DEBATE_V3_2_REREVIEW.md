# Debate V3.2 重新审核（对着当前 main 逐条核码）

- 审核时间：2026-11-15 11:30 +0800
- 代码基线：本地 `main` `93c409b`；辩论相关代码最后一次变更是 `4125ba4`
  （`93c409b` / `d104572` 只含审核文档，没有代码改动）
- 数据集：`scripts/regression/debate-dataset.json` v1.0.0，24 题，
  sha256 `ebd15b7e5ec73965e820e2ae1a5ef5b3d874e90ee74f9fa60e967f64eab6ba3f`
- 本轮实跑（不是引用旧结论）：

  | 命令 | 结果 |
  | --- | --- |
  | `npm run test:p0-gaps` | 10/10 |
  | `npm run test:p1-multi-model` | 9/9 |
  | `node --test scripts/check-debate-quality.mjs` | 5/5 |
  | `node --test scripts/check-judge.mjs` | 16/16 |

---

## 1. 结论先行

用户这份审核结论的六个核心判断，**五项成立，一项需要纠正**。

成立：`fact-verified` 不存在、Evidence Pack 只有设计、`EvidenceKind` 不宜直接扩展、
`DebateClaim` 缺证据关联字段、Gate 0 未闭环、Evidence Pack 应先做契约评审与 Spike。

需要纠正：「24 题 P0/P1 后完整回归：NOT RUN」。**它跑过**，就是 `60ada0e`
那次 18/24；`8f8fb13`、`10adea2`、`d9b49b7` 三个 P0 提交都是它的祖先（`merge-base`
验证）。当前 main 缺的是**P3 修复之后**的全量重跑，不是从没跑过。

另外「V3 质量引擎：部分 INTEGRATED」这句话太糙，应该说成三句：
手动裁决路径已接线、已持久化、已有真实模型证据；辩论结束**不会**自动裁决；
IPC 层没有自动化测试，且回归脚本自己 `new JudgeEngine`，与产品路径分叉。

---

## 2. 逐条核码

### 2.1 `fact-verified` 不存在 —— 成立

`src/main/debate/quality-engine.ts:28-34` 只有五档 `supported / model-assessed /
contradicted / insufficient / unknown`。全仓（`src` + `scripts` + 两个 `docs`）
grep `fact-verified` **0 命中**。计划 2.4 把它写成现有状态，是错的。

用户提出的拆分（`QualityStatus` 与 `FactVerificationStatus` 分开）方向正确，
但**本轮不要写进代码**：外部事实核验是 P1，现在就加类型等于把一个没有实现的
状态标成 IMPLEMENTED。要写就写在契约文档里，标 SPECIFIED。

### 2.2 Evidence Pack 只有设计 —— 成立

全仓 grep `EvidencePack` **0 命中**（`src`、`scripts`、`package.json` 都没有）。
只有两处「接入后要怎样」的注释：

- `src/main/code-index/indexer.ts:757`：Evidence Pack 接入后要先 pin 再清理；
- `src/main/code-index/store.ts:478`：接入后需要先检查 pin。

`docs/implementation/DEBATE_V2_STATUS.md` §5 自己也写着「当前没有独立 Evidence Pack
实现」。没有任何持久化结构、没有 `EvidencePackStore`、没有测试脚本。

### 2.3 `EvidenceKind` 不适合直接扩展 —— 成立，但理由要说得更准

`src/shared/fusion.ts:57`：

```ts
type EvidenceKind = 'official-doc' | 'source-code' | 'paper' | 'benchmark' | 'blog' | 'model-claim';
```

它描述的是**材料种类**，不是工程证据的定位方式。直接加 `symbol` / `call-graph` /
`execution` 的真实代价不是编译报错，而是这三处必须跟着改：

- `src/main/synthesis/evidence.ts:11` `AUTHORITY: Record<EvidenceKind, number>`
- `src/main/synthesis/evidence.ts:20` `VERIFIABILITY: Record<EvidenceKind, number>`
- `src/main/debate/evidence.ts:35` `EXTERNAL_KINDS` 白名单

也就是说，每加一个 kind 都要给它**编一个权威度数字**——那是设计决定，不是机械扩展。
所以「新建 `EvidencePackItemKind` / `EvidencePackItem`、映射进 `DebateEvidence`」
是对的；但映射必须显式：`DebateEvidence.kind` 继续用旧枚举，Pack 侧另存
`packItemKind`，未知类型**拒绝**而不是猜成 `blog`。

### 2.4 `DebateClaim` 缺证据关联字段 —— 成立，且反向边已经存在

`src/main/debate/types.ts:91-112` 的 `DebateClaim` 只有
`evidenceDrafts?: EvidenceDraft[]`（`excerpt / kind / start / end / cue`，
见 `src/main/synthesis/claim-extractor.ts:20-28`），确实没有
`supportingEvidence / contradictingEvidence / evidenceRefs / confidence /
unresolvedReason`。

但要注意：**反向边是有的**——`DebateEvidence.claimIds`（`types.ts:275`）已经
记录「这条证据支持或反驳哪些主张」。所以 6.2 不能做成「Claim 侧再手写一份数组」，
否则同一条证据要写两遍，两边一旦不一致没人知道以谁为准。这一点见 §4.3。

### 2.5 Judge 降级未闭环 —— 成立，而且比审核说的更严重

审核说「要补 IPC 级降级测试」。核完码的结论是：**现在连被测试的行为都没有**。

- `src/main/judge/resolve.ts:44` 只被调用**一次**（`src/main/index.ts:4028`），
  选完就把 id 交给 `JudgeEngine`；
- `src/main/judge/engine.ts:108-133`：模型调用抛错或两次 JSON 都解析失败，
  直接返回 `backend:'rules'` + `judgeMode:'rules-fallback'` + `fallbackReason`；
- `src/main/judge/engine.ts:165-177`：catch 里同样直接退回规则版。

**没有任何代码在候选失败后重新选一个候选**。所以审核里那张
「候选调用失败 → 重新选择候选 → 检查独立性」的流程，是**要实现的新行为**，
不是补一条测试就能通过的。`Gate 0A` 的验收必须写成「实现 + 测试」，见 §5.1。

另外，`judgeIndependent` 本身确实是按实际身份派生的，不是读配置：
`engine.ts:42-60` 用 `participants` + `participantModelIds` 现算，
`index.ts:4023-4038` 用的是 `state.degradation?.actualParticipants`。这一条没问题。

### 2.6 V3 质量引擎真实调用 —— 部分成立，要把三件事分开说

**已接线（手动裁决路径，完整一条链）**：

```
ResearchPanel「裁决」按钮（ResearchPanel.tsx:721）
  → preload adjudicate → IPC judge:adjudicate（index.ts:4008）
  → resolveJudge（4028）→ new JudgeEngine（4040）→ engine.judge（4049）
  → evaluateDebateQuality（4052）→ finalizeDebate（4060）
  → verdicts.save（4062）→ judge:get 回读（4067）
  → 界面渲染质量报告与最终处理建议（ResearchPanel.tsx:798-827）
```

`src/main/judge/types.ts:106-108` 把 `quality?` / `finalDecision?` 做成**可选**字段，
所以旧裁决文件仍然读得出来——这一点是对的，迁移友好。

**已有真实模型证据**：`scripts/regression/run-debate-regression.cjs` 直接调用同一个
`evaluateDebateQuality` / `finalizeDebate`。`debate-regression-v1-1-completeness-latest.md`
记录：24 题全部 `quality passed`，事实维度 24 条 `model-assessed`，裁判独立 24/24。
这说明质量引擎不是只在单元测试里被调过。

**仍未闭环的两点**（审核没分开说）：

1. 辩论跑完**不会自动裁决**。`src/main/debate/orchestrator.ts:359 conclude()` 只跑
   规则版 `judgeDebate`，`backend:'rules'`；质量报告只有用户点「裁决」才产生。
   所以「V3 质量引擎 INTEGRATED」只在手动路径成立。
2. **IPC 层没有自动化测试**，且回归脚本**没有复用** `index.ts:4028-4064` 那 40 行，
   而是自己 `new JudgeEngine`、自己按轮换指定裁判（`run-debate-regression.cjs:226, 314`）。
   这意味着产品路径与回归路径会各自漂移：回归绿了，IPC 仍可能坏。

### 2.7 24 题完整回归 —— **不成立，需要纠正**

事实链：

| 提交 | 时间 | 内容 |
| --- | --- | --- |
| `8f8fb13` | 11-14 01:27 | P0 单 Provider 三模型可用，六策略真实运行 |
| `10adea2` | 11-14 10:53 | P0 使用用户配置的三个模型跑六策略 |
| `60ada0e` | 11-15 00:37 | **完整 24 题**复核（报告生成时间 00:25） |
| `6ba5fa0` | 11-15 02:02 | P3：6 道失败 + 3 道 PARTIAL **定向**回归 |
| `4125ba4` | 11-15 11:02 | 当前 main（只含 CLI/终端与 0.2.5 合并） |

`git merge-base --is-ancestor 10adea2 60ada0e` → 成立。所以那次 24 题**包含 P0/P1**。
结果：`执行 COMPLETED 21 / PARTIAL 3`，`V1 passed 18/24`，`质量 passed 24`，
`裁判 model 24/24、independent 24/24`。

真正没有的是：**P3 修复之后、当前 main 上的全量 24 题**。P3 只跑了 9 题定向
（`DEBATE_V2_P3_TARGETED.md`），6 过 3 因连接失败，问题 4 题转通过、2 题仍失败。
所以正确的表述是：

> 24 题最后一次全量运行在 `60ada0e`（18/24，含 P0/P1，未含 P3 修复）；
> 当前 main 只做过 9 题定向回归，**全量未重跑**。

这个纠正不是抠字眼：如果照原结论，Codex 会把 Gate 0C 当成「从零建基线」，
实际要做的是「在同一数据集、同一口径下与 18/24 对比」，并且必须先说清
连接失败怎么记（见 §5.3）。

---

## 3. 对审核结论的处置

| 审核事项 | 我的意见 |
| --- | --- |
| 范围只做辩论、不碰 CLI | 同意，维持 |
| 四处实现状态纠正 | 同意，全部成立 |
| `QualityStatus` 与事实核验拆两个维度 | 同意方向；本轮只写契约，不进代码 |
| `EvidencePackItem` 新增、不改 `EvidenceKind` | 同意；映射要显式，未知类型拒绝 |
| Claim 证据关联作为新契约 | 同意；但只保留一条权威边（§4.3） |
| Judge IPC 降级测试 | 同意要补，且**必须先补重选实现**，否则无行为可测 |
| V3 质量引擎端到端测试 | 同意；但要拆成「抽公共裁决函数」+「IPC 级测试」两步 |
| 24 题基线提前到 Gate 0 | 同意；表述按 §2.7 改 |
| Evidence Pack 契约评审先行 | 同意 |
| Evidence Pack Spike | 同意，验收见 §6 |
| 外部事实核验 P1、动态分工 P2 | 同意，维持 |

---

## 4. 四个契约（Gate 1）——同意先定，但每个都要写死边界

### 4.1 `FactVerificationStatus` 的挂载位置

不要挂在 `QualityStatus` 上，也不要挂成 `DebateQualityReport` 的第九个维度。
建议落成**独立记录**：

```ts
interface FactCheck {
  claimId: string;
  status: 'verified' | 'contradicted' | 'partially_verified'
        | 'insufficient' | 'conflicting' | 'not_verifiable';
  sourceUrl?: string;
  sourceVersion?: string;
  fetchedAt?: number;
  excerpt?: string;
  method: 'official-doc' | 'rfc' | 'source-code' | 'reproducible-test' | 'other';
  checkedAt: number;
  checkedBy: { agentId?: string; modelId?: string };
}
```

质量报告只**引用**这些记录（例如 `factualAccuracy.factCheckIds`），不复制状态。
理由：状态一旦被复制，两份就会不一致，而「两份不一致时以谁为准」正是这个项目
一直在避免的东西。

### 4.2 `EvidencePackItem` 与 `DebateEvidence` 的映射

```ts
type EvidencePackItemKind =
  | 'source' | 'symbol' | 'call-graph' | 'dependency' | 'test'
  | 'execution' | 'documentation' | 'configuration' | 'git-history';

interface EvidencePackItemLocator {
  path: string;
  startLine?: number;
  endLine?: number;
  symbolId?: string;
  gitRevision?: string;
}

interface EvidencePackItem {
  itemId: string;
  packId: string;
  packItemKind: EvidencePackItemKind;
  locator: EvidencePackItemLocator;
  excerpt: string;
  contentHash: string;
  collectedAt: number;
  /** 采集失败也要留一条，写清原因；不能因为读不到就不记录。 */
  status: 'ok' | 'unreadable' | 'missing-file' | 'line-out-of-range';
}
```

映射规则要写死三条：`kind`（DebateEvidence 用）由 `packItemKind` 查表得到；
表里没有的组合**拒绝**，不许默认成 `blog`；`span` 由 `locator` 换算，
越界直接判 `line-out-of-range`，不允许出现「行号超出文件长度却算有效证据」。

### 4.3 Claim 与 Evidence 只保留一条权威边

现在已经有 `DebateEvidence.claimIds`。再加 `Claim.supportingEvidence[]` 就是两套。

建议：

```ts
interface ClaimEvidenceLink {
  claimId: string;
  evidenceId: string;
  role: 'supporting' | 'contradicting' | 'context';
  strength?: 'strong' | 'weak';
  note?: string;
}
```

`DebateState.links: ClaimEvidenceLink[]` 是唯一事实来源；`Claim.evidenceRefs`
与 `Evidence.claimIds` 都由它派生，并在测试里断言两者一致。这样
`supportingEvidence` / `contradictingEvidence` 的需求由 `role` 表达，
不需要两个数组。

### 4.4 `EvidencePackStore` 的持久化边界

- Pack 独立文件（按 `packId`），内容不可变；重新采集只能产生新 `packId`，
  不许覆盖旧文件；
- `DebateState` 只存 `packId` 引用，不内嵌证据正文；
- 写用 `writeFileAtomic`（已有 `src/main/atomic-write.ts`），失败不留半份；
- 同一 `debateId` 并发创建：**要么复用已有 pack，要么明确拒绝第二个**，
  必须在契约里选一个，不能"看情况"；
- 损坏的 pack 文件：让这场辩论显示「证据不可用」，不能让整条辩论从列表里消失。

---

## 5. Gate 0 怎么算过（可直接照做）

### 5.1 Gate 0A：先补重选实现，再补 IPC 测试

拆两步，别合并：

**0A-1（现有降级路径的 IPC 级测试）**：用假 `ask` 覆盖「抛错」与「两次输出非 JSON」，
断言 `judge:adjudicate` 返回 `backend:'rules'`、`judgeMode:'rules-fallback'`、
`fallbackReason` 非空、`quality.modelAssessed === false`、`status === 'insufficient_evidence'`。

**0A-2（候选失败重选，新行为）**：`engine.judge()` 失败时不再直接退回规则版，
而是回调一个注入的 `reselection`：

```ts
reselection?: (failed: { agentId: string; reason: string }) =>
  JudgeResolution | null;
```

拿到新候选后必须**重算** `judgeMode / judgeIndependent / modelIndependence /
judgeModelId / judgeProviderId`，并把「重选过」记进裁决（例如
`judgeReselection: { from, to, reason, at }`）。测试要断言：`judgeAgentId` 变了、
`judgeIndependent` 是按新身份重算的、**不是**沿用旧值。

这一步不写进契约就永远测不出来——因为现在的代码里根本没有这个分支。

### 5.2 Gate 0B：把裁决逻辑抽出来，IPC 与回归共用

现在 `index.ts:4028-4064` 内联了「选裁判 → 判 → 出质量报告 → 存」，回归脚本自己
重写了一遍（`run-debate-regression.cjs:226`、`314`）。先抽成：

```ts
// src/main/judge/adjudicate.ts
export async function adjudicateDebate(
  state: DebateState,
  deps: { candidates(): Promise<JudgeCandidateInfo[]>; ask(...): Promise<SubAgentAnswer> }
): Promise<JudgeVerdict>
```

然后 IPC handler 与 24 题回归都调它。只有这样，回归绿才能推断 IPC 也绿。
测试覆盖四路：模型成功、模型抛错、模型两次非 JSON、无候选。

### 5.3 Gate 0C：全量 24 题，写清口径

必须记录：代码 SHA、数据集 sha256、`PROMPT_VERSION`、`--completeness` 开关、
`--workers`、每题执行结果（COMPLETED / PARTIAL / FAILED）、V1 结果、质量状态。
连接失败单独统计，**不并入 must 通过率**，也不许用「重跑一次就过」把失败题改写成通过
（`DEBATE_V2_P3_TARGETED.md` 已经立了这个规矩，保持一致）。

对比对象是 `60ada0e` 的 18/24，不是空基线。

### 5.4 Gate 0D：全量测试

`npm test`（含 typecheck）跑完留日志，记录命令、时间、失败项。不接受抽样。

---

## 6. 存储与迁移（同意补，而且现在就有具体风险）

核到的三个既有事实：

1. `DebateState`（`types.ts:522` 起）**没有 schemaVersion**，靠代码里 spread 补默认值
   （`DebateStore.get()` 补 `lead` / `plan` / `config.leadMode`）；
2. `DebateStore.get()` 在 parse 失败时 `return null` —— 一场辩论会**静默消失**，
   不是报错；
3. `VerdictStore.get()` 同样吞掉 parse 错误 —— 旧裁决会被读成「没有裁决」。

所以 Evidence Pack 引入新结构前，必须先做这四项检查：

- 老辩论文件（无 `packId`、无 `quality`）能 `get` / `list`；
- 新字段一律可选，缺失时下游有明确兜底；
- 损坏的 pack 只影响证据可用性，不影响辩论本体；
- 加一个显式 `schemaVersion` 落盘，别再靠"字段有没有"推断版本。

---

## 7. Evidence Pack Spike（同意，给出可验收的最小集）

放在 `scripts/spikes/`（已有 `debate-quality-configured.cjs` 等先例），
**不进 `src`、不注册能力、不改产品代码**。

用真实 TypeScript 仓库跑一遍：读源码 → 定位 symbol → 建 item → 生成 manifest →
算 hash → 冻结 → 改源码 → 再建快照，断言：

| 断言 | 判据 |
| --- | --- |
| 旧快照字节不变 | 重读旧 pack 文件，逐字节比对 |
| 新快照 hash 变化 | `manifestHash` 不同，且等于重算值 |
| 定位准确 | symbol 行号与 `rg -n` 结果一致 |
| 越界即拒绝 | 把 `endLine` 改到文件长度之外，必须 `line-out-of-range` |
| manifest 可校验 | 改动任一 item 的 hash，校验必须失败 |
| 历史可回放 | 用旧 pack 重新生成辩论证据，内容与当时一致 |
| 并发不互相覆盖 | 同一 debate 并发两次创建，结果符合契约选定语义 |

---

## 8. 本轮核实的真实状态

| 能力 | 状态 | 依据 |
| --- | --- | --- |
| P0 单模型 | **TESTED 10/10** | 本轮实跑 `test:p0-gaps` |
| P1 多模型核心 | **TESTED 9/9** | 本轮实跑 `test:p1-multi-model` |
| 六种策略 | IMPLEMENTED + 角色测试 TESTED | `strategies.ts` + 单/多模型用例 |
| Judge 独立性派生 | IMPLEMENTED + TESTED | `resolve.ts:44` 六条用例 |
| Judge 候选失败重选 | **NOT IMPLEMENTED** | `engine.ts:165-177` 直接 rules-fallback |
| V3 质量引擎 | IMPLEMENTED + INTEGRATED（手动裁决）+ TESTED | `index.ts:4052`、`ResearchPanel.tsx:798`、质量 5/5、24 题真实模型 24/24 |
| 辩论结束自动裁决 | **NOT IMPLEMENTED** | `orchestrator.ts:359` 只跑规则版 |
| 裁决 IPC 级自动化测试 | **NOT PRESENT** | `scripts/*.mjs` 无一加载 electron / IPC |
| 24 题全量 | **TESTED 18/24 @ `60ada0e`**；当前 main 未重跑 | 报告 + `merge-base` 验证 |
| Evidence Pack | SPECIFIED | 全仓 0 命中 |
| 工程辩论闭环 | NOT STARTED | — |
| 外部事实核验 | NOT STARTED | 全仓无 `FactVerification` |
| 存储迁移校验 | NOT DONE | 无 `schemaVersion`，读取吞异常 |

---

## 9. 最终审核意见

**有条件批准这份修订方向，Gate 顺序照用。**

但下面四条必须先改口径，否则 Codex 会照着错的验收去做：

1. **Gate 0A 是「实现 + 测试」**，不是只补测试。没有重选分支，测试无从断言；
   重选后必须重算 `judgeIndependent`，不许沿用旧值。
2. **Gate 0B 先抽公共裁决函数**，让 IPC 与 24 题回归走同一条链；否则回归绿
   不代表产品路径绿。
3. **Gate 0C 的表述改为「当前 main（含 P3 修复）上的全量重跑，对比 `60ada0e`
   的 18/24」**，不是「从零建基线」。
4. **四个契约本轮只写文档、不落地类型**，避免又一次把 SPECIFIED 写成 IMPLEMENTED。

在这些完成前，维持三条禁令：

- 不宣称 Evidence Pack 已实现；
- 不宣称工程辩论闭环已完成；
- 不把 18/24 写成更高数字，不把 `model-assessed` 写成 `fact-verified`。

一句话：**方向批准，先做 Gate 0；Gate 0 没过之前，Evidence Pack 一行代码都不要写。**
