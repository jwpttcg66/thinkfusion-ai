# Phase 1：辩论里的结构化主张与争议

对应任务书 Phase 1（独立分析 / Claim 提取 / 争议检测 / 基础综合）与
AC-03 / AC-04 / AC-05。分支 `0.1.1`。

## 交付了什么

| 文件 | 变更 |
| --- | --- |
| `src/main/debate/claims.ts`（新增） | 抽主张、判争议、排序、生成挑战 |
| `src/main/debate/types.ts` | `DebateClaim`、`DebateDispute`、`ClaimStatus`、`DisputeType`；`DebateRound.claims?`、`DebateState.disputes?` |
| `src/main/debate/orchestrator.ts` | 每轮结束算结构化结果；下一轮挑战指向具体两句 |
| `scripts/check-debate-claims.mjs`（新增） | 10 条用例，已接进 `npm test` |

没有新判据。切句用 `synthesis/claim-extractor.ts`，关系判定用
`synthesis/relations.ts`——这两份原本只服务网页回答的综合。Phase 1 做的是把
它们接到辩论上，并把产物落进辩论文件。

## 三个决定

1. **只认跨参与者的冲突。** 同一个模型前后两句相反，是它自己在论证（很常见，
   「有人说 X，但这种说法站不住」）。按两家分歧报出去，读的人会以为有两个立场。
   上一版综合卡里那种「某家说 A／某家说 B」的假分歧，就是这么来的。

2. **争议类型只给判得出来的三种。** `factual`（极性相反）、`evidence_conflict`
   （两边都给数字且对不上）、`scope`（一边带条件、一边是绝对表述）。
   `logical` 只在「有转向词且指向同一件事」时出现，判据弱，所以排在最后。
   任务书的 `definitional`（定义差异）规则判不了，**类型里就不给这个值**，
   而不是塞进 `factual` 冒充。

3. **`priority` 只是排序。** `impact`（按主张类型粗分）× 规则判这条冲突的
   把握，写成 0–1 的数是为了有个稳定的先后顺序。它不是「谁更可能正确」的概率，
   comment 里也这么写。

## 挑战长什么样

第二轮发给辩手的 system 里会多出这样一段（来自上一轮的实际冲突）：

```
这一轮先处理下面几处具体冲突，它们都是上一轮里彼此对不上的两句：
- 直接矛盾：「这个接口提供了多线程安全保证，可以放心并发调用。」 对 「这个接口没有提供多线程安全保证，不能并发调用。」。请指出哪一句不成立，并给出能区分二者的证据。
```

最多三条。挑战一多，模型就会挑好答的回。没有争议时这一段不出现，第二轮回到
原来的通用指令——不硬造。

## 验证

`npm run test:debate-claims`，10 条，全过。钉住的是这几件事：

- 切句带原话位置（`span` 切回去必须等于原文）；
- 极性相反 → `factual`，数字对不上 → `evidence_conflict`，条件句 vs 绝对句 → `scope`；
- 同一个 agentId 的两句相反 → **不产生争议**；
- 各说各的 → 不产生争议；
- 挑战最多三条、每条都带原话；
- 编排器跑两轮：第一轮没有挑战段，第二轮 system 里出现「直接矛盾」和具体句子；
- 没有争议时第二轮不出现挑战段；
- 老辩论文件（没有 `claims` / `disputes` 字段）读回来照常能跑。

`npm test` 全量通过，`npm run typecheck` 通过。

## 没做的

- **界面不展示** claim/dispute。它们在辩论文件与挑战指令里，Phase 4 再画。
- **不做修订决策**（accept/defend/revise/withdraw/inconclusive）。`ClaimStatus`
  只用到 `proposed` / `challenged`，其余四个值留给裁判（Phase 3），不自己发明规则。
- **不做定义差异检测**，理由见上。
- **没有跑真机辩论**：本机只有一个本地模型，辩手不足两位，会话内辩论会被如实
  跳过；结构化层由上面那组用例覆盖。等有第二个可用模型时再补一次真机记录。
