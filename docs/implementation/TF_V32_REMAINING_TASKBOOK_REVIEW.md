# TF-V32-05/06/08 任务书审核

- 审核对象：`/Users/yalla/Downloads/制定辩论主题方案 (11)-20261114-0005-4.md`
- 当前代码：`295a9cd`（`main`）
- 审核日期：2026-11-14
- 说明：这是一份 **剩余任务任务书**，不是新的架构计划。审核重点是它能否安全落到当前代码。

---

## 1. 结论

**任务书方向正确，可以作为执行依据；建议先批准 TF-V32-00 和 TF-V32-05-A（契约设计），不要直接全量编码。**

任务书正确识别了当前代码的薄弱点：

- `tc_${round}_${tool}` 形式的 callId 会在多 Agent/同轮次冲突；
- `parseToolRequest()` 对非法 args 的处理过于宽松；
- `project.read` 内部会捕获异常并返回 `ok:false`，外层只看 `catch` 不够；
- Provider 失败和工具失败没有统一的 FINALIZING；
- 状态目前是手工赋值，没有集中 transition；
- 5 题回归不能替代 30 题/3 工程验收；
- 30 题不能由模型自己生成标准答案。

这些判断与当前代码一致。

但任务书里有 **4 个接口/实现顺序问题** 需要先修正，否则 TF-05/06 会重复建设或返工。

---

## 2. 当前代码核对

| 任务书判断 | 当前代码 | 判断 |
| --- | --- | --- |
| callId 使用 `tc_round_tool`，可能冲突 | `conversation-runner` 当前用 `tc_${round}_${request.tool}` | 正确 |
| `parseToolRequest` 可能把非法 args 变成 `{}` | `project-tools.ts` 中 args 不是对象时回退 `{}` | 正确 |
| `project.read` 捕获异常返回 `ok:false` | `executeReadTool` 外层 try/catch 返回 `{ok:false,...}` | 正确 |
| 工具失败不能只靠 catch | 当前 `askWithReadTool` 主要看 throw；`ok:false` 被当普通结果 | 正确 |
| Provider 失败没有统一收束 | `ask()` 抛错会冒泡到成员失败，不生成 SearchReport | 正确 |
| 状态手工赋值 | `finalizeSearch()` 直接设置 `context.state` | 正确 |
| 5 题基准已有 | `scripts/spikes/agentic-search-real.cjs` 已扩到 5 题 | 正确 |
| `business-flow` 仍会空壳 | 最近一次真实跑仍是 `BUDGET_EXHAUSTED` 空壳 | 正确 |
| 30 题/3 工程未做 | 没有 `benchmarks/code-intelligence/v3.2/dataset.json` | 正确 |

---

## 3. 必须先修正的 4 个 P0

### P0-1：`SearchToolResult` 已存在，不能同名新建

当前 `src/main/research/agentic-search.ts` 已有 `SearchToolResult`：

```ts
interface SearchToolResult {
  callId: string;
  toolName: string;
  argsSummary: string;
  status: 'success' | 'failed' | 'denied' | 'timeout' | 'cancelled';
  data?: unknown;
  error?: { code: string; message: string };
  evidenceRefs: SearchEvidenceRef[];
  warnings: string[];
  truncated: boolean;
  durationMs: number;
}
```

任务书又给出一个同名 `SearchToolResult`，字段为 `searchId`、`status: success|failed|rejected` 等。

必须：

- 扩展已有 `SearchToolResult`（增加 `searchId`、`generation`、`mode`），不要新建同名类型；
- 保留已有 `denied/timeout/cancelled` 状态，不要缩成三个；
- 明确 `ToolCall` 为新增类型，与 `SearchToolResult` 分离；
- `EvidenceRef` 已有 `excerpt/contentHash`，继续用。

### P0-2：`parseToolRequest` 的宽松回退必须改，但会破坏旧测试

当前：

```ts
const args = value.args && typeof value.args === 'object' && !Array.isArray(value.args)
  ? value.args
  : {};
```

任务书要求非法 args 拒绝，不允许静默变成 `{}`。

必须：

- `parseToolRequest` 保持“从文本提取一个 JSON”的职责；
- 新增 `validateToolCall(request)` 做严格 Schema；
- 不能把“含 `tool` 字段但 args 非法”的文本当成普通回答；
- 更新现有 `check-engineering-tools` 测试中依赖宽松行为的期望；
- 保留“模型正常回答里偶然出现 `{}`”不被误判的测试。

### P0-3：callId 必须由 Runtime 生成，Trace/Evidence 共用

任务书建议 `tc_<searchId>_<agentId>_<sequence>`，正确。

当前 `tc_${round}_${request.tool}` 不够。

必须：

- `searchId` 来自 `AgenticSearchContext`；
- `sequence` 是 Context 内单调递增；
- 同一 Agent 不同轮次唯一；
- 不同 Agent 同轮次唯一；
- 重复 callId 直接拒绝并记录；
- `TraceRecorder.beginStep` 的 meta 带上 `searchId/callId`；
- `SearchToolResult.callId`、`EvidenceRef.toolCallId` 与 Trace 用同一个值。

### P0-4：工具失败和 Provider 失败要有统一 FINALIZING

