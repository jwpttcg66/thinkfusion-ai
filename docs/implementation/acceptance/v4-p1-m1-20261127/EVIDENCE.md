# V4 P1 M1 真机验收：执行历史 / 目标实体化与分组 / 目标变更影响面

- 启动方式：默认数据目录 / ThinkFusion Dev / CDP 9333
- 数据目录：默认 `~/Library/Application Support/thinkfusion-ai`（未提供 THINKFUSION_USER_DATA，未复制用户数据）
- 探针任务：2b0a189a-8180-413a-92b7-e1c5000b2586 + 目标下新建 38be442b-f2a6-4e06-9fe3-50d0c83c2161（验收后删除；任务数 0 → 0）

## 结果

- default-store-readable：通过 — /Users/yalla/Library/Application Support/thinkfusion-ai/agent-store.json
- renderer-ready：通过 — CDP 已连接
- probe-task-created：通过 — 2b0a189a-8180-413a-92b7-e1c5000b2586
- execution-1-recorded：通过 — {"outcome":"failed","hasReport":true,"steps":{"total":1,"completed":0,"failed":1,"skipped":0,"unknown":false},"failures":1}
- execution-1-carries-failure：通过 — outcome=failed 失败步骤 1 条 失败原因 ["COMMAND_FAILED: 命令退出码 3"]
- execution-1-no-phantom-zero：通过 — sources={"round":true,"report":true,"events":5}
- two-executions-distinct-rounds：通过 — roundId 去重后 3 条
- executions-not-overwritten：通过 — 第 1 条 bf6ec399-0ed5-4a19-a755-d99a43168f3e / 第 2 条 b658c95c-99d0-4993-9bbc-b9dae5a09f11
- later-execution-not-overwrite-first：通过 — 第 1 条仍为 round 1，outcome=failed
- run-id-linkage-recorded：通过 — 1:2b0a189a-8180-413a-92b7-e1c5000b2586 2:2b0a189a-8180-413a-92b7-e1c5000b2586 3:2b0a189a-8180-413a-92b7-e1c5000b2586
- report-less-round-marked-unknown：通过 — 无报告轮 r2
- round-input-types-recorded：通过 — 1:user_prompt 2:execution_report 3:plan_repair
- ui-execution-card-found：通过 — "执行历史3 次执行 · 1 次失败"
- ui-execution-rows-match-projection：通过 — 界面 3 条 / 同时刻投影 3 条（快照时 3 条）
- ui-execution-rows-show-outcome：通过 — ["执行 #1任务失败08:20:27 → 08:20:28用时 863 ms","执行 #2执行报告未收口08:21:36 → 08:23:53用时 2 分 17 秒","执行 #3计划修正部分完成08:23:53 → 08:26:39用时 2 分 46 秒"]
- ui-execution-rows-honest-about-missing：通过 — 界面缺报告文案=true
- ui-goal-toggle-present：通过 — aria-pressed=true
- ui-goal-groups-rendered：通过 — 分组 1 个
- ui-goal-grouping-toggle-back：通过 — 关分组后 goal-group=0 task-item=1
- planner-mode：通过 — cloud（点名 user:超算:GLM-5.3-Flash）
- planner-page-ready-for-binding：通过 — 执行档源就绪：超算 · GLM-5.3-Flash（reload=false）
- ui-create-in-goal-entry：通过 — {"entry":{"found":true},"form":{"hasTextarea":true,"submitFound":true,"submitDisabled":false}}
- ui-create-in-goal-submitted：通过 — true
- live-two-tasks-one-goal：通过 — 第二条 38be442b-f2a6-4e06-9fe3-50d0c83c2161 挂在 goal:2b0a189a-8180-413a-92b7-e1c5000b2586 下
- second-task-inherits-goal：通过 — goal:2b0a189a-8180-413a-92b7-e1c5000b2586 vs 第一条 goal:2b0a189a-8180-413a-92b7-e1c5000b2586
- second-task-inherits-version：通过 — 第二条 v1 / 目标 v1
- second-task-inherits-criteria：通过 — 第二条 ["工作流全部节点执行完成并各自验证通过"] / 目标当时 ["工作流全部节点执行完成并各自验证通过"]（第一条快照字段 null，标准在它的契约里 1 条）
- ui-goal-group-has-two-tasks：通过 — 分组里 2 条：["V4M1执行历史探针 同目标：只回答上一轮执行历史是否已记录，不要修改任何文件。","工作流：V4M1执行历史探针刚刚删除"]
- ui-reselected-first-probe：通过 — 按标题「工作流：V4M1执行历史探针」回选
- live-goal-grouping-has-binding：通过 — [["goal:2b0a189a-8180-413a-92b7-e1c5000b2586",2]]
- contract-criteria-read：通过 — 1 条：["工作流全部节点执行完成并各自验证通过"]
- append-criteria-is-clarify：通过 — kind=clarify requires=false version=1
- version-not-bumped-on-clarify：通过 — 补充后 v1 / 原来 v1
- removal-requires-confirmation：通过 — kind=change impacted=9
- version-unchanged-before-confirm：通过 — 确认前 v1 / 基线 v1
- structured-event-emitted：通过 — reason=目标变更影响 9 个未完成任务；已完成且不受影响的成果可继承 impacted=9 next=v2
- ui-confirm-card-visible：通过 — "目标变更待确认v1 → v2 · 确认前不抬版本、不改任务"
- ui-card-lists-criteria-and-impact：通过 — 标准 1 条 / 步骤 7 条
- ui-card-impact-count-reconciles：通过 — 受影响 9 条： 可执行步骤 7 条，任务级节点 2 条。 / 事件 impacted=9
- ui-card-folds-structural-nodes：通过 — 另有 2 条任务级节点（任务本体 / 执行计划组） · 就绪，随下属步骤一起重规划｜步骤行 ["goal.get","session.search","session.search","team.task.list","job.list","schedule.list","fs.tree"]
- ui-card-steps-free-of-aggregate-rows：通过 — ["goal.get","session.search","session.search","team.task.list","job.list","schedule.list","fs.tree"]
- event-carries-goal-tasks：通过 — 2 条：[{"taskId":"2b0a189a-8180-413a-92b7-e1c5000b2586","title":"工作流：V4M1执行历史探针","status":"executing"},{"taskId":"38be442b-f2a6-4e06-9fe3-50d0c83c2161","title":"V4M1执行历史探针 同目标：只回答上一轮执行历史是否已记录，不要修改任何文件。","status":"failed"}]
- ui-card-lists-goal-tasks：通过 — 本目标下 2 条任务一起生效：工作流：V4M1执行历史探针（executing）、V4M1执行历史探针 同目标：只回答上一轮执行历史是否已记录，不要修改任何文件。（失败）
- ui-confirm-clicked：通过 — true
- version-bumped-after-confirm：通过 — v2
- fan-out-bumps-sibling-task：通过 — 第二条 v2 / 应为 v2
- fan-out-shares-criteria：通过 — 第二条 ["工作流全部节点执行完成并各自验证通过"] / 第一条 ["工作流全部节点执行完成并各自验证通过"]
- goal-entity-persisted：通过 — {"goalId":"goal:2b0a189a-8180-413a-92b7-e1c5000b2586","title":"工作流：V4M1执行历史探针","version":2,"criteria":["工作流全部节点执行完成并各自验证通过"],"updatedAt":1795825610188}
- card-dismissed-after-confirm：通过 — 刷新后仍在=false
- probe-task-deleted：通过 — before=0 after=0

