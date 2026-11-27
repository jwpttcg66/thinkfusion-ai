# V4 P1 M1 真机验收：执行历史 / 目标分组 / 目标变更影响面

- 启动方式：默认数据目录 / ThinkFusion Dev / CDP 9333
- 数据目录：默认 `~/Library/Application Support/thinkfusion-ai`（未提供 THINKFUSION_USER_DATA，未复制用户数据）
- 探针任务：0a429d96-b37e-44b4-9a78-33dff271142f（验收后删除；任务数 2 → 2）

## 结果

- default-store-readable：通过 — /Users/yalla/Library/Application Support/thinkfusion-ai/agent-store.json
- renderer-ready：通过 — CDP 已连接
- probe-task-created：通过 — 0a429d96-b37e-44b4-9a78-33dff271142f
- execution-1-recorded：通过 — {"outcome":"failed","hasReport":true,"steps":{"total":1,"completed":0,"failed":1,"skipped":0,"unknown":false},"failures":1}
- execution-1-carries-failure：通过 — outcome=failed 失败步骤 1 条 失败原因 ["COMMAND_FAILED: 命令退出码 3"]
- execution-1-no-phantom-zero：通过 — sources={"round":true,"report":true,"events":5}
- two-executions-distinct-rounds：通过 — roundId 去重后 2 条
- executions-not-overwritten：通过 — 第 1 条 79039329-604f-4ecc-88b0-8458925a9956 / 第 2 条 518ed40a-7559-406a-8e53-aa05fc82245c
- later-execution-not-overwrite-first：通过 — 第 1 条仍为 round 1，outcome=failed
- run-id-linkage-recorded：通过 — 1:0a429d96-b37e-44b4-9a78-33dff271142f 2:0a429d96-b37e-44b4-9a78-33dff271142f
- report-less-round-marked-unknown：通过 — 本次每轮都有报告
- round-input-types-recorded：通过 — 1:user_prompt 2:execution_report
- ui-execution-card-found：通过 — "执行历史2 次执行 · 1 次失败"
- ui-execution-rows-match-projection：通过 — 界面 2 条 / 同时刻投影 2 条（快照时 2 条）
- ui-execution-rows-show-outcome：通过 — ["执行 #1任务失败23:42:12 → 23:42:13用时 840 ms","执行 #2执行报告完成23:42:31 → 23:44:34用时 2 分 3 秒"]
- ui-execution-rows-honest-about-missing：通过 — 界面缺报告文案=true
- ui-goal-toggle-present：通过 — aria-pressed=true
- ui-goal-groups-rendered：通过 — 分组 3 个
- ui-goal-grouping-toggle-back：通过 — 关分组后 goal-group=0 task-item=3
- live-two-tasks-one-goal：失败 — 无写入路径可产生同目标多任务
- contract-criteria-read：通过 — 1 条：["工作流全部节点执行完成并各自验证通过"]
- append-criteria-is-clarify：通过 — kind=clarify requires=false version=1
- version-not-bumped-on-clarify：通过 — 补充后 v1 / 原来 v1
- removal-requires-confirmation：通过 — kind=change impacted=2
- version-unchanged-before-confirm：通过 — 确认前 v1 / 基线 v1
- structured-event-emitted：通过 — reason=目标变更影响 2 个未完成任务；已完成且不受影响的成果可继承 impacted=2 next=v2
- ui-confirm-card-visible：通过 — "目标变更待确认v1 → v2 · 确认前不抬版本、不改任务"
- ui-card-lists-criteria-and-impact：通过 — 标准 1 条 / 步骤 0 条
- ui-card-impact-count-reconciles：通过 — 受影响 2 条： 可执行步骤 0 条，任务级节点 2 条。 / 事件 impacted=2
- ui-card-folds-structural-nodes：通过 — 另有 2 条任务级节点（任务本体 / 执行计划组） · 就绪，随下属步骤一起重规划｜步骤行 []
- ui-card-steps-free-of-aggregate-rows：通过 — []
- ui-confirm-clicked：通过 — true
- version-bumped-after-confirm：通过 — v2
- card-dismissed-after-confirm：通过 — 刷新后仍在=false
- probe-task-deleted：通过 — before=2 after=2

