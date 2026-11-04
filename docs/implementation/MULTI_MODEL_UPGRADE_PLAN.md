# 多模型升级实施计划

依据：`docs/proposals/UPGRADE_PROPOSAL.md`（2026-11-04 归档）第十五章 Phase A–K。
基线：`main@88c27d6` 切出的 `0.1.0`。本文件对应项目书 Phase A 交付清单里的
`docs/implementation/MULTI_MODEL_UPGRADE_PLAN.md`。

阶段编号、名称、验收口径一律照抄项目书，不重新分组、不合并阶段。本文只补三样
文档没写的东西：**每阶段动哪些文件、怎么验、什么情况下不许往下走**。

「已完成」只标有代码或测试证据的，计划中的能力不写成已有能力。

---

## 一、完成度基线

| Phase | 项目书要求 | 实际 | 缺口 |
| --- | --- | --- | --- |
| A 审计 | 7 份文档（5 份 architecture + 2 份 implementation） | **已完成**：5 份 architecture + `MULTI_MODEL_UPGRADE_PLAN` + `RISKS_AND_COMPATIBILITY` + 综合审计 `docs/audits/2026-11-04-upgrade-proposal.md` | 无（真机回归属 B 的验收，不属 A） |
| B Provider 抽象 | 接口 / Registry / 能力 / 错误模型 / 超时取消 / 保留 Web Channel | `types.ts` `registry.ts` `web-channel.ts` + 15 条测试（`db16263`）；真机回归已补，见 `PHASE-B.md` | 未接线（按文档属 Phase E）；其余无 |
| C Ollama | 12 项能力 + 6 条验收 | **已完成**：`ollama.ts` `local-admission.ts` + 17 条回放测试 + 7 条真机测试，见 `PHASE-C.md` | 未接线；9B 未下载；模型运行状态展示缺 UI（属 J） |
| D Cloud | OpenAI 兼容 + key 安全存储 + token/费用 | **已完成**：`openai-compatible.ts` `secrets.ts` + 17 条测试，见 `PHASE-D.md` | 真机未验（无 API Key）；未接线；UI 开关属 J |
| E 执行模式 | 4 模式 + 对话级配置 + 隐私 | **已完成**：`execution/` 三件套 + runner/index/IPC 接线 + 13 条测试 + 两轮真机，见 `PHASE-E.md` | UI 选择器属 J；cloud 模式真机未验（无 Key） |
| F Hybrid | Smart / Parallel / All / Sequential | **已完成**：`collaboration/` 策略与执行器 + 11 条测试，见 `PHASE-F.md` | 真机 sequential 未跑；Token 预算闸门属 K；时间线 UI 属 J |
| G 辩论 | 3 策略 + 角色 + 自动停止 + 恢复 | **已完成**：`debate/` 三件套 + 独立文件存储 + 13 条测试，见 `PHASE-G.md` | 真机辩论未跑（可用成员不足 2）；UI 属 J |
| H Judge | 独立裁决 + 少数派保护 | **已完成**：`judge/` 三件套 + 14 条测试，见 `PHASE-H.md` | 本机无独立模型，接线用规则版并如实标记 |
| I Synthesis | 保留现有 + 6 项新增 | **已完成**：补齐 evidence/ranker/engine、接线 11 条测试，见 `PHASE-I.md` | 远程后端未实现（本轮只做本地）；关系图 UI 未做 |
| J UI | 9 项 | 未开始 | 全部 |
| K 测试 | 17 项场景 + 4 份报告 | 现有 291 条单测 | 全部 |

---

## 二、阶段依赖与硬门槛

```
A ── B ── C ─┐
        └────┴── D ──┐
                    E ── F ── G ── H ── I ── J ── K
```

- **C 与 D 互不依赖**，可以并行，但都要在 E 之前完成（E 的四种模式里有它们）。
- **E 是分水岭**：E 之前系统只是「多了一个能调用的 Provider」，E 之后才是「用户能选」。
  在 E 落位前做 F/J 都是在改一份还没定型的调度路径。
