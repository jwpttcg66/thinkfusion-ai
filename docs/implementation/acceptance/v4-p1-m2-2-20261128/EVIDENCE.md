# V4 P1 M2-2 真机验收：从检查点续跑成为常规路径

- 时间：2026-11-28T02:42:55.542Z ~ 2026-11-28T02:45:05.993Z
- 环境：默认数据目录 / ThinkFusion Dev / CDP 9333 / SIGKILL 后重启
- 工作区：`/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m2-2-ws-1795833775542`（探针只在这里写文件）
- 探针任务：A 续跑 `36ea5531-0393-467d-a321-be3c72c58111`、B 反例 `9487adcf-5db2-4e8f-bed1-1abbc21868e1`（收尾已删除）
- 备份：context-checkpoints.before.tgz、agent-store.before.json

## 扫盘前 → 启动扫描后

```json
{
  "before": {
    "tasks": 0,
    "goals": [],
    "ownerSegments": [],
    "archiveSegments": []
  },
  "afterSweep": {
    "ownerSegments": [],
    "archiveSegments": [],
    "goals": [],
    "tasks": 0
  },
  "staleProbes": []
}
```

## 两条路径的暂停账本（读磁盘上的检查点，不抄事件）

```json
{
  "A": {
    "checkpointId": "cp_33b18923-7798-4755-89aa-bdb843d1ff3b",
    "line": "工具执行状态：已完成 0 步；副作用核对 applied 6 / missing 0 / needs_reconciliation 0",
    "applied": 6,
    "missing": 0,
    "needsReconciliation": 0
  },
  "B": {
    "checkpointId": "cp_b0bd619c-d53b-45d9-a4f0-d24bfb53bc75",
    "line": "工具执行状态：已完成 0 步；副作用核对 applied 1 / missing 0 / needs_reconciliation 1",
    "applied": 1,
    "missing": 0,
    "needsReconciliation": 1
  }
}
```

## 两条路径的恢复打点

```json
{
  "continued": {
    "event": "context.resume.continued",
    "at": 1795833801144,
    "context": {
      "contextId": "pause:36ea5531-0393-467d-a321-be3c72c58111:1795833791039",
      "checkpointId": "cp_33b18923-7798-4755-89aa-bdb843d1ff3b",
      "pointerSource": "task-fields",
      "reason": "检查点有效、副作用账本无未知缺口，直接续跑已批准计划 79289ed1-f90d-4336-b231-8d57afe10688",
      "resume": {
        "mode": "continue",
        "planId": "79289ed1-f90d-4336-b231-8d57afe10688",
        "roundId": "e279497c-efc7-46ce-b8c1-334cd17b501f",
        "reusedStepIds": [
          "seed-test",
          "write-1",
          "write-2",
          "write-3",
          "write-4",
          "write-5"
        ],
        "pendingStepIds": [
          "write-6",
          "write-7",
          "write-8",
          "write-9",
          "write-10",
          "write-11",
          "write-12",
          "final-gate"
        ],
        "reasons": []
      }
    }
  },
  "replanned": {
    "event": "context.resume.replanned",
    "at": 1795833902146,
    "context": {
      "contextId": "pause:9487adcf-5db2-4e8f-bed1-1abbc21868e1:1795833896169",
      "checkpointId": "cp_b0bd619c-d53b-45d9-a4f0-d24bfb53bc75",
      "pointerSource": "task-fields",
      "reason": "1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）",
      "resume": {
        "mode": "replan",
        "reasons": [
          "1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation）"
        ]
      }
    }
  }
}
```

## 恢复打点附近的事件序列

```json
{
  "A": [
    "marker:context.resume.continued",
    "execution.bridge@e10688",
    "log",
    "task.started",
    "step.reused:seed-test",
    "step.reused:write-1",
    "step.reused:write-2",
    "step.reused:write-3",
    "step.reused:write-4",
    "step.reused:write-5",
    "step.started:write-6",
    "work.task.status",
    "cycle.subtask.snapshot",
    "step.completed:write-6",
    "work.task.status",
    "cycle.subtask.snapshot",
    "step.started:write-7"
  ]
}
```

## 状态序列

```json
{
  "A_pause": [
    "created",
    "planning",
    "plan_ready",
    "awaiting_approval",
    "executing",
    "pause_requested",
    "pausing",
    "paused"
  ],
  "B_pause": [
    "created",
    "planning",
    "plan_ready",
    "awaiting_approval",
    "executing",
    "pause_requested",
    "pausing",
    "paused"
  ]
}
```

## 删除任务时的回收

