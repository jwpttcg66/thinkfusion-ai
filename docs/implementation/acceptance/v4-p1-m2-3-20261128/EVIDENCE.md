# V4 P1 M2-3 真机验收：上下文重建显性化

- 时间：2026-11-28T03:28:05.418Z ~ 2026-11-28T03:29:42.054Z
- 环境：默认数据目录 / ThinkFusion Dev / CDP 9333 / 同一进程内暂停→恢复
- 工作区：`/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m2-3-ws-1795836485418`（探针只在这里写文件）
- 探针任务：A 暂停→续跑 `275e5b15-d8c5-48f2-8f98-39c1c50f4339`、B 无上下文事件反例 `464b50b0-0edf-4922-8c5e-9b4dcbc75d6e`、C 在途命令不可核对→重规划 `56f93127-29f9-4bf9-914c-4df9254ecd12`（收尾已删除）
- 备份：context-checkpoints.before.tgz、agent-store.before.json

## 取样前

```json
{
  "before": {
    "tasks": 1,
    "ownerSegments": [
      "7107cbd2-2843-4282-9628-51cd02329285.json"
    ]
  },
  "staleProbes": [
    "7107cbd2-2843-4282-9628-51cd02329285"
  ]
}
```

## 三方对照：暂停事件 / 磁盘检查点 / 投影

```json
{
  "pauseEvent": {
    "type": "context.checkpoint.paused",
    "at": 1795836497867,
    "taskId": "275e5b15-d8c5-48f2-8f98-39c1c50f4339",
    "reason": "pause",
    "goalVersion": 1,
    "taskRevision": 3,
    "needsReconciliation": 0,
    "contextId": "pause:275e5b15-d8c5-48f2-8f98-39c1c50f4339:1795836497836",
    "checkpointId": "cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561",
    "activeRunId": "275e5b15-d8c5-48f2-8f98-39c1c50f4339",
    "eventId": "a6a84d08-430d-4f1f-b01c-017eeb28fbb9",
    "runId": "275e5b15-d8c5-48f2-8f98-39c1c50f4339",
    "sequence": 85,
    "phase": "execution"
  },
  "diskTail": {
    "count": 1,
    "checkpointId": "cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561",
    "line": "工具执行状态：已完成 0 步；副作用核对 applied 6 / missing 0 / needs_reconciliation 0",
    "applied": 6,
    "missing": 0,
    "needsReconciliation": 0
  },
  "projectionAfterPause": {
    "hasEvents": true,
    "contextId": "pause:275e5b15-d8c5-48f2-8f98-39c1c50f4339:1795836497836",
    "contextIdFrom": {
      "at": 1795836497867,
      "label": "暂停已提交检查点 cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561"
    },
    "checkpoints": [
      "pause:cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561:nr=0"
    ],
    "rebuilds": [],
    "lastRebuild": null,
    "reconciliation": {
      "at": 1795836497867,
      "applied": null,
      "missing": null,
      "needsReconciliation": 0,
      "source": "pause"
    },
    "budget": null,
    "entryCount": 1,
    "summary": "1 条 context 事件 · 最近检查点 cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561 · 核对 applied ? / missing ? / 待核对 0"
  },
  "projectionAfterResume": {
    "hasEvents": true,
    "contextId": "pause:275e5b15-d8c5-48f2-8f98-39c1c50f4339:1795836497836",
    "contextIdFrom": {
      "at": 1795836501565,
      "label": "已从检查点续跑：沿用已批准计划，未重新规划"
    },
    "checkpoints": [
      "pause:cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561:nr=0"
    ],
    "rebuilds": [
      "recovered:ptr=task-fields",
      "resume-continue:ptr=task-fields"
    ],
    "lastRebuild": {
      "kind": "resume-continue",
      "at": 1795836501565,
      "reason": "检查点有效、副作用账本无未知缺口，直接续跑已批准计划 3bb24e9c-9144-4ec2-940b-92ee48e43079"
    },
    "reconciliation": {
      "at": 1795836501439,
      "applied": 7,
      "missing": 0,
      "needsReconciliation": 0,
      "source": "recovered"
    },
    "budget": null,
    "entryCount": 3,
    "summary": "3 条 context 事件 · 最近检查点 cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561 · 核对 applied 7 / missing 0 / 待核对 0"
  }
}
```

