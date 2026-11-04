# 技术架构

产品定位见 [PRODUCT.md](PRODUCT.md)。这份文档只回答一个问题：**要让那个定位成立，代码该怎么切。**

一句话结论：

> 把「参与者」「编排」「综合」「执行」四件事从原来的一个循环里拆开，让 `desktop-agent/v1` 从"全局协议"降级为"只有本地执行时才用的协议"。

三个词指的是同一件事的不同侧面，本文混着用，这里先说清：**参与者 = agent = 通道**。`SubAgent` 是类型名，agent 是口语，`channelId` 是消息与事件里的字段名。字段没跟着改名，是因为它已经写进了落盘的消息和 IPC 契约——改一次要迁一次数据，而收益只是整齐。

---

## 1. 定位转变对架构的三个硬要求

这三条是这份文档的出发点。写下来的时候它们都还没兑现，现在都兑现了——所以第三列不是「打算」，是「现在长什么样」。

| 要求 | 原来 | 现在 |
| --- | --- | --- |
| 普通问题不能要求生成 JSON 计划 | 每个任务都走 `buildInitialPrompt`，开头就是「你是本地 ThinkFusion 的任务规划引擎……输出执行计划」（`shared/protocol.ts`） | 问答 / 研究把用户原话原样发给每个已开启通道（`master-agent.ts`），不拼任何固定提示词；`desktop-agent/v1` 只在 `workspace` 意图下使用 |
| 一个通道失败不能拖垮整条链路 | `AgentOrchestrator` 一个循环同时负责发问、解析、审批、执行、回传 | 问答链路里失败按 agent 记账（`failures[]`），一个失败不中止其他，原因写进那一轮；执行链路仍是单循环 |
| 增加第二个 AI 不需要改主流程 | 只有一个 `DeepSeekAdapter`，1338 行里混了选择器、探测、发送、归属判断 | `ChatPageDriver`（无站点常量）+ `adapters/providers/`（一个站点一个文件），装配处只有一个 `profileFor(sourceId)` |

三条都指向同一个动作：**先定义接口，再谈编排。** 兑现的方式见第 2 节。

---

## 2. 五层与代码的映射

| 层 | 职责 | 现有代码 | 动作 |
| --- | --- | --- | --- |
| **1. User Interaction** | 输入、进度、对话呈现 | `App.tsx`、`SourceRail.tsx`、`TaskInput.tsx`、`ConversationView.tsx` | ✅ 已落地 |
| **2. Intent & Task Orchestrator** | 判定任务类型、选流程 | `shared/intent.ts`（纯函数）+ `ConversationRunner` | ✅ 已落地 |
| **3. AI Collaboration Engine** | 分头发问、收集、比较 | `MasterAgent` + `SubAgentRegistry` + `ProviderSubAgent` + `BrowserAdapter` | ✅ 已落地（辩论轮未做，见 2.2 末） |
| **4. Tool & Execution Runtime** | 工具、权限、复验 | `src/agent/*`、`agent-manager.ts`、`orchestrator.ts` | ✅ 收敛为按需（只有 `workspace` 进来） |
| **5. Knowledge & Synthesis** | 观点、证据、分歧、索引 | `shared/synthesizer.ts`（规则式，已接进链路） | 部分落地；目标形态见第 11 节 |

第 1–4 层已经落地，第 5 层只做了「把几段回答比成共识 / 分歧 / 缺口」这一步：`Claim.evidence` 能指回原话片段，但**证据索引**（按主题跨会话检索「这句话以前是谁说的」）和跨会话的知识沉淀都还没有。这两件事不做，`research/v1` 就只是「一次问答的产物格式」，不是知识库。

**这一层的目标形态单独写在第 11 节**：从「比较句子」变成「维护论证结构」，产物从 `consensus` / `disputed` 变成 Claim 图、证据强度和条件化结论。第 11 节标了每一块的现状，没做的部分不在这里假装做了。

### 2.1 第 2 层：意图路由

```ts
export type IntentKind = 'answer' | 'research' | 'compare' | 'extract' | 'workspace';

export interface Intent {
  kind: IntentKind;
  /** 为什么是这一类——界面上显示成「路由依据」，让判断可被质疑。 */
  reason: string;
  /** 只有 extract 有：用户指的那个链接。 */
  url?: string;
}

export function classifyIntent(text: string): Intent
```

判定顺序（**全是规则，没有模型兜底**）：

1. 改动动词 **且** 文件线索 → `workspace`
2. 带链接 **且** 整理/总结类动词 → `extract`
3. 比较类词（比较 / 对比 / 区别 / 哪个更好 / vs）→ `compare`
4. 研究类词（研究 / 排查 / 原因 / 为什么 / 原理 / 最佳实践）→ `research`
5. 其余 → `answer`

两个「且」是重点，它们各自修掉一种误判：

- **改动动词必须配上文件线索。** 「帮我分析这段代码」有一个看起来像文件的词，但没有动词，它是个问题；「帮我改这个文件」两者都有，不能变成一次研究。
- **单独一个链接不是 `extract`。** 光贴一个 URL 是在问「这个页面讲了什么」，仍然是一次研究；只有配上「整理 / 总结 / 提取」才是在要求抓取。

**为什么不用模型判类。** 那会给每条消息多一次往返，而且它错的时候用户无法理解——「它为什么觉得我的问题是在改文件」没有可读的答案。规则可以被读、被测试、被指着改，`test:intent` 9 条就是这四条规则的形状。

只有 `workspace` 进入第 4 层。默认分支必须是 `answer`——**默认走执行是当前所有错位的第一因。**

路由结果连同 `reason` 一起落进 `Conversation.intentReason`，界面上就是标题下面那行「路由依据：…」。**判断要能被看见，否则用户只能怀疑它。**

### 2.2 第 3 层：SubAgent 与网页适配器

这一层不是一个类，是六个盒子、五条边界。相邻两层只通过接口说话：

```
MasterAgent            谁参加这一轮、几轮、什么时候停
  └ SubAgentPool       SubAgentRegistry：谁现在能用、同时最多几个
      └ SubAgent       ProviderSubAgent：身份、会话、健康记录、结果归一
          └ BrowserAdapter   PageBrowserAdapter：把一次提问变成「发—等—认领」
              └ ChatPageDriver  探针、发送、等待、回声剥离（与站点无关）
                  └ ProviderProfile  某个站点的选择器与 host
```

**往下每走一层，丢掉一种「为什么」。** Master 知道为什么是这两个参与者；SubAgent 知道为什么这次该重开会话；Adapter 知道为什么这一次算发送成功；Driver 只知道页面上此刻发生了什么；Profile 只知道选择器。任何一层开始回答上一层的「为什么」，就说明它被放错了位置——这也是下面那些「里面没有什么」那一列存在的理由。

**SubAgent 是逻辑上的参与者，Adapter 是技术上的网页驱动器，两者不能写成一个类。** 写在一起，最后会得到「哪个模型说的」和「用了哪个 DOM 选择器」在同一个文件、同一份 bug 报告里。分开的收益是具体的：换一个站点只动 `adapters/providers/`，换一个驱动器（将来的 Playwright）只动 `adapters/browser/`，「谁参加这次研究」在 `agents/` 和 `master-agent.ts` 里，三处互不牵连。

