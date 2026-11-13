# TF-V32 真实模型回归记录

- 日期：2026-11-14
- 工程：`codeStudy/grpc-springboot`
- 运行：`node_modules/.bin/electron scripts/spikes/agentic-search-real.cjs --no-sandbox`
- 说明：**这是独立 harness，不是产品 Agentic Search 循环**。它验证模型探索能力，不验证产品预算/FINALIZING。

## 结果

| 问题 | 本地 gpt-oss:20b agent | 云端 deepseek-v4.1-flash agent |
| --- | --- | --- |
| service-entry | 1.00 / 2 引用 / 6 工具 | 1.00 / 7 / 10 |
| client-config | 1.00 / 2 / 5 | 1.00 / 12 / 9 |
| runner-condition | 1.00 / 1 / 2 | 1.00 / 13 / 7 |
| business-flow | **0.00 / 0 / 6** | 1.00 / 17 / 10 |
| reverse-check | 1.00 / 0 / 5 | 1.00 / 10 / 10 |

## 结论

- 云端 5/5 覆盖；
- 本地 `reverse-check` 1.00，但 `business-flow` 仍然在 harness 预算耗尽后返回“（达到预算，未形成最终回答）”；
- 默认本地模型探测仍失败（`deepseek-r1:14b` 无 tool_calls），harness 使用 `gpt-oss:20b`；
- **产品级 Agentic Search 未在本记录中验证**：产品预算/FINALIZING 已由 `check-agentic-search` 和 `check-engineering-tools` 的确定性测试覆盖，但没有用真实模型跑产品链路；
- 原生 Tool Calling 未验证，按 UNKNOWN 处理；
- 30 问题/3 工程人工基准未准备。

## 结论状态

`business-flow` 产品级真实回归：**PENDING**。  
不能根据本表把 V3.2 标为 TESTED/PRODUCTION_READY。