## 恢复打点（界面上的数字就是从这里来的）

```json
{
  "resumeError": null,
  "recovered": {
    "contextId": "pause:275e5b15-d8c5-48f2-8f98-39c1c50f4339:1795836497836",
    "checkpointId": "cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561",
    "pointerSource": "task-fields",
    "reason": "从 Journal 活动指针恢复",
    "sideEffects": {
      "applied": 7,
      "missing": 0,
      "needsReconciliation": 0
    }
  },
  "decisionType": "context.resume.continued",
  "decision": {
    "contextId": "pause:275e5b15-d8c5-48f2-8f98-39c1c50f4339:1795836497836",
    "checkpointId": "cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561",
    "pointerSource": "task-fields",
    "reason": "检查点有效、副作用账本无未知缺口，直接续跑已批准计划 3bb24e9c-9144-4ec2-940b-92ee48e43079",
    "resume": {
      "mode": "continue",
      "planId": "3bb24e9c-9144-4ec2-940b-92ee48e43079",
      "roundId": "bbe89182-ae75-4de0-8c47-01511a391eae",
      "reusedStepIds": [
        "write-1",
        "write-2",
        "write-3",
        "write-4",
        "write-5",
        "write-6"
      ],
      "pendingStepIds": [
        "write-7",
        "write-8"
      ],
      "reasons": []
    }
  }
}
```

## 「上下文」段实测渲染值

### 暂停后

```json
{
  "tabMissing": null,
  "renderTimeout": null,
  "loading": false,
  "errorText": "",
  "summary": "上下文 1 条 context 事件 · 最近检查点 cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561 · 核对 applied ? / missing ? / 待核对 0",
  "cells": {
    "当前上下文": "pause:275e5b15-d8c5-48f2-8f98-39c1c50f4339:1795836497836",
    "来源事件": "暂停已提交检查点 cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561 @ 11:28:17",
    "最近检查点": "cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561（暂停存档）",
    "存档时间": "11:28:17",
    "副作用核对": "存在 未记录 · 已消失 未记录 · 待核对 0",
    "核对来源": "暂停时核对 @ 11:28:17",
    "上次重建": "未重建",
    "重建原因": "未记录",
    "续跑判定": "没有点过「继续」",
    "预算水位": "未记录"
  },
  "rows": [],
  "entryCount": 1,
  "entryTypes": [
    "context.checkpoint.paused"
  ]
}
```

### 恢复后