```ts
// agents/types.ts —— 参与者
export type SubAgentKind = 'provider' | 'specialist';

export interface SubAgentIdentity {
  id: string;      // 与 sources.json、消息记录用同一个 id
  label: string;   // 界面上的名字；也是「通用层不许写站点名」时名字的唯一来源
  kind: SubAgentKind;
  role: string;    // 一句话：这个 agent 在这轮里负责什么
}

export interface SubAgent {
  readonly identity: SubAgentIdentity;
  readonly id: string;
  readonly label: string;
  health(): Promise<ChannelStatus>;      // 页面状态 + 自己的连续失败记录
  ask(task: SubAgentTask): Promise<SubAgentAnswer>;
  newConversation?(): Promise<NewSessionResult>;
  cancel(requestId: string): void;
  cancelAll?(): void;                    // 「停止」真正需要的那个动作
}

export interface SubAgentTask {
  question: string;                      // 调用方拼好的原文，agent 不改写
  stage: AskStage;                       // initial / followup / challenge
  dispute?: { topic: string; stance: string; counter: string };  // 留给辩论轮
  timeoutMs?: number;
}

/** Master 需要的那一小块，故意比注册表窄。 */
export interface SubAgentPool {
  all(): Promise<SubAgent[]>;            // 有谁——用来告诉用户去登录哪个页面
  available(): Promise<SubAgent[]>;      // 谁能被问
  ask(agentId: string, task: SubAgentTask): Promise<SubAgentAnswer>;
  newConversation(agentId: string): Promise<NewSessionResult>;
  cancel(agentId: string, requestId: string): void;
}

// adapters/browser/types.ts —— 驱动器
export type AskStage = 'initial' | 'followup' | 'challenge';

export interface AdapterAsk {
  question: string;
  stage: AskStage;
  timeoutMs?: number;
}

export interface AdapterAnswer {
  agentId: string;                       // 哪一页答的，等于所属 agent 的 id
  text: string;
  receivedAt: number;
  /** 这段文字是凭什么被认成「这一轮的回答」的。排查用的面包屑。 */
  attribution: { requestId: string; note: string };
}

export interface BrowserAdapter {
  readonly id: string;
  readonly label: string;
  status(): Promise<ChannelStatus>;
  ask(input: AdapterAsk): Promise<AdapterAnswer>;
  newConversation?(): Promise<NewSessionResult>;
  cancel(requestId: string): void;
  /** 停止：请求 id 只有答完才知道，所以"放弃所有在等的"必须是一个独立动作。 */
  cancelAll?(): void;
}
```

`SubAgentPool.all()` 和 `available()` 是两个问题，不是两个版本：`available()` 回答「谁能被问」，`all()` 回答「有谁」。只有前者的话，「一个都用不了」时那句提示只能写死站点名——而那正是被清掉的那种残留。

两个刻意的设计：

1. **`ask()` 只返回 `text`。** 没有 `data`、没有 `payload`、没有 `structured`。类型系统层面禁止"让通道吐 JSON"，因为那正是现在所有问题的源头。
2. **通道不知道协议存在。** 需要 JSON 的场景由调用方在 `question` 后面追加协议后缀，通道照常发、照常取回文本。

文件在哪，以及每个文件里**没有**什么：

| 文件 | 是什么 | 里面没有 |
| --- | --- | --- |
| `agents/types.ts` | `SubAgent`、`SubAgentTask/Answer`、`SubAgentPool` | DOM、选择器 |
| `agents/provider-agent.ts` | `ProviderSubAgent`：身份、会话、健康记录、`normalizeAnswer` | DOM、轮次编排 |
| `agents/registry.ts` | `SubAgentRegistry`：并发上限、可用性、`replaceAll` | 谁该参加这一轮 |
| `adapters/browser/types.ts` | `BrowserAdapter`、`PageBusyError` / `PageUnavailableError` | 站点名、选择器 |
| `adapters/browser/page-adapter.ts` | `PageBrowserAdapter`：把一次提问变成「发—等—认领」 | 身份、会话策略 |
| `adapters/browser/page-driver.ts` | `ChatPageDriver`：探针、发送、`waitForAnswer`、回声剥离 | 任何站点的常量 |
| `adapters/providers/deepseek.ts`、`chatgpt.ts`、`kimi.ts` | 选择器 + host（+ 需要剔除的思考区），一个站点一个文件 | 行为 |
| `master-agent.ts` | 选参与者、单答还是并行研究、收集、交给综合 | DOM、存储、事件 |
| `conversation-runner.ts` | `ConversationRunner`：装配 `ResearchSink`、写消息、落事件、取消 | 页面、选择器、综合规则 |

最后两行是同一条边界的两侧：`MasterAgent` 决定**这一轮怎么进行**，`ConversationRunner` 只负责**把发生的事记下来**。所以 Master 不认识 store，Runner 不认识 DOM。

两者之间那个接口就是这条边界的形状——Master 往一个它不拥有的东西上写：

```ts
// master-agent.ts —— 只声明要什么，不声明怎么实现
export interface ResearchSink {
  join(agentId: string): void;                                    // 这个 agent 加入本轮
  record(answer: SubAgentAnswer): string;                         // 落一条消息，返回 messageId
  phase(agentId: string, phase: ChannelPhase, detail?: string): void;
  note(text: string): void;                                       // 一句话，不属于任何 agent
  status(status: ConversationStatus): void;
  cancelled(): boolean;                                           // 用户按了停止
}
```

`record()` 返回 `messageId` 是关键：综合里的每一条结论都要指回具体的消息（见 3.2），而消息 id 只有记录者知道。如果 Master 自己生成 id，它就得知道存储的规则——那就是它开始拥有 store 的第一步。


**「不含站点常量」包括文案，不只是代码。** 拆完的第一次复查发现，四个通用层里的代码已经不认识站点，**报错和提示还认识**：驱动器说「需要在内嵌页面完成 DeepSeek 登录」，于是在 ChatGPT 的页面上要求用户去登录 DeepSeek；编排器说「DeepSeek 未登录 / 正在生成」；Master 说「请先登录 DeepSeek 或 ChatGPT」——加了第三个站点后，这句既点名了用户已登录的，又漏掉了他没登录的；渲染层 `labelOf()` 里是一张 `if (id === 'deepseek')` 的表，于是答案卡片上显示原始 id 而其他界面显示名字。规矩因此补了一条：**通用层里出现的站点名字只能来自参数**（`siteLabel`、`ChannelStatus.label`、`SubAgentPool.all()`），不能是字面量。`test:adapter` 里两个用例用一个编出来的站点（`chat.example.test` / 「示例站点」）把这条钉住：登录提示里出现的是新名字、且不含 `DeepSeek`。

`DeepSeekStatus` / `DeepSeekDiagnostics` / `DeepSeekEvent` 这三个**类型名**还没改。它们是跨 preload 和渲染层的契约名（34 处引用），改名要动 IPC 表面，留给下一次动 IPC 时一起做。

顺带修掉一个真 bug：诊断面板报告的 `selectors` 原来是模块级的默认值，于是 ChatGPT 的面板里显示的是 DeepSeek 的选择器。现在驱动器的 `selectors` 是构造时传进来的（一个函数，学到的 profile 下一次探针就生效），`diagnose()` 报告的是**正在用的那一份**。

**Master 管预算，SubAgent 不能自己叫人。** 谁能被问、一次问几个、问几轮，只有 `MasterAgent` 决定。一个能自行召集同伴的参与者会把用户的时间和页面的额度花在没人计数的地方。所以 `SubAgent` 接口里没有 `askOther()`，`SubAgentPool` 也没有暴露给参与者。

**辩论轮：设计在，实现不在。** `AskStage = 'challenge'` 是留给它的，规则式综合也已经能指出分歧在哪一句。但这一轮**刻意没有接进链路**：先有可靠的"谁在说什么、页面怎么驱动"，再有"让它们互相质疑"。在那之前，分歧就如实报成分歧，而不是被一轮没人要求的二次提问抹平。（原先这里还留了一份挑战提示词模板，已随"不发固定提示词"一并删除：要接这一轮时，把两种说法并列给通道就够了，不需要一段预设话术。）

#### 只有一种参与者：provider

`SubAgentKind` 里写着 `'specialist'`（researcher / critic / reviewer），但**没有实现，而且是有意不实现**。一个 specialist 终究得跑在某个 provider 上，于是「同一个模型换一段角色提示词」会被当成第二个视角——它说「我同意」的时候，那只是它在复述自己上一句话。

