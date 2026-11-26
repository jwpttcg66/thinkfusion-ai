# P1 设计书：Goal 与 TDL 分层任务模型加深

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


**阶段：** P1  
**依赖：** P0 AUDITED  
**状态：** TESTED（`test:gtec-p1` 5/5；`test:tdl` 回归绿）  
**测试入口：** `npm run test:gtec-p1`  
**改动范围：** `shared/task-decomposition.ts`、`shared/goal-driven-cycle.ts`（仅 Goal 变更辅助）、`contracts` 必要时扩展事件字段；编排种子调用。

## 1. 问题

薄层已有 `level` 与 L1+L3 种子，但：

- WorkTask 无 `goalId` / `goalVersion`，无法把子任务钉在目标版本上。  
- 无依赖环检测。  
- 无 `skipped` 状态（跳过≠完成）。  
- 种子无 L0 Work 根节点。  
- 缺少 `validateWorkTaskTree` 结构校验。

## 2. 契约

### 2.1 WorkTask 增补

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `goalId` | string? | 绑定工程目标；种子写入 `goal:{workId}` |
| `goalVersion` | number? | 默认 1；目标变更后须重评（P4） |
| `level` | 0\|1\|2\|3 | **必填**（种子写出；旧事件可 infer） |
| `status` | + `skipped` | 跳过必须 `blockedReason` 或显式 skipReason；**不算** completed |

### 2.2 树校验 `validateWorkTaskTree(tasks)`

返回 `{ ok, errors: string[] }`：

1. 非法 parent（指向不存在 id）  
2. 依赖环  
3. L0 至多一个（同一 workId）  
4. L3 若有 parent，parent.level < 3  
5. 完成态必须有 evidence（沿用 applyWorkTaskStatus）

### 2.3 依赖环 `hasDependencyCycle(tasks): boolean`

拓扑 / DFS；环则 true。

### 2.4 Goal 变更记录（最小）

扩展已有 `classifyGoalChange`：增加 `applyGoalVersionBump(previousVersion, kind)` → change 时 +1，clarify/optimize 不变。不新建第二套 Goal store；事件仍走现有 goal.fit / 投影。

### 2.5 种子 `seedWorkEventsFromPlan`

顺序：

1. `work.breakdown.created`  
2. L0 Work 根 `wt-work-{workId短}`  
3. L1 组 parent=L0  
4. L3 步骤 parent=L1，带 goalId/goalVersion/cycleId?

## 3. 非目标

- 不做加权进度（P2）  
- 不做 ECO（P3）  
- 不改 UI（P7）

## 4. 测试用例（先红后绿）

1. `skipped` 不进入 completed 计数（配合 progress 只认 completed+acceptanceMet）  
2. 依赖环 `hasDependencyCycle` = true  
3. `validateWorkTaskTree` 捕获悬空 parent  
4. 种子含 level 0、1、3 且 goalId 一致  
5. `applyGoalVersionBump`：change → +1；clarify → 不变  

## 5. 验收

```bash
cd desktop-agent-macos && npm run test:gtec-p1
# 既有 tdl 套件仍绿
npm run test:tdl
```
