# Debate V3.2 修订版复审

- 复审对象：用户对 V3.2 审核意见的修订方案
- 实际代码基线：`main` = `4125ba4`
- 复审日期：2026-11-15
- 结论：**修订方向批准；Gate 0 先做，Evidence Pack 契约评审先于实现；但还有 4 个设计点必须先定。**

---

## 1. 复审结论

修订版比原 V3.2 明显更准确：

- 把 `fact-verified` 从 `QualityStatus` 拆出去；
- 把 `EvidencePackItem` 作为新增契约，而不是替换 `EvidenceKind`；
- 把 24 题基线回归提前到 Gate 0；
- 增加 Evidence Pack 契约评审和 Spike；
- 区分工程证据验证与外部事实核验；
- 明确 Gate 0/1/2 的进入条件。

这些修改都接受。

但仍有 4 个点需要在编码前定清楚，否则会出现新的状态混淆：

1. Claim 证据关联不要做成两套数组。
2. Judge 候选“调用失败后重选”还没有实现，不能只写测试。
3. `FactVerificationStatus` 要明确挂在哪里，不能又混回质量维度。
4. Evidence Pack 持久化是“新存储组件”还是“DebateStore 扩展”，必须先决定。

---

## 2. 已核实的现有能力

在实际 `main` 上执行：

```text
npm run test:p0-gaps     -> 10/10
npm run test:p1-multi-model -> 9/9
```

这只能证明：

- 单模型角色轮转；
- 多模型核心；
- Judge 独立性元数据；
- degradation 单元行为。

不能证明：

- IPC 级 Judge 重选；
- 质量引擎真实调用链；
- P0/P1 后完整 24 题；
- 最新 main 全量测试。

修订版把这几项列进 Gate 0，正确。

---

## 3. 需要先定的四个设计点

### 3.1 Claim 证据关联不要做成两套数组

修订版要求 `DebateClaim` 增加：

```text
supportingEvidence
contradictingEvidence
evidenceRefs
confidence
unresolvedReason
```

问题：

- 现有 `DebateEvidence.claimIds` 已经表达“这条证据关联哪些主张”；
- `ClaimJudgment.evidenceIds` 已经表达“裁判用了哪些证据”；
- `ArgumentGraph` 的边也已经有 relation；
- 如果再给 Claim 加两个数组，会变成第四套关联来源。

建议：

```ts
interface ClaimEvidenceLink {
  claimId: string;
  evidenceId: string;
  relation: 'supports' | 'contradicts' | 'context';
  source: 'author' | 'reviewer' | 'judge';
  reason: string;
}
```

由链接表统一表达支持/反驳/上下文；`DebateClaim` 不直接存两个数组。

`confidence` 也不要作为裸概率：

```ts
assessment: 'model-assessed';
confidenceLevel?: 'low' | 'medium' | 'high';
basis: string;
```

否则会被读成校准后的概率或事实置信度。

### 3.2 Judge 候选调用失败后的重选还没有实现

当前 `judge:adjudicate`：

1. `resolveJudge` 选一个候选；
2. `new JudgeEngine(...)`；
3. `engine.judge(state)`；
4. 如果调用失败，`JudgeEngine` 返回 `rules-fallback`。

也就是说：**当前只会在同一个候选上退回规则版，不会重新选择下一个候选。**

修订版要求覆盖第二种情况：

```text
选择 Judge 候选
  ↓
候选调用失败
  ↓
重新选择候选
  ↓
检查独立性
  ↓
完成裁决或降级
```

这需要在 `resolveJudge` 之上增加“排除失败候选后重选”的循环，或者提供 `selectNextJudge(excludedIds)`。

必须测试：

- 第一个独立候选失败 → 第二个独立候选接管；
- 第二个候选也失败 → participant-review；
- 全部失败 → rules-fallback；
- 重选后 `judgeIndependent`/`modelIndependence` 重新计算，不沿用旧值。

### 3.3 `FactVerificationStatus` 挂在哪里

修订版把它从 `QualityStatus` 拆出来，正确。

但需要明确挂载位置：

- 不要放进 `QualityStatus`；
- 不要混进 `QualityDimension.status`；
- 建议放在 `DebateQualityReport` 新增：

```ts
factVerification?: {
  status: FactVerificationStatus;
  basis: string[];
  sourceRefs: Array<{ url: string; version?: string; readAt: number }>;
  verifier: { modelId?: string; method: string; independent: boolean };
};
```

或者在 `JudgeVerdict`/`FinalDebateDecision` 旁挂独立对象。

原则：

- 质量评估回答“论证/证据/逻辑是否成立”；
- 事实核验回答“外部来源是否证实这个主张”；
- 两者不能共用一个 status 枚举。

### 3.4 Evidence Pack 持久化边界

修订版说“不新建第二套证据数据库”，正确。

但 Evidence Pack 需要一个持久化位置：

- 旧辩论文件继续由 `DebateStore` 管理；
- Pack 是跨辩论复用的冻结快照，不适合塞进单个辩论 JSON；
- 建议新增 `EvidencePackStore`，只存 manifest + 内容寻址的证据片段；
- 它不是“第二套证据数据库”，而是不可变快照存储；
- 必须明确：
  - 文件命名/路径；
  - 原子写；
  - 并发创建；
  - 旧 Pack 不被覆盖；
  - 旧辩论记录不受影响；
  - 回放校验。