真正值得开一个 specialist 的条件是**它带来了别人没有的东西**：独立的模型、独立的数据源、或者能跑工具（查文档、跑代码、读仓库）。在那之前，多一个角色只会让界面上多一张卡片，让「几个 AI 有共识」这个数字变得不可信。类型先留着，是因为接口的形状已经确定了——`kind` 决定它是「代表一个站点」还是「代表一种职责」，而这两者在 Master 眼里是同一种东西：可以被问、会失败、有健康状态。

#### 一个站点是怎么加进来的

`adapters/providers/<id>.ts` 里写 `ProviderProfile`（`selectors` + `hosts` + `label`，需要时再加 `reasoning`），`adapters/providers/index.ts` 的 `PROVIDERS` 里加一行。就这两处。

这条承诺有代价，所以要写清它靠什么成立：驱动器里没有 `if (site === …)`，通用层里没有站点名字（连文案都没有，见上），`hosts` 和 `selectors` 都可以是函数（地址可编辑、学到的选择器下一次探针生效），渲染层的名字来自 `ChannelStatus.label`。**这四条任何一条破了，「加一个站点」就会重新变成「改五个文件」。**

**这条路已经踩过了（第三站：Kimi）。** 结论是「一个文件加一行」成立，但成立的前提是那次真的先看了 DOM，而不是照着前两个抄：

- 发送键在 Kimi 上是个 `div`，没有 `role`、没有 `aria-label`、没有 `data-testid`，唯一身份是 class `send-button-container`。通用兜底找的是 `button, [role="button"]`，实测会先命中输入框工具栏的「上传文件」，点了等于什么都没发。所以画像必须显式给出这个 class。
- 同一个元素在生成时**变成**停止键（加 class `stop`），因此发送选择器写成 `.send-button-container:not(.stop)`。少了 `:not`，生成中点击会把「停止」当成「已发送」。
- 回答是「气泡 + 思考面板 + 正文」的一棵子树，`innerText` 会把「思考已完成」和推理一起带出来。为此通用层加了一个小能力：画像可以声明 `reasoning`（要剔除的子树），探针在取回答文本时克隆气泡、剪掉这些子树再读。剪完为空则回退原文——**剪辑是假设，假设错了不能把回答变成空**。

这三条都不是「多写几个选择器」，而是站点结构逼出来的。所以「加一个站点不用改主流程」以后要加一句：**主流程不改，但可能要新增一种画像能力**。这次的 `reasoning` 就是。

顺带修掉的一个通用缺陷：Kimi 的输入框是 Lexical 编辑器，`execCommand('insertText')` 返回 true 时 DOM 还是空的，文本要等约 40ms 才出现（实测）。旧的填字逻辑同步读回，于是把一个已经成功的填写判成 `INPUT_NOT_FILLED`、拒绝发送。现在对 `contenteditable` 会轮询最多 600ms 再判定；`textarea`/`input` 不轮询——值设进去要么成了要么没成，等待只会掩盖 bug。

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

对应地，探针自己量视口宽度（`probe.viewportWidth`），并且**用它把两种完全不同的失败分开**：视口是 0 时说「页面还没有分到尺寸（视口 0×0），右侧切换到这个页面一次即可」，否则才说「未找到输入框，页面结构可能已变化」。把 0×0 报成「结构可能已变化」曾把一次排查引向完全错误的方向——那是布局问题，不是改版问题。

#### 页面自己的那条栏，和「更新样式」

页面是原生视图，**画在文档之上**。这条事实决定了四件事的写法：

| 想做的事 | 直觉做法 | 实际做法 |
| --- | --- | --- |
| 在页面上方加一条状态栏 | 在页面区域加一个 `div` | `div` 会被视图盖住。必须由主进程把视图下移 `PAGE_HEADER_HEIGHT`，栏才能画在露出来的那条带子里 |
| 让某个页面变大、单独用 | 改分栏比例 | 分栏最大也只能切一半。真正的"放大"是把视图**重新挂到另一个窗口**：`removeChildView` → `addChildView`。同一个 `webContents`，所以登录、滚动位置、正在写的回答都还在 |
| 吸附回来 | 单独写一条恢复路径 | 独立窗口的关闭按钮、Cmd+W、窗口里的「吸附回去」都落到同一个 `closed` 事件。只有一条路径，就没有"两条路径不一致"这种 bug |
| 把网页那一格收起来 | 把分栏宽度设成 0 | 0 会让应用列钻到右侧轨道下面，按钮就被画在输入框上了。而且**折叠不是"分栏变小"**，是"不画了"：折叠时视图照旧占着原来那个盒子，只是被停到窗口外并且 `setVisible(false)` |

最后一条值得单独写下来，因为把两件事混在一起会有很贵的后果。`primeViewports` 给每个视图的那个视口是**通道能不能回答问题的前提**——一个被塞进 0 宽矩形的视图会失去视口，页面里每个元素都量出 0，探针就会对一个完全健康的页面说"找不到输入框"。所以折叠走的是和"切换来源"完全相同的分支（停到窗口外、保留盒子、停止绘制），而不是一条新的几何路径。`check:pane` 直接断言这件事：折叠后视图的 `width` 和页面自己的 `innerWidth` 都必须**和折叠前一模一样**。

折叠后留下的 `PAGE_STUB_WIDTH` 那条窄缝也不是装饰。折掉整格之后，页面栏连同它的按钮一起消失，用户需要另一个入口。窄缝就是那个入口——整条都是按钮，点哪儿都能把页面放回来；它同时也是"页面还活着"的唯一提示（竖排的来源名 + 状态点）。

**收起按钮本身在轨道顶部，不在页面栏里。** 最初它长在页面栏末尾，那是个结构性错误：页面栏在格子里，折掉整格，按钮跟着没了——「撤销刚才那一手」的控件被那一手删掉了。现在它在窗口最右边那一列（`source-rail`）的顶部，和来源按钮之间有一条细线隔开：上面的管窗口，下面的换页面。窄缝里不再放第二个同样的按钮，因为两个相隔 30px 的开关做同一件事，看起来像 bug。

图标也从尖角换成了**面板**：圆角矩形 + 右侧一列实心。尖角说的是"往右移"，描述的是动画；面板说的是"这一格"。**两种状态画的是同一张图**，颜色、边框、填充都不变，变的只有 `aria-label` 和它身后的窗口——一个会自己改头换面的开关，等于让用户多读一样东西。它也比下面的来源按钮大一号（36px 对 32px，图标 20px 对字母 12px）：它是窗口级的控件，不是第四个页面。

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

#### 来源不再是常量，开关就是通道

内嵌的网页从"写死的四个地址"变成了"出厂默认 + 用户增量"，这条链上有四个决定，每一个都在修一个具体的坏结果：

| 决定 | 不这样做会怎样 |
| --- | --- |
| `BUILTIN_SOURCES`（出厂）+ `userData/sources.json`（增量），由纯函数 `resolveSources()` 合并 | 存解析后的整份列表，等于把今天的内置项钉死：将来修一个 URL、加一个来源，对已安装的人永远不可见 |
| 改地址走 `loadURL`，不重建视图 | partition 属于**来源 id**，不属于 URL。重建视图就是换 session——用户刚改好地址，却发现自己被登出了 |
| `hostsFor()` 保留声明过的 hosts 并**追加**新 host | 替换掉会破坏 OAuth 跳转（跳到 accounts.google.com 之类被拒）；不追加会拒绝用户刚填的那个地址，而报错看起来像网络故障 |
| `SubAgentRegistry.replaceAll()` 而不是换一个新的注册表对象 | `ConversationRunner` 持有的是那个实例，换对象会让它永远读旧列表——开关拨了，通道数不动 |

