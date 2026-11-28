# V4 P1 M3-4 真机验收：无人值守开关真落盘、用户出口真开轮、通道停住不判死

- 时间：2026-11-28T13:49:39.456Z ~ 2026-11-28T14:05:44.207Z
- 墙钟：965 秒（用例刻意压短；「≥2 小时无人值守」按用户指示暂缓，不在本条范围内）
- 环境：默认数据目录 / ThinkFusion Dev / CDP 9334 / 通道停住用 SIGSTOP 停住 CLI 子进程喂给现网看门狗 / 附着在手起的 dev 实例上（脚本不起也不收 App）
- 数据目录：`/Users/yalla/Library/Application Support/thinkfusion-ai`（默认，未隔离）；store 备份：agent-store.before.json
- 工作区：`/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-4-ws-1795873779456`（探针只在这里读文件）
- 探针任务：'235c063a-3bc4-4b53-a109-6bb400de58c7'（已删除）、'71aa36ae-6f92-46a4-a587-c908a68635a2'（已删除）、'（F 段只有会话，没有任务）'（已删除）、'9bdcf62b-3ff5-405c-9d6e-a32400551f21'（已删除）、'3040c256-70d1-49c3-917e-be127046395c'（已删除）
- 通道状态：{"page":{"loggedIn":false,"pageReady":false,"detail":"页面尚未加载","url":""},"cli":[{"id":"qoder","available":true,"headless":"verified","reason":null},{"id":"claude","available":false,"headless":"unverified","reason":"已在设置里关闭"}]}
- 探针用的执行档：探针用 CLI 主导（cli:qoder）、云模型清空；用户默认配置见 evidence.defaults｜用户默认配置 {"executionMode":"cloud","fallbackEnabled":false,"privacyMode":"allow-cloud","selectedCloudModels":["user:超算:GLM-5.3-Flash"],"selectedCliAgents":[]}｜C 段用的 CLI："qoder"

## 通道停住是怎么造的（如实记录）

不给异常造假数据：C 段另建一条走 CLI 通道的探针，等主进程把 CLI 拉起来后给那个子进程发 `SIGSTOP`，
它的 stdout 就此不再有新块，由编排器自己的看门狗（现网默认 120 秒静默）说出真机那句
「模型连续 N 秒没有输出」；观察完发 `SIGCONT` 放开、不补刀。注入时刻 2026-11-28T13:50:11.085Z，放开设法：已 SIGCONT 放开 进程组 -94738（它剩下的输出按「回答来晚」丢掉，不再补刀）。
判定、落点、事件、界面读数的代码路径一行没绕。云端那条不能用这个办法：它的请求在主进程里，
CDP 的离线模拟只作用于页面目标（2026-11-28 实测：页面离线之后云端照常回答）。

## A 段：无人值守开关 + 用户出口的边界

