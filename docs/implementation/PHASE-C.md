# Phase C 实施记录：Ollama 本地模型集成

对应项目书第四章、第十五章 Phase C。日期 2026-11-04。
验证模型 `qwen2.5:7b`（本机已有，未下载项目书默认的 9B）。

## 做了什么

| 文件 | 内容 |
| --- | --- |
| `src/main/providers/ollama.ts` | `OllamaProvider`：`listModels` / `health` / `capabilities` / `generate` / `stream` / `cancel` |
| `src/main/providers/local-admission.ts` | `LocalAdmission`：并发 1、排队上限、名额归还 |
| `src/main/providers/types.ts` | 加 `ModelRequest.requestId`、`ProviderErrorCode` 的 `model-not-found` |
| `scripts/check-ollama.mjs` | 17 条回放测试（真实录制的 payload） |
| `scripts/check-ollama-live.mjs` | 7 条真机端到端，服务没起就整组 skip |
| `scripts/fixtures/ollama/` | 从运行中的 Ollama 录下的响应，见 `_meta.json` |
| `package.json` | `test:ollama` 进 `npm test`，`test:ollama:live` 单独跑 |

**没有接线**：`OllamaProvider` 还没注册进 `main/index.ts`，也没出现在任何 UI 里。
项目书 Phase C 只要求「能调用、能检测」，接到执行模式是 Phase E。所以这一阶段
不可能影响现有 Web Channel。

## 关于「真实数据」

测试 payload 不是手写样例，是从本机 Ollama 0.33.2 的真实端点录下来的：

```
GET  /api/tags                     → tags.json
GET  /api/ps                       → ps.json
POST /api/show  qwen2.5:7b         → show-qwen.json
POST /api/show  nomic-embed-text   → show-nomic.json
POST /api/chat  stream:false       → chat-once.json
POST /api/chat  stream:true        → chat-stream.ndjson（41 行原始 NDJSON）
POST /api/chat  不存在的模型        → chat-missing-model.json（真 404）
```

`/api/show` 里与判据无关的 `template` / `license` / `modelfile` / `tensors` 在录制后
移除（原本合计 100KB+），`model_info` 和 `capabilities` 保持原值。裁剪说明写在
`_meta.json` 里。

真机链路另有 `npm run test:ollama:live`，全部打到真实服务、真实模型，不进
`npm test`（CI 没有 Ollama）。

## 真实数据逼出来的三个修正

这三处都是先写代码、跑真实数据才发现的，不是照文档推出来的。

### 1. embedding 模型被当成可对话模型

`/api/tags` 返回 2 个模型：`qwen2.5:7b` 和 `nomic-embed-text:latest`。
但后者的 `/api/show` 里 `capabilities` 只有 `["embedding"]`，没有 `completion`。
照项目书「获取已安装模型」直接列出来，界面上就会出现一个选了必然失败的选项。

现在 `listModels()` 逐个问 `/api/show`，只在**明确**是纯 embedding 时排除；
老版本 Ollama 没有 `capabilities` 字段时不排除——不知道就别替用户决定。

顺带读到了真实的上下文长度：`qwen2.context_length = 32768`、
`nomic-bert.context_length = 2048`。两个 key 的架构前缀不同，所以必须按
`.context_length` 后缀匹配，写死任何一个都会在换模型时静默退回默认值。

### 2. 取消只断了「等待」，没断连接

原实现在 `call()` 里创建 controller，fetch 一返回 `Response` 就在 `finally` 里
拆掉 signal 监听。可流式响应这时才刚开始读：用户按「停止」但没 break 迭代时，
`AbortSignal` 传不到 fetch，模型还在算，直到空闲超时才报错。

改成**一个请求一个 controller，从发起到读完由调用方全程持有**：`call()` 只负责
发请求和检查 HTTP 状态，不再拆链路；`tags/ps/show` 这类一次就结束的端点走
`simple()` 自己管短超时。修复后回放测试才钉住了「取消时 fetch 的 signal 必须为
aborted」。

### 3. 超时和取消会赛跑

连接真的断了之后，`reader.read()` 的 rejection 可能比超时错误先到，结果同一个
「等太久」被报成「已取消」。现在超时先把原因标成 `timeout`，再抛错、再断连接，
不管哪条 rejection 先赢都是同一个答案。

## 三层超时

一个 `timeoutMs` 不够：9B 冷加载可能几十秒，用总超时要么误杀冷加载，要么让
真卡死的请求等两分钟。

