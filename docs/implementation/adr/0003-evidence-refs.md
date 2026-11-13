# ADR-0003：Engineering Evidence 的引用与冻结

- 状态：Proposed
- 日期：2026-11-12
- 适用：Gate 3

## 背景

V2 的 `EngineeringEvidencePack` 只保存 `evidenceRefs`，不复制内容。方向正确，但现有类型没有稳定 ID：

- `EngineeringEvidence` 只有 `path/line/excerpt/sha256/mtime/readAt/why`，没有 `evidenceId`。
- `ExternalHit` 只有 `source/title/content/confidence/path/line`，没有 `hitId`。
- `RetrievalItem` 有 `id`，`MemoryFact` 有 `factId`。
- 旧 generation 清理后，Pack 可能指向不存在的数据。
- `ConclusionStatus` 与现有 `Verdict` / `ClaimStatus` 有重叠。

## 决策

### 稳定 ID

- `EngineeringEvidence.evidenceId = sha256(path | line | endLine | sha256(file) | excerptHash)`。
  - 不含 `readAt`，同一版本同一片段重复读取得到同一 ID。
  - 文件内容变化 → sha256 变化 → 新 ID；旧 ID stale。
- `ExternalHit.hitId = sha256(source | path | line | title | contentHash)`。
- `RetrievalItem.id` 已有；`MemoryFact.factId` 已有。

### Pack

```
EngineeringEvidencePack {
  id
  projectId
  generation
  createdAt
  taskId?
  evidenceRefs: Array<{
    type: 'engineering-evidence' | 'retrieval-item' | 'memory-fact' | 'external-hit'
    id: string
    generation?: number
    sha256?: string
  }>
  sourceSnapshot: {
    gitCommit?
    branch?
    dirty?
    workingTreeFingerprint?
  }
  status: 'complete' | 'partial' | 'stale'
}
```

- `sourceSnapshot` 对非 git 工程使用目录指纹（索引文件内容 hash 的集合 hash）。
- Pack 创建后不重新检索；所有参辩模型共享同一 `packId` / `generation`。

### GC 与 stale

- 新增 `code_evidence_ref(pack_id, evidence_id, type, generation)` 引用表。
- 清理旧 generation 前检查引用；被引用的证据 pin 住，或保留最小不可变摘要（path/line/sha/excerpt hash）。
- 解析 Pack 时校验 `sha256` / generation；不匹配 → `status = stale`，不静默跳过。
- stale 证据不能支撑 `verified`。

### Claim 关联与状态

- `DebateClaim` 增加 `engineeringEvidenceIds?: string[]`，或新增 `claim_evidence(claim_id, evidence_id, relation)` 关联表。
- `ConclusionStatus` 映射到现有 `Verdict`：

| 工程结论 | 现有 Verdict | 说明 |
| --- | --- | --- |
| verified | supported | 有测试/构建/用户确认 |
| source-confirmed | supported | 直接源码证据 |
| inferred | partially_supported / insufficient_evidence | 模型推断，不升级 |
| ambiguous | insufficient_evidence | 多候选，未定 |
| unknown | insufficient_evidence | 无证据 |
| contradicted | contradicted | 有反证 |

- 不新建第三套“支持/不支持”枚举；UI 用现有 Verdict + 工程证据状态组合展示。

## 验收

- Pack 的每个 ref 都能解析；失败时明确 stale。
- 代码变更后证据 stale；旧 generation 清理后 Pack 仍可审计或明确 stale。
- 每个关键结论有 evidence ID；无证据结论不得写“已确认”。
- 模型推断不能自动升级为 verified/source-confirmed。