```json
{
  "rejected": [
    {
      "input": {
        "taskId": "3040c256-70d1-49c3-917e-be127046395c"
      },
      "why": "没指布尔，改的是哪一侧说不清",
      "ok": false,
      "error": "Error invoking remote method 'task:set-auto-continue': [\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"boolean\",\n    \"received\": \"undefined\",\n    \"path\": [\n      \"autoContinue\"\n    ],\n    \"message\": \"Required\"\n  }\n]"
    },
    {
      "input": {
        "taskId": "3040c256-70d1-49c3-917e-be127046395c",
        "autoContinue": "false"
      },
      "why": "字符串 \"false\" 在代码里 !== false，会显示成已打开",
      "ok": false,
      "error": "Error invoking remote method 'task:set-auto-continue': [\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"boolean\",\n    \"received\": \"string\",\n    \"path\": [\n      \"autoContinue\"\n    ],\n    \"message\": \"Expected boolean, received string\"\n  }\n]"
    },
    {
      "input": {
        "taskId": "3040c256-70d1-49c3-917e-be127046395c",
        "autoContinue": 1
      },
      "why": "数字不能当布尔",
      "ok": false,
      "error": "Error invoking remote method 'task:set-auto-continue': [\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"boolean\",\n    \"received\": \"number\",\n    \"path\": [\n      \"autoContinue\"\n    ],\n    \"message\": \"Expected boolean, received number\"\n  }\n]"
    },
    {
      "input": {
        "taskId": "3040c256-70d1-49c3-917e-be127046395c",
        "autoContinue": true,
        "extra": 1
      },
      "why": "多余键必须拒（strict），不能悄悄吞掉",
      "ok": false,
      "error": "Error invoking remote method 'task:set-auto-continue': [\n  {\n    \"code\": \"unrecognized_keys\",\n    \"keys\": [\n      \"extra\"\n    ],\n    \"path\": [],\n    \"message\": \"Unrecognized key(s) in object: 'extra'\"\n  }\n]"
    }
  ],
  "persistedAutoContinue": false,
  "switchOff": {
    "checked": false,
    "disabled": false,
    "label": "无人值守 停在轮次开始前，等你点「继续下一轮」",
    "result": ""
  },
  "switchOn": {
    "checked": true,
    "disabled": false,
    "label": "无人值守 判定要开下一轮时自动开",
    "result": ""
  },
  "continueRefused": [
    {
      "input": {
        "taskId": "3040c256-70d1-49c3-917e-be127046395c",
        "instruction": "   "
      },
      "why": "空指令照样开一轮，等于把一轮模型调用烧在空格上",
      "ok": false,
      "error": "Error invoking remote method 'task:continue-round': [\n  {\n    \"code\": \"too_small\",\n    \"minimum\": 1,\n    \"type\": \"string\",\n    \"inclusive\": true,\n    \"exact\": false,\n    \"message\": \"要说什么做法不对、想换成什么，不能空着\",\n    \"path\": [\n      \"instruction\"\n    ]\n  }\n]"
    },
    {
      "input": {
        "taskId": "3040c256-70d1-49c3-917e-be127046395c",
        "instruction": "上一轮只列了文件名。这一轮改成同时给出每个文件的",
        "extra": 1
      },
      "why": "多余键必须拒",
      "ok": false,
      "error": "Error invoking remote method 'task:continue-round': [\n  {\n    \"code\": \"unrecognized_keys\",\n    \"keys\": [\n      \"extra\"\n    ],\n    \"path\": [],\n    \"message\": \"Unrecognized key(s) in object: 'extra'\"\n  }\n]"
    },
    {
      "input": {
        "instruction": "上一轮只列了文件名。这一轮改成同时给出每个文件的"
      },
      "why": "没有任务 id，不能猜对哪条任务开轮",
      "ok": false,
      "error": "Error invoking remote method 'task:continue-round': [\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"undefined\",\n    \"path\": [\n      \"taskId\"\n    ],\n    \"message\": \"Required\"\n  }\n]"
    },
    {
      "input": {
        "taskId": "3040c256-70d1-49c3-917e-be127046395c",
        "instruction": "上一轮只列了文件名。这一轮改成同时给出每个文件的"
      },
      "why": "状态 awaiting_approval 不在允许名单",
      "ok": false,
      "error": "Error invoking remote method 'task:continue-round': Error: 任务当前状态为 awaiting_approval，只有「已完成待确认」或「停在下一轮开始前」的任务能要求再来一轮"
    }
  ],
  "stateWhenChecked": "awaiting_approval"
}
```

## B 段：用户出口真开一轮

```json
{
  "switchForB": {
    "autoContinue": false,
    "previous": true,
    "status": "awaiting_approval"
  },
  "statusAtGate": "report_pending",
  "roundsBefore": 1,
  "awaitEvent": null,
  "exitShown": {
    "found": true,
    "placeholder": "上一轮哪里不对、想换成什么做法（原话会逐字进下一轮计划请求）",
    "button": "换手段再来一轮",
    "buttons": [
      "继续修复（重新执行验证）",
      "按当前口径重新判定",
      "接受未验证并结束",
      "换手段再来一轮"
    ],
    "groupText": "重点 验证待你决定 · 未通过闸门，需选出口 继续修复（重新执行验证） 按当前口径重新判定 接受未验证并结束 换手段再来一轮 想按自己的判断再做一轮，写下指令点「换手段再来一轮」；不想再做就「接受未验证并结束」。"
  },
  "receipt": {
    "roundId": "4622cf3c-0eca-4cbb-82f9-4f2a24fc8cce",
    "roundNumber": 2,
    "fromStatus": "report_pending",
    "means": [
      "fs.list path=."
    ],
    "gate": {
      "ok": true,
      "reason": "轮数 1/20"
    },
    "status": "planning"
  },
  "status": "planning",
  "roundsAfter": 2,
  "round": {
    "inputType": "user_continue",
    "requestHasInstruction": true
  },
  "event": {
    "fromStatus": "report_pending",
    "instruction": "上一轮只列了文件名。这一轮改成同时给出每个文件的大小，仍然不要新建或修改文件。",
    "means": 1,
    "gate": {
      "ok": true,
      "reason": "轮数 1/20"
    }
  }
}
```