## 执行台账（界面所见 = 投影所得）

```json
[
  {
    "executionId": "bf6ec399-0ed5-4a19-a755-d99a43168f3e",
    "roundId": "bf6ec399-0ed5-4a19-a755-d99a43168f3e",
    "roundNumber": 1,
    "inputType": "user_prompt",
    "runId": "2b0a189a-8180-413a-92b7-e1c5000b2586",
    "planId": "8d81fecd-2a39-405b-bc95-aab41a3dbac3",
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
      "events": 7
    },
    "startedAt": 1795825227456,
    "endedAt": 1795825228319,
    "durationMs": 863
  },
  {
    "executionId": "b658c95c-99d0-4993-9bbc-b9dae5a09f11",
    "roundId": "b658c95c-99d0-4993-9bbc-b9dae5a09f11",
    "roundNumber": 2,
    "inputType": "execution_report",
    "runId": "2b0a189a-8180-413a-92b7-e1c5000b2586",
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
        "label": "user:超算/GLM-5.3-Flash",
        "modelId": "GLM-5.3-Flash",
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
    "startedAt": 1795825296235,
    "endedAt": 1795825433194,
    "durationMs": 136959
  },
  {
    "executionId": "8de48ffe-80b4-454d-8be6-3e37d211b0a6",
    "roundId": "8de48ffe-80b4-454d-8be6-3e37d211b0a6",
    "roundNumber": 3,
    "inputType": "plan_repair",
    "runId": "2b0a189a-8180-413a-92b7-e1c5000b2586",
    "planId": "89ea1b95-ae90-4abd-b99a-b04fca537648",
    "roundStatus": "plan_ready",
    "outcome": "partial",
    "nextAction": "stop",
    "verified": true,
    "fullyVerified": true,
    "changedFiles": 0,
    "steps": {
      "total": 2,
      "completed": 1,
      "failed": 1,
      "skipped": 0,
      "unknown": false
    },
    "failureReasons": [
      "TOOL_ERROR: 这次执行没有关联会话，无法使用会话级能力",
      "goal.get: 这次执行没有关联会话，无法使用会话级能力"
    ],
    "deliverables": [],
    "evidenceCount": 0,
    "participants": [
      {
        "label": "user:超算/GLM-5.3-Flash",
        "modelId": "GLM-5.3-Flash",
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
      "events": 19
    },
    "startedAt": 1795825433333,
    "endedAt": 1795825599639,
    "durationMs": 166306
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
  "taskId": "2b0a189a-8180-413a-92b7-e1c5000b2586",
  "goalId": "goal:2b0a189a-8180-413a-92b7-e1c5000b2586",
  "fromVersion": 1,
  "nextVersion": 2,
  "reason": "目标变更影响 9 个未完成任务；已完成且不受影响的成果可继承",
  "nextCriteria": [
    "工作流全部节点执行完成并各自验证通过"
  ],
  "impactedTaskIds": [
    "wt-work-2b0a189a",
    "wt-group-2b0a189a",
    "wt-step-2",
    "wt-step-3",
    "wt-step-4",
    "wt-step-5",
    "wt-step-6",
    "wt-step-7",
    "wt-step-8"
  ],
  "impactedTasks": [
    {
      "workTaskId": "wt-work-2b0a189a",
      "title": "执行计划",
      "status": "ready"
    },
    {
      "workTaskId": "wt-group-2b0a189a",
      "title": "执行计划",
      "status": "ready"
    },
    {
      "workTaskId": "wt-step-2",
      "title": "goal.get",
      "status": "failed"
    },
    {
      "workTaskId": "wt-step-3",
      "title": "session.search",
      "status": "pending"
    },
    {
      "workTaskId": "wt-step-4",
      "title": "session.search",
      "status": "pending"
    },
    {
      "workTaskId": "wt-step-5",
      "title": "team.task.list",
      "status": "pending"
    },
    {
      "workTaskId": "wt-step-6",
      "title": "job.list",
      "status": "pending"
    },
    {
      "workTaskId": "wt-step-7",
      "title": "schedule.list",
      "status": "pending"
    },
    {
      "workTaskId": "wt-step-8",
      "title": "fs.tree",
      "status": "pending"
    }
  ],
  "inheritedCount": 2,
  "goalTasks": [
    {
      "taskId": "2b0a189a-8180-413a-92b7-e1c5000b2586",
      "title": "工作流：V4M1执行历史探针",
      "status": "executing"
    },
    {
      "taskId": "38be442b-f2a6-4e06-9fe3-50d0c83c2161",
      "title": "V4M1执行历史探针 同目标：只回答上一轮执行历史是否已记录，不要修改任何文件。",
      "status": "failed"
    }
  ],
  "at": 1795825610030,
  "eventId": "ae91f3e9-e1df-441b-8974-ad9a8618530b",
  "runId": "2b0a189a-8180-413a-92b7-e1c5000b2586",
  "sequence": 9871,
  "phase": "execution"
}
```

