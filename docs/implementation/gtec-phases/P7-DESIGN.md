# P7 设计书：UI 可观察投影契约

**阶段：** P7  
**依赖：** P6 TESTED  
**状态：** TESTED（`test:gtec-p7` 4/4）  
**测试：** `npm run test:gtec-p7`（投影契约，不启 Electron）  
**改动：** 若缺字段则补 `WorkBreakdownPanel` / `CollaborationResultPanel` 所需投影字段；优先测共享投影。

## 要求（主活动区六问）

投影必须能支撑：目标、阶段、参与模型、交付版本、未决问题、下一步 + **ECO 充分度** + **任务树 level/depth**。

## 测试

1. work 事件投影含 L0/L1/L3 depth  
2. eco 投影含 sufficiency 与 gateReason  
3. dmoca 投影在 gate 后 reasons 含 ECO  
4. `computeWorkProgress` ratio 与 panel summary.ratio 方向一致（叶子完成）  

## 验收：`npm run test:gtec-p7`
