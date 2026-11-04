# Phase D 实施记录：Cloud API Provider

对应项目书第五章、第十五章 Phase D。日期 2026-11-04。

## 做了什么

| 文件 | 内容 |
| --- | --- |
| `src/main/providers/secrets.ts` | `ApiKeyStore`：密文落盘、按 id 取回、不含明文的清单 |
| `src/main/providers/openai-compatible.ts` | `OpenAICompatibleProvider`：generate / stream / health / 重试 / 用量与费用 |
| `src/main/providers/types.ts` | `ModelUsage` 加 `cost?`，没有单价时是 `null` 不是 0 |
| `scripts/check-cloud.mjs` | 17 条行为测试 |
| `scripts/check-cloud-live.mjs` | 有 `CLOUD_API_KEY` 才跑的真机测试，否则整组 skip |
| `scripts/fixtures/cloud/` | OpenAI API 文档里的响应**结构**样例 |

**没有接线**：和 Phase C 一样，这一阶段只是「可注册、可调用」，注册进
`main/index.ts` 和 UI 属于 Phase E/J。

## 关于「真实数据」：这一阶段做不到，如实标注

本机没有云端 API Key，**无法真机录制响应**。`scripts/fixtures/cloud/_meta.json`
里写死了 `recordedFromLiveService: false`，payload 是 OpenAI API Reference 的
响应字段结构，数值是文档示例值，不是真实调用结果。

真机入口留着：

```bash
CLOUD_API_KEY=sk-... CLOUD_BASE_URL=https://api.openai.com/v1 \
  CLOUD_MODEL=gpt-4o-mini npm run test:cloud:live
```

不设 Key 时输出 `[skip]` 且 3 条全 skip，不把「没跑」写成「通过」。

## 五处按项目书 5.2 落地的关键约束

1. **Key 不暴露给 renderer**：`ApiKeyStore.list()` 只返回 id 和时间，
   `get()` 只在主进程调用。没有任何 IPC handler 返回明文或密文。
2. **加密不可用时拒绝写入**，不降级成明文。明文降级最容易在「先跑起来再说」
   时留下，事后最难发现。`safeStorage` 延迟加载，普通 Node 进程 import 本层
   不会炸。
3. **流式必须开 `stream_options.include_usage`**：不开的话，OpenAI 兼容接口
   的流式调用永远拿不到 token 数，费用统计会静默少一半。测试钉住了请求体。
4. **单价是可编辑配置，不硬编码**：写死在代码里的价目表过期之后，估出来的
   数比没有更糟。没有单价配置时 `cost: null`，不是 0。
5. **重试只在吐出第一个字之前**：429 / 5xx / 网络错误可重试（指数退避、
   上限 2 次）；401 不重试；流式一旦开始 yield 就一路读到底，绝不重新发请求
   把两段回答拼在一起。

## 验收对照（项目书 Phase D）

| 要求 | 状态 |
| --- | --- |
| 可以配置并调用云端模型 | ✅ 逻辑测试覆盖；**真机未验**（无 Key） |
| API Key 不暴露给 Renderer | ✅ `ApiKeyStore` 只有不含明文的清单 |
| 错误和限流能够正确处理 | ✅ 429 重试 / 401 auth / 404 model-not-found / 5xx unavailable |
| 用户可以禁用 Provider | ⚠️ `health()` 无 Key 即不可用；UI 开关属 Phase J |
| Streaming | ✅ SSE 按 `data:` 行解析，任意 TCP 切分可拼对 |
| 超时 / 请求取消 | ✅ `AbortSignal` → abort 连接 → `cancelled` |
| Token 统计 / 费用估算 | ✅ 非流式与流式都记录；`usageSummary()` 单独记「服务端没给 usage」的次数 |

## 测试

```
npm run test:cloud       17 条，全绿
npm run test:cloud:live   3 条 skip（没有 Key，如实标注）
npm run typecheck         干净
npm test                  229 条全绿（原 212 + 17）
```

钉住的反例：文件里不含明文 Key、损坏的密钥文件不崩、加密不可用时拒绝写入、
探活只打 `/models` 不烧 completions、`contextTokens: null`、没有单价时
`cost: null`、SSE 每 9 字节切一块仍拼出 `51`、429 首次 + 1 次重试共 2 次请求
不是无限重试、流式成功只发 1 次请求、取消后 fetch signal 为 aborted。

## 没做的

- **没有真实云端调用**（无 Key）。这一项不标通过。
- **没有注册进 `main/index.ts`**，没有 UI 配置入口、没有把 Key 写进设置的
  IPC（Phase E/J）。
- **没有实现 `local-only` 隐私拦截**：那是执行模式选人时的职责（Phase E），
  不是 Provider 自己的。计划里写明的「local-only 下一次重试都不许发」由 E 的
  过滤层保证——选人阶段就不会把 Cloud 放进名单。
