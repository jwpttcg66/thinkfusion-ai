# OpenCode Go：唯一的 OpenCode 云端源

日期 2026-11-09。一句话：**OpenCode 这一栏现在只接订阅制的 Go**，预设 id 是
`opencode-go`，端点 `https://opencode.ai/inference/go/openai/v1`。按量计费的
Zen 不再单列（原因见第 3 节），需要时改一行端点就能用。

## 1. 官方事实（opencode.ai/docs/console/go，2026-11-09）

| 项目 | 内容 |
| --- | --- |
| 套餐 | **Go $10/月**、**Go Plus $40/月**、**Go Teams $20/人/月**（首月常有 $5 促销） |
| 额度单位 | 不是「次数」，是**每个模型的月度美元额度**；5 小时窗口 = 月额度的 20%，每周 50%，每月 100% |
| 举例 | DeepSeek V4.1 Flash 月额度 $100；GLM-5.3-Flash / GLM-5.2 / MiMo / LongCat 各 $60；Kimi K3、DeepSeek V4 Pro、GPT 系、Claude Haiku 各 $15 |
| 超额 | 关掉就阻塞；打开 **Extra Usage** 则回落到 Console 的按量余额（Go Teams 默认开） |
| 模型数 | 网关当前返回 **30 个 chat 模型**（清单见第 7 节） |
| Base URL | `https://opencode.ai/inference/go`，OpenAI 兼容路径 `/openai/v1/chat/completions` |
| 鉴权 | Console → Account → **Personal API keys** → `oc_sk_…`（只显示一次） |
| 客户端要求 | ① 像编码 agent 的流量；② 自带 User-Agent（不能是 SDK/HTTP 库默认名）；③ 每次请求带**稳定的** `x-opencode-session` |
| 第三方客户端 | 允许，官方列了「已验证客户端」清单；同时说明**会监控滥用** |

实测：`GET https://opencode.ai/inference/go/openai/v1/models` 免 Key 返回 200、
30 条 chat 模型——探活走这条路，不烧额度。

## 2. 一条决定性的差异：Go 会翻译协议

官方原文：*Every API serves every paid and Go text model: Console sends a request to the
model's own endpoint when it speaks that API, and translates it otherwise.*

所以 Claude Haiku 5.5、GPT-6 Luna、Grok 4.7、Gemini 4 Argon 这些「原生不是
chat/completions」的模型，用 chat/completions 也能调，网关替我们翻译。
**现有 `OpenAICompatibleProvider` 一行协议代码都不用加，30 个模型全通。**

## 3. 为什么去掉 Zen

同一个 opencode.ai 上两套网关，协议边界完全不同：

| 网关 | 端点 | 计费 | 本 Provider |
| --- | --- | --- | --- |
| Go（订阅） | `https://opencode.ai/inference/go` | 月费，按模型月度额度封顶 | ✅ 全模型可用 |
| Zen（按量） | `https://opencode.ai/inference` | 按 token 付费 | ⚠️ 只有 `chat/completions` 那批能用 |

Zen 没有翻译层：GPT 系列走 `/responses`、Claude 系列走 `/messages`，填进来第一次
调用就报错。既然用户选的是 Go，就不留一条「半边能用」的 Zen 预设去误导人。

要临时用按量余额：设置里把 OpenCode Go 的端点改成
`https://opencode.ai/inference/openai/v1`、模型改成 Zen 支持的那批（DeepSeek /
GLM / Kimi / MiniMax），Key 换成 Zen 的即可。代码不用动，`cloud-config.json`
会记住这个覆盖。

## 4. 接入步骤（5 步）

1. 设置（左下角齿轮）→「模型」页签 → 往下到「云端 API 模型」
2. 「OpenCode Go」那一行的**端点**保持 `https://opencode.ai/inference/go/openai/v1`
3. 点「编辑」，**模型**用逗号分隔填你买到的名字（预设默认见下表），点「保存」
4. 在 Key 那一行粘贴 Go 会员的 `oc_sk_…` → 「保存 Key」
5. 状态变成「已配置 Key」；「报告与预算 → 来源状态」里 `opencode-go` 显示可用

> 2026-11-09 起这一块从「研究设置 → 执行模式」搬到了「设置 → 模型」：找 Key 的人不会想到去研究设置里翻。研究设置只留「谁参与」，不再填凭据。

改动立即重建 Provider 名单，不用重启。

预设默认模型（都避开了 `-free` 那三个，理由见第 6 节）：

| 模型 | 说明 |
| --- | --- |
| `deepseek-v4.1-flash` | 月额度最高（$100），适合当主力 |
| `deepseek-v4-pro` | 强推理，额度低（$15） |
| `glm-5.3-flash` | 额度高（$60） |
| `kimi-k3` | 长上下文，额度 $15 |
| `qwen3.8-max` | 阿里系 |
| `gpt-6-luna` | 走翻译层，验证「非 chat 原生模型也能用」 |

