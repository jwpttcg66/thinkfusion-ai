# V4 P1 M3-2 真机验收：反空转拦得下、说得清、关得掉

- 时间：2026-11-28T06:55:54.038Z ~ 2026-11-28T07:54:04.056Z
- 环境：默认数据目录 / ThinkFusion Dev / CDP 9333 / 同一进程同一探针连跑四轮判定，中途只改配置文件不重启
- 工作区：`/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037`（探针只在这里写文件）
- 阈值：产品默认 {"repeatLimit":2,"criteriaLimit":2}；真机 A 段把 `no-progress.json` 下调为 {"repeatLimit":1,"criteriaLimit":1}（只为把用例压到三轮判定，触发轮数由离线用例 `npm run test:cycle-decision` 按默认值覆盖），B 段热切为 {"repeatLimit":99,"criteriaLimit":99} 证明回退开关
- 探针任务：`5c8edc7b-5421-4636-9753-90340639782f`（阈值 1/1（触发轮数由离线用例按默认 2/2 覆盖），maxRounds=20） → `5c8edc7b-5421-4636-9753-90340639782f`（阈值热切 99/99（同一探针、同一进程，经「继续修复」由用户接回去），maxRounds=同 A 段），收尾已删除
- 探针目标：工作区里 f01.txt 到 f6.txt 共 6 个文件，每个文件的内容必须恰好等于该文件自身的 sha256（64 位十六进制、不含空白），且 REPORT.md 逐条记录这 6 次校验命令与退出码
  （要求「文件内容等于自身的 sha256」：做不到但没有矛盾，模型既无从澄清也无从伪造，只会连续几轮把同一条校验再跑一遍）
- 备份：agent-store.before.json；配置：原本没有 no-progress.json（跑完删掉我写的这份）

## 一具探针、四次判定的原文与逐条审计

