# Phase 3：论证图与三维裁判

对应任务书 Phase 3（ArgumentGraph、证据评价、多维裁判）与
AC-08 / AC-09 / AC-10 / AC-11 / AC-12 / AC-13。分支 `0.1.1`，接在 Phase 2 之后。

这一版同样按用户对 Phase 3 的补充要求落地：论证边必须关联轮次与来源对象、
三个维度各自出结论、不用多数投票、`insufficient_evidence` 不等于 `unsupported`、
页面提取器与裁判核心分开提交、补 TF-D-011/012/013 三条用例。

## 交付了什么

| 文件 | 变更 |
| --- | --- |
| `src/main/debate/argument-graph.ts`（新增） | 四种节点、六种边、整场重建、节点上限 |
| `src/main/debate/evidence.ts`（新增） | 证据采集、可核验三档、同源标识、去重、独立来源数 |
| `src/main/debate/judges.ts`（新增） | 逻辑 / 证据 / 反例三维 + 五档合成 |
| `src/main/debate/events.ts`（新增） | 事件流：seq 单调、key 幂等、恢复点 |
| `src/shared/evidence.ts`（新增） | 引用链接结构、URL 归一、跳转展开、内容指纹 |
| `src/main/adapters/browser/page-driver.ts` | `CITATIONS_SCRIPT` + `citations()` |
| `src/main/adapters/browser/page-adapter.ts` | 回答带上 `citations` / `pageUrl` |
| `src/main/debate/types.ts` | `DebateEvidence`、`ArgumentNode/Edge/Graph`、`ClaimJudgment`、`DebateVerdict`、`DebateEvent`；`DebateState.graph/evidence/judgments/verdict/events` |
| `src/main/debate/orchestrator.ts` | 每轮算证据与图；收尾跑裁判；开始/每轮/停止/恢复/完成都记事件 |
| `src/main/debate/claims.ts` | 把主张里的出处草稿一起留下；定义差异（`definitional`）判据 |
| `src/shared/contracts.ts` | `DebateView.verdict?`（`debate:get` 本来就返回状态文件） |
| `scripts/check-debate-graph.mjs`（新增） | 6 条 |
| `scripts/check-debate-judge.mjs`（新增） | 19 条（含 6 条判据收紧用例） |
| `scripts/check-debate-events.mjs`（新增） | 7 条 |
| `scripts/check-debate-regression.mjs` + `fixtures/debate-regression.mjs`（新增） | TF-D-001~010 固定回放，产出报告 |
| `scripts/check-page-citations.mjs`（新增） | 10 条，配 `scripts/lib/mini-dom.mjs` |
| `scripts/fixtures/pages/{chatgpt,kimi,gemini}.html`（新增） | 三家固定 HTML fixture |

## 1. 论证图存的是论证关系，不是意见统计

| 节点 | 从哪来 |
| --- | --- |
| `claim` | 每一轮切出来的主张；句子自带的前提也建成节点（`kind: assumption`） |
| `evidence` | 页面链接，或主张里提到的出处/数字 |
| `challenge` | 一轮里的争议（`DebateDispute`） |
| `judgment` | 裁判对某一条主张的判断 |

| 边 | 由什么产生 |
| --- | --- |
| `supports` | 证据 → 主张 |
| `contradicts` | 两句直接矛盾（factual / evidence_conflict） |
| `qualifies` | 适用范围不同（scope） |
| `rebuts` | 有转向词的反驳（logical） |
| `depends_on` | 主张 → 它自己的前提；判断 → 判断用到的证据 |
| `derived_from` | 质疑 → 两句原话；修订 → 被修订的那句；判断 → 主张 |

每条边都带 `roundIndex`、`rationale` 和 `source`（`messageIds` / `claimIds` /
`disputeId` / `revisionId` / `evidenceId` 至少一项）。用户特别强调过「不要只保存
最终图」：只存最终图的话，「这条反驳是第几轮、由哪两句、哪条争议产生的」就再也
还原不出来，而这正是回溯一条结论凭什么成立时要读的东西。

三个实现上的取舍：

1. **不引入图数据库。** 图就是 `{ nodes, edges }` 两个数组，跟着辩论快照写进
   同一个 JSON 文件（`~/Library/Application Support/thinkfusion-ai/debates/<id>.json`）。
   现有持久化已经能原子写、能恢复，图没有独立生命周期。
