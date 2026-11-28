# V4 P1 M3-3 真机验收：预算超限拦得下、说得清、加得回去、加完接回循环

- 时间：2026-11-28T08:42:12.781Z ~ 2026-11-28T08:42:57.905Z
- 墙钟：45 秒（A 段跑 1 个真轮次 + B 段一次真重启，用例刻意压短；「≥2 小时无人值守」是 M3 闸门项，不在本条范围内）
- 环境：默认数据目录 / ThinkFusion Dev / CDP 9333 / A 段跑出一个真轮次，停进程改探针落库预算后重启走常规 resume
- 数据目录：`/Users/yalla/Library/Application Support/thinkfusion-ai`（默认，未隔离）；store 备份：agent-store.before.json
- 工作区：`/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-3-ws-1795855332781`（探针只在这里读文件）
- 默认预算：{"maxRounds":20}（只有轮数有上限；模型调用与 token 现网没有任务级账本，如实记未记账）
- 探针任务：'c915c69b-f756-4a5a-be94-af445e0dca71'（已删除）

## 超限前置条件怎么来的（如实记录）

预算按设计只增不减，默认 20 轮不可能在验收窗口内自然跑满。A 段跑出 **1 个真轮次**后停进程，
把探针任务自己的落库记录改成「轮数已用满 + 无当前计划 + 状态 interrupted」（等价于「老任务带着小上限被恢复」这条真实形态），
重启后走常规 `task:resume`。判定、落点、事件、界面读数的代码路径一行没绕；改动只涉及探针记录，动盘前已备份，跑完删探针。

```json
{
  "rounds": 1,
  "budget": {
    "maxRounds": 1,
    "maxModelCalls": 40
  },
  "status": "interrupted",
  "note": "改的是探针自己的落库记录（备份见 backups.store）；判定/落点/事件/界面代码路径未绕"
}
```

## A 段：IPC 边界 / 落盘 / 只增不减 / 界面读数

