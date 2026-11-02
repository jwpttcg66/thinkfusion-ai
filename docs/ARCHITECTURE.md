# 技术架构

产品定位见 [PRODUCT.md](PRODUCT.md)。这份文档只回答一个问题：**要让那个定位成立，代码该怎么切。**

一句话结论：

> 把「通道」「编排」「综合」「执行」四件事从当前的一个循环里拆开，让 `desktop-agent/v1` 从"全局协议"降级为"只有本地执行时才用的协议"。

---

## 1. 定位转变对架构的三个硬要求

| 要求 | 现状 | 冲突点 |
| --- | --- | --- |
| 普通问题不能要求生成 JSON 计划 | 每个任务都走 `buildInitialPrompt`，开头就是「你是本地 ThinkFusion 的任务规划引擎……输出执行计划」 | `src/shared/protocol.ts:381` |
| 一个通道失败不能拖垮整条链路 | `AgentOrchestrator` 一个循环同时负责发问、解析、审批、执行、回传 | `src/main/orchestrator.ts:37` |
| 增加第二个 AI 不需要改主流程 | `DeepSeekAdapter` 是唯一通道，892 行里混了选择器、探测、发送、归属判断 | `src/main/deepseek-adapter.ts` |

三条都指向同一个动作：**先定义通道接口，再谈编排。**

---

## 2. 五层与代码的映射

| 层 | 职责 | 现有代码 | 目标 | 动作 |
| --- | --- | --- | --- | --- |
| **1. User Interaction** | 输入、进度、对话呈现 | `App.tsx`、`SourceRail.tsx`、`TaskInput.tsx` | 同左 + `ConversationView` | 扩展 |
| **2. Intent & Task Orchestrator** | 判定任务类型、选流程 | 无。所有输入都被当成计划任务 | `IntentRouter` + `ConversationRunner` | **新建** |
| **3. AI Collaboration Engine** | 分头发问、收集、比较、追问 | 无。只有一个通道，一轮一问 | `AiChannel` 接口 + `CollaborationEngine` | **新建** |
| **4. Tool & Execution Runtime** | 工具、权限、复验 | `src/agent/*`、`agent-manager.ts` | 保留原样 | **收敛为按需** |
| **5. Knowledge & Synthesis** | 观点、证据、分歧、索引 | 无。只有 `AgentStore` 的事件流 | `SynthesisStore` + `Synthesizer` | **新建** |

第 2、3、5 层目前是空的。这不是"待优化"，是产品定位没落地。

### 2.1 第 2 层：意图路由

```ts
export type Intent =
  | { kind: 'answer'; question: string }          // 问答
  | { kind: 'research'; question: string }        // 多来源研究
  | { kind: 'compare'; question: string }         // 多 AI 观点比较
  | { kind: 'extract'; url: string }              // 网页提取
  | { kind: 'workspace'; goal: string; workspaceRoot: string }; // 本地执行
```

判定顺序（**规则优先，模型兜底**）：

1. 用户显式声明（"改一下这个文件"）→ `workspace`
2. 附带了 URL 且要求整理/总结 → `extract`
3. 出现工作区路径、文件路径、明确的动词（改、写、删、跑）→ `workspace`
4. 出现"比较 / 哪个更好 / 分别" → `compare`
5. 其余 → `answer`

只有 `workspace` 进入第 4 层。默认分支必须是 `answer`——**默认走执行是当前所有错位的第一因。**

路由结果要落进事件流，用户可回看"系统把这次当成了什么"。

### 2.2 第 3 层：通道接口

这是整个重构的支点。所有 AI 接入（网页版 DeepSeek、ChatGPT、将来的 API 通道）实现同一个接口：

```ts
export interface AiChannel {
  readonly id: string;
  readonly label: string;

  /** 现在能不能用：登录态、页面就绪、是否正在生成。 */
  status(): Promise<ChannelStatus>;

  /** 发一句话，拿回一段话。 */
  ask(input: AskInput): Promise<ChannelAnswer>;
}

export interface AskInput {
  /** 用户的原话，或据此派生的一句追问。不是重写过的任务规格。 */
  question: string;
  /** 同一会话里更早的轮次，旧的在前。 */
  history?: readonly Turn[];
  /** 这次提问的目的，只影响编排，不影响线格式。 */
  stage: 'initial' | 'followup' | 'challenge' | 'synthesis';
}

export interface ChannelAnswer {
  text: string;
  /** 这一段是怎么被认定为"本轮回答"的，排障用。 */
  attribution: Attribution;
  receivedAt: number;
}
```

