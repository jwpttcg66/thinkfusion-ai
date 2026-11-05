# Phase 2：回应、修订与预算

对应任务书 Phase 2（挑战、回应、修订、停止条件和预算）与 AC-06 / AC-07。
分支 `0.1.1`，接在 Phase 1 之后。

## 交付了什么

| 文件 | 变更 |
| --- | --- |
| `src/main/debate/revision.ts`（新增） | 决策解析、修订记录、状态回写 |
| `src/main/debate/types.ts` | `DebatePhase`、`RevisionDecision`、`DebateRevision`、`DebateBudget`；`DebateRound.phase?`、`DebateState.revisions?` |
| `src/main/debate/orchestrator.ts` | 阶段化轮次、单次超时、整场预算、并发上限、回应后的停止判断 |
| `src/main/index.ts` | 会话内辩论改成 3 轮（表态 → 质疑 → 回应），带预算 |
| `scripts/check-debate-revision.mjs`（新增） | 12 条用例，已接进 `npm test` |

## 四个决定

1. **一轮一个步骤，用 `phase` 记下来。** 任务书的 `DebateRound` 有 `phase`
   字段，这里的对应是：第一轮 `analysis`（独立表态）、第二轮 `challenge`
   （质疑）、第三轮起 `response`（回应与修订）。所以会话内辩论从 2 轮改成 3 轮
   ——两轮的话「回应」这一步根本不存在，AC-06 的决策永远记不到。

2. **决策优先读模型自己写的那一行。** 提示词要求第一行只写
   `决策：accept / defend / revise / withdraw / inconclusive`。读到了记
   `source: 'stated'`；没读到就按措辞（「我撤回」「你说得对」「无法判断」）或
   与上一轮发言的相似度推，记 `'inferred'`；两样都不成立就记 `null` +
   `'unknown'`，不替模型挑一个。三种来源都落盘，事后能分清哪条是它说的。

3. **修订记录保留前后原文。** `before` 取这位最近一次**表态或回应**的原文，
   跳过质疑轮——质疑轮里他说的是「你哪里不对」，拿它当 before，记录就成了
   「质疑 → 修正」的对照，看不出原来的立场有没有变。

4. **预算只做拿得到的两个维度：时间与并发。** 单次调用 60 秒（会话内辩论给
   90 秒）、整场 4 分钟、同时问 3 位，都是任务书第 10 节的默认值，可被调用方
   覆盖。Token 与费用没有数据来源（本地 Ollama 与网页通道都不报用量），
   类型里就不留这个字段。

## 停止条件

按任务书 §6.4 补了两条，都受 `convergenceStop` 控制（关掉就是「打满轮数」）：

- 文字收敛：同一参与者两轮发言相似度 ≥ 0.9（原有）；
- **没有人改口，也没有新争议**：回应轮里全是 `defend` / 判不出来，停。
  判据与「收敛」分开，因为看的东西不同——收敛看文字像不像，这条看决定。

时间预算到点也会停，理由写进 `stopReason`，已经说完的话保留。

## 验证

`npm run test:debate-revision`，12 条，全过：

- 决策行中英文都认（`决策：修正`、`【决策】withdraw`、`决策：不接受…` → defend）；
- 没写决策行时按措辞/相似度推，并标 `inferred`；推不出来记 `null` + `unknown`；
- 修订记录保留前后原文，`targetClaimIds` 只含自己的句子；
- 状态回写：撤回 → `withdrawn`、接受 → `revised`、判不了 → `unresolved`、
  坚持 → 仍留在 `challenged`（不升成 `supported`，那是裁判的事）；
- 三轮的 phase 依次是 analysis / challenge / response；
- 单次超时算这一位失败，不拖住整轮；整场预算到点停，已完成的轮保留；
- 并发上限 1 与 2 都真的限住了（峰值并发有断言）；
- 回应阶段没人改口、也没有新争议时提前停，理由写清楚；
- 老辩论文件没有 `revisions` / `phase` 字段，读回来是 `undefined`。

`npm test` 全量通过，`typecheck` 与构建通过。

## 没做的 / 需要注意的

- **没跑真机辩论**：本机只有一个可用本地模型，会话内辩论要求两位辩手，会被
  如实跳过。3 轮 + 4 分钟预算这条配置因此**只在测试里验证过**，等有第二个
  可用模型（云端 Key 或第二个本地模型）时再跑一次真机，确认耗时与记录。
- **决策是模型自己报的**，不是系统验证过的。它写 `revise` 但文本没改，系统
  不会纠正——那需要裁判（Phase 3）比较修订前后的主张。
- **没有事件流**：修订记录仍是整份快照的一部分，断电恢复靠最后一次写盘。
  任务书的 `debate_events` 与幂等键留到 Phase 2c。
- **界面不展示**修订记录。Phase 4 再画。
