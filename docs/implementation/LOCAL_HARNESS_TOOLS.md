# 本地能力对齐：对照 DeepSeek Harness 工具目录

> 参照物：`~/data/dsh-src` 的 `docs/tool-catalog.zh.md`（提交 `ce7073d5`，包版本 0.2.2-alpha.2），
> 以及本机 `DeepSeek Harness.app` 0.2.1-rc.5 的 Standard 工具面。
>
> 结论先行：**「本地机器能力」这一层已经对齐**；agent 编排类（subagent / workflow / schedule /
> goal / 插件管理 / MCP / 浏览器控制）不在这一层，它们在我们这里由计划、审批、会话、辩论
> 自己承担，不重复造一套工具。
>
> **2026-11-10 修正**：本文的「刻意不做」只说明它们**不进入工具层**，不代表它们不在能力清单里。
> dsh 的 76 条 schema 已逐条登记为 L0–L3 并映射到 13 个族，缺口排进 P5/P6，见
> [GENERAL_ENGINEERING_CAPABILITIES](../spec/GENERAL_ENGINEERING_CAPABILITIES.md)。
> 只读本文会把「没有工具」误读成「没有这个能力」。

## 1. 怎么划分「本地能力」

DSH 的 Standard 模式把工具分成三类，我们的处置也按这三类走：

| 类别 | DSH 工具 | 我们的处置 |
| --- | --- | --- |
| 本地机器能力 | `read` / `write` / `edit` / `read_image` / `glob` / `grep` / `bash` / `job_*` / `web_fetch` / `web_search` / `ask_user_question` / `working_directory` | **逐个对齐**（见第 2 节）。`working_directory` 由会话级 `workspaceRoot` 承担；`ask_user_question` 在计划前由协议澄清承担，**执行中另补 `ask.user`（P5）**——协议澄清覆盖不到执行中 |
| agent 编排 | `subagent*`、`workflow`、`ralph`、`todo_write`、`exit_plan_mode`、`goal_*`、`schedule_*`、`session_*` | 不在这层。计划审批、方案评审辩论、会话历史已经是我们的同类机制 |
| 扩展生态 | `plugin_manager`、`plugin_market`、`list_mcp_resources`、`stagehand_*`、`cordis_inspect_*`、`create_worktree` | 不做。这些是「给 harness 装能力」的工具，不是「在本机干活」的工具 |

`str_replace_editor` 与 `apply_patch` 属于 `edit` 的两种形态，我们实现 `fs.edit`（唯一字面量替换）
覆盖同一用途，没有再做 patch 方言——多一套语法就多一类校验失败。

## 2. 逐项对照

