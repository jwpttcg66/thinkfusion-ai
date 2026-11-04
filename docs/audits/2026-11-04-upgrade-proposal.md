# 升级项目书审计（2026-11-04）

对象：[docs/proposals/UPGRADE_PROPOSAL.md](../proposals/UPGRADE_PROPOSAL.md)（1,572 行）
审计者：实现层视角，只认代码里能指出来的东西
结论先行：**项目书的方向可行，但有两处前提与仓库不符，一处结构与既有决策冲突，必须在 Phase B 之前裁决。**

---

## 1. 审计方法与覆盖范围

读过的代码（全文或关键段）：

- `src/main/master-agent.ts`（258 行，全文）
- `src/main/conversation-runner.ts`（479 行，头部与依赖定义）
- `src/main/store.ts`（217 行，头部与写入策略）
- `src/shared/synthesizer.ts`（710 行，结构与导出）
- `src/shared/conversation.ts`（189 行，数据契约）
- `src/main/adapters/providers/`（4 个站点适配器，按文件名与规模）

跑过的统计：`src` 全部 15,355 行的目录与行数、42 个 IPC 通道名、20 个 `check-*.mjs`、grep 关键能力（ollama / ModelProvider / apiKey / tokenUsage / privacy / Promise.all）、`sysctl` 硬件。

**没有做的**：没有逐行读 `page-driver.ts`（2,579 行）和 `App.tsx`（1,378 行）。涉及这两处的判断只基于接口与调用点，不推断内部实现。

---

## 2. 现状盘点（项目书 Phase A 要求的 14 项）

| 项目 | 现状 | 位置 / 证据 |
| --- | --- | --- |
| Web Channel | 4 个站点适配器，各自一个 `WebContentsView` + `persist:` 分区 | `src/main/adapters/providers/{chatgpt,deepseek,gemini,kimi}.ts` |
| 多模型并行 | **已实现**：`Promise.all` 同时发给所有可用通道，结果按花名册顺序归位 | `master-agent.ts:189` |
| 调度 | `MasterAgent` 选参与者、分发、收口；`SubAgentPool` 管通道 | 258 行 |
| 会话执行 | `ConversationRunner` 管消息、事件、状态、取消 | 479 行 |
| 持久化 | **单一 JSON journal**，每次变更写临时文件 + fsync + rename | `store.ts`，注释明确写着「v0.6.0 keeps the JSON journal instead of SQLite on purpose」 |
| Synthesis | 规则版：consensus / disputed / unique / gaps / recommendation / degraded | `shared/synthesizer.ts:564` |
| IPC | 42 个通道，全部在 `main/index.ts`；有 `trustedUiSender` 校验 | `main/index.ts` |
| 测试 | 20 个 `check-*.mjs`，上一轮实测 178 条全绿 | `scripts/` |
| Provider 抽象 | **不存在**（grep `ModelProvider` / `ProviderCapabilities` 零命中） | — |
| Ollama | **不存在**（grep `ollama` 零命中） | — |
| 云端 API | **不存在**（grep `apiKey` 零命中） | — |
| Token / 费用统计 | **不存在** | — |
| 隐私模式 | **不存在**（grep `privacy` / `local-only` 零命中） | — |
| 多轮辩论 / Judge | **不存在**，且是明确决定：`master-agent.ts` 注释 「Not implemented, and deliberately so: the debate round」 | — |
| 网页正文提取 | **不存在** Fetcher / Extractor。只有回答文本清洗（`stripChrome` / `normalizeAnswerText`） | `shared/text.ts` |

硬件实测：`Apple M5 / 24GiB / macOS 26.3`，与项目书 4.2 的假设一致。

---

## 3. 逐条判定

### 3.1 与事实不符（2 处）

**(1) 第十章「当前项目已经实现网页内容提取和整理」——不成立。**

仓库里没有任何 Fetcher / Extractor / Readability 类实现。`shared/text.ts` 做的是**从 AI 回答里剥掉页面壳**（侧栏、按钮文案、说话人标签），不是从任意网页抓正文。

这条影响不小：项目书据此写下「本次项目不重新开发 Fetcher 或 Extractor」，于是第十章列出的 10 项要求（长度估算、分块、原文快照、段落 ID、Prompt Injection 防护）**失去了依托对象**。要么承认这块要新建，要么把第十章整章降级为「暂无输入源」。

**(2) 第十三章「必须先审计现有数据库」——没有数据库。**

现有是 JSON journal，不是 DB。这不影响结论，但「数据迁移」四个字在这里意味着一次序列化格式变更，不是 SQL 迁移。

### 3.2 已具备，项目书可以少写

- 多模型并行（1.3 能力矩阵里 Web 列标「视 Channel 能力」，实际已经并行）
- 每个通道独立的失败隔离（一个通道失败不影响其他，`ChannelOutcome` 三态）
- 综合的 `degraded` 语义（无法综合时明说，而不是假装成功）
- 原始回答完整保存（决策 6 已经满足）

