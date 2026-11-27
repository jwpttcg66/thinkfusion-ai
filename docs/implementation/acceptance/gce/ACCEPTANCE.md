# GCE 真机验收记录

- 日期：2026-11-27
- 分支：`lt-goal-contract-design`
- 提交：`b15ee56` + 本轮目标修订基线修复（见 6.3）
- 环境：macOS，默认数据目录 `~/Library/Application Support/thinkfusion-ai`；未设置 `THINKFUSION_USER_DATA`，未复制用户数据。
- 启动方式：`desktop-agent-macos` 下 `npx electron-vite dev --noSandbox --remoteDebuggingPort 9222`（等价 `npm run dev:local` 的 CDP 模式）。

## 1. 真实模型任务：执行完成不等于目标达成

### 1.1 修复前（`692e990` 行为）

真实会话 + 云端规划，任务只做只读分析，报告 `verification.verified=true`、`changedPaths=[]`。旧逻辑直接 `task.completed`，并写 `goal.fit=met`。这证明“执行完成被写成目标达成”的问题存在。

### 1.2 修复后（`b777e5e` 起）

同一场景，事件序列变为：

```text
report.ready report=completed verified=true paths=
goal.fit fit=pending gceFit=PARTIAL criteria=UNVERIFIED notes=1 条强制标准尚未满足或未验证
cycle.decision.created
cycle.stage.completed CONCLUSION
cycle.stage.started NEXT_DECISION
cycle.stage.completed NEXT_DECISION (进入下一轮修复)
cycle.stage.started PLANNING (修复轮重新规划)
```

结论：

- `goal.fit` 没有写 `met`；
- 完全权限下自动进入下一轮修复；
- 阶段来自真实 `cycle.stage.*` 事件，不是旧事件反推。

## 2. 固定工作流：真实写文件 + 真实测试通过

### 2.1 场景

绕过模型规划的不确定性，使用固定工作流直接执行真实工具：

```text
fs.writeFile(src/math.js, 正确的 add)
→ test.run(npm test)
```

工作区：临时 Node 工程，初始 `add` 为减法，测试失败。
权限：`danger-full-access`。
完成条件：`src/math.js 已写入正确的 add，且 npm test 退出码为 0`。

### 2.2 结果

```text
report.ready report=completed verified=true tests=passed paths=src/math.js
goal.fit fit=met gceFit=MET criteria=MET:src/math.js 已写入正确的 add，且 npm test 退出码为 0
task.completed 执行完成，验证通过，目标标准已满足
FINAL_FIT=MET
DELIVERABLES=["src/math.js"]
```

工作区复核：

```js
export function add(a, b) {
  return a + b;
}
```

结论：

- 目标契约在计划生成时建立，标准类型为 `MODEL_INFERRED` MUST；
- 标准文本包含 `npm test`，`acceptedEvidenceTypes` 收窄为 `TEST_RESULT/INTEGRATION_RESULT`；
- 真实 `test.run` 通过 → Criterion `MET` → Goal Fit `MET` → 任务按目标收尾；
- 交付文件来自真实 `changedPaths`，不是模型摘要。

### 2.3 本轮修复的真机缺陷

首次固定工作流运行暴露并修复：

1. 工作流路径没有 `planning → plan_ready`，`awaiting_approval` 被判非法状态转换；
2. 测试型工作流只有 `test.run` 通过，旧 GDC 仍要求 `compile+run+test+diagnostics` 全过，导致 Goal Fit `MET` 后仍进修复轮，最终因没有规划适配器失败。

修复提交：`111a16e`。

## 3. 计划覆盖门禁与恢复契约（自动化）

提交 `b0e7a59` 补齐 P4/P5 两处生产门禁：

- Criterion → L2/L3 保守映射；单一 MUST 覆盖所有 L2，多标准按关键词匹配，匹配不上保持未覆盖；
- 计划生成时运行 `assessGoalDecomposition`；MUST 无承接/任务无验收时写入 `plan.ready` 警告，并且不自动批准；
- 恢复时 `reconcileGoalContractOnResume` 核对目标版本、Criterion 版本、当前标准和任务树；不兼容发 `goal.contract.stale`，投影清空旧 Criterion/Goal Fit。

自动化：

```text
goal-recovery              4/4
tdl-decomposition           8/8
gdc-goal                    9/9（含 stale 投影）
engineering-orchestration  28/28
workflow                   10/10
```

同一固定工作流在门禁接入后再次真机运行：

```text
task 08bbfc03-6763-436c-a398-cb5c31b96fd1
goal.fit fit=met gceFit=MET criteria=MET
task.completed 执行完成，验证通过，目标标准已满足
DELIVERABLES=["src/math.js"]
```

说明：单 MUST Criterion 会覆盖所有 L2，因此该样本没有被门禁误拦；多 Criterion 未匹配时的阻断目前只有自动化覆盖，没有真机样本。

## 4. 三场景与目标修订（真机 API 链路）

### 4.1 General / Knowledge

通过运行中的 App 提交同一条云端配置：

```text
general   intent=answer status=answered answerChars=45
knowledge intent=answer status=answered answerChars=343
```

两条都已删除会话，未留下用户侧长期记录。工程场景见第 2 节固定工作流。

### 4.2 目标修订

在等待审批的工作流任务上调用真实 IPC：