2. **每轮整场重建，不做增量合并。** id 由被引用对象算出来（`claim:<claimId>`、
   `evidence:<evidenceId>`），所以重建多少次都是同一张图；好处是主张状态被后续
   决策改写后，节点上的 `status` 不会停在旧值。
3. **节点有上限（5000），超了就记 `truncated`。** 宁可明说「图被截断了」，
   也不让人以为这就是全部；截断时边也跟着只留两端都在的，不产生悬空边。

## 2. 三维裁判：三个结论，不是一个分数

| 维度 | 判据（本地规则） | 输出 |
| --- | --- | --- |
| 逻辑 | 绝对化措辞、推断句没给依据、预测句、同一参与者前后矛盾 | `valid` / `questionable` / `invalid` / `not_applicable` |
| 证据 | 有没有来源、来源能不能核验、链接对不对得上这句、是否同源、是否互相冲突 | `sufficient` / `partial` / `unverifiable` / `absent` / `conflicting` |
| 反例 | 对方是否给出可核验材料、是否只是不同意、是否只是范围问题 | `none` / `limited` / `refuted` |

合成顺序就是优先级，读一遍就能复核（`judges.ts` 的 `combine`）：

1. 有可核验的反证 → `contradicted`；
2. 证据互相冲突 → `insufficient_evidence`；
3. 逻辑不成立 → 有证据时 `partially_supported`，没证据时 `unsupported`；
4. 没有可核验证据 → `insufficient_evidence`；
5. 证据只支持到一部分 → `partially_supported`；
6. 证据充分，但反例只构成限制 / 逻辑仍有瑕疵 → `partially_supported`；
7. 以上都没有 → `supported`。

**`insufficient_evidence` 与 `unsupported` 是两个判断**，理由也不同：

- 没有来源，或只有「官方文档说」而没有链接 → 证据拿不到，判不了（第 4 档）；
- 推理不成立且没有证据 → 这句站不住（第 3 档）。

**没有投票。** 裁判的输入里根本没有「多少人这么说」这一项，整场结论也不按
支持者数量选边。TF-D-011 钉的就是这件事：三个模型说「支持并发写入」且都没给
来源，一个模型说「6.0 之前不支持」并给出官方 release notes 链接——结论是后者，
并标记 `minorityWins`。再加三个人说同一句错话，结论不变。

少数派这个标记来自 `DebateState.minorities`（Phase 0 就有的文本差异判断），
它只用来**描述**「这条结论和多数发言不一样」，不参与判定。规则裁判本身不知道
哪边人多。

## 3. 证据：可核验三档，同源与去重分开

| `verified` | 含义 |
| --- | --- |
| `page-link` | 页面把链接画出来了，地址真实存在，可以点开复核 |
| `reported` | 主张自己说「官方文档 / 源码 / 实测」，页面没给链接 |
| `unverified` | 只有断言或数字 |

「能核验」不等于「内容为真」：`page-link` 只说明这条来源存在于页面上，
它到底支持不支持这句话，仍需人读。所以证据维度把链接与主张做了相关性检查，
对不上的链接不给分。

同源识别与内容去重是两件事，分两个字段：

- `originKey`：地址归一后相同，或内容指纹相同，就是同一份材料。Google / Bing /
  DuckDuckGo / 知乎的跳转包装会展开（不发网络请求，认不出就留空）；
- `duplicateOf`：同一份材料的第二条及以后，`independent: false`，理由写进
  `assessment`。转载是正常行为，只是不能当第二个独立来源。

「独立来源数」按 `originKey` 去重，**不按记录条数**。TF-D-012 的场景：两个网站
引用同一份官方文档，记录两条、来源一个。

### 三家站点当前读什么

文本提取那条链**没动**：仍然是页面驱动读最后一条回答气泡的 `innerText`（去掉
推理过程与站点自己的家具）。这一版只是在同一条气泡上多读一次链接。

