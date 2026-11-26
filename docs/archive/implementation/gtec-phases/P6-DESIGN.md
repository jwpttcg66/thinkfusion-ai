# P6 设计书：长任务检查点挂接 ECO 版本

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


**阶段：** P6  
**依赖：** P5 TESTED  
**状态：** TESTED（`test:gtec-p6` 3/3）  
**测试：** `npm run test:gtec-p6`  
**原则：** 不改 LT ContextCheckpoint 核心 schema（避免破坏现有契约测试）；用 ECO 侧引用辅助 + evidenceRefs 约定。

## 契约

```ts
EcoCheckpointRef { contextPackageId, contextVersion, sufficiency, goalVersion? }
toEcoEvidenceRef(ref) → `eco-context:{id}:v{n}:{sufficiency}`
parseEcoEvidenceRef(s) → EcoCheckpointRef | null
isEcoRefCompatible(saved, current) → boolean
  // false if id 不同 or current.version < saved or current.sufficiency stale
```

## 测试

1. round-trip encode/parse  
2. 版本回退 / stale → incompatible  
3. 同 id 更高 version → compatible  

## 验收：`npm run test:gtec-p6` + `npm run test:context-contracts`（若可）
