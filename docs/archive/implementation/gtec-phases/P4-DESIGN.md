# P4 设计书：Cycle 与 WorkTask 绑定

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


**阶段：** P4  
**依赖：** P3 TESTED  
**状态：** TESTED（`test:gtec-p4` 3/3）  
**测试入口：** `npm run test:gtec-p4`  
**改动：** `shared/goal-driven-cycle.ts` + `shared/task-decomposition.ts` 辅助；不改 GDC 状态机权威。

## 1. 问题

`WorkTask.cycleId` 字段存在，但投影/绑定 API 缺失：无法从 cycle.snapshot 回写任务、无法列出「某 cycle 下的子任务」。

## 2. 契约

```ts
bindWorkTasksToCycle(tasks, cycleId): WorkTask[]  // 给未绑定任务写入 cycleId
tasksForCycle(tasks, cycleId): WorkTask[]
projectCycleTaskBinding(events, workId): { cycleId?: string; workTaskIds: string[] }
```

规则：

- 绑定不改变 status/revision（返回新对象；写入侧另发 upsert）  
- `projectCycleTaskBinding`：取最近 `cycle.snapshot.cycleId`，收集同 work 下带该 cycleId 的 upsert 任务  

## 3. 测试

1. bind 后全部带 cycleId  
2. tasksForCycle 过滤正确  
3. 从事件投影绑定关系  

## 4. 验收：`npm run test:gtec-p4`
