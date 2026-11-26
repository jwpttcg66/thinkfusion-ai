# 真机复验：还会不会出现长流程

- 时间：2026-11-26T07:44:37.786Z → 2026-11-26T07:47:01.373Z
- 任务：`2c75f0f5-4baf-4cd3-9159-041bcb81431e`，隔离 userData `/tmp/tf-approval-userdata`，工作区 `/tmp/tf-approval-workspace`
- 模型：["opencode-go:deepseek-v4.1-flash"]，权限 `danger-full-access`（/tmp 一次性工作区）
- 真实 store：`3d64bc63c714` 前后一致

## 判定

- 结论：**no-long-flow**
- 轮次 1 / 其中出计划 1 / 报告 1 份 / 评审 1 次
- 耗时 130 秒，终态 `completed`
- 报告证据重复：false；评审问题重复：false
- cycle.snapshot：[{"decision":"complete","conclusionType":"accepted"}]
- 闸门拦截：[]
- 完全权限审批：等待审批=false，人工点计划=0，NEEDS_ANALYSIS 警告=1 条（本次确已触发，仍无审批等待）
- 触发证据：编排器日志「TDL：计划涉及多个独立写入目标，但没有 decomposition…；TDL 缺可独立验收的 L2：已记入计划警告，属于质量问题，不阻塞自动批准…」
- 截图 `02-final.png`：左下角权限芯片仍为「完全权限」，任务「已完成」，页面没有「确认并执行 / 拒绝计划」按钮。

## 事件