「开启后才可以用」不是一个 if，而是三层同时成立：来源栏只列开着的（点不到）、`activateSource` 对没开的来源直接报错（绕不过去）、`rebuildChannels` 只把开着的变成通道（数得对）。少任何一层，就会出现"按钮在、点了没反应"或者"就绪度写着 1/4，其中两个根本没开"。

规划通道是这条规则唯一的例外，而例外的形状很重要。原来的写法是「规划通道不能关」——一个死的复选框，用户既不知道为什么，也没法关掉一个不再付费的站点。现在写成「**至少留一个**」：`planningSource()` 优先选开着的规划来源，其次任一开着的来源；关掉最后一个会被拒绝并给出理由。规则说的是同一个不变量（Agent 得有地方问），但没有把某一个来源特殊化。界面上「规划通道」的标签跟着 `planningId`（此刻真正在用的那个）走，而不是跟着出厂标记——否则关掉 DeepSeek 之后，标签还挂在它身上，指着一个已经不用的页面。

还有一处只有真机才暴露的坑：**开关打开的瞬间新建的视图没有视口**。它从没上过屏，而 `layout()` 紧接着就把它停到窗口外（因为它不是当前来源），于是一辈子停在 0×0，通道报「未找到输入框，页面结构可能已变化」——和"页面改版了"完全同一个症状。修法是补一次启动时做过的事：`primeViewport()` 先按页面尺寸显示一帧再交回 `layout()`；而 `createSourceView` 一律把视图插到栈**最底层**，因为 z 序不影响布局，所以它拿得到视口，又不会盖住用户正在看的那一页。

**开关站在行首，而且一按就生效。** 它原来在编辑表单里，叫「启用这个提供商」——于是"关掉一个页面"这件最便宜的事要四步：进编辑、取消勾选、保存、等表单关掉。改地址和开关是两个动词，却共用一扇门，而门上写的是「编辑」。现在每行最左边就是开关（`role="switch"` + `aria-checked`），点一下直接落盘，不打开任何表单；关着的行只把名字和地址变淡，不再另挂一个「未启用」标签说同一件事。

两件事刻意**没有**跟着开关走。**编辑按钮**在所有行都在：打开一个来源会真的建视图、加载页面，所以「开着才能改地址」意味着想改一个刚关掉的来源的地址，就得先把它打开——先加载你正想换掉的那个地址。**默认全开**也不成立：WorkBuddy 没有地址、Kimi 没有选择器配置，出厂全开等于四行里两行只会失败；而在这里新加的来源自带地址，所以它是开着的。没地址的行点开关不会只换来一句拒绝：地址框直接打开并聚焦，理由写在框下面——死路变成下一步。

**「保存」这个按钮的承诺，只有磁盘能兑现。** 它说的不是"现在这个进程记得"，而是"下次启动还记得"——所以这条链的最后一环不在内存里，在 `sources.json`。写入原来是 `writeFileSync` 直写：`O_TRUNC` 先清空再写，中间被杀掉、断电、磁盘满，留下的是半个 JSON，而 `load()` 解析不了就只能回退到出厂默认——**这个人改过的一切在下次启动时消失，而且是静默的**，因为出事的那一刻已经太晚了。现在走 `main/atomic-write.ts`：写同目录临时文件、`fsync`、再 `rename` 覆盖（同目录 rename 是原子的），旁边留一份 `.bak`；主文件读不了时读 `.bak`，而不是把设置交给出厂值。

失败也不再被吞掉。`persist()` 原来 `catch {}`，于是面板说「已保存」、磁盘什么都没有，代价要等到下次启动才付。现在写不进去就把内存回滚到改动前，并抛出一句「设置没能写到磁盘上，重启后会丢：…」——面板原样显示。这条路径的验收在 `check:settings` 里：保存地址之后不只问主进程，还**直接读磁盘上的那份文件**；加一个提供商、删一个提供商，也各问一次磁盘。内存和磁盘不一致的时候，只有磁盘说的是下一次启动会相信的话。

#### 左下角那个名字，不该是系统给的

侧栏底部那一行原来写的是 `os.userInfo().username`，提示里是 `os.hostname()`。这是错的，而且错得不只是品味：这个应用**没有账号**，却把操作系统的登录名（以及 macOS 上通常由它派生的机器名）画在屏幕上，然后它会进截图、录屏、发给别人的报错。一个产品显示一个它从未被授予的名字，就是在泄露一个名字。

现在的形状是：规则在 `shared/identity.ts`（纯函数，可单测），存储在自己的 `main/profile-store.ts`，默认值 `本机用户`，可以自己改，空串等于「恢复默认」。三处细节都是刻意的：

- **名字单独一个文件**，没有塞进 `sources.json`。改名字和"有哪些页面"没有关系，而一个坏掉的 profile 也不该能带倒来源列表。最坏情况是名字退回默认值——一次点击就能改回来，而猜测半截 JSON 不是。
- **空名字是被拒绝的，不是被清空的**。侧栏底部空一行，读起来是"未登录"，而这个应用没有可登录的地方。拒绝的理由写在输入框下面，不写在应用底部的错误条里。
- **第二行写平台，不写机器名**。"这台 Mac"是真的，且不指向任何人。

这条规则的另一半在项目底层规则里：工程内（源码、文档、注释、测试、提交信息、记忆文件）不允许出现本机用户名，路径一律写 `~/...`。界面这一半和文件那一半是同一件事的两端——**运行期读到的用户名也不许显示**，否则"工程里没有这个字符串"只是把泄露点从代码挪到了截图。

#### 应用自己叫什么

一个人的名字由他自己给，一个应用的名字也一样，而且同样不由操作系统决定。开发时它跑在 `node_modules/electron/dist/` 里，而 macOS 的 Dock 读的是 **bundle 的身份**——所以无论代码里写什么，Dock 上都写着 "Electron"。

第一次修只改了 `CFBundleName` / `CFBundleDisplayName`，Dock 上还是 "Electron"。原因值得记住：Dock 不只读这两个键。**从命令行直接 exec 起来的进程没有经过 LaunchServices**——`lsappinfo` 对这个实例报的是 `bundleID=[NULL]`，`lsregister -dump` 里根本没有它的记录——Dock 拿不到「显示名」这条记录，就退回磁盘上那个可执行文件的名字，而它叫 `Electron`。于是 `NSRunningApplication.localizedName` 回答 ThinkFusion、屏幕上画的却是 Electron：两处都「对」，只是它们并不读同一处。

所以现在整份身份一起搬，而不是改一个字段：

- `app.setName('ThinkFusion')` 改的是 Electron 自己派生出来的一切：菜单、崩溃报告、user-agent（现在是 `ThinkFusion/0.6.0`，不再是包名）。
- `scripts/rename-dev-app.mjs` 搬的是 bundle 本身：目录名、里面的可执行文件、`CFBundleExecutable`、两个名字键、以及 bundle identifier（Electron 出厂的 `com.github.Electron` 是全机器所有开发副本共用的，本来也不该占着）。`node_modules/electron/path.txt` 跟着重写，因为 `electron` CLI 靠这个文件找二进制。
- 两件事让它在这里是安全的而不是取巧：npm 装下来的 Electron.app 是 ad-hoc 签名、`Info.plist=not bound`、`Sealed Resources=none`，plist 没有被封进去，而改文件名不影响「签名签的是内容」；并且**不复制第二份 bundle**——只有一个路径上的一份，就不存在「副本去申请同一份权限」。辅助功能权限本来就属于 `resources/ax-bridge`（一个被 spawn 的独立二进制），与这个路径无关；早先这里写着相反的理由，是错的。
- 打包版不需要这些：`build.productName` 已经是 ThinkFusion，bundle 生来就叫这个名字。

验收要同时看四个来源，缺一个就可能只改到了一半：bundle 目录名、`CFBundleExecutable` 指向的文件、`mdls kMDItemDisplayName`、`lsregister -dump` 里那条记录的 `displayName`。

