# P0-2 真机验收：needs_replan 从提示升级为硬门禁

**共用探针**：与 [P0-1 验收](../p0-1-version-chain-20261127/EVIDENCE.md) 同一条真实任务，脚本 `scripts/verify-p0-1-cdp.mjs` 一次跑完；原始事件 JSON 见 [evidence.json](../p0-1-version-chain-20261127/evidence.json)。

- 启动方式：ThinkFusion Dev（`npm run dev:local` 等价参数），默认数据目录，CDP 9333；未设置 `THINKFUSION_USER_DATA`。
- 任务 ID：`11941006-4419-4706-8ecc-7b44daa2bd64`（验收后删除，用户任务数 0 → 0）。
- 场景：固定工作流探针进入 `executing` 后，把目标修订到 v2 但故意不重打在途任务树（任务树留 v1），暂停后恢复。

## 结果（全部通过）

- `version.consistency.actedOnReplan = true`，`requiresReplan = true`，过期层为 `worktask/eco/contribution/decision`。
- 任务恢复后状态为 `blocked`，不是 `planning`；恢复时间点之后没有新的 `round.started`。
- 发出 `cycle.decision.created`，`decisionType = WAIT_USER`，理由写明「旧目标计划未执行……等待确认后按新目标重规划」。
- 发出 `work.breakdown.replanned`，作废未完成子任务 `wt-work-…`、`wt-group-…`（`wt-wait` 已完成，保留原版本）。

## 事件序列（截取）

| 时间（ms） | 事件 | 关键信息 |
| --- | --- | --- |
| 1795763395430 | `goal.contract.updated` | 契约目标版本 v2 |
| 1795763441647 | `version.consistency` | `actedOnReplan=true`，任务树绑定 v1 与目标 v2 不一致 |
| 1795763441929 | `work.breakdown.replanned` | 作废未完成子任务 |
| 1795763442060 | `cycle.decision.created` | `WAIT_USER` |

## 边界

- 用户再次点继续时，若事件流已有「同版本已执行门禁」记录，才允许重新规划；本轮未跑到第二次继续，故该路径只有单测语义，没有真机样本。
- 探针通过 IPC 驱动，截图是清理后的应用空闲态；结论以 CDP 读到的事件原文为准。
