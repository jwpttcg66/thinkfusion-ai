# V4 P1 M1 真机验收：执行历史 / 目标分组 / 目标变更影响面

- 启动方式：默认数据目录 / ThinkFusion Dev / CDP 9333
- 数据目录：默认 `~/Library/Application Support/thinkfusion-ai`（未提供 THINKFUSION_USER_DATA，未复制用户数据）
- 探针任务：6a8b9375-9220-4f18-aeee-0842b027908a（验收后删除；任务数 2 → 2）

## 结果

- default-store-readable：通过 — /Users/yalla/Library/Application Support/thinkfusion-ai/agent-store.json
- renderer-ready：通过 — CDP 已连接
- probe-task-created：通过 — 6a8b9375-9220-4f18-aeee-0842b027908a
- execution-1-recorded：通过 — {"outcome":"failed","hasReport":true,"steps":{"total":1,"completed":0,"failed":1,"skipped":0,"unknown":false},"failures":1}
- execution-1-carries-failure：通过 — outcome=failed 失败步骤 1 条 失败原因 ["COMMAND_FAILED: 命令退出码 3"]
- execution-1-no-phantom-zero：通过 — sources={"round":true,"report":true,"events":5}
- two-executions-distinct-rounds：通过 — roundId 去重后 4 条
- executions-not-overwritten：通过 — 第 1 条 2d0703fc-36b0-47cd-be8e-46277e9769c5 / 第 2 条 1513d1ba-60a7-4d77-a56b-ded03e779cae
- later-execution-not-overwrite-first：通过 — 第 1 条仍为 round 1，outcome=failed
- run-id-linkage-recorded：通过 — 1:6a8b9375-9220-4f18-aeee-0842b027908a 2:6a8b9375-9220-4f18-aeee-0842b027908a 3:6a8b9375-9220-4f18-aeee-0842b027908a 4:6a8b9375-9220-4f18-aeee-0842b027908a
- report-less-round-marked-unknown：通过 — 无报告轮 r2,r3
- round-input-types-recorded：通过 — 1:user_prompt 2:execution_report 3:plan_repair 4:plan_repair
- ui-execution-card-found：通过 — "执行历史4 次执行 · 1 次失败"
- ui-execution-rows-match-projection：通过 — 界面 4 条 / 同时刻投影 4 条（快照时 4 条）
- ui-execution-rows-show-outcome：通过 — ["执行 #1任务失败23:31:51 → 23:31:52用时 840 ms","执行 #2执行报告未收口23:32:16 → 23:32:33用时 17.1 s","执行 #3计划修正未收口23:32:34 → 23:32:51用时 17.0 s"]
- ui-execution-rows-honest-about-missing：通过 — 界面缺报告文案=true
- ui-goal-toggle-present：通过 — aria-pressed=true
- ui-goal-groups-rendered：通过 — 分组 3 个
- ui-goal-grouping-toggle-back：通过 — 关分组后 goal-group=0 task-item=3
- live-two-tasks-one-goal：失败 — 无写入路径可产生同目标多任务
- contract-criteria-read：通过 — 1 条：["工作流全部节点执行完成并各自验证通过"]
- append-criteria-is-clarify：通过 — kind=clarify requires=false version=1
- version-not-bumped-on-clarify：通过 — 补充后 v1 / 原来 v1
- removal-requires-confirmation：通过 — kind=change impacted=7
- version-unchanged-before-confirm：通过 — 确认前 v1 / 基线 v1
- structured-event-emitted：通过 — reason=目标变更影响 7 个未完成任务；已完成且不受影响的成果可继承 impacted=7 next=v2
- ui-confirm-card-visible：通过 — "目标变更待确认v1 → v2 · 确认前不抬版本、不改任务"
- ui-card-lists-criteria-and-impact：通过 — 标准 1 条 / 受影响 7 条
- ui-confirm-clicked：通过 — true
- version-bumped-after-confirm：通过 — v2
- card-dismissed-after-confirm：通过 — 刷新后仍在=false
- probe-task-deleted：通过 — before=2 after=2

## 执行台账（界面所见 = 投影所得）

