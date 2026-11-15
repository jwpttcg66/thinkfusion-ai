# Debate V2.0 实施计划审核

- 审核对象：`ThinkFusion AI 辩论系统升级实施计划书 V2.0`
- 代码基线：`0.2.5` / `60ada0e`
- 审核日期：2026-11-15
- 结论：**方向批准，按 P0 审计先行；但不能把“单模型可跑”写成“单模型已完整实现”。**

---

## 1. 总体判断

计划的核心判断正确：

- 单模型是正式运行模式，不是降级方案；
- 多模型是增强能力，不是运行前提；
- 六种策略、DebateOrchestrator、Claim/Evidence/Dispute/Revision/Graph/Judge 必须复用；
- Judge 的逻辑独立性、执行角色独立性、底层模型身份独立性必须分开记录；
- 不能通过放宽 must 提高通过率；
- Evidence Pack 未完成前不能宣称工程辩论完成。

但计划需要修正三点：

1. **单模型的“运行”已经存在，缺的是“角色隔离 + 独立性元数据”。**
2. **`DebateParticipant` 不应再持久化一套与 `LeadPlan`/`DebateMessage` 重叠的配置。**
3. **`judge` 不应塞进 `DebateMessage.role`；Judge 仍是独立评估职责。**

---

## 2. 与当前代码的逐项核对

### 2.1 单模型已经可以启动

证据：

- `normalizeDebateConfig` 不强制至少两个参与者；
- `DebateOrchestrator.start` 只在 `effectivePlan.participants.length === 0` 时抛错；
- `planLead` 在只有一个可用成员时照常返回该成员，并写入
  “只有一个可用成员：后续轮次由同一成员分饰质疑与修正角色”的 warning；
- `check-debate-lead.mjs` 已有单成员启动、三轮发言、revision 目标等测试。

所以 P0 不是“从零支持单模型”，而是：

> 单模型已经能跑，但角色元数据和独立性标记没有跟上。

### 2.2 关键缺陷：单模型的 `roleFor` 永远返回 lead 角色

`lead.ts` 当前逻辑：

```ts
export function roleFor(plan, agentId, roundIndex, strategy) {
  const profile = strategyProfile(strategy);
  if (plan.lead.agentId === agentId) return profile.roles.lead;
  ...
}
```

单模型时 `plan.lead.agentId === agentId` 永远成立，因此：

- truth：永远 `proposer` 或 profile 的 lead 角色；
- adversarial：永远 `proposer`，不会变成 `critic`；
- expert：永远 `domain_expert`；
- assumption：永远 `proposer`，不会变成 `evidence_reviewer`；
- solution：永远 `proposer`，不会变成 `critic`；
- discovery：永远 profile lead 角色。

`kindFor` 确实会按轮次给出 `position / question / revision`，提示词也会切换，
但 **角色字段没有切换**。这和 plan 中“同一模型分饰正方、反方、回应”的要求不一致。

这是 P0 的核心代码缺口，也是现有 warning 文案与实际行为不一致的地方。

### 2.3 角色枚举与计划不一致

当前 `DebateRole`：

```ts
'proposer' | 'critic' | 'peer' | 'domain_expert' | 'evidence_reviewer'
```

计划提出：

```ts
'proposer' | 'opponent' | 'responder' | 'expert'
| 'assumption_checker' | 'evidence_reviewer' | 'judge'
```

差异：

- `opponent` ≈ 当前 `critic`；
- `responder` 当前没有；
- `assumption_checker` 当前由 `evidence_reviewer` 承担；
- `judge` 当前不在 `DebateMessage.role`，是独立 `JudgeVerdict`。

建议：

- **不要直接重命名现有枚举**，会破坏老辩论文件和 UI；
- 先加可选别名/映射，或在 `DebateMessage` 增加 `roleAlias`；
- `judge` 保持独立，不进入 `DebateMessage.role`。

### 2.4 Judge 独立性元数据缺失

当前 `JudgeVerdict` 只有：

- `judgeAgentId`；
- `sharedWith`；
- `backend: 'model' | 'rules'`。

没有：

- `judgeMode: self-review | participant-review | independent-judge`；
- `judgeIndependent: boolean`；
- `modelIndependence: boolean`；
- Judge 的 provider / modelId；
- 计算依据。

`sharedWith` 目前由调用方（`index.ts` 的 `judge:adjudicate`、回归脚本）手动设置。
如果调用方忘了设，单模型自评不会被标记。

这直接违反计划的 P0-04。

### 2.5 降级还没有实现

当前模型失败只写进 `round.failures`，不会：

- 重新规划参与者；
- 重新计算 Judge 独立性；
- 记录降级事件；
- 把三模型降级后的结果改标为单模型自评。

因此计划 P1-09“多模型降级和恢复”是**新增能力**，不是现有能力。

### 2.6 多模型现状

- 双模型：`planLead` pair_debate，`roleFor` 可区分 proposer/critic；
- 三模型：pair + 第三人 Judge 由 IPC/回归脚本选择；
- 四模型以上：`planLead` 会进入 multi_model_panel，但角色仍主要由
  `profile.roles.lead/other` 决定，是否真的“智能分工”需要额外审计。

所以“多模型增强”方向正确，但不能把 4+ 的智能分工写成已完成。

### 2.7 六种策略现状

六种 `STRATEGY_PROFILES` 都存在，`roleFor` 使用 profile roles；
单模型下因为 2.2 的 lead 覆盖，策略只能改变提示词和争议排序，
**不能改变角色身份**。

结论：

- 单模型 + 六策略“能跑”是事实；
- 单模型 + 六策略“角色分工完整”不是事实。

### 2.8 P3 基线口径

`60ada0e` 的结果是：

