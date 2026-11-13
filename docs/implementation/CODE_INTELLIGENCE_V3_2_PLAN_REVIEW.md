# V3.2 Agentic Search Reliability 方案审核

> V3.1 的重新审核见 `CODE_INTELLIGENCE_V3_1_REREVIEW.md`；当前执行主线以 V3.2 为准。

- 审核对象：`/Users/yalla/Downloads/制定辩论主题方案 (10)-20261113-1618-2.md`
- 当前代码：`0.2.0-v3` / `2ec1b3f`
- 审核日期：2026-11-13
- 上一轮：`CODE_INTELLIGENCE_V3_1_IMPLEMENTATION_REVIEW.md`

---

## 1. 结论

**V3.2 方向通过，建议批准为当前专项；但编码前必须补 6 个接口/状态定义。**

V3.2 的取舍正确：

- 不继续堆工具；
- 先把预算、强制收束、Provider Tool Contract、状态机、异常/取消做稳；
- Gate 1A Symbol Identity 独立做；
- Gate 3～5 后置；
- 明确不新建 Runtime、不重做 Generation v5。

这与当前代码的缺口吻合。当前 `askWithReadTool` 已有 4 轮，但：

- 没有统一预算对象；
- 预算耗尽后没有 Runtime 强制收束；
- 没有正式 Tool Contract；
- 没有 `FINALIZING` 状态；
- 工具异常/空响应/非法 JSON 主要靠上层兜底；
- Web-only 仍只有设计，没有产品路径。

**建议批准范围**：V3.2 的 Gate 2A（预算/收束）、2B（Tool Contract）、2C（状态机）、2D（Web 降级）；Gate 1A 独立；Gate 3～5 暂缓。

---

## 2. 计划做得好的部分

- 把“预算耗尽”作为 P0，而不是继续加工具；
- 明确硬预算与软预算；
- 明确 Token 估算不能冒充真实用量；
- 明确 `FINALIZING` 不能突破已耗尽预算；
- 明确非法 JSON、未注册工具、非只读调用要拒绝；
- 明确 Web-only 只消费本地冻结证据；
- 明确 Generation v5 固定读取，不允许同一搜索跨代；
- 明确 Gate 2 完成后再扩 30 问题/3 工程；
- 明确 V3.2 完成不等于 Gate 3～5 完成。

---

## 3. 编码前必须补的 P0

### P0-1：预算耗尽后的“确定性报告”没有定义

计划说：

- 预算耗尽进入 `FINALIZING`；
- 如果最终模型请求也无法执行，使用 Runtime 生成结构化降级报告。

但没有定义：

- 报告由谁生成；
- 没有模型时 `summary` / `findings` 从哪来；
- 如何从已有工具结果中提取 findings；
- 如何标注“已验证 / 推断 / 未验证”；
- 如何避免 Runtime 把工具输出拼成一段像结论的文字。

**建议**：

- 新增 `deterministicFinalReport()`：只读取 `SearchState.evidence`，按工具结果生成：
  - `summary`：已执行哪些检索、覆盖哪些文件；
  - `findings`：每条只写“某文件某行包含某符号/文本”，不推断业务结论；
  - `unresolvedQuestions`：原问题中未被证据覆盖的部分；
  - `warnings`：预算耗尽、工具失败、非法 JSON 等；
- `findings.confidence` 只能是 `source-confirmed` / `unknown`，不能给推断打分；
- 报告状态必须是 `BUDGET_EXHAUSTED`，不能写 `COMPLETED` 成功。

**关闭标准**：模型空响应、非法 JSON、工具全失败、预算耗尽四种情况都能生成报告，且不含编造结论。

### P0-2：Token 预算与 Provider 实际能力没有对齐

计划要求 `maxInputTokens/maxOutputTokens=20000`，但当前：

- `ModelRequest` 只有 `question/context/system/timeout`，没有 token 上限；
- Provider 不统一返回 usage；
- 本地 Ollama 有 `eval_count`，云端可能返回 usage，Web 没有；
- `maxOutputTokens` 对 OpenAI 兼容接口需要 `max_tokens`，现有 Provider 未暴露。

**建议**：

