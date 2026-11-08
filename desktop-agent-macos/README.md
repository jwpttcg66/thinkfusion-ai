# ThinkFusion v0.6.0 — macOS Apple Silicon

> 仓库总览、核心能力、工程介绍与 Roadmap，见[根目录 README（中文）](../README.zh-CN.md)
> 或 [English README](../README.md)。

在 Agent 输入框里提出目标，应用自动把任务发到内嵌的 DeepSeek 网页完成规划，取回结构化计划、本地校验、经你确认后由独立 Runtime 执行，再把执行报告自动回传给 DeepSeek 进入下一轮，直到任务完成。

用户不需要手动打开 DeepSeek 提问、不需要复制回答、不需要粘贴执行结果。

## 适配环境

- macOS Apple Silicon `arm64`
- Node.js 26.x / npm 11.x（终端构建环境；实测 22.22 也可通过 typecheck 与构建）
- Electron 45.1.0
- Xcode Command Line Tools（仅构建 Swift Accessibility helper 时需要）

## 闭环流程

```
输入框 → 创建 Task/Round → 自动发送 DeepSeek → 归属校验后取回本轮回答
   → 解析 desktop-agent/v1 计划 → Zod 校验 → 展示计划 → 用户确认
   → Runtime 串行执行（权限校验 + 写入后 sha256 验证）→ ExecutionReport
   → 自动回传 DeepSeek → 下一轮计划 → … → task_complete
```

状态机：`created → planning → plan_ready → awaiting_approval → executing → verifying → report_pending → awaiting_next_round → completed`，非法跳转直接抛错，不会静默放行。

## 三档权限

| 预设 | 允许 | 说明 |
| --- | --- | --- |
| `read-only` | `fs.list`、`fs.readFile` | 含写入步骤的计划在审批阶段就被拒绝 |
| `workspace-write` | 工作区内全部文件工具 | 拒绝绝对路径、`..` 穿越、符号链接 |
| `danger-full-access` | 当前 macOS 用户可访问的路径 | 仍受 POSIX 权限与 TCC 限制，不等于 root |

权限在任务创建时固定；扩大权限需要新任务。所有档位都绑定 `approvalPolicy=ask`，计划必须由用户确认。

## 本地工具

共 27 个，前 4 个与 v1 兼容。完整对照与「刻意不做」见 `../docs/implementation/LOCAL_HARNESS_TOOLS.md`。

- 文件：`fs.list` / `fs.readFile` / `fs.stat` / `fs.tree` / `fs.search` / `fs.find` / `fs.readImage` / `fs.mkdir` / `fs.writeFile` / `fs.edit` / `fs.move` / `fs.copy` / `fs.remove`
- 命令：`test.run`（固定命令→固定 argv，`shell:false`）、`shell.run`（真 shell，按权限分层）、`job.list` / `job.output` / `job.kill`（后台作业）
- 桌面：`screen.capture` / `app.open` / `clipboard.read` / `clipboard.write` / `notify` / `system.info` / `process.list` / `process.kill`
- 网络：`web.fetch`（http/https，SSRF 防护、10s 超时、2 MB 上限）

没有上传工具。删除默认进废纸篓，永久删除只在完全权限下可用；`process.kill` 也只在完全权限下允许，
普通权限用 `job.kill` 停自己起的作业。shell 的权限分层与拦截规则见 `SECURITY.md`。

## 安装与验证

```bash
npm install --no-audit --no-fund
npm run typecheck        # 主进程 / preload / renderer / runtime 全量类型检查
npm test                 # 44 个子脚本：协议 27 项 + 单元/集成用例 622 项
npm run doctor:electron
npm run dev
```

`npm run dev` 会先执行 `install-electron`；Electron 42+ 不再通过 `postinstall` 下载二进制，网络受限时手动运行 `npx --no-install install-electron --no`。

实机验证（需要应用已在跑，且内嵌页面已登录）：

```bash
npm run start:debug                        # 带 --remote-debugging-port=9222
npm run check:layout                       # 分栏对齐 + 应用列几何
npm run check:drag                         # 拖动全流程
npm run e2e:live -- <工作区目录>            # 真实任务走完整条链路
```

