# 来源回答的排版（2026-11-06）

## 问题

用户的原话：「每个源的回答，像网页那样能更清晰的查看。可以整理成 md 风格，或者类似的统一更清晰的查看方式。」「没有 web 页面那么工整，看着不舒服。」

界面上每张来源卡片是一段 `white-space: pre-wrap` 的纯文本。站点页面上的标题、条目、表格、代码块，落到卡片里全变成一大段字——表格尤其糟：一行里塞着三四列，靠 tab 和空格勉强分开。

## 两个原因，一个在抓取、一个在展示

### 1. 抓取：`innerText` 在 flex 布局下不产生换行

`innerText` 只在**块级布局**处插换行。ChatGPT 现在的消息列表是 flex 列，于是整段转录被读成一行：真机实测 `conversationText` 19660 字、**换行数 0**。落盘的回答同样如此（`agent-store.json` 里那条 chatgpt 回答 `nl=0`、`tab=44`）。

排版再好也救不回一段没有换行的文本。

### 2. 抓取：空输入框的回显剔除把换行全删了

转录要减掉自己发的问题，做法是 `rawText.split(composerText).join('')`。`composer` 是 contenteditable，**空着的时候 `innerText` 是一个换行符**，于是 `split("\n").join("")` 把全文换行删干净。

判据改成「输入框里真的有字」（`composerText.trim().length > 0`）之后，同一个页面读出来是 18804 字、341 个换行。

### 3. 展示：只做了 `pre-wrap`

`ChannelGrid` 直接把 `message.text` 放进 div。没有标题、没有列表、没有表格，认不出哪一行是结构。

## 做法

### 抓取端：`structuredText(el)`（`page-driver.ts` 的 `PROBE_SCRIPT` 内）

按标签把 DOM 读成 Markdown：`h1-h6` → `#`，`li` → `- `，`td/th` → `| a | b |`，`pre` → 围栏，`strong/b` → `**`，`blockquote` → `>`，`br` → 换行。

只认标签，不认类名（站点的类名是哈希）。可见性用 `computedStyle` 判一次；`button`/`svg`/`aria-hidden` 跳过，否则每条回答后面会多出「复制 / 好评 / 差评」。

换行是**先记账后落地**的：站点普遍把列表项内容包在段落里（列表项里再套一层段落），边遍历边拼会得到「短横线独占一行、内容在下一行」——Markdown 里那是一个空列表项，渲染出来只剩一个点。

`bestText(el)` 负责取舍：结构遍历只是换一种排法，不该凭空多出或少掉内容。判据是**去掉所有空白后的字数**，低于 `innerText` 的九成就退回原文。用总长度当尺子不行——结构遍历把每层 div 都当块，换行本来就比 `innerText` 多。

只对最后一条气泡做结构遍历：一条会话几十个气泡，每个都走一遍，探测会从 5ms 变成几百毫秒（实测 1295 节点 5ms，探测整轮 21~36ms）。

### ChatGPT 的选择器

新版 DOM 换成了哈希类名，`[data-message-author-role]`、`article .markdown`、`[class*="markdown"]` 三条全部命中 0，于是 `messageCount = 0`，读答案退回「转录尾部 diff」，回答里混进说话人标签和页脚。

补上 `[class*="MarkdownRoot"]`（那个哈希类名的固定前缀）。实测 5 条消息命中 5 个，且只命中回答、不命中提问——用户消息不走 Markdown 渲染。

### 展示端：`shared/markdown.ts` + `MarkdownBody.tsx`

解析是纯函数放在 `shared`（能被 `npm test` 直接跑），组件只负责画。支持：标题、有序/无序列表、表格（三种形状）、代码块、引用、分隔线、加粗、行内代码、链接。

表格三种形状都要认：

| 形状 | 来源 |
| --- | --- |
| `| a | b |` + `|---|---|` | 标准 Markdown |
| 连续 `| a | b |`，行间夹空行，没有分隔行 | 我们自己的 `structuredText` 产物 |
| 行内 tab 分隔，连续两行以上 | Kimi / Gemini 的 `innerText` |

少于两行不算表：一句话里带个竖线只是排版。

表头行不一定有收尾竖线（Kimi 读出来是 `| 对比点  | HTTP  | HTTPS`），也一样认。

## 边界

- **不是完整的 Markdown。** 没有嵌套列表、没有 HTML、没有脚注。认不出的行原样留在段落里，不丢内容。
- **窄卡片里表格要横向滚动。** 表格 `min-width: 360px`，卡片装不下就滚。用 `width: max-content` 会让长句不换行、一张三列的表撑到 550px，更糟。
- **历史数据不变。** 已经落盘的回答仍是旧形状（ChatGPT 那条是一整行），打开旧卡片只能看到现在这版排版对纯文本能做的事。新问一轮才是新结构。
- **综合与辩论不受影响。** Markdown 是纯文本的超集，它们照旧按行/按句读；`normalizeAnswerText` 只多删一条「只剩井号的行」——那是说话人标签被当标题读出来、又被 `cutSpeakerLabels` 切掉后的残渣。

## 验证

真机（ChatGPT / Gemini / Kimi 三家同时答，问题「用表格对比 HTTP 和 HTTPS 的三点区别」）：

- 探测：`msgCount 5 / 10 / 8`，`chosen.assistant` 分别是 `[class*="MarkdownRoot"]`、`model-response`、`.chat-content-item-assistant`；
- 回答：929 字 3 个标题 7 个列表项 12 行表格；Gemini 6 个标题 9 个列表项 4 行表格；Kimi 4 个列表项；
- 界面：三张卡片各有一个表格（`tables: 3`），表头灰底、行列对齐、文字换行；
- 测试：`check-markdown` 12 条；`check-adapter` 62 条；全量 `npm test` 全绿。