- **F 依赖 E 的配置结构**；**G 依赖 F 的任务记录**（辩论每轮都是一批子任务）。
- **H 依赖 G 的完整记录**，没有记录就没有可裁决的对象。
- **I 依赖 H 的裁决**，否则综合只能回到「按规则聚类」，等于现在。
- **J 跟随 E/F/G/H 逐个解锁**，不做一次性重做 UI。
- **K 贯穿全程**，每阶段跑现有 193 条测试防止回归；17 项场景在 J 之后统一跑。

**硬门槛**（不满足不许进下一阶段）：

| 门槛 | 不满足的后果 |
| --- | --- |
| 每阶段结束 `npm run typecheck` + `npm test` 全绿 | 后续阶段的失败无法归因 |
| 每阶段结束 Web 通道能正常提问一次 | 这是唯一一条会破坏用户日常使用的红线 |
| 未接线的新模块必须有测试覆盖 | 没测试又没接线，等于既不知道对不对也不知道有没有影响 |
| 无法实测的项目写成「未验证」，不写成通过 | 项目书第十九章明确禁止 |

---

## 三、逐阶段计划

### Phase A（已完成，纯文档）

项目书要求 7 份文档，现已补齐：`docs/architecture/` 下 5 份模块审计，
`docs/implementation/` 下本文件与 `RISKS_AND_COMPATIBILITY.md`，另有
`docs/audits/2026-11-04-upgrade-proposal.md` 作为逐条对照代码的综合审计。
每份都能指向具体 `文件:行号`。这一阶段没有改任何 `.ts`。

### Phase B（已完成）

代码在 `db16263`。两件欠账都已补上，记录在 `PHASE-B.md`：

1. **真机回归**：三个已登录通道各问一句 `17 乘 3`，确认提问、取答、综合、
   删除全链路正常，测试数据当场清干净。第一轮发现 Gemini 把提问回显当成
   回答（`containsEcho` 的 40 字门槛放过了一道 39 字的短问题），已加
   `isOwnPromptEcho` 修掉，第二轮三通道都返回 `51`。
2. **差异补记**：项目书写 `type: "local" | "cloud"`，实际是
   `'web' | 'local' | 'cloud'`。网页通道两者都不是，压成两值会让 E 阶段的
   模式判断把 web 误算成 cloud，而 cloud 是允许外发的档位。

### Phase C：Ollama 集成

**新增**

| 文件 | 职责 |
| --- | --- |
| `src/main/providers/ollama.ts` | `OllamaProvider`，实现 `ModelProvider` |
| `src/main/providers/local-admission.ts` | 项目书的 `LocalModelAdmissionController`，并发闸门 + 驻留控制 |
| `scripts/check-ollama.mjs` | 纯逻辑测试，注入假 fetch，不依赖真服务 |

**改动**：`tsconfig.test.json` 的 include、`package.json` 的 test 链、`tsconfig.agent.json`
（若需要单独编 providers）。

**接口映射**（项目书 4.1 的四个端点）

| Ollama | 接口 | 注意 |
| --- | --- | --- |
| `GET /api/tags` | `listModels()` | 只给名称/大小/量化，不给上下文长度 |
| `GET /api/ps` | `health().detail` | 拿「谁在驻留、还剩多久卸载」，是并发控制的依据 |
| `POST /api/show` | `capabilities()` | `model_info` 里的 `*.context_length` 前缀随架构变化（`qwen2.context_length`、`llama.context_length`），必须按后缀匹配，不能写死 key |
| `POST /api/chat` `stream:true` | `stream()` | NDJSON，一行一个对象，要按行切不能按 chunk 切 |
| `POST /api/chat` `stream:false` | `generate()` | 同上，`done_reason` 要透传 |

**六个必须实测、不能假设的点**

1. **取消的真实语义**：`AbortController` 断开 HTTP 之后，Ollama 到底停不停生成？
   验证方式是 abort 后立刻 `GET /api/ps`，看该模型是否仍在 eval。停 → 能力标 `'abort'`；
   不停 → 标 `'give-up'`，和网页通道同一档。不实测就写 `'abort'`，上层会以为取消省了算力。
