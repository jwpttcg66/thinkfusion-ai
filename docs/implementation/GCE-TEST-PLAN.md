# GCE 测试与验收计划

**状态：** `DESIGN`，未执行完整实施验证。  
**基线：** `main@9026e0e`  
**设计：** [V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md](../architecture/V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md)  
**契约：** [GOAL_CONTRACT_EVIDENCE_CONTRACTS.md](../spec/GOAL_CONTRACT_EVIDENCE_CONTRACTS.md)  
**任务：** [V3-GOAL-CONTRACT-EVIDENCE-TASK-BOOK.md](../implementation/V3-GOAL-CONTRACT-EVIDENCE-TASK-BOOK.md)

本文定义分层验证，不重复实现细节。离线测试证明规则；真实应用验收证明链路；二者不可互相替代。

## 1. 测试分层

| 层 | 证明什么 | 入口 |
| --- | --- | --- |
| 纯函数/契约 | 类型、状态机、Goal Fit、Criterion、决策矩阵 | `test:goal-contract` 及新增专项 |
| 集成 | 事件→投影→Orchestrator→持久化 | `test:gdc-*`、`test:task-*`、新增集成脚本 |
| 真实应用 | 真实模型/工具/窗口/恢复 | `npm run dev:local` + CDP/专用 live 脚本 |
| 回归 | 既有工程、对话、Memory、LT 不退化 | 现有 `test:*` 子集 + `npm run verify` |

## 2. 必测矩阵

### Goal Contract

- 六维缺失保持 `UNRESOLVED`，不猜内容。
- `MODEL_INFERRED` 不能标为 `USER_CONFIRMED`；冲突保留双方。
- 无成功标准时不生成 `MUST` Criterion；Goal Fit 为 `UNKNOWN`。
- 简单任务可自动 `ACTIVE`；复杂/重大/高风险进入确认。
- 删除标准必须确认；拒绝后旧 Goal Version 仍有效。
- Goal Version 与下游 WorkTask/Criterion 一致。

### Criterion / Evidence

- 每条 MUST 有验证方式、阈值、证据或明确缺口。
- `MET` 无证据 → 校验失败。
- `WAIVED` 无授权 → 校验失败。
- 文本回读可作为文本改动证据；代码回读不算编译/运行。
- `MODEL_CLAIM` 单独不能支撑 `MET`。
- 执行完成 + 未验证不能得出目标达成。

### Cycle Decision

- `Cycle` 与 `Round` 身份分离；一次局部修复不强制新完整 Cycle。
- 真实阶段事件可重放；`SKIPPED` 必须有原因。
- `REPAIR/REPLAN/REDESIGN/REANALYZE/CLARIFY_GOAL/WAIT_USER/BLOCKED/COMPLETE/ABORT` 均有测试。
- 重复失败/相同证据指纹触发无进展处理，不只靠轮数。
- `task.completed` 不能覆盖 `goal.fit` 的 `GAP/UNVERIFIED`。

### TDL / DMOCA / ECO

- 强制 Criterion 无任务承接 → 分解阻断。
- 循环依赖、重复任务、不可验收任务被拒绝。
- ECO 不足的模型只给有限意见，不能成为正式裁决者。
- 贡献绑定 Goal/Cycle/ECO 版本；无真实争议不伪造辩论。

### 恢复 / 压缩

- 检查点恢复 Goal Contract、Cycle、TDL revision、ECO/贡献/Evidence 版本。
- 目标变化 → 重规划受影响任务；ECO 过期 → 重新读取；证据失效 → 重新验证。
- 外部副作用无法确认 → 停止自动执行。
- 压缩不删除目标版本、决策、证据引用。

### UI / 真机

- 连续文档式主活动区仍成立，不新增卡片堆叠或独立定位轨。
- 目标区、Criterion 状态、Goal Fit、决策原因都可追溯。
- 目标变更确认可操作；拒绝后旧目标不变。
- 没有发生阶段显示“未发生”，不是绿色完成。
- 最终交付文件来自全部轮次并集；没有文件时明确写“没有记录到”。
- 真实工程长任务走通：目标→设计→计划→执行→评审→证据→Goal Fit→决策。

## 3. 故障注入

至少覆盖：

1. 无成功标准但任务执行成功 → 目标必须 `UNKNOWN`，不能自动达成。
2. 目标删除一条 MUST 且未确认 → 保持旧版本，受影响任务不重规划。
3. 评审说需修复但执行报告 verified → Goal Fit 不能 `MET`。
4. 文本回读成功、代码未编译 → 文本 Criterion 可 MET，代码 Criterion 不能 MET。
5. 相同失败步骤连续两轮 → 停止自动修复，产生 `REPLAN/REDESIGN/WAIT_USER`。
6. 检查点 Goal Version 落后 → 恢复 `needs_replan`，不继续旧计划。
7. 模型推断成功标准 → 显示“模型推断”，不得标成用户确认。

## 4. 真机验收记录

每份记录必须包含：

- 启动配置（OpenIDEA ThinkFusion Dev 或 `dev:local`）；
- 代码基线；
- 新任务/现有任务 ID；
- 使用的模型/配置；
- 真实事件序列或截图/JSON 证据；
- 通过项、失败项、未验证项；
- 最终 Goal Fit 和交付文件路径。

没有真实证据时只能标 `TESTED`，不能标 `VERIFIED`。

## 5. 回归门禁

批次合并前至少：

```text
npm run typecheck
npm run test:goal-contract
npm run test:goal-evidence
npm run test:goal-compat
npm run test:cycle-decision
npm run test:gdc-goal
npm run test:gdc-cycle
npm run test:task-conversation
npm run test:task-view
npm run test:version-consistency
npm run test:context-recovery
```

涉及 Orchestrator 时必须追加对应集成脚本；涉及 UI 时必须补真实应用样本；涉及恢复时必须跑一次真实中断/继续。
