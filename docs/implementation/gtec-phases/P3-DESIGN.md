# P3 设计书：ECO 工程上下文编排实质化

**阶段：** P3  
**依赖：** P2 TESTED  
**状态：** TESTED（`test:gtec-p3` 5/5；`test:eco` 回归绿）  
**测试入口：** `npm run test:gtec-p3`  
**改动范围：** `shared/eco.ts`；编排仅增加 `fulfillContextRequest` 辅助，主路径仍发 `eco.context.*` 事件。

## 1. 问题

当前 ECO 薄层：

- 编排用 plan/workspace 占位当 verified，语义过松。  
- 有 `ContextRequest` 类型与事件，**无** `fulfillContextRequest` / 合并进包。  
- 无 `invalidateContextPackage`（版本变化 → stale）。  
- 无「禁止把 inference 升格为 verified_fact」的显式 API。  
- DMOCA 硬门禁留到 P5；本阶段只把 ECO API 做实。

## 2. 契约

### 2.1 `fulfillContextRequest(pkg, request, resources) → EngineeringContextPackage`

- 合并新 resources（去重 resourceId）  
- 按角色重算 sufficiency  
- `contextVersion += 1`  
- 清除已满足的 unknowns（若 path 出现在 resources）

### 2.2 `invalidateContextPackage(pkg, reason) → EngineeringContextPackage`

- sufficiency = stale  
- missingCritical 含 reason  
- version += 1  

### 2.3 `assertFactClassPromotion(from, to)`

- 禁止 inference/general_knowledge/unknown → verified_fact  
- 禁止 provided_context → verified_fact（除非显式 `allowUpgrade: true` 且调用方已核验——默认 false）

### 2.4 `buildEngineeringContextPackage` 收紧

- 若 resources 中声称 `verified: true` 但 `factClass` 为 inference/unknown → 降为 verified:false 或抛错（选：**规范化降级** + 记入 unknowns）

## 3. 测试

1. fulfill 后 version+1 且 sufficiency 改善  
2. invalidate → stale  
3. 禁止 inference 升格 verified_fact  
4. 构建时伪 verified+inference 被降级  
5. projectEcoFromEvents 仍可读 prepared  

## 4. 验收

```bash
npm run test:gtec-p3
npm run test:eco
```
