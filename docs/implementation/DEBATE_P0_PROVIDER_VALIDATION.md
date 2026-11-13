# Debate P0 Provider 验证

- 日期：2026-11-14
- Provider：`opencode-go`
- Base URL：`https://opencode.ai/inference/go/openai/v1`
- Key：仅存在本机密文库，未写入本文件。

## 1. 模型连通性

| 模型 | 状态 | 说明 |
| --- | --- | --- |
| `deepseek-v4.1-flash` | 200 | 可用于辩论 |
| `glm-5.3` | 200 | 可用于辩论；长回答可能触发 60–120s 超时 |
| `claude-haiku-5-5` | 200 | 响应较快 |
| `qwen3.8-max` | 200 | 已连通，本轮未用于辩论 |
| `gpt-5.6-luna` | 400 | 测试请求把 max tokens 设得过小；不是模型不可用 |

结论：

- **同一 Provider 下至少 3 个模型可用**；
- 模型多样性满足 P0 双/三模型的基础验证；
- **只有 1 个 Provider**，因此不能声称“两个 Provider 故障域独立”。

## 2. 真实三模型辩论

运行：

```bash
npm run build:test
./node_modules/.bin/electron scripts/spikes/debate-cloud-real.cjs --no-sandbox
```

模型：

- `deepseek-v4.1-flash`
- `glm-5.3`
- `claude-haiku-5-5`

结果：

- strategy：`truth`
- rounds：2
- messages：5
- failures：`glm-5.3` 在第二轮超过单次调用时限 60 秒
- status：completed（单条失败被记录，不阻塞其他模型）
- duration：约 85 秒

这说明：

- `DebateOrchestrator` 能真实调用同一 Provider 下的多个模型；
- 角色（proposer / peer）和两轮链路正常；
- 单模型超时会进入 `round.failures`，不会让整场崩掉；
- 但该场不是完整的三模型两轮，不能当“三模型完整通过”。

## 3. 仍需补的 Provider 能力

- 第二个 Provider 的真实 Key；
- 各模型的 context window / max output 实测；
- 失败重试与超时阈值按模型校准；
- Token 用量落盘（当前 `DebateMessage` 不保存 usage，只有 `SubAgentAnswer` 有）；
- 流式 Tool Calling 与辩论链路无关，本轮不要求。

## 4. 结论

`SINGLE_PROVIDER + 3 MODELS`：**PARTIAL PASS**。  
`TWO_PROVIDERS`：**BLOCKED**（没有第二个 Key，不能伪造）。
