# OpenCode Zen 接入指南（买之前先看这份）

日期 2026-11-09。一句话结论：**已支持，但只作为「云端 API 源」支持**，能用的只有走
`chat/completions` 的模型；Zen 的 GPT 系列（`/responses`）与 Claude 系列（`/messages`）
本 Provider 调不了。

> 你看的是**按量付费**的 Zen。官方的月费订阅是另一个产品（Go / Go Plus / Go Teams），
> 它走不同的端点，而且网关会把所有文本模型翻译成 chat/completions——见
> [OPENCODE_GO.md](OPENCODE_GO.md)。

---

## 1. 支持到什么程度

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 作为云端 Provider 接入 | ✅ | 预设 `id: 'opencode'`，与 OpenAI / DeepSeek 并列注册 |
| 界面上填 Key、改端点、改模型 | ✅ | 存 `userData/cloud-config.json`（不含 Key），改完立刻生效 |
| 参与知识空间的汇总 / 交锋 / 最终意见 | ✅ | 执行模式「云端主导」只用它；「混合」时按归属择一 |
| 参与工程空间编排 | ✅ | 默认把本地 + 云端一起编入，云端补本机算力 |
| 作为辩论成员 | ✅ | 勾选 `opencode:<模型>` 即可 |
| Zen 的 GPT 系列 | ❌ | 走 `/responses`，协议不同 |
| Zen 的 Claude 系列 | ❌ | 走 `/messages`，协议不同 |
| 网页通道（SourceRail 里那一栏） | ❌ | OpenCode 没有可内嵌的对话页，也没做选择器 profile |
| 真实 Key 端到端 | ⚠️ 未验 | 只把端点指向本地 mock 验证过链路，没有真实 Key 跑过回答质量 |

---

## 2. 买之前先确认三件事

1. **你要的模型在不在 Chat Completions 里。** 预设只列这 5 个：
   `deepseek-v4-flash`、`deepseek-v4-pro`、`glm-5.2`、`kimi-k2.6`、`minimax-m2.7`。
   如果买它是为了用 GPT / Claude，那这份钱现在花下去也用不上——得先另写 Responses /
   Messages 适配器。
2. **费用不会自动估算。** 代码里没有 Zen 的价目表（单价写死过期之后比没有更糟），
   「报告与预算」里费用固定显示「未配置单价，不估算」，只统计 token。
3. **没有预算闸门。** Provider 支持 `budget`，但预设没有传，所以不存在「花到上限就停」。
   第一轮试跑请用短问题、少成员。

---

## 3. 买完怎么接（5 步）

1. 打开「研究设置」→「执行模式」页签 → 下拉到 **云端服务**。
2. 「OpenCode Zen」那一行的 **端点** 保持 `https://opencode.ai/zen/v1`
   （换了区域镜像才需要改，必须是 http(s)）。
3. **模型** 输入框按逗号分隔，填你实际买到的模型名，至少保留一个。
4. 点该行的「保存」——主进程会重建 Provider 名单，界面立刻反映。
5. 在 **API Key** 输入框粘贴 Key →「保存 Key」，状态从「未配置 Key」变「已配置 Key」。

> Key 只经 `app:set-api-key` 写入系统加密区，界面永远不回声；要换就再填一次，要清就点「移除」。

**探活**：健康检查走 `GET {端点}/models`，免费、不烧 token。
常见回执：

| 提示 | 含义 |
| --- | --- |
| 可用，已配置 N 个模型 | 通 |
| 还没有配置 API Key | Key 没写进去 |
| API Key 被拒绝（401/403） | Key 错 / 过期 / 这个 Key 不含该服务 |
| 云端限流中（429） | 服务端限流，不是配置错 |
| 连不上 {端点}：… | 端点或网络问题 |

---

## 4. 接上之后怎么用

- **知识空间**：「执行模式」选 **云端主导** → 回答之后的汇总 / 辩题 / 最终意见只用远程 API；
  选「混合」时，在「参与成员 → 云端模型」里勾要用的那几项（不勾表示全部）。
  第一轮回答按既定链路仍然来自网页通道，云端不参与回答，只参与回答之后的执行阶段。
- **工程空间**：默认编排会把所有可用的本地 + 云端模型编入，本地优先、云端补充；
  只有 `hybrid` 才会把网页也拉进编排。
- **辩论**：`opencode:<模型>` 是一个独立成员；同一模型名在 DeepSeek 和 Zen 上是两个成员，
  id 带服务前缀就是为了能只勾一家。

---

## 5. 数据落在哪

| 内容 | 位置 | 加密 |
| --- | --- | --- |
| API Key | `userData/api-keys.json` | `safeStorage` 密文（macOS 走 Keychain） |
| 端点 / 模型清单 | `userData/cloud-config.json` | 明文，刻意不含 Key |
| token 用量 | 内存（`usageSummary`） | 不落盘，重启归零 |

系统加密不可用时**直接拒绝写入**，不会降级成明文。

---

## 6. 故障对照

| 现象 | 最可能的原因 | 处理 |
| --- | --- | --- |
| 401 / 403 | Key 不对，或该 Key 不覆盖这个服务 | 重新粘贴，确认买的是 Zen 而不是别家 |
| 404 | 模型名写错，或填了走 `/responses` `/messages` 的模型 | 改成预设里那几个，或查控制台 |
| 429 | 服务端限流 | 等一会儿；首个字之前会自动重试 2 次 |
| 回答为空但 HTTP 200 | 服务端不是 chat/completions 的返回形状 | 换模型，不是本地的 bug |
| 「连不上」 | 端点写错 / 代理 | 端点必须是 `https://opencode.ai/zen/v1` |

---

## 7. 买完的真机验收清单

1. 云端服务里 OpenCode Zen 显示「已配置 Key」。
2. 「报告与预算」→「来源状态」里 `opencode` 显示可用。
3. 知识空间执行模式选「云端主导」，问一个短问题，回答链路的执行阶段出现 `opencode:…`。
4. 工程空间跑一个读文件的小任务，确认模型成员里有 OpenCode，计划能正常批准执行。
5. 「报告与预算」→「预算统计」里 token 有数字；「服务端没给 usage」若不是 0，说明该模型没回 usage。

做完记得把测试会话 / 任务删干净（`agentAPI.deleteConversation` + 取消任务）。

---

## 8. 已知限制（如实）

- 费用不估算：没有价目表，也不打算把价格写死在代码里。
- 没有预算闸门：`OpenAICompatibleProvider` 支持 `budget`，但预设未传值。
- 上下文长度未知：`contextTokens: null`，长文怎么切由上层默认策略决定，不按模型真实上限算。
- 真实 Key 未验证：目前只有 mock 端点证明过链路通，回答质量、限流曲线都还没数据。

---

## 9. 相关代码

| 文件 | 作用 |
| --- | --- |
| `src/main/providers/cloud-presets.ts` | 预设：端点、默认模型、能力边界说明 |
| `src/main/providers/openai-compatible.ts` | 请求、SSE、重试、usage、错误映射 |
| `src/main/providers/secrets.ts` | Key 密文存储（safeStorage） |
| `src/main/providers/cloud-config.ts` | 端点 / 模型覆盖的持久化 |
| `src/main/index.ts:585` | 启动时按预设注册 Provider 与成员 |
| `src/renderer/src/components/ResearchPanel.tsx:353` | 「云端服务」界面 |
| `scripts/check-cloud-multi.mjs` | 预设、覆盖、真实 HTTP 的回归测试 |
