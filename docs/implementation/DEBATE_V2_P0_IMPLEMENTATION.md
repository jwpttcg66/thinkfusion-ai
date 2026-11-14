# Debate V2.0 P0 实施记录

- 分支：`0.2.5`
- 日期：2026-11-15
- 质量基线：`60ada0e` 的 18/24，未修改。

## 1. P0-2 单模型角色轮转

修改：

- `DebateRole` 增加 `responder`；
- `roleFor` 在单模型时按轮次轮转：
  - 第 1 轮：profile lead（proposer / domain_expert / peer）；
  - 第 2 轮：assumption 用 evidence_reviewer，其余用 critic；
  - 第 3 轮起：responder；
- `ROLE_DUTY` 增加 responder；
- 共享契约与渲染层 role union 同步。

结果：

- 单模型不再永远返回 lead 角色；
- 第二/第三轮角色与提示词职责一致；
- 六种策略都发生角色轮转；
- 没有伪造新的 agentId 或模型身份。

## 2. P0-3 Judge 独立性元数据

修改：

- `JudgeVerdict` 增加：
  - `judgeMode: self-review | participant-review | independent-judge | rules-fallback`
  - `judgeIndependent`
  - `modelIndependence`
  - `judgeProviderId`
  - `judgeModelId`
  - `independenceReason`
- `JudgeEngine` 从实际参与者和模型身份派生，不再只依赖 `sharedWith`；
- IPC 与回归脚本把实际参与者、participantModelIds、judgeModelId 传给 Judge；
- 规则回退明确标 `rules-fallback`，不冒充独立模型。

结果：

- 单模型自评：`self-review`，非独立；
- 双模型参与者复评：`participant-review`，非独立第三方；
- 未参与辩论的第三模型：`independent-judge`。

## 3. P0-4 动态降级

修改：

- `DebateState` 增加 `degradation`：
  - originalParticipants
  - actualParticipants
  - failedAgents
  - actualRoles
  - judgeIndependent
  - modelIndependence
  - degradedToSingleModel
  - reason
- 每轮结束后由实际 failures 计算；
- 后续轮次自动跳过失败成员；
- 单成员失败不一定降成单模型：只要还有两位实际参与者，就保留多模型状态；
- 剩一位时标 `degradedToSingleModel`，并取消独立 Judge 标签；
- Judge 候选失败时也不沿用旧独立标签。

## 4. P0-5 测试

`npm run test:p0-gaps` 现在：

```text
tests 10
pass 10
fail 0
```

覆盖：

- 单模型 proposer -> critic -> responder；
- 六策略第二轮角色轮转；
- 角色与提示词职责一致；
- Judge 自评/参与者复评/独立裁判；
- 正方失败、反方失败、Judge 候选失败、两人同时失败；
- 失败后实际参与者、actualRoles、judgeIndependent、modelIndependence。

新增测试已加入 `npm test` 链路。

## 5. 没有改的东西

- 没有降低 must；
- 没有删除 Claim；
- 没有把单模型自评写成独立裁判；
- 没有修改 `60ada0e` 的 18/24 历史结果；
- 没有新建第二套 DebateOrchestrator / Judge Runtime。

## 6. 后续

P0 代码和测试已闭环。P1 还需要专项验证：

- 双模型交叉辩论；
- 三模型独立裁判；
- 4+ 模型智能分工；
- 降级后由 IPC/CLI 重新选择 Judge 的完整链路；
- 完整 24 题回归重跑（本轮只做单模型/独立性/降级测试，没有重跑内容题库）。
