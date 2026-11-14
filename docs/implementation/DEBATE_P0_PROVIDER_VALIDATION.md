# Debate P0 Provider 验证（用户配置模型）

- 日期：2026-11-14
- Provider：`opencode-go`
- 用户设置中选择的模型：
  - `deepseek-v4.1-flash`
  - `gpt-6-luna`
  - `kimi-k2.7-code`
- Key：只在本机密文库，未写入报告。

## 1. 连通性

三个配置模型均返回 200：

| 模型 | 状态 |
| --- | --- |
| `deepseek-v4.1-flash` | 200 |
| `gpt-6-luna` | 200 |
| `kimi-k2.7-code` | 200 |

另外 `glm-5.3`、`qwen3.8-max` 也连通，但不是用户当前勾选的模型。

## 2. 三模型真实辩论

运行：

```bash
npm run build:test
./node_modules/.bin/electron scripts/spikes/debate-cloud-configured.cjs --no-sandbox
```

- 三个模型全部参与；
- 每种策略 2 轮；
- 消息已记录 `providerId/modelId/usage`。

三模型 `truth` 结果：

- 2 轮、6 条发言；
- 角色 proposer / peer；
- 无失败；
- 实际 usage 已落盘（输入约 139–4418 token/条，输出约 1701–4142 token/条）。

## 3. 超时

默认单次调用时限已从 60 秒调整为 **180 秒**，因为真实云端长回答会超过 60 秒；仍可由 `DebateConfig.budget.stageTimeoutMs` 覆盖。

在 180 秒下：

- 5/6 策略完整两轮；
- `assumption` 一次 kimi 超时，报告为 `PARTIAL`；
- 同策略把阶段预算提高到 300 秒后复测：2 轮、6 条发言、无失败，`COMPLETED`。

## 4. 结论

- 用户配置的三个模型都可真实调用；
- 单 Provider + 三个模型满足 P0 的模型多样性；
- 仍不满足“两个独立 Provider 故障域”；
- `assumption` 在 180 秒下不稳定，需要按模型/策略继续校准超时或重试。
