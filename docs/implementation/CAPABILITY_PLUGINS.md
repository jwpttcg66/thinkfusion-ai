# 本地、联网与保存能力都是插件

> 2026-11-08，分支 `0.1.3`。用户裁决：「所有本地能力和保存，都看齐 deepseek harness 都是插件」，
> 随后补充「应该还有联网搜索能力吧」——联网那一半也要按插件登记，详见第 7 节。
> 形态确认：自研轻量插件注册表，覆盖全部本地、联网与保存能力；不引入 cordis、不开放第三方包。

## 1. 原来错在哪

应用里其实一直有 29 个本地工具、一次工程证据读取、两种保存动作，但设置页的
「内置插件」写着「还没有插件」。这不是文案写错，是架构上它们确实不是插件：

| 位置 | 原来的形态 | 后果 |
| --- | --- | --- |
| `src/agent/index.ts` | 一整段 `switch (step.tool)`，29 个 case 直接调实现函数 | 加一个能力要改主循环；能力没有统一清单、权限说明、开关 |
| `src/main/engineering/project.ts` | `conversation-runner` 直接 import `scanProject` | 工程空间「读本机文件」游离在能力体系之外 |
| `src/main/index.ts` 的两个 IPC | `document:export` / `page:save-document` 各自组装 deps 再调实现函数 | 保存能力是两段散装代码，界面和宿主都不知道它们存在 |
| `SettingsPanel` 的「内置插件」 | 「还没有插件」 | 用户看到的能力与应用真正能做的事对不上 |

DeepSeek Harness 里这些能力都是插件：挂到 `ctx.tools` 之类的服务上，声明依赖，
宿主按 id 查表分派，注册可逆、清单可见。我们抄这个形状，不抄它的依赖链
（[HARNESS_BASELINE](../desktop-agent-macos/docs/HARNESS_BASELINE.md) 的既有决定仍成立：
不装 cordis、不要求 node ≥24.9、不引入 232 MB monorepo）。

## 2. 一套契约、一份清单、两个宿主

```
src/shared/capabilities.ts        契约 + 全量清单（72 条）+ CapabilityRegistry
        │
        ├── src/agent/local-plugins.ts        Runtime：53 个本地工具 + 3 个联网工具
        │        └── src/agent/index.ts       只剩 localCapabilities.execute(step.tool, …)
        │
        └── src/main/capabilities/index.ts    主进程：project.scan / project.read /
                 │                             file.attach / web.search.browser /
                 │                             document.export / page.save-document
                 ├── src/main/conversation-runner.ts  工程证据改走 project.scan 插件
                 ├── src/main/agent-manager.ts       浏览器搜索改走 web.search.browser 插件
                 └── src/main/index.ts               两个保存 IPC 改成查表执行
```

- `CapabilityPlugin` 只有 `run(args, context)` 是必须实现的，其余是登记信息
  （`id` / `kind` / `host` / `title` / `description` / `permission`）。参数与环境由宿主给，
  插件不抓全局状态——对应 harness 的 `inject`。
- `CapabilityRegistry.register()` 返回 disposer，注册是可逆的副作用（对应 `ctx.effect()`）。
  重复注册、清单外的 id、没有 `run` 都直接拒绝。
- `execute(id, args, context)` 是唯一执行入口。未装载、被停用都**明确报错**，不静默跳过。
- 清单是共享的，两个宿主和设置页读的是同一份 `CAPABILITY_CATALOG`，不会各抄一份名字。

两个宿主不是两套体系：本地工具必须在 Runtime 进程跑（权限、工作区边界、执行日志），
保存与页面探针必须在主进程跑（会话存盘、保存对话框、`WebContentsView`）。
dsh 自己也有 `cordis-host-runner` / `cordis-client-runner` 这种双半包。

### 清单

| 宿主 | 类别 | 数量 | 例子 |
| --- | --- | --- | --- |
| `runtime` | 本地能力 | 63 | `fs.readFile` / `fs.edit` / `git.status` / `json.query` / `archive.extract` … |
| `runtime` | 联网 | 3 | `web.fetch`（抓网页）、`web.search`（结构化搜索）、`dns.lookup`（域名解析） |
| `main` | 本地能力 | 3 | `project.scan`（工程证据读取）、`project.read`（模型自己读一次文件）、`file.attach`（输入框「＋」挑的附件） |
| `main` | 联网 | 1 | `web.search.browser`（免凭据的浏览器搜索后端） |
| `main` | 保存 | 2 | `document.export`（会话 md/docx）、`page.save-document`（网页文档与计划） |