| 站点 | 读答案用的 `assistant` 选择器 | 读引用 |
| --- | --- | --- |
| ChatGPT | `[data-message-author-role="assistant"]`、`article .markdown`、`[class*="markdown"]` | 气泡内 `a[href]` |
| Kimi | `.chat-content-item-assistant`、`div.segment.segment-assistant` | 同上（参考资料区就在气泡里） |
| Gemini | `model-response`、`model-response message-content`、`.model-response-text` | 同上（来源 chip 是链接时） |
| DeepSeek | `[data-message-author-role="assistant"]`、`.ds-markdown` | 同上 |

能读到什么、读不到什么：

- 站点把引用画成 `<a href>` → 能读到原始地址；
- 画成按钮 / 自定义属性（部分站点的最新版）→ **读不到**，按「这条回答没有链接」
  处理，不猜、不从文本里编地址；
- 回答里没有外链 → 空列表，不报错。

页面抓取这边（AC-09）有三条硬边界：

1. 只读**最后一条**回答气泡里的 `a[href]`，侧栏、上一条回答、隐藏节点都不读；
2. `javascript:`、`mailto:`、`#anchor` 在页面脚本或归一阶段就挡掉；
3. 读不到就是没有。独立 2 秒超时、失败返回空，绝不影响已经到手的回答——
   引用是来源元数据，不是答案的一部分。

三家站点各有一份固定 HTML fixture，跑的是 provider 配置里真实的 `assistant`
选择器（`article .markdown` / `.chat-content-item-assistant` / `model-response`），
所以站点改结构时这一组会先红。

## 5. 事件流：快照之外留一条「怎么走到这里」的线（AC-14）

状态快照只能恢复到最后一次写盘；事件流能说明那一轮为什么没跑完。所以每场
辩论多存 `events`：`seq` 从 1 单调递增，`key` 幂等。

| 事件 | 什么时候写 | 幂等键 |
| --- | --- | --- |
| `session.created` | 起一场 | `session.created` |
| `round.started` / `round.finished` | 每轮首尾 | `round.started:<index>` / `round.finished:<index>` |
| `revision.recorded` | 每次改口 | `revision:<revisionId>` |
| `verdict.recorded` | 出结论 | `verdict:<verdictId>` |
| `session.stopped` / `session.resumed` | 用户停止 / 恢复 | `session.stopped` / `session.resumed:<n>` |
| `session.completed` | 正常结束 | `session.completed` |
| `session.cancelled` | 异常中止 | `session.cancelled` |

幂等键不是装饰：恢复一场辩论会重跑那个没跑完的轮次，`round.started:2` 会被
写第二次——靠 key 挡掉，事件流才不会因为一次恢复多出一段假的「又开始了」。
用户连按两次停止也不会留下两条 `session.stopped`。

这一版仍然是**快照为主、事件为辅**，没有改成事件溯源：一场辩论最多几十条
事件，把恢复路径重写成「重放事件」换不来收益，反而更容易出错。

## 6. 十条回归：回放断言结构，不断言模型判断（AC-15）

任务书 §14.2 的 TF-D-001~010 做成了固定回放 + 结构化断言：

- 每条用例是一份发言稿（按场景写成），按轮次回放给两位/三位辩手；
- 断言只读结构：关键词还在不在、该判出的争议判出来没有、证据不足时会不会
  硬给结论、多数一致会不会自动变成正确、转载会不会算成两份独立来源；
- 跑完输出报告（`out-test/debate-regression.md`，加 `TF_REPORT=1` 时写
  `docs/reports/DEBATE_REGRESSION.md`）。

这样做是因为真模型同样的输入不保证同样的输出：断言「模型说了 X」的测试第二
天就会红，而且红得没有意义。这一组守的是**链路不会把真话弄丢**——真模型换掉
之后，结构上的退化会先在这里红。模型判断本身对不对，要人工标注集，属 Phase 5。

## 验证

- `npm run test:debate-claims`，13 条：切句与类型、直接矛盾 / 数字冲突 / 范围 /
  定义差异（`definitional`）四类判据、定义相同时不报分歧、挑战指向具体两句。
- `npm run test:debate-graph`，6 条：四种节点与六种边、每条边都有轮次与来源、
  修订连成 `derived_from`、定义差异不连 `contradicts`、重建与序列化一致、
  真跑一场后读盘仍是同一张图。
