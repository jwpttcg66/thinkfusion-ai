# Web Channel 审计（Phase A）

审计日期 2026-11-04。路径相对 `desktop-agent-macos/`。
这是项目决策 3 明确要求「必须保留」的一条链路，Phase E 之前不要动它。

## 五层，以及每层为什么存在

| 层 | 位置 | 职责 |
| --- | --- | --- |
| `SubAgent` | `src/main/agents/provider-agent.ts:22` | 把网页通道塞进统一的 agent 名单 |
| `BrowserAdapter` | `src/main/adapters/browser/types.ts:68` | 站点无关的接口：`status` / `ask` / `newConversation` / `deleteConversation` / `cancel` |
| `PageBrowserAdapter` | `src/main/adapters/browser/page-adapter.ts:29` | 一次提问的编排：重置 → 填 → 发 → 等 → 取；`ask()` 在 `:100` |
| `PageDriver` / `ChatPageDriver` | `src/main/adapters/browser/page-driver.ts:137` / `:1781` | 具体 DOM 操作、CDP 调用、脚本注入、轮询 |
| `WebContentsView` | `src/main/index.ts:206`（`createElectronDriver`） | 真实网页，每通道一个 `persist:<sourceId>` 分区 |

选择器来自 `src/shared/selectors.ts` 与 `src/main/selector-profile.ts`，
运行时可通过 `page:learn-selectors` 重建（「更新样式」）。

## 一次提问的真实流程

`ChatPageDriver.sendMessage()` 在 `page-driver.ts:2279`：

1. `fill()` `:151` → `FILL_SCRIPT` `:674`：找输入框、填字；
2. `clickSend()` `:152` → `CLICK_SEND_SCRIPT` `:756`：找发送键；有的站点
   输入框为空时没有发送键，用 `composerChars` 区分状态；
3. `waitForAnswer()`：以 `DEFAULT_TUNING.pollMs = 400`（`:1727`、`:1733`）
   轮询 `snapshot()` `:1982`，读 `document.body.innerText` 一次不到 1ms；
4. **快路径**：见过「正在生成」的停止键、它消失、文字未变 → 立刻返回；
   没见过停止键的仍走静止规则（`settleMs`）。这是 2026-11-04 的性能修复，
   把「答案一停就返回」而不是白等三拍；
5. `answerLooksComplete()` `:1650` 判断尾巴是否完整，未完成继续等；
6. `ProviderSubAgent.normalizeAnswer()` `provider-agent.ts:99` 与
   `src/shared/text.ts` 的 `stripChrome()` `:79` / `cutSpeakerLabels()` `:121`
   剥掉侧栏、按钮文案、说话人标签。

`PAGE_CALL_TIMEOUT_MS = 20_000`（`page-driver.ts:1360`）是单次页面调用的上限，
`debugger` 探测另有 2s 超时（`:1442`）。

## 取消与失败态

| 情况 | 表现 |
| --- | --- |
| 页面忙 | `PageBusyError`（`types.ts:110`） |
| 页面不可用 / 未登录 | `PageUnavailableError`（`types.ts:118`） |
| 超时 | 目前靠消息文本识别，没有专门的 `TimeoutError`；`WebChannelProvider.mapError()` 按「超时 / timeout」匹配 |
| 用户取消 | `cancelAll()` 让本地不再等，**页面仍在生成**。所以能力描述是 `cancellation: 'give-up'`，不是 `abort` |

这一条是 Phase B 把 `supportsCancellation: boolean` 改成三态的直接原因：
写成 `true`，上层会以为取消能省配额。

## 删除会话

`ChatPageDriver.deleteConversation()` 在 `:2074`，脚本 `DELETE_CHAT_SCRIPT` 在
`:982`。两遍执行：

1. `locateOnly` 打开抽屉、滚到目标行、回传行中心坐标；
2. 主进程用 CDP `Input.dispatchMouseEvent(mouseMoved)` 把**真实鼠标**移过去，
   再跑删除流程。

:hover 样式无法用合成事件伪造，行内按钮在静止时是 `0×0`，真实 mouseMoved
之后才变成 `28×28`。确认按钮按前缀匹配、排除「取消」，并取命中集合最后一个；
删除成功的证据要求是「找不到该行」连续 ≥1200ms。

`sameThreadAddress()` 只比 pathname，`pageIsEmpty()` 带 `leaving` 参数区分
「已经走了」和「从来没在这」。

## 探测与诊断

`probe()` `:1869`、`getStatus()` `:1875`、`diagnose()` `:1953` →
`PageReport`。`deepseek:diagnose` 这个 IPC 名是历史遗留，实际接收 `sourceId`
查任意通道。`docs/audits/2026-11-04-upgrade-proposal.md` 记过一次硬编码
`planningAdapter()` 导致「标题写 ChatGPT、数字是 planning 页」的故障。

## 没有的东西：网页内容提取

项目书第十章写「当前项目已经实现网页内容提取，本次不重新开发 Fetcher 或
Extractor」，并据此提了分块、段落 ID、原文快照、Prompt Injection 防护等十项
要求。**仓库里没有 Fetcher / Extractor，也没有任何把网页正文作为模型输入的
路径。**

`src/shared/text.ts` 做的只是从**AI 回答文本**里剥掉网页壳（侧栏、按钮、
说话人标签），不是从网页里提取正文。二者方向相反：一个清洗模型输出，
一个准备模型输入。

因此第十章的十项要求目前没有依托对象。已在
`docs/implementation/MULTI_MODEL_UPGRADE_PLAN.md` 里裁决为「暂无输入源」，
等真正有 Fetcher 时再谈防护。这一条不解决，Phase G 的「证据评估」里的
「原文快照」也无从谈起。

## 登录态

每个来源的 `persist:<sourceId>` 分区本身持久，页面里登录一次就一直在。
**不做浏览器 cookie 导入**（用户明确选过「不搬，单独登录」）。页面卡住的
出路是页面栏「刷新」（`page:reload`），不是重开应用。