| 能力 | DSH | 我们 | 状态 |
| --- | --- | --- | --- |
| 读文本 | `read` | `fs.readFile`（≤256 KiB，`O_NOFOLLOW`） | 已有 |
| 写新文件 | `write` | `fs.writeFile`（独占创建） | 已有 |
| 改已有文件 | `edit` / `str_replace_editor` / `apply_patch` | `fs.edit`（唯一字面量替换 + `replaceAll` + `expectedHash`）、`fs.writeFile` 覆盖（带 sha256） | **本轮补齐 `fs.edit`** |
| 读图片 | `read_image` | `fs.readImage`（PNG/JPEG/GIF/WebP，尺寸 + sha256 + base64） | **本轮补齐** |
| 按名字找文件 | `glob` | `fs.find`（`*` `**` `?`） | 已有 |
| 按内容搜 | `grep` | `fs.search`（路径:行号 + 命中行） | 已有 |
| 目录树 | （`bash ls`） | `fs.tree` / `fs.list` | 已有 |
| 文件元数据 | （`bash stat`） | `fs.stat`（类型/字节/权限/mtime/sha256） | **本轮补齐** |
| 移动 / 复制 | （`bash mv/cp`） | `fs.move` / `fs.copy`（目标存在即拒绝） | **本轮补齐** |
| 删除 | `bash rm` / `delete-intent` | `fs.remove`（默认废纸篓；永久删除仅完全权限；目录需 `recursive`） | **本轮补齐** |
| 执行命令 | `bash` | `shell.run`（`/bin/sh -c`，真实退出码，分层策略） | 已有 |
| 后台命令 | `bash` + `run_in_background` | `shell.run` 的 `background` | **本轮补齐** |
| 作业控制 | `job_list` / `job_output` / `job_kill` | `job.list` / `job.output` / `job.kill`（元数据落盘，跨 Runtime 进程可用） | **本轮补齐** |
| 持久终端 | `terminal_*`（PTY） | P5 补 `term.*`，见 [设计 §5.3](../spec/GENERAL_ENGINEERING_CAPABILITIES.md#53-终端6-条) | P5 待补 |
| 抓网页 | `web_fetch` | `web.fetch`（GET/POST，SSRF 防护，10s，2 MB，正文 20k 字符） | **本轮补齐** |
| 联网搜索 | `web_search` | `web.search`（凭据或应用内浏览器；免凭据走主进程 `web.search.browser`） | **已有**（2026-11-09 补） |
| 剪贴板 | （桌面插件） | `clipboard.read` / `clipboard.write` | **本轮补齐** |
| 系统通知 | （`bash osascript`） | `notify`（内容走 argv，不拼脚本） | **本轮补齐** |
| 系统信息 | （`bash uname/df`） | `system.info`（OS/CPU/内存/磁盘/电池） | **本轮补齐** |
| 进程列表 | （`bash ps`） | `process.list`（`ps`，被挡时退 `pgrep`，都不可用就明说读不到） | **本轮补齐** |
| 结束进程 | （`bash kill`） | `process.kill`（仅完全权限） | **本轮补齐** |
| 截屏 | （桌面插件） | `screen.capture`（PNG 校验 + 尺寸 + sha256） | 已有 |
| 打开应用/文件 | （桌面插件 `open_application`） | `app.open`（`open -a` + `pgrep` 回读） | 已有 |
| LSP 诊断 | `lsp` | `code.diagnostics`（tsc / eslint 输出归一，不常驻语言服务器） | **已有** |
| 问用户 | `ask_user_question` | 计划前：`clarification_required` + `awaiting_user`；执行中：补 `ask.user`（P5） | 等价机制 + P5 待补 |
| 改工作目录 | `working_directory` | 会话级 `workspaceRoot`；计划里每个 path 都相对它 | 等价机制 |

工具总数从 11 增加到 27。

## 3. 权限分层（新增工具部分）

| 权限 | 可用工具 |
| --- | --- |
| `read-only` | `fs.list` / `fs.readFile` / `fs.stat` / `fs.readImage` / `fs.tree` / `fs.search` / `fs.find` / `system.info` / `process.list` / `clipboard.read` |
| `workspace-write` | 上面全部 + 写入类（`fs.mkdir` / `fs.writeFile` / `fs.edit` / `fs.remove` / `fs.move` / `fs.copy`）+ `test.run` / `shell.run`（白名单）/ `job.*` / `screen.capture` / `app.open`（GUI 白名单）/ `clipboard.write` / `notify` / `web.fetch` |
| `danger-full-access` | 全部，含 `process.kill`、`fs.remove(permanent)`、任意 shell |

几条刻意的限制：

- **删除默认进废纸篓。** `fs.remove` 不是 `unlink`：默认 `rename` 到 `~/.Trash`，重名加时间戳；
  只有 `danger-full-access` 下的 `permanent: true` 才真的删除。这既是安全网，也符合 macOS 习惯。
- **结束进程只在完全权限。** 普通权限下要停自己起的进程，用 `job.kill`——那是可追踪的进程组。
- **`web.fetch` 拒绝本机/私网/元数据地址，重定向逐跳校验。** 否则 `http://127.0.0.1:9222/json`
  就能把调试端口读成"网页"。这条与 `page-extract.ts` 的规则一致。
- **`notify` 的内容作为 argv 传给 AppleScript**，不拼进脚本源码；否则一段带引号的文本就能改脚本语义。
- **`fs.edit` 默认要求唯一命中。** 同一段文本出现两次时替换任何一处都是猜，宁可让计划补上下文。

## 4. 刻意不做，以及为什么

- **PTY 持久终端（`terminal_*`）**：需要 `node-pty` 原生模块，而本项目的 `dependencies` 只有 `zod`。
  同一用途用 `shell.run` + `job.*` 覆盖：后台进程、输出读取、进程组终止。真正需要交互式 TUI 的
  场景（vim、top）本来也不适合模型自动操作。**2026-11-10 改判**：这条不再算「不做」，
  已排进 P5（`term.*`，优先 `node-pty`，退回 `script(1)`；`send` 逐次审批）。
- **鼠标/键盘模拟（`computer` 系列）**：需要辅助功能 TCC 授权，且每次点击都不可审计、不可回滚。
  截图 + 打开应用 + shell 已经能覆盖"让机器做一件事"，再往上一层是另一套产品（computer use）。
- **LSP 诊断（`lsp`）**：语言服务器与工程栈绑定（TypeScript/Python/Go 各一套）。我们的工程实施
  用 `test.run`（`npm run typecheck` 等固定命令）拿到真实退出码，已经能回答"改完有没有坏"。
  **2026-11-10 已落地**：`code.diagnostics` 把 tsc/eslint 输出归一成
  `{path,line,severity,message}`；真接 LSP 需要常驻进程，另开一期。
- **联网搜索（`web_search`）**：**已补**（2026-11-09）。`web.search` 走凭据或应用内浏览器，
  免凭据时由主进程 `web.search.browser` 兜底；`web.fetch` 仍负责「给 URL 取正文」。
  旧版这里写的「刻意不做」已过期。
- **agent 编排与插件生态**：见第 1 节。我们的计划审批、方案评审辩论、会话历史已经承担其中一部分；
  dsh 的 24 条编排/治理工具现在逐条登记在 [设计 §5](../spec/GENERAL_ENGINEERING_CAPABILITIES.md#5-dsh-76-条全覆盖对照)：
  能由现有机制承担的记 L1，真缺的（goal / schedule / team）排进 P6。

## 5. 验证

- 单元/集成：`scripts/check-local-tools.mjs`，39 条（新增 15 条覆盖 `fs.stat` / `fs.edit` /
  `fs.remove` / `fs.move` / `fs.copy` / `fs.readImage` / 剪贴板 / 系统信息 / 进程 / web.fetch / 后台作业）。
- 真机 s17（文件与系统，`/tmp/tf21/s17-fs-system.mjs`）**16/16**：
  - `fs.stat` 拿到 25 字节、`sha256` 64 位；
  - `fs.edit` 把标题改成「（s17 已编辑）」，磁盘回读一致，`replaced: 1`；
  - `fs.copy` 产出 `README.copy.md`（44 字节），`fs.stat` 确认存在；
  - `fs.remove` 返回 `trashed: true`、`trashPath` 指向 `~/.Trash/README.copy.md` 且文件真的在那里；
  - `clipboard.read` 读到当时剪贴板的 27 个字符；
  - `system.info` 给出 24GB 内存、磁盘 `/dev/disk3s1s1` 挂在 `/`（早先这里把 inode 计数拼进挂载点，已修）。
- 真机 s18（网络与作业，`/tmp/tf21/s18-web-jobs.mjs`）**11/11**：
  - `web.fetch` 取回 `https://example.com`：HTTP 200、577 字节、正文含 "Example Domain"；
  - `shell.run(background: true)` 起了一个 `for` 循环作业，`job.list` 里有它，`job.output` 读到
    `tick-1 / tick-2 / tick-3`（说明进程在 Runtime 交回后仍在跑）；
  - `process.list` 过滤 `sleep` 拿到真实进程；
  - `notify` 返回 `shown: true`。

两次真机都是完整链路：网页模型规划 → 人工审批 → Runtime 执行 → 报告 + 独立评审。
**一次环境事故值得记录**：跑 s17 时 DeepSeek 登录态过期（页面跳到 `/sign_in`），
执行链路报「DeepSeek 未登录」；把规划源临时切到 ChatGPT 才跑通，测完已切回。
这次事故暴露了一个真问题并已修：`AgentOrchestrator` 在构造时就把适配器固定成了当时的
规划源，运行时切换后界面显示已换、实际还是旧页面——现在改成每次取用时重新解析。

## 5. 现状（2026-11-08 第二批能力之后）

上面那张表是「对齐 DSH Standard 工具面」那一轮的记录，只到 27 个工具。之后
两批补齐了 DSH 目录里没有、但本机干活真正用得到的部分；`project.read` 之后，
清单是 **64 个能力 = 58 个 Runtime 工具（55 本地 + 3 联网）+ 6 个主进程能力**
（2026-11-10 对账，`CAPABILITY_CATALOG` 与测试都按 62 断言）：

| 批次 | 新增 | 为什么需要 |
| --- | --- | --- |
| 第一批（`a866972`） | `fs.applyPatch` / `git.worktree` / `project.dependencies` / `project.outline` | 改一处代码只能整文件覆写；看项目结构只能逐文件读 |
| 第二批 | git 读与轻写 6 个、数据文件 3 个、压缩包 3 个、文本 2 个、图片 1 个、宿主 6 个、进程树 1 个、目录体积 1 个 | 见 `CAPABILITY_PLUGINS.md` 第 9 节 |

边界一条没松：全部仍然是「按 id 查表执行 + 权限分层 + 路径授权」，
`READ_ONLY_TOOLS` 28 个、`MUTATING_TOOLS` 28 个，两者不重叠且并集等于
`TOOL_NAMES`——这条由 `scripts/check-capability-batch2.mjs` 守着。

