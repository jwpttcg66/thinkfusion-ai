# TF-V32 剩余任务基线报告

- 日期：2026-11-14
- 分支：`main`
- HEAD：`295a9cd`（工作区另有本轮未提交修改，提交后更新）
- 范围：TF-V32-05 / 06 / 08

## 1. 当前调用链

```
conversation-runner.handle
  → orchestration.members
    → askWithReadTool(target, { searchContext })
      → askSafe / askGuarded
      → parseToolRequest
      → validateToolArgs
      → mainCapabilities.execute('project.read')
      → SearchToolResult + EvidenceRef
      → SearchBudgetManager
      → finalizeSearch / deterministicFinalReport
```

## 2. 已实现

- Generation v5 原子快照；
- 不完整扫描保留旧文件；
- Agentic Search 4→8 轮；
- SearchBudgetManager：轮数/工具/Token/时间/证据字符；
- deterministicFinalReport；
- 状态/终止原因/报告状态映射；
- Web-only 本地证据边界；
- 稳定 `symbolId`（文件移动后不变）；
- 敏感文件拒绝；
- 5 问题 harness。

## 3. 本轮新增

- `ToolCall` / `ToolCallStatus` / `nextToolCallId`；
- `validateToolArgs` 严格参数校验；
- `parseToolRequest.invalidArgs`；
- `transitionSearchState` 集中状态转换；
- `askSafe` 统一 Provider 错误收束；
- `result.ok === false` 的无证据 FAILED；
- Trace meta 带 `searchId/callId/toolName/round/generation`；
- 安全测试与 Tool Contract 测试。

## 4. 测试命令

```bash
npm run typecheck
npm run test:code-index
npm run test:engineering-tools
npm run test:agentic-search
npm test
npm run build
```

## 5. 未完成

- Provider 原生 Tool Calling 未做真实验证；当前只支持 JSON 协议，native 应标 `UNKNOWN`；
- 30 问题/3 工程人工标注集未准备；
- `business-flow` 产品级真实回归未重跑；
- Gate 3～5 未开始。
