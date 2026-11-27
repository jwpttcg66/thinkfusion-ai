# P0-4 真机验收：暂停状态机与检查点

- 启动方式：默认数据目录 / ThinkFusion Dev / CDP 9333
- 数据目录：默认 `~/Library/Application Support/thinkfusion-ai`
- 探针任务：7842257a-9b5c-4218-bbc8-c240f7767708（验收后删除；用户任务数 2 → 2）
- 标记文件：`/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-p0-4-marker-1795765437626.txt`（暂停后若 shell 继续跑完就会出现）

## 状态序列

created → planning → plan_ready → awaiting_approval → executing → pause_requested → pausing → paused

## 结果

- default-store-readable：通过 — /Users/yalla/Library/Application Support/thinkfusion-ai/agent-store.json
- renderer-ready：通过 — CDP 已连接
- probe-task-created：通过 — 7842257a-9b5c-4218-bbc8-c240f7767708
- state-machine-sequence：通过 — created → planning → plan_ready → awaiting_approval → executing → pause_requested → pausing → paused
- checkpoint-event：通过 — {"type":"context.checkpoint.paused","at":1795765446886,"taskId":"7842257a-9b5c-4218-bbc8-c240f7767708","reason":"pause","goalVersion":1,"taskRevision":3,"needsReconciliation":1,"checkpointId":"cp_35a74db7-7296-4be7-9823-3190b6832202","eventId":"95c32f00-774e-4835-9f33-cb9b2605128d","runId":"7842257a-9b5c-4218-bbc8-c240f7767708","sequence":37,"phase":"execution"}
- checkpoint-file：通过 — /Users/yalla/Library/Application Support/thinkfusion-ai/context-checkpoints/owners/agent-task/7842257a-9b5c-4218-bbc8-c240f7767708.json
- checkpoint-goal-and-revision：通过 — 目标版本 v1 / 任务树 revision 3 / 暂停原因：pause / 工具执行状态：已完成 0 步；副作用核对 applied 0 / missing 0 / needs_reconciliation 1
- late-write-never-happened：通过 — /var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-p0-4-marker-1795765437626.txt
- probe-task-selected-in-ui：通过 — true
- probe-task-deleted：通过 — before=2 after=2

## 事件摘要

```json
[
  {
    "type": "task.updated",
    "at": 1795765445161,
    "status": "created",
    "reason": null,
    "taskRevision": null,
    "needsReconciliation": null,
    "checkpointId": null,
    "tool": null,
    "error": null
  },
  {
    "type": "task.updated",
    "at": 1795765445205,
    "status": "planning",
    "reason": null,
    "taskRevision": null,
    "needsReconciliation": null,
    "checkpointId": null,
    "tool": null,
    "error": null
  },
  {
    "type": "task.updated",
    "at": 1795765445271,
    "status": "planning",
    "reason": null,
    "taskRevision": null,
    "needsReconciliation": null,
    "checkpointId": null,
    "tool": null,
    "error": null
  },
  {
    "type": "task.updated",
    "at": 1795765445402,
    "status": "planning",
    "reason": null,
    "taskRevision": null,
    "needsReconciliation": null,
    "checkpointId": null,
    "tool": null,
    "error": null
  },
  {
    "type": "task.updated",
    "at": 1795765445444,
    "status": "plan_ready",
    "reason": null,
    "taskRevision": null,
    "needsReconciliation": null,
    "checkpointId": null,
    "tool": null,
    "error": null
  },
  {
    "type": "task.updated",
    "at": 1795765445492,
    "status": "plan_ready",
    "reason": null,
    "taskRevision": null,
    "needsReconciliation": null,
    "checkpointId": null,
    "tool": null,
    "error": null
  },
  {
    "type": "task.updated",
    "at": 1795765445794,
    "status": "awaiting_approval",
    "reason": null,
    "taskRevision": null,
    "needsReconciliation": null,
    "checkpointId": null,
    "tool": null,
    "error": null
  },
  {
    "type": "task.updated",
    "at": 1795765445881,
    "status": "executing",
    "reason": null,
    "taskRevision": null,
    "needsReconciliation": null,
    "checkpointId": null,
    "tool": null,
    "error": null
  },
  {
    "type": "step.started",
    "at": 1795765445977,
    "status": null,
    "reason": null,
    "taskRevision": null,
    "needsReconciliation": null,
    "checkpointId": null,
    "tool": "shell.run",
    "error": null
  },
  {
    "type": "task.updated",
    "at": 1795765446481,
    "status": "pause_requested",
    "reason": null,
    "taskRevision": null,
    "needsReconciliation": null,
    "checkpointId": null,
    "tool": null,
    "error": null
  },
  {
    "type": "step.failed",
    "at": 1795765446608,
    "status": null,
    "reason": null,
    "taskRevision": null,
    "needsReconciliation": null,
    "checkpointId": null,
    "tool": "shell.run",
    "error": "命令已被用户中断（SIGTERM)，stdout/stderr 与退出码见执行结果"
  },
  {
    "type": "task.updated",
    "at": 1795765446684,
    "status": "pausing",
    "reason": null,
    "taskRevision": null,
    "needsReconciliation": null,
    "checkpointId": null,
    "tool": null,
    "error": null
  },
  {
    "type": "task.updated",
    "at": 1795765446860,
    "status": "pausing",
    "reason": null,
    "taskRevision": null,
    "needsReconciliation": null,
    "checkpointId": null,
    "tool": null,
    "error": null
  },
  {
    "type": "context.checkpoint.paused",
    "at": 1795765446886,
    "status": null,
    "reason": "pause",
    "taskRevision": 3,
    "needsReconciliation": 1,
    "checkpointId": "cp_35a74db7-7296-4be7-9823-3190b6832202",
    "tool": null,
    "error": null
  },
  {
    "type": "task.updated",
    "at": 1795765446935,
    "status": "paused",
    "reason": null,
    "taskRevision": null,
    "needsReconciliation": null,
    "checkpointId": null,
    "tool": null,
    "error": null
  }
]
```
