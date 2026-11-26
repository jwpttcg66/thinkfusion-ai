# V3 架构一致性整改：P0 批次验收记录

**批次：** P0-01 ~ P0-05（2026-11-26）
**基线：** `main@ac832a9` → 本批次 `14331d4`
**范围：** ECO 正式角色门禁、TDL L2 自动分解、Goal→WorkTask 版本绑定、
恢复 ECO 门禁、DMOCA 贡献快照。
**不包含：** P1-01 按需工程探索、P1-02 子任务独立 Cycle、P1-03 三场景统一、
P1-04 Workflow 生产闭环、P1-05 版本一致性、P2 专项。

> 本记录只声明 `IMPLEMENTED / TESTED`。**没有**为新增分支跑真机样本，
> 因此五项均不得标 `VERIFIED`。

## 1. 运行环境与命令

| 项 | 值 |
| --- | --- |
| 平台 | macOS（本机），Node 22 |
| 类型检查 | `npm run typecheck`（tsconfig / agent / renderer 三个工程） |
| 全量自动化 | `npm run verify`（36 个 suite，含本批次新增 4 个） |
| 结果 | `tests 635 / pass 635 / fail 0`（36 个 suite） |
| 输入 | 纯函数 fixture + 现有事件构造，不触网、不读真实 userData |

## 2. 逐项验收

| 交付 | 状态 | 验证方式 | 覆盖点 | 未覆盖 |
| --- | --- | --- | --- | --- |
| DEL-01 ECO 角色门禁 | `IMPLEMENTED / TESTED` | `test:dmoca`（20） | insufficient/stale 下 pinned 的 architect/reviewer/adjudicator/verifier 被摘角色；partial+L3 同样受限；sufficient 保留；`roleEligibility` 派发前复核；`formalRoleHolders` 为空 | 未真机跑「用户钉住模型 + 上下文不足」的完整评审；UI 只验证到字段透传 |
| DEL-02 TDL L2 自动分解 | `IMPLEMENTED / TESTED` | `test:tdl*`（23） | 简单任务不拆；同目录多文件不硬拆；两个写入目录归纳出 L2 且步骤全覆盖；模型分解未覆盖步骤如实标出；种树 L2/L3 父子正确 | 归纳失败只阻断（NEEDS_ANALYSIS）并取消自动批准，没有「自动再问模型补分解」；未真机看审批卡 |
| DEL-03 Goal/WorkTask 版本 | `IMPLEMENTED / TESTED / PARTIAL` | `test:gdc-goal`（6） | 澄清不抬版本；变更抬版本且需确认；影响闭包与继承集合；任务创建写 `goalId/goalVersion`，种树全量继承 | 无界面入口；未自动重开规划轮；真机未验证 |
| DEL-04 恢复 ECO 门禁 | `IMPLEMENTED / TESTED` | `test:context-recovery`（6） | ECO 不兼容 → `needs_context_refresh` + 摘要可读 + 提示「先重读工程」；兼容 → `recovered` | 未真机走暂停/重启/恢复；刷新后不强制重建 ECO 包 |
| DEL-05 DMOCA 贡献快照 | `IMPLEMENTED / TESTED` | `test:dmoca`（20） | 同人多版递增且旧稿 superseded；决策钉最后一版；缺终稿记 degraded；完整性校验抓缺失/版本不符/已覆盖/未完成 | 只覆盖工程方案评审的结构化交锋；会话场景仍走旧投影 |

## 3. 事件与数据

新增/扩展的持久化事实：

- `model.participation.selected`：`participants[].blockedRoles`、`ecoGate.restrictions/contextVersion`。
- `model.decision.snapshot`：正式决策引用的贡献版本（新事件）。
- `plan.debated.debate.contributionSnapshot / decisionSnapshot`。
- `context.refresh.required`：恢复时上下文过期的独立信号。
- `task:revise-goal` IPC：目标修订的版本/影响/确认结果。
- `work.task.upserted`：目标修订后受影响任务的新 `goalVersion` 与 `revision`。

## 4. 已知风险

1. 分解归纳按「写入目标目录」分组，跨目录但属于同一交付单元的计划会被拆成多个 L2；
   这是可见的保守拆分，不是静默伪造。
2. `reviseGoal` 只重打版本并发 `work.breakdown.replanned`，真正的重规划发生在下一轮计划；
   在此之前旧计划仍可被批准 —— 需要 P1-05 的版本一致性检查兜住。
3. 贡献快照目前只在方案评审出口生成；会话结论尚未钉版本（P1-03）。

## 5. 提交

`14331d4`（仅本地，未推送）。
