# 测试与验证

这个项目的失败模式大多不在单个函数里。一次"发送"要经过 DOM 事件、IPC、主进程、原生视图和别人的网页；"回答对不对"取决于时序，不取决于逻辑。所以测试分成两层：**离线规则**（可在 CI 跑）和**实机事实**（必须在跑着的应用上跑）。

## 离线：不需要应用

```bash
npm run typecheck     # 三个 TS 工程：主进程/预加载、agent runtime、渲染进程
npm test              # 协议 24 项 + 适配器 27 项 + 状态机 8 项
npm run build         # electron-vite build + agent runtime 编译
```

### 协议（`scripts/check-protocol.mjs`，24 项）

覆盖解析规则，包括每一条曾经真实出错的输入：

| 用例 | 对应的真实故障 |
| --- | --- |
| 围栏消失的代码块仍能解析 | 渲染后的 `innerText` 没有 ``` 标记，解析器全部失败 |
| 字符串内裸换行仍能解析 | markdown 折叠把换行塞进 JSON 字符串 |
| 尾逗号不使计划失效 | 模型偶尔输出 `},]` |
| 字符串内的花括号不截断对象 | `"content": "function f() {}"` |
| 散文里的花括号不被误判 | 讨论代码时整段文本被当成协议块 |
| 协议块解析失败时报告原因 | 静默返回 `none` 让"没有回答"和"回答不对"无法区分 |
| 冲突计划被拒绝 / 相同重复块被容忍 | 模型把计划说两遍 |

还有断言提示词内容的用例：`taskId`/`roundId` 必须出现、工具清单必须出现、**相对路径规则必须写明**（不写时 DeepSeek 会拼绝对路径，被 Runtime 拒绝后浪费一轮）。

### 适配器（`scripts/check-adapter.mjs`，27 项）

用一个**脚本化页面**驱动真实的 `DeepSeekAdapter`：每次探测的观测值逐条写死，断言的是时序规则而不是 DOM。

`PageDriver` 这个接缝就是为了这个——Electron 依赖被隔离在 `createElectronDriver` 一个函数里，其余全是纯逻辑，可以在 Node 里跑。

覆盖：提交判定（按钮成功、按钮失败后回车、输入框清空才计入、切换会话不算提交）、回答归属（气泡优先、增量必须含协议标记、未闭合 JSON 不接受、连续 3 次一致）、超时错误带诊断事实、选择器全失效时的结构回退。

### 状态机（`scripts/check-state-machine.mjs`，8 项）

用内存 store 驱动真实的 `TaskManager`，断言的是**哪些转换合法**。

这一组的存在理由是一次"看起来卡住了"的反馈：任务在等用户回答问题，却被记成 `planning`——一个意思是"应用正在干活"的状态。没有抛错，模型和事实对不上，于是所有读状态的界面代码都得出错误结论。

所以"等人"的状态有自己的名字，进出它的边都被断言：

- `planning → awaiting_clarification` 合法，且它不等于 `planning`
- `awaiting_clarification → planning`（回答之后）合法
- `awaiting_clarification` 不能跳到 `plan_ready` / `awaiting_approval` / `executing` / `completed`（没回答的问题不能被跳过执行）
- `awaiting_clarification → cancelled` 仍然合法
- `planning → awaiting_approval` 被拒（计划必须先落库并计算哈希）
- 正常路径、终态不可离开、每次转换都发出 `task.updated`

## 实机：需要跑着的应用

```bash
npm run build
npm run start:debug        # 带 --remote-debugging-port=9222 启动
```

前置条件：内嵌页面已登录 DeepSeek。

```bash
npm run check:layout       # 分栏两侧对齐（15 项）+ 应用列几何（9 项）
npm run check:drag         # 拖动全流程（16 项）
npm run check:new-task     # 「新任务」的可见反馈（10 项）
npm run e2e:live -- <工作区目录> ["提示词"]
```

### `check-split.mjs`（15 项）

断言视图宽度 = `split - gutter`、右边缘正好落在窗口边缘、分隔条左缘就是应用列边界。**这一项能抓住最初那个布局 bug**：当时视图右边缘到 1268，窗口只有 1180，页面盖在应用列上，而渲染进程完全不知道。

权威数据来自主进程 `setBounds` 的参数（诊断报告里的 `view`）。页面自己的 `window.innerWidth` 只作旁证——Chromium 不给隐藏或遮挡的窗口重排，窗口不在前台时它不会变；脚本会把这一点标注出来，而不是判失败。

### `check-split-drag.mjs`（16 项）

用合成指针事件驱动完整手势：ghost 出现、主进程知道拖动中、视图被停到窗口外且宽度不变、夹取边界（应用列 ≥720、页面 ≥380）、松手回到边界、双击恢复默认比例。

合成事件证明不了 macOS 会派发真实拖动——那正是 `setPageDragging` 存在的理由。它证明的是：每个 move 都到达主进程、夹取发生在主进程而不是渲染进程、视图最终位置与预留的 gutter 完全一致。

### `check-app-layout.mjs`（9 项）

输入框贴在窗口底边、内容滚动区不压到它、空状态在剩余空间里居中、输入框和按钮都不越过分栏。这几条都是纯几何，可以断言而不必靠眼睛。

### `check-new-task.mjs`（10 项）

这条检查来自一次"新建任务没有响应"的反馈。实机复现后发现按钮本身没坏：它确实清空了选中状态、也确实回到了空状态——但当屏幕**本来就是空的**时，这一下点击没有改变任何一个像素，草稿不清、光标不动，于是和死按钮长得一模一样。

断言的是"点下去必须看得见"：草稿被清空、光标落到输入框、空状态下重复点击光标仍在输入框、空输入按 Enter 给出「先写一句目标，再发送。」而不是吞掉这次按键、开始输入后提示消失且发送按钮可用。

顺带修掉的是同一类静默失败：首次提交必须先选工作区，而目录选择器被取消或抛错时原来直接 `return`，发送键看起来毫无反应。现在两种情况都会给出说明。

### `e2e-live.mjs`

一个真实任务走完整条链路：提交 → 发送到页面 → 解析计划 → 自动批准 → Runtime 执行 → 报告回传 → 直到 `completed`。按最终状态退出，可以直接用作发布门禁。

`E2E_TIMEOUT_MS` 可调超时（默认 210 秒）。

## 最近一次实机结果

环境：macOS arm64，Electron 45.1.0，窗口 1560×928，内嵌页面已登录。

```
check:layout  15 passed, 0 failed  +  9 passed, 0 failed
check:drag    16 passed, 0 failed
check:new-task 10 passed, 0 failed
e2e:live      final: completed（2 轮，首个计划 1 步即成功）
```

`e2e:live` 的轮次值得记录：加入相对路径规则之前，第一个计划必定被拒、第二个才成功，也就是每个任务固定浪费一轮。现在第一轮就通过。

另外单独核对过一次澄清路径（依赖模型是否提问，因此没做成固定检查）：任务进入 `awaiting_clarification`、状态标签显示「等待你回答」、问题卡片可输入、底部输入框保持禁用、回答后回到 `planning` 并继续到 `awaiting_approval`；重复回答会被拒绝。

## 已知无法在此环境验证

- **真实鼠标拖动**：合成事件走的是渲染进程的事件通道，绕过了 macOS 的原生命中测试。手势本身依赖 `setPageDragging` 的设计规避，而不是被测试覆盖。
- **窗口在前台时的渲染表现**：截图在当前环境被拦截，验证只能读状态、不能看像素。`check-split.mjs` 因此在页面 `visibilityState` 不是 `visible` 时跳过 `innerWidth` 断言并打印说明。
- **Accessibility 读取**：需要用户授予 TCC 权限，未在自动化中覆盖。
- **打包与签名**：`npm run package:mac` 未运行。