### 3.3 全缺，且是真正的工作量

Provider 抽象、Ollama、Cloud API、执行模式、Hybrid 策略、辩论、Judge、Admission、Token 与费用、隐私开关。

按行数估，这些全部是新增，现有代码能直接复用的只有「通道分发」和「事件流」两处骨架。

---

## 4. 必须在 Phase B 之前裁决的四件事

### 冲突 1：目录落位，两份文档给的答案相反

- 项目书：`src/providers/`、`src/orchestration/`、`src/debate/`、`src/synthesis/`、`src/admission/`
- `ARCHITECTURE.md` 11.9：**不重排目录**，落到 `src/main/synthesis/`、`src/main/storage/`

项目书自己也留了口子（「目录仅作为建议，最终以实际仓库架构为准」）。建议按 11.9：`src/main/providers/`、`src/main/debate/`。理由不是怀旧——仓库有 20 个检查脚本按现有路径 import `out/`，重排要同时改 import、脚本路径和 electron-vite 入口。

### 冲突 2：要不要上 SQLite，三份说法互相打架

- `ARCHITECTURE.md` 11.7：「SQLite 是前置」
- `store.ts` 注释：刻意不用 SQLite，因为 `better-sqlite3` 会把 node-gyp 拖进安装链路
- 项目书：没说用哪种，只说「先审计」

这是**已经存在的内部矛盾**，不是项目书带来的。但辩论和证据一旦落库，它就必须先解决。我的判断：**先沿用 JSON journal，等 Claim 数量真的到几百再上 SQLite**；如果提前上，第一个卡住的是打包签名，不是查询性能。

### 冲突 3：`FinalSynthesis` 结构比现在的更弱

项目书 9.2：

```ts
consensus: string[];
disputed: string[];
uniqueInsights: string[];
```

现有 `Claim` 带 `sources[{channelId,messageId}]` 和 `evidence[]`。改成 `string[]` 之后：

- 9.3 要求「每个重要结论关联来源模型、原始发言 ID」——`string[]` 装不下
- 决策 6「原始答案不可丢失」——字符串化之后就丢了定位

这是**结构性倒退**，而且同一个文档里前后矛盾。建议保留现有 `Claim[]`，在其上扩 `kind` / `span` / `evidenceIds`（`shared/fusion.ts` 已经这么做了），不要退回字符串数组。

### 冲突 4：第十章的前提不成立（见 3.1）

「不重新开发」的对象不存在。要么新建，要么整章降级。

---

## 5. 风险清单

| 风险 | 量化 | 说明 |
| --- | --- | --- |
| 24GB 内存 | 模型 6.6GB + 8k KV + Electron + 4 个渲染进程 | `qwen3.5:9b-q4_K_M` 已核实为 6.6GB。项目书提醒过「不能只按权重算」，但没有给出余量目标 |
| 辩论成本 | 4 参与者 × 2 轮 ≈ 每轮 4 份上下文 | 项目书只有「Token 预算」开关，没有量级估算。网页通道免费但有限速，API 通道是真金白银 |
| journal 全量重写 | 每次变更重写整个文件 | 辩论每轮新增 N 条消息，每条一次全量写 → I/O 随消息数超线性增长。这是现有存储与辩论功能的**直接冲突** |
| IPC 继续膨胀 | 已有 42 个通道 | 再加 provider / debate / judge 三组，需要先定命名与校验规范，否则 `main/index.ts`（1,638 行）会变成第二个 master-agent |
| 汇总算法复杂度 | Claim 数量 × 两两比较 | 30–90 条 claim 时 O(n²) 尚可，接上辩论会翻几倍 |

---

## 6. 对实施顺序的建议

项目书的 Phase A→K 顺序合理，但有三处需要调整：

1. **Phase A 的交付物与本仓库已有文档重复。** `ARCHITECTURE.md`（785 行）已经覆盖了架构、边界、红线。再产出 7 份 `docs/architecture/*.md` 大概率是抄一遍。建议改成「审计现有文档与代码是否一致」，只补差异（本次审计即是这样做的）。
2. **冲突 1–3 必须在 Phase B 之前定。** 否则 Provider 会按错误的目录落位、辩论文档会按丢溯源的结构设计。
3. **辩论（Phase G）之前必须先解决存储。** 现有 journal 每写一条消息重写全文件，辩论是它的最坏用例。

---

## 7. 这份审计没有回答的问题

- 4 个站点适配器的**实际并发上限**没有测过（同时发 4 个问题时哪家会限流）
- 现有 IPC 的输入校验覆盖到什么程度，只看到 `trustedUiSender`，没有逐个通道核
- `page-driver.ts` 内部的重试与超时策略没有逐行读
- 项目书 4.3 的 `LocalModelAdmissionController` 与现有 `SubAgentPool` 的职责边界没定，两者都可能变成「谁在管并发」的第二个答案