当前 `askWithReadTool` 对 `project.read` 的 `ok:false` 仍会继续下一轮；对 `ask()` 抛错则直接抛到成员失败。

必须：

- `result.ok === false` → `ToolResult.status='failed'`，记录 `TOOL_ERROR`；
- 如果已有有效证据 → 可继续有限搜索，最终 `PARTIAL`；
- 如果无证据且无法继续 → `FAILED`；
- Provider 抛错 → 捕获，分类为 `PROVIDER_ERROR`/`TIMEOUT`/`CANCELLED`；
- 所有路径都进入同一个 `finalizeSearch()`；
- 迟到响应在 `CANCELLED` 后不得再写入 Context。

---

## 4. 任务书需要补的接口

### 4.1 `ToolCall` 与 `SearchToolResult` 的 ID 关系

建议：

```ts
interface ToolCall {
  callId: string;      // runtime 生成，唯一
  searchId: string;
  agentId: string;
  round: number;
  toolName: string;
  args: Record<string, unknown>;
  mode: 'native' | 'json_protocol' | 'web_only';
  status: 'requested' | 'validated' | 'rejected' | 'executing' | 'success' | 'failed';
}
```

`SearchToolResult.callId` 必须等于 `ToolCall.callId`。

### 4.2 参数 Schema 必须落到工具

任务书要求工具参数 Schema，但当前只有函数内手写读取。建议：

```ts
const TOOL_SCHEMAS = {
  'fs.stat': { path: { type: 'string', required: true, max: 2000 } },
  'fs.readFile': { path: {...}, offset: { type: 'number', min: 1, max: 1_000_000 }, limit: {...} },
  'fs.search': { pattern: { type: 'string', required: true, max: 200 }, path: {...} },
  'fs.list': { path: {...} }
};
```

校验必须在 `mainCapabilities.execute('project.read')` 之前执行。

### 4.3 Trace 关联

`TraceRecorder` 的 step meta 需要带：

- `searchId`；
- `callId`；
- `agentId`；
- `round`；
- `toolName`；
- `generation`。

否则无法回答“这次结论对应哪次工具调用”。

### 4.4 Provider 能力不要伪造

当前 `ProviderToolCapabilities` 已新增，但没有任何 Provider 真实 native tool call 适配。

任务书要求：

- 没有真实测试 → `UNKNOWN`；
- 不支持 → `UNSUPPORTED`；
- 不能按模型名推断。

建议 TF-05-C 先只实现 JSON 协议和 Web 边界；native 留给实际 Provider 验证，不要在接口层假装完成。

---

## 5. 任务顺序评估

任务书建议：

```
TF-00 基线 → TF-05-A 契约 → TF-05-B 校验 → TF-05-C Adapter
→ TF-06-A 状态 → TF-06-B FINALIZING → TF-06-C 异常
→ TF-08-A 自动化 → TF-08-B 真实模型 → TF-08-C 验收
```

这个顺序正确。

建议额外加一个前置：

- **TF-05-A 先冻结“现有类型扩展表”**，明确哪些字段加到 `SearchToolResult`、`ToolCall`、`TraceMeta`，避免 B/C 阶段反复改类型。

---

## 6. 验收标准评估

任务书的验收项是完整的，尤其：

- `FINALIZING` 后模型/工具计数不再增加；
- `business-flow` 非空壳；
- 30 题不能自动生成标准答案；
- 真实测试与 Mock 分开；
- `estimated/unavailable` 不能伪装成真实 Token。

建议补：

- `SearchToolResult` 与 Trace 的 `callId` 一致性测试；
- 多 Agent 同轮同工具 callId 不冲突；
- 迟到 Provider 响应在取消后不写入证据；
- `result.ok === false` 的 `TOOL_ERROR` 映射测试；
- `native` 未验证时必须是 `UNKNOWN/UNSUPPORTED`，不能 `VERIFIED`；
- 30 题数据集目录与 `projects.json` 的 schema 校验。

---

## 7. 批准建议

| 任务 | 建议 |
| --- | --- |
| TF-V32-00 基线检查 | **立即批准** |
| TF-V32-05-A 契约设计 | **立即批准** |
| TF-V32-05-B 严格校验 | 契约冻结后批准 |
| TF-V32-05-C Provider Adapter | 仅做 JSON/Web；native 按真实测试标 UNKNOWN |
| TF-V32-06-A/B/C | 05-B 后批准 |
| TF-V32-08-A 自动化 | 随任务推进 |
| TF-V32-08-B 真实模型 | 自动化通过后 |
| TF-V32-08-C 正式验收 | 真实测试和 30 题状态明确后 |
| 30 题/3 工程 | 单独准备数据集，本轮不伪造 |

---

## 8. 最终意见

这份任务书可以作为 V3.2 剩余工作的执行依据，尤其是 callId、严格参数校验、`ok:false` 处理和 FINALIZING 这四处，都是当前代码的真实缺口。

但编码前先做两件事：

1. **跑 TF-00，确认当前 HEAD 和调用链**；
2. **冻结 `SearchToolResult`/`ToolCall`/Trace 的扩展表**，不要新建同名类型。

之后按 TF-05-B → 06 → 08 推进。Gate 3～5 继续后置，30 题/3 工程不能由模型自评代替。