- D0.4 明确：
  - 每个 Provider 是否支持 `max_tokens` / `max_output_tokens`；
  - 是否返回 usage；
  - 不返回时如何 `estimated` 标注；
- 预算管理器按“真实用量优先、估算兜底”记录；
- 不允许用字符数伪装成真实 Token；
- 20,000 只是建议值，5 问题云端的实际输入已达 5k–10k/题，必须校准，不能直接当产品默认。

### P0-3：Evidence Store 与 Gate 4 的边界不清

计划多处写“Evidence Store / Evidence Pack”，但 Gate 4 仍 DEFERRED。

当前已有：

- `EngineeringEvidence`（文件片段、sha、行号）；
- `RetrievalItem`；
- `TraceRecorder` 的 step；
- 没有持久化 Evidence Pack。

**建议**：

- V3.2 不新建持久化 Evidence Store；
- 搜索状态里只保存 **临时 EvidenceRef**：`path + line + contentHash + toolCallId + generation`；
- 复用 `EngineeringEvidence` / Trace 的记录方式；
- Gate 4 再引入稳定 `evidenceId`、Pack、Claim 关联和 GC；
- 否则 V3.2 会提前长出一套和 Gate 4 冲突的事实模型。

### P0-4：Web-only 的能力描述自相矛盾

计划一方面说：

- “Web 模型支持工具调用：根据已验证能力选择适配方式”；
- 另一方面说 Web-only 只消费冻结证据。

当前代码 `web-channel.ts` 是 `toolCalling: false`，网页模型不能调用本地工具。

**建议**：

- 明确写：**Web 模型永远不直接调用本地工具**；
- Web-only 的固定流程 = 本地预检索/Agentic Search → 冻结证据 → Web 单次回答；
- “Web 模型支持工具调用”改为“Web 端不适用”；
- UI 必须显示“Web 未自主探索，只读取本地冻结证据”。

### P0-5：Runtime 接入点没有落到现有函数

计划说“复用 AgentOrchestrator，不新建 Runtime”，但没有写明：

- 状态机放在 `conversation-runner.askWithReadTool` 内，还是新建 `research/agentic-search.ts`？
- 预算/状态由谁持有？
- `SubAgentPool` / `askGuarded` / `mainCapabilities` / `TraceRecorder` 怎么接入？
- `FINALIZING` 后由哪个函数返回报告？

**建议**：

- 明确 `AgenticSearchRunner` 作为 `conversation-runner` 的内部执行器，不新建进程/调度器；
- 状态机只管理一次工程探索任务；
- 每个工具调用仍走 `mainCapabilities.execute('project.read')` 或扩展后的 `project.explore`；
- Journal 继续用现有 Trace/事件，不新建 Journal；
- Web 模型不进入该执行器。

### P0-6：状态与终止原因需要映射表

计划同时有：

- `AgenticSearchState`: PLANNING/SEARCHING/OBSERVING/FINALIZING/COMPLETED/FAILED/CANCELLED；
- `SearchTerminationReason`: COMPLETED/BUDGET_EXHAUSTED/INSUFFICIENT_EVIDENCE/TOOL_ERROR/TIMEOUT/CANCELLED。

没有说明：

- `BUDGET_EXHAUSTED` 对应 COMPLETED 还是 FAILED；
- `INSUFFICIENT_EVIDENCE` 是否算成功；
- 用户取消时最终报告是否生成；
- 工具错误但已有证据时是 COMPLETED 还是 FAILED。

**建议**：

```
Runtime state     Termination reason          Final report
COMPLETED         COMPLETED                    status=COMPLETED
COMPLETED         BUDGET_EXHAUSTED             status=BUDGET_EXHAUSTED
COMPLETED         INSUFFICIENT_EVIDENCE        status=INSUFFICIENT_EVIDENCE
FAILED            TOOL_ERROR                   status=TOOL_ERROR
FAILED            TIMEOUT                      status=TIMEOUT
CANCELLED         CANCELLED                    status=CANCELLED
```

`BUDGET_EXHAUSTED` 不能显示为“成功完成”，UI 要有“部分结果/预算耗尽”标识。

---

