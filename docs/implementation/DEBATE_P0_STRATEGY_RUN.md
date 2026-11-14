# Debate P0 六种策略真实运行（用户配置模型）

- 日期：2026-11-14
- Provider：`opencode-go`
- 模型：`deepseek-v4.1-flash`、`gpt-6-luna`、`kimi-k2.7-code`
- 每策略：2 轮、三模型、cloud 主导
- 运行：`debate-cloud-configured.cjs`

## 结果

180 秒阶段预算：

| 策略 | outcome | 轮数 | 消息 | 角色 | 失败 |
| --- | --- | --- | --- | --- | --- |
| truth | COMPLETED | 2 | 6 | proposer/peer | 无 |
| adversarial | COMPLETED | 2 | 6 | proposer/critic | 无 |
| expert | COMPLETED | 2 | 6 | domain_expert | 无 |
| assumption | PARTIAL | 2 | 5 | proposer/evidence_reviewer | kimi 超时 |
| solution | COMPLETED | 2 | 6 | proposer/critic | 无 |
| discovery | COMPLETED | 2 | 6 | peer | 无 |

`assumption` 单独把阶段预算提高到 300 秒复测：

- outcome：`COMPLETED`
- 轮数：2
- 消息：6
- 失败：无
- usage：三模型每轮均有 input/output token 记录

## 结论

- 六种策略都真实进入 `DebateOrchestrator`；
- 六种策略都至少完成过一次三模型两轮；
- 5/6 在 180 秒内稳定完成；`assumption` 需要更高超时或重试策略；
- 角色确实随策略变化；
- 没有人工质量评分，不能把“完成”写成“质量 PASS”。

## 仍需

- 对 `assumption` 做重复运行，确认 300 秒是否稳定；
- 根据模型响应时间校准默认超时，而不是全用 300 秒；
- 补 24 题自动测试集；
- P1 自动质量评估仍不能替代事实核验。
