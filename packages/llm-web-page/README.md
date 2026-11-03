# @desktop-agent/llm-web-page

把**一个已登录的聊天网页**当作模型通道：驱动页面、等一个可证明是本轮的答复，把回答翻译成标准的流式 chunk。包本身不知道是哪个站点。

**设计借鉴自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT），代码零依赖。** `dependencies` 是空的，`src/` 里没有任何 `@deepseek-ai/*` 的 import。我们采纳的是它的**协议词汇与分层思路**，不是它的包。

这个区别很重要：

- dsh 自称「未来会出现破坏兼容性的变更」，我们不会跟着断。
- 要改一个字段，不需要 fork 一个 232 MB 的 monorepo。
- 形状保持一致，所以将来若要接进别的宿主，写的是**桥接层（十几行）**，不是重写。

## 站点名在哪里

这个包不知道自己在驱动哪个站点，站点名只出现在**真正选了一个站点**的地方——也就是调用方传进来的配置：

| 名字 | 默认值 | 谁决定 |
| --- | --- | --- |
| `provider` | `web-page` | 宿主：这条路由在模型注册表里叫什么 |
| `model` | `default` | 宿主：页面上那个模型对外用什么标签 |
| `pageName` | `web-page` | 宿主：壳把视图注册成了什么名字 |

所以目录、包名、类名都没有站点词：`llm-web-page` / `WebPageAdapter`。站点特有的东西只有两样——选择器画像和 host 白名单——它们在 App 那一侧（`desktop-agent-macos/src/main/adapters/providers/`，一个站点一个文件）。

这条命名规则不是洁癖：通用层一旦带上某个站点的名字，第二个站点接进来时这个名字就开始说谎了。名字说的必须是这个东西是什么，而不是它第一次被用在哪儿。

## 它做什么

统一契约是「把某家的 wire 格式翻译成统一词汇」。这里的 wire 格式不是 HTTP，而是一个**已登录的聊天页面**：

```
GenerateOptions ──▶ 拍平成一段网页提示词 ──▶ 提交
                                              │
                                              ▼
                              等「可证明是本轮」的回答
                                              │
                                              ▼
             解析 JSON ──▶ block-start / deltas / block-end / finish
```

| 文件 | 职责 | 为什么单独存在 |
| --- | --- | --- |
| `protocol.ts` | 协议词汇：块类型、chunk、失败、`LlmAdapter` | 借鉴来的设计落地为**我们自己的类型**，不 import 任何外部包 |
| `host.ts` | 宿主契约（注册表 + 日志） | 三个成员宽；换宿主是桥接，不是依赖 |
| `llm-registry.ts` | 注册表与派发实现 | 让整层自洽可跑，不需要框架 |
| `adapter.ts` | 实现 `stream()` | 只做编排，不含 DOM、不含解析 |
| `transport.ts` | 判定哪段文本才是本轮回答 | 唯一会「静默出错」的地方，必须单独测 |
| `parse.ts` | 从回答里取出回复对象 | 网页模型的包裹方式每次都不一样 |
| `chunks.ts` | 生成协议合法的 chunk 序列 | 顺序不变量集中在一处 |
| `prompt.ts` | 把结构化请求拍平成一段文本 | 网页没有 system 槽、没有工具通道 |
| `page.ts` | `WebPage` 接口 | 让传输层不依赖 Electron，可测 |
| `registry.ts` | 壳与插件交接页面的地方 | 活对象传不进配置，只能注册 |

## 安装与验证

```bash
cd packages/llm-web-page
npm install         # 只装 typescript 和 @types/node
npm run typecheck
npm test            # 69 项行为测试
node examples/mount.mjs   # 两轮对话：一次工具调用 + 一次总结
```

## 怎么用

```ts
import { InMemoryLlmRegistry, apply, registerPage, unregisterPage } from '@desktop-agent/llm-web-page'

const registry = new InMemoryLlmRegistry()

// 站点名只出现在调用方：路由、模型标签、页面注册名，三件事都由宿主给。
registerPage('deepseek-web', viewPage)      // 见下
apply({ llm: registry }, {
  provider: 'deepseek-web',
  model: 'deepseek-chat',
  pageName: 'deepseek-web',
  pollMs: 250,        // 轮询间隔
  settleMs: 1200,     // 两次一致需保持多久
  timeoutMs: 600000,  // 单轮上限
})

for await (const chunk of registry.stream({ provider: 'deepseek-web', model: 'deepseek-chat', messages })) {
  // block-start / text-delta / tool-call-delta / block-end / finish
}
```

