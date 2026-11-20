# D 阶段：旧架构退出审计

日期：2026-11-20。
方法：只审计当前任务涉及的文件与调用链；不重做项目基线。
原则：先有调用链证据，再删除；仍需回滚的路径保留。

## 1. 调用链结论

| 模块 | 生产调用方 | 结论 |
| --- | --- | --- |
| `collaboration/strategy.ts` | `collaboration/runner.ts` | 保留：legacy sequential/all-selected/smart 回滚路径 |
| `collaboration/runner.ts` | `conversation-runner.ts` | 保留：legacy 策略执行 |
| `debate/orchestrator.ts` | `conversation-runner.ts` | 保留：Debate 主流程仍在；待 active 稳定后移除入口 |
| `synthesis/lead-prompt.ts` | 仅 `check-fusion.mjs` | **已删除**：无生产调用方，且属于固定提示词 |
| `shared/protocol.ts buildInitialPrompt` | AgentOrchestrator | 保留：执行规划仍用；P1 迁移项，未完成前不删 |
| `synthesis/lead-selector.ts` | 生产 `pickLeadLocally` | 保留：仍被调用 |
| `evidence-pack` 的 `debateId` | 现有 Pack | 保留：旧数据兼容；新数据走 ownerType |
| `debate/prompts.ts` | — | 已删除（此前） |

## 2. 本次删除

- `src/main/synthesis/lead-prompt.ts`；
- `check-fusion.mjs` 中对应的两个固定提示词测试。

删除依据：

```text
grep -rn "lead-prompt|buildLeadPrompt|LEAD_SYSTEM" src
→ 0 生产引用
```

## 3. 暂不删除

| 模块 | 原因 |
| --- | --- |
| legacy `strategy/runner` | 默认模式仍是 legacy，必须保留回滚 |
| Debate 主流程 | 尚未切 active 默认，删除会破坏现有会话 |
| `buildInitialPrompt` | 执行规划迁移未完成 |
| `debateId` 旧字段 | 旧 Pack 仍需读取 |

## 4. 验证

- `npm run build:test` 通过；
- `check-fusion` 20/20；
- 全仓无 `lead-prompt`/`buildLeadPrompt`/`LEAD_SYSTEM` 引用。

## 5. 后续退出条件

1. active 成为默认且稳定；
2. 旧策略调用统计为 0；
3. 回滚演练通过；
4. 再删除 `strategy/runner` 与 Debate 主入口。
