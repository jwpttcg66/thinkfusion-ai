# Synthesis 综合系统审计（Phase A）

审计日期 2026-11-04。路径相对 `desktop-agent-macos/`。

## 现在跑的是哪一份

**只有一份规则版综合在跑**：`src/shared/synthesizer.ts:564` 的
`synthesize(inputs)`，由 `src/main/master-agent.ts:153` 在所有通道回答收齐后调用。

`src/shared/fusion.ts` 和 `src/main/synthesis/` 下的三个文件是 Phase I 的
前置材料，**未接线、未被任何运行路径引用、无测试**。审计时不要把它们的
能力算进「现有能力」。

## 数据结构

`src/shared/conversation.ts`

| 位置 | 结构 | 说明 |
| --- | --- | --- |
| `:86` | `Claim` | `text` + `sources: [{channelId, messageId}]` + `evidence: string[]` |
| `:93` | `Dispute` | `topic` + `positions[{channelId, stance}]` + `pivot`（真正分歧的那对句子） |
| `:101` | `Gap` | `topic` + `why` |
| `:106` | `Synthesis` | `consensus: Claim[]` / `disputed: Dispute[]` / `unique: Claim[]` / `gaps: Gap[]` / `overlap?` / `recommendation` / `degraded?` |

两个字段值得单独说：

- `degraded?: boolean`（`:123`）：答案切不成观点时，结果只是把各回答并排放，
  UI 必须说明这不是真的综合。这条语义在 Phase I 不能丢。
- `Claim.sources` 带 `messageId`：这是**溯源到原始回答**的唯一锚点。

## 规则版判据

`src/shared/synthesizer.ts` 的常量与函数（审计时行号）：

| 位置 | 内容 |
| --- | --- |
| `:24` | `NEGATIONS`：不 / 没 / 无 / 非 / 别 / 勿 / 禁止 / 避免 / 无需 / 不能 / 无法 / 并非 / 不会 |
| `:34` | `STOP_BIGRAMS`：停用双字 |
| `:58` `:59` | `FIGURE`（带单位的数字）、`BARE_LONG_NUMBER`（3 位以上裸数字） |
| `:62` | `MAX_PHRASE_CHARS = 5` |
| `:121` `:123` | `SENTENCE_SPLIT`（句末标点 / 换行）、`MIN_SENTENCE_CHARS = 12` |
| `:95` `:108` | `PARTICLES`、`BOUNDARY_CHARS`：中文分词替代物 |
| `:144` | `features()`：字符 bigram + ASCII 词。中文不引分词器 |
| `:155` | `jaccard()` |
| `:162` `:166` `:171` `:179` | `negationCount` / `numbersIn` / `figuresIn` / `topicsOf` |
| `:231` | **聚类阈值 `jaccard >= 0.34`** |
| `:318` | `channels.size >= 2 && < channelCount` 判「争议/独有」 |
| `:344` `:358` | `FILLER`、`conclusionOf()`：结论句识别 |
| `:626` | 跨通道 `cluster.channels.size >= 2` 才进共识 |

这些函数在 Phase B 的准备工作里加了 `export`，让新模块复用同一套判据，
避免两处对「相似」「否定」的定义漂移。**逻辑一行没改。**

## 已知的能力边界

1. **字面相似不等于逻辑等价**。「有多线程」和「没有多线程」的 bigram 几乎
   一样，规则版靠 `negationCount` 拆，但这是启发式，不是 NLI。
2. **没有证据来源**。网页回答里引用的文档、链接、代码块都不进 `Evidence`，
   `Claim.evidence[]` 装的是同义句，不是可核查的出处。
3. **没有少数派保护机制**。规则版会按 `channels.size` 分类，但没有「有充分
   证据的少数派必须保留」这条硬约束。
4. **没有置信度解释**，`recommendation` 是一段拼出来的文字。
5. **多数票不等于正确**：三个模型读同一篇博客、错在同一处，`support` 算 3。
   这是 `ARCHITECTURE.md` 11.8 的第一条红线。

## 未接线的 Phase I 材料

`src/shared/fusion.ts`（185 行）定义了 `ClaimKind`、`ClaimSpan`、
7 种 `RelationKind`、`EvidenceScores`（7 维）、`FusedClaim`、`FusionReport`
和 `toSynthesis()` `:149`（转回现有界面契约）。`FusionReport.backend`
目前写死 `'local'`，留出 `'remote'` 的位置。

`src/main/synthesis/`：

| 文件 | 阶段 | 状态 |
| --- | --- | --- |
| `claim-extractor.ts` | 1 切句、标类型、抽前提 | 写完，未接线 |
| `clusterer.ts` | 2 并查集聚类，`SIMILAR_THRESHOLD = 0.34` `:33`，同通道不合并 | 写完，未接线 |
| `relations.ts` | 3 关系判定 | 写完，未接线 |
| `evidence.ts` / `ranker.ts` / `engine.ts` | 5 / 7 / 8 | **尚未创建** |

## 项目书 9.2 的冲突

项目书把 `FinalSynthesis.consensus` 写成 `string[]`，比现状的 `Claim[]`
**少了 `sources` 和 `evidence`**；而同一份文档的决策 6 要求「原始答案不可
丢失」、9.3 要求「关联原始发言 ID」。字符串化之后溯源就是空话。

已裁决：**保留 `Claim[]`，在它上面扩字段**，不退化成 `string[]`。
见 `docs/implementation/MULTI_MODEL_UPGRADE_PLAN.md` 第五节。

## Phase I 的接法

新引擎产出 `FusionReport` → `toSynthesis()` 并回现有 `Synthesis` → UI 不改。
新引擎失败时退回规则版 `synthesize()`，不抛错（`ARCHITECTURE.md` 11.9 的
降级要求）。排序分数只决定「先讲哪个」，不声明「哪个是真的」。