```json
{
  "loading": false,
  "errorText": "",
  "summary": "上下文 3 条 context 事件 · 最近检查点 cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561 · 核对 applied 7 / missing 0 / 待核对 0",
  "cells": {
    "当前上下文": "pause:275e5b15-d8c5-48f2-8f98-39c1c50f4339:1795836497836",
    "来源事件": "已从检查点续跑：沿用已批准计划，未重新规划 @ 11:28:21",
    "最近检查点": "cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561（暂停存档）",
    "存档时间": "11:28:17",
    "副作用核对": "存在 7 · 已消失 0 · 待核对 0",
    "核对来源": "恢复时核对 @ 11:28:21",
    "上次重建": "已从检查点续跑：沿用已批准计划，未重新规划 @ 11:28:21",
    "重建原因": "检查点有效、副作用账本无未知缺口，直接续跑已批准计划 3bb24e9c-9144-4ec2-940b-92ee48e43079",
    "续跑判定": "已从检查点续跑：沿用已批准计划，未重新规划 @ 11:28:21",
    "预算水位": "未记录"
  },
  "rows": [
    {
      "head": "11:28:21 已从检查点恢复上下文 指针来自任务字段",
      "tone": "t-muted",
      "lines": [
        "原因 从 Journal 活动指针恢复",
        "检查点 cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561",
        "副作用 存在 7 · 已消失 0 · 待核对 0"
      ],
      "reasons": [],
      "steps": []
    },
    {
      "head": "11:28:21 已从检查点续跑：沿用已批准计划，未重新规划 指针来自任务字段 复用 6 步 · 本轮执行 2 步",
      "tone": "t-muted",
      "lines": [
        "原因 检查点有效、副作用账本无未知缺口，直接续跑已批准计划 3bb24e9c-9144-4ec2-940b-92ee48e43079",
        "检查点 cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561"
      ],
      "reasons": [],
      "steps": [
        "复用 write-1、write-2、write-3、write-4、write-5、write-6",
        "本轮 write-7、write-8",
        "计划 3bb24e9c · 轮次 bbe89182"
      ]
    }
  ],
  "entryCount": 3,
  "entryTypes": [
    "context.checkpoint.paused",
    "context.event:context.recovered",
    "context.event:context.resume.continued"
  ]
}
```

### 反例（没暂停过）

```json
{
  "summary": "上下文 没有记录到上下文事件",
  "cells": {},
  "entryCount": 0,
  "emptyState": true,
  "loading": false,
  "errorText": "",
  "renderTimeout": null,
  "contextEvents": []
}
```

## 第二条路：核对不过时重规划（探针 C）

