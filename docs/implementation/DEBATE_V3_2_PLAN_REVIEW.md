# Debate V3.2 实施计划审核

- 审核对象：`制定辩论主题方案 (15)-20261115-1105-2.md`
- 审核基线：实际 `main` = `4125ba4`
- 计划写的基线：`1467f32`
- 审核日期：2026-11-15
- 结论：**范围批准，方向批准；但计划里的“已完成”必须重新分级，Evidence Pack 契约需要先定，不能直接进入实现。**

---

## 1. 基线修正

计划写：

```text
代码基线：远端 main，SHA 1467f32
```

实际远端 `main` 已经是：

```text
4125ba4 合并 0.2.4：修复终端会话结束后的报错刷屏
```

`1467f32` 是当前 `main` 的祖先，计划本身不冲突，但基线不是最新。

同时：

- 当前 `main` 已包含辩论 P0/P1 提交；
- 当前 `main` 也包含 CLI / Worktree 提交；
- 计划声明“只做辩论，不包含 CLI”，这个范围划分正确；
- 但实施时必须避免把 CLI 改动和辩论改动混在同一个提交里。

建议把计划基线改为 `4125ba4`，并明确：

> 本期只改辩论相关文件；CLI/PTY/终端/Worktree 改动不在本期验收范围。

---

## 2. 计划中“已完成”的核验

### 2.1 P0 单模型：核验通过

实际执行：

```text
npm run test:p0-gaps
tests 10
pass 10
fail 0
```

覆盖：

- 单模型 proposer -> critic/evidence_reviewer -> responder；
- 六策略第二轮角色轮转；
- 角色与提示词职责一致；
- Judge self-review / participant-review / independent-judge；
- 正方/反方/Judge 候选/两人失败；
- actualParticipants / actualRoles / judgeIndependent / modelIndependence。

代码位置：

- `lead.ts` 的 `roleFor` 单模型轮转；
- `judge/types.ts` 独立性字段；
- `judge/engine.ts` 独立性派生；
- `orchestrator.ts` 的 `updateDegradation`；
- `types.ts` 的 `DebateDegradation`。

### 2.2 P1 多模型：核验通过

实际执行：

```text
npm run test:p1-multi-model
tests 9
pass 9
fail 0
```

覆盖：

- 双模型 pair_debate；
- 三模型两位辩论 + 独立 Judge；
- 四模型 deterministic 多角色；
- `resolveJudge` 四种模式；
- 指定裁判不可用重选；
- 同模型不同 agent 的 modelIndependence=false。

### 2.3 P2 六策略：已有 profile，未新增 Runtime

六种策略 profile 已存在：

`truth / adversarial / expert / assumption / solution / discovery`

单模型和多模型角色测试覆盖六种策略。计划没有为每种策略新建 Runtime，这一点正确。

### 2.4 V3.0 质量引擎：部分核验

计划说已有质量引擎和 Final Judge，正确。

但计划 2.4 要求区分：

```text
model-assessed
fact-verified
supported
contradicted
insufficient
```

当前 `QualityStatus` 是：

```ts
'supported' | 'model-assessed' | 'contradicted' | 'insufficient' | 'unknown'
```

**没有 `fact-verified`。**

所以不能把当前质量报告写成已经具备“外部事实核验”状态；`fact-verified` 是 Phase 3 的新能力。

---

## 3. 计划的数据契约与现有代码不一致

### 3.1 Evidence Pack

计划目标：

```ts
interface EvidencePack {
  packId: string;
  debateId: string;
  repository?: { repositoryId; revision; branch? };
  createdAt: number;
  evidenceIds: string[];
  manifestHash: string;
  status: 'building' | 'ready' | 'failed';
}
```

现状：

- 没有 `EvidencePack` 类型；
- 没有 `packId` / `manifestHash`；
- 没有 repository revision；
- `DebateEvidence` 只有单条证据字段；
- `code-index` 里只有“Evidence Pack 接入后”的注释，没有实现。

结论：**EvidencePack 是 SPECIFIED，不是 IMPLEMENTED。**

计划说“优先扩展现有 Evidence，不另建第二套证据数据库”，这个方向正确；但需要明确：

