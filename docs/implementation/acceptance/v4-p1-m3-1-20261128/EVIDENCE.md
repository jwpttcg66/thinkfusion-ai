# V4 P1 M3-1 真机验收：周期判定只有一个出口

- 时间：2026-11-28T04:41:34.363Z ~ 2026-11-28T04:53:57.353Z
- 环境：默认数据目录 / ThinkFusion Dev / CDP 9333 / 同一进程内连跑两轮
- 工作区：`/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362`（探针只在这里写文件）
- 探针任务：`035d44a9-00db-479e-ad02-994eed68de1c`（M3-1 两轮判定探针，maxRounds=20，收尾已删除）
- 完成条件：工作区里同时存在 d1/a.txt、d2/b.txt 与 REPORT.md，且 REPORT.md 记录了两次校验输出（轮次一故意不生成 REPORT.md，逼出第二轮）
- 备份：agent-store.before.json

## 两轮判定（事件原文的核对结果）

```json
[
  {
    "phase": "round-1",
    "index": 0,
    "roundId": "37a8cfc5-d98e-4e17-9d05-8fc3a5f6c432",
    "at": 1795840945938,
    "reason": "存在待修或未解决评审问题",
    "progress": {
      "fingerprint": "[\"step:write-1:fs.writeFile:completed::\",\"args:write-1:281da2a6\",\"step:write-2:fs.writeFile:completed::\",\"args:write-2:a272f62b\",\"step:check-1:shell.run:completed:0:\",\"args:check-1:46f261a5\",\"out:check-1:34ac38b3\",\"step:check-2:shell.run:failed:3:命令退出码 3\",\"args:check-2:cb92856e\",\"out:check-2:052bb52d\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d1/a.txt:\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d2/b.txt:\",\"evidence:command:test -f d1/a.txt -a -f d2/b.txt && echo both-files-ok:0\",\"evidence:command:test -f REPORT.md || { echo \\\"REPORT.md 未生成\\\"; exit 3; }:3\",\"verified:no\",\"check:compile:skipped::050c5d1f\",\"check:run:skipped::050c5d1f\",\"check:tests:skipped::050c5d1f\",\"diagnostics:skipped:0:0\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d1/a.txt\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d2/b.txt\",\"reason:改了文件，但没有任何成功的构建 / 运行 / 测试 / 诊断：本轮不能算已验证\"]",
      "criterionKey": "[\"工作区里同时存在 d1/a.txt、d2/b.txt 与 REPORT.md，且 REPORT.md 记录了两次校验输出\"]",
      "repeated": 0,
      "criteriaStreak": 0,
      "repeatLimit": 2,
      "criterionStalled": false
    },
    "goalFit": {
      "fit": "PARTIAL",
      "met": 0,
      "unmet": 0,
      "unverified": 1,
      "blockingRisks": []
    },
    "budget": {
      "atMaxRounds": false,
      "roundUsed": 1,
      "roundLimit": 20
    },
    "reportStatus": "partial",
    "evidenceTrace": {
      "file": 2,
      "cmd": 2,
      "url": 0,
      "evidence": 1,
      "unmatched": []
    },
    "evidenceOwnRound": 1,
    "evidenceCrossRound": 0,
    "roundsAtDecision": 1,
    "storedMaxRounds": 20,
    "recomputedProgress": {
      "fingerprint": "[\"step:write-1:fs.writeFile:completed::\",\"args:write-1:281da2a6\",\"step:write-2:fs.writeFile:completed::\",\"args:write-2:a272f62b\",\"step:check-1:shell.run:completed:0:\",\"args:check-1:46f261a5\",\"out:check-1:34ac38b3\",\"step:check-2:shell.run:failed:3:命令退出码 3\",\"args:check-2:cb92856e\",\"out:check-2:052bb52d\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d1/a.txt:\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d2/b.txt:\",\"evidence:command:test -f d1/a.txt -a -f d2/b.txt && echo both-files-ok:0\",\"evidence:command:test -f REPORT.md || { echo \\\"REPORT.md 未生成\\\"; exit 3; }:3\",\"verified:no\",\"check:compile:skipped::050c5d1f\",\"check:run:skipped::050c5d1f\",\"check:tests:skipped::050c5d1f\",\"diagnostics:skipped:0:0\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d1/a.txt\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d2/b.txt\",\"reason:改了文件，但没有任何成功的构建 / 运行 / 测试 / 诊断：本轮不能算已验证\"]",
      "criterionKey": "[\"工作区里同时存在 d1/a.txt、d2/b.txt 与 REPORT.md，且 REPORT.md 记录了两次校验输出\"]",
      "repeated": 0,
      "criteriaStreak": 0,
      "repeatLimit": 2,
      "criterionStalled": false
    },
    "recomputedCriterionKey": "[\"工作区里同时存在 d1/a.txt、d2/b.txt 与 REPORT.md，且 REPORT.md 记录了两次校验输出\"]",
    "progressDiffs": [],
    "snapshot": {
      "decision": "repair",
      "currentStage": "implementation",
      "nextAction": "存在待修或未解决评审问题",
      "at": 1795840945963
    },
    "issues": []
  },
  {
    "phase": "round-2",
    "index": 1,
    "roundId": "2daad2a6-28f3-4f76-aa0e-c63771c009c2",
    "at": 1795841618512,
    "reason": "执行、验证和目标标准均已满足",
    "progress": {
      "fingerprint": "[\"step:step-1:fs.list:completed::\",\"args:step-1:fff89cca\",\"step:step-2:fs.mkdir:completed::\",\"args:step-2:8b3dfd27\",\"step:step-3:fs.writeFile:completed::\",\"args:step-3:b4704b64\",\"step:step-4:fs.readFile:completed::\",\"args:step-4:42952318\",\"step:step-5:fs.stat:completed::\",\"args:step-5:42952318\",\"step:step-6:notify:completed::\",\"args:step-6:801390a9\",\"evidence:file:/private/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/probe-m3-1-2daad2a6:\",\"evidence:file:/private/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/probe-m3-1-2daad2a6/probe.txt:\",\"verified:yes\",\"check:compile:skipped::050c5d1f\",\"check:run:skipped::050c5d1f\",\"check:tests:skipped::050c5d1f\",\"diagnostics:skipped:0:0\",\"changed:probe-m3-1-2daad2a6/probe.txt\"]",
      "criterionKey": "[]",
      "repeated": 0,
      "criteriaStreak": 0,
      "repeatLimit": 2,
      "criterionStalled": false
    },
    "goalFit": {
      "fit": "MET",
      "met": 1,
      "unmet": 0,
      "unverified": 0,
      "blockingRisks": []
    },
    "budget": {
      "atMaxRounds": false,
      "roundUsed": 3,
      "roundLimit": 20
    },
    "reportStatus": "completed",
    "evidenceTrace": {
      "file": 2,
      "cmd": 0,
      "url": 0,
      "evidence": 2,
      "unmatched": []
    },
    "evidenceOwnRound": 1,
    "evidenceCrossRound": 1,
    "roundsAtDecision": 3,
    "storedMaxRounds": 20,
    "recomputedProgress": {
      "fingerprint": "[\"step:step-1:fs.list:completed::\",\"args:step-1:fff89cca\",\"step:step-2:fs.mkdir:completed::\",\"args:step-2:8b3dfd27\",\"step:step-3:fs.writeFile:completed::\",\"args:step-3:b4704b64\",\"step:step-4:fs.readFile:completed::\",\"args:step-4:42952318\",\"step:step-5:fs.stat:completed::\",\"args:step-5:42952318\",\"step:step-6:notify:completed::\",\"args:step-6:801390a9\",\"evidence:file:/private/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/probe-m3-1-2daad2a6:\",\"evidence:file:/private/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/probe-m3-1-2daad2a6/probe.txt:\",\"verified:yes\",\"check:compile:skipped::050c5d1f\",\"check:run:skipped::050c5d1f\",\"check:tests:skipped::050c5d1f\",\"diagnostics:skipped:0:0\",\"changed:probe-m3-1-2daad2a6/probe.txt\"]",
      "criterionKey": "[]",
      "repeated": 0,
      "criteriaStreak": 0,
      "repeatLimit": 2,
      "criterionStalled": false
    },
    "recomputedCriterionKey": "[]",
    "progressDiffs": [],
    "snapshot": {
      "decision": "complete",
      "currentStage": "done",
      "nextAction": "无需下一轮；可做整体验收",
      "at": 1795841618535
    },
    "issues": []
  }
]
```