细节与最近一次结果见 `docs/TEST_PLAN.md`。

## 使用

1. 启动应用，在右侧内嵌页面登录 DeepSeek。
2. 在底部输入框写目标，选择工作区（首次提交会弹出目录选择）。
3. 等待计划出现，检查步骤、写入路径和完成条件，点「确认并执行」。
4. 之后每一轮自动进行；需要你处理的只有计划确认、澄清回答和取消。
5. 左侧任务列表可回看历史任务、删除已结束的本地记录（不会删工作区文件）。
6. 两栏之间的分隔条可拖动（双击恢复默认比例）。拖动时页面会暂时让位——原生视图必须停到窗口外，否则它会吞掉向右拖动所需的鼠标事件。

## 界面

- 输入框固定在底部，上方的记录独立滚动。
- 右侧内嵌页面默认占 42%，可拖到 380px（页面下限）到「窗口宽度 − 720px」（应用列下限）之间。
- 「诊断」按钮打开页面探测报告：逐选择器命中数（0 标红）、命中者、最后一条回答预览、原生视图的真实位置和尺寸。选择器失配时，这些是唯一能定位问题的信息。

## 界面预览（不需要 Electron）

```bash
npm run build:ui-preview
npx vite preview --outDir ui-preview --port 5173
```

会用一个内存 mock（`src/renderer/src/mock-api.ts`）填充示例任务，便于只看界面、调样式。
mock 仅在 `VITE_MOCK=1` 时生效，正常构建里会被 tree-shake 掉，不会进入发布包。

## 打包

```bash
npm run build:ax:mac
npm run package:mac
```

未配置 Developer ID 签名与 notarization 时只适合本机测试。

## 重要限制（必读）

- **DeepSeek 的 DOM 结构不受我们控制。** 选择器是一组启发式候选，实测可用（输入框是 `textarea[placeholder]`，发送键是无 aria-label 的圆形主按钮，页面没有停止按钮），但对方改版就会失效。`getStatus()` 会如实报告，诊断面板会显示每个候选的命中数——某一项归零就是改版的信号。
- **回答归属判定**依赖「发送前消息数快照 + 最新气泡文本 + 增量含协议标记 + 连续 3 次轮询一致」。如果 DeepSeek 改用虚拟列表或没有稳定的消息节点，判定会失败并返回 `ANSWER_TIMEOUT`——此时任务停止，不会猜测执行。
- **持久化仍是原子 JSON journal**，不是 SQLite。原因见 `DELIVERY_STATUS.md`：避免 node-gyp 在 Apple Silicon 上的安装问题。高并发或大量历史任务下应替换为事务数据库。
- **UtilityProcess 不是 OS 沙箱**。没有 Seatbelt profile，路径检查仍存在 TOCTOU 边界。不要授权包含密钥或生产凭据的目录。
- **崩溃恢复未实现**：执行中被中断的任务会停在 `executing`，需要手动处理。
- **真实鼠标拖动未被测试覆盖**：实机脚本用合成指针事件，绕过了 macOS 原生命中测试；手势本身依赖「拖动期间把视图停到窗口外」的设计规避。
- macOS Accessibility 为只读；Windows / Linux 未实现。

## 目录

```
src/main/        主进程：任务、存储、DeepSeek 适配、编排、Runtime 桥、窗口分栏
src/agent/       独立 Runtime：计划校验、工具执行、结果验证
src/preload/     contextBridge 暴露的受限 API
src/renderer/    React 三栏界面
src/shared/      contracts（类型 + Zod）、schemas（IPC 校验）、protocol（解析 + 提示词）、layout（分栏计算）
scripts/         构建辅助、离线测试、实机检查（scripts/lib/cdp.mjs 是共用底座）
docs/            PROTOCOL（协议与解析）、IPC（接口与信任边界）、TEST_PLAN（怎么验、验到什么程度）、HARNESS_BASELINE（借鉴了什么、没依赖什么）
```
