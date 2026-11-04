# Phase I 实施记录：Synthesis 升级

对应项目书第九章、第十五章 Phase I，以及 `ARCHITECTURE.md` 第 11 章。
日期 2026-11-04。上一轮冻结的四个算法文件在本阶段接线并一起提交。

## 补齐的链路

```
抽取 claim-extractor → 聚类 clusterer → 关系 relations
  → 证据 evidence（七维）→ 排序 ranker（成对比较）→ 合成 engine
  → toSynthesis() → 现有 Synthesis 契约
```

新增 `evidence.ts` / `ranker.ts` / `engine.ts`；`shared/fusion.ts` 和
`shared/conversation.ts` 各加**可选**扩展字段，没有替换、没有退化。

## 保留现有能力（项目书 9.1 / 决策 9）

- `Synthesis` 原有字段一个没动：`consensus: Claim[]` 仍是 `Claim[]`，
  `sources[{channelId, messageId}]` 和 `evidence[]` 都在，没有变成 `string[]`。
- `fusion` 是可选字段。老数据、规则版综合读不到它，界面按原卡片显示，
  不需要数据迁移。
- `ConversationRunner` 的 `fusionEnabled` 默认关闭；打开后如果融合引擎抛错，
  **静默保留原来的规则版 `synthesize()` 结果**，不抛错（11.9 的降级要求）。

## 六项新增（项目书 9.x）

| 要求 | 落点 |
| --- | --- |
| Debate Result | `fusion.debateId` + `finalDecision` |
| Evidence | `fusion.evidenceCount` / `FusionReport.evidence[]`（七维分） |
| Rejected Claims | `fusion.rejected[]`，**保留原文**，只标注为什么被否定 |
| Unresolved Questions | `fusion.unresolvedQuestions[]` 与 `gaps` |
| Final Decision | `fusion.finalDecision`，没有裁决时是 `null` |
| Confidence Explanation | `fusion.confidence.{level, why}` |

## 排序借鉴了 LLM-Blender 的成对比较，但没照搬目标

`ranker.ts` 不把七个证据维度压成一个绝对分再排序——权威性 0.7 和相关性
0.7 本来不可比，压成同一个数是假精度。改成每次比较两条观点，输出
`-1 / 0 / 1` 加一句理由，用插入排序（K 很小）。

不照搬的是目标：LLM-Blender 是 best-of-N 选优，会把「三个通道意见不同」
压成「取最好的那一个」，正是 11.8 红线「多数票当真理」的变体。这里排序
**只决定先讲哪个**，`limits` 里明写了这一条。

## 算法红线

- 没有跨通道共识 → `degraded: true`，recommendation 明说「只是回答并列」，
  不包装成一致。
- 同通道重复自己不算共识，`support` 仍是 1。
- 「有」/「没有」字面高度相似 → `contradicts` 边 + 理由，不聚成一伙。
- 条件句抽成 `assumptions`，条件不同不硬判矛盾。
- `timeliness` 本地判不了写 `null`，`independence` 只区分「有没有第二个通道
  说过同样的话」，不做来源谱系、不冒充事实核查。
- 每条 `ArgumentRelation` 都带 `reason`，写不出理由就不建边。

## 测试

```
npm run test:fusion   11 条，全绿
npm test              291 条全绿
npm run typecheck / build 通过
```

钉住的反例：空输入与单回答都 degraded、同通道三遍不算共识、否定极性相反
必出 contradicts、条件句进 assumptions、timeliness 为 null、排序不声明真伪、
`Claim[]` 的 sources/evidence 没丢、裁决接入后 finalDecision/unresolved 正确、
无法确定时不硬给结论、少数派原文保留。

## 真机接线

`main/index.ts` 给 `ConversationRunner` 传了 `fusionEnabled: true` 和
`verdictFor`（按 conversationId 查本进程里最近一次裁决）。`judge:adjudicate`
时若辩论关联了 conversationId，会把裁决记进这张表。**重启后这张表不持久化**，
只影响本次会话里「裁决 → 下一次综合」的联动；裁决本身已独立落盘，不丢。

## 没做的

- **远程后端**：`FusionReport.backend` 仍是 `'local'`。协议留了位置，
  没有实现远程调用（用户要求先做本地）。
- **关系图 UI**（Phase J 只展示摘要卡片，不画图）。
- **`timeliness`** 需要联网才知道，本地永远 null，写在 `limits` 里。
