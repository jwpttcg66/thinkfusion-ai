# P0-5 场景③：强制退出重启恢复

- 启动方式：默认数据目录 / ThinkFusion Dev / CDP 9333 / SIGKILL 后重启
- 数据目录：默认 `~/Library/Application Support/thinkfusion-ai`
- 探针任务：dc75dbf6-fc29-4593-865b-5cbc82711bb5（验收后删除；用户任务数 2 → 2）
- 标记文件：`/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-p0-5-marker-1795766173870.txt`（强制退出后若 shell 继续跑完就会出现）

## 结果

- default-store-readable：通过 — /Users/yalla/Library/Application Support/thinkfusion-ai/agent-store.json
- renderer-ready-first-run：通过 — CDP 已连接
- probe-task-created：通过 — dc75dbf6-fc29-4593-865b-5cbc82711bb5
- planner-member-persisted-for-restart：通过 — {"expected":["opencode-go:deepseek-v4.1-flash"],"persisted":["opencode-go:deepseek-v4.1-flash"]}
- shell-step-started-before-kill：通过 — 1795766185484
- forced-exit：通过 — /var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-p0-5-marker-1795766173870.txt
- renderer-ready-after-restart：通过 — CDP 已连接
- restarted-as-interrupted：通过 — interrupted
- probe-task-selected-in-ui：通过 — 工作流：P0-5 重启恢复探针
- version-chain-rechecked：通过 — {"type":"version.consistency","at":1795766197302,"taskId":"dc75dbf6-fc29-4593-865b-5cbc82711bb5","consistent":true,"issues":[],"inheritable":["goal","worktask","eco","contribution","decision"],"expired":[],"requiresReplan":false,"requiresContextRefresh":false,"notes":["四层版本一致，可以按检查点继续"],"sources":{"goalVersion":"task.goalVersion","currentGoalVersion":"goal.contract.updated","workTaskGoalVersion":"work.task.upserted","ecoGoalVersion":"checkpoint.ecoRef","contributionSnapshotId":"plan.debated.contributionSnapshot","contributionGoalVersion":"unavailable","decisionContributionSnapshotId":"model.decision.snapshot"},"actedOnReplan":false,"eventId":"7b105770-16fe-4137-9c59-38eebcbfca1f","runId":"dc75dbf6-fc29-4593-865b-5cbc82711bb5","sequence":29,"phase":"execution"}
- resume-proceeds-or-blocks：通过 — planning
- no-web-planner-after-resume：通过 — dev.log 未出现 ChatGPT 页面失败
- probe-task-deleted：通过 — before=2 after=2
- late-write-never-happened：通过 — /var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-p0-5-marker-1795766173870.txt

## 事件摘要

```json
[
  {
    "type": "task.updated",
    "at": 1795766184596,
    "status": "created",
    "event": null,
    "requiresReplan": null,
    "actedOnReplan": null,
    "sources": null
  },
  {
    "type": "task.updated",
    "at": 1795766184642,
    "status": "planning",
    "event": null,
    "requiresReplan": null,
    "actedOnReplan": null,
    "sources": null
  },
  {
    "type": "task.updated",
    "at": 1795766184710,
    "status": "planning",
    "event": null,
    "requiresReplan": null,
    "actedOnReplan": null,
    "sources": null
  },
  {
    "type": "task.updated",
    "at": 1795766184852,
    "status": "planning",
    "event": null,
    "requiresReplan": null,
    "actedOnReplan": null,
    "sources": null
  },
  {
    "type": "task.updated",
    "at": 1795766184899,
    "status": "plan_ready",
    "event": null,
    "requiresReplan": null,
    "actedOnReplan": null,
    "sources": null
  },
  {
    "type": "task.updated",
    "at": 1795766184949,
    "status": "plan_ready",
    "event": null,
    "requiresReplan": null,
    "actedOnReplan": null,
    "sources": null
  },
  {
    "type": "task.updated",
    "at": 1795766185264,
    "status": "awaiting_approval",
    "event": null,
    "requiresReplan": null,
    "actedOnReplan": null,
    "sources": null
  },
  {
    "type": "task.updated",
    "at": 1795766185380,
    "status": "executing",
    "event": null,
    "requiresReplan": null,
    "actedOnReplan": null,
    "sources": null
  },
  {
    "type": "step.started",
    "at": 1795766185484,
    "status": null,
    "event": null,
    "requiresReplan": null,
    "actedOnReplan": null,
    "sources": null
  },
  {
    "type": "task.updated",
    "at": 1795766195338,
    "status": "interrupted",
    "event": null,
    "requiresReplan": null,
    "actedOnReplan": null,
    "sources": null
  },
  {
    "type": "version.consistency",
    "at": 1795766197302,
    "status": null,
    "event": null,
    "requiresReplan": false,
    "actedOnReplan": false,
    "sources": {
      "goalVersion": "task.goalVersion",
      "currentGoalVersion": "goal.contract.updated",
      "workTaskGoalVersion": "work.task.upserted",
      "ecoGoalVersion": "checkpoint.ecoRef",
      "contributionSnapshotId": "plan.debated.contributionSnapshot",
      "contributionGoalVersion": "unavailable",
      "decisionContributionSnapshotId": "model.decision.snapshot"
    }
  },
  {
    "type": "task.updated",
    "at": 1795766197347,
    "status": "planning",
    "event": null,
    "requiresReplan": null,
    "actedOnReplan": null,
    "sources": null
  },
  {
    "type": "task.updated",
    "at": 1795766197419,
    "status": "planning",
    "event": null,
    "requiresReplan": null,
    "actedOnReplan": null,
    "sources": null
  }
]
```
