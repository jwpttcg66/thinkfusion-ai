# P5 设计书：DMOCA × ECO 硬门禁

**阶段：** P5  
**依赖：** P4 TESTED  
**状态：** TESTED（`test:gtec-p5` 4/4）  
**测试：** `npm run test:gtec-p5`  
**改动：** `shared/dmoca.ts`；编排调用 `applyEcoGateToDecision`。

## 契约

```ts
applyEcoGateToDecision(decision, sufficiency): ParticipationDecision & {
  ecoGate: { sufficiency; formalRolesBlocked: boolean; reason: string }
}
```

规则：

1. `sufficient` / `partial`：formalRolesBlocked=false（partial 时 reasons 追加警告）。  
2. `insufficient` / `stale`：formalRolesBlocked=true；非 userPinned 时参与者截断为 1 人 lead；reasons 追加 ECO 阻断说明。  
3. 不静默改写 userPinned 名单（可保留多人，但 formalRolesBlocked=true）。  
4. 编排在 emit `model.participation.selected` 前调用本函数。

## 测试

1. sufficient 不阻断  
2. insufficient 非 pinned → 1 人 + blocked  
3. stale + pinned → 保留人选但 blocked  
4. partial → 警告但不 blocked  