## 5. 请求头怎么实现的

Go 的「客户端要求」里那两条，现在由 `OpenAICompatibleProvider` 的
`extraHeaders` 统一下发，探活（`GET /models`）和生成（`POST /chat/completions`）
共用 `headers()`，所以两处都带：

- `user-agent: ThinkFusion/<app.getVersion()>`
- `x-opencode-session: <安装目录路径的 SHA-256 前 24 位>`

会话标识用安装目录指纹而不是随机数：同一套安装每次都一样（官方要求「稳定」），
不落盘、不含任何个人信息，也不随重启变化。设置里的端点/模型/Key 三处改动都会
重建 Provider，头跟着走。

## 6. 风险与限制（买之前先认）

1. **流量画像**：Go 是给编码 agent 用的，官方明说会监控滥用。我们发的是「汇总 /
   辩论 / 最终意见」这类长文本请求，不是典型 agent 流量；大批量跑辩论有被限流或
   警告的风险。建议先小流量试。
2. **额度不是预算闸门**：Provider 没传 `budget`，Go 的额度在服务端，超额才 429
   （或走 Extra Usage）。别拿它当「花到上限就停」。
3. **不估算费用**：Go 是订阅制，按 token 折算的美元数对不上真实额度窗口，所以
   preset 不带 `pricing`，「报告与预算」里显示「未配置单价，不估算」，只统计 token。
   真值在响应里的 `opencode.allowance` 字段，后续可以读出来直接显示剩余额度。
4. **区域限制**：`-free` 结尾的模型（Beam Free、Crouton Alpha Free、
   Iceman Contributor Free）明确不含中国大陆（含港澳），所以不进默认值；付费模型
   没写区域限制，但国内直连 opencode.ai 的连通性要实测。
5. **模型清单会变**：官方写明 list may change，所以模型名可改，别写死到界面文案里。
6. **从 Zen 升级过来的**：旧 Zen 预设的 Key 存在 `api-keys.json` 的 `opencode`
   id 下，新预设读的是 `opencode-go`，需要在界面重新粘一次 Key（旧条目不会被复用，
   也不会被发到 Go 端点）。

## 7. 买完先跑这条 curl

```bash
curl -sS https://opencode.ai/inference/go/openai/v1/chat/completions \
  -H "Authorization: Bearer $OC_GO_KEY" \
  -H "content-type: application/json" \
  -H "user-agent: ThinkFusion/0.6.0" \
  -H "x-opencode-session: ses_local_test_1" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"只回复 ok"}],"stream":false}'
```

| 回执 | 含义 | 下一步 |
| --- | --- | --- |
| 200 + `choices` | 通 | 直接填进设置；顺手看有没有 `opencode.allowance` |
| 400 且提到 session | `x-opencode-session` 是硬要求 | 我们已默认带，检查请求头是否被代理剥掉 |
| 401 / 403 | Key 不对，或这个账户没订阅 Go | 重新生成 Key |
| 429 | 额度窗口用完 / 触发限流 | 看 Console 用量，或开 Extra Usage |
| 连不上 | 网络 / 代理 | 先解决连通性，与代码无关 |

## 8. 附：Go 网关当前 30 个 chat 模型（2026-11-09 实测）

```
deepseek-v4.1-flash   deepseek-v4-pro       glm-5.2              glm-5.3
glm-5.3-flash         grok-4.7              gpt-5.6-luna         gpt-6-luna
claude-haiku-5-5      gemini-4-argon        kimi-k3              kimi-k3.1-pro
kimi-k2.7-code        qwen3.8-max           qwen3.8-flash        qwen3.7-plus
minimax-m3            minimax-m3.1-flash    mimo-v2.6-flash      mimo-v2.6-pro
longcat-2.0           step-5-preview        hy3                  hy4
hy4-preview           muse-spark-1.2-contributor                 muse-spark-1.3-contributor
beam-free             crouton-alpha-free    iceman-contributor-free
```

## 9. 代码位置

| 文件 | 作用 |
| --- | --- |
| `src/main/providers/cloud-presets.ts` | `opencode-go` 预设：端点、默认模型、note |
| `src/main/providers/openai-compatible.ts` | `extraHeaders` 选项；`headers()` 合并，额外头放最后 |
| `src/main/index.ts:585` | 注册预设时补 User-Agent 与 `x-opencode-session` |
| `src/renderer/src/mock-api.ts` | 浏览器预览里的同一条目 |
| `scripts/check-cloud-multi.mjs` | 9 条断言：预设、路径、Key 不串、额外头 |
