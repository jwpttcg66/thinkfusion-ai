# Debate V3.0 P1/P2：自动质量评估与 Final Judge

- 日期：2026-11-14
- 基线：`main`，P0 完成后的提交 `10adea2`
- 模型：用户在设置里勾选的
  - `deepseek-v4.1-flash`
  - `gpt-6-luna`
  - `kimi-k2.7-code`
- Provider：`opencode-go`

## 1. 实现了什么

### P1 `DebateQualityEngine`

文件：`desktop-agent-macos/src/main/debate/quality-engine.ts`

- 输入可以是规则版 `DebateVerdict`，也可以是模型版 `JudgeVerdict`；
- 两者结构不同，先归一化，再读 `argumentQuality`、`undetermined`、
  `unresolved`、`confidence` 和三维判定；
- 输出八个维度：事实、逻辑、证据、反论证覆盖、修订质量、矛盾检测、
  不确定性表达、结论一致性；
- 每个维度带 `status`、`basis`，有来源时带 `evidenceRefs`，不是单一分数；
- `factualAccuracy` 只会是：
  - `model-assessed`：模型评估过主张与引用的一致性；
  - `insufficient`：有页面链接，但没有抓取正文核验；
  - `unknown`：没有外部来源。
- 任何情况下都不会因为模型 Judge 说 `passed` 就变成 `supported`。

### P2 Final Judge

文件：同一份 `quality-engine.ts`

- `finalizeDebate()` 直接复用现有五档 `Verdict`，不新增第三套“结论状态”；
- 另给一个 `action`（`accept / accept_with_caveats / reject / hold`），
  它是处理建议，不是事实判断；
- 只有 `factualAccuracy === 'supported'`（外部核验）才允许 `accept`；
  当前没有外部核验通道，所以实际结果最多是 `accept_with_caveats`；
- 模型版裁判没有五档结论：有结论也只标 `partially_supported`，因为
  模型评审不等于外部事实核验；
- 规则版没有置信度就不编，统一 `low` 并说明“不代表事实核验”。

### 接入

- `judge:adjudicate` 在模型裁判结束后生成质量报告和 Final Judge 决策，
  作为 `JudgeVerdict` 的伴随字段 `quality` / `finalDecision` 一起落盘；
- `JudgeEngine` 对“输出不是可解析 JSON”只重试一次，`judgeAttempts`
  记录实际次数；两次都失败才退回规则版；
- 退回规则版时，`logicalValidity` 标 `unknown`，不能把规则线索写成
  “模型裁判论证质量”；
- 裁判输出新增 `questionType`：`FACT` / `CONTEXTUAL` / `INSUFFICIENT`；
  - FACT 必须给明确结论；
  - CONTEXTUAL 必须给条件、边界和推荐方案；
  - INSUFFICIENT 才表示缺少必要信息且没有成熟默认框架；
  - `CONTEXTUAL` 不等于 `INSUFFICIENT`，不能因为“没有普适最优”就拒绝给结论。
- 老裁决记录没有这两个字段，读回时不补造；
- 渲染层在裁决下方显示评估状态、事实维度、阻断项和最终处理方式。

## 2. 三层验收边界

| 层 | 能标什么 | 不能标什么 |
| --- | --- | --- |
| 规则/源码/测试 | `supported` | 没跑过的规则说成通过 |
| 模型评审 | `model-assessed` | 事实准确率、`PRODUCTION_READY` |
| 无来源 | `unknown` / `insufficient` | 默认正确 |

`DebateQualityReport.status === 'passed'` 只表示评估流程完整：
规则门槛通过、模型评审实际发生、裁判没有标 `undetermined`。
它不表示事实已核验。

## 3. 自动化测试

新增：`scripts/check-debate-quality.mjs`

覆盖：

1. 规则版结论只做规则/结构评估，不冒充模型评审；
2. 模型版裁判的论证质量可 `supported`，事实只能 `model-assessed`；
3. `undetermined` 保留到 Final Judge，结果为 `inconclusive`；
4. 裁判退回规则版（`backend: 'rules'`）时，即使调用方误传
   `modelAssessed: true` 也不冒充模型评审；
5. 规则版/模型版归一化字段互不串用。

运行：

```bash
npm run test:debate-quality
```

已加入 `npm test` 链路。

## 4. 真实运行

脚本：`scripts/spikes/debate-quality-configured.cjs`

安排：

- 辩论：`deepseek-v4.1-flash` + `gpt-6-luna`，2 轮；
- 裁判：`kimi-k2.7-code`，不参加辩论；
- `sharedWith`：空，裁判确实独立；
- 没有失败、没有超时。

结果：

| 项 | 结果 |
| --- | --- |
| 辩论状态 | `COMPLETED` |
| 轮数 / 消息 | 2 轮 / 4 条 |
| 裁判后端 | `model` |
| 裁判模型 | `kimi-k2.7-code` |
| 裁判轨迹 | 1 次调用，输入 3922 / 输出 1082 token，约 13.7 秒 |
| 裁判结论 | `undetermined: true`，`confidence: low` |
| 质量状态 | `inconclusive` |
| 事实维度 | `model-assessed`（不是事实正确） |
| 逻辑维度 | `insufficient`（论证质量均值 0.55，低于 0.7 门槛） |
| 规则门槛 | 11/11 |
| 最终结论 | `insufficient_evidence`（裁判 undetermined） |
| 处理建议 | `hold` |
| 后续建议 | 补充可核验来源后再裁决 |

裁判保留了未解决问题，没有强行给出结论，符合 V3.0 的“不能自证事实”。

## 5. 没有完成的事

- 24 题自动回归集尚未建立；当前只有单场真实运行；
- 没有外部事实核验通道，`factualAccuracy` 仍然不能读成准确率；
- 独立 Judge 依赖“有一位模型不参加辩论”；三位模型全参辩时应用只能
  标记 `sharedWith`，不能声称独立；
- 仍然只有一个云端 Provider，Provider 故障域独立性未验证；
- 自动质量通过只能标记 `TESTED`，不能标记 `PRODUCTION_READY`。

## 6. 结论

- P1 自动质量引擎：已实现、已接入、已有自动化测试；
- P2 Final Judge：已实现、映射现有五档结论、已有真实运行记录；
- 事实正确性仍未被验证，报告里也不会这么写。