```json
{
  "taskId": "c915c69b-f756-4a5a-be94-af445e0dca71",
  "conversationId": "620caf4b-d6a0-4b2a-a726-48c392696cf4",
  "rejected": [
    {
      "input": {
        "taskId": "c915c69b-f756-4a5a-be94-af445e0dca71",
        "maxRounds": 0
      },
      "why": "脏值 0 会被读成「一开局就超限」",
      "ok": false,
      "error": "Error invoking remote method 'task:set-budget': [\n  {\n    \"code\": \"too_small\",\n    \"minimum\": 0,\n    \"type\": \"number\",\n    \"inclusive\": false,\n    \"exact\": false,\n    \"message\": \"Number must be greater than 0\",\n    \"path\": [\n      \"maxRounds\"\n    ]\n  }\n]"
    },
    {
      "input": {
        "taskId": "c915c69b-f756-4a5a-be94-af445e0dca71",
        "maxRounds": -2
      },
      "why": "负数同上",
      "ok": false,
      "error": "Error invoking remote method 'task:set-budget': [\n  {\n    \"code\": \"too_small\",\n    \"minimum\": 0,\n    \"type\": \"number\",\n    \"inclusive\": false,\n    \"exact\": false,\n    \"message\": \"Number must be greater than 0\",\n    \"path\": [\n      \"maxRounds\"\n    ]\n  }\n]"
    },
    {
      "input": {
        "taskId": "c915c69b-f756-4a5a-be94-af445e0dca71",
        "maxRounds": 1.5
      },
      "why": "小数轮数没有意义",
      "ok": false,
      "error": "Error invoking remote method 'task:set-budget': [\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"integer\",\n    \"received\": \"float\",\n    \"message\": \"Expected integer, received float\",\n    \"path\": [\n      \"maxRounds\"\n    ]\n  }\n]"
    },
    {
      "input": {
        "taskId": "c915c69b-f756-4a5a-be94-af445e0dca71",
        "maxRounds": "12"
      },
      "why": "字符串轮数不能被当成数字",
      "ok": false,
      "error": "Error invoking remote method 'task:set-budget': [\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"number\",\n    \"received\": \"string\",\n    \"path\": [\n      \"maxRounds\"\n    ],\n    \"message\": \"Expected number, received string\"\n  }\n]"
    },
    {
      "input": {
        "taskId": "c915c69b-f756-4a5a-be94-af445e0dca71"
      },
      "why": "一条维度都不指，改的是什么说不清",
      "ok": false,
      "error": "Error invoking remote method 'task:set-budget': [\n  {\n    \"code\": \"custom\",\n    \"message\": \"至少指出一条预算维度\",\n    \"path\": []\n  }\n]"
    },
    {
      "input": {
        "taskId": "c915c69b-f756-4a5a-be94-af445e0dca71",
        "maxRounds": 3,
        "nonsense": 1
      },
      "why": "多余键必须拒绝（strict），不能悄悄吞掉用户以为写了的字段",
      "ok": false,
      "error": "Error invoking remote method 'task:set-budget': [\n  {\n    \"code\": \"unrecognized_keys\",\n    \"keys\": [\n      \"nonsense\"\n    ],\n    \"path\": [],\n    \"message\": \"Unrecognized key(s) in object: 'nonsense'\"\n  }\n]"
    }
  ],
  "card": {
    "text": "预算 仍可开新一轮 轮数 1/25 模型调用 未设限 Token 未设限 判定用的数 本轮还没有判定",
    "head": "仍可开新一轮",
    "rows": [
      "轮数 1/25",
      "模型调用 未设限",
      "Token 未设限",
      "判定用的数 本轮还没有判定"
    ],
    "hasInput": false,
    "hasButton": false,
    "buttonDisabled": null
  },
  "unaccountedDim": {
    "receipt": {
      "budget": {
        "maxRounds": 25,
        "maxModelCalls": 40
      },
      "gate": {
        "ok": true,
        "reason": "轮数 1/25，模型调用已设上限但没有调用计数",
        "blockedBy": []
      },
      "status": "failed",
      "state": {
        "exceeded": [],
        "unknowns": [
          "model_calls"
        ],
        "tokenAccounting": "unknown",
        "usage": {
          "rounds": 1,
          "modelCalls": null,
          "tokens": null
        },
        "limits": {
          "maxRounds": 25,
          "maxModelCalls": 40,
          "maxTokens": null
        }
      }
    },
    "recompute": {
      "exceeded": [],
      "unknowns": [
        "model_calls"
      ],
      "tokenAccounting": "unknown",
      "usage": {
        "rounds": 1,
        "modelCalls": null,
        "tokens": null
      },
      "limits": {
        "maxRounds": 25,
        "maxModelCalls": 40,
        "maxTokens": null
      }
    },
    "card": {
      "text": "预算 仍可开新一轮 轮数 1/25 模型调用 未记账 Token 未设限 判定用的数 本轮还没有判定",
      "head": "仍可开新一轮",
      "rows": [
        "轮数 1/25",
        "模型调用 未记账",
        "Token 未设限",
        "判定用的数 本轮还没有判定"
      ],
      "hasInput": false,
      "hasButton": false,
      "buttonDisabled": null
    }
  }
}
```

## B 段：超限暂停 → 追加预算 → 接回循环

