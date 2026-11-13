# Gate 0 D0.6：Agentic Search 真实模型验证

- 日期：2026-11-13
- 工程：`/Users/yalla/data/codeStudy/grpc-springboot`（Spring Boot + gRPC，10 个 Java 文件）
- 运行时：Electron 45.1.0 / Node 24.22.1
- 本地：Ollama；云端：OpenCode Go `deepseek-v4.1-flash`
- 命令：`npm run spike:agentic-search:real`
- 结论：**Agentic Search 在云端可用；默认本地模型不具备可靠的原生工具调用，必须探测并降级。Web 通道不参与。**

## 1. 模型探测

Ollama 当前安装：

- `deepseek-r1:14b`（`tools` 能力）
- `gpt-oss:20b`（`tools` 能力）
- `all-minilm`（embedding，排除）

`qwen2.5:7b`（应用默认）没有安装。按 `/api/tags` 顺序，`deepseek-r1:14b` 是第一个 tools 模型。

原生工具调用探测：

| 模型 | 结果 | 耗时 |
| --- | --- | --- |
| `deepseek-r1:14b` | **失败**：返回“运行 list_files 命令”的自然语言，没有 `tool_calls` | 37.6–47.1 s（两次） |
| `gpt-oss:20b` | 成功：返回 `list_files` 的 `tool_calls` | 冷加载约 12 s |
| `deepseek-v4.1-flash`（云端） | 成功：返回 `tool_calls` | 约 2–3 s |

因此本地验证使用 `gpt-oss:20b`，并在报告中明确它不是应用默认模型。这个结果直接支持复审里的判断：**默认本地模型若不能稳定工具调用，Core 必须退回预检索，而不是假装在探索。**

## 2. 验证方法

- 3 个真实问题：
  1. gRPC 服务端入口类与注册的 service。
  2. `GreeterClient` 如何连接服务端，目标地址来自哪里。
  3. `ClientRunner` 在什么条件下自动执行。
- 工具：`list_files` / `grep_search` / `read_file` / `find_symbol`；只读，路径限制在工程根目录。
- Agent 预算：最多 6 轮、10 次工具调用；预算用完后再发一次“只基于已有工具结果回答”的请求。
- 基线：关键词打分选 3 个文件，拼接最多 50 行/文件，单次回答，不给工具。
- 评分：预期术语覆盖率、`path:line` 引用数、工具调用次数、耗时、token。
- 评分不等于正确性审核；结论正确性由人工抽查（见第 4 节）。

## 3. 结果

### 本地 `gpt-oss:20b`

| 问题 | 模式 | 覆盖 | 缺失 | 工具 | 引用 | 耗时 | 输入/输出 token |
| --- | --- | --- | --- | --- | --- | --- | --- |
| service-entry | agent | 1.00 | — | 6 | 0 | 38.3 s | 7,409 / 818 |
| service-entry | baseline | 1.00 | — | 0 | 0 | 22.0 s | 1,076 / 647 |
| client-config | agent | 1.00 | — | 5 | 2 | 21.0 s | 4,387 / 619 |
| client-config | baseline | 0.80 | `50071` | 0 | 1 | 24.4 s | 681 / 721 |
| runner-condition | agent | 0.75 | `ApplicationRunner` | 2 | 1 | 11.0 s | 1,843 / 308 |
| runner-condition | baseline | 1.00 | — | 0 | 0 | 12.7 s | 458 / 384 |

观察：

- 覆盖率不差，但 agent 比 baseline 慢约 1.3–2 倍，token 多 4–7 倍。
- 第二次运行 `runner-condition` 漏了 `ApplicationRunner`（覆盖 0.75），说明本地 agent 输出有波动；不能把一次通过当成稳定能力。
- 引用不稳定：有的答案用 `【path:...:9-10】`，不是统一的 `path:line`；这说明“每个结论必须带证据 ID”不能只靠提示词，必须有结构化输出/校验。
- `service-entry` 把 `GrpcSpringbootApplication` 称为“gRPC 服务端入口类”，随后又正确指出 `GreeterGrpcService`。对“入口”的口径需要产品定义：是进程入口还是 gRPC service 注册入口。
- `client-config` agent 找到了 `50071`，baseline 没找到；这是 agent 的真实增益。

### 云端 `deepseek-v4.1-flash`