三个名字都不传，得到的就是一条还没起名字的网页通道（`web-page` / `default` / `web-page`）——能跑，只是它在注册表里叫什么由默认值决定，而不是由你决定。

`apply()` 只依赖 `{ llm: { registerAdapter } }` 这一个方法。若宿主已有自己的注册表，包一层适配即可，不需要装任何东西。

### 壳怎么把页面交进来

页面是活的 Electron 对象，配置传不了。视图创建后注册一次：

```ts
const page: WebPage = {
  async probe() { /* 执行探针脚本 → { messageCount, lastText, generating, ready } */ },
  async send(prompt) { /* 填 composer、点发送 */ },
  async stop() { /* 点停止生成 */ },
}
registerPage('deepseek-web', page)
// 视图销毁时
unregisterPage('deepseek-web')
```

**按请求查找，不在 `apply()` 时捕获**：插件可能先于视图挂载，捕获到 `undefined` 就会永久失败。现在没页面时请求以 `NO_PAGE` 干净失败，视图就绪后自动恢复。

## 协议翻译

| 网页回答 | 产出的块 | `finish.reason` |
| --- | --- | --- |
| `{"text":"…"}` | `text` | `{ kind: 'stop' }` |
| `{"calls":[{"name":"read","arguments":{…}}]}` | 每个调用一个 `tool-call` | `{ kind: 'tool-calls' }` |
| `{"text":"…","calls":[…]}` | `text` + 若干 `tool-call` | `{ kind: 'tool-calls' }` |
| 散文、无回复对象 | 无 | `{ kind: 'error', failure: { code: 'PROTOCOL' } }` |

工具块的 `blockType` 是 `'tool-call'`；`block-end` 的 `block.arguments` 是**原始 JSON 字符串**，与 `argumentsDelta` 逐字节一致——装配器要靠这个比对。

## 归属判定：这里最危险

网页聊天没有请求 id，只有一串不断增长的渲染消息。如果传输层直接返回「最后一条消息」，慢页面就会把**上一轮**的回答交给 agent，而 agent 会照着它去执行工具。

规则是：发送前快照 → 消息数必须增长 → 生成必须停止 → 连续两次轮询文本一致。四条同时满足才算回答。

失败码全部落在 `finish.failure.code`（同时挂在 `LlmError.code` 上），调用方按码路由，不读文案：

| 码 | 含义 |
| --- | --- |
| `NO_PAGE` | 壳还没注册页面 |
| `NOT_READY` | 未登录，或 composer 不在 |
| `SEND_FAILED` | 提交动作抛错 |
| `PAGE_ERROR` | 读页面抛错（视图已销毁、中途导航） |
| `NO_ANSWER` | 页面没渲染出新消息 |
| `TIMEOUT` | 新消息一直没稳定下来，或超过上限 |
| `PROTOCOL` | 回答里没有合法的回复对象 |
| `NO_ADAPTER` | 注册表里没有这个 provider 路由 |

## 已知限制

- **不发 `usage`**。网页不暴露 token 计量，编数字会污染计量器，不如让它保持未知。
- **不是真流式**。页面一次吐完整回答，`text-delta` 只能整段发，`tool-call-delta` 同理，所以看不到逐字输出。
- **DOM 选择器未验证**。本仓库只定义 `WebPage` 接口并测了它的契约；把选择器接到 `WebContentsView` 上属于下一步，必须在真实登录态下核对。
- **只有一个模型**。`listModels` 返回配置里那一个 id；页面实际用哪个模型由账号设置决定，无法枚举也无法切换。
- **未知工具名不做过滤**。解析层只看结构不看清单——工具是否允许由宿主的工具层判定，重复实现会误杀后来新增的工具。

## 相关文档

- `desktop-agent-macos/docs/HARNESS_BASELINE.md` — 调研结论、模块映射、借鉴边界
- `desktop-agent-macos/spike/plan-to-chunks.mjs` — 驱动真实适配器跑一遍协议断言