## 4. 工具契约需要补的字段

计划 2B.4 已经比上一版完整，但仍建议补：

```ts
interface EngineeringToolResult<T> {
  success: boolean;
  callId: string;
  toolName: string;              // 新增：审计和 UI 需要
  projectId: string;
  generation?: number;
  argsSummary: string;           // 新增：Trace 回放
  status: 'ok' | 'failed' | 'cancelled' | 'budget-exhausted'; // 新增
  data?: T;
  error?: { code: string; message: string };
  warnings: string[];
  truncated: boolean;
  evidenceRefs: string[];
  durationMs: number;
}
```

同时明确：

- `callId` 重复时拒绝；
- 未注册工具不执行；
- 非只读工具不进入 Agentic Search；
- 参数 Schema 校验；
- 路径范围、密钥过滤、正则超时；
- 结果最大字符数；
- 工具失败保留此前证据，不把整场清空。

---

## 5. 预算与验收建议

### 5.1 初始预算需要重新校准

计划建议：

- 8 轮；
- 20 次工具；
- 20,000 token；
- 120 秒；
- 30,000 证据字符。

当前真实云端一次 5 问题任务单题输入已 5k–10k token；20k 总预算会在 2–3 题耗尽。建议：

- Gate 2A 先按“单题”预算，不是整场 5 题；
- 5 题基准分别记录每题预算；
- 30k 证据字符和 12k 现有上下文预算要统一；
- 120 秒对本地冷加载可能不够，需把“冷加载”与“搜索时间”分开或提高上限。

### 5.2 必须新增的回归用例

- 模型返回空字符串；
- 模型返回非法 JSON；
- 模型返回未注册工具；
- 模型反复请求同一个工具；
- 工具抛错；
- 用户取消；
- 预算耗尽；
- `gpt-oss:20b + business-flow` 不再空壳；
- Web-only 不调用本地工具；
- 固定 Generation 在后台切换后仍读旧代。

### 5.3 验收命令

V3.2 应至少固定：

```bash
npm run typecheck
npm test
npm run build
npm run test:code-index
npm run test:engineering-tools
npm run spike:agentic-search:real
```

`spike` 结果必须区分 PASS/FAIL/SKIP；本地模型失败不能算产品通过。

---

## 6. V3.2 与 Gate 1A 的关系

计划的安排正确：V3.2 先做预算/收束/契约；Gate 1A Symbol Identity 独立。

但要注意：

- V3.2 的 Symbol 工具不能把 `nodeId` 当稳定身份；
- 计划 4.2 已写“暂时用现有节点 ID，但必须标记 provisional”，这点正确；
- Gate 1A 完成前，`FindReferences/FindImplementations` 只能返回候选，不能宣称精确；
- Gate 1A 不要和 V3.2 改同一条执行链路。

---

## 7. 批准范围

| 项 | 建议 |
| --- | --- |
| V3.2 Gate 2A 预算/收束 | **批准**，先补确定性报告 |
| V3.2 Gate 2B Tool Contract | **批准**，先补字段/权限 |
| V3.2 Gate 2C 状态机 | **批准**，先补状态映射 |
| V3.2 Gate 2D Web-only | **批准**，改成“Web 永不直接调用工具” |
| Gate 1A Symbol Identity | 独立批准/实施 |
| Gate 3 Tree-sitter | 暂缓 |
| Gate 4 Evidence Pack | 暂缓，V3.2 不新建持久 Evidence Store |
| Gate 5 Jury/Judge | 暂缓 |

---

## 8. 最终意见

V3.2 是目前最合理的一版：不扩功能，先把 Agentic Search 做成受治理的 Runtime。

编码前只需要把六件事写死：

1. 预算耗尽后的确定性报告；
2. Token 上限与 Provider 能力；
3. Evidence Store 不越过 Gate 4；
4. Web 不直接调用工具；
5. 状态机接入 `conversation-runner` 的具体位置；
6. `AgenticSearchState` 与 `SearchTerminationReason` 的映射。

这些明确后，V3.2 可以按 Gate 2A → 2B → 2C → 2D 顺序实施；Gate 1A 单独走，Gate 3～5 不提前。