## 落点 → 实际行为

```json
[
  {
    "phase": "round-1",
    "nextAction": "open_next_round",
    "newRoundId": "b71e64d9-82bf-4178-b725-3d3167c8793b",
    "completed": true,
    "failed": null,
    "cancelled": false,
    "stopLog": null,
    "issues": []
  },
  {
    "phase": "round-2",
    "nextAction": "finish_completed",
    "newRoundId": null,
    "completed": true,
    "failed": null,
    "cancelled": false,
    "stopLog": null,
    "issues": []
  }
]
```

## 界面读数（工程目标卡）

```json
{
  "card": {
    "decisionLine": "最近一次周期判定：COMPLETE · 按完成收尾｜执行、验证和目标标准均已满足",
    "nextLine": "当前阶段：完成 · 下一步：无需下一轮；可做整体验收",
    "fitLine": "工程目标 · active · 符合度 已满足 · v1",
    "charLen": 218
  },
  "projectionDecisionCount": 5,
  "projectionCycleDecision": null,
  "expectedLine": "最近一次周期判定：COMPLETE · 按完成收尾｜执行、验证和目标标准均已满足"
}
```

## 事件流 diff

```json
{
  "added": 95,
  "removed": 1,
  "bytes": 4919,
  "file": "event-stream.diff"
}
```