合计 **72 = 66 Runtime + 6 主进程**（2026-11-10 对账；`project.read` 是 2026-11-09
「让模型自己读一次文件」补的，旧文里的 61 已过期）。

`web.fetch` / `web.search` 跑在 Runtime，干的却是联网的活，所以单独成组；
工具 id 一个没改，旧计划不会失效。

权限也进了清单：56 个工具里 28 个只读（`READ_ONLY_TOOLS`）、另 28 个为工作区可写，
`process.kill` 是完全权限；主进程侧 `project.scan` / `project.read` / `file.attach` /
`web.search.browser` 只读，两个保存是工作区可写。这层是清单展示；
真正的强制仍由 `assertGrant` / `resolveGrantedPath` 在每一步执行时做，没有因为插件化而放宽。

## 3. 执行链路改了什么

**Runtime**：`agent/index.ts` 里的 29 个 case 全部删掉，实现函数一个字没动，只是
挪进 `local-plugins.ts` 注册。插件返回 `LocalStepOutcome`，把原来散在 switch 里的
后置判断收进插件自己：

- `test.run` / `shell.run` / `code.run` 的非零退出码算「失败」而不是异常，
  并带上 `TEST_FAILED` / `COMMAND_FAILED`；后台作业没有退出码，不算失败；
- `fs.writeFile` 写完回读验证，`app.open` 回读进程确认；
- `web.search` 搜到 0 条不算失败（没资料不是操作失败）。

宿主只剩「验证计划与授权 → 查插件 → 记日志 → 推进」，不再认识任何具体工具。

**主进程**：`document:export` 与 `page:save-document` 的 IPC 现在只校验输入，然后
`mainCapabilities.execute(...)`。会话存盘、`dialog.showSaveDialog`、页面探针
（`PROBE_SCRIPT(..., true)`、页面未打开/加载中/登录页的报错）都收进
`MainCapabilityContext` 由宿主注入。工程空间的两处 `scanProject(...)` 调用改成
`mainCapabilities.execute<ProjectScan>('project.scan', ...)`。

内容侧与格式规则一个字没改：导出仍是本机拼稿、默认 md、只有点名 `doc/docx/word`
才动态加载 docx 模板；网页文档仍是页面回答原文 + 规则识别的计划条目。

## 4. 开关

- 设置 → 内置插件：按「本地能力 / 联网 / 保存」分组列出 60 条，每条有名字、id、
  说明、权限与开关，分组标题显示 `已启用 / 总数`。
- 状态存 `userData/capabilities.json`，只记「被停用的 id」——新增插件默认就是开的。
  文件坏了按全启用处理，不猜半截 JSON。
- `capabilities:set` 更新磁盘后同步 `mainCapabilities`；Runtime 读不到 userData，
  由 `agent-manager.runPlan()` 把 `disabledCapabilities` 随每次 `task.run` 下发。
  因此开关对**下次执行**生效，不会中途改掉正在跑的计划。
- 停用的能力执行时抛「能力插件已停用：xxx」，主进程与 Runtime 各守一道。

## 5. 验证

- `scripts/check-capabilities.mjs`：清单与权限、注册表可逆与报错、
  两个宿主的注册集合、五类插件真干活（读目录、扫工程、浏览器联网搜索、
  导出会话 md、保存网页文档都落盘回读）、开关落盘与下发、防回归断言
  （源码里没有 `switch (step.tool)`、浏览器搜索不再直调 `searchInBrowser`、
  设置页不再写「还没有插件」）。
- `npm run typecheck` 三套通过，`npm run build` 通过。
- 既有验收脚本对导出的格式默认值、页面探针开关、工程证据统计都继续全绿，
  说明插件化没有改变这些能力的对外行为。
- **真机 s29**（2026-11-08，最新 `npm run build` 重启应用后，用应用自己的
  preload API 核对，`/tmp/tf21/s29-capabilities.mjs`）**13/13**：
  清单 32 条 / 本地 30 + 保存 2 / Runtime 29 + 主进程 3 / 权限分层正确；
  停用 `document.export` 后导出明确报「能力插件已停用：导出会话文档」，
  重新启用后走到「这条会话已经不在了，没法导出」（证明确实又执行了插件）；
  设置页 DOM 里 32 行插件、32 个开关，分组标题「本地能力 30/30 已启用」
  「保存 2/2 已启用」，不再有「还没有插件」；测完开关全部恢复，
  `capabilities.json` 为 `{"disabled":[]}`，没有留下测试状态。