| 问题 | 模式 | 覆盖 | 缺失 | 工具 | 引用 | 耗时 | 输入/输出 token |
| --- | --- | --- | --- | --- | --- | --- | --- |
| service-entry | agent | 1.00 | — | 8 | 9 | 15.0 s | 5,234 / 828 |
| service-entry | baseline | 1.00 | — | 0 | 5 | 8.8 s | 1,069 / 748 |
| client-config | agent | 1.00 | — | 10 | 9 | 29.2 s | 8,978 / 1,387 |
| client-config | baseline | 0.80 | `50071` | 0 | 4 | 6.6 s | 663 / 461 |
| runner-condition | agent | 1.00 | — | 9 | 10 | 29.0 s | 9,905 / 1,522 |
| runner-condition | baseline | 1.00 | — | 0 | 12 | 10.8 s | 418 / 929 |

观察：

- 3/3 覆盖全部预期术语；baseline 在 `client-config` 两次都漏 `50071`，一次漏 `ConditionalOnProperty`。
- 引用数 9–10 条，baseline 4–12 条；`runner-condition` 的 baseline 引用反而更多（12 > 10），所以“agent 引用更多”不是普遍规律。
- Agent 的稳定增益在 `client-config`：能找到 `application.yml` 的 `static://localhost:${grpc.server.port}` 和 50071；baseline 两次都漏端口。
- 代价：耗时约 1.6–4.4 倍，token 约 5–20 倍。云端每次 5k–10k 输入 token，长时间多问题需要预算。
- API 返回的 `cost` 在当前 Go 额度下为 0；不能据此认为长期免费。

## 4. 正确性抽查

云端 agent 的三条结论与源码一致：

- `GreeterGrpcService` 标注 `@GrpcService`，继承 `GreeterGrpc.GreeterImplBase`；工程没有手写 `ServerBuilder`，由 `net.devh` starter 自动装配。
- `GreeterClient` 通过 `@GrpcClient("local-grpc-server")` 注入 blocking stub；地址来自 `application.yml` 的 `grpc.client.local-grpc-server.address=static://localhost:${grpc.server.port}`，端口 50071。
- `ClientRunner` 受 `@ConditionalOnProperty(prefix="demo.client", name="run-on-startup", havingValue="true")` 控制；实现 `ApplicationRunner`，启动后执行；默认配置为 `false`。

本地 agent 的两处偏差：

- 把 Spring Boot 进程入口 `GrpcSpringbootApplication` 当成“gRPC 服务端入口”，但同一答案里给出了正确的 `GreeterGrpcService`；这是术语口径问题，不是完全编造。
- 引用格式不统一，不能被 `path:line` 正则完整统计；结构化证据校验仍然必要。

## 5. 结论

1. **Agentic Search 可行，但只在能可靠 tool calling 的模型上可行。** 云端 `deepseek-v4.1-flash` 和本地 `gpt-oss:20b` 通过；默认 `deepseek-r1:14b` 探测失败。
2. **Web 通道不能参与工具循环。** 本次没有使用网页模型；网页模型只能接收冻结证据包。
3. **Agent 的稳定增益是“跨文件/配置定位”，不是“覆盖率数字”。** `client-config` 两次都找到了 baseline 漏掉的 `50071`；`runner-condition` 的 baseline 一次漏了 `ConditionalOnProperty`，但第二次也找到了，不能算稳定差异。
4. **代价必须计入预算。** 云端 agent 输入 token 是 baseline 的 5–20 倍；本地 agent 也明显更慢。Gate 2 必须有轮数、token、墙钟和“无新增证据”停止条件。
5. **不能只靠提示词保证证据纪律。** 本地模型引用格式不稳定；最终答案需要结构化 claim/evidence 输出或 host 校验，否则“每个结论有 path:line”只是愿望。
6. **Core 降级必须显式。** 默认本地模型不可用时，UI 应说明“当前模型不能自主探索”，退回预检索 + 单次回答，而不是静默用弱结果冒充 Agentic Search。

## 6. 本次未覆盖

- 网页模型（未参与工具循环）。
- 多模型并行探索与共享证据快照。
- Maven/Gradle 构建、JDT/类型绑定。
- 更多工程与更多问题（本次 1 个真实工程、3 个问题）。
- 用户级正确性标注；本次是 1 名审核者抽查。
- 长期成本：API 返回 0 只代表当前额度。
