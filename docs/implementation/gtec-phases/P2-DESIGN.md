# P2 设计书：真实进度计算与任务汇总

**阶段：** P2  
**依赖：** P1 TESTED  
**状态：** TESTED（`test:gtec-p2` 6/6）  
**测试入口：** `npm run test:gtec-p2`  
**改动范围：** `shared/task-decomposition.ts`（进度 API）；不改编排业务路径。

## 1. 问题

`progressRatioFromRows` 仅等权叶子计数，缺少：

- 显式权重（acceptance / 复杂度）  
- 阻塞任务不得因「时间经过」涨进度（无时间因子即可，但需测「状态不变则 ratio 不变」）  
- 动态新增叶子后分母变大、完成率下降  
- 父级汇总：`summarizeProgressByParent`  

## 2. 契约

```ts
computeWorkProgress(tasks: WorkTask[]): {
  ratio: number;           // 0–1
  completed: number;
  total: number;           // 活动叶子
  blocked: number;
  failed: number;
  skipped: number;
  byParent: Record<string, { ratio: number; completed: number; total: number }>;
}
```

规则：

1. 只计 `level >= 2` 且非 cancelled/skipped 为分母。  
2. 完成 = `status===completed` 且 `evidence.length>0`。  
3. 权重：默认 1；`complexity` high/high_risk → 2；可选 `acceptanceCriteria.length` 下限 1。  
4. `ratio = Σ(w_i * done_i) / Σ(w_i)`。  
5. 新增未完成叶子 → total↑ ratio↓（或不升）。  
6. 无时间参数；两次相同 tasks 快照 ratio 全等。

`progressRatioFromRows` 保留为 UI 投影薄封装，内部可委托 `computeWorkProgress` 的叶子视图，或并行维护一致性测试。

## 3. 测试

1. 等权：1/2 完成 → 0.5  
2. 高复杂度权重：完成 low + 未完成 high_risk → ratio < 0.5  
3. 新增叶子后分母变大  
4. blocked 计 total 但不计 completed  
5. 同一输入两次调用结果全等（无时间漂移）  

## 4. 验收

```bash
npm run test:gtec-p2
npm run test:gtec-p1
npm run test:tdl
```
