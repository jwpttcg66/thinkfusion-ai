# 对齐 harness 的两件事：spawn 前置沙箱与逐次工具审批（2026-11-09）

用户裁决：「两个全部按照 harness 修改吧，真机验证通过」。

这两条在 `HARNESS_BASELINE.md` 里原本是**未落地**项：

| 项 | dsh 的做法 | 我们原来的做法 |
| --- | --- | --- |
| 沙箱 | `packages/sandbox`，spawn 之前包 argv | 只做路径校验，`sh -c` 起来之后就管不住了 |
| 审批 | `tools/pre-execute` 瀑布，每次调用都过 | 批准整份计划，之后一路跑完 |

「按 harness 修改」的意思是**采纳这两条设计**，不是引入 dsh 的包。代码仍然零
`@deepseek-ai/*` 依赖。

## 1. spawn 前置沙箱

### 1.1 为什么必须在 spawn 之前

路径校验只能约束我们自己的文件工具。命令交给 `/bin/sh -c` 之后，子进程能写哪里
与 grant 无关了：`find . -delete`、`curl … | sh`、往 `~/.ssh` 写 key 都不经过
`resolveGrantedPath`。所以限制必须加在进程启动的那一刻。

### 1.2 profile 的形状

```
(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath "<授权根目录>")
  (subpath "<额外可写目录>")
  (subpath "<os.tmpdir()>")
  (subpath "/private/var/folders")
  (literal "/dev/null") …)
```

- **读全放开是刻意的**：构建要读 `~/.npm/_cacache`、`/usr/local/lib/node_modules`、
  `/private/var/folders`，逐个枚举读权限既写不全也维护不动；而「写到哪」才是
  真正造成损失的维度。
- **顺序不能反**：SBPL 后写的规则覆盖先写的。`deny` 在前、`allow` 在后；反过来
  就是全禁，测试里有一条专门守这个顺序。
- 沙箱可用时 argv 是 `sandbox-exec -p <profile> <cmd> …`。profile 走 `-p` 直接传
  文本，不落临时文件——否则多一条「profile 被改写」的口子。

### 1.3 探测是必须的，不是保险

`probeSandbox()` 在真正施加限制的 profile 下跑一次 `sandbox-exec … /bin/sh -c true`，
通过了才声称 `sandboxed: true`。原因见下节。

### 1.4 已知限制：macOS 26.3 拒绝施加限制

本机（macOS 26.3 / 25D125）实测：

```
$ sandbox-exec -p '(version 1)(allow default)' /usr/bin/true          → exit 0
$ sandbox-exec -p '(version 1)(allow default)(deny file-write*)' …    → sandbox_apply: Operation not permitted
$ sandbox-exec -p '(version 1)(deny default)(allow …)' …              → sandbox_apply: Operation not permitted
```

**只有「什么都不限制」的 profile 能应用**。任何带 `deny` 的降权 profile 都被系统
拒绝（即便在非沙箱 shell 里、即便 `dangerouslyDisableSandbox`）。这不是我们的
写法问题：语法错误会报 `unbound variable`，这里报的是 `sandbox_apply` 被拒。

所以本机上的真机结果是 `sandboxed: false`，原因原样写进执行报告。**把「没能沙箱」
说成「沙箱了」比不做沙箱更糟**——用户会据此放松警惕。

代码路径在能施加限制的系统上不需要改动：探测通过就自动启用。Linux 后端（bwrap）
尚未实现，`probeSandbox()` 在非 darwin 上明确报「当前平台没有接沙箱后端」。

### 1.5 接入位置

| 文件 | spawn 点 |
| --- | --- |
| `src/agent/tools/shell.ts` | `sh -c` 前台命令 |
| `src/agent/tools/jobs.ts` | 后台作业（额外可写：作业日志目录） |
| `src/agent/tools/test-run.ts` | 固定白名单测试命令 |
| `src/agent/tools/code-run.ts` | 模型写的脚本 |

四处都返回 `sandboxed` / `sandboxReason`，执行报告里能看出这一轮到底有没有隔离。

## 2. 逐次工具审批

### 2.1 语义

批准一份计划 ≠ 批准每一次调用：计划提交时用户不知道前几步会跑出什么。审批下沉
到每一步之后，用户在**知道上下文**的情况下决定这一刀要不要落。

### 2.2 链路

