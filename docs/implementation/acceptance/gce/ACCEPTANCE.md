# GCE 真机验收记录

- 日期：2026-11-27
- 分支：`lt-goal-contract-design`
- 提交：`111a16e`（目标契约/证据/阶段/目标卡接线后）
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

## 3. 未完成/未验证

- 工程目标卡与目标修订控件已接线并通过 typecheck/单测，但没有在真机里用鼠标完成一次“修改目标 → 删除标准 → 确认版本递增”的交互验收。
- 恢复后的版本一致性、stale 展示未做真机长任务样本。
- General / Knowledge / Engineering 三场景回归未全部重跑；本轮只覆盖 Engineering 的固定工作流与一次真实模型会话。
- 真机日志来自 CDP 事件流；没有截图。

因此本记录支持：GCE 目标/证据/阶段/决策/交付在真实主进程链路可用；不支持：P5 全部交互已验收或全场景已回归。
