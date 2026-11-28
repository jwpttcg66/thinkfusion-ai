# V4 P1 M2-1 真机验收：检查点指针一致性与恢复路径

- 时间：2026-11-28T00:43:54.856Z ~ 2026-11-28T00:44:14.184Z
- 环境：默认数据目录 / ThinkFusion Dev / CDP 9333
- 探针任务：`41d81e2d-836a-4c2d-9107-fdb6a393a716`（收尾已删除）
- 落库指针：{"contextId":"pause:41d81e2d-836a-4c2d-9107-fdb6a393a716:1795826643342","checkpointId":"cp_02987a71-3473-479b-a788-3f8c748aeb6b","activeRunId":"41d81e2d-836a-4c2d-9107-fdb6a393a716"}
- 检查点文件：/Users/yalla/Library/Application Support/thinkfusion-ai/context-checkpoints/owners/agent-task/41d81e2d-836a-4c2d-9107-fdb6a393a716.json（contextId=pause:41d81e2d-836a-4c2d-9107-fdb6a393a716:1795826643342 runId=41d81e2d-836a-4c2d-9107-fdb6a393a716）
- 暂停事件指针：{"contextId":"pause:41d81e2d-836a-4c2d-9107-fdb6a393a716:1795826643342","checkpointId":"cp_02987a71-3473-479b-a788-3f8c748aeb6b","activeRunId":"41d81e2d-836a-4c2d-9107-fdb6a393a716"}
- 状态序列：created → planning → plan_ready → awaiting_approval → executing → pause_requested → pausing → paused
- 抹掉指针重启后的恢复打点：{"pointerSource":"events-replay","contextId":"pause:41d81e2d-836a-4c2d-9107-fdb6a393a716:1795826643342","checkpointId":"cp_02987a71-3473-479b-a788-3f8c748aeb6b","reason":"任务指针字段缺失，已按事件流最后一条检查点事件重建指针并校验通过","sideEffects":{"applied":2,"missing":0,"needsReconciliation":1}}
- store 备份：../docs/implementation/acceptance/v4-p1-m2-1-20261128/agent-store.before-strip.json

## 断言结果

| 断言 | 结果 | 实测 |
| --- | --- | --- |
| default-store-readable | 通过 | /Users/yalla/Library/Application Support/thinkfusion-ai/agent-store.json |
| renderer-ready | 通过 | CDP 已连接 |
| probe-task-created | 通过 | 41d81e2d-836a-4c2d-9107-fdb6a393a716 |
| pointer-fields-complete | 通过 | {"contextId":"pause:41d81e2d-836a-4c2d-9107-fdb6a393a716:1795826643342","checkpointId":"cp_02987a71-3473-479b-a788-3f8c748aeb6b","activeRunId":"41d81e2d-836a-4c2d-9107-fdb6a393a716"} |
| pointer-fields-persisted-to-store | 通过 | {"contextId":"pause:41d81e2d-836a-4c2d-9107-fdb6a393a716:1795826643342","checkpointId":"cp_02987a71-3473-479b-a788-3f8c748aeb6b","activeRunId":"41d81e2d-836a-4c2d-9107-fdb6a393a716"} |
| pointer-matches-checkpoint-file | 通过 | 文件 contextId=pause:41d81e2d-836a-4c2d-9107-fdb6a393a716:1795826643342 runId=41d81e2d-836a-4c2d-9107-fdb6a393a716 |
| pause-event-carries-full-pointer | 通过 | 事件 contextId=pause:41d81e2d-836a-4c2d-9107-fdb6a393a716:1795826643342 activeRunId=41d81e2d-836a-4c2d-9107-fdb6a393a716 |
| checkpoint-summary-truthful | 通过 | 目标版本 v1 / 任务树 revision 3 / 暂停原因：pause / 工具执行状态：已完成 0 步；副作用核对 applied 1 / missing 0 / needs_reconciliation 1 ｜ 证据 ["/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m2-1-written-1795826634856.txt"] |
| late-write-never-happened | 通过 | /var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m2-1-late-1795826634856.txt |
| written-file-still-there | 通过 | /var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m2-1-written-1795826634856.txt |
| probe-task-selected-in-ui | 通过 | 任务详情页 |
| pointer-fields-stripped-offline | 通过 | 抹掉的是 {"contextId":"pause:41d81e2d-836a-4c2d-9107-fdb6a393a716:1795826643342","checkpointId":"cp_02987a71-3473-479b-a788-3f8c748aeb6b","activeRunId":"41d81e2d-836a-4c2d-9107-fdb6a393a716"}，备份 ../docs/implementation/acceptance/v4-p1-m2-1-20261128/agent-store.before-strip.json |
| renderer-ready-after-restart | 通过 | CDP 已连接（未重编译，读的是同一份 store） |
| restarted-still-paused-without-pointer | 通过 | 状态 paused，指针 {"contextId":null,"checkpointId":null,"activeRunId":null} |
| recovered-event-emitted | 通过 | {"pointerSource":"events-replay","contextId":"pause:41d81e2d-836a-4c2d-9107-fdb6a393a716:1795826643342","checkpointId":"cp_02987a71-3473-479b-a788-3f8c748aeb6b","reason":"任务指针字段缺失，已按事件流最后一条检查点事件重建指针并校验通过","sideEffects":{"applied":2,"missing":0,"needsReconciliation":1}} |
| recovery-path-is-observable | 通过 | pointerSource=events-replay |
| rebuilt-pointer-points-at-pause-checkpoint | 通过 | 重建 cp_02987a71-3473-479b-a788-3f8c748aeb6b / 暂停 cp_02987a71-3473-479b-a788-3f8c748aeb6b |
| recovered-side-effect-ledger | 通过 | {"applied":2,"missing":0,"needsReconciliation":1} |
| probe-task-deleted | 通过 | before=0 after=0 |

合计 19 项，未通过 0 项。

## 未覆盖项

- 正常路径（指针字段齐全）的 `context.recovered` 打点只由自动化测试覆盖：真机这一轮
  重启后刻意抹掉字段，走的是重建路径；字段齐全时的 `pointerSource=task-fields` 见
  `test:checkpoint-pointer`。
- `context.checkpoint.paused` 带 `contextId/activeRunId` 后，检查点文件与事件谁先落盘
  仍未验证（Journal 事务里事件与指针同写，但「事件落库、文件没落」的窗口没有测）。
- 探针任务删除后 `context-checkpoints/owners/agent-task/<taskId>.json` 仍留在盘上，
  属 M2-2 的回收缺口，本脚本不删用户数据。

## 中断原因

无。