```json
[
  {
    "tag": "A",
    "taskId": "36ea5531-0393-467d-a321-be3c72c58111",
    "checkpointExistedBeforeDelete": true,
    "goalId": "goal:36ea5531-0393-467d-a321-be3c72c58111",
    "cleanup": {
      "taskId": "36ea5531-0393-467d-a321-be3c72c58111",
      "checkpointsRemoved": true,
      "archiveSegments": 0,
      "goalId": "goal:36ea5531-0393-467d-a321-be3c72c58111",
      "goalReclaimed": false
    }
  },
  {
    "tag": "B",
    "taskId": "9487adcf-5db2-4e8f-bed1-1abbc21868e1",
    "checkpointExistedBeforeDelete": true,
    "goalId": "goal:9487adcf-5db2-4e8f-bed1-1abbc21868e1",
    "cleanup": {
      "taskId": "9487adcf-5db2-4e8f-bed1-1abbc21868e1",
      "checkpointsRemoved": true,
      "archiveSegments": 0,
      "goalId": "goal:9487adcf-5db2-4e8f-bed1-1abbc21868e1",
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
| startup-sweep-removed-orphans | 通过 | 扫前 0 个归属文件 → 扫后 0 个；扫后仍无人认领的：无 |
| startup-sweep-removed-orphan-goals | 通过 | 扫前 0 条目标 → 扫后 0 条（任务表 0 条）；扫后仍无任务绑定的：无 |
| startup-sweep-keeps-live-task-artifacts | 通过 | 任务表 0 条，其中 0 个归属文件被保留（本轮任务表为空，活任务保留这条由 test:pause-checkpoint 覆盖） |
| A-pause-checkpoint-committed | 通过 | 指针 {"contextId":"pause:36ea5531-0393-467d-a321-be3c72c58111:1795833791039","checkpointId":"cp_33b18923-7798-4755-89aa-bdb843d1ff3b","activeRunId":"36ea5531-0393-467d-a321-be3c72c58111"}｜磁盘 context-checkpoints/owners/agent-task/36ea5531-0393-467d-a321-be3c72c58111.json｜文件里的 checkpointId=cp_33b18923-7798-4755-89aa-bdb843d1ff3b |
| A-pause-ledger-has-no-gap | 通过 | 检查点里的账本：工具执行状态：已完成 0 步；副作用核对 applied 6 / missing 0 / needs_reconciliation 0｜暂停事件 needsReconciliation=0 |
| A-paused-survives-late-cancel-report | 通过 | 暂停落地后 paused，再等 4s（报告收尾应已到）→ paused；状态序列 created → planning → plan_ready → awaiting_approval → executing → pause_requested → pausing → paused |
| ui-shows-paused-probe | 通过 | 侧栏选中探针 A（界面要能核对暂停态与计划进度） |
| A-forced-exit | 通过 | SIGKILL 后端口已释放 |
| A-restarted-resumable | 通过 | 状态 paused，resumeStatus=executing，checkpointId=cp_33b18923-7798-4755-89aa-bdb843d1ff3b |
| startup-sweep-keeps-paused-live-task | 通过 | 重启后 owners/agent-task/36ea5531-0393-467d-a321-be3c72c58111.json 仍在：true｜任务表 1 条 |
| A-resume-ipc-accepted | 通过 | resumeTask 正常返回 |
| A-resume-takes-continuation | 通过 | 实际 context.resume.continued；理由 [] |
| A-resume-reads-the-pause-checkpoint | 通过 | 恢复用的是 cp_33b18923-7798-4755-89aa-bdb843d1ff3b（暂停点 cp_33b18923-7798-4755-89aa-bdb843d1ff3b） |
| A-resume-marker-located-in-event-stream | 通过 | 恢复打点在事件流下标 104（共 184 条，按 at=1795833801144 取后段 79 条） |
| A-first-event-after-checkpoint-is-step-not-planning | 通过 | 恢复打点之后第一个执行/规划事件：step.reused（seed-test）｜第一个规划类事件在下标 -1 |
| A-reused-steps-carry-the-checkpoint-id | 通过 | 复用 6 步：seed-test, write-1, write-2, write-3, write-4, write-5｜执行时间戳都在 |
| A-reuses-interrupted-plan | 通过 | 续跑 planId=79289ed1-f90d-4336-b231-8d57afe10688 与被中断那份计划一致（暂停时任务上的 79289ed1-f90d-4336-b231-8d57afe10688）；复用 ["seed-test","write-1","write-2","write-3","write-4","write-5"]，续跑 ["write-6","write-7","write-8","write-9","write-10","write-11","write-12","final-gate"] |
| A-no-round-opened-by-resume | 通过 | 恢复打点到第一个执行事件之间没有 round.started / plan.ready；打点之后 round.started 共 0 条 |
| A-remaining-steps-actually-ran | 通过 | 12 个写步骤文件都在；收尾 shell.run step.completed，退出码 0 |
| A-resumed-report-restores-reused-steps | 通过 | 报告 e279497c-efc7-46ce-b8c1-334cd17b501f（计划 e10688，completed）里标了复用的步骤：seed-test:completed(复用) write-1:completed(复用) write-2:completed(复用) write-3:completed(复用) write-4:completed(复用) write-5:completed(复用)｜整份 ["seed-test:completed(复用)","write-1:completed(复用)","write-2:completed(复用)","write-3:completed(复用)","write-4:completed(复用)","write-5:completed(复用)","write-6:completed","write-7:completed","write-8:completed","write-9:completed","write-10:completed","write-11:completed","write-12:completed","final-gate:completed#0"] |
| A-resume-completes-with-verified-report | 通过 | 任务状态 completed，续跑后的状态序列 verifying → report_pending → completed |
| ui-shows-resumed-probe | 通过 | 侧栏选中探针 A |
| ui-timeline-shows-pause-checkpoint-and-continuation | 通过 | 检查点行 暂停已提交检查点 cp_33b18923-7798-4755-89aa-bdb843d1ff3b（待核对｜续跑行 已从检查点续跑：沿用已批准计划，未重新规划｜「复用自上次执行」出现 6 次 |
| ui-resume-milestone-is-a-row-in-output-panel | 通过 | 「已从检查点续跑」是输出页时间线里的一行，截图前已滚进视口（时间线一屏装不下 184 条事件） |
| ui-conversation-shows-context-notes-on-resume | 通过 | 对话流检查点行 暂停已提交检查点 cp_33b18923-7798-4755-89aa-bdb843d1ff3b（待核对｜续跑行 已从检查点续跑：沿用已批准计划，未重新规划 |
| ui-context-note-is-a-row-in-conversation | 通过 | 「已从检查点续跑」在对话流里是一条 chat-note，截图前已滚进视口 |
| B-pause-checkpoint-reports-gap | 通过 | 暂停事件 needsReconciliation=1；检查点账本 工具执行状态：已完成 0 步；副作用核对 applied 1 / missing 0 / needs_reconciliation 1 |
| ui-shows-paused-gap-probe | 通过 | 侧栏选中探针 B |
| B-resume-ipc-accepted | 通过 | resumeTask 正常返回 |
| B-resume-falls-back-to-replan | 通过 | 实际 context.resume.replanned；理由 1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation） / 1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation） |
| B-replan-reason-names-the-gap | 通过 | 1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation） / 1 个写操作结局未知且无路径可核对：long-shell（needs_reconciliation） |
| B-replan-opens-new-round | 通过 | 新轮 5d531c0e-9999-420b-9b42-cc1eff2e0b24；任务状态 planning |
| ui-shows-replanned-probe | 通过 | 侧栏选中探针 B |
| ui-timeline-shows-replan-naming-the-gap | 通过 | 检查点行 暂停已提交检查点 cp_b0bd619c-d53b-45d9-a4f0-d24bfb53bc75（待核对｜重规划行 已重新规划：检查点不足以安全续跑｜详情点名 无路径可核对：long-shell（needs_reconciliation）", |
| ui-replan-milestone-is-a-row-in-output-panel | 通过 | 「已重新规划：检查点不足以安全续跑」是输出页时间线里的一行，截图前已滚进视口 |
| A-delete-reclaims-checkpoint | 通过 | 删前文件 true，回收结果 {"taskId":"36ea5531-0393-467d-a321-be3c72c58111","checkpointsRemoved":true,"archiveSegments":0,"goalId":"goal:36ea5531-0393-467d-a321-be3c72c58111","goalReclaimed":false} |
| A-delete-reclaims-goal | 通过 | 目标 goal:36ea5531-0393-467d-a321-be3c72c58111 还在不在：false |
| B-delete-reclaims-checkpoint | 通过 | 删前文件 true，回收结果 {"taskId":"9487adcf-5db2-4e8f-bed1-1abbc21868e1","checkpointsRemoved":true,"archiveSegments":0,"goalId":"goal:9487adcf-5db2-4e8f-bed1-1abbc21868e1","goalReclaimed":false} |
| B-delete-reclaims-goal | 通过 | 目标 goal:9487adcf-5db2-4e8f-bed1-1abbc21868e1 还在不在：false |
| disk-has-no-orphan-after-run | 通过 | 探针之外没有无人认领的归属文件 |
| probe-tasks-cleaned-up | 通过 | 任务数 0 → 0 |

合计 43 项，未通过 0 项。

## 截图

- `01-A-paused-with-checkpoint.png`
- `02-A-resumed-from-checkpoint.png`
- `05-A-output-timeline-checkpoint.png`
- `06-A-conversation-context-notes.png`
- `03-B-paused-with-unknown-gap.png`
- `04-B-replanned-with-unknown-gap.png`
- `07-B-output-timeline-replan.png`

## 中断原因

无。