```
Runtime 每一步 → postMessage 'step.approval'
   → 主进程 agent-manager 记入 pendingSteps → 转渲染层（agent:event）
   → 用户点「执行这一步 / 同类不再问 / 拒绝」
   → ipc 'task:approve-step' | 'task:reject-step'
   → decideStepApproval 回包 'step.approval.result'
   → Runtime 继续或停止
```

关键点：

- **一定要回包**。Runtime 在等；没有回包它只能等到超时。晚到的批准会明确报
  「这一步已经不在等待确认」，不会把「批准晚了」显示成「已经放行」。
- **超时按拒绝处理**（5 分钟）。一个已经去开会的人不该因为「没回话」就让命令
  跑出去；超时原因写进报告。
- **拒绝即停**：该步记 `STEP_REJECTED`，整份计划 `break`，后面的步骤不执行。
  用户主动取消时记 `cancelled` 而不是 `failed`。
- **「同类不再问」** 由主进程按 `taskId + risk` 记住，只在本次任务内有效；报告
  一到就清空——上一轮同意过，不代表下一份计划也同意。

### 2.3 三档粒度

`TaskGrant.stepApproval`：

| 值 | 行为 |
| --- | --- |
| `every` | 每一步都问（最严，harness 原始语义） |
| `mutating` | **缺省**：只问有副作用的步骤 |
| `off` | 批准整份计划后一路跑完（升级前的行为） |

缺省是 `mutating` 而不是 `every`：八步的批量改造会弹八次，用户第三次之后就开始
无脑点批准——那比只问关键几步更不安全。要最严语义就显式传 `every`。

`risk` 分 `read` / `write` / `danger`，只影响界面强调（`danger`：`shell.run` /
`code.run` / `test.run` / `process.kill` / `fs.remove` / `fs.move`），不改变问不问。

## 3. 文件

| 文件 | 职责 |
| --- | --- |
| `src/agent/tools/sandbox.ts` | `buildSeatbeltProfile` / `probeSandbox` / `sandboxArgv` / `wrapWithSandbox` |
| `src/agent/step-approval.ts` | `needsApproval` / `riskOf` / `previewArgs`（纯函数，可测） |
| `src/agent/index.ts` | 每步执行前 `waitForApproval`；超时、取消、拒绝的落库与报告 |
| `src/main/agent-manager.ts` | `pendingSteps` / `remembered` / `decideStepApproval` |
| `src/main/orchestrator.ts` | `approveStep` / `rejectStep`；grant 带 `stepApproval` |
| `src/shared/contracts.ts` | `STEP_APPROVAL_MODES`、`step.approval` 事件、`AgentApi` 两个方法 |
| `src/renderer/src/App.tsx` | 阻塞态卡片：参数预览 + 执行 / 同类不再问 / 拒绝 |

## 4. 验证

- `scripts/check-harness-alignment.mjs`：**12 条**
  - profile：`deny file-write*` 在 `allow` 之前、授权目录与临时目录进清单、引号
    转义、网络开关；
  - argv：`sandbox-exec -p <profile> <cmd> …` 的顺序；
  - 探测：结果一定带原因，缓存生效；
  - 降级：不可用时命令原样执行且 `sandboxed:false`（不假装）；
  - `shell.run` 真跑一次：退出码 0、`sandboxed` 是 boolean、组合符仍被拒；
  - 审批：三档语义、风险分级、参数预览截断留痕、循环引用不炸、grant 三值可写
    且非法值被拒。
- 真机（s34，CDP 9222，ChatGPT 规划，workspace-write）：
  - **逐步确认真的会阻塞执行**。任务停在 `executing`，事件流止于
    `step.approval:shell.run`，批准前后一条都不多；
  - **批准后才执行**。批准后事件是
    `step.approval → step.approval-resolved → step.started → step.completed`，
    `shell.run` 的 result 里是真实输出 `       5 input.txt`、`exitCode 0`、42ms；
  - **沙箱如实上报**。同一份 result 里 `sandboxed: false`，
    `sandboxReason: 系统拒绝施加沙箱限制（sandbox-exec: sandbox_apply: Operation not permitted）…`
    ——没有把「没沙箱」写成「沙箱了」；
  - **只读步骤不打扰**。`fs.readFile + fs.list` 的计划从头到尾零 `step.approval`，
    `mutating` 档按预期只问有副作用的步骤；
  - **拒绝即停**。拒绝第一步后报告 `status: failed`、错误码 `STEP_REJECTED`、
    没有任何步骤 `completed`、目标文件没有被创建，任务历史清空后为 0 条。