有一处必须跟着改，否则会重演「设置丢了」：`app.getPath('userData')` 是**从应用名派生**的。只改名不钉路径，数据目录就会从 `…/thinkfusion-ai` 变成 `…/ThinkFusion`，所有保存过的通道、改过的网址、选好的显示名称，在下次启动时都会像被删掉一样。所以 `app.setPath('userData', …/thinkfusion-ai)` 紧跟在改名后面，目录名保持原样——重命名目录是一次数据迁移，而只能在别人的机器上验证的迁移，不值那点整齐。

#### 页面文本 → 应用文本，只有一个边界

`shared/text.ts` 是唯一允许"页面长什么样"和"答案是什么"不同的地方，四件事：

1. `cutSpeakerLabels`：按页面自己的 `你说：/ChatGPT 说：` 标签切到助手标签之后——提示词被页面重排后精确 echo 匹配会失效，标签才是页面自己画的边界。
2. `stripEcho`：去掉我们自己的问题。
3. `stripChrome`：站点文案（免责声明、升级横幅）按整行名单删、按短语删；**不动缩进**，否则代码块会被拍平。
4. `normalizeAnswerText`：引用角标是内联 chip，`innerText` 会让它变成「短横线 + 数字」竖排，成对删除；编号列表是另一种形状，不受影响。

这四步只做一次，就在 `waitForAnswer` 返回之前。之后无论是气泡、综合还是落盘，拿到的都是同一份干净文本。

### 2.3 第 5 层：综合

输入是 N 个 `SubAgentAnswer`，输出是结构化的 `Synthesis`：

```ts
export interface Synthesis {
  consensus: Claim[];      // 多数通道一致，且各自给了依据
  disputed: Dispute[];     // 有冲突：谁说了什么，分歧点在哪一句
  unique: Claim[];         // 只有一个通道提到，可能是增量，也可能是幻觉
  gaps: Gap[];             // 没有任何通道覆盖的角度
  overlap?: string[];      // 每个通道都谈到的主题词——"值得对比"的证据
  recommendation: string;  // 结论，必须能追到上面的条目
  /**
   * 句子没能切成观点，结果只是把几段回答并排放着。
   * 界面必须说出来，而不是把它当成一次成功的综合——「没找到分歧」和
   * 「没能去找分歧」在屏幕上必须长得不一样。
   */
  degraded?: boolean;
}
```

`degraded` 是这套结构里最容易被省掉的字段，也是唯一一个「省掉就等于说谎」的字段：降级不是错误，把降级呈现成结论才是。

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

就是 IPC 契约，描述一次对话里发生了什么。**下面这张表是代码里那张联合类型，不是设计稿**——`src/shared/conversation.ts` 的 `ConversationEvent` 是唯一权威，这里只是把它读出来：

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `conversation.created` | `{ conversation }` | 新建时整份发过去，渲染层不用再拉一次 |
| `conversation.updated` | `{ conversation }` | 状态、标题、错误都在这里变 |
| `conversation.deleted` | `{ conversationId }` | 谁删的都要发，否则多个列表各留一行 |
| `message.added` | `{ message }` | 用户、通道、综合、系统四种消息共用一条 |
| `channel.phase` | `{ conversationId, channelId, phase, detail? }` | `resetting` / `asking` / `answered` / `failed` / `busy` |
| `synthesis.ready` | `{ conversationId, synthesis }` | 见 `research/v1` |
| `conversation.failed` | `{ conversationId, error }` | 失败要给原因，不是给一个空面板 |

两个刻意的选择：

- **没有 `user.message` / `channel.asked` / `channel.answered` 这类事件。** 早期设计里有，落地时发现它们是「消息」的三种特例——一条 `message.added` 带上 `role` 就够，而多一套事件就多一处会忘记发的地方。用户问了什么、问了谁、谁答的，全在消息记录里，不需要事件来复述；要回看「到底问了什么」，看的是那条 `role: 'user'` 的消息和页面自己的记录。
- **进度不是事件流。** `channel.phase` 带 `at` 时间戳，渲染层自己每秒重算「已等待 12s」——主进程不为此每秒发一条事件。

关键：**这套协议里没有任何"计划""审批""执行"的概念。** 问答链路不经过 Runtime。

### 3.2 `thinkfusion/research/v1`

这是 `Synthesis` 的持久化形态，`Claim` 至少包含：

```ts
export interface Claim {
  text: string;
  /** 哪几个通道说过，按支持度排序。messageId 指回消息记录里的那一条。 */
  sources: Array<{ channelId: string; messageId: string }>;
  /** 原话里的依据片段；空数组表示这是一句断言，没有依据。 */
  evidence: string[];
}
```

`sources` 里存 `messageId` 而不是 `turnId`：综合产出的每一条结论都要能跳回**那一句原话**，而消息记录的主键就是 `messageId`。指向一个没人存的编号，等于「有出处」三个字只是装饰。

`Dispute` 额外带 `positions: Array<{ channelId; stance }>` 和 `pivot`（分歧具体落在哪一句）。

再次强调：这套结构由系统产出，**不要求任何模型按它输出**。

这三个字段是第 11 节那套协议的子集，将来扩的时候只加字段、不改语义：`sources[]` 保持不动，`Claim` 另加 `kind`（这条是事实、推断还是建议）、`span`（原话在消息文本里的位置）、`evidenceIds`（指向 `Evidence` 表）。这样今天落库的 `Synthesis` 明天仍然读得出来，不需要一次数据迁移——**能加列就不要改名**，改名要迁数据，而迁移只能在别人的机器上验证。

### 3.3 `desktop-agent/v1`

**保持不变。** 现有的解析、回声剥离、id 回填校验、`clarification_required` / `task_complete` 全部保留，见 [PROTOCOL.md](../desktop-agent-macos/docs/PROTOCOL.md)。

唯一变化是**触发条件**：只有 `intent.kind === 'workspace'` 时，`AgentOrchestrator` 才会在问题后追加协议后缀。其余场景这段协议文本根本不会出现在对话里——`buildConversationPrompt` 里没有它，`ConversationRunner` 也没见过它。

---

## 4. 两条主链路

### 4.1 问答 / 研究链路（不碰 Runtime）

```
用户输入
  → ConversationRunner     classifyIntent() 判类型，先落一行对话和一条用户消息
  → MasterAgent            选参与者（单答只问一个），并发问，收集
  ── 以下在 Master 内部 ──
  → SubAgentPool           每 agent 一个写者 + 全局上限 3，满了直接拒
  → synthesize()           规则抽取 → consensus / disputed / unique / gaps
  ── 回到 Runner ──
  → 写消息、发事件、翻状态
```

没有计划、没有审批、没有文件系统。三个细节值得记：

- **`start()` 立刻返回**，回答晚点到，通过事件推。一个阻塞一分钟的 IPC 调用，在用户眼里和卡死没有区别。
- **单答不综合。** 一个回答没有第二份可以对照，硬做一次「综合」只会把它复述一遍，还多占一次额度。
- **状态最后翻。** 先写综合消息，再置 `answered`；反过来的话，界面上会出现「已回答」压在一张空卡片上。

### 4.2 工作区任务链路（进入 Runtime）

```
用户输入
  → classifyIntent()       判定 workspace
  → AgentOrchestrator      用同一个通道 ask(goal + desktop-agent/v1 后缀)
  → 解析计划 → 人审批 → UtilityProcess 执行 → 执行报告回传 → 下一轮
```

两条链路**共用通道与事件日志**，但只有第二条进入 `src/agent/*`。第二条至今仍由 `AgentOrchestrator` 独占（414 行）：它自己持有一条单页串行队列（`pageQueue`），直接拿一个 `ChatPageDriver`，不经过 `SubAgentPool`。这一轮的范围是第 3 层，所以没动它；但两者迟早要合——同一个页面被两条路径同时驱动，就是两个写者，而「一个页面只有一个写者」是这个项目里最贵的教训之一。