| 时间 | 事件 | 详情 |
| --- | --- | --- |
| 1795679092931 | task.updated | {"roundId":null} |
| 1795679092949 | task.updated | {"roundId":null} |
| 1795679092973 | task.updated | {"roundId":null} |
| 1795679092981 | round.started | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679092998 | round.peer | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679095481 | round.delta | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679161394 | round.answer | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679161415 | task.updated | {"roundId":null} |
| 1795679161452 | task.updated | {"roundId":null} |
| 1795679161462 | log | {"roundId":null,"level":"warn","message":"TDL：计划涉及多个独立写入目标，但没有 decomposition，且无法从步骤归纳出可独立验收的 L2 子任务；TDL 缺可独立验收的 L2：已记入计划警告，属于质量问题，不阻塞自动批准，任务树暂无独立验收的 L2。"} |
| 1795679161470 | plan.ready | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2","planId":"ec24646e-f427-4d5c-b565-b511e67cbb60","steps":12,"title":"Go Hello World demo 与完整验证"} |
| 1795679161479 | work.breakdown.created | {"roundId":null} |
| 1795679161479 | work.task.upserted | {"roundId":null} |
| 1795679161479 | work.task.upserted | {"roundId":null} |
| 1795679161479 | work.task.upserted | {"roundId":null} |
| 1795679161479 | work.task.upserted | {"roundId":null} |
| 1795679161479 | work.task.upserted | {"roundId":null} |
| 1795679161479 | work.task.upserted | {"roundId":null} |
| 1795679161479 | work.task.upserted | {"roundId":null} |
| 1795679161479 | work.task.upserted | {"roundId":null} |
| 1795679161479 | work.task.upserted | {"roundId":null} |
| 1795679161479 | work.task.upserted | {"roundId":null} |
| 1795679161479 | work.task.upserted | {"roundId":null} |
| 1795679161479 | work.task.upserted | {"roundId":null} |
| 1795679161479 | work.task.upserted | {"roundId":null} |
| 1795679161479 | work.task.upserted | {"roundId":null} |
| 1795679161611 | step.preparing | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679161620 | step.preparing | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679161628 | step.preparing | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679161636 | step.preparing | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679161644 | step.preparing | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679161654 | step.preparing | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679161662 | step.preparing | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679161670 | step.preparing | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679161678 | step.preparing | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679161687 | step.preparing | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679161696 | step.preparing | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679161705 | step.preparing | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679161737 | eco.context.requested | {"roundId":null} |
| 1795679161747 | log | {"roundId":null,"level":"warn","message":"ECO DIRECTORY_DISCOVERY 未取得证据：: 不是工作区内的相对路径"} |
| 1795679161756 | eco.context.requested | {"roundId":null} |
| 1795679161766 | log | {"roundId":null,"level":"warn","message":"ECO FILE_READ 未取得证据：go.mod: 文件不存在、不可读或超过扫描上限"} |
| 1795679161774 | eco.context.requested | {"roundId":null} |
| 1795679161783 | log | {"roundId":null,"level":"warn","message":"ECO FILE_READ 未取得证据：main.go: 文件不存在、不可读或超过扫描上限"} |
| 1795679161792 | eco.context.requested | {"roundId":null} |
| 1795679161802 | log | {"roundId":null,"level":"warn","message":"ECO FILE_READ 未取得证据：go.mod: 文件不存在、不可读或超过扫描上限；main.go: 文件不存在、不可读或超过扫描上限；main_test.go: 文件不存在、不可读或超过扫描上限"} |
| 1795679161811 | log | {"roundId":null,"level":"warn","message":"ECO：计划引用的 3 个文件一个都没能核验，这些文件不计入工程证据。"} |
| 1795679161821 | eco.context.requested | {"roundId":null} |
| 1795679161831 | log | {"roundId":null,"level":"warn","message":"ECO TEST_DISCOVERY 未取得证据：go.mod, main.go, main_test.go: 找不到对应的测试文件"} |
| 1795679161839 | eco.context.prepared | {"roundId":null} |
| 1795679161849 | model.participation.selected | {"roundId":null} |
| 1795679161857 | plan.review.progress | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679162248 | log | {"roundId":null,"level":"info","message":"方案评审：OpenCode Go · deepseek-v4.1-flash 撰写【结论/一致/分歧/存疑/辩题】"} |
| 1795679162248 | round.peer | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679164237 | round.delta | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679171867 | plan.review.progress | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679178607 | round.peer | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679178620 | plan.review.progress | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679178632 | log | {"roundId":null,"level":"info","message":"五段结论已出，主导模型指定 1 个辩题"} |
| 1795679178648 | round.peer | {"roundId":"review:2218848c-4395-4c0a-9765-84468a2db8d7"} |
| 1795679180518 | round.delta | {"roundId":"review:2218848c-4395-4c0a-9765-84468a2db8d7"} |
| 1795679181868 | plan.review.progress | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679191868 | plan.review.progress | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679195024 | round.peer | {"roundId":"review:2218848c-4395-4c0a-9765-84468a2db8d7"} |
| 1795679195054 | plan.review.bridge | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679195064 | log | {"roundId":null,"level":"info","message":"第 1 轮表态结束：仍有 0 条争议未解决 → 进入第 2 轮质疑"} |
| 1795679195074 | round.peer | {"roundId":"review:2218848c-4395-4c0a-9765-84468a2db8d7"} |
| 1795679196693 | round.delta | {"roundId":"review:2218848c-4395-4c0a-9765-84468a2db8d7"} |
| 1795679201869 | plan.review.progress | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204471 | round.peer | {"roundId":"review:2218848c-4395-4c0a-9765-84468a2db8d7"} |
| 1795679204496 | plan.review.bridge | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204506 | log | {"roundId":null,"level":"info","message":"第 2 轮评审（质疑）结束：达到最多 2 轮，评审收尾"} |
| 1795679204527 | model.decision.snapshot | {"roundId":null} |
| 1795679204536 | plan.review.progress | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204556 | task.updated | {"roundId":null} |
| 1795679204536 | plan.debated | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204574 | log | {"roundId":null,"level":"info","message":"完全权限：计划已自动批准并开始执行，步骤不再逐次询问。"} |
| 1795679204602 | task.updated | {"roundId":null} |
| 1795679204611 | execution.bridge | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204623 | task.started | {"roundId":null} |
| 1795679204624 | step.started | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204642 | work.task.status | {"roundId":null} |
| 1795679204625 | step.completed | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204661 | work.task.status | {"roundId":null} |
| 1795679204629 | step.started | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204680 | work.task.status | {"roundId":null} |
| 1795679204630 | step.completed | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204700 | work.task.status | {"roundId":null} |
| 1795679204633 | step.started | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204720 | work.task.status | {"roundId":null} |
| 1795679204634 | step.completed | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204738 | work.task.status | {"roundId":null} |
| 1795679204634 | step.started | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204756 | work.task.status | {"roundId":null} |
| 1795679204711 | step.completed | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204774 | work.task.status | {"roundId":null} |
| 1795679204711 | step.started | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204792 | work.task.status | {"roundId":null} |
| 1795679204812 | step.completed | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204821 | work.task.status | {"roundId":null} |
| 1795679204812 | step.started | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204839 | work.task.status | {"roundId":null} |
| 1795679204858 | step.completed | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204867 | work.task.status | {"roundId":null} |
| 1795679204858 | step.started | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204885 | work.task.status | {"roundId":null} |
| 1795679204903 | step.completed | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204911 | work.task.status | {"roundId":null} |
| 1795679204903 | step.started | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204929 | work.task.status | {"roundId":null} |
| 1795679204940 | step.completed | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204949 | work.task.status | {"roundId":null} |
| 1795679204940 | step.started | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679204967 | work.task.status | {"roundId":null} |
| 1795679205175 | step.completed | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679205185 | work.task.status | {"roundId":null} |
| 1795679205175 | step.started | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679205203 | work.task.status | {"roundId":null} |
| 1795679206010 | step.completed | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679206021 | work.task.status | {"roundId":null} |
| 1795679206011 | step.started | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679206041 | work.task.status | {"roundId":null} |
| 1795679206170 | step.completed | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679206181 | work.task.status | {"roundId":null} |
| 1795679206170 | step.started | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679206200 | work.task.status | {"roundId":null} |
| 1795679206554 | step.completed | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2"} |
| 1795679206564 | work.task.status | {"roundId":null} |
| 1795679206643 | report.ready | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2","status":"completed","nextAction":"continue","results":12,"steps":[{"tool":"fs.list","status":"completed","args":{"path":"."},"exitCode":null,"stdout":null},{"tool":"fs.find","status":"completed","args":{"pattern":"*.go","path":"."},"exitCode":null," |
| 1795679220758 | review.ready | {"roundId":"abb5313e-627c-4938-8cf6-55aa923359d2","reviewer":"OpenCode Go · deepseek-v4.1-flash","verdict":"通过","issues":[],"needsFix":false} |
| 1795679220783 | task.updated | {"roundId":null} |
| 1795679220801 | task.updated | {"roundId":null} |
| 1795679220813 | cycle.snapshot | {"roundId":null,"decision":"complete","conclusionType":"accepted","nextAction":"无需下一轮；可做整体验收"} |
| 1795679220822 | goal.fit | {"roundId":null} |
| 1795679220839 | task.updated | {"roundId":null} |
| 1795679220849 | task.completed | {"roundId":null,"summary":"执行完成，验证通过"} |
| 1795679220859 | goal.fit | {"roundId":null} |

## 截图

- `02-final.png`

> 全程只读观察：没有点接受未验证、没有手动重判验证、没有取消任务。