```json
{
  "pauseEvent": {
    "type": "context.checkpoint.paused",
    "at": 1795836570700,
    "taskId": "56f93127-29f9-4bf9-914c-4df9254ecd12",
    "reason": "pause",
    "goalVersion": 1,
    "taskRevision": 3,
    "needsReconciliation": 1,
    "contextId": "pause:56f93127-29f9-4bf9-914c-4df9254ecd12:1795836570666",
    "checkpointId": "cp_0637ddb5-860c-4885-9113-c937129d6b7a",
    "activeRunId": "56f93127-29f9-4bf9-914c-4df9254ecd12",
    "eventId": "413fa8c5-d1d8-42c8-9101-bd8572c67308",
    "runId": "56f93127-29f9-4bf9-914c-4df9254ecd12",
    "sequence": 45,
    "phase": "execution"
  },
  "diskTail": {
    "count": 1,
    "checkpointId": "cp_0637ddb5-860c-4885-9113-c937129d6b7a",
    "line": "工具执行状态：已完成 0 步；副作用核对 applied 1 / missing 0 / needs_reconciliation 1",
    "applied": 1,
    "missing": 0,
    "needsReconciliation": 1
  },
  "resumeError": null,
  "recovered": {
    "contextId": "pause:56f93127-29f9-4bf9-914c-4df9254ecd12:1795836570666",
    "checkpointId": "cp_0637ddb5-860c-4885-9113-c937129d6b7a",
    "pointerSource": "task-fields",
    "reason": "从 Journal 活动指针恢复",
    "sideEffects": {
      "applied": 2,
      "missing": 0,
      "needsReconciliation": 1
    }
  },
  "decision": {
    "contextId": "pause:56f93127-29f9-4bf9-914c-4df9254ecd12:1795836570666",
    "checkpointId": "cp_0637ddb5-860c-4885-9113-c937129d6b7a",
    "pointerSource": "task-fields",
    "reason": "1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）",
    "resume": {
      "mode": "replan",
      "reasons": [
        "1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）"
      ]
    }
  },
  "projection": {
    "hasEvents": true,
    "contextId": "pause:56f93127-29f9-4bf9-914c-4df9254ecd12:1795836570666",
    "contextIdFrom": {
      "at": 1795836572417,
      "label": "已重新规划：检查点不足以安全续跑"
    },
    "checkpoints": [
      "pause:cp_0637ddb5-860c-4885-9113-c937129d6b7a:nr=1"
    ],
    "rebuilds": [
      "recovered:ptr=task-fields",
      "resume-replan:ptr=task-fields"
    ],
    "lastRebuild": {
      "kind": "resume-replan",
      "at": 1795836572417,
      "reason": "1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）"
    },
    "reconciliation": {
      "at": 1795836572312,
      "applied": 2,
      "missing": 0,
      "needsReconciliation": 1,
      "source": "recovered"
    },
    "budget": null,
    "entryCount": 3,
    "summary": "3 条 context 事件 · 最近检查点 cp_0637ddb5-860c-4885-9113-c937129d6b7a · 核对 applied 2 / missing 0 / 待核对 1"
  },
  "card": {
    "loading": false,
    "errorText": "",
    "summary": "上下文 3 条 context 事件 · 最近检查点 cp_0637ddb5-860c-4885-9113-c937129d6b7a · 核对 applied 2 / missing 0 / 待核对 1",
    "cells": {
      "当前上下文": "pause:56f93127-29f9-4bf9-914c-4df9254ecd12:1795836570666",
      "来源事件": "已重新规划：检查点不足以安全续跑 @ 11:29:32",
      "最近检查点": "cp_0637ddb5-860c-4885-9113-c937129d6b7a（暂停存档）",
      "存档时间": "11:29:30",
      "副作用核对": "存在 2 · 已消失 0 · 待核对 1",
      "核对来源": "恢复时核对 @ 11:29:32",
      "上次重建": "已重新规划：检查点不足以安全续跑 @ 11:29:32",
      "重建原因": "1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）",
      "续跑判定": "已重新规划：检查点不足以安全续跑 @ 11:29:32",
      "预算水位": "未记录"
    },
    "rows": [
      {
        "head": "11:29:32 已从检查点恢复上下文 指针来自任务字段",
        "tone": "t-muted",
        "lines": [
          "原因 从 Journal 活动指针恢复",
          "检查点 cp_0637ddb5-860c-4885-9113-c937129d6b7a",
          "副作用 存在 2 · 已消失 0 · 待核对 1"
        ],
        "reasons": [],
        "steps": []
      },
      {
        "head": "11:29:32 已重新规划：检查点不足以安全续跑 指针来自任务字段 不复用上一轮步骤",
        "tone": "t-warn",
        "lines": [
          "原因 1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）",
          "检查点 cp_0637ddb5-860c-4885-9113-c937129d6b7a"
        ],
        "reasons": [
          "1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）"
        ],
        "steps": []
      }
    ],
    "entryCount": 3,
    "entryTypes": [
      "context.checkpoint.paused",
      "context.event:context.recovered",
      "context.event:context.resume.replanned"
    ]
  }
}
```

## 删除任务时的回收

```json
[
  {
    "tag": "A",
    "taskId": "275e5b15-d8c5-48f2-8f98-39c1c50f4339",
    "checkpointExistedBeforeDelete": true,
    "cleanup": {
      "taskId": "275e5b15-d8c5-48f2-8f98-39c1c50f4339",
      "checkpointsRemoved": true,
      "archiveSegments": 0,
      "goalId": "goal:275e5b15-d8c5-48f2-8f98-39c1c50f4339",
      "goalReclaimed": false
    }
  },
  {
    "tag": "B",
    "taskId": "464b50b0-0edf-4922-8c5e-9b4dcbc75d6e",
    "checkpointExistedBeforeDelete": true,
    "cleanup": {
      "taskId": "464b50b0-0edf-4922-8c5e-9b4dcbc75d6e",
      "checkpointsRemoved": true,
      "archiveSegments": 0,
      "goalId": "goal:464b50b0-0edf-4922-8c5e-9b4dcbc75d6e",
      "goalReclaimed": false
    }
  },
  {
    "tag": "C",
    "taskId": "56f93127-29f9-4bf9-914c-4df9254ecd12",
    "checkpointExistedBeforeDelete": true,
    "cleanup": {
      "taskId": "56f93127-29f9-4bf9-914c-4df9254ecd12",
      "checkpointsRemoved": true,
      "archiveSegments": 0,
      "goalId": "goal:56f93127-29f9-4bf9-914c-4df9254ecd12",
      "goalReclaimed": false
    }
  }
]
```