```json
[
  {
    "label": "阈值 1/1（触发轮数由离线用例按默认 2/2 覆盖）",
    "attempts": [
      {
        "attempt": 1,
        "taskId": "7af5a428-a48c-4df5-8732-110fbe58b843",
        "status": "failed",
        "taskError": "模型连续 120 秒没有输出，已停止。请重试或换模型。",
        "rounds": 5,
        "error": "A 段（第 1/2 次探针） 只拿到 2 条判定就落到终态 failed（轮数 5）——探针目标太容易满足"
      }
    ],
    "decisions": [
      {
        "round": 1,
        "roundId": "d858eb60-b4db-4d3f-8657-b64c5035deb0",
        "at": 1795850223200,
        "decisionType": "REPAIR",
        "nextAction": "open_next_round",
        "noProgressCause": null,
        "progress": {
          "fingerprint": "[\"step:write-1:fs.writeFile:completed::\",\"args:write-1:bbfdf13f\",\"step:write-2:fs.writeFile:completed::\",\"args:write-2:2dad2e43\",\"step:write-3:fs.writeFile:completed::\",\"args:write-3:6667ee53\",\"step:write-4:fs.writeFile:completed::\",\"args:write-4:ac915437\",\"step:write-5:fs.writeFile:completed::\",\"args:write-5:6f5301c7\",\"step:write-6:fs.writeFile:completed::\",\"args:write-6:f5d9a2a3\",\"step:check-hash-fixed:shell.run:failed:3:命令退出码 3\",\"args:check-hash-fixed:c9bdc155\",\"out:check-hash-fixed:3d593787\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f01.txt:\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f02.txt:\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f03.txt:\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f04.txt:\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f05.txt:\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f06.txt:\",\"evidence:command:for i in $(seq -w 1 6); do want=$(sha256sum f$i.txt | cut -d' ' -f1); got=$(tr -d '\\\\n' < f$i.txt); [ -n \\\"$want\\\" ] && [ \\\"$want\\\" = \\\"$got\\\" ] || { echo \\\"f$i.txt 的内容不是它自身的 sha256\\\"; exit 3; }; done && echo all-fixed:3\",\"verified:no\",\"check:compile:skipped::050c5d1f\",\"check:run:skipped::050c5d1f\",\"check:tests:failed:3:abd5750b\",\"diagnostics:skipped:0:0\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f01.txt\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f02.txt\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f03.txt\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f04.txt\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f05.txt\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f06.txt\",\"reason:改了文件，但没有任何成功的构建 / 运行 / 测试 / 诊断：本轮不能算已验证\",\"reason:测试失败（for i in $(seq -w 1 6); do want=$(sha256sum f$i.txt | cut -d' ' -f1); got=$(tr -d '\\\\n' < f$i.txt); [ -n \\\"$want\\\" ] && [ \\\"$want\\\" = \\\"$got\\\" ] || { echo \\\"f$i.txt 的内容不是它自身的 sha256\\\"; exit 3; }; done && echo all-fixed，退出码 3）\"]",
          "criterionKey": "[\"工作区里 f01.txt 到 f6.txt 共 6 个文件，每个文件的内容必须恰好等于该文件自身的 sha256（64 位十六进制、不含空白），且 REPORT.md 逐条记录这 6 次校验命令与退出码\"]",
          "repeated": 0,
          "criteriaStreak": 0,
          "repeatLimit": 1,
          "criteriaLimit": 1,
          "criterionStalled": false,
          "noProgressStreak": 0
        },
        "recomputedProgress": {
          "fingerprint": "[\"step:write-1:fs.writeFile:completed::\",\"args:write-1:bbfdf13f\",\"step:write-2:fs.writeFile:completed::\",\"args:write-2:2dad2e43\",\"step:write-3:fs.writeFile:completed::\",\"args:write-3:6667ee53\",\"step:write-4:fs.writeFile:completed::\",\"args:write-4:ac915437\",\"step:write-5:fs.writeFile:completed::\",\"args:write-5:6f5301c7\",\"step:write-6:fs.writeFile:completed::\",\"args:write-6:f5d9a2a3\",\"step:check-hash-fixed:shell.run:failed:3:命令退出码 3\",\"args:check-hash-fixed:c9bdc155\",\"out:check-hash-fixed:3d593787\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f01.txt:\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f02.txt:\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f03.txt:\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f04.txt:\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f05.txt:\",\"evidence:file:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f06.txt:\",\"evidence:command:for i in $(seq -w 1 6); do want=$(sha256sum f$i.txt | cut -d' ' -f1); got=$(tr -d '\\\\n' < f$i.txt); [ -n \\\"$want\\\" ] && [ \\\"$want\\\" = \\\"$got\\\" ] || { echo \\\"f$i.txt 的内容不是它自身的 sha256\\\"; exit 3; }; done && echo all-fixed:3\",\"verified:no\",\"check:compile:skipped::050c5d1f\",\"check:run:skipped::050c5d1f\",\"check:tests:failed:3:abd5750b\",\"diagnostics:skipped:0:0\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f01.txt\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f02.txt\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f03.txt\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f04.txt\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f05.txt\",\"changed:/var/folders/67/wwgq5pv14wsc30489jtftvt00000gn/T/tf-m3-2-ws-1795848954037/f06.txt\",\"reason:改了文件，但没有任何成功的构建 / 运行 / 测试 / 诊断：本轮不能算已验证\",\"reason:测试失败（for i in $(seq -w 1 6); do want=$(sha256sum f$i.txt | cut -d' ' -f1); got=$(tr -d '\\\\n' < f$i.txt); [ -n \\\"$want\\\" ] && [ \\\"$want\\\" = \\\"$got\\\" ] || { echo \\\"f$i.txt 的内容不是它自身的 sha256\\\"; exit 3; }; done && echo all-fixed，退出码 3）\"]",
          "criterionKey": "[\"工作区里 f01.txt 到 f6.txt 共 6 个文件，每个文件的内容必须恰好等于该文件自身的 sha256（64 位十六进制、不含空白），且 REPORT.md 逐条记录这 6 次校验命令与退出码\"]",
          "repeated": 0,
          "criteriaStreak": 0,
          "repeatLimit": 1,
          "criteriaLimit": 1,
          "criterionStalled": false,
          "noProgressStreak": 0
        },
        "progressDiffs": [],
        "idleRecomputed": false,
        "repeatedCommands": [],
        "newRoundId": "f84863aa-1943-485b-9c82-fddd4898ecf5",
        "nextRoundPromptBytes": 9164,
        "nextRoundHasIdleDirective": false,
        "issues": []
      },
      {
        "round": 2,
        "roundId": "40641650-b922-4927-8fa4-285d38d1192a",
        "at": 1795850751938,
        "decisionType": "REPLAN",
        "nextAction": "open_next_round",
        "noProgressCause": "missing_context",
        "progress": {
          "fingerprint": "[\"step:step-1:session.search:completed::\",\"args:step-1:bebc8b13\",\"step:step-2:fs.tree:completed::\",\"args:step-2:71928f07\",\"step:step-3:fs.search:completed::\",\"args:step-3:192b54b5\",\"step:step-4:fs.search:completed::\",\"args:step-4:6cc3f5ff\",\"step:step-5:fs.find:completed::\",\"args:step-5:f14348dd\",\"step:step-6:shell.run:failed:128:命令退出码 128\",\"args:step-6:93cc62a6\",\"out:step-6:f1d7b1c6\",\"evidence:command:git status --short:128\",\"verified:yes\",\"check:compile:skipped::050c5d1f\",\"check:run:skipped::050c5d1f\",\"check:tests:skipped::050c5d1f\",\"diagnostics:skipped:0:0\",\"reason:本轮没有写操作，无需验证\"]",
          "criterionKey": "[\"工作区里 f01.txt 到 f6.txt 共 6 个文件，每个文件的内容必须恰好等于该文件自身的 sha256（64 位十六进制、不含空白），且 REPORT.md 逐条记录这 6 次校验命令与退出码\"]",
          "repeated": 0,
          "criteriaStreak": 1,
          "repeatLimit": 1,
          "criteriaLimit": 1,
          "criterionStalled": true,
          "noProgressStreak": 1
        },
        "recomputedProgress": {
          "fingerprint": "[\"step:step-1:session.search:completed::\",\"args:step-1:bebc8b13\",\"step:step-2:fs.tree:completed::\",\"args:step-2:71928f07\",\"step:step-3:fs.search:completed::\",\"args:step-3:192b54b5\",\"step:step-4:fs.search:completed::\",\"args:step-4:6cc3f5ff\",\"step:step-5:fs.find:completed::\",\"args:step-5:f14348dd\",\"step:step-6:shell.run:failed:128:命令退出码 128\",\"args:step-6:93cc62a6\",\"out:step-6:f1d7b1c6\",\"evidence:command:git status --short:128\",\"verified:yes\",\"check:compile:skipped::050c5d1f\",\"check:run:skipped::050c5d1f\",\"check:tests:skipped::050c5d1f\",\"diagnostics:skipped:0:0\",\"reason:本轮没有写操作，无需验证\"]",
          "criterionKey": "[\"工作区里 f01.txt 到 f6.txt 共 6 个文件，每个文件的内容必须恰好等于该文件自身的 sha256（64 位十六进制、不含空白），且 REPORT.md 逐条记录这 6 次校验命令与退出码\"]",
          "repeated": 0,
          "criteriaStreak": 1,
          "repeatLimit": 1,
          "criteriaLimit": 1,
          "criterionStalled": true,
          "noProgressStreak": 1
        },
        "progressDiffs": [],
        "idleRecomputed": true,
        "repeatedCommands": [],
        "reason": "连续无进展（原因分类：缺上下文，这是连续第 1 轮）：这一轮采到了不一样的证据，但未满足的标准一条也没变；未满足的标准集合连续 1 轮没有变化；诊断指向实现层缺陷；下一轮必须先改变计划与手段（换验证方式、换工具，或把范围缩到一条未满足的标准上），不得重复同样的调用",
        "newRoundId": "cef198ff-0fad-4ede-8c34-5a803826e14e",
        "nextRoundPromptBytes": 6176,
        "nextRoundHasIdleDirective": true,
        "commandOverlap": [],
        "directiveCommandSection": null,
        "issues": []
      },
      {
        "round": 3,
        "roundId": "6c9cafbd-856b-4cfc-91ed-59133239869e",
        "at": 1795851094723,
        "decisionType": "WAIT_USER",
        "nextAction": "stop_and_wait",
        "noProgressCause": "missing_context",
        "progress": {
          "fingerprint": "[\"step:step-1:fs.tree:completed::\",\"args:step-1:93fbe5d9\",\"step:step-2:fs.search:completed::\",\"args:step-2:192b54b5\",\"step:step-3:fs.search:completed::\",\"args:step-3:6cc3f5ff\",\"step:step-4:fs.search:completed::\",\"args:step-4:7fec3130\",\"step:step-5:fs.find:completed::\",\"args:step-5:efb7d55d\",\"step:step-6:fs.find:completed::\",\"args:step-6:eaacc13d\",\"verified:yes\",\"check:compile:skipped::050c5d1f\",\"check:run:skipped::050c5d1f\",\"check:tests:skipped::050c5d1f\",\"diagnostics:skipped:0:0\",\"reason:本轮没有写操作，无需验证\"]",
          "criterionKey": "[\"工作区里 f01.txt 到 f6.txt 共 6 个文件，每个文件的内容必须恰好等于该文件自身的 sha256（64 位十六进制、不含空白），且 REPORT.md 逐条记录这 6 次校验命令与退出码\"]",
          "repeated": 0,
          "criteriaStreak": 2,
          "repeatLimit": 1,
          "criteriaLimit": 1,
          "criterionStalled": true,
          "noProgressStreak": 2
        },
        "recomputedProgress": {
          "fingerprint": "[\"step:step-1:fs.tree:completed::\",\"args:step-1:93fbe5d9\",\"step:step-2:fs.search:completed::\",\"args:step-2:192b54b5\",\"step:step-3:fs.search:completed::\",\"args:step-3:6cc3f5ff\",\"step:step-4:fs.search:completed::\",\"args:step-4:7fec3130\",\"step:step-5:fs.find:completed::\",\"args:step-5:efb7d55d\",\"step:step-6:fs.find:completed::\",\"args:step-6:eaacc13d\",\"verified:yes\",\"check:compile:skipped::050c5d1f\",\"check:run:skipped::050c5d1f\",\"check:tests:skipped::050c5d1f\",\"diagnostics:skipped:0:0\",\"reason:本轮没有写操作，无需验证\"]",
          "criterionKey": "[\"工作区里 f01.txt 到 f6.txt 共 6 个文件，每个文件的内容必须恰好等于该文件自身的 sha256（64 位十六进制、不含空白），且 REPORT.md 逐条记录这 6 次校验命令与退出码\"]",
          "repeated": 0,
          "criteriaStreak": 2,
          "repeatLimit": 1,
          "criteriaLimit": 1,
          "criterionStalled": true,
          "noProgressStreak": 2
        },
        "progressDiffs": [],
        "idleRecomputed": true,
        "repeatedCommands": [],
        "reason": "连续无进展（原因分类：缺上下文，这是连续第 2 轮）：这一轮采到了不一样的证据，但未满足的标准一条也没变；未满足的标准集合连续 2 轮没有变化；诊断指向实现层缺陷；重做计划后仍未出现新事实，停止自动循环等待用户决定",
        "newRoundId": null,
        "issues": []
      }
    ],
    "taskId": "5c8edc7b-5421-4636-9753-90340639782f",
    "maxRounds": 20
  },
  {
    "label": "阈值热切 99/99（同一探针、同一进程，经「继续修复」由用户接回去）",
    "taskId": "5c8edc7b-5421-4636-9753-90340639782f",
    "decisions": []
  }
]
```