- **真机 s30**（同日，补进联网能力后重新 `npm run build` 并重启，
  `/tmp/tf21/s30-network-capabilities.mjs`）**16/16**：清单 33 条 /
  本地 28 + 联网 3 + 保存 2 / Runtime 29 + 主进程 4；联网三条的 id 与宿主
  正确，`web.search.browser` 只读、默认启用、已装载；新插件停用与重新启用
  回显正确；`document.export` 停用仍被明确拦下、启用后走到导出实现；
  设置页 33 行 33 开关，分组标题「本地能力 28/28 已启用」「联网 3/3 已启用」
  「保存 2/2 已启用」；测后 `capabilities.json` 为 `{"disabled":[]}`。
- 全量 `npm test` 756 条全绿（既有 739 + 插件测试 17）。
- **真机 s31 / s31b**（同日补测，端到端真的跑 `web.search`，补上 s30 只核对清单
  没覆盖的那段链路）：启用态 `provider=browser`，返回 3 条真实 http(s) 链接，
  与历史 s19 基线一致——说明请求确实经 `mainCapabilities.execute` 走到主进程的
  真 Chromium 并回了包；停用 `web.search.browser` 后，`attempts` 里明确出现
  `{provider:'browser', ok:false, note:'能力插件已停用：浏览器联网搜索（web.search.browser）'}`，
  结果退回 `provider=bing`，`degraded` 写明来自 Bing RSS，任务仍正常完成（12/12）。
  两次测试会话与任务已删除，侧栏只剩用户自己的两条；开关恢复，
  `capabilities.json` 为 `{"disabled":[]}`。
  第一次 B 场景没跑起来是测试脚本的问题：同一段任务文本被模型判成「与刚完成的
  验收完全相同」直接 `task_complete`，换成独立的问题文本与搜索词后重跑通过。

## 6. 刻意不做

- **不引入 cordis / dsh 运行时**：一次注册与一次查表用不了整个插件框架。
- **不加载第三方插件、不做插件市场**：ROADMAP 里「接口还没稳定，开放出去就是负债」
  这条仍然成立；这里做的是把**内置**能力收进插件契约。
- **开关不卸载实现**：卸载了就没法一眼看出少的是谁；停用只拦截执行。
- **不给插件发模型、发提示词**：能力插件只在本机干活，回答仍由提问链路产生。

## 7. 补记：联网搜索那半边（同日）

用户随后一句「应该还有联网搜索能力吧」点出了上一轮的漏项。核对下来，联网
搜索被分成了三个地方：

| 位置 | 上一轮的状态 | 问题 |
| --- | --- | --- |
| `web.fetch` / `web.search` | 在 Runtime 的 29 个工具里，但 `kind` 一律是 `local` | 联网的活被列在「本地能力」组，界面上看不出它会出网 |
| `src/main/browser-search.ts` 的 `searchInBrowser` | `agent-manager` 收到 `search.browser.request` 后直接 import 调用 | 真正开 Chromium 窗口搜 Bing 的这半边**不在清单里**、开关管不到、也不走 `execute` |

`web.search` 的免凭据路径本来就是双半包：Runtime 里的 `webSearch()` 负责
四家凭据服务与 HTTP 兜底，遇到受限网络就通过 `browser-search-bridge` 向主进程
要一次真浏览器结果。上一轮只把 Runtime 那半登记成插件，另一半漏了。

改法：

- `CapabilityKind` 增加 `network`，`web.fetch` / `web.search` 改归「联网」；
  **工具 id 一个没改**，旧计划不受影响。
- 新增主进程插件 `web.search.browser`（只读、默认启用）。插件不 import Electron，
  真正的 `searchInBrowser` 由 `MainCapabilityContext.browserSearch` 注入，和另外
  三个主进程插件一样能在 node 里单独测。
- `agent-manager` 的 `search.browser.request` 从 `void searchInBrowser(...)` 改成
  `mainCapabilities.execute<BrowserSearchOutcome>('web.search.browser', {query, limit}, { browserSearch: searchInBrowser })`。
  成功/失败**仍然都回包**：Runtime 那边在等 requestId，一次「其实立刻失败了」
  的搜索不能表现成「网络很慢」。

停用的语义要说清楚：关掉 `web.search.browser` 只关掉浏览器后端。主进程插件抛
「能力插件已停用：浏览器联网搜索」，错误原样回给 Runtime，`webSearch` 把它记成
`attempts` 里 browser 的一次失败，再按既有顺序退到 Bing RSS / DuckDuckGo /
Wikipedia，`degraded` 里能看见。要把联网整个关掉，得连 `web.fetch` 与
`web.search` 一起停用——它们是三个独立插件，不是一个开关管一条链。