## C 段：通道停住落在可恢复那侧

```json
{
  "listeners": [
    {
      "pid": 89425,
      "command": "/Users/yalla/data/localLab/thinkfusion-ai/desktop-agent-macos/node_modules/electron/dist/T"
    }
  ],
  "taskId": "235c063a-3bc4-4b53-a109-6bb400de58c7",
  "switchBackOn": {
    "autoContinue": true,
    "previous": true,
    "status": "planning"
  },
  "inject": {
    "cliId": "qoder",
    "executable": "/Users/yalla/.qoder/entry/qoder",
    "mainPid": 89425,
    "pid": 94738,
    "stopped": "-94738",
    "mode": "group",
    "group": [
      94753
    ],
    "state": "TNs",
    "command": "/Users/yalla/.local/bin/qodercli -p M-dM-=\\240M-fM^XM-/M-fM^\\M-,M-eM^\\M-0 ThinkFusion M-gM^ZM^DM-dM-;M-;M-eM^JM-!M-hM-'M^DM-eM^HM^RM-eM-<M^UM-fM^SM^NM-cM^@M^B\\0",
    "at": "2026-11-28T13:50:11.085Z"
  },
  "released": "已 SIGCONT 放开 进程组 -94738（它剩下的输出按「回答来晚」丢掉，不再补刀）",
  "status": "interrupted",
  "error": "模型连续 120 秒没有输出，已停止。请重试或换模型。",
  "faultEvent": {
    "type": "task.fault.stopped",
    "at": 1795873930208,
    "taskId": "235c063a-3bc4-4b53-a109-6bb400de58c7",
    "roundId": "a005807b-ba26-4f53-9e6e-fab84bae833d",
    "kind": "channel_stall",
    "error": "模型连续 120 秒没有输出，已停止。请重试或换模型。",
    "landedStatus": "interrupted",
    "headline": "这一轮模型不再输出，是通道停住了",
    "howBack": "不是任务做错了：换模型或等通道恢复后点「继续任务」，会按上一轮检查点重开一轮。",
    "eventId": "c0df49e3-b02b-40f0-b770-90f4b43015e5",
    "runId": "235c063a-3bc4-4b53-a109-6bb400de58c7",
    "sequence": 10,
    "phase": "execution"
  },
  "failedAfterFault": [],
  "roundsBeforeFault": 1,
  "roundsAfterFault": 1,
  "ui": {
    "selectedRow": true,
    "conv": {
      "stopped": [
        "这一轮模型不再输出，是通道停住了 · 停在「interrupted」 详情",
        "这一轮模型不再输出，是通道停住了 · 停在「interrupted」",
        "模型连续 120 秒没有输出，已停止。请重试或换模型。｜没有判成失败：这一轮模型不再输出，是通道停住了（停在「interrupted」）。不是任务做错了：换模型或等通道恢复后点「继续任务」，会按上一轮检查点重开一轮。",
        "模型连续 120 秒没有输出，已停止。请重试或换模型。｜没有判成失败：这一轮模型不再输出，是通道停住了（停在「interrupted」）。不是任务做错了：换模型或等通道恢复后点「继续任务」，会按上一轮检查点重开一轮。"
      ],
      "howBack": true,
      "failedWord": []
    },
    "stats": {
      "keys": [
        "目标",
        "轮次",
        "事件",
        "总耗时",
        "无人值守",
        "轮数",
        "模型调用",
        "Token",
        "判定用的数",
        "估算输入",
        "窗口",
        "使用率"
      ],
      "auto": "无人值守 判定要开下一轮时自动开",
      "rounds": "轮次 1 轮"
    }
  },
  "afterResume": {
    "status": "planning",
    "rounds": 2,
    "fired": {
      "state": "settled",
      "ok": true
    }
  },
  "resumeGate": {
    "status": "awaiting_approval",
    "planId": "95604ba0-4875-4e2c-9944-9f29429ad287"
  },
  "approveAfterResume": {
    "reached": true,
    "planId": "95604ba0-4875-4e2c-9944-9f29429ad287",
    "roundId": "177a248e-57f7-4e43-9c03-732ad5537047",
    "receipt": null,
    "ok": true,
    "statusAfter": "report_pending"
  },
  "autoOpen": {
    "decision": {
      "decisionType": "WAIT_USER",
      "nextAction": "stop_and_wait",
      "reason": "目标仅部分达成（0 项部分满足），需补充证据或调整范围",
      "at": 1795873957509
    },
    "openedAfterDecision": false,
    "openedInputType": null,
    "clicks": 0,
    "awaitUser": false,
    "status": "report_pending",
    "roundTypes": [
      "1:user_prompt",
      "2:user_prompt"
    ],
    "timedOut": false,
    "waitedMs": 24924
  }
}
```