## 界面读数（工程目标卡）

```json
{
  "card": {
    "decisionLine": "最近一次周期判定：WAIT_USER · 停下等你决定｜连续无进展（原因分类：缺上下文，这是连续第 2 轮）：这一轮采到了不一样的证据，但未满足的标准一条也没变；未满足的标准集合连续 2 轮没有变化；诊断指向实现层缺陷；重做计划后仍未出现新事实，停止自动循环等待用户决定",
    "nextLine": "当前阶段：实现 · 下一步：连续无进展（原因分类：缺上下文，这是连续第 2 轮）：这一轮采到了不一样的证据，但未满足的标准一条也没变；未满足的标准集合连续 2 轮没有变化；诊断指向实现层缺陷；重做计划后仍未出现新事实，停止自动循环等待用户决定",
    "charLen": 472
  },
  "expectedLine": "最近一次周期判定：WAIT_USER · 停下等你决定｜连续无进展（原因分类：缺上下文，这是连续第 2 轮）：这一轮采到了不一样的证据，但未满足的标准一条也没变；未满足的标准集合连续 2 轮没有变化；诊断指向实现层缺陷；重做计划后仍未出现新事实，停止自动循环等待用户决定",
  "projectionCycleDecision": null,
  "causeText": "缺上下文"
}
```

