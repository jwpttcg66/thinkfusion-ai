# OpenCode Go（订阅制会员）接入方案

日期 2026-11-09。**Go 和 Zen 不是一套东西**：Zen 是按量充值的模型网关，Go 是月费订阅。
好消息是它有官方文档写明「每种 API 都能服务全部 Go 文本模型」，所以**不需要为
Messages / Responses 另写适配器**——这和 Zen 那边的结论不同。

## 1. 官方事实（来自 opencode.ai/docs/console/go，2026-11-09）

| 项目 | 内容 |
| --- | --- |
| 套餐 | **Go $10/月**、**Go Plus $40/月**、**Go Teams $20/人/月**（首月常有 $5 促销） |
| 额度单位 | 不是「次数」，是**每个模型的月度美元额度**；5 小时窗口 = 月额度的 20%，每周 50%，每月 100% |
| 举例 | DeepSeek V4.1 Flash 月额度 $100；GLM-5.3-Flash / GLM-5.2 / MiMo / LongCat 各 $60；Kimi K3、DeepSeek V4 Pro、GPT 系、Claude Haiku 各 $15 |
| 超额 | 关掉就阻塞；打开 **Extra Usage** 则回落到你 Console 的按量余额（Go Teams 默认开） |
| 模型数 | 网关当前返回 **30 个 chat 模型**（清单见文末） |
| Base URL（Go） | `https://opencode.ai/inference/go`，OpenAI 兼容路径 `/openai/v1/chat/completions` |
| Base URL（按量） | `https://opencode.ai/inference`，路径同上但无 `/go` |
| 鉴权 | Console → Account → **Personal API keys** → `oc_sk_…`（只显示一次） |
| 客户端要求 | ① 像编码 agent 的流量；② 自带 User-Agent（不能是 SDK/HTTP 库的默认名）；③ 每次请求带**稳定的** `x-opencode-session` |
| 第三方客户端 | 允许，官方列了「已验证客户端」清单；同时说明**会监控滥用** |

两个已验证的事实（本次实测）：

- `GET https://opencode.ai/inference/go/openai/v1/models` 免 Key 返回 200，30 条 chat 模型 → 我们的探活路径成立，不烧额度。
- `https://opencode.ai/zen/go/v1/models` 返回同一份清单，是兼容别名；官方文档写的是 `/inference/go`，方案按官方走。

## 2. 对我们最关键的一条

官方原文：*Every API serves every paid and Go text model: Console sends a request to the
model's own endpoint when it speaks that API, and translates it otherwise.*

也就是说 **Claude Haiku 5.5、GPT-6 Luna、Grok 4.7、Gemini 4 Argon 这些「原生不是
chat/completions」的模型，用 chat/completions 也能调**，网关替我们翻译。

→ 现有 `OpenAICompatibleProvider` 一行协议代码都不用加，**Go 的 30 个模型全都能用**。
（Zen 那边因为没写翻译，GPT/Claude 才不能用；这是两件事，别混。）

## 3. 两个接入方案

### 方案 A：零改代码，今天就能试（先用这个验证 Key）

把「研究设置 → 执行模式 → 云端服务 → OpenCode Zen」这一行改成 Go 的口径：

- 端点：`https://opencode.ai/inference/go/openai/v1`
- 模型：`deepseek-v4.1-flash, deepseek-v4-pro, glm-5.2, kimi-k3, qwen3.8-max`
- API Key：粘 Go 会员的 `oc_sk_…`

**代价**：这一行从此代表 Go 而不是 Zen（Zen 余额就用不上了）；请求里没有自带
User-Agent、也没有 `x-opencode-session`，属于官方「客户端要求」里没做到的两条，
可能被降级路由或缓存复用变差，也可能被滥用监控盯上。

### 方案 B：加一个独立预设（推荐，改动很小）

1. `src/main/providers/cloud-presets.ts`：新增
   `{ id: 'opencode-go', label: 'OpenCode Go', baseUrl: 'https://opencode.ai/inference/go/openai/v1', models: [...], note: '订阅制；额度按模型月额度计，5 小时窗口为 20%' }`
