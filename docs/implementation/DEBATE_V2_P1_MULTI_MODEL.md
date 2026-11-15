# Debate V2.0 P1：多模型与独立 Judge

- 分支：`0.2.5`
- 日期：2026-11-15
- 依赖：P0 单模型角色轮转、Judge 独立性、动态降级已完成。

## 1. 新增 Judge 选择

新增 `src/main/judge/resolve.ts`：

- 优先未参与辩论且模型身份不同的候选；
- 找不到时允许参与者复评，但标 `participant-review`；
- 单模型自评标 `self-review`；
- 没有可用模型标 `rules-fallback`；
- 统一返回 `judgeAgentId/judgeModelId/judgeMode/judgeIndependent/modelIndependence/sharedWith`。

`judge:adjudicate` 已改用该函数，不再自己手写 `sharedWith`。

## 2. 双模型

- `planLead` 双成员为 `pair_debate`；
- adversarial 等策略下 proposer/critic 分工；
- Judge 若由参与者担任，标 `participant-review`，不冒充独立第三方。

## 3. 三模型

- 两位辩论、第三位未参辩时，`resolveJudge` 返回 `independent-judge`；
- 三位都参辩时，没有独立第三方，返回 `participant-review`；
- 三模型中一位失败后，`state.degradation` 记录实际参与者和独立性变化。

## 4. 四模型及以上

- `planLead` 进入 `multi_model_panel`；
- 4 位以上增加明确角色分工：
  - lead：profile lead；
  - index 1：critic/evidence_reviewer；
  - index 2：evidence_reviewer；
  - 其余：peer；
- 不再让所有非主辩都落到同一个角色。

## 5. 测试

`npm run test:p1-multi-model`：9/9 通过。

覆盖：

- 双模型 pair_debate / proposer-critic；
- 三模型独立 Judge；
- 四模型多角色；
- independent / participant / self / rules 四种 Judge 模式；
- 指定裁判不可用时重新选择；
- 同模型不同 agent 的 modelIndependence=false。

## 6. 限制

- 三模型全部参辩时没有独立第三方，不能声称 independent-judge；
- 降级后的 Judge 重选由 `resolveJudge` + `state.degradation` 提供，CLI 侧接入需单独验证；
- 4+ 智能分工是确定性角色分配，不是模型自动规划；
- 没有重跑 24 题内容回归。