## E 段：没写过这个字段的任务，缺省就自动开下一轮

```json
{
  "taskId": "71aa36ae-6f92-46a4-a587-c908a68635a2",
  "lostReceipt": null,
  "bornFieldWritten": false,
  "bornEffective": true,
  "approved": {
    "ok": true,
    "statusAfter": "executing"
  },
  "roundTypesAtApproval": "1:user_prompt",
  "decision": {
    "decisionType": "REPAIR",
    "nextAction": "open_next_round",
    "reason": "存在待修或未解决评审问题"
  },
  "boundary": {
    "decision": {
      "decisionType": "REPAIR",
      "nextAction": "open_next_round",
      "reason": "存在待修或未解决评审问题",
      "at": 1795874301092
    },
    "openedAfterDecision": true,
    "openedInputType": "execution_report",
    "clicks": 0,
    "awaitUser": false,
    "status": "planning",
    "roundTypes": [
      "1:user_prompt",
      "2:execution_report"
    ],
    "timedOut": false,
    "waitedMs": 301188
  },
  "roundsAfter": 2,
  "autoContinueEvents": 0,
  "userContinueClicks": 0,
  "nowFieldWritten": false,
  "nowEffective": true
}
```

## F 段：只能用网页源时说的是「去设置里打开」，不是判死

```json
{
  "pageSources": [
    {
      "id": "deepseek",
      "label": "DeepSeek",
      "enabled": false
    },
    {
      "id": "chatgpt",
      "label": "ChatGPT",
      "enabled": true
    },
    {
      "id": "kimi",
      "label": "Kimi",
      "enabled": false
    },
    {
      "id": "gemini",
      "label": "Gemini",
      "enabled": false
    },
    {
      "id": "workbuddy",
      "label": "WorkBuddy",
      "enabled": false
    }
  ],
  "chosen": "deepseek",
  "reject": "ChatGPT 未登录：页面尚未加载",
  "strayConversations": [
    "50d8f1dc-3ed4-4cf4-8373-2eff80824c03"
  ]
}
```

## G 段：开关拨到关，判定说要开下一轮也得停在轮次开始前

```json
{
  "taskId": "9bdcf62b-3ff5-405c-9d6e-a32400551f21",
  "switchOff": {
    "autoContinue": false,
    "previous": true,
    "status": "planning"
  },
  "approved": {
    "ok": true,
    "statusAfter": "executing"
  },
  "roundsAtApproval": 1,
  "rounds": 1,
  "clicks": 0,
  "stop": {
    "decision": {
      "decisionType": "REPAIR",
      "nextAction": "open_next_round",
      "reason": "存在待修或未解决评审问题"
    },
    "awaitEvent": {
      "purpose": "按评审与验证问题修复",
      "gate": {
        "ok": true,
        "reason": "轮数 1/20"
      },
      "roundNumber": null
    },
    "status": "awaiting_next_round"
  },
  "ui": {
    "exitShown": {
      "found": true,
      "button": "继续下一轮",
      "buttons": [
        "继续修复（重新执行验证）",
        "按当前口径重新判定",
        "接受未验证并结束",
        "继续下一轮"
      ],
      "groupText": "重点 判定要开下一轮，按你的设置停在这里 继续修复（重新执行验证） 按当前口径重新判定 接受未验证并结束 继续下一轮 点「继续下一轮」才开新一轮；这一轮的报告已经在手里，不想再做就「接受未验证并结束」。统计页的「无人值守续轮」只管之后的边界，拨开它仍要点一次「继续下一轮」。"
    },
    "wantedHeadline": "判定要开下一轮，按你的设置停在这里"
  }
}
```