2. `src/main/providers/openai-compatible.ts`：请求头补两条
   - `user-agent: ThinkFusion/<版本>`（不要沿用 undici 默认名）
   - `x-opencode-session: <稳定 id>`：`ModelRequest` 加可选 `sessionId`，没有时用
     Provider 实例级的固定 id；调用方后续可按会话传，缓存命中更好
3. `pricing`：给 Go 填官方单价，这样「报告与预算」里的 token 能折算成美元，**近似对上额度窗口**
   （真值在响应里的 `opencode.allowance` 字段，后续可以读出来直接显示剩余额度）
4. `scripts/check-cloud-multi.mjs`：断言新增预设、两条请求头、session 稳定
5. 文档：本文件 + `OPENCODE_ZEN.md` 互相指一下

工作量：约 60 行代码 + 测试，不影响现有 Zen 预设（两行各自配 Key，互不干扰）。

## 4. 买完怎么验（不管走 A 还是 B，先跑这一条）

```bash
curl -sS https://opencode.ai/inference/go/openai/v1/chat/completions \
  -H "Authorization: Bearer $OC_GO_KEY" \
  -H "content-type: application/json" \
  -H "user-agent: ThinkFusion/0.1.3" \
  -H "x-opencode-session: ses_local_test_1" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"只回复 ok"}],"stream":false}'
```

- 200 + 有 `choices` → 通；顺手看一眼有没有 `opencode.allowance`（额度余量）。
- 400 且提到 session → `x-opencode-session` 是硬要求，方案 A 走不通，直接上 B。
- 401/403 → Key 不对，或这个工作区没订阅 Go。
- 429 → 额度窗口用完，或触发限流。

## 5. 风险与限制（买之前先认）

1. **流量画像**：Go 是给编码 agent 用的，官方明说会监控滥用。我们发的是「汇总/辩论/最终意见」这类长文本请求，不是典型 agent 流量；大批量跑辩论有被限流或警告的风险。建议先小流量试。
2. **额度不是预算闸门**：我们的 Provider 没传 `budget`，Go 的额度在服务端，超额才 429（或走 Extra Usage）。别拿它当「花到上限就停」。
3. **区域限制**：免费模型里 Crouton Alpha Free、Beam Free 明确不含中国大陆（含港澳）；付费 Go 模型没写区域限制，但网关在国内的连通性要实测。
4. **一把 Key 两套账**：同一个 Console 账户的 Key 既能调 Go 也能调按量余额，但我们是按 provider id 分开存 Key，两个预设要各粘一次；只想用一个就只启用它。
5. **模型清单会变**：官方写明「list may change」，所以模型名必须可改（现在是可改的），别写死到界面文案里。

## 6. 附：Go 网关当前 30 个 chat 模型

```
deepseek-v4.1-flash   deepseek-v4-pro      glm-5.2              glm-5.3
glm-5.3-flash         grok-4.7             gpt-6-luna           gpt-5.6-luna
claude-haiku-5-5      gemini-4-argon       kimi-k3              kimi-k3.1-pro
kimi-k2.7-code        qwen3.8-max          qwen3.8-flash        qwen3.7-plus
minimax-m3            minimax-m3.1-flash   mimo-v2.6-flash      mimo-v2.6-pro
mimo-v2.5             mimo-v2.5-pro        hy3                  hy4
hy4-preview           longcat-2.0          step-5-preview       muse-spark-1.2-contributor
muse-spark-1.3-contributor                 beam-free            crouton-alpha-free
iceman-contributor-free
```

`-free` 结尾的三个属于限时免费，区域与可用性随时会变，**不建议放进预设默认值**。

## 7. 代码位置

| 文件 | 方案 B 要改什么 |
| --- | --- |
| `src/main/providers/cloud-presets.ts` | 加 `opencode-go` 预设与默认模型 |
| `src/main/providers/openai-compatible.ts` | 加 User-Agent 与 `x-opencode-session` 请求头 |
| `src/main/providers/types.ts` | `ModelRequest` 加可选 `sessionId` |
| `src/main/index.ts:585` | 无需改（按预设自动注册） |
| `scripts/check-cloud-multi.mjs` | 断言预设与请求头 |
