# P8 设计书：分场景端到端与真机

**阶段：** P8  
**依赖：** P7 TESTED  
**状态：** DESIGNED  
**自动化：** `npm run test:gtec-all`（P1–P7 串联）  
**真机：** `node scripts/gtec-live.mjs` → `evidence/V3-GTEC-PHASED-LIVE.json`

## 场景（真机至少覆盖 1；其余用自动化等价）

| # | 场景 | 自动化 | 真机 |
| --- | --- | --- | --- |
| 1 | L0 只读：ECO prepared + L0/L1/L3 树 + 完成 | P1/P7 | live |
| 2 | ECO insufficient 门禁截断 | P5 | — |
| 3 | 依赖环拒绝 | P1 | — |
| 4 | 加权进度 | P2 | — |
| 5 | ContextRequest fulfill | P3 | — |
| 6 | Cycle 绑定 | P4 | — |
| 7 | ECO checkpoint ref | P6 | — |

## 验收

```bash
npm run test:gtec-all
# 应用 CDP 9333
node scripts/gtec-live.mjs
```

证据写入 `docs/implementation/evidence/V3-GTEC-PHASED-LIVE.json`。
