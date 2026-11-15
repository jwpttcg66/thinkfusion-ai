# Debate V2.0 P0 缺口测试（测试先行）

- 分支：`0.2.5`
- 当前 HEAD：`71cee5f`（审核报告）
- 质量基线：`60ada0e`（18/24，不修改）
- 本阶段只新增测试，不修改业务实现。

## 1. 测试入口

```bash
cd desktop-agent-macos
npm run test:p0-gaps
```

结果：

```text
tests 10
pass 0
fail 10
```

10 个用例全部按预期失败，分别暴露三个缺口。

## 2. 单模型角色轮转

文件：`scripts/check-debate-single-model.mjs`

失败：

- `单模型 adversarial：proposer -> critic -> responder`
  - 实际：第二轮仍是 `proposer`；
- `单模型六策略：第二轮角色不能仍等于第一轮 lead 角色`
  - 实际：`truth` 为 `proposer -> proposer`；
- `单模型角色与提示词职责一致`
  - 实际：第二轮仍是 proposer，提示词没有使用 critic/evidence reviewer 职责。

根因：`lead.ts` 的 `roleFor` 在 `plan.lead.agentId === agentId` 时永远返回
`profile.roles.lead`；单模型只有这个 agent，所以角色不轮转。

结论：单模型“能启动”成立，但“多角色轮转”不成立。

## 3. Judge 独立性元数据

文件：`scripts/check-debate-judge-independence.mjs`

失败：

- 单模型自评：`judgeMode` 实际 `undefined`，预期 `self-review`；
- 参与者复评：预期 `participant-review`，实际 `undefined`；
- 独立第三模型：预期 `independent-judge`，实际 `undefined`。

同时 `judgeIndependent`、`modelIndependence`、`judgeModelId` 都没有记录。

根因：`JudgeVerdict` 只有 `sharedWith`，独立性依赖调用方手动设置。

结论：Judge 组件独立，但独立性元数据和派生计算不成立。

## 4. 多模型失败与降级

文件：`scripts/check-debate-degradation.mjs`

失败：

- 正方/a 失败：缺少 `state.degradation`；
- 反方/b 失败：缺少降级记录与角色重分配；
- Judge 候选/c 失败：缺少独立性重算；
- a+b 同时失败：缺少“只剩一个时标记单模型自评”。

根因：当前只有 `round.failures`，没有重规划、没有实际参与者/角色/Judge
独立性重算。

结论：动态降级未实现。

## 5. 测试约束

- 单模型角色变化不伪造新的 `agentId` 或模型身份；
- Judge 独立性应由实际参与记录派生，不依赖调用方手工 `sharedWith`；
- 一个成员失败不等于一定降成单模型，要看失败角色、剩余成员和是否还能找到
  独立 Judge；
- 三模型失败后必须重新计算 `judgeIndependent` / `modelIndependence`；
- 18/24 基线不变，测试通过与否不能改写历史结果。

## 6. 下一步

按 P0 顺序：

1. P0-2：修 `roleFor`，让单模型按轮次真实轮转 proposer/critic/responder；
2. P0-3：扩展 `JudgeVerdict`，从参与者派生出 `judgeMode`、
   `judgeIndependent`、`modelIndependence` 和 judge provider/model；
3. P0-4：实现失败后的重规划与降级记录，重新计算实际参与者、角色和独立性；
4. P0-5：六策略单模型回归全部通过；
5. P1：双/三/多模型专项验证。

在 P0-2/03/04 完成前，不把单模型称为“完整辩论能力”。

## 7. 修复后

P0-2/P0-3/P0-4 已实现，`npm run test:p0-gaps` 现在为：

```text
tests 10
pass 10
fail 0
```

具体修改见 `DEBATE_V2_P0_IMPLEMENTATION.md`。本文件的 10/10 失败记录保留为
修复前证据，不代表当前状态。