两个刻意的设计：

1. **`ask()` 只返回 `text`。** 没有 `data`、没有 `payload`、没有 `structured`。类型系统层面禁止"让通道吐 JSON"，因为那正是现在所有问题的源头。
2. **通道不知道协议存在。** 需要 JSON 的场景由调用方在 `question` 后面追加协议后缀，通道照常发、照常取回文本。

现在的 `DeepSeekAdapter` 按这个接口拆成三块：

| 拆分后 | 内容 | 依据 |
| --- | --- | --- |
| `channels/web-page/` | 选择器、probe、发送、`waitForAnswer`、回声剥离、回答归属 | `deepseek-adapter.ts` 现有全部 |
| `channels/registry.ts` | 按 id 注册、并发队列、健康状态 | 新建 |
| `channels/status.ts` | `ChannelStatus` 投影（上层只看得到这个） | 新建 |

上层永远拿不到 DOM 选择器，也拿不到 `WebContentsView`。站点改版只影响 `channels/web-page/`。

#### 回答归属：两条路，一条兜底

站点不可能永远给出可靠的选择器。实测 chatgpt.com 现版已经**没有任何消息语义属性**（`data-message-author-role`、`article`、`.markdown` 全部为 0，只剩构建哈希类名），所以归属必须有两套：

| 路径 | 触发 | 依据 |
| --- | --- | --- |
| 气泡增量 | `probe.messageCount` 增长 | 页面自己暴露了助手消息，取最新一条 |
| 文本增量 | 选择器全灭 | 快照与当前文本的公共前缀之后的部分，去掉回声 |

**第二条不是兜底，是某些站点的唯一路径。** 它曾经要求文本里出现协议标记（当时每个提示词都带），重建后提示词不再带协议，这条分支就永远不可达了——页面上回答早就写完，程序还在等到超时。教训是：**兜底路径的判据不能依赖提示词的内容**，否则改提示词就会静默地废掉一条链路。现在的判据是「长度 + 三轮稳定 + 清洗后非空」。

#### 前置条件：页面必须有视口

探针的所有判断都以 `getBoundingClientRect()` 为基础——输入框要够宽、消息气泡要可见。这条链上有一个不在代码里的假设：**页面得有视口**。

隐藏的 `WebContentsView` 视口是 `0×0`。视口为 0 时页面上每个元素都量出 0 宽，于是"输入框不存在"、"回答不存在"，而页面本身完全正常。症状是通道状态显示「未找到输入框，页面结构可能已变化」，多通道静默退化成单通道；更麻烦的是它不会自愈——用户没点过那个来源，它就永远不可用。

所以有一条硬约束：**每个视图在第一次被提问之前，必须至少被赋过一次真实尺寸**。现在的做法是启动时先建好所有视图，在窗口 `show()` 之前统一给一次尺寸（`primeViewports`），再显示窗口、再加载网页。视口一旦拿到，隐藏后仍然保留。

两个走不通的做法记在这里：把停靠页放到窗口外（Chromium 不给窗口外的视图布局，仍是 0×0）；让所有页面占同一个矩形、靠层级盖住（视口有了，但原生缩放从此只生效一次）。

对应地，探针要如实报告视口尺寸（`viewportWidth/Height`）。把 0×0 报成"结构可能已变化"曾把排查引向错误方向。

#### 页面自己的那条栏，和「更新样式」

页面是原生视图，**画在文档之上**。这条事实决定了四件事的写法：

| 想做的事 | 直觉做法 | 实际做法 |
| --- | --- | --- |
| 在页面上方加一条状态栏 | 在页面区域加一个 `div` | `div` 会被视图盖住。必须由主进程把视图下移 `PAGE_HEADER_HEIGHT`，栏才能画在露出来的那条带子里 |
| 让某个页面变大、单独用 | 改分栏比例 | 分栏最大也只能切一半。真正的"放大"是把视图**重新挂到另一个窗口**：`removeChildView` → `addChildView`。同一个 `webContents`，所以登录、滚动位置、正在写的回答都还在 |
| 吸附回来 | 单独写一条恢复路径 | 独立窗口的关闭按钮、Cmd+W、窗口里的「吸附回去」都落到同一个 `closed` 事件。只有一条路径，就没有"两条路径不一致"这种 bug |
| 把网页那一格收起来 | 把分栏宽度设成 0 | 0 会让应用列钻到右侧轨道下面，按钮就被画在输入框上了。而且**折叠不是"分栏变小"**，是"不画了"：折叠时视图照旧占着原来那个盒子，只是被停到窗口外并且 `setVisible(false)` |