```json
{
  "precondition": {
    "rounds": 1,
    "budget": {
      "maxRounds": 1,
      "maxModelCalls": 40
    },
    "status": "interrupted",
    "note": "改的是探针自己的落库记录（备份见 backups.store）；判定/落点/事件/界面代码路径未绕"
  },
  "rounds": 1,
  "resumeOutcome": {
    "state": "settled",
    "ok": true
  },
  "status": "budget_exhausted",
  "error": "预算已用尽（轮数 1/1，模型调用已设上限但没有调用计数），任务暂停等你追加预算或选择收口",
  "exhaustEvent": {
    "type": "task.budget.exhausted",
    "at": 1795855354180,
    "taskId": "c915c69b-f756-4a5a-be94-af445e0dca71",
    "reason": "轮数 1/1，模型调用已设上限但没有调用计数",
    "budget": {
      "maxRounds": 1,
      "maxModelCalls": 40
    },
    "budgetUsage": {
      "rounds": 1,
      "modelCalls": null,
      "tokens": null
    },
    "eventId": "06220fb2-54fb-4eb7-89b6-59ffa226c8bc",
    "runId": "c915c69b-f756-4a5a-be94-af445e0dca71",
    "sequence": 22,
    "phase": "execution"
  },
  "expectGate": {
    "ok": false,
    "reason": "轮数 1/1，模型调用已设上限但没有调用计数",
    "blockedBy": [
      "rounds"
    ]
  },
  "roundsAfterResume": 1,
  "note": {
    "hit": [
      "预算用尽，任务已暂停 · 轮数 1/1，模型调用已设上限但没有调用计数 详情",
      "预算用尽，任务已暂停 · 轮数 1/1，模型调用已设上限但没有调用计数",
      "预算已更新 · 轮数上限 20 → 25 详情",
      "预算已更新 · 轮数上限 20 → 25",
      "预算已更新 · 轮数上限 25 → 25 详情",
      "预算已更新 · 轮数上限 25 → 25"
    ],
    "paused": true,
    "pausedText": "预算用尽，任务已暂停 · 轮数 1/1，模型调用已设上限但没有调用计数 详情",
    "howBack": true
  },
  "card": {
    "text": "预算 已用尽：轮数 轮数 1/1 模型调用 未记账 Token 未设限 判定用的数 本轮还没有判定 追加轮数 追加并继续",
    "head": "已用尽：轮数",
    "rows": [
      "轮数 1/1",
      "模型调用 未记账",
      "Token 未设限",
      "判定用的数 本轮还没有判定",
      "追加轮数 追加并继续"
    ],
    "hasInput": true,
    "hasButton": true,
    "buttonDisabled": false
  },
  "extend": {
    "request": 3,
    "receipt": {
      "ok": true,
      "value": {
        "budget": {
          "maxRounds": 3,
          "maxModelCalls": 40
        },
        "gate": {
          "ok": true,
          "reason": "轮数 1/3，模型调用已设上限但没有调用计数",
          "blockedBy": []
        },
        "status": "budget_exhausted",
        "state": {
          "exceeded": [],
          "unknowns": [
            "model_calls"
          ],
          "tokenAccounting": "unknown",
          "usage": {
            "rounds": 2,
            "modelCalls": null,
            "tokens": null
          },
          "limits": {
            "maxRounds": 3,
            "maxModelCalls": 40,
            "maxTokens": null
          }
        }
      }
    },
    "expectOpen": {
      "ok": true,
      "reason": "轮数 1/3，模型调用已设上限但没有调用计数",
      "blockedBy": []
    },
    "event": {
      "type": "task.budget.updated",
      "at": 1795855364610,
      "taskId": "c915c69b-f756-4a5a-be94-af445e0dca71",
      "budget": {
        "maxRounds": 3,
        "maxModelCalls": 40
      },
      "previous": {
        "maxRounds": 1,
        "maxModelCalls": 40
      },
      "source": "user",
      "gate": {
        "ok": true,
        "reason": "轮数 1/3，模型调用已设上限但没有调用计数",
        "blockedBy": []
      },
      "eventId": "52f04776-6a55-4294-9bb9-c56f1ed868d9",
      "runId": "c915c69b-f756-4a5a-be94-af445e0dca71",
      "sequence": 25,
      "phase": "execution"
    }
  },
  "afterResume": {
    "status": "planning",
    "error": null,
    "rounds": 2,
    "fired": {
      "state": "settled",
      "ok": true
    }
  },
  "cardAfterResume": {
    "text": "预算 仍可开新一轮 轮数 2/3 模型调用 未记账 Token 未设限 判定用的数 本轮还没有判定 追加轮数 追加并继续",
    "head": "仍可开新一轮",
    "rows": [
      "轮数 2/3",
      "模型调用 未记账",
      "Token 未设限",
      "判定用的数 本轮还没有判定",
      "追加轮数 追加并继续"
    ],
    "hasInput": true,
    "hasButton": true,
    "buttonDisabled": false
  },
  "headRounds": 2
}
```

## 中断原因

无。

## 结论（四条主张逐条对上的实测）

1. **拦得下**：超限后状态 `budget_exhausted`（不是终态 `failed`），停手期间轮数 1 → 1（没有偷开新一轮）。
2. **说得清**：`task.budget.exhausted.reason`=「轮数 1/1，模型调用已设上限但没有调用计数」与脚本用同一批纯函数反算的结果逐字相同；活动流旁注与折叠详情见 `ui-exhaust-note`。
3. **加得回去**：追加到 3 轮后门禁放行，回执 gate={"ok":true,"reason":"轮数 1/3，模型调用已设上限但没有调用计数","blockedBy":[]}，落库同步。
4. **接回循环**：加完预算状态 planning、轮数 1 → 2——真的开出下一轮，不是只改个数。

## 断言结果

