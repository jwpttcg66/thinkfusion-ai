# TF-V32 Tool Contract

- 状态：IMPLEMENTED（JSON 协议）；native 为 UNKNOWN
- 代码：`src/main/research/agentic-search.ts`、`src/main/research/project-tools.ts`

## 1. 调用模式

```ts
type ToolCallingMode = 'native' | 'json_protocol' | 'web_only';
```

- `json_protocol`：当前产品唯一实际启用模式；
- `native`：没有逐 Provider 真实验证，标记 `UNKNOWN`；
- `web_only`：Web 不直接调用本地工具，只消费冻结证据。

## 2. ToolCall

```ts
interface ToolCall {
  callId: string;      // tc_<searchId>_<agentId>_<sequence>
  searchId: string;
  agentId: string;
  round: number;
  toolName: string;
  args: Record<string, unknown>;
  mode: ToolCallingMode;
  status: ToolCallStatus;
}
```

`callId` 由 `nextToolCallId(context, agentId)` 生成，Context 内单调递增；不同 Agent、同轮同工具不会冲突。

## 3. 参数校验

`validateToolArgs(tool, args)` 在执行前校验：

- 工具白名单；
- args 必须是对象；
- 必填 `path` / `pattern`；
- 未知参数拒绝；
- path 长度 ≤ 2000；
- pattern 长度 ≤ 200；
- offset/limit 为整数且在上限内；
- `fs.list` 的 path 可选。

`parseToolRequest()` 只负责提取 JSON；args 不是对象时返回 `invalidArgs: true`，由 Runtime 收束为 `TOOL_ERROR`，不再静默变成 `{}`。

## 4. ToolResult

```ts
interface SearchToolResult {
  callId: string;
  searchId?: string;
  toolName: string;
  argsSummary: string;
  status: 'success' | 'failed' | 'denied' | 'timeout' | 'cancelled';
  data?: unknown;
  error?: { code: string; message: string };
  evidenceRefs: SearchEvidenceRef[];
  warnings: string[];
  truncated: boolean;
  durationMs: number;
  mode?: ToolCallingMode;
  generation?: number;
}
```

## 5. 安全

- 复用 `mainCapabilities.execute('project.read')`；
- 路径 realpath + 根目录/附件范围；
- `.env`、`*.pem`、`*.key`、`*.p12`、`*.jks`、`id_rsa`、`id_ed25519`、`credentials` 默认拒绝；
- `fs.search` 跳过敏感文件；
- 只读，不执行 Shell、不写工程、不跑构建脚本。

## 6. 未完成

- 原生 Tool Calling 的 `ModelRequest.tools` / Provider 返回结构尚未接入；
- 没有真实 Provider native tool call 验证，不能标 VERIFIED。