2. **冷加载超时**：9B 首次加载可能几十秒。所以超时要分三层，不能一个 `timeoutMs`：
   连接 3s、首 token 120s、流式 chunk 间隔 60s。只设总超时，要么冷加载被误杀，
   要么卡死要等两分钟才报错。
3. **上下文长度以谁为准**：配置 8192，模型真实值可能不同。取
   `min(配置, model_info 的真实值)`；超限**报错不截断**——截断会安静地丢内容。
4. **并发上限 1 的实际表现**：第二个请求排队，排满 30s 应返回 `local-busy` 并提示
   「本地模型正忙」，不是无限转圈。这是项目书验收「不会因为并发请求造成无限加载」。
5. **驻留数 1 怎么保证**：切模型前查 `/api/ps`，若有别的模型驻留，先对它发
   `keep_alive: 0` 卸掉再加载。不定这一步，两个 6GB 模型会在 24GB 内存里打架。
6. **模型不存在时的错误**：要能区分「服务没起」和「模型没拉」，前者提示 `ollama serve`，
   后者给 `ollama pull <tag>`。两种情况现在都只会表现为一个 fetch 失败。

**默认值**（项目书 4.2，本机没有 9B 时见下）
主力 `qwen3.5:9b-q4_K_M`、备用 `qwen3.5:4b-q4_K_M`、并发 1、驻留 1、上下文 8192、
生成 2048–4096、地址 `127.0.0.1:11434`。

**验收方式**：`check-ollama.mjs` 覆盖服务不可达、列表解析、NDJSON 分块、abort、
三层超时、并发排队、切换前卸载、context 取 min 八类；真机另做一次（起服务 → 问一句
→ 看流式 → 中途取消 → 查 `/api/ps` 确认已停）。

### Phase D：Cloud API

**新增**：`src/main/providers/openai-compatible.ts`（项目书 5.2 第一阶段只要求 OpenAI
兼容）、`src/main/secrets.ts`（`safeStorage` 加解密）、`scripts/check-cloud.mjs`。

**关键约束**

- Key 只存密文，文件名与日志里只有 provider id；renderer 只拿到 `hasKey: boolean`，
  **任何 IPC 都不返回明文**。项目书验收明确写「API Key 不暴露给 Renderer」。
- Token 统计用服务端返回的 `usage`；流式要显式打开 `stream_options.include_usage`，
  否则流式调用永远拿不到用量。
- 费用单价做成可编辑配置，**不硬编码**——写死在代码里的价目表过期后，估出来的数
  比没有更糟。
- 重试只对 429 / 5xx / 网络错误，指数退避 + 上限；`local-only` 下一次重试都不许发。

### Phase E：统一执行模式

**改动**：`src/shared/conversation.ts`（加 `executionConfig`）、`src/main/master-agent.ts`
（按配置选 Provider 集合）、`src/main/index.ts` + `contracts.ts` + `preload` + renderer
（读写配置）。

**必须裁决的两处语义冲突**（2026-11-04 已定，见第五节）

1. **`local-only` 与 `web` 模式互斥，web 模式保留**。项目书 6.3 说 `local-only`
   禁止向网页 Channel 发送内容，但 `web` 模式的全部内容都发往网页 Channel，
   两者不能共存。裁决：`web` 模式下 `privacyMode` 恒为 `allow-cloud`（网页本来
   就是外发），UI 在 web 模式下不提供 `local-only` 选项，而不是禁用 web 模式。
2. **老会话没有 `executionConfig`**。增加该字段，读到缺失时视为
   `{executionMode:'web', fallbackEnabled:false, privacyMode:'allow-cloud'}`。
   若默认成 `local-only`，老会话一打开就成了违规状态。

**这一阶段只做一件事**：把配置读出来，选 Provider 集合，然后走现有并发路径。
不引入新的调度器，不碰辩论——那是 F、G。

### Phase F：Hybrid Orchestrator

**新增**：`src/main/orchestrator/`（`smart.ts` / `parallel.ts` / `sequential.ts` / `index.ts`）。