如果决定不新增 store，就必须明确 Pack 放在 `DebateStore` 的哪个子目录、如何跨辩论复用。

---

## 4. Gate 0 复核意见

修订版把 Gate 0 分成 0A-0D，正确。

### Gate 0A：Judge 降级 IPC 测试

必须补：

- Judge 正常选择；
- Judge 调用失败 → rules-fallback；
- Judge 候选失败 → 重选候选；
- 重选后独立性重算；
- 无候选 → rules-fallback。

状态：**当前测试只覆盖 resolveJudge 纯函数；IPC 级重选未实现/未测。**

### Gate 0B：V3 质量引擎真实链路

必须覆盖：

```text
IPC judge:adjudicate
  → JudgeEngine
  → DebateQualityEngine
  → FinalJudge
  → verdict.quality / finalDecision
  → VerdictStore 持久化
  → judge:get 读回
```

重点：

- 不能只在单测中直接调用 `evaluateDebateQuality`；
- 必须验证 `judge:get` 返回的质量报告与刚生成的一致；
- 必须验证 `backend: rules` 时质量报告仍然是 `modelAssessed=false`。

### Gate 0C：24 题完整基线

必须：

- 使用 P0/P1 后的代码；
- 完整 24 题；
- 记录 COMPLETED/PARTIAL/FAILED；
- 记录 V1 PASS/FAIL；
- 不合并 P3 定向结果；
- 保留 `60ada0e` 的 18/24 作为历史，不覆盖。

建议命令：

```bash
--workers=3 --completeness
```

这不是最终回归；只是 Gate 0 基线。

### Gate 0D：最新 main 全量测试

必须：

- 在 `4125ba4` 或更新 main 上跑完整 `npm test`；
- `typecheck`；
- `build`；
- 记录命令和结果。

当前只跑了 P0/P1 目标测试，不够。

---

## 5. Evidence Pack 契约评审补充

修订版的六个问题正确。建议再加四个：

1. **证据定位**
   - 文件路径使用仓库相对路径；
   - 行号从 1 开始；
   - 无效行号必须失败，不能截断成空证据。
2. **Hash 规则**
   - Item Hash 对规范化 JSON 计算；
   - Manifest Hash 对排序后的 item hash 列表计算；
   - 排除 `createdAt`、临时路径等不稳定字段。
3. **状态机**
   - `building → ready` 或 `building → failed`；
   - `ready` 不可变；
   - `failed` 不产生半成品；
   - 重复 pack 创建要幂等或明确冲突。
4. **迁移与兼容**
   - 旧辩论 JSON 不需要迁移；
   - 旧 `DebateEvidence` 不受影响；
   - 新 Pack 有 schema version；
   - 读取未知版本要明确失败，不静默降级。

---

## 6. Evidence Pack Spike 验收

修订版的 Spike 方向正确。建议固定验收：

- 真实 TypeScript 仓库；
- 读取一个文件、一个 Symbol、一个调用关系；
- 生成 1 个 Pack、3 个 Item；
- 记录 line/hash；
- 修改文件后再生成新 Pack；
- 旧 Pack 内容不变；
- 新 Pack Hash 改变；
- Manifest 校验通过；
- 删除/损坏一个 Item 能被发现；
- 旧 Pack 可回放；
- 并发创建同一 Pack 不产生脏数据。

Spike 失败就不进入正式实现。

---

## 7. 工程事实与外部事实的边界

修订版区分正确，建议写成代码边界：

- `EvidencePack` / `EvidencePackItem`：只回答“代码/测试/依赖/执行事实是否存在、在哪、什么版本”；
- `FactVerificationStatus`：只回答“外部资料是否支持某个主张”；
- `DebateQualityEngine`：只评价论证质量和证据一致性，不把外部核验结果混进 `QualityStatus`；
- Judge：可以引用两者，但必须标明引用的是哪一类。

---

## 8. 最终复审意见

**批准修订后的 Gate 顺序和范围。**

但进入编码前必须先完成：

1. Gate 0A 的 Judge 重选实现 + IPC 测试；
2. Gate 0B 的质量引擎真实链路测试；
3. Gate 0C 的 24 题基线；
4. Gate 0D 的全量测试；
5. Gate 1 的 ClaimEvidenceLink 契约；
6. Gate 1 的 EvidencePackStore 持久化边界；
7. Gate 1 的 FactVerificationStatus 挂载位置。

在这些完成前：

- 不进入 Evidence Pack 正式实现；
- 不宣称工程辩论闭环；
- 不把 18/24 改写成更高数字；
- 不把模型评估写成事实核验。

当前状态表：

| 能力 | 状态 |
| --- | --- |
| P0 单模型 | TESTED 10/10 |
| P1 多模型核心 | TESTED 9/9 |
| 六种策略 | IMPLEMENTED，证据链测试待补 |
| V3 质量引擎 | IMPLEMENTED / 部分 INTEGRATED |
| FactVerificationStatus | SPECIFIED |
| Evidence Pack | SPECIFIED |
| EvidencePackStore | NOT DECIDED |
| 工程辩论 | NOT STARTED |
| 外部事实核验 | NOT STARTED |
| 24 题 P0/P1 后基线 | NOT RUN |
| 最新 main 全量测试 | NOT RUN IN THIS AUDIT |

结论：**修订版可以批准，但先做 Gate 0，不要直接开 Evidence Pack 编码。**