最后一条值得单独写下来，因为把两件事混在一起会有很贵的后果。`primeViewports` 给每个视图的那个视口是**通道能不能回答问题的前提**——一个被塞进 0 宽矩形的视图会失去视口，页面里每个元素都量出 0，探针就会对一个完全健康的页面说"找不到输入框"。所以折叠走的是和"切换来源"完全相同的分支（停到窗口外、保留盒子、停止绘制），而不是一条新的几何路径。`check:pane` 直接断言这件事：折叠后视图的 `width` 和页面自己的 `innerWidth` 都必须**和折叠前一模一样**。

折叠后留下的 `PAGE_STUB_WIDTH` 那条窄缝也不是装饰。收起按钮长在页面栏里，而页面栏就在那一格里——折掉整格，按钮就跟着没了，用户没有任何回去的入口。窄缝是那个入口，也是"页面还活着"的唯一提示。

分离时主窗口那一格必须换成说明卡。空着和"页面崩了"在像素上完全一样，而这两种情况用户要做的事完全不同。

**「更新样式」不是"重新加载页面"。** 它是三段：

1. `DISCOVER_SCRIPT` 在页面里重建选择器。规则是"属性优先、类名兜底"——`data-testid`、`aria-label`、`name`、`id` 能活过改版，`.css-1x2y3z` 活不过。看起来像构建哈希的类名直接跳过。
2. 用**真实探针**验证：把候选合并进 profile 再跑一次 `PROBE_SCRIPT`，只有 `hasInput` / `hasSendButton` / `messageCount` 确实变好才算数。
3. 只把验证通过的那几项写进 `userData/selector-profile.json`，按 **source + host** 存。登录页和聊天页是两个 host，互不污染。

合并方向是**追加**而不是前置（`mergeProfile`）：内置选择器永远先试，学习来的只在它们全灭时才有机会。这条规则是"修复不会把本来正常的页面改坏"的全部保证。

四个坑，都是实测踩的：

- **`innerText` 和 `getBoundingClientRect()` 会强制同步布局。** `[class*="message"]` 在真实聊天页能命中上千个节点，逐节点读这两个属性不是慢，是**冻结窗口**——表现和"应用卡死"一模一样，第一次跑「更新样式」就是 90 秒不返回。批量扫描改用 `checkVisibility()` + `textContent`，只留最后 400 个候选，只对胜出的一组量一次。
- **冷启动时页面还在加载。** 三段脚本对着半成品 DOM 跑，既慢又必然得出错误结论。现在 `webContents.isLoading()` 就直接返回"还在加载"，另外给 `executeJavaScript` 套了 8 秒超时——没有超时的按钮，就是这个项目反复要道歉的那种卡死。
- **"回答区域没找到"在空对话里是误报。** 空对话本来就没有回答可以校准。文案要分开说：输入框和发送键正常，回答区域等一条回答再校准。
- **重新挂载后视口可能不更新。** 视图换了父节点，原生框跟着 `setBounds` 走，里面的 document 却可能停在旧视口——从 1248px 的独立窗口回到 599px 的格子里，页面仍然按 1248 排版。它不会自愈，因为之后每次 `setBounds` 推的都是同样的数字，Chromium 看不出变化。修法是最便宜的那种"制造一次真实变化"：挂回后先按目标宽度减 1px 设一次，32ms 后再设回目标值。

#### 页面文本 → 应用文本，只有一个边界

`shared/text.ts` 是唯一允许"页面长什么样"和"答案是什么"不同的地方，四件事：