---

## 5. 状态机

两套，各管一件事，互不嵌套：会话状态机管「这次问答走到哪」，执行状态机管「这个任务走到哪」。只有 `workspace` 意图会同时出现在两套里。

### 5.1 会话状态机

```
单答：thinking ─────────────────────────────────► answered
多答：thinking ──► collecting ──► synthesizing ──► answered
追问：answered ──► thinking（同一个会话里，页面历史就是上下文）
任意状态 ──► failed / cancelled
```

`ConversationStatus` 里声明了 8 个值，**当前代码只会进入 6 个**：`thinking`（新建即此，单答全程停在这里）、`collecting`（多参与者时）、`synthesizing`（≥2 条回答才综合）、`answered`、以及两个终态 `failed` / `cancelled`。

`comparing` 和 `awaiting_user` 声明了，但**没有任何代码路径会设置它们**：前者是早期设计里「比较」单独一步的残留，后者要等辩论轮或澄清轮才会用到。写在这里是有意的——一个画在图上却走不到的状态，比没有这个状态更误导人：读代码的人会去找「谁把它设成 `comparing`」，找不到，然后怀疑自己漏了。

`answered` 不是终点：用户追问会回到 `thinking`，同一个会话里页面的历史就是上下文。**状态只在最后一条消息落盘之后才翻**：先翻状态再写消息，界面上会出现「已回答」压在一张空卡片上。

### 5.2 执行状态机（保留）

`created → planning → awaiting_clarification → plan_ready → awaiting_approval → executing → verifying → report_pending → awaiting_next_round → completed`

这套状态机、它的守卫、以及 `TaskManager` 的 `TERMINAL` 集合都不动。它只是不再服务所有任务。

---

## 6. 并发模型

两条链路各有各的串行化，理由是同一条：**一个页面只有一个写者**。两个问题同时写进同一个输入框，回答会互相串进对方的气泡，然后两个都被误读——这不是理论，是实机跑出来过的一次「任务 A 收到任务 B 的完成声明」。

| 链路 | 谁在串行 | 粒度 |
| --- | --- | --- |
| 工作区任务 | `AgentOrchestrator.pageQueue` | 全局一条队列：一次只驱动一个页面 |
| 问答 / 研究 | `SubAgentRegistry` | 每个 agent 一个写者 + 全局上限 3 |

第 3 层没有照搬 `pageQueue` 那条全局队列，因为它会把「问三个 AI」变成「排三次队」，用户等的是三倍时间而不是一份并行答案。换成了两条独立的限制：

- **每个 agent 一个写者**：同一个页面上的第二个问题直接拒（`PageBusyError`），不排队。
- **全局上限 3**（`maxConcurrent`）：上限存在的原因不是正确性，是资源——每个通道是一个 `WebContentsView`，各占一份渲染进程内存。同时开 6 个网页版 AI，机器会先撑不住。

**满了就拒，不排队。** 排队的请求在用户眼里就是「卡住了」，而且它会让「等待中」这个状态失去意义：你无法区分「页面在写」和「前面还有两个人」。拒绝之后由 Master 决定跳过谁，并且**把原因写进那一轮的结果**——`b: 通道正在处理上一个问题，本次跳过`。一个被跳过的通道要在界面上说出来，否则用户看到的是一次「只有两个回答」的正常结果。

这条规则在界面上的表现是通道条上的「忙，已跳过」——它和「失败」用的是不同的词，因为用户能做的事不同：忙，等一下重问；失败，去登录或更新样式。**两种都叫「没回答」，但一个该等，一个该修。**

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

| 现在 | 问题 | 改成 | 状态 |
| --- | --- | --- | --- |
| `buildInitialPrompt` 无条件注入计划协议 | 每个任务都被迫变成计划任务 | `buildConversationPrompt`（问答/研究）+ `buildInitialPrompt`（仅执行链路） | ✅ 已分开 |
| `AgentOrchestrator` 414 行，五件事混在一起 | 改一处牵全身 | 意图路由抽成 `shared/intent.ts` 的纯函数、对话抽成 `ConversationRunner`；执行链路仍叫 `AgentOrchestrator` | 部分：路由与对话已分出去，执行那一半没动 |
| `DeepSeekAdapter` 1338 行 | 加第二个 AI 要复制一遍 | 按 `SubAgent` + `BrowserAdapter` 拆分（见 2.2） | ✅ 已拆：1338 行的一个类变成 5 个文件，其中驱动器仍占 1295 行——探针、发送、归属判断本来就长在一起，硬拆只会让它们隔着接口互相回看 |
| `pageQueue` 全局串行 | 多通道互相阻塞 | 每 agent 一个写者 + 全局上限 3（见第 6 节） | ✅ 问答链路已换；执行链路仍用全局队列 |

---

## 8. 迁移步骤

每一步都能独立发布、独立回滚，不做"大爆炸重写"。

| 步骤 | 内容 | 行为变化 | 验收 |
| --- | --- | --- | --- |
| **M1** ✅ | 抽出通道接口（后来改名 `SubAgent`），`DeepSeekAdapter` 实现它，行为不变 | 无 | 现有 59 项实机检查全绿 |
| **M2** ✅ | 引入意图路由（落地为 `shared/intent.ts` 的纯函数 `classifyIntent`），`answer` 分支**不注入计划提示词** | 问答不再产出计划 | `test:intent` 9；问一个知识问题，回答里没有 JSON |
| **M3** ✅ | `ConversationRunner` + 右侧对话流 UI，来源栏保留为「看原始页面」 | 右侧从网页视图变成对话视图 | `test:runner` 11；能连续追问两轮，上下文不断 |
| **M4** ✅ | 接入第二个通道（ChatGPT），每 agent 一个写者 + 全局上限 3（**没有做队列**，见第 6 节） | 可并行收集 | `test:sources-config` 24、`check:sources` 27；两个通道同时提问互不干扰 |
| **M5** ✅ | `shared/synthesizer.ts` 规则版接进链路 | 出现「分歧 / 缺失」标注 | `test:synthesis` 16；输出里至少一处明确分歧 |
| **M6** ✅ | 执行链路收敛：只有 `workspace` 意图进入 | 计划与审批变稀有 | `test:state` 8；关掉 Runtime，问答与研究仍可用 |
| **M7** ✅ | 第 3 层再拆一层：`ProviderSubAgent`（参与者）+ `BrowserAdapter`（驱动器）+ `adapters/providers/`（一个站点一个文件） | 无（装配位置变了） | `test:runner` 11、`test:adapter` 36、`test:sources-config` 24、`check:settings` 74 |

M6 的验收就是 [PRODUCT.md](PRODUCT.md) 第 7 节最后一条：**拔掉 Runtime 不影响核心产品。**

---

## 9. 风险与反面模式

| 风险 | 具体形态 | 对策 |
| --- | --- | --- |
| **逼模型吐 JSON 复发** | 给 `research/v1` 也定义一套模型输出格式，换个名字回到老路 | `SubAgent.ask()` 的返回类型里只有 `text: string`；结构化只在应用侧发生 |
| **综合退化成压缩** | 把 N 个回答拼给一个模型"总结一下" | `Synthesis` 必须包含 `disputed` 与 `gaps`，缺任一项视为未完成综合；切不出观点就置 `degraded` 并明说 |
| **多页面资源爆炸** | 同时开 6 个网页版 AI | 全局并发上限 3，满了直接 `PageBusyError`，不排队 |
| **回答归属失效** | 多通道下把 A 的回答当成 B 的 | 归属逻辑留在各通道内部，`attribution` 随答案一起返回，可回查 |
| **站点改版** | 选择器失效，整条链路静默变空 | 选择器只出现在 `adapters/providers/`；`diagnose()` 报 `probeVersion`、命中的选择器和正在用的那份 profile |
| **通用层又长出站点名** | 报错、提示、渲染层里出现「DeepSeek 未登录」 | 名字只能来自参数（`siteLabel` / `ChannelStatus.label` / `SubAgentPool.all()`）；`test:adapter` 用一个编出来的站点钉住 |
| **旧任务数据** | 迁移后历史任务无法回看 | `AgentStore` 只读兼容，旧任务标记 `legacy`，不尝试续跑 |