- `Parallel` / `All-selected` 复用现有 `Promise.all` 路径，只换成员来源。
- `Sequential` 的新问题是把前序结果塞进下一轮上下文，必须按目标模型的
  `contextTokens` 裁剪；网页通道给的是 `null`，塞多少只能保守估。
- `Smart` 的「智能」先用**可解释的规则**（是否需要实时信息、是否代码类、问题长度），
  不上模型分类。模型分类慢且判错了没人能查；规则判错至少能指着那条规则改。
- 每个子任务独立记录（项目书验收），这是 G 的前提。

### Phase G：多轮辩论

**新增**：`src/main/debate/`（`orchestrator.ts` / `config.ts` / `round.ts` / `roles.ts`）。

**进 G 之前必须先解决存储**：`store.ts` 是单一 JSON journal，每次写入全量重写。
标准辩论 3 模型 × 3 轮 = 每轮新增 3 条消息，每条一次全量重写。文件到几 MB 之后，
每次写都要序列化整个历史。可选项按代价排序：

1. 每天一个 journal 文件（改 `store.ts` 的路径生成，不动读写逻辑）——最小改动
2. 消息改为 append-only NDJSON，索引单独存——需要引入恢复逻辑
3. SQLite——违背决策 9，且 `better-sqlite3` 拖 node-gyp

先按 1 做，实测不够再升 2。**不用 SQLite**。

**其余要点**：自动停止要同时有「轮数上限」和「观点不再变化」两个条件（只有轮数上限
等于永远打满）；用户中止必须能停在中途并保留已完成轮次；少数派观点进 `disagreements`
而不是被合并。

### Phase H：Judge 独立裁决

**新增**：`src/main/judge/`。

- 裁决输入是 G 的完整记录，不是摘要——摘要会丢掉「谁在什么条件下说过什么」。
- 无独立模型可用时允许兼任，但结果里必须带 `judgeSharedWith: string`（项目书决策 5）。
- 输出允许「无法确定」。不允许拿支持数量当正确性依据（决策 7 + 项目书第十九章第 14 条）。

### Phase I：Synthesis 升级

**已有**（未接线）：`shared/fusion.ts`、`main/synthesis/claim-extractor.ts`、
`clusterer.ts`、`relations.ts`。

**待补**：`evidence.ts`、`ranker.ts`、`engine.ts`、`scripts/check-fusion.mjs`。

**接法**：扩 `Synthesis`（`consensus: Claim[]` 保留 `sources`/`evidence`），
**不退化成 `string[]`**。项目书 9.2 的写法与它自己的决策 6、9.3 冲突，已裁决保留 `Claim[]`。
新引擎失败时退回现有 `synthesize()`，不抛错。

### Phase J：前端 UI

按 E→F→G→H 逐个解锁，每解锁一个补一块 UI，不做一次性重做。顺序建议：
执行模式选择（E）→ 模型选择与状态（E）→ 任务时间线（F）→ 辩论轮次视图（G）→
裁决与报告（H/I）→ 预算统计（D）。

### Phase K：稳定性和性能测试

17 项场景按项目书原样跑，产出 `docs/testing/` 四份报告。其中三项必须真机：
Ollama 退出、网络中断、应用重启后恢复。这三项无法用单测模拟。

---

## 四、环境事实（2026-11-04 实测）

| 项 | 实测值 |
| --- | --- |
| 硬件 | Apple M5 / 24 GiB / macOS 26.3 |
| Ollama | 0.33.2，服务**正在运行**（`127.0.0.1:11434` 有响应） |
| 已装模型 | `qwen2.5:7b`、`nomic-embed-text:latest` |
| 项目书推荐模型 | `qwen3.5:9b-q4_K_M` 存在（6.6GB，Apache-2.0），**本机未安装** |

已定：Phase C 用 `qwen2.5:7b` 验证（本机已有，不下载），代码里的默认 tag 仍按
项目书写 `qwen3.5:9b-q4_K_M`，两者靠配置区分，不写死在代码里。9B 等链路跑通后
再按需拉取。

---

## 五、已裁决的冲突（沿用审计报告与 `PHASE-B.md`）

