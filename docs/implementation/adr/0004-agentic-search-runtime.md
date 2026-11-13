# ADR-0004：Agentic Search 的运行时接入

- 状态：Proposed
- 日期：2026-11-12
- 适用：Gate 0 ADR / Gate 2

## 背景

V2 把 Agentic Search 作为核心，但现有 Runtime 不是开放式工具循环：

- `AgentOrchestrator` 是“提交 → 计划 → 审批 → 执行”的网页任务编排。
- `conversation-runner.askWithReadTool()` 只允许 **1 轮** 额外读取。
- 只支持 `fs.stat/fs.readFile/fs.search/fs.list` 四个只读工具。
- `ModelRequest` 没有 `tools` 字段；Provider 只有 `toolCalling` 能力标志。
- 网页通道 `toolCalling: false`，不能自主搜索。

## 决策

### 协议

- **优先原生 tool calling**：Provider 支持时，使用其 function/tool schema；工具结果作为 tool role 回传。
- **JSON 协议作为本地模型兜底**：沿用 `parseToolRequest()` 的“最后一个配平 JSON”规则，但只允许一个 action/轮，严格白名单，解析失败不重试超过 1 次。
- **网页通道不进入工具循环**：Web 模型只接收冻结的 Evidence Pack，或明确提示“当前模型不能自主搜索”。
- 不把工具指令拼进用户 `question`；工具说明放在 system/tool schema；网页通道看不到工具指令。

### 接入点

- 在 `conversation-runner` 内新增 `askWithEngineeringTools()`，复用：
  - `SubAgentPool` / `askGuarded`；
  - `mainCapabilities.execute('project.read', ...)`（或扩展为 `project.explore`）；
  - `TraceRecorder`、`sink.cancelled()`、现有超时/预算。
- 不新建独立 Agent Runtime、不新建第二套审批/Journal。
- 工具实现放在 `src/main/engineering/tools/` 或现有 `research/project-tools.ts` 扩展；模型循环只负责调度。

### 工具契约

```
EngineeringToolResult<T> {
  success: boolean
  projectId: string
  generation?: number
  data?: T
  error?: string
  warnings?: string[]
  total?: number
  truncated?: boolean
  sourceVersion?: string
  durationMs?: number
  evidence?: EvidenceRef[]
}
```

第一批工具：`listFiles/searchFiles/grepSearch/regexSearch/readFile/readRange/findSymbol/getSymbolContext/getImports/getGitDiff/getGitHistory/findReferences/findImplementations`。

### 预算与终止

- 最大轮数 8（可配置）；单轮结果 30；单文件默认 300 行；总 token/字符预算；墙钟上限。
- 连续两轮无新增证据 → 停止；达到预算 → 停止并说明证据不足。
- 相同 `path+line+contentHash` 去重；同一文件同一版本不重复读。
- 用户取消立即返回已收集证据和限制说明。

### 模型矩阵

| 模式 | 行为 |
| --- | --- |
| 本地 API 模型 | 原生 tool calling 或 JSON 兜底；必须实测工具调用成功率 |
| 云端 API 模型 | 原生 tool calling；按 Provider 能力 |
| 网页模型 | 不进入工具循环；只读冻结证据包，辩论中标注“未自主探索” |

默认本地模型若工具调用不稳定，Core 退回“预检索 + 单次回答”，UI 明确显示，不假装探索。

## Spike 结果（2026-11-12）

`npm run spike:agentic-search` 用确定性脚本模型验证了协议本身：

- 7 轮工具调用，42 条证据，覆盖 Controller → Service → Repository → Database；
- 证据有稳定 ID、文件/行号可复核、重复证据去重；
- 预算/停止条件可执行。

这**不证明真实模型能力**。D0.6 仍需默认本地模型 + 云端模型各跑 3～5 个真实问题。

## 验收

- 5 个真实问题：≥4 个找到期望跨文件组件；关键结论行号准确率 ≥95%；0 条无证据“确定调用”。
- Web-only 配置明确降级。
- 与“一次性预检索 + 单次回答”基线对比，正确率提升且成本可接受。
- 工具调用、重试、去重、终止、取消都有测试。
