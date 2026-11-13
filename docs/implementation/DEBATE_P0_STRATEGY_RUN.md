# Debate P0 六种策略真实运行

- 日期：2026-11-14
- Provider：`opencode-go`
- 模型：`deepseek-v4.1-flash`、`claude-haiku-5-5`
- 运行：`./node_modules/.bin/electron scripts/spikes/debate-cloud-strategies.cjs --no-sandbox`
- 每策略：2 轮，cloud 主导，stageTimeout 120s

## 结果

| 策略 | 状态 | 轮数 | 消息 | 角色 | 失败 |
| --- | --- | --- | --- | --- | --- |
| truth | completed | 2 | 4 | proposer/peer | 无 |
| adversarial | completed | 2 | 3 | proposer/critic | deepseek 一次超时 |
| expert | completed | 2 | 4 | domain_expert | 无 |
| assumption | completed | 2 | 4 | proposer/evidence_reviewer | 无 |
| solution | completed | 2 | 3 | proposer/critic | deepseek 一次超时 |
| discovery | completed | 2 | 4 | peer | 无 |

## 结论

- 六种策略都能真实进入 `DebateOrchestrator`，不是只有 Prompt 存在；
- 4/6 策略完成双模型两轮；
- `adversarial` / `solution` 各有一条模型超时，只有单边有效发言，不能判为“双模型完整通过”；
- 角色确实随策略变化：
  - expert → domain_expert；
  - assumption → proposer / evidence_reviewer；
  - adversarial / solution → proposer / critic；
  - discovery → peer。
- **没有做人工质量评分**，不能判 PASS；当前只能判 `PARTIAL`。

## 仍需

- 对 adversarial / solution 换更快模型或提高 stage timeout 后复测；
- 记录每场真实 token/usage（当前 `DebateMessage` 未落盘 usage）；
- 24 题人工标注集；
- 人工盲评。