| 断言 | 结果 | 实测 |
| --- | --- | --- |
| default-store-readable | 通过 | /Users/yalla/Library/Application Support/thinkfusion-ai/agent-store.json |
| a-probe-created | 通过 | task=c915c69b conv=620caf4b |
| a-budget-persisted-on-create | 通过 | 落库 budget={"maxRounds":20}，显示别名 maxRounds=20 |
| a-probe-cancelled | 通过 | 状态 failed｜轮数 1 → 1 |
| a-round-counted | 通过 | store.rounds 里这条任务有 1 轮 |
| a-dirty-rejected:{"taskId":"c915c69b-f756-4a5a-be94-af445e0dca71","maxRounds":0} | 通过 | 边界拒了：Error invoking remote method 'task:set-budget': [ { "code": "too_small", "minimum": 0, "type": "number", "inclusive": false, "exact": fals｜理由 脏值 0 会被读成「一开局就超限」 |
| a-dirty-rejected:{"taskId":"c915c69b-f756-4a5a-be94-af445e0dca71","maxRounds":-2} | 通过 | 边界拒了：Error invoking remote method 'task:set-budget': [ { "code": "too_small", "minimum": 0, "type": "number", "inclusive": false, "exact": fals｜理由 负数同上 |
| a-dirty-rejected:{"taskId":"c915c69b-f756-4a5a-be94-af445e0dca71","maxRounds":1.5} | 通过 | 边界拒了：Error invoking remote method 'task:set-budget': [ { "code": "invalid_type", "expected": "integer", "received": "float", "message": "Expected i｜理由 小数轮数没有意义 |
| a-dirty-rejected:{"taskId":"c915c69b-f756-4a5a-be94-af445e0dca71","maxRounds":"12"} | 通过 | 边界拒了：Error invoking remote method 'task:set-budget': [ { "code": "invalid_type", "expected": "number", "received": "string", "path": [ "maxRo｜理由 字符串轮数不能被当成数字 |
| a-dirty-rejected:{"taskId":"c915c69b-f756-4a5a-be94-af445e0dca71"} | 通过 | 边界拒了：Error invoking remote method 'task:set-budget': [ { "code": "custom", "message": "至少指出一条预算维度", "path": [] } ]｜理由 一条维度都不指，改的是什么说不清 |
| a-dirty-rejected:{"taskId":"c915c69b-f756-4a5a-be94-af445e0dca71","maxRounds":3,"nonsense":1} | 通过 | 边界拒了：Error invoking remote method 'task:set-budget': [ { "code": "unrecognized_keys", "keys": [ "nonsense" ], "path": [], "message": "Unr｜理由 多余键必须拒绝（strict），不能悄悄吞掉用户以为写了的字段 |
| a-append-accepted | 通过 | 回执 {"budget":{"maxRounds":25},"gate":{"ok":true,"reason":"轮数 1/25","blockedBy":[]},"status":"failed","state":{"exceeded":[],"unknowns":[],"tokenAccounting":"unknown","usage":{"rounds":1,"modelCalls":null,"tokens":null},"lim |
| a-append-persisted | 通过 | 重启后要读回来的那份：budget.maxRounds=25，别名 maxRounds=25 |
| a-append-emitted | 通过 | 事件 1 条｜previous={"maxRounds":20} gate={"ok":true,"reason":"轮数 1/25","blockedBy":[]}｜同口径反算 gate={"ok":true,"reason":"轮数 1/25","blockedBy":[]} |
| a-shrink-refused | 通过 | 填小后回执 maxRounds=25，落库=25｜同口径反算应为 25（只增不减，原值仍可读） |
| a-unknown-dimensions-honest | 通过 | 主进程读数 usage={"rounds":1,"modelCalls":null,"tokens":null} limits={"maxRounds":25,"maxModelCalls":null,"maxTokens":null}｜反算 unknowns=[] tokenAccounting=unknown |
| ui-shows-probe | 通过 | 侧栏选中探针 |
| ui-budget-card-visible | 通过 | 默认预算只给轮数设限，另两条没写上限就该读「未设限」（不是 0、也不是未记账）｜["轮数 1/25","模型调用 未设限","Token 未设限","判定用的数 本轮还没有判定"] |
| ui-no-exhaust-control-before-pause | 通过 | 还没停过手就不该给「追加并继续」：input=false button=false |
| a-unaccounted-dim-honest | 通过 | 设了上限但没账：unknowns=["model_calls"] exceeded=[]｜门禁 {"ok":true,"reason":"轮数 1/25，模型调用已设上限但没有调用计数","blockedBy":[]}｜界面行数 ["轮数 1/25","模型调用 未记账","Token 未设限","判定用的数 本轮还没有判定"] |
| b-precondition-written | 通过 | 轮数 1/1，状态 interrupted，无当前计划（续跑分支不接管） |
| ui-reselect-after-restart | 通过 | 重启后重新选中探针，统计/对话页才真的挂着 |
| b-budget-survives-restart | 通过 | 重启后读回 budget={"maxRounds":1,"maxModelCalls":40} status=interrupted |
| b-no-exhaust-event-yet | 通过 | 接回去之前事件数 18，超限暂停这条不该预先存在 |
| b-status-pausable | 通过 | 实际状态 budget_exhausted（应为可恢复的 budget_exhausted，不是终态 failed）｜resume 回执 {"state":"settled","ok":true} |
| b-not-killed | 通过 | 超限之后没有 task.failed（暂停前已有的 1 条来自 A 段收尾，不算在这里）｜任务状态=budget_exhausted error=「预算已用尽（轮数 1/1，模型调用已设上限但没有调用计数），任务暂停等你追加预算或选择收口」 |
| b-exhaust-event | 通过 | 事件 {"reason":"轮数 1/1，模型调用已设上限但没有调用计数","budget":{"maxRounds":1,"maxModelCalls":40},"budgetUsage":{"rounds":1,"modelCalls":null,"tokens":null}}｜同口径反算 reason=「轮数 1/1，模型调用已设上限但没有调用计数」blockedBy=["rounds"] |
| b-exhaust-says-how-to-come-back | 通过 | 事件读数「轮数 1/1，模型调用已设上限但没有调用计数」＝反算「轮数 1/1，模型调用已设上限但没有调用计数」｜任务提示「预算已用尽（轮数 1/1，模型调用已设上限但没有调用计数），任务暂停等你追加预算或选择收口」 |
| b-no-new-round-while-paused | 通过 | 停手期间不得再开轮：改前 1 轮，现在 1 轮 |
| b-legacy-observe | 通过 | 兼容镜像里不该再出现把超限判死的旧落点｜snapshot=null |
| ui-exhaust-note | 通过 | 活动流要同时给出「为什么停」和「怎么回来」：停手旁注「预算用尽，任务已暂停 · 轮数 1/1，模型调用已设上限但没有调用计数 详情」｜折叠详情含「追加预算后可继续」=true |
| ui-exhaust-control | 通过 | 停手之后才给入口：input=true button=true｜卡头「已用尽：轮数」 |
| ui-exhaust-head | 通过 | 卡头读数「已用尽：轮数」｜行数=5 |
| b-extend-opens-gate | 通过 | 回执 gate={"ok":true,"reason":"轮数 1/3，模型调用已设上限但没有调用计数","blockedBy":[]}｜反算 gate={"ok":true,"reason":"轮数 1/3，模型调用已设上限但没有调用计数","blockedBy":[]} |
| b-extend-persisted | 通过 | 落库=3｜事件 previous={"maxRounds":1,"maxModelCalls":40} → budget={"maxRounds":3,"maxModelCalls":40} gate={"ok":true,"reason":"轮数 1/3，模型调用已设上限但没有调用计数","blockedBy":[]} |
| b-resumed-into-loop | 通过 | 加完预算后状态 planning（离开可恢复暂停，回到循环里推进） |
| b-resume-opened-round | 通过 | 轮数 1 → 2（追加预算不是只改个数，要真开出下一轮） |
| ui-budget-head-clears | 通过 | 卡头「仍可开新一轮」（2/3 反算 gate=true）｜行数=["轮数 2/3","模型调用 未记账","Token 未设限","判定用的数 本轮还没有判定","追加轮数 追加并继续"] |
| probe-cleaned-up | 通过 | 删除后仍存在 false |
| tasks-back-to-baseline | 通过 | 任务数 0 → 0 |
| probe-workspace-removed | 通过 | /var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-3-ws-1795855332781 |

合计 41 项，未通过 0 项。

## 截图

- `01-budget-append-from-ui.png`
- `02-budget-exhausted-pause.png`
- `03-budget-extended-resumed.png`

事件原文：`events.after-budget-exhausted.json`（超限暂停到手后的完整事件流）。