| 层 | 默认 | 管什么 |
| --- | --- | --- |
| 连接 | 3s | `tags` / `ps` / `show` / `generate` 轻量端点 |
| 首字 | 120s | 从发请求到第一个 NDJSON 块，要给冷加载留时间 |
| 块间隔 | 60s | 流式两块之间最长间隔 |
| 非流式整体 | 180s | `generate()` 的总上限，可被 `request.timeoutMs` 覆盖 |

**已知边界**：`simple()` 的超时只覆盖到拿到响应头，之后的 `json()` 读取没有
超时保护。这些是本地小 JSON，暂不处理，但不宣称「所有阶段都有超时」。

## 真机结果（2026-11-04，qwen2.5:7b / M5 24GB）

| 项 | 实测 |
| --- | --- |
| `health()` | `available: true`，「已安装 2 个模型」 |
| `listModels()` | 只返回 `qwen2.5:7b`，`contextTokens: 32768` |
| `generate()` | 3543ms（含冷加载），`usage: {45, 15}`，答案「17 乘 3 等于 51。」 |
| `stream()` | 首字 157ms，总 1317ms，30 块 / 49 字 |
| 并发闸门 | 两个请求同时发：`{running: 1, queued: 1}`，两个都完成 |
| 模型不存在 | 404 → `model-not-found`，提示 `ollama pull` |
| 服务不可达 | `health()` 返回 `available: false`，`generate()` 抛 `unavailable` |

**取消语义是实测后定的，不是假设**：abort 一个正在流式的长回答之后查
`/api/ps`，该模型的 `expires_at` 停在 `19:53:56.517353` 不再推进；1.2 秒后
复查不变；紧接着发新请求 221ms 就返回（冷加载后的一次生成要 3.5s 量级）。
说明断开连接确实让 Ollama 停下了生成——若服务端还在算上一个请求，Ollama
默认单并发会让新请求排队，不可能 221ms 返回。所以 `capabilities().cancellation` 写
`abort` 而不是 `give-up`。这一点与网页通道相反，两家的能力值不同是对的。
如果换了 Ollama 版本后这个结论不成立，能力值必须跟着改。

## 验收对照（项目书 Phase C）

| 要求 | 状态 | 依据 |
| --- | --- | --- |
| 能识别 Ollama 服务状态 | ✅ | 真机 health + 服务不可达用例 |
| 能获取模型列表 | ✅ | 真实 `/api/tags` + `/api/show`，过滤纯 embedding |
| 能使用本地模型回答问题 | ✅ | 真机 `generate` |
| 能正常接收流式回答 | ✅ | 真机 30 块；回放测三种 TCP 切分方式 |
| 不会因为并发请求造成无限加载 | ✅ | 并发 1 + 30s 排队上限 → `busy` |
| Ollama 不可用时能明确提示 | ✅ | 文案指向 `ollama serve` |

项目书 4.1 的 12 项里，`支持模型运行状态展示`（第 10 项）只做到了
`health().detail` 和 `queue()` 提供数据，**没有 UI**——展示属于 Phase J。
其余 11 项在 Provider 层都有对应实现。`keep_alive` 默认 5m，切模型前会
对别的驻留模型发 `keep_alive: 0`（只在 `maxResident = 1` 时）。

## 测试

```
npm run test:ollama       17 条（回放真实 payload，不依赖服务）
npm run test:ollama:live   7 条（真机，全部通过）
npm run typecheck          干净
npm test                   210 条全绿（原 193 + 新增 17）
```

回放测试里钉住的关键反例：NDJSON 按行 / 整段 / 每 7 字节切三种方式结果一致；
纯 embedding 模型不出现在列表；`nomic-bert.context_length` 也能读到并让
`num_ctx` 取 2048；超时文案区分「第一个字」和「中断」；取消时 fetch 的
signal 必须 aborted；排队超时报 `busy`；切模型前发 `keep_alive: 0`。

## 没做的

- **没有注册进 `main/index.ts`**，也没有任何 UI 入口（Phase E/J）。
- **没有下载 `qwen3.5:9b-q4_K_M`**。代码里的默认 tag 仍按项目书写，
  真机验证用 `defaultModel: 'qwen2.5:7b'` 覆盖，没有把验证用的模型写死进实现。
- **没有做 Web Channel 真机回归**（Phase B 遗留的那一条，仍未补）。
- **没有做 Phase K 的稳定性场景**（Ollama 中途退出、网络中断、应用重启），
  这些要等接线之后才有意义。
