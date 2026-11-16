# V4.1 P1-B：ClaimEvidenceLink 完整链路

- 分支 / 工作树：`0.2.9` / `/Users/yalla/data/localLab/thinkfusion-ai-0.2.9`
- 前置：P1-A 诊断补强
- 结论：**关联的写入、校验、持久化与回放已接入辩论收尾；Pack 作为关联来源留到 P2**

---

## 1. 契约

### 1.1 创建时机与责任方

| 项 | 决定 |
| --- | --- |
| 时机 | `DebateOrchestrator.conclude()`：裁判生成 `judgments / verdict` 之后、落盘之前 |
| 责任方 | 确定性代码 `buildClaimEvidenceLinks(state)`，不让模型直接写关联 |
| 输入 | 当前轮次的 `claims`、`evidence`、`judgments` |
| 输出 | `DebateState.claimEvidenceLinks`（整体重建，不做增量拼接） |
| 旧记录 | 字段缺失读成 `undefined`；不迁移、不回填 |

整体重建而不是增量合并的理由：关联必须跟随 claim/evidence/judgment 的最终状态，增量拼接会留下指向已删除对象的悬空引用。

### 1.2 关系规则

| 来源 | 何时产生 | relation | 依据 |
| --- | --- | --- | --- |
| `judge` | 裁判在 `evidence` / `counterexample` 维度引用了该证据 | 由主张结论派生 | `supported/partially_supported → supports`；`unsupported/contradicted → contradicts`；其余 `context` |
| `judge` | 反例维度 `refuted` | `contradicts` | 反例成立优先于主张结论 |
| `author` | 证据的 `claimIds` 指向该主张，且裁判没有对同一对给方向 | `context` | 作者/页面只标明「这句话引用了它」，没有标明支持或反驳 |
| `reviewer` | **未实现** | — | 没有可靠的 reviewer→evidence 记录；不猜 |
| `pack` | **未实现（P2）** | — | Pack 条目的 relation 必须由 P2 的显式关联输入给出，映射层不自动生成 supports |

同一对 `(claimId, evidenceId)` 只保留一条：裁判方向优先，作者 `context` 不重复写入。

### 1.3 校验

`validateClaimEvidenceLinks(state, links)` 检查：

- `debateId` 与当前辩论一致；
- `claimId` 存在于当前 claims；
- `evidenceId` 存在于当前 evidence；
- 同一 `(claim, evidence, relation, source)` 不重复。

返回 `{ valid, errors }`：非法项被过滤，但错误逐条报告。构建器本身只从当前集合取对象，因此正常路径不会产生悬空引用；校验器用于外部导入、回放和测试。

### 1.4 生命周期

| 事件 | 行为 |
| --- | --- |
| 辩论收尾 | 重建 `state.claimEvidenceLinks` |
| 停止/取消 | `conclude()` 同样执行，关联与结论一起落盘 |
| 再次收尾（resume / 重算） | 重新构建，幂等；不追加重复项 |
| Claim 变化 | 旧 claimId 不再出现在当前 claims → 重建时自动消失 |
| Evidence 去重 | 去重后的证据仍以原 id 存在；若上游删除某条，重建时不再写入 |
| Pack 回放 | 只影响 evidence 内容；关联在状态层，不会从 Pack 里再生成一套 |
| 持久化 | 随 `DebateState` 由 `DebateStore` 写盘；读取旧文件得到 `undefined` |

### 1.5 不做的事

- 不把关联写进 Evidence Pack；
- 不让映射层替调用方决定 supports/contradicts；
- 不修改裁判评分或质量门；
- 不提供 UI 编辑入口；
- 不把 `context` 当支持证据计数。

---

## 2. 实现位置

| 文件 | 作用 |
| --- | --- |
| `src/main/debate/claim-evidence-links.ts` | `buildClaimEvidenceLinks` / `validateClaimEvidenceLinks` / `isSupportLink` |
| `src/main/debate/orchestrator.ts` | `conclude()` 中写入 `state.claimEvidenceLinks` |
| `src/main/debate/types.ts` | 既有 `ClaimEvidenceLink` 与可选字段 |

关联没有第二份存储：与辩论状态同文件、同原子写路径。

---

## 3. 测试

`npm run test:claim-evidence-links`：**7/7 通过**。

| 用例 | 钉住的事 |
| --- | --- |
| 作者 vs 裁判 | 作者只能 `context`；裁判引用同一对时以裁判方向为准 |
| unsupported / insufficient | `contradicts` / `context` 不混 |
| 反例 refuted | 即使主张 supported，也记 `contradicts` |
| 幂等与顺序 | 重复构建结果完全相同，按 claimId/evidenceId 排序 |
| 校验器 | 未知 claim、未知 evidence、跨 debate、重复项全部报错 |
| 持久化 | 写入 `DebateStore` 后原样读回 |
| 真实辩论 | 跑完一场带页面引用的辩论，关联非空且无悬空引用，读盘一致 |

---

## 4. 验收对照

| 验收项 | 状态 |
| --- | --- |
| 真实辩论能够创建关联 | 满足（e2e 用例） |
| 无悬空引用 | 满足（e2e + 校验器） |
| supports / contradicts / context 语义正确 | 满足（方向由裁判结论派生） |
| 持久化与回放 | 满足（DebateStore 往返） |
| 重复关联不一致 | 满足（构建去重 + 校验报错） |
| context 不误算支持 | 满足（作者只写 context；消费方按 relation 判断） |

---

## 5. 对 P2 的交接

1. Pack 创建后，调用方需要显式给出 `pack` 来源的关联输入；映射层不会自动把 Pack 条目变成 supports。
2. Pack 与 debateId 的绑定放在 Pack manifest/状态层，不往 Pack 里塞关联表。
3. 工程执行失败是否升级为 `contradicts`，属于 P3 的规则，不在 P1-B 里猜。
4. `reviewer` 来源需要真实的 reviewer 记录后再启用；当前没有写入方。