其余一个字没改：四家凭据 provider、`browser → RSS → 摘要` 的兜底顺序、结果
结构、40 秒回包超时、搜索窗串行化与 `persist:thinkfusion-search` 独立分区。

## 8. 边界：专家与技能不是能力插件

2026-11-08 后加的「专家与技能」（`docs/implementation/ENGINEERING_EXPERTISE.md`）
**不登记进 `CAPABILITY_CATALOG`**：那两份 `.md` 只往工程空间第一意见的 `system`
轮次里添内容，不执行动作、不需要权限、不该被 `CapabilityRegistry.execute` 分派，
也不是新的 agent 成员。它们有独立的设置页分区与开关文件（`expertise.json`）。
判断标准很简单：会不会「干活」——读写文件、出网、保存文档是能力；告诉模型
「以什么身份、按什么流程写」是内容。

## 9. 第二批 23 个能力（同日，清单到 60）

用户要求「把 60 个能力都做了吧」。第一批 4 个（`a866972`）之后，这一批补齐
剩下 23 个，全部按同一套契约登记，**没有一个走 `switch` 或散装 IPC**：

| 组 | 工具 | 关键边界 |
| --- | --- | --- |
| git 读 | `git.status` / `git.diff` / `git.log` / `git.show` | 只读；引用名过 `assertSafeRef`，`-` 开头直接拒；输出有上限且带 `truncated` |
| git 轻写 | `git.stash` / `git.branch` | 需 `workspace-write`；`drop` 必须指明第几条；`push` 的 message 只当 argv |
| 数据文件 | `json.query` / `csv.summary` / `sqlite.query` | 只读；JSON 支持 `a.b[0].c` 与 JSON Pointer；SQLite 用 `-readonly` 且只放行 SELECT/WITH/PRAGMA/EXPLAIN |
| 压缩包 | `archive.list` / `archive.extract` / `archive.create` | 解压前先读条目名，绝对路径或 `..` **整包拒绝**（zip-slip）；输出已存在不覆盖 |
| 文本 | `text.diff` / `text.base64` | `diff` 退出码 1 是「有差异」不是失败；输出可直接喂 `fs.applyPatch` |
| 图片 | `image.resize` | 系统 `sips`；不覆盖原图与已有输出；`-z` 参数顺序是 **高 宽** |
| 宿主 | `env.read` / `port.list` / `app.list` / `window.list` / `time.now` | 环境变量里 KEY/TOKEN/SECRET 一律打码；窗口标题缺辅助功能授权时给 note，不当崩溃 |
| 联网 | `dns.lookup` | 只接受域名形状；归 `network` 组，只读档位下不可用 |
| 进程/体积 | `process.tree` / `fs.du` | `ps` 被挡时退 `pgrep` 并写明「没有父子关系」；`fs.du` 不跟随符号链接 |

同时收掉一处重复实现：`extended.ts` 里原本自己写了一份 `runGit`，现在与
`git-tools.ts` 共用 `git/tools/git-run.ts`——超时、截断、环境变量白名单只有一处。

清单变成 **56 个 Runtime 工具（53 本地 + 3 联网）+ 4 个主进程能力 = 60**，
只读 28 / 可写 28（Runtime 侧）。`TOOL_SPEC` 里 23 条说明同时补进给模型看的
工具面，模型才知道它们存在。

**接线有三处，少一处就是「模型写了却执行不了」**（真机 s32 就在这里栽过）：

1. `TOOL_NAMES`（计划 schema 的 id 白名单）——只决定名字合不合法；
2. `StepSchema` 的逐工具分支——决定**这一步的 args 怎么校验**。它是手写的
   `z.discriminatedUnion`，没补分支时会长成「不受支持的工具名」，模型连改三轮
   都过不去；
3. `local-plugins.ts` 的注册——决定 Runtime 找不找得到实现。

`StepSchema` 里的数值上限要按**实现里的钳制值**写（`git.status` 的
`maxEntries` 实现钳到 2000、`fs.du` 钳到 500），否则模型照着说明写一个更大的
数就被拒，白跑一轮修复。

验证：`scripts/check-capability-batch2.mjs` **18 条**（真建 git 仓库跑
status/diff/log/show/stash/branch、JSON/CSV/SQLite 真读、压缩包 round-trip 与
zip-slip 拒绝、文本 base64 往返、`sips` 真缩放 1×1→8×8、环境变量打码、
`fs.du` 字节数、`dns.lookup` 输入校验，外加「23 个工具都能写进计划且拒绝未知
字段」这条接线回归），已接进 `npm test`。