1. `cutSpeakerLabels`：按页面自己的 `你说：/ChatGPT 说：` 标签切到助手标签之后——提示词被页面重排后精确 echo 匹配会失效，标签才是页面自己画的边界。
2. `stripEcho`：去掉我们自己的问题。
3. `stripChrome`：站点文案（免责声明、升级横幅）按整行名单删、按短语删；**不动缩进**，否则代码块会被拍平。
4. `normalizeAnswerText`：引用角标是内联 chip，`innerText` 会让它变成「短横线 + 数字」竖排，成对删除；编号列表是另一种形状，不受影响。

这四步只做一次，就在 `waitForAnswer` 返回之前。之后无论是气泡、综合还是落盘，拿到的都是同一份干净文本。

### 2.3 第 5 层：综合

输入是 N 个 `ChannelAnswer`，输出是结构化的 `Synthesis`：

```ts
export interface Synthesis {
  consensus: Claim[];      // 多数通道一致，且各自给了依据
  disputed: Dispute[];     // 有冲突：谁说了什么，分歧点在哪一句
  unique: Claim[];         // 只有一个通道提到，可能是增量，也可能是幻觉
  gaps: Gap[];             // 没有任何通道覆盖的角度
  overlap: string[];       // 每个通道都谈到的主题词——"值得对比"的证据
  recommendation: string;  // 结论，必须能追到上面的条目
}
```

实现顺序很重要：

1. **规则版先上。** 句子切分 + 关键实体对齐 + 否定词检测，够用且可解释。
2. **模型归纳后上。** 用一个通道当 judge，但它的输入是已经标注好的候选观点，不是原始长文——否则又变成"把 N 个回答压缩一次"。
3. **抽取失败必须降级。** 降级形态是"原文并列 + 标注未能结构化"，流程继续走。不允许因为结构化失败而中断一次研究。

#### 三条判据，只有一条是"一致"

整句 bigram 的 Jaccard 对中文长句天然偏低：两句共享 8 个 bigram，各自有 20 多个，分母一撑就只剩 0.22。两个通道明明都在讲「连接池 / 数据库上限 / 80%」，规则版却报"几乎没有重合"——**这是代码在说假话，不是阈值没调好**。把阈值降到 0.2 能救这一对，也会把无关的句子配成一对。

所以一致不再只由句子相似度决定，而是三条互不干扰的判据：

| 判据 | 能证明什么 | 为什么可信 |
| --- | --- | --- |
| 整句相似度 ≥ 0.34 | 两句话说同一件事 | 可直接对照原句 |
| **同一个数字** | 两个通道给出同一个量 | `80%` 能打开两边核对；且两句还得共享主题词，否则"都提到 2024 年"也会被当成共识 |
| **共同主题词** | 两边在讲同一件事，但没一句话对得上 | 只能证明"可比"，不能证明"一致"，所以它只进 `overlap`，不进 `consensus` |

`overlap` 的取词有个坑：不能把所有子串都当候选。真实一次回答里它吐出了 `连接数持续 / 连接池 / 池配置 / 置过大 / 导致 / 创建`，六个里只有一个是真的。`置过大` 是「池配置」和「设置」两个不同词的尾巴，`连接数持续` 横跨词边界。修法是要求短语**从词边界开始**（标点后，或常见虚词/动词之后），并且**动词不能做开头**——`导致` 后面接宾语是句子结构，不是主题。

边界表里刻意不含 `配`、`设`：它们正是把 `置过大` 放回来的那两个字符。

---

## 3. 三套协议

| 协议 | 谁跟谁 | 载体 | 要求模型输出 JSON |
| --- | --- | --- | --- |
| `thinkfusion/conversation/v1` | 渲染进程 ↔ 主进程 | IPC 事件流 | **否** |
| `thinkfusion/research/v1` | 系统内部（观点 / 证据 / 分歧） | 本地存储 + 事件 | **否**，由系统抽取 |
| `desktop-agent/v1` | 应用 → 模型 → Runtime | 渲染后 markdown 里的 JSON | **是**，且仅此一处 |

### 3.1 `thinkfusion/conversation/v1`

就是 IPC 契约，描述一次对话里发生了什么：

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `conversation.started` | `{ conversationId, intent }` | 路由结果在这里落地 |
| `user.message` | `{ conversationId, text }` | 用户原话，不改写 |
| `channel.asked` | `{ conversationId, channelId, question }` | 便于回看"到底问了什么" |
| `channel.answered` | `{ conversationId, channelId, text, attribution }` | 一段文本，没有结构 |
| `stage.changed` | `{ conversationId, stage }` | thinking / collecting / comparing / synthesizing |
| `question.asked` | `{ conversationId, questions }` | 信息不足，交回用户 |
| `synthesis.ready` | `{ conversationId, synthesis }` | 见 `research/v1` |