下面四条与 Phase E 的两条语义冲突，2026-11-04 已确认：**保留 web 模式**（即
`local-only` 与 web 互斥，web 下恒 `allow-cloud`）、**增加 `executionConfig`**、
**保留 `Claim[]` 扩字段**、**`type` 扩为三值**。

| 冲突 | 裁决 | 依据 |
| --- | --- | --- |
| 目录 `src/providers/` vs `src/main/providers/` | 用后者 | ARCHITECTURE 11.9；20 个检查脚本按现有路径 import |
| SQLite 是否前置 | 不前置 | `store.ts` 注释：`better-sqlite3` 拖 node-gyp；决策 9 |
| `FinalSynthesis.consensus: string[]` | 保留 `Claim[]` 扩字段 | 决策 6 + 9.3 要求可溯源 |
| 第十章「已有网页提取」 | 降级为「暂无输入源」 | 仓库无 Fetcher/Extractor |
| `type: 'local' \| 'cloud'` | 扩为 `'web' \| 'local' \| 'cloud'` | 网页通道两者都不是 |
| `capabilities.available` | 挪到 `health()` | 能力静态、可用性动态 |
| `supportsCancellation: boolean` | 三态 `'abort' \| 'give-up' \| 'none'` | 网页通道只能「不等了」 |

---

## 六、风险清单

| # | 风险 | 触发阶段 | 影响 | 缓解 |
| --- | --- | --- | --- | --- |
| 1 | journal 全量重写遇到辩论 | G | 每轮写盘变慢，随历史线性恶化 | 先按天分文件，实测不够再 append-only |
| 2 | `local-only` 被 fallback 突破 | E/F | 隐私承诺失效，且无声 | 选 Provider 前先按 privacyMode 过滤，非法组合直接报错 |
| 3 | `web` 与 `local-only` 语义冲突 | E | 写出自相矛盾的配置 | 见 Phase E 裁决 1 |
| 4 | 老会话无 `executionConfig` | E | 老对话打开即违规或崩 | 见 Phase E 裁决 2，默认 web |
| 5 | 网页通道取消被当 abort | E | 上层以为省了配额 | 能力如实标 `give-up` |
| 6 | Ollama 冷加载被首 token 超时误杀 | C | 9B 永远「超时」 | 三层超时，冷加载单独放宽 |
| 7 | `context_length` 写死 key | C | 换模型后读不到，退化成默认值 | 按后缀匹配 + 读不到时标 null |
| 8 | API Key 泄到 renderer 或日志 | D | 明文外泄 | 只走 `safeStorage`，IPC 只回 `hasKey` |
| 9 | 辩论成本失控 | G | 轮数 × 模型数 × 上下文，很快烧完 | 轮数上限 + 预算闸门 + 用户中止 |
| 10 | 把模型数量当正确性 | H/I | 正是项目书红线 | 裁决不读 `support` 计数，少数派强制保留 |
| 11 | 汇总算法提前接线 | I | 在 H 没定型前改综合，返工 | 冻结现状，到 I 再动 |
| 12 | 网页选择器漂移 | 全程 | 通道突然「未就绪」 | 已有「更新样式」入口，不额外做 |

---

## 七、工作区遗留

这些文件已在 Phase I 补齐 `evidence` / `ranker` / `engine` 和测试后一并提交，
并通过 `ConversationRunner.fusionEnabled` 接线。冻结期结束，工作区不再有
未提交算法文件。

---

## 八、执行纪律（项目书第十九章）

每阶段固定六步，一步不省：

1. 给出本阶段实施计划（动哪些文件、怎么验）
2. 实施代码
3. 跑 `typecheck` + `test` + 构建
4. 汇报实际结果（通过的说通过，没跑的写没跑）
5. 列出未完成事项
6. **停下等确认，不自动进下一阶段**

禁止：未执行的测试标通过；计划中的功能描述成已完成；为统一而重写 Web Channel；
把辩论逻辑写进 `MasterAgent` 或 `Synthesis`；无上限并发本地模型；绕过 IPC 安全边界；
明文存 Key；自动突破 `local-only`；以多数意见定真伪；为达成共识删少数派。