---

## 10. 与现有文档的关系

| 文档 | 定位变化 |
| --- | --- |
| [PROTOCOL.md](../desktop-agent-macos/docs/PROTOCOL.md) | 从"系统通信协议"降级为"三协议之一：本地执行协议"。内容不变，适用范围收窄 |
| [IPC.md](../desktop-agent-macos/docs/IPC.md) | 仍描述任务链路那批通道（`task:*`、`deepseek:*`）。对话事件表以 `src/shared/conversation.ts` 的 `ConversationEvent` 为准，本文 3.1 节是它的读法 |
| [SECURITY.md](../desktop-agent-macos/SECURITY.md) | 不变。安全边界只收紧，不放松 |

---

## 11. 观点融合引擎（目标形态，未实现）

第 5 层现在是规则版：把两段回答切成句子、比 bigram、找共同数字和主题词，产出 `consensus` / `disputed` / `unique` / `gaps`。它能回答「这两句说的是不是一回事」，回答不了「这条观点凭什么成立、谁反驳了它、反驳成不成立」。

这一节写它该长成什么样。依据是 2026-11-03 的《观点融合引擎：完整技术建议》v1.0（外部文档，未入库）。**不照抄**，因为那份建议描述的是一个从零开始的项目，而这个仓库已经有三层可用代码和十九个实机检查脚本——照抄目录和运行时，改的是整齐，赔的是已经验过的东西。取舍逐条写在下面。

### 11.1 一句话：从「比较句子」到「维护论证结构」

| | 现在 | 目标 |
| --- | --- | --- |
| 单位 | 句子 | Claim：可独立判断的原子观点 |
| 关系 | 一致 / 不一致 | 支持、反驳、矛盾、细化、限定、依赖、有据 |
| 证据 | 原话片段（字符串） | Evidence 对象：来源、时间、可核验状态、是否独立于其他证据 |
| 结论 | 挑一段当 `recommendation` | 按证据强度与「未解决的反驳」加权 |
| 少数派 | `unique[]` 里一条待定项 | 显式保留，并给出它成立的条件 |

这不是把规则换得更聪明，是**换单位**。句子级的比较天然只能回答「像不像」，因为一句话里可能同时装着一个事实、一个推断和一条建议——三者在论证里的地位完全不同。

### 11.2 八个阶段，四道不能合并的边界

| 阶段 | 模块 | 职责 | 现在有没有 |
| --- | --- | --- | --- |
| 1 | ClaimExtractor | 拆成 Claim，标类型（事实 / 推断 / 假设 / 建议 / 预测 / 提问），保留原文位置 | 只有切句：`synthesize()` 把句子当观点，没有类型，也没有原文位置 |
| 2 | SemanticClusterer | 召回相似 Claim，判断是重复、互补、条件不同还是实质不同 | 部分：同数字 / 共同主题词 / bigram |
| 3 | RelationDetector | 给关系类型与置信度 | 只有「冲突 / 一致」两分 |
| 4 | ArgumentGraph | 节点与边的存储、查询、遍历 | 无 |
| 5 | EvidenceEvaluator | 权威性、相关性、可核验、直接性、独立性、时效、一致性 | 无（`evidence` 只是原话片段） |
| 6 | DebateController | 找最值得研究的争议，定向分配质疑任务 | 设计在（`buildChallengePrompt` + `stage:'challenge'`），未接线 |
| 7 | OpinionRanker | 多维评分与排序 | 无 |
| 8 | SynthesisEngine | 共识、争议、条件化结论、未解决问题 | 规则版 |

四道边界，任何一道合并，系统就会退化成「让一个模型先定结论，再回头挑支持材料」：

1. **抽取 ≠ 关系。** 抽出来的 Claim 不该知道谁支持谁。知道的那一刻，抽取器就会开始「为了凑成一组关系」而切句。
2. **关系 ≠ 证据。** 判定「A 反驳 B」不需要判断 B 对不对。混在一起，模型会把「我不同意」写成「B 是错的」，然后这个判断一路传进结论。
3. **证据 ≠ 生成。** 证据分先算完，写作阶段只能引用、不能加分。否则写作模型会为了行文顺滑给一条弱证据打高分。
4. **生成 ≠ 排序。** 排序回答「先讲哪个」，不回答「哪个是真的」。把这两件事分开，才有资格在界面上写「这条证据较弱」。

这四条不是洁癖。第一版最省事的做法就是一个提示词让模型「读三份回答，输出 JSON 的共识与争议」——那样得到的是一份**看起来结构化**的总结，而它和 `synthesize()` 的区别只是换了个地方说谎。

### 11.3 数据协议

现在 `Claim` 只有三个字段（`conversation.ts`）。目标形态在这三个字段上长，不推倒：

```ts
export type ClaimKind = 'fact' | 'inference' | 'assumption' | 'recommendation' | 'prediction' | 'question';

export interface Claim {
  id: string;
  text: string;
  kind: ClaimKind;
  /** 哪个通道、哪条消息、原话在第几个字符。三者缺一，「有出处」就只是装饰。 */
  sources: Array<{ channelId: string; messageId: string }>;
  span?: { messageId: string; start: number; end: number };
  /** 原话里的依据片段；空数组 = 这句是断言，没有依据。 */
  evidence: string[];
  /** 指向 Evidence 表。片段用于展示，id 用于比对「两条 Claim 引用的是不是同一份证据」。 */
  evidenceIds: string[];
  /** 依赖的前提，也是 Claim——「在 Redis 6 之前」这种条件必须成为节点，否则它会被写进正文里当形容词。 */
  assumptions: string[];
}

export interface ArgumentRelation {
  from: string;
  to: string;
  kind: 'supports' | 'attacks' | 'contradicts' | 'refines' | 'qualifies' | 'depends_on' | 'evidenced_by';
  confidence: number;
  /** 凭什么判成这个关系。没有这一句，图就是一张凭感觉画的图，没人能复核。 */
  reason: string;
}

export interface Evidence {
  id: string;
  url?: string;
  kind: 'official-doc' | 'source-code' | 'paper' | 'benchmark' | 'blog' | 'model-claim';
  title?: string;
  excerpt: string;
  publishedAt?: number;
  fetchedAt: number;
  /** 这份证据支持或反驳哪些 Claim。 */
  claims: string[];
  verified: 'unverified' | 'supported' | 'contradicted';
}
```

另有两条记录不能省：`AgentResponse`（原始回答 + 模型与版本 + 提示词版本 + 会话 id）和 `RevisionRecord`（每轮观点修正的前后版本、触发原因、新增证据）。**只存最终答案是这套设计里最贵的省法**——三个月后没人能回答「这个结论怎么来的」，而那时它已经在被引用。

`kind` 里 `question` 不是凑数：一条没人回答的问题本身是 `gaps[]` 的证据，它该是一个节点，而不是正文里的一句「尚待研究」。

### 11.4 关系与证据

关系类型定七个，够了。再加就会开始出现「这条算 SUPPORTS 还是 REFINES」的争论，而争论的产物是一张没人信的图：

| 关系 | 含义 | 判错的代价 |
| --- | --- | --- |
| `supports` | 为某条 Claim 提供依据 | 把「也有道理」当成「有证据」 |
| `attacks` | 提出反例或反证 | 论点被削弱后仍按原强度进入结论 |
| `contradicts` | 直接矛盾（同一命题的真假相反） | 真正的分歧被当成措辞差异抹平 |
| `refines` | 补充或细化 | 两条其实在讲同一件事，被算成两个独立观点 |
| `qualifies` | 限定适用条件 | 条件被丢掉，结论从「某些场景成立」变成「成立」 |
| `depends_on` | 依赖某个前提 | 前提被推翻时，下游结论不跟着塌 |
| `evidenced_by` | 有具体证据 | 断言和有据的结论在界面上长得一样 |