```text
task status=awaiting_approval
clarify kind=clarify versionChanged=false nextVersion=1
change  kind=change  versionChanged=true  nextVersion=2
goal.contract.updated:
  v1 写入后回读内容一致
  v1 写入后回读内容一致|测试退出码为 0
  v2 写入后回读内容一致
final version=2 criteria=["写入后回读内容一致"]
```

结论：

- 补充标准不抬版本；
- 删除标准经 `userConfirmedChange=true` 才抬到 v2；
- 每次变化都写 `goal.contract.updated`，契约与任务字段一致。
- 这是 IPC/主进程链路验证；目标卡上“删除 → 浏览器确认框”的鼠标交互见 4.3。

### 4.3 目标卡鼠标交互

在真实 App 里选中等待审批的工作流任务，直接操作目标卡：

```text
点击「修改目标 / 成功标准」
输入：写入后回读内容一致 / 测试退出码为 0
保存 → 卡片显示 v1，两条 Criterion
再次编辑，删除第二条，浏览器确认框点「确定」
保存 → 卡片显示 v2，只保留一条 Criterion
```

任务字段复核：`goalVersion=2`，`goalCriteria=["写入后回读内容一致"]`；
事件流有三条 `goal.contract.updated`（v1、v1 补充、v2）。

这次交互还暴露并修复了两个 UI 问题：

- 目标卡版本号只读投影默认值，契约升到 v2 后仍显示 v1；
- 契约已有 Criterion 时仍显示兜底的「尚未写明成功标准」。

同时发现单步工作流的 Criterion 没有 L2 可承接，被门禁误判；已改为没有 L2 时由 L3 步骤承接，并有自动化覆盖。

## 5. 未完成/未验证

- General / Knowledge / Engineering 三场景在 `b15ee56` 之后未统一重跑：通用/知识场景见 4.1，工程场景见第 1、2 节，但基线早于本次目标卡修复。
- 暂停不能中断在途 `shell.run`：第一次恢复样本在暂停后仍把 `sleep 40` 跑完并出了报告，所以恢复样本改用应用重启（见第 6 节）。暂停语义的缺口未在本任务修。
- 真机日志来自 CDP 事件流；没有截图。

已关闭（原列在本节）：

- 目标卡鼠标交互已在 4.3 用真实点击完成：“修改目标 → 删除标准 → 确认后 v1→v2”，并修掉版本号与兜底说明两处 UI 缺陷。
- 恢复后的版本一致性与 stale 展示已在第 6 节用真实重启任务点验。

因此本记录支持：GCE 目标/证据/阶段/决策/交付在真实主进程链路可用；目标卡目标修订可用；应用重启后的 stale 投影可用。不支持：三场景已在最新基线全量回归，或暂停语义已能中断在途命令。

## 6. 应用重启恢复与 stale 投影（真机）

### 6.1 场景

- 环境同第 1 节：默认数据目录，`dev:local`（CDP 9333），分支 `lt-goal-contract-design`。
- 工作流：`fs.writeFile(first.txt)` → 8 × `shell.run(sleep 45)` → `fs.writeFile(second.txt)`，权限 `danger-full-access`。
- 第一段写文件真实完成后，用 `SIGKILL` 杀掉 Electron 主进程（不是正常退出），再启动同一个 App。
- 重启后任务状态为 `interrupted`；在目标卡上删除原标准（`userConfirmedChange=true`），再点继续。

### 6.2 结果

```text
重启后：status=interrupted goalVersion=1
目标修订：kind=change nextVersion=2 versionChanged=true
          impacted=11 个未完成任务 inherited=wt-write-first
继续：version.consistency consistent=true notes=四层版本一致，可以按检查点继续
      goal.contract.stale goalVersion=2
      reasons=["任务树仍有 v1 的任务，当前目标为 v2"]
```

目标卡真实渲染（CDP 读取 `.goal-contract-card`）：

```text
工程目标 · active · 符合度 未验证 · v2
还没有可验收的成功标准；执行完成不会自动算目标达成。
符合度说明：任务树仍有 v1 的任务，当前目标为 v2
待澄清：目标契约已过期；继续前会按当前目标重新建立
```

结论：

- 重启不会复用旧契约：`goal.contract.stale` 落下后卡片清空 Criterion、Goal Fit 回到「未验证」，并明确写出目标版本与原因。
- `version.consistency` 与 goal 核对判据不同：前者取任务树里最高版本（v2）所以报一致；后者逐个任务核对，发现已完成的 `wt-write-first` 仍绑 v1，判 stale。界面以 stale 为准；两者口径若要统一需要单独裁决，本次没有改。
- 继续后的下一轮因网页通道未就绪失败（`ChatGPT 页面尚未就绪`），发生在恢复判定之后，与 stale 结论无关。样本任务与临时工作区已删除。

### 6.3 本轮修复

计划生成时建立了 GoalContract，但 `task.goalCriteria` 仍为空；`reviseGoal` 拿空数组当比较基线，把「删除契约里已有标准」误判成 `clarify`，不抬版本、不要求确认，而目标卡却写着“确认后目标版本会递增”。

修复：契约存在时以契约的 Criterion 为修订基线（`revisionBaselineCriteria`），没有契约才退回 `goalCriteria`。`test:gdc-goal` 增加该用例（10/10）。
