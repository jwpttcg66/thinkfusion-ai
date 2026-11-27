# P0-1 真机验收：恢复时版本链取源

- 启动方式：默认数据目录 / ThinkFusion Dev / CDP 9333
- 数据目录：默认 `~/Library/Application Support/thinkfusion-ai`（未设置隔离目录）
- 探针任务：11941006-4419-4706-8ecc-7b44daa2bd64（验收后删除；原有任务数 0 → 0）

## 结果

- default-store-readable：通过 — /Users/yalla/Library/Application Support/thinkfusion-ai/agent-store.json
- renderer-ready：通过 — http://localhost:5173/
- probe-task-created：通过 — 11941006-4419-4706-8ecc-7b44daa2bd64
- probe-executing：通过 — executing
- goal-revised-to-v2：通过 — {"kind":"change","nextVersion":2,"versionChanged":true,"requiresUserConfirmation":false,"impactedTaskIds":["p0-1-not-a-real-task"],"inheritedTaskIds":["wt-work-11941006","wt-group-11941006","wt-wait"],"reason":"目标变更影响 1 个未完成任务；已完成且不受影响的成果可继承"}
- probe-paused：通过 — paused
- resume-accepted：通过 — 重试后 Runtime 接手恢复：true
- acted-on-replan：通过 — true
- gate-blocks-planning：通过 — blocked
- no-new-planning-round：通过 — resumeAt=1795763396313
- wait-user-decision：通过 — cycle.decision.created=WAIT_USER
- old-worktasks-invalidated：通过 — work.breakdown.replanned
- sources-emitted：通过 — {"goalVersion":"task.goalVersion","currentGoalVersion":"goal.contract.updated","workTaskGoalVersion":"work.task.upserted","ecoGoalVersion":"checkpoint.ecoRef","contributionSnapshotId":"plan.debated.contributionSnapshot","contributionGoalVersion":"unavailable","decisionContributionSnapshotId":"model.decision.snapshot"}
- current-goal-from-contract-event：通过 — goal.contract.updated
- current-goal-version-is-v2：通过 — v2
- stale-worktask-detected：通过 — [{"layer":"worktask","id":"11941006-4419-4706-8ecc-7b44daa2bd64","reason":"任务树绑定的目标版本 v1 与目标 v2 不一致"}]
- replan-required：通过 — true
- probe-task-deleted：通过 — before=0 after=0

## version.consistency 原文

```json
{
  "type": "version.consistency",
  "at": 1795763441647,
  "taskId": "11941006-4419-4706-8ecc-7b44daa2bd64",
  "consistent": false,
  "issues": [
    {
      "layer": "worktask",
      "id": "11941006-4419-4706-8ecc-7b44daa2bd64",
      "reason": "任务树绑定的目标版本 v1 与目标 v2 不一致"
    }
  ],
  "inheritable": [
    "goal"
  ],
  "expired": [
    "worktask",
    "eco",
    "contribution",
    "decision"
  ],
  "requiresReplan": true,
  "requiresContextRefresh": false,
  "notes": [
    "目标/任务结构已变化：未完成的子任务要按新目标重规划，旧结论不得直接继承"
  ],
  "sources": {
    "goalVersion": "task.goalVersion",
    "currentGoalVersion": "goal.contract.updated",
    "workTaskGoalVersion": "work.task.upserted",
    "ecoGoalVersion": "checkpoint.ecoRef",
    "contributionSnapshotId": "plan.debated.contributionSnapshot",
    "contributionGoalVersion": "unavailable",
    "decisionContributionSnapshotId": "model.decision.snapshot"
  },
  "actedOnReplan": true,
  "eventId": "2a406a44-31dd-4f34-b371-de8e5aebb1c1",
  "runId": "11941006-4419-4706-8ecc-7b44daa2bd64",
  "sequence": 40,
  "phase": "execution"
}
```
