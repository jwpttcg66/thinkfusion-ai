# P3-Evidence Producer：从 ExecutionReport 生成 Claim 级执行证据

- 分支 / 工作树：`p3-evidence-producer` / `/Users/yalla/data/localLab/thinkfusion-ai-evidence-producer2`
- 基线：`main` = `f07ec23`
- 范围：把现有 `ExecutionReport` 转成带 `ExecutionAttestation` 的 Evidence Pack
- 未做：Claim → 验证任务规划器、辩论编排器接线、P3-G UI

---

## 1. 生产边界

输入 `ExecutionEvidenceRequest`：

| 字段 | 作用 |
| --- | --- |
| `report: ExecutionReport` | 现有 `AgentOrchestrator` 执行报告 |
| `claimId` | 被验证的 Claim，必须显式提供 |
| `assertionId` | 具体断言 ID |
| `testId?` | 测试用例名 |
| `testCommand` | 期望的完整测试命令 |
| `repoRoot / repoCommit / branch / dirty` | 时间段与仓库状态 |
| `snapshotFingerprint?` | 开场 Pack 指纹 |
| `debateId / roundIndex / baselinePackId?` | Pack 归属 |

校验（任何一项不满足都不生产）：

1. 报告 `verification.checks.tests` 存在且不是 skipped；
2. `tests.command` 与 `testCommand` 逐字一致；
3. `tests.status=passed` 要求 `exitCode===0`；
4. `tests.status=failed` 要求 `exitCode` 非 0；
5. `claimId/assertionId` 非空。

它不是「模型说测试验证了 Claim」：模型没有机会填写 `verifiesClaimIds`，该字段只由生产者的 `claimId` 生成。

## 2. 输出

`ExecutionAttestation`：

```ts
{
  executionId, testId?, assertionId, claimId,
  assertion: 'passed' | 'failed',
  exitCode, repoCommit, snapshotFingerprint?,
  resultHash, // 对 task/round/plan/test 状态/命令/退出码/时间的规范 JSON sha256
  producer: { name: 'agent-orchestrator.execution-report', version: '1.0.0' }
}
```

Pack：

- 条目 kind `test-result`；
- 内容为执行摘要（命令、状态、退出码、detail、claimId、resultHash）；
- 虚拟路径 `.thinkfusion/executions/<executionId>/result.log`；
- attestation 进入 Item Hash（P3-F.3）；
- context 为 `kind=round`，带 debateId / roundIndex / baselinePackId。

## 3. 测试

`npm run test:execution-evidence`：**4/4 通过**。

- passed 报告 → attestation `passed` → 映射 `execution.assertion=passed`；
- failed 报告 → `failed`；
- 命令不一致 / 未执行 / 退出码矛盾 → 明确拒绝；
- 同一执行重复生产 → 复用同一 Pack。

P3 相关：evidence-pack 12/12、judge-pack 15/15、typecheck 全绿。

全量 `npm test` 仍只失败在既有 `check-cli-agent` 注册表测试（main 同样失败，CLI 版本/指纹漂移）。

## 4. Claim 验证计划边界

`claim-verification.ts`：

- `buildClaimVerificationPlan()` 只接受 `test.run` 支持的固定命令；
- 计划通过 `PlanSchema` 校验，TaskGrant `workspace-write`、`approvalPolicy=ask`、
  `allowedTools=['test.run']`、`maxSteps=1`；
- 不自动执行：`verifyClaim()` 必须由调用方传入现有 `runPlan`，先走 Runtime/审批；
- 只有真实 `ExecutionReport` 返回后才生成 attestation；`runPlan` 失败不生产证据。

新增测试：

- 计划只含 `test.run`，命令不在允许列表直接拒绝；
- TaskGrant 只能 `test.run`、最多一步、必须审批；
- `runPlan` 成功 → attestation；失败 → 不生产。

`test:execution-evidence` 6/6。

## 5. Runtime Claim 验证规划

`claim-verification-planner.ts`：

- `DebateClaim.verification` 是显式意图：`testCommand / assertionId /
  testId? / source / reason`；
- `source` 只允许 `author | reviewer | user`，模型来源直接拒绝；
- 只有 `claimScope=runtime` 且带意图的 Claim 生成任务；没有意图不自动跑；
- 命令必须是 `test.run` 支持的固定命令；
- 没有 repository 时跳过并记录原因；
- `executeClaimVerificationTasks` 顺序执行，一个 Claim 失败不阻止其他 Claim。

新增测试：

- 有意图 → 任务；无意图 → `no-intent`；
- code scope → `not-runtime`；
- 模型来源 → `invalid-source`；
- 不支持的命令 → `unsupported-command`；
- 真实报告 → attestation。

`test:execution-evidence` 8/8。

## 6. 仍未接线

| 缺口 | 说明 |
| --- | --- |
| Claim → 验证任务 | 没有把 Runtime Claim 转成测试/命令并交给 AgentOrchestrator |
| Claim.verification 意图的生产方 | 还没有 UI/评审入口写入；规划器只消费显式意图 |
| 辩论编排器调用 | `executeClaimVerificationTasks` 目前没有调用方 |
| UI 审批触发 | 未接 |
| 真实执行 → Pack → Judge E2E | 未做 |
| 多模型 | 仍只有 deepseek 配置 |

因此本轮只完成「可信生产边界」，不能宣称 P3 完成。下一步必须实现 Claim 验证任务规划器，复用现有执行治理，不能由模型自填验证关系。