完整序列见 `events.after-decision-1.json` / `events.after-decision-2.json`，
逐行 diff 见 `event-stream.diff`，投影见 `projection-digest.json`。

## 断言结果

| 断言 | 结果 | 实测 |
| --- | --- | --- |
| default-store-readable | 通过 | /Users/yalla/Library/Application Support/thinkfusion-ai/agent-store.json |
| renderer-ready | 通过 | CDP 已连接 |
| d1-full-fields | 通过 | REPAIR → open_next_round｜证据 {"file":2,"cmd":2,"url":0,"evidence":1,"unmatched":[]} |
| d1-cites-own-round-evidence | 通过 | 本轮 1 条｜跨轮 0 条 |
| d1-evidence-refs-nonempty | 通过 | 5 条：["evidence:035d44a9-00db-479e-ad02-994eed68de1c:37a8cfc5-d98e-4e17-9d05-8fc3a5f6c432:criterion:035d44a9-00db-479e-ad02-994eed68de1c:plan:execution","file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d1/a.txt","file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d2/b.txt"] |
| d1-progress-recomputed | 通过 | 事件 {"fingerprint":"[\"step:write-1:fs.writeFile:completed::\",\"args:write-1:281da2a6\",\"step:write-2:fs.writeFile:completed::\",\"args:write-2:a272f62b\",\"step:check-1:shell.run:completed:0:\",\"args:check-1:46f261a5\",\"out:check-1:34ac38b3\",\"step:check-2:shell.run:failed:3:命令退出码 3\",\"args:check-2:cb92856e\",\"out:check-2:052bb52d\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d1/a.txt:\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d2/b.txt:\",\"evidence:command:test -f d1/a.txt -a -f d2/b.txt && echo both-files-ok:0\",\"evidence:command:test -f REPORT.md || { echo \\\"REPORT.md 未生成\\\"; exit 3; }:3\",\"verified:no\",\"check:compile:skipped::050c5d1f\",\"check:run:skipped::050c5d1f\",\"check:tests:skipped::050c5d1f\",\"diagnostics:skipped:0:0\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d1/a.txt\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d2/b.txt\",\"reason:改了文件，但没有任何成功的构建 / 运行 / 测试 / 诊断：本轮不能算已验证\"]","criterionKey":"[\"工作区里同时存在 d1/a.txt、d2/b.txt 与 REPORT.md，且 REPORT.md 记录了两次校验输出\"]","repeated":0,"criteriaStreak":0,"repeatLimit":2,"criterionStalled":false}｜反算 {"fingerprint":"[\"step:write-1:fs.writeFile:completed::\",\"args:write-1:281da2a6\",\"step:write-2:fs.writeFile:completed::\",\"args:write-2:a272f62b\",\"step:check-1:shell.run:completed:0:\",\"args:check-1:46f261a5\",\"out:check-1:34ac38b3\",\"step:check-2:shell.run:failed:3:命令退出码 3\",\"args:check-2:cb92856e\",\"out:check-2:052bb52d\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d1/a.txt:\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d2/b.txt:\",\"evidence:command:test -f d1/a.txt -a -f d2/b.txt && echo both-files-ok:0\",\"evidence:command:test -f REPORT.md || { echo \\\"REPORT.md 未生成\\\"; exit 3; }:3\",\"verified:no\",\"check:compile:skipped::050c5d1f\",\"check:run:skipped::050c5d1f\",\"check:tests:skipped::050c5d1f\",\"diagnostics:skipped:0:0\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d1/a.txt\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-1-ws-1795840894362/d2/b.txt\",\"reason:改了文件，但没有任何成功的构建 / 运行 / 测试 / 诊断：本轮不能算已验证\"]","criterionKey":"[\"工作区里同时存在 d1/a.txt、d2/b.txt 与 REPORT.md，且 REPORT.md 记录了两次校验输出\"]","repeated":0,"criteriaStreak":0,"repeatLimit":2,"criterionStalled":false}｜标准集合键 ["工作区里同时存在 d1/a.txt、d2/b.txt 与 REPORT.md，且 REPORT.md 记录了两次校验输出"] |
| d1-behaviour-matches-nextaction | 通过 | 落点 open_next_round｜新轮 b71e64d9-82bf-4178-b725-3d3167c8793b｜完成 true |
| probe-ran-two-rounds | 通过 | 第二轮判定 COMPLETE → finish_completed |
| d2-full-fields | 通过 | COMPLETE → finish_completed｜证据 {"file":2,"cmd":0,"url":0,"evidence":2,"unmatched":[]} |
| d2-cites-own-round-evidence | 通过 | 本轮 1 条｜跨轮 1 条（目标证据按轮累计，跨轮引用要求轮次与标准都能在事件流里对上） |
| d2-rounds-distinct | 通过 | 轮次 37a8cfc5-d98e-4e17-9d05-8fc3a5f6c432 → 2daad2a6-28f3-4f76-aa0e-c63771c009c2 |
| d2-belongs-to-new-round | 通过 | 新轮 b71e64d9-82bf-4178-b725-3d3167c8793b,2daad2a6-28f3-4f76-aa0e-c63771c009c2｜判定轮 2daad2a6-28f3-4f76-aa0e-c63771c009c2（有报告 true）｜事件流轮数 3｜budget.roundUsed 3｜其中 1 轮只开了轮没出报告（b71e64d9） |
| d2-behaviour-matches-nextaction | 通过 | 落点 finish_completed｜完成 true｜失败 无 |
| event-stream-diff-stored | 通过 | 第二轮新增 95 行、移除 1 行，落在 event-stream.diff（4919 字节） |
| ui-shows-probe | 通过 | 侧栏选中探针 |
| ui-cycle-decision-visible | 通过 | 界面「最近一次周期判定：COMPLETE · 按完成收尾｜执行、验证和目标标准均已满足」 |
| ui-cycle-decision-matches-newest-event | 通过 | 应为「最近一次周期判定：COMPLETE · 按完成收尾｜执行、验证和目标标准均已满足」｜最新事件 COMPLETE/finish_completed |
| ui-next-step-line-quotes-decision-reason | 通过 | 界面「当前阶段：完成 · 下一步：无需下一轮；可做整体验收」 |
| ui-projection-single-source | 通过 | 投影句 最近一次周期判定：COMPLETE · 按完成收尾｜执行、验证和目标标准均已满足 |
| ui-card-scrolled | 通过 | 截图前把「工程目标」卡滚进视口 |
| probe-task-cleaned-up | 通过 | 任务数 0 → 0；删除回包 {"taskId":"035d44a9-00db-479e-ad02-994eed68de1c","checkpointsRemoved":false,"archiveSegments":0,"goalId":"goal:035d44a9-00db-479e-ad02-994eed68de1c","goalReclaimed":false} |

合计 21 项，未通过 0 项。

## 截图

- `01-goal-card-cycle-decision.png`

## 中断原因

无。