## 断言结果

| 断言 | 结果 | 实测 |
| --- | --- | --- |
| default-store-readable | 通过 | /Users/yalla/Library/Application Support/thinkfusion-ai/agent-store.json |
| renderer-ready | 通过 | CDP 已连接 |
| ipc-pause-projects-checkpoint | 通过 | 投影 [{"at":1795836497867,"checkpointId":"cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561","source":"pause","contextId":"pause:275e5b15-d8c5-48f2-8f98-39c1c50f4339:1795836497836","needsReconciliation":0,"goalVersion":1,"taskRevision":3,"unavailableReason":null}]｜事件 cp=cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561 nr=0｜磁盘 cp=cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561（工具执行状态：已完成 0 步；副作用核对 applied 6 / missing 0 / needs_reconciliation 0，共 1 份） |
| ipc-pause-keeps-unreconciled-as-null | 通过 | 暂停只给待核对条数，不给存在/已消失：{"at":1795836497867,"applied":null,"missing":null,"needsReconciliation":0,"source":"pause"} |
| ipc-task-context-is-read-only | 通过 | 同一任务连读两次投影完全一致（不写盘、不推进状态、不补数据） |
| ui-shows-paused-probe | 通过 | 侧栏选中探针 A |
| ui-context-card-renders | 通过 | 状态 {"loading":false,"error":"","chars":535} |
| ui-summary-line-matches-projection | 通过 | 界面「上下文 1 条 context 事件 · 最近检查点 cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561 · 核对 applied ? / missing ? / 待核对 0」 vs 投影「1 条 context 事件 · 最近检查点 cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561 · 核对 applied ? / missing ? / 待核对 0」 |
| ui-checkpoint-cell-matches-event | 通过 | 最近检查点「cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561（暂停存档）」｜存档时间「11:28:17」 |
| ui-pause-reconciliation-says-unrecorded | 通过 | 副作用核对「存在 未记录 · 已消失 未记录 · 待核对 0」｜口径说明 true |
| ui-pause-no-rebuild-claim | 通过 | 上次重建「未重建」｜重建原因「未记录」 |
| ui-pause-entries-are-raw-payloads | 通过 | 原文 1 条 vs 投影 1 条；类型 context.checkpoint.paused |
| ui-pause-card-scrolled | 通过 | 截图前把「上下文」段滚进视口 |
| resume-ipc-accepted | 通过 | recovered=1795836501439，判定=context.resume.continued |
| ipc-resume-projects-reconciled-ledger | 通过 | 事件 sideEffects={"applied":7,"missing":0,"needsReconciliation":0}｜投影行 {"applied":7,"missing":0,"needsReconciliation":0}｜lastReconciliation {"at":1795836501439,"applied":7,"missing":0,"needsReconciliation":0,"source":"recovered"} |
| ipc-resume-projects-pointer-source | 通过 | 投影 task-fields｜事件 task-fields |
| ipc-resume-projects-rebuild-reason | 通过 | lastRebuild.reason=检查点有效、副作用账本无未知缺口，直接续跑已批准计划 3bb24e9c-9144-4ec2-940b-92ee48e43079｜判定行 resume={"reusedStepIds":["write-1","write-2","write-3","write-4","write-5","write-6"],"pendingStepIds":["write-7","write-8"],"reasons":[],"planId":"3bb24e9c-9144-4ec2-940b-92ee48e43079","roundId":"bbe89182-ae75-4de0-8c47-01511a391eae"} |
| ui-resume-reconciliation-matches-event | 通过 | 界面「存在 7 · 已消失 0 · 待核对 0」｜应为「存在 7 · 已消失 0 · 待核对 0」｜核对来源「恢复时核对 @ 11:28:21」 |
| ui-resume-rebuild-reason-visible | 通过 | 上次重建「已从检查点续跑：沿用已批准计划，未重新规划 @ 11:28:21」｜重建原因「检查点有效、副作用账本无未知缺口，直接续跑已批准计划 3bb24e9c-9144-4ec2-940b-92ee48e43079」｜事件 reason=检查点有效、副作用账本无未知缺口，直接续跑已批准计划 3bb24e9c-9144-4ec2-940b-92ee48e43079 |
| ui-resume-pointer-source-visible | 通过 | 11:28:21 已从检查点恢复上下文 指针来自任务字段 ⏎ 11:28:21 已从检查点续跑：沿用已批准计划，未重新规划 指针来自任务字段 复用 6 步 · 本轮执行 2 步 |
| ui-resume-decision-row-counts-steps | 通过 | 应有步数行「复用 6 步 · 本轮执行 2 步」｜界面行 ["11:28:21 已从检查点恢复上下文 指针来自任务字段","11:28:21 已从检查点续跑：沿用已批准计划，未重新规划 指针来自任务字段 复用 6 步 · 本轮执行 2 步"] |
| ui-resume-reasons-listed | 通过 | 事件理由 []｜界面理由 [] |
| ui-resume-step-list-names-steps | 通过 | 事件复用首步 write-1、本轮首步 write-7、计划 3bb24e9c-9144-4ec2-940b-92ee48e43079｜界面行 ["复用 write-1、write-2、write-3、write-4、write-5、write-6","本轮 write-7、write-8","计划 3bb24e9c · 轮次 bbe89182"] |
| ui-resume-entries-cover-both-phases | 通过 | 界面 3 条 context.checkpoint.paused,context.event:context.recovered,context.event:context.resume.continued｜投影 3 条 |
| ui-resume-detail-payload-carries-ledger | 通过 | {
  "contextId": "pause:275e5b15-d8c5-48f2-8f98-39c1c50f4339:1795836497836",
  "checkpointId": "cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561",
  "pointerSource": "task-fields",
  "reason": "从 Journal 活动指针恢复",
  "sideEffects": {
    "applied": 7,
    "missing": 0,
  |
| ui-resume-card-scrolled | 通过 | 截图前把「上下文」段滚进视口 |
| ui-detail-entries-are-visible | 通过 | 逐条原文展开 3 条，截图前已滚进视口 |
| ipc-no-context-probe-has-no-checkpoint | 通过 | 投影 {"hasEvents":false,"contextId":null,"contextIdFrom":null,"checkpoints":[],"rebuilds":[],"lastRebuild":null,"reconciliation":null,"budget":null,"entryCount":0,"summary":"没有记录到上下文事件"}｜上下文事件 无 |
| ui-shows-empty-probe | 通过 | 侧栏选中探针 B |
| ui-empty-probe-says-nothing-happened | 通过 | 摘要「上下文 没有记录到上下文事件」｜空态文案 true｜最近检查点「」 |
| ui-empty-probe-leaks-no-other-task | 通过 | 探针 B 的原文里出现探针 A 的 cp=cp_8af45f5d-7be2-4bbc-950f-a56c3c4a9561：false |
| ipc-replan-projects-gap-and-decision | 通过 | 判定=context.resume.replanned｜恢复账本 {"applied":2,"missing":0,"needsReconciliation":1}｜投影 rebuilds [{"at":1795836572312,"kind":"recovered","text":"已从检查点恢复上下文","tone":"muted","contextId":"pause:56f93127-29f9-4bf9-914c-4df9254ecd12:1795836570666","checkpointId":"cp_0637ddb5-860c-4885-9113-c937129d6b7a","pointerSource":"task-fields","reason":"从 Journal 活动指针恢复","sideEffects":{"applied":2,"missing":0,"needsReconciliation":1},"resume":null},{"at":1795836572417,"kind":"resume-replan","text":"已重新规划：检查点不足以安全续跑","tone":"warn","contextId":"pause:56f93127-29f9-4bf9-914c-4df9254ecd12:1795836570666","checkpointId":"cp_0637ddb5-860c-4885-9113-c937129d6b7a","pointerSource":"task-fields","reason":"1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）","sideEffects":null,"resume":{"reusedStepIds":[],"pendingStepIds":[],"reasons":["1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）"],"planId":null,"roundId":null}}] |
| ipc-replan-listens-to-event-reasons | 通过 | 事件理由 ["1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）"]｜投影理由 ["1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）"] |
| ui-shows-replan-probe | 通过 | 侧栏选中探针 C |
| ui-replan-card-says-replanned | 通过 | 上次重建「已重新规划：检查点不足以安全续跑 @ 11:29:32」｜续跑判定「已重新规划：检查点不足以安全续跑 @ 11:29:32」 |
| ui-replan-reason-names-the-gap | 通过 | 重建原因「1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）」｜界面理由 ["1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）"] |
| ui-replan-row-is-warn-toned | 通过 | 行的配色类名「t-warn」｜行头「11:29:32 已重新规划：检查点不足以安全续跑 指针来自任务字段 不复用上一轮步骤」 |
| ui-replan-row-says-no-reuse | 通过 | 行头「11:29:32 已重新规划：检查点不足以安全续跑 指针来自任务字段 不复用上一轮步骤」 |
| ui-replan-gap-is-a-number-not-zero | 通过 | 界面「存在 2 · 已消失 0 · 待核对 1」｜事件 {"applied":2,"missing":0,"needsReconciliation":1} |
| ui-replan-keeps-the-checkpoint-it-rejected | 通过 | 最近检查点「cp_0637ddb5-860c-4885-9113-c937129d6b7a（暂停存档）」｜磁盘 工具执行状态：已完成 0 步；副作用核对 applied 1 / missing 0 / needs_reconciliation 1 |
| ui-replan-entries-cover-the-decision | 通过 | 原文 3 条 context.checkpoint.paused,context.event:context.recovered,context.event:context.resume.replanned |
| ui-replan-card-scrolled | 通过 | 截图前把「上下文」段滚进视口 |
| A-delete-reclaims-checkpoint | 通过 | 删前文件 true，回收结果 {"taskId":"275e5b15-d8c5-48f2-8f98-39c1c50f4339","checkpointsRemoved":true,"archiveSegments":0,"goalId":"goal:275e5b15-d8c5-48f2-8f98-39c1c50f4339","goalReclaimed":false} |
| B-delete-reclaims-checkpoint | 通过 | 删前文件 true，回收结果 {"taskId":"464b50b0-0edf-4922-8c5e-9b4dcbc75d6e","checkpointsRemoved":true,"archiveSegments":0,"goalId":"goal:464b50b0-0edf-4922-8c5e-9b4dcbc75d6e","goalReclaimed":false} |
| C-delete-reclaims-checkpoint | 通过 | 删前文件 true，回收结果 {"taskId":"56f93127-29f9-4bf9-914c-4df9254ecd12","checkpointsRemoved":true,"archiveSegments":0,"goalId":"goal:56f93127-29f9-4bf9-914c-4df9254ecd12","goalReclaimed":false} |
| disk-has-no-orphan-after-run | 通过 | 探针之外没有无人认领的归属文件 |
| probe-tasks-cleaned-up | 通过 | 任务数 1 → 0（扫前的 1 个归属文件里，上一轮中断留下的探针 1 条已在开头删掉） |

合计 47 项，未通过 0 项。

## 截图

- `01-A-paused-context-card.png`
- `02-A-resumed-context-card.png`
- `03-A-context-detail-entries.png`
- `04-B-no-context-card.png`
- `05-C-replanned-context-card.png`

## 中断原因

无。