## 目标实体化（M1-2：同目标多任务）

- 这一轮的执行档：{"mode":"cloud","selected":["user:超算:GLM-5.3-Flash"],"webLed":false}；就绪的规划源：{"id":"user:超算:GLM-5.3-Flash","label":"超算 · GLM-5.3-Flash","type":"cloud"}
- 第一条任务的目标：{"goalId":"goal:2b0a189a-8180-413a-92b7-e1c5000b2586","goalVersion":1,"title":"工作流：V4M1执行历史探针"}
- 界面「在此目标下新建任务」产生：38be442b-f2a6-4e06-9fe3-50d0c83c2161，绑定 {"goalId":"goal:2b0a189a-8180-413a-92b7-e1c5000b2586","goalVersion":1,"goalCriteria":["工作流全部节点执行完成并各自验证通过"],"contractCriteria":[],"status":"planning"}
- 侧栏分组内容：{"groupCount":1,"items":["V4M1执行历史探针 同目标：只回答上一轮执行历史是否已记录，不要修改任何文件。","工作流：V4M1执行历史探针刚刚删除"]}
- 绑定时两条的快照：第一条 {"goalId":"goal:2b0a189a-8180-413a-92b7-e1c5000b2586","goalVersion":1,"goalCriteria":null,"contractCriteria":["工作流全部节点执行完成并各自验证通过"],"status":"executing"} / 第二条 {"goalId":"goal:2b0a189a-8180-413a-92b7-e1c5000b2586","goalVersion":1,"goalCriteria":["工作流全部节点执行完成并各自验证通过"],"contractCriteria":[],"status":"planning"}
- 绑定时目标实体（继承基准）："store 里还没落盘，改用第一条契约标准"
- 确认后第二条：v2，标准 ["工作流全部节点执行完成并各自验证通过"]
- 落库目标实体 `store.goals`：{"goalId":"goal:2b0a189a-8180-413a-92b7-e1c5000b2586","title":"工作流：V4M1执行历史探针","version":2,"criteria":["工作流全部节点执行完成并各自验证通过"],"updatedAt":1795825610188}

## 说明与未覆盖项

- 两轮共用同一个 runId：本次是同一次连续执行的续跑，不是两次独立运行。