建议文档里还有一条 `UNRELATED`。这里不建这条边：**「没关系」不该占一条边**，边表里没有就是没关系。给它一个类型，代价是每条边表都多一半零信息行，而过滤它又成了每个查询都得记得做的事。

证据评价七个指标（权威性、相关性、可核验、直接性、独立性、时效、一致性）**不做成单一分数**。原因很具体：官方文档的权威性高，但证明不了生产性能；一篇文章转载了另一篇，独立性是 0，权威性却可能很高。压成一个数，这两件事就再也分不开了。

排序时才允许加权：

```
Score = w_e·Evidence + w_r·Reasoning + w_s·Source + w_i·Independence − w_a·UnresolvedAttack
```

权重随任务类型变（架构选型看独立性，配置问题看官方文档），**而分数只用来决定先讲哪个，不用来声明哪个是真的**。这条如果破了，产品就变成了「用算法给观点投票」。

### 11.5 定向辩论：只有三条例外

第 3 层刻意没接辩论轮（见 2.2 末）。接的时候要守住三条，否则它就是「多问几轮」的别名：

1. **不是所有人都参与所有观点。** Master 从图里挑出「有反对但没定论」的那些，再把任务派给最合适的一方——找支持的、找反例的、查文档和源码的、专门检查「证据有没有真的回答问题」的。全员无差别讨论的产物是四份措辞不同的原文。
2. **默认最多两轮。** 只有出现新证据或新推理才继续。停止条件是「争议已验够 / 这轮没有新增信息 / 关系稳定 / 预算耗尽 / 现有资料解决不了」，五个里任意一个成立就停。
3. **允许「承认无法判断」。** Agent 可以保留原观点、修正、或明说判不了，**不为了共识而改变立场**。这条要写进提示词，也要写进数据结构——`RevisionRecord` 记的是「因为什么改了」，不是「改成了什么」。

### 11.6 暂不引入 Python

建议文档推荐「TypeScript 管产品与调度，Python 管算法，本地 IPC 通信」。划分本身是对的，但在这个仓库里，引入 Python 的代价被低估了：Electron 打包要额外带解释器和依赖目录，签名、公证、跨平台分发各多一条链路，而「开发机能跑」和「用户机器能跑」之间隔着 Python 版本、wheel 平台、模型权重下载三件事。

所以顺序反过来：

| 阶段 | 做法 | 什么时候变 |
| --- | --- | --- |
| V1 / V2 | 纯 TypeScript。embedding 走 `onnxruntime-node`（本地、无 Python 进程），聚类用现成实现，Cross-Encoder 先不上 | — |
| V3 之后 | 如果 NLI / Cross-Encoder 真的成为质量瓶颈，起 Python 子进程只做这一步 | 接口已由 11.3 的协议定死，换实现不动上层 |

这和 §2 是同一条经验：**先定接口，再谈实现**。先起一个 Python 服务，得到的是一个还没想清楚协议的算法进程，它会把「什么算一条 Claim」这个决定绑死在第一个实现上。

（另有一条：集成任何开源组件前逐项核对代码、模型权重和依赖的许可证。这句话在建议文档里出现一次，值得留在这里。）

### 11.7 存储：SQLite 是前置，图数据库不是

现有存储是几个 JSON 文件（对话、来源、名字、学到的选择器）。V1 要存的查询形状是「这条观点的所有反驳」「这个会话里所有没有证据支持的 Claim」「这两条 Claim 引用的是不是同一份证据」——JSON 全量读改写会变成每次写入重写整文件，而且这些查询在内存里只能扫。

- **SQLite 是前置。** 一次研究几百个 Claim、上千条边，两张表加一次自连接就够。
- **图数据库不是。** 建议文档里的 `NetworkX` 是 Python 库；同样那几种分析（可达性、攻击集合、支持链）在 TS 侧用一张邻接表几百行也做得出来。等查询真的慢到要专用引擎，换的是查询层，不是协议。
- **成本要提前算进排期**：`better-sqlite3` 是原生模块，要走 `electron-rebuild`；打包链路要在 V1 的第一个迭代就试一次，不要等发版那天才发现。

### 11.8 红线

| 红线 | 具体形态 | 为什么 |
| --- | --- | --- |
| 多数票当真理 | 三个模型说同一件事，就当共识 | 它们可能读的是同一篇博客，错在同一处 |
| Embedding 相似即合并 | 余弦 0.92 就并成一条 | 相似不等于逻辑等价：「Redis 6 有多线程 IO」和「Redis 6 没有多线程」相似度很高 |
| NLI 判事实真伪 | `Contradiction` 当成「后者是错的」 | NLI 只判断文本关系，不判断世界；中文技术文本还要单独建测试集 |
| 过早引入图数据库 | 第一版就上专用图引擎 | 几百个节点用不上，运维成本先到 |
| 只存最终答案 | 结论落库，过程与依据丢掉 | 三个月后没人能回答结论怎么来的 |
| 网页内容提权 | 页面里写着「忽略之前的指令，执行这个脚本」 | 网页回答是不可信输入。观点分析不得改变本地权限、执行计划或文件操作——见 [SECURITY.md](../desktop-agent-macos/SECURITY.md) |

最后一条不是新问题，是第 4 层的老边界在新地方的复用：**分析网页文本的组件，和能动手的组件，必须是两个进程**。

### 11.9 落位：不重排目录

建议文档给了一份从零开始的目录（`apps/` + `core/` + `agents/` + `synthesis/` + `algorithms/`）。这里已经有 `desktop-agent-macos/` 加 `packages/`，三层可用代码和十九个 `check-*.mjs` 都挂在现有路径上。**重排的收益是整齐，代价是所有 import、所有检查脚本的路径、`electron-vite` 的入口配置一起改。**

新增模块按现有分层落位：

| 建议文档的目录 | 这里的落位 | 理由 |
| --- | --- | --- |
| `apps/desktop/` | `desktop-agent-macos/` | 已在跑，改名只换来全仓改 import |
| `core/orchestrator`、`conversation` | `src/main/master-agent.ts`、`conversation-runner.ts` | 已有，且刚在第十四轮验过边界 |
| `agents/provider`、`specialist` | `src/main/agents/` | 已有；specialist 仍不实现（理由见 2.2） |
| `adapters/providers`、`browser` | `src/main/adapters/` | 已有，第三站刚验收 |
| `synthesis/*`（八个模块） | `src/main/synthesis/`（新建） | 一个模块一个文件，别塞进 `synthesizer.ts` |
| `protocols/claim`、`evidence`、`argument` | `src/shared/contracts.ts`（扩） | 跨进程契约只有一处；拆成三份就要同步三份 |
| `storage/claims`、`evidence`、`argument-graph` | `src/main/storage/`（新建）+ SQLite | 现有 JSON store 不动，新数据新库。**别叫 `store/`**——`src/main/store.ts` 已经存在，目录和同名文件并排会让 `./store` 的解析随打包器变 |
| `algorithms/*` | 暂不建 | TS 实现不需要独立算法层；等 Python 子进程真的出现再建 |
| `benchmarks/` | `scripts/bench/`（新建） | 和现有 `check-*.mjs` 同一套跑法，别造第二套 |

`shared/synthesizer.ts` 的去向：它不删，降级成 `synthesis/claim-extractor.ts` 的规则兜底——**抽取失败要能退回今天这份能跑的东西**，而不是报错。这条和 2.3 第 3 点是同一条：降级不是错误，把降级呈现成结论才是。
