# Goal / TDL / ECO V2.0 验收说明

**分支：** `feat/v3-goal-tdl-eco`  
**日期：** 2026-11-25  

## 完成状态

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| P0 审计 | DONE | `V3-GOAL-TDL-ECO-P0-AUDIT.md` |
| P1 level 树 | DONE | `WorkTask.level` + 种子 L1/L3 |
| P2 真实进度 | DONE | `progressRatioFromRows` |
| P3 ECO | DONE | `shared/eco.ts` + 事件 + UI |
| P4 Cycle | REUSE | GDC |
| P5 DMOCA×ECO | DONE | 参与理由含 ECO 充分度 |
| P6 LT | REUSE | `main/context/` |
| P7 UI | DONE | 树缩进 + 工程上下文 |
| P8 | DONE | `test:eco` + `eco-live.mjs` |

## 自动化

```bash
npm run test:eco
npm run test:dmoca
npm run test:tdl
```

## 真机

```bash
CDP_ENDPOINT=http://127.0.0.1:9333/json node scripts/eco-live.mjs
```

期望：`eco.context.prepared`、L1+L3 upsert、面板「工程上下文」与 L 标签。