## 执行台账（界面所见 = 投影所得）

```json
[
  {
    "executionId": "79039329-604f-4ecc-88b0-8458925a9956",
    "roundId": "79039329-604f-4ecc-88b0-8458925a9956",
    "roundNumber": 1,
    "inputType": "user_prompt",
    "runId": "0a429d96-b37e-44b4-9a78-33dff271142f",
    "planId": "35d36f13-1c18-4096-b864-7957eb91d946",
    "roundStatus": "plan_ready",
    "outcome": "failed",
    "nextAction": "stop",
    "verified": true,
    "fullyVerified": true,
    "changedFiles": 0,
    "steps": {
      "total": 1,
      "completed": 0,
      "failed": 1,
      "skipped": 0,
      "unknown": false
    },
    "failureReasons": [
      "COMMAND_FAILED: 命令退出码 3"
    ],
    "deliverables": [],
    "evidenceCount": 1,
    "participants": [],
    "sources": {
      "round": true,
      "report": true,
      "events": 10
    },
    "startedAt": 1795794132204,
    "endedAt": 1795794133044,
    "durationMs": 840
  },
  {
    "executionId": "518ed40a-7559-406a-8e53-aa05fc82245c",
    "roundId": "518ed40a-7559-406a-8e53-aa05fc82245c",
    "roundNumber": 2,
    "inputType": "execution_report",
    "runId": "0a429d96-b37e-44b4-9a78-33dff271142f",
    "planId": "ce75ec69-6f2b-434f-be65-b94ea7e0ec15",
    "roundStatus": "plan_ready",
    "outcome": "completed",
    "nextAction": "continue",
    "verified": true,
    "fullyVerified": true,
    "changedFiles": 0,
    "steps": {
      "total": 5,
      "completed": 5,
      "failed": 0,
      "skipped": 0,
      "unknown": false
    },
    "failureReasons": [],
    "deliverables": [],
    "evidenceCount": 5,
    "participants": [
      {
        "label": "opencode-go/deepseek-v4.1-flash",
        "modelId": "deepseek-v4.1-flash",
        "status": null
      },
      {
        "label": "未记录成员",
        "modelId": null,
        "status": null
      }
    ],
    "sources": {
      "round": true,
      "report": true,
      "events": 22
    },
    "startedAt": 1795794151426,
    "endedAt": 1795794274418,
    "durationMs": 122992
  }
]
```

## 状态序列

created → planning → plan_ready → awaiting_approval → executing → verifying → report_pending → awaiting_next_round → planning → plan_ready → awaiting_approval → executing

## 脚本推动循环的记录

```json
[]
```

## 待确认事件原文

```json
{
  "type": "goal.revision.pending",
  "taskId": "0a429d96-b37e-44b4-9a78-33dff271142f",
  "goalId": "goal:0a429d96-b37e-44b4-9a78-33dff271142f",
  "fromVersion": 1,
  "nextVersion": 2,
  "reason": "目标变更影响 2 个未完成任务；已完成且不受影响的成果可继承",
  "nextCriteria": [
    "工作流全部节点执行完成并各自验证通过"
  ],
  "impactedTaskIds": [
    "wt-work-0a429d96",
    "wt-group-0a429d96"
  ],
  "impactedTasks": [
    {
      "workTaskId": "wt-work-0a429d96",
      "title": "执行计划",
      "status": "ready"
    },
    {
      "workTaskId": "wt-group-0a429d96",
      "title": "执行计划",
      "status": "ready"
    }
  ],
  "inheritedCount": 6,
  "at": 1795794280485,
  "eventId": "b391e526-7841-474a-b8b1-3b7c58fa0d9a",
  "runId": "0a429d96-b37e-44b4-9a78-33dff271142f",
  "sequence": 4618,
  "phase": "execution"
}
```

## 说明与未覆盖项

- 两轮共用同一个 runId：本次是同一次连续执行的续跑，不是两次独立运行。
- 现网数据里没有任何两条任务共用一个 goalId：代码里没有把新任务绑到既有 goalId 的写入路径（task-manager.create 一律写 goal:<taskId>）。M1-2 的「同一 Goal 下 ≥2 Task」真机条件在当前版本无法由界面产生，只验到分组渲染与退回开关。
