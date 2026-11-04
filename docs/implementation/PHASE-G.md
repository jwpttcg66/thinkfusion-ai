# Phase G 实施记录：多轮辩论系统

对应项目书第八章、第十五章 Phase G。日期 2026-11-04。核心功能阶段。

## 存储前提（计划里的裁决调整）

计划原写「G 之前先按天分文件」，落地改成**每场辩论一个独立文件**
（`userData/debates/<id>.json`），理由是不动 `AgentStore`：主 journal 每次
mutation 全量重写整个 state，辩论一轮就有 N 条发言，塞进去会拖慢所有写入，
还要把老数据的读取路径全改一遍。独立文件同样避开写放大，恢复只需读一个
文件，且旧功能零风险。文件用 `writeFileAtomic` 原子写，`0o600`。

## 新增

| 文件 | 内容 |
| --- | --- |
| `src/main/debate/types.ts` | `DebateConfig` / `Round` / `Message` / `State`，三种策略的默认轮数 |
| `src/main/debate/store.ts` | 每场一文件、列表、删除、路径穿越防护 |
| `src/main/debate/orchestrator.ts` | 三种策略、角色、交叉质疑、修正、自动停止、中止、恢复、少数派 |
| `src/main/agents/types.ts` 等 | `SubAgentTask.system` 结构化指令通道 |
| `src/main/index.ts` | `debate:start/get/list/stop/resume` 五个 IPC |
| `scripts/check-debate.mjs` | 13 条测试 |

## 与网页提问链路的边界

这是本阶段最重要的一条设计。**辩论的指令只走 `SubAgentTask.system`**
（本地/云端 API 的 system 轮次），`question` 永远是用户原话；`WebChannelProvider`
忽略 system，所以页面上永远不会出现「请质疑以下观点」这类包装话术。
`eligible()` 因此把网页成员排除在辩论之外——让它参与只会得到一遍又一遍对
原问题的独立回答，看着像辩论其实没有交锋。

## 三种策略与自动停止

| 策略 | 默认轮数 | 轮次内容 |
| --- | --- | --- |
| `standard` | 2 | 独立观点 → 交叉质疑 |
| `deep` | 3 | + 逐条回应与观点修正 |
| `adversarial` | 3 | 角色分工 proposer / critic，要求明确反驳 |

停止条件有三个：**轮数上限**、**观点收敛**（本轮与上轮 bigram 相似度 ≥0.9）、
**用户中止**。理由写进 `stopReason`，不把「打满轮数」和「真的没分歧了」混成一句。

`stop()` 与 `resume()` 用 generation 代号隔离：中止后立刻恢复时，上一代 run
还没退出，没有代号它会把新状态覆盖回去。写盘前只同步外部 status、不用外部
rounds 覆盖内存，避免丢掉用户喊停那一瞬已经生成的发言（决策 6）。

## 少数派与原始回答

- 每条发言存原文；修正是**另一条** `revision` 消息并带 `targetMessageId`，
  不覆盖 `position`。
- 少数派用规则版 bigram Jaccard（同一套 `features/jaccard`，阈值 0.34）找出
  与同轮其他人都不像的发言，完整保留。判断不了时宁可多留。
- 单成员失败记进 `round.failures`，不拖垮整轮，也**不把它的活转给别人**
  （那是悄悄改参与名单）。

## 验收对照（项目书 Phase G）

| 要求 | 状态 |
| --- | --- |
| 至少两个不同模型参与 | ✅ 少于两个直接拒绝；eligible 过滤 |
| 第一轮独立生成观点 | ✅ 测试断言 context 为空 |
| 第二轮看到并质疑其他观点 | ✅ context 为上一轮全部发言，system 指令要求逐条质疑 |
| 后续轮逐条回应质疑 | ✅ `revision` 轮 |
| 模型可以修改原始观点 | ✅ 修正另存一条，原文保留 |
| 少数派观点完整保留 | ✅ `minorities` + 测试 |
| 达到上限后停止 | ✅ 三种策略轮数 |
| 用户可以中止 | ✅ `stop()` + `debate:stop` |
| 完整过程可恢复和查看 | ✅ 独立文件、重启可读、`resume()` 不重跑 |

## 测试

```
npm run test:debate   13 条，全绿
npm test              266 条全绿
npm run typecheck / build 通过
```

## 没做的

- **没有真机辩论**：本机只有一个本地模型、云端无 API Key，`eligible()` 过滤后
  不足两个成员，真机跑不起来。逻辑链路（含中止/恢复）全部有测试。
- **UI 的辩论设置与时间线**（Phase J）。
- **Judge 裁决**（Phase H）。