## D 段：上一里程碑真机原文回放当前分类器

```json
{
  "liveSamples": 5,
  "stillFatal": [],
  "kinds": [
    "channel_timeout→interrupted"
  ]
}
```

## 中断原因

无。

## 结论

1. **开关真落盘**：关掉后落库 autoContinue=false，事件与界面读数同向；脏值（字符串 "false"、数字 1、多余键）全部被 IPC 边界拒掉。
2. **用户出口真开轮**：状态 report_pending 时出口开出 2 轮（原 1 轮），用户原话逐字进请求文本
3. **通道停住不判死**：实际落点 `interrupted`，事件 kind=`channel_stall`，故障之后 task.failed 0 条，点「继续任务」后状态 planning。
4. **说明字段不再白烧轮**：真机原文 5 条通道类错误的当前落点为 ["channel_timeout→interrupted"]，仍判死 []。
5. **关掉无人值守就真停在开轮之前**：本轮没有 ["task.round.await_user"] 样本（停在 report_pending），停轮段由离线用例覆盖。
6. **开着无人值守时判定说了算**（口径：一条 cycle.decision.created 之后紧跟的第一条 round.started 才算判定开出来的那一轮，轮次行数不做证据）：C 段恢复后判定后自动开轮=false（类型 无）、出口点击 0 次，最近判定 WAIT_USER/stop_and_wait「目标仅部分达成（0 项部分满足），需补充证据或调整范围」，轮次记录 1:user_prompt、2:user_prompt——判定说停，开着也没有多开一轮；E 段（一次开关都没碰、字段没写过）判定后自动开轮=true（类型 execution_report），判定 open_next_round，改动事件 0 条、出口点击 0 次，轮次记录 1:user_prompt、2:execution_report——缺省即开：没人点也开出了下一轮。
7. **中途那次 WAIT_USER 真由人接回去**：探针停在 `awaiting_approval`（read-only 档不自动批），代点「确认并执行」之后状态 report_pending——判定把任务停在等人那侧，人接了就继续走。
8. **关掉无人值守时「判定说开」也被停住**：开关显式关（回执 {"autoContinue":false,"previous":true,"status":"planning"}）后判定 open_next_round，状态 awaiting_next_round、轮数 1 → 1、出口点击 0 次——停在轮次开始前并留下 `task.round.await_user`，界面按钮换成「继续下一轮」且同组仍有「接受未验证并结束」。

## 断言结果