- 24/24 独立模型裁判；
- 质量 24/24 passed；
- 完整性复核 20/24 有缺口，20 题修订；
- 修订后独立 Judge 20/20 model；
- V1 18/24 passed / 6 failed；
- 3 道 PARTIAL 是连接失败；
- 单独重跑未合并主结果。

计划引用正确。需要坚持：

- 18/24 不是“24 题全量完成”；
- 18/24 不是事实正确率；
- 3 道 PARTIAL 不得混入主结果；
- 6 题缺口不得通过降 must 解决。

### 2.9 P4 Evidence Pack

当前代码只在 `code-index` 的注释里提到 Evidence Pack 的 future 接入：

- `indexer.ts` / `store.ts` 有“Evidence Pack 接入后”的注释；
- 没有独立的 Evidence Pack 实现或冻结证据快照。

计划把 P4 后置是正确的。当前不能宣称工程辩论完成。

---

## 3. 对计划数据结构的具体修正建议

### 3.1 `DebateParticipant` 不要作为新的持久化配置

当前已有：

- `DebateConfig.participants: string[]`；
- `LeadPlan.participants/debaters/openingSpeakers`；
- `DebateMessage.agentId/providerId/modelId/role`。

再加一个持久化 `DebateParticipant[]` 会产生三套参与者来源。

建议：

- 保留 `participants: string[]` 兼容旧数据；
- 新增**派生视图** `DebateParticipantView`，由 `LeadPlan` + 实际消息元数据计算；
- 如果需要角色历史，放 `DebateMessage.roleHistory` 或 `DebateRound.roleAssignments`，
  不要复制一份配置。

### 3.2 `topology` / `judgePolicy` 应计算，不应只由用户配置

建议：

- `DebateConfig` 增加可选 `topology` / `judgePolicy` 只作为**意图**；
- `DebateState` 记录 `actualTopology`、`actualJudge`、`independence`；
- 实际值由参与者数量、实际 modelId、Judge 是否参辩计算；
- 降级后重新计算，不能沿用旧标签。

### 3.3 Judge 独立性字段

建议在 `JudgeVerdict` 增加：

```ts
judgeMode: 'self-review' | 'participant-review' | 'independent-judge';
judgeIndependent: boolean;
modelIndependence: boolean;
judgeProviderId?: string;
judgeModelId?: string;
independenceReason: string;
```

并抽出 `resolveJudge(...)`，让 IPC、回归脚本、CLI 共用，避免调用方忘记设
`sharedWith`。

### 3.4 角色映射

建议先做兼容映射，不直接改枚举：

| 计划角色 | 当前角色 |
| --- | --- |
| proposer | proposer |
| opponent | critic |
| responder | revision 轮使用 peer，或新增 responder |
| expert | domain_expert |
| assumption_checker | evidence_reviewer |
| judge | 独立 JudgeVerdict |

如果确实需要 `opponent/responder` 作为正式枚举，先加迁移和 UI 映射，
并保留老值可读。

---

## 4. P0 审计任务（TF-DEBATE-00/01）建议

先不进入大规模改造，先补三个失败测试：

### 4.1 单模型角色轮转测试

新增 `scripts/check-debate-single-model.mjs`：

1. 一个参与者；
2. 3 轮；
3. 断言：
   - round 0 角色是 proposer；
   - round 1 角色是 critic/opponent；
   - round 2 角色是 responder/revision；
   - 提示词与 role 一致；
   - 不会把同一轮输出直接复制到另一角色。

当前预期：**round 1/2 会失败**，因为 `roleFor` 返回 lead。

### 4.2 Judge 自评标记测试

单模型 Judge：

- `judgeMode === 'self-review'`；
- `judgeIndependent === false`；
- `modelIndependence === false`；
- `sharedWith` 指向同一模型。

当前预期：**字段不存在，测试失败**。

### 4.3 降级测试

三模型运行中让一个模型失败：

- 记录原始配置；
- 记录实际参与者；
- 记录降级原因；
- 重新计算 Judge 独立性；
- 不保留“独立 Judge”标签。

当前预期：**没有降级逻辑，测试失败**。

### 4.4 回归矩阵

在现有 24 题之外，增加：

- 单模型 × 六策略；
- 双模型 × 六策略；
- 三模型 × 六策略；
- Judge 自评 / 参与者复评 / 独立 Judge；
- 单模型 PARTIAL/超时；
- 降级前后 `actualTopology` / `judgeIndependent`。

---

## 5. 对计划优先级的修正

计划的 P0/P1/P2/P3/P4 顺序总体正确，但建议：

| 计划 | 建议 |
| --- | --- |
| P0 单模型完整 | 缩窄为“角色轮转 + Judge 独立性元数据 + 单模型异常”；启动能力已存在 |
| P1 多模型 | 双/三模型已有基础；4+ 智能分工和降级是新工作 |
| P2 策略增强 | 与模型数量解耦，可并行；不要为单模型复制六套策略 |
| P3 质量回归 | 保留 18/24 原始口径；6 题定向修订、3 题 PARTIAL 分开处理 |
| P4 Evidence Pack | 后置；当前只有注释，没有实现 |

---

## 6. 结论

**批准方向，但不批准把“单模型可跑”直接写成“单模型完整支持”。**

必须先做 TF-DEBATE-00/01 审计并补失败测试，重点确认：

1. `roleFor` 在单模型下是否轮转角色；
2. `JudgeVerdict` 是否有独立性元数据；
3. 降级是否真的重新计算参与者和 Judge；
4. 4+ 模型是否真的智能分工，而不只是参与者列表变长。

在以上三项未闭环前，不应宣称单模型完整辩论、独立 Judge 或工程辩论完成。

当前 18/24 必须保持原口径：**它是内容通过数，不是事实准确率，也不是 24/24。**