- `EvidencePack` 是 `DebateEvidence[]` 的外层快照，不是新数据库；
- `packId/manifestHash/status` 放在 pack 层；
- `DebateEvidence` 增加可选 `packId` / `repositoryRevision` / `manifestHash`；
- 冻结与 pin 由 pack 层负责，不能改 `DebateEvidence` 的语义。

### 3.2 证据类型不一致

计划列的类型：

```text
source, symbol, call-graph, dependency, test,
execution, documentation, configuration,
git-history, external-source
```

当前 `EvidenceKind`：

```ts
'official-doc' | 'source-code' | 'paper' | 'benchmark' | 'blog' | 'model-claim'
```

两者不是同一套枚举。

不能直接把工程类型塞进 `EvidenceKind`，因为：

- `EvidenceKind` 同时被 `shared/fusion.ts`、UI 和综合层使用；
- 工程证据需要行号、符号、调用边、测试结果等结构化字段，单靠 kind 不够。

建议：

- 新增 `EvidencePackItemKind`（工程证据类型）；
- `EvidencePackItem` 包含 `kind`、`location`、`excerpt`、`hash`、`verification`；
- 再映射到 `DebateEvidence` 做辩论引用；
- 或者给 `DebateEvidence` 增加可选 `packItem` 字段，不改变老 kind。

### 3.3 Claim 字段缺失

计划要求 Claim 能关联：

```text
supportingEvidence
contradictingEvidence
evidenceRefs
confidence
unresolvedReason
```

当前 `DebateClaim` 只有：

- `evidenceDrafts?`；
- `status`；
- `assumptions`；
- `span`。

没有 supporting/contradicting 的区分，也没有 `confidence` 或 `unresolvedReason`。

结论：Phase 2 的 Claim/Evidence 关联是**新增契约**，不是现有字段改名。

### 3.4 外部事实核验状态缺失

计划要求：

```text
verified
contradicted
partially_verified
insufficient
conflicting
not_verifiable
```

当前 `EvidenceVerification` 是：

```ts
'page-link' | 'reported' | 'unverified'
```

它回答的是“页面有没有给链接”，不是“外部来源是否证实”。

结论：Phase 3 需要独立的 verification 状态；不能把 `page-link` 改名为 `verified`。

---

## 4. 计划中的优先级冲突

计划 2.5 把：

- Evidence Pack
- 工程辩论闭环
- Judge 降级集成验证
- 24 题完整回归

都列为 P0。

但第三章路线图把：

- Evidence Pack 放 Phase 1 / P0；
- 工程辩论 Phase 2 / P0；
- 24 题回归 Phase 4 / P1。

同一件事出现 P0/P1 两种优先级。

建议统一为：

| 事项 | 优先级 |
| --- | --- |
| Gate 0 现有辩论集成复核 + Judge 降级集成测试 | P0 |
| Evidence Pack 最小快照 | P0 |
| 工程辩论闭环 | P0，但依赖 Evidence Pack |
| 24 题完整回归 | P0，放在 Gate 0 后、Evidence Pack 前做一次基线 |
| 外部事实核验 | P1 |
| 连接稳定性/恢复 | P1 |
| 4+ 动态分工 | P2 |

特别是：**24 题回归不必等 Evidence Pack 完成**，它验证的是现有辩论质量，应该先跑一次基线。

---

## 5. Gate 0 仍未闭环的部分

计划 Phase 0 要求：

- 单模型、多模型、六策略；
- Claim / Evidence / Dispute / Revision / Argument Graph；
- Judge 自评；
- 质量报告；
- Judge 降级集成测试；
- 历史记录可读；
- 现有测试不退化。

已核验：

- 单模型 P0：10/10；
- 多模型 P1：9/9；
- 六策略角色；
- Judge 独立性；
- degradation 单元测试。

仍缺：

1. **IPC 级 Judge 降级集成测试**
   - `judge:adjudicate` 已用 `resolveJudge`；
   - 但没有测试“Judge 模型调用失败 → 规则回退 → verdict.judgeMode=rules-fallback”;
   - 也没有测试“Judge 候选失败 → 重新选择”。
2. **V3 质量引擎真实调用路径测试**
   - `judge:adjudicate` 调用 `evaluateDebateQuality`；
   - 但没有从 IPC 到 quality 报告、Final Judge 的端到端测试。
3. **P0/P1 代码后的完整 24 题回归**
   - 目前有 18/24 历史基线；
   - 有 P3 定向 6/9；
   - 没有 P0/P1 后的完整 24 题。
