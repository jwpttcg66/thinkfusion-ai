# 云端模型：DeepSeek / OpenCode Go / OpenAI

日期 2026-11-04。原来只有一个写死 `gpt-4o-mini` 的 `openai` Provider，模型列表是常量，换个服务就得改代码。现在改成「预设 + 可编辑」，三个服务并行注册，混合模式会把它们算进成员。

## 三个预设

| 服务 | baseUrl | 默认模型 | 说明 |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini`、`gpt-4o` | 原样保留 |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-v4-flash`、`deepseek-v4-pro` | `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停用，默认值不用旧名 |
| OpenCode Go | `https://opencode.ai/inference/go/openai/v1` | `deepseek-v4.1-flash`、`deepseek-v4-pro`、`glm-5.3-flash`、`kimi-k3`、`qwen3.8-max`、`gpt-6-luna` | 订阅制（月费）；网关把全部文本模型翻译成 Chat Completions，GPT / Claude / Gemini 也能用 |

上游事实来自 DeepSeek 官方文档（2026-11 版本）与 OpenCode Go 网关的 `GET /openai/v1/models`（2026-11-09 实测 30 个 chat 模型）。两家的模型名都还在变，所以**模型列表在界面上可改**，改完立刻生效并持久化到 `cloud-config.json`。

要买 OpenCode Go 或第一次接真实 Key，看 [OPENCODE_GO.md](OPENCODE_GO.md)：里面是套餐额度、接入步骤、探活回执对照、验收清单与已知限制。

### 为什么是 Go，不是 Zen

同样在 opencode.ai 上，两套网关的协议边界完全不同：

| 网关 | 端点 | 计费 | 本 Provider |
| --- | --- | --- | --- |
| Go（订阅） | `https://opencode.ai/inference/go` | 月费，按模型月度额度封顶 | ✅ 全模型可用 |
| Zen（按量） | `https://opencode.ai/inference` | 按 token 付费 | ⚠️ 只有 `chat/completions` 那批能用 |

Go 会把所有文本模型翻译成 Chat Completions（官方原文：每种 API 都服务全部 Go 文本模型），所以 GPT / Claude / Gemini 在我们的 Provider 里也能直接用。Zen 没有这层翻译：它的 GPT 系列走 `/responses`、Claude 系列走 `/messages`，填进来第一次调用就失败，要支持得另写两个适配器。

因此预设只留一条 OpenCode：**Go**。要临时用按量计费的 Zen，把端点改成 `https://opencode.ai/inference/openai/v1` 即可，代码不用动。

### Go 要求的两条客户端头

官方「客户端要求」点名 User-Agent 与稳定的 `x-opencode-session`。前者由 `main/index.ts` 用 `ThinkFusion/<版本>` 填，后者用安装目录的 SHA-256 前 24 位（同一套安装恒定、不落盘、不含个人信息）。两条都通过 `OpenAICompatibleProvider` 的 `extraHeaders` 下发，探活和生成走同一份头。

## 配置分开存

| 内容 | 位置 | 加密 |
| --- | --- | --- |
| API Key | `api-keys.json`，按 provider id | `safeStorage`，加密不可用时拒绝写入 |
| 端点与模型 | `cloud-config.json` | 明文 |

分开的理由：读一下模型列表不该需要解密，导出配置也不该顺手把 Key 带出去。端点的 `baseUrl` 只接受 `http(s)`，尾斜杠会被去掉，避免拼出 `//chat/completions`。

## 混合模式怎么用上云端

`planLead()` 的 `cloud` 类型成员本来就在 `hybrid` 的 `openingSpeakers` 与 `debaters` 里。之前用不上只是因为没有可用的云端成员（无 Key）。配上 Key 后：

- 第一轮：网页 + 本地 + 云端全部独立发言
- 之后：本地与云端（能读 `context` / `system` 的成员）交叉质疑、修正
- 候选可用性仍由 `health()` 现算，没配 Key 的云端成员标成不可用，不会混进名单

## 裁决改用独立云端模型

`judge:adjudicate` 每次现选裁判，不在启动时定死：

1. 优先选**没参加这一场**的云端模型（独立裁决）
2. 只剩参辩模型时按决策 5 允许兼任，但 `sharedWith` 必须标出来
3. 一个云端都不可用时退回规则版，`backend: 'rules'`，不伪装成模型裁决

裁判 prompt 要求只输出一个 JSON 对象，解析失败会退回规则版并写 `fallbackReason`。

## 验证

**协议层**：`npm run test:cloud-multi` 8 条，起真实 HTTP 服务按前缀分三套端点，钉住：

- 三家各用自己的 baseUrl 与 Key，A 的 Key 不会发到 B
- `/models` 探活、非流式、流式 SSE 三条路
- 流式必开 `stream_options.include_usage`
- 模型名被停用时是 `model-not-found`，不是含糊的 `unknown`

**端到端**：真机启动应用，把 DeepSeek 的 baseUrl 指向本地 mock 端点、配一个测试 Key，然后：

- `getExecutionOptions()` 里三个云端服务都在，DeepSeek 默认模型是 v4 系列
- 混合辩论第一轮 6 条发言（3 网页 + 1 本地 + 2 云端），第二轮 3 条（本地 + 2 云端）
- 裁决 `backend: 'model'`，结论「每周 192 人时」，`sharedWith` 标出裁判兼任
- 清理：网页侧三站清空、辩论记录 0、应用侧会话 0、`api-keys.json` 无测试 Key、端点恢复预设

**没有验证的**：真实 DeepSeek / OpenCode 模型的回答质量与结论正确性。本机没有这两家的 Key，mock 端点只能证明链路通，不能证明模型答得对。要补这一条，在界面的「云端服务」里填一个真实 Key，然后跑一个中等复杂问题即可；代码路径不需要再改。

## 已知取舍

- `LOCAL_MODELS` 仍写死 `qwen2.5:7b`，本机 Ollama 的实际模型列表没有动态读取。这不是本轮目标，但换本地模型仍需改代码。
- 云端费用单价仍是可编辑配置，默认空着；没有单价时 `cost: null`，不写 0。
- 预算闸门按 Provider 各自累计，没有做跨 Provider 的总额上限。
