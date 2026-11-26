# DMOCA 验收说明

**分支：** `feat/v3-dmoca`  
**日期：** 2026-11-25  
**原则：** 不另建 Runtime；复用 Orchestrator / CB / GDC / TDL / Journal。

## 阶段完成度

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| P0 审计 | DONE | `V3-DMOCA-P0-ARCHITECTURE-AUDIT.md` |
| P1 参与策略 | DONE | `decideParticipation` + `model.participation.selected` |
| P2 角色/生命周期 | DONE | 角色写入决策；`transitionParticipationLife` |
| P3 贡献协议 | DONE | 事件投影 ModelRun / ContributionArtifact；流式≠final |
| P4 对齐与决策快照 | DONE | ContributionSnapshot / DecisionSnapshot 投影 |
| P5 辩论审核预算 | DONE（复用） | CB `shouldDebatePlan` / `shouldModelReviewExecution` + DMOCA 停止条件 |
| P6 TDL/GDC/UI | DONE | WorkTask 绑定决策字段；主活动区「模型协作」 |
| P7 自动化+真机 | DONE | `npm run test:dmoca`；`scripts/dmoca-live.mjs` → `evidence/V3-DMOCA-LIVE.json` |

## 不可妥协原则核对

1. 不固定三模型：L0 最多 1 人 ✅  
2. 不固定永久角色：按风险分配 roles ✅  
3. 不统一模型内部流程：只适配输出事件 ✅  
4. 流式不当正式贡献：`stream_snapshot` = partial ✅  
5. 不覆盖历史版本：revision + superseded ✅  
6. 不要求同步完成：alignment ready/degraded/blocked ✅  
7. 无实质争议不辩：复用 CB L0 skip ✅  
8. 小任务不强审：L0 modelReview=skip ✅  
9. 高风险预算不足不静默跳过：`shouldStopCollaboration` L3 ✅  
10. 不重复 Runtime：薄层 `shared/dmoca.ts` ✅  

## 自动化

```bash
cd desktop-agent-macos && npm run test:dmoca
```

## 真机

```bash
# 应用已开 CDP 9333
CDP_ENDPOINT=http://127.0.0.1:9333/json node scripts/dmoca-live.mjs
```

期望：`model.participation.selected`、L0 跳过辩论、rules 审核、面板出现「模型协作」。