4. **完整 npm test 在最新 main 上的记录**
   - 本次审核只跑了 P0/P1 目标测试；
   - 没有把最新 `4125ba4` 的完整测试结果写进计划。

---

## 6. 对 Phase 1 / Phase 2 的具体建议

### 6.1 Evidence Pack 最小闭环

不要一开始做“全部工程证据类型”。先做：

1. `EvidencePack` 外层：
   - packId；
   - debateId；
   - repository revision；
   - evidenceIds；
   - manifestHash；
   - status。
2. `EvidencePackItem`：
   - file path；
   - line range；
   - kind；
   - excerpt；
   - hash；
   - verification。
3. 冻结：
   - 生成后不可修改；
   - 所有参与者只读同一 pack；
   - 旧 pack 不被新文件污染。
4. 测试：
   - 相同输入同 hash；
   - 文件变化 hash 变化；
   - 无效行号拒绝；
   - manifest 校验失败可见；
   - 旧 pack 可回放。

这仍然复用 `DebateEvidence`，不是第二套数据库。

### 6.2 工程辩论闭环

在 Evidence Pack 最小闭环之后再做：

- Claim 引用 packItem；
- supporting / contradicting 区分；
- Evidence Reviewer 只核对 pack；
- Judge 只能引用 pack 里的证据；
- 结论回写 Argument Graph；
- 真实代码仓库端到端测试。

测试必须包含：

- 引用不存在文件 → 失败；
- 虚构行号 → 失败；
- 测试未覆盖写成测试通过 → 失败；
- 代码存在写成代码已执行 → 失败；
- 无法读取的证据标 `not_verifiable`。

### 6.3 外部事实核验

Phase 3 单独建 verification 状态，不要复用 `page-link`：

- `verified`；
- `contradicted`；
- `partially_verified`；
- `insufficient`；
- `conflicting`；
- `not_verifiable`。

必须保存：

- 来源 URL/版本/时间；
- 实际读取内容；
- 对应 Claim 的片段；
- 核验模型/方法；
- 核验时间。

网页链接存在不等于事实已验证。

---

## 7. 计划中需要修正的措辞

1. **“P0/P1 核心实现完成”**：应加限定——P0/P1 的单元/集成测试通过，但 IPC 级 Judge 降级和完整 24 题回归未完成。
2. **“V3.0 质量引擎已有 fact-verified”**：不成立。当前没有 `fact-verified`。
3. **“Evidence Pack 优先扩展现有 Evidence”**：正确，但需要先决定 `EvidencePackItemKind` 与 `EvidenceKind` 的映射，不能直接改老枚举。
4. **“24 题完整回归 P0 / P1”**：统一优先级，建议先跑基线。
5. **“基线 1467f32”**：更新为当前 `main` 的 `4125ba4`，并声明只改辩论文件。
6. **“本期只做辩论”**：保留；但当前 main 有 CLI 改动，提交时不要把 CLI 和辩论混在一起。

---

## 8. 最终审核结论

**批准以“辩论系统”为范围的 V3.2 方向，但不批准直接进入 Evidence Pack 大规模编码。**

建议顺序：

1. **Gate 0 收尾**：
   - IPC 级 Judge 降级测试；
   - V3 质量引擎真实调用测试；
   - 完整 24 题基线（P0/P1 后）；
   - 最新 main 全量测试记录。
2. **Evidence Pack 契约评审**：
   - pack/item/kind/hash/freeze 数据结构；
   - 与 `DebateEvidence` 的映射；
   - 不新建第二套数据库。
3. **Evidence Pack 最小实现**；
4. **工程辩论闭环**；
5. **外部事实核验**；
6. **完整回归/稳定性**；
7. **4+ 动态分工对比实验**。

当前能写的状态：

- P0 单模型：TESTED（10/10）；
- P1 多模型核心：TESTED（9/9）；
- P2 六策略：已有实现，需按新契约补证据链测试；
- V3 质量引擎：IMPLEMENTED/部分 INTEGRATED，尚无 fact-verified；
- Evidence Pack：SPECIFIED；
- 工程辩论：NOT STARTED；
- 外部事实核验：NOT STARTED；
- 4+ 动态分工：NOT STARTED；
- 24 题 P0/P1 后全量：NOT RUN。

不能写“V3.2 证据基础或工程辩论已完成”。