关键：**这套协议里没有任何"计划""审批""执行"的概念。** 问答链路不经过 Runtime。

### 3.2 `thinkfusion/research/v1`

这是 `Synthesis` 的持久化形态，`Claim` 至少包含：

```ts
export interface Claim {
  text: string;
  /** 哪几个通道说过，按支持度排序。 */
  sources: Array<{ channelId: string; turnId: string }>;
  /** 原话里的依据片段；空数组表示这是一句断言，没有依据。 */
  evidence: string[];
}
```

`Dispute` 额外带 `positions: Array<{ channelId; stance }>` 和 `pivot`（分歧具体落在哪一句）。

再次强调：这套结构由系统产出，**不要求任何模型按它输出**。

### 3.3 `desktop-agent/v1`

**保持不变。** 现有的解析、回声剥离、id 回填校验、`clarification_required` / `task_complete` 全部保留，见 [PROTOCOL.md](../desktop-agent-macos/docs/PROTOCOL.md)。

唯一变化是**触发条件**：只有 `intent.kind === 'workspace'` 时，`Executor` 才会在问题后追加协议后缀。其余场景这段协议文本根本不会出现在对话里。

---

## 4. 两条主链路

### 4.1 问答 / 研究链路（不碰 Runtime）

```
用户输入
  → IntentRouter           判定 answer / research / compare / extract
  → CollaborationEngine    拆问题，分发给 N 个通道（并行，每通道独立队列）
  → 收集 ChannelAnswer[]   文本，可能伴随归属失败重试
  → Synthesizer            规则抽取 → consensus / disputed / unique / gaps
  → conversation 事件流     渲染成对话 + 左侧协作进度
```

没有计划、没有审批、没有文件系统。

### 4.2 工作区任务链路（进入 Runtime）

```
用户输入
  → IntentRouter           判定 workspace
  → Executor               用同一个通道 ask(goal + desktop-agent/v1 后缀)
  → 解析计划 → 人审批 → UtilityProcess 执行 → 执行报告回传 → 下一轮
```

两条链路**共用通道与事件日志**，但只有第二条进入 `src/agent/*`。

---

## 5. 状态机

现在只有一套（计划-执行），需要两套。

### 5.1 会话状态机（新建）

```
draft ──route──► thinking ──► collecting ──► comparing ──► synthesizing ──► answered
                    │             │              │
                    └─────────────┴──────────────┴──► awaiting_user ──► thinking
                                                        （澄清/追问）
任意状态 ──► failed / cancelled
```

`answered` 不是终点：用户追问会回到 `thinking`，并把已有 `Synthesis` 作为上下文带入。

### 5.2 执行状态机（保留）

`created → planning → awaiting_clarification → plan_ready → awaiting_approval → executing → verifying → report_pending → awaiting_next_round → completed`

这套状态机、它的守卫、以及 `TaskManager` 的 `TERMINAL` 集合都不动。它只是不再服务所有任务。

---

## 6. 并发模型

现在的 `pageQueue` 是**全局单页面串行**（`orchestrator.ts:50`），原因是"一个页面只有一个写者"。这个判断在多通道场景下要变成：

```
每个通道一条队列（同一页面仍然只能有一个写者）
+ 全局并发上限（默认 3，可配）
```

上限存在的原因不是正确性，是资源：每个通道是一个 `WebContentsView`，各占一份渲染进程内存。同时开 6 个网页版 AI，机器会先撑不住。

队列满时**不排队等待**，直接返回 `ChannelBusy`，由编排层决定是跳过该通道还是稍后重试——排队的任务在用户眼里就是"卡住了"。

---

## 7. 保留与解耦清单

### 7.1 原样保留