- `npm run test:debate-judge`，19 条：三维各自出结论且没有总分字段；
  逻辑对但证据拿不到 → `insufficient_evidence`（TF-D-013）；自称有出处但没链接 →
  `unverifiable`；证据充分但推理不成立 → `partially_supported`；有可核验反证 →
  `contradicted`；仅仅有人不同意 → 不构成反例；证据冲突 → `insufficient_evidence`；
  少数派胜出（TF-D-011）；结论里没有票数字段；同源只算一个来源（TF-D-012）；
  页面链接变成可核验证据并展开跳转包装；跑完整三轮后证据、图、结论都在；
  范围争议只限制「没写范围」的那一句；不同适用范围的判断不算前后矛盾、
  真正改口仍判 `invalid`、写了范围的不按改口处理。

### 补充：前后矛盾的判据收紧过（真机跑出来的）

第一次用真模型跑 `assumption` 策略时，「SQLite 不适合高并发」和「SQLite 适合
读多写少」被当成同一位参与者前后矛盾，整场结论从「证据不足」变成「不成立」。
两句说的是不同范围，不是改口。

现在要同时满足：否定词数量不同、**不是同一条发言**、两句都没写适用范围、
去掉否定词之后相似度 ≥ 0.45（真改口约 0.47，不同范围约 0.06）。改了之后
同一场重跑，结论回到 `insufficient_evidence`，逻辑维度为 `valid`。

第二处误判在同一轮里：两个模型互辩时，质疑者常把对方的说法和自己的判断
写在同一条发言里（「你说支持，但它其实不适合」），照字面比就是「前后矛盾」。
「前后」的前提是分两次说，所以同一条发言里的两句不再两两比较。

第三处是整场结论的口径：一场 62 条主张的辩论里 2 条自相矛盾、60 条只是没有
来源，结论原先被写成 `unsupported`——那等于把「判不了」也算成「错」。现在只有
**每一条**被判过的主张都推理不成立时才给 `unsupported`；有相当一部分只是证据
不足时，结论是 `insufficient_evidence`，理由里写明各有几条。
- `npm run test:debate-events`，7 条：事件链完整、seq 单调、key 幂等、连续停止
  只有一条、恢复能跑到完成、老文件没有 `events` 也能写、失败轮次照样收尾。
- `npm run test:debate-regression`，TF-D-001~010 十条，全过并产出报告。
- `npm run test:page-citations`，10 条：三家 fixture 各一条（只读最后一条回答、
  跳过侧栏/隐藏/javascript:、相对地址解析、同一文档多入口去重、跳转展开）、
  空页面、裁剪环境（无 `getComputedStyle`）、URL 归一、Bing base64 展开、
  指纹、非来源地址、条数上限。
- `npm test` 全量通过（含 Phase 1/2 的辩论用例，无回归）；
  `npm run typecheck`、`npm run build` 通过。

逐条验收对照（AC-01~AC-15，含「部分达成」的说明）见
`docs/architecture/DEBATE_ACCEPTANCE.md`。

## 没做的 / 需要注意的

- **真机仍未跑。** Phase 3 的裁判是纯规则，不需要第二个模型，但「一场真实辩论
  跑满 3 轮 + 裁判落盘」还是得有两位能发言的成员。这一版验证时本机 Ollama 没起、
  应用也没开，所以只有测试里那条端到端（脚本化两位辩手，含页面链接）覆盖了
  完整链路；真机上还差一次记录。
- **裁判读不到网页内容。** 它能判断「有没有可核验来源、地址是否同源、这句话
  有没有推理问题」，判断不了「这份文档到底写了什么」。所以它给的是结构判断，
  不是事实核查；`backend: 'rules'` 写死在结论里。
- **只覆盖 `a[href]`。** 有的站点把引用画成按钮或自定义属性，那种读不到——
  读不到就按「没有链接」处理，不猜。
- **Token 与费用预算仍没有。** 三条通道都不报用量（见 AC-07 的说明），只做
  时间与并发；不写估算值，因为估算出来的预算等于没有预算。
- **界面还没有结论面板。** 数据已经在 `debate:get` 的返回里（`DebateView.verdict`），
  渲染留给 Phase 4。
- **会话级 `JudgeEngine`（Phase H）仍存在**，它给的是一段叙述式裁决，与这里的
  逐条主张判定不是同一层：两者 `backend` 分别是 `model` / `rules`，不互相替代。
