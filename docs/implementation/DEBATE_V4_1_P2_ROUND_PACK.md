# P2 每轮代码引用 Pack

- 分支 / 工作树：`evidence-producer` / `/Users/yalla/data/localLab/thinkfusion-ai-evidence-producer`
- 前置：基准一致性 resolver（`2700a64`）
- 本轮范围：把每轮发言/主张里的代码引用冻结成 round Pack
- 明确未做：supports/contradicts 判断

> **状态更新（P2-Final）**
>
> 下文记录了 round Pack 的第一版状态结构；当前代码已增加：
>
> - `items[]`：itemId / path / 行范围 / 候选 claimIds；
> - `DebateState.packEvidence`：映射后的 `DebateEvidence`；
> - `DebateState.packEvidenceLinks`：`source: 'pack'` 的 context 关联；
> - Pack 生命周期与 GC：见 `DEBATE_V4_1_P2_FINAL_GC.md`。
>
> supports/contradicts 仍未实现。

---

## 1. 实现

### 1.1 Pack 上下文

`EvidencePackManifest` 新增可选 `context`：

```ts
{
  kind: 'baseline' | 'round';
  debateId: string;
  roundIndex?: number;
  baselinePackId?: string;
}
```

- 参与 manifest hash；
- 旧 Pack 没有 `context`，hash 输入不变，仍可 replay；
- baseline Pack 记录 `kind: 'baseline'`；
- round Pack 记录 `kind: 'round'`、轮次与 baselinePackId。

### 1.2 RoundEvidenceProducer

`src/main/evidence-pack/round-evidence.ts`

```text
round.messages + round.claims
  → extractCodeReferences
  → resolveBaselineCodeReference（只读开场 Pack/commit）
  → 去重 + 逐条错误
  → store.publish（context: round, baselinePackId）
  → DebateState.roundEvidencePacks[]
```

- 没有代码引用：不写空记录；
- 只有无效引用：记录 `partial`、`packId` 为空、错误逐条保留；
- 有有效引用：生成 round Pack，状态 `complete` 或 `partial`；
- 引用来自 dirty 文件还是 clean 文件，由基准 resolver 决定，round Pack 只冻结结果；
- Pack 失败：记录 `failed`，不阻断辩论。

### 1.3 映射与关联

round Pack 发布后：

1. 用 `mapPackToDebateEvidence` 把 Pack 条目映射成 `DebateEvidence`；
2. 追加到 `DebateState.packEvidence`，每轮 `buildEvidence` 后按 evidenceId 合并回
   `state.evidence`；
3. 为每条 `claimIds` 写 `ClaimEvidenceLink`：
   - `source: 'pack'`
   - `relation: 'context'`（只表示引用，不表示支持）
   - `evidenceId = pack:<packId>:<itemId>`
4. `conclude()` 重建关联时保留 pack 链接；若同一对证据被裁判判 supports/contradicts，
   方向优先级覆盖 context。

**边界**：Pack 证据的 `claimIds` 为空（context 不能冒充支持），所以当前
`judgeEvidence` 不会把它计为支持证据；裁判真正引用 Pack 留在 P3。

### 1.4 状态

`DebateState.roundEvidencePacks?: DebateRoundEvidencePack[]`：

```ts
{
  roundIndex;
  status: 'complete' | 'partial' | 'failed' | 'unavailable';
  packId?;
  itemCount;
  claimIds: string[];   // 候选关联，不是 supports
  errors: string[];
  createdAt;
}
```

`claimIds` 只表示「这条主张的原文里出现了这个代码引用」，**不表示支持/反驳**。

---

## 2. 测试

`npm run test:round-evidence-pack`：**5/5 通过**。

| 用例 | 结果 |
| --- | --- |
| clean 基准引用 | round Pack 内容来自开场 commit |
| dirty 基准 | 冻结 dirty 内容，辩论后改工作区不影响 |
| 只有无效引用 | `partial`，无 Pack，错误保留 |
| 没有代码引用 | 不写空记录 |
| 基准 partial | round Pack 也只能 `partial` |
| 映射与关联 | Pack 条目进入 `state.evidence`，写 `source: 'pack'` 的 context 关联；校验无悬空 |

全量：`npm test` **108 个文件全过**；typecheck 三套全绿。

---

## 3. 已知限制

1. **Pack 关联只有 context**：`source: 'pack'` 已写入，但不会自动变成 supports。
2. **同步生成**：round Pack 在轮次收尾同步发布；dirty 文件多时会增加该轮耗时。
3. **重复轮次**：幂等键是 `debate:<id>:round:<index>`；如果同一轮因恢复被重跑且内容变化，会得到 `PACK_CONFLICT` 并记 `failed`，不会覆盖旧 Pack。
4. **没有符号/代码索引解析**：只有文本里的 `path:line` / `#Lx-Ly` 才会成为候选。
5. **没有每轮 Pack 清理策略**：当前只增不减。

---

## 4. 下一步

1. 为 `claimIds` 生成显式 `ClaimEvidenceLink(source: 'pack')`：
   - 默认只能记 `context`；
   - supports/contradicts 必须由裁判/显式判断产生；
2. 把 round Pack 的 evidenceId 映射成 `DebateEvidence`，让裁判能引用；
3. 定义 Pack 保留/清理策略；
4. 真实辩论端到端回归。