## 中断原因

等待超时：B 段新增判定 出现第 4 条周期判定

## 配置目录终态

```json
{
  "exists": false,
  "content": null
}
```

## 断言结果

| 断言 | 结果 | 实测 |
| --- | --- | --- |
| default-store-readable | 通过 | /Users/yalla/Library/Application Support/thinkfusion-ai/agent-store.json |
| config-lowered-for-phase-a | 通过 | /Users/yalla/Library/Application Support/thinkfusion-ai/no-progress.json 写入 {"repeatLimit":1,"criteriaLimit":1}，解析结果 {"repeatLimit":1,"criteriaLimit":1}｜产品默认仍是 {"repeatLimit":2,"criteriaLimit":2}，默认阈值的触发轮数由离线用例覆盖 |
| renderer-ready | 通过 | CDP 已连接 |
| a-first-round-not-idle | 通过 | REPAIR → open_next_round｜streak 0｜理由「存在待修或未解决评审问题」｜无误伤 |
| a-idle-detected | 通过 | 第 2 份报告：进展 {"fingerprint":"[\"step:step-1:session.search:completed::\",\"args:step-1:bebc8b13\",\"step:step-2:fs.tree:completed::\",\"args:step-2:71928f07\",\"step:step-3:fs.search:completed::\",\"args:step-3:192b54b5\",\"step:step-4:fs.search:completed::\",\"args:step-4:6cc3f5ff\",\"step:step-5:fs.find:completed::\",\"args:step-5:f14348dd\",\"step:step-6:shell.run:failed:128:命令退出码 128\",\"args:step-6:93cc62a6\",\"out:step-6:f1d7b1c6\",\"evidence:command:git status --short:128\",\"verified:yes\",\"check:compile:skipped::050c5d1f\",\"check:run:skipped::050c5d1f\",\"check:tests:skipped::050c5d1f\",\"diagnostics:skipped:0:0\",\"reason:本轮没有写操作，无需验证\"]","criterionKey":"[\"工作区里 f01.txt 到 f6.txt 共 6 个文件，每个文件的内容必须恰好等于该文件自身的 sha256（64 位十六进制、不含空白），且 REPORT.md 逐条记录这 6 次校验命令与退出码\"]","repeated":0,"criteriaStreak":1,"repeatLimit":1,"criteriaLimit":1,"criterionStalled":true,"noProgressStreak":1}｜反算 {"fingerprint":"[\"step:step-1:session.search:completed::\",\"args:step-1:bebc8b13\",\"step:step-2:fs.tree:completed::\",\"args:step-2:71928f07\",\"step:step-3:fs.search:completed::\",\"args:step-3:192b54b5\",\"step:step-4:fs.search:completed::\",\"args:step-4:6cc3f5ff\",\"step:step-5:fs.find:completed::\",\"args:step-5:f14348dd\",\"step:step-6:shell.run:failed:128:命令退出码 128\",\"args:step-6:93cc62a6\",\"out:step-6:f1d7b1c6\",\"evidence:command:git status --short:128\",\"verified:yes\",\"check:compile:skipped::050c5d1f\",\"check:run:skipped::050c5d1f\",\"check:tests:skipped::050c5d1f\",\"diagnostics:skipped:0:0\",\"reason:本轮没有写操作，无需验证\"]","criterionKey":"[\"工作区里 f01.txt 到 f6.txt 共 6 个文件，每个文件的内容必须恰好等于该文件自身的 sha256（64 位十六进制、不含空白），且 REPORT.md 逐条记录这 6 次校验命令与退出码\"]","repeated":0,"criteriaStreak":1,"repeatLimit":1,"criteriaLimit":1,"criterionStalled":true,"noProgressStreak":1} |
| a-idle-decision-not-execute | 通过 | REPLAN → open_next_round｜分类 missing_context |
| a-idle-cause-classified | 通过 | 分类 missing_context（缺上下文）｜理由「连续无进展（原因分类：缺上下文，这是连续第 1 轮）：这一轮采到了不一样的证据，但未满足的标准一条也没变；未满足的标准集合连续 1 轮没有变化；诊断指向实现层缺陷；下一轮必须先改变计划与手段（换验证方式、换工具，或把范围缩到一条未满足的标准上），不得重复同样的调用」 |
| a-idle-progress-recomputed | 通过 | 事件阈值 {"repeatLimit":1,"criteriaLimit":1}｜反算 {"repeatLimit":1,"criteriaLimit":1} |
| a-idle-full-audit | 通过 | 字段、落点、指令下发全部对得上 |
| a-second-idle-stops-for-user | 通过 | 第 3 条判定 WAIT_USER → stop_and_wait｜连续第 2 轮空转｜新轮 无｜无遗留问题 |
| a-stop-waits-for-user-not-failed | 通过 | 任务状态 report_pending｜判定 WAIT_USER｜界面入口「继续修复（重新执行验证）」/「接受未验证并结束」 |
| ui-shows-probe | 通过 | 侧栏选中探针 |
| ui-idle-cause-readable | 通过 | 界面「最近一次周期判定：WAIT_USER · 停下等你决定｜连续无进展（原因分类：缺上下文，这是连续第 2 轮）：这一轮采到了不一样的证据，但未满足的标准一条也没变；未满足的标准集合连续 2 轮没有变化；诊断指向实现层缺陷；重做计划后仍未出现新事实，停止自动循环等待用户决定」 |
| ui-cycle-decision-matches-newest-event | 通过 | 应为「最近一次周期判定：WAIT_USER · 停下等你决定｜连续无进展（原因分类：缺上下文，这是连续第 2 轮）：这一轮采到了不一样的证据，但未满足的标准一条也没变；未满足的标准集合连续 2 轮没有变化；诊断指向实现层缺陷；重做计划后仍未出现新事实，停止自动循环等待用户决定」｜最新事件 WAIT_USER/stop_and_wait |
| ui-projection-single-source | 通过 | 投影句 最近一次周期判定：WAIT_USER · 停下等你决定｜连续无进展（原因分类：缺上下文，这是连续第 2 轮）：这一轮采到了不一样的证据，但未满足的标准一条也没变；未满足的标准集合连续 2 轮没有变化；诊断指向实现层缺陷；重做计划后仍未出现新事实，停止自动循环等待用户决定 |
| ui-card-scrolled | 通过 | 截图前把「工程目标」卡滚进视口 |
| config-raised-read-back | 通过 | /Users/yalla/Library/Application Support/thinkfusion-ai/no-progress.json 写入 {"repeatLimit":99,"criteriaLimit":99}，解析结果 {"repeatLimit":99,"criteriaLimit":99} |
| b-resume-fired | **未通过** | 点火返回 "fired"｜8 秒后页面记录 "Error invoking remote method 'task:resume-repair': Error: 这一轮已经完成全部检查，不需要继续修复"（pending 表示主进程还在跑下一轮，ok 表示已返回） |