```json
[
  {
    "executionId": "2d0703fc-36b0-47cd-be8e-46277e9769c5",
    "roundId": "2d0703fc-36b0-47cd-be8e-46277e9769c5",
    "roundNumber": 1,
    "inputType": "user_prompt",
    "runId": "6a8b9375-9220-4f18-aeee-0842b027908a",
    "planId": "7808f2ce-d66a-44d2-a0f9-c730564a0368",
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
      "events": 12
    },
    "startedAt": 1795793511452,
    "endedAt": 1795793512292,
    "durationMs": 840
  },
  {
    "executionId": "1513d1ba-60a7-4d77-a56b-ded03e779cae",
    "roundId": "1513d1ba-60a7-4d77-a56b-ded03e779cae",
    "roundNumber": 2,
    "inputType": "execution_report",
    "runId": "6a8b9375-9220-4f18-aeee-0842b027908a",
    "planId": null,
    "roundStatus": "plan_invalid",
    "outcome": null,
    "nextAction": null,
    "verified": null,
    "fullyVerified": null,
    "changedFiles": null,
    "steps": {
      "total": 0,
      "completed": 0,
      "failed": 0,
      "skipped": 0,
      "unknown": true
    },
    "failureReasons": [],
    "deliverables": [],
    "evidenceCount": 0,
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
      "report": false,
      "events": 4
    },
    "startedAt": 1795793536817,
    "endedAt": 1795793553887,
    "durationMs": 17070
  },
  {
    "executionId": "72ef9493-8ea9-45f2-855b-ff1809d03332",
    "roundId": "72ef9493-8ea9-45f2-855b-ff1809d03332",
    "roundNumber": 3,
    "inputType": "plan_repair",
    "runId": "6a8b9375-9220-4f18-aeee-0842b027908a",
    "planId": null,
    "roundStatus": "plan_invalid",
    "outcome": null,
    "nextAction": null,
    "verified": null,
    "fullyVerified": null,
    "changedFiles": null,
    "steps": {
      "total": 0,
      "completed": 0,
      "failed": 0,
      "skipped": 0,
      "unknown": true
    },
    "failureReasons": [],
    "deliverables": [],
    "evidenceCount": 0,
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
      "report": false,
      "events": 4
    },
    "startedAt": 1795793554023,
    "endedAt": 1795793571047,
    "durationMs": 17024
  },
  {
    "executionId": "3ef15686-4922-4fff-bcc4-f43c40bf9b0d",
    "roundId": "3ef15686-4922-4fff-bcc4-f43c40bf9b0d",
    "roundNumber": 4,
    "inputType": "plan_repair",
    "runId": "6a8b9375-9220-4f18-aeee-0842b027908a",
    "planId": "d266f1e8-c416-4114-8e52-d6553c94840c",
    "roundStatus": "plan_ready",
    "outcome": "partial",
    "nextAction": "stop",
    "verified": true,
    "fullyVerified": true,
    "changedFiles": 0,
    "steps": {
      "total": 5,
      "completed": 4,
      "failed": 1,
      "skipped": 0,
      "unknown": false
    },
    "failureReasons": [
      "COMMAND_FAILED: 命令退出码 128",
      "shell.run: 命令退出码 128"
    ],
    "deliverables": [],
    "evidenceCount": 1,
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
      "events": 26
    },
    "startedAt": 1795793571184,
    "endedAt": 1795793594795,
    "durationMs": 23611
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
  "taskId": "6a8b9375-9220-4f18-aeee-0842b027908a",
  "goalId": "goal:6a8b9375-9220-4f18-aeee-0842b027908a",
  "fromVersion": 1,
  "nextVersion": 2,
  "reason": "目标变更影响 7 个未完成任务；已完成且不受影响的成果可继承",
  "nextCriteria": [
    "工作流全部节点执行完成并各自验证通过"
  ],
  "impactedTaskIds": [
    "wt-work-6a8b9375",
    "wt-group-6a8b9375",
    "wt-s5",
    "wt-s6",
    "wt-s7",
    "wt-s8",
    "wt-s9"
  ],
  "impactedTasks": [
    {
      "workTaskId": "wt-work-6a8b9375",
      "title": "执行计划",
      "status": "ready"
    },
    {
      "workTaskId": "wt-group-6a8b9375",
      "title": "执行计划",
      "status": "ready"
    },
    {
      "workTaskId": "wt-s5",
      "title": "shell.run",
      "status": "failed"
    },
    {
      "workTaskId": "wt-s6",
      "title": "git.log",
      "status": "pending"
    },
    {
      "workTaskId": "wt-s7",
      "title": "fs.search",
      "status": "pending"
    },
    {
      "workTaskId": "wt-s8",
      "title": "session.search",
      "status": "pending"
    },
    {
      "workTaskId": "wt-s9",
      "title": "time.now",
      "status": "pending"
    }
  ],
  "inheritedCount": 5,
  "at": 1795793601037,
  "eventId": "c9792b32-4d67-4af7-8acf-98b87f5b57ed",
  "runId": "6a8b9375-9220-4f18-aeee-0842b027908a",
  "sequence": 1783,
  "phase": "execution"
}
```

## 说明与未覆盖项

- 两轮共用同一个 runId：本次是同一次连续执行的续跑，不是两次独立运行。
- 现网数据里没有任何两条任务共用一个 goalId：代码里没有把新任务绑到既有 goalId 的写入路径（task-manager.create 一律写 goal:<taskId>）。M1-2 的「同一 Goal 下 ≥2 Task」真机条件在当前版本无法由界面产生，只验到分组渲染与退回开关。