| 模块 | 理由 |
| --- | --- |
| `src/agent/`（UtilityProcess、`policy.ts`、`tools/filesystem.ts`、`verify.ts`） | 权限、路径校验、sha256 复验是产品底线，不因重构放宽 |
| 权限预设与 30 分钟授权 TTL | 同上 |
| `AgentStore` 事件日志 | 回放与追溯的地基 |
| `layout.ts` + 来源栏 + 三个导航钩子 | 原生视图几何与白名单，已经踩平 |
| `stripEcho` / `repairJson` / `extractJsonBlocks` | 转为 `desktop-agent/v1` 专用工具，逻辑不变 |

### 7.2 解耦

| 现在 | 问题 | 改成 |
| --- | --- | --- |
| `buildInitialPrompt` 无条件注入计划协议 | 每个任务都被迫变成计划任务 | `buildRolePrompt`（稳定角色）+ `buildStagePrompt`（本轮动态内容）+ `buildPlanSuffix`（仅执行链路） |
| `AgentOrchestrator` 409 行，五件事混在一起 | 改一处牵全身 | `IntentRouter` / `ConversationRunner` / `Executor` 三个类 |
| `DeepSeekAdapter` 892 行 | 加第二个 AI 要复制一遍 | 按 `AiChannel` 拆分 |
| `pageQueue` 全局串行 | 多通道互相阻塞 | 每通道队列 + 全局并发上限 |

---

## 8. 迁移步骤

每一步都能独立发布、独立回滚，不做"大爆炸重写"。

| 步骤 | 内容 | 行为变化 | 验收 |
| --- | --- | --- | --- |
| **M1** | 抽出 `AiChannel` 接口，`DeepSeekAdapter` 实现它，行为不变 | 无 | 现有 59 项实机检查全绿 |
| **M2** | 引入 `IntentRouter`，`answer` 分支先只做一件事：**不注入计划提示词**，直接把用户原话发出去并展示回答 | 问答不再产出计划 | 问一个知识问题，回答里没有 JSON |
| **M3** | `ConversationRunner` + 右侧对话流 UI，来源栏保留为"看原始页面" | 右侧从网页视图变成对话视图 | 能连续追问两轮，上下文不断 |
| **M4** | 接入第二个通道（ChatGPT），per-channel 队列 | 可并行收集 | 两个通道同时提问互不干扰 |
| **M5** | `Synthesizer` 规则版 | 出现"分歧/缺失"标注 | 输出里至少一处明确分歧 |
| **M6** | `Executor` 收敛：只有 `workspace` 意图进入 | 计划与审批变稀有 | 关掉 Runtime，问答与研究仍可用 |

M6 的验收就是 [PRODUCT.md](PRODUCT.md) 第 7 节最后一条：**拔掉 Runtime 不影响核心产品。**

---

## 9. 风险与反面模式

| 风险 | 具体形态 | 对策 |
| --- | --- | --- |
| **逼模型吐 JSON 复发** | 给 `research/v1` 也定义一套模型输出格式，换个名字回到老路 | `AiChannel.ask()` 的返回类型里只有 `string`；结构化只在应用侧发生 |
| **综合退化成压缩** | 把 N 个回答拼给一个模型"总结一下" | `Synthesis` 必须包含 `disputed` 与 `gaps`，缺任一项视为未完成综合 |
| **多页面资源爆炸** | 同时开 6 个网页版 AI | 全局并发上限 + 队列满即返回 `ChannelBusy` |
| **回答归属失效** | 多通道下把 A 的回答当成 B 的 | 归属逻辑留在各通道内部，`attribution` 随答案一起返回，可回查 |
| **站点改版** | 选择器失效，整条链路静默变空 | 全部收在 `channels/web-page/`；`ChannelStatus` 暴露 `probeVersion` 与命中选择器 |
| **旧任务数据** | 迁移后历史任务无法回看 | `AgentStore` 只读兼容，旧任务标记 `legacy`，不尝试续跑 |

---

## 10. 与现有文档的关系

| 文档 | 定位变化 |
| --- | --- |
| [PROTOCOL.md](../desktop-agent-macos/docs/PROTOCOL.md) | 从"系统通信协议"降级为"三协议之一：本地执行协议"。内容不变，适用范围收窄 |
| [IPC.md](../desktop-agent-macos/docs/IPC.md) | 继续描述主进程与渲染进程的通道；`conversation/v1` 落地后在这里补事件表 |
| [SECURITY.md](../desktop-agent-macos/SECURITY.md) | 不变。安全边界只收紧，不放松 |