合计 18 项，未通过 1 项：b-resume-fired。

## 截图

- `01-idle-decision-goal-card.png`

事件原文：`events.after-idle.json`（A 段三条判定到手后）、`events.after-stop.json`（停下等人的那条）、
`events.raised-threshold.json`（B 段阈值热切后的第 4 条）；判定单条原文见 `decision-*.json`。

---

## 本文件生成之后手工更正（2026-11-28，逐条与 evidence.json 对得上）

上面这份正文由脚本在第 5 次真机结束时写出，其中三句与实况不符，就地更正（不改机器生成的正文，避免把当时的判定快照改掉）：

1. **「收尾已删除」不成立**。B 段抛错后主流程没走到 `cleanupProbe`，探针任务
   `5c8edc7b-5421-4636-9753-90340639782f`（状态 `report_pending`）留在默认数据目录里——
   `evidence.cleanup` 只有第 1 具 `7af5a428` 的回执。已在 16:0x 另起一次短生命周期 dev 实例，走产品自己的
   `cancelTask` + `deleteTask` 删除，核对结果：store 内任务 0 条、`context-checkpoints/owners/agent-task` 为空。
   脚本已把汇总行改为由删除回执算出「N/M 具已删除」并在缺回执时点名任务，不再写死这句。
2. **`events.raised-threshold.json` 不存在**（目录里只有 `events.after-idle.json` 与 `events.after-stop.json`，
   两者都是 A 段静默期后抓的同一份 267 条事件）。B 段一条判定都没新增：`resumeRepair` 被拒
   「这一轮已经完成全部检查，不需要继续修复」，所以「阈值热切后不再拦」这一段现场没有证据，
   `evidence.json` 里也没有 `bBlocked` 字段——那次运行跑的是快败逻辑之前的脚本版本（进程启动时已加载旧代码）。
3. **「中途只改配置文件不重启」这句只对 B 段成立**。A 段的 1/1 是在 `startDev` **之前**写的，
   进程一起来就带着这份配置，因此本轮**证不到**「阈值热生效」；B 段的 99/99 确实是运行中写的，但之后没有新判定
   落进事件流，也就没有事件里的阈值可以对照。脚本已把 1/1 的写入挪到「渲染进程连上之后」并加时间戳断言
   `a-threshold-applies-without-restart`（18 项 → 19 项，下一轮运行才会跑出这条）。

结论口径见 [SUMMARY.md](SUMMARY.md)：A 段 17 项通过的部分成立（拦得住、说得清、任务没被判死、指令真下发、
界面与事件同源）；「关得掉」只证到配置侧，用户侧被 `stop_and_wait` 后缺少「再来一轮」入口挡住，归 M3-4。
