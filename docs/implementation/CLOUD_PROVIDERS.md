# 云端模型：内置预设 + 自己从目录里选

日期 2026-11-04，2026-11-09 扩出自定义。原来只有一个写死 `gpt-4o-mini` 的 `openai` Provider，模型列表是常量，换个服务就得改代码。先改成「预设 + 可编辑」，再补上「目录里挑一家 / 自定义端点」，三个能力叠在一起：内置三条默认就有，其余按需添加。

## 两种来源

| 来源 | 是什么 | 存在哪 |
| --- | --- | --- |
| 内置预设（3 条） | OpenAI / DeepSeek / OpenCode Go，装好就在列表里 | 代码常量 `CLOUD_PRESETS` |
| 目录（14 项） | 「添加云模型」下拉里的候选：OpenRouter、Moonshot、百炼、智谱、SiliconFlow、火山方舟、混元、xAI、Groq、Together、自定义… | 代码常量 `PROVIDER_CATALOG` |
| 已添加 | 用户从目录挑中、或自定义端点的服务 | `cloud-config.json`（端点/模型/名字）+ `api-keys.json`（Key） |

**目录只收 OpenAI 兼容（Chat Completions）端点。** Anthropic / Gemini 的原生协议本 Provider 不会说，收进来只会让人填完 Key 才看到报错；要调那两家的模型，选 OpenRouter 这类聚合网关。

## 添加流程（界面）

设置 → 模型 → 云端 API 模型 → **「＋ 添加云模型」**：

1. 选「服务」：目录里的某一家，或「自定义（OpenAI 兼容）」
2. 端点自动填好（自定义时自己填，要求 `https://` 开头）
3. 填 Key，点 **「获取模型」** → 主进程 `GET {baseUrl}/models` 拿真实清单填进模型框；拿不到会明确报错（401/403/超时/不是 OpenAI 格式）
4. 点 **「添加」** → 服务出现在列表里，同时进入云端成员（可当主导/辩手）

添加后仍可「编辑」改端点/模型、换 Key；目录项与自定义服务可「删除这个服务」，内置三条只能清空 Key（删了就没有恢复默认的锚点了）。

### id 与删除的边界

- 目录项沿用目录 id（`groq`、`openrouter`…），同一家不能重复添加
- 自定义服务用 `user:` 前缀 + 名字的 slug，重名自动加序号（`user:公司内网-2`）
- `cloud-config.json` 里**有记录**就等于「已添加」：启动时只有这些会注册成 Provider

## 三个预设

| 服务 | baseUrl | 默认模型 | 说明 |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini`、`gpt-4o` | 原样保留 |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-v4-flash`、`deepseek-v4-pro` | `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停用，默认值不用旧名 |
| OpenCode Go | `https://opencode.ai/inference/go/openai/v1` | `src/shared/opencode-models.ts` 的完整付费清单（约 27 条，不含 `-free`） | 订阅制（月费）；网关把全部文本模型翻译成 Chat Completions；设置里可「选择模型」勾子集，全选只动可见项 |

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

## 写盘降级（2026-11-09）

`writeFileAtomic` 先写同目录临时文件再 `rename`。遇到 macOS 受管目录 / 加壳容器返回 `EPERM`、`EACCES`、`EXDEV` 时，改为**直接写目标文件**再清理临时文件。代价是断电可能留下半个文件，换来的是「Set 保存不再必然失败」——真机调试实例上就撞到过：rename 一律 EPERM，界面每次保存都弹红字。其它错误（磁盘满、路径不存在）照旧抛出，不吞。

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