| 断言 | 结果 | 实测 |
| --- | --- | --- |
| default-store-readable | 通过 | /Users/yalla/Library/Application Support/thinkfusion-ai/agent-store.json |
| d-live-strings-not-fatal | 通过 | 真机原文 5 条，落点 ["channel_timeout→interrupted"]｜仍判死的 [] |
| a-stale-probes-cleared | 通过 | 清掉 2 条遗留探针任务 + 2 条探针会话，基线任务数 0／会话数 0 |
| a-channel-state | 通过 | 网页登录=false 页面可用=false（页面尚未加载）｜已实测可用的 CLI=["qoder"] |
| a-probe-created | 通过 | task=3040c256 conv=e567c2b1 |
| a-parked-at-approval | 通过 | 停在 awaiting_approval（计划 4f3014d3），确认留到关掉无人值守之后再点 |
| a-dirty-rejected:{"taskId":"3040c256-70d1-49c3-917e-be127046395c"} | 通过 | 边界拒了：Error invoking remote method 'task:set-auto-continue': [ { "code": "invalid_type", "expected": "boolean", "received": "undefined", "｜理由 没指布尔，改的是哪一侧说不清 |
| a-dirty-rejected:{"taskId":"3040c256-70d1-49c3-917e-be127046395c","autoContinue":"false"} | 通过 | 边界拒了：Error invoking remote method 'task:set-auto-continue': [ { "code": "invalid_type", "expected": "boolean", "received": "string", "pat｜理由 字符串 "false" 在代码里 !== false，会显示成已打开 |
| a-dirty-rejected:{"taskId":"3040c256-70d1-49c3-917e-be127046395c","autoContinue":1} | 通过 | 边界拒了：Error invoking remote method 'task:set-auto-continue': [ { "code": "invalid_type", "expected": "boolean", "received": "number", "pat｜理由 数字不能当布尔 |
| a-dirty-rejected:{"taskId":"3040c256-70d1-49c3-917e-be127046395c","autoContinue":true,"extra":1} | 通过 | 边界拒了：Error invoking remote method 'task:set-auto-continue': [ { "code": "unrecognized_keys", "keys": [ "extra" ], "path": [], "｜理由 多余键必须拒（strict），不能悄悄吞掉 |
| a-switch-off-receipt | 通过 | 回执 {"autoContinue":false,"previous":true,"status":"awaiting_approval"}｜建立时的生效值 true（老任务没写过这个字段，缺省按自动续轮算） |
| a-switch-off-persisted | 通过 | 落库 autoContinue=false（重启后要读回来的就是这一格） |
| a-switch-off-event | 通过 | 事件 {"autoContinue":false,"previous":true}｜这条任务共 1 次改动 |
| a-ui-switch-off | 通过 | 界面读数「无人值守 停在轮次开始前，等你点「继续下一轮」」 |
| a-switch-back-on | 通过 | 回执 {"autoContinue":true,"previous":false,"status":"awaiting_approval"}｜界面「无人值守 判定要开下一轮时自动开」 |
| a-continue-boundary | 通过 | 拒了 4 条（状态检查=true）：Error invoking remote method 'task:continue-round': [ { / Error invoking remote method 'task:continue-round': [ { / Error invoking remote method 'task:continue-round': [ { / Error invoking remote method 'task:continue-round': Error: 任 |
| a-continue-no-sneak-round | 通过 | 此刻状态 awaiting_approval（允许名单=["report_pending","awaiting_next_round"]）｜轮数 1 |
| b-stopped-before-wait | 通过 | 等待前把无人值守关掉：{"autoContinue":false,"previous":true,"status":"awaiting_approval"} |
| a-wait-user-approved | 通过 | 无人值守已关，脚本代点「确认并执行」开跑本轮：回执 null｜之后状态 report_pending |
| b-stops-before-round | 跳过 | 本轮自然停在 report_pending（不是 awaiting_next_round）：停轮段本轮没有样本，不拿「没撞见」当「证过了」 |
| b-reached-waiting-state | 通过 | 状态 report_pending｜轮数 1 |
| b-exit-visible-in-ui | 通过 | 入口渲染=true｜按钮「换手段再来一轮」｜同组按钮 ["继续修复（重新执行验证）","按当前口径重新判定","接受未验证并结束","换手段再来一轮"] |
| b-opened-round | 通过 | 轮数 1 → 2，状态 planning（不是只回一个回执） |
| b-instruction-persisted | 通过 | 新一轮 inputType=user_continue，请求文本含用户原话=true｜上一轮手段清单 1 条一并带上 |
| b-event-and-gate | 通过 | 事件 gate={"ok":true,"reason":"轮数 1/20"}｜脚本用同一批纯函数反算 gate={"ok":true,"reason":"轮数 1/20","blockedBy":[]} |
| c-switch-back-on | 通过 | {"autoContinue":true,"previous":true,"status":"planning"} |
| c-channel-stall-injected | 通过 | 已 SIGSTOP 规划用的 CLI 进程 组 -94738（进程态 TNs，组内子进程 1 个｜/Users/yalla/.local/bin/qodercli -p M-dM-=\240M-fM^XM-/M-fM^\M-,M-eM^\） |
| c-not-killed | 通过 | 实际状态 interrupted（要停在可恢复那侧，不是终态 failed）｜错误「模型连续 120 秒没有输出，已停止。请重试或换模型。」 |
| c-fault-event | 通过 | 事件 {"kind":"channel_stall","landedStatus":"interrupted","error":"模型连续 120 秒没有输出，已停止。请重试或换模型。"} |
| c-no-new-round-while-stopped | 通过 | 停住之后不得再开轮：1 → 1 |
| c-activity-note | 通过 | 活动流旁注「这一轮模型不再输出，是通道停住了 · 停在「interrupted」 详情」｜带回来的说法=true |
| c-ui-says-why-and-how | 通过 | 仍在说「失败原因」的条数=0｜统计页 无人值守「无人值守 判定要开下一轮时自动开」｜轮次「轮次 1 轮」 |
| c-resume-recovers | 通过 | 继续任务后状态 planning｜轮数 1 → 2（可恢复不是写在状态表里的空话） |
| c-resume-plan-approved | 通过 | 恢复后停在待审批，脚本代点确认：回执 null｜之后状态 report_pending |
| c-plan-annotations | 通过 | 事件尾部 40 条里没有因说明字段而判废的计划（真机样本那三条键已接住） |
| c-open-still-obays-gate | 通过 | 判定说「WAIT_USER/stop_and_wait」（目标仅部分达成（0 项部分满足），需补充证据或调整范围）→ 判定后没有新轮（出口点击 0 次，开着也不新开轮才算对）｜状态 report_pending｜轮次记录 1:user_prompt、2:user_prompt |
| c-auto-open-after-resume | 跳过 | 窗口内到不了「要开下一轮」这一格（最近判定 stop_and_wait）：这一轮自己判成停，正向半边由 E 段补 |
| c-probe-cleaned-up | 通过 | C 段探针删除后仍存在 false |
| e-default-field-untouched | 通过 | 全程没碰开关：改动事件 0 条｜出口点击 0 次｜字段是否被显式写过 建=false/现=false（生效值 true） |
| e-default-auto-open | 通过 | 判定 REPAIR/open_next_round「存在待修或未解决评审问题」→ 判定后自动开出「execution_report」轮，没落「等你点继续」旁注=true，全程出口点击 0 次（0 才算自动）｜轮次记录 1:user_prompt、2:execution_report |
| e-probe-cleaned-up | 通过 | 缺省探针删除后仍存在 false |
| f-source-disabled-landing | 跳过 | 源关着时这条探针没建出来（ChatGPT 未登录：页面尚未加载）：落点在提问/规划之前，本段证不到｜顺手回收 1 条会话，仍没删掉的 0 条 |
| g-stopped-at-await | 通过 | 状态 awaiting_next_round｜事件 {"purpose":"按评审与验证问题修复","gate":{"ok":true,"reason":"轮数 1/20"}} |
| g-ui-says-why-and-how | 通过 | 按钮「继续下一轮」｜同组 ["继续修复（重新执行验证）","按当前口径重新判定","接受未验证并结束","继续下一轮"]｜文案含「判定要开下一轮，按你的设置停在这里」=true |
| g-no-sneak-round | 通过 | 出口点击 0 次、轮数 1 → 1（开着无人值守时同一问法当场就开了轮，见 E 段） |
| g-probe-cleaned-up | 通过 | 停轮探针删除后仍存在 false |
| probe-cleaned-up | 通过 | 删除后仍存在 false |
| tasks-back-to-baseline | 通过 | 任务数 0 → 0 |
| probe-conversations-cleaned-up | 通过 | 探针会话 5 条，没删掉的 0 条 |
| conversations-back-to-baseline | 通过 | 会话数 0 → 0 |
| probe-workspace-removed | 通过 | /var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-4-ws-1795873779456 |

合计 51 项，未通过 0 项；跳过 3 项：b-stops-before-round、c-auto-open-after-resume、f-source-disabled-landing。

## 截图

- `01-auto-continue-switch.png`
- `02-exit-visible.png`
- `03-continue-round.png`
- `04-fault-interrupted.png`
- `05-default-auto-open.png`
- `06-awaiting-next-round.png`

事件原文：`events.after-fault.json`（通道停住到手后的完整事件流）。
