# P0-3 真机验收：在途 shell.run 中断

- 启动方式：默认数据目录 / ThinkFusion Dev / CDP 9333
- 数据目录：默认 `~/Library/Application Support/thinkfusion-ai`
- 探针任务：17cb09d7-08ef-4836-8b75-0ea3f3fabd3a（验收后删除；用户任务数 0 → 0）
- 标记文件：`/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-p0-3-marker-1795764013043.txt`（在途进程若继续跑完就会出现）

## 结果

- default-store-readable：通过 — /Users/yalla/Library/Application Support/thinkfusion-ai/agent-store.json
- renderer-ready：通过 — CDP 已连接
- probe-task-created：通过 — 17cb09d7-08ef-4836-8b75-0ea3f3fabd3a
- shell-step-started：通过 — 1795764021565
- pause-waited-for-runtime：通过 — paused=paused
- step-result-interrupted：通过 — 命令已被用户中断（SIGTERM)，stdout/stderr 与退出码见执行结果
- report-marks-interrupted：通过 — [{"stepId":"long-shell","code":"COMMAND_INTERRUPTED","message":"命令已被用户中断（SIGTERM)，stdout/stderr 与退出码见执行结果"}]
- terminated-promptly：通过 — 628ms
- late-write-never-happened：通过 — /var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-p0-3-marker-1795764013043.txt
- probe-task-deleted：通过 — before=0 after=0

## 事件摘要

```json
[
  {
    "type": "step.started",
    "at": 1795764021565,
    "tool": "shell.run",
    "error": null,
    "status": null,
    "errors": null
  },
  {
    "type": "step.failed",
    "at": 1795764022193,
    "tool": "shell.run",
    "error": "命令已被用户中断（SIGTERM)，stdout/stderr 与退出码见执行结果",
    "status": null,
    "errors": null
  },
  {
    "type": "report.ready",
    "at": 1795764022392,
    "tool": null,
    "error": null,
    "status": "failed",
    "errors": [
      {
        "stepId": "long-shell",
        "code": "COMMAND_INTERRUPTED",
        "message": "命令已被用户中断（SIGTERM)，stdout/stderr 与退出码见执行结果"
      }
    ]
  }
]
```
